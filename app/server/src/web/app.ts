// Fastify app construction, kept separate from index.ts so tests can drive it
// with app.inject() instead of binding a port.
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import type { Config } from '../config.js';
import { TRUSTED_PROXIES } from '../lib/trusted-proxies.js';
import { authPlugin } from '../plugins/auth.js';
import { authRoutes } from './routes/auth.js';
import { contactRoutes } from './routes/contact.js';
import { danmakuRoutes } from './routes/danmaku.js';
import { episodeBannerRoutes } from './routes/episode-banner.js';
import { episodeRoutes } from './routes/episodes.js';
import { eventRoutes } from './routes/events.js';
import { hallOfFameRoutes } from './routes/hall-of-fame.js';
import { identityRoutes } from './routes/identity.js';
import { meRoutes } from './routes/me.js';
import { movieRoutes } from './routes/movie.js';
import { playbackDiagnosticRoutes } from './routes/playback-diagnostics.js';
import { generationPromptRoutes } from './routes/generation-prompt.js';
import { storyAuthoringRoutes } from './routes/story-authoring.js';
import { storyRoutes } from './routes/stories.js';
import { submissionRoutes } from './routes/submissions.js';

interface HealthSummaryRow {
  codex_runs_today: string;
  codex_failures_today: string;
  input_tokens_today: string;
  cached_input_tokens_today: string;
  output_tokens_today: string;
  reasoning_output_tokens_today: string;
  jobs_pending: string;
  jobs_running: string;
  jobs_retrying: string;
  jobs_dead: string;
}

export interface AppOptions {
  /** Guest claims allowed per IP per minute; tests pin it. */
  guestClaimRateLimit?: number;
  /** Register / forgot / reset requests per IP per minute; tests pin it. */
  authIpRateLimit?: number;
  /** Failed logins per minute on each of the account and IP axes (§3.3). */
  loginFailureLimit?: number;
  /** 投稿 per minute per IP and per identity (§4 反滥用); tests pin it. */
  submissionRateLimit?: number;
  /** 投票 per minute per IP and per identity (§4 反滥用); tests pin it. */
  voteRateLimit?: number;
  /** 弹幕 per minute per IP (§14.3 的 IP 短窗); tests pin it. */
  danmakuIpRateLimit?: number;
  /** How long the 弹幕 `site_settings` read is cached; tests pin it to 0. */
  danmakuSettingsTtlMs?: number;
  /** How long the 名人堂 query is reused (§16.2 的 60 秒); tests pin it to 0. */
  hallOfFameTtlMs?: number;
  /** 草稿自动保存 per minute per IP and per identity; tests pin it. */
  draftRateLimit?: number;
  /** 留言 per minute per IP (§15); tests pin it. */
  contactIpRateLimit?: number;
  /** 留言 per minute per identity (§15); tests pin it. */
  contactUserRateLimit?: number;
  /** 故事设定写操作 per minute per IP and per identity; tests pin it. */
  storyRateLimit?: number;
  /** 故事设定跟帖 per minute per IP and per identity; tests pin it. */
  storyCommentRateLimit?: number;
  /** 故事设定点赞 per minute per IP and per identity; tests pin it. */
  storyLikeRateLimit?: number;
  /** §16.4 的 2 秒计票合并窗口; tests shorten it. */
  voteCoalesceMs?: number;
  /** Concurrent SSE stream ceiling; tests lower it so the cap is reachable. */
  maxEventClients?: number;
  /**
   * Register `GET /api/events`. Default on. Suites that never read the stream
   * turn it off so they do not hold a second PostgreSQL connection for the
   * length of the run.
   */
  events?: boolean;
}

