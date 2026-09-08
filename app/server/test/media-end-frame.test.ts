import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { extractEndFrame } from '../src/lib/media';

const execFile = promisify(execFileCallback);

test('published video end frame is extracted as a reusable 1344x768 PNG', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crowdmovie-end-frame-'));
  try {
    const video = join(root, 'shot.mp4');
    await execFile('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=1344x768:r=2:d=1',
      '-c:v', 'mpeg4', '-y', video,
    ]);
    const result = await extractEndFrame(
      root,
      '/media/shot.mp4',
      '/media/shot.end.png',
    );
    expect(result).toMatchObject({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await readFile(join(root, 'shot.end.png'))).subarray(0, 8)).toEqual(
      Buffer.from('\x89PNG\r\n\x1a\n', 'binary'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
