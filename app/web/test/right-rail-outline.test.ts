import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import RightRail from "../src/components/RightRail.vue";
import { setLocale } from "../src/i18n";
import { identity } from "../src/stores/identity";
import { live } from "../src/stores/live";
import { siteDesign } from "../src/stores/prefs";
import type { Submission } from "../src/lib/api";

enableAutoUnmount(afterEach);

function submission(id: string, createdAt = "2026-09-04T12:00:00.000Z"): Submission {
  return {
    id, createdAt, username: "viewer", content: id, status: "pending",
    upCount: 0, downCount: 0, votesFrozen: false, score: null,
  };
}

/** jsdom has no layout. Model tall rows using their rendered DOM order so
 * preservation assertions exercise actual row movement, not store indexes. */
function mockTimelineLayout(el: HTMLElement) {
  const rows = () => Array.from(el.querySelectorAll<HTMLElement>("[data-submission-id]"));
  Object.defineProperty(el, "scrollHeight", { get: () => rows().length * 500 });
  Object.defineProperty(el, "clientHeight", { value: 100 });
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const index = rows().indexOf(this);
    return index < 0 ? original.call(this) : new DOMRect(0, index * 500 - el.scrollTop, 300, 500);
  });
}

function mountRail() {
  return mount(RightRail, {
    global: {
      stubs: {
        ChatLine: true,
        StoryComposer: true,
      },
    },
  });
}

