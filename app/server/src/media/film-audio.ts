import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mediaFilePath, inspectGeneratedVideo } from '../lib/media.js';

const execFile = promisify(execFileCallback);
export interface TranscriptSegment {
  start: number; end: number; text: string;
  words: Array<{ start: number; end: number; word: string; probability: number }>;
}
export interface FilmTranscript {
  version: 'film-asr-v1'; engine: string; model: string; language: string; duration: number;
  segments: TranscriptSegment[]; uncertainSegments: TranscriptSegment[];
}
export interface Loudness { integrated: number | null; truePeak: number | null; range: number | null }
export interface FilmAudioAudit {
  version: 'film-audio-v1'; rawVideo: string; rawSha256: string;
  videoPath: string; sha256: string; durationSeconds: number;
  before: Loudness; after: Loudness; transcript: FilmTranscript;
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const finite = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : null;

async function measure(path: string): Promise<Record<string, string>> {
  const { stderr } = await execFile('ffmpeg', ['-hide_banner', '-nostdin', '-i', path, '-vn', '-af',
    'loudnorm=I=-16:TP=-1.8:LRA=11:print_format=json', '-f', 'null', '-'], { timeout: 120000, maxBuffer: 2_000_000 });
  const match = stderr.match(/\{\s*"input_i"[\s\S]*?\}/);
  if (!match) throw new Error('No loudness measurement returned');
  return JSON.parse(match[0]) as Record<string, string>;
}
const loudness = (m: Record<string, string>): Loudness => ({ integrated: finite(m.input_i), truePeak: finite(m.input_tp), range: finite(m.input_lra) });

export async function masterAudioVariant(source: string, target: string): Promise<{ before: Loudness; after: Loudness; durationSeconds: number }> {
  const measured = await measure(source);
  await mkdir(dirname(target), { recursive: true });
  const before = loudness(measured);
  if (before.integrated === null) {
    await copyFile(source, `${target}.tmp.mp4`);
  } else {
    const filter = `loudnorm=I=-16:TP=-1.8:LRA=11:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`;
    await execFile('ffmpeg', ['-y', '-hide_banner', '-nostdin', '-i', source, '-map', '0:v:0', '-map', '0:a:0',
      '-c:v', 'copy', '-af', filter, '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', `${target}.tmp.mp4`], { timeout: 120000, maxBuffer: 2_000_000 });
  }
  let after = loudness(await measure(`${target}.tmp.mp4`));
  // Short, transient-heavy fight clips can miss loudnorm's integrated target.
  // A measured gain plus latency-compensated peak limiter corrects that once.
  if (after.integrated !== null && (Math.abs(after.integrated + 16) > 1 || (after.truePeak !== null && after.truePeak > -1.5))) {
    const gain = Math.max(-6, Math.min(6, -16 - after.integrated));
    await execFile('ffmpeg', ['-y', '-hide_banner', '-nostdin', '-i', `${target}.tmp.mp4`, '-map', '0:v:0', '-map', '0:a:0',
      '-c:v', 'copy', '-af', `volume=${gain}dB,alimiter=limit=0.75:attack=5:release=50:level=0:latency=1`, '-ar', '48000',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', `${target}.corrected.mp4`], { timeout: 120000, maxBuffer: 2_000_000 });
    await rename(`${target}.corrected.mp4`, `${target}.tmp.mp4`);
    after = loudness(await measure(`${target}.tmp.mp4`));
  }
  if ((after.truePeak !== null && after.truePeak > -1.5) || (after.integrated !== null && Math.abs(after.integrated + 16) > 1)) throw new Error(`Encoded audio misses project loudness target: ${JSON.stringify(after)}`);
  const inspected = await inspectGeneratedVideo(`${target}.tmp.mp4`);
  if (!inspected.ok) throw new Error(inspected.reason);
  await rename(`${target}.tmp.mp4`, target);
  return { before, after, durationSeconds: inspected.durationSeconds };
}

/** Raw H3 bytes are immutable. Retry uses the hash-verified finished variant. */
export async function prepareFilmAudio(mediaDir: string, roundId: string, videoUrl: string, sourceSha256: string): Promise<FilmAudioAudit> {
  if (!/^[0-9a-f-]{36}$/.test(roundId)) throw new Error('Invalid audio round ID');
  const source = mediaFilePath(mediaDir, videoUrl);
  const rawVideo = `/media/raw/${roundId}.original.mp4`;
  const raw = mediaFilePath(mediaDir, rawVideo)!;
  const videoPath = `/media/pending/${roundId}.master.mp4`;
  const target = mediaFilePath(mediaDir, videoPath)!;
  const manifest = `${raw}.audio-v1.json`;
  if (!source || hash(await readFile(source)) !== sourceSha256) throw new Error('Raw audio input hash mismatch');
  try {
    const cached = JSON.parse(await readFile(manifest, 'utf8')) as FilmAudioAudit;
    if (cached.version === 'film-audio-v1' && cached.rawSha256 === sourceSha256 && hash(await readFile(target)) === cached.sha256) return cached;
  } catch { /* A partial attempt is recomputed from the immutable raw source. */ }
  await mkdir(dirname(raw), { recursive: true });
  try { await copyFile(source, raw, 1); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || hash(await readFile(raw)) !== sourceSha256) throw error;
  }
  const mastered = await masterAudioVariant(source, target);
  const { before, after } = mastered;
  const { stdout } = await execFile(process.env.CROWDMOVIE_ASR_PYTHON ?? '/opt/crowdmovie-film-audio/bin/python', [
    process.env.CROWDMOVIE_ASR_SCRIPT ?? '/opt/crowdmovie/ops/film-audio-transcribe.py', raw,
  ], { timeout: 240000, maxBuffer: 2_000_000 });
  const transcript = JSON.parse(stdout) as FilmTranscript;
  if (transcript.version !== 'film-asr-v1' || !Array.isArray(transcript.segments) || !Array.isArray(transcript.uncertainSegments)) throw new Error('Invalid actual-audio transcript');
  for (const cue of [...transcript.segments, ...transcript.uncertainSegments]) {
    if (!cue.text?.trim() || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start || cue.end > mastered.durationSeconds + 0.1) throw new Error('ASR returned an invalid measured interval');
  }
  const result: FilmAudioAudit = { version: 'film-audio-v1', rawVideo, rawSha256: sourceSha256, videoPath,
    sha256: hash(await readFile(target)), durationSeconds: mastered.durationSeconds, before, after, transcript };
  await writeFile(`${manifest}.tmp`, JSON.stringify(result, null, 2));
  await rename(`${manifest}.tmp`, manifest);
  return result;
}
