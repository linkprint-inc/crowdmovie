// Password hashing (§3.3 安全要求). Argon2id with the parameters the plan pins:
// m=19456 KiB, t=2, p=1 — the OWASP second-choice profile, ~30 ms per hash on
// the production host, which is the point: a stolen `users` dump must not be
// bulk-crackable.
//
// Nothing in this file ever puts the plaintext into a return value, an error or
// a log line. `verify` failures are swallowed into `false` for the same reason:
// a malformed stored hash must read as "wrong password", not as a 500 whose
// stack trace carries the arguments that produced it.
import { Algorithm, hash, verify } from '@node-rs/argon2';

export const PASSWORD_MIN_LENGTH = 8;

const OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * A pre-computed hash of a random string nobody holds. Login verifies against
 * it when the account does not exist, so the unknown-user branch costs the same
 * ~30 ms as the wrong-password branch — the response bodies are identical
 * (§3.3「错误提示不区分」) and this keeps the clock from saying what the body
 * will not.
 */
const ABSENT_USER_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$n0L2KSF3HRvvBjAK+gVDWw$/WsE2ypv7gDFRa7lLxbkxfKJp6FaIKS1sIKN91AE66s';

/** Counted in code points, so an 8-emoji password is 8 characters. */
export function isPasswordTooShort(password: string): boolean {
  return [...password].length < PASSWORD_MIN_LENGTH;
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(
  storedHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

/** Spend the same work as a real verification when there is no account to check. */
export async function burnPasswordVerification(password: string): Promise<void> {
  await verifyPassword(ABSENT_USER_HASH, password);
}
