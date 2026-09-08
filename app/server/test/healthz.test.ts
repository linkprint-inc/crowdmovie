// /healthz must tell the truth: it runs real business-schema queries, so a
// reachable process in front of a dead or unmigrated database reports 503
// rather than a cheerful 200.
import pg from 'pg';

import { buildApp } from '../src/web/app';

const HOST = process.env.PGHOST ?? 'localhost';
const PORT = process.env.PGPORT ?? '5432';
// SELECT 1 needs no schema, so the always-present maintenance database is
// enough here — this file proves the round-trip, not the migrations.
const DB_URL =
  process.env.TEST_DATABASE_URL ?? `postgresql://${HOST}:${PORT}/postgres`;

const config = {
  SERVICE_ROLE: 'web',
  DATABASE_URL: DB_URL,
  SESSION_SECRET: 'x'.repeat(32),
  PORT: 3100,
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
} as const;

test('healthy database answers 200 with Codex and queue counters', async () => {
  // One connection keeps these deliberately minimal TEMP tables visible to
  // the request without mutating the developer's public test schema.
  const pool = new pg.Pool({ connectionString: DB_URL, max: 1 });
  await pool.query(`
    CREATE TEMP TABLE ai_runs (
      provider text NOT NULL,
      status text NOT NULL,
      usage_json jsonb,
      created_at timestamptz NOT NULL
    );
    CREATE TEMP TABLE workflow_jobs (status text NOT NULL);
    INSERT INTO ai_runs (provider, status, usage_json, created_at) VALUES
      ('openai_codex', 'succeeded',
       '{"input_tokens":100,"cached_input_tokens":40,"output_tokens":20,"reasoning_output_tokens":8}', now()),
      ('openai_codex', 'dead',
       '{"input_tokens":50,"output_tokens":10,"reasoning_output_tokens":3}', now()),
      ('stub-content-engine', 'dead',
       '{"input_tokens":999,"output_tokens":999}', now()),
      ('openai_codex', 'succeeded',
       '{"input_tokens":999,"output_tokens":999}', now() - interval '2 days');
    INSERT INTO workflow_jobs (status) VALUES
      ('pending'), ('pending'), ('running'), ('retryable_failed'), ('dead');
  `);
  const app = buildApp(config, pool);
  try {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      db: true,
      ai: {
        codexRunsToday: 2,
        codexFailuresToday: 1,
        inputTokensToday: 150,
        cachedInputTokensToday: 40,
        outputTokensToday: 30,
        reasoningOutputTokensToday: 11,
      },
      queue: { pending: 2, running: 1, retrying: 1, dead: 1 },
    });
  } finally {
    await app.close();
    await pool.end();
  }
});

test('unreachable database answers 503 with {db:false}', async () => {
  // Port 1 is unbindable without root, so this connect is refused immediately.
  const pool = new pg.Pool({
    connectionString: 'postgresql://127.0.0.1:1/nope',
    connectionTimeoutMillis: 1000,
  });
  const app = buildApp(config, pool);
  try {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ db: false });
  } finally {
    await app.close();
    await pool.end();
  }
});
