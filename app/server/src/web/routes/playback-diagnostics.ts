import type { FastifyInstance } from 'fastify';
import { FixedWindowCounter } from '../../lib/rate-limit.js';

export async function playbackDiagnosticRoutes(app: FastifyInstance): Promise<void> {
  const counter = new FixedWindowCounter();
  const integer = { type: 'integer', minimum: 0, maximum: 1000000 };
  const flag = { type: 'boolean' };
  const number = { type: 'number', minimum: 0, maximum: 1000000000 };
  app.post('/api/diagnostics/playback', {
    bodyLimit: 4096,
    schema: { body: {
      type: 'object', additionalProperties: false,
      required: ['id', 'kind', 'source', 'sceneIndex', 'events'],
      properties: {
        id: { type: 'string', pattern: '^[a-f0-9-]{36}$' },
        kind: { enum: ['media_error', 'play_rejected', 'load_timeout', 'media_probe', 'buffered_ready', 'buffered_playing', 'buffered_failed', 'check_result'] },
        source: { type: 'string', maxLength: 200, pattern: '^/media/[a-zA-Z0-9_/-]+\\.mp4$' },
        version: { type: 'string', pattern: '^([a-f0-9]{64})?$' },
        engine: { enum: ['native', 'videojs'] },
        context: { enum: ['minimal_inline', 'minimal_fullscreen', 'external_control'] },
        mediaErrorMessage: { type: 'string', maxLength: 240 },
        delivery: { enum: ['direct', 'buffered'] },
        bufferedBytes: { type: 'integer', minimum: 0, maximum: 33554432 },
        parentId: { type: 'string', pattern: '^[a-f0-9-]{36}$' },
        probeStatus: integer, probeRedirected: flag,
        probeType: { type: 'string', maxLength: 80 },
        probeRange: { type: 'string', maxLength: 80 },
        probeRay: { type: 'string', maxLength: 80 },
        probeSignature: { type: 'string', maxLength: 32, pattern: '^[a-f0-9]*$' },
        probeError: { type: 'string', maxLength: 60 },
        sceneIndex: integer, readyState: integer, networkState: integer, errorCode: integer,
        currentTime: number, duration: number, videoWidth: integer, videoHeight: integer,
        mobile: flag, online: flag, visible: flag, paused: flag, muted: flag, controls: flag, playsInline: flag,
        errorName: { type: 'string', maxLength: 60, pattern: '^([A-Za-z]+Error)?$' },
        viewport: { type: 'string', pattern: '^[0-9]{1,5}x[0-9]{1,5}$' },
        events: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 50, pattern: '^[a-z_]+:[0-9]+$' } },
      },
    } },
  }, async (request, reply) => {
    if (counter.record(request.ip) > 20 || counter.record('global') > 300) {
      return reply.code(429).send({ error: 'rate_limited' });
    }
    request.log.warn({
      diagnostic: request.body,
      userAgent: String(request.headers['user-agent'] ?? '').slice(0, 512),
      edgeRay: String(request.headers['cf-ray'] ?? '').slice(0, 80),
    }, 'client_playback_failure');
    return reply.code(204).send();
  });
}
