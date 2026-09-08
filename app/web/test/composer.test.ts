import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import StoryComposer from "../src/components/StoryComposer.vue";
import { drafts } from "../src/stores/drafts";
import { identity } from "../src/stores/identity";
import { live } from "../src/stores/live";
import {
  movies,
  viewingEpisodeIndex,
  viewingMovieSlug,
} from "../src/stores/movies";
import { setLocale } from "../src/i18n";
import { siteDesign } from "../src/stores/prefs";

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, api: { submit: vi.fn(), sendDanmaku: vi.fn() } };
});

function openRound() {
  live.round = {
    roundId: "11111111-1111-4111-8111-111111111111",
    roundIndex: 42,
    status: "open",
    opensAt: new Date(Date.now() - 60_000).toISOString(),
    closesAt: new Date(Date.now() + 240_000).toISOString(),
    selectedSubmissionId: null,
    selectionMode: null,
    episodeIndex: 7,
    episodeTitle: "School Bus Auction",
  };
}

const inland = {
  id: "10000000-0000-4000-8000-000000000001",
  slug: "inland-empire-high",
  titleI18n: { en: "Inland Empire High" },
  synopsisI18n: { en: "test" },
  posterUrl: null,
  heroUrl: null,
  defaultLocale: "en",
  primaryAudioLocale: "en",
  subtitleLocales: ["en", "zh-CN", "ja", "es"],
  productionStatus: "ready" as const,
  rightsStatus: "original_cleared" as const,
};

beforeEach(() => {
  localStorage.clear();
  setLocale("en");
  identity.state = "guest";
  identity.username = "tester";
  drafts.next_shot = "";
  drafts.next_episode = "";
  drafts.danmaku = "";
  viewingMovieSlug.value = inland.slug;
  viewingEpisodeIndex.value = null;
  movies.catalog = [inland];
  movies.program = {
    generatorKey: "primary",
    timezone: "America/Los_Angeles",
    state: "active",
    movie: inland,
    activeMovieId: inland.id,
    roundIndex: 42,
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 60_000).toISOString(),
    serverNow: new Date().toISOString(),
  };
  openRound();
});

describe("the composer's grapheme counter", () => {
  it("starts at 0 / 200 for a shot pitch", () => {
    const w = mount(StoryComposer, { props: { mode: "story" } });
    expect(w.get('[data-test="count"] b').text()).toBe("0");
    expect(w.get('[data-test="max"]').text()).toBe("200");
  });

  it("switches the limit to 1000 when the kind switches to next episode", async () => {
    const w = mount(StoryComposer, { props: { mode: "story" } });
    const [shotBtn, epBtn] = w.findAll(".kind-btn");

    await epBtn.trigger("click");
    expect(w.get('[data-test="max"]').text()).toBe("1000");

    await shotBtn.trigger("click");
    expect(w.get('[data-test="max"]').text()).toBe("200");
  });

  it("counts CJK characters and English words for shot pitches", async () => {
    const w = mount(StoryComposer, { props: { mode: "story" } });
    await w.get("textarea").setValue("😀灵梦");
    // 2 UTF-16 units + 2 CJK characters, but 3 graphemes.
    expect("😀灵梦".length).toBe(4);
    expect(w.get('[data-test="count"] b').text()).toBe("2");
  });

  it("keeps a separate draft per kind, so switching never overwrites", async () => {
    const w = mount(StoryComposer, { props: { mode: "story" } });
    const [shotBtn, epBtn] = w.findAll(".kind-btn");

    await w.get("textarea").setValue("a shot idea");
    await epBtn.trigger("click");
    expect(w.get("textarea").element.value).toBe("");

    await w.get("textarea").setValue("a whole episode");
    await shotBtn.trigger("click");
    expect(w.get("textarea").element.value).toBe("a shot idea");

    await epBtn.trigger("click");
    expect(w.get("textarea").element.value).toBe("a whole episode");
  });

  it("marks the count as over and refuses to send past the limit", async () => {
    const w = mount(StoryComposer, { props: { mode: "story" } });
    await w.get("textarea").setValue("字".repeat(201));

    expect(w.get('[data-test="count"]').classes()).toContain("over");
    expect(w.get('[data-test="hint"]').text()).toContain("1");
    expect(w.get("button.send").attributes("disabled")).toBeDefined();
  });

  it("uses the 100-character danmaku limit in live-comment mode", () => {
    const w = mount(StoryComposer, { props: { mode: "dm" } });
    expect(w.get('[data-test="max"]').text()).toBe("100");
  });
});

