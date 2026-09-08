// T3.2 —《技术》§6.3 / §6.4 / §6.5 / §9.2 的输出校验。
//
// §6.7 and §17.23 make the code the only thing that decides flow, which is only
// true if content that breaks a documented rule is refused rather than repaired.
// Every rule stated as a number or an invariant in those sections gets a test
// here, driven through the same functions the handlers call.
//
// Invisible characters are written as `\u{...}` escapes throughout — see
// source-hygiene.test.ts.
import {
  type AuthorSubtitlesOutput,
  type DirectSceneOutput,
  type FinalizeRoundOutput,
  type ScoreSubmissionOutput,
} from '../src/ai/engine';
import { createStubEngine } from '../src/ai/stub';
import {
  assertEnglishCreativeSource,
  assertPlainTextCreativeSource,
  EngineOutputError,
  validateDirector,
  validateFinalize,
  validateScore,
  validateSubtitles,
} from '../src/ai/validate';

const SUBMISSION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const ROUND_ID = '33333333-3333-4333-8333-333333333333';

const engine = createStubEngine();

const scoreInput = {
  submissionId: SUBMISSION_ID,
  kind: 'next_shot' as const,
  content: 'a stub pitch',
  episodeTitle: 'T',
  episodeTheme: 'theme',
  recentScenes: [],
};

async function baseScore(): Promise<ScoreSubmissionOutput> {
  return engine.scoreSubmission(scoreInput);
}

async function baseFinalize(): Promise<FinalizeRoundOutput> {
  return engine.finalizeRound({
    roundId: ROUND_ID,
    candidates: [
      {
        submissionId: SUBMISSION_ID,
        content: 'one',
        authorUsername: 'a',
        scoreTotal: 60,
        scoreBreakdown: {
          continuity: 20,
          filmability15s: 15,
          characterConsistency: 12,
          dramaticValue: 8,
          originality: 5,
        },
        reason: 'r',
      },
    ],
    episodeTitle: 'T',
    episodeTheme: 'theme',
    recentScenes: [],
  });
}

async function baseDirector(): Promise<DirectSceneOutput> {
  return engine.directScene({
    roundId: ROUND_ID,
    episodeIndex: 1,
    episodeTitle: 'T',
    episodeTheme: 'theme',
    selectedSubmission: {
      id: SUBMISSION_ID,
      content: 'one',
      authorUsername: 'alice',
    },
    selectionMode: 'ai',
    recentScenes: [],
    previousScene: null,
  });
}

const directorExpectation = {
  roundId: ROUND_ID,
  selectedSubmissionId: SUBMISSION_ID,
};

const productionDirectorExpectation = {
  ...directorExpectation,
  capabilitiesVersion: 'h3-capabilities-v5',
  previousEndFrameSha256: null,
  previousMotionContextId: null,
};

function productionWorkflow(prompt: string, length = 294, withTail = false) {
  const workflow: DirectSceneOutput['comfyuiWorkflow']['prompt'] = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'minimax_h3_fl2va_int8_convrot.safetensors', weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors', type: 'minimax', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_video_vae_fp16.safetensors' } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' } },
    '5': { class_type: 'MiniMaxH3SigmaShift', inputs: { model: ['1', 0], shift_video: 12, shift_audio: 3 } },
    '6': { class_type: 'MiniMaxH3PDDAccApply', inputs: { model: ['5', 0], pdd_file: 'MiniMax-H3-FL2VA-Acc-8Step.safetensors', nfe: '8', lora_strength: 1, head_strength: 1, on_off_grid: 'error', partition: '', enabled: true } },
    '7': { class_type: 'MiniMaxH3ImageToVideo', inputs: { clip: ['2', 0], vae: ['3', 0], prompt, width: 1344, height: 768, length } },
    '8': { class_type: 'BasicGuider', inputs: { model: ['6', 0], conditioning: ['7', 0] } },
    '9': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '10': { class_type: 'RandomNoise', inputs: { noise_seed: 1000 } },
    '11': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['10', 0], guider: ['8', 0], sampler: ['9', 0], sigmas: ['6', 1], latent_image: ['7', 1] } },
    '12': { class_type: 'VAEDecode', inputs: { samples: ['11', 0], vae: ['3', 0] } },
    '13': { class_type: 'VAEDecodeAudio', inputs: { samples: ['11', 0], vae: ['4', 0] } },
    '14': { class_type: 'CreateVideo', inputs: { images: ['12', 0], audio: ['13', 0], fps: 24 } },
    '15': { class_type: 'SaveVideo', inputs: { video: ['14', 0], filename_prefix: `video/FastH3/${ROUND_ID}`, format: 'mp4', codec: 'auto' } },
  };
  if (withTail) {
    workflow['16'] = {
      class_type: 'LoadImage',
      inputs: { image: `crowdmovie/${ROUND_ID}.png` },
    };
    workflow['7'].inputs.first_frame = ['16', 0];
  }
  return workflow;
}

