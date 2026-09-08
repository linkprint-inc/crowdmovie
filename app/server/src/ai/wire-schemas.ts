import { FILM_PLAN_SCHEMA, type FilmState } from './film-plan.js';

const localizedText = {
  type: 'object',
  additionalProperties: false,
  required: ['en', 'zh-CN', 'ja', 'es'],
  properties: {
    en: { type: 'string' },
    'zh-CN': { type: 'string' },
    ja: { type: 'string' },
    es: { type: 'string' },
  },
} as const;

export const STORY_REVIEW_WIRE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'reasons', 'policy_version'],
  properties: {
    ok: { type: 'boolean' },
    reasons: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string', minLength: 1, maxLength: 240 },
    },
    policy_version: {
      type: 'string',
      const: 'story-review-permissive-v2',
    },
  },
} as const;

const scoreBreakdown = {
  type: 'object',
  additionalProperties: false,
  required: [
    'continuity',
    'filmability_15s',
    'character_consistency',
    'dramatic_value',
    'originality',
  ],
  properties: {
    continuity: { type: 'integer', minimum: 0, maximum: 30 },
    filmability_15s: { type: 'integer', minimum: 0, maximum: 25 },
    character_consistency: { type: 'integer', minimum: 0, maximum: 20 },
    dramatic_value: { type: 'integer', minimum: 0, maximum: 15 },
    originality: { type: 'integer', minimum: 0, maximum: 10 },
  },
} as const;

export const SCORE_WIRE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'submission_id',
    'eligible',
    'score_total',
    'score_breakdown',
    'reason',
    'public_roast',
    'risk_flags',
    'rubric_version',
  ],
  properties: {
    submission_id: { type: 'string' },
    eligible: { type: 'boolean' },
    score_total: { type: 'integer', minimum: 0, maximum: 100 },
    score_breakdown: scoreBreakdown,
    reason: { type: 'string' },
    public_roast: localizedText,
    risk_flags: { type: 'array', items: { type: 'string' } },
    rubric_version: { type: 'string', const: 'submission-score-v1' },
  },
} as const;

export const FINAL_WIRE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'round_id',
    'ranked_candidates',
    'selected_submission_id',
    'rubric_version',
  ],
  properties: {
    round_id: { type: 'string' },
    ranked_candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['submission_id', 'final_score', 'rank', 'reason'],
        properties: {
          submission_id: { type: 'string' },
          final_score: { type: 'integer', minimum: 0, maximum: 100 },
          rank: { type: 'integer', minimum: 1 },
          reason: { type: 'string' },
        },
      },
    },
    selected_submission_id: { type: 'string' },
    rubric_version: { type: 'string', const: 'round-final-v1' },
  },
} as const;

export const AUTOMATIC_SHOT_WIRE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['filmed_actions_avoided', 'unused_technique', 'content'],
  properties: {
    filmed_actions_avoided: {
      type: 'array',
      minItems: 0,
      maxItems: 40,
      items: { type: 'string', minLength: 1, maxLength: 300 },
    },
    unused_technique: { type: 'string', minLength: 1, maxLength: 300 },
    // Do not express the 70-English-word Web cap as JSON maxLength: that unit
    // is characters and constrained decoding could close the string mid-word.
    // The mapper word-counts and compiles a complete synopsis before publish.
    content: { type: 'string', minLength: 1, maxLength: 12000 },
  },
} as const;

const dialogueLine = {
  type: 'object',
  additionalProperties: false,
  required: ['speaker', 'start_seconds', 'end_seconds', 'line'],
  properties: {
    speaker: { type: 'string' },
    start_seconds: { type: 'number' },
    end_seconds: { type: 'number' },
    line: { type: 'string' },
  },
} as const;

type SchemaProperties = Record<string, unknown>;

function strictObject(properties: SchemaProperties): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

function fixedLink(nodeId: string, outputIndex: number): Record<string, unknown> {
  // Structured Outputs rejects array-valued `const`. The expected link remains
  // documented in the description and the authoritative FastH3 validator
  // checks the actual graph before submission.
  return {
    type: 'array',
    items: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
    minItems: 2,
    maxItems: 2,
    description: `Must link to node ${nodeId}, output ${outputIndex}`,
  };
}

