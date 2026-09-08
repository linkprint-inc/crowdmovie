import { shallowMount } from "@vue/test-utils";
import { beforeEach, expect, it } from "vitest";

import LiveView from "../src/views/LiveView.vue";
import { locale } from "../src/i18n";
import { live } from "../src/stores/live";
import {
  moviePickerOpen,
  movies,
  viewingMovieSlug,
} from "../src/stores/movies";

beforeEach(() => {
  const movie = {
    id: "movie-crowd",
    slug: "crowd-movie",
    titleI18n: { en: "CrowdMovie" },
    synopsisI18n: { en: "Crowdsourced movie" },
    storySetting: "A whole-movie setting.\n\nIt stays independent from episode scenes.",
    posterUrl: null,
    heroUrl: null,
    defaultLocale: "en",
    primaryAudioLocale: "en",
    subtitleLocales: ["en"],
    productionStatus: "ready" as const,
    rightsStatus: "original_cleared" as const,
  };
  movies.catalog = [movie];
  movies.characters = [];
  viewingMovieSlug.value = movie.slug;
  moviePickerOpen.value = false;
  locale.value = "en";
  live.episode = null;
});

it("opens the movie picker from the movie title chip", async () => {
  const wrapper = shallowMount(LiveView);
  const chip = wrapper.get(".movie-title-chip");

  expect(chip.element.tagName).toBe("SPAN");
  expect(chip.text()).toBe("CrowdMovie");
  expect(chip.attributes("data-tooltip")).toBe("点击切换影片");
  expect(chip.attributes("aria-haspopup")).toBe("dialog");
  expect(wrapper.find(".show-chip.alt").exists()).toBe(false);
  expect(wrapper.find(".show-chip.alt2").exists()).toBe(false);

  await chip.trigger("click");
  expect(moviePickerOpen.value).toBe(true);
});

it("supports opening the movie picker from the keyboard", async () => {
  const wrapper = shallowMount(LiveView);
  const chip = wrapper.get(".movie-title-chip");

  await chip.trigger("keydown", { key: "Enter" });
  expect(moviePickerOpen.value).toBe(true);
});

it("opens the same movie and episode picker from the story-setting button", async () => {
  locale.value = "zh-CN";
  const wrapper = shallowMount(LiveView);
  const button = wrapper.get(".story-setting-switch");

  expect(button.element.tagName).toBe("BUTTON");
  expect(button.text()).toBe("切换剧集");
  expect(button.attributes("aria-haspopup")).toBe("dialog");

  await button.trigger("click");
  expect(moviePickerOpen.value).toBe(true);
});

it("presents the story-setting movie title as a prominent title instead of small print", () => {
  locale.value = "zh-CN";
  movies.catalog[0] = {
    ...movies.catalog[0],
    titleI18n: { en: "Who's Next", "zh-CN": "下一个上场" },
  };

  const wrapper = shallowMount(LiveView);
  const title = wrapper.get(".story-movie-title");

  expect(title.element.tagName).toBe("SPAN");
  expect(title.text()).toBe("下一个上场");
  expect(wrapper.find(".story-setting-heading small").exists()).toBe(false);
});

it("shows the whole-movie text setting below the player instead of episode scenes", () => {
  live.episode = {
    episodeIndex: 3,
    title: "Pay Per Sip",
    themeSourceUsername: null,
    proposalCount: 0,
    status: "open",
    storyOutline: [
      { sceneIndex: 1, summaryZh: "空调停摆后，学生会开始出售阴影走廊许可证。" },
    ],
  };

  const wrapper = shallowMount(LiveView);
  const setting = wrapper.get('[data-test="movie-story-setting"]');

  expect(wrapper.findComponent({ name: "MovieCharacterCard" }).exists()).toBe(false);
  expect(wrapper.get(".story-setting-col .sec-label").text()).toContain("Story setting");
  expect(setting.text()).toContain("A whole-movie setting.");
  expect(setting.text()).toContain("It stays independent from episode scenes.");
  expect(setting.text()).not.toContain("EP 03");
  expect(setting.find("img").exists()).toBe(false);
});
