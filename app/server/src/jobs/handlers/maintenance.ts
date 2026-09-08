// Hourly housekeeping (§16.5). This is deliberately a durable ledger job, not
// a process-local callback: a restart can replay the same UTC-hour key, and the
// unique idempotency key guarantees that cleanup and reporting still happen at
// most once for that hour.
import { withTransaction } from '../../db/tx.js';
import type { Handler } from './common.js';

interface QueueHealthRow {
  pending: string;
  running: string;
  retrying: string;
  dead: string;
  oldest_wait_ms: string;
}

interface CodexDailyRow {
  run_type: string;
  runs: string;
  failures: string;
  input_tokens: string;
  cached_input_tokens: string;
  output_tokens: string;
  reasoning_output_tokens: string;
}

export const maintenanceHandler: Handler = async ({ pool, log }) => {
  const cleanup = await withTransaction(pool, async (client) => {
    const sessions = await client.query(
      `DELETE FROM sessions
        WHERE expires_at <= now() OR revoked_at IS NOT NULL
        RETURNING id`,
    );
    const resets = await client.query(
      `DELETE FROM password_resets
        WHERE expires_at <= now() OR used_at IS NOT NULL
        RETURNING id`,
    );
    const roundVotes = await client.query(
      `UPDATE submissions s
          SET votes_frozen_at = now()
         FROM rounds r
        WHERE s.round_id = r.id
          AND s.kind = 'next_shot'
          AND s.votes_frozen_at IS NULL
          AND r.status <> 'open'
        RETURNING s.id`,
    );
    const episodeVotes = await client.query(
      `UPDATE submissions s
          SET votes_frozen_at = now()
         FROM episodes e
        WHERE s.episode_id = e.id
          AND s.kind = 'next_episode'
          AND s.votes_frozen_at IS NULL
          AND e.status = 'ended'
        RETURNING s.id`,
    );
    return {
      expiredOrRevokedSessions: sessions.rowCount ?? 0,
      expiredOrUsedPasswordResets: resets.rowCount ?? 0,
      frozenRoundVotes: roundVotes.rowCount ?? 0,
      frozenEpisodeVotes: episodeVotes.rowCount ?? 0,
    };
  });

  const [queueResult, codexResult] = await Promise.all([
    pool.query<QueueHealthRow>(
      `SELECT count(*) FILTER (WHERE status = 'pending') AS pending,
              count(*) FILTER (WHERE status = 'running') AS running,
              count(*) FILTER (WHERE status = 'retryable_failed') AS retrying,
              count(*) FILTER (WHERE status = 'dead') AS dead,
              coalesce(extract(epoch FROM (
                now() - min(available_at) FILTER (
                  WHERE status IN ('pending', 'retryable_failed')
                    AND available_at <= now()
                )
              )) * 1000, 0) AS oldest_wait_ms
         FROM workflow_jobs`,
    ),
    pool.query<CodexDailyRow>(
      `SELECT run_type,
              count(*) AS runs,
              count(*) FILTER (
                WHERE status IN ('retryable_failed', 'dead')
              ) AS failures,
              coalesce(sum(CASE
                WHEN jsonb_typeof(usage_json -> 'input_tokens') = 'number'
                THEN (usage_json ->> 'input_tokens')::numeric ELSE 0
              END), 0) AS input_tokens,
              coalesce(sum(CASE
                WHEN jsonb_typeof(usage_json -> 'cached_input_tokens') = 'number'
                THEN (usage_json ->> 'cached_input_tokens')::numeric ELSE 0
              END), 0) AS cached_input_tokens,
              coalesce(sum(CASE
                WHEN jsonb_typeof(usage_json -> 'output_tokens') = 'number'
                THEN (usage_json ->> 'output_tokens')::numeric ELSE 0
              END), 0) AS output_tokens,
              coalesce(sum(CASE
                WHEN jsonb_typeof(usage_json -> 'reasoning_output_tokens') = 'number'
                THEN (usage_json ->> 'reasoning_output_tokens')::numeric ELSE 0
              END), 0) AS reasoning_output_tokens
         FROM ai_runs
        WHERE provider = 'openai_codex'
          AND created_at >= date_trunc('day', now())
        GROUP BY run_type
        ORDER BY run_type`,
    ),
  ]);

  const queue = queueResult.rows[0];
  log.info(
    {
      cleanup,
      queue: {
        pending: Number(queue.pending),
        running: Number(queue.running),
        retrying: Number(queue.retrying),
        dead: Number(queue.dead),
        oldestWaitMs: Math.max(0, Number(queue.oldest_wait_ms)),
      },
      codexToday: codexResult.rows.map((row) => ({
        runType: row.run_type,
        runs: Number(row.runs),
        failures: Number(row.failures),
        inputTokens: Number(row.input_tokens),
        cachedInputTokens: Number(row.cached_input_tokens),
        outputTokens: Number(row.output_tokens),
        reasoningOutputTokens: Number(row.reasoning_output_tokens),
      })),
    },
    'hourly maintenance completed',
  );
  return { kind: 'done' };
};
