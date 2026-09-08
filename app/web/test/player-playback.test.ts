import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import MoviePlayer from "../src/components/MoviePlayer.vue";
import { LOCALES } from "../src/i18n";
import { live } from "../src/stores/live";
import { showSubtitles, siteDesign } from "../src/stores/prefs";

const fake = vi.hoisted(() => ({
  handlers: new Map<string, Array<() => void>>(),
  sources: [] as string[],
  tracks: [] as Array<{ kind: string; language: string; mode: string }>,
  play: vi.fn(() => Promise.resolve()),
  pause: vi.fn(),
  paused: true,
  ended: false,
  options: null as null | { preload?: string; html5?: { nativeControlsForTouch?: boolean } },
  reset: vi.fn(),
  recoverSource: vi.fn<() => Promise<void> | undefined>(),
}));

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
  default: (_element: HTMLVideoElement, options: { preload?: string; html5?: { nativeControlsForTouch?: boolean } }) => {
    fake.options = options;
    return ({
    src: ({ src }: { src: string }) => {
      fake.sources.push(src);
      fake.ended = false;
    },
    on: (name: string, handler: () => void) => {
      const handlers = fake.handlers.get(name) ?? [];
      handlers.push(handler);
      fake.handlers.set(name, handlers);
    },
    play: fake.play,
    pause: fake.pause,
    paused: () => fake.paused,
    ended: () => fake.ended,
    currentTime: () => 0,
    duration: () => 15,
    reset: fake.reset,
    recoverSource: fake.recoverSource,
    dispose: () => undefined,
    textTracks: () => fake.tracks,
    remoteTextTracks: () => fake.tracks,
    removeRemoteTextTrack: (track: (typeof fake.tracks)[number]) => {
      fake.tracks.splice(fake.tracks.indexOf(track), 1);
    },
    addRemoteTextTrack: (options: { kind: string; srclang: string }) => {
      fake.tracks.push({
        kind: options.kind,
        language: options.srclang,
        mode: "disabled",
      });
    },
    });
  },
}));

function playlistScene(sceneIndex: number) {
  const padded = String(sceneIndex).padStart(6, "0");
  return {
    sceneIndex,
    episodeIndex: 1,
    videoUrl: `/media/${padded}.mp4`,
    subtitles: Object.fromEntries(
      LOCALES.map((locale) => [locale, `/media/${padded}.${locale}.vtt`]),
    ) as Record<string, string>,
    authorUsername: null,
  };
}

function emit(name: string): void {
  for (const handler of fake.handlers.get(name) ?? []) handler();
}

async function mountPlayer() {
  const wrapper = mount(MoviePlayer);
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  siteDesign.value = "studio";
  fake.handlers.clear();
  fake.sources.length = 0;
  fake.tracks.length = 0;
  fake.play.mockClear();
  fake.play.mockImplementation(() => {
    fake.paused = false;
    return Promise.resolve();
  });
  fake.pause.mockClear();
  fake.pause.mockImplementation(() => {
    fake.paused = true;
  });
  fake.paused = true;
  fake.ended = false;
  fake.options = null;
  fake.reset.mockClear();
  fake.recoverSource.mockReset();
  live.playlist = [playlistScene(1)];
  live.danmaku = [];
  live.sceneDanmaku = [];
});

