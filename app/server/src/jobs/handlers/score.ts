// `submission_score` — each pitch gets one Qwen no-thinking structured pass.
// Channel `scoring`
// (concurrency 2, §5.2).
//
// The job was enqueued inside the submission's own INSERT transaction (§6.3
// 「投稿写入 PostgreSQL 的同一事务中创建 submission_score 任务」), so it exists
// exactly when the submission does.
import { validateScore } from '../../ai/validate.js';
import { withTransaction } from '../../db/tx.js';
import { emitEvent } from '../../lib/events.js';
import {
  insertAiRun,
  loadRecentScenes,
  requirePayload,
  requireRoundId,
  timed,
  type Handler,
} from './common.js';

interface ScorePayload {
  submissionId: string;
}

interface SubmissionRow {
  id: string;
  movie_id: string;
  kind: 'next_shot' | 'next_episode';
  content: string;
  episode_title: string;
  episode_theme: string;
  episode_id: string;
  already_scored: boolean;
}

/**
 * Stable semantic verdict emitted by the scoring rubric for meaningless text.
 * Every meaningful row remains public whether or not it contains the famous
 * character required for AI selection; only this flag causes destructive
 * discard.
 */
export const NOT_STORY_CONTENT_FLAG = 'not_story_content';

export const scoreHandler: Handler = async ({ pool, engine, job, log }) => {
  const { submissionId } = requirePayload<ScorePayload>(job, ['submissionId']);
  const roundId = requireRoundId(job);

  const found = await pool.query<SubmissionRow>(
    `SELECT s.id, s.movie_id, s.kind, s.content, s.episode_id,
            e.title AS episode_title, e.theme AS episode_theme,
            EXISTS (SELECT 1 FROM submission_scores sc WHERE sc.submission_id = s.id)
              AS already_scored
       FROM submissions s
       JOIN episodes e ON e.id = s.episode_id
      WHERE s.id = $1`,
    [submissionId],
  );
  const submission = found.rows[0];
  if (submission === undefined) {
    // A prior attempt may already have classified and hard-deleted meaningless
    // text. There is then nothing to score and no business row to recreate.
    return { kind: 'done', note: 'submission is gone' };
  }
  // §5.1 step 3: re-verify before doing real work. A stolen lease means another
  // worker may already have scored this one, and a second Qwen call would burn
  // quota to produce a row the PK would then reject.
  if (submission.already_scored) {
    return { kind: 'done', note: 'already scored' };
  }
  const input = {
    submissionId,
    kind: submission.kind,
    content: submission.content,
    episodeTitle: submission.episode_title,
    episodeTheme: submission.episode_theme,
    recentScenes: await loadRecentScenes(
      pool,
      submission.movie_id,
      submission.episode_id,
    ),
  };
  const { value: output, latencyMs } = await timed(() =>
    engine.scoreSubmission(input),
  );
  validateScore(output, submissionId);
  const modelSaysNotStory =
    !output.eligible && output.riskFlags.includes(NOT_STORY_CONTENT_FLAG);

  const wrote = await withTransaction(pool, async (client) => {
    const current = await client.query<{ protected_candidate: boolean }>(
      `SELECT EXISTS (
                SELECT 1 FROM rounds r
                 WHERE r.selected_submission_id = s.id
                   AND r.selection_mode IN ('crowd', 'auto')
              ) AS protected_candidate
         FROM submissions s WHERE s.id = $1 FOR UPDATE`,
      [submissionId],
    );
    if (current.rowCount === 0) return false;

    const existing = await client.query(
      'SELECT 1 FROM submission_scores WHERE submission_id = $1',
      [submissionId],
    );
    if (existing.rowCount !== 0) return false;

    // Net +10 and a legacy backend-authored AI Director shot are hard selections.
    // Qwen still produces and stores the same score + roast, but even a
    // 0/ineligible/not-story verdict cannot delete or veto either protected
    // candidate. Ordinary user pitches keep the destructive not-story rule.
    if (modelSaysNotStory && !current.rows[0].protected_candidate) {
      // Keep only a content-free operational record of the paid model call.
      // The submission id is intentionally not retained in ai_runs: the job
      // ledger already proves the worker completed, while neither the original
      // prose nor a roast that may echo it survives the deletion.
      await insertAiRun(client, engine, {
        roundId,
        submissionId: null,
        runType: 'submission_score',
        input,
        output,
        storedInput: { disposition: 'deleted_not_story_content' },
        storedOutput: {
          disposition: 'deleted_not_story_content',
          rubricVersion: output.rubricVersion,
        },
        latencyMs,
        promptPlanVersion: output.rubricVersion,
      });

      // Votes can land during the short scoring window. Remove every child row
      // before the FK-protected submission. If this was the only shot, the
      // clock disarms the now-empty round instead of generating replacement
      // content when the former deadline arrives.
      await client.query('DELETE FROM submission_votes WHERE submission_id = $1', [
        submissionId,
      ]);
      await client.query(
        'DELETE FROM submission_translations WHERE submission_id = $1',
        [submissionId],
      );
      const deleted = await client.query<{ id: string }>(
        `DELETE FROM submissions
          WHERE id = $1 AND status = 'pending'
          RETURNING id`,
        [submissionId],
      );
      if (deleted.rowCount === 0) {
        throw new Error(`submission ${submissionId} changed before deletion`);
      }

      await emitEvent(client, {
        type: 'submission.deleted',
        data: { submissionId },
      });
      return true;
    }

    const aiRunId = await insertAiRun(client, engine, {
      roundId,
      submissionId,
      runType: 'submission_score',
      input,
      output,
      latencyMs,
      promptPlanVersion: output.rubricVersion,
    });

    await client.query(
      `INSERT INTO submission_scores
         (submission_id, eligible, score_total, score_breakdown, reason,
          public_roast, risk_flags, rubric_version, ai_run_id, scored_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7::jsonb, $8, $9, now())`,
      [
        submissionId,
        output.eligible,
        output.scoreTotal,
        JSON.stringify(output.scoreBreakdown),
        output.reason,
        JSON.stringify(output.publicRoast),
        JSON.stringify(output.riskFlags),
        output.rubricVersion,
        aiRunId,
      ],
    );

    // Every meaningful pitch remains visible. One with no famous character is
    // marked rejected only to keep it out of the AI selection pool; meaningless
    // text took the hard-delete branch above.
    const accepted = output.eligible || current.rows[0].protected_candidate;
    await client.query('UPDATE submissions SET status = $2 WHERE id = $1', [
      submissionId,
      accepted ? 'accepted' : 'rejected',
    ]);

    // §16.4 `submission.scored`「含总分与四语毒舌」— the two things §6.3 makes
    // public. The breakdown, the reason and the risk flags stay on the server,
    // exactly as they do in the GET endpoints. Emitted inside the transaction
    // so it is delivered at COMMIT and never for a score that rolled back.
    await emitEvent(client, {
      type: 'submission.scored',
      data: {
        movieId: submission.movie_id,
        submissionId,
        status: accepted ? 'accepted' : 'rejected',
        total: output.scoreTotal,
        roast: output.publicRoast,
      },
    });
    return true;
  });

  if (!wrote) {
    log.warn({ submissionId }, 'submission was completed by another worker');
    return { kind: 'done', note: 'already completed' };
  }
  return { kind: 'done' };
};
