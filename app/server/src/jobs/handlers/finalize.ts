// `round_finalize` — §5 step 2 (`selecting`) and §6.4 (single-pass selection).
// Channel
// `round` (concurrency 1, §5.2).
//
// The round is already `selecting` and its votes are already frozen: the clock
// did both in the transaction that closed it (§5 step 2). What is left is to
// wait for the things this step is not allowed to skip, pick the winner by the
// backend's own rules, and hand the round to the director.
//
// Two waits, both `defer` rather than failure (see `ledger.defer`):
//   * an earlier round still in flight — §5「上一段正式发布后，下一段才能进入最
//     终选择和拍摄流程」;
//   * a submission accepted before the deadline whose 初评 has not landed —
//     §5.3「不得因排队或暂时限流而被静默排除」.
import type { SelectionMode } from '../../ai/engine.js';
import { withTransaction } from '../../db/tx.js';
import { roundJobKey } from '../keys.js';
import { enqueue } from '../ledger.js';
import {
  hasUnfinishedEarlierRound,
  loadRound,
  requireRoundId,
  type Handler,
} from './common.js';

interface CandidateRow {
  id: string;
  eligible: boolean;
  score_total: number;
  created_at: Date;
}

/**
 * Timed-out rounds use the one Qwen score already stored for each pitch.
 * Equal totals resolve by earlier submission and then smaller UUID, entirely
 * in backend code; no second model call is allowed to reorder the result.
 */
export function pickHighestScore(
  candidates: { id: string; score_total: number; created_at: Date }[],
): string {
  const ordered = [...candidates].sort((a, b) => {
    if (b.score_total !== a.score_total) return b.score_total - a.score_total;
    const byTime = a.created_at.getTime() - b.created_at.getTime();
    if (byTime !== 0) return byTime;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return ordered[0].id;
}

export const finalizeHandler: Handler = async ({ pool, job, log }) => {
  const roundId = requireRoundId(job);
  const round = await loadRound(pool, roundId);
  if (round === null) throw new Error(`round ${roundId} is missing`);
  // §5.1 step 3. A recovered duplicate of this job must not re-select a round
  // that has already moved on — that is how a second scene gets made.
  if (round.status !== 'selecting') {
    return { kind: 'done', note: `round is ${round.status}` };
  }

  if (await hasUnfinishedEarlierRound(pool, round.movie_id, round.round_index)) {
    return { kind: 'defer', reason: 'an earlier round is still generating' };
  }

  // Unscored *and* not written off: a `submission_score` job that exhausted its
  // retries is `dead`, and waiting for it forever would strand the round. Such a
  // submission simply has no score and cannot be selected.
  const unscored = await pool.query<{ id: string }>(
    `SELECT s.id FROM submissions s
      WHERE s.round_id = $1
        AND s.kind = 'next_shot'
        AND NOT EXISTS (
              SELECT 1 FROM submission_scores sc WHERE sc.submission_id = s.id)
        AND NOT EXISTS (
              SELECT 1 FROM workflow_jobs j
               WHERE j.movie_id = $2
                 AND j.job_type = 'submission_score'
                 AND j.payload_json->>'submissionId' = s.id::text
                 AND j.status = 'dead')
      LIMIT 1`,
    [roundId, round.movie_id],
  );
  if (unscored.rowCount !== 0) {
    return { kind: 'defer', reason: 'submissions are still being scored' };
  }

  // Every surviving submission gets exactly one stored Qwen/no-thinking review.
  // Ordinary timeout selection uses the highest eligible score across the full
  // round. A threshold-close remembers its first +10 pitch and uses it at any
  // score/verdict; Qwen supplies the score + roast but cannot veto the vote.
  const candidateResult = await pool.query<CandidateRow>(
    `SELECT s.id, sc.eligible, sc.score_total, s.created_at
       FROM submissions s
       JOIN submission_scores sc ON sc.submission_id = s.id
      WHERE s.round_id = $1 AND s.kind = 'next_shot'
      ORDER BY sc.score_total DESC, s.created_at ASC, s.id ASC`,
    [roundId],
  );

  const candidates = candidateResult.rows;
  const eligibleCandidates = candidates.filter((row) => row.eligible);

  let selectionMode: SelectionMode;
  let selectedSubmissionId: string | null;

  const crowdCandidate =
    round.selection_mode === 'crowd' && round.selected_submission_id !== null
      ? candidates.find((row) => row.id === round.selected_submission_id)
      : undefined;
  const hasLegacyAutomaticCandidate =
    round.selection_mode === 'auto' && round.selected_submission_id !== null;
  if (
    crowdCandidate === undefined &&
    !hasLegacyAutomaticCandidate &&
    eligibleCandidates.length === 0
  ) {
    const failed = await pool.query(
      `UPDATE rounds
          SET status = 'select_failed', selected_submission_id = NULL,
              selection_mode = NULL, updated_at = now()
        WHERE id = $1 AND status = 'selecting'
        RETURNING id`,
      [roundId],
    );
    if (failed.rowCount === 0) {
      return { kind: 'done', note: 'round was advanced by another worker' };
    }
    log.info({ roundId }, 'round ended without an eligible audience shot');
    return { kind: 'done', note: 'no eligible audience shot; no scene generated' };
  }

  if (crowdCandidate !== undefined) {
    selectionMode = 'crowd';
    selectedSubmissionId = crowdCandidate.id;
  } else if (hasLegacyAutomaticCandidate) {
    const automaticCandidate = candidates.find(
      (row) => row.id === round.selected_submission_id,
    );
    if (automaticCandidate === undefined) {
      throw new Error('AI Director submission has no completed score');
    }
    // It is already the backend-authored continuation. Qwen supplies the
    // public score/roast but does not replace or veto it.
    selectionMode = 'auto';
    selectedSubmissionId = automaticCandidate.id;
  } else {
    selectedSubmissionId = pickHighestScore(eligibleCandidates);
    selectionMode = 'ai';
  }

  const advanced = await withTransaction(pool, async (client) => {
    const updated = await client.query<{ id: string }>(
      `UPDATE rounds SET status = 'selected', selected_submission_id = $2,
              selection_mode = $3, updated_at = now()
        WHERE id = $1 AND status = 'selecting'
        RETURNING id`,
      [roundId, selectedSubmissionId, selectionMode],
    );
    if (updated.rowCount === 0) return false;

    if (
      (selectionMode === 'crowd' || selectionMode === 'auto') &&
      selectedSubmissionId !== null
    ) {
      await client.query("UPDATE submissions SET status = 'accepted' WHERE id = $1", [
        selectedSubmissionId,
      ]);
    }

    // §6.5「入选结果……持久化后恢复电影导演 thread 并创建 scene_director 运行」.
    await enqueue(client, {
      jobType: 'scene_director',
      idempotencyKey: roundJobKey('scene_director', roundId, round.movie_id),
      movieId: round.movie_id,
      roundId,
    });
    return true;
  });

  if (!advanced) {
    return { kind: 'done', note: 'round was advanced by another worker' };
  }
  log.info(
    { roundId, selectionMode, selectedSubmissionId },
    'round selected',
  );
  return { kind: 'done' };
};
