import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.resetModules();
});

it("uses the browser language instead of a locale saved by an older build", async () => {
  localStorage.setItem("cm.locale", "es");
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["ja-JP", "en-US"]);

  const i18n = await import("../src/i18n");

  expect(i18n.locale.value).toBe("ja");
});

it.each([
  ["zh-TW", "zh-CN"],
  ["es-MX", "es"],
  ["en-GB", "en"],
] as const)("maps browser language %s to %s", async (browserLanguage, expected) => {
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue([browserLanguage]);

  const i18n = await import("../src/i18n");

  expect(i18n.locale.value).toBe(expected);
});
