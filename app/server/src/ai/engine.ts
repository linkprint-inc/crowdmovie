// `ContentEngine` — the one seam between the code state machine and the model.
//
// §6.7 is the rule this interface encodes: Sol is a *content function*, never a
// scheduler. Every method takes the context the worker assembled out of
// PostgreSQL and returns one JSON document. It cannot enqueue a job, advance a
// round, decide a retry or touch the database — those all belong to §5's state
// machine, which lives in `jobs/handlers/*` and `jobs/scheduler.ts`.
//
// Two implementations are planned: `stub.ts` (M3, deterministic, no quota) and
// `codex.ts` (M4, real `gpt-5.6-sol`). Both outputs go through the same
// validators in `validate.ts` before anything is written, so a stub that drifts
// from the schema fails the same way a hallucinating model would.
//
// Field names are camelCase here and snake_case on the wire (§6.3/§6.5/§9.2
// show the JSON); M4's adapter owns that mapping, not the handlers.

/** The four site languages (§9.2). Order is fixed so validation messages are. */
import type { FilmPlan, FilmPromptAudit, FilmState } from './film-plan.js';
import type { FilmObservation, FilmObservationRecord, ObserveFilmInput } from './film-observation.js';

export const LOCALES = ['en', 'zh-CN', 'ja', 'es'] as const;
export type Locale = (typeof LOCALES)[number];

/** A string in all four languages — 毒舌评论 and subtitle cue text. */
export type LocalizedText = Record<Locale, string>;

export type SubmissionKind = 'next_shot' | 'next_episode';

/** §6.3 的五个评分维度，满分 30/25/20/15/10。 */
export interface ScoreBreakdown {
  continuity: number;
  filmability15s: number;
  characterConsistency: number;
  dramaticValue: number;
  originality: number;
}

/**
 * One already-published scene, as the model sees it. §6.5 hands the director the
 * current episode's last three; scoring gets the same list so continuity can
 * be judged without paying to replay the entire movie on every quick score.
 */
export interface SceneContext {
  sceneIndex: number;
  summaryZh: string;
  durationSeconds: number;
}

export interface EndFrame {
  image: string;
  sha256: string;
}

/** Full last-published-shot context used to choose stateless vs latent continuation. */
export interface PreviousScene extends SceneContext {
  filmObservation?: FilmObservationRecord;
  filmPlan?: FilmPlan;
  filmPromptAudit?: FilmPromptAudit;
  /** Only set from a recorded media observation, never from the director's prediction. */
  observedEndState?: FilmState;
  h3PromptEn: string;
  continuityUpdates: string[];
  endFrame: EndFrame | null;
  /** Opaque ID for the immediately previous published H3 AV latent. */
  motionContextId: string | null;
}

// --- 每条投稿的初评 (§6.3) ---------------------------------------------------

export interface ScoreSubmissionInput {
  submissionId: string;
  kind: SubmissionKind;
  /**
   * 用户原文。§6.3「投稿正文只作为带明确边界的 JSON 数据字段传入，不得拼接成
   * system/developer 指令」— untrusted data, never instructions.
   */
  content: string;
  episodeTitle: string;
  episodeTheme: string;
  recentScenes: SceneContext[];
}

export interface ScoreSubmissionOutput {
  submissionId: string;
  /** False for 违规 / 注入 / 无法作为剧情 — still scored, at 0 (§6.3). */
  eligible: boolean;
  scoreTotal: number;
  scoreBreakdown: ScoreBreakdown;
  /** 内部审计与终审输入，不对外 (§6.3 公开策略). */
  reason: string;
  /** 四语毒舌评论，与 scoreTotal 一起公开. */
  publicRoast: LocalizedText;
  /** 内部，不对外. */
  riskFlags: string[];
  rubricVersion: string;
}

// --- Top-K 终审 (§6.4) -------------------------------------------------------

export interface FinalizeCandidate {
  submissionId: string;
  content: string;
  authorUsername: string;
  scoreTotal: number;
  scoreBreakdown: ScoreBreakdown;
  reason: string;
}

