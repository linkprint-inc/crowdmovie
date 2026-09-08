<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { t, translateError } from "../i18n";
import { ApiError } from "../lib/api";
import { PASSWORD_MIN_LENGTH, USERNAME_MAX_GRAPHEMES } from "../lib/grapheme";
import { claimGuest, identity, login, registerAccount } from "../stores/identity";
import { authModalOpen, closeAuth } from "../stores/ui";

/*
 * Spec §2.5 — the site's only identity entry point.
 *
 * The load-bearing behaviour: pressing 现在注册 the first time neither closes
 * the modal nor submits anything. It reveals the email and password fields in
 * place, relabels itself 创建账号 and swaps the description; only the second
 * press validates and submits. A failed validation keeps the modal open and
 * marks just the offending fields.
 */

type Mode = "start" | "login";

const mode = ref<Mode>("start");
const regOpen = ref(false);
const username = ref("");
const email = ref("");
const password = ref("");
const identifier = ref("");
const bad = ref<Record<string, boolean>>({});
const formError = ref("");

const dialog = ref<HTMLElement | null>(null);
const usernameInput = ref<HTMLInputElement | null>(null);
const emailInput = ref<HTMLInputElement | null>(null);
const identifierInput = ref<HTMLInputElement | null>(null);

let opener: HTMLElement | null = null;

const subText = computed(() => {
  if (mode.value === "login") return t("auth.login_sub");
  return regOpen.value ? t("auth.modal_sub_register") : t("auth.modal_sub");
});

/* Second slot: "sign up now" until the fields are open, "create account" after. */
const secondaryLabel = computed(() =>
  regOpen.value ? t("auth.create_btn") : t("auth.register_btn"),
);

function reset(): void {
  regOpen.value = false;
  mode.value = "start";
  bad.value = {};
  formError.value = "";
  email.value = "";
  password.value = "";
  identifier.value = "";
}

function close(): void {
  closeAuth();
  // Spec §2.5: reopening always starts collapsed again.
  reset();
  opener?.focus();
  opener = null;
}

watch(authModalOpen, async (open) => {
  if (!open) return;
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // Opening as a guest carries the current name in, so it can be upgraded in place.
  username.value = identity.state === "guest" ? (identity.username ?? "") : "";
  await nextTick();
  usernameInput.value?.focus();
});

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.stopPropagation();
    close();
    return;
  }
  if (event.key !== "Tab" || !dialog.value) return;
  const focusable = dialog.value.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [href], select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function mark(field: string, isBad: boolean): boolean {
  bad.value = { ...bad.value, [field]: isBad };
  return !isBad;
}

function handleError(err: unknown): void {
  if (err instanceof ApiError) {
    formError.value = translateError(err.code, err.message);
    if (err.code.startsWith("username")) bad.value = { ...bad.value, username: true };
    if (err.code.startsWith("email")) bad.value = { ...bad.value, email: true };
    if (err.code === "password_too_short") bad.value = { ...bad.value, password: true };
    if (err.code === "invalid_credentials") bad.value = { ...bad.value, identifier: true };
    return;
  }
  throw err;
}

async function onClaim(): Promise<void> {
  formError.value = "";
  if (!mark("username", username.value.trim() === "")) return;
  try {
    await claimGuest(username.value.trim());
    close();
  } catch (err) {
    handleError(err);
  }
}

async function onRegister(): Promise<void> {
  formError.value = "";

  // First press only reveals the account fields — no validation, no request.
  if (!regOpen.value) {
    regOpen.value = true;
    await nextTick();
    emailInput.value?.focus();
    return;
  }

  let ok = mark("username", username.value.trim() === "");
  ok = mark("email", !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u.test(email.value.trim())) && ok;
  ok = mark("password", [...password.value].length < PASSWORD_MIN_LENGTH) && ok;
  if (!ok) return;

  try {
    await registerAccount({
      username: username.value.trim(),
      email: email.value.trim(),
      password: password.value,
    });
    close();
  } catch (err) {
    handleError(err);
  }
}

async function onLogin(): Promise<void> {
  formError.value = "";
  let ok = mark("identifier", identifier.value.trim() === "");
  ok = mark("password", password.value === "") && ok;
  if (!ok) return;
  try {
    await login(identifier.value.trim(), password.value);
    close();
  } catch (err) {
    handleError(err);
  }
}

async function toLogin(): Promise<void> {
  mode.value = "login";
  bad.value = {};
  formError.value = "";
  password.value = "";
  await nextTick();
  identifierInput.value?.focus();
}

