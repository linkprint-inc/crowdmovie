// 故事设定图片的落盘与校验（《故事设定投稿技术规范》§4.4）。
//
// The one rule worth stating plainly: the declared Content-Type does not
// decide anything. A browser can call an SVG "image/jpeg", and an SVG served
// from our own origin is an executable document — <svg onload="..."> is stored
// XSS against every reader of the board. So the first few bytes decide the
// format, and only three formats are accepted at all.
//
// Files live under `<MEDIA_DIR>/story/<proposalId>/<imageId>.<ext>` and are
// served by the same Caddy `handle_path /media/*` block as the scene videos, so
// path resolution reuses the containment rule from lib/media.ts: whatever a URL
// says, the resolved path has to stay under the media root.
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/** 2 MiB，与 `story_images_bytes_ck` 和上传路由的 bodyLimit 是同一个数字。 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export const STORY_MEDIA_PREFIX = '/media/story/';

export interface ImageType {
  mime: string;
  ext: string;
}

/**
 * Identify the image by its leading bytes, or null when it is not one of the
 * three accepted formats.
 *
 * JPEG and PNG have fixed signatures. WebP is a RIFF container, so both the
 * `RIFF` magic and the `WEBP` form type four bytes later have to match — a WAV
 * file starts with the same four bytes and is not an image.
 */
export function sniffImageType(bytes: Buffer): ImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

export function storyImageUrl(
  proposalId: string,
  imageId: string,
  ext: string,
): string {
  return `${STORY_MEDIA_PREFIX}${proposalId}/${imageId}.${ext}`;
}

/**
 * Resolve a story image URL to a path inside `mediaDir`, or null when it is not
 * one this process may open. Same containment rule as lib/media.ts: the
 * resolved path has to stay under the media root, so `/media/../../etc/passwd`
 * is refused however it is spelled.
 */
export function storyImagePath(mediaDir: string, url: string): string | null {
  if (!url.startsWith(STORY_MEDIA_PREFIX)) return null;
  const rest = url.slice('/media/'.length);
  if (rest.length === 0) return null;
  const root = resolve(mediaDir);
  const path = resolve(root, rest);
  return path.startsWith(root + sep) ? path : null;
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Write the file (creating its proposal directory) and return its URL. */
export async function writeStoryImage(
  mediaDir: string,
  proposalId: string,
  imageId: string,
  ext: string,
  bytes: Buffer,
): Promise<string> {
  const url = storyImageUrl(proposalId, imageId, ext);
  const path = storyImagePath(mediaDir, url);
  if (path === null) throw new Error(`refusing to write outside ${mediaDir}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return url;
}

/**
 * Delete the file behind a URL. Missing is not an error: replacing a slot
 * deletes the old file, and a retry of that replacement must not fail because
 * the first attempt already succeeded.
 */
export async function deleteStoryImage(
  mediaDir: string,
  url: string,
): Promise<void> {
  const path = storyImagePath(mediaDir, url);
  if (path === null) return;
  await rm(path, { force: true });
}
