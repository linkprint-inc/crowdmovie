import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { masterAudioVariant } from '../src/media/film-audio';

test('encoded audio meets loudness/peak targets while preserving raw bytes and timeline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crowdmovie-master-'));
  try {
    const source = join(directory, 'raw.mp4'); const target = join(directory, 'master.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x96:r=24:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-af', 'volume=0.1', '-c:v', 'libx264', '-c:a', 'aac', source]);
    const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const before = digest(await readFile(source));
    const result = await masterAudioVariant(source, target);
    expect(Math.abs(result.after.integrated! + 16)).toBeLessThanOrEqual(1);
    expect(result.after.truePeak).toBeLessThanOrEqual(-1.5);
    // AAC encoder/muxer padding differs by FFmpeg version. Verify the video
    // packet timeline exactly, and bound container padding separately.
    const videoPackets = (path: string) => execFileSync('ffprobe', ['-v', 'error',
      '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,dts_time,duration_time',
      '-of', 'json', path], { encoding: 'utf8' });
    expect(JSON.parse(videoPackets(target))).toEqual(JSON.parse(videoPackets(source)));
    expect(result.durationSeconds).toBeGreaterThanOrEqual(3);
    expect(result.durationSeconds).toBeLessThanOrEqual(3.15);
    expect(digest(await readFile(source))).toBe(before);
    expect(digest(await readFile(target))).not.toBe(before);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30000);