async function baseSubtitles(): Promise<AuthorSubtitlesOutput> {
  const director = await baseDirector();
  return engine.authorSubtitles({
    roundId: ROUND_ID,
    actualDurationSeconds: director.durationSeconds,
    dialogueEn: director.dialogueEn,
    sceneSummaryZh: director.sceneSummaryZh,
  });
}

// --- 初评 (§6.3) -------------------------------------------------------------

test('stub 初评输出通过校验，且分项之和严格等于总分', async () => {
  const output = await baseScore();
  expect(() => validateScore(output, SUBMISSION_ID)).not.toThrow();
  const sum = Object.values(output.scoreBreakdown).reduce((a, b) => a + b, 0);
  expect(sum).toBe(output.scoreTotal);
});

test('初评：submissionId 不匹配被拒绝', async () => {
  const output = await baseScore();
  expect(() => validateScore(output, OTHER_ID)).toThrow(EngineOutputError);
});

test('初评：任一分项超出各自上限被拒绝', async () => {
  const output = await baseScore();
  const broken = {
    ...output,
    scoreBreakdown: { ...output.scoreBreakdown, continuity: 31 },
  };
  expect(() => validateScore(broken, SUBMISSION_ID)).toThrow(/continuity/);
});

test('初评：分项之和不等于 score_total 被拒绝', async () => {
  const output = await baseScore();
  const broken = { ...output, scoreTotal: output.scoreTotal + 1 };
  expect(() => validateScore(broken, SUBMISSION_ID)).toThrow(/breakdown sum/);
});

test('初评：eligible=false 必须 score_total=0 且带风险标记', async () => {
  const output = await baseScore();
  expect(() =>
    validateScore(
      { ...output, eligible: false, riskFlags: ['x'] },
      SUBMISSION_ID,
    ),
  ).toThrow(/ineligible submissions must score 0/);

  const zeroed = {
    ...output,
    eligible: false,
    scoreTotal: 0,
    scoreBreakdown: {
      continuity: 0,
      filmability15s: 0,
      characterConsistency: 0,
      dramaticValue: 0,
      originality: 0,
    },
  };
  expect(() => validateScore(zeroed, SUBMISSION_ID)).toThrow(/risk flag/);
  expect(() =>
    validateScore({ ...zeroed, riskFlags: ['prompt_injection'] }, SUBMISSION_ID),
  ).not.toThrow();
});

test('初评：not_story_content 不能同时标为 eligible', async () => {
  const output = await baseScore();
  expect(() =>
    validateScore(
      { ...output, eligible: true, riskFlags: ['not_story_content'] },
      SUBMISSION_ID,
    ),
  ).toThrow(/not_story_content submissions cannot be eligible/);
});

test('初评：四语毒舌缺一语或为空白被拒绝', async () => {
  const output = await baseScore();
  for (const locale of ['en', 'zh-CN', 'ja', 'es'] as const) {
    const broken = {
      ...output,
      publicRoast: { ...output.publicRoast, [locale]: '   ' },
    };
    expect(() => validateScore(broken, SUBMISSION_ID)).toThrow(
      new RegExp(`publicRoast\\.${locale}`),
    );
  }
});

