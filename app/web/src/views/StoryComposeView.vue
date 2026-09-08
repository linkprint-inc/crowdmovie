<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { t } from "../i18n";
import {
  ApiError,
  api,
  type MyStoryImage,
  type MyStoryProposal,
  type StoryImageKind,
  type UploadedStoryImage,
} from "../lib/api";
import { glen } from "../lib/grapheme";
import {
  CAPTION_MAX,
  SYNOPSIS_MAX,
  SYNOPSIS_MIN,
  STORY_TITLE_MAX_GRAPHEMES,
  mixedCount,
} from "../lib/mixed-count";
import { translateError } from "../i18n";
import { isAccount } from "../stores/identity";
import StoryImageSlot from "../components/StoryImageSlot.vue";

/*
 * 规范 §6 的编辑器.
 *
 * The rule this page is built around: the submit button always says why it is
 * disabled. A form holding twelve pictures and 2000 words that answers
 * "incomplete" only when pressed makes the author hunt for what is missing —
 * and they have to press it again to find the next thing.
 *
 * Everything autosaves. The title and synopsis are debounced the way
 * stores/drafts.ts debounces a pitch; an image is written the moment it is
 * chosen, because a picture held in the browser is a picture lost to a refresh.
 */

/** §4.2: 4 to 6 pictures per group, so the editor always shows 6 slots. */
const SLOTS = [0, 1, 2, 3, 4, 5] as const;
const IMAGES_MIN = 4;
/** 2 MiB — the same number as the server's bodyLimit and the CHECK. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** Long enough not to PUT mid-word, short enough that closing the tab keeps it. */
const AUTOSAVE_DELAY_MS = 2_000;

interface Slot {
  imageId: string | null;
  url: string | null;
  caption: string;
  busy: boolean;
}

const proposal = ref<MyStoryProposal | null>(null);
const title = ref("");
const synopsis = ref("");
const saving = ref(false);
const savedAt = ref<string | null>(null);
const error = ref("");
const loading = ref(true);

const emptySlots = (): Slot[] =>
  SLOTS.map(() => ({ imageId: null, url: null, caption: "", busy: false }));
const groups = ref<Record<StoryImageKind, Slot[]>>({
  character: emptySlots(),
  world: emptySlots(),
});

/** The proposal the editor is editing, if it is editable at all. */
const editable = computed(() => proposal.value?.status === "draft");

onMounted(async () => {
  if (!isAccount.value) {
    loading.value = false;
    return;
  }
  await load();
});

// Registering or logging in mid-visit is the moment the editor becomes usable.
watch(isAccount, (able) => {
  if (able && proposal.value === null) void load();
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const mine = await api.myStory();
    // The most recent proposal is what this page is about: the draft if there
    // is one, otherwise the last verdict, so a rejection is not hidden behind
    // a blank form.
    proposal.value = mine.draft ?? mine.proposals[0] ?? (await api.createStory());
    title.value = proposal.value.title;
    synopsis.value = proposal.value.synopsis;
    applyImages(mine.draft?.images ?? []);
  } catch (err) {
    if (err instanceof ApiError) error.value = translateError(err.code, err.message);
  } finally {
    loading.value = false;
  }
}

/**
 * Rebuild the twelve slots from the draft's stored pictures.
 *
 * They arrive with `GET /api/me/story` rather than from the public detail
 * endpoint, which only serves published proposals — an author who uploaded
 * twelve images, closed the tab and came back to empty boxes would reasonably
 * conclude the upload had never worked.
 */
function applyImages(images: MyStoryImage[]): void {
  const next: Record<StoryImageKind, Slot[]> = {
    character: emptySlots(),
    world: emptySlots(),
  };
  for (const image of images) {
    if (image.position < 0 || image.position >= SLOTS.length) continue;
    next[image.kind][image.position] = {
      imageId: image.id,
      url: image.url,
      caption: image.caption,
      busy: false,
    };
  }
  groups.value = next;
}

/* ------------------------------------------------------------- autosave */

let timer: number | undefined;

function scheduleSave(): void {
  if (!editable.value) return;
  if (timer !== undefined) window.clearTimeout(timer);
  timer = window.setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
}

async function save(): Promise<void> {
  const id = proposal.value?.id;
  if (id === undefined || !editable.value) return;
  saving.value = true;
  try {
    const saved = await api.saveStory(id, {
      title: title.value,
      synopsis: synopsis.value,
    });
    proposal.value = saved;
    savedAt.value = new Date().toISOString();
    error.value = "";
  } catch (err) {
    // A failed autosave is not worth interrupting writing for; the next
    // keystroke schedules another attempt.
    if (err instanceof ApiError) error.value = translateError(err.code, err.message);
  } finally {
    saving.value = false;
  }
}

