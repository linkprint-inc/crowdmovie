<script setup lang="ts">
import { computed, ref } from "vue";
import { locale, t } from "../i18n";
import type { RoastText, SubmissionStatus } from "../lib/api";
import { clockTime } from "../lib/format";

/*
 * One timeline row — spec §6.3, §6.4, §8.5.
 *
 * Deliberately flat: no card border, no shadow, hover only tints the row. The
 * AI's score and roast are collapsed behind the red chip and expanding one
 * never moves the row in the timeline.
 *
 * Status is always carried by a text badge as well as by colour (§10):
 * adopted shows a badge, rejected fades but stays readable and expandable,
 * pending says "AI scoring…" rather than inventing a score.
 */

const props = withDefaults(
  defineProps<{
    id: string;
    username: string;
    content: string;
    createdAt?: string;
    status?: SubmissionStatus;
    /** Selection can succeed even when the subsequent video generation fails. */
    adopted?: boolean;
    upCount: number;
    downCount: number;
    score?: number | null;
    roast?: RoastText | null;
    myVote?: 1 | -1 | null;
    votesFrozen?: boolean;
    canVote?: boolean;
    /** Purple "next episode" type badge on proposal rows. */
    episodePitch?: boolean;
    /** Shown on a proposal that is close to the crowd threshold. */
    gapToCanon?: number | null;
    crowdSelected?: boolean;
    showTime?: boolean;
  }>(),
  {
    createdAt: "",
    status: "pending",
    adopted: false,
    score: null,
    roast: null,
    myVote: null,
    votesFrozen: false,
    canVote: true,
    episodePitch: false,
    gapToCanon: null,
    crowdSelected: false,
    showTime: true,
  },
);

const emit = defineEmits<{ (e: "vote", value: 1 | -1): void }>();

const open = ref(false);

const net = computed(() => props.upCount - props.downCount);
const scored = computed(() => props.score !== null && props.score !== undefined);
const roastText = computed(() => props.roast?.[locale.value] ?? props.roast?.en ?? "");
const disabled = computed(() => props.votesFrozen || !props.canVote);
</script>

<template>
  <div
    class="chatline"
    :class="{
      open,
      canon: adopted,
      rejected: status === 'rejected' && !adopted,
    }"
  >
    <span v-if="showTime && createdAt" class="time">{{ clockTime(createdAt) }}</span>
    <span v-if="episodePitch" class="badge-kind">{{ t("timeline.kind_episode") }}</span>
    <span class="user">{{ username }}</span
    >{{ content }}

    <span v-if="adopted" class="badge-canon">{{ t("timeline.canon") }}</span>
    <span v-if="crowdSelected" class="badge-crowd">{{ t("timeline.crowd", { n: net }) }}</span>

    <button
      class="vote"
      :class="{ on: myVote === 1 }"
      type="button"
      :disabled="disabled"
      :title="t('timeline.vote_up')"
      :aria-label="`${t('timeline.vote_up')} — ${t('timeline.gap', { n: net })}`"
      :aria-pressed="myVote === 1"
      @click="emit('vote', 1)"
    >
      ▲ {{ net }}
    </button>
    <button
      class="vote down"
      :class="{ on: myVote === -1 }"
      type="button"
      :disabled="disabled"
      :title="t('timeline.vote_down')"
      :aria-label="t('timeline.vote_down')"
      :aria-pressed="myVote === -1"
      @click="emit('vote', -1)"
    >
      ▼
    </button>

    <button
      v-if="scored"
      class="ai-chip"
      type="button"
      data-test="ai-chip"
      :aria-expanded="open"
      :aria-label="open ? t('timeline.roast_hide') : t('timeline.roast_show')"
      @click="open = !open"
    >
      AI {{ score }}
    </button>
    <!-- Next-episode pitches are decided by votes against the crowd
         threshold, not by an AI score, so they never claim to be awaiting
         one (spec §6.6). -->
    <span v-else-if="!episodePitch" class="scoring">{{ t("timeline.scoring") }}</span>

    <span v-if="gapToCanon !== null && gapToCanon > 0" class="scoring">{{
      t("timeline.gap_to_canon", { n: gapToCanon })
    }}</span>

    <p v-if="open && roastText" class="roast" data-test="roast">{{ roastText }}</p>
  </div>
</template>
