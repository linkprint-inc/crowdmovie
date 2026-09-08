// Shared plumbing for the §5 job handlers: what a handler is given, what it may
// answer, the round/episode/scene reads they all need, and the one place that
// writes `ai_runs` (§6.6).
//
// Persistence note: `ai_runs.output_json` and `submission_scores.score_breakdown`
// store the *validated internal* form of an engine's answer — camelCase, exactly
// the objects in `ai/engine.ts`. §6.3/§6.5/§9.2 print the model's snake_case
// wire JSON; mapping that wire shape onto these types belongs to M4's
// `ai/codex.ts`, at the boundary, so that everything downstream of validation
// speaks one vocabulary.
import crypto from 'node:crypto';
import type { FilmPlan, FilmPromptAudit, FilmState } from '../../ai/film-plan.js';
import type { FilmObservationRecord } from '../../ai/film-observation.js';

import type { Pool, PoolClient } from 'pg';

import {
  getEngineRunMetadata,
  type ContentEngine,
  type PreviousScene,
  type SceneContext,
  type SelectionMode,
} from '../../ai/engine.js';
import type { StoryReviewer } from '../../ai/story-review.js';
import type { H3GatewayClient } from '../../h3/gateway.js';
import type { Job, Queryable } from '../ledger.js';

/** §6.5「最近 3 个已发布片段」— the context window every content call gets. */
export const RECENT_SCENE_COUNT = 3;

/**
 * §6.6 `run_type`. `scene_subtitles` is **not** in the §6.6 list, which stops at
 * `submission_score | round_final | scene_director | generation_event` — but
 * §16.1 makes `scenes.subtitle_ai_run_id` a NOT NULL reference into `ai_runs`,
 * so a subtitle run has to exist there and needs a name. Reported as a spec gap;
 * the column has no CHECK constraint, so adding the value costs nothing.
 */
export type AiRunType =
  | 'submission_score'
  | 'round_final'
  | 'scene_director'
  | 'scene_subtitles'
  | 'film_observation'
  | 'generation_event';
// A film observation stores actual frame evidence separately from planned state.

/** Audit fallback when a test/stub output carries no per-call metadata. */
export const RUN_EFFORT: Record<AiRunType, 'none' | 'high' | 'xhigh'> = {
  film_observation: 'none',
  submission_score: 'none',
  round_final: 'xhigh',
  scene_director: 'none',
  scene_subtitles: 'none',
  generation_event: 'xhigh',
};

export interface WorkerLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export interface RoundEngineSettings {
  /** §6.4 `CROWD_AI_MOVIE_FINAL_TOP_K`. */
  topK: number;
  /** §5.4 民选直采净赞阈值. */
  voteAdoptThreshold: number;
  /** Server-owned countdown for every successor round in the AI writing loop. */
  roundLengthMs: number;
  /** How long a deferred job waits before the worker looks again. */
  deferDelayMs: number;
  /** `MEDIA_DIR` — where the publish gate looks for a scene's files (§5 step 5). */
  mediaDir: string;
  /** Delayed one-shot H3 status poll; the worker never sleeps on a GPU job. */
  h3PollIntervalMs: number;
  /** Structured workflow rewrites allowed after a gateway 400. */
  h3WorkflowRepairRetries: number;
}

export interface HandlerContext {
  pool: Pool;
  engine: ContentEngine;
  /** 故事设定送审用的接缝；只有 `story_review` 处理器会碰它。 */
  reviewer?: StoryReviewer;
  h3?: H3GatewayClient;
  job: Job;
  settings: RoundEngineSettings;
  log: WorkerLogger;
}

/**
 * `done` completes the job. `defer` puts it back without spending an attempt —
 * for the two legitimate "not yet" cases in §5 (scores still landing, previous
 * round still generating), never for an error.
 */
export type HandlerOutcome =
  | { kind: 'done'; note?: string }
  | { kind: 'defer'; delayMs?: number; reason: string };

export type Handler = (context: HandlerContext) => Promise<HandlerOutcome>;

// --- 轮次与集的读取 -----------------------------------------------------------