test('初评：毒舌超过 160 个用户可见字符被拒绝，按 grapheme 计数', async () => {
  const output = await baseScore();
  // 160 CJK characters is exactly at the limit; 161 is over it.
  expect(() =>
    validateScore(
      { ...output, publicRoast: { ...output.publicRoast, ja: '啊'.repeat(160) } },
      SUBMISSION_ID,
    ),
  ).not.toThrow();
  expect(() =>
    validateScore(
      { ...output, publicRoast: { ...output.publicRoast, ja: '啊'.repeat(161) } },
      SUBMISSION_ID,
    ),
  ).toThrow(/160 graphemes/);

  // A ZWJ family emoji is 5 code points and 8 UTF-16 units but one grapheme:
  // 160 of them must pass a limit measured the way the reader sees it.
  const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}';
  expect(family.length).toBe(8);
  expect(() =>
    validateScore(
      { ...output, publicRoast: { ...output.publicRoast, es: family.repeat(160) } },
      SUBMISSION_ID,
    ),
  ).not.toThrow();
  expect(() =>
    validateScore(
      { ...output, publicRoast: { ...output.publicRoast, es: family.repeat(161) } },
      SUBMISSION_ID,
    ),
  ).toThrow(/160 graphemes/);
});

test('初评：空 reason 或空 rubricVersion 被拒绝', async () => {
  const output = await baseScore();
  expect(() => validateScore({ ...output, reason: ' ' }, SUBMISSION_ID)).toThrow(
    /reason is empty/,
  );
  expect(() =>
    validateScore({ ...output, rubricVersion: '' }, SUBMISSION_ID),
  ).toThrow(/rubricVersion/);
});

// --- 终审 (§6.4) -------------------------------------------------------------

test('终审：stub 输出通过校验', async () => {
  const output = await baseFinalize();
  expect(() =>
    validateFinalize(output, ROUND_ID, [SUBMISSION_ID]),
  ).not.toThrow();
});

test('终审：不得排名或选择 Top-K 之外的投稿', async () => {
  const output = await baseFinalize();
  // Matched on the *ranked* message specifically: the selection check below
  // would otherwise cover for a missing membership check on the ranking.
  expect(() => validateFinalize(output, ROUND_ID, [OTHER_ID])).toThrow(
    new RegExp(`ranked ${SUBMISSION_ID} is not in the Top-K`),
  );

  const outside = {
    ...output,
    selectedSubmissionId: OTHER_ID,
  };
  expect(() => validateFinalize(outside, ROUND_ID, [SUBMISSION_ID])).toThrow(
    /selectedSubmissionId is not in the Top-K/,
  );
});

test('终审：重复排名、空排名、越界 final_score、roundId 不符都被拒绝', async () => {
  const output = await baseFinalize();
  const one = output.rankedCandidates[0];

  expect(() =>
    validateFinalize(
      { ...output, rankedCandidates: [one, { ...one, rank: 2 }] },
      ROUND_ID,
      [SUBMISSION_ID],
    ),
  ).toThrow(/appears twice/);

  expect(() =>
    validateFinalize({ ...output, rankedCandidates: [] }, ROUND_ID, [
      SUBMISSION_ID,
    ]),
  ).toThrow(/rankedCandidates is empty/);

  expect(() =>
    validateFinalize(
      { ...output, rankedCandidates: [{ ...one, finalScore: 101 }] },
      ROUND_ID,
      [SUBMISSION_ID],
    ),
  ).toThrow(/out of 0\.\.100/);

  expect(() => validateFinalize(output, OTHER_ID, [SUBMISSION_ID])).toThrow(
    /roundId/,
  );
});

test('终审：被选中的投稿必须出现在排名里', async () => {
  const output = await baseFinalize();
  const broken = {
    ...output,
    rankedCandidates: [{ ...output.rankedCandidates[0], submissionId: OTHER_ID }],
  };
  expect(() =>
    validateFinalize(broken, ROUND_ID, [SUBMISSION_ID, OTHER_ID]),
  ).toThrow(/was not ranked/);
});

// --- 导演包 (§6.5) -----------------------------------------------------------

test('导演包：stub 输出通过校验', async () => {
  const output = await baseDirector();
  expect(() => validateDirector(output, directorExpectation)).not.toThrow();
});

test('导演包：署名的投稿 ID 必须与轮次选择一致', async () => {
  const output = await baseDirector();
  expect(() =>
    validateDirector(output, { roundId: ROUND_ID, selectedSubmissionId: OTHER_ID }),
  ).toThrow(/does not match the round selection/);
});

test('导演包：自动续写不得带署名', async () => {
  const output = await baseDirector();
  expect(() =>
    validateDirector(
      { ...output, selectedSubmissionId: null },
      { roundId: ROUND_ID, selectedSubmissionId: null },
    ),
  ).toThrow(/must not credit a contributor/);
});

