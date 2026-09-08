<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { useRoute } from "vue-router";
import SiteMarquee from "./components/SiteMarquee.vue";
import SiteNav from "./components/SiteNav.vue";
import SiteHeader from "./components/SiteHeader.vue";
import AuthModal from "./components/AuthModal.vue";
import MoviePickerModal from "./components/MoviePickerModal.vue";
import { loadIdentity } from "./stores/identity";
import { siteDesign } from "./stores/prefs";
import { start, switchLiveContext } from "./stores/live";
import {
  chooseViewingContext,
  initializeMovies,
  syncViewingContextFromRoute,
} from "./stores/movies";

const route = useRoute();
const screening = computed(() =>
  ["live", "movie-live", "movie-replay"].includes(String(route.name)),
);

// The rail's round state drives the header countdown too, so the poll runs for
// the whole session rather than only while the screening room is mounted.
onMounted(async () => {
  void loadIdentity();
  const preferred =
    typeof route.params.movieSlug === "string" ? route.params.movieSlug : undefined;
  await initializeMovies(preferred);
  const index = Number(route.params.index);
  if (preferred !== undefined && Number.isSafeInteger(index) && index > 0) {
    await chooseViewingContext(preferred, index);
  }
  start();
});

watch(
  () => [route.name, route.params.movieSlug, route.params.index] as const,
  async ([routeName, rawSlug, rawIndex]) => {
    if (await syncViewingContextFromRoute(routeName, rawSlug, rawIndex)) {
      switchLiveContext();
    }
  },
);
</script>

<template>
  <div class="site-shell" :data-design="siteDesign" :class="{ 'screening-home': screening }">
    <SiteMarquee />
    <SiteNav />
    <SiteHeader :screening="screening" />
    <div class="viewport">
      <RouterView v-slot="{ Component }">
        <component :is="Component" :key="$route.fullPath" />
      </RouterView>
    </div>
    <AuthModal />
    <MoviePickerModal />
  </div>
</template>