export interface RoundRow {
  id: string;
  movie_id: string;
  /**
   * `rounds.round_index` is BIGINT, and node-postgres hands BIGINT back as a
   * string rather than risk a lossy Number. Kept as a string all the way into
   * the comparison below, so nothing has to decide when to convert.
   */
  round_index: string;
  episode_id: string;
  status: string;
  selected_submission_id: string | null;
  selection_mode: SelectionMode | null;
}

export interface EpisodeRow {
  id: string;
  movie_id: string;
  episode_index: number;
  title: string;
  theme: string;
}

/** §5「只有视频达到 published 状态后，相关剧情才能写入正式世界观」. */
export const TERMINAL_ROUND_STATUSES = [
  'published',
  'select_failed',
  'generation_failed',
  'validation_failed',
] as const;

/** Which failure state a dead job of each type leaves its round in (§5). */
export const JOB_FAILURE_STATUS: Record<string, string> = {
  round_finalize: 'select_failed',
  ai_screenwriter: 'select_failed',
  scene_director: 'generation_failed',
  video_generate: 'generation_failed',
  subtitle_author: 'generation_failed',
  media_validate_publish: 'validation_failed',
};

export async function loadRound(
  db: Queryable,
  roundId: string,
): Promise<RoundRow | null> {
  const result = await db.query<RoundRow>(
    `SELECT id, movie_id, round_index, episode_id, status, selected_submission_id, selection_mode
       FROM rounds WHERE id = $1`,
    [roundId],
  );
  return result.rows[0] ?? null;
}

export async function loadEpisode(
  db: Queryable,
  episodeId: string,
): Promise<EpisodeRow> {
  const result = await db.query<EpisodeRow>(
    'SELECT id, movie_id, episode_index, title, theme FROM episodes WHERE id = $1',
    [episodeId],
  );
  if (result.rows[0] === undefined) {
    throw new Error(`episode ${episodeId} is missing`);
  }
  return result.rows[0];
}

/** The current episode's last published scenes, oldest first (§6.5). */
export async function loadRecentScenes(
  db: Queryable,
  movieId: string,
  episodeId: string,
): Promise<SceneContext[]> {
  const result = await db.query<{
    scene_index: number;
    summary_zh: string;
    duration_seconds: string;
  }>(
    `SELECT scene_index, summary_zh, duration_seconds FROM scenes
      WHERE movie_id = $1 AND episode_id = $2
      ORDER BY scene_index DESC LIMIT $3`,
    [movieId, episodeId, RECENT_SCENE_COUNT],
  );
  return result.rows
    .map((row) => ({
      sceneIndex: row.scene_index,
      summaryZh: row.summary_zh,
      // NUMERIC comes back as a string from node-postgres; parsing here keeps
      // the engine input typed as the number the spec describes.
      durationSeconds: Number(row.duration_seconds),
    }))
    .reverse();
}

/** Every published shot in one episode, oldest first, for AI continuity. */
export async function loadEpisodeScenes(
  db: Queryable,
  movieId: string,
  episodeId: string,
): Promise<SceneContext[]> {
  const result = await db.query<{
    scene_index: number;
    summary_zh: string;
    duration_seconds: string;
  }>(
    `SELECT scene_index, summary_zh, duration_seconds FROM scenes
      WHERE movie_id = $1 AND episode_id = $2
      ORDER BY scene_index ASC`,
    [movieId, episodeId],
  );
  return result.rows.map((row) => ({
    sceneIndex: row.scene_index,
    summaryZh: row.summary_zh,
    durationSeconds: Number(row.duration_seconds),
  }));
}

