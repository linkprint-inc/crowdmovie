// 中文按字、英文按词的长度计数（规范 §2）。
//
// This is deliberately NOT lib/grapheme.ts. The rest of the site measures every
// limit in graphemes, which is the right unit for a 140-character pitch — but
// "a 500 to 2000 word synopsis" is a different promise: 500 to an English
// writer means 500 words, and 500 to a Chinese writer means 500 characters.
// Counting a synopsis in graphemes would ask an English writer for roughly
// eighty words and call it five hundred.
//
// The rule:
//   * split on word boundaries with Intl.Segmenter
//   * skip everything that is not word-like (punctuation, spaces, symbols)
//   * inside a word-like run, count each Han / Kana / Hangul character as one,
//     and the rest of the run as one more if it has any non-ideographic
//     characters left
//
// Emoji count as nothing at all. They are neither a character nor a word, and
// a synopsis padded to 500 with emoji is not a 500-unit synopsis.
//
// This mirrors app/web/src/lib/mixed-count.ts, which must stay identical.
//
// The Segmenter is constructed once at module load (it is expensive) and reused.
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

const IDEOGRAPH =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function mixedCount(s: string): number {
  let total = 0;
  for (const { segment, isWordLike } of segmenter.segment(s)) {
    if (isWordLike !== true) continue;
    let ideographs = 0;
    let hasOther = false;
    for (const char of segment) {
      if (IDEOGRAPH.test(char)) ideographs += 1;
      else hasOther = true;
    }
    total += ideographs + (hasOther ? 1 : 0);
  }
  return total;
}

/** 规范 §2 的四个限额。 */
export const SYNOPSIS_MIN = 500;
export const SYNOPSIS_MAX = 2000;
export const CAPTION_MAX = 200;
