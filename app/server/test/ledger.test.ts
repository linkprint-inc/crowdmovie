// T3.1 持久化任务账本 —《技术》§5.1 的五步顺序、§5.2 的通道划分、§5.3 的
// 断线重连补轮询。
//
// Integration tests against the same real PostgreSQL database the other suites
// use (vitest runs test files sequentially, see vitest.config.ts). The ledger
// *is* the queue, so every claim/lease/backoff property has to be proven against
// the real engine — SKIP LOCKED, transactional NOTIFY and `now()` semantics are
// exactly the parts a fake would get wrong.
import crypto from 'node:crypto';

import pg from 'pg';

import { runMigrations } from '../src/db/migrate';
import { INLAND_EMPIRE_MOVIE_ID } from '../src/movies/catalog';
import {
  CHANNEL_CONCURRENCY,
  channelJobTypes,
  claimNext,
  complete,
  enqueue,
  fail,
  JOB_CHANNEL,
  JOB_TYPES,
  ledgerSettings,
  recover,
  renewLease,
  startListener,
} from '../src/jobs/ledger';
import { ensureDatabase, TEST_URL } from './database';

let pool: pg.Pool;

const rnd = (): string => crypto.randomBytes(8).toString('hex');

/** Poll `predicate` until it holds, so no test has to guess a sleep duration. */
async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A `maintenance` job, due now unless told otherwise. */
async function seed(
  overrides: {
    jobType?: string;
    availableAt?: string;
    payload?: unknown;
    roundId?: string;
  } = {},
) {
  return enqueue(pool, {
    jobType: (overrides.jobType ?? 'maintenance') as 'maintenance',
    movieId:
      overrides.jobType === undefined || overrides.jobType === 'maintenance'
        ? undefined
        : INLAND_EMPIRE_MOVIE_ID,
    idempotencyKey: `test_${rnd()}`,
    payload: overrides.payload,
    roundId: overrides.roundId,
    availableAt: overrides.availableAt
      ? new Date(overrides.availableAt)
      : undefined,
  });
}

async function statusOf(id: string): Promise<string> {
  const r = await pool.query('SELECT status FROM workflow_jobs WHERE id = $1', [
    id,
  ]);
  return r.rows[0].status as string;
}

async function rowOf(id: string) {
  const r = await pool.query('SELECT * FROM workflow_jobs WHERE id = $1', [id]);
  return r.rows[0];
}

/** Pull `available_at` back into the past — the backoff test must not sleep. */
async function makeDue(id: string): Promise<void> {
  await pool.query(
    "UPDATE workflow_jobs SET available_at = now() - interval '1 second' WHERE id = $1",
    [id],
  );
}

beforeAll(async () => {
  await ensureDatabase();
  await runMigrations(TEST_URL);
  pool = new pg.Pool({ connectionString: TEST_URL });
});

afterAll(async () => {
  await pool.end();
});

// The ledger table is this suite's alone, and a leftover row from a previous
// file would be claimable by these tests.
beforeEach(async () => {
  await pool.query('DELETE FROM workflow_jobs');
});

// --- 入队：业务事务内插 pending + pg_notify（§5.1 第 1 步） -------------------

