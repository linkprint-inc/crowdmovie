// 弹幕 (§14) — the three §16.3「弹幕」endpoints:
//   POST /api/danmaku
//   GET  /api/movie/scenes/{scene_index}/danmaku
//   GET  /api/danmaku/recent
//
// Two of §14's boundaries are structural here, not incidental:
//   * §14.3「弹幕文本永不拼接进任何 Codex/Sol 上下文」— nothing in this file
//     enqueues a job, touches `ai_runs` or reaches the ContentEngine. The whole
//     write path is validate → INSERT → COMMIT, which is also what §14.2 means
//     by「HTTP 只等待数据库提交，无任何 AI 环节」.
//   * §14.3「明确不做按条 AI 审核」— moderation is the hot-reloadable blocklist
//     below plus 事后 `status='hidden'`, and hidden rows are filtered in SQL on
//     every read (§17.25).
//
// The anti-abuse rules split along a deliberate line. §14.3 puts only the IP
// short window in the shared in-process limiter (「IP 短窗限速与投稿接口共用同一
// 套进程内限流器」); the per-user interval and per-scene quota are counted from
// `danmaku` itself, because a limit a process restart forgets is not a limit.
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../../db/tx.js';
import { emitEvent } from '../../lib/events.js';
import { glen } from '../../lib/grapheme.js';
import { FixedWindowCounter } from '../../lib/rate-limit.js';
import {
  findPublicMovie,
  INLAND_EMPIRE_MOVIE_ID,
  LEGACY_MOVIE_SLUG,
} from '../../movies/catalog.js';

/** §14.3「每条弹幕最多 100 个用户可见字符（对齐 bilibili 普通弹幕上限）」. */
export const DANMAKU_MAX_GRAPHEMES = 100;
/** §14.3「同一用户两条弹幕最短间隔 3 秒」. */
export const DANMAKU_MIN_INTERVAL_MS = 3_000;
/** §14.3「同一用户每片段最多 30 条」. */
export const DANMAKU_MAX_PER_SCENE = 30;
/** §14.2「该片段可见弹幕，按 offset_ms ASC，最多 500 条」. */
export const SCENE_DANMAKU_CAP = 500;
/** §14.2「全站最新可见弹幕，按 created_at ASC，最多 200 条」. */
export const RECENT_DANMAKU_CAP = 200;

/** §14.3「全站弹幕紧急开关（数据库配置项）」. */
export const DANMAKU_ENABLED_KEY = 'danmaku_enabled';
/** §14.3「服务端维护可热更新的屏蔽词表」— operations' override of the list below. */
export const DANMAKU_BLOCKLIST_KEY = 'danmaku_blocklist';

/**
 * How long a `site_settings` read is reused. Short enough that the emergency
 * switch and a blocklist edit take effect without a deploy or a restart (which
 * is what「可热更新」asks for), long enough that the hot read path is not one
 * extra query per comment.
 */
const SETTINGS_TTL_MS = 10_000;

/**
 * The in-code half of §14.3's blocklist: the spam boilerplate that shows up on
 * any open comment stream. Operations grows it online through
 * `site_settings.danmaku_blocklist` (a JSON array of strings) — which *replaces*
 * this list rather than adding to it, so a bad default can also be removed
 * without a deploy. Matching is case-insensitive substring; nothing cleverer,
 * because §14.3 already accepts that the real backstop is 事后 hidden.
 */
export const DEFAULT_BLOCKLIST = [
  '加微信',
  '加qq',
  '刷单',
  '博彩',
  '棋牌代理',
  'onlyfans',
  'free crypto',
];

/** 100 graphemes of astral-plane text is ~400 bytes; the rest is slack. */
const DANMAKU_BODY_LIMIT = 8 * 1024;

/** §14.3 的 IP 短窗限速. A comment costs far less than a 投稿, so the window is
 * wider than 投稿's — but it still bounds one address to roughly three users
 * commenting flat out. */
const DANMAKU_IP_RATE_LIMIT = 60;

