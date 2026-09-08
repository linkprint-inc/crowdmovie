import { createHash } from 'node:crypto';

import type { DialogueLine, PreviousScene } from './engine.js';
import { englishWordCount } from '../lib/english-words.js';

export const FILM_CAPABILITIES = 'h3-capabilities-v6';
export const FILM_STYLE_PROFILE = 'whos-next-causal-cg-v1';
export const FILM_PLAN_VERSION = 'film-plan-v1';
export const FILM_PROMPT_MAX_ENGLISH_WORDS = 8000;
export const FILM_I2VA_HEADER = 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.';
export type FilmPromptFormat = 'h3-four-section-v1' | 'h3-base-v1';

export interface FilmCharacterState {
  name: string;
  appearance: string;
  position: string;
  pose: string;
  heldObjects: string;
  condition: string;
  presence: 'active' | 'approaching' | 'exited';
}

export interface FilmState {
  locationId: string;
  environment: string;
  timeAndLight: string;
  landmarks: string[];
  characters: FilmCharacterState[];
  persistentChanges: string[];
}

export interface FilmBeat {
  action: string;
  responseBeforeContact: string;
  contact: string;
  reaction: string;
  materialResponse: string;
  outcome: string;
  sound: string;
  passage?: FilmPassage | null;
}

/** A passage belongs to its causal beat, so a cut cannot erase the journey. */
export interface FilmPassage {
  character: string;
  kind: 'arrival' | 'exit';
  phase: 'approach' | 'complete';
  origin: string;
  mechanism: string;
  path: string;
  finalPosition: string;
  cutMatch: string;
}

export interface FilmShot {
  startSeconds: number;
  framing: 'wide' | 'medium-wide' | 'medium' | 'close-up';
  cameraMove: 'static' | 'truck-left' | 'truck-right' | 'push-in' | 'pull-out' | 'arc';
  cameraPath: string;
  cameraPurpose: string;
  axis: string;
  beats: FilmBeat[];
}

export interface FilmPlan {
  version: typeof FILM_PLAN_VERSION;
  method: 'paired-action' | 'cumulative-damage' | 'equipment-physics' | 'spatial-path' | 'sequential-arrival' | 'reaction-reveal' | 'result-anchored';
  storyRelation: 'same-event' | 'same-place-new-angle' | 'time-passage' | 'location-change';
  beatGoal: string;
  entryState: FilmState;
  shots: FilmShot[];
  exitState: FilmState;
  endingFunction: 'bridge' | 'result' | 'episode-end';
  nextConsequence: string;
  doNotRepeat: string[];
  voices: Array<{ speaker: string; description: string }>;
  soundscape: string;
  music: string;
}

export interface FilmConditioning {
  mode: 'T2VA' | 'I2VA';
  tailDepth: number;
  resetReason: 'new-location-or-time' | 'new-angle' | 'missing-tail' | 'tail-depth-limit' | 'continuous-tail';
  parentEndFrameSha256: string | null;
}

export interface FilmPromptAudit {
  compilerVersion: 'film-compiler-v1';
  format: FilmPromptFormat;
  planSha256: string;
  promptSha256: string;
  conditioning: FilmConditioning;
}

