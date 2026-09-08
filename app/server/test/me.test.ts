// 我的剧本 —《技术》§16.3 接口清单、§16.2 派生统计、§16.1 drafts，《前端》§12，
// 验收 §17 的 30/31/32。
//
// Two properties are load-bearing across every route here and are asserted
// separately from the data: an anonymous request is 401 (there is no identity to
// scope to), and a banned identity is 403 on the write (§17.31 名单里就有草稿).
//
// The statistics are §16.2's derivations, so the tests are about what a query
// counts — including the takedown rule, which reaches 已采用数 the same way it
// reaches the 名人堂.
import pg from 'pg';

import { runMigrations } from '../src/db/migrate';
import { buildApp } from '../src/web/app';
import { DRAFT_KINDS, MY_SUBMISSIONS_MAX_LIMIT } from '../src/web/routes/me';
import { NEXT_SHOT_MAX_GRAPHEMES } from '../src/web/routes/submissions';
import { ensureDatabase, resetStory, testConfig, TEST_URL } from './helpers';
import { createScene } from './scene-fixture';
import {
  createEpisode,
  createRound,
  createSubmission,
  scoreSubmission,
  setEpisodeTheme,
} from './story-fixture';

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
    draftRateLimit: 10_000,
    events: false,
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

beforeEach(async () => {
  await resetStory(pool);
  // `drafts` is not story state, so resetStory leaves it alone.
  await pool.query('TRUNCATE drafts');
});

interface Guest {
  cookie: string;
  userId: string;
  username: string;
}

async function claimGuest(): Promise<Guest> {
  const username = `me_${Math.random().toString(36).slice(2, 12)}`;
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
  return { cookie: `cm_guest=${cookie.value}`, userId: found.rows[0].id, username };
}

function get(url: string, cookie?: string) {
  return app.inject({
    method: 'GET',
    url,
    headers: cookie === undefined ? {} : { cookie },
  });
}

function putDraft(cookie: string | undefined, payload: unknown) {
  return app.inject({
    method: 'PUT',
    url: '/api/me/drafts',
    headers: cookie === undefined ? {} : { cookie },
    payload,
  });
}

// --- 身份边界 ----------------------------------------------------------------

test('未认领身份时四个接口全部 401', async () => {
  for (const url of [
    '/api/me/stats',
    '/api/me/submissions',
    '/api/me/drafts',
  ]) {
    const response = await get(url);
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: string }>().error).toBe('identity_required');
  }
  const put = await putDraft(undefined, { kind: 'next_shot', body: '匿名草稿' });
  expect(put.statusCode).toBe(401);
});

// §17.31「被封禁用户的所有写接口（投稿、投票、弹幕、留言、草稿）一律被拒绝」.
test('被封禁的身份在读和写上都是 403', async () => {
  const guest = await claimGuest();
  expect((await putDraft(guest.cookie, { kind: 'next_shot', body: '封禁前' })).statusCode).toBe(200);

  await pool.query(
    "UPDATE users SET banned_at = now(), ban_reason = '测试封禁' WHERE id = $1",
    [guest.userId],
  );

  const write = await putDraft(guest.cookie, { kind: 'next_shot', body: '封禁后' });
  expect(write.statusCode).toBe(403);
  expect(write.json<{ error: string }>().error).toBe('banned');
  expect((await get('/api/me/stats', guest.cookie)).statusCode).toBe(403);

  // 「其已有内容不自动删除」— the draft written before the ban is still there.
  const stored = await pool.query<{ body: string }>(
    'SELECT body FROM drafts WHERE user_id = $1',
    [guest.userId],
  );
  expect(stored.rows[0].body).toBe('封禁前');
});

// --- GET /api/me/stats (§16.2) ----------------------------------------------

test('新身份的统计全是 0', async () => {
  const guest = await claimGuest();
  const response = await get('/api/me/stats', guest.cookie);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    submissions: 0,
    accepted: 0,
    netVotes: 0,
    episodes: 0,
    themesSet: 0,
  });
});

