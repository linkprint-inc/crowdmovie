import crypto from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  LOCALES,
  type AuthorSubtitlesOutput,
  type Locale,
} from '../ai/engine.js';
import { mediaFilePath, subtitleUrlsFor } from '../lib/media.js';


function timestamp(seconds: number): string {
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(
    2,
    '0',
  )}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export function renderWebVtt(
  subtitles: AuthorSubtitlesOutput,
  locale: Locale,
): string {
  const cues = subtitles.cues.map((cue) => {
    const id = singleLine(cue.cueId);
    const speaker = singleLine(cue.speaker);
    const text = cue.text[locale].replace(/\r\n?/g, '\n').trim();
    return `${id}\n${timestamp(cue.startSeconds)} --> ${timestamp(
      cue.endSeconds,
    )}\n${speaker}: ${text}`;
  });
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o640 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * Whether a subtitle package has anything to show. A scene without dialogue
 * publishes no sidecar and registers no subtitle URL: an empty `<track>` is not
 * harmless on iOS, where WebKit hands every track to AVFoundation with the video
 * and one unusable track fails the whole asset.
 */
export function hasSubtitleCues(subtitles: AuthorSubtitlesOutput): boolean {
  return subtitles.cues.length > 0;
}

export async function writeSubtitleSidecars(
  mediaDir: string,
  videoUrl: string,
  subtitles: AuthorSubtitlesOutput,
): Promise<void> {
  if (!hasSubtitleCues(subtitles)) return;
  const urls = subtitleUrlsFor(videoUrl);
  await Promise.all(
    LOCALES.map(async (locale, index) => {
      const path = mediaFilePath(mediaDir, urls[index]);
      if (path === null) {
        throw new Error(`subtitle URL ${urls[index]} is outside ${mediaDir}`);
      }
      await atomicWrite(path, renderWebVtt(subtitles, locale));
    }),
  );
}
