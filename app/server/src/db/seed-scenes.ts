// Seed the movie with the four pre-existing sample clips, so the player has
// real content and 弹幕 has something to anchor to (§14.1 requires a published
// scene). M4/M5 — the Codex director and the H3 generation that would produce
// scenes for real — are deferred, so nothing else can currently put a playable
//片段 on the site.
//
// Run it:
//   SEED_SOURCE_DIR=/var/lib/crowdmovie/seed-source \
//   DATABASE_URL=postgresql://... node dist/db/seed-scenes.js
//
// It is idempotent, and safe to run against production:
//   * A clip is identified by the SHA-256 of its bytes, which is also what goes
//     into `scenes.media.sha256`. A second run finds the scene it created last
//     time and only re-verifies it, so re-running never mints a second copy —
//     and never needs a marker row to remember itself by.
//   * It takes the same two advisory locks the live system uses
//     (`CLOCK_LOCK_KEY` in rounds/clock.ts, `SCENE_INDEX_LOCK_KEY` in
//     handlers/publish.ts), so a seeded round cannot collide with the five-minute
//     clock's `max(round_index)+1` and a seeded scene cannot collide with the
//     publisher's `max(scene_index)+1`.
//   * It never deletes a row and never renumbers one (§16.1「scene_index 永不回
//     收、永不重排」). The only thing it changes about existing data is the
//     reconciliation pass below.
//
// **Reconciling the stub-produced scenes.** The worker currently runs the M3
// stub content engine, and its publish step does not yet check that the media
// files exist (handlers/publish.ts says so: "M5 owns the file half"). So
// production has accumulated `scenes` rows that name `/media/000001.mp4` and
// friends with no file behind them, and it gains one more every five minutes.
// Those rows are taken down here — `takedown_at` + a reason — rather than
// overwritten with real media:
//   * There is more than one of them and their number grows, so "reuse it as
//     scene 1" does not describe a stable target.
//   * The first of them credits a real user for a real 投稿. Rewriting its media
//     to a preview clip would attribute footage to a pitch it does not depict.
//   * Takedown is the operation the spec already has for "this 片段 must leave
//     the playlist" (§17.32), it keeps the row auditable, and it leaves
//     `scene_index` contiguous and unrenumbered.
// The seeded scenes therefore start after the stub ones rather than at 1, and
// the media filenames follow their real `scene_index` per §11.
//
// The predicate for "stub" is deliberately not a string match on the summary:
// it is "this scene's video file does not exist on disk". A scene that cannot
// be played must not be in the playlist, whoever wrote it — and a scene whose
// file is present is never touched by this script.
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Pool, type PoolClient } from 'pg';

import { LOCALES, type Locale } from '../ai/engine.js';
import { SCENE_INDEX_LOCK_KEY, sceneMediaPaths } from '../jobs/handlers/publish.js';
import { INLAND_EMPIRE_MOVIE_ID } from '../movies/catalog.js';
import { CLOCK_LOCK_KEY, ensureOpenEpisode } from '../rounds/clock.js';
import { withTransaction } from './tx.js';

const execFile = promisify(execFileCallback);

/** The four clips, in the order they become scenes. */
export const SEED_CLIPS = [
  'segment-01.mp4',
  'segment-02.mp4',
  'segment-03.mp4',
  'segment-04.mp4',
];

const DEFAULT_MEDIA_DIR = '/var/lib/crowdmovie/media';

/** Where Caddy's `handle_path /media/*` block is rooted, as a URL prefix. */
const MEDIA_URL_PREFIX = '/media/';

export const TAKEDOWN_REASON =
  'seed-scenes: 片段媒体文件不存在，无法播放（M3 stub 发布，未经 M5 文件校验）';

/**
 * The placeholder cue, in each of the four §10 languages. It says what the clip
 * actually is. No dialogue is invented for it: these scenes were never written,
 * and a subtitle that reads like canon would put words into the movie that
 * nobody submitted and no model produced.
 */
function placeholderCue(locale: Locale, position: number, total: number): string {
  switch (locale) {
    case 'en':
      return `[Preview clip ${position} of ${total} — seeded sample footage, not a generated scene. No dialogue has been written for it.]`;
    case 'zh-CN':
      return `[预览片段 ${position}/${total} —— 种子样片，不是生成的正片，尚未创作任何台词。]`;
    case 'ja':
      return `[プレビュークリップ ${position}/${total} —— シード用のサンプル映像で、生成された本編ではありません。台詞はまだ書かれていません。]`;
    case 'es':
      return `[Clip de vista previa ${position} de ${total}: material de muestra, no una escena generada. Todavía no se ha escrito ningún diálogo.]`;
  }
}

