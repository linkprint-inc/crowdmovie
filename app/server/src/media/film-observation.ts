import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FilmPlan } from '../ai/film-plan.js';
import type { ObserveFilmInput } from '../ai/film-observation.js';

const execFile = promisify(execFileCallback);
export async function filmObservationInput(roundId: string, path: string, videoSha256: string, duration: number, plan: FilmPlan): Promise<ObserveFilmInput> {
  if (createHash('sha256').update(await readFile(path)).digest('hex') !== videoSha256) throw new Error('Observation input hash mismatch');
  const times = [0, duration * 0.25, duration * 0.5, duration * 0.75, Math.max(0, duration - 0.1)];
  const frames: ObserveFilmInput['frames'] = [];
  for (const seconds of times) {
    const { stdout } = await execFile('ffmpeg', ['-v', 'error', '-nostdin', '-ss', seconds.toFixed(3), '-i', path,
      '-frames:v', '1', '-vf', 'scale=640:-2', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '6', 'pipe:1'], { encoding: 'buffer', timeout: 30000, maxBuffer: 1_000_000 });
    if (!stdout.length) throw new Error(`No observation frame at ${seconds}`);
    frames.push({ seconds: Number(seconds.toFixed(3)), sha256: createHash('sha256').update(stdout).digest('hex'), dataUrl: `data:image/jpeg;base64,${stdout.toString('base64')}` });
  }
  const indices = times.map((seconds) => Math.ceil(seconds * 24));
  const { stdout: sheet } = await execFile('ffmpeg', ['-v', 'error', '-nostdin', '-i', path,
    '-vf', `select='${indices.map((n) => `eq(n,${n})`).join('+')}',scale=640:-2,tile=2x3`,
    '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '6', 'pipe:1'], { encoding: 'buffer', timeout: 30000, maxBuffer: 2_000_000 });
  if (!sheet.length) throw new Error('No observation contact sheet');
  return { roundId, videoSha256, plan, frames, contactSheet: { sha256: createHash('sha256').update(sheet).digest('hex'), dataUrl: `data:image/jpeg;base64,${sheet.toString('base64')}` } };
}
