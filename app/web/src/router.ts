/*
 * History mode: clean URLs, no `#`. This depends on the Caddy site block
 * rewriting unknown paths to /index.html (`try_files {path} /index.html`) —
 * without that, a deep link or a refresh on /episodes/3 is a 404 from the
 * static file server before the app ever loads.
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";

const routes: RouteRecordRaw[] = [
  { path: "/", name: "live", component: () => import("./views/LiveView.vue") },
  {
    path: "/movies/:movieSlug",
    name: "movie-live",
    component: () => import("./views/LiveView.vue"),
  },
  {
    path: "/movies/:movieSlug/watch/:index(\\d+)",
    name: "movie-replay",
    component: () => import("./views/LiveView.vue"),
    props: true,
  },
  {
    path: "/movies/:movieSlug/episodes",
    name: "movie-episodes",
    component: () => import("./views/EpisodesView.vue"),
    props: true,
  },
  {
    path: "/movies/:movieSlug/episodes/:index(\\d+)",
    name: "movie-episode",
    component: () => import("./views/EpisodeDetailView.vue"),
    props: (route) => ({
      movieSlug: String(route.params.movieSlug),
      index: Number(route.params.index),
    }),
  },
  {
    path: "/movies/:movieSlug/characters",
    name: "movie-characters",
    component: () => import("./views/CharactersView.vue"),
    props: true,
  },
  {
    path: "/episodes",
    name: "episodes",
    component: () => import("./views/EpisodesView.vue"),
  },
  {
    path: "/episodes/:index(\\d+)",
    redirect: (to) => `/movies/inland-empire-high/episodes/${String(to.params.index)}`,
  },
  {
    path: "/characters",
    name: "characters",
    component: () => import("./views/CharactersView.vue"),
  },
  { path: "/my-scripts", name: "mine", component: () => import("./views/MyScriptsView.vue") },
  { path: "/hall-of-fame", name: "hall", component: () => import("./views/HallOfFameView.vue") },
  { path: "/stories", name: "stories", component: () => import("./views/StoriesView.vue") },
  {
    path: "/stories/compose",
    name: "story-compose",
    component: () => import("./views/StoryComposeView.vue"),
  },
  {
    path: "/stories/:id",
    name: "story",
    component: () => import("./views/StoryDetailView.vue"),
    props: (route) => ({ id: String(route.params.id) }),
  },
  { path: "/how-it-works", name: "how", component: () => import("./views/HowItWorksView.vue") },
  { path: "/contact", name: "contact", component: () => import("./views/ContactView.vue") },
  { path: "/:pathMatch(.*)*", redirect: { name: "live" } },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});