describe("the live playlist playback tail", () => {
  it.each(["iPhone", "Android Mobile"])("hides source-change controls on %s until interaction", async agent => {
    const ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(agent);
    live.playlist = [playlistScene(1), playlistScene(2)];
    const wrapper = await mountPlayer();
    try {
      await wrapper.get('[data-test="load-video"]').trigger("click");
      expect(fake.sources).toHaveLength(1);
      fake.ended = true;
      emit("ended");
      await flushPromises();
      expect(fake.sources).toEqual(["/media/000001.mp4", "/media/000002.mp4"]);
      expect(wrapper.get(".screen").classes()).toContain("mobile-controls-hidden");
      emit("playing");
      await flushPromises();
      expect(wrapper.get(".screen").classes()).toContain("mobile-controls-hidden");
      await wrapper.get(".screen").trigger("pointerup");
      expect(wrapper.get(".screen").classes()).not.toContain("mobile-controls-hidden");
      await wrapper.get('[data-test="previous-scene"]').trigger("click");
      expect(wrapper.get(".screen").classes()).toContain("mobile-controls-hidden");
      emit("error");
      await flushPromises();
      expect(wrapper.find('[data-test="playback-error"]').exists()).toBe(true);
      expect(wrapper.get(".screen").classes()).not.toContain("mobile-controls-hidden");
    } finally { wrapper.unmount(); ua.mockRestore(); }
  });


  it.each(["iPhone", "Android Mobile"])("does not create caption tracks on %s even with a saved subtitle preference", async (agent) => {
    const ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(agent);
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    const preference = showSubtitles.value;
    showSubtitles.value = true;
    const wrapper = await mountPlayer();
    try {
      await wrapper.get('[data-test="load-video"]').trigger("click");
      await flushPromises();
      expect(wrapper.get('[data-test="cc-switch"] input').attributes("disabled")).toBeDefined();
      expect((wrapper.get('[data-test="cc-switch"] input').element as HTMLInputElement).checked).toBe(false);
      expect(wrapper.findAll("track")).toHaveLength(0);
      expect(fake.tracks).toHaveLength(0);
      expect(fake.options?.html5?.nativeControlsForTouch).toBe(false);
      showSubtitles.value = false;
      showSubtitles.value = true;
      await flushPromises();
      expect(wrapper.findAll("track")).toHaveLength(0);
      expect(fake.tracks).toHaveLength(0);
      expect(fake.options?.html5?.nativeControlsForTouch).toBe(false);
    } finally {
      wrapper.unmount(); showSubtitles.value = preference;
      ua.mockRestore(); play.mockRestore(); pause.mockRestore(); load.mockRestore();
    }
  });

  it("buffers a failed scene and requests a fresh gesture if the browser requires one", async () => {
    let ready!: () => void;
    fake.recoverSource.mockReturnValueOnce(new Promise(resolve => { ready = resolve; }));
    const wrapper = await mountPlayer();
    await wrapper.get('[data-test="load-video"]').trigger("click");
    emit("error");
    await flushPromises();
    expect(wrapper.find('[data-test="playback-recovering"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="playback-error"]').exists()).toBe(false);
    fake.play.mockRejectedValueOnce(new DOMException("Gesture required", "NotAllowedError"));
    ready(); await flushPromises();
    expect(wrapper.find('[data-test="playback-recovering"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="load-video"]').exists()).toBe(true);
    expect(fake.sources).toEqual(["/media/000001.mp4"]);
    wrapper.unmount();
  });

  it("ignores recovery finishing after a new scene has been selected", async () => {
    let ready!: () => void;
    fake.recoverSource.mockReturnValueOnce(new Promise(resolve => { ready = resolve; }));
    live.playlist = [playlistScene(1), playlistScene(14)];
    const wrapper = await mountPlayer();
    await wrapper.get('[data-test="load-video"]').trigger("click");
    emit("error"); await flushPromises();
    fake.paused = true;
    await wrapper.get('[data-test="scene-picker"]').setValue("1");
    ready(); await flushPromises();
    expect(fake.play).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-test="playback-recovering"]').exists()).toBe(false);
    expect((wrapper.get('[data-test="scene-picker"]').element as HTMLSelectElement).value).toBe("1");
    wrapper.unmount();
  });

  it("lets the viewer reload a failed scene without losing their selection", async () => {
    live.playlist = [playlistScene(1), playlistScene(4)];
    const wrapper = await mountPlayer();
    await wrapper.get('[data-test="scene-picker"]').setValue("1");
    await wrapper.get('[data-test="load-video"]').trigger("click");
    emit("error");
    await flushPromises();
    expect(wrapper.find('[data-test="playback-error"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="direct-video"]').attributes("href")).toBe("/media/000004.mp4");
    await wrapper.get('[data-test="retry-video"]').trigger("click");
    await flushPromises();
    expect(fake.reset).toHaveBeenCalledTimes(1);
    expect(fake.sources).toEqual(["/media/000004.mp4", "/media/000004.mp4"]);
    expect(fake.play).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-test="playback-error"]').exists()).toBe(false);
    expect((wrapper.get('[data-test="scene-picker"]').element as HTMLSelectElement).value).toBe("1");
    wrapper.unmount();
  });

  it("uses Video.js touch controls and offers a new gesture when mobile autoplay is blocked", async () => {
    const wrapper = await mountPlayer();
    expect(fake.options?.html5?.nativeControlsForTouch).toBe(false);
    expect(wrapper.get("video").attributes("playsinline")).toBeDefined();
    fake.play.mockRejectedValueOnce(new DOMException("Gesture required", "NotAllowedError"));
    await wrapper.get('[data-test="load-video"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="load-video"]').exists()).toBe(true);
    await wrapper.get('[data-test="load-video"]').trigger("click");
    await flushPromises();
    expect(fake.sources).toHaveLength(1);
    expect(wrapper.find('[data-test="load-video"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("does not attach an MP4 until the viewer asks to play it", async () => {
    const wrapper = await mountPlayer();

    expect(fake.options?.preload).toBe("none");
    expect(fake.sources).toEqual([]);
    expect(wrapper.get("video").attributes("preload")).toBe("none");

    await wrapper.get('[data-test="load-video"]').trigger("click");
    await flushPromises();

    expect(fake.sources).toEqual(["/media/000001.mp4"]);
    expect(fake.play).toHaveBeenCalledTimes(1);
    expect(fake.tracks).toHaveLength(LOCALES.length);
    expect(wrapper.find('[data-test="cc-switch"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("stops on the newest scene's final frame instead of looping", async () => {
    const wrapper = await mountPlayer();

    await wrapper.get('[data-test="load-video"]').trigger("click");
    await flushPromises();

    fake.ended = true;
    emit("ended");
    await flushPromises();

    expect(fake.sources).toEqual(["/media/000001.mp4"]);
    expect(fake.play).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("continues when a new scene arrives after a natural end", async () => {
    const wrapper = await mountPlayer();
    await wrapper.get('[data-test="load-video"]').trigger("click");
    await flushPromises();
    fake.ended = true;
    emit("ended");

    live.playlist = [playlistScene(1), playlistScene(2)];
    await flushPromises();

    expect(fake.sources).toEqual(["/media/000001.mp4", "/media/000002.mp4"]);
    expect(fake.play).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it("does not autoplay an appended scene after a user pause", async () => {
    const wrapper = await mountPlayer();
    await wrapper.get('[data-test="load-video"]').trigger("click");
    await flushPromises();
    emit("pause");

    live.playlist = [playlistScene(1), playlistScene(2)];
    await flushPromises();

    expect(fake.sources).toEqual(["/media/000001.mp4"]);
    expect(fake.play).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("plays existing scenes once and stops at the final one", async () => {
    live.playlist = [playlistScene(1), playlistScene(2)];
    const wrapper = await mountPlayer();
    await wrapper.get('[data-test="load-video"]').trigger("click");
    await flushPromises();

    fake.ended = true;
    emit("ended");
    await flushPromises();
    fake.ended = true;
    emit("ended");
    await flushPromises();

    expect(fake.sources).toEqual(["/media/000001.mp4", "/media/000002.mp4"]);
    expect(fake.play).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });
});

describe("manual scene navigation", () => {
  it("keeps the active video and source when changing templates in either direction", async () => {
    const wrapper = await mountPlayer();
    const video = wrapper.get("video").element;
    expect(wrapper.find('[data-test="player-cover"]').exists()).toBe(true);
    await wrapper.get('[data-test="load-video"]').trigger("click");
    await flushPromises();
    const sources = [...fake.sources];
    const playCount = fake.play.mock.calls.length;
    const resetCount = fake.reset.mock.calls.length;

    for (const template of ["classic", "studio"] as const) {
      siteDesign.value = template;
      await flushPromises();
      expect(wrapper.get("video").element).toBe(video);
      expect(fake.sources).toEqual(sources);
      expect(fake.play).toHaveBeenCalledTimes(playCount);
      expect(fake.reset).toHaveBeenCalledTimes(resetCount);
      expect(wrapper.find('[data-test="player-cover"]').exists()).toBe(false);
    }
    wrapper.unmount();
  });

  beforeEach(() => {
    live.playlist = [playlistScene(1), playlistScene(2), playlistScene(3)];
  });

  it("switches with the scene picker while preserving a paused player", async () => {
    const wrapper = await mountPlayer();

    await wrapper.get('[data-test="scene-picker"]').setValue("2");
    await flushPromises();

    expect(fake.sources).toEqual([]);
    expect(fake.play).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="load-video"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="next-scene"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-test="previous-scene"]').attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("moves backward and forward and resumes an already playing player", async () => {
    const wrapper = await mountPlayer();
    await wrapper.get('[data-test="load-video"]').trigger("click");
    await flushPromises();

    await wrapper.get('[data-test="next-scene"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-test="previous-scene"]').trigger("click");
    await flushPromises();

    expect(fake.sources).toEqual([
      "/media/000001.mp4",
      "/media/000002.mp4",
      "/media/000001.mp4",
    ]);
    expect(fake.play).toHaveBeenCalledTimes(3);
    expect(wrapper.get('[data-test="previous-scene"]').attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });
});
