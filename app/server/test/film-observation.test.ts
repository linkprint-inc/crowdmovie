import { readFileSync } from 'node:fs';
import type { DirectSceneOutput } from '../src/ai/engine';
import { recordFilmObservation, type ObserveFilmInput, type FilmObservation } from '../src/ai/film-observation';
import { filmDirectorWireSchema, openAiOutputSchema } from '../src/ai/wire-schemas';
import Ajv from 'ajv';

const director = JSON.parse(readFileSync(new URL('./fixtures/film-director-v2.json', import.meta.url), 'utf8')) as DirectSceneOutput;

test('model confidence never promotes sampled visual claims into accepted continuity', () => {
  const input: ObserveFilmInput = { roundId: 'test', videoSha256: 'a'.repeat(64), plan: director.filmPlan!,
    frames: Array.from({ length: 5 }, (_, i) => ({ seconds: i, sha256: `${i}`.repeat(64), dataUrl: 'data:image/jpeg;base64,transient' })),
    contactSheet: { sha256: 'b'.repeat(64), dataUrl: 'data:image/jpeg;base64,transient' } };
  const value: FilmObservation = { version: 'film-observation-v1', confidence: 1, endState: director.filmPlan!.exitState,
    findings: (['identity', 'location', 'contact', 'outcome', 'state'] as const).map(category => ({ category, verdict: 'matched', frame: 4, evidence: 'A claimed match in the final frame' })) };
  const record = recordFilmObservation(input, value);
  expect(record.acceptedEndState).toBeNull();
  expect(JSON.stringify(record)).not.toContain('base64');
  value.findings[0].frame = 5;
  expect(() => recordFilmObservation(input, value)).toThrow('real frame');
});

test('previous story state is context and no longer pins generated openings', () => {
  const p = structuredClone(director.filmPlan!); p.storyRelation = 'same-event';
  for (const shot of p.shots) for (const beat of shot.beats) beat.passage = null;
  const schema = filmDirectorWireSchema(p.entryState);
  const validate = new Ajv({ strict: false }).compile(schema.properties.film_plan);
  p.entryState.environment = 'A sunny courtyard';
  expect(validate(p)).toBe(true);
  expect(filmDirectorWireSchema()).toEqual(schema);
  expect(openAiOutputSchema(schema)).toEqual(schema);
  expect(JSON.stringify(schema)).not.toContain('Copy this inherited value exactly');
  p.entryState.characters = 'invalid' as never;
  expect(validate(p)).toBe(false);
});
