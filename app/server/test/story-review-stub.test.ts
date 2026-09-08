// 规范 §5.1 的 stub。
//
// A stub that always says yes cannot test the reject path, and a stub that
// decides at random cannot test anything reproducibly. This one keys off the
// text: anything containing the marker is refused, everything else passes. The
// route and job tests then drive both verdicts without a model.
import { createStubReviewer } from '../src/ai/story-review';

const reviewer = createStubReviewer();

const image = {
  kind: 'character' as const,
  position: 0,
  path: '/tmp/fake.png',
  mime: 'image/png',
  caption: '一个穿校服的少女',
};

test('身份如实报告自己是 stub', () => {
  expect(reviewer.identity.model).toBe('stub');
});

test('普通文本通过', async () => {
  const verdict = await reviewer.review({
    title: '夜行电车',
    synopsis: '一列永不到站的电车',
    images: [image],
  });

  expect(verdict).toEqual({ ok: true, reasons: [] });
});

test('带拒绝标记的文本不通过，并给出理由', async () => {
  const verdict = await reviewer.review({
    title: '夜行电车',
    synopsis: `一列永不到站的电车 ${'REJECT_ME'}`,
    images: [],
  });

  expect(verdict.ok).toBe(false);
  expect(verdict.reasons.length).toBeGreaterThan(0);
});

test('图片说明里的标记同样会让那张图不通过', async () => {
  const good = await reviewer.review({
    title: '正常',
    synopsis: '正常',
    images: [image],
  });
  const bad = await reviewer.review({
    title: '正常',
    synopsis: '正常',
    images: [{ ...image, caption: 'REJECT_ME' }],
  });

  expect(good.ok).toBe(true);
  expect(bad.ok).toBe(false);
  expect(bad.reasons[0]).toContain('character image 1');
});

test('标记出现在标题或任一条说明里都算', async () => {
  const byTitle = await reviewer.review({
    title: 'REJECT_ME',
    synopsis: '正常',
    images: [],
  });
  const byCaption = await reviewer.review({
    title: '正常',
    synopsis: '正常',
    images: [image, { ...image, position: 1, caption: 'REJECT_ME' }],
  });

  expect(byTitle.ok).toBe(false);
  expect(byCaption.ok).toBe(false);
});
