/*
 * 规范 §6 的入口。A feature nobody can find is a feature that does not ship:
 * the board needs a link in the main nav, and an author needs to see the
 * verdict on their bible from the page they already visit.
 */
import { RouterLinkStub, flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SiteNav from "../src/components/SiteNav.vue";
import MyScriptsView from "../src/views/MyScriptsView.vue";
import { setLocale } from "../src/i18n";
import { identity } from "../src/stores/identity";

const { myStats, mySubmissions, myStory } = vi.hoisted(() => ({
  myStats: vi.fn(),
  mySubmissions: vi.fn(),
  myStory: vi.fn(),
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>(
    "../src/lib/api",
  );
  return { ...actual, api: { myStats, mySubmissions, myStory } };
});

beforeEach(() => {
  setLocale("en");
  identity.state = "account";
  identity.username = "tester";
  identity.loaded = true;
  myStats.mockResolvedValue({
    submissions: 0,
    accepted: 0,
    netVotes: 0,
    episodes: 0,
    themesSet: 0,
  });
  mySubmissions.mockResolvedValue({
    total: 0,
    limit: 50,
    offset: 0,
    hasMore: false,
    submissions: [],
  });
  myStory.mockResolvedValue({ draft: null, proposals: [] });
});

describe("the nav", () => {
  it("links to the board", () => {
    const w = mount(SiteNav, { global: { stubs: { RouterLink: RouterLinkStub } } });

    const labels = w.findAllComponents(RouterLinkStub).map((link) => link.text());
    expect(labels).toContain("Story Bibles");
  });

  it("points that link at the board route", () => {
    const w = mount(SiteNav, { global: { stubs: { RouterLink: RouterLinkStub } } });

    const link = w
      .findAllComponents(RouterLinkStub)
      .find((each) => each.text() === "Story Bibles");
    expect(link?.props("to")).toEqual({ name: "stories" });
  });

  it("opens global episode and character catalogues instead of the current movie only", () => {
    const w = mount(SiteNav, { global: { stubs: { RouterLink: RouterLinkStub } } });
    const links = w.findAllComponents(RouterLinkStub);

    expect(links.find((link) => link.text() === "Episodes")?.props("to")).toEqual({
      name: "episodes",
    });
    expect(links.find((link) => link.text() === "Characters")?.props("to")).toEqual({
      name: "characters",
    });
  });
});

describe("my scripts shows my bible's verdict", () => {
  const proposal = {
    id: "story-1",
    title: "The Night Tram",
    synopsis: "s",
    status: "rejected" as const,
    rejectReason: "text: explicit content",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    submittedAt: "2026-01-01T00:00:00.000Z",
    publishedAt: null,
  };

  it("shows the status badge and the reason", async () => {
    myStory.mockResolvedValue({ draft: null, proposals: [proposal] });

    const w = mount(MyScriptsView, {
      global: { stubs: { RouterLink: RouterLinkStub } },
    });
    await flushPromises();

    const block = w.get(".ms-stories");
    expect(block.text()).toContain("The Night Tram");
    expect(block.text()).toContain("Not accepted");
    expect(block.text()).toContain("explicit content");
  });

  it("marks a draft as a draft", async () => {
    myStory.mockResolvedValue({
      draft: { ...proposal, status: "draft", rejectReason: null },
      proposals: [{ ...proposal, status: "draft", rejectReason: null }],
    });

    const w = mount(MyScriptsView, {
      global: { stubs: { RouterLink: RouterLinkStub } },
    });
    await flushPromises();

    expect(w.get(".ms-stories").text()).toContain("Draft");
  });

  it("says nothing at all when the author has never written one", async () => {
    const w = mount(MyScriptsView, {
      global: { stubs: { RouterLink: RouterLinkStub } },
    });
    await flushPromises();

    expect(w.find(".ms-stories").exists()).toBe(false);
  });
});
