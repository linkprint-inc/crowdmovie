import crypto from 'node:crypto';

import { type DirectSceneOutput } from '../src/ai/engine';
import {
  H3BusyError,
  H3GatewayClient,
  H3ValidationError,
} from '../src/h3/gateway';


const ROUND_ID = '11111111-1111-4111-8111-111111111111';
const T2VA_PROMPT =
  'summary:\nSpider-Man and Batman collide inside a crisp high-detail 3D fighting-game arena.\n\ndetailed_description:\nA stabilized medium-wide gameplay camera tracks slowly sideways while keeping the entire rain-slick rooftop arena sharp and readable. Spider-Man launches a flying kick and Batman blocks with his armored forearm. Fast character motion has only localized limb and cape streaks; no full-frame motion blur, no depth-of-field blur, no fog wash, no camera shake.\n\noverall_soundscape:\nRain and heavy impacts.\n\nnon_diegetic_music:\nOriginal tense percussion.';

function directorOutput(): DirectSceneOutput {
  return {
    selectedSubmissionId: null,
    creditUsername: null,
    sceneSummaryZh: 'A test shot.',
    durationSeconds: 5,
    continuityFromPrevious: 'A new shot.',
    shotRelation: 'new_shot',
    usePreviousEndFrame: false,
    useMotionContext: false,
    h3PromptEn: T2VA_PROMPT,
    dialogueEn: [],
    continuityUpdates: [],
    episodeShouldEnd: false,
    episodeEndReason: null,
    comfyuiWorkflow: {
      prompt: {
        '7': {
          class_type: 'MiniMaxH3ImageToVideo',
          inputs: {
            prompt: T2VA_PROMPT,
            width: 1344,
            height: 768,
            length: 124,
          },
        },
      },
    },
    comfyuiCapabilitiesVersion: 'h3-capabilities-v5',
    directorSchemaVersion: 'scene-director-v1',
  };
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function acceptedJob(status: 'running' | 'completed' = 'running') {
  return {
    job_id: 'job-1',
    prompt_id: 'prompt-1',
    status,
    round_id: ROUND_ID,
    motion_context_id: null,
    outputs: [],
    style_enforced: true,
    character_enforced: true,
  };
}

test('capabilities require the pinned PDD8 full-INT8 version and both server-side guards', async () => {
  const fetchFn = vi.fn(async () =>
    response(200, {
      version: 'h3-capabilities-v5',
      fps: 24,
      sizes: [[1344, 768]],
      node_classes: ['MiniMaxH3ImageToVideo', 'LoadImage'],
      models: { unet: ['minimax_h3_fl2va_int8_convrot.safetensors'] },
      style_profile: 'whos-next-spiderman-batman-quality-reference-v8',
      style_enforced: true,
      character_profile: 'whos-next-famous-cast-v3',
      character_enforced: true,
      fixed_parameters: { steps: 8, nfe: '8' },
      image_conditioning: { first_frame: true, last_frame: false },
      motion_context: { enabled: false },
      external_loras: { enabled: false },
    }),
  );
  const client = new H3GatewayClient('http://192.168.10.20:8191', fetchFn);
  await expect(client.getCapabilities()).resolves.toMatchObject({
    fps: 24,
    fixed_parameters: { steps: 8, nfe: '8' },
  });

  fetchFn.mockResolvedValueOnce(
    response(200, {
      version: 'h3-capabilities-v5',
      style_enforced: false,
      character_enforced: true,
    }),
  );
  await expect(client.getCapabilities()).rejects.toThrow(/visual-policy enforcement/);
});

test('stateless submission uses the canonical PDD8 envelope without image or motion state', async () => {
  const fetchFn = vi.fn(async () => response(202, acceptedJob()));
  const client = new H3GatewayClient('http://192.168.10.20:8191', fetchFn);
  await client.submitWorkflow(ROUND_ID, directorOutput());

  const [url, init] = fetchFn.mock.calls[0];
  expect(url).toBe('http://192.168.10.20:8191/v1/workflows');
  const body = JSON.parse(String(init?.body));
  expect(body).toMatchObject({
    round_id: ROUND_ID,
    idempotency_key: `h3:${ROUND_ID}:v1`,
    capabilities_version: 'h3-capabilities-v5',
    expected: { width: 1344, height: 768, duration_seconds: 5, fps: 24 },
  });
  expect(body).not.toHaveProperty('first_frame');
  expect(body).not.toHaveProperty('motion_context');
  expect(body.prompt).toEqual(directorOutput().comfyuiWorkflow.prompt);
});

test('I2VA submission transports the verified previous-tail digest and PNG only when requested', async () => {
  const i2va = {
    ...directorOutput(),
    shotRelation: 'continuous_event' as const,
    usePreviousEndFrame: true,
  };
  const fetchFn = vi.fn(async () => response(202, acceptedJob()));
  const client = new H3GatewayClient('http://192.168.10.20:8191', fetchFn);
  const png = Buffer.from('verified png bytes');
  const sha256 = crypto.createHash('sha256').update(png).digest('hex');

  await expect(client.submitWorkflow(ROUND_ID, i2va)).rejects.toMatchObject({
    code: 'first_frame_missing',
  });
  await expect(
    client.submitWorkflow(ROUND_ID, directorOutput(), {
      firstFrame: { sha256, png },
    }),
  ).rejects.toMatchObject({ code: 'first_frame_unexpected' });

  await client.submitWorkflow(ROUND_ID, i2va, {
    firstFrame: { sha256, png },
  });
  const body = JSON.parse(String(fetchFn.mock.calls[0][1]?.body));
  expect(body.first_frame).toEqual({
    sha256,
    png_base64: png.toString('base64'),
  });
  expect(body).not.toHaveProperty('motion_context');
});

test('workflow validation runs the exact gateway guard without submitting generation', async () => {
  const fetchFn = vi.fn(async () =>
    response(200, {
      valid: true,
      round_id: ROUND_ID,
      capabilities_version: 'h3-capabilities-v5',
      node_count: 15,
      style_enforced: true,
      character_enforced: true,
      generation_submitted: false,
    }),
  );
  const client = new H3GatewayClient('http://192.168.10.20:8191', fetchFn);

  await expect(client.validateWorkflow(ROUND_ID, directorOutput())).resolves.toMatchObject({
    valid: true,
    roundId: ROUND_ID,
    nodeCount: 15,
    generationSubmitted: false,
  });
  expect(fetchFn.mock.calls[0][0]).toBe(
    'http://192.168.10.20:8191/v1/workflows/validate',
  );
});

test('Motion Context is rejected before any gateway request', async () => {
  const motion = {
    ...directorOutput(),
    shotRelation: 'continuous_event' as const,
    useMotionContext: true,
  };
  const fetchFn = vi.fn(async () => response(202, acceptedJob()));
  const client = new H3GatewayClient('http://192.168.10.20:8191', fetchFn);
  await expect(client.submitWorkflow(ROUND_ID, motion)).rejects.toMatchObject({
    code: 'motion_context_disabled',
  });
  expect(fetchFn).not.toHaveBeenCalled();
});

test('structured 400 and busy 409 remain distinct state-machine outcomes', async () => {
  const output = directorOutput();
  const invalid = new H3GatewayClient(
    'http://192.168.10.20:8191',
    vi.fn(async () =>
      response(400, {
        error: {
          code: 'length_mismatch',
          message: 'wrong length',
          details: { expected: 124, received: 125 },
        },
      }),
    ),
  );
  await expect(invalid.submitWorkflow(ROUND_ID, output)).rejects.toBeInstanceOf(
    H3ValidationError,
  );

  const busy = new H3GatewayClient(
    'http://192.168.10.20:8191',
    vi.fn(async () =>
      response(409, {
        error: { code: 'fasth3_busy', message: 'busy', details: {} },
      }),
    ),
  );
  await expect(busy.submitWorkflow(ROUND_ID, output)).rejects.toBeInstanceOf(
    H3BusyError,
  );
});

test('job polling accepts a null Motion Context ID', async () => {
  const fetchFn = vi.fn(async () =>
    response(200, {
      ...acceptedJob('completed'),
      outputs: [
        {
          filename: 'clip.mp4',
          subfolder: 'video/FastH3',
          type: 'output',
          download_url:
            'http://192.168.10.20:8191/v1/output?filename=clip.mp4&subfolder=video%2FFastH3',
        },
      ],
    }),
  );
  const client = new H3GatewayClient('http://192.168.10.20:8191', fetchFn);
  await expect(client.getJob('job-1')).resolves.toMatchObject({
    status: 'completed',
    motionContextId: null,
    outputs: [{ filename: 'clip.mp4' }],
  });
});

test('job responses reject a non-null legacy Motion Context ID', async () => {
  const client = new H3GatewayClient(
    'http://192.168.10.20:8191',
    vi.fn(async () =>
      response(200, {
        ...acceptedJob('completed'),
        motion_context_id: ROUND_ID,
      }),
    ),
  );
  await expect(client.getJob('job-1')).rejects.toMatchObject({
    code: 'invalid_response',
  });
});
