// `subtitle_author` — §9 四语字幕与时间轴。Channel `subtitle` (concurrency 1,
// §5.2), and §5 puts it after the measured duration is known (§9.1 step 3).
//
// This step *is* a content call, so it runs for real against whichever engine is
// configured, and its output is validated to §9.2 before the round is allowed to
// move to `validating`. What M5 still owns is the deterministic WebVTT rendering
// of §9.3 — four files on disk per scene — which needs somewhere to write them.
import type { DirectSceneOutput, AuthorSubtitlesInput } from '../../ai/engine.js';
import { recordFilmObservation, type FilmObservationRecord } from '../../ai/film-observation.js';
import { prepareFilmAudio } from '../../media/film-audio.js';
import { filmObservationInput } from '../../media/film-observation.js';
import { mediaFilePath } from '../../lib/media.js';
import { validateSubtitles } from '../../ai/validate.js';
import { withTransaction } from '../../db/tx.js';
import { writeSubtitleSidecars } from '../../media/vtt.js';
import { roundJobKey } from '../keys.js';
import { enqueue } from '../ledger.js';
import {
  insertAiRun,
  loadRound,
  requirePayload,
  requireRoundId,
  timed,
  type Handler,
} from './common.js';

interface SubtitlePayload {
  directorAiRunId: string;
  videoPath: string;
  sha256: string;
  actualDurationSeconds: number;
  motionContextId: string | null;
}

export const subtitleHandler: Handler = async ({
  pool,
  engine,
  job,
  settings,
  log,
}) => {
  const roundId = requireRoundId(job);
  const payload = requirePayload<SubtitlePayload>(job, [
    'directorAiRunId',
    'videoPath',
    'sha256',
    'actualDurationSeconds',
  ]);

  const round = await loadRound(pool, roundId);
  if (round === null) throw new Error(`round ${roundId} is missing`);
  if (round.status !== 'generating') {
    return { kind: 'done', note: `round is ${round.status}` };
  }
  if (payload.motionContextId !== null && payload.motionContextId !== roundId) {
    throw new Error('subtitle job motion context ID does not match the current round');
  }

  const directorRun = await pool.query<{ output_json: DirectSceneOutput }>(
    "SELECT output_json FROM ai_runs WHERE id = $1 AND run_type = 'scene_director'",
    [payload.directorAiRunId],
  );
  if (directorRun.rows[0] === undefined) {
    throw new Error(`director run ${payload.directorAiRunId} is missing`);
  }
  const director = directorRun.rows[0].output_json;
  const audio = director.filmPlan ? await prepareFilmAudio(settings.mediaDir, roundId, payload.videoPath, payload.sha256) : null;
  let observation: FilmObservationRecord | null = null;
  // Sampled vision is an optional development diagnostic, never a publication
  // gate or an automatic regeneration trigger.
  if (director.filmPlan && audio && engine.observeFilm && process.env.FILM_OBSERVATION_ENABLED === 'true') {
    try {
    const sample = await filmObservationInput(roundId, mediaFilePath(settings.mediaDir, audio.videoPath)!, audio.sha256, audio.durationSeconds, director.filmPlan);
    const observed = await timed(() => engine.observeFilm!(sample));
    observation = recordFilmObservation(sample, observed.value);
    const evidenceFrames = observation.frames;
    await withTransaction(pool, (client) => insertAiRun(client, engine, { roundId, runType: 'film_observation',
      input: { ...sample, frames: evidenceFrames, contactSheet: { sha256: sample.contactSheet.sha256 } }, output: observed.value,
      latencyMs: observed.latencyMs, promptPlanVersion: 'film-observation-v1' }));
    } catch (error) {
      log.warn({ roundId, error: error instanceof Error ? error.message : String(error) }, 'optional film observation unavailable; publishing measured media');
    }
  }

  const input: AuthorSubtitlesInput = {
    roundId,
    actualDurationSeconds: audio?.durationSeconds ?? payload.actualDurationSeconds,
    dialogueEn: audio ? audio.transcript.segments.map((segment) => ({
      speaker: director.dialogueEn.find((line) => line.line.toLowerCase().replace(/[^a-z0-9]/g, '') === segment.text.toLowerCase().replace(/[^a-z0-9]/g, ''))?.speaker ?? 'Unknown',
      startSeconds: segment.start, endSeconds: segment.end, line: segment.text,
    })) : director.dialogueEn,
    sceneSummaryZh: director.sceneSummaryZh,
    ...(audio ? { audioSource: { version: 'film-asr-v1' as const, videoSha256: audio.rawSha256 } } : {}),
  };
  const { value: output, latencyMs } = await timed(() =>
    engine.authorSubtitles(input),
  );
  validateSubtitles(output, {
    actualDurationSeconds: input.actualDurationSeconds,
  });
  // Deterministic rendering belongs to code, not the model. All four files are
  // written before the publish job is enqueued, so the media channel cannot
  // win a race against sidecar creation immediately after COMMIT.
  await writeSubtitleSidecars(settings.mediaDir, audio?.videoPath ?? payload.videoPath, output);

  const advanced = await withTransaction(pool, async (client) => {
    const aiRunId = await insertAiRun(client, engine, {
      roundId,
      runType: 'scene_subtitles',
      input,
      output,
      latencyMs,
      promptPlanVersion: output.subtitleSchemaVersion,
    });

    const updated = await client.query<{ id: string }>(
      `UPDATE rounds SET status = 'validating', updated_at = now()
        WHERE id = $1 AND status = 'generating'
        RETURNING id`,
      [roundId],
    );
    if (updated.rowCount === 0) return null;

    await enqueue(client, {
      jobType: 'media_validate_publish',
      idempotencyKey: roundJobKey(
        'media_validate_publish',
        roundId,
        round.movie_id,
      ),
      movieId: round.movie_id,
      roundId,
      payload: {
        directorAiRunId: payload.directorAiRunId,
        subtitleAiRunId: aiRunId,
        videoPath: audio?.videoPath ?? payload.videoPath,
        sha256: audio?.sha256 ?? payload.sha256,
        durationSeconds: audio?.durationSeconds ?? payload.actualDurationSeconds,
        ...(audio ? { filmAudio: audio, filmObservation: observation } : {}),
        motionContextId: payload.motionContextId ?? null,
      },
    });
    return aiRunId;
  });

  if (advanced === null) {
    return { kind: 'done', note: 'round was advanced by another worker' };
  }
  log.info({ roundId, cues: output.cues.length }, 'subtitles finalised');
  return { kind: 'done' };
};
