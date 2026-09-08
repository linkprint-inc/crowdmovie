import { afterEach, expect, it, vi } from "vitest";
import { fetchBufferedVideo } from "../src/lib/buffered-video";

afterEach(() => vi.unstubAllGlobals());

function response(status = 200, type = "video/mp4", length = "16") {
  const read = vi.fn().mockResolvedValueOnce({ done: false, value: new Uint8Array(16) }).mockResolvedValue({ done: true });
  const cancel = vi.fn().mockResolvedValue(undefined);
  return { status, headers: new Headers({ "content-type": type, "content-length": length }), body: { cancel, getReader: () => ({ read, cancel }) } };
}

it("downloads only the requested same-origin scene without credentials or a Range request", async () => {
  const fetcher = vi.fn().mockResolvedValue(response());
  vi.stubGlobal("fetch", fetcher);
  const abort = new AbortController();
  const blob = await fetchBufferedVideo("/media/whos-next/000014.mp4?v=abc", abort.signal);
  expect(blob.size).toBe(16);
  expect(blob.type).toBe("video/mp4");
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${location.origin}/media/whos-next/000014.mp4?v=abc`, {
    signal: abort.signal, credentials: "omit", redirect: "error",
  });
  await expect(fetchBufferedVideo("https://example.com/video.mp4", abort.signal)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("rejects partial, HTML, incomplete and oversized responses before attaching media", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  for (const reply of [response(206), response(200, "text/html"), response(200, "video/mp4", "20"), response(200, "video/mp4", "33554433")]) {
    fetcher.mockResolvedValueOnce(reply);
    await expect(fetchBufferedVideo("/media/000014.mp4", new AbortController().signal)).rejects.toThrow();
    expect(reply.body.cancel).toHaveBeenCalledOnce();
  }
  const reply = response(200, "video/mp4", "0");
  const read = vi.fn().mockResolvedValue({ done: false, value: new Uint8Array(17 * 1024 * 1024) });
  reply.body.getReader = () => ({ read, cancel: reply.body.cancel });
  fetcher.mockResolvedValueOnce(reply);
  await expect(fetchBufferedVideo("/media/000014.mp4", new AbortController().signal)).rejects.toThrow(RangeError);
  expect(read).toHaveBeenCalledTimes(2);
  expect(reply.body.cancel).toHaveBeenCalledOnce();
});