watch([title, synopsis], scheduleSave);

/* --------------------------------------------------------------- images */

async function pick(kind: StoryImageKind, position: number, file: File): Promise<void> {
  const id = proposal.value?.id;
  if (id === undefined) return;
  // Checked here as well as on the server: a 2 MB upload that is going to be
  // refused should not be sent at all.
  if (file.size > MAX_IMAGE_BYTES) {
    error.value = t("err.image_too_large");
    return;
  }
  const slot = groups.value[kind][position];
  slot.busy = true;
  try {
    const uploaded: UploadedStoryImage = await api.uploadStoryImage(
      id,
      kind,
      position,
      file,
    );
    groups.value[kind][position] = {
      imageId: uploaded.id,
      url: uploaded.url,
      // Replacing a picture clears its note server-side; mirror that here.
      caption: uploaded.caption,
      busy: false,
    };
    error.value = "";
  } catch (err) {
    if (err instanceof ApiError) error.value = translateError(err.code, err.message);
    slot.busy = false;
  }
}

const captionTimers = new Map<string, number>();

function editCaption(kind: StoryImageKind, position: number, value: string): void {
  groups.value[kind][position].caption = value;
  const id = proposal.value?.id;
  const imageId = groups.value[kind][position].imageId;
  if (id === undefined || imageId === null) return;
  const key = `${kind}-${position}`;
  const existing = captionTimers.get(key);
  if (existing !== undefined) window.clearTimeout(existing);
  captionTimers.set(
    key,
    window.setTimeout(() => {
      void api.saveStoryCaption(id, imageId, value).catch(() => undefined);
    }, AUTOSAVE_DELAY_MS),
  );
}

async function remove(kind: StoryImageKind, position: number): Promise<void> {
  const id = proposal.value?.id;
  const imageId = groups.value[kind][position].imageId;
  if (id === undefined || imageId === null) return;
  await api.deleteStoryImage(id, imageId).catch(() => undefined);
  groups.value[kind][position] = {
    imageId: null,
    url: null,
    caption: "",
    busy: false,
  };
}

/* ------------------------------------------------------- what is missing */

const synopsisCount = computed(() => mixedCount(synopsis.value));

function filled(kind: StoryImageKind): Slot[] {
  return groups.value[kind].filter((slot) => slot.url !== null);
}

/**
 * Every unmet condition, recomputed on every keystroke.
 *
 * This is the list the button points at, so the author never has to press it
 * to find out what is left.
 */
const blocking = computed<string[]>(() => {
  const missing: string[] = [];
  if (title.value.trim() === "") missing.push(t("compose.need_title"));
  if (synopsisCount.value < SYNOPSIS_MIN) {
    missing.push(
      t("compose.need_synopsis", { n: SYNOPSIS_MIN - synopsisCount.value }),
    );
  }
  const characters = filled("character");
  const worlds = filled("world");
  if (characters.length < IMAGES_MIN) {
    missing.push(t("compose.need_characters", { n: IMAGES_MIN - characters.length }));
  }
  if (worlds.length < IMAGES_MIN) {
    missing.push(t("compose.need_worlds", { n: IMAGES_MIN - worlds.length }));
  }
  const uncaptioned = [...characters, ...worlds].filter(
    (slot) => slot.caption.trim() === "" || mixedCount(slot.caption) > CAPTION_MAX,
  ).length;
  if (uncaptioned > 0) {
    missing.push(t("compose.need_captions", { n: uncaptioned }));
  }
  return missing;
});

const canSubmit = computed(
  () =>
    editable.value &&
    blocking.value.length === 0 &&
    glen(title.value) <= STORY_TITLE_MAX_GRAPHEMES &&
    synopsisCount.value <= SYNOPSIS_MAX,
);

async function submit(): Promise<void> {
  const id = proposal.value?.id;
  if (id === undefined || !canSubmit.value) return;
  // Flush anything the debounce is still holding, so the server judges what is
  // on screen rather than what it was told two seconds ago.
  if (timer !== undefined) window.clearTimeout(timer);
  await save();
  try {
    proposal.value = await api.submitStory(id);
    error.value = "";
  } catch (err) {
    if (err instanceof ApiError) error.value = translateError(err.code, err.message);
  }
}

async function reopen(): Promise<void> {
  const id = proposal.value?.id;
  if (id === undefined) return;
  try {
    proposal.value = await api.reopenStory(id);
    // Reloaded rather than patched: reopening turns the proposal back into a
    // draft, and the slots have to come back with it.
    await load();
  } catch (err) {
    if (err instanceof ApiError) error.value = translateError(err.code, err.message);
  }
}
</script>

