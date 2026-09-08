// 剧集页 —《技术》§16.3 接口清单、§16.2 派生统计、§5.4 主题来源，《前端》§11。
//
// The counts are the point. §16.2 says they are derived by query and never
// stored, so the assertions here are about what a query counts: a taken-down
// 片段 leaves the count (§17.32), and two independent aggregates on one episode
// row must not multiply each other.
import pg from 'pg';

import { runMigrations } from '../src/db/migrate';
import { buildApp } from '../src/web/app';
import { ensureDatabase, resetStory, testConfig, TEST_URL } from './helpers';
import { createScene } from './scene-fixture';
import {
  createEpisode,
  createRound,
  createSubmission,
  scoreSubmission,
  setEpisodeTheme,
} from './story-fixture';

let pool: pg.Pool;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  await ensureDatabase();
  await runMigrations(TEST_URL);
  pool = new pg.Pool({ connectionString: TEST_URL });
  app = buildApp(testConfig, pool, {
    guestClaimRateLimit: 10_000,
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
});

async function claimGuest(): Promise<{ cookie: string; userId: string }> {
  const username = `ep_${Math.random().toString(36).slice(2, 12)}`;
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

interface EpisodeCard {
  episodeIndex: number;
  title: string;
  premise: string;
  status: string;
  sceneCount: number;
  submissionCount: number;
  themeSourceUsername: string | null;
  themeSourceVotes: number | null;
}

async function list(): Promise<EpisodeCard[]> {
  const response = await app.inject({ method: 'GET', url: '/api/episodes' });
  expect(response.statusCode).toBe(200);
  return response.json<{ episodes: EpisodeCard[] }>().episodes;
}

function detail(episodeIndex: number | string) {
  return app.inject({ method: 'GET', url: `/api/episodes/${episodeIndex}` });
}

test('没有任何一集时返回空列表而不是错误', async () => {
  expect(await list()).toEqual([]);
});

// 《前端》§11「卡片网格，倒序排列，最新一集在前」.
test('列表按 episode_index 倒序，与创建顺序无关', async () => {
  await createEpisode(pool, { episodeIndex: 2 });
  await createEpisode(pool, { episodeIndex: 5, status: 'open' });
  await createEpisode(pool, { episodeIndex: 1 });

  expect((await list()).map((card) => card.episodeIndex)).toEqual([5, 2, 1]);
});

// §16.2「剧集卡片的片段数 / 投稿数：按 episode_id 计数」. Deliberately unequal
// numbers of each, because a join instead of two subqueries would return their
// product and equal numbers would hide it.
test('片段数与投稿数按集独立计数，不互相相乘', async () => {
  const { userId } = await claimGuest();
  const other = await claimGuest();
  const episode = await createEpisode(pool, { episodeIndex: 1 });
  const round = await createRound(pool, { episodeId: episode.id });

  await createScene(pool, { sceneIndex: 1, episodeId: episode.id });
  await createScene(pool, { sceneIndex: 2, episodeId: episode.id });
  await createScene(pool, { sceneIndex: 3, episodeId: episode.id });
  await createSubmission(pool, {
    userId,
    episodeId: episode.id,
    roundId: round.id,
  });
  await createSubmission(pool, {
    userId: other.userId,
    episodeId: episode.id,
    roundId: round.id,
  });

  const [card] = await list();
  expect(card.sceneCount).toBe(3);
  expect(card.submissionCount).toBe(2);
});

// §17.32「被下架片段立即从播放清单、分享页与统计中消失」— 片段数 is a statistic.
test('已下架片段不计入片段数', async () => {
  const episode = await createEpisode(pool, { episodeIndex: 1 });
  await createScene(pool, { sceneIndex: 1, episodeId: episode.id });
  await createScene(pool, { sceneIndex: 2, episodeId: episode.id });
  expect((await list())[0].sceneCount).toBe(2);

  await pool.query(
    "UPDATE scenes SET takedown_at = now(), takedown_reason = '测试下架' WHERE scene_index = 2",
  );
  expect((await list())[0].sceneCount).toBe(1);
});

// §5.4 / §16.1: NULL `theme_source_submission_id` 表示 AI 自拟。
test('AI 自拟的主题没有署名，也没有票数', async () => {
  await createEpisode(pool, { episodeIndex: 1 });
  const [card] = await list();
  expect(card.themeSourceUsername).toBeNull();
  expect(card.themeSourceVotes).toBeNull();
});

// §5.4「提案者署名为「本集主题贡献者」」, and 比较值为净赞.
test('民选主题带提案者用户名与当时净赞', async () => {
  const { userId } = await claimGuest();
  const previous = await createEpisode(pool, { episodeIndex: 1 });
  const proposal = await createSubmission(pool, {
    userId,
    episodeId: previous.id,
    kind: 'next_episode',
    content: '下一集：校车竞标战',
    upCount: 31,
    downCount: 4,
    frozen: true,
  });
  const episode = await createEpisode(pool, { episodeIndex: 2, status: 'open' });
  await setEpisodeTheme(pool, episode.id, proposal.id);

  const card = (await list()).find((each) => each.episodeIndex === 2);
  const username = await pool.query<{ username_display: string }>(
    'SELECT username_display FROM users WHERE id = $1',
    [userId],
  );
  expect(card?.themeSourceUsername).toBe(username.rows[0].username_display);
  expect(card?.themeSourceVotes).toBe(27);
});

test('卡片带状态、标题与设定正文', async () => {
  await createEpisode(pool, {
    episodeIndex: 1,
    title: '校车竞标战',
    theme: '本集设定正文',
    status: 'open',
  });
  const [card] = await list();
  expect(card.title).toBe('校车竞标战');
  expect(card.premise).toBe('本集设定正文');
  expect(card.status).toBe('open');
});

// --- 单集详情 ----------------------------------------------------------------

test('不存在的集、非数字与负数都是 404', async () => {
  await createEpisode(pool, { episodeIndex: 1 });
  expect((await detail(2)).statusCode).toBe(404);
  expect((await detail('abc')).statusCode).toBe(404);
  expect((await detail(-1)).statusCode).toBe(404);
  expect((await detail(1)).statusCode).toBe(200);
});

// 《前端》§11「本集设定：完整 premise 与主题来源署名」+「本集高赞投稿」.
test('详情带设定、署名与本集高赞投稿，按净赞排序', async () => {
  const author = await claimGuest();
  const rival = await claimGuest();
  const episode = await createEpisode(pool, { episodeIndex: 1, theme: '设定正文' });
  const round = await createRound(pool, { episodeId: episode.id });

  const low = await createSubmission(pool, {
    userId: author.userId,
    episodeId: episode.id,
    roundId: round.id,
    content: '低赞的镜头',
    upCount: 2,
    downCount: 1,
  });
  const high = await createSubmission(pool, {
    userId: rival.userId,
    episodeId: episode.id,
    roundId: round.id,
    content: '高赞的镜头',
    upCount: 40,
    downCount: 3,
  });
  await scoreSubmission(pool, {
    submissionId: high.id,
    roundId: round.id,
    total: 88,
  });

  const response = await detail(1);
  expect(response.statusCode).toBe(200);
  const body = response.json<{
    premise: string;
    topSubmissions: Array<{
      id: string;
      content: string;
      upCount: number;
      downCount: number;
      score: { total: number; roast: Record<string, string> } | null;
    }>;
  }>();

  expect(body.premise).toBe('设定正文');
  expect(body.topSubmissions.map((row) => row.id)).toEqual([high.id, low.id]);
  expect(body.topSubmissions[0].score?.total).toBe(88);
  expect(body.topSubmissions[0].score?.roast['zh-CN']).toBe('fixture 毒舌');
  // A submission whose 初评 has not landed is still listed, without a score.
  expect(body.topSubmissions[1].score).toBeNull();
});

// §6.3 公开策略: 总分与四语毒舌公开; 分项、理由与风险标记不对外。
test('详情不泄露初评分项、理由与风险标记', async () => {
  const author = await claimGuest();
  const episode = await createEpisode(pool, { episodeIndex: 1 });
  const round = await createRound(pool, { episodeId: episode.id });
  const submission = await createSubmission(pool, {
    userId: author.userId,
    episodeId: episode.id,
    roundId: round.id,
  });
  await scoreSubmission(pool, {
    submissionId: submission.id,
    roundId: round.id,
    total: 70,
  });

  const raw = (await detail(1)).body;
  expect(raw).toContain('fixture 毒舌');
  expect(raw).not.toContain('fixture reason');
  expect(raw).not.toContain('scoreBreakdown');
  expect(raw).not.toContain('riskFlags');
});

// 详情只列本集的投稿，不串集。
test('详情只包含本集的投稿', async () => {
  const author = await claimGuest();
  const first = await createEpisode(pool, { episodeIndex: 1 });
  const second = await createEpisode(pool, { episodeIndex: 2 });
  const firstRound = await createRound(pool, { episodeId: first.id });
  const secondRound = await createRound(pool, { episodeId: second.id });

  await createSubmission(pool, {
    userId: author.userId,
    episodeId: first.id,
    roundId: firstRound.id,
    content: '第一集的投稿',
  });
  await createSubmission(pool, {
    userId: author.userId,
    episodeId: second.id,
    roundId: secondRound.id,
    content: '第二集的投稿',
  });

  const body = (await detail(1)).json<{
    topSubmissions: Array<{ content: string }>;
  }>();
  expect(body.topSubmissions.map((row) => row.content)).toEqual(['第一集的投稿']);
});
