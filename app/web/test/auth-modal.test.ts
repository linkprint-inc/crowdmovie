import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AuthModal from "../src/components/AuthModal.vue";
import { identity } from "../src/stores/identity";
import { authModalOpen, closeAuth, openAuth } from "../src/stores/ui";
import { setLocale } from "../src/i18n";

const claimGuest = vi.fn();
const register = vi.fn();

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...actual,
    api: {
      claimGuest: (...args: unknown[]) => claimGuest(...args),
      register: (...args: unknown[]) => register(...args),
      login: vi.fn(),
      logout: vi.fn(),
      identity: vi.fn(),
    },
  };
});

beforeEach(() => {
  localStorage.clear();
  setLocale("en");
  identity.state = "anonymous";
  identity.username = null;
  identity.busy = false;
  claimGuest.mockReset();
  register.mockReset();
  closeAuth();
});

/*
 * Spec §2.5. The behaviour that is easy to break and impossible to notice in a
 * screenshot: pressing "sign up now" the first time must reveal the account
 * fields WITHOUT closing the modal and WITHOUT submitting anything.
 */
describe("the quick-start modal's progressive disclosure", () => {
  it("shows only the username field when it opens", async () => {
    const w = mount(AuthModal);
    openAuth();
    await w.vm.$nextTick();

    expect(w.find("#cm-username").exists()).toBe(true);
    expect(w.find('[data-test="field-email"]').exists()).toBe(false);
    expect(w.find('[data-test="field-password"]').exists()).toBe(false);
  });

  it("reveals email and password in place, without closing or submitting", async () => {
    const w = mount(AuthModal);
    openAuth();
    await w.vm.$nextTick();

    await w.get('[data-test="register"]').trigger("click");
    await w.vm.$nextTick();

    // Revealed...
    expect(w.find('[data-test="field-email"]').exists()).toBe(true);
    expect(w.find('[data-test="field-password"]').exists()).toBe(true);
    // ...still open...
    expect(authModalOpen.value).toBe(true);
    expect(w.find('[data-test="scrim"]').exists()).toBe(true);
    // ...and nothing was sent.
    expect(register).not.toHaveBeenCalled();
    expect(claimGuest).not.toHaveBeenCalled();
  });

  it("relabels the button and swaps the description on the first press", async () => {
    const w = mount(AuthModal);
    openAuth();
    await w.vm.$nextTick();

    const firstLabel = w.get('[data-test="register"]').text();
    const firstSub = w.get(".sub").text();

    await w.get('[data-test="register"]').trigger("click");
    await w.vm.$nextTick();

    expect(w.get('[data-test="register"]').text()).not.toBe(firstLabel);
    expect(w.get(".sub").text()).not.toBe(firstSub);
  });

  it("validates only on the second press and keeps the modal open on failure", async () => {
    const w = mount(AuthModal);
    openAuth();
    await w.vm.$nextTick();

    await w.get("#cm-username").setValue("tester");
    await w.get('[data-test="register"]').trigger("click");
    await w.vm.$nextTick();

    // Second press with an empty email and a short password.
    await w.get("#cm-email").setValue("not-an-email");
    await w.get("#cm-password").setValue("short");
    await w.get('[data-test="register"]').trigger("click");
    await w.vm.$nextTick();

    expect(register).not.toHaveBeenCalled();
    expect(authModalOpen.value).toBe(true);
    expect(w.get('[data-test="field-email"]').classes()).toContain("bad");
    expect(w.get('[data-test="field-password"]').classes()).toContain("bad");
  });

  it("submits once every field is valid", async () => {
    register.mockResolvedValue({ id: "1", username: "tester", state: "account" });
    const w = mount(AuthModal);
    openAuth();
    await w.vm.$nextTick();

    await w.get("#cm-username").setValue("tester");
    await w.get('[data-test="register"]').trigger("click");
    await w.vm.$nextTick();

    await w.get("#cm-email").setValue("tester@example.com");
    await w.get("#cm-password").setValue("longenough");
    await w.get('[data-test="register"]').trigger("click");
    await w.vm.$nextTick();

    expect(register).toHaveBeenCalledWith({
      username: "tester",
      email: "tester@example.com",
      password: "longenough",
    });
  });

  it("collapses back to username-only the next time it opens", async () => {
    const w = mount(AuthModal);
    openAuth();
    await w.vm.$nextTick();

    await w.get('[data-test="register"]').trigger("click");
    await w.vm.$nextTick();
    expect(w.find('[data-test="field-email"]').exists()).toBe(true);

    await w.get(".x").trigger("click");
    await w.vm.$nextTick();
    expect(authModalOpen.value).toBe(false);

    openAuth();
    await w.vm.$nextTick();
    expect(w.find('[data-test="field-email"]').exists()).toBe(false);
  });

  it("carries the current guest name in so it can be upgraded in place", async () => {
    identity.state = "guest";
    identity.username = "NightStudyDeserter";

    const w = mount(AuthModal);
    openAuth();
    await w.vm.$nextTick();

    expect((w.get("#cm-username").element as HTMLInputElement).value).toBe("NightStudyDeserter");
  });

  it("claims a guest name without ever revealing the account fields", async () => {
    claimGuest.mockResolvedValue({ id: "1", username: "tester" });
    const w = mount(AuthModal);
    openAuth();
    await w.vm.$nextTick();

    await w.get("#cm-username").setValue("tester");
    await w.get(".primary").trigger("click");
    await w.vm.$nextTick();

    expect(claimGuest).toHaveBeenCalledWith("tester");
    expect(register).not.toHaveBeenCalled();
  });
});
