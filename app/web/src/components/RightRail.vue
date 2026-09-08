<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { t } from "../i18n";
import { ApiError, type Danmaku, type DanmakuAnchor, type SubmissionRound } from "../lib/api";
import { publicRoundNumber } from "../lib/round-number";
import { pad } from "../lib/format";
import ChatLine from "./ChatLine.vue";
import StoryComposer from "./StoryComposer.vue";
import { canWrite } from "../stores/identity";
import {
  CROWD_THRESHOLD,
  castVote,
  live,
  nextPublicRound,
  loadEarlierSubmissions,
  myVotes,
  refreshSceneDanmaku,
} from "../stores/live";
import type { DraftSlot } from "../stores/drafts";
import { siteDesign } from "../stores/prefs";

/*
 * The right rail — spec §5–§7. One closed panel, height-locked to the
 * viewport; only the feed inside it scrolls. Studio puts the same composer
 * before the feed; Classic keeps it at the bottom with CSS order. Switching
 * templates never remounts the composer. Switching between Continue Story
 * and Live Comments changes the list and the input's meaning, and never
 * touches the video or either draft.
 */

/** The player's live anchor, handed down so the comment box can send §14.1's
 *  scene and offset instead of inventing one. */
defineProps<{ anchor?: DanmakuAnchor | null }>();

const emit = defineEmits<{ (e: "danmaku", row: Danmaku): void }>();

const mode = ref<"story" | "dm">("story");
const bannerOpen = ref(false);
const feed = ref<HTMLElement | null>(null);
const hasNew = ref(false);
const voteError = ref("");

const newestFirst = computed(() => siteDesign.value === "studio");

function roundLabel(round: Pick<SubmissionRound, "status" | "sceneIndex" | "sceneTakenDown">): string {
  let label: string;
  switch (round.status) {
    case "open": label = t("timeline.round_open"); break;
    case "published": label = t(round.sceneTakenDown ? "timeline.round_removed" : "timeline.round_published"); break;
    case "select_failed": label = t("timeline.round_select_failed"); break;
    case "generation_failed": label = t("timeline.round_generation_failed"); break;
    case "validation_failed": label = t("timeline.round_validation_failed"); break;
    case "generating": label = t("timeline.round_generating"); break;
    case "validating": label = t("timeline.round_validating"); break;
    case "selected": label = t("timeline.round_queued"); break;
    case "selecting": label = t("timeline.round_judging"); break;
    default: label = t("timeline.round_history");
  }
  return round.sceneIndex != null ? `${label} · SCENE ${pad(round.sceneIndex)}` : label;
}

/* The store stays chronological. Classic preserves that order; Studio shows
   newest rounds and newest submissions first, without mutating shared data. */
const chronologicalGroups = computed(() => {
  const out = live.archive.map((a) => ({
    key: `r${a.roundIndex}`,
    roundIndex: publicRoundNumber(a, nextPublicRound.value),
    status: a.status,
    label: roundLabel(a),
    rows: a.submissions,
  }));
  if (live.round) {
    out.push({
      key: `r${live.round.roundIndex}-current`,
      roundIndex: publicRoundNumber(live.round, nextPublicRound.value),
      status: live.round.status,
      label: roundLabel(live.round),
      rows: live.submissions,
    });
  }
  return out;
});

const groups = computed(() => newestFirst.value
  ? [...chronologicalGroups.value].reverse().map((group) => ({
      ...group,
      rows: [...group.rows].reverse(),
    }))
  : chronologicalGroups.value,
);
const timelineIds = computed(() =>
  chronologicalGroups.value.flatMap((group) => group.rows.map((row) => row.id)),
);
const visibleCount = computed(() => groups.value.reduce((n, g) => n + g.rows.length, 0));
const isEmpty = computed(() => live.loaded && visibleCount.value === 0);

const proposals = computed(() =>
  [...live.proposals].sort((a, b) => b.upCount - b.downCount - (a.upCount - a.downCount)),
);

const episodeIndex = computed(() => live.episode?.episodeIndex ?? live.round?.episodeIndex ?? null);
const episodeTitle = computed(
  () => live.episode?.title ?? live.round?.episodeTitle ?? "",
);

function crowdSelected(id: string): boolean {
  return (
    live.round?.selectedSubmissionId === id &&
    live.round?.selectionMode === "crowd"
  );
}

function gapToCanon(up: number, down: number): number | null {
  const gap = CROWD_THRESHOLD - (up - down);
  return gap > 0 && gap <= 5 ? gap : null;
}

