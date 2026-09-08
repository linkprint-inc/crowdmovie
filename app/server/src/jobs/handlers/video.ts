// `video_generate` — submit/poll/download for the guarded 8191 FastH3 gateway.
// Polling is a delayed one-shot ledger job, never a sleeping worker: every
// running response is persisted and deferred so a process restart simply polls
// the same gateway job again. Gateway idempotency is canonical per round.
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { DirectSceneOutput } from '../../ai/engine.js';
import { SCENE_MAX_SECONDS, validateDirector } from '../../ai/validate.js';
import { withTransaction } from '../../db/tx.js';
import {
  H3BusyError,
  H3ValidationError,
  type H3Job,
} from '../../h3/gateway.js';
import {
  inspectGeneratedVideo,
  mediaFilePath,
} from '../../lib/media.js';
import { roundJobKey } from '../keys.js';
import { enqueue } from '../ledger.js';
import { buildDirectorInput } from './director.js';
import {
  insertAiRun,
  loadPreviousScene,
  loadRound,
  requirePayload,
  requireRoundId,
  timed,
  type Handler,
} from './common.js';

interface VideoPayload {
  directorAiRunId: string;
  gatewayJobId?: string;
  workflowRepairCount?: number;
}

export function pendingVideoPath(roundId: string): string {
  return `/media/pending/${roundId}.mp4`;
}

function stubDigest(roundId: string): string {
  return crypto.createHash('sha256').update(`stub-video:${roundId}`).digest('hex');
}

async function loadDirector(
  context: Parameters<Handler>[0],
  directorAiRunId: string,
): Promise<DirectSceneOutput> {
  const found = await context.pool.query<{ output_json: DirectSceneOutput }>(
    "SELECT output_json FROM ai_runs WHERE id = $1 AND run_type = 'scene_director'",
    [directorAiRunId],
  );
  if (found.rows[0] === undefined) {
    throw new Error(`director run ${directorAiRunId} is missing`);
  }
  return found.rows[0].output_json;
}

async function rememberGatewayJob(
  context: Parameters<Handler>[0],
  payload: VideoPayload,
  gatewayJob: H3Job,
): Promise<void> {
  await context.pool.query(
    `UPDATE workflow_jobs
        SET upstream_job_id = $2,
            payload_json = $3::jsonb,
            updated_at = now()
      WHERE id = $1 AND status = 'running'`,
    [
      context.job.id,
      gatewayJob.promptId,
      JSON.stringify({ ...payload, gatewayJobId: gatewayJob.jobId }),
    ],
  );
}

async function repairRejectedWorkflow(
  context: Parameters<Handler>[0],
  round: NonNullable<Awaited<ReturnType<typeof loadRound>>>,
  payload: VideoPayload,
  previousOutput: DirectSceneOutput,
  error: H3ValidationError,
): Promise<void> {
  const repairCount = payload.workflowRepairCount ?? 0;
  if (repairCount >= context.settings.h3WorkflowRepairRetries) throw error;
  if (context.h3 === undefined) throw new Error('H3 gateway is not configured');

  const capabilities = await context.h3.getCapabilities();
  const input = await buildDirectorInput(context.pool, round, capabilities, {
    previousOutput,
    error: { code: error.code, message: error.message, details: error.details },
  });
  const { value: output, latencyMs } = await timed(() =>
    context.engine.directScene(input),
  );
  validateDirector(output, {
    roundId: round.id,
    selectedSubmissionId: round.selected_submission_id,
    capabilitiesVersion: capabilities.version,
    previousEndFrameSha256: input.previousScene?.endFrame?.sha256 ?? null,
    previousMotionContextId: input.previousScene?.motionContextId ?? null,
    previousFilmState: input.previousScene?.observedEndState ?? input.previousScene?.filmPlan?.exitState,
  });

  await withTransaction(context.pool, async (client) => {
    const aiRunId = await insertAiRun(client, context.engine, {
      roundId: round.id,
      submissionId: round.selected_submission_id,
      runType: 'scene_director',
      input,
      output,
      latencyMs,
      promptPlanVersion: output.directorSchemaVersion,
    });
    await client.query(
      `UPDATE workflow_jobs
          SET upstream_job_id = NULL,
              payload_json = $2::jsonb,
              updated_at = now()
        WHERE id = $1 AND status = 'running'`,
      [
        context.job.id,
        JSON.stringify({
          directorAiRunId: aiRunId,
          workflowRepairCount: repairCount + 1,
        }),
      ],
    );
  });
}

async function enqueueSubtitles(
  context: Parameters<Handler>[0],
  movieId: string,
  roundId: string,
  directorAiRunId: string,
  sha256: string,
  actualDurationSeconds: number,
  motionContextId: string | null,
): Promise<boolean> {
  return withTransaction(context.pool, async (client) => {
    const still = await client.query(
      "SELECT id FROM rounds WHERE id = $1 AND status = 'generating' FOR UPDATE",
      [roundId],
    );
    if (still.rowCount === 0) return false;
    await enqueue(client, {
      jobType: 'subtitle_author',
      idempotencyKey: roundJobKey('subtitle_author', roundId, movieId),
      movieId,
      roundId,
      payload: {
        directorAiRunId,
        videoPath: pendingVideoPath(roundId),
        sha256,
        actualDurationSeconds,
        motionContextId,
      },
    });
    return true;
  });
}