/**
 * §14.3「拒绝……控制字符」. C0 and C1 controls (newline and tab included — a
 * bullet comment is one line), plus the invisible formatting characters that
 * exist to make text render as something other than what it is: zero-width
 * padding, the bidi overrides and isolates, and the byte-order mark.
 *
 * U+200D (ZERO WIDTH JOINER) is deliberately *not* in the set. It is the glue
 * inside every ZWJ emoji sequence — a family, a flag, a professions emoji — so
 * banning it would reject ordinary comments to close a spoofing hole that a
 * one-line bullet comment does not really have.
 */
const CONTROL_CHARS_RE =
  /[\u{0}-\u{1F}\u{7F}-\u{9F}\u{200B}\u{200C}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{FEFF}]/u;

/** §14.3「拒绝……纯链接」, matching 投稿's rule: only a bare, single URL. */
const LINK_ONLY_RE = /^(?:https?:\/\/|www\.)\S+$/i;

interface DanmakuSettings {
  enabled: boolean;
  blocklist: string[];
}

/**
 * Cached reader for the two `site_settings` rows this module honours. Absent
 * rows mean "default": danmaku on, in-code blocklist — the emergency switch has
 * to be something an operator turns *off*, never something whose absence takes
 * the feature down.
 */
function settingsReader(
  pool: Pool,
  ttlMs: number,
): () => Promise<DanmakuSettings> {
  let cached: DanmakuSettings | null = null;
  let expiresAt = 0;

  return async function read(): Promise<DanmakuSettings> {
    const now = Date.now();
    if (cached !== null && now < expiresAt) return cached;

    const result = await pool.query<{ key: string; value: unknown }>(
      'SELECT key, value FROM site_settings WHERE key = ANY($1::text[])',
      [[DANMAKU_ENABLED_KEY, DANMAKU_BLOCKLIST_KEY]],
    );
    const byKey = new Map(result.rows.map((row) => [row.key, row.value]));

    const enabledValue = byKey.get(DANMAKU_ENABLED_KEY);
    const blocklistValue = byKey.get(DANMAKU_BLOCKLIST_KEY);
    cached = {
      // Only an explicit `false` closes the switch; a row holding anything else
      // is a malformed setting, and a malformed setting must not silently
      // disable a working feature.
      enabled: enabledValue !== false,
      blocklist: Array.isArray(blocklistValue)
        ? blocklistValue.filter(
            (word): word is string => typeof word === 'string' && word.length > 0,
          )
        : DEFAULT_BLOCKLIST,
    };
    expiresAt = now + ttlMs;
    return cached;
  };
}

function isBlocked(content: string, blocklist: readonly string[]): boolean {
  const haystack = content.toLowerCase();
  return blocklist.some((word) => haystack.includes(word.toLowerCase()));
}

interface DanmakuRow {
  /** BIGINT: node-postgres hands it over as a string, which is also what the
   *  frontend types it as. Left as-is rather than narrowed to a JS number. */
  id: string;
  movie_id: string;
  username: string;
  content: string;
  scene_index: number;
  offset_ms: number;
  created_at: Date;
}

/**
 * The one shape every danmaku leaves the server in. §14.2 defines the SSE
 * `danmaku.created` payload as exactly these fields (`scene_index`,
 * `offset_ms`, `username_display`, `content`, `created_at`), so when
 * `GET /api/events` lands (§16.4) the broadcast body is this function's output
 * and the emit is one line at the marked point in the POST handler below.
 *
 * `videoSceneId` / `videoTimeMs` are the same two anchors under the names the
 * shipped player's overlay reads them by (web/src/lib/api.ts `Danmaku`); they
 * are aliases, not a second source of truth.
 */
function danmakuView(row: DanmakuRow): Record<string, unknown> {
  return {
    id: row.id,
    movieId: row.movie_id,
    username: row.username,
    content: row.content,
    sceneIndex: row.scene_index,
    offsetMs: row.offset_ms,
    createdAt: row.created_at.toISOString(),
    videoSceneId: String(row.scene_index),
    videoTimeMs: row.offset_ms,
  };
}

const DANMAKU_COLUMNS = `d.id, d.movie_id, d.scene_index, d.offset_ms, d.content, d.created_at,
                         u.username_display AS username`;

