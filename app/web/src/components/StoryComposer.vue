<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { t, translateError } from "../i18n";
import { ApiError, api, type Danmaku, type DanmakuAnchor } from "../lib/api";
import {
  DANMAKU_MAX_GRAPHEMES,
  KIND_MAX_GRAPHEMES,
  glen,
  type SubmissionKind,
} from "../lib/grapheme";
import { mixedCount } from "../lib/mixed-count";
import { mmss } from "../lib/format";
import { clearPublishedDraft, drafts, type DraftSlot } from "../stores/drafts";
import { canWrite } from "../stores/identity";
import { isViewingLiveProgram, viewingMovieSlug } from "../stores/movies";
import { live, msToDeadline, submit } from "../stores/live";
import { openAuth } from "../stores/ui";
import { siteDesign } from "../stores/prefs";

/*
 * Spec §6.5 / §8.4. The whole block of copy switches with the submission kind
 * — the two kinds share no wording — and each kind keeps its own unsent draft.
 * The counter is grapheme-accurate and mirrors the server's limits exactly, so
 * the number the writer sees is the number the server enforces.
 */

const props = defineProps<{
  mode: "story" | "dm";
  /**
   * §14.1's anchor for a live comment: the scene the viewer is watching and
   * the playback position inside it, read off the player. Null means nothing
   * is playing — there is no honest anchor, so the box goes read-only instead
   * of pinning the comment to a scene the writer never saw.
   */
  anchor?: DanmakuAnchor | null;
}>();
const emit = defineEmits<{
  (e: "sent", slot: DraftSlot, content: string): void;
  (e: "posted", row: Danmaku): void;
}>();

const kind = ref<SubmissionKind>("next_shot");
const sending = ref(false);
const justSent = ref(false);
const error = ref("");

const slot = computed<DraftSlot>(() => (props.mode === "dm" ? "danmaku" : kind.value));
const isEpisode = computed(() => props.mode === "story" && kind.value === "next_episode");

const max = computed(() =>
  props.mode === "dm" ? DANMAKU_MAX_GRAPHEMES : kind.value === "next_shot" ? 200 : KIND_MAX_GRAPHEMES[kind.value],
);
const count = computed(() => props.mode === "story" && kind.value === "next_shot" ? mixedCount(drafts[slot.value]) : glen(drafts[slot.value]));
const over = computed(() => count.value > max.value);

const label = computed(() => {
  if (props.mode === "dm") return t("composer.label_dm");
  return isEpisode.value ? t("composer.label_episode") : t("composer.label_shot");
});
const placeholder = computed(() => {
  if (props.mode === "dm") return t("composer.ph_dm");
  return isEpisode.value ? t("composer.ph_episode") : t("composer.ph_shot");
});

/* ---------------------------------------------- "one per round" bookkeeping */

/* The server is the authority (it answers duplicate_submission). We remember
   a successful post across reloads so the button stays disabled, while leaving
   the textarea editable for drafting the next round. */
const DONE_KEY = "cm.submitted";

function loadDone(): Record<string, true> {
  try {
    return JSON.parse(localStorage.getItem(DONE_KEY) ?? "{}") as Record<string, true>;
  } catch {
    return {};
  }
}
const done = ref<Record<string, true>>(loadDone());

function markDone(token: string): void {
  done.value = { ...done.value, [token]: true };
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify(done.value));
  } catch {
    /* ignore */
  }
}

/** next_shot is one per round; next_episode is one per episode. */
const doneToken = computed(() => {
  if (props.mode === "dm") return null;
  if (kind.value === "next_episode") {
    return live.round
      ? `movie:${viewingMovieSlug.value}:ep:${live.round.episodeIndex}`
      : null;
  }
  return live.round
    ? `movie:${viewingMovieSlug.value}:round:${live.round.roundId}`
    : null;
});

const alreadySubmitted = computed(
  () => doneToken.value !== null && done.value[doneToken.value] === true,
);

const roundOpen = computed(() => live.round?.status === "open");
/** A live comment needs a scene to hang on; §14.1 has no unanchored form. */
const noAnchor = computed(() => props.mode === "dm" && !props.anchor);
/**
 * A closed shot round or an off-air movie prevents publishing, not writing.
 * The draft belongs to the writer and remains useful when the next valid
 * window opens. Publishing twice into one round disables only the send button.
 */
const offAir = computed(
  () => props.mode === "story" && !isViewingLiveProgram.value,
);
const inputReadOnly = computed(() => noAnchor.value);
const publishingBlocked = computed(() => noAnchor.value || offAir.value);
const submissionWindowOpen = computed(
  () => props.mode === "dm" || isEpisode.value || roundOpen.value,
);

const hint = computed(() => {
  if (error.value) return error.value;
  if (noAnchor.value) return t("composer.dm_no_scene");
  if (offAir.value) return t("composer.draft_only");
  if (!canWrite.value) return t("composer.need_name");
  if (props.mode === "dm") return t("composer.hint_dm");
  if (alreadySubmitted.value) {
    if (isEpisode.value) return t("composer.done_episode");
    const ms = msToDeadline.value;
    return t("composer.done_shot", { time: ms === null ? "--:--" : mmss(ms / 1000) });
  }
  if (!roundOpen.value && !isEpisode.value) return t("composer.closed");
  if (over.value) return t("composer.over", { n: count.value - max.value });
  return isEpisode.value ? t("composer.hint_episode") : t("composer.hint_shot");
});