const text = { type: 'string', minLength: 1, maxLength: 1000 };
const strings = { type: 'array', maxItems: 12, items: text };
const objectSchema = (properties: Record<string, unknown>) => ({
  type: 'object', additionalProperties: false, required: Object.keys(properties), properties,
});
export const FILM_CHARACTER_SCHEMA = objectSchema({
  name: text, appearance: text, position: text, pose: text, heldObjects: text,
  condition: text, presence: { type: 'string', enum: ['active', 'approaching', 'exited'] },
});
export const FILM_STATE_SCHEMA = objectSchema({
  locationId: text, environment: text, timeAndLight: text,
  landmarks: { ...strings, minItems: 2, maxItems: 6 },
  characters: { type: 'array', minItems: 1, maxItems: 100, items: FILM_CHARACTER_SCHEMA },
  persistentChanges: strings,
});
export const FILM_PLAN_SCHEMA = objectSchema({
  version: { type: 'string', const: FILM_PLAN_VERSION },
  method: { type: 'string', enum: ['paired-action', 'cumulative-damage', 'equipment-physics', 'spatial-path', 'sequential-arrival', 'reaction-reveal', 'result-anchored'] },
  storyRelation: { type: 'string', enum: ['same-event', 'same-place-new-angle', 'time-passage', 'location-change'] },
  beatGoal: text, entryState: FILM_STATE_SCHEMA,
  shots: {
    type: 'array', minItems: 1, maxItems: 3,
    items: objectSchema({
      startSeconds: { type: 'number', minimum: 0, maximum: 14 },
      framing: { type: 'string', enum: ['wide', 'medium-wide', 'medium', 'close-up'] },
      cameraMove: { type: 'string', enum: ['static', 'truck-left', 'truck-right', 'push-in', 'pull-out', 'arc'] },
      cameraPath: text, cameraPurpose: text, axis: text,
      beats: {
        type: 'array', minItems: 1, maxItems: 4,
        items: objectSchema({ action: text, responseBeforeContact: { ...text, description: 'The other actor blocks, dodges, pivots or deflects BEFORE contact. Include the named actor and ordered response that changes the attack path. None only for an unopposed hit.' }, contact: text, reaction: text, materialResponse: text, outcome: text, sound: text,
          passage: { anyOf: [{ type: 'null' }, objectSchema({ character: text,
            kind: { type: 'string', enum: ['arrival', 'exit'] }, phase: { type: 'string', enum: ['approach', 'complete'] },
            origin: text, mechanism: text, path: text, finalPosition: text, cutMatch: text,
          })], description: 'Required for a filmed arrival or departure, including an approaching flight close-up. Otherwise null. The beat supplies the body motion, contact, reaction, environment response and result.' },
        }),
      },
    }),
  },
  exitState: FILM_STATE_SCHEMA,
  endingFunction: { type: 'string', enum: ['bridge', 'result', 'episode-end'] },
  nextConsequence: text, doNotRepeat: strings,
  voices: { type: 'array', maxItems: 100, items: objectSchema({ speaker: text, description: text }) },
  soundscape: text, music: text,
});

function requiredText(value: unknown, at: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000) {
    throw new Error(`${at} must be nonempty text of at most 1000 characters`);
  }
  if (/<\/?d>|<Picture|\[Shot\s+\d+\]/i.test(value)) {
    throw new Error(`${at} must not contain dialogue, image or shot markup; the compiler owns it`);
  }
}

export function validateFilmState(state: FilmState, at = 'film state'): void {
  if (!state || typeof state !== 'object') throw new Error(`${at} is missing`);
  for (const key of ['locationId', 'environment', 'timeAndLight'] as const) requiredText(state[key], `${at}.${key}`);
  if (!Array.isArray(state.landmarks) || state.landmarks.length < 2 || state.landmarks.length > 6) throw new Error(`${at} needs 2-6 spatial landmarks`);
  if (!Array.isArray(state.persistentChanges) || state.persistentChanges.length > 12) throw new Error(`${at} persistent changes are invalid`);
  [...state.landmarks, ...state.persistentChanges].forEach((value) => requiredText(value, at));
  if (!Array.isArray(state.characters) || state.characters.length < 1 || state.characters.length > 100) throw new Error(`${at} needs 1-100 character records`);
  for (const character of state.characters) {
    for (const key of ['name', 'appearance', 'position', 'pose', 'heldObjects', 'condition'] as const) requiredText(character[key], `${at}.${key}`);

    if (!['active', 'approaching', 'exited'].includes(character.presence)) throw new Error(`${at} has invalid character presence`);
  }

}

