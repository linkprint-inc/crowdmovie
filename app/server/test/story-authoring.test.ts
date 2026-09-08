// 规范 §4.2 —— 提案类接口只对注册账号开放。
//
// The permission rule is the first thing tested and the one most worth getting
// wrong loudly: everywhere else on this site a claimed guest name can write, so
// "account only" is the exception and an implementation that forgets it would
// look completely normal.
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
    storyRateLimit: 10_000,
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

/** A registered account, with its session cookie. */
async function account(): Promise<{ cookie: string; username: string }> {
  const username = `sa_${uniq()}`;
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, email: `${username}@example.com`, password: 'password123' },
  });
  // 200, not 201 — `POST /api/auth/register` answers 200 and test/auth.test.ts
  // already pins that contract.
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.find((each) => each.name === 'cm_session');
  if (cookie === undefined) throw new Error('no session cookie');
  return { cookie: `cm_session=${cookie.value}`, username };
}

/** A claimed guest name — allowed to like and reply, never to submit. */
async function guest(): Promise<string> {
  const username = `sg_${uniq()}`;
  const response = await app.inject({
    method: 'POST',
    url: '/api/identity/guest',
    payload: { username },
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.find((each) => each.name === 'cm_guest');
  if (cookie === undefined) throw new Error('no guest cookie');
  return `cm_guest=${cookie.value}`;
}

describe('谁可以开一份草稿', () => {
  test('未认领身份被拒为 401', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/stories' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('identity_required');
  });

  test('游客被拒为 403，并说明要注册', async () => {
    const cookie = await guest();

    const response = await app.inject({
      method: 'POST',
      url: '/api/stories',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('account_required');
  });

  test('注册账号可以开草稿', async () => {
    const { cookie } = await account();

    const response = await app.inject({
      method: 'POST',
      url: '/api/stories',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().status).toBe('draft');
    expect(response.json().id).toEqual(expect.any(String));
  });

  test('再开一次拿回同一份，不会开出第二份', async () => {
    const { cookie } = await account();
    const first = await app.inject({
      method: 'POST',
      url: '/api/stories',
      headers: { cookie },
    });

    const second = await app.inject({
      method: 'POST',
      url: '/api/stories',
      headers: { cookie },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
  });
});

describe('保存标题与大纲', () => {
  async function draft(): Promise<{ cookie: string; id: string }> {
    const { cookie } = await account();
    const created = await app.inject({
      method: 'POST',
      url: '/api/stories',
      headers: { cookie },
    });
    return { cookie, id: created.json().id as string };
  }

  test('存下来的就是读回来的', async () => {
    const { cookie, id } = await draft();

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/stories/${id}`,
      headers: { cookie },
      payload: { title: '夜行电车', synopsis: '一列永不到站的电车' },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json().title).toBe('夜行电车');
    expect(saved.json().synopsis).toBe('一列永不到站的电车');
  });

  test('草稿期不校验下限 —— 写到一半本来就不满 500', async () => {
    const { cookie, id } = await draft();

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/stories/${id}`,
      headers: { cookie },
      payload: { title: '短', synopsis: '才写了几个字' },
    });

    expect(saved.statusCode).toBe(200);
  });

  test('但上限一直有效', async () => {
    const { cookie, id } = await draft();

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/stories/${id}`,
      headers: { cookie },
      payload: { title: '正常', synopsis: '字'.repeat(2001) },
    });

    expect(saved.statusCode).toBe(400);
    expect(saved.json().error).toBe('synopsis_too_long');
  });

  test('标题上限按可见字符计', async () => {
    const { cookie, id } = await draft();

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/stories/${id}`,
      headers: { cookie },
      payload: { title: 'x'.repeat(81), synopsis: '正常' },
    });

    expect(saved.statusCode).toBe(400);
    expect(saved.json().error).toBe('title_too_long');
  });

  test('别人的草稿看不见也改不了', async () => {
    const { id } = await draft();
    const { cookie: other } = await account();

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/stories/${id}`,
      headers: { cookie: other },
      payload: { title: '偷改', synopsis: '偷改' },
    });

    // 404 而不是 403：别人的草稿对你来说就是不存在。
    expect(saved.statusCode).toBe(404);
  });
});

describe('删除草稿', () => {
  test('删得掉，而且真的没了', async () => {
    const { cookie } = await account();
    const created = await app.inject({
      method: 'POST',
      url: '/api/stories',
      headers: { cookie },
    });
    const id = created.json().id as string;

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/stories/${id}`,
      headers: { cookie },
    });

    expect(deleted.statusCode).toBe(204);
    const left = await pool.query('SELECT 1 FROM story_proposals WHERE id = $1', [id]);
    expect(left.rowCount).toBe(0);
  });

  test('删掉之后可以再开一份新的', async () => {
    const { cookie } = await account();
    const created = await app.inject({
      method: 'POST',
      url: '/api/stories',
      headers: { cookie },
    });
    await app.inject({
      method: 'DELETE',
      url: `/api/stories/${created.json().id as string}`,
      headers: { cookie },
    });

    const again = await app.inject({
      method: 'POST',
      url: '/api/stories',
      headers: { cookie },
    });

    expect(again.statusCode).toBe(201);
  });

  test('审核中的不能删 —— 删掉就把审核任务变成孤儿了', async () => {
    const { cookie } = await account();
    const created = await app.inject({
      method: 'POST',
      url: '/api/stories',
      headers: { cookie },
    });
    const id = created.json().id as string;
    await pool.query(`UPDATE story_proposals SET status = 'pending' WHERE id = $1`, [
      id,
    ]);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/stories/${id}`,
      headers: { cookie },
    });

    expect(deleted.statusCode).toBe(409);
    expect(deleted.json().error).toBe('not_a_draft');
  });
});

describe('GET /api/me/story', () => {
  test('拿得到自己的草稿和历史', async () => {
    const { cookie } = await account();
    const created = await app.inject({
      method: 'POST',
      url: '/api/stories',
      headers: { cookie },
    });

    const mine = await app.inject({
      method: 'GET',
      url: '/api/me/story',
      headers: { cookie },
    });

    expect(mine.statusCode).toBe(200);
    expect(mine.json().draft.id).toBe(created.json().id);
    expect(mine.json().proposals).toHaveLength(1);
  });

  test('被拒时看得到理由', async () => {
    const { cookie } = await account();
    const created = await app.inject({
      method: 'POST',
      url: '/api/stories',
      headers: { cookie },
    });
    await pool.query(
      `UPDATE story_proposals
          SET status = 'rejected', reject_reason = 'text: 含有露骨描写'
        WHERE id = $1`,
      [created.json().id as string],
    );

    const mine = await app.inject({
      method: 'GET',
      url: '/api/me/story',
      headers: { cookie },
    });

    expect(mine.json().draft).toBeNull();
    expect(mine.json().proposals[0].rejectReason).toBe('text: 含有露骨描写');
  });

  test('游客也能调，只是永远是空的 —— 他们本来就提交不了', async () => {
    const cookie = await guest();

    const mine = await app.inject({
      method: 'GET',
      url: '/api/me/story',
      headers: { cookie },
    });

    expect(mine.statusCode).toBe(200);
    expect(mine.json().draft).toBeNull();
    expect(mine.json().proposals).toEqual([]);
  });

  test('草稿带着自己的图片回来 —— 编辑器重新载入要靠它填回 12 个格子', async () => {
    const { cookie } = await account();
    const created = await app.inject({
      method: 'POST',
      url: '/api/stories',
      headers: { cookie },
    });
    const id = created.json().id as string;
    await pool.query(
      `INSERT INTO story_images
         (proposal_id, kind, position, caption, file_url, mime, bytes, sha256)
       VALUES ($1, 'character', 2, '穿校服的少女', '/media/story/x.png',
               'image/png', 100, 'abc')`,
      [id],
    );

    const mine = await app.inject({
      method: 'GET',
      url: '/api/me/story',
      headers: { cookie },
    });

    const images = mine.json().draft.images as {
      kind: string;
      position: number;
      caption: string;
      url: string;
    }[];
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      kind: 'character',
      position: 2,
      caption: '穿校服的少女',
      url: '/media/story/x.png',
    });
  });
});
