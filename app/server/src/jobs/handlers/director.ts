// `scene_director` — §6.5 台词、导演包与 ComfyUI JSON。Channel `director`
// (concurrency 1, §5.2).
//
// The round enters this handler `selected` (winner persisted, §5 step 3) and
// leaves it `generating` (§5 step 4) with a validated director package on the
// record. §6.5 is explicit that the backend verifies duration, submission ID,
// contributor, dialogue timeline and H3 parameters and may not patch any of
// them — so validation failing here is a failed round, not a repaired one.
import type { Pool } from 'pg';

import type { DirectSceneInput } from '../../ai/engine.js';
import { validateDirector } from '../../ai/validate.js';
import { withTransaction } from '../../db/tx.js';
import { roundJobKey } from '../keys.js';
import { enqueue } from '../ledger.js';
import {
  hasUnfinishedEarlierRound,
  insertAiRun,
  loadEpisode,
  loadEpisodeScenes,
  loadPreviousScene,
  loadRound,
  requireRoundId,
  timed,
  type Handler,
  type RoundRow,
} from './common.js';

interface SelectedRow {
  id: string;
  content: string;
  author_username: string;
}

export async function buildDirectorInput(
  pool: Pool,
  round: RoundRow,
  h3Capabilities: unknown,
  workflowRepair?: DirectSceneInput['workflowRepair'],
): Promise<DirectSceneInput> {
  let selected: SelectedRow | null = null;
  if (round.selected_submission_id !== null) {
    const found = await pool.query<SelectedRow>(
      `SELECT s.id, s.content, u.username_display AS author_username
         FROM submissions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1`,
      [round.selected_submission_id],
    );
    if (found.rows[0] === undefined) {
      throw new Error(`selected submission ${round.selected_submission_id} is missing`);
    }
    selected = found.rows[0];
  }

  const episode = await loadEpisode(pool, round.episode_id);
  const previousScene = await loadPreviousScene(pool, round.movie_id, round.episode_id);
  return {
    roundId: round.id,
    episodeIndex: episode.episode_index,
    episodeTitle: episode.title,
    episodeTheme: episode.theme,
    selectedSubmission:
      selected === null
        ? null
        : {
            id: selected.id,
            content: selected.content,
            authorUsername: selected.author_username,
          },
    selectionMode: round.selection_mode ?? 'auto',
    // Each fresh director thread receives the complete published episode canon.
    recentScenes: await loadEpisodeScenes(pool, round.movie_id, round.episode_id),
    previousScene,
    ...(previousScene === null ? { previousChapter: await loadPreviousScene(pool, round.movie_id, null) } : {}),
    h3Capabilities,
    ...(workflowRepair === undefined ? {} : { workflowRepair }),
  };
}

export const directorHandler: Handler = async ({ pool, engine, h3, job, log }) => {
  const roundId = requireRoundId(job);
  const round = await loadRound(pool, roundId);
  if (round === null) throw new Error(`round ${roundId} is missing`);
  // §5.1 step 3. The director run and the move to `generating` commit together,
  // so a round that is past `selected` already has its package.
  if (round.status !== 'selected') {
    return { kind: 'done', note: `round is ${round.status}` };
  }
  // Crowd election can select the newly opened round while the previous scene
  // is still rendering. Preserve story order: the winner is final, but its H3
  // JSON must wait until the prior scene is published so recent canon is real.
  if (await hasUnfinishedEarlierRound(pool, round.movie_id, round.round_index)) {
    return { kind: 'defer', reason: 'an earlier round is still generating' };
  }

  const h3Capabilities =
    h3 === undefined
      ? { version: 'stub-h3-capabilities-v1' }
      : await h3.getCapabilities();
  const input = await buildDirectorInput(pool, round, h3Capabilities);

  const { value: output, latencyMs } = await timed(() => engine.directScene(input));
  validateDirector(output, {
    roundId,
    selectedSubmissionId: round.selected_submission_id,
    capabilitiesVersion: String(
      (h3Capabilities as { version?: unknown }).version ?? '',
    ),
    previousEndFrameSha256: input.previousScene?.endFrame?.sha256 ?? null,
    previousMotionContextId: input.previousScene?.motionContextId ?? null,
    previousFilmState: input.previousScene?.observedEndState ?? input.previousScene?.filmPlan?.exitState,
  });

  const advanced = await withTransaction(pool, async (client) => {
    const aiRunId = await insertAiRun(client, engine, {
      roundId,
      submissionId: round.selected_submission_id,
      runType: 'scene_director',
      input,
      output,
      latencyMs,
      promptPlanVersion: output.directorSchemaVersion,
    });

    const updated = await client.query<{ id: string }>(
      `UPDATE rounds SET status = 'generating', updated_at = now()
        WHERE id = $1 AND status = 'selected'
        RETURNING id`,
      [roundId],
    );
    if (updated.rowCount === 0) return null;

    await enqueue(client, {
      jobType: 'video_generate',
      idempotencyKey: roundJobKey('video_generate', roundId, round.movie_id),
      movieId: round.movie_id,
      roundId,
      payload: { directorAiRunId: aiRunId },
    });
    return aiRunId;
  });

  if (advanced === null) {
    return { kind: 'done', note: 'round was advanced by another worker' };
  }
  log.info({ roundId, directorAiRunId: advanced }, 'director package accepted');
  return { kind: 'done' };
};
