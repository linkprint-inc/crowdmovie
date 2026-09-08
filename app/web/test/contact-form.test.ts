import { RouterLinkStub, flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ContactView from "../src/views/ContactView.vue";
import { CONTACT_MAX_GRAPHEMES } from "../src/lib/grapheme";
import { setLocale } from "../src/i18n";
import { identity } from "../src/stores/identity";

/*
 * §15. The body limit is counted with the same `Intl.Segmenter` rule the
 * server uses, `category` is a fixed enum, and `scene_index` is a published
 * scene number or nothing. The success state matters as much as the send: a
 * form that clears itself without saying anything reads as a message lost.
 */

const { contact } = vi.hoisted(() => ({ contact: vi.fn() }));

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, api: { contact } };
});

beforeEach(() => {
  setLocale("en");
  identity.state = "guest";
  identity.username = "tester";
  contact.mockReset();
  contact.mockResolvedValue({ ok: true });
});

const mountView = () => mount(ContactView, { global: { stubs: { RouterLink: RouterLinkStub } } });

async function fill(
  w: ReturnType<typeof mountView>,
  body: string,
  sceneRef = "",
): Promise<void> {
  await w.get("#ct-body").setValue(body);
  if (sceneRef !== "") await w.get("#ct-scene").setValue(sceneRef);
}

describe("the contact form's length limit", () => {
  it("counts graphemes the way the server does, not UTF-16 units", async () => {
    const w = mountView();

    await fill(w, "👩‍👩‍👧‍👦灵梦");

    // One ZWJ family sequence plus two CJK characters: 3 to the reader and to
    // `Intl.Segmenter`, 13 to `String.length`.
    expect("👩‍👩‍👧‍👦灵梦".length).toBe(13);
    expect(w.get(".count b").text()).toBe("3");
  });

  it("accepts exactly the limit", async () => {
    const w = mountView();

    await fill(w, "x".repeat(CONTACT_MAX_GRAPHEMES));

    expect(w.get(".count").classes()).not.toContain("over");
    expect(w.get("button.btn-teal").attributes("disabled")).toBeUndefined();
  });

  it("refuses to send one grapheme past it", async () => {
    const w = mountView();

    await fill(w, "x".repeat(CONTACT_MAX_GRAPHEMES + 1));

    expect(w.get(".count").classes()).toContain("over");
    expect(w.get("button.btn-teal").attributes("disabled")).toBeDefined();
    await w.get("button.btn-teal").trigger("click");
    expect(contact).not.toHaveBeenCalled();
  });

  it("will not send an empty body", async () => {
    const w = mountView();

    await w.get("button.btn-teal").trigger("click");

    expect(contact).not.toHaveBeenCalled();
    expect(w.find(".field.bad .err").exists()).toBe(true);
  });
});

describe("the contact form's scene reference", () => {
  it("sends the padded scene number as an integer", async () => {
    const w = mountView();
    await fill(w, "this scene is not mine", "000042");

    await w.get("button.btn-teal").trigger("click");

    expect(contact).toHaveBeenCalledWith({
      category: "general",
      sceneIndex: 42,
      body: "this scene is not mine",
    });
  });

  it("sends null when no scene was named", async () => {
    const w = mountView();
    await fill(w, "just a question");

    await w.get("button.btn-teal").trigger("click");

    expect(contact.mock.calls[0][0].sceneIndex).toBeNull();
  });

  it("refuses a reference that is not a scene number", async () => {
    const w = mountView();
    await fill(w, "about scene", "the red one");

    expect(w.find('[data-test="scene-err"]').exists()).toBe(true);
    await w.get("button.btn-teal").trigger("click");
    expect(contact).not.toHaveBeenCalled();
  });

  it("sends the category the writer picked, not the default", async () => {
    const w = mountView();
    await fill(w, "my scene was taken down");
    await w.get("#ct-type").setValue("appeal");

    await w.get("button.btn-teal").trigger("click");

    expect(contact.mock.calls[0][0].category).toBe("appeal");
  });
});

describe("the contact form's outcome", () => {
  it("confirms the message landed and says how a reply arrives", async () => {
    const w = mountView();
    await fill(w, "hello");

    await w.get("button.btn-teal").trigger("click");
    await flushPromises();

    const sent = w.get('[data-test="sent"]');
    expect(sent.text()).toContain("Message sent");
    // A guest has no address to reply to, and is told so rather than left
    // waiting for an answer that cannot come.
    expect(sent.text()).toContain("account");
    expect(w.find("#ct-body").exists()).toBe(false);
  });

  it("says nothing was sent when the endpoint is not there", async () => {
    const { ApiError } = await import("../src/lib/api");
    contact.mockRejectedValue(new ApiError(404, "not_implemented", "Not Found"));
    const w = mountView();
    await fill(w, "hello");

    await w.get("button.btn-teal").trigger("click");
    await flushPromises();

    expect(w.find('[data-test="sent"]').exists()).toBe(false);
    expect(w.get(".empty.bad").text()).toContain("not connected yet");
  });

  it("keeps the writer's text on screen when the send fails", async () => {
    const { ApiError } = await import("../src/lib/api");
    contact.mockRejectedValue(new ApiError(429, "rate_limited", "too many"));
    const w = mountView();
    await fill(w, "a message worth keeping");

    await w.get("button.btn-teal").trigger("click");
    await flushPromises();

    expect(w.find('[data-test="sent"]').exists()).toBe(false);
    expect((w.get("#ct-body").element as HTMLTextAreaElement).value).toBe(
      "a message worth keeping",
    );
    expect(w.get(".formerr").text()).toContain("Too many");
  });
});