test('导演包：时长必须在 [5, 15] 秒内（§17.11）', async () => {
  const output = await baseDirector();
  for (const seconds of [0, -1, 4.999, 15.001, 30]) {
    expect(() =>
      validateDirector({ ...output, durationSeconds: seconds }, directorExpectation),
    ).toThrow(/durationSeconds/);
  }
  expect(() =>
    validateDirector(
      {
        ...output,
        durationSeconds: 5,
        dialogueEn: [
          { speaker: 'StubOne', startSeconds: 1, endSeconds: 4, line: 'Five seconds.' },
        ],
      },
      directorExpectation,
    ),
  ).not.toThrow();
  expect(() =>
    validateDirector({ ...output, durationSeconds: 15 }, directorExpectation),
  ).not.toThrow();
});

test('导演包：上一幕尾帧只允许连续事件且必须存在已发布摘要', async () => {
  const output = await baseDirector();
  expect(() =>
    validateDirector(
      { ...output, usePreviousEndFrame: true, shotRelation: 'new_shot' },
      directorExpectation,
    ),
  ).toThrow(/shotRelation=continuous_event/);
  expect(() =>
    validateDirector(
      { ...output, usePreviousEndFrame: true, shotRelation: 'continuous_event' },
      {
        ...directorExpectation,
        capabilitiesVersion: 'h3-capabilities-v5',
        previousEndFrameSha256: null,
      },
    ),
  ).toThrow(/immediately previous published end frame/);
});

test('导演包：production v5 始终禁用 Motion Context', async () => {
  const output = await baseDirector();
  expect(() =>
    validateDirector(
      { ...output, useMotionContext: true },
      { ...directorExpectation, capabilitiesVersion: 'h3-capabilities-v5' },
    ),
  ).toThrow(/Motion Context is disabled/);
  expect(() =>
    validateDirector(
      {
        ...output,
        shotRelation: 'continuous_event',
        usePreviousEndFrame: true,
        useMotionContext: true,
      },
      {
        ...directorExpectation,
        capabilitiesVersion: 'h3-capabilities-v5',
        previousEndFrameSha256: 'a'.repeat(64),
      },
    ),
  ).toThrow(/Motion Context is disabled/);
});

test('导演包：episode_should_end 与 episode_end_reason 必须一致', async () => {
  const output = await baseDirector();
  expect(() =>
    validateDirector({ ...output, episodeShouldEnd: true }, directorExpectation),
  ).toThrow(/non-empty episodeEndReason/);
  expect(() =>
    validateDirector(
      { ...output, episodeEndReason: '本集结束' },
      directorExpectation,
    ),
  ).toThrow(/must be null unless the episode ends/);
  expect(() =>
    validateDirector(
      { ...output, episodeShouldEnd: true, episodeEndReason: '本集结束' },
      directorExpectation,
    ),
  ).not.toThrow();
});

test('导演包：台词时间轴越界、乱序或同一说话人重叠被拒绝', async () => {
  const output = await baseDirector();
  const speaker = output.dialogueEn[0].speaker;

  expect(() =>
    validateDirector(
      {
        ...output,
        dialogueEn: [{ speaker, startSeconds: 3, endSeconds: 99, line: 'x' }],
      },
      directorExpectation,
    ),
  ).toThrow(/ends after the scene/);

  expect(() =>
    validateDirector(
      {
        ...output,
        dialogueEn: [{ speaker, startSeconds: 5, endSeconds: 4, line: 'x' }],
      },
      directorExpectation,
    ),
  ).toThrow(/does not end after it starts/);

  expect(() =>
    validateDirector(
      {
        ...output,
        dialogueEn: [
          { speaker, startSeconds: 6, endSeconds: 7, line: 'x' },
          { speaker: 'Other', startSeconds: 1, endSeconds: 2, line: 'y' },
        ],
      },
      directorExpectation,
    ),
  ).toThrow(/out of time order/);

  expect(() =>
    validateDirector(
      {
        ...output,
        dialogueEn: [
          { speaker, startSeconds: 1, endSeconds: 6, line: 'x' },
          { speaker, startSeconds: 5, endSeconds: 8, line: 'y' },
        ],
      },
      directorExpectation,
    ),
  ).toThrow(/overlaps another line/);

  // Different speakers may overlap — §9.2「cue 可以有受控重叠」.
  expect(() =>
    validateDirector(
      {
        ...output,
        dialogueEn: [
          { speaker: 'A', startSeconds: 1, endSeconds: 6, line: 'x' },
          { speaker: 'B', startSeconds: 5, endSeconds: 8, line: 'y' },
        ],
      },
      directorExpectation,
    ),
  ).not.toThrow();
});

