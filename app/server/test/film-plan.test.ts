import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { compileFilmPrompt, selectFilmConditioning, validateFilmPlan } from '../src/ai/film-plan';
import { validateDirector } from '../src/ai/validate';
import type { DirectSceneOutput, PreviousScene } from '../src/ai/engine';
import { englishWordCount } from '../src/lib/english-words';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/film-director-v2.json', import.meta.url), 'utf8')) as DirectSceneOutput;
const fresh = () => {
  const d = structuredClone(fixture);
  const compiled = compileFilmPrompt(d.filmPlan!, d.sceneSummaryZh, d.dialogueEn, d.durationSeconds, d.filmPromptAudit!.conditioning);
  d.h3PromptEn = compiled.prompt; d.filmPromptAudit = compiled.audit;
  d.comfyuiWorkflow.prompt['7'].inputs.prompt = compiled.prompt;
  return d;
};
const previous = (output: DirectSceneOutput): PreviousScene => ({
  sceneIndex: 1, summaryZh: output.sceneSummaryZh, durationSeconds: output.durationSeconds,
  h3PromptEn: output.h3PromptEn, continuityUpdates: [], motionContextId: null,
  endFrame: { image: '/media/test.end.png', sha256: 'a'.repeat(64) }, filmPlan: output.filmPlan, filmPromptAudit: output.filmPromptAudit,
});

test('Qwen causal package retains contact, reaction and result through the final workflow', () => {
  const d = fresh();
  validateDirector(d, { roundId: 'd26e8a9c-c38c-4826-a3e9-536e87e05fd9', selectedSubmissionId: d.selectedSubmissionId, capabilitiesVersion: 'h3-capabilities-v6' });
  expect(d.comfyuiWorkflow.prompt['7'].inputs.prompt).toBe(d.h3PromptEn);
  expect(d.h3PromptEn).toContain("Batman’s chest");
  expect(d.h3PromptEn).toContain("Water squeezes into a narrow trail");
  expect(d.h3PromptEn).not.toContain('stabilized medium-wide gameplay camera');
  d.h3PromptEn = d.h3PromptEn.replace('Water squeezes into a narrow trail', 'The stone stays dry');
  d.comfyuiWorkflow.prompt['7'].inputs.prompt = d.h3PromptEn;
  expect(() => validateDirector(d, { roundId: 'd26e8a9c-c38c-4826-a3e9-536e87e05fd9', selectedSubmissionId: d.selectedSubmissionId, capabilitiesVersion: 'h3-capabilities-v6' })).toThrow('differs from the accepted plan');
});

test('T2VA reset does not change the story relation, location or inherited damage', () => {
  const first = fresh(); const plan = structuredClone(first.filmPlan!);
  plan.storyRelation = 'same-event'; plan.entryState = structuredClone(plan.exitState);
  const a = selectFilmConditioning(plan, previous(first));
  expect(a.mode).toBe('I2VA');
  const second = { ...first, filmPromptAudit: { ...first.filmPromptAudit!, conditioning: a } };
  const b = selectFilmConditioning(plan, previous(second));
  expect(b.mode).toBe('T2VA'); expect(b.resetReason).toBe('tail-depth-limit');
  validateFilmPlan(plan, 8, first.filmPlan!.exitState);
  plan.entryState.locationId = 'sunlit-courtyard'; plan.exitState.locationId = 'sunlit-courtyard';
  expect(() => validateFilmPlan(plan, 8, first.filmPlan!.exitState)).not.toThrow();
});

test('code accepts director decisions about items, injuries, exits and poses', () => {
  const d = fresh(); const p = d.filmPlan!;
  p.storyRelation = 'same-event'; p.entryState = structuredClone(p.exitState);
  const old = structuredClone(p.exitState);
  old.characters[0].heldObjects = 'None; web-shooter lies beside the left vent';
  expect(() => validateFilmPlan(p, 8, old)).not.toThrow();
  old.characters[0] = structuredClone(p.entryState.characters[0]); old.characters[0].presence = 'exited';
  expect(() => validateFilmPlan(p, 8, old)).not.toThrow();
  old.characters[0] = structuredClone(p.entryState.characters[0]); old.characters[0].pose = 'Kneeling with left palm down';
  expect(() => validateFilmPlan(p, 8, old)).not.toThrow();
  p.exitState.persistentChanges = [];
  expect(() => validateFilmPlan(p, 8)).not.toThrow();
});

