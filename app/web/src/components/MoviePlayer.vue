<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { reportPlaybackFailure, type PlaybackDiagnostic } from "../lib/playback-diagnostics";
import { useNativePlayback, type PlaybackController } from "../lib/native-player";

import { LOCALES, LOCALE_NAMES, locale, t } from "../i18n";
import type { Danmaku, DanmakuAnchor } from "../lib/api";
import { live, loadSceneDanmaku } from "../stores/live";
import { showDanmaku, showSubtitles, siteDesign } from "../stores/prefs";
import { viewingMovie, viewingMovieTitle } from "../stores/movies";

/*
 * Spec §4.1. Four soft WebVTT tracks (en / zh-CN / ja / es), never burned in.
 * Subtitles are a switch, not a menu: off by default, remembered, and always
 * shown in the language the site itself is currently displayed in.
 *
 * Video.js owns play/pause, progress, volume and fullscreen. Its captions menu
 * is switched off: it would be a second language choice, and the one below the
 * picture would silently overrule it. The strip below the picture carries what
 * Video.js has no concept of: the scene label and the two switches.
 *
 * Video.js and its stylesheet are imported dynamically: they are ~210 kB
 * gzipped and the screening room is the landing page, which for a while will
 * have an empty playlist. Nothing is fetched until there is a scene to play.
 */

const videoEl = ref<HTMLVideoElement | null>(null);
// Temporary real-device isolation: mobile requests no WebVTT tracks at all.
const mobilePlayback = useNativePlayback() || /Android|Mobile/i.test(navigator.userAgent);
const subtitleToggle = computed({
  get: () => !mobilePlayback && showSubtitles.value,
  set: (enabled: boolean) => { if (!mobilePlayback) showSubtitles.value = enabled; },
});
const player = shallowRef<PlaybackController | null>(null);
/* Position in the playlist, which is *not* the scene's own `sceneIndex`:
   published indexes are never renumbered, so a takedown leaves a gap. Anything
   sent to the server has to carry `scene.sceneIndex`, never this. */
const slot = ref(0);
/** No URL is attached until the viewer explicitly presses play. */
const loadedSlot = ref<number | null>(null);
const currentTimeMs = ref(0);
const playbackFailed = ref(false);
// Keep source-change activity from flashing touch controls until interaction.
const hideMobileControls = ref(false);
function revealControls(): void {
  hideMobileControls.value = false;
  // Run after Video.js touch/click handlers so they cannot toggle it off again.
  setTimeout(() => player.value?.userActive?.(true), 0);
}
const playbackRecovering = ref(false);
const needsPlayGesture = ref(false);
/** The playing media's own duration in ms; null until metadata has loaded. */
const durationMs = ref<number | null>(null);
/* Comment ids already drawn for this pass through the scene. Declared up here
   rather than with the overlay below because `loadScene` clears it. */
const shown = new Set<string>();

const scenes = computed(() => live.playlist);
const scene = computed(() => scenes.value[slot.value] ?? null);
const hasVideo = computed(() => scenes.value.length > 0);
const sourceLoaded = computed(() => loadedSlot.value === slot.value);
const coverUrl = computed(() => {
  const movie = viewingMovie.value;
  return movie?.heroUrl || movie?.posterUrl ||
    (movie?.slug === "whos-next" ? "/whos-next-title-88f57667.webp" : movie?.posterImages?.[0]) || null;
});
const coverFailed = ref(false);
watch(coverUrl, () => { coverFailed.value = false; });
const canGoPrevious = computed(() => hasVideo.value && slot.value > 0);
const canGoNext = computed(
  () => hasVideo.value && slot.value < scenes.value.length - 1,
);

const emit = defineEmits<{ (e: "time", ms: number): void }>();

/*
 * §14.1's anchor, read straight off the player: the scene actually on screen
 * and the playback position inside it. Null while nothing is playing — the
 * comment box has to go read-only in that case rather than invent a scene.
 *
 * The offset is bounded by the media's own duration because the server rejects
 * an offset past the scene's measured length: at the very end of a clip the
 * element's `currentTime` and ffprobe's duration can disagree by a millisecond
 * or two, and that disagreement must not cost the writer their comment.
 */
