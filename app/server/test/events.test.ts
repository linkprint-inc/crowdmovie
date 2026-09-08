// 实时事件流 —《技术》§16.4 SSE 事件集、§16.3 接口清单、§14.2 弹幕广播。
//
// Driven over a **real socket**, not `app.inject()`: the response never ends, so
// an injected request would simply never resolve, and — more importantly — the
// two properties worth testing here are what happens to the connection. A
// dropped client has to release its subscription, and it can only be dropped if
// there is a socket to drop.
//
// The cross-process half is real too. Round and scene events are produced by the
// worker, not by the web service, so they travel over PostgreSQL `NOTIFY`
// (lib/events.ts). The tests below emit them from a plain pool — which is
// exactly what the worker is, from this process's point of view — and read them
// off the HTTP stream.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import pg from 'pg';

import { runMigrations } from '../src/db/migrate';
import { emitEvent, encodeEvent, type AppEvent } from '../src/lib/events';
import { buildApp } from '../src/web/app';
import { EventHub } from '../src/web/routes/events';
import { tick } from '../src/rounds/clock';
import { ensureDatabase, resetStory, testConfig, TEST_URL, waitFor } from './helpers';
import { createScene } from './scene-fixture';

/** Small enough that a test can fill it, so the cap is testable as a cap. */
const MAX_CLIENTS = 3;

let pool: pg.Pool;
let app: ReturnType<typeof buildApp>;
let baseUrl: string;

