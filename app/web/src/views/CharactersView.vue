<script setup lang="ts">
import { computed } from "vue";
import { t } from "../i18n";
import { api, type MovieCharacter, type MovieSummary } from "../lib/api";
import { useResource } from "../lib/useResource";
import MovieCatalogHeader from "../components/MovieCatalogHeader.vue";
import MovieCharacterCard from "../components/MovieCharacterCard.vue";
import PageState from "../components/PageState.vue";

const props = defineProps<{ movieSlug?: string }>();

interface CharacterGroup {
  movie: MovieSummary;
  characters: MovieCharacter[];
}

async function loadGroups(): Promise<CharacterGroup[]> {
  if (props.movieSlug !== undefined) {
    const [movie, result] = await Promise.all([
      api.movie(props.movieSlug),
      api.movieCharacters(props.movieSlug),
    ]);
    return [{ movie, characters: result.characters }];
  }

  const catalog = await api.movies();
  return Promise.all(
    catalog.movies.map(async (movie) => ({
      movie,
      characters: (await api.movieCharacters(movie.slug)).characters,
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
        {{ t("chars.title") }} <small>{{ t("catalog.characters_sub") }}</small>
      </h2>
      <p class="plead">{{ t("catalog.characters_lead") }}</p>

      <PageState
        :loading="loading"
        :missing="missing"
        :error="error"
        :empty-title="groups.length === 0 ? t('catalog.empty_title') : undefined"
        :empty-body="t('catalog.empty_body')"
        @retry="reload()"
      />

      <div v-if="groups.length > 0" class="movie-catalog">
        <section v-for="group in groups" :key="group.movie.id" class="movie-catalog-section">
          <MovieCatalogHeader :movie="group.movie" />

          <p v-if="group.characters.length === 0" class="empty catalog-empty">
            <b>{{ t("catalog.characters_empty") }}</b>
          </p>
          <div v-else class="char-grid movie-catalog-content">
            <MovieCharacterCard
              v-for="character in group.characters"
              :key="`${group.movie.id}-${character.key}`"
              :character="character"
              :movie-slug="group.movie.slug"
            />
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
