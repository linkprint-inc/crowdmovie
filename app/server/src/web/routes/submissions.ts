// 投稿与投票 (§4, §5.4) — the four §16.3 放映厅·时间线 endpoints that T3.2 owns:
//   GET  /api/round/current
//   GET  /api/round/current/submissions
//   POST /api/round/current/submissions
//   POST /api/submissions/{id}/vote
//
// Two rules shape every write here:
//   * §4「同一用户同一轮次只能投一条 next_shot……唯一约束兜底。接口层先行拒绝重
//     复」— the pre-check is a courtesy, the partial unique index is the actual
//     guarantee, so 23505 is caught and answered as 409 rather than 500.
//   * A Qwen no-thinking score job is created in the same transaction as each
//     transaction as the INSERT: a submission that exists without its scoring
//     job would be silently excluded from the round, which §5.3 forbids.
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../../db/tx.js';
import { roundJobKey, scoreJobKey } from '../../jobs/keys.js';
import { enqueue } from '../../jobs/ledger.js';
import { emitEvent } from '../../lib/events.js';
import { glen } from '../../lib/grapheme.js';
import { FixedWindowCounter } from '../../lib/rate-limit.js';
import { readVoteAdoptThreshold } from '../../lib/site-settings.js';
import { CLOCK_LOCK_KEY, ensureOpenRound } from '../../rounds/clock.js';
import {
  findPublicMovie,
  INLAND_EMPIRE_MOVIE_ID,
  resolveScheduledProgram,
} from '../../movies/catalog.js';

/** §4「「下一个镜头」投稿最多 140 个用户可见字符」. */
export const NEXT_SHOT_MAX_GRAPHEMES = 140;
/** §4「「下一集」总纲投稿最多 1000 个用户可见字符」. */
export const NEXT_EPISODE_MAX_GRAPHEMES = 1000;

export const SUBMISSION_KINDS = ['next_shot', 'next_episode'] as const;
export type SubmissionKind = (typeof SUBMISSION_KINDS)[number];

export const KIND_MAX_GRAPHEMES: Record<SubmissionKind, number> = {
  next_shot: NEXT_SHOT_MAX_GRAPHEMES,
  next_episode: NEXT_EPISODE_MAX_GRAPHEMES,
};

// 1000 graphemes of astral-plane text is ~4KB; the rest is JSON overhead and
// slack. Bounded so Intl.Segmenter is never handed a megabyte of hostile input.
const SUBMISSION_BODY_LIMIT = 32 * 1024;
const VOTE_BODY_LIMIT = 1024;

/** §4 的最低反滥用规则：per-IP and per-identity submission/vote frequency. */
const SUBMISSION_RATE_LIMIT = 20;
const VOTE_RATE_LIMIT = 120;

/**
 * §4「拒绝空内容、纯链接」. Only a bare, single URL is refused — a pitch that
 * happens to *contain* a link is still a pitch. 「重复刷屏」is covered by the
 * one-per-round / one-per-episode uniqueness plus the rate limits above.
 */
const LINK_ONLY_RE = /^(?:https?:\/\/|www\.)\S+$/i;

const DUPLICATE_CONSTRAINTS = new Set([
  'submissions_next_shot_round_user_uq',
  'submissions_next_episode_ep_user_uq',
]);

function isDuplicateSubmission(error: unknown): boolean {
  const pgError = error as { code?: unknown; constraint?: unknown };
  return (
    pgError?.code === '23505' &&
    typeof pgError.constraint === 'string' &&
    DUPLICATE_CONSTRAINTS.has(pgError.constraint)
  );
}

interface RoundRow {
  id: string;
  movie_id: string;
  /** BIGINT: node-postgres returns it as a string, so the view converts it. */
  round_index: string;
  status: string;
  opens_at: Date;
  /** NULL while the round is 未点火 — nobody has submitted to it yet (§5.3). */
  closes_at: Date | null;
  selected_submission_id: string | null;
  selection_mode: string | null;
  episode_id: string;
  episode_index: number;
  episode_title: string;
}

interface PublicSubmissionRow {
  id: string;
  content: string;
  status: string;
  up_count: number;
  down_count: number;
  votes_frozen_at: Date | null;
  created_at: Date;
  username: string;
  score_total: number | null;
  public_roast: unknown;
}

