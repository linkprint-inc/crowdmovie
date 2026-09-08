// `episode_theme` — §5.4's Sol/xhigh fallback when no eligible proposal reaches
// the crowd-adoption threshold. The job only prepares an audited theme; the
// publish transaction remains the sole place allowed to end/open episodes.
import type { ProposeEpisodeThemeOutput } from '../../ai/engine.js';
import { withTransaction } from '../../db/tx.js';
import {
  insertAiRun,
  loadEpisode,
  loadRecentScenes,
  requirePayload,
  requireRoundId,
  timed,
  type Handler,
} from './common.js';

interface EpisodeThemePayload {
  episodeId: string;
}

function validateTheme(output: ProposeEpisodeThemeOutput): void {
  if (output.title.trim().length === 0) {
    throw new Error('episode theme title is empty');
  }
  if (output.theme.trim().length === 0) {
    throw new Error('episode theme is empty');
  }
}

export const episodeThemeHandler: Handler = async ({
  pool,
  engine,
  job,
  log,
}) => {
  const roundId = requireRoundId(job);
  const { episodeId } = requirePayload<EpisodeThemePayload>(job, ['episodeId']);

  // A worker may die after the AI row and payload pointer commit but before the
  // ledger completion. Replaying that claim must not buy the same Sol turn twice.
  const existing = await pool.query<{ theme_ai_run_id: string | null }>(
    `SELECT payload_json ->> 'themeAiRunId' AS theme_ai_run_id
       FROM workflow_jobs WHERE id = $1`,
    [job.id],
  );
  if (typeof existing.rows[0]?.theme_ai_run_id === 'string') {
    return { kind: 'done', note: 'episode theme already prepared' };
  }

  const episode = await loadEpisode(pool, episodeId);
  const input = {
    episodeIndex: episode.episode_index + 1,
    previousTheme: episode.theme,
    recentScenes: await loadRecentScenes(pool, episode.movie_id, episodeId),
  };
  const generated = await timed(() => engine.proposeEpisodeTheme(input));
  validateTheme(generated.value);

  const aiRunId = await withTransaction(pool, async (client) => {
    const raced = await client.query<{ theme_ai_run_id: string | null }>(
      `SELECT payload_json ->> 'themeAiRunId' AS theme_ai_run_id
         FROM workflow_jobs WHERE id = $1 FOR UPDATE`,
      [job.id],
    );
    if (typeof raced.rows[0]?.theme_ai_run_id === 'string') {
      return raced.rows[0].theme_ai_run_id;
    }

    const inserted = await insertAiRun(client, engine, {
      roundId,
      runType: 'generation_event',
      input,
      output: generated.value,
      latencyMs: generated.latencyMs,
    });
    await client.query(
      `UPDATE workflow_jobs
          SET payload_json = coalesce(payload_json, '{}'::jsonb)
                             || jsonb_build_object('themeAiRunId', $2::text),
              updated_at = now()
        WHERE id = $1`,
      [job.id, inserted],
    );
    return inserted;
  });

  log.info(
    { roundId, episodeId, themeAiRunId: aiRunId },
    'episode theme prepared',
  );
  return { kind: 'done' };
};