beforeEach(() => {
  localStorage.clear();
  siteDesign.value = "studio";
  setLocale("zh-CN");
  identity.state = "anonymous";
  live.loaded = true;
  live.noRound = false;
  live.error = null;
  live.round = null;
  live.archive = [];
  live.submissions = [];
  live.submissionsHasMore = false;
  live.submissionsNextCursor = null;
  live.submissionsLoadingEarlier = false;
  live.proposals = [];
  live.episode = {
    episodeIndex: 2,
    title: "校园空气使用费",
    themeSourceUsername: null,
    proposalCount: 0,
    status: "open",
    storyOutline: [
      { sceneIndex: 11, summaryZh: "广播宣布征收校园空气使用费。" },
      { sceneIndex: 12, summaryZh: "魔理沙推来订阅制氧气机。" },
    ],
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("剧情投稿历史时间线", () => {
  it("历史轮次使用真实状态与场次，失败和未知状态不冒充已发布正片", () => {
    live.archive = [
      { roundIndex: 1, status: "generation_failed", sceneIndex: null, submissions: [{ ...submission("failed"), status: "accepted", selection: "human" }] },
      { roundIndex: 2, status: "published", sceneIndex: 1, submissions: [{ ...submission("published"), status: "accepted", selection: "ai" }] },
      { roundIndex: 3, submissions: [{ ...submission("unknown"), status: "accepted" }] },
      { roundIndex: 4, status: "published", sceneIndex: 2, sceneTakenDown: true, submissions: [submission("removed")] },
    ];
    const wrapper = mount(RightRail, { global: { stubs: { StoryComposer: true } } });
    expect(wrapper.findAll(".rmark").map((row) => row.text())).toEqual([
      "ROUND 000002 · 已下架 · SCENE 000002",
      "历史轮次",
      "ROUND 000001 · 已发布 · SCENE 000001",
      "生成失败",
    ]);
    expect(wrapper.get('[data-submission-id="failed"]').text()).toContain("已采用");
    expect(wrapper.get('[data-submission-id="failed"]').text()).not.toContain("CANON");
    expect(wrapper.get('[data-submission-id="unknown"]').find(".badge-canon").exists()).toBe(false);
    expect(wrapper.get('[data-submission-id="published"]').text()).toContain("已采用");
  });

  it("同轮两条投稿评分通过时，只给真正决定开拍的一条显示已采用", () => {
    live.archive = [{ roundIndex: 39, status: "selected", submissions: [
      { ...submission("zeng"), username: "曾哥172", status: "accepted", selection: "human" },
      { ...submission("other"), status: "accepted", selection: null },
    ] }];
    const wrapper = mount(RightRail, { global: { stubs: { StoryComposer: true } } });
    expect(wrapper.get('[data-submission-id="zeng"] .badge-canon').text()).toBe("已采用");
    expect(wrapper.get('[data-submission-id="other"]').find(".badge-canon").exists()).toBe(false);
  });

  it.each(["studio", "classic"] as const)("%s 渲染全部历史轮次并使用对应时间顺序", (design) => {
    siteDesign.value = design;
    live.archive = Array.from({ length: 5 }, (_, index) => ({
      roundIndex: index + 1,
      status: "published" as const,
      sceneIndex: index + 1,
      submissions: [
        {
          id: `archive-${index + 1}`,
          username: "AI Director",
          content: `历史镜头 ${index + 1}`,
          status: "accepted" as const,
          upCount: 0,
          downCount: 0,
          votesFrozen: true,
          createdAt: new Date().toISOString(),
          score: null,
        },
      ],
    }));

    const wrapper = mountRail();
    const markers = wrapper.findAll(".timeline .rmark");

    expect(markers).toHaveLength(5);
    expect(markers[0].text()).toContain(design === "studio" ? "ROUND 000005" : "ROUND 000001");
    expect(markers[4].text()).toContain(design === "studio" ? "ROUND 000001" : "ROUND 000005");
    expect(live.archive.map((round) => round.roundIndex)).toEqual([1, 2, 3, 4, 5]);
  });

  it.each(["studio", "classic"] as const)("%s 按时间排列同轮 AI 和用户投稿，不受旧筛选偏好影响", (design) => {
    siteDesign.value = design;
    localStorage.setItem("cm.acceptedOnly", "true");
    live.archive = [
      {
        roundIndex: 1,
        submissions: [
          {
            id: "ai-first",
            username: "AI Director",
            content: 'Superman bursts through the wall. "Your move."',
            status: "rejected",
            upCount: 0,
            downCount: 0,
            votesFrozen: true,
            createdAt: "2026-09-02T12:00:00.000Z",
            score: null,
          },
          {
            id: "human-first",
            username: "viewer",
            content: "贝吉塔大战超人",
            status: "rejected",
            upCount: 0,
            downCount: 0,
            votesFrozen: true,
            createdAt: "2026-09-02T12:00:01.000Z",
            score: null,
          },
        ],
      },
    ];

    const wrapper = mount(RightRail, {
      global: { stubs: { StoryComposer: true } },
    });
    const rows = wrapper.findAll(".timeline .chatline");

    expect(rows).toHaveLength(2);
    expect(rows[design === "studio" ? 1 : 0].text()).toContain('AI DirectorSuperman bursts through the wall. "Your move."');
    expect(rows[design === "studio" ? 0 : 1].text()).toContain("viewer贝吉塔大战超人");
    expect(rows.every((row) => row.classes().includes("chatline"))).toBe(true);
    expect(live.archive[0].submissions.map((row) => row.id)).toEqual(["ai-first", "human-first"]);
  });

  it("选集回放时即使没有实时轮次标记，也照常显示历史时间线", () => {
    live.noRound = true;
    live.archive = [
      {
        roundIndex: 1,
        submissions: [
          {
            id: "playback-history",
            username: "viewer",
            content: "最早一轮投稿",
            status: "accepted",
            upCount: 0,
            downCount: 0,
            votesFrozen: true,
            createdAt: "2026-09-02T12:00:00.000Z",
            score: null,
          },
        ],
      },
    ];

    const wrapper = mountRail();

    expect(wrapper.find(".timeline .rmark").exists()).toBe(true);
    expect(wrapper.get(".timeline chat-line-stub").attributes("content")).toBe(
      "最早一轮投稿",
    );
    expect(wrapper.text()).not.toContain("当前页面只播放所选剧集");
  });

  it.each(["studio", "classic"] as const)("%s 从历史一端加载更早一页，保持阅读位置且不提示新投稿", async (design) => {
    siteDesign.value = design;
    live.archive = [
      {
        roundIndex: 2,
        submissions: [
          {
            id: "newer",
            username: "viewer",
            content: "稍后的投稿",
            status: "pending",
            upCount: 0,
            downCount: 0,
            votesFrozen: false,
            createdAt: "2026-01-02T00:00:00.000Z",
            score: null,
          },
        ],
      },
    ];
    live.submissionsHasMore = true;
    live.submissionsNextCursor = "opaque-cursor";
    const fetchMock = vi.fn(async (_input: unknown) =>
      new Response(
        JSON.stringify({
          roundId: null,
          roundIndex: null,
          archive: [
            {
              roundIndex: 1,
              submissions: [
                {
                  id: "older",
                  username: "viewer",
                  content: "最早的投稿",
                  status: "pending",
                  upCount: 0,
                  downCount: 0,
                  votesFrozen: false,
                  createdAt: "2026-01-01T00:00:00.000Z",
                  score: null,
                },
              ],
            },
          ],
          submissions: [],
          hasMore: false,
          nextCursor: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mountRail();
    const timeline = wrapper.get<HTMLElement>(".timeline");
    mockTimelineLayout(timeline.element);
    timeline.element.scrollTop = design === "studio" ? 0 : 400;
    await timeline.trigger("scroll");
    expect(fetchMock).not.toHaveBeenCalled();

    timeline.element.scrollTop = design === "studio" ? 350 : 100;
    const anchor = timeline.get("[data-submission-id='newer']").element;
    const before = anchor.getBoundingClientRect().top;
    await timeline.trigger("scroll");
    await flushPromises();

    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "before=opaque-cursor",
    );
    expect(live.archive.map((round) => round.roundIndex)).toEqual([1, 2]);
    expect(anchor.getBoundingClientRect().top).toBe(before);
    expect(timeline.element.scrollTop).toBe(design === "studio" ? 350 : 600);
    expect(wrapper.find(".newpill").exists()).toBe(false);
    expect(timeline.findAll("[data-submission-id]").map((row) => row.attributes("data-submission-id")))
      .toEqual(design === "studio" ? ["newer", "older"] : ["older", "newer"]);
  });

  it("当前轮优先显示，同轮倒序；切换模板恢复正序且不改变共享投稿", async () => {
    live.archive = [{ roundIndex: 1, status: "published", sceneIndex: 1, submissions: [submission("archive")] }];
    live.round = {
      roundId: "current", roundIndex: 2, status: "open",
      opensAt: "2026-09-04T12:00:00.000Z", closesAt: null,
      selectedSubmissionId: null, selectionMode: null, episodeIndex: 2, episodeTitle: "",
    };
    live.submissions = [submission("first"), submission("latest", "2026-09-04T12:01:00.000Z")];
    const wrapper = mountRail();
    const timeline = wrapper.get<HTMLElement>(".timeline");
    mockTimelineLayout(timeline.element);
    const ids = () => timeline.findAll("[data-submission-id]").map((row) => row.attributes("data-submission-id"));

    expect(ids()).toEqual(["latest", "first", "archive"]);
    expect(wrapper.findAll(".rmark")[0].text()).toContain("ROUND 000002");
    siteDesign.value = "classic";
    await flushPromises();
    expect(ids()).toEqual(["archive", "first", "latest"]);
    expect(timeline.element.scrollTop).toBe(1500);
    siteDesign.value = "studio";
    await flushPromises();
    expect(ids()).toEqual(["latest", "first", "archive"]);
    expect(timeline.element.scrollTop).toBe(0);
    expect(live.submissions.map((row) => row.id)).toEqual(["first", "latest"]);
  });

  it.each(["studio", "classic"] as const)("%s 浏览历史时新投稿不抢走阅读位置，点击提示跳到最新", async (design) => {
    siteDesign.value = design;
    live.archive = [{ roundIndex: 1, submissions: [submission("existing")] }];
    const wrapper = mountRail();
    const timeline = wrapper.get<HTMLElement>(".timeline");
    mockTimelineLayout(timeline.element);
    timeline.element.scrollTop = 100;
    const anchor = timeline.get("[data-submission-id='existing']").element;
    const before = anchor.getBoundingClientRect().top;

    live.archive[0].submissions.push(submission("newest", "2026-09-04T12:01:00.000Z"));
    await flushPromises();
    expect(anchor.getBoundingClientRect().top).toBe(before);
    expect(wrapper.find(".newpill").exists()).toBe(true);
    await wrapper.get(".newpill").trigger("click");
    expect(timeline.element.scrollTop).toBe(design === "studio" ? 0 : 1000);
    expect(wrapper.find(".newpill").exists()).toBe(false);
  });

  it.each(["studio", "classic"] as const)("%s 已经在最新位置时自动跟随新投稿", async (design) => {
    siteDesign.value = design;
    live.archive = [{ roundIndex: 1, submissions: [submission("existing")] }];
    const wrapper = mountRail();
    const timeline = wrapper.get<HTMLElement>(".timeline");
    mockTimelineLayout(timeline.element);
    timeline.element.scrollTop = design === "studio" ? 0 : 400;

    live.archive[0].submissions.push(submission("newest", "2026-09-04T12:01:00.000Z"));
    await flushPromises();
    expect(timeline.element.scrollTop).toBe(design === "studio" ? 0 : 1000);
    expect(wrapper.find(".newpill").exists()).toBe(false);
  });
});

describe("下一集提案区的当前集故事大纲", () => {
  it("展开提案区时按镜头顺序显示 Sol 摘要", async () => {
    const wrapper = mountRail();
    await wrapper.get("button.ep-banner").trigger("click");

    const outline = wrapper.get('[data-test="episode-outline"]');
    expect(outline.text()).toContain("EP 02 · SOL 当前集故事大纲");
    expect(outline.text()).toContain("镜头 11 广播宣布征收校园空气使用费。");
    expect(outline.text()).toContain("镜头 12 魔理沙推来订阅制氧气机。");
  });

  it("还没有 Sol 正片时显示明确等待状态", async () => {
    live.episode!.storyOutline = [];
    const wrapper = mountRail();
    await wrapper.get("button.ep-banner").trigger("click");

    const outline = wrapper.get('[data-test="episode-outline"]');
    expect(outline.text()).toContain("首个 Sol 正式镜头发布后");
    expect(outline.find("ol").exists()).toBe(false);
  });
});
