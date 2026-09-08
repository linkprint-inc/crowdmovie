import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import MyScriptsView from "../src/views/MyScriptsView.vue";
import { identity } from "../src/stores/identity";

const mocks = vi.hoisted(() => ({
  myDrafts: vi.fn(),
  myStats: vi.fn(),
  mySubmissions: vi.fn(),
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      myDrafts: mocks.myDrafts,
      myStats: mocks.myStats,
      mySubmissions: mocks.mySubmissions,
    },
  };
});

beforeEach(() => {
  identity.state = "anonymous";
  identity.username = null;
  identity.loaded = false;
  mocks.myDrafts.mockReset();
  mocks.myDrafts.mockResolvedValue({ drafts: [] });
  mocks.myStats.mockReset();
  mocks.myStats.mockResolvedValue({
    submissions: 0,
    accepted: 0,
    netVotes: 0,
    episodes: 0,
    themesSet: 0,
  });
  mocks.mySubmissions.mockReset();
  mocks.mySubmissions.mockResolvedValue({ submissions: [] });
});

describe("My Scripts identity gate", () => {
  it("does not call private endpoints until the browser has an identity", async () => {
    const wrapper = mount(MyScriptsView);
    await flushPromises();

    expect(mocks.myStats).not.toHaveBeenCalled();
    expect(mocks.mySubmissions).not.toHaveBeenCalled();

    identity.loaded = true;
    await flushPromises();
    expect(wrapper.find(".empty").exists()).toBe(true);
    expect(mocks.myStats).not.toHaveBeenCalled();
    expect(mocks.mySubmissions).not.toHaveBeenCalled();

    identity.state = "guest";
    identity.username = "tester";
    await flushPromises();
    expect(mocks.myStats).toHaveBeenCalledOnce();
    expect(mocks.mySubmissions).toHaveBeenCalledOnce();
  });
});
