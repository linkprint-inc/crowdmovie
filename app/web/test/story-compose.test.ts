/*
 * 规范 §6 的编辑器。
 *
 * The behaviour worth testing here is the one a writer notices: the button
 * says why it is disabled, always and before they press it. A form holding
 * twelve pictures that answers "incomplete" only on submit makes the author
 * hunt for what is missing.
 */
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import StoryComposeView from "../src/views/StoryComposeView.vue";
import { setLocale } from "../src/i18n";
import { identity } from "../src/stores/identity";

const {
  createStory,
  myStory,
  story,
  saveStory,
  submitStory,
  reopenStory,
  uploadStoryImage,
  saveStoryCaption,
  deleteStoryImage,
} = vi.hoisted(() => ({
  createStory: vi.fn(),
  myStory: vi.fn(),
  story: vi.fn(),
  saveStory: vi.fn(),
  submitStory: vi.fn(),
  reopenStory: vi.fn(),
  uploadStoryImage: vi.fn(),
  saveStoryCaption: vi.fn(),
  deleteStoryImage: vi.fn(),
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>(
    "../src/lib/api",
  );
  return {
    ...actual,
    api: {
      createStory,
      myStory,
      story,
      saveStory,
      submitStory,
      reopenStory,
      uploadStoryImage,
      saveStoryCaption,
      deleteStoryImage,
    },
  };
});

const DRAFT = {
  id: "story-1",
  title: "",
  synopsis: "",
  status: "draft" as const,
  rejectReason: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  submittedAt: null,
  publishedAt: null,
};

beforeEach(() => {
  setLocale("en");
  identity.state = "account";
  identity.username = "tester";
  for (const mock of [
    createStory,
    myStory,
    story,
    saveStory,
    submitStory,
    reopenStory,
    uploadStoryImage,
    saveStoryCaption,
    deleteStoryImage,
  ]) {
    mock.mockReset();
  }
  myStory.mockResolvedValue({
    draft: { ...DRAFT, images: [] },
    proposals: [DRAFT],
  });
  createStory.mockResolvedValue(DRAFT);
  // 草稿的图片随 myStory 回来，编辑器不该去调公开详情接口 —— 那个接口只服务
  // 已发布的设定，对草稿永远是 404。
  story.mockRejectedValue(new Error("the editor must not call this"));
  saveStory.mockImplementation((_id: string, input: unknown) =>
    Promise.resolve({ ...DRAFT, ...(input as object) }),
  );
});

async function mountEditor() {
  const w = mount(StoryComposeView);
  await flushPromises();
  return w;
}

describe("who may open the editor", () => {
  it("tells an anonymous browser to register instead of showing the form", async () => {
    identity.state = "anonymous";
    identity.username = null;

    const w = await mountEditor();

    expect(w.text()).toContain("Accounts only");
    expect(w.find("#sc-title").exists()).toBe(false);
  });

  it("tells a guest the same thing — a bible needs an account", async () => {
    identity.state = "guest";

    const w = await mountEditor();

    expect(w.text()).toContain("Accounts only");
    expect(w.find("#sc-title").exists()).toBe(false);
  });

  it("shows the form to an account", async () => {
    const w = await mountEditor();

    expect(w.find("#sc-title").exists()).toBe(true);
    expect(w.find("#sc-synopsis").exists()).toBe(true);
  });
});

describe("the synopsis counter", () => {
  it("counts Chinese by character", async () => {
    const w = await mountEditor();

    await w.get("#sc-synopsis").setValue("中文测试");

    expect(w.get(".sc-count").text()).toContain("4");
  });

  it("counts English by word, not by letter", async () => {
    const w = await mountEditor();

    await w.get("#sc-synopsis").setValue("the quick brown fox");

    expect(w.get(".sc-count").text()).toContain("4");
  });

  it("says how many more are needed while under the floor", async () => {
    const w = await mountEditor();

    await w.get("#sc-synopsis").setValue("字".repeat(100));

    // 500 - 100 = 400 还差
    expect(w.get(".sc-count").text()).toContain("400");
  });
});

describe("the submit button says why it is disabled", () => {
  it("is disabled on an empty draft and lists every unmet condition", async () => {
    const w = await mountEditor();

    const button = w.get("button.sc-submit");
    expect(button.attributes("disabled")).toBeDefined();
    const blocking = w.get(".sc-blocking").text();
    expect(blocking).toContain("A title");
    expect(blocking).toContain("character pictures");
    expect(blocking).toContain("place pictures");
  });

  it("drops a condition from the list as it is met", async () => {
    const w = await mountEditor();

    await w.get("#sc-title").setValue("The Night Tram");
    await flushPromises();

    expect(w.get(".sc-blocking").text()).not.toContain("A title");
  });

  it("never submits while something is missing", async () => {
    const w = await mountEditor();

    await w.get("button.sc-submit").trigger("click");

    expect(submitStory).not.toHaveBeenCalled();
  });
});

describe("uploading", () => {
  it("sends the chosen file for that slot", async () => {
    uploadStoryImage.mockResolvedValue({
      id: "img-1",
      kind: "character",
      position: 0,
      caption: "",
      url: "/media/story/story-1/img-1.png",
      mime: "image/png",
      bytes: 10,
    });
    const w = await mountEditor();
    const file = new File([new Uint8Array([1])], "a.png", { type: "image/png" });

    const input = w.get('[data-slot="character-0"] input[type="file"]');
    Object.defineProperty(input.element, "files", { value: [file] });
    await input.trigger("change");
    await flushPromises();

    expect(uploadStoryImage).toHaveBeenCalledWith("story-1", "character", 0, file);
  });

  it("refuses a file over 2 MB in the browser, before it is uploaded", async () => {
    const w = await mountEditor();
    const tooBig = new File([new Uint8Array(2 * 1024 * 1024 + 1)], "big.png", {
      type: "image/png",
    });

    const input = w.get('[data-slot="character-0"] input[type="file"]');
    Object.defineProperty(input.element, "files", { value: [tooBig] });
    await input.trigger("change");
    await flushPromises();

    expect(uploadStoryImage).not.toHaveBeenCalled();
    expect(w.text()).toContain("2 MB");
  });

  it("restores the pictures already uploaded, so a reload does not look like a lost upload", async () => {
    myStory.mockResolvedValue({
      draft: {
        ...DRAFT,
        images: [
          {
            id: "img-1",
            kind: "character" as const,
            position: 2,
            caption: "The conductor",
            url: "/media/story/story-1/img-1.png",
          },
        ],
      },
      proposals: [DRAFT],
    });

    const w = await mountEditor();

    const slot = w.get('[data-slot="character-2"]');
    expect(slot.find("img").attributes("src")).toBe("/media/story/story-1/img-1.png");
    expect((slot.get("textarea").element as HTMLTextAreaElement).value).toBe(
      "The conductor",
    );
    // 公开详情接口对草稿是 404，编辑器绝不能依赖它。
    expect(story).not.toHaveBeenCalled();
  });
});

describe("a verdict the author has to act on", () => {
  it("shows the reason a bible was refused, and a way to edit it again", async () => {
    const rejected = {
      ...DRAFT,
      status: "rejected" as const,
      rejectReason: "text: explicit content",
    };
    myStory.mockResolvedValue({ draft: null, proposals: [rejected] });

    const w = await mountEditor();

    expect(w.text()).toContain("Not accepted");
    expect(w.text()).toContain("explicit content");
    expect(w.find("button.sc-reopen").exists()).toBe(true);
  });

  it("says a failed review is our problem, not the author's writing", async () => {
    myStory.mockResolvedValue({
      draft: null,
      proposals: [{ ...DRAFT, status: "review_failed" as const }],
    });

    const w = await mountEditor();

    expect(w.text()).toContain("Review did not finish");
    expect(w.text()).toContain("not your bible");
  });

  it("does not offer to edit a bible that is still under review", async () => {
    myStory.mockResolvedValue({
      draft: { ...DRAFT, status: "pending" as const, images: [] },
      proposals: [{ ...DRAFT, status: "pending" as const }],
    });

    const w = await mountEditor();

    expect(w.text()).toContain("Under review");
    expect(w.find("#sc-title").exists()).toBe(false);
  });
});
