import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

/*
 * §12「草稿按身份保存在服务端（游客与账号一致），换会话后可恢复」. localStorage
 * alone cannot do that — it is per-browser — so the point of `PUT
 * /api/me/drafts` is that the text comes back on a machine that has never seen
 * it. These cover the two halves that break silently: the debounce actually
 * firing one save per pause, and hydration not stomping on what is being typed.
 */

const { myDrafts, saveDraft } = vi.hoisted(() => ({
  myDrafts: vi.fn(),
  saveDraft: vi.fn(),
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, api: { myDrafts, saveDraft } };
});

type DraftsModule = typeof import("../src/stores/drafts");
type IdentityModule = typeof import("../src/stores/identity");
type MoviesModule = typeof import("../src/stores/movies");

/* The store wires its watchers at import time, so each case needs its own. */
async function freshStore(): Promise<{
  drafts: DraftsModule;
  identity: IdentityModule;
  movies: MoviesModule;
}> {
  vi.resetModules();
  const identity = await import("../src/stores/identity");
  const movies = await import("../src/stores/movies");
  identity.identity.state = "anonymous";
  identity.identity.username = null;
  const drafts = await import("../src/stores/drafts");
  return { drafts, identity, movies };
}

/** Claiming a username is what makes drafts savable and readable. */
async function signIn(mods: Awaited<ReturnType<typeof freshStore>>): Promise<void> {
  mods.identity.identity.state = "guest";
  mods.identity.identity.username = "tester";
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  myDrafts.mockReset();
  saveDraft.mockReset();
  myDrafts.mockResolvedValue({ drafts: [] });
  saveDraft.mockResolvedValue({ kind: "next_shot", body: "", updatedAt: "" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("draft autosave", () => {
  it("waits for the writer to pause instead of saving every keystroke", async () => {
    const mods = await freshStore();
    await signIn(mods);
    saveDraft.mockClear();

    mods.drafts.drafts.next_shot = "R";
    await vi.advanceTimersByTimeAsync(500);
    mods.drafts.drafts.next_shot = "Reimu ";
    await vi.advanceTimersByTimeAsync(500);
    mods.drafts.drafts.next_shot = "Reimu kicks the door in";
    expect(saveDraft).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(mods.drafts.AUTOSAVE_DELAY_MS);

    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(saveDraft).toHaveBeenCalledWith(
      "next_shot",
      "Reimu kicks the door in",
      "whos-next",
    );
  });

  it("saves each kind under its own key, so one never overwrites the other", async () => {
    const mods = await freshStore();
    await signIn(mods);
    saveDraft.mockClear();

    mods.drafts.drafts.next_shot = "a shot";
    mods.drafts.drafts.next_episode = "a whole episode";
    await vi.advanceTimersByTimeAsync(mods.drafts.AUTOSAVE_DELAY_MS);

    expect(saveDraft).toHaveBeenCalledWith(
      "next_shot",
      "a shot",
      "whos-next",
    );
    expect(saveDraft).toHaveBeenCalledWith(
      "next_episode",
      "a whole episode",
      "whos-next",
    );
  });

  it("does not re-send a draft that has not changed since the last save", async () => {
    const mods = await freshStore();
    await signIn(mods);
    saveDraft.mockClear();

    mods.drafts.drafts.next_shot = "settled";
    await vi.advanceTimersByTimeAsync(mods.drafts.AUTOSAVE_DELAY_MS);
    expect(saveDraft).toHaveBeenCalledTimes(1);

    await mods.drafts.flushDraftsNow();

    expect(saveDraft).toHaveBeenCalledTimes(1);
  });

  it("never sends a draft for a browser with no identity", async () => {
    const mods = await freshStore();

    mods.drafts.drafts.next_shot = "typed while anonymous";
    await vi.advanceTimersByTimeAsync(mods.drafts.AUTOSAVE_DELAY_MS);

    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("saves what was typed while anonymous once a username is claimed", async () => {
    const mods = await freshStore();
    mods.drafts.drafts.next_shot = "typed while anonymous";
    await vi.advanceTimersByTimeAsync(mods.drafts.AUTOSAVE_DELAY_MS);
    expect(saveDraft).not.toHaveBeenCalled();

    await signIn(mods);
    await vi.advanceTimersByTimeAsync(mods.drafts.AUTOSAVE_DELAY_MS);

    expect(saveDraft).toHaveBeenCalledWith(
      "next_shot",
      "typed while anonymous",
      "whos-next",
    );
  });

  it("keeps local and server drafts separate when the viewer switches films", async () => {
    const mods = await freshStore();
    await signIn(mods);
    saveDraft.mockClear();

    mods.movies.viewingMovieSlug.value = "inland-empire-high";
    mods.drafts.drafts.next_shot = "高校片草稿";
    mods.movies.viewingMovieSlug.value = "whos-next";
    expect(mods.drafts.drafts.next_shot).toBe("");

    mods.drafts.drafts.next_shot = "Who\'s Next 草稿";
    mods.movies.viewingMovieSlug.value = "inland-empire-high";
    expect(mods.drafts.drafts.next_shot).toBe("高校片草稿");

    await vi.advanceTimersByTimeAsync(mods.drafts.AUTOSAVE_DELAY_MS);
    expect(saveDraft).toHaveBeenCalledWith(
      "next_shot",
      "高校片草稿",
      "inland-empire-high",
    );
    expect(saveDraft).toHaveBeenCalledWith(
      "next_shot",
      "Who\'s Next 草稿",
      "whos-next",
    );
  });

  it("clears a published draft after any older in-flight autosave", async () => {
    const mods = await freshStore();
    await signIn(mods);
    saveDraft.mockClear();

    let finishOldSave: (() => void) | undefined;
    saveDraft.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldSave = () => resolve({ kind: "next_shot", body: "old", updatedAt: "" });
        }),
    );
    saveDraft.mockResolvedValue({ kind: "next_shot", body: "", updatedAt: "" });

    mods.drafts.drafts.next_shot = "the text being published";
    await vi.advanceTimersByTimeAsync(mods.drafts.AUTOSAVE_DELAY_MS);
    expect(saveDraft).toHaveBeenCalledWith(
      "next_shot",
      "the text being published",
      "whos-next",
    );

    const clearing = mods.drafts.clearPublishedDraft("next_shot");
    expect(mods.drafts.drafts.next_shot).toBe("");
    expect(saveDraft).toHaveBeenCalledTimes(1);

    finishOldSave?.();
    await clearing;

    expect(saveDraft).toHaveBeenCalledTimes(2);
    expect(saveDraft).toHaveBeenLastCalledWith(
      "next_shot",
      "",
      "whos-next",
    );
  });
});

describe("draft restore", () => {
  it("brings back a draft this browser has never seen", async () => {
    myDrafts.mockResolvedValue({
      drafts: [{
        kind: "next_episode",
        body: "written on the other laptop",
        movieSlug: "whos-next",
        updatedAt: "",
      }],
    });
    const mods = await freshStore();
    expect(mods.drafts.drafts.next_episode).toBe("");

    await signIn(mods);

    expect(mods.drafts.drafts.next_episode).toBe("written on the other laptop");
  });

  it("leaves a slot alone once the writer has started typing in it", async () => {
    // The stored copy arrives after the writer is already mid-sentence; taking
    // it would delete a line they can see on screen.
    let release: (value: { drafts: Array<{ kind: string; body: string; updatedAt: string }> }) => void =
      () => undefined;
    myDrafts.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const mods = await freshStore();
    await signIn(mods);

    mods.drafts.drafts.next_shot = "what I am typing right now";
    release({ drafts: [{ kind: "next_shot", body: "the stale stored one", updatedAt: "" }] });
    await vi.advanceTimersByTimeAsync(0);

    expect(mods.drafts.drafts.next_shot).toBe("what I am typing right now");
  });

  it("stays local-only and stops asking once the endpoint answers 404", async () => {
    const { ApiError } = await import("../src/lib/api");
    myDrafts.mockRejectedValue(new ApiError(404, "not_implemented", "Not Found"));
    const mods = await freshStore();

    await signIn(mods);
    mods.drafts.drafts.next_shot = "still typed, still kept locally";
    await vi.advanceTimersByTimeAsync(mods.drafts.AUTOSAVE_DELAY_MS);

    expect(saveDraft).not.toHaveBeenCalled();
    expect(mods.drafts.drafts.next_shot).toBe("still typed, still kept locally");
  });
});
