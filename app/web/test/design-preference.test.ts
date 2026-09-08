import { nextTick } from "vue";
import { beforeEach, expect, it, vi } from "vitest";

beforeEach(() => { localStorage.clear(); vi.resetModules(); });

it("defaults to the studio template for a new visitor", async () => {
  const { siteDesign } = await import("../src/stores/prefs");
  expect(siteDesign.value).toBe("studio");
});

it("restores the selected classic template after reload", async () => {
  const { siteDesign } = await import("../src/stores/prefs");
  siteDesign.value = "classic";
  await nextTick();
  expect(localStorage.getItem("cm.siteDesign")).toBe("classic");
  vi.resetModules();
  const reloaded = await import("../src/stores/prefs");
  expect(reloaded.siteDesign.value).toBe("classic");
});

it("falls back to studio for an unknown saved template", async () => {
  localStorage.setItem("cm.siteDesign", "removed-template");
  const { siteDesign } = await import("../src/stores/prefs");
  expect(siteDesign.value).toBe("studio");
});
