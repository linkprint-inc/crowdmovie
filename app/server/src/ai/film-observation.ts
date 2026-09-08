import { FILM_STATE_SCHEMA, validateFilmState, type FilmPlan, type FilmState } from './film-plan.js';

export interface ObserveFilmInput {
  roundId: string; videoSha256: string; plan: FilmPlan;
  frames: Array<{ seconds: number; sha256: string; dataUrl: string }>;
  contactSheet: { sha256: string; dataUrl: string };
}
export interface FilmObservation {
  version: 'film-observation-v1';
  findings: Array<{ category: 'identity' | 'location' | 'contact' | 'outcome' | 'state'; verdict: 'matched' | 'mismatch' | 'uncertain'; frame: number; evidence: string }>;
  endState: FilmState;
  confidence: number;
}
export interface FilmObservationRecord {
  videoSha256: string;
  contactSheetSha256: string;
  frames: Array<{ seconds: number; sha256: string }>;
  observation: FilmObservation;
  acceptedEndState: FilmState | null;
}
export const FILM_OBSERVATION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['version', 'findings', 'endState', 'confidence'],
  properties: {
    version: { type: 'string', const: 'film-observation-v1' },
    findings: { type: 'array', minItems: 5, maxItems: 5, items: {
      type: 'object', additionalProperties: false, required: ['category', 'verdict', 'frame', 'evidence'],
      properties: {
        category: { type: 'string', enum: ['identity', 'location', 'contact', 'outcome', 'state'] },
        verdict: { type: 'string', enum: ['matched', 'mismatch', 'uncertain'] },
        frame: { type: 'integer', minimum: 0, maximum: 4 }, evidence: { type: 'string', minLength: 1, maxLength: 1000 },
      },
    } },
    endState: FILM_STATE_SCHEMA,
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
};

export function validateFilmObservation(value: FilmObservation, input: ObserveFilmInput): void {
  if (value.version !== 'film-observation-v1' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) throw new Error('Invalid film observation confidence/version');
  validateFilmState(value.endState);
  if (!Array.isArray(value.findings) || value.findings.length !== 5 || new Set(value.findings.map((f) => f.category)).size !== 5) throw new Error('Observation must cover all five categories once');
  for (const finding of value.findings) {
    if (!['identity', 'location', 'contact', 'outcome', 'state'].includes(finding.category) || !['matched', 'mismatch', 'uncertain'].includes(finding.verdict) || !Number.isInteger(finding.frame) || !input.frames[finding.frame] || !finding.evidence?.trim()) throw new Error('Observation needs a real frame reference and visible evidence');
  }
  const expectedNames = new Set([...input.plan.entryState.characters, ...input.plan.exitState.characters].map((c) => c.name));
  if (value.endState.characters.some((c) => !expectedNames.has(c.name))) throw new Error('Observation introduced an unrecognized character identity');
}

export function recordFilmObservation(input: ObserveFilmInput, observation: FilmObservation): FilmObservationRecord {
  validateFilmObservation(observation, input);
  // This is a sampled visual observation, not proof of every frame or sound.
  // Canary evidence showed the model confidently repeating an invisible belt
  // item and a planned water trail. Confidence is not verification. v1 records
  // this as advice; a reviewed state must be accepted separately against its
  // source hash before it can replace persisted continuity targets.
  return { videoSha256: input.videoSha256, contactSheetSha256: input.contactSheet.sha256, frames: input.frames.map(({ seconds, sha256 }) => ({ seconds, sha256 })), observation,
    acceptedEndState: null };
}
