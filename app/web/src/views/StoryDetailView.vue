<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { t, translateError } from "../i18n";
import { ApiError, api, type StoryComment } from "../lib/api";
import { glen } from "../lib/grapheme";
import { STORY_COMMENT_MAX_GRAPHEMES } from "../lib/mixed-count";
import { useResource } from "../lib/useResource";
import PageState from "../components/PageState.vue";
import StoryImageLightbox, {
  type LightboxImage,
} from "../components/StoryImageLightbox.vue";
import { canWrite } from "../stores/identity";
import { openAuth } from "../stores/ui";

/* 规范 §6: the whole bible, with every note attached to its own picture. A
   note that drifts away from the picture it describes is the one failure that
   makes this page useless, so the two are one figure element. */

const props = defineProps<{ id: string }>();

const { data, loading, missing, error, reload } = useResource(() => api.story(props.id));

const replies = ref<StoryComment[]>([]);
const draft = ref("");
const sending = ref(false);
const replyError = ref("");
const lightboxImages = ref<LightboxImage[]>([]);
const lightboxIndex = ref<number | null>(null);

// Replies load alongside the post rather than through a second `useResource`:
// they have their own list state (a new reply is appended, not refetched), so
// the loading/missing/error states that helper provides would go unused.
onMounted(async () => {
  try {
    replies.value = (await api.storyComments(props.id)).comments;
  } catch {
    // The post's own loader already reports a story that is not there; a second
    // message about its replies would say the same thing twice.
  }
});

const figures = computed(() => {
  const detail = data.value;
  if (detail === null) return [];
  return [
    ...detail.characters.map((image) => ({ ...image, group: "character" as const })),
    ...detail.worlds.map((image) => ({ ...image, group: "world" as const })),
  ];
});

const replyCount = computed(() => glen(draft.value));
const replyTooLong = computed(() => replyCount.value > STORY_COMMENT_MAX_GRAPHEMES);

function openLightbox(index: number): void {
  lightboxImages.value = figures.value.map((image) => ({
    url: image.url,
    caption: image.caption,
    kind: image.group,
  }));
  lightboxIndex.value = index;
}

async function toggleLike(): Promise<void> {
  const detail = data.value;
  if (detail === null) return;
  if (!canWrite.value) {
    openAuth();
    return;
  }
  try {
    const result = await api.likeStory(props.id, detail.likedByMe ? 0 : 1);
    detail.likeCount = result.likeCount;
    detail.likedByMe = result.likedByMe;
  } catch (err) {
    if (err instanceof ApiError) replyError.value = translateError(err.code, err.message);
  }
}

async function send(): Promise<void> {
  if (draft.value.trim() === "" || replyTooLong.value) return;
  if (!canWrite.value) {
    openAuth();
    return;
  }
  sending.value = true;
  try {
    const created = await api.commentOnStory(props.id, draft.value);
    // Appended rather than refetched: the reader's own reply appearing
    // instantly is what makes the box feel like it worked.
    replies.value = [...replies.value, created];
    if (data.value !== null) data.value.commentCount += 1;
    draft.value = "";
    replyError.value = "";
  } catch (err) {
    if (err instanceof ApiError) replyError.value = translateError(err.code, err.message);
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <div class="page">
    <div class="inner">
      <RouterLink class="sd-back" :to="{ name: 'stories' }">{{
        t("story.back")
      }}</RouterLink>

      <PageState
        :loading="loading"
        :missing="missing"
        :error="error"
        @retry="reload()"
      />

      <article v-if="data" class="sd-post">
        <h2 class="ptitle">{{ data.title }}</h2>
        <p class="sd-by">{{ t("stories.by", { name: data.authorUsername }) }}</p>

        <p class="sd-synopsis">{{ data.synopsis }}</p>

        <h3 class="sd-group">{{ t("story.characters") }}</h3>
        <div class="sd-gallery">
          <figure
            v-for="image in figures.filter((f) => f.group === 'character')"
            :key="`c-${image.position}`"
            class="sd-figure"
          >
            <button
              type="button"
              class="sd-image-open"
              :aria-label="t('story.image_open', { n: image.position + 1 })"
              aria-haspopup="dialog"
              @click="openLightbox(figures.indexOf(image))"
            >
              <img :src="image.url" :alt="image.caption" loading="lazy" />
            </button>
            <figcaption>{{ image.caption }}</figcaption>
          </figure>
        </div>

        <h3 class="sd-group">{{ t("story.worlds") }}</h3>
        <div class="sd-gallery">
          <figure
            v-for="image in figures.filter((f) => f.group === 'world')"
            :key="`w-${image.position}`"
            class="sd-figure"
          >
            <button
              type="button"
              class="sd-image-open"
              :aria-label="t('story.image_open', { n: image.position + 1 })"
              aria-haspopup="dialog"
              @click="openLightbox(figures.indexOf(image))"
            >
              <img :src="image.url" :alt="image.caption" loading="lazy" />
            </button>
            <figcaption>{{ image.caption }}</figcaption>
          </figure>
        </div>

        <button
          type="button"
          class="sd-like"
          :class="{ on: data.likedByMe }"
          @click="toggleLike()"
        >
          {{ data.likedByMe ? t("story.liked") : t("story.like") }} · {{ data.likeCount }}
        </button>

        <h3 class="sd-group">{{ t("story.reply_title") }}</h3>
        <p v-if="replies.length === 0" class="empty">{{ t("story.reply_empty") }}</p>
        <ol v-else class="sd-replies">
          <li v-for="reply in replies" :key="reply.id" class="sd-reply">
            <span class="sd-floor">{{ t("story.floor", { n: reply.floor }) }}</span>
            <b class="sd-name">{{ reply.username }}</b>
            <span class="sd-text">{{ reply.content }}</span>
          </li>
        </ol>

        <p v-if="replyError" class="empty bad">{{ replyError }}</p>

        <div class="sd-composer">
          <textarea
            id="sd-reply"
            v-model="draft"
            rows="3"
            :placeholder="t('story.reply_ph')"
          ></textarea>
          <p class="sd-count" :class="{ over: replyTooLong }">
            <b>{{ replyCount }}</b> / {{ STORY_COMMENT_MAX_GRAPHEMES }}
          </p>
          <button
            type="button"
            class="sd-send"
            :disabled="sending || replyTooLong"
            @click="send()"
          >
            {{ t("story.reply_send") }}
          </button>
        </div>
      </article>
    </div>

    <StoryImageLightbox
      v-if="lightboxIndex !== null"
      :images="lightboxImages"
      :start-index="lightboxIndex"
      @close="lightboxIndex = null"
    />
  </div>
</template>