const anchor = computed<DanmakuAnchor | null>(() => {
  const s = scene.value;
  if (!s || loadedSlot.value !== slot.value) return null;
  const limit = durationMs.value;
  const offsetMs = limit === null ? currentTimeMs.value : Math.min(currentTimeMs.value, limit);
  return { sceneIndex: s.sceneIndex, offsetMs: Math.max(0, offsetMs) };
});

function trackLabel(srclang: string): string {
  const known = (LOCALES as readonly string[]).includes(srclang);
  return known ? LOCALE_NAMES[srclang as (typeof LOCALES)[number]] : srclang;
}

/* Video.js ships its own TrackList types, which are array-like but declare
   neither an index signature nor an iterator. Read them positionally. */
function listToArray<T>(list: { length: number }): T[] {
  const indexed = list as { length: number } & Record<number, T>;
  const out: T[] = [];
  for (let i = 0; i < indexed.length; i += 1) out.push(indexed[i]);
  return out;
}

interface SubtitleTrack {
  kind: string;
  language: string;
  mode: "showing" | "hidden" | "disabled";
}

/**
 * Load one playlist slot into the player, replacing its subtitle tracks.
 *
 * Both URLs come from the playlist entry (§11「不能让前端拼接或猜测文件名」):
 * the video from `videoUrl` and each caption from `subtitles[locale]`. A scene
 * missing a locale's track simply has no track for it rather than a guessed
 * filename that 404s.
 */
function loadScene(index: number): void {
  const p = player.value;
  const s = scenes.value[index];
  if (!p || !s) return;

  hideMobileControls.value = mobilePlayback && loadedSlot.value !== null;
  sourceRevision += 1;
  playAttempt += 1;
  playbackRecovering.value = false;
  bufferedPlayingReported = false;
  nativePlayingReported = false;
  playbackEvents.length = 0;
  currentTimeMs.value = 0;
  durationMs.value = null;
  playbackFailed.value = false;
  needsPlayGesture.value = false;
  p.src({ src: s.videoUrl, type: "video/mp4" });
  loadedSlot.value = index;

  for (const existing of listToArray<HTMLTrackElement>(p.remoteTextTracks())) {
    p.removeRemoteTextTrack(existing);
  }
  if (!mobilePlayback) {
    for (const srclang of LOCALES) {
      const src = s.subtitles[srclang];
      if (typeof src !== "string" || src.length === 0) continue;
      p.addRemoteTextTrack({ kind: "subtitles", src, srclang, label: trackLabel(srclang) }, false);
    }
  } else {
    playbackEvents.push(`subtitles_disabled:${Math.round(performance.now())}`);
  }
  applySubtitles();

  // §14.2: the comment track belongs to the scene, not to the site-wide feed,
  // so replaying a scene replays every comment anchored inside it.
  shown.clear();
  void loadSceneDanmaku(s.sceneIndex);
}

function unloadScene(): void {
  const p = player.value;
  if (!p || loadedSlot.value === null) return;
  sourceRevision += 1;
  playAttempt += 1;
  playbackRecovering.value = false;
  clearLoadingTimer();
  p.reset();
  playbackFailed.value = false;
  needsPlayGesture.value = false;
  loadedSlot.value = null;
  currentTimeMs.value = 0;
  durationMs.value = null;
  shown.clear();
}

/** At most one track showing, and only ever the interface language's. */
function applySubtitles(): void {
  if (mobilePlayback) return;
  const p = player.value;
  if (!p) return;
  for (const track of listToArray<SubtitleTrack>(p.textTracks())) {
    if (track.kind !== "subtitles") continue;
    const wanted = showSubtitles.value && track.language === locale.value;
    track.mode = wanted ? "showing" : "disabled";
  }
}

// The switch, and the language switcher in the header, both land here.
watch([showSubtitles, locale], applySubtitles);

/** The media's real length, once it is known; NaN/Infinity stay unknown. */
function readDuration(): void {
  const seconds = player.value?.duration() ?? Number.NaN;
  durationMs.value = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds * 1000) : null;
}

