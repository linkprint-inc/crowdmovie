// 播放清单 —《技术》§11 视频编号与连续播放、§16.3 接口清单，验收 §17 的 13/17/32。
import pg from 'pg';
import { randomUUID } from 'node:crypto';

import { LOCALES } from '../src/ai/engine';
import { runMigrations } from '../src/db/migrate';
import { buildApp } from '../src/web/app';
import { ensureDatabase, resetStory, testConfig, TEST_URL } from './helpers';
import { createScene } from './scene-fixture';

let pool: pg.Pool;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  await ensureDatabase();
  await runMigrations(TEST_URL);
  pool = new pg.Pool({ connectionString: TEST_URL });
  app = buildApp(testConfig, pool);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

beforeEach(async () => {
  await resetStory(pool);
});

interface PlaylistEntry {
  sceneIndex: number;
  episodeIndex: number;
  videoUrl: string;
  subtitles: Record<string, string>;
  durationMs: number;
}

async function playlist(): Promise<PlaylistEntry[]> {
  const response = await app.inject({ method: 'GET', url: '/api/movie/playlist' });
  expect(response.statusCode).toBe(200);
  return response.json<{ scenes: PlaylistEntry[] }>().scenes;
}

test('没有片段时返回空清单而不是错误', async () => {
  expect(await playlist()).toEqual([]);
});

// §17.17「播放器严格按照 scene_index 连续播放所有已发布 MP4 片段」— the order is
// the endpoint's job, so it is asserted against rows created out of order.
test('按 scene_index ASC 排序，与创建顺序无关', async () => {
  const episode = await createScene(pool, { sceneIndex: 2 });
  await createScene(pool, { sceneIndex: 5, episodeId: episode.episodeId });
  await createScene(pool, { sceneIndex: 1, episodeId: episode.episodeId });
  await createScene(pool, { sceneIndex: 4, episodeId: episode.episodeId });

  expect((await playlist()).map((entry) => entry.sceneIndex)).toEqual([1, 2, 4, 5]);
});

test('播放清单可只返回已知场次之后的新场次', async () => {
  const episode = await createScene(pool, { sceneIndex: 1 });
  await createScene(pool, { sceneIndex: 2, episodeId: episode.episodeId });
  await createScene(pool, { sceneIndex: 4, episodeId: episode.episodeId });

  const response = await app.inject({
    method: 'GET',
    url: '/api/movie/playlist?afterSceneIndex=2',
  });
  expect(response.statusCode).toBe(200);
  expect(
    response.json<{ scenes: PlaylistEntry[] }>().scenes.map((entry) => entry.sceneIndex),
  ).toEqual([4]);
});

// §17.32「被下架片段立即从播放清单……中消失；scene_index 不回收、不重排」.
test('已下架片段被剔除，其余编号不重排', async () => {
  const first = await createScene(pool, { sceneIndex: 1 });
  await createScene(pool, { sceneIndex: 2, episodeId: first.episodeId });
  await createScene(pool, {
    sceneIndex: 3,
    episodeId: first.episodeId,
    takedownAt: new Date(),
  });
  await createScene(pool, { sceneIndex: 4, episodeId: first.episodeId });

  expect((await playlist()).map((entry) => entry.sceneIndex)).toEqual([1, 2, 4]);

  // Taking one down later removes it from the next read, and leaves the gap.
  await pool.query(
    "UPDATE scenes SET takedown_at = now(), takedown_reason = '测试下架' WHERE scene_index = 2",
  );
  expect((await playlist()).map((entry) => entry.sceneIndex)).toEqual([1, 4]);
});

// §11「每个播放清单条目必须显式返回视频和四条字幕 URL，不能让前端拼接或猜测文件
// 名」 and §17.13「四份独立 WebVTT」.
test('每个条目显式返回视频与四条字幕 URL，全部在 /media/ 下', async () => {
  await createScene(pool, { sceneIndex: 1, durationSeconds: 15.083 });

  const entries = await playlist();
  expect(entries).toHaveLength(1);
  const entry = entries[0];

  const version = `?v=${'f'.repeat(64)}`;
  expect(entry.videoUrl).toBe(`/media/000001.mp4${version}`);
  expect(Object.keys(entry.subtitles).sort()).toEqual([...LOCALES].sort());
  expect(entry.subtitles).toEqual({
    en: `/media/000001.en.vtt${version}`,
    'zh-CN': `/media/000001.zh-CN.vtt${version}`,
    ja: `/media/000001.ja.vtt${version}`,
    es: `/media/000001.es.vtt${version}`,
  });
  for (const url of [entry.videoUrl, ...Object.values(entry.subtitles)]) {
    expect(url.startsWith('/media/')).toBe(true);
  }
  // §16.1「duration_seconds NUMERIC(6,3)」— milliseconds, not seconds.
  expect(entry.durationMs).toBe(15_083);
});

test('六位补零的编号跟随 scene_index，不是序号', async () => {
  await createScene(pool, { sceneIndex: 42 });
  const entries = await playlist();
  const version = `?v=${'f'.repeat(64)}`;
  expect(entries[0].videoUrl).toBe(`/media/000042.mp4${version}`);
  expect(entries[0].subtitles['zh-CN']).toBe(`/media/000042.zh-CN.vtt${version}`);
});