async function toStart(): Promise<void> {
  mode.value = "start";
  bad.value = {};
  formError.value = "";
  await nextTick();
  usernameInput.value?.focus();
}
</script>

<template>
  <div
    v-if="authModalOpen"
    class="scrim"
    data-test="scrim"
    @click.self="close()"
    @keydown="onKeydown"
  >
    <div
      ref="dialog"
      class="modal"
      :class="{ 'reg-open': regOpen }"
      role="dialog"
      aria-modal="true"
      aria-labelledby="authTitle"
    >
      <button class="x" type="button" :aria-label="t('auth.close')" @click="close()">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path
            d="M2 2l10 10M12 2L2 12"
            stroke="#1D1814"
            stroke-width="2.6"
            stroke-linecap="round"
          />
        </svg>
      </button>

      <h3 id="authTitle">
        {{ mode === "login" ? t("auth.login_title") : t("auth.modal_title") }}
      </h3>
      <p class="sub">{{ subText }}</p>

      <template v-if="mode === 'start'">
        <p v-if="identity.state === 'guest'" class="upgrade">
          {{ t("auth.upgrade_note", { name: `@${identity.username}` }) }}
        </p>

        <div class="field" :class="{ bad: bad.username }">
          <label for="cm-username">{{ t("auth.username") }}</label>
          <input
            id="cm-username"
            ref="usernameInput"
            v-model="username"
            type="text"
            :maxlength="USERNAME_MAX_GRAPHEMES"
            autocomplete="username"
            :placeholder="t('auth.username_ph')"
          />
          <p class="note">{{ t("auth.username_note") }}</p>
          <p v-if="bad.username" class="err">{{ t("auth.username_err") }}</p>
        </div>

        <!-- Revealed in place by the first press of 现在注册; the modal never
             closes to show them. -->
        <template v-if="regOpen">
          <div class="field" :class="{ bad: bad.email }" data-test="field-email">
            <label for="cm-email">{{ t("auth.email") }}</label>
            <input
              id="cm-email"
              ref="emailInput"
              v-model="email"
              type="email"
              autocomplete="email"
              :placeholder="t('auth.email_ph')"
            />
            <p class="note">{{ t("auth.email_note") }}</p>
            <p v-if="bad.email" class="err">{{ t("auth.email_err") }}</p>
          </div>
          <div class="field" :class="{ bad: bad.password }" data-test="field-password">
            <label for="cm-password">{{ t("auth.password") }}</label>
            <input
              id="cm-password"
              v-model="password"
              type="password"
              autocomplete="new-password"
              :placeholder="t('auth.password_ph')"
            />
            <p v-if="bad.password" class="err">{{ t("auth.password_err") }}</p>
          </div>
        </template>

        <div class="acts">
          <button
            class="primary"
            type="button"
            :disabled="identity.busy"
            @click="onClaim()"
          >
            {{ t("auth.claim_btn") }}
          </button>
          <button
            class="secondary"
            type="button"
            data-test="register"
            :disabled="identity.busy"
            @click="onRegister()"
          >
            {{ secondaryLabel }}
          </button>
        </div>

        <p v-if="formError" class="formerr" role="alert">{{ formError }}</p>
        <p class="warn">{{ t("auth.warn") }}</p>
        <button class="full" type="button" @click="toLogin()">
          {{ t("auth.have_account") }}
        </button>
      </template>

      <template v-else>
        <div class="field" :class="{ bad: bad.identifier }">
          <label for="cm-identifier">{{ t("auth.identifier") }}</label>
          <input
            id="cm-identifier"
            ref="identifierInput"
            v-model="identifier"
            type="text"
            autocomplete="username"
          />
          <p v-if="bad.identifier" class="err">{{ t("auth.identifier_err") }}</p>
        </div>
        <div class="field" :class="{ bad: bad.password }">
          <label for="cm-login-password">{{ t("auth.password") }}</label>
          <input
            id="cm-login-password"
            v-model="password"
            type="password"
            autocomplete="current-password"
          />
        </div>
        <div class="acts">
          <button
            class="primary"
            type="button"
            :disabled="identity.busy"
            @click="onLogin()"
          >
            {{ t("auth.login_btn") }}
          </button>
        </div>
        <p v-if="formError" class="formerr" role="alert">{{ formError }}</p>
        <button class="full" type="button" @click="toStart()">
          {{ t("auth.back_to_signup") }}
        </button>
      </template>
    </div>
  </div>
</template>
