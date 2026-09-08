import { readFileSync } from 'node:fs';
import { createCodexEngine } from '../src/ai/codex';
import { getEngineRunMetadata, type DirectSceneOutput } from '../src/ai/engine';

test('a v6 director repairs a rejected plan before H3 compilation while preserving the selected event', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/film-director-v2.json', import.meta.url), 'utf8')) as DirectSceneOutput;
  const wire: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fixture)) {
    if (key === 'filmPromptAudit') continue;
    wire[key.replace(/[A-Z]/g, (s) => `_${s.toLowerCase()}`)] = value;
  }
  wire.h3_prompt_en = ''; wire.comfyui_workflow = { prompt: {} };
  let directors = 0; let reviews = 0; const requests: string[] = [];
  const engine = createCodexEngine({ CODEX_SCORE_MODEL: 'gpt-5.6-terra', CODEX_MODEL: 'gpt-5.6-sol',
    CODEX_WORKSTATION_DIR: '/test', CODEX_SCORE_REASONING_EFFORT: 'high', CODEX_FINAL_REASONING_EFFORT: 'xhigh', CODEX_DIRECTOR_REASONING_EFFORT: 'xhigh', CODEX_OUTPUT_RETRIES: 1 }, {
    codex: { startThread: () => { throw new Error('Must use Qwen'); }, resumeThread: () => { throw new Error('Must use Qwen'); } },
    directorThreads: { load: async () => null, save: async () => { throw new Error('Must not save a Codex thread'); } },
    readTextFile: async () => 'Film plan contract: preserve the causal action and compile it deterministically.',
    qwen: { run: async (prompt, _schema, key) => {
      requests.push(prompt);
      if (key?.startsWith('plan-review:')) {
        reviews++;
        return { content: JSON.stringify({ selectedEventPreserved: true, causalOrderWorks: true, stateChangesAreFilmed: true, cameraShowsNecessaryContactAndFeet: true,
          durationHasNoLongIdlePadding: reviews > 1, issues: reviews === 1 ? ['duration_seconds: shorten this exchange to six seconds'] : [] }), model: 'qwen3.8-27b', usage: null, latencyMs: 1 };
      }
      directors++;
      return { content: JSON.stringify({ ...wire, duration_seconds: directors === 1 ? 8 : 6 }), model: 'qwen3.8-27b', usage: null, latencyMs: 1 };
    } },
  });
  const output = await engine.directScene({ roundId: 'd26e8a9c-c38c-4826-a3e9-536e87e05fd9', episodeIndex: 1, episodeTitle: 'Rooftop', episodeTheme: 'A physical exchange', selectedSubmission: { id: fixture.selectedSubmissionId!, authorUsername: 'test', content: `${fixture.sceneSummaryZh} Neither fighter leaves the rooftop.` },
    selectionMode: 'auto', recentScenes: [], previousScene: null, h3Capabilities: { version: 'h3-capabilities-v6' } });
  expect(directors).toBe(2); expect(reviews).toBe(2);
  expect(output.durationSeconds).toBe(6);
  expect(output.episodeShouldEnd).toBe(false);
  expect(output.filmPlanReview?.checks.durationHasNoLongIdlePadding).toBe(true);
  expect(getEngineRunMetadata(output)?.attempts).toBe(2);
  expect(requests[2]).toContain('Film plan review rejected');
  expect(output.h3PromptEn.indexOf('braces his raised left forearm')).toBeLessThan(output.h3PromptEn.indexOf("left forearm meets Spider-Man's right foot"));
});

test.each(['success', 'invalid', 'review-rejected'] as const)('Astra low takes over after exactly two Qwen failures: %s', async (mode) => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/film-director-v2.json', import.meta.url), 'utf8')) as DirectSceneOutput;
  for (const shot of fixture.filmPlan!.shots) for (const beat of shot.beats) beat.passage ??= null;
  const wire = Object.fromEntries(Object.entries(fixture).filter(([key]) => key !== 'filmPromptAudit').map(([key, value]) => [key.replace(/[A-Z]/g, (s) => `_${s.toLowerCase()}`), value]));
  wire.h3_prompt_en = ''; wire.comfyui_workflow = { prompt: {} };
  let qwenAttempts = 0; let solAttempts = 0;
  const engine = createCodexEngine({ CODEX_SCORE_MODEL: 'gpt-5.6-terra', CODEX_MODEL: 'gpt-5.6-sol',
    CODEX_WORKSTATION_DIR: '/test', CODEX_SCORE_REASONING_EFFORT: 'high', CODEX_FINAL_REASONING_EFFORT: 'xhigh', CODEX_DIRECTOR_REASONING_EFFORT: 'xhigh', CODEX_OUTPUT_RETRIES: 1 }, {
    codex: { startThread: (options) => {
      expect(qwenAttempts).toBe(2);
      expect(options).toMatchObject({ model: 'gpt-6-astra', modelReasoningEffort: 'low', workingDirectory: '/tmp', approvalPolicy: 'never' });
      return { id: 'sol-takeover', run: async (prompt) => {
        solAttempts++;
        expect(prompt).toContain('Film plan contract');
        if (solAttempts === 1) expect(prompt).toContain('Qwen unavailable');
        return { items: [], finalResponse: mode === 'invalid' ? '{}' : JSON.stringify(wire), usage: null };
      } };
    }, resumeThread: () => { throw new Error('Must use isolated thread'); } },
    directorThreads: { load: async () => null, save: async () => { throw new Error('Must not persist thread'); } },
    readTextFile: async () => 'Film plan contract',
    qwen: { run: async (_prompt, _schema, key) => {
      if (!key?.startsWith('plan-review:')) { qwenAttempts++; throw new Error('Qwen unavailable'); }
      return { content: JSON.stringify({ selectedEventPreserved: true, causalOrderWorks: true, stateChangesAreFilmed: true,
        cameraShowsNecessaryContactAndFeet: true, durationHasNoLongIdlePadding: mode !== 'review-rejected', issues: ['review gate'] }), model: 'qwen-review', usage: null, latencyMs: 1 };
    } },
  });
  const result = engine.directScene({ roundId: 'd26e8a9c-c38c-4826-a3e9-536e87e05fd9', episodeIndex: 1, episodeTitle: 'Rooftop', episodeTheme: 'A physical exchange',
    selectedSubmission: { id: fixture.selectedSubmissionId!, authorUsername: 'test', content: `${fixture.sceneSummaryZh} Neither fighter leaves the rooftop.` },
    selectionMode: 'auto', recentScenes: [], previousScene: null, h3Capabilities: { version: 'h3-capabilities-v6' } });
  if (mode === 'success') {
    expect(getEngineRunMetadata(await result)).toMatchObject({ identity: { provider: 'openai_codex', model: 'gpt-6-astra' }, reasoningEffort: 'low', threadId: 'sol-takeover' });
    expect(solAttempts).toBe(1);
  } else {
    await expect(result).rejects.toThrow(mode === 'review-rejected' ? /Film plan review rejected/ : /Astra takeover failed/);
    expect(solAttempts).toBe(2);
  }
  expect(qwenAttempts).toBe(2);
});
