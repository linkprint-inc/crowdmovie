<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { locale } from "../i18n";
import { api, type EpisodeSummary, type MovieSummary } from "../lib/api";
import { pad } from "../lib/format";
import {
  chooseViewingContext,
  closeMoviePicker,
  moviePickerOpen,
  movies,
  viewingMovieSlug,
} from "../stores/movies";
import { switchLiveContext } from "../stores/live";

const router = useRouter();
const focusedSlug = ref(viewingMovieSlug.value);
const episodeCache = ref<Record<string, EpisodeSummary[]>>({});
const loadingSlug = ref<string | null>(null);

const focusedMovie = computed(
  () => movies.catalog.find((movie) => movie.slug === focusedSlug.value) ?? null,
);
const focusedEpisodes = computed(() => episodeCache.value[focusedSlug.value] ?? []);

function copy(movie: MovieSummary, field: "titleI18n" | "synopsisI18n"): string {
  return movie[field][locale.value] ?? movie[field][movie.defaultLocale] ?? movie.slug;
}

function posterImages(movie: MovieSummary): string[] {
  return movie.posterImages?.slice(0, 4) ?? [];
}

async function focusMovie(slug: string): Promise<void> {
  focusedSlug.value = slug;
  if (episodeCache.value[slug] !== undefined) return;
  loadingSlug.value = slug;
  try {
    const result = await api.episodes(slug);
    episodeCache.value = { ...episodeCache.value, [slug]: result.episodes };
  } finally {
    if (loadingSlug.value === slug) loadingSlug.value = null;
  }
}

async function select(movie: MovieSummary, episodeIndex: number | null): Promise<void> {
  await chooseViewingContext(movie.slug, episodeIndex);
  switchLiveContext();
  await router.push(
    episodeIndex === null
      ? { name: "movie-live", params: { movieSlug: movie.slug } }
      : {
          name: "movie-replay",
          params: { movieSlug: movie.slug, index: episodeIndex },
        },
  );
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") closeMoviePicker();
}

watch(moviePickerOpen, (open) => {
  if (!open) {
    document.removeEventListener("keydown", onKeydown);
    return;
  }
  focusedSlug.value = viewingMovieSlug.value;
  void focusMovie(focusedSlug.value);
  document.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
  <Teleport to="body">
    <div v-if="moviePickerOpen" class="movie-picker-backdrop" @click.self="closeMoviePicker()">
      <section class="movie-picker" role="dialog" aria-modal="true" aria-label="切换影片">
        <header class="movie-picker-head">
          <div>
            <p class="eyebrow">NOW SHOWING / ARCHIVE</p>
            <h2>选择影片与剧集</h2>
            <p>历史剧集只切换你的回放；实时剧情仍由后台固定排期控制。</p>
          </div>
          <button type="button" class="movie-picker-close" aria-label="关闭" @click="closeMoviePicker()">
            ×
          </button>
        </header>

        <div class="movie-picker-body">
          <nav class="movie-shelf" aria-label="影片列表">
            <button
              v-for="movie in movies.catalog"
              :key="movie.id"
              type="button"
              class="movie-poster-card"
              :class="{ selected: focusedSlug === movie.slug }"
              @click="focusMovie(movie.slug)"
            >
              <span
                class="movie-poster-art"
                :class="[
                  `movie-${movie.slug}`,
                  { 'movie-poster-mosaic': posterImages(movie).length > 1 },
                ]"
              >
                <template v-if="posterImages(movie).length > 0">
                  <img
                    v-for="image in posterImages(movie)"
                    :key="image"
                    :src="image"
                    alt=""
                    loading="lazy"
                  />
                </template>
                <img v-else-if="movie.posterUrl" :src="movie.posterUrl" alt="" />
                <img
                  v-else-if="movie.slug === 'whos-next'"
                  src="/whos-next-title-88f57667.webp"
                  alt=""
                />
                <b v-else>{{ copy(movie, "titleI18n").slice(0, 2) }}</b>
              </span>
              <span class="movie-poster-copy">
                <strong>{{ copy(movie, "titleI18n") }}</strong>
                <small>{{ movie.primaryAudioLocale }} AUDIO</small>
              </span>
              <i v-if="movies.program?.movie.id === movie.id">当前排期</i>
            </button>
          </nav>

          <div v-if="focusedMovie" class="movie-detail-panel">
            <div class="movie-detail-copy">
              <p class="eyebrow">{{ focusedMovie.slug }}</p>
              <h3>{{ copy(focusedMovie, "titleI18n") }}</h3>
              <p>{{ copy(focusedMovie, "synopsisI18n") }}</p>
              <div class="movie-facts">
                <span>配音 {{ focusedMovie.primaryAudioLocale }}</span>
                <span>{{ focusedMovie.subtitleLocales.length }} 种字幕</span>
                <span v-if="focusedMovie.productionStatus !== 'ready'">筹备中</span>
                <span v-else-if="focusedMovie.rightsStatus === 'original_cleared'">原创清权</span>
                <span v-else-if="focusedMovie.rightsStatus === 'licensed'">授权内容</span>
                <span v-else>权利待确认</span>
              </div>
              <button type="button" class="watch-live" @click="select(focusedMovie, null)">
                进入该片放映室
              </button>
            </div>

            <div class="episode-picker">
              <div class="episode-picker-title">
                <h4>选择剧集</h4>
                <span>{{ focusedEpisodes.length }} EPISODES</span>
              </div>
              <p v-if="loadingSlug === focusedSlug" class="movie-picker-empty">正在载入剧集…</p>
              <p v-else-if="focusedEpisodes.length === 0" class="movie-picker-empty">
                影片已入库，首集将在排期到达后自动创建。
              </p>
              <button
                v-for="episode in focusedEpisodes"
                :key="episode.episodeIndex"
                type="button"
                class="episode-choice"
                @click="select(focusedMovie, episode.episodeIndex)"
              >
                <span>EP {{ pad(episode.episodeIndex, 2) }}</span>
                <b>{{ episode.title }}</b>
                <small>{{ episode.sceneCount }} 镜头 · {{ episode.status === "open" ? "生成中" : "已完结" }}</small>
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>
