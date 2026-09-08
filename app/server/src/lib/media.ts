// 媒体落盘校验 — the file half of §5 step 5「检查MP4、时长、音轨和字幕文件」and
// of §17.16「H3输出验证通过后才能加入播放列表和剧情正史」.
//
// One rule, stated once: a `scenes` row may only exist for media that is
// actually on disk. §5 spells out what "on disk" means —「要求视频与英、中、日、
// 西四份字幕文件全部就绪；任一缺失或校验失败即进入 validation_failed」— so all
// five files are checked, and the MP4 is additionally handed to ffprobe, because
// a zero-byte or truncated file exists without being playable.
//
// What this module deliberately does **not** do is measure the duration that
// gets stored. §16.1's `duration_seconds ffprobe 实测` enters the pipeline once,
// at generation time (jobs/handlers/video.ts), and travels through subtitle
// authoring — `validateSubtitles` requires the subtitle package to name that
// exact number — into the publish payload. Probing a second time here and using
// *that* number would give the movie two measurements of one file and let them
// disagree over a rounding digit. The probe below is a gate: it decides whether
// the file is a usable video at all, not how long the scene is recorded as.
import { execFile as execFileCallback } from 'node:child_process';
import crypto from 'node:crypto';
import { access, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { LOCALES } from '../ai/engine.js';

const execFile = promisify(execFileCallback);

/** Where Caddy's `handle_path /media/*` block is rooted, as a URL prefix. */
export const MEDIA_URL_PREFIX = '/media/';

/**
 * Resolve a `/media/...` URL to a path inside `mediaDir`, or null when it is not
 * one this process may open.
 *
 * The URL comes from our own pipeline, but it still ends up as a filesystem
 * path, so the resolved result is required to stay under the media root:
 * `/media/../../etc/passwd` resolves outside it and is refused. Subdirectories
 * *are* allowed — generation output lives at `/media/pending/<round>.mp4` (§11
 * 「失败和重试任务使用内部任务 ID，不占用正式电影编号」) before it is given an
 * official number.
 */
export function mediaFilePath(mediaDir: string, url: string): string | null {
  if (!url.startsWith(MEDIA_URL_PREFIX)) return null;
  const rest = url.slice(MEDIA_URL_PREFIX.length);
  if (rest.length === 0) return null;
  const root = resolve(mediaDir);
  const path = resolve(root, rest);
  return path.startsWith(root + sep) ? path : null;
}

/**
 * The four §17.13 sidecars that belong to a video URL: same stem, one `.vtt` per
 * §10 locale. Mirrors `sceneMediaPaths()` in jobs/handlers/publish.ts, but works
 * from a path rather than from a scene number, so it also covers the pending
 * file a round is validated as before it has a number.
 */
export function subtitleUrlsFor(videoUrl: string): string[] {
  const stem = videoUrl.endsWith('.mp4')
    ? videoUrl.slice(0, -'.mp4'.length)
    : videoUrl;
  return LOCALES.map((locale) => `${stem}.${locale}.vtt`);
}

export type MediaVerdict =
  | { ok: true; probedDurationSeconds: number }
  | { ok: false; reason: string };

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function validEndFrame(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFile('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0:s=x',
      path,
    ]);
    return stdout.trim() === '1344x768';
  } catch {
    return false;
  }
}

