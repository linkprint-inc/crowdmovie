// Deterministic `ContentEngine` stub (M3). No model, no quota, no clock, no
// randomness: the same input always produces the same output, so the round
// engine's tests assert on exact values instead of on "something happened".
//
// It is deliberately, visibly fake — every string says STUB — but it is
// structurally valid, and its output goes through the same `validate.ts` the
// real Codex engine's will (M4). A stub that could not pass validation would
// make the tests prove nothing about the real path.
//
// Steering: scores are a pure function of the submission text, so a test can
// choose which submission wins by choosing what it writes. When a test needs a
// specific shape instead (ineligible, `episodeShouldEnd`, a malformed package to
// prove validation bites), it passes an override — see `StubEngineOptions`.
import {
  type AuthorSubtitlesInput,
  type AuthorSubtitlesOutput,
  type ContentEngine,
  type DirectSceneInput,
  type DirectSceneOutput,
  type FinalizeRoundInput,
  type FinalizeRoundOutput,
  type LocalizedText,
  type ProposeEpisodeThemeInput,
  type ProposeEpisodeThemeOutput,
  type ScoreSubmissionInput,
  type ScoreSubmissionOutput,
  type SubtitleCue,
  type WriteAutomaticShotInput,
  type WriteAutomaticShotOutput,
} from './engine.js';
import { SCORE_DIMENSION_MAX } from './validate.js';

export const STUB_RUBRIC_VERSION = 'stub-submission-score-v1';
export const STUB_FINAL_RUBRIC_VERSION = 'stub-round-final-v1';
export const STUB_DIRECTOR_SCHEMA_VERSION = 'stub-scene-director-v1';
export const STUB_SUBTITLE_SCHEMA_VERSION = 'stub-scene-subtitles-v1';
export const STUB_CAPABILITIES_VERSION = 'stub-h3-capabilities-v1';

/** FNV-1a over the UTF-16 code units — small, dependency-free and stable. */
function hash(seed: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    value ^= seed.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

/** A stable integer in `0..max` derived from `seed` and `salt`. */
function derive(seed: string, salt: string, max: number): number {
  return hash(`${salt}:${seed}`) % (max + 1);
}

function roast(prefix: string): LocalizedText {
  return {
    en: `STUB roast: ${prefix}`,
    'zh-CN': `STUB 毒舌：${prefix}`,
    ja: `STUB 辛口：${prefix}`,
    es: `STUB burla: ${prefix}`,
  };
}

/**
 * Per-method output rewriting. Each override receives the input and the stub's
 * own answer, so a test that only cares about `eligible` writes
 * `{ ...base, eligible: false, scoreTotal: 0, ... }` instead of a whole document.
 */
export interface StubEngineOptions {
  scoreSubmission?: Override<ScoreSubmissionInput, ScoreSubmissionOutput>;
  finalizeRound?: Override<FinalizeRoundInput, FinalizeRoundOutput>;
  writeAutomaticShot?: Override<
    WriteAutomaticShotInput,
    WriteAutomaticShotOutput
  >;
  directScene?: Override<DirectSceneInput, DirectSceneOutput>;
  authorSubtitles?: Override<AuthorSubtitlesInput, AuthorSubtitlesOutput>;
  proposeEpisodeTheme?: Override<
    ProposeEpisodeThemeInput,
    ProposeEpisodeThemeOutput
  >;
}

/**
 * May be async, and may never resolve: that is how the crash-recovery tests
 * hold a worker inside a handler while they kill it.
 */
type Override<TInput, TOutput> = (
  input: TInput,
  base: TOutput,
) => TOutput | Promise<TOutput>;

/** The stub's fixed 12-second shot; well inside §17.11 的 15 秒上限。 */
const STUB_DURATION_SECONDS = 12;

function stubScore(input: ScoreSubmissionInput): ScoreSubmissionOutput {
  const seed = input.content;
  const scoreBreakdown = {
    continuity: derive(seed, 'continuity', SCORE_DIMENSION_MAX.continuity),
    filmability15s: derive(seed, 'film', SCORE_DIMENSION_MAX.filmability15s),
    characterConsistency: derive(
      seed,
      'character',
      SCORE_DIMENSION_MAX.characterConsistency,
    ),
    dramaticValue: derive(seed, 'drama', SCORE_DIMENSION_MAX.dramaticValue),
    originality: derive(seed, 'original', SCORE_DIMENSION_MAX.originality),
  };
  const scoreTotal = Object.values(scoreBreakdown).reduce((a, b) => a + b, 0);

  return {
    submissionId: input.submissionId,
    eligible: true,
    scoreTotal,
    scoreBreakdown,
    reason: `STUB reason for ${input.submissionId}`,
    publicRoast: roast(`${scoreTotal}/100`),
    riskFlags: [],
    rubricVersion: STUB_RUBRIC_VERSION,
  };
}

function stubFinalize(input: FinalizeRoundInput): FinalizeRoundOutput {
  // Re-score independently of the initial pass, the way a real 终审 does, but
  // keep the initial total as the dominant term so a test that steers scoring
  // also steers the winner.
  const ranked = input.candidates
    .map((candidate) => ({
      submissionId: candidate.submissionId,
      finalScore: candidate.scoreTotal,
      rank: 0,
      reason: `STUB final reason for ${candidate.submissionId}`,
    }))
    .sort(
      (a, b) =>
        b.finalScore - a.finalScore || a.submissionId.localeCompare(b.submissionId),
    )
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));

  return {
    roundId: input.roundId,
    rankedCandidates: ranked,
    selectedSubmissionId: ranked[0].submissionId,
    rubricVersion: STUB_FINAL_RUBRIC_VERSION,
  };
}

