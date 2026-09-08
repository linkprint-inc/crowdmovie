// 我的剧本 (§16.3) — `GET /api/me/stats`, `GET /api/me/submissions`,
// `GET /api/me/drafts`, `PUT /api/me/drafts`.
//
// Every route here is scoped to `request.currentUser` and nothing else: there
// is no `?user=` and no id in a path, so one identity can never read another's
// drafts or history. An anonymous request is 401; a banned one never reaches
// these handlers, because the auth plugin has already answered 403 (§17.31).
//
// The four statistics are the §16.2 derivations, verbatim — 已采用数, 累计获赞,
// 参与集数, 定过集主题 — computed by query, with no table behind them. §17.32's
// takedown rule applies to 已采用数 for the same reason it applies to the
// 名人堂: a 下架 片段 leaves the statistics too.
//
// §12「该页依赖 Cookie 身份」: a guest sees exactly what an account sees. The
// only thing an account adds is that the identity survives losing the cookie.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { glen } from '../../lib/grapheme.js';
import { FixedWindowCounter } from '../../lib/rate-limit.js';
import {
  findPublicMovie,
  LEGACY_MOVIE_SLUG,
} from '../../movies/catalog.js';
import { DANMAKU_MAX_GRAPHEMES } from './danmaku.js';
import { KIND_MAX_GRAPHEMES } from './submissions.js';

/** §16.1 `drafts.kind`. */
export const DRAFT_KINDS = ['next_shot', 'next_episode', 'danmaku'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

/**
 * A draft is measured by the limit of the thing it will become, so the box that
 * autosaves it and the endpoint that stores it agree on when it is too long.
 */
export const DRAFT_MAX_GRAPHEMES: Record<DraftKind, number> = {
  next_shot: KIND_MAX_GRAPHEMES.next_shot,
  next_episode: KIND_MAX_GRAPHEMES.next_episode,
  danmaku: DANMAKU_MAX_GRAPHEMES,
};

/** 1000 graphemes of astral-plane text is ~4KB; the rest is JSON overhead. */
const DRAFT_BODY_LIMIT = 32 * 1024;

/**
 * Autosave writes at most one PUT per slot per 2 s while someone is typing
 * (web/src/stores/drafts.ts), so three slots is ~90/min in the worst case. The
 * limit is a flood stop, not a quota.
 */
const DRAFT_RATE_LIMIT = 240;

/** §16.3「分页」defaults. */
export const MY_SUBMISSIONS_DEFAULT_LIMIT = 50;
export const MY_SUBMISSIONS_MAX_LIMIT = 100;

function parseBounded(raw: unknown, fallback: number, max: number): number | null {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > max) return null;
  return value;
}

export interface MeRoutesOptions {
  pool: Pool;
  /** Draft saves per minute per IP and per identity; tests pin it. */
  draftRateLimit?: number;
}

