// Grapheme-cluster length. Every user-facing length limit in the app is
// measured in what the reader actually sees: one CJK ideograph, one full emoji
// (ZWJ sequences included), and a base letter plus its combining marks each
// count as a single character. This mirrors on the frontend, so it must match.
//
// The Segmenter is constructed once at module load (it is expensive) and reused.
const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });

export function glen(s: string): number {
  return [...segmenter.segment(s)].length;
}

/** Keep at most `limit` user-visible grapheme clusters without splitting emoji. */
export function gtruncate(s: string, limit: number): string {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error('grapheme limit must be a non-negative safe integer');
  }
  return [...segmenter.segment(s)]
    .slice(0, limit)
    .map((part) => part.segment)
    .join('');
}
