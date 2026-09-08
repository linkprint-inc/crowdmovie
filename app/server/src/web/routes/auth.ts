// 注册 / 升级 / 登录 / 登出 / 找回密码 (§3.3). Registration is optional on this
// site, so these endpoints are not the front door — they are what turns a
// browser-bound guest into an identity that survives a cleared cookie.
//
// The one rule everything else hangs off: a request that arrives holding a
// valid guest cookie is an **in-place upgrade** of that row, never a second
// row. Usernames are永久 unique and never released (创意 §4.1), so a second row
// would strand the original name forever and orphan every submission, vote and
// credit already attributed to it.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import { isValidEmail, normalizeEmail } from '../../lib/email.js';
import { appendOutbox } from '../../lib/outbox.js';
import {
  burnPasswordVerification,
  hashPassword,
  isPasswordTooShort,
  PASSWORD_MIN_LENGTH,
  verifyPassword,
} from '../../lib/password.js';
import { FixedWindowCounter } from '../../lib/rate-limit.js';
import {
  hasForbiddenCharacters,
  isUsernameTooLong,
  isReservedUsernameKey,
  normalizeUsername,
  USERNAME_MAX_GRAPHEMES,
} from '../../lib/username.js';
import {
  clearCookieOptions,
  GUEST_COOKIE,
  hashToken,
  newToken,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  sessionCookieOptions,
} from '../../plugins/auth.js';

// §3.3「注册、登录、找回密码和游客认领接口都要有 IP 频率限制」. Per IP per minute.
const AUTH_IP_RATE_LIMIT = 20;
// §3.3「登录失败按邮箱/用户名与来源 IP 双维度限速」— five failures per window on
// either axis, so the sixth attempt is refused before it is even evaluated.
const LOGIN_FAILURE_LIMIT = 5;

// §3.1「建议 30 分钟」.
const RESET_TTL_SECONDS = 30 * 60;

// Nothing here is longer than a username, an address and a passphrase.
const BODY_LIMIT = 4096;

const USERNAME_UNIQUE_CONSTRAINT = 'users_username_key_unique';
const EMAIL_UNIQUE_CONSTRAINT = 'users_email_key_unique';

// One frozen object per failure mode, sent verbatim. §3.3 requires the login
// failure to be indistinguishable between "no such user" and "wrong password",
// and the cheapest way to guarantee byte-identical bodies is to have exactly
// one body.
const INVALID_CREDENTIALS = {
  error: 'invalid_credentials',
  message: '用户名或密码错误',
} as const;
const RATE_LIMITED = {
  error: 'rate_limited',
  message: '操作过于频繁，请稍后再试',
} as const;
const ALREADY_ACCOUNT = {
  error: 'already_account',
  message: '该身份已经是账号，无法重复注册',
} as const;
const INVALID_RESET_TOKEN = {
  error: 'invalid_token',
  message: '重置链接无效或已过期，请重新申请',
} as const;
const PASSWORD_TOO_SHORT = {
  error: 'password_too_short',
  message: `密码至少 ${PASSWORD_MIN_LENGTH} 个字符`,
} as const;
// Always the same reply, whether or not the address belongs to an account:
// otherwise this endpoint is an account-enumeration oracle.
const FORGOT_ACCEPTED = {
  status: 'sent',
  message: '如果该邮箱对应一个账号，重置邮件已经发出',
} as const;

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const pgError = error as { code?: unknown; constraint?: unknown };
  return pgError?.code === '23505' && pgError.constraint === constraint;
}

/**
 * A brand-new session row and the raw token for the cookie. Only the digest is
 * stored, so `sessions` is not a table of live credentials.
 */
