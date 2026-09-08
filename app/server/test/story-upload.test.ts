// 规范 §4.2 的图片接口与 §4.4 的上传校验。
//
// 这套用例跑在真实的临时目录上：落盘与删盘是这个功能里唯一会在数据库之外留下
// 痕迹的部分，只断言数据库行会漏掉「旧文件还躺在磁盘上」这一类问题。
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';

import { runMigrations } from '../src/db/migrate';
import { storyImagePath } from '../src/lib/story-images';
import { buildApp } from '../src/web/app';
import { ensureDatabase, resetStory, testConfig, TEST_URL } from './helpers';

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(64, 7),
]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 9),
]);

let pool: pg.Pool;
let app: ReturnType<typeof buildApp>;
let mediaDir: string;
let seq = 0;
const uniq = (): string => `${Date.now().toString(36)}_${(seq += 1)}`;

beforeAll(async () => {
  await ensureDatabase();
  await runMigrations(TEST_URL);
  pool = new pg.Pool({ connectionString: TEST_URL });
  mediaDir = await mkdtemp(join(tmpdir(), 'cm-upload-'));
  app = buildApp({ ...testConfig, MEDIA_DIR: mediaDir }, pool, {
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

async function draft(): Promise<{ cookie: string; id: string }> {
  const username = `su_${uniq()}`;
  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, email: `${username}@example.com`, password: 'password123' },
  });
  const session = registered.cookies.find((each) => each.name === 'cm_session');
  if (session === undefined) throw new Error('no session cookie');
  const cookie = `cm_session=${session.value}`;
  const created = await app.inject({
    method: 'POST',
    url: '/api/stories',
    headers: { cookie },
  });
  return { cookie, id: created.json().id as string };
}

function upload(
  cookie: string,
  id: string,
  kind: string,
  position: number,
  bytes: Buffer,
  contentType = 'image/jpeg',
) {
  return app.inject({
    method: 'POST',
    url: `/api/stories/${id}/images?kind=${kind}&position=${position}`,
    headers: { cookie, 'content-type': contentType },
    payload: bytes,
  });
}

describe('上传', () => {
  test('合法的 JPEG 存下来，并给出可访问的 URL', async () => {
    const { cookie, id } = await draft();

    const response = await upload(cookie, id, 'character', 0, JPEG);

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.url).toMatch(new RegExp(`^/media/story/${id}/[0-9a-f-]+\\.jpg$`));
    expect(body.kind).toBe('character');
    expect(body.position).toBe(0);
    // 文件真的在盘上，而且内容一致。
    const path = storyImagePath(mediaDir, body.url as string);
    expect(await readFile(path as string)).toEqual(JPEG);
  });

  test('PNG 按 PNG 存，哪怕声明的是 JPEG', async () => {
    const { cookie, id } = await draft();

    const response = await upload(cookie, id, 'world', 1, PNG, 'image/jpeg');

    expect(response.statusCode).toBe(201);
    expect(response.json().url).toMatch(/\.png$/);
    expect(response.json().mime).toBe('image/png');
  });

  test('改名成 jpg 的 SVG 被拒 —— 它是可执行文档', async () => {
    const { cookie, id } = await draft();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');

    const response = await upload(cookie, id, 'character', 0, svg);

    expect(response.statusCode).toBe(415);
    expect(response.json().error).toBe('image_type_invalid');
  });

  test('超过 2 MiB 被拒', async () => {
    const { cookie, id } = await draft();
    const tooBig = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(2 * 1024 * 1024, 1),
    ]);

    const response = await upload(cookie, id, 'character', 0, tooBig);

    expect([413, 400]).toContain(response.statusCode);
  });

  test('恰好 2 MiB 可以过', async () => {
    const { cookie, id } = await draft();
    const exact = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(2 * 1024 * 1024 - 4, 1),
    ]);
    expect(exact.length).toBe(2 * 1024 * 1024);

    const response = await upload(cookie, id, 'character', 0, exact);

    expect(response.statusCode).toBe(201);
  });

  test('kind 与 position 都必须合法', async () => {
    const { cookie, id } = await draft();

    expect((await upload(cookie, id, 'sidekick', 0, JPEG)).statusCode).toBe(400);
    expect((await upload(cookie, id, 'character', 6, JPEG)).statusCode).toBe(400);
    expect((await upload(cookie, id, 'character', -1, JPEG)).statusCode).toBe(400);
  });

  test('游客传不了图', async () => {
    const { id } = await draft();
    const username = `sug_${uniq()}`;
    const claimed = await app.inject({
      method: 'POST',
      url: '/api/identity/guest',
      payload: { username },
    });
    const guestCookie = claimed.cookies.find((each) => each.name === 'cm_guest');
    if (guestCookie === undefined) throw new Error('no guest cookie');

    const response = await upload(
      `cm_guest=${guestCookie.value}`,
      id,
      'character',
      0,
      JPEG,
    );

    expect(response.statusCode).toBe(403);
  });
});

