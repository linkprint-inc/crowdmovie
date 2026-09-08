/* Per-browser preferences (spec §6.1, §7): all local, none sent to the server. */
import { ref, watch } from "vue";

function persisted<T>(key: string, fallback: T, parse: (raw: string) => T) {
  let initial = fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) initial = parse(raw);
  } catch {
    /* private mode: fall back to the default and simply never persist */
  }
  const r = ref<T>(initial);
  watch(r, (v) => {
    try {
      localStorage.setItem(key, String(v));
    } catch {
      /* ignore */
    }
  });
  return r;
}

const asBool = (raw: string) => raw === "true";

/** Both designs share one live session. This preference only changes presentation. */
export type SiteDesign = "studio" | "classic";
export const siteDesign = persisted<SiteDesign>(
  "cm.siteDesign",
  "studio",
  (raw) => raw === "classic" ? "classic" : "studio",
);

/** Danmaku drawn over the player. Spec §7: on by default. */
export const showDanmaku = persisted("cm.showDanmaku", true, asBool);

/** Subtitles on the player. Spec §4.1: off by default and remembered. The
 *  language is not a second choice — it follows the interface language. */
export const showSubtitles = persisted("cm.showSubtitles", false, asBool);