let booting = false;
let sourceRevision = 0;
let playAttempt = 0;
let bufferedPlayingReported = false;
let nativePlayingReported = false;
const playbackEvents: string[] = [];
let loadingTimer: ReturnType<typeof setTimeout> | null = null;
function clearLoadingTimer(): void {
  if (loadingTimer !== null) clearTimeout(loadingTimer);
  loadingTimer = null;
}
function diagnostic(kind: PlaybackDiagnostic["kind"], name = ""): void {
  const s = scene.value;
  const media = player.value?.el?.()?.querySelector("video") ?? videoEl.value;
  if (s) reportPlaybackFailure(media, s.videoUrl, s.sceneIndex, kind, playbackEvents, name);
}
function watchLoading(): void {
  clearLoadingTimer();
  loadingTimer = setTimeout(() => {
    if (document.visibilityState === "visible" && loadedSlot.value !== null) diagnostic("load_timeout");
  }, 15000);
}
/*
 * True only after the newest published scene reaches its natural `ended`
 * event. This is the sole permission for a later playlist append to autoplay:
 * a user pause never sets it, and a subsequent play/pause clears it. Keeping
 * the current source untouched at the end also leaves the last frame visible.
 */
let waitingForNewScene = false;

function playLoadedScene(p: PlaybackController): void {
  waitingForNewScene = false;
  needsPlayGesture.value = false;
  watchLoading();
  const requestedSlot = loadedSlot.value;
  const requestedAttempt = ++playAttempt;
  void p.play()?.catch((error: unknown) => {
    // A previous source may reject after the viewer has already changed scenes.
    if (loadedSlot.value !== requestedSlot || playAttempt !== requestedAttempt) return;
    clearLoadingTimer();
    diagnostic("play_rejected", typeof error === "object" && error !== null && "name" in error ? String(error.name) : "");
    if (typeof error === "object" && error !== null && "name" in error && error.name === "NotAllowedError") {
      needsPlayGesture.value = true;
    }
  });
}

function loadCurrentAndPlay(): void {
  const p = player.value;
  if (!p || !scene.value) return;
  if (loadedSlot.value !== slot.value) loadScene(slot.value);
  playLoadedScene(p);
}

function retryPlayback(): void {
  const p = player.value;
  if (!p || !scene.value) return;
  waitingForNewScene = false;
  unloadScene();
  loadCurrentAndPlay();
}

/** Switch scenes without changing the user's play/pause intent. */
function goToScene(index: number): void {
  const p = player.value;
  if (!p || index < 0 || index >= scenes.value.length || index === slot.value) return;
  const shouldResume = !p.paused();
  waitingForNewScene = false;
  slot.value = index;
  if (shouldResume) {
    loadScene(index);
    playLoadedScene(p);
  } else {
    unloadScene();
  }
}

function goToPreviousScene(): void {
  goToScene(slot.value - 1);
}

function goToNextScene(): void {
  goToScene(slot.value + 1);
}

function selectScene(event: Event): void {
  const selectedSlot = Number((event.target as HTMLSelectElement).value);
  if (Number.isInteger(selectedSlot)) goToScene(selectedSlot);
}

