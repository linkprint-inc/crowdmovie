// Validation of everything a `ContentEngine` returns, before any of it is
// written or acted on.
//
// §6.7 / §17.23: the model produces content, the code decides flow. That only
// holds if the code refuses content it cannot verify — so every rule the spec
// states as a number or an invariant is checked here, and a failure is an error
// the state machine handles, never a value the backend quietly repairs
// (§6.5「不能从自由文本中猜测或自动修补关键字段」, §9.2「后端不得静默补写译文或
// 移动时间点」).
//
// The stub engine goes through these same functions as M4's real Codex engine
// will: a stub that drifts from the schema has to fail the way a hallucinating
// model does, or the tests prove nothing about the real path.
import { glen } from '../lib/grapheme.js';
import { englishWordCount } from '../lib/english-words.js';
import { FILM_CAPABILITIES, FILM_PROMPT_MAX_ENGLISH_WORDS, compileFilmPrompt, validateFilmPlan, type FilmState } from './film-plan.js';
import {
  LOCALES,
  type AuthorSubtitlesOutput,
  type DialogueLine,
  type DirectSceneOutput,
  type FinalizeRoundOutput,
  type LocalizedText,
  type ScoreSubmissionOutput,
} from './engine.js';

/** §6.3 的五个维度上限，顺序即报错顺序。 */
export const SCORE_DIMENSION_MAX = {
  continuity: 30,
  filmability15s: 25,
  characterConsistency: 20,
  dramaticValue: 15,
  originality: 10,
} as const;

/** §6.3「每种语言不超过 160 个用户可见字符」. */
export const ROAST_MAX_GRAPHEMES = 160;
/** English AI Director feed copy is word-counted independently of human shots. */
export const AUTOMATIC_SHOT_MAX_ENGLISH_WORDS = 70;
/** Full MiniMax H3 production prompt; the public synopsis is a separate field. */
export const H3_PROMPT_MAX_ENGLISH_WORDS = 2000;

/** §17.11「场景最长不超过 15 秒」. */
export const SCENE_MAX_SECONDS = 15;
/** Sol chooses the beat length, but a production scene is never shorter than 5s. */
export const SCENE_MIN_SECONDS = 5;
export const H3_PRODUCTION_CAPABILITIES = 'h3-capabilities-v5';
export const H3_BODY_PREFIX = 'summary:\n';
export const H3_I2VA_HEADER =
  'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.';

/**
 * Thrown when engine output fails validation. §5.2 puts schema mismatches in the
 * "limited retry, then a definite failure state" bucket, so the scheduler treats
 * these as retryable and the attempt cap is what stops the loop.
 */
export class EngineOutputError extends Error {
  constructor(what: string, problems: string[]) {
    super(`${what} failed validation: ${problems.join('; ')}`);
    this.name = 'EngineOutputError';
  }
}

// AI Director source writing is English-only. Translated subtitle fields are
// validated separately and are deliberately exempt from this source-text rule.
const NON_ENGLISH_SOURCE_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}]/u;
const NON_ENGLISH_SOURCE_RUN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}]+/gu;
const H3_DIALOGUE_BLOCK = /<d>\[English\]\s*([\s\S]*?)<\/d>/g;
const H3_DIALOGUE_TAG = /<\/?d>/gi;
const H3_EXPLICIT_TIME_RANGE =
  /(?:\bfrom\s+)?\d+(?:\.\d+)?\s*(?:to|[-\u2013\u2014])\s*\d+(?:\.\d+)?\s*(?:seconds?|secs?|s)\b|\b(?:at|after|before)\s+\d+(?:\.\d+)?\s*(?:seconds?|secs?|s)\b|\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\b/i;
const PRODUCTION_LABEL_IN_DIALOGUE =
  /\b(?:scene|shot|round)\s*(?:number\s*)?#?\s*0*\d+\b|\b0{2,}\d+\b/i;
const SCENE_OR_ROUND_LABEL =
  /\b(?:scene|round)\s*(?:number\s*)?#?\s*0*\d+\b/i;

