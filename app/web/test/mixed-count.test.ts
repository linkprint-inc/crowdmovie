/*
 * 规范 §2。这份用例与 app/server/test/mixed-count.test.ts 逐字相同——两份实现
 * 必须对同一组输入给出同一个数，否则编辑器的计数会和服务端的 content_too_long
 * 打架。改动任何一份时，另一份必须同步。
 */
import { expect, test } from "vitest";
import { mixedCount } from "../src/lib/mixed-count";

test('空串与纯标点计 0', () => {
  expect(mixedCount('')).toBe(0);
  expect(mixedCount('   ')).toBe(0);
  expect(mixedCount('，。！？')).toBe(0);
});

test('英文按词', () => {
  expect(mixedCount('hello world')).toBe(2);
  expect(mixedCount('The quick brown fox.')).toBe(4);
  expect(mixedCount("don't stop")).toBe(2);
});

test('中日韩按字', () => {
  expect(mixedCount('中文')).toBe(2);
  expect(mixedCount('你好，世界！')).toBe(4);
  expect(mixedCount('日本語テキスト')).toBe(7);
  expect(mixedCount('한국어 텍스트')).toBe(6);
});

test('中英混排各按各的规则', () => {
  expect(mixedCount('中文 mixed 文本')).toBe(5);
  expect(mixedCount('中文abc')).toBe(3);
  expect(mixedCount('AI时代')).toBe(3);
});

test('数字串整体计 1', () => {
  expect(mixedCount('1234')).toBe(1);
  expect(mixedCount('3.14 pies')).toBe(2);
});

test('emoji 不计数：它既不是字也不是词，不能用来凑满 500', () => {
  expect(mixedCount('\u{1F44D}\u{1F600}')).toBe(0);
  expect(mixedCount('a\u{1F44D}b')).toBe(2);
});

test('带变音符号与非拉丁字母的词各计 1', () => {
  expect(mixedCount('café')).toBe(1);
  expect(mixedCount('Москва')).toBe(1);
});

test('计到 500 与 2000 这两个真正的阈值', () => {
  expect(mixedCount('word '.repeat(500))).toBe(500);
  expect(mixedCount('字'.repeat(2000))).toBe(2000);
});
