<script setup lang="ts">
import { computed } from "vue";
import { t } from "../i18n";
import { api } from "../lib/api";
import { pad } from "../lib/format";
import { useResource } from "../lib/useResource";
import MovieCharacterCard from "../components/MovieCharacterCard.vue";
import ChatLine from "../components/ChatLine.vue";
import PageState from "../components/PageState.vue";
import { myVotes } from "../stores/live";
import { movies } from "../stores/movies";

/* Spec §11 detail: premise + theme credit, the compact cast, this episode's
   top pitches in the same chat-row style as the screening room, and a status
   line telling the reader where they can still act. */
const props = defineProps<{ movieSlug: string; index: number }>();

const { data, loading, missing, error, reload } = useResource(() =>
  api.episode(props.index, props.movieSlug),
);
const episode = computed(() => data.value);
</script>

<template>
  <div class="page">
    <div class="inner">
      <RouterLink
        class="back"
        :to="{ name: 'episodes' }"
        >{{ t("eps.back") }}</RouterLink
      >

      <PageState :loading="loading" :missing="missing" :error="error" @retry="reload()" />

      <template v-if="episode">
        <h2 class="ptitle">
          EP {{ pad(episode.episodeIndex, 2) }} · {{ episode.title }}
          <small>
            {{ episode.status === "open" ? t("eps.airing") : t("eps.ended") }} ·
            {{ episode.sceneCount }} {{ t("eps.scenes") }} ·
            {{ episode.submissionCount }} {{ t("eps.submissions") }}
          </small>
        </h2>

        <div class="premise">
          <h4>{{ t("eps.premise") }}</h4>
          <p>{{ episode.premise }}</p>
          <p class="by" style="margin-top: 10px">
            <template v-if="episode.themeSourceUsername">
              {{
                t("eps.premise_by", {
                  name: `@${episode.themeSourceUsername}`,
                  votes: episode.themeSourceVotes ?? 0,
                })
              }}
            </template>
            <template v-else>{{ t("eps.premise_ai") }}</template>
          </p>
        </div>

        <h3 class="subsec">{{ t("eps.cast") }}</h3>
        <div class="char-grid wide">
          <MovieCharacterCard
            v-for="c in movies.characters"
            :key="c.key"
            :character="c"
            slim
          />
        </div>

        <h3 class="subsec">{{ t("eps.top") }}</h3>
        <div class="sublist">
          <p v-if="episode.topSubmissions.length === 0" class="empty">
            {{ t("timeline.empty_title") }}
          </p>
          <ChatLine
            v-for="s in episode.topSubmissions"
            :key="s.id"
            :id="s.id"
            :username="s.username"
            :content="s.content"
            :created-at="s.createdAt"
            :status="s.status"
            :up-count="s.upCount"
            :down-count="s.downCount"
            :score="s.score?.total ?? null"
            :roast="s.score?.roast ?? null"
            :my-vote="myVotes[s.id] ?? null"
            :can-vote="false"
            votes-frozen
            :show-time="false"
          />
        </div>

        <p class="foot-note">
          {{ episode.status === "open" ? t("eps.live_note") : t("eps.done_note") }}
        </p>
      </template>
    </div>
  </div>
</template>
