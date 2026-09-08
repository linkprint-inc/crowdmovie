import { afterEach, expect, it, vi } from "vitest";

const movie = {
  id: "movie-inland",
  slug: "inland-empire-high",
  titleI18n: { en: "Inland Empire High", "zh-CN": "内陆帝国高校" },
  synopsisI18n: { en: "A school serial." },
  posterUrl: null,
  heroUrl: null,
  defaultLocale: "en",
  primaryAudioLocale: "en",
  subtitleLocales: ["en", "zh-CN"],
  productionStatus: "ready" as const,
  rightsStatus: "original_cleared" as const,
};

const whosNext = {
  ...movie,
  id: "movie-whos-next",
  slug: "whos-next",
  titleI18n: { en: "Who's Next", "zh-CN": "下一个上场" },
  synopsisI18n: { en: "Movie heroes collide." },
};

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    api: {
      movies: vi.fn(async () => ({ movies: [whosNext, movie] })),
      currentProgram: vi.fn(async () => {
        throw new actual.ApiError(503, "program_off_air", "off air");
      }),
      movieCharacters: vi.fn(async () => ({ movieId: movie.id, characters: [] })),
      episodes: vi.fn(async () => ({ episodes: [] })),
    },
  };
});

it("defaults the homepage to Who's Next even when an old browser choice exists", async () => {
  localStorage.setItem("cm.viewingMovie", movie.slug);
  const store = await import("../src/stores/movies");

  await store.initializeMovies();

  expect(store.viewingMovieSlug.value).toBe(whosNext.slug);
  expect(store.viewingMovieTitle.value).toBe("Who's Next");
});

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

it("keeps the movie catalog usable while the scheduled program is off air", async () => {
  const store = await import("../src/stores/movies");

  await store.initializeMovies(movie.slug);

  expect(store.movies.catalog).toEqual([whosNext, movie]);
  expect(store.movies.program).toBeNull();
  expect(store.viewingMovieSlug.value).toBe(movie.slug);
  expect(store.viewingMovieTitle.value).toBe("Inland Empire High");
  expect(store.movies.error).toBeNull();
});

it("clears a stale replay selection when navigation returns to the homepage", async () => {
  const store = await import("../src/stores/movies");
  store.viewingMovieSlug.value = whosNext.slug;
  store.viewingEpisodeIndex.value = 2;

  const changed = await store.syncViewingContextFromRoute("live", undefined, undefined);

  expect(changed).toBe(true);
  expect(store.viewingMovieSlug.value).toBe(whosNext.slug);
  expect(store.viewingEpisodeIndex.value).toBeNull();
});