function stubAutomaticShot(
  input: WriteAutomaticShotInput,
): WriteAutomaticShotOutput {
  return {
    content: `STUB AI Director 第 ${input.previousScenes.length + 1} 个镜头：一个可在 5–15 秒内拍完的具体动作。`,
  };
}

function stubDirect(input: DirectSceneInput): DirectSceneOutput {
  const selected = input.selectedSubmission;
  return {
    selectedSubmissionId: selected?.id ?? null,
    creditUsername: selected === null ? null : selected.authorUsername,
    sceneSummaryZh: `STUB 片段摘要（第 ${input.episodeIndex} 集，${input.selectionMode}）`,
    durationSeconds: STUB_DURATION_SECONDS,
    continuityFromPrevious: 'STUB continuity note',
    // §17.15：默认不使用上一片段结尾帧。
    shotRelation: 'new_shot',
    usePreviousEndFrame: false,
    useMotionContext: false,
    h3PromptEn: `STUB H3 prompt for round ${input.roundId}`,
    dialogueEn: [
      {
        speaker: 'StubOne',
        startSeconds: 3,
        endSeconds: 5,
        line: 'STUB line one.',
      },
      {
        speaker: 'StubTwo',
        startSeconds: 5.5,
        endSeconds: 8,
        line: 'STUB line two.',
      },
    ],
    continuityUpdates: ['STUB continuity update'],
    // 分集由 T3.3 驱动；测试用 override 让它变 true。
    episodeShouldEnd: false,
    episodeEndReason: null,
    comfyuiWorkflow: {
      prompt: {
        '1': {
          class_type: 'StubH3Sampler',
          inputs: { prompt: 'STUB', seconds: STUB_DURATION_SECONDS },
        },
      },
    },
    comfyuiCapabilitiesVersion: STUB_CAPABILITIES_VERSION,
    directorSchemaVersion: STUB_DIRECTOR_SCHEMA_VERSION,
  };
}

function stubSubtitles(input: AuthorSubtitlesInput): AuthorSubtitlesOutput {
  const duration = input.actualDurationSeconds;
  const cues: SubtitleCue[] = [];
  for (const [index, line] of input.dialogueEn.entries()) {
    // The real MP4 may be shorter than the plan; §9.1 makes the measured
    // duration the final boundary, so a line past the end is dropped rather
    // than allowed to point outside the video.
    if (line.startSeconds >= duration) continue;
    cues.push({
      cueId: `stub-line-${String(index + 1).padStart(3, '0')}`,
      speaker: line.speaker,
      startSeconds: line.startSeconds,
      endSeconds: Math.min(line.endSeconds, duration),
      text: {
        en: line.line,
        'zh-CN': `STUB 字幕：${line.line}`,
        ja: `STUB 字幕：${line.line}`,
        es: `STUB subtítulo: ${line.line}`,
      },
    });
  }

  return {
    audioLanguage: 'en',
    actualDurationSeconds: duration,
    cues,
    subtitleSchemaVersion: STUB_SUBTITLE_SCHEMA_VERSION,
  };
}

function stubTheme(input: ProposeEpisodeThemeInput): ProposeEpisodeThemeOutput {
  return {
    title: `STUB 第 ${input.episodeIndex} 集`,
    theme: `STUB 本集设定（第 ${input.episodeIndex} 集）`,
  };
}

/** §6.6 audit identity. It says `stub` because a stub is what ran. */
export const STUB_IDENTITY = {
  provider: 'stub',
  model: 'stub-content-engine',
} as const;

export function createStubEngine(
  options: StubEngineOptions = {},
): ContentEngine {
  return {
    identity: STUB_IDENTITY,
    scoreSubmission: async (input) => {
      const base = stubScore(input);
      return options.scoreSubmission?.(input, base) ?? base;
    },
    finalizeRound: async (input) => {
      const base = stubFinalize(input);
      return options.finalizeRound?.(input, base) ?? base;
    },
    writeAutomaticShot: async (input) => {
      const base = stubAutomaticShot(input);
      return options.writeAutomaticShot?.(input, base) ?? base;
    },
    directScene: async (input) => {
      const base = stubDirect(input);
      return options.directScene?.(input, base) ?? base;
    },
    authorSubtitles: async (input) => {
      const base = stubSubtitles(input);
      return options.authorSubtitles?.(input, base) ?? base;
    },
    proposeEpisodeTheme: async (input) => {
      const base = stubTheme(input);
      return options.proposeEpisodeTheme?.(input, base) ?? base;
    },
  };
}