export async function meRoutes(
  app: FastifyInstance,
  options: MeRoutesOptions,
): Promise<void> {
  const { pool } = options;
  const draftLimit = options.draftRateLimit ?? DRAFT_RATE_LIMIT;
  // Keys carry their axis as a prefix so the IP budget and the identity budget
  // can never land on one another's counter.
  const draftCounter = new FixedWindowCounter();

  // --- GET /api/me/stats (§12 统计卡, §16.2) ---------------------------------

  app.get('/api/me/stats', async (request, reply) => {
    const user = request.currentUser;
    if (user === null) {
      return reply
        .code(401)
        .send({ error: 'identity_required', message: '请先认领用户名' });
    }

    // One round trip, five independent aggregates. Subqueries rather than
    // joins: joining `scenes` and `submissions` on the same row would multiply
    // 已采用数 by 投稿数.
    const stats = await pool.query<{
      submissions: number;
      accepted: number;
      net_votes: number;
      episodes: number;
      themes_set: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM submissions WHERE user_id = $1) AS submissions,
         (SELECT count(*)::int FROM scenes
           WHERE credit_user_id = $1 AND takedown_at IS NULL) AS accepted,
         coalesce((SELECT sum(up_count - down_count)::int FROM submissions
                    WHERE user_id = $1 AND votes_frozen_at IS NOT NULL), 0)
           AS net_votes,
         (SELECT count(DISTINCT episode_id)::int FROM submissions
           WHERE user_id = $1) AS episodes,
         (SELECT count(*)::int FROM episodes e
            JOIN submissions src ON src.id = e.theme_source_submission_id
           WHERE src.user_id = $1) AS themes_set`,
      [user.id],
    );

    const row = stats.rows[0];
    return {
      submissions: row.submissions,
      accepted: row.accepted,
      netVotes: row.net_votes,
      episodes: row.episodes,
      themesSet: row.themes_set,
    };
  });

  // --- GET /api/me/submissions (§12 投稿记录) --------------------------------

  // 「按时间倒序，每行显示所属集与轮次、投稿摘要、状态徽标、AI 分数与净赞；定过
  // 集主题的记录单独标注」. Ordered by `created_at DESC`, which is exactly the
  // §16.2 index `submissions(user_id, created_at DESC)`.
  app.get('/api/me/submissions', async (request, reply) => {
    const user = request.currentUser;
    if (user === null) {
      return reply
        .code(401)
        .send({ error: 'identity_required', message: '请先认领用户名' });
    }

    const query = request.query as { limit?: unknown; offset?: unknown };
    const limit = parseBounded(
      query.limit,
      MY_SUBMISSIONS_DEFAULT_LIMIT,
      MY_SUBMISSIONS_MAX_LIMIT,
    );
    const offset = parseBounded(query.offset, 0, Number.MAX_SAFE_INTEGER);
    if (limit === null || offset === null || limit === 0) {
      return reply.code(400).send({
        error: 'pagination_invalid',
        message: `limit 必须在 1 与 ${MY_SUBMISSIONS_MAX_LIMIT} 之间，offset 不能为负`,
      });
    }

    const rows = await pool.query<{
      id: string;
      kind: string;
      content: string;
      status: string;
      episode_index: number | null;
      round_index: string | null;
      score_total: number | null;
      net_votes: number;
      is_episode_theme: boolean;
      adopted_scene_index: number | null;
      created_at: Date;
      total: string;
    }>(
      `SELECT s.id, s.kind, s.content, s.status,
              e.episode_index,
              r.round_index,
              sc.score_total,
              (s.up_count - s.down_count) AS net_votes,
              (ep.id IS NOT NULL) AS is_episode_theme,
              scene.scene_index AS adopted_scene_index,
              s.created_at,
              count(*) OVER () AS total
         FROM submissions s
         LEFT JOIN episodes e ON e.id = s.episode_id
         LEFT JOIN rounds r ON r.id = s.round_id
         LEFT JOIN submission_scores sc ON sc.submission_id = s.id
         LEFT JOIN episodes ep ON ep.theme_source_submission_id = s.id
         LEFT JOIN scenes scene
                ON scene.source_submission_id = s.id AND scene.takedown_at IS NULL
        WHERE s.user_id = $1
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT $2 OFFSET $3`,
      [user.id, limit, offset],
    );

    const total = rows.rows.length === 0 ? 0 : Number(rows.rows[0].total);
    return {
      total,
      limit,
      offset,
      hasMore: offset + rows.rows.length < total,
      submissions: rows.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        episodeIndex: row.episode_index,
        // BIGINT arrives as a string; the page prints it as 第 000043 轮.
        roundIndex: row.round_index === null ? null : Number(row.round_index),
        content: row.content,
        // §16.1: pending | rejected | accepted — the 初评 verdict (§6.3), which
        // is *not* the same fact as being adopted into a scene.
        status: row.status,
        score: row.score_total,
        netVotes: row.net_votes,
        isEpisodeTheme: row.is_episode_theme,
        // 采用 in the §16.2 sense: this 投稿 became a published, live 片段.
        adopted: row.adopted_scene_index !== null,
        sceneIndex: row.adopted_scene_index,
        createdAt: row.created_at.toISOString(),
      })),
    };
  });

  // --- GET /api/me/drafts (§12 草稿箱) ---------------------------------------

  app.get('/api/me/drafts', async (request, reply) => {
    const user = request.currentUser;
    if (user === null) {
      return reply
        .code(401)
        .send({ error: 'identity_required', message: '请先认领用户名' });
    }

    const rows = await pool.query<{
      movie_slug: string;
      kind: string;
      body: string;
      updated_at: Date;
    }>(
      `SELECT m.slug AS movie_slug, d.kind, d.body, d.updated_at
         FROM drafts d JOIN movies m ON m.id = d.movie_id
        WHERE d.user_id = $1 ORDER BY m.display_order, d.kind`,
      [user.id],
    );
    return {
      drafts: rows.rows.map((row) => ({
        movieSlug: row.movie_slug,
        kind: row.kind,
        body: row.body,
        updatedAt: row.updated_at.toISOString(),
      })),
    };
  });

  // --- PUT /api/me/drafts (§12 自动保存) -------------------------------------

  // §16.1「每类各保留一份，UPSERT 覆盖」— so one call carries one kind, and the
  // `(user_id, kind)` primary key is what makes a second save an overwrite
  // rather than a second row. §17.30「两类投稿与弹幕草稿互不覆盖」is the same
  // key read the other way round.
  app.put(
    '/api/me/drafts',
    {
      bodyLimit: DRAFT_BODY_LIMIT,
      onRequest: async (request, reply) => {
        if (draftCounter.record(`ip:${request.ip}`) > draftLimit) {
          return reply
            .code(429)
            .send({ error: 'rate_limited', message: '操作过于频繁，请稍后再试' });
        }
      },
    },
    async (request, reply) => {
      const user = request.currentUser;
      if (user === null) {
        return reply
          .code(401)
          .send({ error: 'identity_required', message: '请先认领用户名' });
      }
      if (draftCounter.record(`user:${user.id}`) > draftLimit) {
        return reply
          .code(429)
          .send({ error: 'rate_limited', message: '操作过于频繁，请稍后再试' });
      }

      const body = request.body as {
        movieSlug?: unknown;
        kind?: unknown;
        body?: unknown;
      } | null;
      const movieSlug =
        typeof body?.movieSlug === 'string' ? body.movieSlug : LEGACY_MOVIE_SLUG;
      const movie = await findPublicMovie(pool, movieSlug);
      if (movie === null) {
        return reply
          .code(404)
          .send({ error: 'movie_not_found', message: '影片不存在' });
      }
      const kind = body?.kind;
      if (
        typeof kind !== 'string' ||
        !(DRAFT_KINDS as readonly string[]).includes(kind)
      ) {
        return reply.code(400).send({
          error: 'kind_invalid',
          message: '草稿类型必须是 next_shot、next_episode 或 danmaku',
        });
      }
      // An empty draft is a legal draft: clearing the box has to be savable, or
      // the next session restores text the writer deleted on purpose.
      const text = typeof body?.body === 'string' ? body.body : null;
      if (text === null) {
        return reply
          .code(400)
          .send({ error: 'body_invalid', message: '草稿内容必须是字符串' });
      }
      const max = DRAFT_MAX_GRAPHEMES[kind as DraftKind];
      if (glen(text) > max) {
        return reply.code(400).send({
          error: 'content_too_long',
          message: `最多 ${max} 个字符`,
          max,
        });
      }

      const saved = await pool.query<{ updated_at: Date }>(
        `INSERT INTO drafts (user_id, movie_id, kind, body)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, movie_id, kind)
         DO UPDATE SET body = EXCLUDED.body, updated_at = now()
         RETURNING updated_at`,
        [user.id, movie.id, kind, text],
      );

      return {
        movieSlug: movie.slug,
        kind,
        body: text,
        updatedAt: saved.rows[0].updated_at.toISOString(),
      };
    },
  );
}