async function onVote(id: string, value: 1 | -1): Promise<void> {
  voteError.value = "";
  try {
    await castVote(id, value);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    voteError.value = err.message;
  }
}

/* Follow new submissions only while already reading the newest end. Keep the
   visible row in place when either live updates or historical pages arrive. */
function atLatest(): boolean {
  const el = feed.value;
  if (!el) return true;
  return newestFirst.value
    ? el.scrollTop < 48
    : el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}

function scrollToLatest(): void {
  const el = feed.value;
  if (!el) return;
  el.scrollTop = newestFirst.value ? 0 : el.scrollHeight;
  hasNew.value = false;
}

watch(
  timelineIds,
  async (ids, previous) => {
    if (ids.length === 0) {
      hasNew.value = false;
      return;
    }
    const previousIds = new Set(previous);
    if (ids.every((id) => previousIds.has(id))) return;
    const el = feed.value;
    if (!el) return;
    const hasNewRows = !previousIds.has(ids[ids.length - 1]);
    const replacedTimeline = !ids.some((id) => previousIds.has(id));
    const followLatest = atLatest() || replacedTimeline;
    const viewportTop = el.getBoundingClientRect().top;
    const anchor = Array.from(el.querySelectorAll<HTMLElement>("[data-submission-id]"))
      .find((row) => row.getBoundingClientRect().bottom > viewportTop);
    const anchorTop = anchor?.getBoundingClientRect().top;
    await nextTick();
    if (el !== feed.value) return;
    if (hasNewRows && followLatest) {
      scrollToLatest();
    } else {
      // Use the row's actual offset, accounting for variable heights and any
      // scroll anchoring the browser has already performed.
      if (anchor && anchorTop !== undefined && el.contains(anchor)) {
        el.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
      }
      if (hasNewRows) hasNew.value = true;
    }
  },
);

watch([newestFirst, mode], async () => {
  await nextTick();
  if (mode.value === "story") scrollToLatest();
});

async function onScroll(): Promise<void> {
  if (atLatest()) hasNew.value = false;
  const el = feed.value;
  if (
    !el ||
    (newestFirst.value
      ? el.scrollHeight - el.scrollTop - el.clientHeight >= 160
      : el.scrollTop >= 160) ||
    !live.submissionsHasMore ||
    live.submissionsLoadingEarlier
  ) {
    return;
  }
  await loadEarlierSubmissions();
}

function onSent(slot: DraftSlot): void {
  if (slot !== "danmaku") scrollToLatest();
}

/* The created row carries its id, so the overlay can draw it immediately and
   still recognise the copy that arrives with the scene's track. */
async function onPosted(row: Danmaku): Promise<void> {
  emit("danmaku", row);
  await refreshSceneDanmaku();
}
</script>