/** Last published scene in this episode, including legacy end-frame metadata. */
export async function loadPreviousScene(
  db: Queryable,
  movieId: string,
  episodeId: string | null,
): Promise<PreviousScene | null> {
  const result = await db.query<{
    scene_index: number;
    summary_zh: string;
    duration_seconds: string;
    h3_prompt_en: unknown;
    continuity_updates: unknown;
    end_frame: unknown;
    motion_context: unknown;
    film_plan: FilmPlan | null;
    film_prompt_audit: FilmPromptAudit | null;
    observed_end_state: FilmState | null;
    film_observation: FilmObservationRecord | null;
  }>(
    `SELECT s.scene_index, s.summary_zh, s.duration_seconds,
            a.output_json ->> 'h3PromptEn' AS h3_prompt_en,
            a.output_json -> 'continuityUpdates' AS continuity_updates,
            a.output_json -> 'filmPlan' AS film_plan,
            a.output_json -> 'filmPromptAudit' AS film_prompt_audit,
            s.media -> 'film_observation' -> 'acceptedEndState' AS observed_end_state,
            s.media -> 'film_observation' AS film_observation,
            s.media -> 'end_frame' AS end_frame,
            s.media -> 'motion_context' AS motion_context
       FROM scenes s
       JOIN ai_runs a ON a.id = s.director_ai_run_id
      WHERE s.movie_id = $1 AND ($2::uuid IS NULL OR s.episode_id = $2) AND s.takedown_at IS NULL
      ORDER BY s.scene_index DESC
      LIMIT 1`,
    [movieId, episodeId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const continuityUpdates = Array.isArray(row.continuity_updates)
    ? row.continuity_updates.filter(
        (value): value is string => typeof value === 'string',
      )
    : [];
  const rawEndFrame = row.end_frame;
  const endFrame =
    rawEndFrame !== null &&
    typeof rawEndFrame === 'object' &&
    !Array.isArray(rawEndFrame) &&
    typeof (rawEndFrame as Record<string, unknown>).image === 'string' &&
    /^[0-9a-f]{64}$/.test(
      String((rawEndFrame as Record<string, unknown>).sha256 ?? ''),
    )
      ? {
          image: (rawEndFrame as Record<string, unknown>).image as string,
          sha256: (rawEndFrame as Record<string, unknown>).sha256 as string,
        }
      : null;
  const rawMotionContext = row.motion_context;
  const motionContextId =
    rawMotionContext !== null &&
    typeof rawMotionContext === 'object' &&
    !Array.isArray(rawMotionContext) &&
    (rawMotionContext as Record<string, unknown>).plugin_version === '0.5.1' &&
    typeof (rawMotionContext as Record<string, unknown>).id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      (rawMotionContext as Record<string, unknown>).id as string,
    )
      ? ((rawMotionContext as Record<string, unknown>).id as string)
      : null;
  return {
    sceneIndex: row.scene_index,
    summaryZh: row.summary_zh,
    durationSeconds: Number(row.duration_seconds),
    h3PromptEn: typeof row.h3_prompt_en === 'string' ? row.h3_prompt_en : '',
    continuityUpdates,
    endFrame,
    motionContextId,
    ...(row.film_plan ? { filmPlan: row.film_plan } : {}),
    ...(row.film_prompt_audit ? { filmPromptAudit: row.film_prompt_audit } : {}),
    ...(row.observed_end_state ? { observedEndState: row.observed_end_state } : {}),
    ...(row.film_observation ? { filmObservation: row.film_observation } : {}),
  };
}

/**
 * §5「上一段正式发布后，下一段才能进入最终选择和拍摄流程」— true while an
 * earlier round is still anywhere between `selecting` and `validating`.
 * Submissions keep flowing into the open round; only the dependent generation
 * pipeline waits.
 */
export async function hasUnfinishedEarlierRound(
  db: Queryable,
  movieId: string,
  roundIndex: string,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM rounds
      WHERE movie_id = $1
        AND round_index < $2::bigint
        AND status <> 'open'
        AND status <> ALL($3::text[])
      LIMIT 1`,
    [movieId, roundIndex, [...TERMINAL_ROUND_STATUSES]],
  );
  return result.rowCount !== 0;
}

// --- ai_runs (§6.6) ----------------------------------------------------------

export interface AiRunSpec {
  roundId: string;
  submissionId?: string | null;
  runType: AiRunType;
  input: unknown;
  output: unknown;
  /**
   * Optional redacted audit values. Runtime metadata is still read from
   * `output`, but these values are what reach PostgreSQL. Used when the
   * business result is a hard deletion and retaining user prose would defeat
   * that deletion.
   */
  storedInput?: unknown;
  storedOutput?: unknown;
  latencyMs: number;
  promptPlanVersion?: string | null;
}

export interface FailedAiRunSpec {
  roundId: string;
  submissionId?: string | null;
  runType: AiRunType;
  input: unknown;
  provider: string;
  model: string;
  reasoningEffort: 'none' | 'low' | 'high' | 'xhigh';
  threadId: string | null;
  usage: unknown;
  latencyMs: number;
  status: 'retryable_failed' | 'dead';
  errorCode: string;
  errorSummary: string;
}

/**
 * Record one model call. §6.6「仅有 Codex thread 历史或终端输出都不算成功」— the
 * row is written in the same transaction as the result it produced, so an audit
 * trail and a published fact cannot disagree.
 */
export async function insertAiRun(
  client: PoolClient,
  engine: ContentEngine,
  spec: AiRunSpec,
): Promise<string> {
  const metadata =
    spec.output !== null && typeof spec.output === 'object'
      ? getEngineRunMetadata(spec.output)
      : undefined;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO ai_runs
       (movie_id, round_id, submission_id, run_type, provider, model, reasoning_effort,
        codex_thread_id, prompt_plan_version, input_sha256, output_json,
        usage_json, latency_ms, status, finished_at)
     SELECT r.movie_id, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
            $11::jsonb, $12,
            'succeeded', now()
       FROM rounds r WHERE r.id = $1
     RETURNING id`,
    [
      spec.roundId,
      spec.submissionId ?? null,
      spec.runType,
      metadata?.identity?.provider ?? engine.identity.provider,
      metadata?.identity?.model ?? engine.identity.model,
      metadata?.reasoningEffort ?? RUN_EFFORT[spec.runType],
      metadata?.threadId ?? null,
      spec.promptPlanVersion ?? null,
      crypto
        .createHash('sha256')
        .update(JSON.stringify(spec.storedInput ?? spec.input))
        .digest('hex'),
      JSON.stringify(spec.storedOutput ?? spec.output),
      metadata?.usage === undefined ? null : JSON.stringify(metadata.usage),
      spec.latencyMs,
    ],
  );
  return inserted.rows[0].id;
}

