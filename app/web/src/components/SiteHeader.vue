<script setup lang="ts">
import ProductionStatus from "./ProductionStatus.vue";
import { computed } from "vue";
import { LOCALES, LOCALE_NAMES, locale, setLocale, t, type Locale } from "../i18n";
import { nextPublicRound, live, msToDeadline } from "../stores/live";
import {
  isViewingLiveProgram,
  movies,
  viewingEpisodeIndex,
  viewingMovieTitle,
  openMoviePicker,
} from "../stores/movies";
import { siteDesign } from "../stores/prefs";

defineProps<{ screening?: boolean }>();

/* Spec §6.1: the countdown lives in the header's right cell next to the
   language select, and switches to a red title-card disc for the last 10s. */
const secondsLeft = computed(() => {
  const ms = msToDeadline.value;
  if (ms === null) return null;
  return Math.max(0, Math.ceil(ms / 1000));
});

const final = computed(() => secondsLeft.value !== null && secondsLeft.value <= 10);

/* 未点火的一轮没有截止时间（后端 §5.3）：在有人投稿之前显示等待，而不是一个
   停在 --:-- 的假倒计时。 */
const idle = computed(() => live.round !== null && live.round.closesAt === null);

const clockText = computed(() => {
  const s = secondsLeft.value;
  if (s === null) return "--:--";
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return `${String(m).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
});

/* Next video scene, not the submission round: failed rounds produce no scene. */
const nextSceneIndex = nextPublicRound;

/* Filled portion of the disc: 0° with 10s to go, a full turn at zero. */
const discDeg = computed(() => `${((10 - (secondsLeft.value ?? 10)) / 10) * 360}deg`);

const liveChip = computed(() => {
  if (viewingEpisodeIndex.value !== null) {
    return t("head.episode_replay", {
      episode: String(viewingEpisodeIndex.value).padStart(2, "0"),
    });
  }
  if (!isViewingLiveProgram.value) return t("head.movie_replay");
  return live.round
    ? t("head.live", { scene: String(nextSceneIndex.value).padStart(6, "0") })
    : t("head.live_idle");
});

const liveMovieSlug = computed(() =>
  movies.program?.state === "active" ? movies.program.movie.slug : null,
);

function onLocaleChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  setLocale(value as Locale);
}
</script>

<template>
  <header>
    <div class="head-left">
      <h1 class="mast">
        <RouterLink :to="{ name: 'live' }">
          <img class="mark" src="/logo-144.png" alt="" width="36" height="36" />
          <span>CROWD<span class="ai">AI</span>MOVIE</span>
        </RouterLink>
      </h1>
      <div v-if="siteDesign === 'studio' && screening" class="movie-title-status">
      <h1 class="studio-movie-heading">
        <button type="button" class="studio-movie-switch" aria-haspopup="dialog" :title="t('setting.switch_episode')" @click="openMoviePicker()">
          {{ viewingMovieTitle }}
          <svg class="studio-movie-chevron" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </h1>
      <ProductionStatus compact />
      </div>
      <span class="live-chip"><i></i>{{ liveChip }}</span>
    </div>
    <div class="head-right">
      <div v-if="isViewingLiveProgram" class="clock" :class="{ final }">
        <span class="lbl">{{ t(idle ? "head.deadline_idle" : "head.deadline") }}</span>
        <span class="t">{{ clockText }}</span>
        <span class="leader" :style="{ '--deg': discDeg }">
          <b>{{ secondsLeft ?? "" }}</b>
        </span>
        <span class="visually-hidden" role="timer">{{
          idle ? t("head.idle_a11y") : t("head.countdown_a11y", { time: clockText })
        }}</span>
      </div>
      <div v-else class="clock replay-clock">
        <span class="lbl">{{ t("head.view_mode") }}</span>
        <span class="t">{{ t("head.read_only") }}</span>
      </div>
      <RouterLink
        v-if="!isViewingLiveProgram && liveMovieSlug !== null"
        class="return-live"
        :to="{ name: 'movie-live', params: { movieSlug: liveMovieSlug } }"
      >
        {{ t("head.return_live") }}
      </RouterLink>
      <select
        v-model="siteDesign"
        class="design-select"
        :aria-label="t('design.label')"
        data-test="design-select"
      >
        <option value="studio">{{ t("design.studio") }}</option>
        <option value="classic">{{ t("design.classic") }}</option>
      </select>
      <select
        class="lang-select"
        :aria-label="t('head.lang')"
        :value="locale"
        @change="onLocaleChange"
      >
        <option v-for="code in LOCALES" :key="code" :value="code">
          {{ LOCALE_NAMES[code] }}
        </option>
      </select>
    </div>
  </header>
</template>

<style scoped>
.movie-title-status { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 16px; min-width: 0; width: 100%; }
.movie-title-status h1 { margin: 0; }
.movie-title-status :deep(.production-status) { margin-left: auto; }
.head-left:has(.movie-title-status) > .live-chip { flex-basis: 100%; }
</style>
