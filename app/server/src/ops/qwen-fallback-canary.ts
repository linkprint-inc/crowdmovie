// Backward-compatible command name for the no-database, validation-only LAN
// Qwen primary director canary. FastH3 validates the package
// but never submits generation, so this cannot publish or consume GPU work.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getEngineRunMetadata,
  type ContentEngine,
  type DirectSceneInput,
} from '../ai/engine.js';
import {
  createCodexEngine,
  type CodexLike,
  type DirectorThreadStore,
  type ThreadLike,
} from '../ai/codex.js';
import { validateDirector } from '../ai/validate.js';
import {
  H3GatewayClient,
  type H3Capabilities,
  type H3WorkflowValidation,
} from '../h3/gateway.js';

const ROUND_ID = '00000000-0000-4000-8000-000000000004';
const SUBMISSION_ID = '00000000-0000-4000-8000-000000000005';

class RefusingThread implements ThreadLike {
  readonly id = 'forced-copyright-refusal-canary';

  async run() {
    return {
      finalResponse:
        "I can't generate a prompt featuring these copyrighted characters.",
      usage: {
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
      },
    };
  }
}

class RefusingCodex implements CodexLike {
  startThread(): ThreadLike {
    return new RefusingThread();
  }

  resumeThread(): ThreadLike {
    return new RefusingThread();
  }
}

class MemoryDirectorStore implements DirectorThreadStore {
  async load(): Promise<string | null> {
    return null;
  }

  async save(): Promise<void> {
    throw new Error('Qwen primary canary must not save a Codex thread');
  }
}

interface ValidationGateway {
  getCapabilities(): Promise<H3Capabilities>;
  validateWorkflow(
    roundId: string,
    output: Awaited<ReturnType<ContentEngine['directScene']>>,
  ): Promise<H3WorkflowValidation>;
}

function input(capabilities: H3Capabilities): DirectSceneInput {
  return {
    roundId: ROUND_ID,
    episodeIndex: 1,
    episodeTitle: 'Internal Qwen primary canary — never published',
    episodeTheme:
      'Vegeta and Superman collide in a fast mixed-media action brawl.',
    selectedSubmission: {
      id: SUBMISSION_ID,
      content:
        'Vegeta fires his Galick Gun into Superman’s heat vision as the camera whip-pans around the collision. Vegeta shouts, "Try harder!"',
      authorUsername: 'internal_canary',
    },
    selectionMode: 'ai',
    recentScenes: [],
    previousScene: null,
    h3Capabilities: capabilities,
  };
}

export async function runQwenFallbackCanary(
  engine: ContentEngine,
  gateway: ValidationGateway,
) {
  const capabilities = await gateway.getCapabilities();
  const directorInput = input(capabilities);
  const started = Date.now();
  const output = await engine.directScene(directorInput);
  const latencyMs = Date.now() - started;
  validateDirector(output, {
    roundId: ROUND_ID,
    selectedSubmissionId: SUBMISSION_ID,
    capabilitiesVersion: capabilities.version,
    previousEndFrameSha256: null,
  });
  const validation = await gateway.validateWorkflow(ROUND_ID, output);
  const metadata = getEngineRunMetadata(output);
  if (metadata?.identity?.provider !== 'qwen_vllm') {
    throw new Error('Qwen primary canary did not route to qwen_vllm');
  }
  if (metadata.threadId !== null) {
    throw new Error('Qwen primary canary unexpectedly returned a Codex thread');
  }
  if (validation.generationSubmitted) {
    throw new Error('Qwen primary canary unexpectedly submitted generation');
  }
  return {
    ok: true as const,
    canary: 'qwen_primary_director' as const,
    provider: metadata.identity.provider,
    model: metadata.identity.model,
    latencyMs,
    durationSeconds: output.durationSeconds,
    dialogueLines: output.dialogueEn.length,
    workflowNodeCount: validation.nodeCount,
    gatewayValidated: true as const,
    generationSubmitted: false as const,
    databaseWrites: false as const,
    gpuRequested: false as const,
  };
}

function createCanary(env: NodeJS.ProcessEnv) {
  const engine = createCodexEngine(
    {
      CODEX_SCORE_MODEL: 'gpt-5.6-terra',
      CODEX_MODEL: 'gpt-5.6-sol',
      CODEX_WORKSTATION_DIR:
        env.CODEX_WORKSTATION_DIR ?? '/opt/crowdmovie/workstation',
      CODEX_SCORE_REASONING_EFFORT: 'high',
      CODEX_FINAL_REASONING_EFFORT: 'xhigh',
      CODEX_DIRECTOR_REASONING_EFFORT: 'xhigh',
      CODEX_OUTPUT_RETRIES: 0,
      CODEX_TURN_TIMEOUT_SECONDS: 30,
      QWEN_COPYRIGHT_FALLBACK_BASE_URL:
        env.QWEN_COPYRIGHT_FALLBACK_BASE_URL ??
        'http://192.168.10.30:8000/v1',
      QWEN_COPYRIGHT_FALLBACK_MODEL:
        env.QWEN_COPYRIGHT_FALLBACK_MODEL ??
        'qwen3.8-27b-huihui-abliterated-nvfp4',
      QWEN_COPYRIGHT_FALLBACK_TIMEOUT_MS: Number(
        env.QWEN_COPYRIGHT_FALLBACK_TIMEOUT_MS ?? 300000,
      ),
    },
    {
      codex: new RefusingCodex(),
      directorThreads: new MemoryDirectorStore(),
    },
  );
  return {
    engine,
    gateway: new H3GatewayClient(
      env.H3_BASE_URL ?? 'http://192.168.10.20:8191',
    ),
  };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const canary = createCanary(process.env);
    console.log(
      JSON.stringify(
        await runQwenFallbackCanary(canary.engine, canary.gateway),
      ),
    );
  } catch (error) {
    console.error(
      `[crowdmovie] Qwen primary canary failed: ${(error as Error).message}`,
    );
    process.exitCode = 1;
  }
}
