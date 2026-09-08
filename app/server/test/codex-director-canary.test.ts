import { readFileSync } from 'node:fs';

import {
  attachEngineRunMetadata,
  type ContentEngine,
  type DirectSceneInput,
  type DirectSceneOutput,
} from '../src/ai/engine';
import type {
  H3Capabilities,
  H3WorkflowValidation,
} from '../src/h3/gateway';
import {
  DIRECTOR_CANARY_ROUND_ID,
  DIRECTOR_CANARY_SUBMISSION_ID,
  createRealDirectorCanary,
  runCodexDirectorCanary,
} from '../src/ops/codex-director-canary';

const capabilities: H3Capabilities = {
  version: 'h3-capabilities-v5',
  fps: 24,
  sizes: [[1344, 768]],
  node_classes: [
    'MiniMaxH3ImageToVideo',
    'MiniMaxH3PDDAccApply',
    'LoadImage',
  ],
  models: {},
  fixed_parameters: { steps: 8, nfe: '8' },
  style_profile: 'whos-next-spiderman-batman-quality-reference-v8',
  style_enforced: true,
  character_profile: 'whos-next-famous-cast-v3',
  character_enforced: true,
};

function directorOutput(
  threadId: string | null,
  provider = 'qwen_vllm',
): DirectSceneOutput {
  const h3Prompt =
    'summary:\nReimu Hakurei and Marisa Kirisame collide inside a crisp high-detail 3D fighting-game cafeteria arena.\n\ndetailed_description:\nA stabilized medium-wide gameplay camera tracks slowly sideways while keeping the entire cafeteria arena sharp and readable: clean tile seams, stainless counters, vending machines, tables, chairs, ceiling panels, and bright practical lighting remain in clear focus. Reimu Hakurei unplugs the vending machine as Marisa Kirisame rushes forward and blocks her escape with a grounded shoulder check. Fast character motion has only localized limb, clothing and impact streaks; no full-frame motion blur, no depth-of-field blur, no fog wash, no camera shake. Strong readable silhouettes, hard impacts and reactive loose objects preserve the exact action.\n\noverall_soundscape:\nQuiet cafeteria room tone, plug snap, grounded shoulder impact, shoes scraping tile, loose trays rattling.\n\nnon_diegetic_music:\nOriginal tense electronic percussion with a driving arcade-fighting rhythm; no recognizable theme music.';
  const workflow = JSON.parse(
    readFileSync(
      new URL('../../../ops/fasth3/workflow_api.json', import.meta.url),
      'utf8',
    ),
  ) as Record<string, { inputs: Record<string, unknown>; class_type: string }>;
  workflow['7'].inputs.prompt = h3Prompt;
  workflow['7'].inputs.length = 124;
  workflow['15'].inputs.filename_prefix = `video/FastH3/${DIRECTOR_CANARY_ROUND_ID}`;
  return attachEngineRunMetadata(
    {
      selectedSubmissionId: DIRECTOR_CANARY_SUBMISSION_ID,
      creditUsername: 'internal_canary',
      sceneSummaryZh: 'Reimu unplugs the vending machine while Marisa defends it.',
      durationSeconds: 5,
      continuityFromPrevious: 'This continues the indoor lunch period.',
      shotRelation: 'new_shot',
      usePreviousEndFrame: false,
      useMotionContext: false,
      h3PromptEn: h3Prompt,
      dialogueEn: [],
      continuityUpdates: [],
      episodeShouldEnd: false,
      episodeEndReason: null,
      comfyuiWorkflow: { prompt: workflow },
      comfyuiCapabilitiesVersion: capabilities.version,
      directorSchemaVersion: 'scene-director-v1',
    },
    {
      threadId,
      usage: { input_tokens: 500, output_tokens: 200 },
      identity: {
        provider,
        model:
          provider === 'qwen_vllm'
            ? 'qwen3.8-27b-huihui-abliterated-nvfp4'
            : 'gpt-5.6-sol',
      },
      reasoningEffort: provider === 'qwen_vllm' ? 'none' : 'xhigh',
      attempts: 1,
    },
  );
}

function fakeEngine(
  directScene: (input: DirectSceneInput) => Promise<DirectSceneOutput>,
): ContentEngine {
  const unsupported = async (): Promise<never> => {
    throw new Error('unexpected content function');
  };
  return {
    identity: { provider: 'openai_codex', model: 'gpt-5.6-sol' },
    scoreSubmission: unsupported,
    finalizeRound: unsupported,
    directScene,
    authorSubtitles: unsupported,
    proposeEpisodeTheme: unsupported,
  };
}

test('director canary validates Qwen no-thinking output without generation or DB writes', async () => {
  let seenInput: DirectSceneInput | undefined;
  let validatedOutput: DirectSceneOutput | undefined;
  const gateway = {
    getCapabilities: async () => capabilities,
    validateWorkflow: async (
      roundId: string,
      output: DirectSceneOutput,
    ): Promise<H3WorkflowValidation> => {
      expect(roundId).toBe(DIRECTOR_CANARY_ROUND_ID);
      validatedOutput = output;
      return {
        valid: true,
        roundId,
        capabilitiesVersion: capabilities.version,
        nodeCount: 15,
        styleEnforced: true,
        characterEnforced: true,
        generationSubmitted: false,
      };
    },
  };

  const result = await runCodexDirectorCanary(
    fakeEngine(async (input) => {
      seenInput = input;
      return directorOutput(null);
    }),
    gateway,
  );

  expect(seenInput).toMatchObject({
    roundId: DIRECTOR_CANARY_ROUND_ID,
    selectedSubmission: { id: DIRECTOR_CANARY_SUBMISSION_ID },
    h3Capabilities: { version: capabilities.version },
  });
  expect(validatedOutput).toBeDefined();
  expect(result).toMatchObject({
    ok: true,
    canary: 'scene_director',
    provider: 'qwen_vllm',
    model: 'qwen3.8-27b-huihui-abliterated-nvfp4',
    reasoningEffort: 'none',
    threadId: null,
    workflowNodeCount: 15,
    gatewayValidated: true,
    generationSubmitted: false,
    databaseWrites: false,
    gpuRequested: false,
  });
});

test('director canary rejects the wrong provider before reporting success', async () => {
  const wrongProvider = directorOutput('codex-thread', 'openai_codex');
  await expect(
    runCodexDirectorCanary(fakeEngine(async () => wrongProvider), {
      getCapabilities: async () => capabilities,
      validateWorkflow: async () => ({
        valid: true,
        roundId: DIRECTOR_CANARY_ROUND_ID,
        capabilitiesVersion: capabilities.version,
        nodeCount: 16,
        styleEnforced: true,
        characterEnforced: true,
        generationSubmitted: false,
      }),
    }),
  ).rejects.toThrow('unexpected model');
});

test('real director canary timeout is bounded', () => {
  expect(() =>
    createRealDirectorCanary({ CODEX_DIRECTOR_CANARY_TIMEOUT_SECONDS: '5' }),
  ).toThrow('CODEX_DIRECTOR_CANARY_TIMEOUT_SECONDS');
});
