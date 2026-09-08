<script setup lang="ts">
import { t } from "../i18n";
import type { MessageKey } from "../i18n";

/* Spec §2.5: six steps plus the rules table. Static content. */
const steps = [1, 2, 3, 4, 5, 6] as const;
const rules = [1, 2, 3, 4, 5, 6, 7, 8] as const;

const step = (n: number, part: "n" | "h" | "p") => t(`how.s${n}_${part}` as MessageKey);
const rule = (n: number, part: "k" | "d") => t(`how.r${n}_${part}` as MessageKey);
</script>

<template>
  <div class="page">
    <div class="inner">
      <h2 class="ptitle">
        {{ t("how.title") }} <small>{{ t("how.sub") }}</small>
      </h2>
      <p class="plead">{{ t("how.lead") }}</p>

      <div class="steps">
        <div v-for="n in steps" :key="n" class="step">
          <div class="n">{{ step(n, "n") }}</div>
          <h4>{{ step(n, "h") }}</h4>
          <p>{{ step(n, "p") }}</p>
        </div>
      </div>

      <h3 class="subsec">{{ t("how.rules") }}</h3>
      <div class="rules">
        <div v-for="n in rules" :key="n" class="row">
          <span class="k">{{ rule(n, "k") }}</span>
          <span class="d">{{ rule(n, "d") }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
