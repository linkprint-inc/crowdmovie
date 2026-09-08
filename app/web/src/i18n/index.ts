/*
 * Small hand-rolled i18n store. Four real locales, flat dotted keys, `{name}`
 * interpolation. Deliberately not vue-i18n: the app needs lookup and
 * interpolation and nothing else, and `en` is the type source so a missing key
 * in any other locale is a compile error rather than a runtime blank.
 */
import { computed, ref } from "vue";
import { en } from "./messages/en";
import { zhCN } from "./messages/zh-CN";
import { ja } from "./messages/ja";
import { es } from "./messages/es";

export const LOCALES = ["en", "zh-CN", "ja", "es"] as const;
export type Locale = (typeof LOCALES)[number];

/** Spec §2: the switcher shows each language in its own name, never a flag. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  "zh-CN": "简体中文",
  ja: "日本語",
  es: "Español",
};

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;

const BUNDLES: Record<Locale, Messages> = {
  en,
  "zh-CN": zhCN,
  ja,
  es,
};

/**
 * The browser is the authority on every fresh page load. The language switcher
 * still changes the current session immediately, but an old local preference
 * must not make a shared browser start in the wrong language forever.
 */
function detect(): Locale {
  const tags = navigator.languages.length > 0 ? navigator.languages : [navigator.language];
  for (const tag of tags) {
    const lower = (tag ?? "").toLowerCase();
    if (lower.startsWith("zh")) return "zh-CN";
    if (lower.startsWith("ja")) return "ja";
    if (lower.startsWith("es")) return "es";
    if (lower.startsWith("en")) return "en";
  }
  return "en";
}

export const locale = ref<Locale>(detect());

export function setLocale(next: Locale): void {
  locale.value = next;
  document.documentElement.lang = next;
}

export const messages = computed<Messages>(() => BUNDLES[locale.value]);

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const raw = messages.value[key] ?? en[key] ?? (key as string);
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** Server error codes → localized copy; unknown codes fall back to the
 *  server's own message, which is already user-facing (Chinese). */
export function translateError(code: string, serverMessage: string): string {
  const key = `err.${code}` as MessageKey;
  if (key in messages.value) return t(key);
  if (key in en) return t(key);
  return serverMessage;
}