interface TimelineSubmissionRow extends PublicSubmissionRow {
  round_id: string;
  round_index: string;
  round_status: string;
  scene_index: number | null;
  scene_taken_down: boolean;
}

interface TimelineRound {
  roundIndex: number;
  status: string;
  sceneIndex: number | null;
  sceneTakenDown: boolean;
  submissions: Array<Record<string, unknown>>;
}

interface TimelineCursor {
  createdAt: string;
  id: string;
}

interface TimelineQuery {
  before?: string;
  limit?: string;
}

const TIMELINE_PAGE_SIZE = 100;
const TIMELINE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function publicSubmission(row: PublicSubmissionRow): Record<string, unknown> {
  return {
    id: row.id,
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
  };
}

function encodeTimelineCursor(row: TimelineSubmissionRow): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.created_at.toISOString(), id: row.id }),
  ).toString('base64url');
}

function decodeTimelineCursor(value: string | undefined): TimelineCursor | null {
  if (value === undefined) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (
      typeof decoded.createdAt !== 'string' ||
      Number.isNaN(Date.parse(decoded.createdAt)) ||
      typeof decoded.id !== 'string' ||
      !TIMELINE_UUID_RE.test(decoded.id)
    ) {
      return null;
    }
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    return null;
  }
}

function timelineLimit(value: string | undefined): number | null {
  if (value === undefined) return TIMELINE_PAGE_SIZE;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1
    ? Math.min(parsed, TIMELINE_PAGE_SIZE)
    : null;
}

async function loadSubmissionTimeline(
  pool: Pool,
  movieId: string,
  round: RoundRow | null,
  query: TimelineQuery,
): Promise<
  | { error: 'cursor_invalid' | 'limit_invalid' }
  | {
      archive: TimelineRound[];
      submissions: Array<Record<string, unknown>>;
      hasMore: boolean;
      nextCursor: string | null;
    }
