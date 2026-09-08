// A real Qwen/no-thinking director canary that stops at FastH3 validation-only
// endpoint. It writes no database rows, saves no production director thread,
// creates no workflow job and never reaches ComfyUI generation.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getEngineRunMetadata,
  type ContentEngine,
  type DirectSceneInput,
} from '../ai/engine.js';
import {
  createCodexEngine,
  type DirectorThreadStore,
} from '../ai/codex.js';
import { validateDirector } from '../ai/validate.js';
import {
  H3GatewayClient,
  type H3Capabilities,
  type H3WorkflowValidation,
} from '../h3/gateway.js';

export const DIRECTOR_CANARY_ROUND_ID =
  '00000000-0000-4000-8000-000000000002';
export const DIRECTOR_CANARY_SUBMISSION_ID =
  '00000000-0000-4000-8000-000000000003';

interface DirectorCanaryGateway {
  getCapabilities(): Promise<H3Capabilities>;
  validateWorkflow(
    roundId: string,
    output: Awaited<ReturnType<ContentEngine['directScene']>>,
  ): Promise<H3WorkflowValidation>;
}

export interface CodexDirectorCanaryResult {
  ok: true;
  canary: 'scene_director';
  provider: string;
  model: string;
  reasoningEffort: 'none';
  latencyMs: number;
  threadId: null;
  usage: unknown;
  attempts: number;
  durationSeconds: number;
  workflowNodeCount: number;
  gatewayValidated: true;
  generationSubmitted: false;
  databaseWrites: false;
  gpuRequested: false;
}

function directorInput(capabilities: H3Capabilities): DirectSceneInput {
  return {
    roundId: DIRECTOR_CANARY_ROUND_ID,
    episodeIndex: 1,
    episodeTitle: 'Internal director canary — never published',
    episodeTheme:
      '葫芦娃 and the one-eared Van Gogh self-portrait collide inside a crisp high-detail 3D fighting-game version of Versailles.',
    selectedSubmission: {
      id: DIRECTOR_CANARY_SUBMISSION_ID,
      content:
        "Inside a crisp high-detail 3D fighting-game version of ruined Versailles, render 葫芦娃 and the one-eared Van Gogh self-portrait as recognizable fighters. Keep a stabilized medium-wide gameplay camera and make the monumental broken architecture, gilded frames, weathered stone, floor seams and loose debris sharp and readable. 葫芦娃 is already vaulting over the portrait's swinging gilded frame; stage their collision with grounded weight, punishing contact and reactive debris. Use only localized character and impact streaks: no full-frame motion blur, no depth-of-field blur, no fog wash, no camera shake. Keep 葫芦娃 written in Chinese.",
      authorUsername: 'internal_canary',
    },
    selectionMode: 'ai',
    recentScenes: [
      {
        sceneIndex: 0,
        summaryZh: 'Internal canary context: a Versailles gallery wall has just split behind them.',
        durationSeconds: 5,
      },
    ],
    previousScene: null,
    h3Capabilities: capabilities,
  };
}

export async function runCodexDirectorCanary(
  engine: ContentEngine,
  gateway: DirectorCanaryGateway,
): Promise<CodexDirectorCanaryResult> {
  const capabilities = await gateway.getCapabilities();
  const input = directorInput(capabilities);
  const started = Date.now();
  const output = await engine.directScene(input);
  const latencyMs = Date.now() - started;
  validateDirector(output, {
    roundId: DIRECTOR_CANARY_ROUND_ID,
    selectedSubmissionId: DIRECTOR_CANARY_SUBMISSION_ID,
    capabilitiesVersion: capabilities.version,
    previousEndFrameSha256: null,
  });
  const gatewayValidation = await gateway.validateWorkflow(
    DIRECTOR_CANARY_ROUND_ID,
    output,
  );
  const metadata = getEngineRunMetadata(output);
  if (metadata === undefined) {
    throw new Error('director canary returned no audit metadata');
  }
  const provider = metadata.identity?.provider ?? engine.identity.provider;
  const model = metadata.identity?.model ?? engine.identity.model;
  if (provider !== 'qwen_vllm') {
    throw new Error(`director canary used unexpected model ${provider}/${model}`);
  }
  if (metadata.reasoningEffort !== 'none') {
    throw new Error('director canary did not disable thinking');
  }
  if (metadata.threadId !== null) {
    throw new Error('Qwen director canary unexpectedly returned a thread id');
  }
  if (gatewayValidation.generationSubmitted) {
    throw new Error('FastH3 validation unexpectedly submitted generation');
  }

  return {
    ok: true,
    canary: 'scene_director',
    provider,
    model,
    reasoningEffort: 'none',
    latencyMs,
    threadId: null,
    usage: metadata.usage,
    attempts: metadata.attempts ?? 1,
    durationSeconds: output.durationSeconds,
    workflowNodeCount: gatewayValidation.nodeCount,
    gatewayValidated: true,
    generationSubmitted: false,
    databaseWrites: false,
    gpuRequested: false,
  };
}

class MemoryDirectorThreadStore implements DirectorThreadStore {
  private threadId: string | null = null;

  async load(): Promise<string | null> {
    return this.threadId;
  }

  async save(threadId: string): Promise<void> {
    this.threadId = threadId;
  }
}

function canaryTimeout(env: NodeJS.ProcessEnv): number {
  const raw = env.CODEX_DIRECTOR_CANARY_TIMEOUT_SECONDS ?? '600';
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 30 || value > 1200) {
    throw new Error(
      'CODEX_DIRECTOR_CANARY_TIMEOUT_SECONDS must be an integer from 30 to 1200',
    );
  }
  return value;
}

export function createRealDirectorCanary(
  env: NodeJS.ProcessEnv = process.env,
): { engine: ContentEngine; gateway: H3GatewayClient } {
  const engine = createCodexEngine(
    {
      CODEX_SCORE_MODEL: 'gpt-5.6-terra',
      CODEX_MODEL: 'gpt-5.6-sol',
      CODEX_WORKSTATION_DIR:
        env.CODEX_WORKSTATION_DIR ?? '/opt/crowdmovie/workstation',
      CODEX_SCORE_REASONING_EFFORT: 'high',
      CODEX_FINAL_REASONING_EFFORT: 'xhigh',
      CODEX_DIRECTOR_REASONING_EFFORT: 'xhigh',
      // Match the production config default: one initial response plus two
      // bounded same-schema repairs. A canary with fewer attempts can report a
      // false outage for a package production would still correct safely.
      CODEX_OUTPUT_RETRIES: 2,
      CODEX_TURN_TIMEOUT_SECONDS: canaryTimeout(env),
    },
    {
      directorThreads: new MemoryDirectorThreadStore(),
      codexEnv: env,
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
    const { engine, gateway } = createRealDirectorCanary();
    const result = await runCodexDirectorCanary(engine, gateway);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(
      `[crowdmovie] Qwen director canary failed: ${(error as Error).message}`,
    );
    process.exitCode = 1;
  }
}