export function assertEnglishCreativeSource(what: string, value: string): void {
  if (value.trim().length === 0) throw new Error(`${what} is empty`);
  if (NON_ENGLISH_SOURCE_SCRIPT.test(value)) {
    const originalScriptRuns = value.match(NON_ENGLISH_SOURCE_RUN) ?? [];
    const originalScriptCharacters = originalScriptRuns.reduce(
      (count, run) => count + [...run].length,
      0,
    );
    const englishWords = value.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/g) ?? [];
    // Canonical country-specific names stay in their original script while
    // the surrounding creative source remains English. Keep that exception
    // narrow: one or two short name runs need a real English sentence around
    // them; non-English prose or dialogue still fails closed.
    if (
      englishWords.length < 5 ||
      originalScriptRuns.length > 2 ||
      originalScriptCharacters > 24 ||
      originalScriptRuns.some((run) => [...run].length > 12)
    ) {
      throw new Error(`${what} must be written in English`);
    }
  }
}

/**
 * A creative-source field is already inside a structured wire response. Reject
 * a second serialized `{ "content": ... }` envelope instead of silently
 * unwrapping it and persisting a different shape from an ordinary submission.
 */
export function assertPlainTextCreativeSource(
  what: string,
  value: string,
): void {
  assertEnglishCreativeSource(what, value);

  let candidate = value.trim();
  for (let depth = 0; depth < 2; depth += 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      return;
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).content === 'string'
    ) {
      throw new Error(`${what} must be plain text, not serialized JSON`);
    }
    if (typeof parsed !== 'string') return;
    candidate = parsed.trim();
  }
}

function checkEnglishCreativeSource(
  problems: string[],
  what: string,
  value: string,
): void {
  if (value.trim().length === 0) {
    problems.push(`${what} is empty`);
  } else if (NON_ENGLISH_SOURCE_SCRIPT.test(value)) {
    problems.push(`${what} must be written in English`);
  }
}

function checkEnglishCreativeSourceAllowNames(
  problems: string[],
  what: string,
  value: string,
): void {
  if (value.trim().length === 0) {
    problems.push(`${what} is empty`);
  } else if (NON_ENGLISH_SOURCE_SCRIPT.test(value) && !/[A-Za-z]{2,}/.test(value)) {
    problems.push(`${what} must use English prose; only canonical names may retain original script`);
  }
}

function same(value: unknown, expected: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(expected);
}

