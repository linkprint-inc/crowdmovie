/* Real-device isolation: no framework, subtitles, source handlers or recovery. */
(() => {
  const clips = {
    1: "/media/whos-next/000001.mp4?v=3aa4259c41c0d43a86511278347984ce0f51c960077cfdb6ef718535afbd6725",
    14: "/media/whos-next/000014.mp4?v=88712c31ea3b47373b146ce9b052d5d15eef75c907d02dea21183e22ed394946",
  };
  const video = document.getElementById("video");
  const select = document.getElementById("scene");
  const status = document.getElementById("status");
  const details = document.getElementById("details");
  let mode = "inline", attempt = 0, timer, reported = false;
  const events = [];
  const addEvent = name => { events.push(`${name}:${Math.round(performance.now())}`); if (events.length > 16) events.shift(); };
  const source = () => clips[select.value];
  const updateSource = () => { video.src = source(); document.getElementById("direct").href = source(); };
  const clean = message => String(message || "").replace(/(?:https?:\/\/|blob:)[^\s"'<>]+/g, "[media]").slice(0, 240);
  const finite = value => Number.isFinite(value) && value >= 0 ? value : 0;
  async function report(result, errorName = "") {
    if (reported || !attempt) return;
    reported = true; clearTimeout(timer);
    addEvent(result);
    const url = new URL(source(), location.origin);
    const report = {
      id: crypto.randomUUID(), kind: "check_result", context: `minimal_${mode}`,
      source: url.pathname, version: url.searchParams.get("v"), sceneIndex: Number(select.value),
      engine: "native", delivery: "direct", mobile: true, online: navigator.onLine,
      visible: document.visibilityState === "visible", readyState: video.readyState,
      networkState: video.networkState, errorCode: video.error?.code || 0,
      mediaErrorMessage: clean(video.error?.message), errorName: /^[A-Za-z]+Error$/.test(errorName) ? errorName.slice(0,60) : "",
      currentTime: finite(video.currentTime), duration: finite(video.duration), paused: video.paused,
      muted: video.muted, controls: video.controls, playsInline: video.playsInline,
      videoWidth: video.videoWidth, videoHeight: video.videoHeight, viewport: `${innerWidth}x${innerHeight}`, events: [...events],
    };
    details.textContent = JSON.stringify(report, null, 2);
    status.textContent = result === "playing" ? "已开始播放。正在发送检查结果…" : "本项未能播放。正在发送错误信息…";
    const requestedAttempt = attempt;
    try {
      const response = await fetch("/api/diagnostics/playback", {
        method: "POST", credentials: "omit", keepalive: true,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(report),
      });
      if (!response.ok) throw new Error("Report rejected");
      if (requestedAttempt === attempt) status.textContent = result === "playing" ? "已开始播放，结果已发送。" : "错误信息已发送。可以继续检查另一种播放方式。";
    } catch {
      if (requestedAttempt === attempt) status.textContent += " 结果发送失败，详细信息保留在下方。";
    }
  }
  for (const event of ["loadstart", "loadedmetadata", "loadeddata", "canplay", "waiting", "stalled", "pause", "ended"]) video.addEventListener(event, () => addEvent(event));
  video.addEventListener("playing", () => { void report("playing"); });
  video.addEventListener("error", () => { void report("error"); });
  document.addEventListener("securitypolicyviolation", event => {
    if (event.effectiveDirective === "media-src") addEvent("csp_media_src");
  });
  function play(nextMode) {
    clearTimeout(timer); attempt += 1; reported = false; mode = nextMode; events.length = 0;
    video.pause(); video.playsInline = mode === "inline"; updateSource(); video.load();
    status.textContent = "正在加载…";
    const requestedAttempt = attempt;
    timer = setTimeout(() => { void report("timeout"); }, 15000);
    video.play().catch(error => {
      // Let the MediaError event supply the native error message when available.
      setTimeout(() => { if (requestedAttempt === attempt) void report("rejected", error.name); }, 100);
    });
  }
  document.getElementById("inline").onclick = () => play("inline");
  document.getElementById("fullscreen").onclick = () => play("fullscreen");
  select.onchange = () => { clearTimeout(timer); attempt += 1; reported = true; video.pause(); updateSource(); status.textContent = "片段已切换，选择一种播放方式。"; };
  updateSource();
})();
