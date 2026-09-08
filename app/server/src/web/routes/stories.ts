// 故事设定的公开面（《故事设定投稿技术规范》§4.1、§4.3）—— 列表、详情、跟帖、
// 点赞。
//
// One predicate governs every route in this file: a proposal is visible only
// when `published_at IS NOT NULL AND takedown_at IS NULL`. A draft, one under
// review and one that was refused are not "forbidden" — as far as the board is
// concerned they do not exist, and a leak here would publish text that nobody
// ever approved.
//
// Guests may read, like and reply, which is the site's usual rule. Only
// authoring is account-only, and that half lives in routes/story-authoring.ts.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { withTransaction } from '../../db/tx.js';
import { glen } from '../../lib/grapheme.js';
import { FixedWindowCounter } from '../../lib/rate-limit.js';

/** 短字段，与站内其他短字段同口径（规范 §2）。 */
export const STORY_COMMENT_MAX_GRAPHEMES = 500;

export const STORIES_DEFAULT_LIMIT = 20;
export const STORIES_MAX_LIMIT = 50;
export const COMMENTS_DEFAULT_LIMIT = 50;
export const COMMENTS_MAX_LIMIT = 100;

/** 500 graphemes of astral-plane text is ~2KB; the rest is JSON overhead. */
const COMMENT_BODY_LIMIT = 16 * 1024;

const COMMENT_RATE_LIMIT = 30;
const LIKE_RATE_LIMIT = 120;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 唯一的可见性判据。Written once, used by every route below. */
const VISIBLE = `published_at IS NOT NULL AND takedown_at IS NULL`;

function parseBounded(raw: unknown, fallback: number, max: number): number | null {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > max) return null;
  return value;
}

export interface StoryRoutesOptions {
  pool: Pool;
  /** 跟帖 per minute per IP and per identity; tests pin it. */
  commentRateLimit?: number;
  /** 点赞 per minute per IP and per identity; tests pin it. */
  likeRateLimit?: number;
}

