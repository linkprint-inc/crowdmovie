// 规范 §4.4 的上传校验。
//
// The rule that matters most here is the one about SVG: it is an executable
// document, and an <svg onload="..."> served from our own origin under a name
// ending in .jpg is a stored XSS. Sniffing the bytes rather than trusting the
// declared Content-Type is what stops it.
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  sniffImageType,
  storyImagePath,
  storyImageUrl,
  MAX_IMAGE_BYTES,
} from '../src/lib/story-images';

/** Smallest bytes that identify each accepted format. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
]);

test('认得 JPEG、PNG 与 WebP', () => {
  expect(sniffImageType(JPEG)).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
  expect(sniffImageType(PNG)).toEqual({ mime: 'image/png', ext: 'png' });
  expect(sniffImageType(WEBP)).toEqual({ mime: 'image/webp', ext: 'webp' });
});

test('拒绝 SVG —— 它是可执行文档，站内直接引用等于 XSS', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  expect(sniffImageType(svg)).toBeNull();
});

test('拒绝 GIF、PDF 与空文件', () => {
  expect(sniffImageType(Buffer.from('GIF89a'))).toBeNull();
  expect(sniffImageType(Buffer.from('%PDF-1.7'))).toBeNull();
  expect(sniffImageType(Buffer.alloc(0))).toBeNull();
});

test('RIFF 但不是 WEBP 的容器也被拒绝', () => {
  const wav = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x1a, 0x00, 0x00, 0x00]),
    Buffer.from('WAVE'),
  ]);
  expect(sniffImageType(wav)).toBeNull();
});

test('声明的类型不算数，字节才算数', () => {
  // 一个改名成 .jpg 的 PNG 仍然被识别为 PNG，存成 .png。
  expect(sniffImageType(PNG)?.ext).toBe('png');
});

test('上限是 2 MiB', () => {
  expect(MAX_IMAGE_BYTES).toBe(2 * 1024 * 1024);
});

test('URL 与磁盘路径一一对应，且都锁在媒体根目录下', () => {
  const proposalId = '11111111-1111-1111-1111-111111111111';
  const imageId = '22222222-2222-2222-2222-222222222222';

  const url = storyImageUrl(proposalId, imageId, 'jpg');
  expect(url).toBe(`/media/story/${proposalId}/${imageId}.jpg`);
  expect(storyImagePath('/var/lib/crowdmovie/media', url)).toBe(
    `/var/lib/crowdmovie/media/story/${proposalId}/${imageId}.jpg`,
  );
});

test('穿越媒体根目录的 URL 解析为 null', () => {
  expect(storyImagePath('/var/lib/crowdmovie/media', '/media/../../etc/passwd')).toBeNull();
  expect(storyImagePath('/var/lib/crowdmovie/media', '/etc/passwd')).toBeNull();
});

test('写入的文件真的能读回来，目录会被建出来', async () => {
  const { writeStoryImage } = await import('../src/lib/story-images');
  const root = await mkdtemp(join(tmpdir(), 'cm-story-'));
  const proposalId = '33333333-3333-3333-3333-333333333333';
  const imageId = '44444444-4444-4444-4444-444444444444';

  const url = await writeStoryImage(root, proposalId, imageId, 'png', PNG);

  expect(url).toBe(`/media/story/${proposalId}/${imageId}.png`);
  const path = storyImagePath(root, url);
  expect(path).not.toBeNull();
  expect(await readFile(path as string)).toEqual(PNG);
});

test('删除不存在的文件不抛错 —— 重复删除是正常的', async () => {
  const { deleteStoryImage } = await import('../src/lib/story-images');
  const root = await mkdtemp(join(tmpdir(), 'cm-story-'));

  await expect(
    deleteStoryImage(root, `/media/story/nope/nope.jpg`),
  ).resolves.toBeUndefined();
});

test('删除会真的删掉文件', async () => {
  const { deleteStoryImage, writeStoryImage } = await import(
    '../src/lib/story-images'
  );
  const root = await mkdtemp(join(tmpdir(), 'cm-story-'));
  const proposalId = '55555555-5555-5555-5555-555555555555';
  const imageId = '66666666-6666-6666-6666-666666666666';
  const url = await writeStoryImage(root, proposalId, imageId, 'jpg', JPEG);

  await deleteStoryImage(root, url);

  await expect(readFile(storyImagePath(root, url) as string)).rejects.toThrow();
});
