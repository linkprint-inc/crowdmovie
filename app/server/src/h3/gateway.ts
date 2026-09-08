import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { DirectSceneOutput } from '../ai/engine.js';
import { FILM_CAPABILITIES, FILM_STYLE_PROFILE } from '../ai/film-plan.js';


export const H3_CAPABILITIES_VERSION = 'h3-capabilities-v5';
export const H3_STYLE_PROFILE = 'whos-next-spiderman-batman-quality-reference-v8';
export const H3_CHARACTER_PROFILE = 'whos-next-famous-cast-v3';

export interface H3Capabilities {
  version: string;
  fps: number;
  sizes: number[][];
  node_classes: string[];
  models: Record<string, string[]>;
  style_profile: string;
  style_enforced: boolean;
  character_profile: string;
  character_enforced: boolean;
  [key: string]: unknown;
}

export interface H3Output {
  filename: string;
  subfolder: string;
  type: string;
  downloadUrl: string;
}

export type H3JobStatus = 'running' | 'completed' | 'failed';

export interface H3Job {
  jobId: string;
  promptId: string;
  roundId: string;
  motionContextId: string | null;
  status: H3JobStatus;
  outputs: H3Output[];
  error: { code: string; message: string; details?: unknown } | null;
  styleEnforced: boolean;
  characterEnforced: boolean;
}

export interface H3WorkflowValidation {
  valid: true;
  roundId: string;
  capabilitiesVersion: string;
  nodeCount: number;
  styleEnforced: true;
  characterEnforced: true;
  generationSubmitted: false;
}

export interface H3WorkflowOptions {
  firstFrame?: {
    sha256: string;
    png: Buffer;
  };
}

interface GatewayErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export class H3GatewayError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'H3GatewayError';
  }
}

export class H3ValidationError extends H3GatewayError {
  constructor(message: string, code: string, details?: unknown) {
    super(message, code, details);
    this.name = 'H3ValidationError';
  }
}

export class H3BusyError extends H3GatewayError {
  constructor(message: string, code = 'fasth3_busy', details?: unknown) {
    super(message, code, details);
    this.name = 'H3BusyError';
  }
}

type Fetch = typeof fetch;

function assertObject(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new H3GatewayError(`${what} is not a JSON object`, 'invalid_response');
  }
  return value as Record<string, unknown>;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
  what: string,
): string {
  const found = value[key];
  if (typeof found !== 'string' || found.length === 0) {
    throw new H3GatewayError(`${what}.${key} is missing`, 'invalid_response');
  }
  return found;
}

function mapJob(value: unknown): H3Job {
  const body = assertObject(value, 'FastH3 job');
  const status = stringField(body, 'status', 'FastH3 job');
  if (!['running', 'completed', 'failed'].includes(status)) {
    throw new H3GatewayError(
      `FastH3 returned unknown status ${status}`,
      'invalid_response',
    );
  }
  const outputs = Array.isArray(body.outputs)
    ? body.outputs.map((raw) => {
        const output = assertObject(raw, 'FastH3 output');
        return {
          filename: stringField(output, 'filename', 'FastH3 output'),
          subfolder:
            typeof output.subfolder === 'string' ? output.subfolder : '',
          type: typeof output.type === 'string' ? output.type : 'output',
          downloadUrl: stringField(output, 'download_url', 'FastH3 output'),
        };
      })
    : [];
  const error =
    body.error === null || body.error === undefined
      ? null
      : (() => {
          const each = assertObject(body.error, 'FastH3 job error');
          return {
            code: stringField(each, 'code', 'FastH3 job error'),
            message: stringField(each, 'message', 'FastH3 job error'),
            details: each.details,
          };
        })();

  const roundId = stringField(body, 'round_id', 'FastH3 job');
  if (body.motion_context_id !== null) {
    throw new H3GatewayError(
      'FastH3 job motion_context_id must be null for production v5',
      'invalid_response',
    );
  }
  return {
    jobId: stringField(body, 'job_id', 'FastH3 job'),
    promptId: stringField(body, 'prompt_id', 'FastH3 job'),
    roundId,
    motionContextId: null,
    status: status as H3JobStatus,
    outputs,
    error,
    styleEnforced: body.style_enforced === true,
    characterEnforced: body.character_enforced === true,
  };
}

