<script setup lang="ts">
import { computed } from "vue";
import { locale, t } from "../i18n";
import type { Character } from "../data/characters";

/* Spec §4.2 / §8.4: a static display element. No hover transform, no scale, no
   shadow change — six cards must never jump together under the pointer. */
const props = withDefaults(defineProps<{ character: Character; slim?: boolean }>(), {
  slim: false,
});

const copy = computed(() => props.character.copy[locale.value]);
/* Spec §10: alt text carries the character's name and political archetype. */
const alt = computed(() =>
  t("chars.alt", { name: copy.value.name, archetype: copy.value.archetype }),
);
</script>

<template>
  <article class="char">
    <img :src="character.image" :alt="alt" width="800" height="1200" loading="lazy" />
    <div class="body">
      <h3>
        {{ copy.name }}
        <small>{{ character.nameEn }} · {{ copy.grade }}</small>
      </h3>
      <span class="chip">{{ copy.archetype }}</span>
      <p v-if="!slim">{{ copy.personality }}</p>
      <p class="props">{{ copy.props }}</p>
      <p v-if="!slim" class="fn"><b>{{ t("chars.function") }}</b> {{ copy.fn }}</p>
    </div>
  </article>
</template>