/** A published, non-taken-down scene and the millisecond bound §14.1 checks
 *  `offset_ms` against. Null when there is no such scene to anchor to. */
async function playableScene(
  client: PoolClient,
  movieId: string,
  sceneIndex: number,
): Promise<{ durationMs: number } | null> {
  const result = await client.query<{ duration_ms: string }>(
    `SELECT round(duration_seconds * 1000) AS duration_ms
       FROM scenes
      WHERE movie_id = $1 AND scene_index = $2 AND takedown_at IS NULL`,
    [movieId, sceneIndex],
  );
  const row = result.rows[0];
  return row === undefined ? null : { durationMs: Number(row.duration_ms) };
}

function parseIndex(raw: unknown): number | null {
  const value = typeof raw === 'number' ? raw : Number.NaN;
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

export interface DanmakuRoutesOptions {
  pool: Pool;
  /** 弹幕 per minute per IP (§14.3 的 IP 短窗); tests pin it. */
  danmakuIpRateLimit?: number;
  /** How long a `site_settings` read is reused; tests pin it to 0 so a switch
   *  flip is observable on the next request. */
  danmakuSettingsTtlMs?: number;
}

export async function danmakuRoutes(
  app: FastifyInstance,
  options: DanmakuRoutesOptions,
): Promise<void> {
  const { pool } = options;
  const ipLimit = options.danmakuIpRateLimit ?? DANMAKU_IP_RATE_LIMIT;
  // §14.3 asks danmaku to share 投稿's limiter; it shares the *mechanism* and
  // not the budget, because 30 comments per scene would otherwise eat a
  // 投稿 allowance sized for one pitch per round. Keys carry their axis as a
  // prefix so two axes can never land on one another's counter.
  const ipCounter = new FixedWindowCounter();
  const readSettings = settingsReader(
    pool,
    options.danmakuSettingsTtlMs ?? SETTINGS_TTL_MS,
  );

  // --- POST /api/danmaku (§14.2, §14.3) --------------------------------------

  app.post(
    '/api/danmaku',
    {
      bodyLimit: DANMAKU_BODY_LIMIT,
      // Counted before the body is parsed, so a flood of rejects costs an
      // attacker exactly what a flood of accepts does.
      onRequest: async (request, reply) => {
        if (ipCounter.record(`ip:${request.ip}`) > ipLimit) {
          return reply
            .code(429)
            .send({ error: 'rate_limited', message: '操作过于频繁，请稍后再试' });
        }
      },
    },
    async (request, reply) => {
      // §14.3「全站弹幕紧急开关……关闭时 POST 返回 503」. First, because the
      // switch is a property of the endpoint rather than of the caller: with
      // danmaku off there is nothing to authenticate for.
      const settings = await readSettings();
      if (!settings.enabled) {
        return reply.code(503).send({
          error: 'danmaku_disabled',
          message: '弹幕已临时关闭',
        });
      }

      const user = request.currentUser;
      // The auth plugin has already turned a banned identity into 403 (§17.31).
      if (user === null) {
        return reply
          .code(401)
          .send({ error: 'identity_required', message: '请先认领用户名' });
      }

      const body = request.body as {
        movieSlug?: unknown;
        sceneIndex?: unknown;
        offsetMs?: unknown;
        content?: unknown;
      } | null;

      const movieSlug =
        typeof body?.movieSlug === 'string' ? body.movieSlug : LEGACY_MOVIE_SLUG;
      const movie = await findPublicMovie(pool, movieSlug);
      if (movie === null) {
        return reply
          .code(404)
          .send({ error: 'movie_not_found', message: '影片不存在' });
      }

      const sceneIndex = parseIndex(body?.sceneIndex);
      if (sceneIndex === null) {
        return reply.code(400).send({
          error: 'scene_index_invalid',
          message: '弹幕必须锚定在一个已发布片段上',
        });
      }
      const offsetRaw = typeof body?.offsetMs === 'number' ? body.offsetMs : Number.NaN;
      if (!Number.isSafeInteger(offsetRaw) || offsetRaw < 0) {
        return reply.code(400).send({
          error: 'offset_invalid',
          message: '弹幕时间点必须是非负整数毫秒',
        });
      }
      const offsetMs = offsetRaw;

      const content = typeof body?.content === 'string' ? body.content : '';
      if (content.trim().length === 0) {
        return reply
          .code(400)
          .send({ error: 'content_required', message: '弹幕内容不能为空' });
      }
      if (CONTROL_CHARS_RE.test(content)) {
        return reply
          .code(400)
          .send({ error: 'content_invalid', message: '弹幕不能包含控制字符' });
      }
      if (LINK_ONLY_RE.test(content.trim())) {
        return reply
          .code(400)
          .send({ error: 'content_link_only', message: '弹幕不能只有一个链接' });
      }
      // §14.3「使用与投稿一致的 Intl.Segmenter grapheme cluster 计数」— on the
      // raw text, so what the user typed is what is measured and stored.
      if (glen(content) > DANMAKU_MAX_GRAPHEMES) {
        return reply.code(400).send({
          error: 'content_too_long',
          message: `最多 ${DANMAKU_MAX_GRAPHEMES} 个字符`,
          max: DANMAKU_MAX_GRAPHEMES,
        });
      }
      if (isBlocked(content, settings.blocklist)) {
        return reply
          .code(400)
          .send({ error: 'content_blocked', message: '弹幕包含屏蔽词' });
      }

      const result = await withTransaction(pool, async (client) => {
        // §14.3's two per-user limits are only limits if a double-clicked send
        // or two tabs cannot slip past them, so every check below runs behind
        // this user's own row lock. Nothing else in the app takes a write lock
        // on `users` on the request path, so it serialises one user's comments
        // and nothing else.
        await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [
          user.id,
        ]);

        // §14.1「校验 scene_index 属于已发布片段，且 offset_ms 不超过该片段实际
        // 时长（毫秒）；超界直接拒绝，不做静默截断」.
        const scene = await playableScene(client, movie.id, sceneIndex);
        if (scene === null) return { error: 'scene_index_invalid' as const };
        if (offsetMs > scene.durationMs) {
          return { error: 'offset_out_of_range' as const, max: scene.durationMs };
        }

        // The user's own previous comment answers two of §14.3's rules at once:
        // 「两条弹幕最短间隔 3 秒」and「与该用户上一条完全相同的文本」. Hidden
        // rows count — an operator hiding a comment is not a refund.
        const previous = await client.query<{
          content: string;
          age_ms: string;
        }>(
          `SELECT content,
                  extract(epoch FROM (now() - created_at)) * 1000 AS age_ms
             FROM danmaku
            WHERE user_id = $1
            ORDER BY id DESC
            LIMIT 1`,
          [user.id],
        );
        const last = previous.rows[0];
        if (last !== undefined) {
          if (Number(last.age_ms) < DANMAKU_MIN_INTERVAL_MS) {
            return { error: 'too_fast' as const };
          }
          if (last.content === content) {
            return { error: 'content_duplicate' as const };
          }
        }

        const posted = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM danmaku
            WHERE user_id = $1 AND movie_id = $2 AND scene_index = $3`,
          [user.id, movie.id, sceneIndex],
        );
        if (posted.rows[0].n >= DANMAKU_MAX_PER_SCENE) {
          return { error: 'scene_quota_exceeded' as const };
        }

        const inserted = await client.query<DanmakuRow>(
          `INSERT INTO danmaku (movie_id, user_id, scene_index, offset_ms, content)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, movie_id, scene_index, offset_ms, content, created_at,
                     $6::text AS username`,
          [
            movie.id,
            user.id,
            sceneIndex,
            offsetMs,
            content,
            user.usernameDisplay,
          ],
        );

        // §14.2「写入成功后通过既有 SSE 流广播 danmaku.created」, §17.24. Inside
        // the transaction, so it is delivered at COMMIT and never for a comment
        // that rolled back. The payload is `danmakuView`'s five §14.2 fields —
        // and it is a broadcast, not an AI call: §17.26「弹幕文本不进入任何模型
        // 上下文」still holds, because nothing downstream of this stream is a
        // model.
        await emitEvent(client, {
          type: 'danmaku.created',
          data: danmakuView(inserted.rows[0]),
        });
        return { row: inserted.rows[0] };
      });

      if ('error' in result) {
        switch (result.error) {
          case 'scene_index_invalid':
            return reply.code(400).send({
              error: 'scene_index_invalid',
              message: '该片段不存在或已下架',
            });
          case 'offset_out_of_range':
            return reply.code(400).send({
              error: 'offset_out_of_range',
              message: '弹幕时间点超出该片段时长',
              max: result.max,
            });
          case 'too_fast':
            return reply.code(429).send({
              error: 'too_fast',
              message: '发送太快了，请等几秒',
            });
          case 'content_duplicate':
            return reply.code(400).send({
              error: 'content_duplicate',
              message: '不要重复发送同一条弹幕',
            });
          case 'scene_quota_exceeded':
            return reply.code(429).send({
              error: 'scene_quota_exceeded',
              message: `每个片段最多发送 ${DANMAKU_MAX_PER_SCENE} 条弹幕`,
            });
        }
      }

      return reply.code(201).send(danmakuView(result.row));
    },
  );

  // --- GET /api/movie/scenes/{scene_index}/danmaku (§14.2) --------------------

  app.get<{ Params: { sceneIndex: string } }>(
    '/api/movie/scenes/:sceneIndex/danmaku',
    async (request, reply) => {
      const sceneIndex = parseIndex(Number(request.params.sceneIndex));
      if (sceneIndex === null) {
        return reply
          .code(404)
          .send({ error: 'scene_not_found', message: '该片段不存在或已下架' });
      }

      // §17.32「被下架片段立即从播放清单、分享页与统计中消失」— a taken-down
      // scene has no readable comment track either.
      const exists = await pool.query(
        `SELECT 1 FROM scenes
          WHERE movie_id = $1 AND scene_index = $2 AND takedown_at IS NULL`,
        [INLAND_EMPIRE_MOVIE_ID, sceneIndex],
      );
      if (exists.rowCount === 0) {
        return reply
          .code(404)
          .send({ error: 'scene_not_found', message: '该片段不存在或已下架' });
      }

      // §14.2「单片段弹幕超过 500 条时，回放接口按 offset_ms 均匀抽样返回并标记
      // truncated: true」.
      //
      // The sampling is done in SQL so a hot scene never ships 100k rows to the
      // process just to throw most of them away. Each row is placed in one of
      // `cap` buckets by its position along the ordered timeline, and the first
      // row of every bucket is kept: with `total >= cap` every bucket holds at
      // least one row, so exactly `cap` rows come back, spread evenly from the
      // first offset to the last. Under the cap the predicate is simply true.
      const rows = await pool.query<DanmakuRow & { total: string }>(
        `WITH ordered AS (
           SELECT ${DANMAKU_COLUMNS},
                  row_number() OVER (ORDER BY d.offset_ms ASC, d.id ASC) AS rn,
                  count(*) OVER () AS total
             FROM danmaku d
             JOIN users u ON u.id = d.user_id
            WHERE d.movie_id = $1 AND d.scene_index = $2 AND d.status = 'visible'
         )
         SELECT id, movie_id, scene_index, offset_ms, content, created_at, username, total
           FROM ordered
          WHERE total <= $3
             OR rn = 1
             OR ((rn - 1) * $3) / total <> ((rn - 2) * $3) / total
          ORDER BY offset_ms ASC, id ASC`,
        [INLAND_EMPIRE_MOVIE_ID, sceneIndex, SCENE_DANMAKU_CAP],
      );

      const total = rows.rows.length === 0 ? 0 : Number(rows.rows[0].total);
      return {
        sceneIndex,
        total,
        truncated: total > SCENE_DANMAKU_CAP,
        danmaku: rows.rows.map(danmakuView),
      };
    },
  );

  // --- GET /api/danmaku/recent (§14.2) ---------------------------------------

  // 「全站最新可见弹幕，按 created_at ASC，最多 200 条」— the newest 200, handed
  // back oldest-first, which is the order the right rail renders them in (UI
  // §7「顺序从旧到新，最新弹幕位于底部」). Comments on a taken-down scene are
  // left out for the same reason the endpoint above 404s on one (§17.32).
  app.get('/api/danmaku/recent', async () => {
    const rows = await pool.query<DanmakuRow>(
      `SELECT id, movie_id, scene_index, offset_ms, content, created_at, username
         FROM (
           SELECT ${DANMAKU_COLUMNS}
             FROM danmaku d
             JOIN users u ON u.id = d.user_id
             JOIN scenes s
               ON s.movie_id = d.movie_id AND s.scene_index = d.scene_index
            WHERE d.movie_id = $1 AND d.status = 'visible' AND s.takedown_at IS NULL
            ORDER BY d.created_at DESC, d.id DESC
            LIMIT $2
         ) newest
        ORDER BY created_at ASC, id ASC`,
      [INLAND_EMPIRE_MOVIE_ID, RECENT_DANMAKU_CAP],
    );
    return { danmaku: rows.rows.map(danmakuView) };
  });

  app.get<{ Params: { movieSlug: string; sceneIndex: string } }>(
    '/api/movies/:movieSlug/scenes/:sceneIndex/danmaku',
    async (request, reply) => {
      const movie = await findPublicMovie(pool, request.params.movieSlug);
      const sceneIndex = parseIndex(Number(request.params.sceneIndex));
      if (movie === null || sceneIndex === null) {
        return reply
          .code(404)
          .send({ error: 'scene_not_found', message: '该片段不存在或已下架' });
      }
      const exists = await pool.query(
        `SELECT 1 FROM scenes
          WHERE movie_id = $1 AND scene_index = $2 AND takedown_at IS NULL`,
        [movie.id, sceneIndex],
      );
      if (exists.rowCount === 0) {
        return reply
          .code(404)
          .send({ error: 'scene_not_found', message: '该片段不存在或已下架' });
      }
      const rows = await pool.query<DanmakuRow & { total: string }>(
        `WITH ordered AS (
           SELECT ${DANMAKU_COLUMNS},
                  row_number() OVER (ORDER BY d.offset_ms, d.id) AS rn,
                  count(*) OVER () AS total
             FROM danmaku d JOIN users u ON u.id = d.user_id
            WHERE d.movie_id = $1 AND d.scene_index = $2
              AND d.status = 'visible'
         )
         SELECT id, movie_id, scene_index, offset_ms, content, created_at,
                username, total
           FROM ordered
          WHERE total <= $3 OR rn = 1
             OR ((rn - 1) * $3) / total <> ((rn - 2) * $3) / total
          ORDER BY offset_ms, id`,
        [movie.id, sceneIndex, SCENE_DANMAKU_CAP],
      );
      const total = rows.rows.length === 0 ? 0 : Number(rows.rows[0].total);
      return {
        movieId: movie.id,
        sceneIndex,
        total,
        truncated: total > SCENE_DANMAKU_CAP,
        danmaku: rows.rows.map(danmakuView),
      };
    },
  );

  app.get<{ Params: { movieSlug: string } }>(
    '/api/movies/:movieSlug/danmaku/recent',
    async (request, reply) => {
      const movie = await findPublicMovie(pool, request.params.movieSlug);
      if (movie === null) {
        return reply
          .code(404)
          .send({ error: 'movie_not_found', message: '影片不存在' });
      }
      const rows = await pool.query<DanmakuRow>(
        `SELECT id, movie_id, scene_index, offset_ms, content, created_at, username
           FROM (
             SELECT ${DANMAKU_COLUMNS}
               FROM danmaku d
               JOIN users u ON u.id = d.user_id
               JOIN scenes s
                 ON s.movie_id = d.movie_id AND s.scene_index = d.scene_index
              WHERE d.movie_id = $1 AND d.status = 'visible'
                AND s.takedown_at IS NULL
              ORDER BY d.created_at DESC, d.id DESC
              LIMIT $2
           ) newest
          ORDER BY created_at, id`,
        [movie.id, RECENT_DANMAKU_CAP],
      );
      return { movieId: movie.id, danmaku: rows.rows.map(danmakuView) };
    },
  );
}
