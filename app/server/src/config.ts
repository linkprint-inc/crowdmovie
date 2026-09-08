// Environment validation. All three services (web, worker, codex) are the same
// build distinguished only by SERVICE_ROLE, so every one of them boots through
// loadConfig(). A missing or malformed key aborts the boot with that key named
// in the message: a half-configured service is worse than one that refuses to
// start, and the operator has to be able to read the reason out of journalctl.
//
// Named import, not default: ajv ships CJS with an ESM-shaped .d.ts, and under
// NodeNext a default import resolves to the module namespace rather than the
// class. `Ajv` is a real named export at both levels.
import { Ajv, type ErrorObject } from 'ajv';

const SERVICE_ROLES = ['web', 'worker', 'codex'] as const;
export type ServiceRole = (typeof SERVICE_ROLES)[number];

// pino's levels — LOG_LEVEL is handed straight to the Fastify logger.
const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  SERVICE_ROLE: ServiceRole;
  DATABASE_URL: string;
  SESSION_SECRET: string;
  PORT: number;
  HOST: string;
  LOG_LEVEL: LogLevel;
  MEDIA_DIR: string;
  OUTBOX_PATH: string;
  JOB_LEASE_MS: number;
  JOB_POLL_INTERVAL_MS: number;
  JOB_BACKOFF_BASE_MS: number;
  JOB_MAX_ATTEMPTS: number;
  ROUND_LENGTH_MS: number;
  FINAL_TOP_K: number;
  VOTE_ADOPT_THRESHOLD: number;
  CODEX_SCORE_MODEL: 'gpt-5.6-terra' | 'gpt-5.6-sol';
  CODEX_MODEL: string;
  CODEX_WORKSTATION_DIR: string;
  CODEX_SCORE_REASONING_EFFORT: 'high';
  CODEX_FINAL_REASONING_EFFORT: 'xhigh';
  CODEX_DIRECTOR_REASONING_EFFORT: 'xhigh';
  CODEX_OUTPUT_RETRIES: number;
  CODEX_TURN_TIMEOUT_SECONDS: number;
  QWEN_COPYRIGHT_FALLBACK_BASE_URL: string;
  QWEN_COPYRIGHT_FALLBACK_MODEL: string;
  QWEN_COPYRIGHT_FALLBACK_TIMEOUT_MS: number;
  QWEN_MAX_CONCURRENCY: number;
  H3_BASE_URL: string;
  H3_POLL_INTERVAL_MS: number;
  H3_REQUEST_TIMEOUT_MS: number;
  H3_WORKFLOW_REPAIR_RETRIES: number;
}

// Only the keys the services actually use today. Later milestones add their own
// (H3 gateway, Codex credentials, SMTP) as they gain a real reader.
const KEYS = [
  'SERVICE_ROLE',
  'DATABASE_URL',
  'SESSION_SECRET',
  'PORT',
  'HOST',
  'LOG_LEVEL',
  'MEDIA_DIR',
  'OUTBOX_PATH',
  'JOB_LEASE_MS',
  'JOB_POLL_INTERVAL_MS',
  'JOB_BACKOFF_BASE_MS',
  'JOB_MAX_ATTEMPTS',
  'ROUND_LENGTH_MS',
  'FINAL_TOP_K',
  'VOTE_ADOPT_THRESHOLD',
  'CODEX_SCORE_MODEL',
  'CODEX_MODEL',
  'CODEX_WORKSTATION_DIR',
  'CODEX_SCORE_REASONING_EFFORT',
  'CODEX_FINAL_REASONING_EFFORT',
  'CODEX_DIRECTOR_REASONING_EFFORT',
  'CODEX_OUTPUT_RETRIES',
  'CODEX_TURN_TIMEOUT_SECONDS',
  'QWEN_COPYRIGHT_FALLBACK_BASE_URL',
  'QWEN_COPYRIGHT_FALLBACK_MODEL',
  'QWEN_COPYRIGHT_FALLBACK_TIMEOUT_MS',
  'QWEN_MAX_CONCURRENCY',
  'H3_BASE_URL',
  'H3_POLL_INTERVAL_MS',
  'H3_REQUEST_TIMEOUT_MS',
  'H3_WORKFLOW_REPAIR_RETRIES',
] as const;

