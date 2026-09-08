<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { locale, t } from "../i18n";
import type { MovieSummary } from "../lib/api";

const props = defineProps<{ movie: MovieSummary }>();

function copy(field: "titleI18n" | "synopsisI18n"): string {
  return (
    props.movie[field][locale.value] ??
    props.movie[field][props.movie.defaultLocale] ??
    props.movie.slug
  );
}

const failedStill = ref(false);
const sceneStill = computed(() => failedStill.value ? null : props.movie.sceneStillUrl);
watch(() => props.movie.sceneStillUrl, () => { failedStill.value = false; });

function posterImages(): string[] {
  return props.movie.posterImages?.slice(0, 4) ?? [];
}
</script>

<template>
  <header class="movie-catalog-head">
    <RouterLink
      class="movie-catalog-art"
      :class="{ mosaic: !sceneStill && posterImages().length > 1 }"
      :to="{ name: 'movie-live', params: { movieSlug: movie.slug } }"
      :aria-label="copy('titleI18n')"
    >
      <img v-if="sceneStill" :src="sceneStill" alt="" loading="lazy" @error="failedStill = true" />
      <template v-else-if="posterImages().length > 0">
        <img
          v-for="image in posterImages()"
          :key="image"
          :src="image"
          alt=""
          loading="lazy"
        />
      </template>
      <img v-else-if="movie.posterUrl" :src="movie.posterUrl" alt="" loading="lazy" />
      <b v-else>{{ copy("titleI18n").slice(0, 2) }}</b>
    </RouterLink>

    <div class="movie-catalog-copy">
      <p class="eyebrow">MOVIE · {{ movie.slug }}</p>
      <h3>{{ copy("titleI18n") }}</h3>
      <p>{{ copy("synopsisI18n") }}</p>
      <div class="movie-catalog-facts">
        <span>{{ movie.primaryAudioLocale }} AUDIO</span>
        <span>{{ movie.subtitleLocales.length }} CC</span>
      </div>
    </div>

    <RouterLink
      class="movie-catalog-open"
      :to="{ name: 'movie-live', params: { movieSlug: movie.slug } }"
    >
      {{ t("catalog.open_movie") }}
    </RouterLink>
  </header>
</template>
