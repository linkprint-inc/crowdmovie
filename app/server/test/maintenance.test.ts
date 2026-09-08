// §16.5 hourly housekeeping: durable scheduling, expired credential cleanup,
// missed vote freezes, and operational Codex/queue telemetry.
import crypto from 'node:crypto';

import pg from 'pg';

import { createStubEngine } from '../src/ai/stub';
import { runMigrations } from '../src/db/migrate';
import { INLAND_EMPIRE_MOVIE_ID } from '../src/movies/catalog';
import {
  MAINTENANCE_HANDLERS,
  maintenanceHandler,
} from '../src/jobs/handlers/index';
import type { WorkerLogger } from '../src/jobs/handlers/common';
import { maintenanceJobKey } from '../src/jobs/keys';
import { startWorker } from '../src/jobs/scheduler';
import type { Job } from '../src/jobs/ledger';
import {
  ensureDatabase,
  resetStory,
  testConfig,
  TEST_URL,
  waitFor,
} from './helpers';
import { createEpisode, createRound, createSubmission } from './story-fixture';

let pool: pg.Pool;

const rnd = (): string => crypto.randomBytes(8).toString('hex');

beforeAll(async () => {
  await ensureDatabase();
  await runMigrations(TEST_URL);
  pool = new pg.Pool({ connectionString: TEST_URL });
}, 60_000);

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query('DELETE FROM sessions');
  await pool.query('DELETE FROM password_resets');
  await resetStory(pool);
});

function fakeJob(): Job {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    roundId: null,
    jobType: 'maintenance',
    idempotencyKey: maintenanceJobKey(now),
    status: 'running',
    upstreamJobId: null,
    payload: null,
    attemptCount: 1,
    availableAt: now,
    leaseExpiresAt: new Date(now.getTime() + 60_000),
    lastError: null,
    createdAt: now,
    startedAt: now,
    finishedAt: null,
    updatedAt: now,
  };
}

const settings = {
  topK: 10,
  voteAdoptThreshold: 10,
  deferDelayMs: 100,
  mediaDir: '/tmp/crowdmovie-test-media',
  h3PollIntervalMs: 500,
  h3WorkflowRepairRetries: 2,
};

test('maintenance job key deduplicates every UTC hour', () => {
  expect(maintenanceJobKey(new Date('2026-08-30T17:01:02.003Z'))).toBe(
    'maintenance:2026-08-30T17:00:00.000Z',
  );
  expect(maintenanceJobKey(new Date('2026-08-30T17:59:59.999Z'))).toBe(
    'maintenance:2026-08-30T17:00:00.000Z',
  );
});

