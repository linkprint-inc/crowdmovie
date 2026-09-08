export const CONTROL_TEST_VIDEO_URL = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";

export interface PlaybackDiagnostic {
  id: string;
  kind: "media_error" | "play_rejected" | "load_timeout" | "media_probe" | "buffered_ready" | "buffered_playing" | "buffered_failed" | "check_result";
  context?: "external_control";
  source: string;
  version: string;
  sceneIndex: number;
  mobile: boolean;
  online: boolean;
  visible: boolean;
  readyState: number;
  networkState: number;
  errorCode: number;
  errorName: string;
  mediaErrorMessage: string;
  currentTime: number;
  duration: number;
  paused: boolean;
  muted: boolean;
  controls: boolean;
  playsInline: boolean;
  videoWidth: number;
  videoHeight: number;
  viewport: string;
  events: string[];
  engine: string;
  delivery: "direct" | "buffered";
  bufferedBytes: number;
  parentId?: string;
  probeStatus?: number;
  probeType?: string;
  probeRange?: string;
  probeSignature?: string;
  probeError?: string;
  probeRedirected?: boolean;
  probeRay?: string;
}
let lastSent = 0;
let lastKey = "";
let windowStart = 0;
let count = 0;
/** Error and recovery telemetry. Never send cookies, page queries, identities or captions. */
export function reportPlaybackFailure(video: HTMLVideoElement | null, source: string, sceneIndex: number,
  kind: PlaybackDiagnostic["kind"], events: string[], errorName = "", context?: "external_control"): void {
  if (!video) return;
  const now = Date.now();
  if (now - windowStart > 60_000) { windowStart = now; count = 0; }
  const key = `${kind}:${sceneIndex}`;
  const recovery = kind.startsWith("buffered_") || kind === "check_result";
  if ((key === lastKey && now - lastSent < 2000) || count >= 12 || (!recovery && count >= 5)) return;
  let url: URL;
  try { url = new URL(source, location.origin); } catch { return; }
  const external = context === "external_control" && kind === "check_result" && url.href === CONTROL_TEST_VIDEO_URL;
  if ((!external && url.origin !== location.origin) || !/^\/media\/[a-zA-Z0-9_/-]+\.mp4$/.test(url.pathname)) return;
  count += 1; lastSent = now; lastKey = key;
  const finite = (n: number) => Number.isFinite(n) && n >= 0 ? n : 0;
  const report: PlaybackDiagnostic = {
    id: crypto.randomUUID(), kind, source: url.pathname,
    version: /^[a-f0-9]{64}$/.test(url.searchParams.get("v") ?? "") ? url.searchParams.get("v")! : "",
    sceneIndex, mobile: navigator.maxTouchPoints > 0 || /iPhone|iPad|Android|Mobile/i.test(navigator.userAgent), online: navigator.onLine,
    visible: document.visibilityState === "visible", readyState: video.readyState,
    networkState: video.networkState, errorCode: video.error?.code ?? 0,
    errorName: /^[A-Za-z]+Error$/.test(errorName) ? errorName.slice(0, 60) : "",
    mediaErrorMessage: String(video.error?.message ?? "").replace(/(?:https?:\/\/|blob:)[^\s"'<>]+/g, "[media]").slice(0, 240),
    currentTime: finite(video.currentTime), duration: finite(video.duration), paused: video.paused,
    muted: video.muted, controls: video.controls, playsInline: video.playsInline,
    videoWidth: video.videoWidth, videoHeight: video.videoHeight,
    viewport: `${innerWidth}x${innerHeight}`, events: events.slice(-16),
    engine: external || video.classList.contains("native-movie-video") ? "native" : "videojs",
    ...(external ? { context: "external_control" as const } : {}),
    delivery: video.dataset.playbackDelivery === "buffered" ? "buffered" : "direct",
    bufferedBytes: finite(Number(video.dataset.bufferedBytes ?? 0)),
  };
  console.warn("[playback-diagnostic]", report);
  sendReport(report);
  if (kind === "media_error" && !external) void probeMedia(url, report);
}

function sendReport(report: PlaybackDiagnostic): void {
  void fetch("/api/diagnostics/playback", {
    method: "POST", credentials: "omit", keepalive: true,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(report),
  }).catch(() => { /* The browser console retains evidence if the network is down. */ });
}

const probed = new Map<string, number>();
async function probeMedia(url: URL, parent: PlaybackDiagnostic): Promise<void> {
  const now = Date.now();
  if (now - (probed.get(url.pathname) ?? 0) < 60000) return;
  probed.set(url.pathname, now);
  if (probed.size > 20) probed.delete(probed.keys().next().value!);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 5000);
  const report: PlaybackDiagnostic = { ...parent, id: crypto.randomUUID(), parentId: parent.id, kind: "media_probe" };
  try {
    const response = await fetch(url.href, { credentials: "omit", cache: "no-store", headers: { Range: "bytes=0-31" }, signal: abort.signal });
    report.probeStatus = response.status;
    report.probeType = (response.headers.get("content-type") ?? "").slice(0, 80);
    report.probeRange = (response.headers.get("content-range") ?? "").slice(0, 80);
    report.probeRay = (response.headers.get("cf-ray") ?? "").slice(0, 80);
    report.probeRedirected = response.redirected;
    const reader = response.body?.getReader();
    if (reader) {
      const bytes: number[] = [];
      try {
        while (bytes.length < 16) {
          const next = await reader.read();
          if (next.done) break;
          bytes.push(...next.value.subarray(0, 16 - bytes.length));
        }
        report.probeSignature = bytes.map(byte => byte.toString(16).padStart(2, "0")).join("");
      } finally { await reader.cancel(); }
    }
  } catch (error) {
    report.probeError = error instanceof Error ? error.name.slice(0, 60) : "UnknownError";
  } finally {
    clearTimeout(timeout);
    console.warn("[playback-probe]", report);
    sendReport(report);
  }
}
