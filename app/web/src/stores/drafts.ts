/*
 * Unsent drafts belong to a film just like episodes, rounds and danmaku do.
 * The exported `drafts` object is always the three slots for the film currently
 * being viewed; switching films swaps that view without destroying either
 * film's local or server-side copy.
 */
import { reactive, watch } from "vue";

import { ApiError, api, type DraftKind } from "../lib/api";
import { canWrite } from "./identity";
import { LEGACY_MOVIE_SLUG, viewingMovieSlug } from "./movies";

export type DraftSlot = DraftKind;
type DraftRecord = Record<DraftSlot, string>;

const SLOTS: readonly DraftSlot[] = ["next_shot", "next_episode", "danmaku"];
const KEY = "cm.drafts.byMovie.v1";
const LEGACY_KEY = "cm.drafts";

/** §12「自动保存」. */
export const AUTOSAVE_DELAY_MS = 2_000;

function emptyDrafts(): DraftRecord {
  return { next_shot: "", next_episode: "", danmaku: "" };
}

function readRecord(value: unknown): DraftRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Partial<Record<DraftSlot, unknown>>;
  const record = emptyDrafts();
  for (const slot of SLOTS) {
    if (typeof source[slot] === "string") record[slot] = source[slot];
  }
  return record;
}

function loadAll(): Record<string, DraftRecord> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const found: Record<string, DraftRecord> = {};
      for (const [slug, value] of Object.entries(parsed)) {
        const record = readRecord(value);
        if (record !== null) found[slug] = record;
      }
      return found;
    }

    // The old global slots belonged to the only film that existed then, never
    // to whichever film is selected on the first run after this release.
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const record = readRecord(JSON.parse(legacy));
      if (record !== null) return { [LEGACY_MOVIE_SLUG]: record };
    }
  } catch {
    /* corrupt or unavailable storage — start empty */
  }
  return {};
}

const byMovie = reactive<Record<string, DraftRecord>>(loadAll());

function recordFor(movieSlug: string): DraftRecord {
  byMovie[movieSlug] ??= emptyDrafts();
  return byMovie[movieSlug];
}

function persistAll(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(byMovie));
  } catch {
    /* private browsing */
  }
}

export const drafts = reactive<DraftRecord>({
  ...recordFor(viewingMovieSlug.value),
});

/* ------------------------------------------------------------ server sync */

let serverUnavailable = false;
let replacingCurrent = false;
/** Slots edited per movie since load; hydration leaves those local values. */
const touched = new Map<string, Set<DraftSlot>>();
/** What the server is known to hold, separated by movie. */
const saved = new Map<string, DraftRecord>();
const timers = new Map<string, number>();
/**
 * PUTs for one movie/slot are serialized. A slow save of submitted text must
 * not finish after its subsequent empty save and resurrect the old draft.
 */
const saveTails = new Map<string, Promise<void>>();

function touchedFor(movieSlug: string): Set<DraftSlot> {
  let set = touched.get(movieSlug);
  if (set === undefined) {
    set = new Set<DraftSlot>();
    touched.set(movieSlug, set);
  }
  return set;
}

function savedFor(movieSlug: string): DraftRecord {
  let record = saved.get(movieSlug);
  if (record === undefined) {
    record = emptyDrafts();
    saved.set(movieSlug, record);
  }
  return record;
}

function timerKey(movieSlug: string, slot: DraftSlot): string {
  return `${movieSlug}:${slot}`;
}

function showMovie(movieSlug: string): void {
  replacingCurrent = true;
  const source = recordFor(movieSlug);
  for (const slot of SLOTS) drafts[slot] = source[slot];
  replacingCurrent = false;
}

/** Restore every server row, while only changing untouched local slots. */
export async function hydrateDrafts(): Promise<void> {
  if (serverUnavailable || !canWrite.value) return;
  let stored: Awaited<ReturnType<typeof api.myDrafts>>;
  try {
    stored = await api.myDrafts();
  } catch (err) {
    if (err instanceof ApiError && err.notImplemented) serverUnavailable = true;
    return;
  }

  for (const row of stored.drafts ?? []) {
    if (!SLOTS.includes(row.kind)) continue;
    const movieSlug = row.movieSlug ?? LEGACY_MOVIE_SLUG;
    savedFor(movieSlug)[row.kind] = row.body;
    if (touchedFor(movieSlug).has(row.kind)) continue;
    recordFor(movieSlug)[row.kind] = row.body;
  }
  persistAll();
  showMovie(viewingMovieSlug.value);
}

