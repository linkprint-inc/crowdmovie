<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "../i18n";
import { api, type StorySummary } from "../lib/api";
import { useResource } from "../lib/useResource";
import PageState from "../components/PageState.vue";
import StoryImageLightbox, {
  type LightboxImage,
} from "../components/StoryImageLightbox.vue";

/* 规范 §6: a forum board. One row per bible with all of its character and
   place pictures, so a reader can tell them apart at a glance
   without opening any of them. */

const sort = ref<"hot" | "new">("hot");
const lightboxImages = ref<LightboxImage[]>([]);
const lightboxIndex = ref<number | null>(null);

const { data, loading, missing, error, reload } = useResource(() =>
  api.stories({ sort: sort.value }),
);

const rows = computed(() => data.value?.stories ?? []);

async function setSort(next: "hot" | "new"): Promise<void> {
  if (sort.value === next) return;
  sort.value = next;
  await reload();
}

function openLightbox(row: StorySummary, index: number): void {
  lightboxImages.value = row.previewImages.map((image) => ({
    url: image.url,
    caption: row.title,
    kind: image.kind,
  }));
  lightboxIndex.value = index;
}
</script>

<template>
  <div class="page">
    <div class="inner">
      <h2 class="ptitle">
        {{ t("stories.title") }} <small>{{ t("stories.sub") }}</small>
      </h2>
      <p class="plead">{{ t("stories.lead") }}</p>

      <div class="sb-bar">
        <button
          type="button"
          class="sb-sort-hot"
          :class="{ on: sort === 'hot' }"
          @click="setSort('hot')"
        >
          {{ t("stories.sort_hot") }}
        </button>
        <button
          type="button"
          class="sb-sort-new"
          :class="{ on: sort === 'new' }"
          @click="setSort('new')"
        >
          {{ t("stories.sort_new") }}
        </button>
        <span class="sb-spacer"></span>
        <RouterLink class="sb-compose" :to="{ name: 'story-compose' }">{{
          t("stories.compose")
        }}</RouterLink>
      </div>

      <PageState
        :loading="loading"
        :missing="missing"
        :error="error"
        :empty-title="rows.length === 0 ? t('stories.empty_title') : undefined"
        :empty-body="t('stories.empty_body')"
        @retry="reload()"
      />

      <div v-if="rows.length > 0" class="sb-board">
        <div
          v-for="row in rows"
          :key="row.id"
          class="sb-row"
        >
          <RouterLink
            class="sb-row-hit"
            :to="{ name: 'story', params: { id: row.id } }"
            :aria-label="row.title"
          />
          <span class="sb-meta">
            <b class="sb-title">{{ row.title }}</b>
            <span class="sb-by">{{ t("stories.by", { name: row.authorUsername }) }}</span>
            <span class="sb-counts">
              {{ t("stories.likes", { n: row.likeCount }) }} ·
              {{ t("stories.replies", { n: row.commentCount }) }}
            </span>
          </span>
          <span class="sb-thumbs">
            <button
              v-for="(image, index) in row.previewImages"
              :key="image.url"
              type="button"
              class="sb-thumb-open"
              :aria-label="t('story.image_open', { n: index + 1 })"
              aria-haspopup="dialog"
              @click="openLightbox(row, index)"
            >
              <img :src="image.url" :alt="row.title" loading="lazy" />
            </button>
          </span>
        </div>
      </div>
    </div>

    <StoryImageLightbox
      v-if="lightboxIndex !== null"
      :images="lightboxImages"
      :start-index="lightboxIndex"
      @close="lightboxIndex = null"
    />
  </div>
</template>
