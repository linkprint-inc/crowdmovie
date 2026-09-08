// Shared fixtures for the T3.2 suites. Not a test file (the vitest glob only
// picks up `*.test.ts`), just the boilerplate both round suites need: a config
// with the round shortened to seconds, and a reset that empties the story tables
// without touching the identity tables the other suites populate. Which database
// that is comes from ./database, re-exported here so a round suite still gets
// its whole setup from one import.
import pg from 'pg';

import type { Config } from '../src/config';
import {
  WHOS_NEXT_MOVIE_ID,
  INLAND_EMPIRE_MOVIE_ID,
} from '../src/movies/catalog';
import { ensureDatabase, TEST_URL } from './database';

export { ensureDatabase, TEST_URL };

/**
 * A three-second round, a fast poll and a small retry budget. Everything else
 * matches production; the round length is the only thing a five-minute clock
 * makes untestable.
 */
export const testConfig: Config = {
  SERVICE_ROLE: 'worker',
  DATABASE_URL: TEST_URL,
  SESSION_SECRET: 'x'.repeat(32),
  PORT: 3100,
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
  // Deliberately a path that does not exist: any suite that reaches the publish
  // gate must point it at its own temp directory (see rounds.test.ts), and one
  // that does not is meant to fail validation rather than silently pass.
  MEDIA_DIR: '/nonexistent/crowdmovie-test-media',
  OUTBOX_PATH: '/dev/null',
  JOB_LEASE_MS: 5_000,
  JOB_POLL_INTERVAL_MS: 100,
  JOB_BACKOFF_BASE_MS: 20,
  JOB_MAX_ATTEMPTS: 3,
  ROUND_LENGTH_MS: 3_000,
  FINAL_TOP_K: 10,
  VOTE_ADOPT_THRESHOLD: 10,
  CODEX_SCORE_MODEL: 'gpt-5.6-terra',
  CODEX_MODEL: 'gpt-5.6-sol',
  CODEX_WORKSTATION_DIR: '/opt/crowdmovie/workstation',
  CODEX_SCORE_REASONING_EFFORT: 'high',
  CODEX_FINAL_REASONING_EFFORT: 'xhigh',
  CODEX_DIRECTOR_REASONING_EFFORT: 'xhigh',
  CODEX_OUTPUT_RETRIES: 2,
  CODEX_TURN_TIMEOUT_SECONDS: 300,
  H3_BASE_URL: 'http://192.168.10.20:8191',
  H3_POLL_INTERVAL_MS: 500,
  H3_REQUEST_TIMEOUT_MS: 30_000,
  H3_WORKFLOW_REPAIR_RETRIES: 2,
};

/**
 * Empty everything the round engine writes. `scene_index` starts from 1 again,
 * which is what lets the contiguity assertions be exact.
 *
 * The story-proposal tables are truncated here too: they hang off `users`, and
 * a suite that leaves a draft behind would trip the one-active-proposal index
 * for the next suite that reuses the identity.
 */
export async function resetStory(pool: pg.Pool): Promise<void> {
  await pool.query(
    `TRUNCATE scenes, submission_votes, submission_scores, submissions,
              rounds, episodes, ai_runs, workflow_jobs,
              story_comments, story_likes, story_images, story_proposals,
              site_settings CASCADE`,
  );
  await pinInlandTestSchedule(pool);
}

/**
 * Legacy API suites exercise the original Inland Empire pipeline. Pinning it
 * for the test makes those suites independent of the Los Angeles wall clock.
 */
export async function pinInlandTestSchedule(pool: pg.Pool): Promise<void> {
  await pool.query(
    `UPDATE movie_schedule_windows SET enabled = false WHERE generator_key = 'primary'`,
  );
  await pool.query(
    `UPDATE movie_schedule_windows
        SET movie_id = $1, start_minute = 0, end_minute = 1440, enabled = true
      WHERE id = '13000000-0000-4000-8000-000000000001'`,
    [INLAND_EMPIRE_MOVIE_ID],
  );
}

/**
 * Restore the two-movie 23:00/11:00 test schedule after time-independent tests.
 * Production (drizzle/0011) runs Who's Next all day; the switching suites keep
 * this synthetic layout to exercise the boundary and lease state machine.
 */
export async function restorePrimarySchedule(pool: pg.Pool): Promise<void> {
  await pool.query(
    `UPDATE movie_schedule_windows SET enabled = false WHERE generator_key = 'primary'`,
  );
  await pool.query(
    `UPDATE movie_schedule_windows
        SET movie_id = $1, start_minute = 0, end_minute = 660,
            label = 'Who''s Next · 夜间', enabled = true
      WHERE id = '13000000-0000-4000-8000-000000000001'`,
    [WHOS_NEXT_MOVIE_ID],
  );
  await pool.query(
    `UPDATE movie_schedule_windows
        SET movie_id = $1, start_minute = 660, end_minute = 1380,
            label = '内陆帝国高校 · 日间', enabled = true
      WHERE id = '13000000-0000-4000-8000-000000000002'`,
    [INLAND_EMPIRE_MOVIE_ID],
  );
  await pool.query(
    `UPDATE movie_schedule_windows
        SET movie_id = $1, start_minute = 1380, end_minute = 1440,
            label = 'Who''s Next · 夜间', enabled = true
      WHERE id = '13000000-0000-4000-8000-000000000003'`,
    [WHOS_NEXT_MOVIE_ID],
  );
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `probe` returns something truthy, so no test guesses a sleep. */
export async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
