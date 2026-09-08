// 没有对白的片段：播放清单不登记字幕 URL，分享页不输出 <track>。
import pg from 'pg';

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

/** A published scene whose media document registers no subtitle at all. */
async function createSilentScene(sceneIndex: number): Promise<void> {
  await createScene(pool, { sceneIndex });
  await pool.query(
    `UPDATE scenes SET media = jsonb_set(media, '{subtitles}', '{}'::jsonb)
      WHERE scene_index = $1`,
    [sceneIndex],
  );
}

test('没有对白的片段：播放清单条目不带任何字幕 URL', async () => {
  await createSilentScene(1);

  const response = await app.inject({ method: 'GET', url: '/api/movie/playlist' });
  expect(response.statusCode).toBe(200);
  const [entry] = response.json<{
    scenes: { videoUrl: string; subtitles: Record<string, string>; tracks: unknown[] }[];
  }>().scenes;
  expect(entry.videoUrl).toBe(`/media/000001.mp4?v=${'f'.repeat(64)}`);
  expect(entry.subtitles).toEqual({});
  expect(entry.tracks).toEqual([]);
});

test('没有对白的片段：分享页不输出 <track>', async () => {
  await createSilentScene(7);

  const response = await app.inject({ method: 'GET', url: '/share/000007' });
  expect(response.statusCode).toBe(200);
  expect(response.payload).toContain('SCENE 000007');
  expect(response.payload).not.toContain('<track');
});
