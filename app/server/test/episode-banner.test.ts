// 放映厅·集横幅 —《技术》§16.3 的 `GET /api/episode/current` 与
// `GET /api/episode/current/proposals`，规则见 §5.4，展示见《前端》§6.6。
//
// The proposal pool is what makes this suite different from the 剧集页 one:
// §5.4 scopes it to the *episode*, not the round, so the two things that are
// easy to get wrong are the boundary (a `next_shot` or another episode's
// proposal leaking in) and the ordering (净赞 desc with 「并列时取更早投稿」).
// Both are asserted with rows that would pass a sloppier query.
import pg from 'pg';

import { runMigrations } from '../src/db/migrate';
import { buildApp } from '../src/web/app';
import { ensureDatabase, resetStory, testConfig, TEST_URL } from './helpers';
import { createScene } from './scene-fixture';
import { createEpisode, createRound, createSubmission } from './story-fixture';

let pool: pg.Pool;
let app: ReturnType<typeof buildApp>;

const APP_OPTIONS = {
  guestClaimRateLimit: 10_000,
  voteRateLimit: 10_000,
  events: false,
} as const;

beforeAll(async () => {
  await ensureDatabase();
  await runMigrations(TEST_URL);
  pool = new pg.Pool({ connectionString: TEST_URL });
  app = buildApp(testConfig, pool, APP_OPTIONS);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

beforeEach(async () => {
  await resetStory(pool);
});

async function claimGuest(): Promise<{ cookie: string; userId: string }> {
  const username = `banner_${Math.random().toString(36).slice(2, 12)}`;
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

interface Banner {
  episodeIndex: number;
  title: string;
  theme: string;
  status: string;
  themeSourceUsername: string | null;
  themeSourceVotes: number | null;
  proposalCount: number;
  storyOutline: Array<{ sceneIndex: number; summaryZh: string }>;
}

interface ProposalRow {
  id: string;
  username: string;
  content: string;
  upCount: number;
  downCount: number;
  netVotes: number;
  myVote: 1 | -1 | null;
  createdAt: string;
}

interface ProposalsBody {
  episodeIndex: number;
  adoptThreshold: number;
  proposals: ProposalRow[];
}

function bannerResponse(cookie?: string) {
  return app.inject({
    method: 'GET',
    url: '/api/episode/current',
    headers: cookie === undefined ? {} : { cookie },
  });
}

function proposalsResponse(cookie?: string) {
  return app.inject({
    method: 'GET',
    url: '/api/episode/current/proposals',
    headers: cookie === undefined ? {} : { cookie },
  });
}

async function banner(): Promise<Banner> {
  const response = await bannerResponse();
  expect(response.statusCode).toBe(200);
  return response.json<Banner>();
}

async function proposals(cookie?: string): Promise<ProposalsBody> {
  const response = await proposalsResponse(cookie);
  expect(response.statusCode).toBe(200);
  return response.json<ProposalsBody>();
}

/**
 * A 「下一集」提案 written by its own fresh guest. §16.1 的
 * `UNIQUE (episode_id, user_id) WHERE kind='next_episode'` allows one proposal
 * per identity per episode, so a pool of several needs a proposer each.
 */
async function pitch(input: {
  episodeId: string;
  content: string;
  upCount?: number;
  downCount?: number;
  createdAt?: Date;
}): Promise<{ id: string }> {
  const author = await claimGuest();
  return createSubmission(pool, {
    userId: author.userId,
    episodeId: input.episodeId,
    kind: 'next_episode',
    content: input.content,
    upCount: input.upCount,
    downCount: input.downCount,
    createdAt: input.createdAt,
  });
}

/** The real vote path (§5.4), so `up_count`/`down_count` stay consistent. */
async function vote(
  cookie: string,
  submissionId: string,
  value: 1 | -1,
): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/submissions/${submissionId}/vote`,
    headers: { cookie },
    payload: { value },
  });
  expect(response.statusCode).toBe(200);
}

// --- 集横幅 ------------------------------------------------------------------

// §5.4「同一时刻只有一个 status=open 的集」— before the first one exists there is
// nothing to show, and the answer matches `/api/round/current` 的 `no_round`.
test('没有开放的集时两个接口都是 404 而不是 500', async () => {
  await createEpisode(pool, { episodeIndex: 1, status: 'ended' });

  const bannerRes = await bannerResponse();
  expect(bannerRes.statusCode).toBe(404);
  expect(bannerRes.json<{ error: string }>().error).toBe('no_episode');

  const proposalsRes = await proposalsResponse();
  expect(proposalsRes.statusCode).toBe(404);
  expect(proposalsRes.json<{ error: string }>().error).toBe('no_episode');
});

// 《前端》§6.6「EP N · 主题：…」— 集号、短标题与本集设定正文都在横幅上。
//
// The open episode is deliberately neither the first nor the last row: picking
// it by `status` is the only way to land on EP 2, so an endpoint that took the
// earliest or the latest episode instead would fail here rather than pass by
// coincidence.
test('横幅返回开放的那一集，既不是第一集也不是最新一集', async () => {
  await createEpisode(pool, { episodeIndex: 1, status: 'ended' });
  await createEpisode(pool, {
    episodeIndex: 2,
    title: '校车竞标战',
    theme: '本集设定正文',
    status: 'open',
  });
  await createEpisode(pool, { episodeIndex: 3, status: 'ended' });

  const body = await banner();
  expect(body.episodeIndex).toBe(2);
  expect(body.title).toBe('校车竞标战');
  expect(body.theme).toBe('本集设定正文');
  expect(body.status).toBe('open');
});

// §5.4 / §16.1: NULL `theme_source_submission_id` 表示 AI 自拟。
test('AI 自拟的主题没有署名，也没有票数', async () => {
  await createEpisode(pool, { episodeIndex: 1, status: 'open' });
  const body = await banner();
  expect(body.themeSourceUsername).toBeNull();
  expect(body.themeSourceVotes).toBeNull();
});

// §5.4「提案者署名为「本集主题贡献者」」, 比较值为净赞。
test('民选主题带提案者用户名与当时净赞', async () => {
  const proposer = await claimGuest();
  const previous = await createEpisode(pool, { episodeIndex: 1 });
  const source = await createSubmission(pool, {
    userId: proposer.userId,
    episodeId: previous.id,
    kind: 'next_episode',
    content: '上一集里选中的总纲',
    upCount: 31,
    downCount: 4,
    frozen: true,
  });
  const current = await createEpisode(pool, {
    episodeIndex: 2,
    status: 'open',
    themeSourceSubmissionId: source.id,
  });
  expect(current.episodeIndex).toBe(2);

  const username = await pool.query<{ username_display: string }>(
    'SELECT username_display FROM users WHERE id = $1',
    [proposer.userId],
  );
  const body = await banner();
  expect(body.themeSourceUsername).toBe(username.rows[0].username_display);
  expect(body.themeSourceVotes).toBe(27);
});

// 提案数只数本集的「下一集」提案: a 镜头投稿 in the same episode and a proposal
// in another episode both have to stay out of it.
test('提案数只数本集的 next_episode，与镜头投稿和别集互不混淆', async () => {
  const author = await claimGuest();
  const other = await createEpisode(pool, { episodeIndex: 1 });
  const current = await createEpisode(pool, { episodeIndex: 2, status: 'open' });
  const round = await createRound(pool, { episodeId: current.id });

  await createSubmission(pool, {
    userId: author.userId,
    episodeId: current.id,
    kind: 'next_episode',
    content: '本集的提案',
  });
  await createSubmission(pool, {
    userId: author.userId,
    episodeId: current.id,
    roundId: round.id,
    content: '本集的镜头投稿',
  });
  await createSubmission(pool, {
    userId: author.userId,
    episodeId: other.id,
    kind: 'next_episode',
    content: '别集的提案',
  });

  const body = await banner();
  expect(body.proposalCount).toBe(1);
  // The banner's count and the list it opens must agree (《前端》§6.6).
  expect((await proposals()).proposals).toHaveLength(1);
});

test('没有提案时提案数是 0，列表为空', async () => {
  await createEpisode(pool, { episodeIndex: 1, status: 'open' });
  expect((await banner()).proposalCount).toBe(0);
  expect((await proposals()).proposals).toEqual([]);
});

test('当前集故事大纲只汇总已发布且未下架的 Sol 导演镜头', async () => {
  const episode = await createEpisode(pool, { episodeIndex: 1, status: 'open' });
  const second = await createScene(pool, { episodeId: episode.id, sceneIndex: 12 });
  const first = await createScene(pool, { episodeId: episode.id, sceneIndex: 11 });
  const notSol = await createScene(pool, { episodeId: episode.id, sceneIndex: 13 });
  const takenDown = await createScene(pool, {
    episodeId: episode.id,
    sceneIndex: 14,
    takedownAt: new Date('2026-08-30T02:00:00.000Z'),
  });

  for (const [sceneIndex, summary] of [
    [second.sceneIndex, '第二幕：魔理沙推来订阅制氧气机。'],
    [first.sceneIndex, '第一幕：广播宣布征收校园空气使用费。'],
    [takenDown.sceneIndex, '这条已经被运营下架。'],
  ] as const) {
    await pool.query('UPDATE scenes SET summary_zh = $2 WHERE scene_index = $1', [
      sceneIndex,
      summary,
    ]);
    await pool.query(
      `UPDATE ai_runs d
          SET provider = 'openai_codex', model = 'gpt-5.6-sol'
         FROM scenes s
        WHERE s.scene_index = $1 AND d.id = s.director_ai_run_id`,
      [sceneIndex],
    );
  }
  await pool.query(
    `UPDATE scenes SET summary_zh = '不是 Sol 生成的演示镜头' WHERE scene_index = $1`,
    [notSol.sceneIndex],
  );
  await pool.query(
    `UPDATE ai_runs d
        SET provider = 'openai_codex', model = 'gpt-5.6-terra'
       FROM scenes s
      WHERE s.scene_index = $1 AND d.id = s.director_ai_run_id`,
    [notSol.sceneIndex],
  );

  expect((await banner()).storyOutline).toEqual([
    {
      sceneIndex: first.sceneIndex,
      summaryZh: '第一幕：广播宣布征收校园空气使用费。',
    },
    {
      sceneIndex: second.sceneIndex,
      summaryZh: '第二幕：魔理沙推来订阅制氧气机。',
    },
  ]);
});

test('还没有 Sol 正片时故事大纲为空，不拿种子预览冒充', async () => {
  const episode = await createEpisode(pool, { episodeIndex: 1, status: 'open' });
  await createScene(pool, { episodeId: episode.id });

  expect((await banner()).storyOutline).toEqual([]);
});

// --- 提案列表 ----------------------------------------------------------------

// 《前端》§6.6「按净赞从高到低排序」+ §5.4「并列时取更早投稿」. The upvote counts
// are deliberately not a ranking on their own: `low` has the most 赞 but the
// worst 净赞, so a query that sorted by `up_count` would put it first.
test('提案按净赞倒序排列，并列时更早的投稿在前', async () => {
  const episode = await createEpisode(pool, { episodeIndex: 1, status: 'open' });
  const base = new Date('2026-08-30T00:00:00.000Z');
  const at = (minutes: number): Date =>
    new Date(base.getTime() + minutes * 60_000);

  const low = await pitch({
    episodeId: episode.id,
    content: '净赞最低',
    upCount: 40,
    downCount: 38,
    createdAt: at(0),
  });
  const tieLate = await pitch({
    episodeId: episode.id,
    content: '并列，投得晚',
    upCount: 12,
    downCount: 2,
    createdAt: at(20),
  });
  const tieEarly = await pitch({
    episodeId: episode.id,
    content: '并列，投得早',
    upCount: 10,
    downCount: 0,
    createdAt: at(10),
  });
  const top = await pitch({
    episodeId: episode.id,
    content: '净赞最高',
    upCount: 15,
    downCount: 1,
    createdAt: at(30),
  });

  const body = await proposals();
  expect(body.proposals.map((row) => row.id)).toEqual([
    top.id,
    tieEarly.id,
    tieLate.id,
    low.id,
  ]);
  expect(body.proposals.map((row) => row.netVotes)).toEqual([14, 10, 10, 2]);
});

// The pool is 「下一集」提案 only — a 镜头投稿 in the same episode must never be
// listed as a pitch for the next one (§5.4, 《前端》§6.6).
test('镜头投稿不会漏进提案列表', async () => {
  const author = await claimGuest();
  const episode = await createEpisode(pool, { episodeIndex: 1, status: 'open' });
  const round = await createRound(pool, { episodeId: episode.id });

  // The 镜头投稿 carries far more 净赞, so a query that forgot the kind filter
  // would put it at the top of the list rather than hide it at the bottom.
  await createSubmission(pool, {
    userId: author.userId,
    episodeId: episode.id,
    roundId: round.id,
    content: '高赞的镜头投稿',
    upCount: 99,
    downCount: 0,
  });
  const pitch = await createSubmission(pool, {
    userId: author.userId,
    episodeId: episode.id,
    kind: 'next_episode',
    content: '真正的下一集提案',
    upCount: 1,
    downCount: 0,
  });

  const body = await proposals();
  expect(body.proposals.map((row) => row.id)).toEqual([pitch.id]);
  expect(body.proposals[0].content).toBe('真正的下一集提案');
});

test('提案列表只包含当前开放这一集的提案', async () => {
  const author = await claimGuest();
  const ended = await createEpisode(pool, { episodeIndex: 1, status: 'ended' });
  const open = await createEpisode(pool, { episodeIndex: 2, status: 'open' });

  await createSubmission(pool, {
    userId: author.userId,
    episodeId: ended.id,
    kind: 'next_episode',
    content: '上一集的提案',
    upCount: 50,
  });
  await createSubmission(pool, {
    userId: author.userId,
    episodeId: open.id,
    kind: 'next_episode',
    content: '本集的提案',
  });

  const body = await proposals();
  expect(body.episodeIndex).toBe(2);
  expect(body.proposals.map((row) => row.content)).toEqual(['本集的提案']);
});

test('提案带用户名、正文、赞踩数与投稿时间', async () => {
  const author = await claimGuest();
  const episode = await createEpisode(pool, { episodeIndex: 1, status: 'open' });
  const created = new Date('2026-08-30T01:02:03.000Z');
  const pitch = await createSubmission(pool, {
    userId: author.userId,
    episodeId: episode.id,
    kind: 'next_episode',
    content: '下一集：校车竞标战',
    upCount: 7,
    downCount: 2,
    createdAt: created,
  });

  const username = await pool.query<{ username_display: string }>(
    'SELECT username_display FROM users WHERE id = $1',
    [author.userId],
  );
  const [row] = (await proposals()).proposals;
  expect(row.id).toBe(pitch.id);
  expect(row.username).toBe(username.rows[0].username_display);
  expect(row.content).toBe('下一集：校车竞标战');
  expect(row.upCount).toBe(7);
  expect(row.downCount).toBe(2);
  expect(row.netVotes).toBe(5);
  expect(row.createdAt).toBe(created.toISOString());
});

// --- 自己的票 ----------------------------------------------------------------

// 每人每条一票 (§5.4): the list has to say which one is yours, and only yours.
test('带身份调用时返回自己的票，不返回别人的票', async () => {
  const me = await claimGuest();
  const stranger = await claimGuest();
  const episode = await createEpisode(pool, { episodeIndex: 1, status: 'open' });

  const liked = await pitch({
    episodeId: episode.id,
    content: '我点了赞',
    createdAt: new Date('2026-08-30T00:00:00.000Z'),
  });
  const disliked = await pitch({
    episodeId: episode.id,
    content: '我点了踩',
    createdAt: new Date('2026-08-30T00:01:00.000Z'),
  });
  const untouched = await pitch({
    episodeId: episode.id,
    content: '我没投过',
    createdAt: new Date('2026-08-30T00:02:00.000Z'),
  });

  await vote(me.cookie, liked.id, 1);
  await vote(me.cookie, disliked.id, -1);
  // Somebody else's votes must not be reported as mine.
  await vote(stranger.cookie, untouched.id, 1);
  await vote(stranger.cookie, disliked.id, 1);

  const mine = new Map(
    (await proposals(me.cookie)).proposals.map((row) => [row.id, row.myVote]),
  );
  expect(mine.get(liked.id)).toBe(1);
  expect(mine.get(disliked.id)).toBe(-1);
  expect(mine.get(untouched.id)).toBeNull();
});

test('匿名调用时没有任何一条带着别人的票', async () => {
  const voter = await claimGuest();
  const episode = await createEpisode(pool, { episodeIndex: 1, status: 'open' });
  const voted = await pitch({
    episodeId: episode.id,
    content: '有人投过的提案',
  });
  await vote(voter.cookie, voted.id, 1);

  const body = await proposals();
  expect(body.proposals).toHaveLength(1);
  expect(body.proposals[0].myVote).toBeNull();
  // The counts are public even when the caller is not signed in.
  expect(body.proposals[0].upCount).toBe(1);
});

// --- 直采阈值 ----------------------------------------------------------------

// 《前端》§6.6「距直采阈值的差距提示」— the page must not have to hardcode 10.
test('提案列表带上直采阈值，默认 10', async () => {
  await createEpisode(pool, { episodeIndex: 1, status: 'open' });
  expect((await proposals()).adoptThreshold).toBe(10);
});

// §5.4「直采阈值由 CROWD_AI_MOVIE_VOTE_ADOPT_THRESHOLD（默认 10）配置」.
test('直采阈值跟着配置走，不是写死的 10', async () => {
  await createEpisode(pool, { episodeIndex: 1, status: 'open' });
  const tuned = buildApp(
    { ...testConfig, VOTE_ADOPT_THRESHOLD: 7 },
    pool,
    APP_OPTIONS,
  );
  await tuned.ready();
  try {
    const response = await tuned.inject({
      method: 'GET',
      url: '/api/episode/current/proposals',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<ProposalsBody>().adoptThreshold).toBe(7);
  } finally {
    await tuned.close();
  }
});

test('site_settings 的合法正整数可热覆盖 env，非法值回退 env', async () => {
  await createEpisode(pool, { episodeIndex: 1, status: 'open' });
  await pool.query(
    `INSERT INTO site_settings (key, value) VALUES ($1, $2::jsonb)`,
    ['vote_adopt_threshold_override', '7'],
  );
  expect((await proposals()).adoptThreshold).toBe(7);

  await pool.query(
    `UPDATE site_settings SET value = $2::jsonb, updated_at = now()
      WHERE key = $1`,
    ['vote_adopt_threshold_override', '"7"'],
  );
  expect((await proposals()).adoptThreshold).toBe(10);
});
