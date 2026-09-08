<script setup lang="ts">
import { computed } from "vue";
import { t, locale } from "../i18n";
import { live } from "../stores/live";

// The strip scrolls its own width, so the text is doubled to make the loop
// seamless. Decorative only — hidden from assistive tech.
const text = computed(() => {
  const base = t("marquee");
  const ep = live.round
    ? `EP ${String(live.round.episodeIndex).padStart(2, "0")} ${live.round.episodeTitle} ✦ `
    : "";
  return (base + ep).repeat(2);
});
</script>

<template>
  <div class="marquee" aria-hidden="true">
    <span class="in" :key="locale">{{ text }}</span>
  </div>
</template>