test('导演包：ComfyUI workflow 不能为空，节点必须有 class_type', async () => {
  const output = await baseDirector();
  expect(() =>
    validateDirector(
      { ...output, comfyuiWorkflow: { prompt: {} } },
      directorExpectation,
    ),
  ).toThrow(/no nodes/);
  expect(() =>
    validateDirector(
      { ...output, comfyuiWorkflow: { prompt: { '1': { class_type: '', inputs: {} } } } },
      directorExpectation,
    ),
  ).toThrow(/no class_type/);
});

test('AI Director 生产源文本只允许英语，字幕翻译层除外', () => {
  expect(() =>
    assertEnglishCreativeSource('automatic shot content', 'Reimu closes the vent.'),
  ).not.toThrow();
  expect(() =>
    assertEnglishCreativeSource(
      'automatic shot content',
      '葫芦娃 bursts through the gate and launches Batman across the arena.',
    ),
  ).not.toThrow();
  expect(() =>
    assertEnglishCreativeSource('automatic shot content', '灵梦关掉风口。'),
  ).toThrow(/must be written in English/);
});

test('AI Director 投稿必须是普通文本，不得再包一层 JSON content', () => {
  expect(() =>
    assertPlainTextCreativeSource(
      'automatic shot content',
      'Marisa starts a battery fan beside Reimu.',
    ),
  ).not.toThrow();
  expect(() =>
    assertPlainTextCreativeSource(
      'automatic shot content',
      '{"content":"Marisa starts a battery fan beside Reimu."}',
    ),
  ).toThrow(/plain text, not serialized JSON/);
  expect(() =>
    assertPlainTextCreativeSource(
      'automatic shot content',
      '"{\\"content\\":\\"Marisa starts a battery fan beside Reimu.\\"}"',
    ),
  ).toThrow(/plain text, not serialized JSON/);
});

test('生产导演包固定英语源文本、参考提示词质量约束与 1344x768 横屏', async () => {
  const base = await baseDirector();
  const h3Prompt =
    'summary:\nReimu closes the premium vent in a crisp high-detail 3D arena.\n\ndetailed_description:\nA stabilized medium-wide gameplay camera tracks slowly sideways while keeping the entire hallway arena sharp and readable. Reimu Hakurei speaks in a young teenage-girl voice with dry deadpan delivery: <d>[English] Nobody gets premium air.</d> She closes the vent with grounded impact weight. Fast character motion has only localized limb and impact streaks; no full-frame motion blur, no depth-of-field blur, no fog wash, no camera shake.\n\noverall_soundscape:\nA vent clicks shut.\n\nnon_diegetic_music:\nN/A';
  const output: DirectSceneOutput = {
    ...base,
    sceneSummaryZh: 'Reimu closes the broken vent.',
    continuityFromPrevious: 'This starts a new hallway shot.',
    h3PromptEn: h3Prompt,
    dialogueEn: [
      {
        speaker: 'Reimu',
        startSeconds: 1,
        endSeconds: 3,
        line: 'Nobody gets premium air.',
      },
    ],
    continuityUpdates: ['The hallway vent is now closed.'],
    comfyuiCapabilitiesVersion: 'h3-capabilities-v5',
    comfyuiWorkflow: { prompt: productionWorkflow(h3Prompt) },
  };

  expect(() =>
    validateDirector(output, productionDirectorExpectation),
  ).not.toThrow();
  const fastCameraPrompt = h3Prompt.replace(
    'Reimu Hakurei speaks',
    'The camera executes a fast single-axis tracking rush while Reimu Hakurei speaks',
  );
  expect(() =>
    validateDirector(
      {
        ...output,
        h3PromptEn: fastCameraPrompt,
        comfyuiWorkflow: { prompt: productionWorkflow(fastCameraPrompt) },
      },
      productionDirectorExpectation,
    ),
  ).not.toThrow();
  expect(() =>
    validateDirector(
      {
        ...output,
        comfyuiWorkflow: {
          prompt: {
            ...output.comfyuiWorkflow.prompt,
            '9': {
              ...output.comfyuiWorkflow.prompt['9'],
              inputs: {
                ...output.comfyuiWorkflow.prompt['9'].inputs,
                length: 999,
              },
            },
          },
        },
      },
      productionDirectorExpectation,
    ),
  ).toThrow(/node 9/);
  expect(() =>
    validateDirector(
      { ...output, sceneSummaryZh: '灵梦关掉坏掉的风口。' },
      productionDirectorExpectation,
    ),
  ).toThrow(/English prose/);
  expect(() =>
    validateDirector(
      { ...output, h3PromptEn: 'Reimu Hakurei says: “Nobody gets premium air.”' },
      productionDirectorExpectation,
    ),
  ).toThrow(/reference summary field/);
  expect(() =>
    validateDirector(
      {
        ...output,
        comfyuiWorkflow: {
          prompt: {
            ...output.comfyuiWorkflow.prompt,
            '9': {
              class_type: 'MiniMaxH3ImageToVideo',
              inputs: {
                clip: ['2', 0],
                vae: ['3', 0],
                prompt: 'A fixed shot.',
                width: 864,
                height: 480,
                length: 294,
              },
            },
          },
        },
      },
      productionDirectorExpectation,
    ),
  ).toThrow(/node 9/);
});

