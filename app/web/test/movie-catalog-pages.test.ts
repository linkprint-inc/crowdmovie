import { RouterLinkStub, flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import CharactersView from "../src/views/CharactersView.vue";
import EpisodesView from "../src/views/EpisodesView.vue";
import { setLocale } from "../src/i18n";

const { movies, movie, episodes, movieCharacters } = vi.hoisted(() => ({
  movies: vi.fn(),
  movie: vi.fn(),
  episodes: vi.fn(),
  movieCharacters: vi.fn(),
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, api: { movies, movie, episodes, movieCharacters } };
});

const catalog = [
  {
    id: "movie-a",
    slug: "movie-a",
    titleI18n: { en: "Movie A", "zh-CN": "电影 A" },
    synopsisI18n: { en: "First movie", "zh-CN": "第一部电影" },
    posterUrl: null,
    posterImages: ["/a-1.jpg", "/a-2.jpg", "/a-3.jpg", "/a-4.jpg"],
    storySetting: null,
    heroUrl: null,
    defaultLocale: "zh-CN",
    primaryAudioLocale: "en",
    subtitleLocales: ["en", "zh-CN"],
    productionStatus: "ready" as const,
    rightsStatus: "original_cleared" as const,
  },
  {
    id: "movie-b",
    slug: "movie-b",
    titleI18n: { en: "Movie B", "zh-CN": "电影 B" },
    synopsisI18n: { en: "Second movie", "zh-CN": "第二部电影" },
    posterUrl: null,
    posterImages: [],
    storySetting: null,
    heroUrl: null,
    defaultLocale: "zh-CN",
    primaryAudioLocale: "zh-CN",
    subtitleLocales: ["zh-CN"],
    productionStatus: "blocked" as const,
    rightsStatus: "blocked" as const,
  },
];

beforeEach(() => {
  setLocale("zh-CN");
  movies.mockReset().mockResolvedValue({ movies: catalog });
  movie.mockReset().mockImplementation(async (slug: string) =>
    catalog.find((item) => item.slug === slug),
  );
  episodes.mockReset().mockImplementation(async (slug: string) => ({
    episodes:
      slug === "movie-a"
        ? [
            {
              episodeIndex: 1,
              title: "第一集",
              premise: "开场",
              status: "open",
              sceneCount: 2,
              submissionCount: 3,
              themeSourceUsername: null,
              themeSourceVotes: null,
              storyOutline: [],
            },
          ]
        : [],
  }));
  movieCharacters.mockReset().mockImplementation(async (slug: string) => ({
    movieId: slug,
    characters: [
      {
        key: `${slug}-lead`,
        position: 1,
        copyI18n: { "zh-CN": { name: `${slug} 主角`, role: "主角" } },
        visualIdentity: {},
        referenceAssets: [],
      },
    ],
  }));
});

describe("movie-grouped catalogue pages", () => {
  it("shows every movie first and its episodes underneath", async () => {
    const wrapper = mount(EpisodesView, {
      global: { stubs: { RouterLink: RouterLinkStub } },
    });
    await flushPromises();

    const sections = wrapper.findAll(".movie-catalog-section");
    expect(sections).toHaveLength(2);
    expect(wrapper.find(".episode-catalog-board").exists()).toBe(false);
    expect(wrapper.findAll(".episode-catalog-section")).toHaveLength(2);
    expect(sections[0].get(".movie-catalog-copy h3").text()).toBe("电影 A");
    expect(sections[0].findAll(".ep-card")).toHaveLength(1);
    expect(sections[0].get(".episode-strip").attributes("tabindex")).toBe("0");
    expect(sections[1].get(".movie-catalog-copy h3").text()).toBe("电影 B");
    expect(sections[1].findAll(".ep-card")).toHaveLength(0);
    expect(episodes).toHaveBeenCalledWith("movie-a");
    expect(episodes).toHaveBeenCalledWith("movie-b");
  });

  it("shows each movie's own character bible underneath it", async () => {
    const wrapper = mount(CharactersView, {
      global: { stubs: { RouterLink: RouterLinkStub } },
    });
    await flushPromises();

    const sections = wrapper.findAll(".movie-catalog-section");
    expect(sections).toHaveLength(2);
    expect(sections[0].get(".movie-character").text()).toContain("movie-a 主角");
    expect(sections[1].get(".movie-character").text()).toContain("movie-b 主角");
    expect(movieCharacters).toHaveBeenCalledWith("movie-a");
    expect(movieCharacters).toHaveBeenCalledWith("movie-b");
  });
});

it("uses a real scene still before poster artwork and retains the screening-room destination", async () => {
  const { default: MovieCatalogHeader } = await import("../src/components/MovieCatalogHeader.vue");
  const wrapper = mount(MovieCatalogHeader, {
    props: { movie: { ...catalog[0], sceneStillUrl: "/media/movie-a/000013.end.png?v=hash" } },
    global: { stubs: { RouterLink: RouterLinkStub } },
  });
  expect(wrapper.get(".movie-catalog-art img").attributes("src")).toBe("/media/movie-a/000013.end.png?v=hash");
  expect(wrapper.get(".movie-catalog-art").classes()).not.toContain("mosaic");
  expect(wrapper.findAllComponents(RouterLinkStub)[1].props("to")).toEqual({ name: "movie-live", params: { movieSlug: "movie-a" } });
  await wrapper.get(".movie-catalog-art img").trigger("error");
  expect(wrapper.findAll(".movie-catalog-art img")).toHaveLength(4);
  expect(wrapper.get(".movie-catalog-art").classes()).toContain("mosaic");
});
