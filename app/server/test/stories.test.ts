// 规范 §4.1 的公开读取与 §4.3 的跟帖。
//
// The rule the list has to get right: only a proposal that is published and not
// taken down is visible. Everything else — a draft, one under review, one that
// was refused — is not "forbidden", it does not exist as far as the board is
// concerned, and a leak here would publish text no one ever approved.
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

async function newUser(): Promise<{ id: string; username: string }> {
  const username = `sl_${uniq()}`;
  const row = await pool.query<{ id: string }>(
    `INSERT INTO users (username_display, username_key, password_hash)
     VALUES ($1, $1, 'x') RETURNING id`,
    [username],
  );
  return { id: row.rows[0].id, username };
}

async function guestCookie(): Promise<string> {
  const username = `slg_${uniq()}`;
  const claimed = await app.inject({
    method: 'POST',
    url: '/api/identity/guest',
    payload: { username },
  });
  const cookie = claimed.cookies.find((each) => each.name === 'cm_guest');
  if (cookie === undefined) throw new Error('no guest cookie');
  return `cm_guest=${cookie.value}`;
}

interface PublishOptions {
  title?: string;
  likeCount?: number;
  publishedAt?: string;
  images?: number;
}

/** A published proposal with `images` pictures in each group. */
async function publish(
  userId: string,
  options: PublishOptions = {},
): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `INSERT INTO story_proposals
       (user_id, title, synopsis, status, like_count, submitted_at, reviewed_at,
        published_at)
     VALUES ($1, $2, '一列永不到站的电车', 'approved', $3, now(), now(),
             coalesce($4::timestamptz, now()))
     RETURNING id`,
    [
      userId,
      options.title ?? '夜行电车',
      options.likeCount ?? 0,
      options.publishedAt ?? null,
    ],
  );
  const proposalId = row.rows[0].id;
  const count = options.images ?? 4;
  for (const kind of ['character', 'world'] as const) {
    for (let position = 0; position < count; position += 1) {
      await pool.query(
        `INSERT INTO story_images
           (proposal_id, kind, position, caption, file_url, mime, bytes, sha256)
         VALUES ($1, $2, $3, $4, $5, 'image/png', 100, 'abc')`,
        [
          proposalId,
          kind,
          position,
          `${kind} ${position}`,
          `/media/story/${proposalId}/${kind}-${position}.png`,
        ],
      );
    }
  }
  return proposalId;
}

describe('列表页', () => {
  test('只显示已发布的', async () => {
    const author = await newUser();
    const published = await publish(author.id);
    // 一份草稿、一份审核中、一份被拒 —— 都不该出现。
    for (const status of ['draft', 'pending', 'rejected']) {
      const other = await newUser();
      await pool.query(
        `INSERT INTO story_proposals (user_id, title, status)
         VALUES ($1, '不该出现', $2)`,
        [other.id, status],
      );
    }

    const response = await app.inject({ method: 'GET', url: '/api/stories' });

    expect(response.statusCode).toBe(200);
    const stories = response.json().stories as { id: string }[];
    expect(stories).toHaveLength(1);
    expect(stories[0].id).toBe(published);
  });

  test('下架的也不显示', async () => {
    const author = await newUser();
    const id = await publish(author.id);
    await pool.query(
      `UPDATE story_proposals SET takedown_at = now() WHERE id = $1`,
      [id],
    );

    const response = await app.inject({ method: 'GET', url: '/api/stories' });

    expect(response.json().stories).toHaveLength(0);
  });

  test('每条带全部人物图和设定图', async () => {
    const author = await newUser();
    await publish(author.id, { images: 6 });

    const response = await app.inject({ method: 'GET', url: '/api/stories' });

    const preview = response.json().stories[0].previewImages as {
      kind: string;
      url: string;
    }[];
    expect(preview).toHaveLength(12);
    expect(preview.filter((image) => image.kind === 'character')).toHaveLength(6);
    expect(preview.filter((image) => image.kind === 'world')).toHaveLength(6);
  });

  test('预览图按 position 排序，不按 file_url 排序', async () => {
    const author = await newUser();
    const id = await publish(author.id, { images: 0 });
    // file_url 故意与 position 反着排：文件名里的图片 id 是随机生成的
    // （storyImageUrl，见 lib/story-images.ts），跟 position 毫无关系。查询若
    // 靠 file_url 断平局（旧 bug），这两张图会倒过来。
    await pool.query(
      `INSERT INTO story_images
         (proposal_id, kind, position, caption, file_url, mime, bytes, sha256)
       VALUES ($1, 'character', 0, 'c0', '/media/story/zzz-later-url.png',
                 'image/png', 100, 'abc'),
              ($1, 'character', 1, 'c1', '/media/story/aaa-earlier-url.png',
                 'image/png', 100, 'abc')`,
      [id],
    );

    const response = await app.inject({ method: 'GET', url: '/api/stories' });

    const characters = (
      response.json().stories[0].previewImages as { kind: string; url: string }[]
    ).filter((image) => image.kind === 'character');
    expect(characters.map((image) => image.url)).toEqual([
      '/media/story/zzz-later-url.png',
      '/media/story/aaa-earlier-url.png',
    ]);
  });

  test('默认按点赞数排序', async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    await publish(a.id, { title: '少', likeCount: 1 });
    await publish(b.id, { title: '多', likeCount: 9 });
    await publish(c.id, { title: '中', likeCount: 5 });

    const response = await app.inject({ method: 'GET', url: '/api/stories' });

    const titles = (response.json().stories as { title: string }[]).map(
      (story) => story.title,
    );
    expect(titles).toEqual(['多', '中', '少']);
  });

  test('sort=new 按发布时间倒序', async () => {
    const a = await newUser();
    const b = await newUser();
    await publish(a.id, {
      title: '旧',
      likeCount: 99,
      publishedAt: '2020-01-01T00:00:00Z',
    });
    await publish(b.id, {
      title: '新',
      likeCount: 0,
      publishedAt: '2030-01-01T00:00:00Z',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/stories?sort=new',
    });

    const titles = (response.json().stories as { title: string }[]).map(
      (story) => story.title,
    );
    expect(titles).toEqual(['新', '旧']);
  });

  test('分页有效，并报告总数', async () => {
    for (let i = 0; i < 3; i += 1) {
      const author = await newUser();
      await publish(author.id, { title: `第 ${i}`, likeCount: 10 - i });
    }

    const response = await app.inject({
      method: 'GET',
      url: '/api/stories?limit=2&offset=1',
    });

    expect(response.json().total).toBe(3);
    expect(response.json().stories).toHaveLength(2);
    expect(response.json().hasMore).toBe(false);
  });

  test('limit 超过上限被拒', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/stories?limit=999',
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('详情页', () => {
  test('给出全文与两组图', async () => {
    const author = await newUser();
    const id = await publish(author.id);

    const response = await app.inject({ method: 'GET', url: `/api/stories/${id}` });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.title).toBe('夜行电车');
    expect(body.synopsis).toBe('一列永不到站的电车');
    expect(body.authorUsername).toBe(author.username);
    expect(body.characters).toHaveLength(4);
    expect(body.worlds).toHaveLength(4);
    expect(body.characters[0].caption).toBe('character 0');
  });

  test('未发布的详情是 404', async () => {
    const author = await newUser();
    const row = await pool.query<{ id: string }>(
      `INSERT INTO story_proposals (user_id, title, status)
       VALUES ($1, '审核中', 'pending') RETURNING id`,
      [author.id],
    );

    const response = await app.inject({
      method: 'GET',
      url: `/api/stories/${row.rows[0].id}`,
    });

    expect(response.statusCode).toBe(404);
  });

  test('乱写的 id 是 404，不是 500', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/stories/not-a-uuid' });

    expect(response.statusCode).toBe(404);
  });
});

