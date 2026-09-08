// Idempotency keys. §5「同一轮选择和生成任务必须具备幂等键，防止定时器或重试造
// 成重复片段」— the UNIQUE index on `workflow_jobs.idempotency_key` is what makes
// a re-delivered NOTIFY, a duplicated timer or a restarted worker produce the
// same single job, so the format lives in one place rather than being spelled
// out at every enqueue site.
//
// One job of each pipeline type per round: `scene_director:<round>` can only
// exist once, so a round can only ever be filmed once (§17.18/19/20).
import type { JobType } from './ledger.js';

/** The job types that are per-round. `Extract` keeps them real job types. */
export type RoundJobType = Extract<
  JobType,
  | 'round_finalize'
  | 'episode_theme'
  | 'ai_screenwriter'
  | 'scene_director'
  | 'video_generate'
  | 'subtitle_author'
  | 'media_validate_publish'
>;

export function roundJobKey(
  jobType: RoundJobType,
  roundId: string,
  movieId?: string,
): string {
  return movieId === undefined
    ? `${jobType}:${roundId}`
    : `movie:${movieId}:round:${roundId}:${jobType}:v1`;
}

export function scoreJobKey(submissionId: string, movieId?: string): string {
  return movieId === undefined
    ? `submission_score:${submissionId}`
    : `movie:${movieId}:submission:${submissionId}:submission_score:v1`;
}

/**
 * 故事设定送审（《故事设定投稿技术规范》§4.2）。
 *
 * `attempt` is part of the key because a rejected proposal can be reopened,
 * edited and submitted again, and that resubmission has to be genuinely
 * reviewed rather than deduplicated against the first verdict. It is the
 * proposal's submission count, not a retry counter — the ledger's own
 * `attempt_count` handles retries of one submission.
 */
export function storyReviewJobKey(proposalId: string, attempt: number): string {
  return `story_review:${proposalId}:${attempt}`;
}

/** One missing-outline bootstrap per episode, even after recovery. */
export function episodeBootstrapJobKey(episodeId: string): string {
  return `episode_bootstrap:${episodeId}`;
}

/** One housekeeping job per UTC hour, stable across restarts and duplicate timers. */
export function maintenanceJobKey(at: Date): string {
  const hour = new Date(at);
  hour.setUTCMinutes(0, 0, 0);
  return `maintenance:${hour.toISOString()}`;
}
