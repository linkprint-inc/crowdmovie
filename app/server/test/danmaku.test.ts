// 弹幕路由 —《技术》§14 弹幕系统、§16.3 接口清单，验收 §17 的 24/25/26/31/32。
//
// Lengths are checked with CJK text and with a ZWJ-family emoji, because §14.3
// counts what the reader sees. Invisible characters are written as `\u{...}`
// escapes (see source-hygiene.test.ts) — which also matters here because one of
// the rules under test is「拒绝……控制字符」.
import pg from 'pg';

import { runMigrations } from '../src/db/migrate';
import { buildApp } from '../src/web/app';
import {
  DANMAKU_BLOCKLIST_KEY,
  DANMAKU_ENABLED_KEY,
  DANMAKU_MAX_GRAPHEMES,
  DANMAKU_MAX_PER_SCENE,
  RECENT_DANMAKU_CAP,
  SCENE_DANMAKU_CAP,
} from '../src/web/routes/danmaku';
import { ensureDatabase, resetStory, testConfig, TEST_URL } from './helpers';
import { createScene, insertDanmaku } from './scene-fixture';
import { INLAND_EMPIRE_MOVIE_ID } from '../src/movies/catalog';

/** One grapheme cluster; 5 code points; 8 UTF-16 code units. */
const FAMILY = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}';

