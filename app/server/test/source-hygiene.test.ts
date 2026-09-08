// Guard against invisible characters getting committed into source files.
//
// Background: an earlier commit embedded literal NUL bytes and invisible format
// characters into a test file. Git then classified it as *binary* — `grep`
// matched nothing inside it, and structural editing broke on it. The tests still
// passed, so nothing caught it for a whole commit.
//
// The blast radius grows from here: M3 adds many more Unicode boundary tests
// (140/1000-grapheme limits, bidi controls, zero-width padding), and each one is
// a chance to paste a raw control character instead of writing its escape. The
// rule this file enforces is simply: express those characters as escapes, so the
// source stays plain visible text and every tool keeps working. Emoji that
// legitimately need a joiner or a variation selector may still be written as
// themselves.
//
// This file holds itself to the same rule: nothing below is a literal invisible
// character — the fixtures are built out of code points.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(TEST_DIR, '..');
const ROOTS = [join(SERVER_DIR, 'src'), TEST_DIR];

// NUL (the character that made the file binary), every Unicode format character
// (\p{Cf}: ZWSP U+200B, ZWNJ U+200C, ZWJ U+200D, the bidi overrides and
// isolates, BOM U+FEFF, soft hyphen, the tag block), and the variation
// selectors — which are category Mn, so \p{Cf} misses them even though
// `admin<VS16>` renders exactly like `admin`.
const SUSPECT = /[\u{0}\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u;
const VARIATION_SELECTOR = /[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const ZWJ = String.fromCodePoint(0x200d);

export interface Violation {
  line: number;
  codePoint: string;
}

function isPictographic(char: string | undefined): boolean {
  return char !== undefined && PICTOGRAPHIC.test(char);
}

/**
 * Report every invisible character in `text` that is not part of an emoji
 * sequence. Deliberately narrow: only a joiner *between* two pictographs and a
 * variation selector *after* one are excused, because those are the two forms
 * that carry meaning an escape would only obscure.
 */
export function scanText(text: string): Violation[] {
  const chars = Array.from(text); // by code point, so astral chars stay whole
  const violations: Violation[] = [];
  let line = 1;

  // The left neighbour of a joiner may itself be a variation selector — as in
  // the U+2764 U+FE0F U+200D U+1F525 sequence — so look past those when judging
  // adjacency.
  const leftOf = (index: number): string | undefined => {
    let at = index - 1;
    while (at >= 0 && VARIATION_SELECTOR.test(chars[at])) at -= 1;
    return at >= 0 ? chars[at] : undefined;
  };

  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    if (char === '\n') {
      line += 1;
      continue;
    }
    if (!SUSPECT.test(char)) continue;
    if (
      char === ZWJ &&
      isPictographic(leftOf(i)) &&
      isPictographic(chars[i + 1])
    ) {
      continue;
    }
    if (VARIATION_SELECTOR.test(char) && isPictographic(chars[i - 1])) continue;

    const code = char.codePointAt(0) ?? 0;
    violations.push({
      line,
      codePoint: `U+${code.toString(16).toUpperCase().padStart(4, '0')}`,
    });
  }

  return violations;
}

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else found.push(path);
  }
  return found;
}

test('src / test 下没有 NUL 或 emoji 之外的不可见字符', () => {
  const files = ROOTS.flatMap((root) => sourceFiles(root));
  // A walk that silently found nothing would make this guard vacuous.
  expect(files.length).toBeGreaterThan(10);

  const offenders: string[] = [];
  for (const file of files) {
    for (const violation of scanText(readFileSync(file, 'utf8'))) {
      offenders.push(
        `${relative(SERVER_DIR, file)}:${violation.line} ${violation.codePoint}`,
      );
    }
  }

  // Fix by writing the character as an escape instead of pasting it literally.
  expect(offenders).toEqual([]);
});

test('扫描器本身有效：识别不可见字符，且不误伤 emoji 与普通文本', () => {
  const codes = (text: string): string[] =>
    scanText(text).map((violation) => violation.codePoint);
  const s = (...points: number[]): string => String.fromCodePoint(...points);

  const NUL = 0x0000;
  const ZWSP = 0x200b;
  const ZWNJ = 0x200c;
  const JOINER = 0x200d;
  const RLO = 0x202e;
  const BOM = 0xfeff;
  const VS16 = 0xfe0f;
  const MAN = 0x1f468;
  const WOMAN = 0x1f469;
  const GIRL = 0x1f467;
  const HEART = 0x2764;
  const FIRE = 0x1f525;
  const THUMB = 0x1f44d;
  const SKIN_TONE_4 = 0x1f3fd;
  const A = 0x61;
  const B = 0x62;

  // The characters behind the incident, and their usual neighbours.
  expect(codes(s(A, NUL, B))).toEqual(['U+0000']); // makes the file binary
  expect(codes(`admin${s(ZWSP)}`)).toEqual(['U+200B']); // zero-width padding
  expect(codes(`ad${s(JOINER)}min`)).toEqual(['U+200D']); // joiner between letters
  expect(codes(`admin${s(VS16)}`)).toEqual(['U+FE0F']); // bare variation selector
  expect(codes(`${s(BOM)}admin${s(RLO)}`)).toEqual(['U+FEFF', 'U+202E']);
  expect(codes(s(A, ZWSP, ZWNJ, JOINER, B))).toHaveLength(3);

  // Emoji sequences may be written as themselves.
  expect(codes(s(MAN, JOINER, WOMAN, JOINER, GIRL))).toEqual([]);
  expect(codes(s(HEART, VS16, JOINER, FIRE))).toEqual([]);
  expect(codes(s(THUMB, SKIN_TONE_4))).toEqual([]);

  // Ordinary source text, including CJK and escapes written as escapes.
  expect(codes("const s = '\\u200B'; // 中文注释\n")).toEqual([]);

  // Line numbers point at the offending line, not the start of the file.
  expect(scanText(`one\ntwo\nthr${s(ZWSP)}ee`)).toEqual([
    { line: 3, codePoint: 'U+200B' },
  ]);
});
