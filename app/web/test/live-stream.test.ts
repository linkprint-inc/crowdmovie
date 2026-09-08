import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * §16.4:「事件只带数据库 ID 与展示所需最小字段；断线重连后前端以 GET 接口全量
 * 校准，不依赖事件流补历史」. Two ways that breaks silently and neither shows up
 * as an error: listening only for unnamed `message` frames (so every named
 * event in §16.4 is ignored and the page just feels stale), and treating a
 * reconnect as "nothing happened" (so whatever landed while the socket was
 * down is never read).
 */

const calls = vi.hoisted(() => ({
  round: 0,
  submissions: 0,
  submissionCursors: [] as Array<string | undefined>,
  playlistAfter: [] as Array<number | undefined>,
  archive: [] as Array<{ roundIndex: number; status?: string; sceneIndex?: number | null; sceneTakenDown?: boolean; submissions: unknown[] }>,
  olderArchive: [] as Array<{ roundIndex: number; status?: string; sceneIndex?: number | null; sceneTakenDown?: boolean; submissions: unknown[] }>,
  newScenes: [] as Array<{
    sceneIndex: number;
    episodeIndex: number;
    videoUrl: string;
    subtitles: Record<string, string>;
    authorUsername: null;
  }>,
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    api: {
      currentRound: vi.fn(async () => {
        calls.round += 1;
        throw new actual.ApiError(404, "no_round", "no round");
      }),
      currentSubmissions: vi.fn(async (_slug?: string, before?: string) => {
        calls.submissions += 1;
        calls.submissionCursors.push(before);
        return before === undefined
          ? {
              roundId: "",
              roundIndex: 0,
              archive: calls.archive,
              submissions: [],
              hasMore: calls.olderArchive.length > 0,
              nextCursor: calls.olderArchive.length > 0 ? "older-page" : null,
            }
          : {
              roundId: "",
              roundIndex: 0,
              archive: calls.olderArchive,
              submissions: [],
              hasMore: false,
              nextCursor: null,
            };
      }),
      currentProgram: vi.fn(async () => {
        throw new actual.ApiError(404, "program_off_air", "off air");
      }),
      episodes: vi.fn(async () => ({ episodes: [] })),
      currentEpisode: vi.fn(async () => {
        throw new actual.ApiError(404, "not_implemented", "Not Found");
      }),
      episodeProposals: vi.fn(async () => ({ proposals: [] })),
      recentDanmaku: vi.fn(async () => ({ danmaku: [] })),
      playlist: vi.fn(async (_slug?: string, _episode?: number | null, after?: number) => {
        calls.playlistAfter.push(after);
        return { scenes: after === undefined ? [] : calls.newScenes };
      }),
      sceneDanmaku: vi.fn(async () => ({ sceneIndex: 1, total: 0, truncated: false, danmaku: [] })),
    },
  };
});

/** Just enough EventSource to drive open / named event / drop / reopen. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: Event) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, Array<(event: Event) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, fn: (event: Event) => void): void {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
  }
  close(): void {
    this.closed = true;
  }
  emit(name: string, data = ""): void {
    const event = new MessageEvent(name, { data });
    for (const fn of this.listeners.get(name) ?? []) fn(event);
  }
}

type LiveModule = typeof import("../src/stores/live");

async function freshStore(): Promise<LiveModule> {
  vi.resetModules();
  calls.round = 0;
  calls.submissions = 0;
  calls.archive = [];
  calls.olderArchive = [];
  calls.submissionCursors = [];
  calls.playlistAfter = [];
  calls.newScenes = [];
  FakeEventSource.instances.length = 0;
  return import("../src/stores/live");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Let the refresh chain's promises settle without advancing the poll timer. */
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

