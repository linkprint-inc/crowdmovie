// 实时 (§16.3) — `GET /api/events`, the single SSE stream defined by §16.4.
//
// Three responsibilities, kept apart:
//   * a dedicated PostgreSQL connection that LISTENs on `EVENT_CHANNEL` and
//     hands every notification to the hub (see lib/events.ts for why the
//     transport is NOTIFY);
//   * the hub, which fans one event out to every open response and coalesces
//     `submission.votes`「按条每 2 秒合并推送一次」;
//   * the route, which hijacks its reply and registers a client that is removed
//     the moment the socket closes.
//
// **No catch-up, on purpose.** §16.4:「断线重连后前端以 GET 接口全量校准，不依赖
// 事件流补历史」. So this listener does not poll, does not replay and keeps no
// backlog: a notification sent while the connection was down is gone, and the
// client's reconnect re-reads the GET endpoints. That is why it does not reuse
// `startListener` from the job ledger, whose whole point is the opposite —
// there, a lost notification must still be found by polling durable rows.
//
// **A dropped client must cost nothing.** Every write goes to a socket that may
// already be gone, so `write()` is guarded and any error unregisters the client
// instead of propagating; the `close` handler unregisters it too, so a client
// that vanishes without an error still leaves no entry behind. Nothing in the
// request path ever waits on a subscriber.
import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import pg from 'pg';

import { EVENT_CHANNEL, type AppEvent } from '../../lib/events.js';
import { findPublicMovie } from '../../movies/catalog.js';

/** §16.4「按条每 2 秒合并推送一次」. */
export const VOTE_COALESCE_MS = 2_000;

/** Comment frames, so an idle stream is not mistaken for a dead one by a proxy. */
const KEEPALIVE_MS = 25_000;

const RECONNECT_DELAY_MS = 1_000;

/**
 * Ceiling on concurrent streams. This endpoint is public and each subscriber
 * pins a socket for as long as it likes, so without a bound one client can hold
 * the web service's whole connection budget. Far above any real audience the
 * site will have before this is revisited.
 */
export const MAX_EVENT_CLIENTS = 500;

interface Client {
  raw: ServerResponse;
  movieId: string | null;
}

/**
 * Fans events out to the open responses. Owns no database state and no history:
 * it is a switch, not a queue.
 */
export class EventHub {
  private readonly clients = new Set<Client>();
  private readonly pendingVotes = new Map<string, AppEvent>();
  private voteTimer: NodeJS.Timeout | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly voteWindowMs: number = VOTE_COALESCE_MS) {
    this.keepAliveTimer = setInterval(() => {
      this.writeAll(': keepalive\n\n');
    }, KEEPALIVE_MS);
    // A heartbeat must not be a reason the process cannot exit.
    this.keepAliveTimer.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  /** Register an open response. Returns the detach function. */
  add(raw: ServerResponse, movieId: string | null = null): () => void {
    const client: Client = { raw, movieId };
    this.clients.add(client);
    return () => this.clients.delete(client);
  }

  /**
   * Take one event off the wire. `submission.votes` is held for the coalescing
   * window and replaced in place — the last counts for a submission are the only
   * ones worth sending — while everything else goes out immediately.
   */
  publish(event: AppEvent): void {
    if (this.stopped) return;
    if (event.type === 'submission.votes') {
      const key = `${String(event.data.movieId ?? '')}:${String(
        event.data.submissionId ?? '',
      )}`;
      this.pendingVotes.set(key, event);
      this.armVoteFlush();
      return;
    }
    this.send(event);
  }

  private armVoteFlush(): void {
    if (this.voteTimer !== null) return;
    this.voteTimer = setTimeout(() => {
      this.voteTimer = null;
      const batch = [...this.pendingVotes.values()];
      this.pendingVotes.clear();
      for (const event of batch) this.send(event);
    }, this.voteWindowMs);
    this.voteTimer.unref();
  }

  private send(event: AppEvent): void {
    // `id:` is deliberately absent: there is no replay to resume from, so
    // handing the browser a Last-Event-ID would promise one (§16.4).
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    const movieId =
      typeof event.data.movieId === 'string' ? event.data.movieId : null;
    for (const client of this.clients) {
      if (client.movieId !== null && client.movieId !== movieId) continue;
      this.write(client, frame);
    }
  }

  private writeAll(frame: string): void {
    for (const client of this.clients) {
      this.write(client, frame);
    }
  }

  private write(client: Client, frame: string): void {
    if (client.raw.writableEnded || client.raw.destroyed) {
      this.clients.delete(client);
      return;
    }
    try {
      client.raw.write(frame);
    } catch {
      this.clients.delete(client);
    }
  }

  /** Close every stream and stop the timers. Called from the app's onClose. */
  stop(): void {
    this.stopped = true;
    if (this.voteTimer !== null) clearTimeout(this.voteTimer);
    if (this.keepAliveTimer !== null) clearInterval(this.keepAliveTimer);
    this.voteTimer = null;
    this.keepAliveTimer = null;
    for (const client of this.clients) {
      try {
        client.raw.end();
      } catch {
        /* already gone */
      }
    }
    this.clients.clear();
  }
}

