/*
 * Client mirror of app/server/src/lib/mixed-count.ts. The two must agree
 * exactly, or the composer's counter will disagree with the server's
 * content_too_long rejection.
 *
 * 中文按字、英文按词（规范 §2）。This is deliberately NOT lib/grapheme.ts: the
 * rest of the site measures limits in graphemes, which is right for a
 * 140-character pitch, but "500 to 2000 words" means words to an English
 * writer and characters to a Chinese one.
 *
 * Load-bearing details kept identical to the server: the locale string "zh",
 * granularity "word", one segmenter constructed at module load, skipping
 * everything that is not word-like, counting Han / Kana / Hangul characters
 * one apiece and the remainder of a run as one more.
 */

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

const IDEOGRAPH = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

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

/** Server-enforced limits, from app/server/src/lib/mixed-count.ts. */
export const SYNOPSIS_MIN = 500;
export const SYNOPSIS_MAX = 2000;
export const CAPTION_MAX = 200;
/** app/server/src/web/routes/story-authoring.ts —— 短字段，按 grapheme 计。 */
export const STORY_TITLE_MAX_GRAPHEMES = 80;
/** app/server/src/web/routes/stories.ts —— 短字段，按 grapheme 计。 */
export const STORY_COMMENT_MAX_GRAPHEMES = 500;
