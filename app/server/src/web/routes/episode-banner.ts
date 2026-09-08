// 放映厅·集横幅 (§16.3) — `GET /api/episode/current` and
// `GET /api/episode/current/proposals`.
//
// Both are read models over the same row: the one episode §5.4 says is open at
// any moment. The banner is 《前端》§6.6「EP N · 主题：…」plus the size of the
// pool it opens; the second endpoint is that pool.
//
// What separates this from the 剧集页 (routes/episodes.ts) is the scope of the
// pool. A「下一集」提案 belongs to the *episode*, not the round: §5.4 says the
// proposals accumulate for the whole episode and their votes freeze when the
// episode ends, where a 镜头投稿 is frozen at its round's close. So the pool is
// selected by `episode_id` + `kind`, never by round — and the `kind` filter is
// load-bearing in the other direction too: a `next_shot` listed as a pitch for
// the next episode would be a lie about what its author wrote.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { readVoteAdoptThreshold } from '../../lib/site-settings.js';

interface CurrentEpisodeRow {
  id: string;
  episode_index: number;
  title: string;
  theme: string;
  status: string;
  theme_source_username: string | null;
  theme_source_votes: number | null;
  proposal_count: number;
  story_outline: Array<{
    sceneIndex: number;
    summaryZh: string;
  }>;
}

/**
 * The open episode, or `null` before the first one exists.
 *
 * §5.4「同一时刻只有一个 status=open 的集」makes the LIMIT redundant in a healthy
 * database; the `ORDER BY episode_index` is there to match the ordering
 * routes/submissions.ts uses to decide which pool a new 提案 is written into
 * (`resolveTarget`). If the invariant ever broke, the endpoint that shows the
 * pool and the endpoint that writes into it would still agree on which episode
 * is "current" — disagreeing would be far more confusing than either answer.
 *
 * 主题来源 (§16.1, and the same shape routes/episodes.ts publishes): a NULL
 * `theme_source_submission_id` means AI 自拟 and the banner says so; a non-NULL
 * one names the proposer and the 净赞 their proposal carried.
 */
async function currentEpisode(db: Pool): Promise<CurrentEpisodeRow | null> {
  const result = await db.query<CurrentEpisodeRow>(
    `SELECT e.id, e.episode_index, e.title, e.theme, e.status,
            u.username_display AS theme_source_username,
            CASE WHEN src.id IS NULL THEN NULL
                 ELSE src.up_count - src.down_count END AS theme_source_votes,
            (SELECT count(*)::int FROM submissions p
              WHERE p.episode_id = e.id AND p.kind = 'next_episode')
              AS proposal_count,
            coalesce(
              (SELECT json_agg(
                        json_build_object(
                          'sceneIndex', s.scene_index,
                          'summaryZh', s.summary_zh
                        )
                        ORDER BY s.scene_index
                      )
                 FROM scenes s
                 JOIN ai_runs d ON d.id = s.director_ai_run_id
                WHERE s.episode_id = e.id
                  AND s.takedown_at IS NULL
                  AND d.run_type = 'scene_director'
                  AND d.provider = 'openai_codex'
                  AND d.model LIKE '%-sol'
                  AND d.status = 'succeeded'),
              '[]'::json
            ) AS story_outline
       FROM episodes e
       LEFT JOIN submissions src ON src.id = e.theme_source_submission_id
       LEFT JOIN users u ON u.id = src.user_id
      WHERE e.status = 'open'
      ORDER BY e.episode_index
      LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

export interface EpisodeBannerRoutesOptions {
  pool: Pool;
  /** §5.4 的 env 基线；§16.6 的 site_settings 合法值会在线覆盖它。 */
  fallbackAdoptThreshold: number;
}

export async function episodeBannerRoutes(
  app: FastifyInstance,
  options: EpisodeBannerRoutesOptions,
): Promise<void> {
  const { pool, fallbackAdoptThreshold } = options;

  // --- GET /api/episode/current ----------------------------------------------

  app.get('/api/episode/current', async (_request, reply) => {
    const episode = await currentEpisode(pool);
    // Same shape as `/api/round/current` 的 `no_round`: only true before the
    // first episode is created, because §17.29 opens the next one in the same
    // transaction that ends the current one.
    if (episode === null) {
      return reply
        .code(404)
        .send({ error: 'no_episode', message: '还没有开始任何一集' });
    }
    return {
      episodeIndex: episode.episode_index,
      title: episode.title,
      theme: episode.theme,
      status: episode.status,
      themeSourceUsername: episode.theme_source_username,
      themeSourceVotes: episode.theme_source_votes,
      proposalCount: episode.proposal_count,
      storyOutline: episode.story_outline,
    };
  });

  // --- GET /api/episode/current/proposals -------------------------------------

  // 《前端》§6.6「按净赞从高到低排序」with §5.4「并列时取更早投稿」, then the id as
  // the last tie-break so two proposals written in the same millisecond still
  // come back in the same order on every read.
  //
  // `adoptThreshold` travels with the list because the page renders「差 N 赞直采」
  // against it — a number the client cannot know without being told, and must
  // not guess, since §16.6 lets an operator retune it.
  app.get('/api/episode/current/proposals', async (request, reply) => {
    const episode = await currentEpisode(pool);
    if (episode === null) {
      return reply
        .code(404)
        .send({ error: 'no_episode', message: '还没有开始任何一集' });
    }

    // The caller's own vote, and only theirs: the join is keyed on their user
    // id, so an anonymous read (NULL) matches no row and every `my_vote` comes
    // back NULL rather than borrowing somebody else's.
    const rows = await pool.query<{
      id: string;
      content: string;
      up_count: number;
      down_count: number;
      created_at: Date;
      username: string;
      my_vote: number | null;
    }>(
      `SELECT s.id, s.content, s.up_count, s.down_count, s.created_at,
              u.username_display AS username,
              v.value AS my_vote
         FROM submissions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN submission_votes v
                ON v.submission_id = s.id AND v.user_id = $2::uuid
        WHERE s.episode_id = $1 AND s.kind = 'next_episode'
        ORDER BY (s.up_count - s.down_count) DESC, s.created_at ASC, s.id ASC`,
      [episode.id, request.currentUser?.id ?? null],
    );

    const adoptThreshold = await readVoteAdoptThreshold(
      pool,
      fallbackAdoptThreshold,
    );
    return {
      episodeIndex: episode.episode_index,
      adoptThreshold,
      proposals: rows.rows.map((row) => ({
        id: row.id,
        username: row.username,
        content: row.content,
        upCount: row.up_count,
        downCount: row.down_count,
        netVotes: row.up_count - row.down_count,
        myVote: row.my_vote,
        createdAt: row.created_at.toISOString(),
      })),
    };
  });
}