export const draftSync = reactive<{ saving: boolean; savedAt: string | null }>({
  saving: false,
  savedAt: null,
});

async function persistLatest(movieSlug: string, slot: DraftSlot): Promise<void> {
  if (serverUnavailable || !canWrite.value) return;
  const body = recordFor(movieSlug)[slot];
  const known = savedFor(movieSlug);
  if (body === known[slot]) return;
  draftSync.saving = true;
  try {
    await api.saveDraft(slot, body, movieSlug);
    known[slot] = body;
    draftSync.savedAt = new Date().toISOString();
  } catch (err) {
    if (err instanceof ApiError && err.notImplemented) serverUnavailable = true;
  } finally {
    draftSync.saving = false;
  }
}

function flush(movieSlug: string, slot: DraftSlot): Promise<void> {
  const key = timerKey(movieSlug, slot);
  const timer = timers.get(key);
  if (timer !== undefined) window.clearTimeout(timer);
  timers.delete(key);

  const previous = saveTails.get(key) ?? Promise.resolve();
  const queued = previous.then(() => persistLatest(movieSlug, slot));
  saveTails.set(key, queued);
  void queued.then(() => {
    if (saveTails.get(key) === queued) saveTails.delete(key);
  });
  return queued;
}

function schedule(movieSlug: string, slot: DraftSlot): void {
  const key = timerKey(movieSlug, slot);
  const existing = timers.get(key);
  if (existing !== undefined) window.clearTimeout(existing);
  timers.set(
    key,
    window.setTimeout(() => {
      void flush(movieSlug, slot);
    }, AUTOSAVE_DELAY_MS),
  );
}

for (const slot of SLOTS) {
  watch(
    () => drafts[slot],
    (body) => {
      if (replacingCurrent) return;
      const movieSlug = viewingMovieSlug.value;
      recordFor(movieSlug)[slot] = body;
      touchedFor(movieSlug).add(slot);
      persistAll();
      schedule(movieSlug, slot);
    },
    { flush: "sync" },
  );
}

watch(
  viewingMovieSlug,
  (movieSlug) => {
    showMovie(movieSlug);
    void hydrateDrafts();
  },
  { flush: "sync" },
);

// Claiming a username or logging in is the moment a stored draft can be read;
// it is also the moment anything typed while anonymous becomes savable.
watch(canWrite, (able) => {
  if (!able) return;
  void hydrateDrafts();
  const movieSlug = viewingMovieSlug.value;
  for (const slot of SLOTS) {
    if (recordFor(movieSlug)[slot] !== "") schedule(movieSlug, slot);
  }
});

/**
 * Clear a slot after the corresponding text has been accepted for publishing.
 * The reactive assignment clears the visible textarea immediately; the
 * serialized PUT also clears the cross-session copy without racing an older
 * autosave that is still in flight.
 */
export async function clearPublishedDraft(slot: DraftSlot): Promise<void> {
  const movieSlug = viewingMovieSlug.value;
  drafts[slot] = "";
  await flush(movieSlug, slot);
}

/** Exposed for tests; pending saves retain the movie that scheduled them. */
export function flushDraftsNow(): Promise<void[]> {
  const pending = [...timers.keys()];
  for (const timer of timers.values()) window.clearTimeout(timer);
  timers.clear();

  const work = new Map<string, { movieSlug: string; slot: DraftSlot }>();
  for (const key of pending) {
    for (const slot of SLOTS) {
      const suffix = `:${slot}`;
      if (key.endsWith(suffix)) {
        work.set(key, { movieSlug: key.slice(0, -suffix.length), slot });
        break;
      }
    }
  }
  const movieSlug = viewingMovieSlug.value;
  for (const slot of SLOTS) {
    work.set(timerKey(movieSlug, slot), { movieSlug, slot });
  }
  return Promise.all([...work.values()].map((item) => flush(item.movieSlug, item.slot)));
}