test('五项统计各自独立：投稿数、已采用数、累计获赞、参与集数、定过集主题', async () => {
  const me = await claimGuest();
  const other = await claimGuest();
  const first = await createEpisode(pool, { episodeIndex: 1 });
  const second = await createEpisode(pool, { episodeIndex: 2 });
  const firstRound = await createRound(pool, { episodeId: first.id });
  const secondRound = await createRound(pool, { episodeId: second.id });

  // Two episodes, three submissions, two of them frozen.
  await createSubmission(pool, {
    userId: me.userId,
    episodeId: first.id,
    roundId: firstRound.id,
    upCount: 9,
    downCount: 2,
    frozen: true,
  });
  const proposal = await createSubmission(pool, {
    userId: me.userId,
    episodeId: first.id,
    kind: 'next_episode',
    upCount: 6,
    downCount: 1,
    frozen: true,
  });
  await createSubmission(pool, {
    userId: me.userId,
    episodeId: second.id,
    roundId: secondRound.id,
    upCount: 500,
    frozen: false,
  });
  // Someone else's work must not leak into my numbers.
  await createSubmission(pool, {
    userId: other.userId,
    episodeId: first.id,
    roundId: firstRound.id,
    upCount: 77,
    frozen: true,
  });
  await createScene(pool, {
    sceneIndex: 1,
    episodeId: first.id,
    creditUserId: other.userId,
  });

  await createScene(pool, {
    sceneIndex: 2,
    episodeId: first.id,
    creditUserId: me.userId,
  });
  await setEpisodeTheme(pool, second.id, proposal.id);

  const stats = (await get('/api/me/stats', me.cookie)).json();
  expect(stats).toEqual({
    submissions: 3,
    accepted: 1,
    netVotes: 12, // (9-2) + (6-1); the unfrozen 500 is not final
    episodes: 2,
    themesSet: 1,
  });
});

// §17.32「被下架片段立即从……统计中消失」.
test('已采用数排除被下架的片段', async () => {
  const me = await claimGuest();
  const episode = await createEpisode(pool, { episodeIndex: 1 });
  await createScene(pool, {
    sceneIndex: 1,
    episodeId: episode.id,
    creditUserId: me.userId,
  });
  await createScene(pool, {
    sceneIndex: 2,
    episodeId: episode.id,
    creditUserId: me.userId,
  });
  expect((await get('/api/me/stats', me.cookie)).json<{ accepted: number }>().accepted).toBe(2);

  await pool.query(
    "UPDATE scenes SET takedown_at = now(), takedown_reason = '测试下架' WHERE scene_index = 1",
  );
  expect((await get('/api/me/stats', me.cookie)).json<{ accepted: number }>().accepted).toBe(1);
});

// --- GET /api/me/submissions -------------------------------------------------

interface MyRow {
  id: string;
  kind: string;
  episodeIndex: number | null;
  roundIndex: number | null;
  content: string;
  status: string;
  score: number | null;
  netVotes: number;
  isEpisodeTheme: boolean;
  adopted: boolean;
  sceneIndex: number | null;
  createdAt: string;
}

test('投稿记录按时间倒序，只包含自己的，带集号轮号、分数、净赞与采用状态', async () => {
  const me = await claimGuest();
  const other = await claimGuest();
  const episode = await createEpisode(pool, { episodeIndex: 7 });
  const round = await createRound(pool, { episodeId: episode.id, roundIndex: 43 });

  const older = await createSubmission(pool, {
    userId: me.userId,
    episodeId: episode.id,
    roundId: round.id,
    content: '更早的投稿',
    status: 'accepted',
    upCount: 10,
    downCount: 3,
    createdAt: new Date(Date.now() - 60_000),
  });
  const newer = await createSubmission(pool, {
    userId: me.userId,
    episodeId: episode.id,
    kind: 'next_episode',
    content: '更晚的提案',
    createdAt: new Date(),
  });
  await createSubmission(pool, {
    userId: other.userId,
    episodeId: episode.id,
    roundId: round.id,
    content: '别人的投稿',
  });
  await scoreSubmission(pool, {
    submissionId: older.id,
    roundId: round.id,
    total: 81,
  });
  await createScene(pool, {
    sceneIndex: 5,
    episodeId: episode.id,
    creditUserId: me.userId,
    sourceSubmissionId: older.id,
  });
  await setEpisodeTheme(pool, episode.id, newer.id);

  const body = (await get('/api/me/submissions', me.cookie)).json<{
    total: number;
    hasMore: boolean;
    submissions: MyRow[];
  }>();

  expect(body.total).toBe(2);
  expect(body.hasMore).toBe(false);
  expect(body.submissions.map((row) => row.content)).toEqual([
    '更晚的提案',
    '更早的投稿',
  ]);

  const adopted = body.submissions[1];
  expect(adopted.episodeIndex).toBe(7);
  expect(adopted.roundIndex).toBe(43);
  expect(adopted.status).toBe('accepted');
  expect(adopted.score).toBe(81);
  expect(adopted.netVotes).toBe(7);
  expect(adopted.adopted).toBe(true);
  expect(adopted.sceneIndex).toBe(5);
  expect(adopted.isEpisodeTheme).toBe(false);

  // 《前端》§12「定过集主题的记录单独标注」; a next_episode proposal has no round.
  const themed = body.submissions[0];
  expect(themed.isEpisodeTheme).toBe(true);
  expect(themed.roundIndex).toBeNull();
  expect(themed.adopted).toBe(false);
  expect(themed.score).toBeNull();
});