function validateProductionWorkflow(
  problems: string[],
  output: DirectSceneOutput,
  roundId: string,
): void {
  const prompt = output.comfyuiWorkflow?.prompt ?? {};
  const requiredIds = [
    '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13',
    '14', '15', ...(output.usePreviousEndFrame ? ['16'] : []),
  ];
  const expectedIds = [...requiredIds].sort();
  if (!same(Object.keys(prompt).sort(), expectedIds)) {
    problems.push(`comfyuiWorkflow node ids must exactly match ${expectedIds.join(',')}`);
    return;
  }
  const fixed: Record<string, { classType: string; inputs: Record<string, unknown> }> = {
    '1': { classType: 'UNETLoader', inputs: { unet_name: 'minimax_h3_fl2va_int8_convrot.safetensors', weight_dtype: 'default' } },
    '2': { classType: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors', type: 'minimax', device: 'default' } },
    '3': { classType: 'VAELoader', inputs: { vae_name: 'minimax_h3_video_vae_fp16.safetensors' } },
    '4': { classType: 'VAELoader', inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' } },
    '5': { classType: 'MiniMaxH3SigmaShift', inputs: { model: ['1', 0], shift_video: 12, shift_audio: 3 } },
    '6': { classType: 'MiniMaxH3PDDAccApply', inputs: { model: ['5', 0], pdd_file: 'MiniMax-H3-FL2VA-Acc-8Step.safetensors', nfe: '8', lora_strength: 1, head_strength: 1, on_off_grid: 'error', partition: '', enabled: true } },
    '8': { classType: 'BasicGuider', inputs: { model: ['6', 0], conditioning: ['7', 0] } },
    '9': { classType: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '11': { classType: 'SamplerCustomAdvanced', inputs: { noise: ['10', 0], guider: ['8', 0], sampler: ['9', 0], sigmas: ['6', 1], latent_image: ['7', 1] } },
    '12': { classType: 'VAEDecode', inputs: { samples: ['11', 0], vae: ['3', 0] } },
    '13': { classType: 'VAEDecodeAudio', inputs: { samples: ['11', 0], vae: ['4', 0] } },
    '14': { classType: 'CreateVideo', inputs: { images: ['12', 0], audio: ['13', 0], fps: 24 } },
    '15': { classType: 'SaveVideo', inputs: { video: ['14', 0], filename_prefix: `video/FastH3/${roundId}`, format: 'mp4', codec: 'auto' } },
  };
  if (output.usePreviousEndFrame) {
    fixed['16'] = {
      classType: 'LoadImage',
      inputs: { image: `crowdmovie/${roundId}.png` },
    };
  }
  for (const [id, rule] of Object.entries(fixed)) {
    const node = prompt[id];
    if (node.class_type !== rule.classType || !same(node.inputs, rule.inputs)) {
      problems.push(`comfyuiWorkflow node ${id} does not match the pinned PDD NFE8 graph`);
    }
  }
  const noise = prompt['10'];
  if (
    noise.class_type !== 'RandomNoise' ||
    !Number.isInteger(noise.inputs.noise_seed) ||
    Number(noise.inputs.noise_seed) < 0 ||
    Object.keys(noise.inputs).length !== 1
  ) {
    problems.push('comfyuiWorkflow node 10 must be RandomNoise with one non-negative integer seed');
  }
  const h3 = prompt['7'];
  const expectedH3Inputs: Record<string, unknown> = {
    clip: ['2', 0],
    vae: ['3', 0],
    prompt: output.h3PromptEn,
    width: 1344,
    height: 768,
    length: expectedH3Length(output.durationSeconds),
  };
  if (output.usePreviousEndFrame) expectedH3Inputs.first_frame = ['16', 0];
  if (
    h3.class_type !== 'MiniMaxH3ImageToVideo' ||
    !same(h3.inputs, expectedH3Inputs)
  ) {
    problems.push('comfyuiWorkflow node 7 does not match the director prompt/mode/length');
  }
}

function assertNoProblems(what: string, problems: string[]): void {
  if (problems.length > 0) throw new EngineOutputError(what, problems);
}

function checkH3DialogueIsolation(
  problems: string[],
  prompt: string,
  dialogue: DialogueLine[],
  imageConditioned: boolean,
): void {
  const blockMatches = [...prompt.matchAll(H3_DIALOGUE_BLOCK)];
  const blocks = blockMatches.map((match) =>
    (match[1] ?? '').trim(),
  );
  const tagCount = prompt.match(H3_DIALOGUE_TAG)?.length ?? 0;

  if (tagCount !== blocks.length * 2 || blocks.length !== dialogue.length) {
    problems.push(
      'h3PromptEn must contain exactly one well-formed <d>[English] ...</d> block per dialogue line',
    );
  } else {
    for (const [index, line] of dialogue.entries()) {
      if (blocks[index] !== line.line) {
        problems.push(
          `h3PromptEn dialogue block ${index} must exactly match dialogueEn[${index}].line`,
        );
      }
    }
  }

  const expectedHeader = `${H3_I2VA_HEADER}\n\n`;
  const corePrompt = imageConditioned && prompt.startsWith(expectedHeader)
    ? prompt.slice(expectedHeader.length)
    : prompt;
  const outsideDialogue = corePrompt.replace(H3_DIALOGUE_BLOCK, '');
  const summaryAt = corePrompt.indexOf('summary:');
  const detailedAt = corePrompt.indexOf('detailed_description:');
  const soundscapeAt = corePrompt.indexOf('overall_soundscape:');
  const musicAt = corePrompt.indexOf('non_diegetic_music:');
  if (
    summaryAt !== 0 ||
    detailedAt <= summaryAt ||
    soundscapeAt <= detailedAt ||
    musicAt <= soundscapeAt
  ) {
    problems.push(
      'h3PromptEn must use the reference field order: summary, detailed_description, overall_soundscape, non_diegetic_music',
    );
  }
  if (
    soundscapeAt >= 0 &&
    [...corePrompt.matchAll(H3_DIALOGUE_BLOCK)].some(
      (match) => (match.index ?? corePrompt.length) > soundscapeAt,
    )
  ) {
    problems.push(
      'h3PromptEn dialogue blocks must stay inside detailed_description',
    );
  }
  if (H3_EXPLICIT_TIME_RANGE.test(outsideDialogue)) {
    problems.push(
      'h3PromptEn must use relative action timing, not readable numeric time ranges',
    );
  }
  if (/[\u201c\u201d"]/.test(outsideDialogue)) {
    problems.push('h3PromptEn must not contain quoted speech outside <d> blocks');
  }
  if (SCENE_OR_ROUND_LABEL.test(outsideDialogue)) {
    problems.push('h3PromptEn must not include scene or round numbers');
  }

  for (const [index, line] of dialogue.entries()) {
    if (PRODUCTION_LABEL_IN_DIALOGUE.test(line.line)) {
      problems.push(
        `dialogueEn[${index}].line contains a scene, shot, or round number`,
      );
    }
    if (H3_EXPLICIT_TIME_RANGE.test(line.line)) {
      problems.push(`dialogueEn[${index}].line contains a production time range`);
    }
  }
}

function checkLocalized(
  problems: string[],
  where: string,
  value: LocalizedText,
  maxGraphemes?: number,
): void {
  for (const locale of LOCALES) {
    const text = value[locale];
    if (typeof text !== 'string' || text.trim().length === 0) {
      problems.push(`${where}.${locale} is missing or empty`);
      continue;
    }
    if (maxGraphemes !== undefined && glen(text) > maxGraphemes) {
      problems.push(`${where}.${locale} exceeds ${maxGraphemes} graphemes`);
    }
  }
}

// --- 初评 (§6.3) -------------------------------------------------------------

export function validateScore(
  output: ScoreSubmissionOutput,
  expectedSubmissionId: string,
): void {
  const problems: string[] = [];

  if (output.submissionId !== expectedSubmissionId) {
    problems.push('submissionId does not match the submission being scored');
  }

  let sum = 0;
  for (const [dimension, max] of Object.entries(SCORE_DIMENSION_MAX)) {
    const value = output.scoreBreakdown[
      dimension as keyof typeof SCORE_DIMENSION_MAX
    ];
    if (!Number.isInteger(value) || value < 0 || value > max) {
      problems.push(`scoreBreakdown.${dimension} must be an integer in 0..${max}`);
      continue;
    }
    sum += value;
  }
  // 「后端必须验证五个分项均在各自范围内且总和严格等于 score_total」.
  if (problems.length === 0 && sum !== output.scoreTotal) {
    problems.push(`scoreTotal ${output.scoreTotal} != breakdown sum ${sum}`);
  }

  // 「设为 eligible=false、score_total=0 并填写固定风险标记」— an ineligible
  // submission that still carries points would sort into the Top-K.
  if (!output.eligible && output.scoreTotal !== 0) {
    problems.push('ineligible submissions must score 0');
  }
  if (!output.eligible && output.riskFlags.length === 0) {
    problems.push('ineligible submissions must carry at least one risk flag');
  }
  if (output.eligible && output.riskFlags.includes('not_story_content')) {
    problems.push('not_story_content submissions cannot be eligible');
  }

  if (output.reason.trim().length === 0) problems.push('reason is empty');
  if (output.rubricVersion.trim().length === 0) {
    problems.push('rubricVersion is empty');
  }
  checkLocalized(problems, 'publicRoast', output.publicRoast, ROAST_MAX_GRAPHEMES);

  assertNoProblems('submission score', problems);
}

// --- 终审 (§6.4) -------------------------------------------------------------

export function validateFinalize(
  output: FinalizeRoundOutput,
  expectedRoundId: string,
  candidateIds: readonly string[],
): void {
  const problems: string[] = [];
  const allowed = new Set(candidateIds);

  if (output.roundId !== expectedRoundId) {
    problems.push('roundId does not match the round being finalized');
  }
  if (output.rankedCandidates.length === 0) {
    problems.push('rankedCandidates is empty');
  }

  const seen = new Set<string>();
  for (const candidate of output.rankedCandidates) {
    // 「终审不得选择 Top-K 之外或数据库不存在的 ID」.
    if (!allowed.has(candidate.submissionId)) {
      problems.push(`ranked ${candidate.submissionId} is not in the Top-K`);
    }
    if (seen.has(candidate.submissionId)) {
      problems.push(`ranked ${candidate.submissionId} appears twice`);
    }
    seen.add(candidate.submissionId);
    if (
      !Number.isFinite(candidate.finalScore) ||
      candidate.finalScore < 0 ||
      candidate.finalScore > 100
    ) {
      problems.push(`finalScore for ${candidate.submissionId} is out of 0..100`);
    }
  }

  if (!allowed.has(output.selectedSubmissionId)) {
    problems.push('selectedSubmissionId is not in the Top-K');
  } else if (!seen.has(output.selectedSubmissionId)) {
    problems.push('selectedSubmissionId was not ranked');
  }
  if (output.rubricVersion.trim().length === 0) {
    problems.push('rubricVersion is empty');
  }

  assertNoProblems('round finalize', problems);
}

// --- 时间轴，导演包与字幕包共用 (§6.5, §9.2) ---------------------------------

interface TimedSpan {
  speaker: string;
  startSeconds: number;
  endSeconds: number;
  label: string;
}

/**
 * §9.2「0 <= start < end <= duration，并按照开始时间单调递增；cue 可以有受控重
 * 叠，但同一说话人的 cue 不得互相覆盖」. §6.5 constrains `dialogue_en` the same
 * way — it is the planned version of the very same timeline (§9.1).
 */
function checkTimeline(
  problems: string[],
  spans: TimedSpan[],
  durationSeconds: number,
): void {
  let previousStart = -Infinity;
  const lastEndBySpeaker = new Map<string, number>();

  for (const span of spans) {
    const { startSeconds: start, endSeconds: end, label } = span;
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      problems.push(`${label} has non-numeric times`);
      continue;
    }
    if (start < 0) problems.push(`${label} starts before 0`);
    if (start >= end) problems.push(`${label} does not end after it starts`);
    if (end > durationSeconds) {
      problems.push(`${label} ends after the scene (${durationSeconds}s)`);
    }
    if (start < previousStart) problems.push(`${label} is out of time order`);
    previousStart = Math.max(previousStart, start);

    if (span.speaker.trim().length === 0) {
      problems.push(`${label} has no speaker`);
    } else {
      const lastEnd = lastEndBySpeaker.get(span.speaker);
      if (lastEnd !== undefined && start < lastEnd) {
        problems.push(`${label} overlaps another line by ${span.speaker}`);
      }
      lastEndBySpeaker.set(span.speaker, Math.max(lastEnd ?? 0, end));
    }
  }
}

const dialogueSpans = (lines: DialogueLine[]): TimedSpan[] =>
  lines.map((line, index) => ({
    speaker: line.speaker,
    startSeconds: line.startSeconds,
    endSeconds: line.endSeconds,
    label: `dialogueEn[${index}]`,
  }));

function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

function expectedH3Length(durationSeconds: number): number {
  const requestedFrames = Math.max(5, roundHalfToEven(durationSeconds * 24));
  return Math.min(
    345,
    requestedFrames + ((5 - (requestedFrames % 17) + 17) % 17),
  );
}

// --- 导演包 (§6.5) -----------------------------------------------------------

export function validateDirector(
  output: DirectSceneOutput,
  expected: {
    roundId: string;
    selectedSubmissionId: string | null;
    capabilitiesVersion?: string;
    previousEndFrameSha256?: string | null;
    previousMotionContextId?: string | null;
    previousFilmState?: FilmState;
  },
): void {
  const problems: string[] = [];

  // §6.5「后端还必须验证时长、投稿 ID、贡献者……」— a director package that
  // credits a different submission than the one the round selected would put
  // the wrong username on a permanent scene.
  if (output.selectedSubmissionId !== expected.selectedSubmissionId) {
    problems.push('selectedSubmissionId does not match the round selection');
  }
  if (expected.selectedSubmissionId === null && output.creditUsername !== null) {
    problems.push('自动续写 must not credit a contributor');
  }

  if (
    !Number.isFinite(output.durationSeconds) ||
    output.durationSeconds < SCENE_MIN_SECONDS ||
    output.durationSeconds > SCENE_MAX_SECONDS
  ) {
    problems.push(
      `durationSeconds must be in [${SCENE_MIN_SECONDS}, ${SCENE_MAX_SECONDS}]`,
    );
  }
  if (
    output.shotRelation !== 'continuous_event' &&
    output.shotRelation !== 'new_shot'
  ) {
    problems.push('shotRelation must be continuous_event or new_shot');
  }
  if (output.usePreviousEndFrame) {
    if (output.shotRelation !== 'continuous_event') {
      problems.push('usePreviousEndFrame requires shotRelation=continuous_event');
    }
    if (expected.previousEndFrameSha256 == null) {
      problems.push('usePreviousEndFrame requires the immediately previous published end frame');
    }
  }
  if (output.useMotionContext) {
    problems.push('Motion Context is disabled in production v5');
  }

  const endReason = output.episodeEndReason ?? '';
  if (output.episodeShouldEnd && endReason.trim().length === 0) {
    problems.push('episodeShouldEnd=true requires a non-empty episodeEndReason');
  }
  if (!output.episodeShouldEnd && endReason.trim().length > 0) {
    problems.push('episodeEndReason must be null unless the episode ends');
  }

  const productionEnglishSource =
    expected.capabilitiesVersion === H3_PRODUCTION_CAPABILITIES;
  const filmSource = expected.capabilitiesVersion === FILM_CAPABILITIES;
  if (filmSource) {
    try {
      if (!output.filmPlan || !output.filmPromptAudit) throw new Error('v6 requires a film plan and compiler audit');
      validateFilmPlan(output.filmPlan, output.durationSeconds, expected.previousFilmState);
      const audit = output.filmPromptAudit;
      if (audit.compilerVersion !== 'film-compiler-v1' || !['h3-four-section-v1', 'h3-base-v1'].includes(audit.format)) throw new Error('Unknown film compiler or format');
      if ((audit.conditioning.mode === 'I2VA') !== output.usePreviousEndFrame) throw new Error('Film conditioning differs from workflow conditioning');
      if (output.usePreviousEndFrame && audit.conditioning.parentEndFrameSha256 !== expected.previousEndFrameSha256) throw new Error('Film conditioning does not reference the immediately previous tail');
      const rebuilt = compileFilmPrompt(output.filmPlan, output.sceneSummaryZh, output.dialogueEn, output.durationSeconds, audit.conditioning, audit.format);
      if (rebuilt.prompt !== output.h3PromptEn || rebuilt.audit.promptSha256 !== audit.promptSha256 || rebuilt.audit.planSha256 !== audit.planSha256) throw new Error('Final H3 text differs from the accepted plan; recompile without rewriting');
      if (output.directorSchemaVersion !== 'scene-director-v2') throw new Error('v6 requires scene-director-v2');
      if (output.episodeShouldEnd !== (output.filmPlan.endingFunction === 'episode-end')) throw new Error('Episode ending must come from the planned visible resolution');
      checkEnglishCreativeSourceAllowNames(problems, 'h3PromptEn', output.h3PromptEn);
      if (englishWordCount(output.h3PromptEn) > FILM_PROMPT_MAX_ENGLISH_WORDS) throw new Error('Film prompt exceeds 8000 words; simplify the plan');

      const blocks = [...output.h3PromptEn.matchAll(/<d>\[English\] ([\s\S]*?)<\/d>/g)].map((match) => match[1]);
      if (blocks.length !== output.dialogueEn.length || output.dialogueEn.some((line) => blocks.filter((block) => block === line.line).length !== 1)) throw new Error('Dialogue must occur verbatim once in each compiler-owned block');
      for (const line of output.dialogueEn) checkEnglishCreativeSource(problems, 'dialogue line', line.line);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (productionEnglishSource) {
    // `sceneSummaryZh` is a legacy storage/API name. New AI Director values are
    // English and remain so until that compatibility field can be migrated.
    checkEnglishCreativeSourceAllowNames(problems, 'sceneSummaryZh', output.sceneSummaryZh);
    checkEnglishCreativeSourceAllowNames(
      problems,
      'continuityFromPrevious',
      output.continuityFromPrevious,
    );
    for (const [index, update] of output.continuityUpdates.entries()) {
      checkEnglishCreativeSourceAllowNames(problems, `continuityUpdates[${index}]`, update);
    }
    if (output.episodeEndReason !== null) {
      checkEnglishCreativeSourceAllowNames(
        problems,
        'episodeEndReason',
        output.episodeEndReason,
      );
    }
    checkEnglishCreativeSourceAllowNames(problems, 'h3PromptEn', output.h3PromptEn);
    const h3PromptWordCount = englishWordCount(output.h3PromptEn);
    if (h3PromptWordCount > H3_PROMPT_MAX_ENGLISH_WORDS) {
      problems.push(
        `h3PromptEn must contain at most ${H3_PROMPT_MAX_ENGLISH_WORDS} English words; received ${h3PromptWordCount}`,
      );
    }
    for (const [index, line] of output.dialogueEn.entries()) {
      checkEnglishCreativeSource(problems, `dialogueEn[${index}].line`, line.line);
    }
    const body = output.h3PromptEn;
    if (output.usePreviousEndFrame) {
      const expectedPrefix = `${H3_I2VA_HEADER}\n\n${H3_BODY_PREFIX}`;
      if (!body.startsWith(expectedPrefix)) {
        problems.push('I2VA h3PromptEn must start with the exact Picture 1 alignment header');
      }

    } else {
      if (!body.startsWith(H3_BODY_PREFIX)) {
        problems.push('T2VA h3PromptEn must start with the reference summary field');
      }
      if (body.includes('<Picture')) {
        problems.push('T2VA h3PromptEn must not reference <Picture>');
      }
    }
    checkH3DialogueIsolation(
      problems,
      body,
      output.dialogueEn,
      output.usePreviousEndFrame,
    );
  } else {
    if (output.sceneSummaryZh.trim().length === 0) {
      problems.push('sceneSummaryZh is empty');
    }
    if (output.h3PromptEn.trim().length === 0) problems.push('h3PromptEn is empty');
  }
  if (
    expected.capabilitiesVersion !== undefined &&
    output.comfyuiCapabilitiesVersion !== expected.capabilitiesVersion
  ) {
    problems.push('comfyuiCapabilitiesVersion does not match gateway capabilities');
  }

  const nodes = Object.entries(output.comfyuiWorkflow?.prompt ?? {});
  if (nodes.length === 0) {
    problems.push('comfyuiWorkflow.prompt has no nodes');
  }
  for (const [nodeId, node] of nodes) {
    if (typeof node?.class_type !== 'string' || node.class_type.length === 0) {
      problems.push(`comfyuiWorkflow node ${nodeId} has no class_type`);
    }
  }
  if (productionEnglishSource || filmSource) {
    validateProductionWorkflow(problems, output, expected.roundId);
  }

  checkTimeline(problems, dialogueSpans(output.dialogueEn), output.durationSeconds);

  assertNoProblems('director package', problems);
}

// --- 字幕包 (§9.2) -----------------------------------------------------------

export function validateSubtitles(
  output: AuthorSubtitlesOutput,
  expected: { actualDurationSeconds: number },
): void {
  const problems: string[] = [];

  if (output.audioLanguage !== 'en') problems.push('audioLanguage must be en');
  if (output.actualDurationSeconds !== expected.actualDurationSeconds) {
    problems.push('actualDurationSeconds does not match the measured duration');
  }
  if (output.subtitleSchemaVersion.trim().length === 0) {
    problems.push('subtitleSchemaVersion is empty');
  }

  const seen = new Set<string>();
  for (const [index, cue] of output.cues.entries()) {
    if (cue.cueId.trim().length === 0) problems.push(`cues[${index}] has no cueId`);
    if (seen.has(cue.cueId)) problems.push(`cueId ${cue.cueId} appears twice`);
    seen.add(cue.cueId);
    checkLocalized(problems, `cues[${index}].text`, cue.text);
  }

  checkTimeline(
    problems,
    output.cues.map((cue, index) => ({
      speaker: cue.speaker,
      startSeconds: cue.startSeconds,
      endSeconds: cue.endSeconds,
      label: `cues[${index}]`,
    })),
    expected.actualDurationSeconds,
  );

  assertNoProblems('subtitle package', problems);
}
