<script setup lang="ts">
import { computed, watch } from "vue";
import { t } from "../i18n";
import { api } from "../lib/api";
import { glen, KIND_MAX_GRAPHEMES } from "../lib/grapheme";
import { pad } from "../lib/format";
import { useResource } from "../lib/useResource";
import PageState from "../components/PageState.vue";
import { draftSync, drafts } from "../stores/drafts";
import { canWrite, identity } from "../stores/identity";
import { openAuth } from "../stores/ui";

/*
 * Spec §12. Stats, the draft box and the submission history. Drafts are local
 * to this browser and available even before the server-side endpoints exist,
 * so the page is useful today rather than being one big empty state.
 */

const { data: stats, reload: reloadStats } = useResource(() => api.myStats(), {
  immediate: false,
});
const {
  data: historyData,
  loading: historyLoading,
  missing: historyMissing,
  error: historyError,
  reload: reloadHistory,
} = useResource(() => api.mySubmissions(), { immediate: false });

/* 故事设定（《故事设定投稿技术规范》§6）。The author sees the verdict on the
   page they already visit, rather than having to remember to open the editor. */
const { data: storyData, reload: reloadStories } = useResource(() => api.myStory(), {
  immediate: false,
});
const myStories = computed(() => storyData.value?.proposals ?? []);

/* Both endpoints are 401 for an anonymous browser. Wait until the identity
   request has answered before deciding whether to read them; claiming a name
   mid-visit then flips this source and loads the private data exactly once. */
const canLoadMine = computed(() => identity.loaded && canWrite.value);
watch(canLoadMine, (able) => {
  if (!able) return;
  void reloadStats();
  void reloadHistory();
  void reloadStories();
}, { immediate: true });

const localDrafts = computed(() =>
  (["next_shot", "next_episode"] as const)
    .filter((slot) => drafts[slot].trim() !== "")
    .map((slot) => ({
      slot,
      label: slot === "next_shot" ? t("composer.kind_shot") : t("composer.kind_episode"),
      text: drafts[slot],
      count: glen(drafts[slot]),
      max: KIND_MAX_GRAPHEMES[slot],
    })),
);

const rows = computed(() => historyData.value?.submissions ?? []);

function statusLabel(status: string): string {
  if (status === "accepted") return t("mine.accepted");
  if (status === "rejected") return t("mine.rejected");
  return t("mine.pending");
}

function storyStatusLabel(status: string): string {
  if (status === "draft") return t("mine.story_draft");
  if (status === "pending") return t("mine.story_pending");
  if (status === "approved") return t("mine.story_approved");
  if (status === "review_failed") return t("mine.story_failed");
  return t("mine.story_rejected");
}
</script>

