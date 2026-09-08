/*
 * 规范 §6 的列表页与详情页。
 *
 * The board's job is to show every picture and let someone like and
 * reply without leaving. The detail page's job is to show the whole bible with
 * every note attached to its own picture — a note that drifts away from the
 * picture it describes is the one failure that makes the page useless.
 */
import { RouterLinkStub, flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

import StoriesView from "../src/views/StoriesView.vue";
import StoryDetailView from "../src/views/StoryDetailView.vue";
import { setLocale } from "../src/i18n";
import { identity } from "../src/stores/identity";

const { stories, story, storyComments, commentOnStory, likeStory } = vi.hoisted(() => ({
  stories: vi.fn(),
  story: vi.fn(),
  storyComments: vi.fn(),
  commentOnStory: vi.fn(),
  likeStory: vi.fn(),
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>(
    "../src/lib/api",
  );
  return {
    ...actual,
    api: { stories, story, storyComments, commentOnStory, likeStory },
  };
});

const SUMMARY = {
  id: "story-1",
  title: "The Night Tram",
  authorUsername: "kira",
  likeCount: 12,
  commentCount: 3,
  publishedAt: "2026-08-01T00:00:00.000Z",
  previewImages: [
    { kind: "character" as const, url: "/media/story/story-1/c0.png" },
    { kind: "character" as const, url: "/media/story/story-1/c1.png" },
    { kind: "character" as const, url: "/media/story/story-1/c2.png" },
    { kind: "character" as const, url: "/media/story/story-1/c3.png" },
    { kind: "character" as const, url: "/media/story/story-1/c4.png" },
    { kind: "character" as const, url: "/media/story/story-1/c5.png" },
    { kind: "world" as const, url: "/media/story/story-1/w0.png" },
    { kind: "world" as const, url: "/media/story/story-1/w1.png" },
    { kind: "world" as const, url: "/media/story/story-1/w2.png" },
    { kind: "world" as const, url: "/media/story/story-1/w3.png" },
  ],
};

const DETAIL = {
  id: "story-1",
  title: "The Night Tram",
  synopsis: "A tram that never reaches a stop.",
  authorUsername: "kira",
  likeCount: 12,
  commentCount: 1,
  publishedAt: "2026-08-01T00:00:00.000Z",
  likedByMe: false,
  characters: [
    { position: 0, caption: "The conductor", url: "/media/story/story-1/c0.png" },
    { position: 1, caption: "The passenger", url: "/media/story/story-1/c1.png" },
  ],
  worlds: [{ position: 0, caption: "The depot", url: "/media/story/story-1/w0.png" }],
};

beforeEach(() => {
  setLocale("en");
  identity.state = "guest";
  identity.username = "reader";
  for (const mock of [stories, story, storyComments, commentOnStory, likeStory]) {
    mock.mockReset();
  }
  stories.mockResolvedValue({
    total: 1,
    limit: 20,
    offset: 0,
    hasMore: false,
    sort: "hot",
    stories: [SUMMARY],
  });
  story.mockResolvedValue(DETAIL);
  storyComments.mockResolvedValue({
    total: 1,
    limit: 50,
    offset: 0,
    hasMore: false,
    comments: [
      {
        id: 1,
        floor: 1,
        username: "someone",
        content: "Good one",
        createdAt: "2026-08-02T00:00:00.000Z",
      },
    ],
  });
  likeStory.mockResolvedValue({ storyId: "story-1", likeCount: 13, likedByMe: true });
  commentOnStory.mockResolvedValue({
    id: 2,
    floor: 2,
    username: "reader",
    content: "Mine",
    createdAt: "2026-08-03T00:00:00.000Z",
  });
});

const mountBoard = async () => {
  const w = mount(StoriesView, { global: { stubs: { RouterLink: RouterLinkStub } } });
  await flushPromises();
  return w;
};

const mountDetail = async () => {
  const w = mount(StoryDetailView, {
    props: { id: "story-1" },
    global: { stubs: { RouterLink: RouterLinkStub } },
  });
  await flushPromises();
  return w;
};

describe("the board", () => {
  it("shows every character and place picture", async () => {
    const w = await mountBoard();

    const images = w.get(".sb-row").findAll("img");
    expect(images).toHaveLength(10);
    expect(images[0].attributes("src")).toBe("/media/story/story-1/c0.png");
  });

  it("shows the title, the author and both counts", async () => {
    const w = await mountBoard();

    const row = w.get(".sb-row");
    const text = row.text();
    expect(text).toContain("The Night Tram");
    expect(text).toContain("kira");
    expect(text).toContain("12");
    expect(text).toContain("3");
    expect(row.element.children[1].classList.contains("sb-meta")).toBe(true);
    expect(row.element.children[2].classList.contains("sb-thumbs")).toBe(true);
  });

  it("opens a preview image without taking away the row detail link", async () => {
    const w = await mountBoard();

    expect(w.find(".sb-row-hit").exists()).toBe(true);
    await w.findAll("button.sb-thumb-open")[6].trigger("click");
    await nextTick();

    const image = document.body.querySelector<HTMLImageElement>(".sil-stage img");
    expect(image?.getAttribute("src")).toBe("/media/story/story-1/w0.png");
    expect(document.body.querySelector(".sil-caption")?.textContent).toContain("7 / 10");

    w.unmount();
    expect(document.body.querySelector(".sil-backdrop")).toBeNull();
  });

  it("switching to newest refetches with that sort", async () => {
    const w = await mountBoard();

    await w.get("button.sb-sort-new").trigger("click");
    await flushPromises();

    expect(stories).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "new" }));
  });

  it("says the board is empty rather than showing nothing at all", async () => {
    stories.mockResolvedValue({
      total: 0,
      limit: 20,
      offset: 0,
      hasMore: false,
      sort: "hot",
      stories: [],
    });

    const w = await mountBoard();

    expect(w.text()).toContain("No bibles yet");
  });
});

