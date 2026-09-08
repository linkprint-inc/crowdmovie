// T2.1 游客认领 POST /api/identity/guest —《技术》§3.1 归一化、§3.2 识别流程、
// §3.3 Cookie 属性与 IP 频率限制。
//
// Integration tests against the same real PostgreSQL database schema.test.ts
// uses. That file drops and recreates the schema in its own beforeAll, so
// vitest runs test files sequentially (see vitest.config.ts) and the two never
// overlap. Usernames are永久 unique by design and this suite never truncates
// the table, so every name carries a per-run random suffix.
import crypto from 'node:crypto';

import pg from 'pg';

import { runMigrations } from '../src/db/migrate';
import { glen } from '../src/lib/grapheme';
import {
  hasForbiddenCharacters,
  normalizeUsername,
  USERNAME_MAX_GRAPHEMES,
} from '../src/lib/username';
import { GUEST_COOKIE } from '../src/plugins/auth';
import { buildApp } from '../src/web/app';
import { ensureDatabase, TEST_URL } from './database';

const config = {
  SERVICE_ROLE: 'web',
  DATABASE_URL: TEST_URL,
  SESSION_SECRET: 'x'.repeat(32),
  PORT: 3100,
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
} as const;

let pool: pg.Pool;
let app: ReturnType<typeof buildApp>;

// Random, not sequential: usernames are never released, so a name that is a
// pure function of the test would 409 on the second run of the suite.
const rnd = (n = 8): string => crypto.randomBytes(8).toString('hex').slice(0, n);

function claim(
  username: unknown,
  cookie?: string,
  instance: ReturnType<typeof buildApp> = app,
) {
  return instance.inject({
    method: 'POST',
    url: '/api/identity/guest',
    payload: { username },
    headers: cookie === undefined ? {} : { cookie },
  });
}

const setCookieHeader = (r: { headers: Record<string, unknown> }): string => {
  const raw = r.headers['set-cookie'];
  return Array.isArray(raw) ? raw.join('; ') : String(raw);
};

// The cookie the browser will send back: `<userId>.<token>`.
const cookieValue = (r: {
  cookies: { name: string; value: string }[];
}): string => {
  const found = r.cookies.find((each) => each.name === GUEST_COOKIE);
  if (found === undefined) throw new Error('guest cookie missing from response');
  return found.value;
};

