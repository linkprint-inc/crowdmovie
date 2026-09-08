<script setup lang="ts">
import { computed } from "vue";
import { t } from "../i18n";
import { api, type HallEntry } from "../lib/api";
import { useResource } from "../lib/useResource";
import PageState from "../components/PageState.vue";

/* Spec §2.5: ranked by accepted scenes, with cumulative net votes and a mark
   for anyone who has set an entire episode's theme. */
const { data, loading, missing, error, reload } = useResource(() => api.hallOfFame());
const entries = computed(() => data.value?.entries ?? []);

/** Every episode theme this contributor wrote, newest first. */
function themesOf(row: HallEntry): number[] {
  const all = row.themeEpisodeIndexes;
  if (Array.isArray(all) && all.length > 0) return [...all].sort((a, b) => b - a);
  return row.themeEpisodeIndex === null ? [] : [row.themeEpisodeIndex];
}
</script>

<template>
  <div class="page">
    <div class="inner">
      <h2 class="ptitle">
        {{ t("hall.title") }} <small>{{ t("hall.sub") }}</small>
      </h2>
      <p class="plead">{{ t("hall.lead") }}</p>

      <PageState
        :loading="loading"
        :missing="missing"
        :error="error"
        :empty-title="entries.length === 0 ? t('hall.empty_title') : undefined"
        :empty-body="t('hall.empty_body')"
        @retry="reload()"
      />

      <div v-if="entries.length > 0" class="board">
        <div v-for="(row, i) in entries" :key="row.username" class="row">
          <span class="rank" :class="{ top: i < 3 }">{{ i + 1 }}</span>
          <span class="nm">{{ row.username }}</span>
          <!-- Someone can have authored more than one episode's theme; naming
               only the first would quietly under-credit them. -->
          <span v-for="n in themesOf(row)" :key="n" class="medal">{{
            t("hall.theme", { n })
          }}</span>
          <span class="sp"></span>
          <span class="num">
            {{ t("hall.accepted", { n: row.acceptedCount }) }} ·
            {{ t("hall.votes", { n: row.netVotes }) }}
          </span>
        </div>
      </div>

      <p class="disclaimer">{{ t("hall.note") }}</p>
    </div>
  </div>
</template>
