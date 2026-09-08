// 发布门（§5 step 5）的文件检查：有对白才要求四份字幕，没有对白只要求 MP4。
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { verifySceneMedia } from '../src/lib/media';

const execFile = promisify(execFileCallback);
let mediaDir: string;

beforeAll(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), 'cm-media-verify-'));
  await mkdir(join(mediaDir, 'pending'), { recursive: true });
  await execFile('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=160x120:r=12:d=1',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=1',
    '-shortest',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    join(mediaDir, 'pending', 'silent.mp4'),
  ]);
}, 60_000);

afterAll(async () => {
  if (mediaDir !== undefined) await rm(mediaDir, { recursive: true, force: true });
});

test('没有对白的片段只要求 MP4 在场，不要求四份字幕', async () => {
  const verdict = await verifySceneMedia(mediaDir, '/media/pending/silent.mp4', {
    subtitles: false,
  });
  expect(verdict.ok).toBe(true);
});

test('有对白的片段仍然要求四份字幕全部就绪（没有对白以外的默认行为不变）', async () => {
  const verdict = await verifySceneMedia(mediaDir, '/media/pending/silent.mp4');
  expect(verdict).toEqual({
    ok: false,
    reason: expect.stringMatching(/\.en\.vtt/),
  });
});