function workflowNode(
  classType: string,
  inputs: SchemaProperties,
): Record<string, unknown> {
  return strictObject({
    class_type: { type: 'string', const: classType },
    inputs: strictObject(inputs),
  });
}

// Structured Outputs requires every object to close over a fixed property set.
// Qwen returns the base graph shape; server code recompiles every node and adds
// the controlled LoadImage node only when use_previous_end_frame is accepted.
export const PINNED_PDD_FL2VA_WORKFLOW_SCHEMA = strictObject({
  '1': workflowNode('UNETLoader', {
    unet_name: {
      type: 'string',
      const: 'minimax_h3_fl2va_int8_convrot.safetensors',
    },
    weight_dtype: { type: 'string', const: 'default' },
  }),
  '2': workflowNode('CLIPLoader', {
    clip_name: {
      type: 'string',
      const: 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors',
    },
    type: { type: 'string', const: 'minimax' },
    device: { type: 'string', const: 'default' },
  }),
  '3': workflowNode('VAELoader', {
    vae_name: {
      type: 'string',
      const: 'minimax_h3_video_vae_fp16.safetensors',
    },
  }),
  '4': workflowNode('VAELoader', {
    vae_name: {
      type: 'string',
      const: 'minimax_h3_audio_vae_fp32.safetensors',
    },
  }),
  '5': workflowNode('MiniMaxH3SigmaShift', {
    model: fixedLink('1', 0),
    shift_video: { type: 'number', const: 12 },
    shift_audio: { type: 'number', const: 3 },
  }),
  '6': workflowNode('MiniMaxH3PDDAccApply', {
    model: fixedLink('5', 0),
    pdd_file: {
      type: 'string',
      const: 'MiniMax-H3-FL2VA-Acc-8Step.safetensors',
    },
    nfe: { type: 'string', const: '8' },
    lora_strength: { type: 'number', const: 1 },
    head_strength: { type: 'number', const: 1 },
    on_off_grid: { type: 'string', const: 'error' },
    partition: { type: 'string', const: '' },
    enabled: { type: 'boolean', const: true },
  }),
  '7': workflowNode('MiniMaxH3ImageToVideo', {
    clip: fixedLink('2', 0),
    vae: fixedLink('3', 0),
    prompt: { type: 'string' },
    width: { type: 'integer', const: 1344 },
    height: { type: 'integer', const: 768 },
    length: { type: 'integer', minimum: 1 },
  }),
  '8': workflowNode('BasicGuider', {
    model: fixedLink('6', 0),
    conditioning: fixedLink('7', 0),
  }),
  '9': workflowNode('KSamplerSelect', {
    sampler_name: { type: 'string', const: 'euler' },
  }),
  '10': workflowNode('RandomNoise', {
    noise_seed: { type: 'integer', minimum: 0 },
  }),
  '11': workflowNode('SamplerCustomAdvanced', {
    noise: fixedLink('10', 0),
    guider: fixedLink('8', 0),
    sampler: fixedLink('9', 0),
    sigmas: fixedLink('6', 1),
    latent_image: fixedLink('7', 1),
  }),
  '12': workflowNode('VAEDecode', {
    samples: fixedLink('11', 0),
    vae: fixedLink('3', 0),
  }),
  '13': workflowNode('VAEDecodeAudio', {
    samples: fixedLink('11', 0),
    vae: fixedLink('4', 0),
  }),
  '14': workflowNode('CreateVideo', {
    images: fixedLink('12', 0),
    audio: fixedLink('13', 0),
    fps: { type: 'integer', const: 24 },
  }),
  '15': workflowNode('SaveVideo', {
    video: fixedLink('14', 0),
    filename_prefix: { type: 'string' },
    format: { type: 'string', const: 'mp4' },
    codec: { type: 'string', const: 'auto' },
  }),
});

