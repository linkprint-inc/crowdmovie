// `media_validate_publish` — §5 step 5/6. Channel `media` (concurrency 1, §5.2).
//
// This is the only handler that writes to the movie's canon, and §5 is blunt
// about what that means:「只有视频达到 published 状态后，相关剧情才能写入正式世
// 界观」and「生成失败时不得提前推进剧情」. So one transaction does all of it: the
// round becomes `published`, the `scenes` row appears, and the official
// `scene_index` is assigned — or none of it happens.
//
// Three independent guards make a duplicate scene impossible (§17.18/19/20):
//   1. one `media_validate_publish:<round>` job can exist, ever;
//   2. the round transition is conditional on `status='validating'`, so a
//      re-delivered or recovered duplicate finds nothing to do;
//   3. `scenes.round_id` is UNIQUE, so even a transition race ends in a
//      constraint violation rather than a second scene.
// The advisory lock is not one of those guards — it exists so that two
// simultaneous publishes queue instead of colliding on `scene_index`, which is
// UNIQUE and would otherwise turn a race into a retry.
//
// M5 owns *producing* the files — the H3 download, the rendered WebVTT (§9.3)
// and moving `pending/<round>.mp4` to its official number. Checking that they
// exist is this handler's job and is not deferred: §5 says「要求视频与英、中、
// 日、西四份字幕文件全部就绪；任一缺失或校验失败即进入 validation_failed」, and
// §17.16 lets only validated output into the playlist. A round with missing or
// invalid media therefore ends in `validation_failed`; that is strictly better
// than writing a `scenes` row the player later 404s on.
import {
  LOCALES,
  type AuthorSubtitlesOutput,
  type DirectSceneOutput,
  type ProposeEpisodeThemeOutput,
} from '../../ai/engine.js';
import { access, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SCENE_MAX_SECONDS, validateSubtitles } from '../../ai/validate.js';
import { withTransaction } from '../../db/tx.js';
import { emitEvent } from '../../lib/events.js';
import { hasSubtitleCues } from '../../media/vtt.js';
import type { FilmAudioAudit } from '../../media/film-audio.js';
import type { FilmObservationRecord } from '../../ai/film-observation.js';
import { readVoteAdoptThreshold } from '../../lib/site-settings.js';
import {
  mediaFilePath,
  extractEndFrame,
  subtitleUrlsFor,
  verifySceneMedia,
} from '../../lib/media.js';
import { roundJobKey } from '../keys.js';
import { enqueue } from '../ledger.js';
import { loadRound, requirePayload, requireRoundId, type Handler } from './common.js';

interface PublishPayload {
  filmAudio?: FilmAudioAudit;
  filmObservation?: FilmObservationRecord;
  directorAiRunId: string;
  subtitleAiRunId: string;
  videoPath: string;
  sha256: string;
  durationSeconds: number;
  motionContextId: string | null;
}

/** Distinct from `CLOCK_LOCK_KEY`; serialises `scene_index` allocation only. */
export const SCENE_INDEX_LOCK_KEY = 0x63_6d_73_69; // "cmsi"

const SHA256_RE = /^[0-9a-f]{64}$/;

class EpisodeThemeRequiredError extends Error {}
class EpisodeProposalScoresPendingError extends Error {}

function parsePreparedTheme(value: unknown): ProposeEpisodeThemeOutput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('prepared episode theme output is malformed');
  }
  const theme = value as Record<string, unknown>;
  if (typeof theme.title !== 'string' || theme.title.trim().length === 0) {
    throw new Error('prepared episode theme title is empty');
  }
  if (typeof theme.theme !== 'string' || theme.theme.trim().length === 0) {
    throw new Error('prepared episode theme is empty');
  }
  return { title: theme.title, theme: theme.theme };
}

