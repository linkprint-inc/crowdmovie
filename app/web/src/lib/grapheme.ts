/*
 * Client mirror of app/server/src/lib/grapheme.ts. The two must agree exactly,
 * or the composer's counter will disagree with the server's `content_too_long`
 * rejection. The server is:
 *
 *   const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });
 *   export function glen(s: string): number {
 *     return [...segmenter.segment(s)].length;
 *   }
 *
 * Load-bearing details kept identical: the locale string "zh", granularity
 * "grapheme", one segmenter constructed at module load, and counting the
 * spread iterator (not code points, not UTF-16 units). A CJK ideograph, a ZWJ
 * emoji sequence and a base letter plus combining marks each count as 1.
 */

const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });

export function glen(s: string): number {
  return [...segmenter.segment(s)].length;
}

/** Server-enforced limits, from app/server/src/web/routes/submissions.ts. */
export const NEXT_SHOT_MAX_GRAPHEMES = 140;
export const NEXT_EPISODE_MAX_GRAPHEMES = 1000;
/** Not yet enforced server-side (no danmaku route); spec §6.5 / rules table. */
export const DANMAKU_MAX_GRAPHEMES = 100;
/** app/server/src/lib/username.ts */
export const USERNAME_MAX_GRAPHEMES = 24;
/** app/server/src/lib/password.ts — code points, not graphemes. */
export const PASSWORD_MIN_LENGTH = 8;
/** Spec §2.5 contact form. */
export const CONTACT_MAX_GRAPHEMES = 1000;

export const SUBMISSION_KINDS = ["next_shot", "next_episode"] as const;
export type SubmissionKind = (typeof SUBMISSION_KINDS)[number];

export const KIND_MAX_GRAPHEMES: Record<SubmissionKind, number> = {
  next_shot: NEXT_SHOT_MAX_GRAPHEMES,
  next_episode: NEXT_EPISODE_MAX_GRAPHEMES,
};