export function validateFilmPlan(plan: FilmPlan, duration: number, previous?: FilmState | null): void {
  if (plan?.version !== FILM_PLAN_VERSION) throw new Error('filmPlan.version must be film-plan-v1');
  validateFilmState(plan.entryState, 'entryState');
  validateFilmState(plan.exitState, 'exitState');
  for (const key of ['beatGoal', 'nextConsequence', 'soundscape', 'music'] as const) requiredText(plan[key], key);
  if (!['same-event', 'same-place-new-angle', 'time-passage', 'location-change'].includes(plan.storyRelation)) throw new Error('invalid film story relation');
  // Story continuity, casting, damage and endings belong to the director.
  void previous;
  if (!Array.isArray(plan.shots) || !plan.shots.length || plan.shots.length > 3) throw new Error('filmPlan requires 1-3 purposeful shots');
  if (plan.shots[0].startSeconds !== 0) throw new Error('First shot must start at zero');
  for (const [index, shot] of plan.shots.entries()) {
    const end = plan.shots[index + 1]?.startSeconds ?? duration;
    if (!Number.isFinite(shot.startSeconds) || end - shot.startSeconds < 1.5 || end > duration) throw new Error('Shot cut times must increase within duration, leaving at least 1.5 seconds per shot');
    if (!['wide', 'medium-wide', 'medium', 'close-up'].includes(shot.framing)) throw new Error('invalid shot framing');
    if (!['static', 'truck-left', 'truck-right', 'push-in', 'pull-out', 'arc'].includes(shot.cameraMove)) throw new Error('invalid camera movement');
    for (const key of ['cameraPath', 'cameraPurpose', 'axis'] as const) requiredText(shot[key], key);

    if (!Array.isArray(shot.beats) || !shot.beats.length || shot.beats.length > 4) throw new Error('Each shot needs 1-4 causal beats');
    for (const beat of shot.beats) {
      for (const key of ['action', 'responseBeforeContact', 'contact', 'reaction', 'materialResponse', 'outcome', 'sound'] as const) requiredText(beat[key], `beat.${key}`);
      const passage = beat.passage;
      if (!passage) continue;
      for (const key of ['character', 'origin', 'mechanism', 'path', 'finalPosition', 'cutMatch'] as const) requiredText(passage[key], `passage.${key}`);
      if (!['arrival', 'exit'].includes(passage.kind) || !['approach', 'complete'].includes(passage.phase)) throw new Error('Invalid passage kind or phase');
    }
  }
  if (!['bridge', 'result', 'episode-end'].includes(plan.endingFunction)) throw new Error('invalid ending function');
  if (!Array.isArray(plan.doNotRepeat) || plan.doNotRepeat.length > 12) throw new Error('invalid do-not-repeat list');
  plan.doNotRepeat.forEach((value) => requiredText(value, 'doNotRepeat'));
  if (!Array.isArray(plan.voices) || plan.voices.length > 100) throw new Error('invalid voice list');
  for (const voice of plan.voices) {
    requiredText(voice.speaker, 'voice speaker'); requiredText(voice.description, 'voice description');
  }
  if (englishWordCount(JSON.stringify(plan)) > FILM_PROMPT_MAX_ENGLISH_WORDS) throw new Error('Director film plan exceeds 8000 English words; this is a ceiling, not a length target');
}

export function selectFilmConditioning(plan: FilmPlan, previous: PreviousScene | null): FilmConditioning {
  const base = { mode: 'T2VA' as const, tailDepth: 0, parentEndFrameSha256: null };
  if (plan.storyRelation === 'location-change' || plan.storyRelation === 'time-passage') return { ...base, resetReason: 'new-location-or-time' };
  if (plan.storyRelation === 'same-place-new-angle') return { ...base, resetReason: 'new-angle' };
  if (!previous?.endFrame) return { ...base, resetReason: 'missing-tail' };
  const depth = previous.filmPromptAudit?.conditioning.tailDepth ?? (previous.h3PromptEn.startsWith(FILM_I2VA_HEADER) ? 1 : 0);
  if (depth >= 1) return { ...base, resetReason: 'tail-depth-limit' };
  return { mode: 'I2VA', tailDepth: depth + 1, resetReason: 'continuous-tail', parentEndFrameSha256: previous.endFrame.sha256 };
}

const sentence = (value: string) => /[.!?]$/.test(value.trim()) ? value.trim() : `${value.trim()}.`;
const useful = (value: string) => !/^(?:n\/a|none|no change)\.?$/i.test(value.trim());
const time = (seconds: number) => `00:${seconds.toFixed(3).padStart(6, '0')}`;

function describeState(state: FilmState): string {
  return [state.environment, state.timeAndLight, ...state.landmarks,
    ...state.characters.map((c) => `${c.name}: ${c.appearance}; ${c.position}; ${c.pose}; ${c.heldObjects}; ${c.condition}; ${c.presence === 'exited' ? 'already out of the arena and remains absent' : c.presence === 'approaching' ? 'approaching from outside the fight, not yet engaged' : 'present in the action'}`),
    ...state.persistentChanges].filter(useful).map(sentence).join(' ');
}