describe("the live stream", () => {
  it("keeps loading the complete submission archive during episode playback", async () => {
    const store = await freshStore();
    const movies = await import("../src/stores/movies");
    movies.viewingEpisodeIndex.value = 3;
    calls.archive = [
      {
        roundIndex: 1,
        submissions: [
          {
            id: "first-pitch",
            username: "viewer",
            content: "贝吉塔大战超人",
            status: "rejected",
            upCount: 0,
            downCount: 0,
            votesFrozen: true,
            createdAt: "2026-09-02T12:00:00.000Z",
            score: null,
          },
        ],
      },
    ];

    await store.refresh();
    await settle();

    expect(calls.submissions).toBe(1);
    expect(store.live.archive).toEqual(calls.archive);
    movies.viewingEpisodeIndex.value = null;
  });

  it("subscribes to /api/events rather than polling blind", async () => {
    const live = await freshStore();
    live.start();
    await settle();

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe(
      "/api/movies/whos-next/events",
    );
    live.stop();
  });

  it("does not repeat the initial GET set when the first stream connection opens", async () => {
    const store = await freshStore();
    store.start();
    await settle();
    const before = { round: calls.round, submissions: calls.submissions };

    FakeEventSource.instances[0].onopen?.();
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();

    expect(calls.round).toBe(before.round);
    expect(calls.submissions).toBe(before.submissions);
    store.stop();
  });

  it("refreshes production every five seconds with SSE connected and slows down after publication", async () => {
    const store = await freshStore();
    store.start();
    await settle();
    const stream = FakeEventSource.instances[0];
    stream.onopen?.();
    calls.archive = [{ roundIndex: 39, status: "selected", submissions: [] }];
    stream.emit("round.closed");
    await vi.advanceTimersByTimeAsync(400);
    const before = calls.submissions;
    calls.archive = [{ roundIndex: 39, status: "generating", submissions: [] }];
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.submissions).toBe(before + 1);
    expect(store.activeProductionRound.value?.status).toBe("generating");
    calls.archive = [{ roundIndex: 39, status: "published", submissions: [] }];
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.activeProductionRound.value).toBeNull();
    const after = calls.submissions;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.submissions).toBe(after);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(calls.submissions).toBe(after + 1);
    store.stop();
  });

  it("patches a submission event without re-reading the whole page", async () => {
    const live = await freshStore();
    live.start();
    await settle();
    const stream = FakeEventSource.instances[0];
    stream.onopen?.();
    await settle();
    const before = calls.round;

    stream.emit(
      "submission.created",
      JSON.stringify({
        type: "submission.created",
        data: {
          submissionId: "new-pitch",
          kind: "next_shot",
          roundId: "round-1",
          username: "viewer",
          content: "fast action",
          createdAt: new Date().toISOString(),
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(500);
    await settle();

    expect(calls.round).toBe(before);
    live.stop();
  });

  it("coalesces a published-round burst and only asks for new playlist entries", async () => {
    const live = await freshStore();
    live.start();
    await settle();
    const stream = FakeEventSource.instances[0];
    stream.onopen?.();
    await settle();
    const before = calls.round;
    calls.playlistAfter = [];
    live.live.playlist = [
      {
        sceneIndex: 7,
        episodeIndex: 1,
        videoUrl: "/media/000007.mp4",
        subtitles: {},
        authorUsername: null,
      },
    ];
    calls.newScenes = [
      {
        sceneIndex: 8,
        episodeIndex: 1,
        videoUrl: "/media/000008.mp4",
        subtitles: {},
        authorUsername: null,
      },
    ];

    stream.emit("round.published");
    stream.emit("scene.published");
    stream.emit("submission.scored");
    await vi.advanceTimersByTimeAsync(500);
    await settle();

    expect(calls.round).toBe(before + 1);
    expect(calls.playlistAfter).toEqual([7]);
    expect(live.live.playlist.map((scene) => scene.sceneIndex)).toEqual([7, 8]);
    live.stop();
  });

  it("loads older submission pages on demand and keeps the newest page", async () => {
    const store = await freshStore();
    calls.archive = [
      {
        roundIndex: 2,
        status: "published",
        sceneIndex: 1,
        sceneTakenDown: false,
        submissions: [
          {
            id: "newer",
            username: "viewer",
            content: "newer",
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
    calls.olderArchive = [
      {
        roundIndex: 1,
        status: "generation_failed",
        sceneIndex: null,
        submissions: [
          {
            id: "older",
            username: "viewer",
            content: "older",
            status: "pending",
            upCount: 0,
            downCount: 0,
            votesFrozen: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            score: null,
          },
        ],
      },
    ];

    await store.refresh();
    const firstLoad = store.loadEarlierSubmissions();
    const duplicateLoad = store.loadEarlierSubmissions();
    const [loaded, duplicateLoaded] = await Promise.all([firstLoad, duplicateLoad]);

    expect(loaded).toBe(true);
    expect(duplicateLoaded).toBe(false);
    expect(calls.submissionCursors).toEqual([undefined, "older-page"]);
    expect(store.live.archive.map((round) => round.roundIndex)).toEqual([1, 2]);
    expect(store.live.archive[0]).toMatchObject({ status: "generation_failed", sceneIndex: null });
    expect(store.live.archive[1]).toMatchObject({ status: "published", sceneIndex: 1, sceneTakenDown: false });
    calls.archive[0].sceneTakenDown = true;
    await store.refresh();
    expect(store.live.archive[1].sceneTakenDown).toBe(true);
    expect(store.live.submissionsHasMore).toBe(false);
  });

  it("removes a deleted pitch from every visible feed immediately", async () => {
    const store = await freshStore();
    store.start();
    await settle();
    const row = {
      id: "gone",
      username: "author",
      content: "asdf",
      status: "pending" as const,
      upCount: 0,
      downCount: 0,
      votesFrozen: false,
      createdAt: new Date().toISOString(),
      score: null,
    };
    store.live.submissions = [row];
    store.live.archive = [{ roundIndex: 1, submissions: [row] }];
    store.live.proposals = [
      {
        id: "gone",
        username: "author",
        content: "asdf",
        upCount: 0,
        downCount: 0,
        createdAt: new Date().toISOString(),
      },
    ];
    const stream = FakeEventSource.instances[0];

    stream.emit(
      "submission.deleted",
      JSON.stringify({
        type: "submission.deleted",
        data: { submissionId: "gone" },
      }),
    );

    expect(store.live.submissions).toEqual([]);
    expect(store.live.archive[0].submissions).toEqual([]);
    expect(store.live.proposals).toEqual([]);
    store.stop();
  });

  it("keeps an AI Director pitch in the closing round before the next-round refresh", async () => {
    const store = await freshStore();
    store.start();
    await settle();
    store.live.round = {
      roundId: "round-1",
      roundIndex: 1,
      status: "selecting",
      opensAt: new Date().toISOString(),
      closesAt: new Date().toISOString(),
      selectedSubmissionId: null,
      selectionMode: "auto",
      episodeIndex: 1,
      episodeTitle: "第一集",
    };
    const stream = FakeEventSource.instances[0];
    const createdAt = new Date().toISOString();

    stream.emit(
      "submission.created",
      JSON.stringify({
        type: "submission.created",
        data: {
          submissionId: "ai-shot-1",
          kind: "next_shot",
          roundId: "round-1",
          username: "AI Director",
          content: "一个具体的十秒镜头。",
          votesFrozen: true,
          createdAt,
        },
      }),
    );

    expect(store.live.submissions).toEqual([
      {
        id: "ai-shot-1",
        username: "AI Director",
        content: "一个具体的十秒镜头。",
        status: "pending",
        upCount: 0,
        downCount: 0,
        votesFrozen: true,
        createdAt,
        score: null,
      },
    ]);
    store.stop();
  });

  it("patches a late Terra score and roast into an archived crowd winner", async () => {
    const store = await freshStore();
    store.start();
    await settle();
    const row = {
      id: "crowd-winner",
      username: "author",
      content: "the crowd picked this",
      status: "pending" as const,
      upCount: 10,
      downCount: 0,
      votesFrozen: true,
      createdAt: new Date().toISOString(),
      score: null,
    };
    store.live.archive = [{ roundIndex: 1, submissions: [row] }];
    const stream = FakeEventSource.instances[0];

    stream.emit(
      "submission.scored",
      JSON.stringify({
        type: "submission.scored",
        data: {
          submissionId: "crowd-winner",
          status: "accepted",
          total: 0,
          roast: {
            en: "The crowd has spoken. Taste was not guaranteed.",
            "zh-CN": "群众已经表态，品味没有保证。",
            ja: "民意は決まった。センスは保証外。",
            es: "El público habló; el gusto no venía incluido.",
          },
        },
      }),
    );

    expect(store.live.archive[0].submissions[0]).toMatchObject({
      status: "accepted",
      score: {
        total: 0,
        roast: { "zh-CN": "群众已经表态，品味没有保证。" },
      },
    });
    store.stop();
  });

  it("restores prior-round scores and roasts from GET after a full reload", async () => {
    const store = await freshStore();
    const archived = {
      id: "ai-shot-from-server",
      username: "AI Director",
      content: "一个已经拍摄的具体镜头。",
      status: "accepted" as const,
      upCount: 0,
      downCount: 0,
      votesFrozen: true,
      createdAt: new Date().toISOString(),
      score: {
        total: 93,
        roast: {
          en: "dry",
          "zh-CN": "毒舌",
          ja: "辛口",
          es: "ácido",
        },
      },
    };
    calls.archive = [{ roundIndex: 1, submissions: [archived] }];

    await store.refresh();

    expect(store.live.archive).toEqual([
      { roundIndex: 1, submissions: [archived] },
    ]);
    store.stop();
  });

  it("keeps more than three archived rounds from the authoritative GET", async () => {
    const store = await freshStore();
    calls.archive = Array.from({ length: 5 }, (_, index) => ({
      roundIndex: index + 1,
      submissions: [
        {
          id: `archive-${index + 1}`,
          username: "AI Director",
          content: `shot ${index + 1}`,
          status: "accepted" as const,
          upCount: 0,
          downCount: 0,
          votesFrozen: true,
          createdAt: new Date().toISOString(),
          score: null,
        },
      ],
    }));

    await store.refresh();

    expect(store.live.archive.map((round) => round.roundIndex)).toEqual([1, 2, 3, 4, 5]);
    store.stop();
  });

  it("recalibrates over GET when the connection comes back", async () => {
    const live = await freshStore();
    live.start();
    await settle();
    const stream = FakeEventSource.instances[0];
    stream.onopen?.();
    await settle();

    // Dropped after it had been working: EventSource reconnects by itself and
    // fires `open` again. Whatever happened while it was down is only knowable
    // from the GET endpoints — the stream does not replay it.
    stream.onerror?.();
    const before = calls.round;
    stream.onopen?.();
    await settle();

    expect(calls.round).toBe(before + 1);
    live.stop();
  });

  it("falls back to polling and stops retrying when the endpoint is not there", async () => {
    const live = await freshStore();
    live.start();
    await settle();
    const stream = FakeEventSource.instances[0];

    // An error before it ever opened means /api/events does not exist.
    stream.onerror?.();
    expect(stream.closed).toBe(true);

    const before = calls.round;
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();

    // The timer is still the transport, so state still refreshes.
    expect(calls.round).toBeGreaterThan(before);
    expect(FakeEventSource.instances).toHaveLength(1);
    live.stop();
  });
});