describe("the detail page", () => {
  it("keeps every note with its own picture", async () => {
    const w = await mountDetail();

    const figures = w.findAll(".sd-figure");
    expect(figures).toHaveLength(3);
    expect(figures[0].find("img").attributes("src")).toBe(
      "/media/story/story-1/c0.png",
    );
    expect(figures[0].text()).toContain("The conductor");
    expect(figures[1].text()).toContain("The passenger");
  });

  it("shows the synopsis in full", async () => {
    const w = await mountDetail();

    expect(w.text()).toContain("A tram that never reaches a stop.");
  });

  it("opens the image lightbox and supports arrows, wrapping and Escape", async () => {
    const w = await mountDetail();

    await w.findAll("button.sd-image-open")[0].trigger("click");
    await nextTick();

    const currentSrc = () =>
      document.body
        .querySelector<HTMLImageElement>(".sil-stage img")
        ?.getAttribute("src");

    expect(currentSrc()).toBe("/media/story/story-1/c0.png");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await nextTick();
    expect(currentSrc()).toBe("/media/story/story-1/c1.png");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    await nextTick();
    expect(currentSrc()).toBe("/media/story/story-1/w0.png");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(document.body.querySelector(".sil-backdrop")).toBeNull();
    expect(document.body.style.overflow).toBe("");

    w.unmount();
  });

  it("likes it, and the count moves", async () => {
    const w = await mountDetail();

    await w.get("button.sd-like").trigger("click");
    await flushPromises();

    expect(likeStory).toHaveBeenCalledWith("story-1", 1);
    expect(w.get("button.sd-like").text()).toContain("13");
  });

  it("un-likes on a second press", async () => {
    story.mockResolvedValue({ ...DETAIL, likedByMe: true });
    likeStory.mockResolvedValue({
      storyId: "story-1",
      likeCount: 11,
      likedByMe: false,
    });
    const w = await mountDetail();

    await w.get("button.sd-like").trigger("click");
    await flushPromises();

    expect(likeStory).toHaveBeenCalledWith("story-1", 0);
  });

  it("lists replies with floor numbers", async () => {
    const w = await mountDetail();

    const reply = w.get(".sd-reply");
    expect(reply.text()).toContain("someone");
    expect(reply.text()).toContain("Good one");
    expect(reply.text()).toContain("1");
  });

  it("posts a reply and shows it without a reload", async () => {
    const w = await mountDetail();

    await w.get("#sd-reply").setValue("Mine");
    await w.get("button.sd-send").trigger("click");
    await flushPromises();

    expect(commentOnStory).toHaveBeenCalledWith("story-1", "Mine");
    expect(w.findAll(".sd-reply")).toHaveLength(2);
  });

  it("will not send an empty reply", async () => {
    const w = await mountDetail();

    await w.get("button.sd-send").trigger("click");

    expect(commentOnStory).not.toHaveBeenCalled();
  });

  it("counts a reply the way the server does, by grapheme", async () => {
    const w = await mountDetail();

    await w.get("#sd-reply").setValue("\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}灵梦");

    // 一个 ZWJ 家庭序列加两个汉字：读者看到 3 个，String.length 是 13。
    expect(w.get(".sd-count").text()).toContain("3");
  });
});