describe('覆盖同一个格子', () => {
  test('重传覆盖旧图，磁盘上不留旧文件', async () => {
    const { cookie, id } = await draft();
    const first = await upload(cookie, id, 'character', 0, JPEG);
    const firstUrl = first.json().url as string;

    const second = await upload(cookie, id, 'character', 0, PNG);

    expect(second.statusCode).toBe(201);
    expect(second.json().url).not.toBe(firstUrl);
    // 数据库里这个格子只有一行。
    const rows = await pool.query(
      `SELECT 1 FROM story_images
        WHERE proposal_id = $1 AND kind = 'character' AND position = 0`,
      [id],
    );
    expect(rows.rowCount).toBe(1);
    // 磁盘上也只有一份。
    const files = await readdir(join(mediaDir, 'story', id));
    expect(files).toHaveLength(1);
  });

  test('覆盖会清掉这一格原来的说明 —— 换了图，旧说明就不再对得上', async () => {
    const { cookie, id } = await draft();
    const first = await upload(cookie, id, 'character', 0, JPEG);
    await app.inject({
      method: 'PUT',
      url: `/api/stories/${id}/images/${first.json().id as string}`,
      headers: { cookie },
      payload: { caption: '穿校服的少女' },
    });

    const second = await upload(cookie, id, 'character', 0, PNG);

    const row = await pool.query<{ caption: string }>(
      `SELECT caption FROM story_images WHERE id = $1`,
      [second.json().id as string],
    );
    expect(row.rows[0].caption).toBe('');
  });
});

describe('说明', () => {
  test('存得下、读得回', async () => {
    const { cookie, id } = await draft();
    const image = await upload(cookie, id, 'character', 0, JPEG);

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/stories/${id}/images/${image.json().id as string}`,
      headers: { cookie },
      payload: { caption: '穿校服的少女，左眼有一道旧疤' },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json().caption).toBe('穿校服的少女，左眼有一道旧疤');
  });

  test('超过 200 字被拒', async () => {
    const { cookie, id } = await draft();
    const image = await upload(cookie, id, 'character', 0, JPEG);

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/stories/${id}/images/${image.json().id as string}`,
      headers: { cookie },
      payload: { caption: '字'.repeat(201) },
    });

    expect(saved.statusCode).toBe(400);
    expect(saved.json().error).toBe('caption_too_long');
  });

  test('恰好 200 字可以', async () => {
    const { cookie, id } = await draft();
    const image = await upload(cookie, id, 'character', 0, JPEG);

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/stories/${id}/images/${image.json().id as string}`,
      headers: { cookie },
      payload: { caption: '字'.repeat(200) },
    });

    expect(saved.statusCode).toBe(200);
  });
});

describe('删除', () => {
  test('删掉行，也删掉文件', async () => {
    const { cookie, id } = await draft();
    const image = await upload(cookie, id, 'character', 0, JPEG);
    const url = image.json().url as string;

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/stories/${id}/images/${image.json().id as string}`,
      headers: { cookie },
    });

    expect(deleted.statusCode).toBe(204);
    await expect(readFile(storyImagePath(mediaDir, url) as string)).rejects.toThrow();
  });

  test('删掉整份草稿时，它的图片文件也一起走', async () => {
    const { cookie, id } = await draft();
    const image = await upload(cookie, id, 'character', 0, JPEG);
    const url = image.json().url as string;

    await app.inject({
      method: 'DELETE',
      url: `/api/stories/${id}`,
      headers: { cookie },
    });

    await expect(readFile(storyImagePath(mediaDir, url) as string)).rejects.toThrow();
  });
});
