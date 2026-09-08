import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNativePlayer } from "../src/lib/native-player";
import { fetchBufferedVideo } from "../src/lib/buffered-video";

vi.mock("../src/lib/buffered-video", () => ({ fetchBufferedVideo: vi.fn() }));
const fetcher = vi.mocked(fetchBufferedVideo);
const revoke = vi.fn();
const create = vi.fn(() => "blob:http://localhost/test-video");
beforeEach(() => {
  fetcher.mockReset(); create.mockClear(); revoke.mockClear();
  vi.stubGlobal("URL", class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function failingVideo() {
  const video = document.createElement("video");
  vi.spyOn(video, "pause").mockImplementation(() => {});
  vi.spyOn(video, "load").mockImplementation(() => {});
  Object.defineProperty(video, "error", { configurable: true, value: { code: 4 } });
  return video;
}

it("recovers once from an early unsupported-source error and releases the buffer on scene change", async () => {
  const video = failingVideo();
  fetcher.mockResolvedValue(new Blob(["MP4"]));
  const player = createNativePlayer(video);
  expect(player.recoverSource!()).toBeUndefined();
  player.src({ src: "/media/000014.mp4", type: "video/mp4" });
  player.addRemoteTextTrack({ kind: "subtitles", src: "/media/000014.en.vtt", srclang: "en", label: "English" }, false);
  await player.recoverSource!();
  expect(video.getAttribute("src")).toBe("blob:http://localhost/test-video");
  expect(video.dataset.playbackDelivery).toBe("buffered");
  expect(video.dataset.bufferedBytes).toBe("3");
  expect(player.remoteTextTracks().length).toBe(1);
  expect(player.recoverSource!()).toBeUndefined();
  player.src({ src: "/media/000015.mp4", type: "video/mp4" });
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:http://localhost/test-video");
  expect(video.dataset.playbackDelivery).toBe("direct");
  expect(video.dataset.bufferedBytes).toBeUndefined();
  player.dispose();
});

it("aborts an old download and never attaches its result after selection changes", async () => {
  let finish!: (blob: Blob) => void;
  fetcher.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const video = failingVideo(); const player = createNativePlayer(video);
  player.src({ src: "/media/000014.mp4", type: "video/mp4" });
  const pending = player.recoverSource!()!;
  const signal = fetcher.mock.calls[0][1];
  player.src({ src: "/media/000015.mp4", type: "video/mp4" });
  expect(signal.aborted).toBe(true);
  finish(new Blob(["old"]));
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(create).not.toHaveBeenCalled();
  expect(video.getAttribute("src")).toBe("/media/000015.mp4");
  player.dispose();
});

it("does not download for a decode error or after playback has already loaded", () => {
  const video = failingVideo(); const player = createNativePlayer(video);
  player.src({ src: "/media/000014.mp4", type: "video/mp4" });
  Object.defineProperty(video, "error", { value: { code: 3 } });
  expect(player.recoverSource!()).toBeUndefined();
  Object.defineProperty(video, "error", { value: { code: 4 } });
  Object.defineProperty(video, "readyState", { value: 2 });
  expect(player.recoverSource!()).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
  player.dispose();
});
