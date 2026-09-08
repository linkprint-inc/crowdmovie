import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { LOCALES, type SubtitleCue, type AuthorSubtitlesOutput } from '../ai/engine.js';
import { validateSubtitles } from '../ai/validate.js';
import { mediaFilePath } from '../lib/media.js';
import { masterAudioVariant } from './film-audio.js';
import { renderWebVtt } from './vtt.js';

const execFile = promisify(execFileCallback);
export interface EditClip {
  sceneId: string; source: string; sha256: string; durationSeconds: number;
  inSeconds: number; outSeconds: number; credit: string | null; cues: SubtitleCue[];
}
export interface EpisodeEdit {
  version: 'episode-edit-v1'; movieId: string; episodeId: string; title: string; clips: EditClip[];
}
export function episodeEditTimeline(edit: EpisodeEdit) {
  if (edit.version !== 'episode-edit-v1' || !edit.clips?.length || edit.clips.length > 100) throw new Error('Edit needs 1–100 source clips');
  let offset = 0;
  const cues: SubtitleCue[] = [];
  const clips = edit.clips.map((clip, index) => {
    if (![clip.durationSeconds, clip.inSeconds, clip.outSeconds].every(Number.isFinite) || clip.inSeconds < 0 || clip.outSeconds > clip.durationSeconds + 0.01 || clip.outSeconds - clip.inSeconds < 0.5) throw new Error('Edit source range is invalid');
    for (const cue of clip.cues) {
      if (cue.endSeconds <= clip.inSeconds || cue.startSeconds >= clip.outSeconds) continue;
      if (cue.startSeconds < clip.inSeconds || cue.endSeconds > clip.outSeconds) throw new Error(`Cut splits spoken cue ${cue.cueId}; move the edit point outside the utterance`);
      cues.push({ ...cue, cueId: `${index + 1}-${cue.cueId}`, startSeconds: cue.startSeconds - clip.inSeconds + offset, endSeconds: cue.endSeconds - clip.inSeconds + offset });
    }
    const timelineStart = offset;
    offset += clip.outSeconds - clip.inSeconds;
    return { ...clip, timelineStart, timelineEnd: offset };
  });
  const subtitles: AuthorSubtitlesOutput = { audioLanguage: 'en', actualDurationSeconds: offset, cues, subtitleSchemaVersion: 'episode-subtitles-v1' };
  validateSubtitles(subtitles, { actualDurationSeconds: offset });
  return { clips, durationSeconds: offset, subtitles };
}

/** Creates a new version directory. Published source media and canon are read-only. */
export async function renderEpisodeEdit(edit: EpisodeEdit, mediaDir: string, destination: string) {
  const timeline = episodeEditTimeline(edit);
  const version = createHash('sha256').update(JSON.stringify(edit)).digest('hex').slice(0, 16);
  const root = resolve(destination, version);
  await mkdir(dirname(root), { recursive: true });
  // Existing versions are never overwritten, including a previously reviewed cut.
  await mkdir(root);
  try {
    const args: string[] = ['-v', 'error', '-nostdin'];
    const filters: string[] = [];
    for (const [index, clip] of timeline.clips.entries()) {
      const source = mediaFilePath(mediaDir, clip.source);
      if (!source || createHash('sha256').update(await readFile(source)).digest('hex') !== clip.sha256) throw new Error(`Source hash mismatch for scene ${clip.sceneId}`);
      args.push('-i', source);
      const length = clip.outSeconds - clip.inSeconds;
      filters.push(`[${index}:v:0]trim=start=${clip.inSeconds}:end=${clip.outSeconds},setpts=PTS-STARTPTS,fps=24,scale=1344:768,setsar=1[v${index}]`);
      filters.push(`[${index}:a:0]atrim=start=${clip.inSeconds}:end=${clip.outSeconds},asetpts=PTS-STARTPTS,aresample=48000,afade=t=in:d=0.015,afade=t=out:st=${length - 0.015}:d=0.015[a${index}]`);
    }
    filters.push(`${timeline.clips.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${timeline.clips.length}:v=1:a=1[v][a]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', resolve(root, 'assembly.mp4'));
    await execFile('ffmpeg', args, { timeout: 600000, maxBuffer: 2_000_000 });
    const audio = await masterAudioVariant(resolve(root, 'assembly.mp4'), resolve(root, 'film.mp4'));
    if (Math.abs(audio.durationSeconds - timeline.durationSeconds) > 0.1) throw new Error('Edited duration differs from the source map');
    for (const locale of LOCALES) if (timeline.subtitles.cues.length) await writeFile(resolve(root, `film.${locale}.vtt`), renderWebVtt(timeline.subtitles, locale));
    const manifest = { ...edit, versionId: version, timeline, audio, sha256: createHash('sha256').update(await readFile(resolve(root, 'film.mp4'))).digest('hex'),
      credits: [...new Set(edit.clips.map((c) => c.credit).filter(Boolean))], sourceMediaChanged: false };
    await writeFile(resolve(root, 'manifest.json.tmp'), JSON.stringify(manifest, null, 2));
    await rename(resolve(root, 'manifest.json.tmp'), resolve(root, 'manifest.json'));
    await rm(resolve(root, 'assembly.mp4'));
    return { directory: root, manifest };
  } catch (error) {
    await writeFile(resolve(root, 'failed.txt'), error instanceof Error ? error.message : String(error));
    throw error;
  }
}