/** §10/§11 的编号与文件名：`000001.mp4` 加四份独立 WebVTT；没有对白的片段没有字幕。 */
export function sceneMediaPaths(
  sceneIndex: number,
  movieSlug?: string,
  withSubtitles = true,
): {
  video: string;
  endFrame: string;
  subtitles: Record<string, string>;
} {
  const stem = `/media/${movieSlug === undefined ? '' : `${movieSlug}/`}${String(
    sceneIndex,
  ).padStart(6, '0')}`;
  const subtitles: Record<string, string> = {};
  if (withSubtitles) {
    for (const locale of LOCALES) subtitles[locale] = `${stem}.${locale}.vtt`;
  }
  return { video: `${stem}.mp4`, endFrame: `${stem}.end.png`, subtitles };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Give a validated pending media set its immutable public number. All paths are
 * on MEDIA_DIR's filesystem, so each rename is atomic. A crash between files is
 * restart-safe: already-moved destinations are accepted and remaining sources
 * are moved on the next claim before the database transaction commits.
 */
async function promoteMedia(
  mediaDir: string,
  pendingVideoUrl: string,
  official: ReturnType<typeof sceneMediaPaths>,
): Promise<void> {
  const sources = [pendingVideoUrl];
  const destinations = [official.video];
  const pendingSubtitles = subtitleUrlsFor(pendingVideoUrl);
  LOCALES.forEach((locale, index) => {
    const destination = official.subtitles[locale];
    if (destination === undefined) return;
    sources.push(pendingSubtitles[index]);
    destinations.push(destination);
  });
  for (let index = 0; index < sources.length; index += 1) {
    const source = mediaFilePath(mediaDir, sources[index]);
    const destination = mediaFilePath(mediaDir, destinations[index]);
    if (source === null || destination === null) {
      throw new Error('media promotion path escaped MEDIA_DIR');
    }
    if (await pathExists(source)) {
      await mkdir(dirname(destination), { recursive: true });
      await rename(source, destination);
    } else if (!(await pathExists(destination))) {
      throw new Error(`media vanished during promotion: ${sources[index]}`);
    }
  }
}

export const publishHandler: Handler = async ({ pool, job, settings, log }) => {
  const roundId = requireRoundId(job);
  const payload = requirePayload<PublishPayload>(job, [
    'directorAiRunId',
    'subtitleAiRunId',
    'videoPath',
    'sha256',
    'durationSeconds',
  ]);

  const round = await loadRound(pool, roundId);
  if (round === null) throw new Error(`round ${roundId} is missing`);
  if (round.status !== 'validating') {
    return { kind: 'done', note: `round is ${round.status}` };
  }
  if (payload.motionContextId !== null && payload.motionContextId !== roundId) {
    throw new Error('publish job motion context ID does not match the current round');
  }

  // §5 step 5「检查MP4、时长、音轨和字幕文件」. M5 checks the bytes; what can be
  // checked without them is checked here, and a failure is a failure — §5 does
  // not allow publishing a scene whose media did not verify.
  if (payload.videoPath.length === 0) throw new Error('videoPath is empty');
  if (!SHA256_RE.test(payload.sha256)) throw new Error('sha256 is malformed');
  if (payload.filmAudio && (payload.filmAudio.sha256 !== payload.sha256 || payload.filmAudio.videoPath !== payload.videoPath || payload.filmAudio.durationSeconds !== payload.durationSeconds)) throw new Error('Film audio audit does not identify the exact media being published');
  if (payload.filmObservation && payload.filmObservation.videoSha256 !== payload.sha256) throw new Error('Film observation belongs to different media');
  if (
    !Number.isFinite(payload.durationSeconds) ||
    payload.durationSeconds <= 0 ||
    payload.durationSeconds > SCENE_MAX_SECONDS
  ) {
    throw new Error(`duration ${payload.durationSeconds}s is out of range`);
  }

  const runs = await pool.query<{ id: string; run_type: string; output_json: unknown }>(
    "SELECT id, run_type, output_json FROM ai_runs WHERE id = ANY($1::uuid[])",
    [[payload.directorAiRunId, payload.subtitleAiRunId]],
  );
  const director = runs.rows.find((row) => row.run_type === 'scene_director');
  const subtitles = runs.rows.find((row) => row.run_type === 'scene_subtitles');
  if (director === undefined) throw new Error('director run is missing');
  if (subtitles === undefined) throw new Error('subtitle run is missing');
  // No dialogue, no subtitles: the sidecars were never written, are not
  // required below and are not registered on the scene.
  const spoken = hasSubtitleCues(subtitles.output_json as AuthorSubtitlesOutput);

  // §5 step 5 的文件检查，before anything is written: the MP4 and, for a scene
  // with dialogue, its four WebVTT sidecars have to be on disk under MEDIA_DIR,
  // and the MP4 has to probe as a real video. This is the gate §17.16 asks for,
  // and it sits at publish time on purpose — a read-path existence check would
  // only hide an unplayable row that had already entered the canon.
  //
  // A failure here is decided, not transient: the file will not appear on the
  // fifth attempt if it did not appear on the first, so the round is moved to
  // `validation_failed` and the job completes, rather than throwing and holding
  // the pipeline through a retry schedule that can only restate the same
  // answer (§5「上一段正式发布后，下一段才能进入最终选择和拍摄流程」).
  const media = await verifySceneMedia(settings.mediaDir, payload.videoPath, {
    subtitles: spoken,
  });
  if (!media.ok) {
    const moved = await pool.query(
      `UPDATE rounds SET status = 'validation_failed', updated_at = now()
        WHERE id = $1 AND status = 'validating'`,
      [roundId],
    );
    log.error({ roundId, reason: media.reason }, 'media validation failed');
    return {
      kind: 'done',
      note:
        moved.rowCount === 0
          ? 'round was advanced by another worker'
          : `validation_failed: ${media.reason}`,
    };
  }

  // §5「要求视频与英、中、日、西四份字幕文件全部就绪；任一缺失或校验失败即进入
  // validation_failed」— re-checked here rather than trusted from the authoring
  // step, because this is the gate that lets a scene into the movie.
  validateSubtitles(subtitles.output_json as AuthorSubtitlesOutput, {
    actualDurationSeconds: payload.durationSeconds,
  });
  const directorOutput = director.output_json as DirectSceneOutput;

  let preparedTheme: ProposeEpisodeThemeOutput | null = null;
  if (directorOutput.episodeShouldEnd) {
    const themeJob = await pool.query<{
      status: string;
      theme_ai_run_id: string | null;
      output_json: unknown;
    }>(
      `SELECT j.status,
              j.payload_json ->> 'themeAiRunId' AS theme_ai_run_id,
              a.output_json
         FROM workflow_jobs j
         LEFT JOIN ai_runs a
           ON a.id = (j.payload_json ->> 'themeAiRunId')::uuid
        WHERE j.idempotency_key = $1`,
      [roundJobKey('episode_theme', roundId, round.movie_id)],
    );
    const row = themeJob.rows[0];
    if (row?.status === 'dead') throw new Error('episode theme job is dead');
    if (row?.status === 'succeeded') {
      if (row.theme_ai_run_id === null) {
        throw new Error('episode theme job succeeded without an ai_run');
      }
      preparedTheme = parsePreparedTheme(row.output_json);
    }
  }

  let published: { sceneIndex: number; sceneId: string } | null;
  try {
    published = await withTransaction(pool, async (client) => {
    // Serialise `scene_index` allocation across workers. The UNIQUE index is
    // what guarantees correctness; this only keeps a race from becoming a retry.
    await client.query('SELECT pg_advisory_xact_lock($1)', [SCENE_INDEX_LOCK_KEY]);

    const advanced = await client.query<{
      episode_id: string;
      movie_id: string;
      movie_slug: string;
      episode_index: number;
      round_index: string;
      selected_submission_id: string | null;
    }>(
      `UPDATE rounds r SET status = 'published', updated_at = now()
         FROM episodes e, movies m
        WHERE r.id = $1 AND r.status = 'validating' AND e.id = r.episode_id
          AND m.id = r.movie_id
        RETURNING r.episode_id, r.movie_id, m.slug AS movie_slug,
                  e.episode_index, r.round_index,
                  r.selected_submission_id`,
      [roundId],
    );
    if (advanced.rowCount === 0) return null;
    const { episode_id: episodeId, selected_submission_id: submissionId } =
      advanced.rows[0];

    let rotatedEpisode: {
      endedEpisodeId: string;
      endedEpisodeIndex: number;
      endReason: string;
      openedEpisodeId: string;
      openedEpisodeIndex: number;
      openedTitle: string;
    } | null = null;

    if (directorOutput.episodeShouldEnd) {
      const episode = await client.query<{
        id: string;
        episode_index: number;
        status: string;
      }>(
        `SELECT id, episode_index, status FROM episodes
          WHERE id = $1 FOR UPDATE`,
        [episodeId],
      );
      if (episode.rows[0]?.status !== 'open') {
        throw new Error('published scene tried to end a non-open episode');
      }

      // A proposal accepted before the episode lock must receive its safety
      // score before the pool can be frozen. Dead score jobs are explicit
      // rejections; live jobs defer publication rather than silently excluding
      // an accepted proposal from the final tally.
      const unscored = await client.query(
        `SELECT p.id FROM submissions p
          WHERE p.episode_id = $1 AND p.kind = 'next_episode'
            AND NOT EXISTS (
                  SELECT 1 FROM submission_scores sc
                   WHERE sc.submission_id = p.id)
            AND NOT EXISTS (
                  SELECT 1 FROM workflow_jobs j
                   WHERE j.movie_id = $2
                     AND j.job_type = 'submission_score'
                     AND j.payload_json->>'submissionId' = p.id::text
                     AND j.status = 'dead')
          LIMIT 1`,
        [episodeId, round.movie_id],
      );
      if (unscored.rowCount !== 0) {
        throw new EpisodeProposalScoresPendingError();
      }

      await client.query(
        `UPDATE submissions SET votes_frozen_at = now()
          WHERE episode_id = $1 AND kind = 'next_episode'
            AND votes_frozen_at IS NULL`,
        [episodeId],
      );
      const voteAdoptThreshold = await readVoteAdoptThreshold(
        client,
        settings.voteAdoptThreshold,
      );
      const proposal = await client.query<{ id: string; content: string }>(
        `SELECT p.id, p.content
           FROM submissions p
           JOIN submission_scores sc ON sc.submission_id = p.id
          WHERE p.episode_id = $1
            AND p.kind = 'next_episode'
            AND sc.eligible
            AND p.up_count - p.down_count >= $2
          ORDER BY p.up_count - p.down_count DESC, p.created_at ASC, p.id ASC
          LIMIT 1`,
        [episodeId, voteAdoptThreshold],
      );
      if (proposal.rows[0] === undefined && preparedTheme === null) {
        throw new EpisodeThemeRequiredError();
      }

      const nextEpisodeIndex = episode.rows[0].episode_index + 1;
      const title =
        proposal.rows[0] === undefined
          ? preparedTheme!.title
          : `第 ${nextEpisodeIndex} 集`;
      const theme =
        proposal.rows[0] === undefined
          ? preparedTheme!.theme
          : proposal.rows[0].content;
      const sourceSubmissionId = proposal.rows[0]?.id ?? null;
      const endReason = directorOutput.episodeEndReason?.trim() ?? '';
      if (endReason.length === 0) {
        throw new Error('episode end reason is empty');
      }

      await client.query(
        `UPDATE episodes
            SET status = 'ended', ended_at = now(), end_reason = $2
          WHERE id = $1 AND status = 'open'`,
        [episodeId, endReason],
      );
      const opened = await client.query<{ id: string }>(
        `INSERT INTO episodes
           (movie_id, bible_version_id, episode_index, title, theme,
            theme_source_submission_id, status)
         SELECT $1, b.id, $2, $3, $4, $5, 'open'
           FROM movie_bible_versions b
          WHERE b.movie_id = $1 AND b.status = 'active'
         RETURNING id`,
        [round.movie_id, nextEpisodeIndex, title, theme, sourceSubmissionId],
      );
      if (opened.rows[0] === undefined) {
        throw new Error(`movie ${round.movie_id} has no active bible version`);
      }

      // The clock may already have opened or even closed later rounds while
      // this scene was rendering. They have not reached selection because the
      // earlier round is unfinished, so move them and their shot submissions
      // together to make the very next round belong to the new episode.
      await client.query(
        `WITH moved AS (
           UPDATE rounds
              SET episode_id = $2, updated_at = now()
            WHERE movie_id = $3
              AND round_index > $1::bigint
              AND status IN ('open', 'selecting')
            RETURNING id
         )
         UPDATE submissions s SET episode_id = $2
           FROM moved m
          WHERE s.movie_id = $3 AND s.round_id = m.id`,
        [advanced.rows[0].round_index, opened.rows[0].id, round.movie_id],
      );

      rotatedEpisode = {
        endedEpisodeId: episodeId,
        endedEpisodeIndex: episode.rows[0].episode_index,
        endReason,
        openedEpisodeId: opened.rows[0].id,
        openedEpisodeIndex: nextEpisodeIndex,
        openedTitle: title,
      };
    }

    // §16.1「scene_index 永不回收、永不重排」— always one past the highest that
    // has ever existed, taken under the lock above. Failed rounds never reach
    // here, so a failure leaves no gap either (§11).
    const movieId = advanced.rows[0].movie_id;
    const next = await client.query<{ scene_index: number }>(
      `SELECT coalesce(max(scene_index), 0) + 1 AS scene_index
         FROM scenes WHERE movie_id = $1`,
      [movieId],
    );
    const sceneIndex = next.rows[0].scene_index;
    const paths = sceneMediaPaths(sceneIndex, advanced.rows[0].movie_slug, spoken);

    // Do this after the round transition won and scene_index was allocated,
    // but before the scene row is inserted/committed. The read path can never
    // observe an official URL whose file promotion has not completed.
    await promoteMedia(settings.mediaDir, payload.videoPath, paths);

    const extractedEndFrame = await extractEndFrame(
      settings.mediaDir,
      paths.video,
      paths.endFrame,
    );
    if ('error' in extractedEndFrame) {
      log.error(
        { roundId, reason: extractedEndFrame.error },
        'end-frame metadata extraction failed; publishing without thumbnail metadata',
      );
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO scenes
         (movie_id, scene_index, episode_id, round_id, credit_user_id, source_submission_id,
          summary_zh, duration_seconds, media, director_ai_run_id,
          subtitle_ai_run_id, episode_should_end, published_at)
       VALUES ($1, $2, $3, $4,
               (SELECT user_id FROM submissions WHERE id = $5), $5,
               $6, $7, $8::jsonb, $9, $10, $11, now())
       RETURNING id`,
      [
        movieId,
        sceneIndex,
        episodeId,
        roundId,
        submissionId,
        directorOutput.sceneSummaryZh,
        payload.durationSeconds,
        JSON.stringify({
          video: paths.video,
          sha256: payload.sha256,
          subtitles: paths.subtitles,
          ...(payload.filmAudio ? { film_audio: { ...payload.filmAudio, videoPath: paths.video }, film_observation: payload.filmObservation ?? null,
            film_prompt_audit: directorOutput.filmPromptAudit ?? null } : {}),
          ...(directorOutput.filmPlan ? { visual_assets: {
            version: 'film-assets-v1', source: 'planned-continuity-with-generated-reference',
            reference_frame: 'sha256' in extractedEndFrame ? { image: paths.endFrame, sha256: extractedEndFrame.sha256 } : null,
            scene: { locationId: directorOutput.filmPlan.exitState.locationId, environment: directorOutput.filmPlan.exitState.environment,
              timeAndLight: directorOutput.filmPlan.exitState.timeAndLight, landmarks: directorOutput.filmPlan.exitState.landmarks },
            characters: directorOutput.filmPlan.exitState.characters,
            voices: directorOutput.filmPlan.voices,
          } } : {}),
          end_frame:
            'sha256' in extractedEndFrame
              ? { image: paths.endFrame, sha256: extractedEndFrame.sha256 }
              : null,
          motion_context:
            payload.motionContextId === null
              ? null
              : { id: payload.motionContextId, plugin_version: '0.5.1' },
        }),
        payload.directorAiRunId,
        payload.subtitleAiRunId,
        directorOutput.episodeShouldEnd,
      ],
    );

    // §16.4 `round.published`（轮次推进）and `scene.published`（播放器追加新
    // 片段）. Both inside the transaction, so a client is never told to append a
    // scene whose row did not commit. The player still fetches
    // `/api/movie/playlist` for the URLs — §16.4 keeps the GET authoritative.
    await emitEvent(client, {
      type: 'round.published',
      data: {
        movieId,
        roundId,
        roundIndex: Number(advanced.rows[0].round_index),
        sceneIndex,
      },
    });
    await emitEvent(client, {
      type: 'scene.published',
      data: {
        movieId,
        sceneIndex,
        episodeIndex: advanced.rows[0].episode_index,
      },
    });

    if (rotatedEpisode !== null) {
      await emitEvent(client, {
        type: 'episode.ended',
        data: {
          movieId,
          episodeId: rotatedEpisode.endedEpisodeId,
          episodeIndex: rotatedEpisode.endedEpisodeIndex,
          reason: rotatedEpisode.endReason,
        },
      });
      await emitEvent(client, {
        type: 'episode.opened',
        data: {
          movieId,
          episodeId: rotatedEpisode.openedEpisodeId,
          episodeIndex: rotatedEpisode.openedEpisodeIndex,
          title: rotatedEpisode.openedTitle,
        },
      });
    }

    return { sceneIndex, sceneId: inserted.rows[0].id };
    });
  } catch (error) {
    if (error instanceof EpisodeProposalScoresPendingError) {
      return { kind: 'defer', reason: 'episode proposals are still being scored' };
    }
    if (error instanceof EpisodeThemeRequiredError) {
      const queued = await withTransaction(pool, (client) =>
        enqueue(client, {
          jobType: 'episode_theme',
          idempotencyKey: roundJobKey('episode_theme', roundId, round.movie_id),
          movieId: round.movie_id,
          roundId,
          payload: { episodeId: round.episode_id },
        }),
      );
      if (queued.job.status === 'dead') {
        throw new Error('episode theme job is dead');
      }
      return { kind: 'defer', reason: 'episode theme is being prepared' };
    }
    throw error;
  }

  if (published === null) {
    return { kind: 'done', note: 'round was already published' };
  }
  log.info({ roundId, ...published }, 'scene published');
  return { kind: 'done' };
};