async function errorFor(response: Response): Promise<H3GatewayError> {
  let body: GatewayErrorBody = {};
  try {
    body = (await response.json()) as GatewayErrorBody;
  } catch {
    // The status code remains useful even when an upstream proxy returned HTML.
  }
  const code = body.error?.code ?? `http_${response.status}`;
  const message =
    body.error?.message ?? `FastH3 gateway returned HTTP ${response.status}`;
  if (response.status === 400) {
    return new H3ValidationError(message, code, body.error?.details);
  }
  if (response.status === 409) {
    return new H3BusyError(message, code, body.error?.details);
  }
  return new H3GatewayError(message, code, body.error?.details);
}

export class H3GatewayClient {
  private readonly base: URL;

  constructor(
    baseUrl: string,
    private readonly fetchFn: Fetch = fetch,
    private readonly requestTimeoutMs = 30_000,
  ) {
    this.base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    if (!['http:', 'https:'].includes(this.base.protocol)) {
      throw new Error('H3 base URL must use HTTP or HTTPS');
    }
  }

  private url(path: string): string {
    return new URL(path.replace(/^\//, ''), this.base).toString();
  }

  async getCapabilities(): Promise<H3Capabilities> {
    const response = await this.fetchFn(this.url('/v1/capabilities'), {
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) throw await errorFor(response);
    const body = assertObject(await response.json(), 'FastH3 capabilities');
    if (body.version !== H3_CAPABILITIES_VERSION && body.version !== FILM_CAPABILITIES) {
      throw new H3GatewayError(
        `FastH3 capability version must be ${H3_CAPABILITIES_VERSION}`,
        'capabilities_version_mismatch',
      );
    }
    if (
      body.style_enforced !== true ||
      body.style_profile !== (body.version === FILM_CAPABILITIES ? FILM_STYLE_PROFILE : H3_STYLE_PROFILE)
    ) {
      throw new H3GatewayError(
        'FastH3 visual-policy enforcement is not the pinned profile',
        'style_enforcement_mismatch',
      );
    }
    if (
      body.character_enforced !== true ||
      body.character_profile !== H3_CHARACTER_PROFILE
    ) {
      throw new H3GatewayError(
        'FastH3 casting-policy enforcement is not the pinned profile',
        'character_enforcement_mismatch',
      );
    }
    const fixed = assertObject(body.fixed_parameters, 'FastH3 fixed_parameters');
    if (fixed.steps !== 8 || fixed.nfe !== '8') {
      throw new H3GatewayError(
        'FastH3 is not pinned to PDD NFE 8',
        'fixed_parameters_mismatch',
      );
    }
    return body as unknown as H3Capabilities;
  }

  private workflowEnvelope(
    roundId: string,
    director: DirectSceneOutput,
    options: H3WorkflowOptions = {},
  ): Record<string, unknown> {
    const { firstFrame } = options;
    if (director.useMotionContext) {
      throw new H3ValidationError(
        'Motion Context is disabled in production v5',
        'motion_context_disabled',
      );
    }
    if (director.usePreviousEndFrame && firstFrame === undefined) {
      throw new H3ValidationError(
        'director requested previous-tail I2VA but no verified PNG was supplied',
        'first_frame_missing',
      );
    }
    if (!director.usePreviousEndFrame && firstFrame !== undefined) {
      throw new H3ValidationError(
        'a first frame was supplied for a stateless T2VA shot',
        'first_frame_unexpected',
      );
    }
    if (firstFrame !== undefined) {
      if (!/^[0-9a-f]{64}$/.test(firstFrame.sha256)) {
        throw new H3ValidationError(
          'first-frame sha256 is malformed',
          'first_frame_invalid',
        );
      }
      const actual = crypto.createHash('sha256').update(firstFrame.png).digest('hex');
      if (actual !== firstFrame.sha256) {
        throw new H3ValidationError(
          'first-frame bytes do not match the declared sha256',
          'first_frame_hash_mismatch',
        );
      }
    }
    const h3Nodes = Object.values(director.comfyuiWorkflow.prompt).filter(
      (node) => node.class_type === 'MiniMaxH3ImageToVideo',
    );
    if (h3Nodes.length !== 1) {
      throw new H3ValidationError(
        'director workflow must contain one MiniMaxH3ImageToVideo node',
        'node_count_mismatch',
      );
    }
    const width = h3Nodes[0].inputs.width;
    const height = h3Nodes[0].inputs.height;
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
      throw new H3ValidationError(
        'director workflow dimensions are missing',
        'dimensions_invalid',
      );
    }
    if (width !== 1344 || height !== 768) {
      throw new H3ValidationError(
        'director workflow must use the fixed 1344x768 landscape output',
        'dimensions_not_768p',
        { expected: { width: 1344, height: 768 }, received: { width, height } },
      );
    }
    const envelope: Record<string, unknown> = {
      round_id: roundId,
      idempotency_key: `h3:${roundId}:v1`,
      capabilities_version: director.comfyuiCapabilitiesVersion,
      expected: {
        width,
        height,
        duration_seconds: director.durationSeconds,
        fps: 24,
      },
      prompt: director.comfyuiWorkflow.prompt,
    };
    if (firstFrame !== undefined) {
      envelope.first_frame = {
        sha256: firstFrame.sha256,
        png_base64: firstFrame.png.toString('base64'),
      };
    }
    return envelope;
  }

  /** Run the gateway's exact allowlist guard without creating a generation. */
  async validateWorkflow(
    roundId: string,
    director: DirectSceneOutput,
    options: H3WorkflowOptions = {},
  ): Promise<H3WorkflowValidation> {
    const response = await this.fetchFn(this.url('/v1/workflows/validate'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(this.workflowEnvelope(roundId, director, options)),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) throw await errorFor(response);
    const body = assertObject(await response.json(), 'FastH3 validation');
    if (
      body.valid !== true ||
      body.round_id !== roundId ||
      body.capabilities_version !== director.comfyuiCapabilitiesVersion ||
      !Number.isInteger(body.node_count) ||
      body.style_enforced !== true ||
      body.character_enforced !== true ||
      body.generation_submitted !== false
    ) {
      throw new H3GatewayError(
        'FastH3 validation response is incomplete',
        'invalid_response',
      );
    }
    return {
      valid: true,
      roundId,
      capabilitiesVersion: body.capabilities_version as string,
      nodeCount: body.node_count as number,
      styleEnforced: true,
      characterEnforced: true,
      generationSubmitted: false,
    };
  }

  async submitWorkflow(
    roundId: string,
    director: DirectSceneOutput,
    options: H3WorkflowOptions = {},
  ): Promise<H3Job> {
    const response = await this.fetchFn(this.url('/v1/workflows'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(this.workflowEnvelope(roundId, director, options)),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) throw await errorFor(response);
    const job = mapJob(await response.json());
    if (!job.styleEnforced || !job.characterEnforced) {
      throw new H3GatewayError(
        'FastH3 accepted a job without visual/casting policy enforcement',
        'enforcement_missing',
      );
    }
    return job;
  }

  async getJob(jobId: string): Promise<H3Job> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) {
      throw new H3GatewayError('FastH3 job id is malformed', 'job_id_invalid');
    }
    const response = await this.fetchFn(this.url(`/v1/jobs/${jobId}`), {
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) throw await errorFor(response);
    return mapJob(await response.json());
  }

  /** Stream the first completed MP4 to a private pending path and hash it. */
  async downloadVideo(job: H3Job, destination: string): Promise<string> {
    const output = job.outputs.find((item) => item.filename.endsWith('.mp4'));
    if (output === undefined) {
      throw new H3GatewayError(
        'completed FastH3 job has no MP4 output',
        'video_output_missing',
      );
    }
    const source = new URL(output.downloadUrl);
    if (source.origin !== this.base.origin || source.pathname !== '/v1/output') {
      throw new H3GatewayError(
        'FastH3 output URL is outside the configured gateway',
        'output_url_not_allowed',
      );
    }
    const response = await this.fetchFn(source.toString(), {
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok || response.body === null) throw await errorFor(response);

    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${crypto.randomUUID()}.part`;
    const hash = crypto.createHash('sha256');
    const hashing = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk as Buffer);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        hashing,
        createWriteStream(temporary, { flags: 'wx', mode: 0o640 }),
      );
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return hash.digest('hex');
  }
}
