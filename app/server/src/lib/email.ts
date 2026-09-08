// Email normalization and validation (§3.1「邮箱同样归一化后存入 email_key」).
//
// The email is only ever a recovery channel and a uniqueness key — §3.3 forbids
// returning it from any public interface or putting it into model context — so
// this file deliberately does no deliverability checking, no MX lookup and no
// provider-specific folding (no gmail dot-stripping): two people who type the
// same address must collide, and nothing more is needed.
export const EMAIL_MAX_LENGTH = 254; // RFC 5321 path limit.

// Deliberately conservative rather than RFC-complete: exactly one `@`, no
// whitespace, and a dotted domain. Quoted local parts and address literals are
// valid per RFC and rejected here on purpose — an address nobody can type into
// a password-reset form is not worth the parser.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u;

/**
 * The stored `email_key`. Lowercasing the local part is not RFC-correct — it is
 * the practical choice every mail provider already makes, and the alternative
 * is letting `Bob@` and `bob@` become two accounts on one mailbox.
 */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

/** True when a normalized address is well-formed enough to store and mail. */
export function isValidEmail(normalized: string): boolean {
  return normalized.length <= EMAIL_MAX_LENGTH && EMAIL_RE.test(normalized);
}
