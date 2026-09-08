<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { t } from "../i18n";
import { CONTROL_TEST_VIDEO_URL, reportPlaybackFailure } from "../lib/playback-diagnostics";

const mobile = ref(false);
const video = ref<HTMLVideoElement | null>(null);
const status = ref<"idle" | "loading" | "playing" | "failed">("idle");
let query: MediaQueryList;
let timer: ReturnType<typeof setTimeout> | undefined;
let reported = false;
const events: string[] = [];
function event(name: string) {
  events.push(`${name}:${Math.round(performance.now())}`);
  if (events.length > 16) events.shift();
}
function report(name: "playing" | "error" | "timeout", errorName = "") {
  clearTimeout(timer);
  event(name);
  status.value = name === "playing" ? "playing" : "failed";
  if (!reported) {
    reported = true;
    reportPlaybackFailure(video.value, CONTROL_TEST_VIDEO_URL, 14, "check_result", events, errorName, "external_control");
  }
}
function play() {
  const v = video.value;
  if (!v) return;
  reported = false;
  events.length = 0;
  status.value = "loading";
  clearTimeout(timer);
  v.src = CONTROL_TEST_VIDEO_URL;
  v.load();
  timer = setTimeout(() => report("timeout"), 15000);
  void v.play().catch(error => report("error", error instanceof Error ? error.name : ""));
}
function resize() {
  if (!query.matches) { video.value?.pause(); clearTimeout(timer); }
  mobile.value = query.matches;
}
onMounted(() => {
  query = matchMedia("(max-width: 1000px)");
  resize();
  query.addEventListener("change", resize);
});
onBeforeUnmount(() => { clearTimeout(timer); query?.removeEventListener("change", resize); });
</script>

<template>
  <section v-if="mobile" class="external-video-test" data-test="external-video-test">
    <h2>{{ t("player.external_test_title") }}</h2>
    <p>{{ t("player.external_test_description") }} <span>SCENE 000014 · 000014.mp4</span></p>
    <video ref="video" controls playsinline preload="none" :aria-label="t('player.external_test_title')"
      @loadstart="event('loadstart')" @loadedmetadata="event('loadedmetadata')"
      @playing="report('playing')" @error="report('error')" />
    <button type="button" @click="play">{{ t("player.external_test_play") }}</button>
    <p v-if="status !== 'idle'" role="status" aria-live="polite">
      {{ status === "loading" ? t("player.buffering_video") : status === "playing" ? t("player.external_test_playing") : t("player.load_failed") }}
    </p>
    <a :href="CONTROL_TEST_VIDEO_URL" target="_blank" rel="noopener noreferrer">{{ t("player.open_direct") }}</a>
  </section>
</template>

<style scoped>
.external-video-test { order: 4; grid-column: 1 / -1; padding: 18px; border: 1px solid #bbc3d6; border-radius: 12px; background: #fff; color: #192032; margin-bottom: 16px; }
h2 { margin: 0 0 8px; font-size: 20px; }
p { margin: 8px 0 14px; font-size: 14px; line-height: 1.6; }
p span { display: block; color: #667085; }
video { display: block; width: 100%; height: auto; aspect-ratio: 16 / 9; background: #111; border-radius: 8px; }
button { width: 100%; min-height: 44px; margin: 14px 0; padding: 10px 14px; border: 0; border-radius: 8px; background: #3348ec; color: #fff; font: inherit; cursor: pointer; }
a { color: #3348ec; font-size: 14px; }
</style>