/** Extract and hash an immutable 1344x768 last frame as media metadata only. */
export async function extractEndFrame(
  mediaDir: string,
  videoUrl: string,
  pngUrl: string,
): Promise<{ sha256: string } | { error: string }> {
  const video = mediaFilePath(mediaDir, videoUrl);
  const png = mediaFilePath(mediaDir, pngUrl);
  if (video === null || png === null) {
    return { error: 'end-frame path escaped MEDIA_DIR' };
  }
  if (!(await validEndFrame(png))) {
    await unlink(png).catch(() => undefined);
    await mkdir(dirname(png), { recursive: true });
    const temporary = `${png}.${crypto.randomUUID()}.part.png`;
    try {
      let frameCount = 0;
      try {
        const { stdout } = await execFile('ffprobe', [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=nb_frames',
          '-of',
          'csv=p=0',
          video,
        ]);
        frameCount = Number.parseInt(stdout.trim(), 10);
      } catch {
        frameCount = 0;
      }
      if (Number.isInteger(frameCount) && frameCount > 0) {
        await execFile('ffmpeg', [
          '-v',
          'error',
          '-i',
          video,
          '-vf',
          `select=eq(n\\,${frameCount - 1})`,
          '-frames:v',
          '1',
          '-y',
          temporary,
        ]);
      } else {
        await execFile('ffmpeg', [
          '-v',
          'error',
          '-sseof',
          '-0.05',
          '-i',
          video,
          '-frames:v',
          '1',
          '-y',
          temporary,
        ]);
      }
      if (!(await validEndFrame(temporary))) {
        throw new Error('extracted end frame is not 1344x768');
      }
      await rename(temporary, png);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      return {
        error: `end-frame extraction failed: ${(error as Error).message}`,
      };
    }
  }
  const bytes = await readFile(png);
  return { sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

/**
 * Ask ffprobe for the container duration. Returns null when the file is not a
 * media file ffprobe can read at all (it exits non-zero, which rejects here) or
 * when it reports no usable duration — both of which mean "not playable".
 */
export type GeneratedVideoVerdict =
  | { ok: true; durationSeconds: number }
  | { ok: false; reason: string };

/** Probe both required tracks and fully decode them once before publication. */
export async function inspectGeneratedVideo(
  path: string,
): Promise<GeneratedVideoVerdict> {
  let stdout: string;
  try {
    ({ stdout } = await execFile('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type',
      '-of',
      'json',
      path,
    ]));
  } catch {
    return { ok: false, reason: `${path} is not a probeable video file` };
  }
  let probe: {
    format?: { duration?: string };
    streams?: { codec_type?: string }[];
  };
  try {
    probe = JSON.parse(stdout) as typeof probe;
  } catch {
    return { ok: false, reason: `${path} is not a probeable video file` };
  }
  const seconds = Number(probe.format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { ok: false, reason: `${path} is not a probeable video file` };
  }
  const types = new Set((probe.streams ?? []).map((stream) => stream.codec_type));
  if (!types.has('video') || !types.has('audio')) {
    return { ok: false, reason: `${path} must contain video and audio tracks` };
  }
  try {
    await execFile('ffmpeg', [
      '-v',
      'error',
      '-i',
      path,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-f',
      'null',
      '-',
    ]);
  } catch {
    return { ok: false, reason: `${path} cannot be fully decoded` };
  }
  return { ok: true, durationSeconds: seconds };
}

/**
 * The publish gate. `ok` only when the MP4 and all four WebVTT sidecars named by
 * `videoUrl` exist under `mediaDir` and the MP4 probes as a real video. A scene
 * without dialogue has no sidecars to check (`subtitles: false`): only its MP4.
 *
 * A failure is reported rather than thrown: §5 makes missing media a *decided*
 * outcome (`validation_failed`), not a transient error worth retrying — the file
 * will not appear on the fifth attempt if it did not appear on the first.
 */
export async function verifySceneMedia(
  mediaDir: string,
  videoUrl: string,
  options: { subtitles?: boolean } = {},
): Promise<MediaVerdict> {
  const urls =
    options.subtitles === false
      ? [videoUrl]
      : [videoUrl, ...subtitleUrlsFor(videoUrl)];
  const paths: string[] = [];
  for (const url of urls) {
    const path = mediaFilePath(mediaDir, url);
    if (path === null) {
      return { ok: false, reason: `media URL ${url} is not under ${mediaDir}` };
    }
    paths.push(path);
  }

  const present = await Promise.all(paths.map(exists));
  const missing = urls.filter((_, index) => !present[index]);
  if (missing.length > 0) {
    return { ok: false, reason: `media files are missing: ${missing.join(', ')}` };
  }

  const inspected = await inspectGeneratedVideo(paths[0]);
  if (!inspected.ok) {
    // Keep the public/internal URL in the message rather than leaking the
    // service's absolute media path into logs or state-machine errors.
    return {
      ok: false,
      reason: inspected.reason.replace(paths[0], videoUrl),
    };
  }
  return { ok: true, probedDurationSeconds: inspected.durationSeconds };
}