export function buildApp(
  config: Config,
  pool: Pool,
  options: AppOptions = {},
): FastifyInstance {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    // SSE streams are intentionally long-lived. During a systemd restart they
    // must be closed with the listener instead of keeping app.close() pending
    // until TimeoutStopSec kills the old process.
    forceCloseConnections: true,
    // Only locally configured proxy addresses may assert the forwarded client.
    trustProxy: TRUSTED_PROXIES,
  });

  // Registered before the routes so the identity hook and `request.currentUser`
  // exist by the time any route context is built.
  app.register(authPlugin, { pool });
  app.register(identityRoutes, {
    pool,
    rateLimit: options.guestClaimRateLimit,
  });
  app.register(authRoutes, {
    pool,
    outboxPath: config.OUTBOX_PATH,
    ipRateLimit: options.authIpRateLimit,
    loginFailureLimit: options.loginFailureLimit,
  });
  app.register(submissionRoutes, {
    pool,
    // The round length lives with the thing that starts the countdown: the
    // first 投稿 arms `rounds.closes_at` (§5.3 未点火轮次).
    roundLengthMs: config.ROUND_LENGTH_MS,
    voteAdoptThreshold: config.VOTE_ADOPT_THRESHOLD,
    submissionRateLimit: options.submissionRateLimit,
    voteRateLimit: options.voteRateLimit,
  });
  app.register(movieRoutes, { pool });
  app.register(generationPromptRoutes, { pool });
  app.register(playbackDiagnosticRoutes);
  app.register(danmakuRoutes, {
    pool,
    danmakuIpRateLimit: options.danmakuIpRateLimit,
    danmakuSettingsTtlMs: options.danmakuSettingsTtlMs,
  });
  app.register(episodeBannerRoutes, {
    pool,
    // The env value is the baseline. The route and both settlement paths read
    // the same §16.6 site_settings override, so hot tuning cannot split UI from
    // backend behaviour.
    fallbackAdoptThreshold: config.VOTE_ADOPT_THRESHOLD,
  });
  app.register(episodeRoutes, { pool });
  app.register(hallOfFameRoutes, { pool, hallOfFameTtlMs: options.hallOfFameTtlMs });
  app.register(meRoutes, { pool, draftRateLimit: options.draftRateLimit });
  app.register(contactRoutes, {
    pool,
    contactIpRateLimit: options.contactIpRateLimit,
    contactUserRateLimit: options.contactUserRateLimit,
  });
  app.register(storyAuthoringRoutes, {
    pool,
    mediaDir: config.MEDIA_DIR,
    storyRateLimit: options.storyRateLimit,
  });
  app.register(storyRoutes, {
    pool,
    commentRateLimit: options.storyCommentRateLimit,
    likeRateLimit: options.storyLikeRateLimit,
  });
  if (options.events !== false) {
    // Its own connection string rather than the pool: a `LISTEN` owns its
    // session for as long as it is listening, so it cannot be borrowed and
    // returned (§16.4, see routes/events.ts).
    app.register(eventRoutes, {
      pool,
      connectionString: config.DATABASE_URL,
      voteCoalesceMs: options.voteCoalesceMs,
      maxEventClients: options.maxEventClients,
    });
  }

  // Liveness *and* readiness in one: the summary is intentionally small and
  // safe to expose publicly. It proves the business schema is queryable while
  // giving 24x7 monitoring enough signal to spot a stalled Codex/job pipeline.
  app.get('/healthz', async (request, reply) => {
    try {
      const result = await pool.query<HealthSummaryRow>(
        `WITH codex_today AS (
           SELECT count(*) AS codex_runs_today,
                  count(*) FILTER (
                    WHERE status IN ('retryable_failed', 'dead')
                  ) AS codex_failures_today,
                  coalesce(sum(CASE
                    WHEN jsonb_typeof(usage_json -> 'input_tokens') = 'number'
                    THEN (usage_json ->> 'input_tokens')::numeric ELSE 0
                  END), 0) AS input_tokens_today,
                  coalesce(sum(CASE
                    WHEN jsonb_typeof(usage_json -> 'cached_input_tokens') = 'number'
                    THEN (usage_json ->> 'cached_input_tokens')::numeric ELSE 0
                  END), 0) AS cached_input_tokens_today,
                  coalesce(sum(CASE
                    WHEN jsonb_typeof(usage_json -> 'output_tokens') = 'number'
                    THEN (usage_json ->> 'output_tokens')::numeric ELSE 0
                  END), 0) AS output_tokens_today,
                  coalesce(sum(CASE
                    WHEN jsonb_typeof(usage_json -> 'reasoning_output_tokens') = 'number'
                    THEN (usage_json ->> 'reasoning_output_tokens')::numeric ELSE 0
                  END), 0) AS reasoning_output_tokens_today
             FROM ai_runs
            WHERE provider = 'openai_codex'
              AND created_at >= date_trunc('day', now())
         ), job_summary AS (
           SELECT count(*) FILTER (WHERE status = 'pending') AS jobs_pending,
                  count(*) FILTER (WHERE status = 'running') AS jobs_running,
                  count(*) FILTER (WHERE status = 'retryable_failed') AS jobs_retrying,
                  count(*) FILTER (WHERE status = 'dead') AS jobs_dead
             FROM workflow_jobs
         )
         SELECT * FROM codex_today CROSS JOIN job_summary`,
      );
      const summary = result.rows[0];

      return {
        db: true,
        ai: {
          codexRunsToday: Number(summary.codex_runs_today),
          codexFailuresToday: Number(summary.codex_failures_today),
          inputTokensToday: Number(summary.input_tokens_today),
          cachedInputTokensToday: Number(summary.cached_input_tokens_today),
          outputTokensToday: Number(summary.output_tokens_today),
          reasoningOutputTokensToday: Number(
            summary.reasoning_output_tokens_today,
          ),
        },
        queue: {
          pending: Number(summary.jobs_pending),
          running: Number(summary.jobs_running),
          retrying: Number(summary.jobs_retrying),
          dead: Number(summary.jobs_dead),
        },
      };
    } catch (error) {
      request.log.error({ err: error }, 'healthz database probe failed');
      return reply.code(503).send({ db: false });
    }
  });

  return app;
}
