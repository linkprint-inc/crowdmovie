<script setup lang="ts">
import { t } from "../i18n";

/* Shared loading / not-built-yet / failed / empty block. Every state is a
   sentence, not a spinner colour (spec §10). */
defineProps<{
  loading: boolean;
  missing: boolean;
  error: string;
  emptyTitle?: string;
  emptyBody?: string;
}>();

defineEmits<{ (e: "retry"): void }>();
</script>

<template>
  <p v-if="loading" class="empty">{{ t("state.loading") }}</p>
  <p v-else-if="missing" class="empty">
    <b>{{ t("state.soon_title") }}</b>
    {{ t("state.soon_body") }}
  </p>
  <p v-else-if="error" class="empty bad">
    <b>{{ error }}</b>
    <button class="ep-open" type="button" @click="$emit('retry')">{{ t("state.retry") }}</button>
  </p>
  <p v-else-if="emptyTitle" class="empty">
    <b>{{ emptyTitle }}</b>
    {{ emptyBody }}
  </p>
</template>
