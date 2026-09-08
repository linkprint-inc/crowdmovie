const MAX_BYTES = 32 * 1024 * 1024;

/** Fetch one short, same-origin MP4 without the native media Range pipeline. */
export async function fetchBufferedVideo(source: string, signal: AbortSignal): Promise<Blob> {
  const url = new URL(source, location.origin);
  if (url.origin !== location.origin || !/^\/media\/[a-zA-Z0-9_/-]+\.mp4$/.test(url.pathname)) {
    throw new TypeError("Invalid media source");
  }
  const response = await fetch(url.href, { signal, credentials: "omit", redirect: "error" });
  const declaredSize = Number(response.headers.get("content-length"));
  if (response.status !== 200 || !/^video\/mp4(?:;|$)/i.test(response.headers.get("content-type") ?? "") || declaredSize > MAX_BYTES) {
    await response.body?.cancel();
    throw new TypeError("Invalid complete MP4 response");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TypeError("Missing MP4 body");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new RangeError("MP4 exceeds memory limit");
      chunks.push(new Uint8Array(value));
    }
  } finally { await reader.cancel(); }
  if (size < 12 || (declaredSize > 0 && size !== declaredSize)) throw new TypeError("Incomplete MP4");
  return new Blob(chunks, { type: "video/mp4" });
}