const schema = {
  type: 'object',
  required: ['SERVICE_ROLE', 'DATABASE_URL', 'SESSION_SECRET'],
  additionalProperties: false,
  properties: {
    SERVICE_ROLE: { type: 'string', enum: SERVICE_ROLES },
    DATABASE_URL: { type: 'string', minLength: 1 },
    // 32 chars is the floor for a session-signing secret worth having.
    SESSION_SECRET: { type: 'string', minLength: 32 },
    PORT: { type: 'integer', minimum: 1, maximum: 65535, default: 3100 },
    HOST: { type: 'string', minLength: 1, default: '127.0.0.1' },
    LOG_LEVEL: { type: 'string', enum: LOG_LEVELS, default: 'info' },
    // Where §10/§11 的媒体文件 live on disk: `<MEDIA_DIR>/000042.mp4` and its
    // four WebVTT sidecars, which Caddy serves as `/media/000042.mp4`. The
    // publish gate (jobs/handlers/publish.ts) resolves a scene's media URLs
    // against this directory before it will let the scene into the movie, so a
    // wrong value here fails rounds loudly rather than publishing blind.
    MEDIA_DIR: {
      type: 'string',
      minLength: 1,
      default: '/var/lib/crowdmovie/media',
    },
    // Outbound mail is appended here as JSON lines until an SMTP provider is
    // picked (§7 开放决策). It carries live password-reset tokens, so the
    // default sits in the service's own state directory, not in /var/log.
    OUTBOX_PATH: {
      type: 'string',
      minLength: 1,
      default: '/var/lib/crowdmovie/outbox.log',
    },
    // Job ledger tunables (§5.1/§5.3), read by ledgerSettings() in
    // jobs/ledger.ts. The defaults are the ones the tests and a single-worker
    // deployment both run on; an operator only touches them when a channel's
    // real work outgrows them.
    //
    // How long a claimed job stays claimed. Long jobs (H3 video generation)
    // renew instead of asking for a bigger lease, so this is also how quickly a
    // killed worker's job is noticed.
    JOB_LEASE_MS: { type: 'integer', minimum: 1000, default: 60000 },
    // Safety net for lost notifications, not the primary wake-up path (§5.3).
    JOB_POLL_INTERVAL_MS: { type: 'integer', minimum: 100, default: 2000 },
    // First retry delay; doubles per attempt with jitter.
    JOB_BACKOFF_BASE_MS: { type: 'integer', minimum: 1, default: 1000 },
    // Total attempts before a retryable failure becomes `dead` (§5.2 达到上限
    // 后必须进入明确失败状态).
    JOB_MAX_ATTEMPTS: { type: 'integer', minimum: 1, default: 5 },
    // §5: the first human next-shot submission, or an enabled automatic
    // successor, starts this fixed voting window. Other empty rounds remain
    // unarmed. Exposed because integration tests cannot wait five minutes;
    // production leaves it alone.
    ROUND_LENGTH_MS: { type: 'integer', minimum: 500, default: 300000 },
    // §6.4/§6.6 `CROWD_AI_MOVIE_FINAL_TOP_K`, named to match the JOB_* keys
    // above rather than the spec's suggested prefix.
    FINAL_TOP_K: { type: 'integer', minimum: 1, default: 10 },
    // §5.4 的直采阈值 `CROWD_AI_MOVIE_VOTE_ADOPT_THRESHOLD`（默认 10），same
    // naming compromise as FINAL_TOP_K. Compared against 净赞
    // (`up_count - down_count`), so the floor is 1 — a threshold of 0 would
    // adopt a proposal nobody voted for.
    VOTE_ADOPT_THRESHOLD: { type: 'integer', minimum: 1, default: 10 },
    // Retained for the Codex-only task configuration and rollback compatibility.
    // Production submission scoring is routed to Qwen in ai/codex.ts.
    CODEX_SCORE_MODEL: {
      type: 'string',
      enum: ['gpt-5.6-terra', 'gpt-5.6-sol'],
      default: 'gpt-5.6-terra',
    },
    // Episode planning and any still-creative final pass stay on Sol. Public AI
    // pitches, scoring, directing and subtitles use Qwen no-thinking.
    CODEX_MODEL: { type: 'string', const: 'gpt-5.6-sol', default: 'gpt-5.6-sol' },
    CODEX_WORKSTATION_DIR: {
      type: 'string',
      minLength: 1,
      default: '/opt/crowdmovie/workstation',
    },
    CODEX_SCORE_REASONING_EFFORT: {
      type: 'string',
      const: 'high',
      default: 'high',
    },
    CODEX_FINAL_REASONING_EFFORT: {
      type: 'string',
      const: 'xhigh',
      default: 'xhigh',
    },
    CODEX_DIRECTOR_REASONING_EFFORT: {
      type: 'string',
      const: 'xhigh',
      default: 'xhigh',
    },
    CODEX_OUTPUT_RETRIES: {
      type: 'integer',
      minimum: 0,
      maximum: 2,
      default: 2,
    },
    CODEX_TURN_TIMEOUT_SECONDS: {
      type: 'integer',
      minimum: 30,
      maximum: 1800,
      default: 300,
    },
    QWEN_COPYRIGHT_FALLBACK_BASE_URL: {
      type: 'string',
      pattern: '^https?://[^/]+(?::[0-9]+)?/v1/?$',
      default: 'http://192.168.10.30:8000/v1',
    },
    QWEN_COPYRIGHT_FALLBACK_MODEL: {
      type: 'string',
      const: 'qwen3.8-27b-huihui-abliterated-nvfp4',
      default: 'qwen3.8-27b-huihui-abliterated-nvfp4',
    },
    QWEN_COPYRIGHT_FALLBACK_TIMEOUT_MS: {
      type: 'integer',
      minimum: 1000,
      maximum: 600000,
      default: 300000,
    },
    // The Qwen gateway has four slots; CrowdMovie intentionally leaves one
    // available to other clients on the shared inference service.
    QWEN_MAX_CONCURRENCY: {
      type: 'integer',
      minimum: 1,
      maximum: 3,
      default: 3,
    },
    H3_BASE_URL: {
      type: 'string',
      pattern: '^https?://[^/]+(?::[0-9]+)?/?$',
      default: 'http://192.168.10.20:8191',
    },
    H3_POLL_INTERVAL_MS: {
      type: 'integer',
      minimum: 500,
      maximum: 60000,
      default: 2000,
    },
    H3_REQUEST_TIMEOUT_MS: {
      type: 'integer',
      minimum: 1000,
      maximum: 300000,
      default: 30000,
    },
    H3_WORKFLOW_REPAIR_RETRIES: {
      type: 'integer',
      minimum: 0,
      maximum: 2,
      default: 2,
    },
  },
};