describe("the composer's copy", () => {
  it("preserves the textarea, kind and unsent drafts across template changes", async () => {
    siteDesign.value = "studio";
    const w = mount(StoryComposer, { props: { mode: "story" } });
    const textarea = w.get("textarea").element;
    await w.get("textarea").setValue("keep my shot draft");
    await w.findAll(".kind-btn")[1].trigger("click");
    await w.get("textarea").setValue("keep my episode draft");

    for (const template of ["classic", "studio"] as const) {
      siteDesign.value = template;
      await w.vm.$nextTick();
      expect(w.get("textarea").element).toBe(textarea);
      expect(w.get("textarea").element.value).toBe("keep my episode draft");
      expect(w.findAll(".kind-btn")[1].attributes("aria-checked")).toBe("true");
      expect(w.get("button.send").attributes("disabled")).toBeUndefined();
      expect(identity.username).toBe("tester");
    }
    await w.findAll(".kind-btn")[0].trigger("click");
    expect(w.get("textarea").element.value).toBe("keep my shot draft");
    w.unmount();
  });

  it("keeps story drafts editable during replay while publishing stays disabled", async () => {
    viewingEpisodeIndex.value = 1;
    const w = mount(StoryComposer, { props: { mode: "story" } });

    expect(w.get("textarea").attributes("readonly")).toBeUndefined();
    await w.get("textarea").setValue("a draft for the next live window");
    expect(w.get("textarea").element.value).toBe("a draft for the next live window");
    expect(w.get("button.send").attributes("disabled")).toBeDefined();
    expect(w.get('[data-test="hint"]').text()).toContain("keep drafting");
  });

  it("keeps story drafts editable while the program is off air", async () => {
    movies.program = null;
    const w = mount(StoryComposer, { props: { mode: "story" } });

    expect(w.get("textarea").attributes("readonly")).toBeUndefined();
    await w.get("textarea").setValue("saved until a program becomes active");
    expect(w.get("textarea").element.value).toBe("saved until a program becomes active");
    expect(w.get("button.send").attributes("disabled")).toBeDefined();
    expect(w.get('[data-test="hint"]').text()).toContain("keep drafting");
  });

  it("swaps the whole block of copy with the kind, not just the number", async () => {
    const w = mount(StoryComposer, { props: { mode: "story" } });
    const shotLabel = w.get(".clabel").text();
    const shotPlaceholder = w.get("textarea").attributes("placeholder");
    const shotHint = w.get('[data-test="hint"]').text();

    await w.findAll(".kind-btn")[1].trigger("click");

    expect(w.get(".clabel").text()).not.toBe(shotLabel);
    expect(w.get("textarea").attributes("placeholder")).not.toBe(shotPlaceholder);
    expect(w.get('[data-test="hint"]').text()).not.toBe(shotHint);
    // The next-episode note only exists in episode mode.
    expect(w.find(".ep-note").exists()).toBe(true);
  });

  it("never offers a filter that can hide meaningful feed history", async () => {
    const w = mount(StoryComposer, { props: { mode: "story" } });
    expect(w.find(".filter").exists()).toBe(false);

    await w.findAll(".kind-btn")[1].trigger("click");
    expect(w.find(".filter").exists()).toBe(false);

    const dm = mount(StoryComposer, { props: { mode: "dm" } });
    expect(dm.find(".filter").exists()).toBe(false);
  });

  it("lets a submitted writer draft the next round without posting twice", async () => {
    localStorage.setItem(
      "cm.submitted",
      JSON.stringify({
        [`movie:inland-empire-high:round:${live.round?.roundId}`]: true,
      }),
    );
    const w = mount(StoryComposer, { props: { mode: "story" } });

    expect(w.get("textarea").attributes("readonly")).toBeUndefined();
    await w.get("textarea").setValue("an idea for the next round");

    expect(w.get("textarea").element.value).toBe("an idea for the next round");
    expect(w.get("button.send").attributes("disabled")).toBeDefined();
    expect(w.get('[data-test="hint"]').text()).toContain("Submitted this round");
  });

  it("keeps the shot draft editable while a round is being judged", async () => {
    if (!live.round) throw new Error("expected an open round fixture");
    live.round.status = "selecting";
    const w = mount(StoryComposer, { props: { mode: "story" } });

    expect(w.get("textarea").attributes("readonly")).toBeUndefined();
    await w.get("textarea").setValue("an idea for the next open round");

    expect(w.get("textarea").element.value).toBe("an idea for the next open round");
    expect(w.get("button.send").attributes("disabled")).toBeDefined();
    expect(w.get('[data-test="hint"]').text()).toContain("closed");
  });
});
