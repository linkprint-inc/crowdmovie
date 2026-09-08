import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import StoryComposer from "../src/components/StoryComposer.vue";
import { drafts } from "../src/stores/drafts";
import { identity } from "../src/stores/identity";
import { setLocale } from "../src/i18n";

/*
 * §14.1: a danmaku row has a NOT NULL `scene_index` and an `offset_ms` that has
 * to fall inside that scene. The composer shipped sending `{videoTimeMs: 0,
 * videoSceneId: null}`, which the server answered 400 scene_index_invalid for
 * every single comment — so the whole feature was dead in production and no
 * test noticed. These pin the wire shape, not just that something was sent.
 */

/* `vi.mock`'s factory is hoisted above the file, so the spy has to be too. */
const { sendDanmaku } = vi.hoisted(() => ({
  sendDanmaku: vi.fn(
    async (content: string, anchor: { sceneIndex: number; offsetMs: number }) => ({
      id: "77",
      username: "tester",
      content,
      sceneIndex: anchor.sceneIndex,
      offsetMs: anchor.offsetMs,
      createdAt: new Date().toISOString(),
    }),
  ),
}));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, api: { submit: vi.fn(), sendDanmaku } };
});

const ANCHOR = { sceneIndex: 9, offsetMs: 4_200 };

beforeEach(() => {
  localStorage.clear();
  setLocale("en");
  identity.state = "guest";
  identity.username = "tester";
  drafts.next_shot = "";
  drafts.next_episode = "";
  drafts.danmaku = "";
  sendDanmaku.mockClear();
});

const mountDm = (anchor: { sceneIndex: number; offsetMs: number } | null) =>
  mount(StoryComposer, { props: { mode: "dm", anchor } });

describe("the live comment's scene anchor", () => {
  it("sends the scene being watched and the playback position, not a default", async () => {
    const w = mountDm(ANCHOR);
    await w.get("textarea").setValue("this shot rules");

    await w.get("button.send").trigger("click");

    expect(sendDanmaku).toHaveBeenCalledTimes(1);
    expect(sendDanmaku.mock.calls[0][0]).toBe("this shot rules");
    // The second argument is the anchor: the real scene_index and offset_ms.
    expect(sendDanmaku.mock.calls[0][1]).toEqual(ANCHOR);
  });

  it("sends the scene index off the playlist entry, never the playlist position", async () => {
    // Published indexes are never renumbered, so scene 9 can sit at playlist
    // position 0. Sending the position would anchor onto the wrong scene.
    const w = mountDm({ sceneIndex: 9, offsetMs: 0 });
    await w.get("textarea").setValue("first frame");

    await w.get("button.send").trigger("click");

    expect(sendDanmaku.mock.calls[0][1].sceneIndex).toBe(9);
  });

  it("refuses to send at all while nothing is playing", async () => {
    const w = mountDm(null);
    await w.get("textarea").setValue("shouting into the void");

    await w.get("button.send").trigger("click");

    expect(sendDanmaku).not.toHaveBeenCalled();
  });

  it("puts the box read-only and says why when nothing is playing", async () => {
    const w = mountDm(null);

    expect(w.get("textarea").attributes("readonly")).toBeDefined();
    expect(w.get("button.send").attributes("disabled")).toBeDefined();
    // The state is a sentence, not just a greyed-out button.
    expect(w.get('[data-test="hint"]').text()).toContain("Nothing is playing");
  });

  it("reopens the box as soon as a scene starts playing", async () => {
    const w = mountDm(null);
    expect(w.get("textarea").attributes("readonly")).toBeDefined();

    await w.setProps({ anchor: ANCHOR });

    expect(w.get("textarea").attributes("readonly")).toBeUndefined();
  });

  it("hands the created row up so the overlay can draw it without a refetch", async () => {
    const w = mountDm(ANCHOR);
    await w.get("textarea").setValue("nice");

    await w.get("button.send").trigger("click");
    await Promise.resolve();

    const posted = w.emitted("posted");
    expect(posted).toBeTruthy();
    expect((posted?.[0][0] as { id: string }).id).toBe("77");
  });
});
