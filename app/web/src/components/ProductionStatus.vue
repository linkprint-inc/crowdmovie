<script setup lang="ts">
import { computed } from "vue";
import { t } from "../i18n";
import { activeProductionRound, live } from "../stores/live";
import { isViewingLiveProgram } from "../stores/movies";

defineProps<{ compact?: boolean }>();

const stage = computed(() => {
  if (!isViewingLiveProgram.value) return "replay";
  if (activeProductionRound.value) return activeProductionRound.value.status!;
  const round = live.round;
  if (!round) return "loading";
  return round.status === "open" && round.closesAt === null ? "waiting" : round.status;
});
const label = computed(() => {
  const keys: Record<string, Parameters<typeof t>[0]> = {
    replay: "head.movie_replay", loading: "state.loading",
    waiting: "production.waiting", open: "timeline.round_open",
    selecting: "timeline.round_judging", selected: "timeline.round_queued",
    generating: "timeline.round_generating", validating: "timeline.round_validating",
    published: "timeline.round_published", select_failed: "timeline.round_select_failed",
    generation_failed: "timeline.round_generation_failed", validation_failed: "timeline.round_validation_failed",
  };
  return t(keys[stage.value] ?? "state.loading");
});
</script>

<template>
  <div class="production-status" :class="[`production-${stage}`, { 'production-compact': compact }]" data-test="production-status" role="status" aria-live="polite" aria-atomic="true">
    <span class="production-icon" :data-stage="stage" aria-hidden="true"><i></i><i></i><i></i></span>
    <span class="production-copy"><b>{{ label }}</b></span>
  </div>
</template>

<style scoped>
.production-status { display: flex; align-items: center; gap: 12px; min-height: 44px; margin-bottom: 14px; padding: 10px 16px; border-radius: 10px; background: #191f31; color: #fff; }
.production-icon { display: flex; gap: 4px; color: #69e2c8; }
.production-icon i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.production-icon i:nth-child(1) { opacity: .4; }
.production-icon i:nth-child(2) { opacity: .7; }
.production-copy { font-size: 14px; line-height: 1.5; }
.production-select_failed, .production-generation_failed, .production-validation_failed { background: #652b30; }
:global([data-design="classic"]) .production-status { background: #211b15; border: 2px solid #211b15; box-shadow: 4px 4px 0 #69e2c8; }
.production-status.production-compact { display: inline-flex; flex: 0 0 auto; min-height: 30px; margin: 0; padding: 5px 10px; gap: 8px; border-radius: 7px; }
.production-compact .production-copy { font-size: 12px; }
</style>