test('生产导演包拒绝超过 2000 个英文单词的完整 H3 拍摄提示词', async () => {
  const base = await baseDirector();
  const h3Prompt =
    `integrated_multimodal_description: [Shot 1] Elden Ring-style polished 3D fighters in a sharp Elden Ring-style arena with Soulslike-style impact weight. ${'accelerates '.repeat(2001)}` +
    '\n\noverall_soundscape: Air tears past.\n\nnon_diegetic_music: Fast percussion.';
  const output: DirectSceneOutput = {
    ...base,
    sceneSummaryZh: 'The fighters accelerate through the arena.',
    continuityFromPrevious: 'This begins a new action shot.',
    h3PromptEn: h3Prompt,
    dialogueEn: [],
    continuityUpdates: ['The fighters cross the arena.'],
    comfyuiCapabilitiesVersion: 'h3-capabilities-v5',
    comfyuiWorkflow: { prompt: productionWorkflow(h3Prompt) },
  };

  expect(() =>
    validateDirector(output, productionDirectorExpectation),
  ).toThrow(/h3PromptEn must contain at most 2000 English words/);
});

test('生产导演包隔离 H3 调度数字与角色台词', async () => {
  const base = await baseDirector();
  const dialogueEn = [
    {
      speaker: 'Reimu',
      startSeconds: 1,
      endSeconds: 3,
      line: 'Nobody gets premium air.',
    },
  ];
  const validPrompt =
    'summary:\nReimu closes the premium vent in a crisp high-detail 3D arena.\n\ndetailed_description:\nA stabilized medium-wide gameplay camera tracks slowly sideways while keeping the entire arena sharp and readable. Reimu speaks in a young teenage-girl voice: <d>[English] Nobody gets premium air.</d> After she finishes, the vent closes with grounded impact weight. Fast character motion has only localized limb and impact streaks; no full-frame motion blur, no depth-of-field blur, no fog wash, no camera shake.\n\noverall_soundscape:\nOne dry vent click.\n\nnon_diegetic_music:\nN/A';
  const production = {
    ...base,
    sceneSummaryZh: 'Reimu closes the premium vent.',
    continuityFromPrevious: 'The argument continues beside the vent.',
    h3PromptEn: validPrompt,
    dialogueEn,
    continuityUpdates: ['The premium vent is closed.'],
    comfyuiCapabilitiesVersion: 'h3-capabilities-v5',
    comfyuiWorkflow: { prompt: productionWorkflow(validPrompt) },
  } satisfies DirectSceneOutput;

  expect(() =>
    validateDirector(production, productionDirectorExpectation),
  ).not.toThrow();

  const missingDialogueBlock = validPrompt.replace(
    '<d>[English] Nobody gets premium air.</d>',
    'Nobody gets premium air.',
  );
  expect(() =>
    validateDirector(
      {
        ...production,
        h3PromptEn: missingDialogueBlock,
        comfyuiWorkflow: {
          prompt: {
            '5': {
              class_type: 'MiniMaxH3ImageToVideo',
              inputs: {
                prompt: missingDialogueBlock,
                width: 1344,
                height: 768,
              },
            },
          },
        },
      },
      productionDirectorExpectation,
    ),
  ).toThrow(/one well-formed <d>/);

  expect(() =>
    validateDirector(
      {
        ...production,
        dialogueEn: [{ ...dialogueEn[0], line: 'Scene 000018. Nobody gets premium air.' }],
        h3PromptEn: validPrompt.replace(
          'Nobody gets premium air.',
          'Scene 000018. Nobody gets premium air.',
        ),
      },
      productionDirectorExpectation,
    ),
  ).toThrow(/scene, shot, or round number/);

  const timedPrompt = validPrompt.replace(
    'After she finishes',
    'From 1.0 to 3.0 seconds',
  );
  expect(() =>
    validateDirector(
      {
        ...production,
        h3PromptEn: timedPrompt,
        comfyuiWorkflow: {
          prompt: {
            '5': {
              class_type: 'MiniMaxH3ImageToVideo',
              inputs: { prompt: timedPrompt, width: 1344, height: 768 },
            },
          },
        },
      },
      productionDirectorExpectation,
    ),
  ).toThrow(/relative action timing/);

  const dialogueInSoundscape =
    'integrated_multimodal_description: [Shot 1] Elden Ring-style polished 3D character rendering and a sharp Elden Ring-style arena. Reimu speaks in a young teenage-girl voice. After she finishes, the vent closes with Soulslike-style grounded impact weight.\n\noverall_soundscape: One dry vent click. <d>[English] Nobody gets premium air.</d>\n\nnon_diegetic_music: N/A';
  expect(() =>
    validateDirector(
      {
        ...production,
        h3PromptEn: dialogueInSoundscape,
        comfyuiWorkflow: {
          prompt: {
            '5': {
              class_type: 'MiniMaxH3ImageToVideo',
              inputs: {
                prompt: dialogueInSoundscape,
                width: 1344,
                height: 768,
              },
            },
          },
        },
      },
      productionDirectorExpectation,
    ),
  ).toThrow(/inside detailed_description/);

  expect(() =>
    validateDirector(
      {
        ...production,
        comfyuiWorkflow: {
          prompt: {
            ...production.comfyuiWorkflow.prompt,
            '9': {
              ...production.comfyuiWorkflow.prompt['9'],
              inputs: {
                ...production.comfyuiWorkflow.prompt['9'].inputs,
                prompt: `${validPrompt} Extra instruction.`,
              },
            },
          },
        },
      },
      productionDirectorExpectation,
    ),
  ).toThrow(/node 9/);
});