> {
  const limit = timelineLimit(query.limit);
  if (limit === null) return { error: 'limit_invalid' };
  const cursor = decodeTimelineCursor(query.before);
  if (query.before !== undefined && cursor === null) return { error: 'cursor_invalid' };

  const result = await pool.query<TimelineSubmissionRow>(
    `SELECT s.id, s.round_id, s.content, s.status, s.up_count, s.down_count,
            s.votes_frozen_at, s.created_at,
            u.username_display AS username,
            sc.score_total, sc.public_roast, r.round_index, r.status AS round_status,
            scene.scene_index, (scene.takedown_at IS NOT NULL) AS scene_taken_down
       FROM submissions s
       JOIN rounds r ON r.id = s.round_id AND r.movie_id = s.movie_id
       JOIN users u ON u.id = s.user_id
       LEFT JOIN submission_scores sc ON sc.submission_id = s.id
       LEFT JOIN scenes scene ON scene.round_id = r.id AND scene.movie_id = r.movie_id
      WHERE s.movie_id = $1 AND s.kind = 'next_shot'
        AND ($2::timestamptz IS NULL OR
             (s.created_at, s.id) < ($2::timestamptz, $3::uuid))
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT $4`,
    [movieId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
  );
  const hasMore = result.rows.length > limit;
  const pageRows = result.rows.slice(0, limit);
  const archive = new Map<number, TimelineRound>();
  const submissions: Array<Record<string, unknown>> = [];

  // SQL seeks newest-first so LIMIT can stop at 100. Reverse only the bounded
  // page before presenting the feed's oldest-to-newest contract.
  for (const row of pageRows.toReversed()) {
    if (row.round_id === round?.id) {
      submissions.push(publicSubmission(row));
      continue;
    }
    const roundIndex = Number(row.round_index);
    const group = archive.get(roundIndex) ?? {
      roundIndex,
      status: row.round_status,
      sceneIndex: row.scene_index,
      sceneTakenDown: row.scene_taken_down,
      submissions: [],
    };
    group.submissions.push(publicSubmission(row));
    archive.set(roundIndex, group);
  }

  return {
    archive: [...archive]
      .sort(([left], [right]) => left - right)
      .map(([, group]) => group),
    submissions,
    hasMore,
    nextCursor: hasMore && pageRows.length > 0
      ? encodeTimelineCursor(pageRows[pageRows.length - 1])
      : null,
  };
}

const ROUND_SELECT = `
  SELECT r.id, r.movie_id, r.round_index, r.status, r.opens_at, r.closes_at,
         r.selected_submission_id, r.selection_mode,
         e.id AS episode_id, e.episode_index, e.title AS episode_title
    FROM rounds r JOIN episodes e ON e.id = r.episode_id`;

/**
 * The round the site is currently about: the open one, or — while the pipeline
 * is between rounds — the most recent one, so the page can still show what is
 * being generated. `null` only before the worker has ever ticked.
 */
async function currentRound(db: Pool, movieId: string): Promise<RoundRow | null> {
  const result = await db.query<RoundRow>(
    `${ROUND_SELECT}
      WHERE r.movie_id = $1
      ORDER BY (r.status = 'open') DESC, r.round_index DESC
      LIMIT 1`,
    [movieId],
  );
  return result.rows[0] ?? null;
}

function roundView(round: RoundRow): Record<string, unknown> {
  return {
    roundId: round.id,
    movieId: round.movie_id,
    roundIndex: Number(round.round_index),
    status: round.status,
    opensAt: round.opens_at.toISOString(),
    closesAt: round.closes_at?.toISOString() ?? null,
    selectedSubmissionId: round.selected_submission_id,
    selectionMode: round.selection_mode,
    episodeIndex: round.episode_index,
    episodeTitle: round.episode_title,
  };
}

export interface SubmissionRoutesOptions {
  pool: Pool;
  /** §5「每个轮次固定持续 5 分钟」— the window the first 投稿 opens (§5.3). */
  roundLengthMs: number;
  /** Net votes that immediately elect the first `next_shot` pitch to reach it. */
  voteAdoptThreshold: number;
  submissionRateLimit?: number;
  voteRateLimit?: number;
}

export async function submissionRoutes(
  app: FastifyInstance,
  options: SubmissionRoutesOptions,
): Promise<void> {
  const { pool, roundLengthMs, voteAdoptThreshold } = options;
  const submissionLimit = options.submissionRateLimit ?? SUBMISSION_RATE_LIMIT;
  const voteLimit = options.voteRateLimit ?? VOTE_RATE_LIMIT;
  const submissionCounter = new FixedWindowCounter();
  const voteCounter = new FixedWindowCounter();

  // --- 读取 ------------------------------------------------------------------

  app.get('/api/round/current', async (_request, reply) => {
    const round = await currentRound(pool, INLAND_EMPIRE_MOVIE_ID);
    if (round === null) {
      return reply
        .code(404)
        .send({ error: 'no_round', message: '还没有开始任何轮次' });
    }
    return roundView(round);
  });

  // §17.7「投稿能够实时显示在当前轮次列表中」. §6.3 公开策略 decides the columns:
  // score_total and the four-language roast are public the moment they exist;
  // score_breakdown / reason / risk_flags never leave the server.
  app.get<{ Querystring: TimelineQuery }>(
    '/api/round/current/submissions',
    async (request, reply) => {
      const round = await currentRound(pool, INLAND_EMPIRE_MOVIE_ID);
      if (round === null) {
        return reply
          .code(404)
          .send({ error: 'no_round', message: '还没有开始任何轮次' });
      }

      const timeline = await loadSubmissionTimeline(
        pool,
        INLAND_EMPIRE_MOVIE_ID,
        round,
        request.query,
      );
      if ('error' in timeline) {
        return reply.code(400).send({
          error: timeline.error,
          message:
            timeline.error === 'cursor_invalid'
              ? '分页光标无效'
              : '分页数量无效',
        });
      }

      return {
        roundId: round.id,
        roundIndex: Number(round.round_index),
        ...timeline,
      };
    },
  );

  // --- 投稿 (§4) -------------------------------------------------------------

  app.post(
    '/api/round/current/submissions',
    {
      bodyLimit: SUBMISSION_BODY_LIMIT,
      onRequest: async (request, reply) => {
        // Counted before the body is even parsed, so a flood of rejects costs
        // an attacker the same as a flood of accepts.
        if (submissionCounter.record(request.ip) > submissionLimit) {
          return reply
            .code(429)
            .send({ error: 'rate_limited', message: '操作过于频繁，请稍后再试' });
        }
      },
    },
    async (request, reply) => {
      const user = request.currentUser;
      // The auth plugin has already turned a banned identity into 403 (§17.31).
      if (user === null) {
        return reply
          .code(401)
          .send({ error: 'identity_required', message: '请先认领用户名' });
      }
      if (submissionCounter.record(`user:${user.id}`) > submissionLimit) {
        return reply
          .code(429)
          .send({ error: 'rate_limited', message: '操作过于频繁，请稍后再试' });
      }

      const body = request.body as { kind?: unknown; content?: unknown } | null;
      const kind = body?.kind;
      if (
        typeof kind !== 'string' ||
        !(SUBMISSION_KINDS as readonly string[]).includes(kind)
      ) {
        return reply.code(400).send({
          error: 'kind_invalid',
          message: '投稿类型必须是 next_shot 或 next_episode',
        });
      }
      const content = typeof body?.content === 'string' ? body.content : '';
      if (content.trim().length === 0) {
        return reply
          .code(400)
          .send({ error: 'content_required', message: '投稿内容不能为空' });
      }
      if (LINK_ONLY_RE.test(content.trim())) {
        return reply
          .code(400)
          .send({ error: 'content_link_only', message: '投稿不能只有一个链接' });
      }
      // §4「服务端按 Unicode grapheme cluster 计数」— on the raw text, not the
      // trimmed one: what the user typed is what gets stored.
      const max = KIND_MAX_GRAPHEMES[kind as SubmissionKind];
      if (glen(content) > max) {
        return reply.code(400).send({
          error: 'content_too_long',
          message: `最多 ${max} 个字符`,
          max,
        });
      }

      try {
        const created = await withTransaction(pool, async (client) => {
          const target = await resolveTarget(
            client,
            kind as SubmissionKind,
            INLAND_EMPIRE_MOVIE_ID,
          );
          if (typeof target === 'string') return { error: target };

          const inserted = await client.query<{ id: string; created_at: Date }>(
            `INSERT INTO submissions
               (movie_id, kind, round_id, episode_id, user_id, content)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, created_at`,
            [
              INLAND_EMPIRE_MOVIE_ID,
              kind,
              target.roundId,
              target.episodeId,
              user.id,
              content,
            ],
          );
          const submission = inserted.rows[0];

          // 与投稿写在同一个事务里：提交之后不存在“有投稿却没有截止时间”的中间
          // 状态。每个空轮都等第一条真人镜头剧情才启动倒计时；后续投稿不续时。
          // 总纲提案不点火（`round_id` 为 NULL）：它不是本轮要拍的东西。
          await armRoundAfterFirstShot(client, target.roundId, roundLengthMs);

          // A successfully published submission is no longer a draft. Clear
          // the cross-session copy in the same transaction as the submission,
          // so a lost HTTP response or an immediate reload cannot restore the
          // just-published text into the composer.
          await client.query(
            `UPDATE drafts SET body = '', updated_at = now()
              WHERE user_id = $1 AND kind = $2 AND body <> ''`,
            [user.id, kind],
          );

          // §6.3「投稿写入 PostgreSQL 的同一事务中创建 submission_score 任务」.
          // `auditRoundId` is the round the ai_runs row will be filed under —
          // a `next_episode` proposal has no round of its own (§16.1 CHECK).
          await enqueue(client, {
            jobType: 'submission_score',
            idempotencyKey: scoreJobKey(
              submission.id,
              INLAND_EMPIRE_MOVIE_ID,
            ),
            movieId: INLAND_EMPIRE_MOVIE_ID,
            roundId: target.auditRoundId,
            payload: { submissionId: submission.id },
          });

          // §16.4 `submission.created` — §17.7「投稿能够实时显示在当前轮次列表
          // 中」. It carries what the timeline row needs so the list does not
          // have to be refetched on every 投稿; the score arrives separately as
          // `submission.scored` when 初评 lands.
          await emitEvent(client, {
            type: 'submission.created',
            data: {
              movieId: INLAND_EMPIRE_MOVIE_ID,
              submissionId: submission.id,
              kind,
              roundId: target.roundId,
              episodeId: target.episodeId,
              username: user.usernameDisplay,
              content,
              createdAt: submission.created_at.toISOString(),
            },
          });

          return { submission, target };
        });

        if ('error' in created) {
          if (created.error === 'round_closed') {
            return reply.code(409).send({
              error: 'round_closed',
              message: '本轮已截止，请等待下一轮',
            });
          }
          return reply
            .code(409)
            .send({ error: 'no_round', message: '还没有开始任何轮次' });
        }

        return reply.code(201).send({
          id: created.submission.id,
          kind,
          roundId: created.target.roundId,
          episodeId: created.target.episodeId,
          createdAt: created.submission.created_at.toISOString(),
          status: 'pending',
        });
      } catch (error) {
        if (isDuplicateSubmission(error)) {
          return reply.code(409).send({
            error: 'duplicate_submission',
            message:
              kind === 'next_shot'
                ? '本轮你已经投过稿了'
                : '本集你已经提过总纲了',
          });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { movieSlug: string } }>(
    '/api/movies/:movieSlug/round/current',
    async (request, reply) => {
      const movie = await findPublicMovie(pool, request.params.movieSlug);
      if (movie === null) {
        return reply
          .code(404)
          .send({ error: 'movie_not_found', message: '影片不存在' });
      }
      const round = await currentRound(pool, movie.id);
      if (round === null) {
        return reply
          .code(404)
          .send({ error: 'no_round', message: '这部影片还没有开始轮次' });
      }
      return roundView(round);
    },
  );

  app.get<{ Params: { movieSlug: string }; Querystring: TimelineQuery }>(
    '/api/movies/:movieSlug/round/current/submissions',
    async (request, reply) => {
      const movie = await findPublicMovie(pool, request.params.movieSlug);
      if (movie === null) {
        return reply
          .code(404)
          .send({ error: 'movie_not_found', message: '影片不存在' });
      }
      const round = await currentRound(pool, movie.id);
      const timeline = await loadSubmissionTimeline(pool, movie.id, round, request.query);
      if ('error' in timeline) {
        return reply.code(400).send({
          error: timeline.error,
          message:
            timeline.error === 'cursor_invalid'
              ? '分页光标无效'
              : '分页数量无效',
        });
      }

      return {
        movieId: movie.id,
        roundId: round?.id ?? null,
        roundIndex: round === null ? null : Number(round.round_index),
        ...timeline,
      };
    },
  );

  app.post<{ Params: { movieSlug: string } }>(
    '/api/movies/:movieSlug/round/current/submissions',
    {
      bodyLimit: SUBMISSION_BODY_LIMIT,
      onRequest: async (request, reply) => {
        if (submissionCounter.record(request.ip) > submissionLimit) {
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
      if (submissionCounter.record(`user:${user.id}`) > submissionLimit) {
        return reply
          .code(429)
          .send({ error: 'rate_limited', message: '操作过于频繁，请稍后再试' });
      }
      const movie = await findPublicMovie(pool, request.params.movieSlug);
      if (movie === null) {
        return reply
          .code(404)
          .send({ error: 'movie_not_found', message: '影片不存在' });
      }
      const body = request.body as { kind?: unknown; content?: unknown } | null;
      const kind = body?.kind;
      if (
        typeof kind !== 'string' ||
        !(SUBMISSION_KINDS as readonly string[]).includes(kind)
      ) {
        return reply.code(400).send({
          error: 'kind_invalid',
          message: '投稿类型必须是 next_shot 或 next_episode',
        });
      }
      const content = typeof body?.content === 'string' ? body.content : '';
      if (content.trim().length === 0) {
        return reply
          .code(400)
          .send({ error: 'content_required', message: '投稿内容不能为空' });
      }
      if (LINK_ONLY_RE.test(content.trim())) {
        return reply
          .code(400)
          .send({ error: 'content_link_only', message: '投稿不能只有一个链接' });
      }
      const max = KIND_MAX_GRAPHEMES[kind as SubmissionKind];
      if (glen(content) > max) {
        return reply.code(400).send({
          error: 'content_too_long',
          message: `最多 ${max} 个字符`,
          max,
        });
      }

      try {
        const created = await withTransaction(pool, async (client) => {
          const target = await resolveTarget(
            client,
            kind as SubmissionKind,
            movie.id,
          );
          if (typeof target === 'string') return { error: target };
          const inserted = await client.query<{ id: string; created_at: Date }>(
            `INSERT INTO submissions
               (movie_id, kind, round_id, episode_id, user_id, content)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, created_at`,
            [movie.id, kind, target.roundId, target.episodeId, user.id, content],
          );
          const submission = inserted.rows[0];
          await armRoundAfterFirstShot(client, target.roundId, roundLengthMs);
          await enqueue(client, {
            jobType: 'submission_score',
            idempotencyKey: scoreJobKey(submission.id, movie.id),
            movieId: movie.id,
            roundId: target.auditRoundId,
            payload: { submissionId: submission.id },
          });
          await emitEvent(client, {
            type: 'submission.created',
            data: {
              movieId: movie.id,
              submissionId: submission.id,
              kind,
              roundId: target.roundId,
              episodeId: target.episodeId,
              username: user.usernameDisplay,
              content,
              createdAt: submission.created_at.toISOString(),
            },
          });
          return { submission, target };
        });
        if ('error' in created) {
          return reply.code(409).send({
            error: created.error,
            message:
              created.error === 'round_closed'
                ? '当前影片不在放映生成时段，或本轮已经截止'
                : '这部影片还没有开始轮次',
          });
        }
        return reply.code(201).send({
          id: created.submission.id,
          movieId: movie.id,
          kind,
          roundId: created.target.roundId,
          episodeId: created.target.episodeId,
          createdAt: created.submission.created_at.toISOString(),
          status: 'pending',
        });
      } catch (error) {
        if (isDuplicateSubmission(error)) {
          return reply.code(409).send({
            error: 'duplicate_submission',
            message:
              kind === 'next_shot'
                ? '本轮你已经投过稿了'
                : '本集你已经提过总纲了',
          });
        }
        throw error;
      }
    },
  );

  // --- 投票 (§4, §5.4) -------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/api/submissions/:id/vote',
    {
      bodyLimit: VOTE_BODY_LIMIT,
      onRequest: async (request, reply) => {
        if (voteCounter.record(request.ip) > voteLimit) {
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
      if (voteCounter.record(`user:${user.id}`) > voteLimit) {
        return reply
          .code(429)
          .send({ error: 'rate_limited', message: '操作过于频繁，请稍后再试' });
      }

      const raw = (request.body as { value?: unknown } | null)?.value;
      const value = typeof raw === 'number' ? raw : Number.NaN;
      // 0 revokes. §4「可改票或撤票」needs a way to say "no vote" and §16.3 has
      // only this one endpoint to say it with.
      if (value !== 1 && value !== -1 && value !== 0) {
        return reply
          .code(400)
          .send({ error: 'value_invalid', message: '投票只能是 +1、-1 或 0' });
      }
      if (!UUID_RE.test(request.params.id)) {
        return reply
          .code(404)
          .send({ error: 'submission_not_found', message: '投稿不存在' });
      }

      const result = await withTransaction(pool, async (client) => {
        // Discover the kind before taking a row lock. A next-shot vote takes
        // the clock advisory lock first, matching the clock's lock order
        // (clock -> submissions) and avoiding a vote/clock deadlock.
        const target = await client.query<{
          kind: SubmissionKind;
          round_id: string | null;
        }>('SELECT kind, round_id FROM submissions WHERE id = $1', [request.params.id]);
        if (target.rows[0] === undefined) return { error: 'submission_not_found' };
        if (target.rows[0].kind === 'next_shot' && target.rows[0].round_id !== null) {
          await client.query('SELECT pg_advisory_xact_lock($1)', [CLOCK_LOCK_KEY]);
        }

        // FOR UPDATE serialises this vote against other votes on the same pitch,
        // the scoring worker's destructive not-story decision, and the clock's
        // freeze. After the advisory lock, only one pitch can become the first
        // winner of this round.
        const found = await client.query<{
          id: string;
          movie_id: string;
          user_id: string;
          kind: SubmissionKind;
          round_id: string | null;
          votes_frozen_at: Date | null;
        }>(
          `SELECT id, movie_id, user_id, kind, round_id, votes_frozen_at
             FROM submissions WHERE id = $1 FOR UPDATE`,
          [request.params.id],
        );
        const submission = found.rows[0];
        if (submission === undefined) return { error: 'submission_not_found' };
        // §4「服务端拒绝给自己投票」(§17.27).
        if (submission.user_id === user.id) return { error: 'self_vote' };
        if (submission.votes_frozen_at !== null) return { error: 'votes_frozen' };

        if (value === 0) {
          await client.query(
            'DELETE FROM submission_votes WHERE submission_id = $1 AND user_id = $2',
            [submission.id, user.id],
          );
        } else {
          // §5.4 的主键 (submission_id, user_id) is the one-vote-per-person
          // guarantee; the upsert is how 改票 is expressed against it.
          await client.query(
            `INSERT INTO submission_votes (submission_id, user_id, value)
             VALUES ($1, $2, $3)
             ON CONFLICT (submission_id, user_id)
             DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            [submission.id, user.id, value],
          );
        }

        // §5.4「up_count/down_count 缓存列（与投票写入同事务维护）」. Recomputed
        // rather than incremented: under the row lock it costs one index scan,
        // and it cannot drift from `submission_votes` the way a delta can.
        const counts = await client.query<{ up_count: number; down_count: number }>(
          `UPDATE submissions s SET
             up_count = (SELECT count(*) FROM submission_votes v
                          WHERE v.submission_id = s.id AND v.value = 1),
             down_count = (SELECT count(*) FROM submission_votes v
                            WHERE v.submission_id = s.id AND v.value = -1)
           WHERE s.id = $1
           RETURNING up_count, down_count`,
          [submission.id],
        );

        // §16.4 `submission.votes`「计票变化，按条每 2 秒合并推送一次」. Every
        // vote emits; the 2-second merge is done by the SSE hub per submission
        // (web/routes/events.ts), because that is where consecutive changes to
        // one row can actually be collapsed into the latest counts.
        await emitEvent(client, {
          type: 'submission.votes',
          data: {
            movieId: submission.movie_id,
            submissionId: submission.id,
            upCount: counts.rows[0].up_count,
            downCount: counts.rows[0].down_count,
          },
        });

        let crowdAdopted = false;
        if (submission.kind === 'next_shot' && submission.round_id !== null) {
          const threshold = await readVoteAdoptThreshold(client, voteAdoptThreshold);
          const netVotes = counts.rows[0].up_count - counts.rows[0].down_count;
          if (netVotes >= threshold) {
            // The first pitch to reach the threshold closes the round and is
            // remembered as its crowd candidate. Qwen still has to write
            // this pitch's one score + roast before the finalizer may hand it
            // to the director; there is no second Sol selection review.
            const selected = await client.query<{
              id: string;
              round_index: string;
            }>(
              `UPDATE rounds
                  SET status = 'selecting', selected_submission_id = $2,
                      selection_mode = 'crowd', closes_at = now(), updated_at = now()
                WHERE id = $1 AND status = 'open'
                  AND (closes_at IS NULL OR closes_at > now())
                RETURNING id, round_index`,
              [submission.round_id, submission.id],
            );
            if (selected.rows[0] !== undefined) {
              crowdAdopted = true;
              await client.query(
                `UPDATE submissions SET votes_frozen_at = now()
                  WHERE round_id = $1 AND kind = 'next_shot'
                    AND votes_frozen_at IS NULL`,
                [submission.round_id],
              );
              await enqueue(client, {
                jobType: 'round_finalize',
                idempotencyKey: roundJobKey(
                  'round_finalize',
                  submission.round_id,
                  submission.movie_id,
                ),
                movieId: submission.movie_id,
                roundId: submission.round_id,
              });
              await emitEvent(client, {
                type: 'round.closed',
                data: {
                  movieId: submission.movie_id,
                  roundId: submission.round_id,
                  roundIndex: Number(selected.rows[0].round_index),
                  selectedSubmissionId: submission.id,
                  selectionMode: 'crowd',
                },
              });
              // The old countdown is now exactly zero and an unarmed successor
              // opens in the same commit to wait for its first audience shot.
              const program = await resolveScheduledProgram(client);
              if (
                program?.state === 'active' &&
                program.scheduledMovie.id === submission.movie_id &&
                (program.leaseMovieId === null ||
                  program.leaseMovieId === submission.movie_id)
              ) {
                await ensureOpenRound(client, {
                  movieId: submission.movie_id,
                });
              }
            }
          }
        }
        return { counts: counts.rows[0], crowdAdopted };
      });

      if ('error' in result) {
        if (result.error === 'submission_not_found') {
          return reply
            .code(404)
            .send({ error: 'submission_not_found', message: '投稿不存在' });
        }
        if (result.error === 'self_vote') {
          return reply
            .code(403)
            .send({ error: 'self_vote', message: '不能给自己的投稿投票' });
        }
        return reply
          .code(409)
          .send({ error: 'votes_frozen', message: '本轮计票已冻结' });
      }

      return {
        submissionId: request.params.id,
        value,
        upCount: result.counts.up_count,
        downCount: result.counts.down_count,
        crowdAdopted: result.crowdAdopted,
      };
    },
  );
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SubmissionTarget {
  roundId: string | null;
  episodeId: string;
  /** Which round the scoring run is filed under in `ai_runs` (§6.6). */
  auditRoundId: string;
}

/**
 * Where this submission belongs, locked for the duration of the transaction.
 *
 * `FOR UPDATE` on the round row is what makes「投稿属于当前 5 分钟轮次；截止后
 * 不能修改」(§4) exact at the boundary: the clock's close is an UPDATE on the
 * same row, so one of the two waits for the other. If the close wins, the
 * `status = 'open'` predicate is re-evaluated against the new row version and
 * this query returns nothing — the submission is refused rather than landing in
 * a round whose candidate set was already frozen (§5 step 2).
 *
 * A 未点火 round (`closes_at IS NULL`, §5.3) has no deadline to be past: it is
 * waiting for exactly this submission, which arms it.
 */
async function resolveTarget(
  client: PoolClient,
  kind: SubmissionKind,
  movieId: string,
): Promise<SubmissionTarget | 'round_closed' | 'no_round'> {
  const program = await resolveScheduledProgram(client);
  if (
    program === null ||
    program.state !== 'active' ||
    program.scheduledMovie.id !== movieId ||
    (program.leaseMovieId !== null && program.leaseMovieId !== movieId)
  ) {
    return 'round_closed';
  }
  if (kind === 'next_shot') {
    const open = await client.query<{ id: string; episode_id: string }>(
      `SELECT id, episode_id FROM rounds
        WHERE movie_id = $1 AND status = 'open'
          AND (closes_at IS NULL OR closes_at > now())
        ORDER BY round_index DESC
        LIMIT 1
        FOR UPDATE`,
      [movieId],
    );
    const round = open.rows[0];
    if (round === undefined) return 'round_closed';
    return {
      roundId: round.id,
      episodeId: round.episode_id,
      auditRoundId: round.id,
    };
  }

  // §4「next_episode 归属当前集的提案池」— an episode-scoped proposal, so it has
  // no round of its own (§16.1 CHECK) and survives the round boundary.
  const episode = await client.query<{ id: string }>(
    `SELECT id FROM episodes
      WHERE movie_id = $1 AND status = 'open'
      ORDER BY episode_index LIMIT 1 FOR UPDATE`,
    [movieId],
  );
  if (episode.rows[0] === undefined) return 'no_round';
  const anchor = await client.query<{ id: string }>(
    `SELECT id FROM rounds
      WHERE movie_id = $1 ORDER BY round_index DESC LIMIT 1`,
    [movieId],
  );
  if (anchor.rows[0] === undefined) return 'no_round';
  return {
    roundId: null,
    episodeId: episode.rows[0].id,
    auditRoundId: anchor.rows[0].id,
  };
}

/**
 * Start the voting window exactly once, in the same transaction that stores
 * its first human next-shot submission. A next-episode proposal has no round
 * and later shots find an existing deadline, so neither can move the boundary.
 */
async function armRoundAfterFirstShot(
  client: PoolClient,
  roundId: string | null,
  roundLengthMs: number,
): Promise<void> {
  if (roundId === null) return;
  await client.query(
    `UPDATE rounds
        SET closes_at = now() + make_interval(secs => $2::double precision / 1000),
            updated_at = now()
      WHERE id = $1 AND closes_at IS NULL`,
    [roundId, roundLengthMs],
  );
}