async function boot(): Promise<void> {
  if (player.value || booting || !videoEl.value) return;
  booting = true;
  const [{ default: videojs }] = await Promise.all([
    import("video.js"),
    import("video.js/dist/video-js.css"),
  ]);
  booting = false;
  if (!videoEl.value) return;
  player.value = videojs(videoEl.value, {
    controls: true,
    preload: "none",
    fluid: false,
    responsive: true,
    playsinline: true,
    html5: { nativeControlsForTouch: false },
    inactivityTimeout: 1500,
    language: "en",
    controlBar: { subsCapsButton: false },
  });

  const p = player.value;
  for (const event of ["loadstart", "loadedmetadata", "loadeddata", "canplay", "playing", "waiting", "stalled", "suspend", "abort", "emptied", "pause", "ended", "error"]) {
    p.on(event, () => {
      playbackEvents.push(`${event}:${Math.round(performance.now())}`);
      if (playbackEvents.length > 16) playbackEvents.shift();
    });
  }
  p.on("playing", clearLoadingTimer);
  p.on("playing", () => {
    playbackFailed.value = false;
    if (videoEl.value?.dataset.playbackDelivery === "buffered" && !bufferedPlayingReported) {
      bufferedPlayingReported = true;
      diagnostic("buffered_playing");
    } else if (mobilePlayback && !nativePlayingReported) {
      nativePlayingReported = true;
      diagnostic("check_result");
    }
  });
  p.on("waiting", watchLoading);
  p.on("stalled", () => { if (!p.paused()) watchLoading(); });
  p.on("error", () => {
    clearLoadingTimer();
    hideMobileControls.value = false;
    diagnostic("media_error");
    waitingForNewScene = false;
    const recovery = p.recoverSource?.();
    if (!recovery) {
      playbackFailed.value = true;
      return;
    }
    playAttempt += 1;
    playbackRecovering.value = true;
    playbackFailed.value = false;
    needsPlayGesture.value = false;
    const requestedRevision = sourceRevision;
    void recovery.then(() => {
      if (player.value !== p || sourceRevision !== requestedRevision) return;
      playbackRecovering.value = false;
      diagnostic("buffered_ready");
      playLoadedScene(p);
    }).catch(error => {
      if (player.value !== p || sourceRevision !== requestedRevision) return;
      playbackRecovering.value = false;
      playbackFailed.value = true;
      diagnostic("buffered_failed", error instanceof Error ? error.name : "");
    });
  });
  p.on("ended", () => {
    if (scenes.value.length === 0) return;
    const next = slot.value + 1;
    if (next >= scenes.value.length) {
      waitingForNewScene = true;
      return;
    }
    slot.value = next;
    loadScene(slot.value);
    playLoadedScene(p);
  });
  // A pause before `ended` is the user's decision and must survive future
  // playlist updates. Browsers may emit `pause` on the natural-end path too;
  // `ended()` distinguishes that event regardless of event ordering.
  p.on("pause", () => {
    clearLoadingTimer();
    if (!p.ended()) waitingForNewScene = false;
  });
  p.on("play", () => {
    waitingForNewScene = false;
  });
  p.on("timeupdate", () => {
    currentTimeMs.value = Math.floor((p.currentTime() ?? 0) * 1000);
    emit("time", currentTimeMs.value);
  });
  p.on("loadedmetadata", readDuration);
  p.on("durationchange", readDuration);
}

// The playlist arrives with the first poll, so boot the player the moment
// there is something in it — and not before.
watch(
  () => scenes.value.length,
  (count, previous) => {
    if (count === 0) {
      player.value?.pause();
      unloadScene();
      slot.value = 0;
      currentTimeMs.value = 0;
      durationMs.value = null;
      waitingForNewScene = false;
      shown.clear();
      return;
    }
    if (!player.value) {
      void boot();
    } else if (previous === 0) {
      slot.value = 0;
      unloadScene();
    } else if (slot.value >= count) {
      slot.value = count - 1;
      unloadScene();
    } else if (count > previous && waitingForNewScene) {
      const next = slot.value + 1;
      if (next >= count) return;
      slot.value = next;
      loadScene(next);
      playLoadedScene(player.value);
    }
  },
);

// If the playlist was already loaded before this view mounted, the watcher
// above never fires — boot from the mount hook instead.
onMounted(() => {
  if (hasVideo.value) void boot();
});

onBeforeUnmount(() => {
  sourceRevision += 1;
  playAttempt += 1;
  clearLoadingTimer();
  player.value?.dispose();
  player.value = null;
});

/* ---------------------------------------------------------- danmaku layer */

interface Bullet {
  key: number;
  text: string;
  lane: number;
  durationMs: number;
}

const bullets = ref<Bullet[]>([]);
const LANES = 8;
const laneFreeAt: number[] = new Array(LANES).fill(0);
let bulletKey = 0;

/* Spec §10: bounded density — one bullet per lane at a time, and a lane is
   only reusable once its previous bullet has cleared the right edge. */
function spawn(text: string): void {
  const nowMs = performance.now();
  const lane = laneFreeAt.findIndex((free) => free <= nowMs);
  if (lane === -1) return;
  const durationMs = 9000 + Math.min(text.length, 40) * 90;
  laneFreeAt[lane] = nowMs + durationMs * 0.45;
  const bullet: Bullet = { key: (bulletKey += 1), text, lane, durationMs };
  bullets.value = [...bullets.value, bullet];
  window.setTimeout(() => {
    bullets.value = bullets.value.filter((b) => b.key !== bullet.key);
  }, durationMs);
}

/* Comments are anchored to playback time, so replaying a stretch shows them
   again (spec §7). `shown` is cleared whenever the scene restarts. The track
   is the scene's own (§14.2), not the site-wide recent feed, so a comment on
   an old scene still appears when that scene comes back round. */
