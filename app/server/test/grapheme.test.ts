import { glen } from "../src/lib/grapheme";

test("CJK/emoji/组合字均按可见字符计", () => {
  expect(glen("学abc")).toBe(4);
  expect(glen("👩‍👩‍👧‍👦")).toBe(1);       // ZWJ 家庭
  expect(glen("é")).toBe(1);            // e + 组合重音
  expect(glen("")).toBe(0);
});

test("组合序列/纯 ASCII/尾随空格", () => {
  // Explicit decomposed form: base "e" + U+0301 combining acute -> one grapheme.
  expect(glen("é")).toBe(1);
  expect(glen("hello")).toBe(5);
  // A trailing space is a visible position and must be counted.
  expect(glen("ab ")).toBe(3);
});
