<script setup lang="ts">
import { computed, ref } from "vue";
import { locale, t } from "../i18n";
import type { Danmaku } from "../lib/api";
import { pad } from "../lib/format";
import ProductionStatus from "../components/ProductionStatus.vue";
import MoviePlayer from "../components/MoviePlayer.vue";
import RightRail from "../components/RightRail.vue";
import GenerationPromptPanel from "../components/GenerationPromptPanel.vue";
import { live, nextPublicRound } from "../stores/live";
import { siteDesign } from "../stores/prefs";
import {
  openMoviePicker,
  viewingEpisodeIndex,
  viewingMovie,
  viewingMovieTitle,
} from "../stores/movies";

/*
 * Spec §3: desktop is two columns at roughly 64/36. The page itself does not
 * scroll — the left column scrolls inside the viewport and the right rail is
 * height-locked.
 *
 * Spec §9: below 1000px it is one column ordered player, rail, setting. The
 * player and the setting share a scroll container on desktop but must be
 * separated by the rail on mobile, so `.left` becomes `display: contents`
 * there and its two children take their own grid order.
 */

const playerRef = ref<InstanceType<typeof MoviePlayer> | null>(null);

/* The comment box's anchor comes from the player and nowhere else: it is the
   scene on screen and the position inside it (§14.1). Null while the playlist
   is empty, which is what puts the box into its read-only state. */
const anchor = computed(() => playerRef.value?.anchor ?? null);

const movieSetting = computed(() => {
  const movie = viewingMovie.value;
  if (movie === null) return "";
  const synopsis =
    movie.synopsisI18n[locale.value] ??
    movie.synopsisI18n[movie.defaultLocale] ??
    "";
  return movie.storySetting?.trim() || synopsis;
});

function onDanmaku(row: Danmaku): void {
  playerRef.value?.push(row);
}
</script>

<template>
  <main class="stage">
    <div class="left">
      <section class="player-col">
        <div v-show="siteDesign === 'classic'" class="showrow">
          <span
            class="show-chip movie-title-chip"
            role="button"
            tabindex="0"
            aria-haspopup="dialog"
            aria-label="点击切换影片"
            data-tooltip="点击切换影片"
            @click="openMoviePicker()"
            @keydown.enter="openMoviePicker()"
            @keydown.space.prevent="openMoviePicker()"
          >
            {{ viewingMovieTitle }}
          </span>
          <ProductionStatus compact />
          <span class="show-chip" v-if="live.episode">
            EP {{ pad(live.episode.episodeIndex, 2) }} ·
            <b v-if="viewingEpisodeIndex !== null">REPLAY</b>
            <b v-else-if="live.round">ROUND {{ pad(nextPublicRound) }}</b>
          </span>
        </div>

        <MoviePlayer ref="playerRef" />
      </section>

      <section class="story-setting-col">
        <h2 class="sec-label story-setting-heading">
          {{ t("setting.title") }}
          <span class="story-movie-title">{{ viewingMovieTitle }}</span>
          <button
            class="story-setting-switch"
            type="button"
            aria-haspopup="dialog"
            @click="openMoviePicker()"
          >
            {{ t("setting.switch_episode") }}
          </button>
        </h2>
        <div class="movie-story-setting" data-test="movie-story-setting">
          <p>{{ movieSetting || t("setting.empty") }}</p>
        </div>
        <GenerationPromptPanel />
      </section>
    </div>

    <RightRail :anchor="anchor" @danmaku="onDanmaku" />
  </main>
</template>

<style scoped>
/* Let wheel/trackpad gestures continue into the left column (or mobile page)
   when this nested text box has no overflow or reaches its scroll boundary. */
.movie-story-setting { overscroll-behavior-y: auto; }
</style>
