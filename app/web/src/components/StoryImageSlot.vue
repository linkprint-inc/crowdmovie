<script setup lang="ts">
import { computed } from "vue";
import { t } from "../i18n";
import { CAPTION_MAX, mixedCount } from "../lib/mixed-count";
import type { StoryImageKind } from "../lib/api";

/* One upload slot: a picture and the note that belongs to it. The note is part
   of the slot rather than a separate list, because a note without its picture
   is what the reader would have to guess about. */

const props = defineProps<{
  kind: StoryImageKind;
  position: number;
  imageId: string | null;
  url: string | null;
  caption: string;
  busy: boolean;
}>();

const emit = defineEmits<{
  (e: "pick", file: File): void;
  (e: "caption", value: string): void;
  (e: "remove"): void;
}>();

const count = computed(() => mixedCount(props.caption));
const over = computed(() => count.value > CAPTION_MAX);

function onPick(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file !== undefined) emit("pick", file);
  // Cleared so choosing the same file twice still fires a change event.
  input.value = "";
}
</script>

<template>
  <div class="sc-slot" :data-slot="`${kind}-${position}`">
    <label class="sc-drop">
      <img v-if="url" :src="url" :alt="caption" class="sc-thumb" />
      <span v-else class="sc-add">{{ t("compose.slot_add") }}</span>
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        :disabled="busy"
        @change="onPick"
      />
    </label>

    <textarea
      class="sc-caption"
      :value="caption"
      :placeholder="t('compose.caption_ph')"
      :disabled="imageId === null"
      @input="emit('caption', ($event.target as HTMLTextAreaElement).value)"
    ></textarea>

    <p class="sc-caption-count" :class="{ over }">
      {{ t("compose.caption_count", { n: count, max: CAPTION_MAX }) }}
    </p>

    <button v-if="imageId" type="button" class="sc-remove" @click="emit('remove')">
      {{ t("compose.slot_remove") }}
    </button>
  </div>
</template>