const hintIsBad = computed(() => Boolean(error.value) || over.value);

const canSend = computed(
  () =>
    canWrite.value &&
    !sending.value &&
    !publishingBlocked.value &&
    submissionWindowOpen.value &&
    !alreadySubmitted.value &&
    count.value > 0 &&
    !over.value,
);

/* Clearing the error the moment the writer edits keeps a stale rejection from
   sitting under a line that has since been fixed. */
watch(
  () => drafts[slot.value],
  () => {
    error.value = "";
  },
);

function setKind(next: SubmissionKind): void {
  // Drafts are stored per slot, so switching cannot overwrite the other one.
  kind.value = next;
  error.value = "";
}

/**
 * A danmaku scrolls across the screen as one line, so a newline in it is never
 * something the writer meant. Enter therefore sends, the way it does on every
 * other bullet-comment site — and because the server rejects control characters,
 * letting Enter insert one would have produced "danmaku cannot contain control
 * characters" for someone who simply pressed Enter to send. Pitches are prose
 * and keep their newlines; there Enter does nothing special.
 */
function onKeydown(event: KeyboardEvent): void {
  if (props.mode !== "dm") return;
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  void send();
}

/** Pasted multi-line text collapses to spaces rather than being rejected. */
function onPaste(event: ClipboardEvent): void {
  if (props.mode !== "dm") return;
  const text = event.clipboardData?.getData("text");
  if (!text || !/[\r\n\t]/.test(text)) return;
  event.preventDefault();
  const el = event.target as HTMLTextAreaElement;
  const flat = text.replace(/\s*[\r\n]+\s*/g, " ").replace(/\t/g, " ");
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  const current = drafts[slot.value];
  drafts[slot.value] = current.slice(0, start) + flat + current.slice(end);
}

async function send(): Promise<void> {
  if (publishingBlocked.value) return;
  if (!canWrite.value) {
    openAuth();
    return;
  }
  if (!canSend.value) return;

  // Safety net for whatever slipped past the key and paste handlers -- an IME
  // commit, a drag-and-drop, an autofill. The server rejects control characters
  // outright, and "your comment contains a control character" is a useless thing
  // to tell someone who just wants to shout at the screen.
  const content =
    props.mode === "dm"
      ? drafts[slot.value].replace(/\s*[\r\n\t]+\s*/g, " ").trim()
      : drafts[slot.value];
  sending.value = true;
  error.value = "";
  try {
    if (props.mode === "dm") {
      // Read once, at the moment of sending: the anchor is where playback
      // actually is, not where it was when the box was focused.
      const anchor = props.anchor;
      if (!anchor) return;
      emit("posted", await api.sendDanmaku(content, anchor, viewingMovieSlug.value));
    } else {
      await submit(kind.value, content);
      if (doneToken.value) markDone(doneToken.value);
    }
    emit("sent", slot.value, content);
    await clearPublishedDraft(slot.value);
    justSent.value = true;
    window.setTimeout(() => {
      justSent.value = false;
    }, 1200);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    error.value = translateError(err.code, err.message);
    if (err.code === "duplicate_submission" && doneToken.value) {
      // The authoritative write already exists (often because the original
      // response was lost). Treat that as published locally too: keeping an
      // already-published stale draft in the box gives the writer no useful
      // recovery path.
      markDone(doneToken.value);
      await clearPublishedDraft(slot.value);
    }
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <div class="composer" :class="{ ep: isEpisode }">
    <p v-if="siteDesign === 'studio' && mode === 'story'" class="studio-invite">{{ t("design.invite") }}</p>
    <div class="crow">
      <span class="clabel">{{ label }}</span>
      <div
        v-if="mode === 'story'"
        class="kinds"
        role="radiogroup"
        :aria-label="t('composer.kind_label')"
      >
        <button
          class="kind-btn"
          :class="{ on: kind === 'next_shot' }"
          type="button"
          role="radio"
          :aria-checked="kind === 'next_shot'"
          @click="setKind('next_shot')"
        >
          {{ t("composer.kind_shot") }}
        </button>
        <button
          class="kind-btn"
          :class="{ on: kind === 'next_episode' }"
          type="button"
          role="radio"
          :aria-checked="kind === 'next_episode'"
          @click="setKind('next_episode')"
        >
          {{ t("composer.kind_episode") }}
        </button>
      </div>
    </div>

    <p v-if="isEpisode" class="ep-note">{{ t("composer.ep_note") }}</p>

    <textarea
      v-model="drafts[slot]"
      :rows="props.mode === 'dm' ? 2 : 3"
      :placeholder="placeholder"
      :readonly="inputReadOnly"
      :aria-label="label"
      @keydown="onKeydown"
      @paste="onPaste"
    ></textarea>

    <div class="foot">
      <span class="count" :class="{ over }" data-test="count">
        <b>{{ count }}</b> / <span data-test="max">{{ max }}</span>
        <small v-if="mode === 'story' && kind === 'next_shot'"> {{ t("composer.word_units") }}</small>
        <span class="visually-hidden">{{
          t("composer.count_a11y", { n: count, max: max })
        }}</span>
      </span>
      <span class="hint" :class="{ bad: hintIsBad }" data-test="hint">{{ hint }}</span>
      <button
        class="send"
        type="button"
        :disabled="publishingBlocked || (!canSend && canWrite)"
        @click="send()"
      >
        {{ justSent ? t("composer.sent") : sending ? t("composer.sending") : t("composer.send") }}
      </button>
    </div>
  </div>
</template>