test('ordered cuts survive both supported H3 formats and keep exact speech once', () => {
  const d = fresh(); const p = d.filmPlan!;
  const next = structuredClone(p.shots[0]); next.startSeconds = 4; next.framing = 'medium';
  p.shots.push(next); p.voices = [{ speaker: 'Batman', description: 'low restrained baritone' }];
  const dialogue = [{ speaker: 'Batman', startSeconds: 4.5, endSeconds: 5.5, line: 'Try again.' }];
  for (const format of ['h3-four-section-v1', 'h3-base-v1'] as const) {
    const { prompt, audit } = compileFilmPrompt(p, 'A block costs Batman ground.', dialogue, 8, d.filmPromptAudit!.conditioning, format);
    expect(prompt).toContain('[Shot 2] At 00:04.000');
    expect(prompt.match(/<d>\[English\] Try again\.<\/d>/g)).toHaveLength(1);
    expect(audit.promptSha256).toBe(createHash('sha256').update(prompt).digest('hex'));
  }
  p.shots[1].startSeconds = 7;
  expect(() => compileFilmPrompt(p, 'A block costs Batman ground.', [], 8, d.filmPromptAudit!.conditioning)).toThrow('at least 1.5');
});

test('a replacement has a filmed exit, flight close-up and matched wide landing in order', () => {
  const d = fresh(); const p = d.filmPlan!;
  const spidey = p.exitState.characters.find((c) => c.name === 'Spider-Man')!;
  spidey.presence = 'exited'; spidey.position = 'Outside the right railing, hanging below the lower ledge';
  const superman = { name: 'Superman', appearance: 'Blue suit, red cape and S chest emblem', position: 'Inside the right railing beside the stairwell', pose: 'Both boots planted, knees soft', heldObjects: 'None', condition: 'Uninjured', presence: 'active' as const };
  p.exitState.characters.push(superman);
  const first = p.shots[0];
  first.beats = [{ action: 'Batman strikes upward below Spider-Man’s ribs', responseBeforeContact: 'None', contact: 'Forearm meets the lower ribs', reaction: 'Spider-Man folds and loses both footholds', materialResponse: 'Loose grit slides from the ledge', outcome: 'Spider-Man catches the outside ledge below the fighting floor', sound: 'A short impact then grit patters',
    passage: { character: 'Spider-Man', kind: 'exit', phase: 'complete', origin: 'Wet stone inside the front railing', mechanism: 'The upward impact launches his body backward', path: 'Above the bent bar, then down onto the exterior ledge', finalPosition: spidey.position, cutMatch: 'Hold the wide view until the fighting floor is visibly clear' } }];
  const approach = structuredClone(first); approach.startSeconds = 4; approach.framing = 'close-up';
  approach.beats = [{ action: 'Superman flies left to right with his right fist leading', responseBeforeContact: 'None', contact: 'None', reaction: 'His cape streams behind as he banks downward', materialResponse: 'None', outcome: 'The stairwell roof passes behind his shoulder', sound: 'Air rushes past the cape',
    passage: { character: 'Superman', kind: 'arrival', phase: 'approach', origin: 'Above the distant skyline', mechanism: 'Self-propelled flight', path: 'Left to right toward the brick stairwell, then down toward the clear right side', finalPosition: 'Above the right railing', cutMatch: 'Cut on the downward bank; keep the stairwell behind his right shoulder and preserve left-to-right travel' } }];
  approach.beats[0].outcome = approach.beats[0].passage!.finalPosition;
  const landing = structuredClone(approach); landing.startSeconds = 6; landing.framing = 'wide';
  landing.beats[0] = { ...landing.beats[0], action: 'Superman continues the downward bank and slows upright', contact: 'Both boots touch wet stone', reaction: 'His knees bend and cape settles', materialResponse: 'Water fans outward from the soles', outcome: 'Superman stands opposite Batman', passage: { ...approach.beats[0].passage!, phase: 'complete', origin: 'Above the right railing', path: 'Down inside the right railing beside the stairwell', finalPosition: superman.position } };
  p.shots = [first, approach, landing];
  const { prompt } = compileFilmPrompt(p, 'A visible exit clears space for Superman’s flying arrival.', [], 9, d.filmPromptAudit!.conditioning);
  expect(prompt.indexOf('completes the exit')).toBeLessThan(prompt.indexOf('[Shot 2]'));
  expect(prompt).toContain('[Shot 2] At 00:04.000, the camera cuts to a close-up');
  expect(prompt).toContain('[Shot 3] At 00:06.000');
  expect(prompt).toContain('Water fans outward from the soles');
  approach.beats[0].outcome = 'Superman lands on wet stone';
  expect(() => validateFilmPlan(p, 9)).not.toThrow();
  approach.beats[0].outcome = approach.beats[0].passage!.finalPosition;
  p.shots[0].beats[0].passage = null;
  expect(() => validateFilmPlan(p, 9)).not.toThrow();
  p.shots = [first];
  expect(() => validateFilmPlan(p, 9)).not.toThrow();
});

