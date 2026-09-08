import { mount } from "@vue/test-utils";
import { beforeEach, expect, it, vi } from "vitest";

import MoviePickerModal from "../src/components/MoviePickerModal.vue";
import { locale } from "../src/i18n";
import { moviePickerOpen, movies, viewingMovieSlug } from "../src/stores/movies";

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

beforeEach(() => {
  locale.value = "en";
  viewingMovieSlug.value = "inland-empire-high";
  moviePickerOpen.value = true;
  movies.program = null;
  movies.catalog = [
    {
      id: "movie-inland",
      slug: "inland-empire-high",
      titleI18n: { en: "Inland Empire High" },
      synopsisI18n: { en: "A high-school crowd movie." },
      posterUrl: null,
      posterImages: ["/c0.webp", "/c1.webp", "/w0.webp", "/w1.webp"],
      heroUrl: null,
      defaultLocale: "en",
      primaryAudioLocale: "en",
      subtitleLocales: ["en"],
      productionStatus: "ready",
      rightsStatus: "original_cleared",
    },
  ];
});

it("renders the four poster images as a mosaic inside movie-poster-art", () => {
  const wrapper = mount(MoviePickerModal, {
    global: { stubs: { Teleport: true } },
  });
  const art = wrapper.get(".movie-poster-art.movie-inland-empire-high");

  expect(art.classes()).toContain("movie-poster-mosaic");
  expect(art.findAll("img").map((image) => image.attributes("src"))).toEqual([
    "/c0.webp",
    "/c1.webp",
    "/w0.webp",
    "/w1.webp",
  ]);

  wrapper.unmount();
});

it("renders the bundled Who's Next title art when the catalog has no poster", () => {
  movies.catalog.push({
    id: "movie-whos-next",
    slug: "whos-next",
    titleI18n: { en: "Who's Next" },
    synopsisI18n: { en: "Famous figures collide." },
    posterUrl: null,
    posterImages: [],
    heroUrl: null,
    defaultLocale: "en",
    primaryAudioLocale: "en",
    subtitleLocales: ["en"],
    productionStatus: "ready",
    rightsStatus: "licensed",
  });

  const wrapper = mount(MoviePickerModal, {
    global: { stubs: { Teleport: true } },
  });
  const art = wrapper.get(".movie-poster-art.movie-whos-next");

  expect(art.get("img").attributes("src")).toBe("/whos-next-title-88f57667.webp");
  expect(art.find("b").exists()).toBe(false);

  wrapper.unmount();
});
