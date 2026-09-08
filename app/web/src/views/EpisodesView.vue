<script setup lang="ts">
import { computed } from "vue";
import { t } from "../i18n";
import { api, type EpisodeSummary, type MovieSummary } from "../lib/api";
import { pad } from "../lib/format";
import { useResource } from "../lib/useResource";
import MovieCatalogHeader from "../components/MovieCatalogHeader.vue";
import PageState from "../components/PageState.vue";

const props = defineProps<{ movieSlug?: string }>();

interface EpisodeGroup {
  movie: MovieSummary;
  episodes: EpisodeSummary[];
}

function newestFirst(episodes: EpisodeSummary[]): EpisodeSummary[] {
  return [...episodes].sort((a, b) => b.episodeIndex - a.episodeIndex);
}

async function loadGroups(): Promise<EpisodeGroup[]> {
  if (props.movieSlug !== undefined) {
    const [movie, result] = await Promise.all([
      api.movie(props.movieSlug),
      api.episodes(props.movieSlug),
    ]);
    return [{ movie, episodes: newestFirst(result.episodes) }];
  }

  const catalog = await api.movies();
  return Promise.all(
    catalog.movies.map(async (movie) => ({
      movie,
      episodes: newestFirst((await api.episodes(movie.slug)).episodes),
    })),
  );
}

const { data, loading, missing, error, reload } = useResource(loadGroups);
const groups = computed(() => data.value ?? []);
</script>

<template>
  <div class="page">
    <div class="inner">
      <h2 class="ptitle">
        {{ t("eps.title") }} <small>{{ t("catalog.episodes_sub") }}</small>
      </h2>
      <p class="plead">{{ t("catalog.episodes_lead") }}</p>

      <PageState
        :loading="loading"
        :missing="missing"
        :error="error"
        :empty-title="groups.length === 0 ? t('catalog.empty_title') : undefined"
        :empty-body="t('catalog.empty_body')"
        @retry="reload()"
      />

      <div v-if="groups.length > 0" class="movie-catalog">
        <section
          v-for="group in groups"
          :key="group.movie.id"
          class="movie-catalog-section episode-catalog-section"
        >
          <MovieCatalogHeader :movie="group.movie" />

          <p v-if="group.episodes.length === 0" class="empty catalog-empty">
            <b>{{ t("eps.empty_title") }}</b>
            {{ t("eps.empty_body") }}
          </p>

          <div
            v-else
            class="episode-strip movie-catalog-content"
            role="region"
            tabindex="0"
            :aria-label="t('catalog.episodes_scroll')"
          >
            <article
              v-for="ep in group.episodes"
              :key="`${group.movie.id}-${ep.episodeIndex}`"
              class="ep-card"
              :class="{ live: ep.status === 'open' }"
            >
              <div class="ep-top">
                <span class="ep-no">EP {{ pad(ep.episodeIndex, 2) }}</span>
                <span class="ep-state" :class="ep.status === 'open' ? 'on' : 'done'">
                  {{ ep.status === "open" ? t("eps.airing") : t("eps.ended") }}
                </span>
              </div>
              <h3>{{ ep.title }}</h3>
              <p>{{ ep.premise }}</p>
              <div class="ep-meta">
                <span>{{ t("eps.scenes") }} <b>{{ ep.sceneCount }}</b></span>
                <span>{{ t("eps.submissions") }} <b>{{ ep.submissionCount }}</b></span>
              </div>
              <p class="by">
                <template v-if="ep.themeSourceUsername">
                  {{
                    t("eps.theme_by", {
                      name: `@${ep.themeSourceUsername}`,
                      votes: ep.themeSourceVotes ?? 0,
                    })
                  }}
                </template>
                <template v-else>{{ t("eps.theme_ai") }}</template>
              </p>
              <RouterLink
                class="ep-open"
                :to="{
                  name: 'movie-episode',
                  params: { movieSlug: group.movie.slug, index: ep.episodeIndex },
                }"
              >
                {{ t("eps.open") }}
              </RouterLink>
            </article>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