/** Persist a terminal Codex attempt even though it produced no usable output. */
export async function insertFailedAiRun(
  db: Queryable,
  engine: ContentEngine,
  spec: FailedAiRunSpec,
): Promise<void> {
  await db.query(
    `INSERT INTO ai_runs
       (movie_id, round_id, submission_id, run_type, provider, model, reasoning_effort,
        codex_thread_id, input_sha256, output_json, usage_json, latency_ms,
        status, error_code, error_summary, finished_at)
     SELECT r.movie_id, $1, $2, $3, $4, $5, $6, $7, $8, NULL, $9::jsonb,
            $10, $11, $12, $13, now()
       FROM rounds r WHERE r.id = $1`,
    [
      spec.roundId,
      spec.submissionId ?? null,
      spec.runType,
      spec.provider,
      spec.model,
      spec.reasoningEffort,
      spec.threadId,
      crypto.createHash('sha256').update(JSON.stringify(spec.input)).digest('hex'),
      spec.usage === null ? null : JSON.stringify(spec.usage),
      spec.latencyMs,
      spec.status,
      spec.errorCode,
      spec.errorSummary.slice(0, 2000),
    ],
  );
}

/** Time an engine call so `ai_runs.latency_ms` is measured, not guessed. */
export async function timed<T>(
  run: () => Promise<T>,
): Promise<{ value: T; latencyMs: number }> {
  const started = Date.now();
  const value = await run();
  return { value, latencyMs: Date.now() - started };
}

export function requirePayload<T extends object>(job: Job, keys: (keyof T)[]): T {
  const payload = job.payload as T | null;
  if (payload === null || typeof payload !== 'object') {
    throw new Error(`${job.jobType} job ${job.id} has no payload`);
  }
  for (const key of keys) {
    if (payload[key] === undefined || payload[key] === null) {
      throw new Error(
        `${job.jobType} job ${job.id} payload is missing ${String(key)}`,
      );
    }
  }
  return payload;
}

export function requireRoundId(job: Job): string {
  if (job.roundId === null) {
    throw new Error(`${job.jobType} job ${job.id} has no round_id`);
  }
  return job.roundId;
}