async function createSession(pool: Pool, userId: string): Promise<string> {
  const token = newToken();
  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))`,
    [userId, hashToken(token), SESSION_MAX_AGE_SECONDS],
  );
  return token;
}

/**
 * Hand the browser its session and retire the guest cookie's identity role
 * (§3.3 登录). Only the cookie is cleared — `users.guest_token_hash` belongs to
 * whoever claimed it, which on a shared machine need not be the person logging
 * in.
 */
function establishSession(
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
): void {
  reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions);
  if (request.cookies[GUEST_COOKIE] !== undefined) {
    reply.clearCookie(GUEST_COOKIE, clearCookieOptions);
  }
}

export interface AuthRoutesOptions {
  pool: Pool;
  outboxPath: string;
  /** Requests per IP per minute on register / forgot / reset; tests pin it. */
  ipRateLimit?: number;
  /** Failed logins per window on each of the two axes; tests pin it. */
  loginFailureLimit?: number;
}

export async function authRoutes(
  app: FastifyInstance,
  options: AuthRoutesOptions,
): Promise<void> {
  const { pool, outboxPath } = options;
  const ipRateLimit = options.ipRateLimit ?? AUTH_IP_RATE_LIMIT;
  const loginFailureLimit = options.loginFailureLimit ?? LOGIN_FAILURE_LIMIT;

  const ipRequests = new FixedWindowCounter();
  const loginFailures = new FixedWindowCounter();

  // onRequest, so rejected and malformed attempts are counted too: the point is
  // to stop bulk probing, not just bulk success.
  const limitByIp = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    if (ipRequests.record(request.ip) > ipRateLimit) {
      return reply.code(429).send(RATE_LIMITED);
    }
  };

  // --- 注册与升级 (§3.3, §17.4a/4b) ------------------------------------------

  app.post(
    '/api/auth/register',
    { bodyLimit: BODY_LIMIT, onRequest: limitByIp },
    async (request, reply) => {
      const current = request.currentUser;
      // §3.3「服务端必须确认该行 password_hash IS NULL，已是账号的行不允许被再次
      // 升级覆盖」— otherwise anyone borrowing a logged-in browser could rebind
      // the account to their own email and password.
      if (current !== null && !current.isGuest) {
        return reply.code(409).send(ALREADY_ACCOUNT);
      }

      const body = request.body as {
        username?: unknown;
        email?: unknown;
        password?: unknown;
      } | null;
      const rawUsername = typeof body?.username === 'string' ? body.username : '';
      const rawEmail = typeof body?.email === 'string' ? body.email : '';
      const password = typeof body?.password === 'string' ? body.password : '';

      let display: string;
      let key: string;
      if (current !== null) {
        // Upgrade: the row's own username wins. The field is optional (the form
        // can show it read-only), but if it is sent it has to agree — silently
        // ignoring a different name would read to the user as a rename, and
        // names are永久 unchangeable (创意 §4.1).
        if (
          rawUsername.length > 0 &&
          normalizeUsername(rawUsername).key !== current.usernameKey
        ) {
          return reply.code(400).send({
            error: 'username_mismatch',
            message: '升级不能更改用户名，请保留当前用户名',
          });
        }
        display = current.usernameDisplay;
        key = current.usernameKey;
      } else {
        // Same gate as the guest claim (§3.2): the username is a byline printed
        // in the credits, so it is validated identically no matter which door
        // the identity comes in through.
        if (hasForbiddenCharacters(rawUsername)) {
          return reply.code(400).send({
            error: 'username_invalid_characters',
            message: '用户名不能包含换行或控制字符',
          });
        }
        ({ display, key } = normalizeUsername(rawUsername));
        if (display.length === 0 || key.length === 0) {
          return reply
            .code(400)
            .send({ error: 'username_required', message: '请输入用户名' });
        }
        if (isUsernameTooLong(display)) {
          return reply.code(400).send({
            error: 'username_too_long',
            message: `用户名最多 ${USERNAME_MAX_GRAPHEMES} 个字符`,
          });
        }
        if (isReservedUsernameKey(key)) {
          return reply
            .code(409)
            .send({ error: 'username_taken', message: '该用户名已被使用' });
        }
      }

      const email = normalizeEmail(rawEmail);
      if (!isValidEmail(email)) {
        return reply
          .code(400)
          .send({ error: 'email_invalid', message: '请输入有效的邮箱地址' });
      }
      if (isPasswordTooShort(password)) {
        return reply.code(400).send(PASSWORD_TOO_SHORT);
      }

      const passwordHash = await hashPassword(password);

      let userId: string;
      try {
        if (current !== null) {
          // One statement, and the `password_hash IS NULL` guard is inside it:
          // two upgrade requests racing on the same guest cookie can only have
          // one winner, and the loser sees 409 rather than overwriting.
          // `guest_token_hash` is retired here — after the upgrade the password
          // is the way back in, and a stale copy of the guest cookie must not
          // be a way around it.
          const updated = await pool.query<{ id: string }>(
            `UPDATE users
                SET email_key = $2,
                    password_hash = $3,
                    upgraded_at = now(),
                    guest_token_hash = NULL
              WHERE id = $1 AND password_hash IS NULL
              RETURNING id`,
            [current.id, email, passwordHash],
          );
          if (updated.rowCount === 0) {
            return reply.code(409).send(ALREADY_ACCOUNT);
          }
          userId = updated.rows[0].id;
        } else {
          // No SELECT-then-INSERT: the unique indexes are the only checks that
          // hold under two simultaneous registrations.
          const inserted = await pool.query<{ id: string }>(
            `INSERT INTO users (username_display, username_key, email_key, password_hash)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [display, key, email, passwordHash],
          );
          userId = inserted.rows[0].id;
        }
      } catch (error) {
        if (isUniqueViolation(error, USERNAME_UNIQUE_CONSTRAINT)) {
          return reply
            .code(409)
            .send({ error: 'username_taken', message: '该用户名已被使用' });
        }
        if (isUniqueViolation(error, EMAIL_UNIQUE_CONSTRAINT)) {
          return reply
            .code(409)
            .send({ error: 'email_taken', message: '该邮箱已被注册' });
        }
        throw error;
      }

      establishSession(request, reply, await createSession(pool, userId));
      return { id: userId, username: display, state: 'account' };
    },
  );

  // --- 登录 (§3.3, §17.4a/4c) -------------------------------------------------

  app.post(
    '/api/auth/login',
    { bodyLimit: BODY_LIMIT },
    async (request, reply) => {
      const body = request.body as {
        identifier?: unknown;
        password?: unknown;
      } | null;
      const rawIdentifier =
        typeof body?.identifier === 'string' ? body.identifier : '';
      const password = typeof body?.password === 'string' ? body.password : '';

      const emailKey = normalizeEmail(rawIdentifier);
      const usernameKey = normalizeUsername(rawIdentifier).key;

      // The account axis keys on the *normalized* identifier, so `Alice`,
      // `alice　` and `ALICE@x.com ` all spend the same budget. The two axes
      // share one counter, so they are namespaced: a username is arbitrary user
      // input and may be spelled exactly like an address, and the two must not
      // draw down each other's budget.
      const ipKey = `ip:${request.ip}`;
      const accountKey = `account:${isValidEmail(emailKey) ? emailKey : usernameKey}`;

      // Checked before the request is served and *not* counted: a refused
      // attempt must not extend the lockout, or the window never drains.
      if (
        loginFailures.count(ipKey) >= loginFailureLimit ||
        loginFailures.count(accountKey) >= loginFailureLimit
      ) {
        return reply.code(429).send(RATE_LIMITED);
      }

      const fail = (): FastifyReply => {
        loginFailures.record(ipKey);
        loginFailures.record(accountKey);
        return reply.code(401).send(INVALID_CREDENTIALS);
      };

      // §3.3「接受用户名或邮箱加密码」. A username may legally contain `@`, so a
      // name and someone else's address can collide; the ORDER BY makes the
      // email the winner instead of leaving it to the planner.
      const found = await pool.query<{
        id: string;
        username_display: string;
        password_hash: string | null;
      }>(
        `SELECT id, username_display, password_hash
           FROM users
          WHERE username_key = $1 OR email_key = $2
          ORDER BY (email_key IS NOT DISTINCT FROM $2) DESC
          LIMIT 1`,
        [usernameKey, emailKey],
      );
      const row = found.rows[0];

      // A guest row has no password, so it lands here too: "this name exists
      // but has no account" is exactly the fact §3.3 forbids leaking.
      if (row === undefined || row.password_hash === null) {
        await burnPasswordVerification(password);
        return fail();
      }
      if (!(await verifyPassword(row.password_hash, password))) {
        return fail();
      }

      // §3.3「会话有效期短于游客 Cookie，并在登录时轮换令牌」: the session this
      // browser arrived with is retired rather than reused.
      if (request.currentSessionId !== null) {
        await pool.query(
          'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
          [request.currentSessionId],
        );
      }

      // The account proved itself, so its own budget is released. The IP's is
      // not: a successful login says nothing about the other traffic from
      // there, which is the case the IP axis exists for.
      loginFailures.clear(accountKey);

      establishSession(request, reply, await createSession(pool, row.id));
      return {
        id: row.id,
        username: row.username_display,
        state: 'account',
      };
    },
  );

  // --- 登出 (§3.3) ------------------------------------------------------------

  app.post('/api/auth/logout', async (request, reply) => {
    // §3.3「撤销当前会话，不影响其他设备的会话」— by id, never by user.
    if (request.currentSessionId === null) {
      return reply
        .code(401)
        .send({ error: 'not_authenticated', message: '当前没有登录会话' });
    }

    await pool.query(
      'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
      [request.currentSessionId],
    );
    reply.clearCookie(SESSION_COOKIE, clearCookieOptions);
    return { ok: true };
  });

  // --- 找回密码 (§3.3, 创意 §4.3) ---------------------------------------------

  app.post(
    '/api/auth/password/forgot',
    { bodyLimit: BODY_LIMIT, onRequest: limitByIp },
    async (request, reply) => {
      const body = request.body as { email?: unknown } | null;
      const email = normalizeEmail(
        typeof body?.email === 'string' ? body.email : '',
      );

      if (isValidEmail(email)) {
        // `password_hash IS NOT NULL` — recovery is an account-only feature;
        // a guest has no email and no way back (创意 §4.2), by design.
        const found = await pool.query<{ id: string }>(
          `SELECT id FROM users
            WHERE email_key = $1 AND password_hash IS NOT NULL AND banned_at IS NULL`,
          [email],
        );
        const user = found.rows[0];
        if (user !== undefined) {
          const token = newToken();
          await pool.query(
            `INSERT INTO password_resets (user_id, token_hash, expires_at)
             VALUES ($1, $2, now() + make_interval(secs => $3))`,
            [user.id, hashToken(token), RESET_TTL_SECONDS],
          );
          try {
            await appendOutbox(outboxPath, {
              type: 'password_reset',
              to: email,
              token,
              expires_in_seconds: RESET_TTL_SECONDS,
            });
          } catch (error) {
            // An unwritable outbox is a delivery failure, not a request
            // failure — and surfacing it here would leak that the address
            // exists. The token simply goes unused and expires.
            request.log.error({ err: error }, 'outbox append failed');
          }
        }
      }

      return reply.code(202).send(FORGOT_ACCEPTED);
    },
  );

  app.post(
    '/api/auth/password/reset',
    { bodyLimit: BODY_LIMIT, onRequest: limitByIp },
    async (request, reply) => {
      const body = request.body as { token?: unknown; password?: unknown } | null;
      const token = typeof body?.token === 'string' ? body.token : '';
      const password = typeof body?.password === 'string' ? body.password : '';

      // Checked before the token is consumed: a rejected password must not burn
      // the one-time link and force the user to request another.
      if (isPasswordTooShort(password)) {
        return reply.code(400).send(PASSWORD_TOO_SHORT);
      }

      const passwordHash = await hashPassword(password);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Single-use is enforced by the UPDATE's own predicate, so two requests
        // replaying the same token cannot both win. Unknown, used and expired
        // all collapse into the same 0-row result and the same reply — the
        // distinction is only useful to an attacker.
        const consumed = await client.query<{ user_id: string }>(
          `UPDATE password_resets
              SET used_at = now()
            WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
            RETURNING user_id`,
          [hashToken(token)],
        );
        if (consumed.rowCount === 0) {
          await client.query('ROLLBACK');
          return reply.code(400).send(INVALID_RESET_TOKEN);
        }
        const userId = consumed.rows[0].user_id;

        await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
          userId,
          passwordHash,
        ]);
        // Standard practice after a credential change: whoever held a session
        // before the reset may be exactly the person it was done because of.
        await client.query(
          'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
          [userId],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      return { ok: true };
    },
  );
}
