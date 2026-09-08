<script setup lang="ts">
import { computed, ref } from "vue";
import { t, translateError } from "../i18n";
import { ApiError, api } from "../lib/api";
import { CONTACT_MAX_GRAPHEMES, glen } from "../lib/grapheme";
import { identity } from "../stores/identity";

/*
 * Spec §2.5: an on-site message form. No email address is published anywhere,
 * and the lead copy states plainly that we never ask for passwords or send
 * people to external links — the form itself is the anti-phishing statement.
 */

const CATEGORIES = [
  { value: "general", key: "contact.type_general" },
  { value: "appeal", key: "contact.type_appeal" },
  { value: "copyright", key: "contact.type_copyright" },
  { value: "bug", key: "contact.type_bug" },
] as const;

/*
 * The rail beside the form. Every row is a question that would otherwise
 * arrive here as a message, pointed at the page that already answers it.
 */
const SELF_SERVE = [
  { to: "how", q: "contact.self_rules_q", a: "contact.self_rules_a" },
  { to: "live", q: "contact.self_scene_q", a: "contact.self_scene_a" },
  { to: "mine", q: "contact.self_mine_q", a: "contact.self_mine_a" },
] as const;

const category = ref<string>(CATEGORIES[0].value);
const sceneRef = ref("");
const body = ref("");
const bad = ref(false);
const sending = ref(false);
const sent = ref(false);
const unavailable = ref(false);
const error = ref("");

const count = computed(() => glen(body.value));
const over = computed(() => count.value > CONTACT_MAX_GRAPHEMES);

/*
 * §15:「`scene_index` 必须是已发布片段或为空」. The box takes the number as it
 * is printed on the player — `000042`, zero-padded — so leading zeros are part
 * of the notation, not part of the value. Anything that is not a positive
 * whole number is not a scene reference and is refused here rather than sent
 * as garbage for the server to reject.
 */
const sceneIndex = computed<number | null>(() => {
  const raw = sceneRef.value.trim();
  if (raw === "") return null;
  if (!/^\d+$/.test(raw)) return Number.NaN;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : Number.NaN;
});
const sceneRefBad = computed(() => Number.isNaN(sceneIndex.value));

const asWho = computed(() => {
  if (identity.state === "account") return t("contact.as_account", { name: `@${identity.username}` });
  if (identity.state === "guest") return t("contact.as_guest", { name: `@${identity.username}` });
  return t("contact.as_anon");
});

const replyNote = computed(() =>
  identity.state === "account" ? t("contact.sent_reply_account") : t("contact.sent_reply_guest"),
);

async function send(): Promise<void> {
  error.value = "";
  bad.value = body.value.trim() === "";
  if (bad.value || over.value || sceneRefBad.value) return;

  sending.value = true;
  try {
    await api.contact({
      category: category.value,
      sceneIndex: sceneIndex.value as number | null,
      body: body.value,
    });
    sent.value = true;
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    // The endpoint has not shipped. Say so plainly and say nothing was sent,
    // rather than showing a success screen for a message that went nowhere.
    if (err.notImplemented) unavailable.value = true;
    else error.value = translateError(err.code, err.message);
  } finally {
    sending.value = false;
  }
}

function again(): void {
  body.value = "";
  sceneRef.value = "";
  bad.value = false;
  sent.value = false;
  unavailable.value = false;
  error.value = "";
}
</script>

<template>
  <div class="page">
    <div class="inner">
      <h2 class="ptitle">
        {{ t("contact.title") }} <small>{{ t("contact.sub") }}</small>
      </h2>
      <p class="plead">{{ t("contact.lead") }}</p>

      <div class="ct-grid">
        <div class="form-card">
          <div v-if="sent" class="sent" data-test="sent">
            <b>{{ t("contact.sent") }}</b><br />
            {{ t("contact.sent_body") }} {{ replyNote }}
            <div style="margin-top: 12px">
              <button class="btn-teal" type="button" @click="again()">
                {{ t("contact.again") }}
              </button>
            </div>
          </div>

          <template v-else>
            <p v-if="unavailable" class="empty bad" role="alert">
              <b>{{ t("contact.unavailable_title") }}</b>
              {{ t("contact.unavailable_body") }}
            </p>

            <div class="field">
              <label for="ct-type">{{ t("contact.type") }}</label>
              <select id="ct-type" v-model="category">
                <option v-for="c in CATEGORIES" :key="c.value" :value="c.value">
                  {{ t(c.key) }}
                </option>
              </select>
            </div>

            <div class="field" :class="{ bad: sceneRefBad }">
              <label for="ct-scene">
                {{ t("contact.scene") }}<span class="opt">{{ t("contact.optional") }}</span>
              </label>
              <input
                id="ct-scene"
                v-model="sceneRef"
                type="text"
                inputmode="numeric"
                maxlength="12"
                :aria-invalid="sceneRefBad"
                :placeholder="t('contact.scene_ph')"
              />
              <p v-if="sceneRefBad" class="err" data-test="scene-err">
                {{ t("contact.scene_err") }}
              </p>
              <p class="note">{{ t("contact.scene_note") }}</p>
            </div>

            <div class="field" :class="{ bad }">
              <label for="ct-body">{{ t("contact.body") }}</label>
              <textarea id="ct-body" v-model="body" :placeholder="t('contact.body_ph')"></textarea>
              <p v-if="bad" class="err">{{ t("contact.body_err") }}</p>
            </div>

            <div class="form-foot">
              <span class="count" :class="{ over }">
                <b>{{ count }}</b> / {{ CONTACT_MAX_GRAPHEMES }}
              </span>
              <span class="as-who">{{ asWho }}</span>
              <button
                class="btn-teal"
                type="button"
                :disabled="sending || over || sceneRefBad"
                @click="send()"
              >
                {{ sending ? t("contact.sending") : t("contact.send") }}
              </button>
            </div>

            <p v-if="error" class="formerr" role="alert" style="color: var(--red); font-weight: 600">
              {{ error }}
            </p>
          </template>
        </div>

        <aside class="ct-side">
          <div class="side-card">
            <h3 class="side-h">{{ t("contact.side_first") }}</h3>
            <RouterLink
              v-for="item in SELF_SERVE"
              :key="item.to"
              class="side-row"
              :to="{ name: item.to }"
            >
              <span class="q">{{ t(item.q) }}</span>
              <span class="a">{{ t(item.a) }}</span>
            </RouterLink>
          </div>

          <div class="side-card reply" data-test="reply-rules">
            <h3 class="side-h">{{ t("contact.side_reply") }}</h3>
            <p>{{ t("contact.side_reply_account") }}</p>
            <p>{{ t("contact.side_reply_guest") }}</p>
            <p>{{ t("contact.side_reply_order") }}</p>
          </div>

          <p class="disclaimer" data-test="disclaimer">{{ t("contact.disclaimer") }}</p>
        </aside>
      </div>
    </div>
  </div>
</template>
