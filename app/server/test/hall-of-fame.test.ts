// 名人堂 —《技术》§16.3 接口清单、§16.2 派生数据不建表，验收 §17 的 32。
//
// §16.2 fixes all three derivations, and every one of them has a way of being
// quietly wrong:
//   * 主榜 counts `scenes GROUP BY credit_user_id` 排除 `takedown_at IS NOT NULL`
//     — a takedown that only hides the 片段 from the player but leaves it in the
//     board is exactly what §17.32 forbids;
//   * 累计获赞 sums 冻结后的净赞 — counting live counts would let an open round
//     inflate the board;
//   * 定过集主题 walks `episodes.theme_source_submission_id → submissions.user_id`.
// And §16.2 permits one 60-second in-process cache, which is tested as a cache:
// stale within the window, fresh after it.
import pg from 'pg';

import { runMigrations } from '../src/db/migrate';
import { buildApp } from '../src/web/app';
import { ensureDatabase, resetStory, testConfig, TEST_URL } from './helpers';
import { createScene } from './scene-fixture';
import {
  createEpisode,
  createRound,
  createSubmission,
  setEpisodeTheme,
} from './story-fixture';

interface HallEntry {
  username: string;
  acceptedCount: number;
  netVotes: number;
  themeEpisodeIndex: number | null;
  themeEpisodeIndexes: number[];
}

let pool: pg.Pool;
/** TTL 0: every request reads through, so the aggregates are what is tested. */
let app: ReturnType<typeof buildApp>;
/** A second app with the real 60-second window, for the cache tests only. */
let cachedApp: ReturnType<typeof buildApp>;

beforeAll(async () => {
  await ensureDatabase();
  await runMigrations(TEST_URL);
  pool = new pg.Pool({ connectionString: TEST_URL });
  app = buildApp(testConfig, pool, {
    guestClaimRateLimit: 10_000,
    hallOfFameTtlMs: 0,
    events: false,
  });
  cachedApp = buildApp(testConfig, pool, {
    guestClaimRateLimit: 10_000,
    hallOfFameTtlMs: 60_000,
    events: false,
  });
  await app.ready();
  await cachedApp.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await cachedApp?.close();
  await pool?.end();
});

beforeEach(async () => {
  await resetStory(pool);
});

