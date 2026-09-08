<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { t } from "../i18n";
import { api, type GenerationPrompt } from "../lib/api";
import { live, nextPublicRound } from "../stores/live";
import { publicRoundNumber } from "../lib/round-number";
import { pad } from "../lib/format";
import { viewingMovieSlug } from "../stores/movies";

const generation = ref<GenerationPrompt | null>(null);
const loading = ref(true);
const failed = ref(false);
let version = 0;
let pending = false;
let polling: ReturnType<typeof setInterval> | undefined;

const roundNumber = computed(() => {
  if (!generation.value) return null;
  const archive = live.archive.find(r => r.roundIndex === generation.value!.roundIndex);
  return publicRoundNumber({ ...generation.value, sceneIndex: archive?.sceneIndex }, nextPublicRound.value);
});

const status = computed(() => {
  switch (generation.value?.status) {
    case "generating": return t("timeline.round_generating");
    case "generation_failed": return t("timeline.round_generation_failed");
    case "validation_failed": return t("timeline.round_validation_failed");
    case "published": return t("timeline.round_published");
    case "validating": return t("timeline.round_validating");
    default: return "";
  }
});

async function refresh(): Promise<void> {
  const requestVersion = ++version;
  pending = true;
  const slug = viewingMovieSlug.value;
  try {
    const result = await api.generationPrompt(slug);
    if (requestVersion !== version) return;
    generation.value = result.generation;
    failed.value = false;
  } catch {
    if (requestVersion !== version) return;
    // Never continue labelling a stale response as currently generating.
    generation.value = null;
    failed.value = true;
  } finally {
    if (requestVersion === version) { loading.value = false; pending = false; }
  }
}

watch(viewingMovieSlug, () => {
  generation.value = null;
  loading.value = true;
  failed.value = false;
  void refresh();
}, { immediate: true });
onMounted(() => {
  polling = setInterval(() => {
    if (!pending && document.visibilityState !== "hidden") void refresh();
  }, 5000);
});
onUnmounted(() => { ++version; clearInterval(polling); });
</script>

<template>
  <section class="generation-prompt" aria-labelledby="generation-prompt-heading">
    <h2 id="generation-prompt-heading" class="sec-label">{{ t("generation.title") }}</h2>
    <div class="generation-prompt-card">
      <template v-if="generation">
        <div class="generation-prompt-meta">
          <strong>{{ t(generation.mode === 'current' ? 'generation.current' : 'generation.latest') }}</strong>
          <span><template v-if="roundNumber !== null">ROUND {{ pad(roundNumber) }} · </template>{{ status }}<template v-if="generation.durationSeconds"> · {{ generation.durationSeconds }}s</template></span>
        </div>
        <p class="generation-prompt-text" data-test="h3-prompt">{{ generation.prompt }}</p>
      </template>
      <p v-else role="status">{{ t(loading ? 'state.loading' : failed ? 'generation.unavailable' : 'generation.empty') }}</p>
    </div>
  </section>
</template>

<style scoped>
.generation-prompt { margin-top: 22px; }
.generation-prompt-card { padding: 16px 18px; border: 2px solid var(--ink); border-radius: 8px; background: var(--card); }
.generation-prompt-meta { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; padding-bottom: 12px; margin-bottom: 14px; border-bottom: 1px solid var(--ink-soft); font-size: 11px; }
.generation-prompt-meta strong { color: var(--blue); }
.generation-prompt-meta span { color: var(--ink-soft); font-family: var(--mono); }
.generation-prompt-card p { margin: 0; font-size: 13px; line-height: 1.85; overflow-wrap: anywhere; }
.generation-prompt-text { white-space: pre-wrap; }
:global([data-design="studio"] .generation-prompt-card) { border: 1px solid var(--studio-line); }
:global([data-design="studio"] .generation-prompt-meta) { border-color: var(--studio-line); }
</style>
