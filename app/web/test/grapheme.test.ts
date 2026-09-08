import { describe, expect, it } from "vitest";
import { KIND_MAX_GRAPHEMES, glen } from "../src/lib/grapheme";

/*
 * The client counter and the server's rejection must agree exactly, or a
 * writer sees "139 / 140" and still gets content_too_long. These cases are the
 * ones where naive counting (str.length, or Array.from) diverges from the
 * server's Intl.Segmenter grapheme count.
 */
describe("glen mirrors the server's grapheme count", () => {
  it("counts ASCII one per character", () => {
    expect(glen("hello")).toBe(5);
  });

  it("counts a CJK ideograph as one", () => {
    expect(glen("灵梦把校车路线拆成六段")).toBe(11);
  });

  it("counts an astral-plane emoji as one, not two UTF-16 units", () => {
    expect("😀".length).toBe(2);
    expect(glen("😀")).toBe(1);
  });

  it("counts a ZWJ emoji sequence as one, not one per code point", () => {
    const family = "👨‍👩‍👧‍👦";
    expect([...family].length).toBeGreaterThan(1);
    expect(glen(family)).toBe(1);
  });

  it("counts a flag as one", () => {
    expect(glen("🇯🇵")).toBe(1);
  });

  it("counts a base letter plus combining marks as one", () => {
    expect(glen("é")).toBe(1);
  });

  it("counts an empty string as zero", () => {
    expect(glen("")).toBe(0);
  });
});

describe("submission limits match the server constants", () => {
  it("uses 140 for a shot and 1000 for an episode outline", () => {
    expect(KIND_MAX_GRAPHEMES.next_shot).toBe(140);
    expect(KIND_MAX_GRAPHEMES.next_episode).toBe(1000);
  });
});
