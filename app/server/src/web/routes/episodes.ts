// 剧集页 (§16.3) — `GET /api/episodes` and `GET /api/episodes/{episode_index}`.
//
// Everything these two return is derived by query. §16.2 is explicit that the
// counts and the credits are 不建表:「剧集卡片的片段数 / 投稿数：按 episode_id
// 计数」, and the theme credit is 「episodes.theme_source_submission_id →
// submissions.user_id」. There is no aggregate table and nothing is cached — an
// episode list is short, and its counts have to be right the moment a 投稿
// lands (UI §11 shows them on the card).
//
// The one rule that is easy to get wrong and expensive to get wrong: a
// taken-down scene is not in the count. §17.32「被下架片段立即从播放清单、分享页
// 与统计中消失」makes 片段数 a count of *live* scenes, the same predicate the
// playlist uses.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { findPublicMovie, INLAND_EMPIRE_MOVIE_ID } from '../../movies/catalog.js';

interface EpisodeRow {
  episode_index: number;
  title: string;
  theme: string;
  status: string;
  scene_count: number;
  submission_count: number;
  theme_source_username: string | null;
  theme_source_votes: number | null;
  story_outline: Array<{ sceneIndex: number; summaryZh: string }>;
}

/**
 * One card's worth of episode. The subqueries are per-episode counts rather
 * than joins, because joining `scenes` and `submissions` to the same row would
 * multiply them together — the classic double-count that makes a "12 片段"
 * card read "144".
 *
 * 主题来源 (§16.1): a NULL `theme_source_submission_id` means AI 自拟 and the
 * page says so; a non-NULL one names the proposer and the net votes the
 * proposal was carrying, which are frozen when the episode ends (§5.4).
 */
const EPISODE_SELECT = `
  SELECT e.episode_index, e.title, e.theme, e.status,
         (SELECT count(*)::int FROM scenes s
           WHERE s.episode_id = e.id AND s.takedown_at IS NULL) AS scene_count,
         (SELECT count(*)::int FROM submissions sub
           WHERE sub.episode_id = e.id) AS submission_count,
         u.username_display AS theme_source_username,
         CASE WHEN src.id IS NULL THEN NULL
              ELSE src.up_count - src.down_count END AS theme_source_votes,
         coalesce(
           (SELECT json_agg(
                     json_build_object(
                       'sceneIndex', outline.scene_index,
                       'summaryZh', outline.summary_zh
                     ) ORDER BY outline.scene_index)
              FROM scenes outline
              JOIN ai_runs d ON d.id = outline.director_ai_run_id
             WHERE outline.movie_id = e.movie_id
               AND outline.episode_id = e.id
               AND outline.takedown_at IS NULL
               AND d.movie_id = e.movie_id
               AND d.run_type = 'scene_director'
               AND d.provider = 'openai_codex'
               AND d.model LIKE '%-sol'
               AND d.status = 'succeeded'),
           '[]'::json
         ) AS story_outline
    FROM episodes e
    LEFT JOIN submissions src ON src.id = e.theme_source_submission_id
    LEFT JOIN users u ON u.id = src.user_id`;

function episodeView(row: EpisodeRow): Record<string, unknown> {
  return {
    episodeIndex: row.episode_index,
    title: row.title,
    // The card and the detail page both call it the premise; §16.1 calls the
    // column `theme`. Same string, the page's name for it.
    premise: row.theme,
    status: row.status,
    sceneCount: row.scene_count,
    submissionCount: row.submission_count,
    themeSourceUsername: row.theme_source_username,
    themeSourceVotes: row.theme_source_votes,
    storyOutline: row.story_outline,
  };
}

/** UI §11「本集高赞投稿」— how many rows the detail page shows. */
export const EPISODE_TOP_SUBMISSIONS = 20;

export interface EpisodeRoutesOptions {
  pool: Pool;
}