<template>
  <div class="page">
    <div class="inner">
      <h2 class="ptitle">
        {{ t("mine.title") }} <small>{{ t("mine.sub") }}</small>
      </h2>
      <p class="plead">{{ t("mine.lead") }}</p>

      <p v-if="!canWrite && identity.loaded" class="empty">
        <b>{{ t("mine.anon_title") }}</b>
        {{ t("mine.anon_body") }}
        <span style="display: block; margin-top: 12px">
          <button class="ep-open" type="button" @click="openAuth()">
            {{ t("auth.signin") }}
          </button>
        </span>
      </p>

      <template v-else>
        <div v-if="stats" class="stats">
          <div class="stat">
            <div class="k">{{ t("mine.stat_submissions") }}</div>
            <div class="v">{{ stats.submissions }}</div>
          </div>
          <div class="stat">
            <div class="k">{{ t("mine.stat_accepted") }}</div>
            <div class="v">{{ stats.accepted }}</div>
          </div>
          <div class="stat">
            <div class="k">{{ t("mine.stat_votes") }}</div>
            <div class="v">{{ stats.netVotes }}</div>
          </div>
          <div class="stat">
            <div class="k">{{ t("mine.stat_episodes") }}</div>
            <div class="v">{{ stats.episodes }}</div>
          </div>
          <div class="stat">
            <div class="k">{{ t("mine.stat_themes") }}</div>
            <div class="v">{{ stats.themesSet }}</div>
          </div>
        </div>

        <h3 class="subsec">
          {{ t("mine.drafts") }}
          <!-- §12「自动保存」: the writer is told which copy they are looking
               at, rather than being left to guess whether it left the tab. -->
          <small v-if="draftSync.saving" data-test="draft-sync">{{ t("mine.drafts_saving") }}</small>
          <small v-else-if="draftSync.savedAt" data-test="draft-sync">{{
            t("mine.drafts_saved")
          }}</small>
        </h3>
        <div class="board">
          <p v-if="localDrafts.length === 0" class="empty">{{ t("mine.drafts_empty") }}</p>
          <div v-for="d in localDrafts" :key="d.slot" class="row">
            <span class="nm">{{ d.label }}</span>
            <span class="sp">{{ d.text }}</span>
            <span class="num">{{ d.count }} / {{ d.max }}</span>
          </div>
        </div>

        <h3 class="subsec">{{ t("mine.records") }}</h3>
        <PageState
          :loading="historyLoading"
          :missing="historyMissing"
          :error="historyError"
          :empty-title="rows.length === 0 ? t('mine.empty_title') : undefined"
          :empty-body="t('mine.empty_body')"
          @retry="reloadHistory()"
        />
        <div v-if="rows.length > 0" class="board blue">
          <div v-for="row in rows" :key="row.id" class="row">
            <span class="num">
              <template v-if="row.episodeIndex !== null">EP {{ pad(row.episodeIndex, 2) }}</template>
              <template v-if="row.sceneIndex !== null"> · R{{ row.sceneIndex }}</template>
            </span>
            <span class="sp">{{ row.content }}</span>
            <!-- Adoption and the 初评 verdict are different facts: a pitch can
                 pass scoring and still not be the one that got shot. -->
            <span v-if="row.isEpisodeTheme" class="medal">{{
              t("mine.theme_medal", { n: row.episodeIndex ?? 0 })
            }}</span>
            <span v-else-if="row.adopted" class="medal" data-test="adopted">{{
              row.sceneIndex === null
                ? t("mine.adopted")
                : t("mine.adopted_scene", { n: pad(row.sceneIndex, 6) })
            }}</span>
            <span v-else-if="row.status === 'accepted'" class="medal">{{ t("mine.accepted") }}</span>
            <span class="num">
              <template v-if="row.score !== null">
                {{ statusLabel(row.status) }} · <b>AI {{ row.score }}</b> ·
              </template>
              <template v-else>{{ statusLabel(row.status) }} · </template>
              ▲{{ row.netVotes }}
            </span>
          </div>
        </div>

        <section v-if="myStories.length > 0" class="ms-stories">
          <h3 class="ptitle">{{ t("mine.stories_title") }}</h3>
          <div v-for="row in myStories" :key="row.id" class="ms-story">
            <b class="ms-story-title">{{ row.title }}</b>
            <span class="ms-story-status" :class="row.status">{{
              storyStatusLabel(row.status)
            }}</span>
            <!-- The reason is the whole point of showing a rejection here: a
                 badge without it tells the author no and not why. -->
            <span v-if="row.rejectReason" class="ms-story-reason">{{
              row.rejectReason
            }}</span>
            <RouterLink
              v-if="row.status === 'approved'"
              :to="{ name: 'story', params: { id: row.id } }"
              >{{ t("compose.view") }}</RouterLink
            >
            <RouterLink v-else :to="{ name: 'story-compose' }">{{
              t("stories.compose")
            }}</RouterLink>
          </div>
        </section>

        <p class="disclaimer">{{ t("mine.cookie_note") }}</p>
      </template>
    </div>
  </div>
</template>