export interface FinalizeRoundInput {
  roundId: string;
  /** Already cut to K and ordered by the backend (§6.4); the model re-scores. */
  candidates: FinalizeCandidate[];
  episodeTitle: string;
  episodeTheme: string;
  recentScenes: SceneContext[];
}

export interface RankedCandidate {
  submissionId: string;
  finalScore: number;
  rank: number;
  reason: string;
}

export interface FinalizeRoundOutput {
  roundId: string;
  rankedCandidates: RankedCandidate[];
  /**
   * The model's pick. Advisory: §6.4「选择逻辑由后端执行，不能让模型自由改变
   * 规则」— the backend recomputes the winner from `finalScore` plus the
   * documented tie-breaks and only uses this to detect disagreement.
   */
  selectedSubmissionId: string;
  rubricVersion: string;
}

// --- 台词与导演包 (§6.5) -----------------------------------------------------

export interface DialogueLine {
  speaker: string;
  startSeconds: number;
  endSeconds: number;
  line: string;
}

/** §6.5「shot_relation 只允许 continuous_event 或 new_shot」. */
export type ShotRelation = 'continuous_event' | 'new_shot';

export interface ComfyWorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
}

/** The ComfyUI API workflow Sol writes in full (§6.5). Validated, never patched. */
export interface ComfyWorkflow {
  prompt: Record<string, ComfyWorkflowNode>;
}

export interface DirectSceneInput {
  previousChapter?: PreviousScene | null;
  roundId: string;
  episodeIndex: number;
  episodeTitle: string;
  episodeTheme: string;
  /** null is accepted only when reading or replaying a legacy auto round. */
  selectedSubmission: {
    id: string;
    content: string;
    authorUsername: string;
  } | null;
  /** crowd | ai | auto — the director credits the contributor unless `auto`. */
  selectionMode: SelectionMode;
  recentScenes: SceneContext[];
  /** Last published scene in this episode, or null for a new episode. */
  previousScene: PreviousScene | null;
  /** Versioned, server-fetched 8191 capability document (§8.2). */
  h3Capabilities?: unknown;
  /** Structured gateway rejection for the bounded workflow-rewrite path. */
  workflowRepair?: {
    previousOutput: DirectSceneOutput;
    error: { code: string; message: string; details?: unknown };
  };
}

export interface DirectSceneOutput {
  filmPlanReview?: { planSha256: string; model: string; checks: Record<string, boolean>; issues: string[]; usage: unknown };
  filmPlan?: FilmPlan;
  filmPromptAudit?: FilmPromptAudit;
  selectedSubmissionId: string | null;
  /** 署名；历史自动续写运行可为 null。 */
  creditUsername: string | null;
  sceneSummaryZh: string;
  /** Sol chooses 5–15s from the beat's actual needs; there is no fixed default. */
  durationSeconds: number;
  continuityFromPrevious: string;
  shotRelation: ShotRelation;
  /** Controlled I2VA: previous published tail becomes this shot's first frame. */
  usePreviousEndFrame: boolean;
  /** Retained for wire compatibility; production v5 requires false. */
  useMotionContext: boolean;
  /** Official H3 T2VA/I2VA prompt; speech is isolated in exact `<d>` blocks. */
  h3PromptEn: string;
  /** 所有角色台词固定英语 (§17.12). Also the planned subtitle timeline (§9.1). */
  dialogueEn: DialogueLine[];
  continuityUpdates: string[];
  episodeShouldEnd: boolean;
  /** Non-empty exactly when `episodeShouldEnd` (§6.5). */
  episodeEndReason: string | null;
  comfyuiWorkflow: ComfyWorkflow;
  comfyuiCapabilitiesVersion: string;
  directorSchemaVersion: string;
}

// --- 已退役的 AI 自动编剧兼容接口 --------------------------------------

export interface WriteAutomaticShotInput {
  previousChapter?: PreviousScene | null;
  previousScene?: PreviousScene | null;
  roundId: string;
  episodeIndex: number;
  episodeTitle: string;
  /** The current episode-level outline, not a shot script. */
  episodeOutline: string;
  /** Every published shot in this episode, oldest first. */
  previousScenes: SceneContext[];
}

