import html from "../public/playback-check.html?raw";
import script from "../public/playback-check.js?raw";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

it("compares the identical Scene 14 source in inline and fullscreen modes and sends the native error", async () => {
  vi.useFakeTimers();
  document.body.innerHTML = html.split("<body>")[1].split("</body>")[0];
  const video = document.querySelector("video")!;
  vi.spyOn(video, "play").mockResolvedValue();
  vi.spyOn(video, "pause").mockImplementation(() => {});
  vi.spyOn(video, "load").mockImplementation(() => {});
  const fetcher = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal("fetch", fetcher);
  Object.defineProperty(video, "error", { configurable: true, value: { code: 4, message: "AVFoundationErrorDomain -11800" } });
  new Function(script)();
  document.getElementById("inline")!.click();
  expect(video.playsInline).toBe(true);
  const src = video.src;
  expect(src).toContain("/media/whos-next/000014.mp4?v=88712c");
  expect(document.getElementById("direct")!.getAttribute("href")).toContain("000014.mp4");
  video.dispatchEvent(new Event("error"));
  await Promise.resolve();
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ context: "minimal_inline", sceneIndex: 14, mediaErrorMessage: "AVFoundationErrorDomain -11800" });
  document.getElementById("fullscreen")!.click();
  expect(video.playsInline).toBe(false);
  expect(video.src).toBe(src);
  video.dispatchEvent(new Event("error"));
  await Promise.resolve();
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ context: "minimal_fullscreen", sceneIndex: 14 });
  expect(fetcher.mock.calls[1][1].credentials).toBe("omit");
});