test('maintenance cleans only dead credentials, freezes stale votes and logs health', async () => {
  const suffix = rnd();
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (username_display, username_key, guest_token_hash)
     VALUES ($1, $1, $2) RETURNING id`,
    [`maint_${suffix}`, `guest_${suffix}`],
  );
  const userId = user.rows[0].id;

  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at, revoked_at) VALUES
       ($1, $2, now() - interval '1 minute', NULL),
       ($1, $3, now() + interval '1 hour', now()),
       ($1, $4, now() + interval '1 hour', NULL)`,
    [userId, `expired_${suffix}`, `revoked_${suffix}`, `active_${suffix}`],
  );
  await pool.query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at, used_at) VALUES
       ($1, $2, now() - interval '1 minute', NULL),
       ($1, $3, now() + interval '1 hour', now()),
       ($1, $4, now() + interval '1 hour', NULL)`,
    [userId, `expired_${suffix}`, `used_${suffix}`, `active_${suffix}`],
  );

  const endedEpisode = await createEpisode(pool, { status: 'ended' });
  const openEpisode = await createEpisode(pool, { status: 'open' });
  const publishedRound = await createRound(pool, {
    episodeId: endedEpisode.id,
    status: 'published',
  });
  const openRound = await createRound(pool, {
    episodeId: openEpisode.id,
    status: 'open',
  });
  const frozenShot = await createSubmission(pool, {
    userId,
    episodeId: endedEpisode.id,
    roundId: publishedRound.id,
  });
  const liveShot = await createSubmission(pool, {
    userId,
    episodeId: openEpisode.id,
    roundId: openRound.id,
  });
  const frozenTheme = await createSubmission(pool, {
    userId,
    episodeId: endedEpisode.id,
    kind: 'next_episode',
  });
  const liveTheme = await createSubmission(pool, {
    userId,
    episodeId: openEpisode.id,
    kind: 'next_episode',
  });

  await pool.query(
    `INSERT INTO ai_runs
       (movie_id, round_id, run_type, provider, model, reasoning_effort,
        usage_json,
        status, created_at, finished_at)
     VALUES ($1, $2, 'submission_score', 'openai_codex', 'gpt-5.6-terra',
             'high', $3::jsonb, 'succeeded', now(), now()),
            ($1, $2, 'submission_score', 'openai_codex', 'gpt-5.6-terra',
             'high', $4::jsonb, 'dead', now(), now())`,
    [
      INLAND_EMPIRE_MOVIE_ID,
      publishedRound.id,
      JSON.stringify({
        input_tokens: 100,
        cached_input_tokens: 40,
        output_tokens: 20,
        reasoning_output_tokens: 8,
      }),
      JSON.stringify({ input_tokens: 50, output_tokens: 10 }),
    ],
  );
  await pool.query(
    `INSERT INTO workflow_jobs
       (job_type, idempotency_key, status, available_at)
     VALUES ('maintenance', $1, 'pending', now() - interval '2 seconds'),
            ('maintenance', $2, 'retryable_failed', now() - interval '1 second'),
            ('maintenance', $3, 'dead', now())`,
    [`pending_${suffix}`, `retry_${suffix}`, `dead_${suffix}`],
  );

  const logs: { details: Record<string, unknown>; message: string }[] = [];
  const log: WorkerLogger = {
    info: (details, message) => logs.push({ details, message }),
    warn: () => undefined,
    error: () => undefined,
  };
  await maintenanceHandler({
    pool,
    engine: createStubEngine(),
    job: fakeJob(),
    settings,
    log,
  });

  const sessions = await pool.query<{ token_hash: string }>(
    'SELECT token_hash FROM sessions WHERE user_id = $1 ORDER BY token_hash',
    [userId],
  );
  expect(sessions.rows.map((row) => row.token_hash)).toEqual([
    `active_${suffix}`,
  ]);
  const resets = await pool.query<{ token_hash: string }>(
    'SELECT token_hash FROM password_resets WHERE user_id = $1 ORDER BY token_hash',
    [userId],
  );
  expect(resets.rows.map((row) => row.token_hash)).toEqual([
    `active_${suffix}`,
  ]);

  const votes = await pool.query<{ id: string; frozen: boolean }>(
    `SELECT id, votes_frozen_at IS NOT NULL AS frozen
       FROM submissions WHERE id = ANY($1::uuid[])`,
    [[frozenShot.id, liveShot.id, frozenTheme.id, liveTheme.id]],
  );
  expect(new Map(votes.rows.map((row) => [row.id, row.frozen]))).toEqual(
    new Map([
      [frozenShot.id, true],
      [liveShot.id, false],
      [frozenTheme.id, true],
      [liveTheme.id, false],
    ]),
  );

  const completed = logs.find(
    (entry) => entry.message === 'hourly maintenance completed',
  );
  expect(completed?.details).toMatchObject({
    cleanup: {
      expiredOrRevokedSessions: 2,
      expiredOrUsedPasswordResets: 2,
      frozenRoundVotes: 1,
      frozenEpisodeVotes: 1,
    },
    queue: { pending: 1, running: 0, retrying: 1, dead: 1 },
    codexToday: [
      {
        runType: 'submission_score',
        runs: 2,
        failures: 1,
        inputTokens: 150,
        cachedInputTokens: 40,
        outputTokens: 30,
        reasoningOutputTokens: 8,
      },
    ],
  });
});

test('ordinary worker durably enqueues and completes one job for the current hour', async () => {
  const worker = startWorker({
    pool,
    config: { ...testConfig, JOB_POLL_INTERVAL_MS: 20 },
    engine: createStubEngine(),
    handlers: MAINTENANCE_HANDLERS,
    maintenanceIntervalMs: 25,
  });
  try {
    const row = await waitFor(async () => {
      const found = await pool.query<{ status: string }>(
        `SELECT status FROM workflow_jobs
          WHERE idempotency_key = $1`,
        [maintenanceJobKey(new Date())],
      );
      return found.rows[0]?.status === 'succeeded' ? found.rows[0] : null;
    }, 'hourly maintenance job to succeed');
    expect(row.status).toBe('succeeded');

    await new Promise((resolve) => setTimeout(resolve, 80));
    const count = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM workflow_jobs
        WHERE idempotency_key = $1`,
      [maintenanceJobKey(new Date())],
    );
    expect(count.rows[0].n).toBe(1);
  } finally {
    await worker.stop();
  }
});