watch(currentTimeMs, (ms, previous) => {
  if (!showDanmaku.value) return;
  if (ms < previous) shown.clear();
  const current = scene.value?.sceneIndex ?? null;
  for (const d of live.sceneDanmaku) {
    if (current !== null && d.sceneIndex !== current) continue;
    if (d.offsetMs > ms || d.offsetMs <= previous) continue;
    if (shown.has(d.id)) continue;
    shown.add(d.id);
    spawn(d.content);
  }
});

// Spec §4.1: turning the overlay off clears the screen immediately and stops
// new bullets entering it.
watch(showDanmaku, (on) => {
  if (!on) {
    bullets.value = [];
    laneFreeAt.fill(0);
  }
});

/**
 * Locally echo a comment the user just sent, so it appears without waiting for
 * a refetch. Its id is marked shown so the copy that arrives with the scene's
 * track does not draw a second bullet at the same offset.
 */
function push(row: Danmaku): void {
  shown.add(row.id);
  if (showDanmaku.value) spawn(row.content);
}

defineExpose({ push, anchor, currentTimeMs });
</script>

<template>
  <div class="player">
    <div class="screen" :class="{ 'mobile-controls-hidden': hideMobileControls }" @pointerup.capture="revealControls" @click.capture="revealControls" @keydown.capture="revealControls">
      <video
        v-show="hasVideo"
        ref="videoEl"
        class="video-js vjs-default-skin"
        :aria-label="t('player.a11y')"
        playsinline
        preload="none"
      ></video>

      <div v-if="siteDesign === 'studio' && hasVideo && !sourceLoaded" class="studio-player-cover" data-test="player-cover">
        <img v-if="coverUrl && !coverFailed" :src="coverUrl" alt="" decoding="async" @error="coverFailed = true" />
        <div class="studio-cover-copy">
          <span>WEIRDWIRED</span>
          <strong>{{ viewingMovieTitle }}</strong>
          <small v-if="scene">{{ t("player.scene", { ep: String(scene.episodeIndex).padStart(2, '0'), scene: String(scene.sceneIndex).padStart(6, '0') }) }}</small>
        </div>
      </div>

      <button
        v-if="hasVideo && (!sourceLoaded || needsPlayGesture)"
        class="video-demand-play"
        type="button"
        data-test="load-video"
        @click="loadCurrentAndPlay"
      >
        <span aria-hidden="true">▶</span>
        {{ t("player.load_video") }}
      </button>

      <div v-if="playbackFailed" class="playback-error" role="alert" data-test="playback-error">
        <p>{{ t("player.load_failed") }}</p>
        <button type="button" data-test="retry-video" @click="retryPlayback">{{ t("player.retry_video") }}</button>
        <a v-if="scene" :href="scene.videoUrl" target="_blank" rel="noopener" data-test="direct-video">{{ t("player.open_direct") }}</a>
      </div>

      <div v-if="playbackRecovering" class="playback-error" role="status" data-test="playback-recovering">
        <p>{{ t("player.buffering_video") }}</p>
        <a v-if="scene" :href="scene.videoUrl" target="_blank" rel="noopener">{{ t("player.open_direct") }}</a>
      </div>

      <div v-if="!hasVideo" class="screen-blank">
        <b>{{ t("player.empty_title") }}</b>
        <span>{{ t("player.empty_body") }}</span>
      </div>

      <div v-if="showDanmaku" class="dm-layer" aria-hidden="true">
        <span
          v-for="b in bullets"
          :key="b.key"
          class="dm"
          :style="{ top: `${4 + b.lane * 11}%`, animationDuration: `${b.durationMs}ms` }"
          >{{ b.text }}</span
        >
      </div>

      <nav v-if="hasVideo" class="scene-nav" :aria-label="t('player.scene_navigation')">
        <button
          class="scene-step"
          type="button"
          :title="t('player.previous_scene')"
          :aria-label="t('player.previous_scene')"
          :disabled="!canGoPrevious"
          data-test="previous-scene"
          @click="goToPreviousScene"
        >
          ‹
        </button>
        <button
          class="scene-step"
          type="button"
          :title="t('player.next_scene')"
          :aria-label="t('player.next_scene')"
          :disabled="!canGoNext"
          data-test="next-scene"
          @click="goToNextScene"
        >
          ›
        </button>
      </nav>
    </div>

    <div class="chrome-bar">
      <select
        v-if="scene"
        class="scene-picker"
        :value="slot"
        :aria-label="t('player.select_scene')"
        :title="t('player.select_scene')"
        data-test="scene-picker"
        @change="selectScene"
      >
        <option v-for="(item, index) in scenes" :key="item.sceneIndex" :value="index">
          {{
            t("player.scene", {
              ep: String(item.episodeIndex).padStart(2, "0"),
              scene: String(item.sceneIndex).padStart(6, "0"),
            })
          }}
        </option>
      </select>
      <span v-else>{{ t("player.empty_title") }}</span>
      <span v-if="scene && scene.authorUsername" class="player-author" :title="`@${scene.authorUsername}`"><span class="author-separator">· </span>@{{ scene.authorUsername }}</span>
      <span class="chrome-spacer" style="flex: 1"></span>
      <div class="playback-toggles">
        <label class="cc-switch" :class="{ 'control-disabled': mobilePlayback }" data-test="cc-switch" :title="mobilePlayback ? t('player.mobile_cc_paused') : undefined">
          <input v-model="subtitleToggle" type="checkbox" :disabled="mobilePlayback" />
          <span>{{ subtitleToggle ? t("player.hide_cc") : t("player.show_cc") }}</span>
        </label>
        <label class="dm-switch">
          <input v-model="showDanmaku" type="checkbox" />
          <span>{{ showDanmaku ? t("player.hide_dm") : t("player.show_dm") }}</span>
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Source changes can mark Video.js active or paused. Keep only its transient
   chrome hidden; our error/retry/gesture controls remain available. */
