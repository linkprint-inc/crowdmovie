import { describe, expect, it } from "vitest";
import { nextRoundNumber, publicRoundNumber } from "../src/lib/round-number";
describe("public rounds", () => {
  it("does not consume numbers on failures", () => {
    const next = nextRoundNumber([{ sceneIndex: 14 }]);
    for (const status of ["generation_failed", "validation_failed", "select_failed"]) expect(publicRoundNumber({ status }, next)).toBeNull();
    expect(publicRoundNumber({ status: "open" }, next)).toBe(15);
    expect(publicRoundNumber({ status: "generating" }, next)).toBe(15);
  });
  it("advances after publish and preserves historical scene numbers", () => {
    expect(publicRoundNumber({ status: "published", sceneIndex: 14 }, 15)).toBe(14);
    expect(nextRoundNumber([{ sceneIndex: 14 }, { sceneIndex: 15 }])).toBe(16);
    expect(nextRoundNumber([])).toBe(1);
    expect(nextRoundNumber([{ sceneIndex: 13 }], [{ sceneIndex: 14 }])).toBe(15);
    expect(publicRoundNumber({ status: "published" }, 15)).toBeNull();
  });
});
