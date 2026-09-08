<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { t } from "../i18n";

export interface LightboxImage {
  url: string;
  caption: string;
  kind: "character" | "world";
}

const props = defineProps<{
  images: LightboxImage[];
  startIndex: number;
}>();

const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLElement | null>(null);
const activeIndex = ref(
  Math.min(Math.max(props.startIndex, 0), Math.max(props.images.length - 1, 0)),
);
const active = computed(() => props.images[activeIndex.value]);

let previousFocus: HTMLElement | null = null;
let previousOverflow = "";

function close(): void {
  emit("close");
}

function move(delta: number): void {
  if (props.images.length < 2) return;
  activeIndex.value =
    (activeIndex.value + delta + props.images.length) % props.images.length;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
    return;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    move(-1);
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    move(1);
    return;
  }
  if (event.key !== "Tab" || dialog.value === null) return;

  const focusable = Array.from(
    dialog.value.querySelectorAll<HTMLElement>("button:not([disabled])"),
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

onMounted(async () => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  document.addEventListener("keydown", onKeydown);
  await nextTick();
  dialog.value?.focus();
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown);
  document.body.style.overflow = previousOverflow;
  previousFocus?.focus();
});
</script>

<template>
  <Teleport to="body">
    <div class="sil-backdrop" @click.self="close()">
      <section
        ref="dialog"
        class="sil-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="t('story.lightbox_dialog')"
        tabindex="-1"
      >
        <button
          type="button"
          class="sil-close"
          :aria-label="t('story.lightbox_close')"
          @click="close()"
        >
          ×
        </button>

        <button
          v-if="images.length > 1"
          type="button"
          class="sil-arrow sil-prev"
          :aria-label="t('story.lightbox_previous')"
          @click="move(-1)"
        >
          ‹
        </button>

        <div v-if="active" class="sil-stage">
          <img :key="active.url" :src="active.url" :alt="active.caption" />
        </div>

        <button
          v-if="images.length > 1"
          type="button"
          class="sil-arrow sil-next"
          :aria-label="t('story.lightbox_next')"
          @click="move(1)"
        >
          ›
        </button>

        <footer v-if="active" class="sil-caption" aria-live="polite">
          <span class="sil-kind">
            {{ active.kind === "character" ? t("story.characters") : t("story.worlds") }}
          </span>
          <p>{{ active.caption }}</p>
          <b>{{ activeIndex + 1 }} / {{ images.length }}</b>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
