<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "../i18n";
import { identity, logout } from "../stores/identity";
import { openAuth } from "../stores/ui";
import { viewingMovieSlug } from "../stores/movies";
import { siteDesign } from "../stores/prefs";

const moreMenu = ref<HTMLDetailsElement | null>(null);
function closeMore(): void {
  if (moreMenu.value) moreMenu.value.open = false;
}

const links = [
  { name: "live", key: "nav.live" },
  { name: "episodes", key: "nav.episodes" },
  { name: "characters", key: "nav.characters" },
  { name: "mine", key: "nav.mine" },
  { name: "hall", key: "nav.hall" },
  { name: "stories", key: "nav.stories" },
  { name: "how", key: "nav.how" },
  { name: "contact", key: "nav.contact" },
] as const;

/* Spec §2.5: unclaimed shows "Sign in / Sign up", a guest is invited to turn
   the name into an account, an account shows the name and a way out. */
const authLabel = computed(() =>
  identity.state === "guest" ? t("auth.claim_account") : t("auth.signin"),
);

function linkTarget(name: (typeof links)[number]["name"]): Record<string, unknown> {
  if (name === "live") {
    return { name: "movie-live", params: { movieSlug: viewingMovieSlug.value } };
  }
  return { name };
}
</script>

<template>
  <nav class="navbar" :aria-label="t('nav.label')">
    <div class="in">
      <RouterLink v-if="siteDesign === 'studio'" class="studio-brand" :to="linkTarget('live')" aria-label="CrowdAIMovie">
        Crowd<span>AI</span>Movie
      </RouterLink>
      <RouterLink
        v-for="link in siteDesign === 'studio' ? links.slice(0, 3) : links"
        :key="link.name"
        class="nav-link"
        :to="linkTarget(link.name)"
        >{{ t(link.key) }}</RouterLink
      >
      <details v-if="siteDesign === 'studio'" ref="moreMenu" class="nav-more" @keydown.esc="closeMore">
        <summary>{{ t("nav.more") }}</summary>
        <div class="nav-more-menu">
          <RouterLink v-for="(link, index) in links" :key="link.name" :class="{ 'nav-more-primary': index < 3 }" :to="linkTarget(link.name)" @click="closeMore">
            {{ t(link.key) }}
          </RouterLink>
        </div>
      </details>
      <span class="nav-spacer"></span>
      <div class="nav-user">
        <span class="who">
          <template v-if="identity.state === 'account'"
            ><b>@{{ identity.username }}</b></template
          >
          <template v-else-if="identity.state === 'guest'"
            >{{ t("auth.guest") }} <b>@{{ identity.username }}</b></template
          >
          <template v-else>{{ t("auth.anonymous") }}</template>
        </span>
        <button
          v-if="identity.state !== 'account'"
          class="btn-auth"
          type="button"
          @click="openAuth()"
        >
          {{ authLabel }}
        </button>
        <button
          v-if="identity.state !== 'anonymous'"
          class="btn-auth ghost"
          type="button"
          :disabled="identity.busy"
          @click="logout()"
        >
          {{ t("auth.logout") }}
        </button>
      </div>
    </div>
  </nav>
</template>