export const DIRECTOR_WIRE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'selected_submission_id',
    'credit_username',
    'scene_summary_zh',
    'duration_seconds',
    'continuity_from_previous',
    'shot_relation',
    'use_previous_end_frame',
    'use_motion_context',
    'h3_prompt_en',
    'dialogue_en',
    'continuity_updates',
    'episode_should_end',
    'episode_end_reason',
    'comfyui_workflow',
    'comfyui_capabilities_version',
    'director_schema_version',
  ],
  properties: {
    selected_submission_id: { type: ['string', 'null'] },
    credit_username: { type: ['string', 'null'] },
    scene_summary_zh: { type: 'string' },
    duration_seconds: { type: 'number', minimum: 5, maximum: 15 },
    continuity_from_previous: { type: 'string' },
    shot_relation: { type: 'string', enum: ['continuous_event', 'new_shot'] },
    use_previous_end_frame: { type: 'boolean' },
    use_motion_context: { type: 'boolean', const: false },
    h3_prompt_en: {
      type: 'string',
      description:
        'Complete MiniMax H3 T2VA or controlled previous-tail I2VA prompt, at most 2000 English words and independent of the public synopsis. It uses summary, detailed_description, overall_soundscape and non_diegetic_music in that exact order; I2VA starts with the exact Picture 1 alignment line. Match the proven Spider-Man/Batman rooftop reference with crisp high-detail full-3D characters, a stabilized medium-wide gameplay camera, a sharp readable layered arena, concrete materials, ordered physical action and motion streaks localized to moving subjects. Explicitly reject full-frame motion blur, depth-of-field blur, fog wash and camera shake. Each dialogue_en line appears exactly once and verbatim inside <d>[English] ...</d>.',
    },
    dialogue_en: { type: 'array', items: dialogueLine },
    continuity_updates: { type: 'array', items: { type: 'string' } },
    episode_should_end: { type: 'boolean' },
    episode_end_reason: { type: ['string', 'null'] },
    comfyui_workflow: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        // The server owns and recompiles all executable nodes. Keeping the
        // model placeholder empty avoids wasting constrained-output tokens on
        // a 15-node graph that is discarded before validation and dispatch.
        prompt: strictObject({}),
      },
    },
    comfyui_capabilities_version: {
      type: 'string',
      const: 'h3-capabilities-v5',
    },
    director_schema_version: { type: 'string', const: 'scene-director-v1' },
  },
} as const;

export const FILM_DIRECTOR_WIRE_SCHEMA = {
  ...DIRECTOR_WIRE_SCHEMA,
  required: [...DIRECTOR_WIRE_SCHEMA.required, 'film_plan'],
  properties: {
    ...DIRECTOR_WIRE_SCHEMA.properties,
    film_plan: FILM_PLAN_SCHEMA,
    h3_prompt_en: { type: 'string', const: '', description: 'Server compiles film_plan into H3 text. Return an empty string.' },
    comfyui_capabilities_version: { type: 'string', const: 'h3-capabilities-v6' },
    director_schema_version: { type: 'string', const: 'scene-director-v2' },
  },
} as const;

/** OpenAI does not accept object-valued const. Keep its shape and expose the
 * pinned value as context; the original schema remains the local validator. */
export function openAiOutputSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(openAiOutputSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const result = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, openAiOutputSchema(value)]));
  if (result.const !== null && typeof result.const === 'object') {
    result.description = `Copy this inherited value exactly: ${JSON.stringify(result.const)}`;
    delete result.const;
  }
  return result;
}

/** Previous scenes remain prompt context, never hard constraints on story. */
export function filmDirectorWireSchema(previous?: FilmState | null) {
  void previous;
  return FILM_DIRECTOR_WIRE_SCHEMA;
}

export const SUBTITLE_WIRE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'audio_language',
    'actual_duration_seconds',
    'cues',
    'subtitle_schema_version',
  ],
  properties: {
    audio_language: { type: 'string', const: 'en' },
    actual_duration_seconds: { type: 'number' },
    cues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'cue_id',
          'speaker',
          'start_seconds',
          'end_seconds',
          'text',
        ],
        properties: {
          cue_id: { type: 'string' },
          speaker: { type: 'string' },
          start_seconds: { type: 'number' },
          end_seconds: { type: 'number' },
          text: localizedText,
        },
      },
    },
    subtitle_schema_version: { type: 'string', const: 'scene-subtitles-v1' },
  },
} as const;

export const EPISODE_THEME_WIRE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'theme'],
  properties: {
    title: { type: 'string' },
    theme: { type: 'string' },
  },
} as const;
