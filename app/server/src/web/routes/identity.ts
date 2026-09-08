// GET /api/identity — 身份三态 (§16.3), POST /api/identity/guest — 游客认领
// (§3.2). Registration is optional on this site: picking an unused name is the
// whole signup, and the reply's cookie is the only thing that will ever prove
// the name belongs to this browser. 注册 / 登录 / 找回 live in ./auth.ts.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { FixedWindowCounter } from '../../lib/rate-limit.js';
import {
  hasForbiddenCharacters,
  isUsernameTooLong,
  isReservedUsernameKey,
  normalizeUsername,
  USERNAME_MAX_GRAPHEMES,
} from '../../lib/username.js';
import {
  buildGuestCookie,
  GUEST_COOKIE,
  guestCookieOptions,
  hashToken,
  newToken,
} from '../../plugins/auth.js';

// §3.3 requires an IP rate limit here so a script cannot bulk-squat the
// namespace — names are never released, so every claim is permanent. In-process
// fixed window, per the plan's explicit "no Redis" call.
const GUEST_CLAIM_RATE_LIMIT = 30;

// A username can only be 24 graphemes, so the body has no business being large;
// this also bounds the work Intl.Segmenter does on hostile input.
const CLAIM_BODY_LIMIT = 4096;

// Drizzle names the constraint after the column it guards; anything else that
// raises 23505 on this insert is a bug, not a taken name.
const USERNAME_UNIQUE_CONSTRAINT = 'users_username_key_unique';

function isUsernameConflict(error: unknown): boolean {
  const pgError = error as { code?: unknown; constraint?: unknown };
  return (
    pgError?.code === '23505' &&
    pgError.constraint === USERNAME_UNIQUE_CONSTRAINT
  );
}

export interface IdentityRoutesOptions {
  pool: Pool;
  rateLimit?: number;
}

export async function identityRoutes(
  app: FastifyInstance,
  options: IdentityRoutesOptions,
): Promise<void> {
  const { pool } = options;
  const limit = options.rateLimit ?? GUEST_CLAIM_RATE_LIMIT;
  const claims = new FixedWindowCounter();

  // §16.3 身份弹窗 reads this on every page load to decide what to render, so it
  // answers for all three states and never fails. The email is deliberately
  // absent: §3.3「邮箱……不在任何公开接口返回，也不进入模型上下文」.
  app.get('/api/identity', async (request) => {
    const current = request.currentUser;
    if (current === null) return { state: 'anonymous' };
    return {
      state: current.isGuest ? 'guest' : 'account',
      username: current.usernameDisplay,
    };
  });

  app.post(
    '/api/identity/guest',
    {
      bodyLimit: CLAIM_BODY_LIMIT,
      // onRequest, so rejected and malformed attempts are counted too: the
      // point is to stop bulk probing, not just bulk success.
      onRequest: async (request, reply) => {
        if (claims.record(request.ip) > limit) {
          return reply
            .code(429)
            .send({ error: 'rate_limited', message: '操作过于频繁，请稍后再试' });
        }
      },
    },
    async (request, reply) => {
      // A browser that already holds a working identity must not be able to
      // claim a second name: the old one would be orphaned forever, and a
      // double-clicked dialog is enough to trigger it.
      if (request.currentUser !== null) {
        return reply.code(409).send({
          error: 'already_identified',
          message: '当前浏览器已有身份，无需再次认领',
          username: request.currentUser.usernameDisplay,
        });
      }

      const body = request.body as { username?: unknown } | null;
      const input = typeof body?.username === 'string' ? body.username : '';

      // Checked on the raw input, before folding: a control character is not a
      // name to be cleaned up, it is a name to be refused.
      if (hasForbiddenCharacters(input)) {
        return reply.code(400).send({
          error: 'username_invalid_characters',
          message: '用户名不能包含换行或控制字符',
        });
      }

      const { display, key } = normalizeUsername(input);

      // An empty key means the input folded away to nothing — blank, or made
      // only of invisible characters, which would print as an unattributable
      // credit. Length is checked before uniqueness so an over-long duplicate
      // reads as 400 (fix your input) rather than 409 (pick another name).
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

      const token = newToken();
      let userId: string;
      try {
        // No SELECT-then-INSERT: the unique index is the only check that holds
        // under two simultaneous claims of the same name.
        const inserted = await pool.query<{ id: string }>(
          `INSERT INTO users (username_display, username_key, guest_token_hash)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [display, key, hashToken(token)],
        );
        userId = inserted.rows[0].id;
      } catch (error) {
        if (isUsernameConflict(error)) {
          return reply
            .code(409)
            .send({ error: 'username_taken', message: '该用户名已被使用' });
        }
        throw error;
      }

      reply.setCookie(
        GUEST_COOKIE,
        buildGuestCookie(userId, token),
        guestCookieOptions,
      );
      return { id: userId, username: display };
    },
  );
}