test('分页返回 total、limit、offset 与 hasMore，越界参数是 400', async () => {
  const me = await claimGuest();
  const episode = await createEpisode(pool, { episodeIndex: 1 });
  const round = await createRound(pool, { episodeId: episode.id });
  for (let index = 0; index < 5; index += 1) {
    await createSubmission(pool, {
      userId: me.userId,
      episodeId: episode.id,
      roundId: index === 0 ? round.id : (await createRound(pool, { episodeId: episode.id })).id,
      content: `投稿 ${index}`,
      createdAt: new Date(Date.now() - index * 1_000),
    });
  }

  const page = (await get('/api/me/submissions?limit=2', me.cookie)).json<{
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
    submissions: MyRow[];
  }>();
  expect(page.total).toBe(5);
  expect(page.limit).toBe(2);
  expect(page.hasMore).toBe(true);
  expect(page.submissions.map((row) => row.content)).toEqual(['投稿 0', '投稿 1']);

  const last = (await get('/api/me/submissions?limit=2&offset=4', me.cookie)).json<{
    hasMore: boolean;
    submissions: MyRow[];
  }>();
  expect(last.submissions.map((row) => row.content)).toEqual(['投稿 4']);
  expect(last.hasMore).toBe(false);

  expect((await get('/api/me/submissions?limit=0', me.cookie)).statusCode).toBe(400);
  expect((await get('/api/me/submissions?limit=-1', me.cookie)).statusCode).toBe(400);
  expect((await get('/api/me/submissions?offset=-1', me.cookie)).statusCode).toBe(400);
  expect(
    (await get(`/api/me/submissions?limit=${MY_SUBMISSIONS_MAX_LIMIT + 1}`, me.cookie))
      .statusCode,
  ).toBe(400);
});

// §17.32 again: an adopted 投稿 whose 片段 was taken down is no longer adopted.
test('片段被下架后，对应投稿不再标记为已采用', async () => {
  const me = await claimGuest();
  const episode = await createEpisode(pool, { episodeIndex: 1 });
  const round = await createRound(pool, { episodeId: episode.id });
  const submission = await createSubmission(pool, {
    userId: me.userId,
    episodeId: episode.id,
    roundId: round.id,
  });
  await createScene(pool, {
    sceneIndex: 1,
    episodeId: episode.id,
    creditUserId: me.userId,
    sourceSubmissionId: submission.id,
  });

  const before = (await get('/api/me/submissions', me.cookie)).json<{
    submissions: MyRow[];
  }>();
  expect(before.submissions[0].adopted).toBe(true);

  await pool.query(
    "UPDATE scenes SET takedown_at = now(), takedown_reason = '测试下架' WHERE scene_index = 1",
  );
  const after = (await get('/api/me/submissions', me.cookie)).json<{
    submissions: MyRow[];
  }>();
  expect(after.submissions[0].adopted).toBe(false);
  expect(after.submissions[0].sceneIndex).toBeNull();
});

// --- 草稿箱 (§16.1 drafts, §17.30) -------------------------------------------

interface DraftRow {
  kind: string;
  body: string;
  updatedAt: string;
}

async function drafts(cookie: string): Promise<DraftRow[]> {
  const response = await get('/api/me/drafts', cookie);
  expect(response.statusCode).toBe(200);
  return response.json<{ drafts: DraftRow[] }>().drafts;
}

test('新身份没有草稿', async () => {
  const me = await claimGuest();
  expect(await drafts(me.cookie)).toEqual([]);
});

// §16.1「PRIMARY KEY (user_id, kind)，每类各保留一份，UPSERT 覆盖」.
test('同一类型重复保存是覆盖，不会留下第二行', async () => {
  const me = await claimGuest();
  expect((await putDraft(me.cookie, { kind: 'next_shot', body: '第一版' })).statusCode).toBe(200);
  expect((await putDraft(me.cookie, { kind: 'next_shot', body: '第二版' })).statusCode).toBe(200);
  expect((await putDraft(me.cookie, { kind: 'next_shot', body: '第三版' })).statusCode).toBe(200);

  const rows = await drafts(me.cookie);
  expect(rows).toHaveLength(1);
  expect(rows[0].body).toBe('第三版');

  const stored = await pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM drafts WHERE user_id = $1',
    [me.userId],
  );
  expect(Number(stored.rows[0].n)).toBe(1);
});