test('v6 accepts a complete prompt beyond the old 2000-word cap and rejects over 8000 words', () => {
  const d = fresh(); const p = d.filmPlan!;
  const detail = 'Stone stays wet and sharp. '.repeat(30);
  for (const beat of p.shots[0].beats) for (const key of ['action', 'responseBeforeContact', 'contact', 'reaction', 'materialResponse', 'outcome', 'sound'] as const) beat[key] = detail;
  p.shots[0].beats = Array.from({ length: 3 }, () => structuredClone(p.shots[0].beats[0]));
  const output = compileFilmPrompt(p, d.sceneSummaryZh, [], 8, d.filmPromptAudit!.conditioning);
  expect(englishWordCount(output.prompt)).toBeGreaterThan(2000);
  expect(englishWordCount(output.prompt)).toBeLessThan(8000);
  const dense = 'wet '.repeat(240);
  p.shots[0].beats = Array.from({ length: 4 }, () => ({ action: dense, responseBeforeContact: dense, contact: dense, reaction: dense, materialResponse: dense, outcome: dense, sound: dense }));
  p.shots.push({ ...structuredClone(p.shots[0]), startSeconds: 4, beats: [structuredClone(p.shots[0].beats[0])] });
  expect(() => compileFilmPrompt(p, d.sceneSummaryZh, [], 8, d.filmPromptAudit!.conditioning)).toThrow('8000');
});

test('story discontinuities do not block the compiler or final director gate', () => {
  const d = fresh(); const plan = d.filmPlan!;
  const inherited = structuredClone(plan.exitState);
  plan.entryState.characters = Array.from({ length: 4 }, (_, i) => ({ ...plan.entryState.characters[0], name: `Actor ${i}`, presence: 'active' as const }));
  plan.exitState.characters = [{ ...plan.exitState.characters[0], name: 'A new actor', presence: 'active' }];
  plan.exitState.persistentChanges = [];
  plan.exitState.locationId = 'a different location';
  plan.shots[0].cameraMove = 'static'; plan.shots[0].cameraPath = 'Fast arc around the arena';
  plan.shots[0].beats[0].passage = { character: 'Absent from state table', kind: 'arrival', phase: 'complete', origin: 'Sky', mechanism: 'Flight', path: 'Down', finalPosition: 'A new ledge', cutMatch: 'Close view' };
  const compiled = compileFilmPrompt(plan, d.sceneSummaryZh, d.dialogueEn, d.durationSeconds, d.filmPromptAudit!.conditioning);
  d.h3PromptEn = compiled.prompt; d.filmPromptAudit = compiled.audit; d.comfyuiWorkflow.prompt['7'].inputs.prompt = compiled.prompt;
  expect(() => validateDirector(d, { roundId: 'd26e8a9c-c38c-4826-a3e9-536e87e05fd9', selectedSubmissionId: d.selectedSubmissionId, capabilitiesVersion: 'h3-capabilities-v6', previousFilmState: inherited })).not.toThrow();
  d.comfyuiWorkflow.prompt['7'].inputs.prompt = 'tampered';
  expect(() => validateDirector(d, { roundId: 'd26e8a9c-c38c-4826-a3e9-536e87e05fd9', selectedSubmissionId: d.selectedSubmissionId, capabilitiesVersion: 'h3-capabilities-v6' })).toThrow();
});