export interface WriteAutomaticShotOutput {
  /** Public AI Director pitch for an enabled movie's empty automatic round. */
  content: string;
}

// --- 四语字幕定稿 (§9.2) -----------------------------------------------------

export interface SubtitleCue {
  cueId: string;
  speaker: string;
  startSeconds: number;
  endSeconds: number;
  /** All four locales, non-empty; one shared timeline (§9.2). */
  text: LocalizedText;
}

export interface AuthorSubtitlesInput {
  /** dialogueEn now contains the measured transcript, never planned speech. */
  audioSource?: { version: 'film-asr-v1'; videoSha256: string };
  roundId: string;
  /** ffprobe 实测时长 — the final boundary for every cue (§9.1 step 3). */
  actualDurationSeconds: number;
  dialogueEn: DialogueLine[];
  sceneSummaryZh: string;
}

export interface AuthorSubtitlesOutput {
  /** Must be `en` (§9.2). */
  audioLanguage: 'en';
  actualDurationSeconds: number;
  cues: SubtitleCue[];
  subtitleSchemaVersion: string;
}

// --- 新集主题自拟 (§5.4 step 2) ----------------------------------------------

export interface ProposeEpisodeThemeInput {
  episodeIndex: number;
  previousTheme: string | null;
  recentScenes: SceneContext[];
}

export interface ProposeEpisodeThemeOutput {
  title: string;
  theme: string;
}

// --- 轮次选择模式 (§16.1 rounds.selection_mode) ------------------------------

export const SELECTION_MODES = ['crowd', 'ai', 'auto'] as const;
export type SelectionMode = (typeof SELECTION_MODES)[number];

/**
 * What actually produced the content, for `ai_runs.provider` / `.model` (§6.6).
 * The audit table has to say `stub` when a stub ran: a ledger that claims every
 * M3 scene came from `gpt-5.6-sol` is worse than no ledger at all.
 *
 * `reasoning_effort` is deliberately *not* here — §6 fixes it per pipeline step
 * (`high` for fast scoring, `xhigh` for final/director/subtitles), so it
 * describes the step, not whoever is answering.
 */
export interface EngineIdentity {
  provider: string;
  model: string;
}

/** Per-call audit facts carried without changing the content JSON contract. */
export interface EngineRunMetadata {
  threadId: string | null;
  usage: unknown;
  /** Exact provider/model used for this call when an engine routes by task. */
  identity?: EngineIdentity;
  /** Exact effort used for this call; kept beside the routed model for audit. */
  reasoningEffort?: 'none' | 'low' | 'high' | 'xhigh';
  /** Includes the initial turn plus any bounded same-thread repairs. */
  attempts?: number;
}

const ENGINE_RUN_METADATA = Symbol('crowdmovie.engineRunMetadata');

export function attachEngineRunMetadata<T extends object>(
  output: T,
  metadata: EngineRunMetadata,
): T {
  Object.defineProperty(output, ENGINE_RUN_METADATA, {
    value: metadata,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return output;
}

export function getEngineRunMetadata(
  output: object,
): EngineRunMetadata | undefined {
  return (output as Record<symbol, EngineRunMetadata | undefined>)[
    ENGINE_RUN_METADATA
  ];
}

/**
 * The content functions the round engine calls. Nothing here returns a
 * decision about *flow* — only content for the state machine to validate, store
 * and act on.
 */
export interface ContentEngine {
  readonly identity: EngineIdentity;
  scoreSubmission(input: ScoreSubmissionInput): Promise<ScoreSubmissionOutput>;
  finalizeRound(input: FinalizeRoundInput): Promise<FinalizeRoundOutput>;
  writeAutomaticShot(
    input: WriteAutomaticShotInput,
  ): Promise<WriteAutomaticShotOutput>;
  directScene(input: DirectSceneInput): Promise<DirectSceneOutput>;
  authorSubtitles(input: AuthorSubtitlesInput): Promise<AuthorSubtitlesOutput>;
  observeFilm?(input: ObserveFilmInput): Promise<FilmObservation>;
  proposeEpisodeTheme(
    input: ProposeEpisodeThemeInput,
  ): Promise<ProposeEpisodeThemeOutput>;
}