export const videoHandler: Handler = async (context) => {
  const { pool, h3, job, settings, log } = context;
  const roundId = requireRoundId(job);
  const payload = requirePayload<VideoPayload>(job, ['directorAiRunId']);

  const round = await loadRound(pool, roundId);
  if (round === null) throw new Error(`round ${roundId} is missing`);
  if (round.status !== 'generating') {
    return { kind: 'done', note: `round is ${round.status}` };
  }
  const director = await loadDirector(context, payload.directorAiRunId);

  // Tests and the pre-M5 deterministic harness deliberately omit the client.
  // That path preserves the old stub's state-machine proof without pretending
  // it created bytes; production always supplies the real client.
  if (h3 === undefined) {
    const advanced = await enqueueSubtitles(
      context,
      round.movie_id,
      roundId,
      payload.directorAiRunId,
      stubDigest(roundId),
      director.durationSeconds,
      null,
    );
    if (!advanced) {
      return { kind: 'done', note: 'round was advanced by another worker' };
    }
    log.info({ roundId }, 'video generated (stub)');
    return { kind: 'done' };
  }

  let gatewayJob: H3Job;
  if (payload.gatewayJobId === undefined) {
    try {
      let firstFrame: { sha256: string; png: Buffer } | undefined;
      if (director.usePreviousEndFrame) {
        const previousScene = await loadPreviousScene(
          pool,
          round.movie_id,
          round.episode_id,
        );
        if (previousScene?.endFrame == null) {
          throw new Error('director requested a previous end frame but none exists');
        }
        const path = mediaFilePath(settings.mediaDir, previousScene.endFrame.image);
        if (path === null) throw new Error('previous end frame escaped MEDIA_DIR');
        const png = await readFile(path);
        const sha256 = crypto.createHash('sha256').update(png).digest('hex');
        if (sha256 !== previousScene.endFrame.sha256) {
          throw new Error('previous end frame sha256 mismatch');
        }
        firstFrame = { sha256, png };
      }
      gatewayJob = await h3.submitWorkflow(roundId, director, {
        ...(firstFrame === undefined ? {} : { firstFrame }),
      });
    } catch (error) {
      if (error instanceof H3BusyError) {
        return {
          kind: 'defer',
          delayMs: settings.h3PollIntervalMs,
          reason: error.code,
        };
      }
      if (error instanceof H3ValidationError) {
        await repairRejectedWorkflow(context, round, payload, director, error);
        return {
          kind: 'defer',
          delayMs: settings.h3PollIntervalMs,
          reason: `workflow rewritten after ${error.code}`,
        };
      }
      throw error;
    }
    await rememberGatewayJob(context, payload, gatewayJob);
  } else {
    gatewayJob = await h3.getJob(payload.gatewayJobId);
  }

  if (gatewayJob.status === 'running') {
    return {
      kind: 'defer',
      delayMs: settings.h3PollIntervalMs,
      reason: 'FastH3 job is still running',
    };
  }
  if (gatewayJob.status === 'failed') {
    throw new Error(
      `FastH3 ${gatewayJob.error?.code ?? 'generation_failed'}: ${
        gatewayJob.error?.message ?? 'unknown failure'
      }`,
    );
  }
  const persisted = await pool.query<{ payload_json: VideoPayload }>(
    'SELECT payload_json FROM workflow_jobs WHERE id = $1',
    [job.id],
  );
  const currentPayload = persisted.rows[0]?.payload_json ?? payload;

  const videoUrl = pendingVideoPath(roundId);
  const destination = mediaFilePath(settings.mediaDir, videoUrl);
  if (destination === null) throw new Error('pending video path escaped MEDIA_DIR');
  const sha256 = await h3.downloadVideo(gatewayJob, destination);
  const inspected = await inspectGeneratedVideo(destination);
  if (!inspected.ok) throw new Error(inspected.reason);
  if (inspected.durationSeconds > SCENE_MAX_SECONDS) {
    throw new Error(
      `generated video duration ${inspected.durationSeconds}s exceeds ${SCENE_MAX_SECONDS}s`,
    );
  }

  const advanced = await enqueueSubtitles(
    context,
    round.movie_id,
    roundId,
    currentPayload.directorAiRunId,
    sha256,
    inspected.durationSeconds,
    null,
  );
  if (!advanced) {
    return { kind: 'done', note: 'round was advanced by another worker' };
  }
  log.info(
    {
      roundId,
      gatewayJobId: gatewayJob.jobId,
      promptId: gatewayJob.promptId,
      durationSeconds: inspected.durationSeconds,
      sha256,
    },
    'FastH3 video downloaded and decoded',
  );
  return { kind: 'done' };
};