let pool: pg.Pool;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  await ensureDatabase();
  await runMigrations(TEST_URL);
  pool = new pg.Pool({ connectionString: TEST_URL });
  app = buildApp(testConfig, pool, {
    guestClaimRateLimit: 10_000,
    danmakuIpRateLimit: 10_000,
    // 0 so a `site_settings` flip is visible on the very next request.
    danmakuSettingsTtlMs: 0,
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

beforeEach(async () => {
  await resetStory(pool);
  await pool.query('DELETE FROM site_settings WHERE key = ANY($1::text[])', [
    [DANMAKU_ENABLED_KEY, DANMAKU_BLOCKLIST_KEY],
  ]);
});

async function claimGuest(): Promise<{ cookie: string; userId: string }> {
  const username = `dm_${Math.random().toString(36).slice(2, 12)}`;
  const response = await app.inject({
    method: 'POST',
    url: '/api/identity/guest',
    payload: { username },
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.find((each) => each.name === 'cm_guest');
  if (cookie === undefined) throw new Error('no guest cookie');
  const found = await pool.query<{ id: string }>(
    'SELECT id FROM users WHERE username_display = $1',
    [username],
  );
  return { cookie: `cm_guest=${cookie.value}`, userId: found.rows[0].id };
}

function recentBody(response: { json: <T>() => T }): Array<{
  content: string;
  createdAt: string;
}> {
  return response.json<{ danmaku: Array<{ content: string; createdAt: string }> }>()
    .danmaku;
}

function send(cookie: string | undefined, body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/danmaku',
    headers: cookie === undefined ? {} : { cookie },
    payload: body,
  });
}

function sceneDanmaku(sceneIndex: number) {
  return app.inject({
    method: 'GET',
    url: `/api/movie/scenes/${sceneIndex}/danmaku`,
  });
}

function recent() {
  return app.inject({ method: 'GET', url: '/api/danmaku/recent' });
}

/** Push this user's previous comment far enough into the past that the 3-second
 *  interval rule is not the thing under test. */
async function agePreviousDanmaku(userId: string): Promise<void> {
  await pool.query(
    "UPDATE danmaku SET created_at = now() - interval '1 hour' WHERE user_id = $1",
    [userId],
  );
}

async function setSetting(key: string, value: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO site_settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

// --- 身份与封禁 (§16.3, §17.24, §17.31) ---------------------------------------

test('未认领身份不能发弹幕（401）', async () => {
  const scene = await createScene(pool);
  const response = await send(undefined, {
    sceneIndex: scene.sceneIndex,
    offsetMs: 0,
    content: '匿名弹幕',
  });
  expect(response.statusCode).toBe(401);
  expect(response.json<{ error: string }>().error).toBe('identity_required');
});

test('被封禁用户不能发弹幕（403）', async () => {
  const scene = await createScene(pool);
  const { cookie, userId } = await claimGuest();
  await pool.query('UPDATE users SET banned_at = now() WHERE id = $1', [userId]);

  const response = await send(cookie, {
    sceneIndex: scene.sceneIndex,
    offsetMs: 0,
    content: '封禁后的弹幕',
  });
  expect(response.statusCode).toBe(403);
  expect(response.json<{ error: string }>().error).toBe('banned');
  const stored = await pool.query('SELECT 1 FROM danmaku');
  expect(stored.rowCount).toBe(0);
});

test('发送成功后按 §14.2 的字段返回并落库', async () => {
  const scene = await createScene(pool, { durationSeconds: 15.083 });
  const { cookie, userId } = await claimGuest();

  const response = await send(cookie, {
    sceneIndex: scene.sceneIndex,
    offsetMs: 4200,
    content: '这一幕真好看',
  });
  expect(response.statusCode).toBe(201);
  const body = response.json<{
    id: string;
    username: string;
    content: string;
    sceneIndex: number;
    offsetMs: number;
    createdAt: string;
  }>();
  expect(body.sceneIndex).toBe(scene.sceneIndex);
  expect(body.offsetMs).toBe(4200);
  expect(body.content).toBe('这一幕真好看');
  expect(body.username).toMatch(/^dm_/);

  const stored = await pool.query<{
    user_id: string;
    scene_index: number;
    offset_ms: number;
    content: string;
    status: string;
  }>('SELECT user_id, scene_index, offset_ms, content, status FROM danmaku');
  expect(stored.rows).toEqual([
    {
      user_id: userId,
      scene_index: scene.sceneIndex,
      offset_ms: 4200,
      content: '这一幕真好看',
      status: 'visible',
    },
  ]);
});

// §17.26「弹幕文本不进入任何模型上下文，也不触发任何按条 AI 调用」. The observable
// consequence of that rule is that sending a comment enqueues no work at all —
// 投稿 by contrast always creates its `submission_score` job (§6.3).
test('发弹幕不产生任何任务或模型留痕（§17.26）', async () => {
  const scene = await createScene(pool);
  const { cookie } = await claimGuest();

  const response = await send(cookie, {
    sceneIndex: scene.sceneIndex,
    offsetMs: 100,
    content: '弹幕不该触发任何 AI 调用',
  });
  expect(response.statusCode).toBe(201);

  const jobs = await pool.query('SELECT 1 FROM workflow_jobs');
  expect(jobs.rowCount).toBe(0);
  // The fixture writes two `ai_runs` rows per scene and nothing else may appear.
  const runs = await pool.query<{ n: string }>('SELECT count(*) AS n FROM ai_runs');
  expect(Number(runs.rows[0].n)).toBe(2);
});

// --- 长度 (§14.3, §17.25) ------------------------------------------------------

test('100 个中文字符通过，101 个被拒', async () => {
  const scene = await createScene(pool);
  const { cookie, userId } = await claimGuest();

  const ok = await send(cookie, {
    sceneIndex: scene.sceneIndex,
    offsetMs: 0,
    content: '弹'.repeat(DANMAKU_MAX_GRAPHEMES),
  });
  expect(ok.statusCode).toBe(201);

  await agePreviousDanmaku(userId);
  const tooLong = await send(cookie, {
    sceneIndex: scene.sceneIndex,
    offsetMs: 0,
    content: '弹'.repeat(DANMAKU_MAX_GRAPHEMES + 1),
  });
  expect(tooLong.statusCode).toBe(400);
  expect(tooLong.json<{ error: string; max: number }>()).toMatchObject({
    error: 'content_too_long',
    max: DANMAKU_MAX_GRAPHEMES,
  });
});

// The family emoji is one grapheme cluster but 8 UTF-16 units, so a `.length`
// check would reject 100 of them at 13 and this test would fail.
test('100 个 ZWJ 家庭 emoji 是 100 个字符，不是 800', async () => {
  const scene = await createScene(pool);
  const { cookie, userId } = await claimGuest();

  const ok = await send(cookie, {
    sceneIndex: scene.sceneIndex,
    offsetMs: 0,
    content: FAMILY.repeat(DANMAKU_MAX_GRAPHEMES),
  });
  expect(ok.statusCode).toBe(201);

  await agePreviousDanmaku(userId);
  const tooLong = await send(cookie, {
    sceneIndex: scene.sceneIndex,
    offsetMs: 0,
    content: FAMILY.repeat(DANMAKU_MAX_GRAPHEMES + 1),
  });
  expect(tooLong.statusCode).toBe(400);
  expect(tooLong.json<{ error: string }>().error).toBe('content_too_long');
});

// --- 内容校验 (§14.3) ----------------------------------------------------------

test('空白、纯链接、控制字符与屏蔽词都被拒', async () => {
  const scene = await createScene(pool);
  const { cookie } = await claimGuest();
  const anchor = { sceneIndex: scene.sceneIndex, offsetMs: 0 };

  const cases: Array<[unknown, string]> = [
    ['   ', 'content_required'],
    ['', 'content_required'],
    ['https://example.com/spam', 'content_link_only'],
    ['www.example.com', 'content_link_only'],
    [`前${String.fromCodePoint(0x200b)}后`, 'content_invalid'], // ZWSP
    [`前${String.fromCodePoint(0x202e)}后`, 'content_invalid'], // RLO
    [`两${String.fromCodePoint(0x000a)}行`, 'content_invalid'], // newline
    ['加微信 12345', 'content_blocked'],
    ['ONLYFANS link in bio', 'content_blocked'], // case-insensitive
  ];

  for (const [content, error] of cases) {
    const response = await send(cookie, { ...anchor, content });
    expect(
      { content, status: response.statusCode, error: response.json<{ error: string }>().error },
    ).toEqual({ content, status: 400, error });
  }
  const stored = await pool.query('SELECT 1 FROM danmaku');
  expect(stored.rowCount).toBe(0);
});

test('带链接但不只有链接的弹幕可以发送', async () => {
  const scene = await createScene(pool);
  const { cookie } = await claimGuest();
  const response = await send(cookie, {
    sceneIndex: scene.sceneIndex,
    offsetMs: 0,
    content: '这段参考了 https://example.com 的分镜',
  });
  expect(response.statusCode).toBe(201);
});

test('屏蔽词表可以通过 site_settings 在线替换（§14.3 可热更新）', async () => {
  const scene = await createScene(pool);
  const { cookie } = await claimGuest();
  await setSetting(DANMAKU_BLOCKLIST_KEY, ['禁用词']);

  const blocked = await send(cookie, {
    sceneIndex: scene.sceneIndex,
    offsetMs: 0,
    content: '这里有禁用词',
  });
  expect(blocked.statusCode).toBe(400);
  expect(blocked.json<{ error: string }>().error).toBe('content_blocked');

  // The override replaces the in-code list, so a default word is now allowed —
  // which is what makes the list editable in both directions without a deploy.
  const allowed = await send(cookie, {
    sceneIndex: scene.sceneIndex,
    offsetMs: 0,
    content: '加微信聊聊分镜',
  });
  expect(allowed.statusCode).toBe(201);
});

// --- 片段锚点 (§14.1, §17.32) --------------------------------------------------

test('offset_ms 超出片段实际时长被拒绝，不静默截断', async () => {
  const scene = await createScene(pool, { durationSeconds: 15.083 });
  const { cookie, userId } = await claimGuest();

  const atEnd = await send(cookie, {
    sceneIndex: scene.sceneIndex,
    offsetMs: 15_083,
    content: '刚好在最后一帧',
  });
  expect(atEnd.statusCode).toBe(201);

  await agePreviousDanmaku(userId);
  const past = await send(cookie, {
    sceneIndex: scene.sceneIndex,
    offsetMs: 15_084,
    content: '超出一毫秒',
  });
  expect(past.statusCode).toBe(400);
  expect(past.json<{ error: string; max: number }>()).toMatchObject({
    error: 'offset_out_of_range',
    max: 15_083,
  });

  // Nothing was clamped into the row.
  const stored = await pool.query<{ offset_ms: number }>(
    'SELECT offset_ms FROM danmaku',
  );
  expect(stored.rows.map((row) => row.offset_ms)).toEqual([15_083]);
});

test('负数与非整数 offset_ms 被拒绝', async () => {
  const scene = await createScene(pool);
  const { cookie } = await claimGuest();
  for (const offsetMs of [-1, 1.5, '100', null]) {
    const response = await send(cookie, {
      sceneIndex: scene.sceneIndex,
      offsetMs,
      content: '时间点不合法',
    });
    expect({ offsetMs, status: response.statusCode }).toEqual({
      offsetMs,
      status: 400,
    });
    expect(response.json<{ error: string }>().error).toBe('offset_invalid');
  }
});

test('不存在的 scene_index 被拒绝（400）', async () => {
  await createScene(pool);
  const { cookie } = await claimGuest();
  const response = await send(cookie, {
    sceneIndex: 9999,
    offsetMs: 0,
    content: '锚在不存在的片段上',
  });
  expect(response.statusCode).toBe(400);
  expect(response.json<{ error: string }>().error).toBe('scene_index_invalid');
});

test('已下架片段不能再收弹幕（400，§17.32）', async () => {
  const scene = await createScene(pool, { takedownAt: new Date() });
  const { cookie } = await claimGuest();
  const response = await send(cookie, {
    sceneIndex: scene.sceneIndex,
    offsetMs: 0,
    content: '下架片段的弹幕',
  });
  expect(response.statusCode).toBe(400);
  expect(response.json<{ error: string }>().error).toBe('scene_index_invalid');
});

test('缺失或非法的 sceneIndex 被拒绝', async () => {
  const { cookie } = await claimGuest();
  for (const sceneIndex of [undefined, 0, -3, 'one', 1.5]) {
    const response = await send(cookie, {
      sceneIndex,
      offsetMs: 0,
      content: '没有锚点',
    });
    expect({ sceneIndex, status: response.statusCode }).toEqual({
      sceneIndex,
      status: 400,
    });
    expect(response.json<{ error: string }>().error).toBe('scene_index_invalid');
  }
});

// --- 频率限制 (§14.3) ----------------------------------------------------------

test('同一用户两条弹幕间隔不足 3 秒被拒，满 3 秒后放行', async () => {
  const scene = await createScene(pool);
  const { cookie, userId } = await claimGuest();

  const first = await send(cookie, {
    sceneIndex: scene.sceneIndex,
    offsetMs: 0,
    content: '第一条',
  });
  expect(first.statusCode).toBe(201);

  const tooSoon = await send(cookie, {
    sceneIndex: scene.sceneIndex,
    offsetMs: 10,
    content: '第二条',
  });
  expect(tooSoon.statusCode).toBe(429);
  expect(tooSoon.json<{ error: string }>().error).toBe('too_fast');

  // Backdated by more than the interval rather than slept through, so the rule
  // under test is the elapsed time and not "one comment ever".
  await pool.query(
    "UPDATE danmaku SET created_at = now() - interval '4 seconds' WHERE user_id = $1",
    [userId],
  );
  const later = await send(cookie, {
    sceneIndex: scene.sceneIndex,
    offsetMs: 20,
    content: '第三条',
  });
  expect(later.statusCode).toBe(201);
});

test('与上一条完全相同的文本被拒', async () => {
  const scene = await createScene(pool);
  const { cookie, userId } = await claimGuest();

  expect(
    (
      await send(cookie, {
        sceneIndex: scene.sceneIndex,
        offsetMs: 0,
        content: '一模一样',
      })
    ).statusCode,
  ).toBe(201);
  await agePreviousDanmaku(userId);

  const duplicate = await send(cookie, {
    sceneIndex: scene.sceneIndex,
    offsetMs: 500,
    content: '一模一样',
  });
  expect(duplicate.statusCode).toBe(400);
  expect(duplicate.json<{ error: string }>().error).toBe('content_duplicate');

  // Only the *previous* message is compared, so a different one in between
  // makes the same text sendable again.
  expect(
    (
      await send(cookie, {
        sceneIndex: scene.sceneIndex,
        offsetMs: 600,
        content: '换一句',
      })
    ).statusCode,
  ).toBe(201);
  await agePreviousDanmaku(userId);
  expect(
    (
      await send(cookie, {
        sceneIndex: scene.sceneIndex,
        offsetMs: 700,
        content: '一模一样',
      })
    ).statusCode,
  ).toBe(201);
});

test('同一用户同一片段最多 30 条', async () => {
  const scene = await createScene(pool);
  const other = await createScene(pool);
  const { cookie, userId } = await claimGuest();

  for (let i = 0; i < DANMAKU_MAX_PER_SCENE - 1; i += 1) {
    await insertDanmaku(pool, {
      userId,
      sceneIndex: scene.sceneIndex,
      offsetMs: i,
      content: `历史弹幕 ${i}`,
      createdAt: new Date(Date.now() - 3_600_000),
    });
  }

  const thirtieth = await send(cookie, {
    sceneIndex: scene.sceneIndex,
    offsetMs: 900,
    content: '第 30 条',
  });
  expect(thirtieth.statusCode).toBe(201);

  await agePreviousDanmaku(userId);
  const overQuota = await send(cookie, {
    sceneIndex: scene.sceneIndex,
    offsetMs: 950,
    content: '第 31 条',
  });
  expect(overQuota.statusCode).toBe(429);
  expect(overQuota.json<{ error: string }>().error).toBe('scene_quota_exceeded');

  // The quota is per scene, so another scene is unaffected.
  const elsewhere = await send(cookie, {
    sceneIndex: other.sceneIndex,
    offsetMs: 0,
    content: '另一个片段',
  });
  expect(elsewhere.statusCode).toBe(201);
});

test('被隐藏的弹幕仍然占用每片段配额', async () => {
  const scene = await createScene(pool);
  const { cookie, userId } = await claimGuest();
  for (let i = 0; i < DANMAKU_MAX_PER_SCENE; i += 1) {
    await insertDanmaku(pool, {
      userId,
      sceneIndex: scene.sceneIndex,
      offsetMs: i,
      content: `被隐藏 ${i}`,
      status: 'hidden',
      createdAt: new Date(Date.now() - 3_600_000),
    });
  }
  const response = await send(cookie, {
    sceneIndex: scene.sceneIndex,
    offsetMs: 900,
    content: '隐藏不退还配额',
  });
  expect(response.statusCode).toBe(429);
  expect(response.json<{ error: string }>().error).toBe('scene_quota_exceeded');
});

// --- 紧急开关 (§14.3) ----------------------------------------------------------

test('紧急开关关闭时 POST 返回 503，历史弹幕仍可读', async () => {
  const scene = await createScene(pool);
  const { cookie, userId } = await claimGuest();
  await insertDanmaku(pool, {
    userId,
    sceneIndex: scene.sceneIndex,
    offsetMs: 100,
    content: '关掉之前的历史',
  });

  await setSetting(DANMAKU_ENABLED_KEY, false);

  const blocked = await send(cookie, {
    sceneIndex: scene.sceneIndex,
    offsetMs: 200,
    content: '关掉之后想发的',
  });
  expect(blocked.statusCode).toBe(503);
  expect(blocked.json<{ error: string }>().error).toBe('danmaku_disabled');

  const scenes = await sceneDanmaku(scene.sceneIndex);
  expect(scenes.statusCode).toBe(200);
  expect(
    scenes.json<{ danmaku: Array<{ content: string }> }>().danmaku.map((d) => d.content),
  ).toEqual(['关掉之前的历史']);

  const feed = await recent();
  expect(feed.statusCode).toBe(200);
  expect(
    feed.json<{ danmaku: Array<{ content: string }> }>().danmaku.map((d) => d.content),
  ).toEqual(['关掉之前的历史']);

  // Re-opening the switch restores sending without a restart.
  await setSetting(DANMAKU_ENABLED_KEY, true);
  await agePreviousDanmaku(userId);
  const reopened = await send(cookie, {
    sceneIndex: scene.sceneIndex,
    offsetMs: 200,
    content: '重新打开之后',
  });
  expect(reopened.statusCode).toBe(201);
});

// --- 读取 (§14.2, §17.25) ------------------------------------------------------

test('片段弹幕按 offset_ms ASC 返回，且 hidden 不出现', async () => {
  const scene = await createScene(pool);
  const { userId } = await claimGuest();
  await insertDanmaku(pool, { userId, sceneIndex: scene.sceneIndex, offsetMs: 900, content: '慢' });
  await insertDanmaku(pool, { userId, sceneIndex: scene.sceneIndex, offsetMs: 100, content: '快' });
  await insertDanmaku(pool, {
    userId,
    sceneIndex: scene.sceneIndex,
    offsetMs: 500,
    content: '被隐藏的',
    status: 'hidden',
  });

  const response = await sceneDanmaku(scene.sceneIndex);
  expect(response.statusCode).toBe(200);
  const body = response.json<{
    truncated: boolean;
    total: number;
    danmaku: Array<{ content: string; offsetMs: number }>;
  }>();
  expect(body.danmaku.map((d) => d.content)).toEqual(['快', '慢']);
  expect(body.danmaku.map((d) => d.offsetMs)).toEqual([100, 900]);
  expect(body.truncated).toBe(false);
  expect(body.total).toBe(2);
});

test('hidden 弹幕也不出现在全站实时流里（§17.25）', async () => {
  const scene = await createScene(pool);
  const { userId } = await claimGuest();
  await insertDanmaku(pool, { userId, sceneIndex: scene.sceneIndex, offsetMs: 1, content: '可见的' });
  await insertDanmaku(pool, {
    userId,
    sceneIndex: scene.sceneIndex,
    offsetMs: 2,
    content: '隐藏的',
    status: 'hidden',
  });

  const body = recentBody(await recent());
  expect(body.map((d) => d.content)).toEqual(['可见的']);
});

test('超过 500 条时按时间轴均匀抽样并标记 truncated', async () => {
  const scene = await createScene(pool, { durationSeconds: 15 });
  const { userId } = await claimGuest();

  const total = SCENE_DANMAKU_CAP + 100;
  const values: string[] = [];
  for (let i = 0; i < total; i += 1) values.push(`($1, $2, $3, ${i * 25}, '弹幕 ${i}')`);
  await pool.query(
    `INSERT INTO danmaku (movie_id, user_id, scene_index, offset_ms, content) VALUES ${values.join(',')}`,
    [INLAND_EMPIRE_MOVIE_ID, userId, scene.sceneIndex],
  );

  const body = (await sceneDanmaku(scene.sceneIndex)).json<{
    truncated: boolean;
    total: number;
    danmaku: Array<{ offsetMs: number }>;
  }>();
  expect(body.total).toBe(total);
  expect(body.truncated).toBe(true);
  expect(body.danmaku).toHaveLength(SCENE_DANMAKU_CAP);

  const offsets = body.danmaku.map((d) => d.offsetMs);
  expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  // Even sampling means the whole timeline is represented, not just its head:
  // the first and last comments survive and the gaps stay bounded.
  expect(offsets[0]).toBe(0);
  expect(offsets[offsets.length - 1]).toBe((total - 1) * 25);
  const biggestGap = Math.max(
    ...offsets.slice(1).map((offset, i) => offset - offsets[i]),
  );
  expect(biggestGap).toBeLessThanOrEqual(2 * 25);
});

test('恰好 500 条时不标记 truncated', async () => {
  const scene = await createScene(pool);
  const { userId } = await claimGuest();
  const values: string[] = [];
  for (let i = 0; i < SCENE_DANMAKU_CAP; i += 1) values.push(`($1, $2, $3, ${i}, '弹幕 ${i}')`);
  await pool.query(
    `INSERT INTO danmaku (movie_id, user_id, scene_index, offset_ms, content) VALUES ${values.join(',')}`,
    [INLAND_EMPIRE_MOVIE_ID, userId, scene.sceneIndex],
  );

  const body = (await sceneDanmaku(scene.sceneIndex)).json<{
    truncated: boolean;
    danmaku: unknown[];
  }>();
  expect(body.danmaku).toHaveLength(SCENE_DANMAKU_CAP);
  expect(body.truncated).toBe(false);
});

test('未知或已下架片段的弹幕接口返回 404', async () => {
  const live = await createScene(pool);
  const gone = await createScene(pool, { takedownAt: new Date() });
  const { userId } = await claimGuest();
  await insertDanmaku(pool, {
    userId,
    sceneIndex: gone.sceneIndex,
    offsetMs: 1,
    content: '下架片段上的历史弹幕',
  });

  expect((await sceneDanmaku(live.sceneIndex)).statusCode).toBe(200);
  expect((await sceneDanmaku(gone.sceneIndex)).statusCode).toBe(404);
  expect((await sceneDanmaku(4242)).statusCode).toBe(404);

  // §17.32: it is gone from the site-wide feed too.
  expect(recentBody(await recent())).toEqual([]);
});

test('全站实时流按 created_at ASC 返回最新的 200 条', async () => {
  const scene = await createScene(pool);
  const { userId } = await claimGuest();

  const total = RECENT_DANMAKU_CAP + 50;
  const values: string[] = [];
  for (let i = 0; i < total; i += 1) {
    // Oldest first, one second apart, so "the newest 200" is unambiguous.
    values.push(`($1, $2, $3, ${i}, '弹幕 ${i}', now() - make_interval(secs => ${total - i}))`);
  }
  await pool.query(
    `INSERT INTO danmaku (movie_id, user_id, scene_index, offset_ms, content, created_at)
     VALUES ${values.join(',')}`,
    [INLAND_EMPIRE_MOVIE_ID, userId, scene.sceneIndex],
  );

  const body = recentBody(await recent());
  expect(body).toHaveLength(RECENT_DANMAKU_CAP);
  // Oldest of the returned window first, newest last (UI §7).
  expect(body[0].content).toBe(`弹幕 ${total - RECENT_DANMAKU_CAP}`);
  expect(body[body.length - 1].content).toBe(`弹幕 ${total - 1}`);
  const times = body.map((d) => Date.parse(d.createdAt));
  expect(times).toEqual([...times].sort((a, b) => a - b));
});
