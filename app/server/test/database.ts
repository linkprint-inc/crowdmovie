// One answer, in one place, to "which PostgreSQL database do the tests use?".
// Not a test file (the vitest glob only picks up `*.test.ts`).
//
// The default is unique per checkout, because a shared database is destructive:
// `resetStory()` truncates eight tables, ledger.test.ts deletes workflow_jobs
// before every case and schema.test.ts drops the schema outright. Two checkouts
// running the suite at once — the main tree and a git worktree, say — therefore
// delete each other's rows mid-test. What that produces looks exactly like a
// concurrency bug in the code under test (a claim that finds one job instead of
// three, a deadlock inside TRUNCATE, a row that vanishes between write and
// read), so the cost is not a flaky run, it is a day spent debugging the engine
// instead of the setup.
//
// Deriving the name from the checkout's own path makes that isolation automatic
// rather than something you have to know about, and keeps it stable: the same
// tree gets the same database on every run, so its schema and migrated state
// survive. CROWDMOVIE_TEST_DB (a name) and TEST_DATABASE_URL (a whole URL) still
// override it.
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const HOST = process.env.PGHOST ?? 'localhost';
const PORT = process.env.PGPORT ?? '5432';

/** This file is `<root>/app/server/test/database.ts`, so three levels up is `<root>/`. */
const CHECKOUT_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * `crowdmovie_test_<checkout>_<hash>`. The directory name is there so the
 * database is recognisable in `psql -l`; the hash of the absolute path is what
 * actually keeps two checkouts apart, including two named the same. The slug is
 * bounded so the whole identifier stays well inside PostgreSQL's 63 bytes and
 * the hash never gets truncated away.
 */
function defaultDatabaseName(): string {
  const slug = basename(CHECKOUT_ROOT)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  const digest = createHash('sha256')
    .update(CHECKOUT_ROOT)
    .digest('hex')
    .slice(0, 8);
  return ['crowdmovie_test', slug, digest].filter(Boolean).join('_');
}

export const TEST_DB = process.env.CROWDMOVIE_TEST_DB ?? defaultDatabaseName();

const ADMIN_URL = `postgresql://${HOST}:${PORT}/postgres`;

export const TEST_URL =
  process.env.TEST_DATABASE_URL ?? `postgresql://${HOST}:${PORT}/${TEST_DB}`;

/** Create the test database if this checkout has not run the suite before. */
export async function ensureDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    const exists = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [TEST_DB],
    );
    // CREATE DATABASE cannot run inside a transaction; a plain query is autocommit.
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${TEST_DB}"`);
  } finally {
    await admin.end();
  }
}

/** Use PostgreSQL's clock for PostgreSQL-generated deadlines, including VM tests. */
export async function databaseNow(pool: pg.Pool): Promise<number> {
  const result = await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  return result.rows[0]!.now.getTime();
}
