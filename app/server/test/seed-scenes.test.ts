// 种子片段脚本 —《技术》§10 字幕文件、§11 编号与播放清单、§16.1 scenes 字段。
//
// The four production clips live outside the repository (`artifacts/` is
// gitignored), so this suite generates its own MP4s with ffmpeg — deliberately
// at *different* durations, which is what lets the "measured, not assumed"
// assertion below mean something. Everything else is the real thing: the real
// ffprobe call, the real copy-and-verify, the real WebVTT files and the real
// rows.
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import pg from 'pg';

import { LOCALES } from '../src/ai/engine';
import { runMigrations } from '../src/db/migrate';
import { seedScenes, TAKEDOWN_REASON } from '../src/db/seed-scenes';
import { buildApp } from '../src/web/app';
import { ensureDatabase, resetStory, testConfig, TEST_URL } from './helpers';
import { createScene } from './scene-fixture';

const execFile = promisify(execFileCallback);

/** Distinct durations, so a hard-coded constant cannot pass for a measurement. */
const CLIP_SECONDS = [1.2, 1.5, 2, 2.4];
const CLIPS = CLIP_SECONDS.map((_, i) => `segment-0${i + 1}.mp4`);

let pool: pg.Pool;
let app: ReturnType<typeof buildApp>;
let sourceDir: string;
let mediaDir: string;

beforeAll(async () => {
  await ensureDatabase();
  await runMigrations(TEST_URL);
  pool = new pg.Pool({ connectionString: TEST_URL });
  app = buildApp(testConfig, pool);
  await app.ready();

  sourceDir = await mkdtemp(join(tmpdir(), 'cm-seed-src-'));
  for (const [i, seconds] of CLIP_SECONDS.entries()) {
    await execFile('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=black:s=160x120:r=12:d=${seconds}`,
      '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=mono:d=${seconds}`,
      '-shortest',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      join(sourceDir, CLIPS[i]),
    ]);
  }
}, 120_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  if (sourceDir !== undefined) await rm(sourceDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetStory(pool);
  if (mediaDir !== undefined) await rm(mediaDir, { recursive: true, force: true });
  mediaDir = await mkdtemp(join(tmpdir(), 'cm-seed-media-'));
});

function seed() {
  return seedScenes(pool, { sourceDir, mediaDir, clips: CLIPS });
}

async function playlist(): Promise<
  Array<{ sceneIndex: number; videoUrl: string; durationMs: number; subtitles: Record<string, string> }>
> {
  const response = await app.inject({ method: 'GET', url: '/api/movie/playlist' });
  expect(response.statusCode).toBe(200);
  return response.json<{ scenes: Awaited<ReturnType<typeof playlist>> }>().scenes;
}

test('四个片段落地：文件、四语字幕、连续编号与实测时长', async () => {
  const report = await seed();
  expect(report.scenes.map((scene) => scene.created)).toEqual([
    true,
    true,
    true,
    true,
  ]);

  const indexes = report.scenes.map((scene) => scene.sceneIndex);
  expect(indexes).toEqual([1, 2, 3, 4]);

  const entries = await playlist();
  expect(entries.map((entry) => entry.sceneIndex)).toEqual([1, 2, 3, 4]);

  const files = new Set(await readdir(mediaDir));
  for (const [i, entry] of entries.entries()) {
    expect(entry.videoUrl).toMatch(
      new RegExp(`^/media/00000${i + 1}\\.mp4\\?v=[a-f0-9]{64}$`),
    );
    expect(files.has(`00000${i + 1}.mp4`)).toBe(true);
    // §17.13 的四份独立 WebVTT，逐一存在。
    for (const locale of LOCALES) {
      expect(entry.subtitles[locale]).toMatch(
        new RegExp(`^/media/00000${i + 1}\\.${locale}\\.vtt\\?v=[a-f0-9]{64}$`),
      );
      expect(files.has(`00000${i + 1}.${locale}.vtt`)).toBe(true);
    }
    // §16.1「duration_seconds ffprobe 实测」— each clip keeps its own length,
    // to the tolerance a keyframe-aligned encode allows.
    expect(entry.durationMs / 1000).toBeCloseTo(CLIP_SECONDS[i], 1);
  }
  // Four distinct durations survived; a constant would have collapsed them.
  expect(new Set(entries.map((entry) => entry.durationMs)).size).toBe(4);
});

test('字幕是诚实的占位说明，不编造台词', async () => {
  await seed();
  const en = await readFile(join(mediaDir, '000001.en.vtt'), 'utf8');
  expect(en.startsWith('WEBVTT')).toBe(true);
  expect(en).toContain('-->');
  expect(en.toLowerCase()).toContain('preview clip 1 of 4');
  expect(en.toLowerCase()).toContain('no dialogue');

  const zh = await readFile(join(mediaDir, '000002.zh-CN.vtt'), 'utf8');
  expect(zh).toContain('预览片段 2/4');
  expect(await readFile(join(mediaDir, '000003.ja.vtt'), 'utf8')).toContain(
    'プレビュークリップ 3/4',
  );
  expect(await readFile(join(mediaDir, '000004.es.vtt'), 'utf8')).toContain(
    'vista previa 4 de 4',
  );

  // The cue spans the measured clip, not a constant.
  const cue = /(\d\d:\d\d:\d\d\.\d\d\d) --> (\d\d:\d\d:\d\d\.\d\d\d)/.exec(en);
  expect(cue?.[1]).toBe('00:00:00.000');
  expect(cue?.[2]).toMatch(/^00:00:0[12]\./);
});

