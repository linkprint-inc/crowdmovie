// Username normalization (§3.1). Guest names and account names share one
// permanently-unique namespace, so the comparison key has to collapse every
// form two people would read as the same name — otherwise `Alice` and `alice　`
// become two identities and the "永久唯一" promise is only skin deep.
//
// The stakes are higher than a duplicate row: the username is the byline
// printed on published scenes and in the Hall of Fame. A name that renders
// blank is an unattributable credit, and `admin<ZWSP>` rendering identically to
// `admin` is impersonation. Names are never released, so neither is fixable
// after the fact — the folding has to happen before the row is inserted.
//
// Division of labour: `display` keeps what the user typed (trimmed only, so
// their chosen case and glyph forms survive into the credits); `key` is folded
// aggressively and is what `users.username_key` and its unique index compare.
import { glen } from './grapheme.js';

// The limit is counted in what the reader sees, not UTF-16 code units: one CJK
// ideograph and one full emoji each cost 1.
export const USERNAME_MAX_GRAPHEMES = 24;

// Invisible characters, removed from the key so they cannot pad a copy of a
// name that already exists.
//   \p{Cf}  format characters: ZWSP U+200B, ZWNJ U+200C, ZWJ U+200D,
//           RLO U+202E, BOM U+FEFF, soft hyphen U+00AD, the tag block.
//   FE00-FE0F / E0100-E01EF  variation selectors. These are category Mn, so
//           \p{Cf} misses them, yet `admin<VS16>` renders exactly like `admin`.
// Stripping ZWJ folds 👨‍👩‍👧‍👦 and 👨👩👧👦 onto one key. That is the intended
// direction (they are near-indistinguishable in a byline), and it costs the
// display nothing — the emoji is stored and rendered exactly as typed.
// It also folds a Persian ZWNJ spelling onto its unjoined form; rare, and the
// safe direction to err in for a namespace nobody can ever un-claim.
const INVISIBLE = /[\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;

// Runs of whitespace collapse to one: HTML renders `ad  min` and `ad min`
// identically, so they must not be two identities.
const WHITESPACE_RUN = /\s+/gu;

// Characters that have no business in a byline at all:
//   \p{Cc}          controls — \n, \r, \t, NUL. A newline in a name breaks the
//                   layout of every surface that renders it.
//   \p{Zl} \p{Zp}   line and paragraph separators, same problem.
//   202A-202E       explicit bidi embeddings and overrides (LRE/RLE/PDF/LRO/RLO)
//   2066-2069       bidi isolates (LRI/RLI/FSI/PDI)
//
// The bidi controls are already stripped from the *key* by INVISIBLE, so they
// cannot squat a name — but `username_display` is deliberately kept unfolded,
// and an unterminated override there reverses the rendering of everything after
// it. The byline is listed in the Hall of Fame and burned into published scene
// credits that are never rewritten, so one such name would flip every entry
// after it. Hence rejected at input rather than silently stripped.
//
// This bans the explicit *control* characters only. Natural right-to-left text
// carries no control characters — an Arabic or Hebrew name is ordinary letters
// that the Unicode bidi algorithm lays out on its own — so RTL names claim
// normally and must not be collateral damage here.
const FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u;

// Known remaining gap, deliberately not closed here: cross-script homoglyphs
// (Cyrillic `а` vs Latin `a`, Greek `ο` vs Latin `o`) still produce distinct
// keys. Folding those needs a Unicode confusables table and a policy decision
// about which scripts may mix inside one name — a larger call than this file.

export interface NormalizedUsername {
  display: string;
  key: string;
}

/** Historical backend-owned byline retained for stored legacy pitches. */
export const AI_DIRECTOR_USERNAME = 'AI Director';
export const AI_DIRECTOR_USERNAME_KEY = 'ai director';

/** Reserved even before the worker has created its inaccessible system row. */
export function isReservedUsernameKey(key: string): boolean {
  return key === AI_DIRECTOR_USERNAME_KEY;
}

/**
 * Derive the stored display name and the uniqueness key from raw user input.
 *
 * NFKC runs *before* the strip and the trim, because it is the pass that turns
 * the confusable width forms into their ASCII equivalents — U+3000 IDEOGRAPHIC
 * SPACE only becomes a trimmable U+0020 after it. Lowercasing is
 * locale-independent on purpose: the namespace is global, so a Turkish browser
 * must not derive a different key than a Chinese one.
 */
export function normalizeUsername(input: string): NormalizedUsername {
  return {
    display: input.trim(),
    key: input
      .normalize('NFKC')
      .replace(INVISIBLE, '')
      .replace(WHITESPACE_RUN, ' ')
      .trim()
      .toLowerCase(),
  };
}

/** True when the input contains a character no byline may carry. */
export function hasForbiddenCharacters(input: string): boolean {
  return FORBIDDEN.test(input);
}

export function isUsernameTooLong(display: string): boolean {
  return glen(display) > USERNAME_MAX_GRAPHEMES;
}