test('重拍更新影片 SHA 后生成新的 CDN URL', async () => {
  await createScene(pool, { sceneIndex: 1 });
  const before = (await playlist())[0].videoUrl;
  const replacementSha = 'a'.repeat(64);

  await pool.query(
    `UPDATE scenes
        SET media = jsonb_set(media, '{sha256}', to_jsonb($2::text))
      WHERE scene_index = $1`,
    [1, replacementSha],
  );

  const after = (await playlist())[0];
  expect(before).not.toBe(after.videoUrl);
  expect(after.videoUrl).toBe(`/media/000001.mp4?v=${replacementSha}`);
  expect(Object.values(after.subtitles)).toEqual(
    expect.arrayContaining([
      `/media/000001.en.vtt?v=${replacementSha}`,
      `/media/000001.zh-CN.vtt?v=${replacementSha}`,
    ]),
  );
});

// §11「条目携带所属 episode_index，播放器据此按集分组展示与跳转」.
test('条目携带所属 episode_index', async () => {
  const first = await createScene(pool, { sceneIndex: 1, episodeIndex: 1 });
  await createScene(pool, { sceneIndex: 2, episodeId: first.episodeId });
  await createScene(pool, { sceneIndex: 3, episodeIndex: 2 });

  expect(
    (await playlist()).map((entry) => [entry.sceneIndex, entry.episodeIndex]),
  ).toEqual([
    [1, 1],
    [2, 1],
    [3, 2],
  ]);
});

test('分享页由服务端输出可抓取的 OG 视频元数据，并转义数据库文本', async () => {
  const username = `writer-${randomUUID()}<script>`;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (username_display, username_key, guest_token_hash)
     VALUES ($1, $2, $3) RETURNING id`,
    [username, `writer-${randomUUID()}`, 'fixture-share-token'],
  );
  await createScene(pool, {
    sceneIndex: 42,
    episodeIndex: 3,
    creditUserId: user.rows[0].id,
  });
  await pool.query(
    `UPDATE scenes SET summary_zh = $2 WHERE scene_index = $1`,
    [42, '<script>alert("share")</script> 校园会议'],
  );

  const response = await app.inject({ method: 'GET', url: '/share/000042' });

  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toContain('text/html');
  expect(response.headers['cache-control']).toContain('no-transform');
  expect(response.payload).toContain('EP 03 · SCENE 000042');
  expect(response.payload).toContain(
    'property="og:url" content="https://movie.example.com/share/inland-empire-high/000042"',
  );
  expect(response.payload).toContain(
    `property="og:video" content="https://movie.example.com/media/000042.mp4?v=${'f'.repeat(64)}"`,
  );
  expect(response.payload).toContain('&lt;script&gt;alert(&quot;share&quot;)&lt;/script&gt;');
  expect(response.payload).toContain('@writer-');
  expect(response.payload).not.toContain('<script>alert');
});

test('下架片段和非法编号没有分享页，恢复后原编号重新可用', async () => {
  await createScene(pool, { sceneIndex: 7, takedownAt: new Date() });

  expect((await app.inject({ method: 'GET', url: '/share/000007' })).statusCode).toBe(404);
  expect((await app.inject({ method: 'GET', url: '/share/not-a-number' })).statusCode).toBe(404);
  expect((await app.inject({ method: 'GET', url: '/share/0' })).statusCode).toBe(404);
  expect((await app.inject({ method: 'GET', url: '/share/999999' })).statusCode).toBe(404);

  await pool.query('UPDATE scenes SET takedown_at = NULL WHERE scene_index = 7');
  const restored = await app.inject({ method: 'GET', url: '/share/000007' });
  expect(restored.statusCode).toBe(200);
  expect(restored.payload).toContain('SCENE 000007');
});

test('影片目录和详情返回最新未下架剧照，使用图片哈希更新缓存', async () => {
  const first = await createScene(pool, { sceneIndex: 1 });
  await createScene(pool, { sceneIndex: 2, episodeId: first.episodeId, takedownAt: new Date() });
  await pool.query(`UPDATE scenes SET media = media || jsonb_build_object('end_frame',
      jsonb_build_object('image', '/media/still-' || scene_index || '.png', 'sha256', repeat('a', 64)))
    WHERE movie_id=$1`, [first.movieId]);
  const expected = `/media/still-1.png?v=${'a'.repeat(64)}`;
  const catalog = await app.inject({ method: 'GET', url: '/api/movies' });
  expect(catalog.json().movies.find((movie: { id: string }) => movie.id === first.movieId).sceneStillUrl).toBe(expected);
  const detail = await app.inject({ method: 'GET', url: '/api/movies/inland-empire-high' });
  expect(detail.json().sceneStillUrl).toBe(expected);
  const other = await app.inject({ method: 'GET', url: '/api/movies/whos-next' });
  expect(other.json().sceneStillUrl).toBeNull();
});