test('生产导演包只在连续事件中接受上一幕尾帧 I2VA', async () => {
  const base = await baseDirector();
  const body =
    'summary:\n葫芦娃 and Superman continue their clash in a crisp high-detail 3D arena.\n\ndetailed_description:\nThe shot opens exactly on <Picture 1>, preserving its framing, lighting, costumes and positions, and the action continues without a pause as 葫芦娃 dives and Superman answers with a grounded counter. A stabilized medium-wide gameplay camera tracks slowly sideways while keeping the entire arena sharp and readable. Fast character motion has only localized limb, cape, weapon and impact streaks; no full-frame motion blur, no depth-of-field blur, no fog wash, no camera shake.\n\noverall_soundscape:\nAir tears past.\n\nnon_diegetic_music:\nFast percussion.';
  const header =
    'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.';
  const prompt = `${header}\n\n${body}`;
  const workflow = productionWorkflow(prompt, 294, true);
  const output: DirectSceneOutput = {
    ...base,
    sceneSummaryZh: '葫芦娃 dives while Superman evades.',
    continuityFromPrevious: '葫芦娃 continues the same dive.',
    shotRelation: 'continuous_event',
    usePreviousEndFrame: true,
    h3PromptEn: prompt,
    dialogueEn: [],
    continuityUpdates: ['葫芦娃 remains airborne.'],
    comfyuiCapabilitiesVersion: 'h3-capabilities-v5',
    comfyuiWorkflow: { prompt: workflow },
  };

  expect(() =>
    validateDirector(output, {
      ...productionDirectorExpectation,
      previousEndFrameSha256: 'a'.repeat(64),
    }),
  ).not.toThrow();
  expect(() => validateDirector(output, productionDirectorExpectation)).toThrow(
    /immediately previous published end frame/,
  );
  expect(() =>
    validateDirector(
      {
        ...output,
        shotRelation: 'new_shot',
        usePreviousEndFrame: false,
        h3PromptEn:
          'summary:\n葫芦娃 and Superman collide in a crisp high-detail 3D arena.\n\ndetailed_description:\nA stabilized medium-wide gameplay camera tracks slowly sideways while keeping the entire arena sharp and readable. 葫芦娃 dives as Superman answers with a grounded counter. Fast character motion has only localized limb, cape, weapon and impact streaks; no full-frame motion blur, no depth-of-field blur, no fog wash, no camera shake.\n\noverall_soundscape:\nAir tears past.\n\nnon_diegetic_music:\nFast percussion.',
        comfyuiWorkflow: {
          prompt: productionWorkflow(
            'summary:\n葫芦娃 and Superman collide in a crisp high-detail 3D arena.\n\ndetailed_description:\nA stabilized medium-wide gameplay camera tracks slowly sideways while keeping the entire arena sharp and readable. 葫芦娃 dives as Superman answers with a grounded counter. Fast character motion has only localized limb, cape, weapon and impact streaks; no full-frame motion blur, no depth-of-field blur, no fog wash, no camera shake.\n\noverall_soundscape:\nAir tears past.\n\nnon_diegetic_music:\nFast percussion.',
          ),
        },
      },
      productionDirectorExpectation,
    ),
  ).not.toThrow();
});