describe('跟帖', () => {
  test('游客可以回帖', async () => {
    const author = await newUser();
    const id = await publish(author.id);
    const cookie = await guestCookie();

    const response = await app.inject({
      method: 'POST',
      url: `/api/stories/${id}/comments`,
      headers: { cookie },
      payload: { content: '这个设定很好' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().content).toBe('这个设定很好');
  });

  test('未认领身份不能回帖', async () => {
    const author = await newUser();
    const id = await publish(author.id);

    const response = await app.inject({
      method: 'POST',
      url: `/api/stories/${id}/comments`,
      payload: { content: '匿名' },
    });

    expect(response.statusCode).toBe(401);
  });

  test('按楼层顺序读回来，并维护计数缓存', async () => {
    const author = await newUser();
    const id = await publish(author.id);
    const cookie = await guestCookie();
    for (const content of ['一楼', '二楼', '三楼']) {
      await app.inject({
        method: 'POST',
        url: `/api/stories/${id}/comments`,
        headers: { cookie },
        payload: { content },
      });
    }

    const response = await app.inject({
      method: 'GET',
      url: `/api/stories/${id}/comments`,
    });

    const contents = (response.json().comments as { content: string }[]).map(
      (comment) => comment.content,
    );
    expect(contents).toEqual(['一楼', '二楼', '三楼']);
    const counted = await app.inject({ method: 'GET', url: `/api/stories/${id}` });
    expect(counted.json().commentCount).toBe(3);
  });

  test('隐藏的跟帖不显示，也不计数', async () => {
    const author = await newUser();
    const id = await publish(author.id);
    const cookie = await guestCookie();
    await app.inject({
      method: 'POST',
      url: `/api/stories/${id}/comments`,
      headers: { cookie },
      payload: { content: '会被下架的' },
    });
    await pool.query(`UPDATE story_comments SET status = 'hidden'`);

    const response = await app.inject({
      method: 'GET',
      url: `/api/stories/${id}/comments`,
    });

    expect(response.json().comments).toHaveLength(0);
  });

  test('超过 500 个可见字符被拒', async () => {
    const author = await newUser();
    const id = await publish(author.id);
    const cookie = await guestCookie();

    const response = await app.inject({
      method: 'POST',
      url: `/api/stories/${id}/comments`,
      headers: { cookie },
      payload: { content: 'x'.repeat(501) },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('content_too_long');
  });

  test('空跟帖被拒', async () => {
    const author = await newUser();
    const id = await publish(author.id);
    const cookie = await guestCookie();

    const response = await app.inject({
      method: 'POST',
      url: `/api/stories/${id}/comments`,
      headers: { cookie },
      payload: { content: '   ' },
    });

    expect(response.statusCode).toBe(400);
  });

  test('回不了未发布的设定', async () => {
    const author = await newUser();
    const row = await pool.query<{ id: string }>(
      `INSERT INTO story_proposals (user_id, title, status)
       VALUES ($1, '审核中', 'pending') RETURNING id`,
      [author.id],
    );
    const cookie = await guestCookie();

    const response = await app.inject({
      method: 'POST',
      url: `/api/stories/${row.rows[0].id}/comments`,
      headers: { cookie },
      payload: { content: '偷偷回帖' },
    });

    expect(response.statusCode).toBe(404);
  });
});