export interface EventListener {
  stop(): Promise<void>;
}

/**
 * Keep one connection LISTENing on `EVENT_CHANNEL`, reconnecting if it drops.
 * Malformed payloads are dropped rather than thrown: this connection is shared
 * by every subscriber, and one bad notification must not take the stream down
 * for all of them.
 */
export function startEventListener(options: {
  connectionString: string;
  onEvent: (event: AppEvent) => void;
  onError?: (error: Error) => void;
}): EventListener {
  let stopped = false;
  let client: pg.Client | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const report = (error: Error): void => options.onError?.(error);

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer !== null) return;
    const dying = client;
    client = null;
    if (dying) dying.end().catch(() => undefined);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_DELAY_MS);
    reconnectTimer.unref();
  };

  const connect = (): void => {
    if (stopped) return;
    const next = new pg.Client({
      connectionString: options.connectionString,
      application_name: 'crowdmovie-events',
    });
    client = next;

    next.on('error', (error: Error) => {
      if (stopped || client !== next) return;
      report(error);
      scheduleReconnect();
    });
    next.on('notification', (message) => {
      if (message.payload === undefined) return;
      let event: AppEvent;
      try {
        event = JSON.parse(message.payload) as AppEvent;
      } catch {
        return;
      }
      if (typeof event?.type !== 'string') return;
      options.onEvent(event);
    });

    void (async () => {
      try {
        await next.connect();
        await next.query(`LISTEN "${EVENT_CHANNEL}"`);
      } catch (error) {
        if (stopped || client !== next) return;
        report(error as Error);
        scheduleReconnect();
      }
    })();
  };

  connect();

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const dying = client;
      client = null;
      if (dying) await dying.end().catch(() => undefined);
    },
  };
}

export interface EventRoutesOptions {
  pool: pg.Pool;
  /** Its own connection: a `LISTEN` holds its session, so it cannot be pooled. */
  connectionString: string;
  /** §16.4 的 2 秒合并窗口; tests shorten it. */
  voteCoalesceMs?: number;
  /** Concurrent stream ceiling; tests lower it so the cap is reachable. */
  maxEventClients?: number;
}

export async function eventRoutes(
  app: FastifyInstance,
  options: EventRoutesOptions,
): Promise<void> {
  const hub = new EventHub(options.voteCoalesceMs ?? VOTE_COALESCE_MS);
  const maxClients = options.maxEventClients ?? MAX_EVENT_CLIENTS;
  const listener = startEventListener({
    connectionString: options.connectionString,
    onEvent: (event) => hub.publish(event),
    onError: (error) => app.log.error({ err: error.message }, 'event listener'),
  });

  app.addHook('onClose', async () => {
    hub.stop();
    await listener.stop();
  });

  app.get('/api/events', async (request, reply) => {
    if (hub.size >= maxClients) {
      return reply
        .code(503)
        .send({ error: 'too_many_streams', message: '实时连接已满，请稍后重试' });
    }

    // Past this point Fastify must not touch the response: the body is an
    // open-ended stream written to directly.
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Tells a buffering reverse proxy to pass frames straight through.
      'X-Accel-Buffering': 'no',
    });
    // A first frame flushes the headers, so a client knows it is connected
    // before any event happens. `retry:` is the browser's reconnect delay.
    raw.write('retry: 3000\n\n');

    const detach = hub.add(raw);
    // Both ends, because either can be the one that notices: `request.raw`
    // fires on an aborted request, `reply.raw` on a closed response. Removing
    // an absent client is a no-op, so a double fire is harmless — and a missing
    // one would leak a subscription for the life of the process.
    request.raw.on('close', detach);
    raw.on('close', detach);
    raw.on('error', detach);
    return reply;
  });

  app.get<{ Params: { movieSlug: string } }>(
    '/api/movies/:movieSlug/events',
    async (request, reply) => {
      const movie = await findPublicMovie(options.pool, request.params.movieSlug);
      if (movie === null) {
        return reply
          .code(404)
          .send({ error: 'movie_not_found', message: '影片不存在' });
      }
      if (hub.size >= maxClients) {
        return reply
          .code(503)
          .send({ error: 'too_many_streams', message: '实时连接已满，请稍后重试' });
      }
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      raw.write('retry: 3000\n\n');
      const detach = hub.add(raw, movie.id);
      request.raw.on('close', detach);
      raw.on('close', detach);
      raw.on('error', detach);
      return reply;
    },
  );
}
