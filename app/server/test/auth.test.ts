// T2.2 注册 / 升级 / 登录 / 登出 / 找回 —《技术》§3.3 全部规则，《验收》§17 的
// 1–4、4a–4c。
//
// Integration tests against the same real PostgreSQL database the other suites
// use (vitest runs test files sequentially, see vitest.config.ts). Usernames and
// emails are permanently unique and this suite never truncates the table, so
// every identifier carries a per-run random suffix.
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';

import { runMigrations } from '../src/db/migrate';
import {
  INLAND_EMPIRE_BIBLE_ID,
  INLAND_EMPIRE_MOVIE_ID,
} from '../src/movies/catalog';
import { normalizeEmail } from '../src/lib/email';
import { GUEST_COOKIE, SESSION_COOKIE } from '../src/plugins/auth';
import { buildApp } from '../src/web/app';
import { ensureDatabase, TEST_URL } from './database';

const OUTBOX = join(mkdtempSync(join(tmpdir(), 'crowdmovie-outbox-')), 'outbox.log');

const config = {
  SERVICE_ROLE: 'web',
  DATABASE_URL: TEST_URL,
  SESSION_SECRET: 'x'.repeat(32),
  PORT: 3100,
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
  OUTBOX_PATH: OUTBOX,
} as const;

let pool: pg.Pool;
let app: ReturnType<typeof buildApp>;

const rnd = (n = 10): string => crypto.randomBytes(8).toString('hex').slice(0, n);
const PASSWORD = 'correct horse battery';

type Instance = ReturnType<typeof buildApp>;
type Reply = Awaited<ReturnType<Instance['inject']>>;

interface Call {
  cookie?: string;
  ip?: string;
  app?: Instance;
}

function post(url: string, payload: unknown, call: Call = {}) {
  return (call.app ?? app).inject({
    method: 'POST',
    url,
    payload: payload as object,
    headers: call.cookie === undefined ? {} : { cookie: call.cookie },
    remoteAddress: call.ip,
  });
}

const claimGuest = (username: string, call: Call = {}) =>
  post('/api/identity/guest', { username }, call);
const register = (payload: unknown, call: Call = {}) =>
  post('/api/auth/register', payload, call);
const login = (payload: unknown, call: Call = {}) =>
  post('/api/auth/login', payload, call);
const logout = (call: Call = {}) => post('/api/auth/logout', {}, call);
const forgot = (payload: unknown, call: Call = {}) =>
  post('/api/auth/password/forgot', payload, call);
const resetPassword = (payload: unknown, call: Call = {}) =>
  post('/api/auth/password/reset', payload, call);
const identity = (call: Call = {}) =>
  (call.app ?? app).inject({
    method: 'GET',
    url: '/api/identity',
    headers: call.cookie === undefined ? {} : { cookie: call.cookie },
  });

function cookieOf(r: Reply, name: string): string {
  const found = r.cookies.find((each) => each.name === name);
  if (found === undefined) throw new Error(`cookie ${name} missing from response`);
  return found.value;
}

const sessionCookie = (r: Reply): string =>
  `${SESSION_COOKIE}=${cookieOf(r, SESSION_COOKIE)}`;
const guestCookie = (r: Reply): string =>
  `${GUEST_COOKIE}=${cookieOf(r, GUEST_COOKIE)}`;

/** The raw `Set-Cookie` line for one cookie, so attributes are checked on it. */
function setCookieLine(r: Reply, name: string): string {
  const raw = r.headers['set-cookie'];
  const lines = Array.isArray(raw) ? raw : [String(raw)];
  const found = lines.find((line) => line.startsWith(`${name}=`));
  if (found === undefined) throw new Error(`no Set-Cookie for ${name}`);
  return found;
}

/** A fresh account, returned with the cookie header a browser would send back. */
async function makeAccount(): Promise<{
  id: string;
  username: string;
  email: string;
  cookie: string;
}> {
  const s = rnd();
  const username = `账号${s}`;
  const email = `acct-${s}@example.com`;
  const r = await register({ username, email, password: PASSWORD });
  expect(r.statusCode).toBe(200);
  return { id: r.json().id, username, email, cookie: sessionCookie(r) };
}

