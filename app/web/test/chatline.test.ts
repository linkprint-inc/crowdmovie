import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it } from "vitest";

import ChatLine from "../src/components/ChatLine.vue";
import { setLocale } from "../src/i18n";
import type { RoastText } from "../src/lib/api";

const roast: RoastText = {
  en: "Privatising public transport in one auction. Fine.",
  "zh-CN": "把公共交通私有化压进一次拍卖。过。",
  ja: "公共交通の民営化を一度の競売に押し込んだ。可。",
  es: "Privatizar el transporte público en una subasta. Vale.",
};

function base() {
  return {
    id: "abc",
    username: "NightStudyDeserter",
    content: "Reimu auctions the bus routes as six franchises.",
    createdAt: "2026-08-30T21:35:00.000Z",
    upCount: 30,
    downCount: 4,
  };
}

beforeEach(() => {
  setLocale("en");
});

describe("the AI verdict is collapsed by default", () => {
  it("hides the roast until the score chip is pressed", async () => {
    const w = mount(ChatLine, { props: { ...base(), score: 91, roast } });

    expect(w.find('[data-test="roast"]').exists()).toBe(false);
    expect(w.get('[data-test="ai-chip"]').attributes("aria-expanded")).toBe("false");

    await w.get('[data-test="ai-chip"]').trigger("click");
    expect(w.get('[data-test="roast"]').text()).toBe(roast.en);
    expect(w.get('[data-test="ai-chip"]').attributes("aria-expanded")).toBe("true");
    expect(w.get(".chatline").classes()).toContain("open");

    await w.get('[data-test="ai-chip"]').trigger("click");
    expect(w.find('[data-test="roast"]').exists()).toBe(false);
  });

  it("shows the roast in the interface language", async () => {
    setLocale("ja");
    const w = mount(ChatLine, { props: { ...base(), score: 91, roast } });
    await w.get('[data-test="ai-chip"]').trigger("click");
    expect(w.get('[data-test="roast"]').text()).toBe(roast.ja);
  });

  it("stays expandable on a rejected row", async () => {
    const w = mount(ChatLine, {
      props: { ...base(), status: "rejected", score: 34, roast },
    });
    expect(w.get(".chatline").classes()).toContain("rejected");
    await w.get('[data-test="ai-chip"]').trigger("click");
    expect(w.find('[data-test="roast"]').exists()).toBe(true);
  });
});

describe("a row that has not been judged yet", () => {
  it("says so instead of showing a score", () => {
    const w = mount(ChatLine, { props: { ...base(), score: null, roast: null } });
    expect(w.find('[data-test="ai-chip"]').exists()).toBe(false);
    expect(w.get(".scoring").text()).toContain("AI");
    expect(w.text()).not.toContain("AI 0");
  });
});

describe("status is never colour alone", () => {
  it("gives an adopted row a text badge as well as the yellow ground", () => {
    const w = mount(ChatLine, {
      props: { ...base(), status: "accepted", adopted: true, score: 91, roast, crowdSelected: true },
    });
    expect(w.get(".chatline").classes()).toContain("canon");
    expect(w.get(".badge-canon").text()).toBe("ADOPTED");
    expect(w.get(".badge-crowd").text()).toContain("26");
  });
});

it("does not mark score acceptance as adoption", () => {
  const w = mount(ChatLine, { props: { ...base(), status: "accepted", score: 82 } });
  expect(w.find(".badge-canon").exists()).toBe(false);
  expect(w.classes()).not.toContain("canon");
});

it("shows adoption immediately even while scoring is pending", () => {
  setLocale("zh-CN");
  const w = mount(ChatLine, { props: { ...base(), adopted: true } });
  expect(w.get(".badge-canon").text()).toBe("已采用");
});

describe("votes", () => {
  it("shows net votes and marks the one the reader cast", () => {
    const w = mount(ChatLine, { props: { ...base(), myVote: 1 } });
    const up = w.get("button.vote");
    expect(up.text()).toContain("26");
    expect(up.classes()).toContain("on");
    expect(up.attributes("aria-pressed")).toBe("true");
  });

  it("emits the direction that was pressed", async () => {
    const w = mount(ChatLine, { props: base() });
    await w.get("button.vote").trigger("click");
    await w.get("button.vote.down").trigger("click");
    expect(w.emitted("vote")).toEqual([[1], [-1]]);
  });

  it("disables voting once the round's count is frozen", async () => {
    const w = mount(ChatLine, { props: { ...base(), votesFrozen: true } });
    expect(w.get("button.vote").attributes("disabled")).toBeDefined();
    await w.get("button.vote").trigger("click");
    expect(w.emitted("vote")).toBeUndefined();
  });
});