// §17.30「两类投稿与弹幕草稿互不覆盖」.
test('三类草稿各自独立，互不覆盖', async () => {
  const me = await claimGuest();
  for (const kind of DRAFT_KINDS) {
    expect((await putDraft(me.cookie, { kind, body: `${kind} 的草稿` })).statusCode).toBe(200);
  }
  const rows = await drafts(me.cookie);
  expect(rows.map((row) => [row.kind, row.body]).sort()).toEqual(
    [...DRAFT_KINDS].map((kind) => [kind, `${kind} 的草稿`]).sort(),
  );
});

// §12「换会话后可恢复」: the draft belongs to the identity, not to the cookie
// that happened to write it.
test('草稿只属于自己的身份，另一个身份读不到', async () => {
  const me = await claimGuest();
  const other = await claimGuest();
  await putDraft(me.cookie, { kind: 'next_shot', body: '我的草稿' });
  expect(await drafts(other.cookie)).toEqual([]);
  expect((await drafts(me.cookie))[0].body).toBe('我的草稿');
});

test('清空草稿是合法保存，不是删除失败', async () => {
  const me = await claimGuest();
  await putDraft(me.cookie, { kind: 'next_shot', body: '写了一半' });
  expect((await putDraft(me.cookie, { kind: 'next_shot', body: '' })).statusCode).toBe(200);
  expect((await drafts(me.cookie))[0].body).toBe('');
});

test('未知类型与非字符串正文都是 400', async () => {
  const me = await claimGuest();
  expect((await putDraft(me.cookie, { kind: 'poem', body: 'x' })).statusCode).toBe(400);
  expect((await putDraft(me.cookie, { body: 'x' })).statusCode).toBe(400);
  expect((await putDraft(me.cookie, { kind: 'next_shot' })).statusCode).toBe(400);
  expect((await putDraft(me.cookie, { kind: 'next_shot', body: 42 })).statusCode).toBe(400);
  expect(await drafts(me.cookie)).toEqual([]);
});

// §4 的字数上限，按 grapheme cluster 计数（§17.5 的同一把尺）.
test('草稿超过对应投稿类型的字数上限即拒绝，按用户可见字符计数', async () => {
  const me = await claimGuest();
  const family = FAMILY.repeat(NEXT_SHOT_MAX_GRAPHEMES);
  expect((await putDraft(me.cookie, { kind: 'next_shot', body: family })).statusCode).toBe(200);

  const over = await putDraft(me.cookie, {
    kind: 'next_shot',
    body: FAMILY.repeat(NEXT_SHOT_MAX_GRAPHEMES + 1),
  });
  expect(over.statusCode).toBe(400);
  expect(over.json<{ error: string; max: number }>()).toMatchObject({
    error: 'content_too_long',
    max: NEXT_SHOT_MAX_GRAPHEMES,
  });
  // The rejected save left the accepted one intact.
  expect((await drafts(me.cookie))[0].body).toBe(family);
});

test('弹幕草稿用弹幕的 100 字上限，不是镜头的 140', async () => {
  const me = await claimGuest();
  expect(
    (await putDraft(me.cookie, { kind: 'danmaku', body: '弹'.repeat(100) })).statusCode,
  ).toBe(200);
  expect(
    (await putDraft(me.cookie, { kind: 'danmaku', body: '弹'.repeat(101) })).statusCode,
  ).toBe(400);
});

// The IP axis and the identity axis share one FixedWindowCounter, so they must
// not share a *key*. With a budget of 3 on each, three saves have to succeed:
// a shared keyspace would take two records per request and refuse the second.
test('草稿限速的 IP 轴与身份轴不共用键空间', async () => {
  const limited = buildApp(testConfig, pool, {
    guestClaimRateLimit: 10_000,
    draftRateLimit: 3,
    events: false,
  });
  await limited.ready();
  try {
    const username = `mr_${Math.random().toString(36).slice(2, 12)}`;
    const claimed = await limited.inject({
      method: 'POST',
      url: '/api/identity/guest',
      payload: { username },
    });
    const cookie = `cm_guest=${claimed.cookies.find((each) => each.name === 'cm_guest')?.value}`;

    for (const body of ['第 1 版', '第 2 版', '第 3 版']) {
      const response = await limited.inject({
        method: 'PUT',
        url: '/api/me/drafts',
        headers: { cookie },
        payload: { kind: 'next_shot', body },
      });
      expect(response.statusCode).toBe(200);
    }
    const fourth = await limited.inject({
      method: 'PUT',
      url: '/api/me/drafts',
      headers: { cookie },
      payload: { kind: 'next_shot', body: '第 4 版' },
    });
    expect(fourth.statusCode).toBe(429);
  } finally {
    await limited.close();
  }
});
