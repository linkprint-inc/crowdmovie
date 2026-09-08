import { episodeEditTimeline, type EpisodeEdit } from '../src/media/episode-edit';

const edit = (): EpisodeEdit => ({ version: 'episode-edit-v1', title: 'A resolved exchange', movieId: 'movie', episodeId: 'episode', clips: [
  { sceneId: 'a', source: '/media/a.mp4', sha256: 'a'.repeat(64), durationSeconds: 8, inSeconds: 1, outSeconds: 4, credit: 'Alice', cues: [] },
  { sceneId: 'b', source: '/media/b.mp4', sha256: 'b'.repeat(64), durationSeconds: 6, inSeconds: 0, outSeconds: 5, credit: 'Bob', cues: [
    { cueId: 'audio-1', speaker: 'Batman', startSeconds: 1, endSeconds: 2, text: { en: 'Stay still!', 'zh-CN': '别动！', ja: '動くな！', es: '¡No te muevas!' } },
  ] },
] });

test('an action edit preserves one shared translated timeline and source offsets', () => {
  const result = episodeEditTimeline(edit());
  expect(result.durationSeconds).toBe(8);
  expect(result.clips[1].timelineStart).toBe(3);
  expect(result.subtitles.cues[0].startSeconds).toBe(4);
  expect(result.subtitles.cues[0].endSeconds).toBe(5);
  expect(result.subtitles.cues[0].text['zh-CN']).toBe('别动！');
});

test('a cut may remove a whole utterance but cannot split it or exceed source media', () => {
  const source = edit(); source.clips[1].inSeconds = 1.5;
  expect(() => episodeEditTimeline(source)).toThrow('splits spoken cue');
  source.clips[1].inSeconds = 2;
  expect(episodeEditTimeline(source).subtitles.cues).toHaveLength(0);
  source.clips[1].outSeconds = 7;
  expect(() => episodeEditTimeline(source)).toThrow('source range');
});
