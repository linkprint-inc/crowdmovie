// 名人堂 (§16.3) — `GET /api/hall-of-fame`.
//
// §16.2 decides the shape of this file before any code is written:
// 「「我的剧本」统计卡与「名人堂」全部由查询派生，MVP 不做物化表」, with the
// three derivations spelled out:
//   * 已采用数 / 名人堂主榜：`scenes GROUP BY credit_user_id`（排除
//     `takedown_at IS NOT NULL`）;
//   * 累计获赞：用户投稿冻结后的净赞求和;
//   * 定过集主题：`episodes.theme_source_submission_id → submissions.user_id`.
// and it ends with the one piece of infrastructure it permits:
// 「名人堂查询加 60 秒进程内缓存即可，无需更多基础设施」.
//
// So: no leaderboard table, no Redis, one query, one in-process cache. The
// takedown exclusion is not decoration — §17.32 says a 下架 片段 disappears from
// 统计 as well as from the playlist, and this board *is* the statistic.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

/** §16.2「加 60 秒进程内缓存即可」. */
export const HALL_OF_FAME_TTL_MS = 60_000;

/** The board is a page, not a data export. */
export const HALL_OF_FAME_LIMIT = 100;

interface HallRow {
  username: string;
  accepted_count: number;
  net_votes: number;
  theme_episode_indexes: number[] | null;
}

interface HallEntry {
  username: string;
  acceptedCount: number;
  netVotes: number;
  /** The first episode they set the theme of, or null — the medal on the row. */
  themeEpisodeIndex: number | null;
  /** Every one of them, for a contributor who has set more than one. */
  themeEpisodeIndexes: number[];
}

/**
 * The three derivations of §16.2, as three independent per-user aggregates over
 * `users`. They are subqueries rather than joins for the same reason as in
 * episodes.ts: joining `scenes` and `submissions` onto one user row multiplies
 * the two counts together.
 *
 * The board lists whoever has at least one adopted scene *or* at least one
 * authored episode theme — the two things §16.2 calls a contribution. Someone
 * whose only trace is votes on unadopted 投稿 is not on it, which is what
 * 「按被采用片段数排名」means.
 */
const HALL_QUERY = `
  WITH stats AS (
    SELECT u.id,
           u.username_display AS username,
           (SELECT count(*)::int FROM scenes s
             WHERE s.credit_user_id = u.id AND s.takedown_at IS NULL)
             AS accepted_count,
           coalesce((SELECT sum(sub.up_count - sub.down_count)::int
                       FROM submissions sub
                      WHERE sub.user_id = u.id
                        AND sub.votes_frozen_at IS NOT NULL), 0) AS net_votes,
           (SELECT array_agg(e.episode_index ORDER BY e.episode_index)
              FROM episodes e
              JOIN submissions src ON src.id = e.theme_source_submission_id
             WHERE src.user_id = u.id) AS theme_episode_indexes
      FROM users u
  )
  SELECT username, accepted_count, net_votes, theme_episode_indexes
    FROM stats
   WHERE accepted_count > 0 OR theme_episode_indexes IS NOT NULL
   ORDER BY accepted_count DESC, net_votes DESC, username ASC
   LIMIT $1`;

export interface HallOfFameRoutesOptions {
  pool: Pool;
  /** Overrides the §16.2 cache window; tests pin it to 0 to read through. */
  hallOfFameTtlMs?: number;
}

export async function hallOfFameRoutes(
  app: FastifyInstance,
  options: HallOfFameRoutesOptions,
): Promise<void> {
  const { pool } = options;
  const ttlMs = options.hallOfFameTtlMs ?? HALL_OF_FAME_TTL_MS;

  let cached: HallEntry[] | null = null;
  let expiresAt = 0;
  /** In-flight read, shared: a cold cache under load runs one query, not N. */
  let inFlight: Promise<HallEntry[]> | null = null;

  async function read(): Promise<HallEntry[]> {
    const rows = await pool.query<HallRow>(HALL_QUERY, [HALL_OF_FAME_LIMIT]);
    return rows.rows.map((row) => {
      const themes = row.theme_episode_indexes ?? [];
      return {
        username: row.username,
        acceptedCount: row.accepted_count,
        netVotes: row.net_votes,
        themeEpisodeIndex: themes[0] ?? null,
        themeEpisodeIndexes: themes,
      };
    });
  }

  async function entries(): Promise<HallEntry[]> {
    const now = Date.now();
    if (cached !== null && now < expiresAt) return cached;
    if (inFlight !== null) return inFlight;

    inFlight = read()
      .then((fresh) => {
        cached = fresh;
        expiresAt = Date.now() + ttlMs;
        return fresh;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  app.get('/api/hall-of-fame', async () => ({ entries: await entries() }));
}