<template>
  <aside class="rail" :aria-label="t('rail.label')">
    <div class="tabs" role="tablist" :aria-label="t('rail.label')">
      <button
        class="tab"
        role="tab"
        type="button"
        :aria-selected="mode === 'story'"
        @click="mode = 'story'"
      >
        {{ t("rail.tab_story") }}
      </button>
      <button
        class="tab"
        role="tab"
        type="button"
        :aria-selected="mode === 'dm'"
        @click="mode = 'dm'"
      >
        {{ t("rail.tab_dm") }}
      </button>
    </div>

    <StoryComposer :mode="mode" :anchor="anchor" @sent="onSent" @posted="onPosted" />

    <template v-if="mode === 'story'">
      <!-- Spec §6.6: a permanent episode banner that opens the pitch list. -->
      <button
        v-if="episodeIndex !== null"
        class="ep-banner"
        type="button"
        :aria-expanded="bannerOpen"
        @click="bannerOpen = !bannerOpen"
      >
        <span class="idx">EP {{ pad(episodeIndex, 2) }}</span>
        <span class="ttl">{{
          episodeTitle ? t("rail.episode_theme", { theme: episodeTitle }) : t("rail.episode_untitled")
        }}</span>
        <span class="n">{{ t("rail.proposals_count", { n: proposals.length }) }}</span>
        <span class="arr">▼</span>
      </button>

      <div v-if="bannerOpen" class="proposals">
        <section class="episode-outline" data-test="episode-outline">
          <div class="outline-title">
            {{ t("rail.current_outline", { n: pad(episodeIndex ?? 0, 2) }) }}
          </div>
          <ol v-if="live.episode?.storyOutline.length" class="outline-scenes">
            <li v-for="scene in live.episode.storyOutline" :key="scene.sceneIndex">
              <span>{{ t("rail.outline_scene", { n: pad(scene.sceneIndex, 2) }) }}</span>
              {{ scene.summaryZh }}
            </li>
          </ol>
          <p v-else class="outline-pending">{{ t("rail.current_outline_pending") }}</p>
        </section>
        <div class="cap">
          {{
            t("rail.proposals_cap", {
              n: pad((episodeIndex ?? 0) + 1, 2),
              threshold: CROWD_THRESHOLD,
            })
          }}
        </div>
        <!-- An empty pool and an endpoint that is not built yet look identical
             from here, and telling someone the feature is missing when it is
             live and simply has nothing in it is worse than saying nothing. -->
        <p v-if="proposals.length === 0" class="empty">
          <template v-if="live.missing.proposals">
            <b>{{ t("state.soon_title") }}</b>
            {{ t("state.soon_body") }}
          </template>
          <template v-else>
            <b>{{ t("rail.no_proposals_title") }}</b>
            {{ t("rail.no_proposals_body") }}
          </template>
        </p>
        <ChatLine
          v-for="p in proposals"
          :key="p.id"
          :id="p.id"
          :username="p.username"
          :content="p.content"
          :created-at="p.createdAt"
          :up-count="p.upCount"
          :down-count="p.downCount"
          :my-vote="myVotes[p.id] ?? null"
          :can-vote="canWrite"
          :gap-to-canon="gapToCanon(p.upCount, p.downCount)"
          episode-pitch
          :show-time="false"
          @vote="(v) => onVote(p.id, v)"
        />
      </div>

      <div class="feedwrap">
        <div
          ref="feed"
          class="timeline"
          role="feed"
          :aria-label="t('rail.timeline_label')"
          @scroll="onScroll"
        >
          <p v-if="!live.loaded" class="empty">{{ t("state.loading") }}</p>

          <p v-if="live.submissionsLoadingEarlier && !newestFirst" class="history-loading">
            {{ t("timeline.loading_earlier") }}
          </p>

          <p v-else-if="live.noRound && visibleCount === 0" class="empty">
            <b>{{ t("timeline.no_round_title") }}</b>
            {{ t("timeline.no_round_body") }}
          </p>

          <p v-else-if="live.error" class="empty bad">
            <b>{{ t("timeline.offline_title") }}</b>
            {{ t("timeline.offline_body") }}
          </p>

          <p v-else-if="isEmpty" class="empty">
            <b>{{ t("timeline.empty_title") }}</b>
            {{ t("timeline.empty_body") }}
          </p>

          <template v-for="group in groups" :key="group.key">
            <div v-if="group.rows.length > 0" class="rmark">
              {{ group.roundIndex === null ? group.label : t("timeline.round", { index: pad(group.roundIndex), status: group.label }) }}
            </div>
            <ChatLine
              v-for="s in group.rows"
              :key="s.id"
              :id="s.id"
              :data-submission-id="s.id"
              :username="s.username"
              :content="s.content"
              :created-at="s.createdAt"
              :status="s.status"
              :adopted="s.selection === 'human' || s.selection === 'ai' || live.round?.selectedSubmissionId === s.id"
              :up-count="s.upCount"
              :down-count="s.downCount"
              :score="s.score?.total ?? null"
              :roast="s.score?.roast ?? null"
              :my-vote="myVotes[s.id] ?? null"
              :votes-frozen="s.votesFrozen"
              :can-vote="canWrite"
              :crowd-selected="crowdSelected(s.id)"
              @vote="(v) => onVote(s.id, v)"
            />
          </template>

          <p v-if="live.submissionsLoadingEarlier && newestFirst" class="history-loading">
            {{ t("timeline.loading_earlier") }}
          </p>
        </div>

        <button v-if="hasNew" class="newpill" type="button" @click="scrollToLatest()">
          {{ t("timeline.new_items") }}
        </button>
      </div>
    </template>

    <template v-else>
      <div class="feedwrap">
        <div class="dm-list" :aria-label="t('rail.dm_label')">
          <p v-if="live.danmaku.length === 0" class="empty">
            <b>{{ t("timeline.empty_dm_title") }}</b>
            {{ t("timeline.empty_dm_body") }}
          </p>
          <div v-for="d in live.danmaku" :key="d.id" class="dm-row">
            <span class="time">{{ d.createdAt.slice(11, 16) }}</span>
            <span class="user">{{ d.username }}</span>{{ d.content }}
          </div>
        </div>
      </div>
    </template>

    <p v-if="voteError" class="empty bad" role="alert">{{ voteError }}</p>
  </aside>
</template>
