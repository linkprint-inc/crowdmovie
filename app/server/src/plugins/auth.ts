// Identity resolution (§3.2 steps 5–7, §3.3). Every request that arrives with a
// session or guest cookie gets its `request.currentUser` filled in here, so
// route handlers never touch the cookie themselves and the ban check (§17.31)
// lives in exactly one place.
//
// Two cookies, one decorator, and a fixed precedence: a valid session wins over
// a guest cookie, because once a browser has logged in the account name is the
// identity (创意 §4.3「已登录时，界面显示账号用户名，不再使用任何游客名」). The
// guest cookie stays behind as the fallback for a session that has expired or
// been revoked.
//
// Neither raw token is ever stored — only its SHA-256 — so a database dump
// cannot be replayed as a set of live cookies. The two lookups differ only in
// shape: `users.guest_token_hash` carries no unique index, so the guest cookie
// has to name the row (`<userId>.<token>`) and the digest is then compared in
// constant time; `sessions.token_hash` is UNIQUE, so the session cookie is the
// bare token and the index does the matching.
import crypto from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Pool } from 'pg';

export const GUEST_COOKIE = 'cm_guest';
export const SESSION_COOKIE = 'cm_session';

// §3.3「游客 Cookie Max-Age=10年」. A guest has no recovery path, so the cookie
// is the whole identity and must outlive any plausible browsing gap.
const GUEST_COOKIE_MAX_AGE_SECONDS = 10 * 365 * 24 * 60 * 60;

// §3.3「会话 Cookie Max-Age=30天，登录时轮换」— deliberately far shorter than
// the guest cookie: this one is recoverable, so it can afford to expire.
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export const guestCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
  maxAge: GUEST_COOKIE_MAX_AGE_SECONDS,
} as const;

export const sessionCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
  maxAge: SESSION_MAX_AGE_SECONDS,
} as const;

/** Path must match the one the cookie was set with, or the browser keeps it. */
export const clearCookieOptions = { path: '/' } as const;

export interface CurrentUser {
  id: string;
  usernameDisplay: string;
  /** The `username_key` this row is unique on — authoritative, not re-derived. */
  usernameKey: string;
  /** `password_hash IS NULL` — a claimed name with no account behind it (§3.1). */
  isGuest: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    currentUser: CurrentUser | null;
    /** The `sessions.id` this request authenticated with; null for guests. */
    currentSessionId: string | null;
  }
}

/**
 * A fresh opaque token — guest cookie, session cookie or password reset. 32
 * random bytes is already far past guessing range, so the stored digest is a
 * plain SHA-256: a slow KDF buys nothing against a secret that has no
 * low-entropy structure to brute-force. (Argon2id is for user-chosen passwords,
 * which do — see lib/password.ts.)
 */
export function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function buildGuestCookie(userId: string, token: string): string {
  return `${userId}.${token}`;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tokenMatches(storedHex: string, token: string): boolean {
  const stored = Buffer.from(storedHex, 'hex');
  const presented = crypto.createHash('sha256').update(token).digest();
  // timingSafeEqual throws on a length mismatch, which a corrupt column would
  // otherwise turn into a 500.
  return (
    stored.length === presented.length && crypto.timingSafeEqual(stored, presented)
  );
}

interface IdentityRow {
  id: string;
  username_display: string;
  username_key: string;
  is_guest: boolean;
  guest_token_hash: string | null;
  banned_at: Date | null;
}

interface SessionRow extends IdentityRow {
  session_id: string;
}

export interface AuthPluginOptions {
  pool: Pool;
}

async function auth(
  app: FastifyInstance,
  options: AuthPluginOptions,
): Promise<void> {
  const { pool } = options;

  // Awaited so @fastify/cookie's own onRequest parser is installed before the
  // hook below, which reads `request.cookies`.
  await app.register(cookie);

  app.decorateRequest('currentUser', null);
  app.decorateRequest('currentSessionId', null);

  async function resolveSession(token: string): Promise<SessionRow | null> {
    // Revocation and expiry are filtered in SQL: a logged-out or stale session
    // must be indistinguishable from a cookie that was never issued.
    const result = await pool.query<SessionRow>(
      `SELECT s.id AS session_id, u.id, u.username_display, u.username_key,
              u.password_hash IS NULL AS is_guest, u.guest_token_hash, u.banned_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()`,
      [hashToken(token)],
    );
    return result.rows[0] ?? null;
  }

  async function resolveGuest(raw: string): Promise<IdentityRow | null> {
    const separator = raw.indexOf('.');
    if (separator <= 0) return null;
    const userId = raw.slice(0, separator);
    const token = raw.slice(separator + 1);
    // Guard the id before it reaches PostgreSQL: a tampered cookie must be an
    // anonymous request, not a 22P02 invalid-uuid 500.
    if (token.length === 0 || !UUID_RE.test(userId)) return null;

    const result = await pool.query<IdentityRow>(
      `SELECT id, username_display, username_key, password_hash IS NULL AS is_guest,
              guest_token_hash, banned_at
         FROM users
        WHERE id = $1`,
      [userId],
    );
    const row = result.rows[0];
    if (row === undefined || row.guest_token_hash === null) return null;
    // §3.2 step 7: a cookie that does not match the database is simply not an
    // identity — the user is asked for a new username instead.
    return tokenMatches(row.guest_token_hash, token) ? row : null;
  }

  app.addHook('onRequest', async (request, reply) => {
    request.currentUser = null;
    request.currentSessionId = null;

    const sessionToken = request.cookies[SESSION_COOKIE];
    let row: IdentityRow | null = null;
    if (sessionToken !== undefined && sessionToken.length > 0) {
      const session = await resolveSession(sessionToken);
      if (session !== null) {
        row = session;
        request.currentSessionId = session.session_id;
      }
    }

    if (row === null) {
      const guestCookieValue = request.cookies[GUEST_COOKIE];
      if (guestCookieValue === undefined) return;
      row = await resolveGuest(guestCookieValue);
      if (row === null) return;
    }

    if (row.banned_at !== null) {
      return reply
        .code(403)
        .send({ error: 'banned', message: '该身份已被封禁' });
    }

    request.currentUser = {
      id: row.id,
      usernameDisplay: row.username_display,
      usernameKey: row.username_key,
      isGuest: row.is_guest,
    };
  });
}

// fastify-plugin: the decorator and the hook have to land on the root instance,
// not on an encapsulated child, or routes registered elsewhere would not see
// them.
export const authPlugin = fp(auth, { name: 'crowdmovie-auth' });
