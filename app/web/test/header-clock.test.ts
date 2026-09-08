import { mount } from "@vue/test-utils";
import { beforeEach, expect, it } from "vitest";

import SiteHeader from "../src/components/SiteHeader.vue";
import { live, now } from "../src/stores/live";
import { movies, viewingEpisodeIndex, viewingMovieSlug } from "../src/stores/movies";
import { setLocale } from "../src/i18n";
import { siteDesign } from "../src/stores/prefs";
import { moviePickerOpen } from "../src/stores/movies";

/*
 * 后端 §5.3：没有人投稿的一轮是「未点火」的，`closesAt` 为 null。头部那块表在这
 * 种时候必须说自己在等投稿——如果照常打「距截稿 --:--」，页面就在装作有一个正在
 * 走的倒计时，而实际上什么都没有在走。
 */

function round(closesAt: string | null) {
  live.round = {
    roundId: "11111111-1111-4111-8111-111111111111",
    roundIndex: 36,
    status: "open",
    opensAt: new Date(Date.now() - 3_600_000).toISOString(),
    closesAt,
    selectedSubmissionId: null,
    selectionMode: null,
    episodeIndex: 1,
    episodeTitle: "第一集",
  };
}

function mountHeader() {
  return mount(SiteHeader, {
    global: {
      stubs: {
        RouterLink: {
          template: "<a><slot /></a>",
        },
      },
    },
  });
}

beforeEach(() => {
  setLocale("en");
  now.value = Date.now();
  const movie = {
    id: "movie-inland",
    slug: "inland-empire-high",
    titleI18n: { en: "Inland Empire High" },
    synopsisI18n: { en: "School serial" },
    posterUrl: null,
    heroUrl: null,
    defaultLocale: "en",
    primaryAudioLocale: "en",
    subtitleLocales: ["en"],
    productionStatus: "ready" as const,
    rightsStatus: "original_cleared" as const,
  };
  movies.catalog = [movie];
  movies.program = {
    generatorKey: "primary",
    timezone: "America/Los_Angeles",
    state: "active",
    movie,
    activeMovieId: movie.id,
    roundIndex: 36,
    startsAt: new Date(now.value - 1_000).toISOString(),
    endsAt: new Date(now.value + 60_000).toISOString(),
    serverNow: new Date(now.value).toISOString(),
  };
  viewingMovieSlug.value = movie.slug;
  viewingEpisodeIndex.value = null;
  live.playlist = [];
});

it("shows the next public scene number instead of the internal retry round", () => {
  round(null);
  live.playlist = Array.from({ length: 10 }, (_, index) => ({
    sceneIndex: index + 1,
    episodeIndex: index < 6 ? 1 : 2,
    videoUrl: `/media/whos-next/${String(index + 1).padStart(6, "0")}.mp4`,
    subtitles: {},
  }));

  const w = mountHeader();

  expect(w.get(".live-chip").text()).toBe("STREAMING 24/7 · NEXT SCENE 000011");
});

it("says it is waiting while the round has no deadline yet", () => {
  round(null);
  const w = mountHeader();
  expect(w.get(".clock .lbl").text()).toBe("AWAITING FIRST PITCH");
  expect(w.get(".clock .t").text()).toBe("--:--");
  expect(w.get('[role="timer"]').text()).toBe(
    "This round is waiting for its first pitch",
  );
});

it("counts down once the first pitch has armed the round", () => {
  round(new Date(now.value + 154_000).toISOString());
  const w = mountHeader();
  expect(w.get(".clock .lbl").text()).toBe("DEADLINE");
  expect(w.get(".clock .t").text()).toBe("02:34");
  expect(w.find(".movie-switch").exists()).toBe(false);
  expect(w.find(".return-live").exists()).toBe(false);
});

it("makes replay mode explicit and offers a direct route back to live", () => {
  round(new Date(now.value + 154_000).toISOString());
  viewingEpisodeIndex.value = 2;

  const w = mountHeader();

  expect(w.get(".live-chip").text()).toBe("EPISODE REPLAY · EP 02");
  expect(w.get(".replay-clock .t").text()).toBe("READ-ONLY REPLAY");
  expect(w.get(".return-live").text()).toBe("RETURN TO LIVE");
  expect(w.find('[role="timer"]').exists()).toBe(false);
});

it("switches templates with the real selector while keeping the countdown and viewing context", async () => {
  siteDesign.value = "studio";
  round(new Date(now.value + 154_000).toISOString());
  const w = mountHeader();
  await w.get('[data-test="design-select"]').setValue("classic");
  expect(siteDesign.value).toBe("classic");
  expect(w.get(".clock .t").text()).toBe("02:34");
  expect(viewingMovieSlug.value).toBe("inland-empire-high");
  await w.get('[data-test="design-select"]').setValue("studio");
  expect(siteDesign.value).toBe("studio");
  expect(w.get(".clock .t").text()).toBe("02:34");
});

it("opens the existing movie picker from the studio title", async () => {
  siteDesign.value = "studio";
  moviePickerOpen.value = false;
  const w = mountHeader();
  await w.setProps({ screening: true });
  await w.get(".studio-movie-switch").trigger("click");
  expect(moviePickerOpen.value).toBe(true);
});