async function claimGuest(
  prefix: string,
): Promise<{ userId: string; username: string }> {
  const username = `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
  const response = await app.inject({
    method: 'POST',
    url: '/api/identity/guest',
    payload: { username },
  });
  expect(response.statusCode).toBe(200);
  const found = await pool.query<{ id: string }>(
    'SELECT id FROM users WHERE username_display = $1',
    [username],
  );
  return { userId: found.rows[0].id, username };
}

async function board(
  instance: ReturnType<typeof buildApp> = app,
): Promise<HallEntry[]> {
  const response = await instance.inject({
    method: 'GET',
    url: '/api/hall-of-fame',
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ entries: HallEntry[] }>().entries;
}

test('没有贡献者时返回空榜而不是错误', async () => {
  expect(await board()).toEqual([]);
});

// §16.2「已采用数 / 名人堂主榜：scenes GROUP BY credit_user_id」.
test('按已采用片段数排名，未被采用过的人不上榜', async () => {
  const winner = await claimGuest('hof_win');
  const second = await claimGuest('hof_two');
  const nobody = await claimGuest('hof_non');
  const episode = await createEpisode(pool, { episodeIndex: 1 });
  const round = await createRound(pool, { episodeId: episode.id });

  await createScene(pool, {
    sceneIndex: 1,
    episodeId: episode.id,
    creditUserId: winner.userId,
  });
  await createScene(pool, {
    sceneIndex: 2,
    episodeId: episode.id,
    creditUserId: winner.userId,
  });
  await createScene(pool, {
    sceneIndex: 3,
    episodeId: episode.id,
    creditUserId: second.userId,
  });
  // Plenty of votes, never adopted: votes alone are not a contribution.
  await createSubmission(pool, {
    userId: nobody.userId,
    episodeId: episode.id,
    roundId: round.id,
    upCount: 99,
    frozen: true,
  });

  const entries = await board();
  expect(entries.map((row) => [row.username, row.acceptedCount])).toEqual([
    [winner.username, 2],
    [second.username, 1],
  ]);
});

// §17.32「被下架片段立即从……统计中消失」— the whole reason the exclusion is in
// the §16.2 sentence at all.
test('下架的片段不计入已采用数，只剩下架片段的人离开榜单', async () => {
  const solo = await claimGuest('hof_solo');
  const keeps = await claimGuest('hof_keep');
  const episode = await createEpisode(pool, { episodeIndex: 1 });

  await createScene(pool, {
    sceneIndex: 1,
    episodeId: episode.id,
    creditUserId: solo.userId,
  });
  await createScene(pool, {
    sceneIndex: 2,
    episodeId: episode.id,
    creditUserId: keeps.userId,
  });
  await createScene(pool, {
    sceneIndex: 3,
    episodeId: episode.id,
    creditUserId: keeps.userId,
  });
  expect((await board()).map((row) => row.acceptedCount)).toEqual([2, 1]);

  await pool.query(
    `UPDATE scenes SET takedown_at = now(), takedown_reason = '测试下架'
      WHERE scene_index = ANY($1::int[])`,
    [[1, 3]],
  );

  const entries = await board();
  expect(entries.map((row) => [row.username, row.acceptedCount])).toEqual([
    [keeps.username, 1],
  ]);
});

// §16.2「累计获赞：用户投稿冻结后的净赞求和」.
test('累计获赞只统计已冻结的投稿，按净赞求和', async () => {
  const author = await claimGuest('hof_vote');
  const episode = await createEpisode(pool, { episodeIndex: 1 });
  const round = await createRound(pool, { episodeId: episode.id });
  await createScene(pool, {
    sceneIndex: 1,
    episodeId: episode.id,
    creditUserId: author.userId,
  });

  await createSubmission(pool, {
    userId: author.userId,
    episodeId: episode.id,
    roundId: round.id,
    upCount: 12,
    downCount: 2,
    frozen: true,
  });
  await createSubmission(pool, {
    userId: author.userId,
    episodeId: episode.id,
    kind: 'next_episode',
    upCount: 5,
    downCount: 1,
    frozen: true,
  });
  // Still open: its votes are not final and must not be counted yet.
  const laterRound = await createRound(pool, { episodeId: episode.id });
  await createSubmission(pool, {
    userId: author.userId,
    episodeId: episode.id,
    roundId: laterRound.id,
    upCount: 1_000,
    frozen: false,
  });

  expect((await board())[0].netVotes).toBe(14);
});

// §16.2「定过集主题：episodes.theme_source_submission_id → submissions.user_id」.
test('定过集主题的人带上集号，没定过的是 null', async () => {
  const proposer = await claimGuest('hof_prop');
  const plain = await claimGuest('hof_plain');
  const first = await createEpisode(pool, { episodeIndex: 1 });
  const proposal = await createSubmission(pool, {
    userId: proposer.userId,
    episodeId: first.id,
    kind: 'next_episode',
    frozen: true,
  });
  const second = await createEpisode(pool, { episodeIndex: 2 });
  await setEpisodeTheme(pool, second.id, proposal.id);

  await createScene(pool, {
    sceneIndex: 1,
    episodeId: first.id,
    creditUserId: plain.userId,
  });

  const entries = await board();
  const byName = new Map(entries.map((row) => [row.username, row]));
  expect(byName.get(proposer.username)?.themeEpisodeIndex).toBe(2);
  expect(byName.get(proposer.username)?.themeEpisodeIndexes).toEqual([2]);
  expect(byName.get(plain.username)?.themeEpisodeIndex).toBeNull();
  // Setting a theme is itself a contribution, even with no adopted 片段.
  expect(byName.get(proposer.username)?.acceptedCount).toBe(0);
});

// Two aggregates on one user row must not multiply: three scenes and two frozen
// submissions is 3 and a sum, never 6 and a tripled sum.
test('已采用数与累计获赞互相独立，不相乘', async () => {
  const author = await claimGuest('hof_mult');
  const episode = await createEpisode(pool, { episodeIndex: 1 });
  const round = await createRound(pool, { episodeId: episode.id });

  for (const sceneIndex of [1, 2, 3]) {
    await createScene(pool, {
      sceneIndex,
      episodeId: episode.id,
      creditUserId: author.userId,
    });
  }
  await createSubmission(pool, {
    userId: author.userId,
    episodeId: episode.id,
    roundId: round.id,
    upCount: 10,
    frozen: true,
  });
  await createSubmission(pool, {
    userId: author.userId,
    episodeId: episode.id,
    kind: 'next_episode',
    upCount: 4,
    frozen: true,
  });

  const [entry] = await board();
  expect(entry.acceptedCount).toBe(3);
  expect(entry.netVotes).toBe(14);
});

// §16.2「名人堂查询加 60 秒进程内缓存即可」— a cache is only a cache if it is
// observably stale, so this asserts both halves.
test('60 秒进程内缓存：窗口内复用旧结果，窗口外重新查询', async () => {
  const author = await claimGuest('hof_cache');
  const episode = await createEpisode(pool, { episodeIndex: 1 });
  await createScene(pool, {
    sceneIndex: 1,
    episodeId: episode.id,
    creditUserId: author.userId,
  });

  expect((await board(cachedApp))[0].acceptedCount).toBe(1);

  await createScene(pool, {
    sceneIndex: 2,
    episodeId: episode.id,
    creditUserId: author.userId,
  });
  // Inside the window the board is deliberately behind the database.
  expect((await board(cachedApp))[0].acceptedCount).toBe(1);
  // The uncached instance proves the row really is there.
  expect((await board())[0].acceptedCount).toBe(2);

  // Past the window it catches up. The clock is moved rather than waited on.
  vi.useFakeTimers();
  try {
    vi.setSystemTime(Date.now() + 61_000);
    expect((await board(cachedApp))[0].acceptedCount).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});