/** Outbox lines, newest last. The outbox stands in for SMTP (§7 开放决策). */
function outboxEntries(): Record<string, unknown>[] {
  let raw = '';
  try {
    raw = readFileSync(OUTBOX, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function resetTokenFor(email: string): string {
  const entry = outboxEntries()
    .reverse()
    .find((each) => each.to === normalizeEmail(email));
  if (entry === undefined) throw new Error(`no outbox entry for ${email}`);
  return entry.token as string;
}

beforeAll(async () => {
  await ensureDatabase();
  await runMigrations(TEST_URL);
  pool = new pg.Pool({ connectionString: TEST_URL });
  // Rate limiting has dedicated tests below with their own app instances; the
  // shared one is pinned high so this file does not throttle itself.
  app = buildApp(config, pool, {
    guestClaimRateLimit: 10_000,
    authIpRateLimit: 10_000,
    loginFailureLimit: 10_000,
  });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

// --- 注册：新账号 (§3.3 注册, §17.4a) -----------------------------------------

test('无 Cookie 注册创建账号：200 + 会话 Cookie(HttpOnly/Secure/SameSite=Lax/30天)', async () => {
  const s = rnd();
  const r = await register({
    username: `新账号${s}`,
    email: `New-${s}@Example.COM `,
    password: PASSWORD,
  });

  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({
    id: expect.any(String),
    username: `新账号${s}`,
    state: 'account',
  });

  const setCookie = setCookieLine(r, SESSION_COOKIE);
  expect(setCookie).toMatch(/HttpOnly/);
  expect(setCookie).toMatch(/Secure/);
  expect(setCookie).toMatch(/SameSite=Lax/);
  expect(setCookie).toMatch(/Path=\//);
  expect(setCookie).toMatch(/Max-Age=2592000/); // 会话 Cookie 30 天 (§3.3)

  const row = await pool.query(
    'SELECT email_key, password_hash, upgraded_at, guest_token_hash FROM users WHERE id = $1',
    [r.json().id],
  );
  // 邮箱归一化后入库 (§3.1)
  expect(row.rows[0].email_key).toBe(`new-${s}@example.com`);
  expect(row.rows[0].password_hash).toMatch(/^\$argon2id\$/);
  expect(row.rows[0].upgraded_at).toBeNull(); // 直接注册不是升级
  expect(row.rows[0].guest_token_hash).toBeNull();
});

test('密码以 argon2id(m=19456,t=2,p=1) 哈希存储，明文从不落库 (§17.4c)', async () => {
  const account = await makeAccount();
  const row = await pool.query(
    'SELECT password_hash FROM users WHERE id = $1',
    [account.id],
  );
  const hash = row.rows[0].password_hash as string;
  expect(hash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
  expect(hash).not.toContain(PASSWORD);

  const leak = await pool.query(
    `SELECT count(*)::int AS n FROM users
      WHERE password_hash = $1 OR username_display = $1
         OR username_key = $1 OR email_key = $1`,
    [PASSWORD],
  );
  expect(leak.rows[0].n).toBe(0);
});

test('注册校验：邮箱格式、邮箱重复、密码长度、用户名规则', async () => {
  const s = rnd();
  const ok = { username: `校验${s}`, email: `v-${s}@example.com`, password: PASSWORD };

  for (const bad of ['not-an-email', 'a@b', '', 'a b@example.com', 42]) {
    const r = await register({ ...ok, email: bad });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('email_invalid');
  }

  const short = await register({ ...ok, password: '1234567' });
  expect(short.statusCode).toBe(400);
  expect(short.json().error).toBe('password_too_short');

  expect((await register({ ...ok, username: '' })).json().error).toBe(
    'username_required',
  );
  expect((await register({ ...ok, username: '字'.repeat(25) })).json().error).toBe(
    'username_too_long',
  );
  expect((await register({ ...ok, username: 'a\nb' })).json().error).toBe(
    'username_invalid_characters',
  );

  expect((await register(ok)).statusCode).toBe(200);

  // 用户名被占用
  const takenName = await register({
    ...ok,
    email: `other-${s}@example.com`,
  });
  expect(takenName.statusCode).toBe(409);
  expect(takenName.json().error).toBe('username_taken');

  // 邮箱被占用（大小写/空格归一化后同一个）
  const takenEmail = await register({
    username: `另一个${s}`,
    email: ` V-${s}@EXAMPLE.com `,
    password: PASSWORD,
  });
  expect(takenEmail.statusCode).toBe(409);
  expect(takenEmail.json().error).toBe('email_taken');
});

// --- 升级：本里程碑的核心 (§3.3 升级, §17.4b) ---------------------------------

test('AI Director 保留名不能注册成账号', async () => {
  const response = await register({
    username: 'ai director',
    email: `ai-director-${rnd()}@example.com`,
    password: PASSWORD,
  });
  expect(response.statusCode).toBe(409);
  expect(response.json().error).toBe('username_taken');
});

test('带游客 Cookie 注册 = 原地升级：同一行、用户名不变、投稿仍归属、不产生第二身份', async () => {
  const s = rnd();
  const username = `升级前${s}`;
  const claimed = await claimGuest(username);
  expect(claimed.statusCode).toBe(200);
  const guestId = claimed.json().id as string;
  const cookie = guestCookie(claimed);

  // 升级前先留下一条投稿，证明升级不做数据迁移。
  const episode = await pool.query(
    `INSERT INTO episodes
       (movie_id, bible_version_id, episode_index, title, theme, status)
     VALUES ($1, $2, $3, 'T', 'T', 'ended') RETURNING id`,
    [
      INLAND_EMPIRE_MOVIE_ID,
      INLAND_EMPIRE_BIBLE_ID,
      Math.floor(Math.random() * 2_000_000_000),
    ],
  );
  const round = await pool.query(
    `INSERT INTO rounds
       (movie_id, round_index, episode_id, status, opens_at, closes_at)
     VALUES ($1, $2, $3, 'published', now(), now() + interval '5 minutes')
     RETURNING id`,
    [
      INLAND_EMPIRE_MOVIE_ID,
      Math.floor(Math.random() * 2_000_000_000),
      episode.rows[0].id,
    ],
  );
  const submission = await pool.query(
    `INSERT INTO submissions
       (movie_id, kind, round_id, episode_id, user_id, content)
     VALUES ($1, 'next_shot', $2, $3, $4, '升级前的投稿') RETURNING id`,
    [INLAND_EMPIRE_MOVIE_ID, round.rows[0].id, episode.rows[0].id, guestId],
  );
  const submissionId = submission.rows[0].id as string;

  const upgraded = await register(
    { username, email: `up-${s}@example.com`, password: PASSWORD },
    { cookie },
  );
  expect(upgraded.statusCode).toBe(200);
  expect(upgraded.json().id).toBe(guestId); // 同一行
  expect(upgraded.json().username).toBe(username); // 用户名不变
  expect(upgraded.json().state).toBe('account');

  const row = await pool.query(
    'SELECT username_display, email_key, password_hash, upgraded_at, guest_token_hash FROM users WHERE id = $1',
    [guestId],
  );
  expect(row.rows[0].username_display).toBe(username);
  expect(row.rows[0].email_key).toBe(`up-${s}@example.com`);
  expect(row.rows[0].password_hash).not.toBeNull();
  expect(row.rows[0].upgraded_at).not.toBeNull();
  // 游客令牌作废：升级后旧 Cookie 不能再绕过密码认回这个身份。
  expect(row.rows[0].guest_token_hash).toBeNull();

  // 投稿仍归属原 user_id，没有搬迁
  const kept = await pool.query('SELECT user_id FROM submissions WHERE id = $1', [
    submissionId,
  ]);
  expect(kept.rows[0].user_id).toBe(guestId);

  // 没有第二个身份：这个用户名只对应一行
  const rows = await pool.query(
    'SELECT count(*)::int AS n FROM users WHERE username_key = $1',
    [username.toLowerCase()],
  );
  expect(rows.rows[0].n).toBe(1);

  // 升级后旧游客 Cookie 不再是身份
  const stale = await identity({ cookie });
  expect(stale.json().state).toBe('anonymous');

  // 新会话立即可用
  const now = await identity({ cookie: sessionCookie(upgraded) });
  expect(now.json()).toEqual({ state: 'account', username });
});

test('已是账号的行不能被再次“升级”：409 (§3.3)', async () => {
  const account = await makeAccount();
  const again = await register(
    {
      username: account.username,
      email: `second-${rnd()}@example.com`,
      password: PASSWORD,
    },
    { cookie: account.cookie },
  );
  expect(again.statusCode).toBe(409);
  expect(again.json().error).toBe('already_account');

  // 邮箱没有被覆盖
  const row = await pool.query('SELECT email_key FROM users WHERE id = $1', [
    account.id,
  ]);
  expect(row.rows[0].email_key).toBe(normalizeEmail(account.email));
});

test('升级时 body 用户名与游客行不一致：400，原用户名保留', async () => {
  const claimed = await claimGuest(`不改名${rnd()}`);
  const cookie = guestCookie(claimed);

  const mismatch = await register(
    { username: `想改成${rnd()}`, email: `m-${rnd()}@example.com`, password: PASSWORD },
    { cookie },
  );
  expect(mismatch.statusCode).toBe(400);
  expect(mismatch.json().error).toBe('username_mismatch');

  const row = await pool.query('SELECT password_hash FROM users WHERE id = $1', [
    claimed.json().id,
  ]);
  expect(row.rows[0].password_hash).toBeNull(); // 仍是游客
});

test('升级时省略 username 字段：沿用游客行的用户名', async () => {
  const username = `省略用户名${rnd()}`;
  const claimed = await claimGuest(username);

  const upgraded = await register(
    { email: `omit-${rnd()}@example.com`, password: PASSWORD },
    { cookie: guestCookie(claimed) },
  );
  expect(upgraded.statusCode).toBe(200);
  expect(upgraded.json().username).toBe(username);
  expect(upgraded.json().id).toBe(claimed.json().id);
});

test('升级失败（邮箱已占用）不会半途改写游客行', async () => {
  const existing = await makeAccount();
  const username = `升级失败${rnd()}`;
  const claimed = await claimGuest(username);

  const r = await register(
    { username, email: existing.email, password: PASSWORD },
    { cookie: guestCookie(claimed) },
  );
  expect(r.statusCode).toBe(409);
  expect(r.json().error).toBe('email_taken');

  const row = await pool.query(
    'SELECT password_hash, upgraded_at, guest_token_hash FROM users WHERE id = $1',
    [claimed.json().id],
  );
  expect(row.rows[0].password_hash).toBeNull();
  expect(row.rows[0].upgraded_at).toBeNull();
  expect(row.rows[0].guest_token_hash).not.toBeNull(); // 游客身份还能用
});

// --- 登录 (§3.3 登录, §17.4a) -------------------------------------------------

test('用户名或邮箱都能登录，且会话令牌在登录时轮换', async () => {
  const account = await makeAccount();
  const first = account.cookie;

  const byName = await login({ identifier: account.username, password: PASSWORD });
  expect(byName.statusCode).toBe(200);
  expect(byName.json()).toEqual({
    id: account.id,
    username: account.username,
    state: 'account',
  });
  const second = sessionCookie(byName);
  expect(second).not.toBe(first); // 轮换：不复用旧令牌

  const byEmail = await login({
    identifier: ` ${account.email.toUpperCase()} `,
    password: PASSWORD,
  });
  expect(byEmail.statusCode).toBe(200);
  expect(sessionCookie(byEmail)).not.toBe(second);

  // 三个会话行，令牌哈希互不相同
  const rows = await pool.query(
    'SELECT token_hash FROM sessions WHERE user_id = $1',
    [account.id],
  );
  expect(rows.rowCount).toBe(3);
  expect(new Set(rows.rows.map((r) => r.token_hash as string)).size).toBe(3);
});

test('登录时旧会话 Cookie 被轮换：同一浏览器的旧会话立即失效', async () => {
  const account = await makeAccount();
  const next = await login(
    { identifier: account.username, password: PASSWORD },
    { cookie: account.cookie },
  );
  expect(next.statusCode).toBe(200);

  expect((await identity({ cookie: account.cookie })).json().state).toBe(
    'anonymous',
  );
  expect((await identity({ cookie: sessionCookie(next) })).json().state).toBe(
    'account',
  );
});

test('登录清除游客 Cookie 的身份用途 (§3.3)', async () => {
  const claimed = await claimGuest(`登录前的游客${rnd()}`);
  const account = await makeAccount();

  const r = await login(
    { identifier: account.username, password: PASSWORD },
    { cookie: guestCookie(claimed) },
  );
  expect(r.statusCode).toBe(200);
  const cleared = r.cookies.find((c) => c.name === GUEST_COOKIE);
  expect(cleared?.value).toBe('');

  // 别人的游客身份没有被动过（只清浏览器上的 Cookie，不改数据库）
  const row = await pool.query(
    'SELECT guest_token_hash FROM users WHERE id = $1',
    [claimed.json().id],
  );
  expect(row.rows[0].guest_token_hash).not.toBeNull();
});

test('登录失败不区分“用户不存在”与“密码错误”：状态码与响应体逐字节相同 (§17.4c)', async () => {
  const account = await makeAccount();

  const wrongPassword = await login({
    identifier: account.username,
    password: 'definitely not the password',
  });
  const unknownUser = await login({
    identifier: `从来没有过的人${rnd()}`,
    password: PASSWORD,
  });

  expect(wrongPassword.statusCode).toBe(401);
  expect(unknownUser.statusCode).toBe(wrongPassword.statusCode);
  expect(JSON.stringify(unknownUser.json())).toBe(
    JSON.stringify(wrongPassword.json()),
  );
  // 逐字节：原始响应体也必须完全一致
  expect(
    Buffer.from(unknownUser.payload, 'utf8').equals(
      Buffer.from(wrongPassword.payload, 'utf8'),
    ),
  ).toBe(true);
  expect(unknownUser.headers['set-cookie']).toBeUndefined();
  expect(wrongPassword.headers['set-cookie']).toBeUndefined();

  // 游客行没有密码，也必须落在同一个响应上，而不是“这个名字是游客”。
  const guest = await claimGuest(`没有密码的游客${rnd()}`);
  const guestLogin = await login({
    identifier: guest.json().username,
    password: PASSWORD,
  });
  expect(guestLogin.statusCode).toBe(401);
  expect(
    Buffer.from(guestLogin.payload, 'utf8').equals(
      Buffer.from(wrongPassword.payload, 'utf8'),
    ),
  ).toBe(true);
});

// --- 登录限速：账号 + IP 双维度 (§3.3, §17.4c) --------------------------------

test('账号维度限速：同一账号连续失败，即使换 IP，第 6 次也 429', async () => {
  const limited = buildApp(config, pool, {
    authIpRateLimit: 10_000,
    loginFailureLimit: 5,
  });
  await limited.ready();
  try {
    const account = await makeAccount();
    for (let i = 1; i <= 5; i += 1) {
      const r = await login(
        { identifier: account.username, password: 'wrong' },
        { app: limited, ip: `10.1.0.${i}` },
      );
      expect(r.statusCode).toBe(401);
    }
    // 第 6 次来自第 6 个 IP：IP 维度还是干净的，被挡住的只能是账号维度。
    const sixth = await login(
      { identifier: account.username, password: PASSWORD },
      { app: limited, ip: '10.1.0.6' },
    );
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error).toBe('rate_limited');

    // 别的账号从同一个新 IP 仍能正常登录
    const other = await makeAccount();
    const ok = await login(
      { identifier: other.username, password: PASSWORD },
      { app: limited, ip: '10.1.0.6' },
    );
    expect(ok.statusCode).toBe(200);
  } finally {
    await limited.close();
  }
});

test('IP 维度限速：同一 IP 撞不同账号，第 6 次 429', async () => {
  const limited = buildApp(config, pool, {
    authIpRateLimit: 10_000,
    loginFailureLimit: 5,
  });
  await limited.ready();
  try {
    for (let i = 1; i <= 5; i += 1) {
      const r = await login(
        { identifier: `撞库目标${rnd()}`, password: 'wrong' },
        { app: limited, ip: '10.2.0.1' },
      );
      expect(r.statusCode).toBe(401);
    }
    // 第 6 次换一个全新账号且密码正确：账号维度是干净的，挡住的只能是 IP。
    const account = await makeAccount();
    const sixth = await login(
      { identifier: account.username, password: PASSWORD },
      { app: limited, ip: '10.2.0.1' },
    );
    expect(sixth.statusCode).toBe(429);

    // 换一个 IP，同一账号照常登录
    const ok = await login(
      { identifier: account.username, password: PASSWORD },
      { app: limited, ip: '10.2.0.2' },
    );
    expect(ok.statusCode).toBe(200);
  } finally {
    await limited.close();
  }
});

test('两个维度的计数互不串台：用户名长得像 IP 也不会共用配额', async () => {
  const limited = buildApp(config, pool, {
    authIpRateLimit: 10_000,
    loginFailureLimit: 5,
  });
  await limited.ready();
  try {
    // 用户名逐字节等于攻击者用的那个地址字面量（用户名可以是任意字符串）。
    const username = `fd00::${rnd(4)}:${rnd(4)}:${rnd(4)}`;
    const email = `lookalike-${rnd()}@example.com`;
    const created = await register({ username, email, password: PASSWORD });
    expect(created.statusCode).toBe(200);

    // 从该地址打满 IP 维度的失败额度（目标账号都是别人）。
    for (let i = 0; i < 5; i += 1) {
      await login(
        { identifier: `随便撞${rnd()}`, password: 'wrong' },
        { app: limited, ip: username },
      );
    }

    // 同名账号从别的 IP 登录，不该被那个 IP 的计数波及。
    const ok = await login(
      { identifier: username, password: PASSWORD },
      { app: limited, ip: '10.6.0.9' },
    );
    expect(ok.statusCode).toBe(200);
  } finally {
    await limited.close();
  }
});

test('登录成功清空该账号的失败计数', async () => {
  const limited = buildApp(config, pool, {
    authIpRateLimit: 10_000,
    loginFailureLimit: 5,
  });
  await limited.ready();
  try {
    const account = await makeAccount();
    for (let i = 0; i < 4; i += 1) {
      await login(
        { identifier: account.username, password: 'wrong' },
        { app: limited, ip: `10.3.0.${i}` },
      );
    }
    const ok = await login(
      { identifier: account.username, password: PASSWORD },
      { app: limited, ip: '10.3.0.9' },
    );
    expect(ok.statusCode).toBe(200);

    // 计数已清零，还能再失败 5 次而不被挡
    for (let i = 0; i < 5; i += 1) {
      const r = await login(
        { identifier: account.username, password: 'wrong' },
        { app: limited, ip: `10.3.1.${i}` },
      );
      expect(r.statusCode).toBe(401);
    }
  } finally {
    await limited.close();
  }
});

test('注册接口按 IP 限速 (§3.3)', async () => {
  const limited = buildApp(config, pool, { authIpRateLimit: 2 });
  await limited.ready();
  try {
    const call = { app: limited, ip: '10.4.0.1' };
    // 被拒的请求同样计数：限速要挡住批量试探，不只是成功的注册。
    expect((await register({ username: '', email: 'x' }, call)).statusCode).toBe(400);
    expect((await register({ username: '', email: 'x' }, call)).statusCode).toBe(400);
    const blocked = await register(
      { username: `本该成功${rnd()}`, email: `r-${rnd()}@example.com`, password: PASSWORD },
      call,
    );
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe('rate_limited');
  } finally {
    await limited.close();
  }
});

// --- 登出 (§3.3 登出) ---------------------------------------------------------

test('登出撤销当前会话，不影响其他设备的会话', async () => {
  const account = await makeAccount();
  const otherDevice = await login({
    identifier: account.username,
    password: PASSWORD,
  });
  const otherCookie = sessionCookie(otherDevice);

  const out = await logout({ cookie: account.cookie });
  expect(out.statusCode).toBe(200);
  expect(out.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe('');

  expect((await identity({ cookie: account.cookie })).json().state).toBe(
    'anonymous',
  );
  expect((await identity({ cookie: otherCookie })).json().state).toBe('account');

  const rows = await pool.query(
    'SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NOT NULL',
    [account.id],
  );
  expect(rows.rows[0].n).toBe(1);
});

test('没有会话时登出 401', async () => {
  expect((await logout()).statusCode).toBe(401);
  const guest = await claimGuest(`游客登出${rnd()}`);
  const asGuest = await logout({ cookie: guestCookie(guest) });
  expect(asGuest.statusCode).toBe(401);
});

// --- 找回密码 (§3.3 找回密码) -------------------------------------------------

test('忘记密码：邮箱存在与否响应逐字节相同，不泄露账号是否存在', async () => {
  const account = await makeAccount();
  const known = await forgot({ email: account.email });
  const unknown = await forgot({ email: `nobody-${rnd()}@example.com` });

  expect(known.statusCode).toBe(202);
  expect(unknown.statusCode).toBe(known.statusCode);
  expect(
    Buffer.from(unknown.payload, 'utf8').equals(
      Buffer.from(known.payload, 'utf8'),
    ),
  ).toBe(true);

  // 只有存在的账号真的产生了令牌
  const rows = await pool.query(
    'SELECT count(*)::int AS n FROM password_resets WHERE user_id = $1',
    [account.id],
  );
  expect(rows.rows[0].n).toBe(1);
});

test('重置令牌写入 outbox 日志文件，数据库只存哈希、有效期 30 分钟', async () => {
  const account = await makeAccount();
  await forgot({ email: account.email });

  const entry = outboxEntries()
    .reverse()
    .find((each) => each.to === normalizeEmail(account.email));
  expect(entry).toBeDefined();
  expect(entry?.type).toBe('password_reset');
  const token = entry?.token as string;
  expect(token.length).toBeGreaterThanOrEqual(43);

  const row = await pool.query(
    `SELECT token_hash, used_at,
            extract(epoch FROM (expires_at - created_at))::int AS ttl
       FROM password_resets WHERE user_id = $1`,
    [account.id],
  );
  expect(row.rows[0].token_hash).toBe(
    crypto.createHash('sha256').update(token).digest('hex'),
  );
  expect(row.rows[0].token_hash).not.toContain(token);
  expect(row.rows[0].used_at).toBeNull();
  expect(row.rows[0].ttl).toBe(30 * 60); // 30 分钟 (§3.1「建议 30 分钟」)

  const leak = await pool.query(
    'SELECT count(*)::int AS n FROM password_resets WHERE token_hash = $1',
    [token],
  );
  expect(leak.rows[0].n).toBe(0);
});

test('游客没有找回路径：没有邮箱的行不会产生任何重置令牌', async () => {
  const before = await pool.query('SELECT count(*)::int AS n FROM password_resets');
  const guest = await claimGuest(`无法找回${rnd()}`);
  const r = await forgot({ email: `guest-${rnd()}@example.com` });
  expect(r.statusCode).toBe(202);

  const rows = await pool.query(
    'SELECT count(*)::int AS n FROM password_resets WHERE user_id = $1',
    [guest.json().id],
  );
  expect(rows.rows[0].n).toBe(0);
  const after = await pool.query('SELECT count(*)::int AS n FROM password_resets');
  expect(after.rows[0].n).toBe(before.rows[0].n);
});

test('忘记密码按 IP 限速 (§3.3)', async () => {
  const limited = buildApp(config, pool, { authIpRateLimit: 2 });
  await limited.ready();
  try {
    const call = { app: limited, ip: '10.5.0.1' };
    expect((await forgot({ email: 'a@example.com' }, call)).statusCode).toBe(202);
    expect((await forgot({ email: 'a@example.com' }, call)).statusCode).toBe(202);
    const blocked = await forgot({ email: 'a@example.com' }, call);
    expect(blocked.statusCode).toBe(429);
  } finally {
    await limited.close();
  }
});

test('重置密码：新密码可登录，旧密码失效，并撤销该用户全部会话', async () => {
  const account = await makeAccount();
  const otherDevice = await login({
    identifier: account.username,
    password: PASSWORD,
  });
  await forgot({ email: account.email });

  const newPassword = 'a brand new secret';
  const r = await resetPassword({
    token: resetTokenFor(account.email),
    password: newPassword,
  });
  expect(r.statusCode).toBe(200);

  // 全部会话被撤销（改密后的标准做法）
  expect((await identity({ cookie: account.cookie })).json().state).toBe(
    'anonymous',
  );
  expect((await identity({ cookie: sessionCookie(otherDevice) })).json().state).toBe(
    'anonymous',
  );
  const live = await pool.query(
    'SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
    [account.id],
  );
  expect(live.rows[0].n).toBe(0);

  expect(
    (await login({ identifier: account.username, password: PASSWORD })).statusCode,
  ).toBe(401);
  expect(
    (await login({ identifier: account.username, password: newPassword })).statusCode,
  ).toBe(200);
});

test('重置令牌一次性：第二次使用被拒，密码不再改变', async () => {
  const account = await makeAccount();
  await forgot({ email: account.email });
  const token = resetTokenFor(account.email);

  expect((await resetPassword({ token, password: 'first new secret' })).statusCode).toBe(
    200,
  );

  const replay = await resetPassword({ token, password: 'second new secret' });
  expect(replay.statusCode).toBe(400);
  expect(replay.json().error).toBe('invalid_token');

  expect(
    (await login({ identifier: account.username, password: 'first new secret' }))
      .statusCode,
  ).toBe(200);
  expect(
    (await login({ identifier: account.username, password: 'second new secret' }))
      .statusCode,
  ).toBe(401);
});

test('重置令牌 30 分钟后过期：过期令牌被拒', async () => {
  const account = await makeAccount();
  await forgot({ email: account.email });
  const token = resetTokenFor(account.email);

  // 把有效期推到刚好过去一秒，模拟 30 分钟之后。
  await pool.query(
    "UPDATE password_resets SET expires_at = now() - interval '1 second' WHERE user_id = $1",
    [account.id],
  );

  const expired = await resetPassword({ token, password: 'too late for this' });
  expect(expired.statusCode).toBe(400);
  expect(expired.json().error).toBe('invalid_token');
  expect(
    (await login({ identifier: account.username, password: PASSWORD })).statusCode,
  ).toBe(200);
});

test('未知重置令牌与短密码被拒', async () => {
  const unknown = await resetPassword({
    token: crypto.randomBytes(32).toString('base64url'),
    password: 'long enough password',
  });
  expect(unknown.statusCode).toBe(400);
  expect(unknown.json().error).toBe('invalid_token');

  const account = await makeAccount();
  await forgot({ email: account.email });
  const short = await resetPassword({
    token: resetTokenFor(account.email),
    password: '1234567',
  });
  expect(short.statusCode).toBe(400);
  expect(short.json().error).toBe('password_too_short');

  // 短密码被拒时令牌没有被消耗
  const row = await pool.query(
    'SELECT used_at FROM password_resets WHERE user_id = $1',
    [account.id],
  );
  expect(row.rows[0].used_at).toBeNull();
});

// --- GET /api/identity 三态 (§16.3) -------------------------------------------

test('GET /api/identity 返回三态：未登录 / 游客 / 账号', async () => {
  const anonymous = await identity();
  expect(anonymous.statusCode).toBe(200);
  expect(anonymous.json()).toEqual({ state: 'anonymous' });

  const guestName = `三态游客${rnd()}`;
  const guest = await claimGuest(guestName);
  expect((await identity({ cookie: guestCookie(guest) })).json()).toEqual({
    state: 'guest',
    username: guestName,
  });

  const account = await makeAccount();
  expect((await identity({ cookie: account.cookie })).json()).toEqual({
    state: 'account',
    username: account.username,
  });
});

test('GET /api/identity 从不返回邮箱 (§3.3「邮箱不在任何公开接口返回」)', async () => {
  const account = await makeAccount();
  const r = await identity({ cookie: account.cookie });
  expect(r.payload).not.toContain(account.email);
  expect(r.payload).not.toContain(normalizeEmail(account.email));
  expect(Object.keys(r.json())).toEqual(['state', 'username']);
});

test('会话 Cookie 优先于游客 Cookie：登录后浏览器显示账号名', async () => {
  const guest = await claimGuest(`被覆盖的游客${rnd()}`);
  const account = await makeAccount();

  const both = `${guestCookie(guest)}; ${account.cookie}`;
  expect((await identity({ cookie: both })).json()).toEqual({
    state: 'account',
    username: account.username,
  });
});

test('会话过期后 Cookie 不再是身份，并回落到游客 Cookie', async () => {
  const guestName = `回落游客${rnd()}`;
  const guest = await claimGuest(guestName);
  const account = await makeAccount();
  await pool.query(
    "UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1",
    [account.id],
  );

  expect((await identity({ cookie: account.cookie })).json().state).toBe(
    'anonymous',
  );
  const both = `${guestCookie(guest)}; ${account.cookie}`;
  expect((await identity({ cookie: both })).json()).toEqual({
    state: 'guest',
    username: guestName,
  });
});

test('封禁账号的会话被拒 403 (§17.31)', async () => {
  const account = await makeAccount();
  await pool.query('UPDATE users SET banned_at = now() WHERE id = $1', [
    account.id,
  ]);
  const r = await identity({ cookie: account.cookie });
  expect(r.statusCode).toBe(403);
  expect(r.json().error).toBe('banned');
});
