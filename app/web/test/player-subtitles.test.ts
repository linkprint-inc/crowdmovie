import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import MoviePlayer from "../src/components/MoviePlayer.vue";
import { LOCALES, setLocale } from "../src/i18n";
import { live } from "../src/stores/live";
import { showSubtitles } from "../src/stores/prefs";

/* A text track as the player sees it: only `mode` ever changes. */
interface FakeTrack {
  kind: string;
  language: string;
  label: string;
  mode: string;
}

const tracks: FakeTrack[] = [];
const showing = () => tracks.filter((t) => t.mode === "showing").map((t) => t.language);

/* Video.js is loaded dynamically and needs a real media element, which jsdom
   has not got. The component touches exactly this much of its surface. */
/* The scene's comment track is fetched whenever a scene loads; these tests are
   about subtitles, so answer with an empty track rather than a real request. */
vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    api: {
      sceneDanmaku: vi.fn(async (sceneIndex: number) => ({
        sceneIndex,
        total: 0,
        truncated: false,
        danmaku: [],
      })),
    },
  };
});

vi.mock("video.js/dist/video-js.css", () => ({}));
vi.mock("video.js", () => ({
  default: () => ({
    src: () => undefined,
    on: () => undefined,
    play: () => undefined,
    pause: () => undefined,
    paused: () => true,
    ended: () => false,
    reset: () => undefined,
    currentTime: () => 0,
    duration: () => 15,
    dispose: () => undefined,
    textTracks: () => tracks,
    remoteTextTracks: () => tracks,
    removeRemoteTextTrack: (track: FakeTrack) => {
      tracks.splice(tracks.indexOf(track), 1);
    },
    addRemoteTextTrack: (options: { kind: string; srclang: string; label: string }) => {
      tracks.push({
        kind: options.kind,
        language: options.srclang,
        label: options.label,
        mode: "disabled",
      });
    },
  }),
}));

const scene = {
  sceneIndex: 1,
  episodeIndex: 1,
  videoUrl: "/media/000001.mp4",
  subtitles: Object.fromEntries(
    LOCALES.map((locale) => [locale, `/media/000001.${locale}.vtt`]),
  ) as Record<string, string>,
  authorUsername: null,
};

beforeEach(() => {
  localStorage.clear();
  tracks.length = 0;
  setLocale("en");
  showSubtitles.value = false;
  live.playlist = [scene];
  live.danmaku = [];
  live.sceneDanmaku = [];
});

async function mountPlayer() {
  const wrapper = mount(MoviePlayer);
  await flushPromises();
  return wrapper;
}

const flip = async (wrapper: Awaited<ReturnType<typeof mountPlayer>>, on: boolean) => {
  await wrapper.find('[data-test="cc-switch"] input').setValue(on);
  await flushPromises();
};

const loadVideo = async (wrapper: Awaited<ReturnType<typeof mountPlayer>>) => {
  await wrapper.get('[data-test="load-video"]').trigger("click");
  await flushPromises();
};

/*
 * The player carries one subtitle control: an on/off switch. The language is
 * not a second choice — it is whatever the site is currently displayed in.
 */
describe("the player's subtitle switch", () => {
  it("leaves every track disabled until the switch is turned on", async () => {
    const wrapper = await mountPlayer();
    await loadVideo(wrapper);

    expect(showing()).toEqual([]);
  });

  it("shows the track for the site language when switched on", async () => {
    setLocale("zh-CN");
    const wrapper = await mountPlayer();
    await loadVideo(wrapper);

    await flip(wrapper, true);

    expect(showing()).toEqual(["zh-CN"]);
  });

  it("follows the site language while it is on", async () => {
    const wrapper = await mountPlayer();
    await loadVideo(wrapper);
    await flip(wrapper, true);

    setLocale("ja");
    await flushPromises();

    expect(showing()).toEqual(["ja"]);
  });

  it("clears the subtitles when switched off again", async () => {
    const wrapper = await mountPlayer();
    await loadVideo(wrapper);
    await flip(wrapper, true);

    await flip(wrapper, false);

    expect(showing()).toEqual([]);
  });
});