export async function episodeRoutes(
  app: FastifyInstance,
  options: EpisodeRoutesOptions,
): Promise<void> {
  const { pool } = options;

  // --- GET /api/episodes -----------------------------------------------------

  // UI §11「卡片网格，倒序排列，最新一集在前」. Sorted here rather than in the
  // client so the order does not depend on which page is asking.
  app.get('/api/episodes', async () => {
    const rows = await pool.query<EpisodeRow>(
      `${EPISODE_SELECT} WHERE e.movie_id = $1 ORDER BY e.episode_index DESC`,
      [INLAND_EMPIRE_MOVIE_ID],
    );
    return { episodes: rows.rows.map(episodeView) };
  });

  // --- GET /api/episodes/{episode_index} -------------------------------------

  app.get<{ Params: { episodeIndex: string } }>(
    '/api/episodes/:episodeIndex',
    async (request, reply) => {
      const episodeIndex = Number(request.params.episodeIndex);
      if (!Number.isSafeInteger(episodeIndex) || episodeIndex < 1) {
        return reply
          .code(404)
          .send({ error: 'episode_not_found', message: '该集不存在' });
      }

      const found = await pool.query<EpisodeRow & { id: string }>(
        `${EPISODE_SELECT} WHERE e.movie_id = $1 AND e.episode_index = $2`,
        [INLAND_EMPIRE_MOVIE_ID, episodeIndex],
      );
      const episode = found.rows[0];
      if (episode === undefined) {
        return reply
          .code(404)
          .send({ error: 'episode_not_found', message: '该集不存在' });
      }

      // 「本集高赞投稿」: both kinds, ranked by 净赞 the way the timeline ranks
      // them, ties broken by the earlier 投稿 (§5.4「并列时取更早投稿」) so the
      // order is stable between two reads. The public score columns are the
      // same three §6.3 allows out — total and the four-language roast; the
      // breakdown, reason and risk flags stay on the server.
      const submissions = await pool.query<{
        id: string;
        kind: string;
        content: string;
        status: string;
        up_count: number;
        down_count: number;
        votes_frozen_at: Date | null;
        created_at: Date;
        username: string;
        score_total: number | null;
        public_roast: unknown;
      }>(
        `SELECT s.id, s.kind, s.content, s.status, s.up_count, s.down_count,
                s.votes_frozen_at, s.created_at,
                u.username_display AS username,
                sc.score_total, sc.public_roast
           FROM submissions s
           JOIN users u ON u.id = s.user_id
           LEFT JOIN submission_scores sc ON sc.submission_id = s.id
          WHERE s.episode_id = (SELECT id FROM episodes
                                 WHERE movie_id = $1 AND episode_index = $2)
          ORDER BY (s.up_count - s.down_count) DESC, s.created_at ASC, s.id ASC
          LIMIT $3`,
        [INLAND_EMPIRE_MOVIE_ID, episodeIndex, EPISODE_TOP_SUBMISSIONS],
      );

      return {
        ...episodeView(episode),
        topSubmissions: submissions.rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          username: row.username,
          content: row.content,
          status: row.status,
          upCount: row.up_count,
          downCount: row.down_count,
          votesFrozen: row.votes_frozen_at !== null,
          createdAt: row.created_at.toISOString(),
          score:
            row.score_total === null
              ? null
              : { total: row.score_total, roast: row.public_roast },
        })),
      };
    },
  );

  app.get<{ Params: { movieSlug: string } }>(
    '/api/movies/:movieSlug/episodes',
    async (request, reply) => {
      const movie = await findPublicMovie(pool, request.params.movieSlug);
      if (movie === null) {
        return reply
          .code(404)
          .send({ error: 'movie_not_found', message: '影片不存在' });
      }
      const rows = await pool.query<EpisodeRow>(
        `${EPISODE_SELECT} WHERE e.movie_id = $1 ORDER BY e.episode_index DESC`,
        [movie.id],
      );
      return { movieId: movie.id, episodes: rows.rows.map(episodeView) };
    },
  );

  app.get<{ Params: { movieSlug: string; episodeIndex: string } }>(
    '/api/movies/:movieSlug/episodes/:episodeIndex',
    async (request, reply) => {
      const movie = await findPublicMovie(pool, request.params.movieSlug);
      const episodeIndex = Number(request.params.episodeIndex);
      if (
        movie === null ||
        !Number.isSafeInteger(episodeIndex) ||
        episodeIndex < 1
      ) {
        return reply
          .code(404)
          .send({ error: 'episode_not_found', message: '该集不存在' });
      }
      const found = await pool.query<EpisodeRow & { id: string }>(
        `${EPISODE_SELECT} WHERE e.movie_id = $1 AND e.episode_index = $2`,
        [movie.id, episodeIndex],
      );
      const episode = found.rows[0];
      if (episode === undefined) {
        return reply
          .code(404)
          .send({ error: 'episode_not_found', message: '该集不存在' });
      }
      const submissions = await pool.query<{
        id: string;
        kind: string;
        content: string;
        status: string;
        up_count: number;
        down_count: number;
        votes_frozen_at: Date | null;
        created_at: Date;
        username: string;
        score_total: number | null;
        public_roast: unknown;
      }>(
        `SELECT s.id, s.kind, s.content, s.status, s.up_count, s.down_count,
                s.votes_frozen_at, s.created_at,
                u.username_display AS username,
                sc.score_total, sc.public_roast
           FROM submissions s
           JOIN users u ON u.id = s.user_id
           LEFT JOIN submission_scores sc ON sc.submission_id = s.id
          WHERE s.episode_id = (SELECT id FROM episodes
                                 WHERE movie_id = $1 AND episode_index = $2)
          ORDER BY (s.up_count - s.down_count) DESC, s.created_at ASC, s.id ASC
          LIMIT $3`,
        [movie.id, episodeIndex, EPISODE_TOP_SUBMISSIONS],
      );
      return {
        movieId: movie.id,
        ...episodeView(episode),
        topSubmissions: submissions.rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          username: row.username,
          content: row.content,
          status: row.status,
          upCount: row.up_count,
          downCount: row.down_count,
          votesFrozen: row.votes_frozen_at !== null,
          createdAt: row.created_at.toISOString(),
          score:
            row.score_total === null
              ? null
              : { total: row.score_total, roast: row.public_roast },
        })),
      };
    },
  );
}
