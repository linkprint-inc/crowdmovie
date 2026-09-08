// English creative limits are expressed in words, not characters. Keep this
// deliberately ASCII-focused: surrounding production prose is required to be
// English, while protected original-script character names (for example 葫芦娃)
// are not English words and therefore do not consume this particular budget.
const ENGLISH_WORD = /[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g;

export function englishWordCount(value: string): number {
  return value.match(ENGLISH_WORD)?.length ?? 0;
}