test('enqueue 写入 pending 行，attempt_count=0 且立即可领', async () => {
  const { job, created } = await seed({ payload: { submissionId: 'abc' } });
  expect(created).toBe(true);
  expect(job.status).toBe('pending');
  expect(job.attemptCount).toBe(0);
  expect(job.leaseExpiresAt).toBeNull();
  expect(job.startedAt).toBeNull();
  expect(job.payload).toEqual({ submissionId: 'abc' });
  expect(job.availableAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
});

test('同一个 idempotency_key 入队两次只产生一行，第二次返回既有任务', async () => {
  const key = `dup_${rnd()}`;
  const first = await enqueue(pool, {
    jobType: 'round_finalize',
    movieId: INLAND_EMPIRE_MOVIE_ID,
    idempotencyKey: key,
  });
  const second = await enqueue(pool, {
    jobType: 'round_finalize',
    movieId: INLAND_EMPIRE_MOVIE_ID,
    idempotencyKey: key,
    payload: { ignored: true },
  });

  expect(first.created).toBe(true);
  expect(second.created).toBe(false);
  expect(second.job.id).toBe(first.job.id);
  // The second call must not overwrite the first payload either.
  expect(second.job.payload).toBeNull();

  const count = await pool.query(
    'SELECT count(*)::int AS n FROM workflow_jobs WHERE idempotency_key = $1',
    [key],
  );
  expect(count.rows[0].n).toBe(1);
});

test('业务事务回滚后不留下任何任务行（账本与业务状态同生共死）', async () => {
  const key = `rollback_${rnd()}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { job } = await enqueue(client, {
      jobType: 'submission_score',
      movieId: INLAND_EMPIRE_MOVIE_ID,
      idempotencyKey: key,
    });
    // Visible inside the transaction...
    const inside = await client.query(
      'SELECT count(*)::int AS n FROM workflow_jobs WHERE id = $1',
      [job.id],
    );
    expect(inside.rows[0].n).toBe(1);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }

  const after = await pool.query(
    'SELECT count(*)::int AS n FROM workflow_jobs WHERE idempotency_key = $1',
    [key],
  );
  expect(after.rows[0].n).toBe(0);
});

test('pg_notify 在事务内不投递，随 COMMIT 才发出', async () => {
  const listener = new pg.Client({ connectionString: TEST_URL });
  await listener.connect();
  const seen: pg.Notification[] = [];
  listener.on('notification', (n) => seen.push(n));
  await listener.query('LISTEN "scoring"');

  const client = await pool.connect();
  let jobId = '';
  try {
    await client.query('BEGIN');
    const { job } = await enqueue(client, {
      jobType: 'submission_score',
      movieId: INLAND_EMPIRE_MOVIE_ID,
      idempotencyKey: `notify_${rnd()}`,
    });
    jobId = job.id;

    // A round trip on the listening connection guarantees any already-delivered
    // async message would have been parsed by now.
    await sleep(150);
    await listener.query('SELECT 1');
    expect(seen).toHaveLength(0);

    await client.query('COMMIT');
  } finally {
    client.release();
  }

  await waitFor(() => seen.length > 0, 'notification after commit');
  expect(seen[0].channel).toBe('scoring');
  expect(JSON.parse(seen[0].payload ?? '{}')).toMatchObject({
    id: jobId,
    jobType: 'submission_score',
  });
  await listener.end();
});

test('回滚的事务不发出任何通知', async () => {
  const listener = new pg.Client({ connectionString: TEST_URL });
  await listener.connect();
  const seen: pg.Notification[] = [];
  listener.on('notification', (n) => seen.push(n));
  await listener.query('LISTEN "round"');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await enqueue(client, {
      jobType: 'round_finalize',
      movieId: INLAND_EMPIRE_MOVIE_ID,
      idempotencyKey: `rollback_notify_${rnd()}`,
    });
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }

  await sleep(150);
  await listener.query('SELECT 1');
  expect(seen).toHaveLength(0);
  await listener.end();
});

// --- 领取：FOR UPDATE SKIP LOCKED（§5.1 第 2 步） ----------------------------

test('claimNext 置 running、写租约、attempt_count 加一', async () => {
  const { job } = await seed();
  const claimed = await claimNext(pool, ['maintenance'], { leaseMs: 30_000 });

  expect(claimed?.id).toBe(job.id);
  expect(claimed?.status).toBe('running');
  expect(claimed?.attemptCount).toBe(1);
  expect(claimed?.startedAt).not.toBeNull();
  const lease = claimed?.leaseExpiresAt?.getTime() ?? 0;
  expect(lease).toBeGreaterThan(Date.now());
  expect(lease).toBeLessThanOrEqual(Date.now() + 40_000);
});

test('并发两个 worker 领取同一任务：只有一个成功，另一个拿到 null', async () => {
  const { job } = await seed();

  // Two genuinely separate server connections, issued without awaiting in
  // between — SKIP LOCKED is what has to break the tie, not JS scheduling.
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    const [first, second] = await Promise.all([
      claimNext(a, ['maintenance']),
      claimNext(b, ['maintenance']),
    ]);
    const winners = [first, second].filter((j) => j !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.id).toBe(job.id);
  } finally {
    a.release();
    b.release();
  }

  expect(await statusOf(job.id)).toBe('running');
});

test('一个 worker 持有行锁时，另一个 worker 立即跳过而不是排队等它', async () => {
  const { job } = await seed();

  const holder = await pool.connect();
  const rival = await pool.connect();
  try {
    // Claim inside an explicit transaction so the row lock is still held when
    // the second worker arrives. This is the SKIP LOCKED contract in isolation:
    // the rival must come back empty-handed *immediately*, not block until the
    // holder commits and then claim the very same job.
    await holder.query('BEGIN');
    const mine = await claimNext(holder, ['maintenance']);
    expect(mine?.id).toBe(job.id);

    let settled = false;
    const rivalClaim = claimNext(rival, ['maintenance']).then((result) => {
      settled = true;
      return result;
    });

    await sleep(200);
    expect(settled).toBe(true); // did not queue behind the row lock
    expect(await rivalClaim).toBeNull();

    await holder.query('COMMIT');
  } finally {
    holder.release();
    rival.release();
  }

  expect(await statusOf(job.id)).toBe('running');
});

test('四个并发 worker 领三条任务：各得其一，无重复领取', async () => {
  const ids = new Set<string>();
  for (let i = 0; i < 3; i += 1) ids.add((await seed()).job.id);

  const clients = await Promise.all([
    pool.connect(),
    pool.connect(),
    pool.connect(),
    pool.connect(),
  ]);
  try {
    const claims = await Promise.all(
      clients.map((c) => claimNext(c, ['maintenance'])),
    );
    const claimed = claims.filter((j) => j !== null).map((j) => j.id);
    expect(claimed).toHaveLength(3);
    expect(new Set(claimed).size).toBe(3);
    expect(new Set(claimed)).toEqual(ids);
  } finally {
    for (const c of clients) c.release();
  }
});

test('一次 claimNext 只领走一条，哪怕计划器拿到的是过期统计信息', async () => {
  // The claim's locking scan has to be evaluated exactly once. Written as a
  // plain `id IN (SELECT ... LIMIT 1 FOR UPDATE SKIP LOCKED)` subquery it is not:
  // the planner may put it on the inner side of a semi join, where it is
  // re-executed per outer row and locks a fresh job each time. One claimNext()
  // then marks several jobs `running` — attempt spent, lease set — and returns
  // only the first, leaving the rest with no worker until §5.3's recovery scan
  // takes them back, one attempt poorer.
  //
  // Which plan gets chosen depends on the table statistics, so this test pins
  // the statistics that produce the bad one instead of waiting to be unlucky:
  // ANALYZE while the table is empty (beforeEach has just emptied it), then
  // queue the jobs, which is the state every other test here runs in.
  await pool.query('ANALYZE workflow_jobs');
  for (let i = 0; i < 3; i += 1) await seed();

  expect(await claimNext(pool, ['maintenance'])).not.toBeNull();

  const counts = await pool.query<{ status: string; n: string; attempts: string }>(
    `SELECT status, count(*) AS n, sum(attempt_count) AS attempts
       FROM workflow_jobs GROUP BY status ORDER BY status`,
  );
  // One claimed, two still queued with their attempt budget untouched.
  expect(counts.rows).toEqual([
    { status: 'pending', n: '2', attempts: '0' },
    { status: 'running', n: '1', attempts: '1' },
  ]);
});

test('claimNext 只领本通道的 job_type，且没有到期任务时返回 null', async () => {
  const { job } = await seed({ jobType: 'video_generate' });

  expect(await claimNext(pool, ['submission_score'])).toBeNull();
  expect(await claimNext(pool, ['scene_director', 'subtitle_author'])).toBeNull();
  expect((await claimNext(pool, ['video_generate']))?.id).toBe(job.id);
  expect(await claimNext(pool, ['video_generate'])).toBeNull();
});

test('available_at 未到的任务不可领', async () => {
  await seed({ availableAt: new Date(Date.now() + 60_000).toISOString() });
  expect(await claimNext(pool, ['maintenance'])).toBeNull();
});

// --- 完成与退避重试（§5.1 第 4 步，§5.2 退避规则） --------------------------

test('complete 置 succeeded 并清空租约；重复 complete 返回 false', async () => {
  const { job } = await seed();
  await claimNext(pool, ['maintenance']);

  expect(await complete(pool, job.id)).toBe(true);
  const row = await rowOf(job.id);
  expect(row.status).toBe('succeeded');
  expect(row.lease_expires_at).toBeNull();
  expect(row.finished_at).not.toBeNull();

  // Not running any more: a second completion (or one from a worker whose lease
  // was already stolen) must not silently succeed.
  expect(await complete(pool, job.id)).toBe(false);
  expect(await claimNext(pool, ['maintenance'])).toBeNull();
});

test('retryable_failed 的任务先不可领，available_at 到期后被重新领取', async () => {
  const { job } = await seed();
  await claimNext(pool, ['maintenance']);

  const failed = await fail(pool, job.id, 'upstream 429', { retryable: true });
  expect(failed?.status).toBe('retryable_failed');
  expect(failed?.lastError).toBe('upstream 429');
  expect(failed?.availableAt.getTime()).toBeGreaterThan(Date.now());

  // Backoff is a future `available_at`, not a sleep: the job is simply invisible
  // to claimNext until then.
  expect(await claimNext(pool, ['maintenance'])).toBeNull();

  await makeDue(job.id);
  const again = await claimNext(pool, ['maintenance']);
  expect(again?.id).toBe(job.id);
  expect(again?.attemptCount).toBe(2);
});

test('退避随尝试次数指数增长，且不超过上限', async () => {
  const { job } = await seed();
  const base = 1000;

  await claimNext(pool, ['maintenance']); // attempt 1
  const first = await fail(pool, job.id, 'e1', {
    retryable: true,
    backoffBaseMs: base,
  });
  const firstDelay = (first?.availableAt.getTime() ?? 0) - Date.now();
  // Equal jitter: half the window at minimum, the full window at most.
  expect(firstDelay).toBeGreaterThanOrEqual(base * 0.5 - 200);
  expect(firstDelay).toBeLessThanOrEqual(base + 200);

  await makeDue(job.id);
  await claimNext(pool, ['maintenance']); // attempt 2
  const second = await fail(pool, job.id, 'e2', {
    retryable: true,
    backoffBaseMs: base,
  });
  const secondDelay = (second?.availableAt.getTime() ?? 0) - Date.now();
  expect(secondDelay).toBeGreaterThanOrEqual(base - 200);
  expect(secondDelay).toBeLessThanOrEqual(base * 2 + 200);
});

test('重试次数用尽后进入 dead，不再被领取', async () => {
  const { job } = await seed();

  await claimNext(pool, ['maintenance']);
  const first = await fail(pool, job.id, 'boom', {
    retryable: true,
    maxAttempts: 2,
  });
  expect(first?.status).toBe('retryable_failed');

  await makeDue(job.id);
  await claimNext(pool, ['maintenance']); // attempt 2 of 2
  const second = await fail(pool, job.id, 'boom', {
    retryable: true,
    maxAttempts: 2,
  });
  expect(second?.status).toBe('dead');
  expect(second?.finishedAt).not.toBeNull();

  await makeDue(job.id);
  expect(await claimNext(pool, ['maintenance'])).toBeNull();
});

test('不可重试的失败直接进入 dead，不管还剩几次尝试', async () => {
  const { job } = await seed();
  await claimNext(pool, ['maintenance']);

  const dead = await fail(pool, job.id, 'schema mismatch', { retryable: false });
  expect(dead?.status).toBe('dead');
  expect(dead?.attemptCount).toBe(1);
  expect(await claimNext(pool, ['maintenance'])).toBeNull();
});

test('fail 只作用于 running 的任务', async () => {
  const { job } = await seed();
  expect(await fail(pool, job.id, 'never ran', { retryable: true })).toBeNull();
  expect(await statusOf(job.id)).toBe('pending');
});

// --- 租约续期（长任务：H3 生成以分钟计） ------------------------------------

test('renewLease 推后租约；非 running 的任务返回 null', async () => {
  const { job } = await seed();
  const claimed = await claimNext(pool, ['maintenance'], { leaseMs: 1000 });
  const before = claimed?.leaseExpiresAt?.getTime() ?? 0;

  const renewed = await renewLease(pool, job.id, 60_000);
  expect(renewed).not.toBeNull();
  expect(renewed?.getTime()).toBeGreaterThan(before);

  await complete(pool, job.id);
  expect(await renewLease(pool, job.id, 60_000)).toBeNull();
});

// --- 恢复扫描（§5.1 第 5 步） -----------------------------------------------

test('超租约的 running 被恢复扫描接管，租约仍有效的不受影响', async () => {
  const expired = (await seed()).job;
  const healthy = (await seed()).job;

  await claimNext(pool, ['maintenance'], { leaseMs: 60_000 });
  await claimNext(pool, ['maintenance'], { leaseMs: 60_000 });
  expect(await statusOf(expired.id)).toBe('running');
  expect(await statusOf(healthy.id)).toBe('running');

  // Only the first worker died: force its lease into the past.
  await pool.query(
    "UPDATE workflow_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
    [expired.id],
  );

  const result = await recover(pool);
  expect(result).toEqual({ requeued: 1, dead: [] });

  expect(await statusOf(expired.id)).toBe('pending');
  expect(await statusOf(healthy.id)).toBe('running');

  const requeued = await rowOf(expired.id);
  expect(requeued.lease_expires_at).toBeNull();
  expect(requeued.last_error).toMatch(/lease/i);
  // The dead worker's attempt was already counted at claim time.
  expect(requeued.attempt_count).toBe(1);

  const reclaimed = await claimNext(pool, ['maintenance']);
  expect(reclaimed?.id).toBe(expired.id);
  expect(reclaimed?.attemptCount).toBe(2);
});

test('恢复扫描不会让耗尽尝试次数的任务无限循环，直接判 dead', async () => {
  const { job } = await seed();
  await claimNext(pool, ['maintenance']);
  await pool.query(
    "UPDATE workflow_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
    [job.id],
  );

  // Reported one by one, not counted: the caller has to know *which* round is
  // now stranded so it can be failed (§5「生成失败时不得提前推进剧情」).
  expect(await recover(pool, { maxAttempts: 1 })).toEqual({
    requeued: 0,
    dead: [{ id: job.id, jobType: 'maintenance', roundId: null }],
  });
  expect(await statusOf(job.id)).toBe('dead');
});

test('没有超租约任务时 recover 什么也不改', async () => {
  const { job } = await seed();
  expect(await recover(pool)).toEqual({ requeued: 0, dead: [] });
  expect(await statusOf(job.id)).toBe('pending');
});

// --- 唤醒：LISTEN + 轮询兜底（§5.3） ----------------------------------------

test('NOTIFY 唤醒 worker', async () => {
  const wakes: string[] = [];
  const listener = startListener({
    connectionString: TEST_URL,
    channels: ['round'],
    pollIntervalMs: 60_000, // long enough that only NOTIFY can wake us
    onWake: (reason) => {
      wakes.push(reason);
    },
  });
  try {
    await waitFor(() => wakes.includes('connect'), 'initial connect wake');
    await enqueue(pool, {
      jobType: 'round_finalize',
      movieId: INLAND_EMPIRE_MOVIE_ID,
      idempotencyKey: `wake_${rnd()}`,
    });
    await waitFor(() => wakes.includes('notify'), 'notify wake');
  } finally {
    await listener.stop();
  }
});

test('NOTIFY 丢失时轮询兜底：不发通知的任务照样被领走', async () => {
  const wakes: string[] = [];
  const claimedOn: string[] = [];
  const listener = startListener({
    connectionString: TEST_URL,
    channels: ['maintenance'],
    pollIntervalMs: 50,
    onWake: async (reason) => {
      wakes.push(reason);
      const job = await claimNext(pool, ['maintenance']);
      if (job) claimedOn.push(reason);
    },
  });

  try {
    await waitFor(() => wakes.includes('connect'), 'initial connect wake');

    // Insert straight into the ledger with no pg_notify at all — this is what a
    // dropped notification looks like from the worker's side.
    const key = `poll_${rnd()}`;
    await pool.query(
      "INSERT INTO workflow_jobs (job_type, idempotency_key, status) VALUES ('maintenance', $1, 'pending')",
      [key],
    );

    await waitFor(() => claimedOn.length === 1, 'poll to pick the job up');
    expect(claimedOn[0]).toBe('poll');
    expect(wakes).not.toContain('notify');
  } finally {
    await listener.stop();
  }
});

test('LISTEN 断线重连后立即补一次全量轮询（§5.3）', async () => {
  const appName = `crowdmovie-test-listener-${rnd()}`;
  const wakes: string[] = [];
  const listener = startListener({
    connectionString: TEST_URL,
    channels: ['media'],
    pollIntervalMs: 60_000, // only connect/reconnect may wake us
    reconnectDelayMs: 20,
    applicationName: appName,
    onWake: (reason) => {
      wakes.push(reason);
    },
  });

  try {
    await waitFor(() => wakes.length === 1, 'initial connect wake');
    expect(wakes[0]).toBe('connect');

    // Kill the LISTEN connection the way a network blip or a database restart
    // would. Anything notified while it is down is lost forever, so the
    // reconnect itself has to trigger the full poll.
    const killed = await pool.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1',
      [appName],
    );
    expect(killed.rowCount).toBe(1);

    await waitFor(() => wakes.length === 2, 'wake after reconnect');
    expect(wakes[1]).toBe('connect');
  } finally {
    await listener.stop();
  }
});

test('stop 之后不再唤醒', async () => {
  const wakes: string[] = [];
  const listener = startListener({
    connectionString: TEST_URL,
    channels: ['subtitle'],
    pollIntervalMs: 20,
    onWake: (reason) => {
      wakes.push(reason);
    },
  });
  await waitFor(() => wakes.length >= 2, 'a poll wake');
  await listener.stop();

  const seen = wakes.length;
  await sleep(120);
  expect(wakes).toHaveLength(seen);
});

test('onWake 抛错不会打断监听（错误交给 onError）', async () => {
  const errors: Error[] = [];
  let calls = 0;
  const listener = startListener({
    connectionString: TEST_URL,
    channels: ['director'],
    pollIntervalMs: 20,
    onWake: () => {
      calls += 1;
      throw new Error('handler blew up');
    },
    onError: (error) => errors.push(error),
  });
  try {
    await waitFor(() => calls >= 3, 'wakes to keep coming after a throw');
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(errors[0].message).toBe('handler blew up');
  } finally {
    await listener.stop();
  }
});

// --- 通道划分与配置（§5.2） -------------------------------------------------

test('每个 job_type 都映射到一个通道，通道并发上限符合 §5.2', () => {
  for (const jobType of JOB_TYPES) {
    expect(JOB_CHANNEL[jobType]).toBeDefined();
  }
  expect(JOB_CHANNEL.submission_score).toBe('scoring');
  expect(JOB_CHANNEL.round_finalize).toBe('round');
  expect(JOB_CHANNEL.episode_bootstrap).toBe('director');
  expect(JOB_CHANNEL.ai_screenwriter).toBe('director');
  expect(JOB_CHANNEL.scene_director).toBe('director');
  expect(JOB_CHANNEL.episode_theme).toBe('director');
  expect(JOB_CHANNEL.video_generate).toBe('video');
  expect(JOB_CHANNEL.subtitle_author).toBe('subtitle');
  expect(JOB_CHANNEL.media_validate_publish).toBe('media');

  expect(CHANNEL_CONCURRENCY.scoring).toBe(2);
  for (const channel of ['director', 'round', 'video', 'subtitle', 'media'] as const) {
    expect(CHANNEL_CONCURRENCY[channel]).toBe(1);
  }

  expect(channelJobTypes('director')).toEqual([
    'episode_bootstrap',
    'ai_screenwriter',
    'scene_director',
    'episode_theme',
  ]);
});

test('ledgerSettings 从 env 读出可调项并带默认值', () => {
  const base = {
    SERVICE_ROLE: 'worker',
    DATABASE_URL: TEST_URL,
    SESSION_SECRET: 'x'.repeat(32),
    PORT: 3100,
    HOST: '127.0.0.1',
    LOG_LEVEL: 'info',
    OUTBOX_PATH: '/tmp/outbox.log',
  } as const;

  const defaults = ledgerSettings({
    ...base,
    JOB_LEASE_MS: 60_000,
    JOB_POLL_INTERVAL_MS: 2000,
    JOB_BACKOFF_BASE_MS: 1000,
    JOB_MAX_ATTEMPTS: 5,
  });
  expect(defaults).toEqual({
    leaseMs: 60_000,
    pollIntervalMs: 2000,
    backoffBaseMs: 1000,
    maxAttempts: 5,
  });
});
