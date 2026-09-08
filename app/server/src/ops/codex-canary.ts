// A single-call, no-database, no-GPU production canary for the real Qwen
// scoring route: LAN endpoint -> no-thinking JSON -> application validator.
//
// It deliberately does not enqueue a workflow job or write ai_runs. A canary
// must never become a public submission, advance a round, or reach FastH3.
// Run the built script as the crowdmovie service user so it reads the same
// CODEX_HOME as crowdmovie-codex-worker.service.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getEngineRunMetadata,
  type ContentEngine,
  type ScoreSubmissionInput,
} from '../ai/engine.js';
import {
  createCodexEngine,
  type DirectorThreadStore,
} from '../ai/codex.js';
import { validateScore } from '../ai/validate.js';

export const CODEX_CANARY_SUBMISSION_ID =
  '00000000-0000-4000-8000-000000000001';

export const CODEX_CANARY_INPUT: ScoreSubmissionInput = {
  submissionId: CODEX_CANARY_SUBMISSION_ID,
  kind: 'next_shot',
  content:
    '贝吉塔大战超人，给我拍这个场景，贝吉塔发的冲击波和超人的眼中发的激光对中抵消。',
  episodeTitle: 'Internal Qwen score canary — never published',
  episodeTheme:
    'Famous figures from movies, games, animation, comics, history and fine art collide anywhere.',
  recentScenes: [
    {
      sceneIndex: 0,
      summaryZh: '内部测试前情：上一场战斗刚结束。',
      durationSeconds: 5,
    },
  ],
};

export interface CodexCanaryResult {
  ok: true;
  canary: 'submission_score';
  provider: string;
  model: string;
  reasoningEffort: 'none';
  latencyMs: number;
  threadId: string | null;
  usage: unknown;
  attempts: number;
  eligible: boolean;
  scoreTotal: number;
  rubricVersion: string;
  databaseWrites: false;
  gpuRequested: false;
}

/** Run the canary against an injected engine so the boundary is unit-testable. */
export async function runCodexScoreCanary(
  engine: ContentEngine,
): Promise<CodexCanaryResult> {
  const started = Date.now();
  const output = await engine.scoreSubmission(CODEX_CANARY_INPUT);
  const latencyMs = Date.now() - started;
  validateScore(output, CODEX_CANARY_SUBMISSION_ID);
  const metadata = getEngineRunMetadata(output);
  if (metadata === undefined) {
    throw new Error('score canary returned no audit metadata');
  }

  const provider = metadata.identity?.provider ?? engine.identity.provider;
  if (provider !== 'qwen_vllm') {
    throw new Error(`score canary used unexpected provider ${provider}`);
  }
  if (metadata?.reasoningEffort !== 'none') {
    throw new Error('score canary did not disable thinking');
  }

  return {
    ok: true,
    canary: 'submission_score',
    provider,
    model: metadata.identity?.model ?? engine.identity.model,
    reasoningEffort: 'none',
    latencyMs,
    threadId: metadata.threadId ?? null,
    usage: metadata.usage,
    attempts: metadata.attempts ?? 1,
    eligible: output.eligible,
    scoreTotal: output.scoreTotal,
    rubricVersion: output.rubricVersion,
    databaseWrites: false,
    gpuRequested: false,
  };
}

class CanaryDirectorThreadStore implements DirectorThreadStore {
  async load(): Promise<string | null> {
    throw new Error('Codex score canary must not load the director thread');
  }

  async save(): Promise<void> {
    throw new Error('Codex score canary must not save the director thread');
  }
}

const ALLOWED_CANARY_MODELS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
]);

function canaryModel(env: NodeJS.ProcessEnv): string {
  const model = env.CODEX_CANARY_MODEL ?? env.CODEX_MODEL ?? 'gpt-5.6-sol';
  if (!ALLOWED_CANARY_MODELS.has(model)) {
    throw new Error(
      `CODEX_CANARY_MODEL must be one of: ${[...ALLOWED_CANARY_MODELS].join(', ')}`,
    );
  }
  return model;
}

function canaryTimeout(env: NodeJS.ProcessEnv): number {
  const raw = env.CODEX_CANARY_TIMEOUT_SECONDS ?? '300';
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 30 || value > 600) {
    throw new Error(
      'CODEX_CANARY_TIMEOUT_SECONDS must be an integer from 30 to 600',
    );
  }
  return value;
}

export function createRealCanaryEngine(
  env: NodeJS.ProcessEnv = process.env,
): ContentEngine {
  return createCodexEngine(
    {
      CODEX_SCORE_MODEL: canaryModel(env) as
        | 'gpt-5.6-sol'
        | 'gpt-5.6-terra',
      CODEX_MODEL: 'gpt-5.6-sol',
      CODEX_WORKSTATION_DIR:
        env.CODEX_WORKSTATION_DIR ?? '/opt/crowdmovie/workstation',
      CODEX_SCORE_REASONING_EFFORT: 'high',
      CODEX_FINAL_REASONING_EFFORT: 'xhigh',
      CODEX_DIRECTOR_REASONING_EFFORT: 'xhigh',
      // One bounded same-thread repair is enough to prove that cross-field
      // validation failures can be corrected without turning this into a
      // quota-consuming retry loop.
      CODEX_OUTPUT_RETRIES: 1,
      CODEX_TURN_TIMEOUT_SECONDS: canaryTimeout(env),
    },
    {
      directorThreads: new CanaryDirectorThreadStore(),
      codexEnv: env,
    },
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const result = await runCodexScoreCanary(createRealCanaryEngine());
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`[crowdmovie] Qwen score canary failed: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