// coerceTypes turns the string env values into the declared types (PORT), and
// useDefaults fills the optional keys. Both mutate the validated object, which
// is why loadConfig validates a copy rather than the caller's env.
const ajv = new Ajv({ allErrors: true, coerceTypes: true, useDefaults: true });
const validate = ajv.compile<Config>(schema);

function describeError(error: ErrorObject): string {
  if (error.keyword === 'required') {
    return `${error.params.missingProperty as string} is required`;
  }
  const key = error.instancePath.replace(/^\//, '') || 'environment';
  if (error.keyword === 'enum') {
    const allowed = (error.params.allowedValues as string[]).join(', ');
    return `${key} must be one of: ${allowed}`;
  }
  return `${key} ${error.message ?? 'is invalid'}`;
}

/**
 * Validate `env` and return the typed config.
 *
 * @throws Error naming every offending key when validation fails.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const candidate: Record<string, unknown> = {};
  for (const key of KEYS) {
    const value = env[key];
    if (value !== undefined) {
      candidate[key] = value;
    }
  }

  if (!validate(candidate)) {
    // Ajv can report several failures for one key (type then range); dedupe so
    // the message stays readable.
    const reasons = [...new Set((validate.errors ?? []).map(describeError))];
    throw new Error(`Invalid environment: ${reasons.join('; ')}`);
  }

  return candidate;
}