<template>
  <div class="page">
    <div class="inner">
      <h2 class="ptitle">{{ t("compose.title") }}</h2>

      <!-- A bible has to be yours across devices, so a guest name is not
           enough. Said before the form rather than after a rejected submit. -->
      <p v-if="!isAccount" class="empty">
        <b>{{ t("compose.account_title") }}</b>
        {{ t("compose.account_body") }}
      </p>

      <template v-else-if="!loading">
        <p class="plead">{{ t("compose.lead") }}</p>

        <p v-if="error" class="empty bad">{{ error }}</p>

        <p v-if="proposal?.status === 'pending'" class="empty">
          <b>{{ t("compose.pending_title") }}</b>
          {{ t("compose.pending_body") }}
        </p>

        <div v-else-if="proposal?.status === 'rejected'" class="empty bad">
          <b>{{ t("compose.rejected_title") }}</b>
          <span class="sc-reason">{{ proposal.rejectReason }}</span>
          <button type="button" class="sc-reopen" @click="reopen()">
            {{ t("compose.reopen") }}
          </button>
        </div>

        <div v-else-if="proposal?.status === 'review_failed'" class="empty bad">
          <b>{{ t("compose.failed_title") }}</b>
          {{ t("compose.failed_body") }}
          <button type="button" class="sc-reopen" @click="reopen()">
            {{ t("compose.reopen") }}
          </button>
        </div>

        <p v-else-if="proposal?.status === 'approved'" class="empty">
          <b>{{ t("compose.published_title") }}</b>
          {{ t("compose.published_body") }}
          <RouterLink :to="{ name: 'story', params: { id: proposal.id } }">{{
            t("compose.view")
          }}</RouterLink>
        </p>

        <form v-if="editable" class="sc-form" @submit.prevent="submit()">
          <label class="sc-label" for="sc-title">{{ t("compose.field_title") }}</label>
          <input
            id="sc-title"
            v-model="title"
            type="text"
            :placeholder="t('compose.title_ph')"
          />

          <label class="sc-label" for="sc-synopsis">{{
            t("compose.field_synopsis")
          }}</label>
          <textarea
            id="sc-synopsis"
            v-model="synopsis"
            rows="14"
            :placeholder="t('compose.synopsis_ph')"
          ></textarea>
          <p class="sc-count" :class="{ over: synopsisCount > SYNOPSIS_MAX }">
            <template v-if="synopsisCount < SYNOPSIS_MIN">{{
              t("compose.synopsis_count", {
                n: synopsisCount,
                max: SYNOPSIS_MAX,
                short: SYNOPSIS_MIN - synopsisCount,
              })
            }}</template>
            <template v-else>{{
              t("compose.synopsis_ok", { n: synopsisCount, max: SYNOPSIS_MAX })
            }}</template>
          </p>

          <h3 class="sc-group">{{ t("compose.characters") }}</h3>
          <div class="sc-slots">
            <StoryImageSlot
              v-for="position in SLOTS"
              :key="`character-${position}`"
              kind="character"
              :position="position"
              :image-id="groups.character[position].imageId"
              :url="groups.character[position].url"
              :caption="groups.character[position].caption"
              :busy="groups.character[position].busy"
              @pick="(file) => pick('character', position, file)"
              @caption="(value) => editCaption('character', position, value)"
              @remove="remove('character', position)"
            />
          </div>

          <h3 class="sc-group">{{ t("compose.worlds") }}</h3>
          <div class="sc-slots">
            <StoryImageSlot
              v-for="position in SLOTS"
              :key="`world-${position}`"
              kind="world"
              :position="position"
              :image-id="groups.world[position].imageId"
              :url="groups.world[position].url"
              :caption="groups.world[position].caption"
              :busy="groups.world[position].busy"
              @pick="(file) => pick('world', position, file)"
              @caption="(value) => editCaption('world', position, value)"
              @remove="remove('world', position)"
            />
          </div>

          <!-- Always visible, so the author never presses submit to find out
               what is left. -->
          <div v-if="blocking.length > 0" class="sc-blocking">
            <b>{{ t("compose.blocking") }}</b>
            <span v-for="item in blocking" :key="item">{{ item }}</span>
          </div>

          <div class="sc-actions">
            <span class="sc-sync">
              <template v-if="saving">{{ t("compose.saving") }}</template>
              <template v-else-if="savedAt">{{ t("compose.saved") }}</template>
            </span>
            <button type="submit" class="sc-submit" :disabled="!canSubmit">
              {{ t("compose.submit") }}
            </button>
          </div>
        </form>
      </template>
    </div>
  </div>
</template>
