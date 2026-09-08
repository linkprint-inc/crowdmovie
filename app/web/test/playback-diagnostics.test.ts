import { expect, it, vi } from "vitest";

it("identifies the approved external control without probing arbitrary external URLs", async () => {
  vi.resetModules();
  const fetcher = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal("fetch", fetcher);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { CONTROL_TEST_VIDEO_URL, reportPlaybackFailure } = await import("../src/lib/playback-diagnostics");
  const video = document.createElement("video");
  reportPlaybackFailure(video, "https://example.com/media/video.mp4", 0, "check_result", []);
  expect(fetcher).not.toHaveBeenCalled();
  reportPlaybackFailure(video, CONTROL_TEST_VIDEO_URL, 14, "check_result", ["playing:10"], "", "external_control");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ context: "external_control", source: "/media/cc0-videos/flower.mp4", engine: "native", sceneIndex: 14 });
  warn.mockRestore(); vi.unstubAllGlobals();
});

it("sends media diagnostics without credentials or source query secrets and throttles duplicates", async () => {
  vi.resetModules();
  const fetcher = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetcher);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { reportPlaybackFailure } = await import("../src/lib/playback-diagnostics");
  const v = document.createElement("video");
  Object.defineProperty(v, "error", { value: { code: 4, message: "AVFoundationErrorDomain -11800 https://example.com/private?token=secret" } });
  reportPlaybackFailure(v, "/media/whos-next/000014.mp4?token=secret", 14, "play_rejected", ["error:10"]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, options] = fetcher.mock.calls[0];
  expect(url).toBe("/api/diagnostics/playback");
  expect(options.credentials).toBe("omit");
  expect(options.body).not.toContain("secret");
  expect(JSON.parse(options.body).mediaErrorMessage).toBe("AVFoundationErrorDomain -11800 [media]");
  expect(JSON.parse(options.body)).toMatchObject({ sceneIndex: 14, source: "/media/whos-next/000014.mp4", duration: 0 });
  reportPlaybackFailure(v, "/media/whos-next/000014.mp4", 14, "play_rejected", []);
  expect(fetcher).toHaveBeenCalledTimes(1);
  warn.mockRestore(); vi.unstubAllGlobals();
});

it("probes only the first bytes after an error and links the HTTP result to that error", async () => {
  vi.resetModules();
  const cancel = vi.fn().mockResolvedValue(undefined);
  const fetcher = vi.fn().mockImplementation(async (url: string) => url.startsWith("/api/") ? { ok: true } : {
    status: 206, redirected: false,
    headers: new Headers({ "content-type": "video/mp4", "content-range": "bytes 0-31/4018752" }),
    body: { getReader: () => ({ read: vi.fn().mockResolvedValue({ done: false, value: new Uint8Array([0,0,0,32,102,116,121,112,105,115,111,109,0,0,2,0]) }), cancel }) },
  });
  vi.stubGlobal("fetch", fetcher);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { reportPlaybackFailure } = await import("../src/lib/playback-diagnostics");
  reportPlaybackFailure(document.createElement("video"), "/media/whos-next/000001.mp4", 1, "media_error", ["error:10"]);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  const probeRequest = fetcher.mock.calls[1][1];
  expect(probeRequest.headers.Range).toBe("bytes=0-31");
  expect(cancel).toHaveBeenCalledOnce();
  const error = JSON.parse(fetcher.mock.calls[0][1].body);
  const report = JSON.parse(fetcher.mock.calls[2][1].body);
  expect(report).toMatchObject({ kind: "media_probe", parentId: error.id, probeStatus: 206, probeSignature: "000000206674797069736f6d00000200" });
  warn.mockRestore(); vi.unstubAllGlobals();
});
