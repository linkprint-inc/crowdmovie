// `episode_bootstrap` — start an episode that has no published scene yet.
//
// If the episode still carries the bootstrap placeholder, Sol/xhigh writes the
// episode-level outline and the backend persists it as the episode title/theme.
// If this movie has remaining automatic-scene capacity, the same transaction
// claims its truly empty first round for AI Director. Otherwise the round stays
// open and unarmed for a human next-shot submission.
//
// A real submission may land while Sol is writing the outline. Bootstrap may
// fill in the missing outline, but it never closes, steals or deletes that
// user's round.
import type { ProposeEpisodeThemeOutput } from '../../ai/engine.js';
import { withTransaction } from '../../db/tx.js';
import { emitEvent } from '../../lib/events.js';
import {
  BOOTSTRAP_EPISODE_THEME,
  BOOTSTRAP_EPISODE_TITLE,
  CLOCK_LOCK_KEY,
  hasAutomaticSceneCapacity,
} from '../../rounds/clock.js';
import { roundJobKey } from '../keys.js';
import { enqueue } from '../ledger.js';
import {
  insertAiRun,
  loadEpisode,
  loadRecentScenes,
  loadRound,
  requirePayload,
  requireRoundId,
  timed,
  type Handler,
} from './common.js';

interface EpisodeBootstrapPayload {
  episodeId: string;
}

function outlineIsMissing(title: string, theme: string): boolean {
  return (
    title.trim().length === 0 ||
    theme.trim().length === 0 ||
    theme === BOOTSTRAP_EPISODE_THEME
  );
}

function validateOutline(output: ProposeEpisodeThemeOutput): void {
  if (output.title.trim().length === 0) {
    throw new Error('episode outline title is empty');
  }
  if (output.theme.trim().length === 0) {
    throw new Error('episode outline is empty');
  }
}

export const episodeBootstrapHandler: Handler = async ({
  pool,
  engine,
  job,
  log,
}) => {
  const roundId = requireRoundId(job);
  const { episodeId } = requirePayload<EpisodeBootstrapPayload>(job, [
    'episodeId',
  ]);

  const persisted = await pool.query<{ completed: boolean }>(
    `SELECT coalesce((payload_json ->> 'bootstrapCompleted')::boolean, false)
              AS completed
       FROM workflow_jobs WHERE id = $1`,
    [job.id],
  );
  if (persisted.rows[0]?.completed === true) {
    return { kind: 'done', note: 'episode bootstrap already committed' };
  }

  const round = await loadRound(pool, roundId);
  if (round === null) throw new Error(`round ${roundId} is missing`);
  if (round.episode_id !== episodeId) {
    throw new Error(`round ${roundId} does not belong to episode ${episodeId}`);
  }

  const episode = await loadEpisode(pool, episodeId);
  const needsOutline = outlineIsMissing(episode.title, episode.theme);
  const previousEpisode = needsOutline
    ? await pool.query<{ id: string; theme: string }>(
        `SELECT id, theme FROM episodes
          WHERE movie_id = $1 AND episode_index < $2
          ORDER BY episode_index DESC LIMIT 1`,
        [episode.movie_id, episode.episode_index],
      )
    : null;
  const previous = previousEpisode?.rows[0] ?? null;
  const outlineInput = {
    episodeIndex: episode.episode_index,
    previousTheme: previous?.theme ?? null,
    recentScenes: previous === null
      ? []
      : await loadRecentScenes(pool, episode.movie_id, previous.id),
  };
  const generated = needsOutline
    ? await timed(() =>
        engine.proposeEpisodeTheme(outlineInput),
      )
    : null;
  if (generated !== null) validateOutline(generated.value);

  const committed = await withTransaction(pool, async (client) => {
    // The same lock serialises timer close, crowd close and opening round N+1.
    // Take it before any job-row lock so this path has the same lock order as
    // `tick()` (advisory lock, then enqueue/idempotency row).
    await client.query('SELECT pg_advisory_xact_lock($1)', [CLOCK_LOCK_KEY]);

    const lockedJob = await client.query<{ completed: boolean }>(
      `SELECT coalesce((payload_json ->> 'bootstrapCompleted')::boolean, false)
                AS completed
         FROM workflow_jobs WHERE id = $1 FOR UPDATE`,
      [job.id],
    );
    if (lockedJob.rows[0]?.completed === true) {
      return { selected: false, outlineAiRunId: null, replay: true };
    }

    let outlineAiRunId: string | null = null;
    if (generated !== null) {
      outlineAiRunId = await insertAiRun(client, engine, {
        roundId,
        runType: 'generation_event',
        input: outlineInput,
        output: generated.value,
        latencyMs: generated.latencyMs,
      });
      await client.query(
        `UPDATE episodes
            SET title = CASE
                          WHEN btrim(title) = '' OR title = $2 THEN $4
                          ELSE title
                        END,
                theme = CASE
                          WHEN btrim(theme) = '' OR theme = $3 THEN $5
                          ELSE theme
                        END
          WHERE id = $1`,
        [
          episodeId,
          BOOTSTRAP_EPISODE_TITLE,
          BOOTSTRAP_EPISODE_THEME,
          generated.value.title.trim(),
          generated.value.theme.trim(),
        ],
      );
    }

    let selected = false;
    if (await hasAutomaticSceneCapacity(client, round.movie_id)) {
      // Recheck eligibility after the potentially long outline call. A human
      // who submitted in the meantime owns the round and is never displaced.
      const claimed = await client.query<{ round_index: string }>(
        `UPDATE rounds
            SET status = 'selecting', selected_submission_id = NULL,
                selection_mode = 'auto', updated_at = now()
          WHERE id = $1 AND movie_id = $2 AND episode_id = $3
            AND status = 'open' AND closes_at IS NULL
            AND NOT EXISTS (
                  SELECT 1 FROM submissions s
                   WHERE s.round_id = rounds.id AND s.kind = 'next_shot'
                )
            AND NOT EXISTS (
                  SELECT 1 FROM scenes sc
                   WHERE sc.movie_id = $2 AND sc.episode_id = $3
                )
          RETURNING round_index`,
        [roundId, round.movie_id, episodeId],
      );
      selected = claimed.rows[0] !== undefined;
      if (selected) {
        await enqueue(client, {
          jobType: 'ai_screenwriter',
          idempotencyKey: roundJobKey(
            'ai_screenwriter',
            roundId,
            round.movie_id,
          ),
          movieId: round.movie_id,
          roundId,
        });
        await emitEvent(client, {
          type: 'round.closed',
          data: {
            movieId: round.movie_id,
            roundId,
            roundIndex: Number(claimed.rows[0].round_index),
            selectionMode: 'auto',
          },
        });
      }
    }

    await client.query(
      `UPDATE workflow_jobs
          SET payload_json = coalesce(payload_json, '{}'::jsonb)
                             || jsonb_build_object(
                                  'bootstrapCompleted', true,
                                  'outlineAiRunId', $2::text
                                ),
              updated_at = now()
        WHERE id = $1`,
      [job.id, outlineAiRunId],
    );
    return {
      selected,
      outlineAiRunId,
      replay: false,
    };
  });

  log.info(
    {
      roundId,
      episodeId,
      selected: committed.selected,
      outlineAiRunId: committed.outlineAiRunId,
    },
    committed.selected
      ? 'episode outline ready; AI Director first-shot submission queued'
      : 'episode outline ready; waiting for audience shot',
  );
  return {
    kind: 'done',
    ...(committed.replay ? { note: 'episode bootstrap already committed' } : {}),
  };
};