test('重复执行是幂等的：不新增片段，也不换编号', async () => {
  const first = await seed();
  const second = await seed();

  expect(second.scenes.map((scene) => scene.created)).toEqual([
    false,
    false,
    false,
    false,
  ]);
  expect(second.scenes.map((scene) => scene.sceneIndex)).toEqual(
    first.scenes.map((scene) => scene.sceneIndex),
  );

  const count = await pool.query<{ n: string }>('SELECT count(*) AS n FROM scenes');
  expect(Number(count.rows[0].n)).toBe(4);
  expect((await playlist()).map((entry) => entry.sceneIndex)).toEqual([1, 2, 3, 4]);
});

test('文件被误删后重跑会补回来，而不是新建片段', async () => {
  await seed();
  await unlink(join(mediaDir, '000002.mp4'));
  await unlink(join(mediaDir, '000002.ja.vtt'));

  const report = await seed();
  expect(report.scenes.map((scene) => scene.created)).toEqual([
    false,
    false,
    false,
    false,
  ]);
  expect(report.takenDown).toEqual([]);
  const files = new Set(await readdir(mediaDir));
  expect(files.has('000002.mp4')).toBe(true);
  expect(files.has('000002.ja.vtt')).toBe(true);
  const count = await pool.query<{ n: string }>('SELECT count(*) AS n FROM scenes');
  expect(Number(count.rows[0].n)).toBe(4);
});

// The reconciliation that makes this runnable against the live database: the
// M3 stub publisher writes `scenes` rows whose media files were never created
// (handlers/publish.ts defers the file half to M5), and an unplayable row must
// not sit in the playlist (§17.32).
test('没有媒体文件的既有片段被下架，种子片段接在其后', async () => {
  const stub = await createScene(pool, { sceneIndex: 1 });
  const stubTwo = await createScene(pool, { sceneIndex: 2 });
  expect((await playlist()).map((entry) => entry.sceneIndex)).toEqual([1, 2]);

  const report = await seed();
  expect(report.takenDown).toEqual([stub.sceneIndex, stubTwo.sceneIndex]);
  expect(report.scenes.map((scene) => scene.sceneIndex)).toEqual([3, 4, 5, 6]);

  // §16.1「scene_index 永不回收、永不重排」— the stub rows keep their numbers.
  const rows = await pool.query<{
    scene_index: number;
    takedown_at: Date | null;
    takedown_reason: string | null;
  }>('SELECT scene_index, takedown_at, takedown_reason FROM scenes ORDER BY scene_index');
  expect(rows.rows.map((row) => row.scene_index)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(rows.rows[0].takedown_at).not.toBeNull();
  expect(rows.rows[0].takedown_reason).toBe(TAKEDOWN_REASON);
  expect(rows.rows[5].takedown_at).toBeNull();

  expect((await playlist()).map((entry) => entry.sceneIndex)).toEqual([3, 4, 5, 6]);
});

test('有媒体文件的片段永远不会被这个脚本下架', async () => {
  await seed();
  const second = await seed();
  expect(second.takenDown).toEqual([]);
  const live = await pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM scenes WHERE takedown_at IS NULL',
  );
  expect(Number(live.rows[0].n)).toBe(4);
});

test('每个种子片段的外键都成立，且不署名任何用户', async () => {
  await seed();
  const rows = await pool.query<{
    scene_index: number;
    credit_user_id: string | null;
    source_submission_id: string | null;
    round_status: string;
    director_provider: string;
    subtitle_provider: string;
  }>(
    `SELECT s.scene_index, s.credit_user_id, s.source_submission_id,
            r.status AS round_status,
            d.provider AS director_provider, t.provider AS subtitle_provider
       FROM scenes s
       JOIN rounds r ON r.id = s.round_id
       JOIN ai_runs d ON d.id = s.director_ai_run_id
       JOIN ai_runs t ON t.id = s.subtitle_ai_run_id
      ORDER BY s.scene_index`,
  );
  expect(rows.rows).toHaveLength(4);
  for (const row of rows.rows) {
    // 自动续写为 NULL (§16.1): nobody wrote these, so nobody is credited.
    expect(row.credit_user_id).toBeNull();
    expect(row.source_submission_id).toBeNull();
    // A seeded round must never look like the open one to the 5-minute clock.
    expect(row.round_status).toBe('published');
    // §6.6 留痕 records that no model ran.
    expect(row.director_provider).toBe('seed');
    expect(row.subtitle_provider).toBe('seed');
  }
});

test('种子轮次不会挡住五分钟时钟的下一轮', async () => {
  await seed();
  const { tick } = await import('../src/rounds/clock');
  const result = await tick(pool);
  expect(result.ran).toBe(true);
  expect(result.openRoundId).not.toBeNull();

  const open = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM rounds WHERE status = 'open'",
  );
  expect(Number(open.rows[0].n)).toBe(1);
});
