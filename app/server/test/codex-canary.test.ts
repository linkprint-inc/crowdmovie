import {
  attachEngineRunMetadata,
  type ContentEngine,
  type ScoreSubmissionInput,
} from '../src/ai/engine';
import {
  CODEX_CANARY_SUBMISSION_ID,
  createRealCanaryEngine,
  runCodexScoreCanary,
} from '../src/ops/codex-canary';

type ScoreResult = Awaited<
  ReturnType<ContentEngine['scoreSubmission']>
>;

function fakeEngine(
  scoreSubmission: (input: ScoreSubmissionInput) => Promise<ScoreResult>,
): ContentEngine {
  const unsupported = async (): Promise<never> => {
    throw new Error('unexpected content function');
  };
  return {
    identity: { provider: 'openai_codex', model: 'gpt-5.6-sol' },
    scoreSubmission,
    finalizeRound: unsupported,
    directScene: unsupported,
    authorSubtitles: unsupported,
    proposeEpisodeTheme: unsupported,
  };
}

const validOutput = attachEngineRunMetadata(
  {
    submissionId: CODEX_CANARY_SUBMISSION_ID,
    eligible: true,
    scoreTotal: 78,
    scoreBreakdown: {
      continuity: 24,
      filmability15s: 22,
      characterConsistency: 16,
      dramaticValue: 10,
      originality: 6,
    },
    reason: 'The scene is bounded, visual and continuous.',
    publicRoast: {
      en: 'The vending machine has more situational awareness than the adults.',
      'zh-CN': '自动售货机都比大人更懂现场状况。',
      ja: '自販機のほうが大人より状況を理解している。',
      es: 'La máquina entiende mejor la situación que los adultos.',
    },
    riskFlags: [],
    rubricVersion: 'submission-score-v1',
  },
  {
    threadId: null,
    usage: { input_tokens: 100, output_tokens: 50 },
    identity: {
      provider: 'qwen_vllm',
      model: 'qwen3.8-27b-huihui-abliterated-nvfp4',
    },
    reasoningEffort: 'none',
    attempts: 1,
  },
);

test('score canary validates one Qwen no-thinking result without database or GPU work', async () => {
  let seen: ScoreSubmissionInput | undefined;
  const result = await runCodexScoreCanary(
    fakeEngine(async (input) => {
      seen = input;
      return validOutput;
    }),
  );

  expect(seen).toMatchObject({
    submissionId: CODEX_CANARY_SUBMISSION_ID,
    kind: 'next_shot',
    content: '贝吉塔大战超人，给我拍这个场景，贝吉塔发的冲击波和超人的眼中发的激光对中抵消。',
  });
  expect(result).toMatchObject({
    ok: true,
    canary: 'submission_score',
    provider: 'qwen_vllm',
    model: 'qwen3.8-27b-huihui-abliterated-nvfp4',
    reasoningEffort: 'none',
    threadId: null,
    attempts: 1,
    rubricVersion: 'submission-score-v1',
    databaseWrites: false,
    gpuRequested: false,
  });
});

test('score canary rejects a result that is not audited as Qwen no-thinking', async () => {
  const withoutThread = attachEngineRunMetadata(
    { ...validOutput },
    {
      threadId: null,
      usage: null,
      identity: { provider: 'openai_codex', model: 'gpt-5.6-terra' },
      reasoningEffort: 'high',
    },
  );
  await expect(
    runCodexScoreCanary(fakeEngine(async () => withoutThread)),
  ).rejects.toThrow('unexpected provider');
});

test('real canary config is bounded to supported models', () => {
  expect(
    createRealCanaryEngine({
      CODEX_CANARY_MODEL: 'gpt-5.6-terra',
      CODEX_CANARY_TIMEOUT_SECONDS: '120',
      CODEX_HOME: '/var/lib/crowdmovie/codex',
    }).identity,
  ).toEqual({ provider: 'openai_codex', model: 'gpt-5.6-sol' });

  expect(() =>
    createRealCanaryEngine({
      CODEX_CANARY_MODEL: 'floating-alias',
      CODEX_HOME: '/var/lib/crowdmovie/codex',
    }),
  ).toThrow('CODEX_CANARY_MODEL must be one of');
  expect(() =>
    createRealCanaryEngine({
      CODEX_CANARY_TIMEOUT_SECONDS: '5',
      CODEX_HOME: '/var/lib/crowdmovie/codex',
    }),
  ).toThrow('CODEX_CANARY_TIMEOUT_SECONDS');
});
