// 规范 §4.3 的点赞。
//
// This count decides which story bible an operator picks as the next video's
// main setting, so the two properties worth proving are that it cannot be
// inflated (one like per identity, none on your own work) and that it cannot
// drift from the rows behind it.
import pg from 'pg';

import { runMigrations } from '../src/db/migrate';
import { buildApp } from '../src/web/app';
import { ensureDatabase, resetStory, testConfig, TEST_URL } from './helpers';

let pool: pg.Pool;
let app: ReturnType<typeof buildApp>;
let seq = 0;
const uniq = (): string => `${Date.now().toString(36)}_${(seq += 1)}`;

beforeAll(async () => {
  await ensureDatabase();
  await runMigrations(TEST_URL);
  pool = new pg.Pool({ connectionString: TEST_URL });
  app = buildApp(testConfig, pool, {
    guestClaimRateLimit: 10_000,
    authIpRateLimit: 10_000,
    storyLikeRateLimit: 10_000,
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

/** A claimed guest name and the user id behind it. */
async function reader(): Promise<{ cookie: string; id: string }> {
  const username = `lk_${uniq()}`;
  const claimed = await app.inject({
    method: 'POST',
    url: '/api/identity/guest',
    payload: { username },
  });
  const cookie = claimed.cookies.find((each) => each.name === 'cm_guest');
  if (cookie === undefined) throw new Error('no guest cookie');
  return { cookie: `cm_guest=${cookie.value}`, id: claimed.json().id as string };
}

/** A published proposal owned by `userId`. */
async function publish(userId: string): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `INSERT INTO story_proposals
       (user_id, title, synopsis, status, submitted_at, reviewed_at, published_at)
     VALUES ($1, '夜行电车', '一列永不到站的电车', 'approved', now(), now(), now())
     RETURNING id`,
    [userId],
  );
  return row.rows[0].id;
}

const like = (cookie: string, id: string, value: number) =>
  app.inject({
    method: 'POST',
    url: `/api/stories/${id}/like`,
    headers: { cookie },
    payload: { value },
  });

test('点赞把计数加上去', async () => {
  const author = await reader();
  const fan = await reader();
  const id = await publish(author.id);

  const response = await like(fan.cookie, id, 1);

  expect(response.statusCode).toBe(200);
  expect(response.json().likeCount).toBe(1);
  expect(response.json().likedByMe).toBe(true);
});

test('重复点赞不叠加', async () => {
  const author = await reader();
  const fan = await reader();
  const id = await publish(author.id);
  await like(fan.cookie, id, 1);

  const again = await like(fan.cookie, id, 1);

  expect(again.json().likeCount).toBe(1);
});

test('取消点赞让计数回落', async () => {
  const author = await reader();
  const fan = await reader();
  const id = await publish(author.id);
  await like(fan.cookie, id, 1);

  const cancelled = await like(fan.cookie, id, 0);

  expect(cancelled.json().likeCount).toBe(0);
  expect(cancelled.json().likedByMe).toBe(false);
});

test('不同的人各算一票', async () => {
  const author = await reader();
  const first = await reader();
  const second = await reader();
  const id = await publish(author.id);

  await like(first.cookie, id, 1);
  const response = await like(second.cookie, id, 1);

  expect(response.json().likeCount).toBe(2);
});

test('不能给自己点赞 —— 这个计数要决定下次拍谁的设定', async () => {
  const author = await reader();
  const id = await publish(author.id);

  const response = await like(author.cookie, id, 1);

  expect(response.statusCode).toBe(403);
  expect(response.json().error).toBe('self_like');
});

test('未认领身份不能点赞', async () => {
  const author = await reader();
  const id = await publish(author.id);

  const response = await app.inject({
    method: 'POST',
    url: `/api/stories/${id}/like`,
    payload: { value: 1 },
  });

  expect(response.statusCode).toBe(401);
});

test('未发布的设定点不了赞', async () => {
  const author = await reader();
  const fan = await reader();
  const row = await pool.query<{ id: string }>(
    `INSERT INTO story_proposals (user_id, title, status)
     VALUES ($1, '审核中', 'pending') RETURNING id`,
    [author.id],
  );

  const response = await like(fan.cookie, row.rows[0].id, 1);

  expect(response.statusCode).toBe(404);
});

test('value 只能是 1 或 0', async () => {
  const author = await reader();
  const fan = await reader();
  const id = await publish(author.id);

  const response = await like(fan.cookie, id, -1);

  expect(response.statusCode).toBe(400);
  expect(response.json().error).toBe('value_invalid');
});

test('缓存列与真实行数一致', async () => {
  const author = await reader();
  const fans = [await reader(), await reader(), await reader()];
  const id = await publish(author.id);
  for (const fan of fans) await like(fan.cookie, id, 1);
  await like(fans[0].cookie, id, 0);

  const cached = await pool.query<{ like_count: number }>(
    'SELECT like_count FROM story_proposals WHERE id = $1',
    [id],
  );
  const actual = await pool.query('SELECT 1 FROM story_likes WHERE proposal_id = $1', [
    id,
  ]);
  expect(cached.rows[0].like_count).toBe(actual.rowCount);
  expect(cached.rows[0].like_count).toBe(2);
});
