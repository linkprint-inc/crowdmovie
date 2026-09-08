import { computed, reactive, ref } from "vue";
import {
  ApiError,
  api,
  type CurrentProgram,
  type EpisodeSummary,
  type MovieCharacter,
  type MovieSummary,
} from "../lib/api";
import { locale } from "../i18n";

export const LEGACY_MOVIE_SLUG = "inland-empire-high";
export const DEFAULT_MOVIE_SLUG = "whos-next";

interface MovieState {
  catalog: MovieSummary[];
  program: CurrentProgram | null;
  characters: MovieCharacter[];
  episodes: EpisodeSummary[];
  loading: boolean;
  error: string | null;
}

export const movies = reactive<MovieState>({
  catalog: [],
  program: null,
  characters: [],
  episodes: [],
  loading: false,
  error: null,
});

export const viewingMovieSlug = ref(DEFAULT_MOVIE_SLUG);
export const viewingEpisodeIndex = ref<number | null>(null);
export const moviePickerOpen = ref(false);

export const viewingMovie = computed(
  () => movies.catalog.find((movie) => movie.slug === viewingMovieSlug.value) ?? null,
);

export const viewingMovieTitle = computed(() => {
  const movie = viewingMovie.value;
  if (movie === null) return "CrowdMovie";
  return movie.titleI18n[locale.value] ?? movie.titleI18n[movie.defaultLocale] ?? movie.slug;
});

export const scheduledMovieId = computed(() => movies.program?.movie.id ?? null);
export const isViewingLiveProgram = computed(
  () =>
    movies.program?.state === "active" &&
    viewingMovie.value?.id === movies.program.movie.id &&
    viewingEpisodeIndex.value === null,
);

export function openMoviePicker(): void {
  moviePickerOpen.value = true;
}

export function closeMoviePicker(): void {
  moviePickerOpen.value = false;
}

export async function loadMovieContext(slug: string): Promise<void> {
  const generationSlug = slug;
  const [characters, episodes] = await Promise.all([
    api.movieCharacters(slug),
    api.episodes(slug),
  ]);
  if (viewingMovieSlug.value !== generationSlug) return;
  movies.characters = characters.characters;
  movies.episodes = episodes.episodes;
}

export async function chooseViewingContext(
  slug: string,
  episodeIndex: number | null = null,
): Promise<void> {
  viewingMovieSlug.value = slug;
  viewingEpisodeIndex.value = episodeIndex;
  closeMoviePicker();
  await loadMovieContext(slug);
}

/**
 * Keep the selected movie/episode in lockstep with navigation. The bare `/`
 * route is the homepage, so it always means the default movie's live window;
 * otherwise a visit back from `/watch/:index` can leave the whole app stuck in
 * replay mode even though the URL says home.
 */
export async function syncViewingContextFromRoute(
  routeName: unknown,
  rawSlug: unknown,
  rawIndex: unknown,
): Promise<boolean> {
  let slug: string;
  let episodeIndex: number | null;

  if (routeName === "live") {
    slug = DEFAULT_MOVIE_SLUG;
    episodeIndex = null;
  } else if (typeof rawSlug === "string") {
    slug = rawSlug;
    const parsed = Number(rawIndex);
    episodeIndex = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  } else {
    return false;
  }

  if (slug === viewingMovieSlug.value && episodeIndex === viewingEpisodeIndex.value) {
    return false;
  }
  await chooseViewingContext(slug, episodeIndex);
  return true;
}

export async function initializeMovies(preferredSlug?: string): Promise<void> {
  movies.loading = true;
  try {
    const catalog = await api.movies();
    movies.catalog = catalog.movies;
    let program: CurrentProgram | null = null;
    try {
      program = await api.currentProgram();
    } catch (error) {
      if (!(error instanceof ApiError && error.code === "program_off_air")) throw error;
    }
    movies.program = program;
    const hasDefault = catalog.movies.some((movie) => movie.slug === DEFAULT_MOVIE_SLUG);
    const fallbackSlug = hasDefault
      ? DEFAULT_MOVIE_SLUG
      : (program?.movie.slug ?? catalog.movies[0]?.slug ?? LEGACY_MOVIE_SLUG);
    const candidate = preferredSlug ?? fallbackSlug;
    const slug = catalog.movies.some((movie) => movie.slug === candidate)
      ? candidate
      : fallbackSlug;
    viewingMovieSlug.value = slug;
    await loadMovieContext(slug);
    movies.error = null;
  } catch (error) {
    movies.error = error instanceof Error ? error.message : String(error);
  } finally {
    movies.loading = false;
  }
}
