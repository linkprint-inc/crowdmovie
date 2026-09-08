import { readFileSync } from 'node:fs';

import { Ajv } from 'ajv';

import {
  DIRECTOR_WIRE_SCHEMA,
  PINNED_PDD_FL2VA_WORKFLOW_SCHEMA,
} from '../src/ai/wire-schemas';

function assertStrictObjects(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  const schema = value as Record<string, unknown>;
  if (schema.type === 'object') {
    expect(schema.additionalProperties, path).toBe(false);
    const properties = schema.properties as Record<string, unknown> | undefined;
    expect(properties, `${path}.properties`).toBeDefined();
    expect(schema.required, `${path}.required`).toEqual(Object.keys(properties ?? {}));
  }
  for (const [key, child] of Object.entries(schema)) {
    if (key === 'const') continue;
    if (Array.isArray(child)) {
      child.forEach((item, index) => assertStrictObjects(item, `${path}.${key}[${index}]`));
    } else {
      assertStrictObjects(child, `${path}.${key}`);
    }
  }
}

function assertNoArrayConst(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoArrayConst(item, `${path}[${index}]`));
    return;
  }
  const schema = value as Record<string, unknown>;
  if (schema.type === 'array') {
    expect(Array.isArray(schema.const), `${path}.const`).toBe(false);
  }
  for (const [key, child] of Object.entries(schema)) {
    assertNoArrayConst(child, `${path}.${key}`);
  }
}

test('director Structured Output schema closes every object property set', () => {
  assertStrictObjects(DIRECTOR_WIRE_SCHEMA);
  assertNoArrayConst(DIRECTOR_WIRE_SCHEMA);
});

test('director Structured Output schema exposes controlled tail-frame I2VA and disables Motion Context', () => {
  const schema = DIRECTOR_WIRE_SCHEMA as {
    required: string[];
    properties: Record<string, { const?: unknown }>;
  };
  expect(schema.required).toContain('use_motion_context');
  expect(schema.properties.use_motion_context).toEqual({
    type: 'boolean',
    const: false,
  });
  expect(schema.properties.use_previous_end_frame).toEqual({
    type: 'boolean',
  });
  expect(schema.properties.comfyui_capabilities_version.const).toBe(
    'h3-capabilities-v5',
  );
});

test('the backend owns the pinned PDD8 graph while Qwen returns only an empty placeholder', () => {
  const validate = new Ajv().compile(DIRECTOR_WIRE_SCHEMA);
  const validatePinnedGraph = new Ajv().compile(
    PINNED_PDD_FL2VA_WORKFLOW_SCHEMA,
  );
  const prompt = JSON.parse(
    readFileSync(
      new URL('../../../ops/fasth3/workflow_api.json', import.meta.url),
      'utf8',
    ),
  ) as Record<string, { inputs?: Record<string, unknown> }>;
  expect(Object.keys(prompt)).toHaveLength(15);
  expect(prompt['7']?.inputs).not.toHaveProperty('first_frame');
  expect(prompt['6']?.inputs?.nfe).toBe('8');
  expect(prompt['1']?.inputs?.unet_name).toBe(
    'minimax_h3_fl2va_int8_convrot.safetensors',
  );
  expect(validatePinnedGraph(prompt), JSON.stringify(validatePinnedGraph.errors)).toBe(true);
  expect(validate({
      selected_submission_id: '00000000-0000-4000-8000-000000000003',
      credit_username: 'internal_canary',
      scene_summary_zh: 'A test shot.',
      duration_seconds: 5,
      continuity_from_previous: 'A new shot.',
      shot_relation: 'new_shot',
      use_previous_end_frame: false,
      use_motion_context: false,
      h3_prompt_en: 'A school cafeteria scene.',
      dialogue_en: [],
      continuity_updates: [],
      episode_should_end: false,
      episode_end_reason: null,
      comfyui_workflow: { prompt: {} },
      comfyui_capabilities_version: 'h3-capabilities-v5',
      director_schema_version: 'scene-director-v1',
    }), JSON.stringify(validate.errors)).toBe(true);
  expect(validate.errors).toBeNull();
  expect(validate({
    selected_submission_id: null,
    credit_username: null,
    scene_summary_zh: 'A test shot.',
    duration_seconds: 5,
    continuity_from_previous: 'A new shot.',
    shot_relation: 'new_shot',
    use_previous_end_frame: false,
    use_motion_context: false,
    h3_prompt_en: 'A school cafeteria scene.',
    dialogue_en: [],
    continuity_updates: [],
    episode_should_end: false,
    episode_end_reason: null,
    comfyui_workflow: { prompt },
    comfyui_capabilities_version: 'h3-capabilities-v5',
    director_schema_version: 'scene-director-v1',
  })).toBe(false);
});
