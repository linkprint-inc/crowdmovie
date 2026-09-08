import { RouterLinkStub, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it } from "vitest";

import ContactView from "../src/views/ContactView.vue";
import { router } from "../src/router";
import { setLocale } from "../src/i18n";
import { identity } from "../src/stores/identity";

beforeEach(() => {
  setLocale("en");
  identity.state = "anonymous";
  identity.username = null;
});

const mountView = () => mount(ContactView, { global: { stubs: { RouterLink: RouterLinkStub } } });

/*
 * Spec §2.5. The rail exists to answer the questions that would otherwise
 * arrive as a message. A link that points at a renamed route still renders —
 * vue-router only warns — so the dead href is invisible until someone clicks.
 */
describe("the contact page's self-serve rail", () => {
  it("points every link at a route that still exists", () => {
    const links = mountView().findAllComponents(RouterLinkStub);

    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const to = link.props("to") as { name: string };
      expect(router.hasRoute(to.name)).toBe(true);
    }
  });

  it("states the reply rules before anything has been submitted", () => {
    const w = mountView();

    expect(w.find('[data-test="reply-rules"]').exists()).toBe(true);
    expect(w.find('[data-test="sent"]').exists()).toBe(false);
  });

  it("keeps the disclaimer on the page after the move into the rail", () => {
    expect(mountView().find('[data-test="disclaimer"]').text()).toContain("new crossover scenes");
  });
});