const cameraSentences: Record<FilmShot['cameraMove'], string> = {
  static: 'The camera holds its position, lens and horizon fixed',
  'truck-left': 'The camera trucks left slowly with small amplitude',
  'truck-right': 'The camera trucks right slowly with small amplitude',
  'push-in': 'The camera pushes in slowly with small amplitude',
  'pull-out': 'The camera pulls out slowly with small amplitude',
  arc: 'The camera follows a small, slow arc',
};

/** Every creative sentence comes from the accepted plan; no fallback camera rewrite. */
export function compileFilmPrompt(
  plan: FilmPlan, summary: string, dialogue: DialogueLine[], duration: number,
  conditioning: FilmConditioning, format: FilmPromptFormat = 'h3-four-section-v1',
): { prompt: string; audit: FilmPromptAudit } {
  validateFilmPlan(plan, duration);
  requiredText(summary, 'summary');
  for (const line of dialogue) requiredText(line.line, 'dialogue line');
  const sections = plan.shots.map((shot, index) => {
    const end = plan.shots[index + 1]?.startSeconds ?? duration;
    const opening = index === 0
      ? `Crisp high-detail 3D game cinematics. ${conditioning.mode === 'I2VA' ? 'The shot opens exactly on <Picture 1>; preserve its composition and the action continues without a pause. ' : ''}${describeState(plan.entryState)}`
      : `At ${time(shot.startSeconds)}, the camera cuts to a ${shot.framing} view from the declared side of the action.`;
    const voiceLines = dialogue.filter((line) => line.startSeconds >= shot.startSeconds && line.startSeconds < end).map((line) => {
      const voice = plan.voices.find((v) => v.speaker === line.speaker);
      if (!voice) throw new Error(`Missing voice description for ${line.speaker}`);
      return `${line.speaker}, using an original ${voice.description} voice, speaks over the visible action: <d>[English] ${line.line}</d>`;
    });
    const action = shot.beats.flatMap((beat) => {
      const p = beat.passage;
      const actor = p ? plan.exitState.characters.find((c) => c.name === p.character) : null;
      return [ ...(p ? [ ...(p.kind === 'arrival' && actor ? [`${p.character} wears ${actor.appearance}`] : []), `${p.character}'s ${p.kind} begins from ${p.origin}`, p.mechanism, `The connected travel path: ${p.path}`] : []),
        beat.action, beat.responseBeforeContact, beat.contact, beat.reaction, beat.materialResponse, beat.outcome, beat.sound,
        ...(p ? [`${p.character} ${p.phase === 'complete' ? 'completes the ' + p.kind : 'is still in transit'} at ${p.finalPosition}`, p.cutMatch] : []) ];
    }).filter(useful).map(sentence).join(' ');
    return `[Shot ${index + 1}] ${opening} ${sentence(`A ${shot.framing} composition`)} ${sentence(cameraSentences[shot.cameraMove])} ${sentence(shot.cameraPath)} ${sentence(shot.axis)} ${sentence(shot.cameraPurpose)} ${action} ${voiceLines.join(' ')}`.trim();
  });
  sections[sections.length - 1] += ` At the end: ${describeState(plan.exitState)} Keep character identities and the spatial landmarks sharp and readable; motion streaks stay localized to moving limbs, fabric and equipment. No full-frame motion blur, no fog wash, no camera shake. No on-screen captions or production text.`;
  const body = sections.join('\n');
  const header = conditioning.mode === 'I2VA' ? `${FILM_I2VA_HEADER}\n\n` : '';
  const core = format === 'h3-base-v1'
    ? `integrated_multimodal_description:\n${sentence(summary)} ${body}`
    : `summary:\n${summary.trim()}\n\ndetailed_description:\n${body}`;
  const prompt = `${header}${core}\n\noverall_soundscape:\n${plan.soundscape.trim()}\n\nnon_diegetic_music:\n${plan.music.trim()}`;
  if (englishWordCount(prompt) > FILM_PROMPT_MAX_ENGLISH_WORDS) throw new Error('Compiled H3 prompt exceeds 8000 English words; simplify repeated anchors and choreography');
  return { prompt, audit: {
    compilerVersion: 'film-compiler-v1', format, conditioning,
    planSha256: createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
    promptSha256: createHash('sha256').update(prompt).digest('hex'),
  } };
}
