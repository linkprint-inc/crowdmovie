<script setup lang="ts">
import { computed } from "vue";
import { locale, t } from "../i18n";
import type { MovieCharacter } from "../lib/api";
import { CHARACTERS } from "../data/characters";
import { viewingMovieSlug } from "../stores/movies";

const props = withDefaults(
  defineProps<{ character: MovieCharacter; movieSlug?: string; slim?: boolean }>(),
  { movieSlug: undefined, slim: false },
);

// These approved six-character settings belong only to Inland Empire High.
// Match stable keys, never array positions: another film/order must not borrow them.
const official = computed(() =>
  (props.movieSlug ?? viewingMovieSlug.value) === "inland-empire-high"
    ? CHARACTERS.find((character) => character.key === props.character.key)
    : undefined,
);
const copy = computed(() => {
  const publicCopy = props.character.copyI18n[locale.value] ??
    props.character.copyI18n["zh-CN"] ?? props.character.copyI18n.en ?? {};
  return {
    ...official.value?.copy[locale.value],
    ...Object.fromEntries(Object.entries(publicCopy).filter(([, value]) => typeof value === "string" && value.trim())),
  } as { name?: string; role?: string; grade?: string; archetype?: string; bio?: string; personality?: string; props?: string; fn?: string; voice?: string };
});
const fallbackImage = computed(() => official.value?.image ?? null);
const details = computed(() => [
  { key: "personality", label: t("chars.personality"), value: copy.value.personality },
  { key: "appearance", label: t("chars.appearance"), value: copy.value.props },
  { key: "function", label: t("chars.function"), value: copy.value.fn },
  { key: "voice", label: t("chars.voice"), value: copy.value.voice },
].filter((item) => item.value));
</script>

<template>
  <article class="char movie-character">
    <img
      v-if="fallbackImage"
      :src="fallbackImage"
      :alt="copy.name ?? character.key"
      width="800"
      height="1200"
      loading="lazy"
    />
    <div v-else class="character-placeholder" :data-position="character.position" aria-hidden="true">
      <b>{{ (copy.name ?? character.key).slice(0, 1) }}</b>
      <span>ORIGINAL 3D CHARACTER</span>
    </div>
    <div class="body">
      <h3>
        {{ copy.name ?? character.key }}
        <small v-if="copy.grade">{{ copy.grade }}</small>
      </h3>
      <span v-if="copy.archetype || copy.role" class="chip">{{ copy.archetype ?? copy.role }}</span>
      <template v-if="!slim">
        <p v-if="copy.bio">{{ copy.bio }}</p>
        <dl v-if="details.length" class="character-settings">
          <div v-for="detail in details" :key="detail.key" :data-setting="detail.key">
            <dt>{{ detail.label }}</dt>
            <dd>{{ detail.value }}</dd>
          </div>
        </dl>
        <p v-else-if="!copy.bio">{{ t("chars.settings_pending") }}</p>
      </template>
    </div>
  </article>
</template>

<style scoped>
.character-settings { margin: 14px 0 0; display: grid; gap: 12px; }
.character-settings > div { min-width: 0; }
.character-settings dt { font-size: 11px; font-weight: 700; color: var(--ink-soft); margin-bottom: 3px; }
.character-settings dd { margin: 0; font-size: 13px; line-height: 1.75; overflow-wrap: anywhere; white-space: pre-line; }
</style>
