// 实时事件 (§16.4) — the wire every SSE event travels on, and the one function
// that puts an event on it.
//
// **Why PostgreSQL `NOTIFY` and not an in-process emitter.** The events in
// §16.4 have two producers in two different processes: `submission.*` and
// `danmaku.created` happen in the web service, `round.*` / `scene.published` /
// `episode.*` happen in the worker. `pg_notify` is the only transport both
// already hold a connection to, and §2 rules out adding a broker or a cache.
//
// **Why the emit belongs inside the caller's transaction.** PostgreSQL queues a
// notification and delivers it at COMMIT, discarding it on ROLLBACK. Emitting
// there is therefore the only way to guarantee §16.4's implicit contract: a
// client is never told about a submission, scene or comment that did not
// actually land. It also means an emit is not a thing that can be "forgotten"
// after a crash between the write and the broadcast.
//
// **What an event may carry.** §16.4:「事件只带数据库 ID 与展示所需最小字段；
// 断线重连后前端以 GET 接口全量校准，不依赖事件流补历史」. So no event is a
// substitute for a read endpoint, nothing here is required to arrive, and the
// payload stays small enough that PostgreSQL will accept it — see `encode()`.
import type { Queryable } from '../jobs/ledger.js';

/** The `LISTEN`/`NOTIFY` channel. Distinct from the §5.2 job channels. */
export const EVENT_CHANNEL = 'crowdmovie_events';

/** §16.4 的事件类型全集。 */
export const EVENT_TYPES = [
  'round.opened',
  'round.closed',
  'round.published',
  'submission.created',
  'submission.scored',
  'submission.deleted',
  'submission.votes',
  'episode.opened',
  'episode.ended',
  'scene.published',
  'danmaku.created',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface AppEvent {
  type: EventType;
  data: Record<string, unknown>;
}

/**
 * PostgreSQL refuses a `NOTIFY` payload of 8000 bytes or more, and it refuses it
 * by raising inside the caller's transaction — which would turn "the broadcast
 * was too big" into "the 投稿 was rejected". That trade is never acceptable, so
 * the size is checked here instead of being discovered by the database.
 *
 * The margin below 8000 is for the channel name and the server's own framing.
 */
const NOTIFY_BUDGET_BYTES = 7_000;

/** Anything longer than this is prose, not an identifier. */
const SHORT_STRING = 64;

/**
 * Serialise an event, shrinking it if it would not fit.
 *
 * The shrink keeps every scalar that is plainly an identifier or a counter and
 * drops the free text (a 1000-grapheme 提案, four localised roasts), then marks
 * the result `truncated`. That is the honest degradation for this stream: §16.4
 * already tells the client that the authoritative view comes from the GET
 * endpoints, so a client that sees `truncated` re-reads rather than rendering a
 * half event — and the write that produced the event still commits.
 */
export function encodeEvent(event: AppEvent): string {
  const full = JSON.stringify(event);
  if (Buffer.byteLength(full) <= NOTIFY_BUDGET_BYTES) return full;

  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.data)) {
    if (typeof value === 'string' && value.length > SHORT_STRING) continue;
    if (typeof value === 'object' && value !== null) continue;
    kept[key] = value;
  }
  return JSON.stringify({ type: event.type, data: kept, truncated: true });
}

/**
 * Broadcast one §16.4 event.
 *
 * Pass the transaction the state change is running in wherever there is one;
 * pass the pool only for an event that has no write behind it.
 */
export async function emitEvent(db: Queryable, event: AppEvent): Promise<void> {
  await db.query('SELECT pg_notify($1, $2)', [EVENT_CHANNEL, encodeEvent(event)]);
}