/** `00:00:15.083` — WebVTT's timestamp form. */
function vttTimestamp(seconds: number): string {
  const whole = Math.floor(seconds);
  const millis = Math.round((seconds - whole) * 1000);
  const hh = String(Math.floor(whole / 3600)).padStart(2, '0');
  const mm = String(Math.floor((whole % 3600) / 60)).padStart(2, '0');
  const ss = String(whole % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}.${String(millis).padStart(3, '0')}`;
}

/**
 * A one-cue WebVTT file spanning the whole clip. §10「字幕不合成进视频」— these
 * are sidecar files loaded through `<track>`, never burned in and never muxed.
 */
export function placeholderVtt(
  locale: Locale,
  durationSeconds: number,
  position: number,
  total: number,
): string {
  return [
    'WEBVTT',
    '',
    '1',
    `${vttTimestamp(0)} --> ${vttTimestamp(durationSeconds)}`,
    placeholderCue(locale, position, total),
    '',
  ].join('\n');
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * The clip's real duration, measured. §16.1 says `duration_seconds` is
 * 「ffprobe 实测」and NUMERIC(6,3), so it is read from the file rather than
 * taken from a constant, and rounded to the column's precision.
 */
async function probeDurationSeconds(path: string): Promise<number> {
  const { stdout } = await execFile('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    path,
  ]);
  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`ffprobe returned no usable duration for ${path}`);
  }
  return Math.round(seconds * 1000) / 1000;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** `/media/000003.mp4` → `<mediaDir>/000003.mp4`, or null if it is not a
 *  `/media/` URL this script is able to reason about. */
function mediaFilePath(mediaDir: string, url: string): string | null {
  if (!url.startsWith(MEDIA_URL_PREFIX)) return null;
  const name = url.slice(MEDIA_URL_PREFIX.length);
  // The value comes from our own database, but it ends up in a filesystem path,
  // so it is reduced to a bare filename before it gets there.
  if (name.length === 0 || name !== basename(name)) return null;
  return join(mediaDir, name);
}

interface SeedClip {
  file: string;
  sourcePath: string;
  sha256: string;
  durationSeconds: number;
}

interface SeededScene {
  sceneIndex: number;
  created: boolean;
  note?: string;
}

/** Write the MP4 and its four WebVTT sidecars for a scene that is about to
 *  exist, and verify the copy byte-for-byte. */
async function writeSceneMedia(
  mediaDir: string,
  sceneIndex: number,
  clip: SeedClip,
  position: number,
  total: number,
): Promise<void> {
  const paths = sceneMediaPaths(sceneIndex);
  const videoPath = mediaFilePath(mediaDir, paths.video);
  if (videoPath === null) throw new Error(`unusable media URL ${paths.video}`);

  if (!(await exists(videoPath)) || (await sha256File(videoPath)) !== clip.sha256) {
    await copyFile(clip.sourcePath, videoPath);
    const copied = await sha256File(videoPath);
    if (copied !== clip.sha256) {
      throw new Error(
        `copy of ${clip.file} to ${videoPath} does not match the source digest`,
      );
    }
  }

  // §17.13「每个片段必须发布 .en.vtt、.zh-CN.vtt、.ja.vtt、.es.vtt 四份独立
  // WebVTT」— all four, every time, or the scene is not publishable.
  for (const locale of LOCALES) {
    const subtitlePath = mediaFilePath(mediaDir, paths.subtitles[locale]);
    if (subtitlePath === null) {
      throw new Error(`unusable subtitle URL ${paths.subtitles[locale]}`);
    }
    await writeFile(
      subtitlePath,
      placeholderVtt(locale, clip.durationSeconds, position, total),
      'utf8',
    );
  }
}

/** Create the round and the two `ai_runs` rows a `scenes` row's NOT NULL
 *  foreign keys require. They record that no model ran, because none did. */
async function createProvenance(
  client: PoolClient,
  movieId: string,
  episodeId: string,
  clip: SeedClip,
): Promise<{ roundId: string; directorRunId: string; subtitleRunId: string }> {
  // `status='published'` and a closed window, so the five-minute clock never
  // mistakes a seeded round for the open one (rounds/clock.ts selects on
  // `status='open'`).
  const round = await client.query<{ id: string }>(
    `INSERT INTO rounds (movie_id, round_index, episode_id, status, opens_at, closes_at)
     VALUES ($1, (SELECT coalesce(max(round_index), 0) + 1
                    FROM rounds WHERE movie_id = $1),
             $2, 'published', now(), now())
     RETURNING id`,
    [movieId, episodeId],
  );
  const roundId = round.rows[0].id;

  const runIds: string[] = [];
  for (const runType of ['scene_director', 'scene_subtitles'] as const) {
    // §6.6 是全部模型调用留痕. Provider/model/effort say `seed`/`none`/`none`
    // because this scene came from a file, not from a model — an audit row that
    // claimed `openai_codex`/`gpt-5.6-sol` here would be a false one.
    const run = await client.query<{ id: string }>(
      `INSERT INTO ai_runs (movie_id, round_id, run_type, provider, model, reasoning_effort,
                            status, output_json, finished_at)
       VALUES ($1, $2, $3, 'seed', 'none', 'none', 'succeeded', $4::jsonb, now())
       RETURNING id`,
      [
        movieId,
        roundId,
        runType,
        JSON.stringify({
          seeded: true,
          note: 'seed-scenes.ts: sample clip, no model call',
          sourceFile: clip.file,
          sha256: clip.sha256,
        }),
      ],
    );
    runIds.push(run.rows[0].id);
  }

  return { roundId, directorRunId: runIds[0], subtitleRunId: runIds[1] };
}

/**
 * Ensure one seeded scene exists for `clip`. Returns the `scene_index` it lives
 * at, whether this run created it or found it.
 */
async function seedClip(
  pool: Pool,
  mediaDir: string,
  clip: SeedClip,
  position: number,
  total: number,
): Promise<SeededScene> {
  return withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [CLOCK_LOCK_KEY]);
    await client.query('SELECT pg_advisory_xact_lock($1)', [SCENE_INDEX_LOCK_KEY]);

    // Idempotency: the clip's own digest. Taken-down rows are matched too, so a
    // scene an operator deliberately removed is reported and left alone rather
    // than silently re-created under a new number.
    const existing = await client.query<{
      scene_index: number;
      takedown_at: Date | null;
    }>(
      `SELECT scene_index, takedown_at FROM scenes
        WHERE movie_id = $1 AND media->>'sha256' = $2
        ORDER BY scene_index LIMIT 1`,
      [INLAND_EMPIRE_MOVIE_ID, clip.sha256],
    );
    const found = existing.rows[0];
    if (found !== undefined) {
      if (found.takedown_at !== null) {
        return {
          sceneIndex: found.scene_index,
          created: false,
          note: 'already seeded but taken down — left alone',
        };
      }
      // Self-healing: the row is right, so make sure the files it names are
      // still there and still correct.
      await writeSceneMedia(mediaDir, found.scene_index, clip, position, total);
      return { sceneIndex: found.scene_index, created: false };
    }

    const movieId = INLAND_EMPIRE_MOVIE_ID;
    const episode = await ensureOpenEpisode(client, movieId);
    const provenance = await createProvenance(client, movieId, episode.id, clip);

    // Same allocation rule as handlers/publish.ts, under the same lock:
    // one past the highest that has ever existed.
    const next = await client.query<{ scene_index: number }>(
      `SELECT coalesce(max(scene_index), 0) + 1 AS scene_index
         FROM scenes WHERE movie_id = $1`,
      [movieId],
    );
    const sceneIndex = next.rows[0].scene_index;
    const paths = sceneMediaPaths(sceneIndex);

    // The files are written before COMMIT: a `scenes` row must never become
    // visible to the playlist without the media it names.
    await writeSceneMedia(mediaDir, sceneIndex, clip, position, total);

    await client.query(
      `INSERT INTO scenes
         (movie_id, scene_index, episode_id, round_id, credit_user_id, source_submission_id,
          summary_zh, duration_seconds, media, director_ai_run_id,
          subtitle_ai_run_id, episode_should_end, published_at)
       VALUES ($1, $2, $3, $4, NULL, NULL, $5, $6, $7::jsonb, $8, $9, false, now())`,
      [
        movieId,
        sceneIndex,
        episode.id,
        provenance.roundId,
        `种子预览片段 ${position}/${total}：样片 ${clip.file}，非生成正片，无台词。`,
        clip.durationSeconds,
        JSON.stringify({
          video: paths.video,
          sha256: clip.sha256,
          subtitles: paths.subtitles,
        }),
        provenance.directorRunId,
        provenance.subtitleRunId,
      ],
    );

    return { sceneIndex, created: true };
  });
}

/**
 * Take down every live scene whose video file is not on disk. Returns the
 * indexes it removed from the playlist.
 */
export async function reconcileMissingMedia(
  pool: Pool,
  mediaDir: string,
): Promise<number[]> {
  const live = await pool.query<{
    movie_id: string;
    scene_index: number;
    video: string | null;
  }>(
    `SELECT movie_id, scene_index, media->>'video' AS video
       FROM scenes WHERE takedown_at IS NULL ORDER BY scene_index`,
  );

  const removed: number[] = [];
  for (const row of live.rows) {
    const path = row.video === null ? null : mediaFilePath(mediaDir, row.video);
    // A row whose media URL this script cannot resolve is left alone: it is not
    // evidence of a missing file, only of an unexpected one.
    if (path === null) {
      console.warn(
        `[seed-scenes] scene ${row.scene_index}: unresolvable media URL ${String(row.video)}, skipped`,
      );
      continue;
    }
    if (await exists(path)) continue;

    await pool.query(
      `UPDATE scenes SET takedown_at = now(), takedown_reason = $3
        WHERE movie_id = $1 AND scene_index = $2 AND takedown_at IS NULL`,
      [row.movie_id, row.scene_index, TAKEDOWN_REASON],
    );
    removed.push(row.scene_index);
  }
  return removed;
}

export interface SeedOptions {
  sourceDir: string;
  mediaDir: string;
  clips?: string[];
}

export interface SeedReport {
  scenes: SeededScene[];
  takenDown: number[];
}

export async function seedScenes(
  pool: Pool,
  options: SeedOptions,
): Promise<SeedReport> {
  const files = options.clips ?? SEED_CLIPS;
  await mkdir(options.mediaDir, { recursive: true });

  const clips: SeedClip[] = [];
  for (const file of files) {
    const sourcePath = resolve(options.sourceDir, file);
    if (!(await exists(sourcePath))) {
      throw new Error(`source clip ${sourcePath} does not exist`);
    }
    clips.push({
      file,
      sourcePath,
      sha256: await sha256File(sourcePath),
      durationSeconds: await probeDurationSeconds(sourcePath),
    });
  }

  const scenes: SeededScene[] = [];
  for (const [index, clip] of clips.entries()) {
    scenes.push(
      await seedClip(pool, options.mediaDir, clip, index + 1, clips.length),
    );
  }

  // After seeding, so a scene created by this run is never a candidate.
  const takenDown = await reconcileMissingMedia(pool, options.mediaDir);
  return { scenes, takenDown };
}

// --- script entry point -------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const url =
    process.env.SEED_DATABASE_URL ??
    process.env.MIGRATE_DATABASE_URL ??
    process.env.DATABASE_URL;
  const sourceDir = process.env.SEED_SOURCE_DIR;
  if (url === undefined || url.length === 0) {
    console.error(
      '[seed-scenes] SEED_DATABASE_URL, MIGRATE_DATABASE_URL or DATABASE_URL is required',
    );
    process.exit(1);
  }
  if (sourceDir === undefined || sourceDir.length === 0) {
    console.error('[seed-scenes] SEED_SOURCE_DIR is required');
    process.exit(1);
  }

  const mediaDir = process.env.SEED_MEDIA_DIR ?? DEFAULT_MEDIA_DIR;
  const pool = new Pool({ connectionString: url });
  try {
    const report = await seedScenes(pool, { sourceDir, mediaDir });
    for (const scene of report.scenes) {
      const state = scene.created ? 'created' : 'already present';
      const note = scene.note === undefined ? '' : ` (${scene.note})`;
      console.log(`[seed-scenes] scene ${scene.sceneIndex}: ${state}${note}`);
    }
    console.log(
      report.takenDown.length === 0
        ? '[seed-scenes] no scenes needed taking down'
        : `[seed-scenes] took down scenes with no media file: ${report.takenDown.join(', ')}`,
    );
  } finally {
    await pool.end();
  }
}