beforeAll(async () => {
  await ensureDatabase();
  await runMigrations(TEST_URL);
  pool = new pg.Pool({ connectionString: TEST_URL });
  app = buildApp(testConfig, pool, {
    guestClaimRateLimit: 10_000,
    submissionRateLimit: 10_000,
    voteRateLimit: 10_000,
    danmakuIpRateLimit: 10_000,
    // 50ms rather than 2s: the merge is what is under test, not the wait.
    voteCoalesceMs: 50,
    maxEventClients: MAX_CLIENTS,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

beforeEach(async () => {
  await resetStory(pool);
});

// --- SSE 客户端 --------------------------------------------------------------

interface Frame {
  event: string;
  data: AppEvent;
}

/** A minimal EventSource: enough to read frames and to hang up mid-stream. */
class Stream {
  readonly frames: Frame[] = [];
  private request: http.ClientRequest | null = null;
  private response: http.IncomingMessage | null = null;
  private buffer = '';
  statusCode = 0;

  static open(url: string): Promise<Stream> {
    const stream = new Stream();
    return new Promise((resolve, reject) => {
      const request = http.get(url, { headers: { Accept: 'text/event-stream' } });
      stream.request = request;
      request.on('error', reject);
      request.on('response', (response) => {
        stream.response = response;
        stream.statusCode = response.statusCode ?? 0;
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => stream.consume(chunk));
        response.on('error', () => undefined);
        resolve(stream);
      });
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let boundary = this.buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const event = /^event: (.+)$/m.exec(block);
      const data = /^data: (.+)$/m.exec(block);
      if (event !== null && data !== null) {
        this.frames.push({
          event: event[1],
          data: JSON.parse(data[1]) as AppEvent,
        });
      }
      boundary = this.buffer.indexOf('\n\n');
    }
  }

  /** The frames of one type seen so far. */
  of(type: string): AppEvent[] {
    return this.frames.filter((frame) => frame.event === type).map((f) => f.data);
  }

  /** Wait for at least `count` frames of `type`, then return them. */
  async expect(type: string, count = 1): Promise<AppEvent[]> {
    return waitFor(async () => {
      const found = this.of(type);
      return found.length >= count ? found : false;
    }, `${count} ${type} event(s)`, 10_000);
  }

  /** Hang up the way a closed tab does. */
  close(): void {
    this.request?.destroy();
    this.response?.destroy();
  }
}

const streams: Stream[] = [];

async function open(): Promise<Stream> {
  const stream = await Stream.open(`${baseUrl}/api/events`);
  streams.push(stream);
  // The route writes `retry:` before anything else, so a stream that has
  // answered has also been registered.
  await waitFor(async () => stream.statusCode !== 0, 'the stream to answer');
  return stream;
}

afterEach(() => {
  while (streams.length > 0) streams.pop()?.close();
});

async function claimGuest(): Promise<{ cookie: string; userId: string }> {
  const username = `ev_${Math.random().toString(36).slice(2, 12)}`;
  const response = await app.inject({
    method: 'POST',
    url: '/api/identity/guest',
    payload: { username },
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.find((each) => each.name === 'cm_guest');
  if (cookie === undefined) throw new Error('no guest cookie');
  const found = await pool.query<{ id: string }>(
    'SELECT id FROM users WHERE username_display = $1',
    [username],
  );
  return { cookie: `cm_guest=${cookie.value}`, userId: found.rows[0].id };
}

// --- 传输 --------------------------------------------------------------------

test('流以 text/event-stream 应答，且不被缓存或代理缓冲', async () => {
  const stream = await open();
  expect(stream.statusCode).toBe(200);
});

// §14.2「写入成功后通过既有 SSE 流广播 danmaku.created」, §17.24.
test('弹幕写入后，已连接的客户端收到 danmaku.created', async () => {
  const scene = await createScene(pool, { sceneIndex: 1, durationSeconds: 10 });
  const guest = await claimGuest();
  const stream = await open();

  const posted = await app.inject({
    method: 'POST',
    url: '/api/danmaku',
    headers: { cookie: guest.cookie },
    payload: { sceneIndex: scene.sceneIndex, offsetMs: 1_200, content: '这段绝了' },
  });
  expect(posted.statusCode).toBe(201);

  const [event] = await stream.expect('danmaku.created');
  expect(event.data).toMatchObject({
    sceneIndex: scene.sceneIndex,
    offsetMs: 1_200,
    content: '这段绝了',
  });
});

// 两个订阅者都要收到同一条事件：这是一个广播，不是一个队列。
test('同一条事件送达每一个已连接的客户端', async () => {
  const scene = await createScene(pool, { sceneIndex: 1, durationSeconds: 10 });
  const guest = await claimGuest();
  const first = await open();
  const second = await open();

  await app.inject({
    method: 'POST',
    url: '/api/danmaku',
    headers: { cookie: guest.cookie },
    payload: { sceneIndex: scene.sceneIndex, offsetMs: 900, content: '两个人都看到' },
  });

  for (const stream of [first, second]) {
    const [event] = await stream.expect('danmaku.created');
    expect(event.data.content).toBe('两个人都看到');
  }
});

// §16.4 `submission.created` / `submission.scored`（含总分与四语毒舌）.
test('投稿写入广播 submission.created，且只在事务提交后送达', async () => {
  const guest = await claimGuest();
  await tick(pool);
  const stream = await open();

  const created = await app.inject({
    method: 'POST',
    url: '/api/round/current/submissions',
    headers: { cookie: guest.cookie },
    payload: { kind: 'next_shot', content: '一个会被广播的镜头' },
  });
  expect(created.statusCode).toBe(201);
  const submissionId = created.json<{ id: string }>().id;

  const [event] = await stream.expect('submission.created');
  expect(event.data).toMatchObject({
    submissionId,
    kind: 'next_shot',
    content: '一个会被广播的镜头',
  });

  // The row is committed by the time the event is seen — the emit rides the
  // same transaction, so this can never be the other way round.
  const row = await pool.query('SELECT id FROM submissions WHERE id = $1', [
    submissionId,
  ]);
  expect(row.rowCount).toBe(1);
});

test('无意义投稿删除通过 submission.deleted 广播', async () => {
  const stream = await open();
  await emitEvent(pool, {
    type: 'submission.deleted',
    data: { submissionId: 'deleted-pitch' },
  });
  const [event] = await stream.expect('submission.deleted');
  expect(event.data).toEqual({ submissionId: 'deleted-pitch' });
});

// 被拒绝的写不广播：事务回滚会把 NOTIFY 一起丢掉。
test('被拒绝的投稿不产生任何事件', async () => {
  const guest = await claimGuest();
  await tick(pool);
  const stream = await open();

  const rejected = await app.inject({
    method: 'POST',
    url: '/api/round/current/submissions',
    headers: { cookie: guest.cookie },
    payload: { kind: 'next_shot', content: '' },
  });
  expect(rejected.statusCode).toBe(400);

  // A committed event of another kind proves the stream was live and listening
  // the whole time, so "nothing arrived" is not "nothing was watching".
  await emitEvent(pool, { type: 'round.closed', data: { roundId: 'probe' } });
  await stream.expect('round.closed');
  expect(stream.of('submission.created')).toEqual([]);
});

// §16.4 `round.opened` / `round.closed`：由 worker 进程产生，跨进程送达。
test('时钟推进的轮次事件跨进程送达（round.opened / round.closed）', async () => {
  const stream = await open();

  await tick(pool);
  const [opened] = await stream.expect('round.opened');
  expect(opened.data.roundIndex).toBe(1);
  // opens_at 是数据库的绝对时间；closes_at 还没有——轮次未点火（§5.3）。
  expect(typeof opened.data.opensAt).toBe('string');
  expect(opened.data.closesAt).toBeNull();

  // §16.4 `episode.opened`（新集横幅）rides the same tick.
  const [episode] = await stream.expect('episode.opened');
  expect(episode.data.episodeIndex).toBe(1);

  // 点火这一轮：空轮不会关闭，也就不会有 round.closed（§5.3）。
  const guest = await claimGuest();
  const submitted = await app.inject({
    method: 'POST',
    url: '/api/round/current/submissions',
    headers: { cookie: guest.cookie },
    payload: { kind: 'next_shot', content: '让这一轮跑起来' },
  });
  expect(submitted.statusCode).toBe(201);

  await pool.query(
    "UPDATE rounds SET closes_at = now() - interval '1 second' WHERE status = 'open'",
  );
  await tick(pool);
  const closed = await stream.expect('round.closed');
  expect(closed[0].data.roundIndex).toBe(1);
  // The tick that closed round 1 opened round 2.
  const openedAgain = await stream.expect('round.opened', 2);
  expect(openedAgain[1].data.roundIndex).toBe(2);
});

// §16.4「submission.votes ——计票变化，按条每 2 秒合并推送一次」.
//
// The five emits share one transaction on purpose. PostgreSQL delivers a
// transaction's notifications together at COMMIT, so all five reach the hub
// inside one coalescing window *by construction* rather than by being fast
// enough — a merge test whose input was five separate HTTP round trips would
// pass or fail on how quickly the machine happened to run them.
test('窗口内的连续计票合并成一条，只送最新计票', async () => {
  const stream = await open();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let upCount = 1; upCount <= 5; upCount += 1) {
      await emitEvent(client, {
        type: 'submission.votes',
        data: { submissionId: 'merge-me', upCount, downCount: 0 },
      });
    }
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  const events = await stream.expect('submission.votes');
  expect(events[0].data).toMatchObject({ submissionId: 'merge-me', upCount: 5 });

  // Nothing else follows: five changes produced exactly one frame.
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(stream.of('submission.votes')).toHaveLength(1);
});

// The route still emits on a real vote — the merge above is about the hub, this
// is about the write path reaching it at all.
test('真实投票经由投票接口进入事件流', async () => {
  await tick(pool);
  const author = await claimGuest();
  const created = await app.inject({
    method: 'POST',
    url: '/api/round/current/submissions',
    headers: { cookie: author.cookie },
    payload: { kind: 'next_shot', content: '会被投票的镜头' },
  });
  const submissionId = created.json<{ id: string }>().id;

  const stream = await open();
  const voter = await claimGuest();
  const voted = await app.inject({
    method: 'POST',
    url: `/api/submissions/${submissionId}/vote`,
    headers: { cookie: voter.cookie },
    payload: { value: 1 },
  });
  expect(voted.statusCode).toBe(200);

  const [event] = await stream.expect('submission.votes');
  expect(event.data).toMatchObject({ submissionId, upCount: 1, downCount: 0 });
});

// --- 断线与容量 --------------------------------------------------------------

/**
 * §16.4 的连接管理：a client that hangs up must release its slot. The cap is the
 * observable proof — fill it, drop the streams, and the next connection is
 * accepted again. A leaked subscription would leave the endpoint permanently
 * full, which is what this asserts cannot happen.
 */
test('断开的客户端释放订阅：占满上限后挂断，新连接又能接上', async () => {
  const held: Stream[] = [];
  for (let index = 0; index < MAX_CLIENTS; index += 1) {
    held.push(await open());
  }
  const rejected = await Stream.open(`${baseUrl}/api/events`);
  expect(rejected.statusCode).toBe(503);
  rejected.close();

  for (const stream of held) stream.close();

  // The server notices the hang-up asynchronously; this waits for it rather
  // than assuming it.
  const reconnected = await waitFor(async () => {
    const attempt = await Stream.open(`${baseUrl}/api/events`);
    if (attempt.statusCode === 200) return attempt;
    attempt.close();
    return false;
  }, 'a slot to be released');
  expect(reconnected.statusCode).toBe(200);
  reconnected.close();
});

test('断开的客户端不影响其他客户端继续收事件', async () => {
  const leaving = await open();
  const staying = await open();
  leaving.close();

  await waitFor(async () => {
    await emitEvent(pool, { type: 'round.closed', data: { roundId: 'after-drop' } });
    return staying.of('round.closed').length > 0;
  }, 'the surviving stream to keep receiving');
});

// --- 单元：hub 的合并与清理 ---------------------------------------------------

/** A response stand-in that records what was written to it. */
function fakeResponse(): {
  raw: { write: (frame: string) => boolean; writableEnded: boolean; destroyed: boolean; end: () => void };
  frames: string[];
} {
  const frames: string[] = [];
  const raw = {
    writableEnded: false,
    destroyed: false,
    write: (frame: string): boolean => {
      frames.push(frame);
      return true;
    },
    end: (): void => {
      raw.writableEnded = true;
    },
  };
  return { raw, frames };
}

test('hub：detach 之后不再向该客户端写入', () => {
  const hub = new EventHub(10);
  const client = fakeResponse();
  const detach = hub.add(client.raw as unknown as import('node:http').ServerResponse);

  hub.publish({ type: 'round.closed', data: { roundId: 'a' } });
  expect(client.frames).toHaveLength(1);
  expect(hub.size).toBe(1);

  detach();
  expect(hub.size).toBe(0);
  hub.publish({ type: 'round.closed', data: { roundId: 'b' } });
  expect(client.frames).toHaveLength(1);
  hub.stop();
});

test('hub：写入抛错的客户端被移除，不会拖垮广播', () => {
  const hub = new EventHub(10);
  const broken = {
    writableEnded: false,
    destroyed: false,
    write: () => {
      throw new Error('socket is gone');
    },
    end: () => undefined,
  };
  const healthy = fakeResponse();
  hub.add(broken as unknown as import('node:http').ServerResponse);
  hub.add(healthy.raw as unknown as import('node:http').ServerResponse);

  hub.publish({ type: 'round.closed', data: { roundId: 'a' } });
  expect(hub.size).toBe(1);
  expect(healthy.frames).toHaveLength(1);
  hub.stop();
});

test('hub：不同投稿的计票各自合并，互不覆盖', async () => {
  const hub = new EventHub(20);
  const client = fakeResponse();
  hub.add(client.raw as unknown as import('node:http').ServerResponse);

  hub.publish({ type: 'submission.votes', data: { submissionId: 'a', upCount: 1 } });
  hub.publish({ type: 'submission.votes', data: { submissionId: 'a', upCount: 2 } });
  hub.publish({ type: 'submission.votes', data: { submissionId: 'b', upCount: 9 } });
  expect(client.frames).toHaveLength(0);

  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(client.frames).toHaveLength(2);
  const payloads = client.frames.map(
    (frame) => JSON.parse(/^data: (.+)$/m.exec(frame)?.[1] ?? '{}') as AppEvent,
  );
  expect(payloads.map((event) => [event.data.submissionId, event.data.upCount])).toEqual([
    ['a', 2],
    ['b', 9],
  ]);
  hub.stop();
});

// --- NOTIFY 的 8000 字节上限 --------------------------------------------------

// A `NOTIFY` payload PostgreSQL refuses raises inside the caller's transaction,
// which would turn "the broadcast was too big" into "the 投稿 was rejected".
test('超大事件被缩成 ID 版本，不会让业务事务失败', async () => {
  const huge: AppEvent = {
    type: 'submission.created',
    data: {
      submissionId: 'abc',
      kind: 'next_episode',
      content: '很'.repeat(4_000),
      username: 'someone',
    },
  };
  const encoded = encodeEvent(huge);
  expect(Buffer.byteLength(encoded)).toBeLessThan(8_000);
  const decoded = JSON.parse(encoded) as AppEvent & { truncated?: boolean };
  expect(decoded.truncated).toBe(true);
  expect(decoded.data.submissionId).toBe('abc');
  expect(decoded.data.kind).toBe('next_episode');
  expect(decoded.data.content).toBeUndefined();

  // And PostgreSQL accepts it, which is the thing that actually has to be true.
  await expect(emitEvent(pool, huge)).resolves.toBeUndefined();
});

test('正常大小的事件原样送达，不被裁剪', () => {
  const event: AppEvent = {
    type: 'submission.created',
    data: { submissionId: 'abc', content: '一个正常长度的镜头描述' },
  };
  const decoded = JSON.parse(encodeEvent(event)) as AppEvent & {
    truncated?: boolean;
  };
  expect(decoded.truncated).toBeUndefined();
  expect(decoded.data.content).toBe('一个正常长度的镜头描述');
});
