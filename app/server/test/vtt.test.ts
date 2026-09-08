import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderWebVtt, writeSubtitleSidecars } from '../src/media/vtt';


const subtitles = {
  audioLanguage: 'en' as const,
  actualDurationSeconds: 12.25,
  cues: [
    {
      cueId: 'cue-1',
      speaker: 'Reimu',
      startSeconds: 1.234,
      endSeconds: 5.678,
      text: {
        en: 'This meeting could have been an email.',
        'zh-CN': '这场会议本来可以是一封邮件。',
        ja: 'この会議、メールで済んだよね。',
        es: 'Esta reunión pudo ser un correo.',
      },
    },
  ],
  subtitleSchemaVersion: 'scene-subtitles-v1',
};

test('WebVTT uses one shared millisecond timeline for all locales', () => {
  const rendered = renderWebVtt(subtitles, 'zh-CN');
  expect(rendered).toContain('WEBVTT\n\n');
  expect(rendered).toContain('cue-1\n00:00:01.234 --> 00:00:05.678');
  expect(rendered).toContain('Reimu: 这场会议本来可以是一封邮件。');
});

test('four locale sidecars are written next to the pending MP4', async () => {
  const mediaDir = await mkdtemp(join(tmpdir(), 'crowdmovie-vtt-'));
  await writeSubtitleSidecars(
    mediaDir,
    '/media/pending/11111111-1111-4111-8111-111111111111.mp4',
    subtitles,
  );
  for (const locale of ['en', 'zh-CN', 'ja', 'es']) {
    const text = await readFile(
      join(
        mediaDir,
        'pending',
        `11111111-1111-4111-8111-111111111111.${locale}.vtt`,
      ),
      'utf8',
    );
    expect(text).toContain('WEBVTT');
  }
});

// 没有对白就没有字幕：零条 cue 时不落任何 .vtt，播放器也就不会给 <video> 挂上
// 空字幕轨（iOS 把空轨当成资源不可用，整段拒播）。
test('没有对白（零条 cue）时不写任何 .vtt sidecar', async () => {
  const mediaDir = await mkdtemp(join(tmpdir(), 'crowdmovie-vtt-'));
  await writeSubtitleSidecars(
    mediaDir,
    '/media/pending/22222222-2222-4222-8222-222222222222.mp4',
    { ...subtitles, cues: [] },
  );
  const written = await readdir(join(mediaDir, 'pending')).catch(() => [] as string[]);
  expect(written.filter((name) => name.endsWith('.vtt'))).toEqual([]);
});