beforeAll(async () => {
  await ensureDatabase();
  await runMigrations(TEST_URL);
  pool = new pg.Pool({ connectionString: TEST_URL });
  // Rate limiting has its own test below; a shared instance would otherwise
  // throttle this file as it grows.
  app = buildApp(config, pool, { guestClaimRateLimit: 1000 });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

// --- 归一化 (§3.1) ------------------------------------------------------------

test('normalizeUsername：`Alice` 与 `alice　`(U+3000) 产生同一个 username_key', () => {
  expect(normalizeUsername('Alice').key).toBe('alice');
  expect(normalizeUsername('alice　').key).toBe('alice');
  expect(normalizeUsername('Alice').key).toBe(normalizeUsername('alice　').key);
});

test('normalizeUsername：display 保留输入的大小写与字形，只去首尾空白', () => {
  expect(normalizeUsername('　Alice ').display).toBe('Alice');
  // 全角输入按 NFKC 折叠进 key，展示名保留用户写的全角形式。
  expect(normalizeUsername('Ａｌｉｃｅ').display).toBe('Ａｌｉｃｅ');
  expect(normalizeUsername('Ａｌｉｃｅ').key).toBe('alice');
});

// --- 认领流程 (§3.2) ----------------------------------------------------------

test('可认领未用名：200 + Set-Cookie(HttpOnly/Secure/SameSite=Lax/Path=/)', async () => {
  const username = `夜自习逃兵${rnd()}`;
  const r = await claim(username);

  expect(r.statusCode).toBe(200);
  const setCookie = setCookieHeader(r);
  expect(setCookie).toMatch(/HttpOnly/);
  expect(setCookie).toMatch(/Secure/);
  expect(setCookie).toMatch(/SameSite=Lax/);
  expect(setCookie).toMatch(/Path=\//);
  expect(setCookie).toMatch(/Max-Age=315360000/); // 游客 Cookie 十年 (§3.3)
  expect(r.json().username).toBe(username);
});

test('同名二次认领 409，且不下发 Cookie', async () => {
  const username = `重名${rnd()}`;
  expect((await claim(username)).statusCode).toBe(200);

  const second = await claim(username);
  expect(second.statusCode).toBe(409);
  expect(second.json().error).toBe('username_taken');
  expect(second.headers['set-cookie']).toBeUndefined();
});

test('AI Director 是后端保留身份，尚未建系统用户行也不能被游客抢注', async () => {
  const exact = await claim('AI Director');
  expect(exact.statusCode).toBe(409);
  expect(exact.json().error).toBe('username_taken');

  const folded = await claim('ＡＩ　ＤＩＲＥＣＴＯＲ');
  expect(folded.statusCode).toBe(409);
  expect(folded.json().error).toBe('username_taken');
});

test('归一化冲突：`Alice` 被占用后 `alice　`(U+3000) 认领 409', async () => {
  const s = rnd();
  expect((await claim(`Alice${s}`)).statusCode).toBe(200);

  const collision = await claim(`alice${s}　`);
  expect(collision.statusCode).toBe(409);
  expect(collision.json().error).toBe('username_taken');
});

test('超 24 字 400；恰好 24 字通过', async () => {
  const tooLong = await claim('字'.repeat(USERNAME_MAX_GRAPHEMES + 1));
  expect(tooLong.statusCode).toBe(400);
  expect(tooLong.json().error).toBe('username_too_long');

  const exact = `${'字'.repeat(USERNAME_MAX_GRAPHEMES - 8)}${rnd(8)}`;
  expect((await claim(exact)).statusCode).toBe(200);
});

test('长度按 grapheme cluster 计数：24 个家庭 emoji 通过', async () => {
  // 每个 👨‍👩‍👧‍👦 是 11 个 UTF-16 码元、1 个用户可见字符；用 .length 判长会误拒。
  const username = `${'👨‍👩‍👧‍👦'.repeat(USERNAME_MAX_GRAPHEMES - 8)}${rnd(8)}`;
  expect(username.length).toBeGreaterThan(USERNAME_MAX_GRAPHEMES);
  // key 里的 ZWJ 会被剥离，但计数走 display，emoji 仍是 1 个字符。
  expect(glen(username)).toBe(USERNAME_MAX_GRAPHEMES);
  expect((await claim(username)).statusCode).toBe(200);
});

test('空 / 纯空白用户名 400', async () => {
  for (const bad of ['', '   ', '　　']) {
    const r = await claim(bad);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('username_required');
  }
});

test('username 缺失或不是字符串 400', async () => {
  for (const bad of [undefined, 42, { nested: 'x' }]) {
    expect((await claim(bad)).statusCode).toBe(400);
  }
});

// --- 字符策略：用户名是正片署名，不能不可见、也不能靠隐形填充冒名 ------------

test('normalizeUsername：不可见字符折进同一个 key，`admin` 与 `admin\u200B` 不是两个人', () => {
  expect(normalizeUsername('admin').key).toBe('admin');
  expect(normalizeUsername('admin\u200B').key).toBe('admin'); // ZWSP 尾填充
  expect(normalizeUsername('ad\u200Dmin').key).toBe('admin'); // ZWJ 夹在中间
  expect(normalizeUsername('\uFEFFadmin\u202E').key).toBe('admin'); // BOM + RLO
  expect(normalizeUsername('admin\uFE0F').key).toBe('admin'); // 变体选择符
  expect(normalizeUsername('ad  min').key).toBe('ad min'); // HTML 里连续空格只渲染一个
});

test('normalizeUsername：全不可见字符折叠后为空 key', () => {
  expect(normalizeUsername('\u200B\u200C\u200D\uFEFF').key).toBe('');
});

test('normalizeUsername：折叠只作用于 key，display 保留用户原样输入', () => {
  const raw = 'a\u200Bb';
  expect(normalizeUsername(raw).display).toBe(raw);
  expect(normalizeUsername(raw).key).toBe('ab');
});

test('hasForbiddenCharacters：控制字符与行分隔符被识别，合法名不误伤', () => {
  for (const bad of ['夜自习\n逃兵', 'a\tb', 'a\u2028b', 'a\u2029b', '\u0000x']) {
    expect(hasForbiddenCharacters(bad)).toBe(true);
  }
  for (const good of ['夜自习逃兵', '👨‍👩‍👧‍👦', 'Alice', 'ad min']) {
    expect(hasForbiddenCharacters(good)).toBe(false);
  }
});

test('隐形填充不能造出同形用户名：占用后再带 ZWSP / ZWJ 认领 409', async () => {
  const name = `admin${rnd()}`;
  expect((await claim(name)).statusCode).toBe(200);

  const padded = await claim(`${name}\u200B`);
  expect(padded.statusCode).toBe(409);
  expect(padded.json().error).toBe('username_taken');

  const inner = await claim(`${name.slice(0, 3)}\u200D${name.slice(3)}`);
  expect(inner.statusCode).toBe(409);
  expect(inner.json().error).toBe('username_taken');
});

test('纯不可见字符用户名 400（折叠后为空）', async () => {
  for (const bad of ['\u200B\u200C', '\uFEFF', '\u200D\u200D\u200D']) {
    const r = await claim(bad);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('username_required');
  }
});

test('含控制字符或行分隔符的用户名 400', async () => {
  for (const bad of ['夜自习\n逃兵', '夜自习\r逃兵', 'a\tb', '名字\u2028', '名字\u2029']) {
    const r = await claim(bad);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('username_invalid_characters');
  }
});

test('合法 CJK / emoji 名不受折叠影响，username_display 与输入逐字节一致', async () => {
  for (const username of [
    `夜自习逃兵${rnd()}`,
    `👨‍👩‍👧‍👦剪辑师${rnd()}`,
  ]) {
    const r = await claim(username);
    expect(r.statusCode).toBe(200);
    expect(r.json().username).toBe(username);

    const row = await pool.query(
      'SELECT username_display FROM users WHERE id = $1',
      [r.json().id],
    );
    const stored = row.rows[0].username_display as string;
    expect(stored).toBe(username);
    expect(Buffer.from(stored, 'utf8').equals(Buffer.from(username, 'utf8'))).toBe(
      true,
    );
  }
});

// --- Cookie 与令牌 (§3.2 步骤 5–7, §3.3) ---------------------------------------

test('数据库只保存令牌哈希，明文令牌从不落库', async () => {
  const r = await claim(`只存哈希${rnd()}`);
  expect(r.statusCode).toBe(200);

  const raw = cookieValue(r);
  const userId = raw.slice(0, raw.indexOf('.'));
  const token = raw.slice(raw.indexOf('.') + 1);
  expect(userId).toBe(r.json().id);
  expect(token.length).toBeGreaterThanOrEqual(43); // 32 随机字节的 base64url

  const row = await pool.query(
    'SELECT guest_token_hash, password_hash FROM users WHERE id = $1',
    [userId],
  );
  const stored = row.rows[0].guest_token_hash as string;
  expect(stored).toBe(crypto.createHash('sha256').update(token).digest('hex'));
  expect(stored).not.toContain(token);
  expect(row.rows[0].password_hash).toBeNull(); // 游客身份 (§3.1)

  // 明文令牌在整张表的任何文本列里都不存在。
  const leak = await pool.query(
    'SELECT count(*)::int AS n FROM users WHERE guest_token_hash = $1 OR username_display = $1 OR username_key = $1',
    [token],
  );
  expect(leak.rows[0].n).toBe(0);
});

test('伪造 / 失效 Cookie 被忽略，用户可以认领一个新名 (§3.2 步骤 7)', async () => {
  const r = await claim(`原主${rnd()}`);
  const userId = cookieValue(r).split('.')[0];

  for (const forged of [
    `${GUEST_COOKIE}=${userId}.wrong-token`,
    `${GUEST_COOKIE}=not-a-uuid.whatever`,
    `${GUEST_COOKIE}=00000000-0000-0000-0000-000000000000.x`,
    `${GUEST_COOKIE}=garbage`,
  ]) {
    const next = await claim(`新名${rnd()}`, forged);
    expect(next.statusCode).toBe(200);
  }
});

test('已持有有效身份时再次认领 409（双击不会丢掉原用户名）', async () => {
  const first = await claim(`已有身份${rnd()}`);
  const cookie = `${GUEST_COOKIE}=${cookieValue(first)}`;

  const again = await claim(`另一个名${rnd()}`, cookie);
  expect(again.statusCode).toBe(409);
  expect(again.json().error).toBe('already_identified');
});

test('封禁用户的 Cookie 被拒 403 (§17.31)', async () => {
  const r = await claim(`待封禁${rnd()}`);
  const raw = cookieValue(r);
  await pool.query('UPDATE users SET banned_at = now() WHERE id = $1', [
    raw.split('.')[0],
  ]);

  const banned = await claim(`封禁后改名${rnd()}`, `${GUEST_COOKIE}=${raw}`);
  expect(banned.statusCode).toBe(403);
  expect(banned.json().error).toBe('banned');
});

// --- 竞态与限速 ---------------------------------------------------------------

test('并发同名认领只有一个成功，另一个 409（唯一索引兜底）', async () => {
  const username = `并发${rnd()}`;
  const results = await Promise.all([claim(username), claim(username)]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);

  const rows = await pool.query(
    'SELECT count(*)::int AS n FROM users WHERE username_key = $1',
    [normalizeUsername(username).key],
  );
  expect(rows.rows[0].n).toBe(1);
});

test('同一 IP 超过频率限制返回 429 (§3.3)', async () => {
  const limited = buildApp(config, pool, { guestClaimRateLimit: 2 });
  await limited.ready();
  try {
    // 被拒的请求同样计数：限速要挡住批量试探，不只是成功的认领。
    expect((await claim('', undefined, limited)).statusCode).toBe(400);
    expect((await claim('', undefined, limited)).statusCode).toBe(400);

    const blocked = await claim(`本该成功${rnd()}`, undefined, limited);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe('rate_limited');
  } finally {
    await limited.close();
  }
});

// --- 显式 bidi 控制符 ---------------------------------------------------------
// 这一组一律用 \uXXXX 转义而不是字面量：这些字符在编辑器、grep 和 diff 里都不可见，
// 字面量会让维护者读不出这个用例到底在测什么。

// U+202A LRE / U+202B RLE / U+202C PDF / U+202D LRO / U+202E RLO
// U+2066 LRI / U+2067 RLI / U+2068 FSI / U+2069 PDI
const BIDI_CONTROLS = [
  '\u202A',
  '\u202B',
  '\u202C',
  '\u202D',
  '\u202E',
  '\u2066',
  '\u2067',
  '\u2068',
  '\u2069',
];

test('hasForbiddenCharacters：九个显式 bidi 控制符全部被识别', () => {
  for (const control of BIDI_CONTROLS) {
    expect(hasForbiddenCharacters(`名字${control}`)).toBe(true);
  }
});

test('hasForbiddenCharacters：自然 RTL 文字不含控制符，不误伤', () => {
  // 阿拉伯语「导演」、希伯来语「导演」：纯字母，排版交给 Unicode bidi 算法。
  for (const good of ['مخرج', 'במאי', 'مخرج الأفلام']) {
    expect(hasForbiddenCharacters(good)).toBe(false);
  }
});

test('含显式 bidi 控制符的用户名 400（会翻转署名之后的所有文本）', async () => {
  // key 里 bidi 控制符本来就会被剥离，所以它抢不到名字；这里要挡的是它写进
  // username_display 之后，对名人堂列表和正片署名的渲染污染。
  for (const control of BIDI_CONTROLS) {
    const r = await claim(`${control}逃兵${rnd()}`);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('username_invalid_characters');
  }
  // 经典的 RLO 冒名：末尾追加 RLO，渲染时把后面的内容整体翻转。
  const rlo = await claim(`admin${rnd()}\u202E`);
  expect(rlo.statusCode).toBe(400);
  expect(rlo.json().error).toBe('username_invalid_characters');
});

test('自然 RTL 用户名可正常认领 200，且 display 逐字节保留', async () => {
  for (const base of ['مخرج', 'במאי']) {
    const username = `${base}${rnd()}`;
    const r = await claim(username);
    expect(r.statusCode).toBe(200);
    expect(r.json().username).toBe(username);

    const row = await pool.query(
      'SELECT username_display FROM users WHERE id = $1',
      [r.json().id],
    );
    const stored = row.rows[0].username_display as string;
    expect(stored).toBe(username);
    expect(
      Buffer.from(stored, 'utf8').equals(Buffer.from(username, 'utf8')),
    ).toBe(true);
  }
});
