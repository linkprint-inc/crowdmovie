import { mount } from "@vue/test-utils";
import { nextTick, ref, type Ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../src/i18n";
import ProductionStatus from "../src/components/ProductionStatus.vue";
import { live } from "../src/stores/live";
import type { CurrentRound, RoundStatus } from "../src/lib/api";
import { isViewingLiveProgram } from "../src/stores/movies";
vi.mock("../src/stores/movies", () => ({ isViewingLiveProgram: ref(true) }));

beforeEach(() => {
  live.archive = [];
  live.round = null;
  setLocale("zh-CN");
  (isViewingLiveProgram as Ref<boolean>).value = true;
});

describe("production status", () => {
  it("shows earlier filming ahead of the next waiting round, then returns to waiting after publication", async () => {
    live.round = { roundIndex: 40, status: "open", closesAt: null } as CurrentRound;
    live.archive = [
      { roundIndex: 38, status: "generating", submissions: [] },
      { roundIndex: 39, status: "selected", submissions: [] },
    ];
    const wrapper = mount(ProductionStatus);
    expect(wrapper.get("b").text()).toBe("正在拍摄");
    live.archive[0].status = "validating";
    await nextTick();
    expect(wrapper.get(".production-icon").attributes("data-stage")).toBe("validating");
    live.archive[0].status = "published";
    await nextTick();
    expect(wrapper.get(".production-icon").attributes("data-stage")).toBe("selected");
    live.archive[1].status = "published";
    await nextTick();
    expect(wrapper.get(".production-icon").attributes("data-stage")).toBe("waiting");
    wrapper.unmount();
  });

  it("keeps replay status even when the live program is filming", () => {
    live.archive = [{ roundIndex: 39, status: "generating", submissions: [] }];
    (isViewingLiveProgram as Ref<boolean>).value = false;
    const wrapper = mount(ProductionStatus);
    expect(wrapper.get(".production-icon").attributes("data-stage")).toBe("replay");
    wrapper.unmount();
  });

  it("follows the real round and distinguishes waiting from accepting submissions", async () => {
    (isViewingLiveProgram as Ref<boolean>).value = true;
    live.round = { status: "open", closesAt: null } as CurrentRound;
    const wrapper = mount(ProductionStatus);
    expect(wrapper.get(".production-icon").attributes("data-stage")).toBe("waiting");
    live.round.closesAt = "2026-09-05T04:00:00Z";
    await nextTick();
    expect(wrapper.get(".production-icon").attributes("data-stage")).toBe("open");
    for (const status of ["selecting", "selected", "generating", "validating", "published", "select_failed", "generation_failed", "validation_failed"] as RoundStatus[]) {
      live.round.status = status;
      await nextTick();
      expect(wrapper.get(".production-icon").attributes("data-stage")).toBe(status);
      expect(wrapper.get("b").text()).not.toBe("");
    }
    (isViewingLiveProgram as Ref<boolean>).value = false;
    await nextTick();
    expect(wrapper.get(".production-icon").attributes("data-stage")).toBe("replay");
    wrapper.unmount();
  });
});