export async function storyRoutes(
  app: FastifyInstance,
  options: StoryRoutesOptions,
): Promise<void> {
  const { pool } = options;
  const commentLimit = options.commentRateLimit ?? COMMENT_RATE_LIMIT;
  const likeLimit = options.likeRateLimit ?? LIKE_RATE_LIMIT;
  const commentCounter = new FixedWindowCounter();
  const likeCounter = new FixedWindowCounter();

  /** The id of a visible proposal, or null. */
  async function visibleProposalId(id: string): Promise<string | null> {
    if (!UUID_RE.test(id)) return null;
    const found = await pool.query<{ id: string }>(
      `SELECT id FROM story_proposals WHERE id = $1 AND ${VISIBLE}`,
      [id],
    );
    return found.rows[0]?.id ?? null;
  }

  // --- GET /api/stories：列表 ------------------------------------------------

  app.get('/api/stories', async (request, reply) => {
    const query = request.query as {
      sort?: unknown;
      limit?: unknown;
      offset?: unknown;
    };
    const sort = query.sort === undefined ? 'hot' : query.sort;
    if (sort !== 'hot' && sort !== 'new') {
      return reply
        .code(400)
        .send({ error: 'sort_invalid', message: '排序只能是 hot 或 new' });
    }
    const limit = parseBounded(query.limit, STORIES_DEFAULT_LIMIT, STORIES_MAX_LIMIT);
    const offset = parseBounded(query.offset, 0, Number.MAX_SAFE_INTEGER);
    if (limit === null || offset === null || limit === 0) {
      return reply.code(400).send({
        error: 'pagination_invalid',
        message: `limit 必须在 1 与 ${STORIES_MAX_LIMIT} 之间，offset 不能为负`,
      });
    }

    // The two orderings match the two partial indexes on the table, so neither
    // sort has to read rows it will not return.
    const order =
      sort === 'hot'
        ? 'p.like_count DESC, p.published_at DESC'
        : 'p.published_at DESC';

    const rows = await pool.query<{
      id: string;
      title: string;
      username: string;
      like_count: number;
      comment_count: number;
      published_at: Date;
      total: string;
    }>(
      `SELECT p.id, p.title, u.username_display AS username,
              p.like_count, p.comment_count, p.published_at,
              count(*) OVER () AS total
         FROM story_proposals p
         JOIN users u ON u.id = p.user_id
        WHERE p.published_at IS NOT NULL AND p.takedown_at IS NULL
        ORDER BY ${order}, p.id
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    // 每条带全部人物图与设定图（规范 §4.1）。Fetch the whole page in one
    // query rather than one query per story, so the list still costs two round
    // trips no matter how many rows or pictures it contains.
    const ids = rows.rows.map((row) => row.id);
    const previews =
      ids.length === 0
        ? { rows: [] as { proposal_id: string; kind: string; file_url: string }[] }
        : await pool.query<{ proposal_id: string; kind: string; file_url: string }>(
            `SELECT proposal_id, kind, file_url
               FROM story_images
              WHERE proposal_id = ANY($1::uuid[])
             -- file_url embeds a randomly generated image id (storyImageUrl,
             -- lib/story-images.ts), not the slot it fills, so it cannot break
             -- ties within a kind: sort by position itself, which is the order
             -- §4.1 promises.
              ORDER BY proposal_id, kind ASC, position`,
            [ids],
          );

    const byProposal = new Map<string, { kind: string; url: string }[]>();
    for (const preview of previews.rows) {
      const list = byProposal.get(preview.proposal_id) ?? [];
      list.push({ kind: preview.kind, url: preview.file_url });
      byProposal.set(preview.proposal_id, list);
    }

    const total = rows.rows.length === 0 ? 0 : Number(rows.rows[0].total);
    return {
      total,
      limit,
      offset,
      hasMore: offset + rows.rows.length < total,
      sort,
      stories: rows.rows.map((row) => ({
        id: row.id,
        title: row.title,
        authorUsername: row.username,
        likeCount: row.like_count,
        commentCount: row.comment_count,
        publishedAt: row.published_at.toISOString(),
        previewImages: byProposal.get(row.id) ?? [],
      })),
    };
  });

  // --- GET /api/stories/:id：详情 --------------------------------------------

  app.get<{ Params: { id: string } }>('/api/stories/:id', async (request, reply) => {
    if (!UUID_RE.test(request.params.id)) {
      return reply
        .code(404)
        .send({ error: 'story_not_found', message: '这份设定不存在' });
    }

    const found = await pool.query<{
      id: string;
      title: string;
      synopsis: string;
      username: string;
      like_count: number;
      comment_count: number;
      published_at: Date;
    }>(
      `SELECT p.id, p.title, p.synopsis, u.username_display AS username,
              p.like_count, p.comment_count, p.published_at
         FROM story_proposals p
         JOIN users u ON u.id = p.user_id
        WHERE p.id = $1 AND p.published_at IS NOT NULL AND p.takedown_at IS NULL`,
      [request.params.id],
    );
    const story = found.rows[0];
    if (story === undefined) {
      return reply
        .code(404)
        .send({ error: 'story_not_found', message: '这份设定不存在' });
    }

    const images = await pool.query<{
      kind: string;
      position: number;
      caption: string;
      file_url: string;
    }>(
      `SELECT kind, position, caption, file_url FROM story_images
        WHERE proposal_id = $1 ORDER BY kind ASC, position`,
      [story.id],
    );

    const user = request.currentUser;
    const liked =
      user === null
        ? { rowCount: 0 }
        : await pool.query(
            'SELECT 1 FROM story_likes WHERE proposal_id = $1 AND user_id = $2',
            [story.id, user.id],
          );

    const view = (kind: string) =>
      images.rows
        .filter((image) => image.kind === kind)
        .map((image) => ({
          position: image.position,
          caption: image.caption,
          url: image.file_url,
        }));

    return {
      id: story.id,
      title: story.title,
      synopsis: story.synopsis,
      authorUsername: story.username,
      likeCount: story.like_count,
      commentCount: story.comment_count,
      publishedAt: story.published_at.toISOString(),
      likedByMe: (liked.rowCount ?? 0) > 0,
      characters: view('character'),
      worlds: view('world'),
    };
  });

  // --- GET /api/stories/:id/comments -----------------------------------------

  app.get<{ Params: { id: string } }>(
    '/api/stories/:id/comments',
    async (request, reply) => {
      const proposalId = await visibleProposalId(request.params.id);
      if (proposalId === null) {
        return reply
          .code(404)
          .send({ error: 'story_not_found', message: '这份设定不存在' });
      }

      const query = request.query as { limit?: unknown; offset?: unknown };
      const limit = parseBounded(
        query.limit,
        COMMENTS_DEFAULT_LIMIT,
        COMMENTS_MAX_LIMIT,
      );
      const offset = parseBounded(query.offset, 0, Number.MAX_SAFE_INTEGER);
      if (limit === null || offset === null || limit === 0) {
        return reply.code(400).send({
          error: 'pagination_invalid',
          message: `limit 必须在 1 与 ${COMMENTS_MAX_LIMIT} 之间，offset 不能为负`,
        });
      }

      const rows = await pool.query<{
        id: string;
        username: string;
        content: string;
        created_at: Date;
        total: string;
      }>(
        `SELECT c.id, u.username_display AS username, c.content, c.created_at,
                count(*) OVER () AS total
           FROM story_comments c
           JOIN users u ON u.id = c.user_id
          WHERE c.proposal_id = $1 AND c.status = 'visible'
          ORDER BY c.id
          LIMIT $2 OFFSET $3`,
        [proposalId, limit, offset],
      );

      const total = rows.rows.length === 0 ? 0 : Number(rows.rows[0].total);
      return {
        total,
        limit,
        offset,
        hasMore: offset + rows.rows.length < total,
        comments: rows.rows.map((row, index) => ({
          // BIGINT arrives as a string; the page prints the floor number.
          id: Number(row.id),
          floor: offset + index + 1,
          username: row.username,
          content: row.content,
          createdAt: row.created_at.toISOString(),
        })),
      };
    },
  );

  // --- POST /api/stories/:id/comments ----------------------------------------

  app.post<{ Params: { id: string } }>(
    '/api/stories/:id/comments',
    {
      bodyLimit: COMMENT_BODY_LIMIT,
      onRequest: async (request, reply) => {
        if (commentCounter.record(`ip:${request.ip}`) > commentLimit) {
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
      if (commentCounter.record(`user:${user.id}`) > commentLimit) {
        return reply
          .code(429)
          .send({ error: 'rate_limited', message: '操作过于频繁，请稍后再试' });
      }

      const proposalId = await visibleProposalId(request.params.id);
      if (proposalId === null) {
        return reply
          .code(404)
          .send({ error: 'story_not_found', message: '这份设定不存在' });
      }

      const raw = (request.body as { content?: unknown } | null)?.content;
      const content = typeof raw === 'string' ? raw : '';
      if (content.trim().length === 0) {
        return reply
          .code(400)
          .send({ error: 'content_required', message: '回帖内容不能为空' });
      }
      if (glen(content) > STORY_COMMENT_MAX_GRAPHEMES) {
        return reply.code(400).send({
          error: 'content_too_long',
          message: `最多 ${STORY_COMMENT_MAX_GRAPHEMES} 个字符`,
          max: STORY_COMMENT_MAX_GRAPHEMES,
        });
      }

      const created = await withTransaction(pool, async (client) => {
        const inserted = await client.query<{ id: string; created_at: Date }>(
          `INSERT INTO story_comments (proposal_id, user_id, content)
           VALUES ($1, $2, $3) RETURNING id, created_at`,
          [proposalId, user.id, content],
        );
        // Recomputed rather than incremented, the same way §5.4 maintains
        // up_count: under one statement it costs an index scan, and it cannot
        // drift from the rows the way a delta can.
        await client.query(
          `UPDATE story_proposals p SET
             comment_count = (SELECT count(*) FROM story_comments c
                               WHERE c.proposal_id = p.id AND c.status = 'visible')
           WHERE p.id = $1`,
          [proposalId],
        );
        return inserted.rows[0];
      });

      return reply.code(201).send({
        id: Number(created.id),
        username: user.usernameDisplay,
        content,
        createdAt: created.created_at.toISOString(),
      });
    },
  );

  // --- POST /api/stories/:id/like -------------------------------------------

  // Likes only, no dislikes. This count is what an operator reads when picking
  // the next video's main setting, and the simplest signal is the hardest to
  // game — which is also why one identity gets one like and never one on their
  // own proposal.
  app.post<{ Params: { id: string } }>(
    '/api/stories/:id/like',
    {
      bodyLimit: 1024,
      onRequest: async (request, reply) => {
        if (likeCounter.record(`ip:${request.ip}`) > likeLimit) {
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
      if (likeCounter.record(`user:${user.id}`) > likeLimit) {
        return reply
          .code(429)
          .send({ error: 'rate_limited', message: '操作过于频繁，请稍后再试' });
      }

      const raw = (request.body as { value?: unknown } | null)?.value;
      const value = typeof raw === 'number' ? raw : Number.NaN;
      if (value !== 1 && value !== 0) {
        return reply
          .code(400)
          .send({ error: 'value_invalid', message: '点赞只能是 1 或 0' });
      }
      if (!UUID_RE.test(request.params.id)) {
        return reply
          .code(404)
          .send({ error: 'story_not_found', message: '这份设定不存在' });
      }

      const result = await withTransaction(pool, async (client) => {
        // FOR UPDATE serialises this like against other likes on the same
        // proposal, so the recount below cannot interleave with another one.
        const found = await client.query<{ id: string; user_id: string }>(
          `SELECT id, user_id FROM story_proposals
            WHERE id = $1 AND ${VISIBLE}
            FOR UPDATE`,
          [request.params.id],
        );
        const story = found.rows[0];
        if (story === undefined) return { error: 'story_not_found' as const };
        if (story.user_id === user.id) return { error: 'self_like' as const };

        if (value === 1) {
          await client.query(
            `INSERT INTO story_likes (proposal_id, user_id) VALUES ($1, $2)
             ON CONFLICT (proposal_id, user_id) DO NOTHING`,
            [story.id, user.id],
          );
        } else {
          await client.query(
            'DELETE FROM story_likes WHERE proposal_id = $1 AND user_id = $2',
            [story.id, user.id],
          );
        }

        const counted = await client.query<{ like_count: number }>(
          `UPDATE story_proposals p SET
             like_count = (SELECT count(*) FROM story_likes l
                            WHERE l.proposal_id = p.id)
           WHERE p.id = $1
           RETURNING like_count`,
          [story.id],
        );
        return { likeCount: counted.rows[0].like_count };
      });

      if ('error' in result) {
        if (result.error === 'self_like') {
          return reply
            .code(403)
            .send({ error: 'self_like', message: '不能给自己的设定点赞' });
        }
        return reply
          .code(404)
          .send({ error: 'story_not_found', message: '这份设定不存在' });
      }

      return {
        storyId: request.params.id,
        likeCount: result.likeCount,
        likedByMe: value === 1,
      };
    },
  );
}
