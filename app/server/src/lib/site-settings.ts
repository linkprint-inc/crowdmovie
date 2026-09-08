// Runtime settings that operators must be able to change without restarting
// the web and worker processes (§16.6). Environment values remain the safe
// baseline; a malformed JSONB override never changes production behaviour.
import type { Queryable } from '../jobs/ledger.js';

export const VOTE_ADOPT_THRESHOLD_OVERRIDE_KEY =
  'vote_adopt_threshold_override';

export function automaticSceneLimitKey(movieId: string): string {
  return `movie:${movieId}:automatic_scene_limit`;
}

/**
 * Optional per-movie cap for the unattended AI Director loop. Missing or
 * malformed values disable automatic shots without affecting human input.
 */
export async function readAutomaticSceneLimit(
  db: Queryable,
  movieId: string,
): Promise<number | null> {
  const result = await db.query<{ value: unknown }>(
    'SELECT value FROM site_settings WHERE key = $1',
    [automaticSceneLimitKey(movieId)],
  );
  const value = result.rows[0]?.value;
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

/**
 * Read the one threshold shared by the banner, immediate shot election and episode
 * rotation. `jsonb` is decoded by node-postgres, so the valid stored shape is a
 * bare positive integer such as `7`, not `{ "value": 7 }` or the string `"7"`.
 */
export async function readVoteAdoptThreshold(
  db: Queryable,
  fallback: number,
): Promise<number> {
  const result = await db.query<{ value: unknown }>(
    'SELECT value FROM site_settings WHERE key = $1',
    [VOTE_ADOPT_THRESHOLD_OVERRIDE_KEY],
  );
  const value = result.rows[0]?.value;
  return Number.isSafeInteger(value) && (value as number) >= 1
    ? (value as number)
    : fallback;
}
