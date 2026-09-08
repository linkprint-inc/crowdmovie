import { fetchBufferedVideo } from "./buffered-video";

/** The small playback surface shared by native HTML video and Video.js. */
export interface PlaybackController {
  src(source: { src: string; type: string }): unknown;
  play(): Promise<void> | undefined;
  pause(): unknown;
  paused(): boolean;
  ended(): boolean;
  currentTime(): number | undefined;
  duration(): number | undefined;
  on(event: string, handler: () => void): unknown;
  reset(): unknown;
  userActive?(active: boolean): unknown;
  /** A one-shot recovery for a source rejected before metadata. */
  recoverSource?(): Promise<void> | undefined;
  dispose(): unknown;
  el(): Element | undefined;
  textTracks(): { length: number };
  remoteTextTracks(): { length: number };
  removeRemoteTextTrack(track: HTMLTrackElement): unknown;
  addRemoteTextTrack(options: { kind: string; src: string; srclang: string; label: string }, manualCleanup: boolean): unknown;
}

export function useNativePlayback(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** No library source handler or CORS mode: the same MP4 goes to the browser. */
export function createNativePlayer(video: HTMLVideoElement): PlaybackController {
  const listeners: Array<[string, () => void]> = [];
  let source = "";
  let revision = 0;
  let recoveryAttempted = false;
  let download: AbortController | null = null;
  let objectUrl: string | null = null;
  const releaseBuffer = () => {
    revision += 1;
    download?.abort();
    download = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    delete video.dataset.bufferedBytes;
    video.dataset.playbackDelivery = "direct";
  };
  video.className = "native-movie-video";
  video.controls = true;
  video.playsInline = true;
  video.preload = "none";
  video.removeAttribute("crossorigin");
  const reset = () => {
    releaseBuffer();
    source = "";
    recoveryAttempted = false;
    video.pause();
    video.removeAttribute("src");
    video.querySelectorAll("track").forEach(track => track.remove());
    video.load();
  };
  return {
    src: ({ src }) => {
      releaseBuffer();
      source = src;
      recoveryAttempted = false;
      video.src = src;
    },
    recoverSource: () => {
      if (!source || recoveryAttempted || video.error?.code !== 4 || video.readyState !== 0) return;
      recoveryAttempted = true;
      const requestedRevision = revision;
      const abort = new AbortController();
      download = abort;
      const timeout = setTimeout(() => abort.abort(), 30000);
      return fetchBufferedVideo(source, abort.signal).then(blob => {
        if (abort.signal.aborted || revision !== requestedRevision) throw new DOMException("Source changed", "AbortError");
        objectUrl = URL.createObjectURL(blob);
        video.dataset.playbackDelivery = "buffered";
        video.dataset.bufferedBytes = String(blob.size);
        video.src = objectUrl;
        video.load();
      }).finally(() => {
        clearTimeout(timeout);
        if (download === abort) download = null;
      });
    },
    play: () => video.play(), pause: () => video.pause(),
    paused: () => video.paused, ended: () => video.ended,
    currentTime: () => video.currentTime, duration: () => video.duration,
    on: (event, handler) => { video.addEventListener(event, handler); listeners.push([event, handler]); },
    reset,
    dispose: () => { listeners.forEach(([event, handler]) => video.removeEventListener(event, handler)); reset(); },
    el: () => video.parentElement ?? undefined,
    textTracks: () => video.textTracks,
    remoteTextTracks: () => video.querySelectorAll("track"),
    removeRemoteTextTrack: track => track.remove(),
    addRemoteTextTrack: options => {
      const track = document.createElement("track");
      Object.assign(track, options);
      video.append(track);
      return track;
    },
  };
}
