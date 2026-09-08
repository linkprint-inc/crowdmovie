// 联系我们 (§15, §16.3) — `POST /api/contact`.
//
// §15's hardest rule is structural, not a validation:「留言正文是**不可信数据**：
// 不得进入任何模型上下文，不得作为提示词拼接」. Nothing in this file enqueues a
// job, writes `ai_runs`, or touches the ContentEngine — the whole path is
// validate → INSERT → COMMIT, and the body is never read back by anything but a
// human running SQL (§16.6「留言处理」). Keeping that true is the reason this
// route does not, for example, auto-classify a message or draft a reply.
//
// The second rule is that the form must accept people who cannot be replied to:
// 「未登录访客也允许提交，但页面明确告知无法回复」. So there is no identity
// requirement here — `user_id` is simply NULL for a visitor — and the endpoint
// is rate limited on both axes precisely because it is open.
//
// No mail is sent. §15 says a reply goes to the account's bound address and
// §16.6 puts that in the operator's hands; this endpoint only records.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { glen } from '../../lib/grapheme.js';
import { FixedWindowCounter } from '../../lib/rate-limit.js';
import { findPublicMovie, LEGACY_MOVIE_SLUG } from '../../movies/catalog.js';

/** §15「category 必须落在固定枚举内」. */
export const CONTACT_CATEGORIES = [
  'general',
  'appeal',
  'copyright',
  'bug',
] as const;
export type ContactCategory = (typeof CONTACT_CATEGORIES)[number];

/** §15「body 最多 1000 个用户可见字符，沿用 Intl.Segmenter 计数」. */
export const CONTACT_MAX_GRAPHEMES = 1000;

/** 1000 graphemes of astral-plane text is ~4KB; the rest is JSON and slack. */
const CONTACT_BODY_LIMIT = 32 * 1024;

/**
 * §15「提交按来源 IP 与身份限速」. A message is a human action taken once, so
 * both budgets are small — small enough that a scripted flood is stopped, large
 * enough that a shared office address and a mistyped submission are not.
 */
const CONTACT_IP_RATE_LIMIT = 10;
const CONTACT_USER_RATE_LIMIT = 5;

export interface ContactRoutesOptions {
  pool: Pool;
  /** 留言 per minute per IP; tests pin it. */
  contactIpRateLimit?: number;
  /** 留言 per minute per identity; tests pin it. */
  contactUserRateLimit?: number;
}

/**
 * §15「scene_index 必须是已发布片段或为空」.
 *
 * The form field is a scene number typed by hand ("000042"), so a numeric
 * string is accepted as the number it is and an empty field as "no scene". A
 * value that is neither is refused rather than silently dropped: an appeal that
 * quietly lost the 片段 it was about is worse than one that was not sent.
 */
function parseSceneIndex(raw: unknown): number | null | 'invalid' {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string' && raw.trim().length === 0) return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return 'invalid';
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return 'invalid';
  return value;
}

export async function contactRoutes(
  app: FastifyInstance,
  options: ContactRoutesOptions,
): Promise<void> {
  const { pool } = options;
  const ipLimit = options.contactIpRateLimit ?? CONTACT_IP_RATE_LIMIT;
  const userLimit = options.contactUserRateLimit ?? CONTACT_USER_RATE_LIMIT;
  // One counter, keys prefixed with their axis, so the IP budget and the
  // identity budget cannot spend each other.
  const counter = new FixedWindowCounter();

  app.post(
    '/api/contact',
    {
      bodyLimit: CONTACT_BODY_LIMIT,
      onRequest: async (request, reply) => {
        // Counted before the body is parsed: a flood of rejects has to cost an
        // attacker what a flood of accepts costs.
        if (counter.record(`ip:${request.ip}`) > ipLimit) {
          return reply
            .code(429)
            .send({ error: 'rate_limited', message: '提交过于频繁，请稍后再试' });
        }
      },
    },
    async (request, reply) => {
      // No 401 here — §15 admits anonymous messages. A *banned* identity is
      // already 403 from the auth plugin, which is §17.31's「留言」.
      const user = request.currentUser;
      if (user !== null && counter.record(`user:${user.id}`) > userLimit) {
        return reply
          .code(429)
          .send({ error: 'rate_limited', message: '提交过于频繁，请稍后再试' });
      }

      const body = request.body as {
        category?: unknown;
        movieSlug?: unknown;
        sceneIndex?: unknown;
        body?: unknown;
      } | null;

      const category = body?.category;
      if (
        typeof category !== 'string' ||
        !(CONTACT_CATEGORIES as readonly string[]).includes(category)
      ) {
        return reply.code(400).send({
          error: 'category_invalid',
          message: '留言类型必须是 general、appeal、copyright 或 bug',
          categories: CONTACT_CATEGORIES,
        });
      }

      const sceneIndex = parseSceneIndex(body?.sceneIndex);
      if (sceneIndex === 'invalid') {
        return reply.code(400).send({
          error: 'scene_index_invalid',
          message: '相关片段编号必须是片段序号，或者留空',
        });
      }

      const text = typeof body?.body === 'string' ? body.body : '';
      if (text.trim().length === 0) {
        return reply
          .code(400)
          .send({ error: 'body_required', message: '留言内容不能为空' });
      }
      // §15 counts what the reader sees, on the raw text — what was typed is
      // what is measured and what is stored.
      if (glen(text) > CONTACT_MAX_GRAPHEMES) {
        return reply.code(400).send({
          error: 'content_too_long',
          message: `最多 ${CONTACT_MAX_GRAPHEMES} 个字符`,
          max: CONTACT_MAX_GRAPHEMES,
        });
      }

      if (sceneIndex !== null) {
        const movieSlug =
          typeof body?.movieSlug === 'string'
            ? body.movieSlug
            : LEGACY_MOVIE_SLUG;
        const movie = await findPublicMovie(pool, movieSlug);
        if (movie === null) {
          return reply
            .code(400)
            .send({ error: 'movie_not_found', message: '影片不存在' });
        }
        // 「必须是已发布片段」. A taken-down 片段 still counts: §15 puts appeals
        // about a 下架 decision at the front of the queue, and refusing to
        // record the number would make exactly that appeal unfileable. The
        // column carries no foreign key by §16.1's explicit choice, so this
        // check is the whole of its integrity.
        const scene = await pool.query(
          `SELECT 1 FROM scenes WHERE movie_id = $1 AND scene_index = $2`,
          [movie.id, sceneIndex],
        );
        if (scene.rowCount === 0) {
          return reply.code(400).send({
            error: 'scene_index_invalid',
            message: '该片段不存在',
          });
        }
        await pool.query(
          `INSERT INTO contact_messages
             (user_id, movie_id, category, scene_index, body, source_ip)
           VALUES ($1, $2, $3, $4, $5, $6::inet)`,
          [user?.id ?? null, movie.id, category, sceneIndex, text, request.ip],
        );
      } else {
        await pool.query(
          `INSERT INTO contact_messages
             (user_id, movie_id, category, scene_index, body, source_ip)
           VALUES ($1, NULL, $2, NULL, $3, $4::inet)`,
          [user?.id ?? null, category, text, request.ip],
        );
      }

      // Nothing about the stored message is echoed back. The page already
      // knows what was typed, and §15 keeps the reply channel off the API.
      return reply.code(201).send({ ok: true });
    },
  );
}