// --- 字幕包 (§9.2) -----------------------------------------------------------

test('字幕包：stub 输出通过校验', async () => {
  const output = await baseSubtitles();
  expect(() =>
    validateSubtitles(output, { actualDurationSeconds: 12 }),
  ).not.toThrow();
});

test('字幕包：audio_language 必须为 en', async () => {
  const output = await baseSubtitles();
  expect(() =>
    validateSubtitles(
      { ...output, audioLanguage: 'ja' as 'en' },
      { actualDurationSeconds: 12 },
    ),
  ).toThrow(/audioLanguage must be en/);
});

test('字幕包：实际时长必须与实测一致，cue 不得超出片段', async () => {
  const output = await baseSubtitles();
  expect(() =>
    validateSubtitles(output, { actualDurationSeconds: 11 }),
  ).toThrow(/actualDurationSeconds does not match/);

  const overlong = {
    ...output,
    cues: [{ ...output.cues[0], endSeconds: 99 }],
  };
  expect(() =>
    validateSubtitles(overlong, { actualDurationSeconds: 12 }),
  ).toThrow(/ends after the scene/);
});

test('字幕包：每个 cue 必须四语齐全且非空', async () => {
  const output = await baseSubtitles();
  for (const locale of ['en', 'zh-CN', 'ja', 'es'] as const) {
    const broken = {
      ...output,
      cues: [
        { ...output.cues[0], text: { ...output.cues[0].text, [locale]: '' } },
        ...output.cues.slice(1),
      ],
    };
    expect(() =>
      validateSubtitles(broken, { actualDurationSeconds: 12 }),
    ).toThrow(new RegExp(`cues\\[0\\]\\.text\\.${locale}`));
  }
});

test('字幕包：cue_id 不得重复', async () => {
  const output = await baseSubtitles();
  const duplicated = {
    ...output,
    cues: [output.cues[0], { ...output.cues[1], cueId: output.cues[0].cueId }],
  };
  expect(() =>
    validateSubtitles(duplicated, { actualDurationSeconds: 12 }),
  ).toThrow(/appears twice/);
});

test('字幕包：四语共用同一条时间轴（cue 顺序必须单调递增）', async () => {
  const output = await baseSubtitles();
  const reversed = { ...output, cues: [output.cues[1], output.cues[0]] };
  expect(() =>
    validateSubtitles(reversed, { actualDurationSeconds: 12 }),
  ).toThrow(/out of time order/);
});

// --- stub 的确定性 -----------------------------------------------------------

test('stub 引擎是确定性的：同一输入两次调用输出完全相同', async () => {
  const a = await engine.scoreSubmission(scoreInput);
  const b = await engine.scoreSubmission(scoreInput);
  expect(a).toEqual(b);

  const other = await engine.scoreSubmission({
    ...scoreInput,
    content: 'a different pitch',
  });
  // Scores are a function of the text, which is how the round tests steer
  // which submission wins.
  expect(other.scoreTotal).not.toBe(a.scoreTotal);
});