.mobile-controls-hidden :deep(.vjs-control-bar),
.mobile-controls-hidden :deep(.vjs-big-play-button),
.mobile-controls-hidden :deep(.vjs-loading-spinner) {
  opacity: 0 !important;
  visibility: hidden !important;
  pointer-events: none !important;
}

.playback-toggles { display: contents; }
.control-disabled { opacity: .55; cursor: not-allowed; }
@media (max-width: 1000px) {
  .chrome-bar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px 10px;
    padding: 12px;
  }
  .chrome-bar .scene-picker { width: 100%; min-width: 0; max-width: 240px; min-height: 36px; }
  .chrome-bar .player-author {
    justify-self: end;
    max-width: min(27vw, 150px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
    font: 500 12px var(--body);
  }
  .author-separator, .chrome-spacer { display: none; }
  .chrome-bar .playback-toggles {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .chrome-bar .playback-toggles > label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
    min-height: 44px;
    margin: 0;
    padding: 9px 10px;
    border: 1px solid color-mix(in srgb, currentColor 24%, transparent);
    border-radius: 9px;
    background: color-mix(in srgb, currentColor 6%, transparent);
    font: 600 12px var(--body);
    white-space: nowrap;
  }
  .playback-toggles > label > span { overflow: hidden; text-overflow: ellipsis; }
  .chrome-bar .playback-toggles input {
    appearance: none;
    -webkit-appearance: none;
    order: 2;
    flex: 0 0 32px;
    width: 32px;
    height: 18px;
    margin: 0;
    padding: 2px;
    border: 0;
    border-radius: 999px;
    background: color-mix(in srgb, currentColor 25%, transparent);
    cursor: pointer;
  }
  .chrome-bar .playback-toggles input::before {
    content: "";
    display: block;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 3px #0003;
  }
  .chrome-bar .playback-toggles input:checked { background: var(--teal); }
  .chrome-bar .playback-toggles input:checked::before { transform: translateX(14px); }
  .chrome-bar .playback-toggles input:disabled { cursor: not-allowed; }
  .chrome-bar .playback-toggles input:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
  .chrome-bar .playback-toggles label:has(input:checked) { border-color: var(--teal); }
}
.playback-error {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 24px 60px;
  background: #141b2b;
  color: #fff;
  text-align: center;
}
.playback-error a { color: #fff; padding: 8px; text-decoration: underline; }
.playback-error p { margin: 0; line-height: 1.6; }
.playback-error button {
  min-height: 44px;
  padding: 10px 20px;
  border: 2px solid #fff;
  border-radius: 8px;
  background: #fff;
  color: #141b2b;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}
</style>
