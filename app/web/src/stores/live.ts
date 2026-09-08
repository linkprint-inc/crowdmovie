/*
 * Live state for the screening room: the current round, its submissions, the
 * episode banner, next-episode pitches, danmaku and the playlist.
 *
 * Transport: `GET /api/events` (§16.4) first, a timer as the fallback. The
 * stream patches small event payloads directly. Reconnect and the slow safety
 * poll reconcile only the latest submission page and scenes newer than the
 * playlist tail; older timeline pages load solely when the reader scrolls up.
 */
import { computed, reactive, ref, watch } from "vue";
import { nextRoundNumber } from "../lib/round-number";
import {
  ApiError,
  api,
  type CurrentRound,
  type Danmaku,
  type EpisodeBanner,
  type PlaylistScene,
  type Proposal,
  type RoastText,
  type Submission,
  type SubmissionRound,
} from "../lib/api";
import type { SubmissionKind } from "../lib/grapheme";
import {
  movies,
  viewingEpisodeIndex,
  viewingMovieSlug,
} from "./movies";

/** Net upvotes that put a pitch straight into canon (creative doc / §6.6). */
export const CROWD_THRESHOLD = 10;

const POLL_ACTIVE_MS = 5_000;
const POLL_HIDDEN_MS = 30_000;
/** The fallback poll's interval while SSE is carrying the updates. */
const POLL_STREAM_MS = 60_000;

export type Vote = 1 | -1;

/** A closed round. The GET endpoint returns the complete authoritative archive
 *  so reload/reconnect preserves the timeline; the event path fills the same
 *  shape immediately while a round is rolling over. */
export type ArchivedRound = SubmissionRound;

interface State {
  round: CurrentRound | null;
  submissions: Submission[];
  archive: ArchivedRound[];
  submissionsHasMore: boolean;
  submissionsNextCursor: string | null;
  submissionsLoadingEarlier: boolean;
  proposals: Proposal[];
  episode: EpisodeBanner | null;
  /** Site-wide newest comments — the rail's list (§14.2). */
  danmaku: Danmaku[];
  /** The playing scene's own comment track — the overlay's source (§14.2). */
  sceneDanmaku: Danmaku[];
  playlist: PlaylistScene[];
  /** Set when the whole feed could not be loaded, cleared on the next success. */
  error: string | null;
  errorCode: string | null;
  loaded: boolean;
  /** True once we know the server has no round yet (404 no_round). */
  noRound: boolean;
  /** Features whose endpoints answered 404 — render an empty state, not an error. */
  missing: Record<string, boolean>;
}

export const live = reactive<State>({
  round: null,
  submissions: [],
  archive: [],
  submissionsHasMore: false,
  submissionsNextCursor: null,
  submissionsLoadingEarlier: false,
  proposals: [],
  episode: null,
  danmaku: [],
  sceneDanmaku: [],
  playlist: [],
  error: null,
  errorCode: null,
  loaded: false,
  noRound: false,
  missing: {},
});

/** The next writing round can be open while an earlier round is filming. */
export const activeProductionRound = computed(() => {
  const rounds = new Map(live.archive.map((round) => [round.roundIndex, round]));
  if (live.round) rounds.set(live.round.roundIndex, { ...live.round, submissions: live.submissions });
  const priority = (status: string | undefined) =>
    status === "generating" || status === "validating" ? 0 : 1;
  return [...rounds.values()]
    .filter((round) => ["selecting", "selected", "generating", "validating"].includes(round.status ?? ""))
    .sort((a, b) => priority(a.status) - priority(b.status) || a.roundIndex - b.roundIndex)[0] ?? null;
});

export const nextPublicRound = computed(() => nextRoundNumber(live.playlist, live.archive));

/* ------------------------------------------------------- my votes (local) */

/* The server has no endpoint to read back your own vote, so the browser
   remembers what it sent. Losing this only costs the blue highlight. */
const VOTES_KEY = "cm.votes";

function loadVotes(): Record<string, Vote> {
  try {
    const raw = localStorage.getItem(VOTES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, Vote> = {};
    for (const [id, v] of Object.entries(parsed)) {
      if (v === 1 || v === -1) out[id] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export const myVotes = reactive<Record<string, Vote>>(loadVotes());

function saveVotes(): void {
  try {
    localStorage.setItem(VOTES_KEY, JSON.stringify(myVotes));
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------- countdown */

export const now = ref(Date.now());

/** null before a round exists and during the initial AI bootstrap only. */
export const msToDeadline = computed(() => {
  if (!live.round?.closesAt) return null;
  const closes = Date.parse(live.round.closesAt);
  if (Number.isNaN(closes)) return null;
  return closes - now.value;
});

/* ---------------------------------------------------------------- reading */

function noteMissing(feature: string, err: unknown): void {
  if (err instanceof ApiError && err.notImplemented) live.missing[feature] = true;
}

let contextVersion = 0;
let loadedEarlierTimeline = false;
let playlistInitialized = false;

function mergeRows(existing: Submission[], incoming: Submission[]): Submission[] {
  const byId = new Map(existing.map((row) => [row.id, row]));
  for (const row of incoming) byId.set(row.id, row);
  return [...byId.values()].sort(
    (left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

function mergeArchive(
  existing: ArchivedRound[],
  incoming: ArchivedRound[],
): ArchivedRound[] {
  const byRound = new Map(
    existing.map((round) => [round.roundIndex, round] as const),
  );
  for (const round of incoming) {
    byRound.set(
      round.roundIndex,
      {
        ...byRound.get(round.roundIndex),
        ...round,
        submissions: mergeRows(byRound.get(round.roundIndex)?.submissions ?? [], round.submissions),
      },
    );
  }
  return [...byRound]
    .sort(([left], [right]) => left - right)
    .map(([, round]) => round);
}

async function loadRound(version: number): Promise<void> {
  try {
    const round = await api.currentRound(viewingMovieSlug.value);
    if (version !== contextVersion) return;
    // Rolling over to a new round: keep the round we were just reading so its
    // rows stay in the timeline instead of vanishing mid-scroll.
    if (live.round && live.round.roundIndex !== round.roundIndex && live.submissions.length > 0) {
      live.archive = mergeArchive(live.archive, [
        { roundIndex: live.round.roundIndex, status: live.round.status, submissions: live.submissions },
      ]);
      live.submissions = [];
    }
    live.round = round;
    live.noRound = false;
  } catch (err) {
    if (err instanceof ApiError && err.code === "no_round") {
      live.round = null;
      live.noRound = true;
      return;
    }
    throw err;
  }
}

async function loadSubmissions(version: number, before?: string): Promise<boolean> {
  try {
    const res = await api.currentSubmissions(viewingMovieSlug.value, before);
    if (version !== contextVersion) return false;
    if (res.archive !== undefined) {
      live.archive = mergeArchive(live.archive, res.archive);
    }
    live.submissions = mergeRows(live.submissions, res.submissions);
    if (before !== undefined) loadedEarlierTimeline = true;
    if (before !== undefined || !loadedEarlierTimeline) {
      live.submissionsHasMore = res.hasMore === true;
      live.submissionsNextCursor =
        typeof res.nextCursor === "string" ? res.nextCursor : null;
    }
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.code === "no_round") {
      live.submissions = [];
      live.submissionsHasMore = false;
      live.submissionsNextCursor = null;
      return true;
    }
    throw err;
  }
}

/** Fetch one older page only when the timeline asks for it. */
export async function loadEarlierSubmissions(): Promise<boolean> {
  const before = live.submissionsNextCursor;
  if (
    live.submissionsLoadingEarlier ||
    !live.submissionsHasMore ||
    before === null
  ) {
    return false;
  }
  const version = contextVersion;
  live.submissionsLoadingEarlier = true;
  try {
    return await loadSubmissions(version, before);
  } finally {
    if (version === contextVersion) live.submissionsLoadingEarlier = false;
  }
}

async function loadPlaylist(version: number, replace: boolean): Promise<void> {
  const after = replace
    ? undefined
    : live.playlist.reduce((max, scene) => Math.max(max, scene.sceneIndex), 0);
  try {
    const res = await api.playlist(
      viewingMovieSlug.value,
      viewingEpisodeIndex.value,
      after,
    );
    if (version !== contextVersion) return;
    if (replace) {
      live.playlist = res.scenes;
    } else {
      const byIndex = new Map(live.playlist.map((scene) => [scene.sceneIndex, scene]));
      for (const scene of res.scenes) byIndex.set(scene.sceneIndex, scene);
      live.playlist = [...byIndex.values()].sort(
        (left, right) => left.sceneIndex - right.sceneIndex,
      );
    }
    playlistInitialized = true;
  } catch (err) {
    noteMissing("playlist", err);
  }
}

/** Endpoints that may not exist yet never fail the whole refresh. */
async function loadOptional(version: number): Promise<void> {
  const slug = viewingMovieSlug.value;
  const episodeIndex = viewingEpisodeIndex.value;
  await Promise.all([
    api
      .currentProgram()
      .then((program) => {
        if (version !== contextVersion) return;
        movies.program = program;
      })
      .catch(() => undefined),
    api
      .episodes(slug)
      .then((result) => {
        if (version !== contextVersion) return;
        const ep =
          (episodeIndex === null
            ? result.episodes.find((each) => each.status === "open")
            : result.episodes.find((each) => each.episodeIndex === episodeIndex)) ?? null;
        live.episode =
          ep === null
            ? null
            : {
                episodeIndex: ep.episodeIndex,
                title: ep.title,
                themeSourceUsername: ep.themeSourceUsername,
                proposalCount: ep.submissionCount,
                status: ep.status,
                storyOutline: ep.storyOutline,
              };
      })
      .catch((err) => noteMissing("episode", err)),
    api
      .recentDanmaku(slug)
      .then((res) => {
        if (version !== contextVersion) return;
        live.danmaku = res.danmaku;
      })
      .catch((err) => noteMissing("danmaku", err)),
    refreshSceneDanmaku(version),
    loadPlaylist(version, !playlistInitialized),
  ]);
}

/**
 * The comment track for the scene now on screen (§14.2). Kept apart from the
 * site-wide recent feed: the overlay needs every comment anchored in *this*
 * scene, which the newest-200 feed stops covering the moment the site is busy.
 */
let sceneDanmakuIndex: number | null = null;

export async function loadSceneDanmaku(sceneIndex: number): Promise<void> {
  sceneDanmakuIndex = sceneIndex;
  try {
    const slug = viewingMovieSlug.value;
    const version = contextVersion;
    const res = await api.sceneDanmaku(sceneIndex, slug);
    // A slower earlier request must not overwrite the scene now playing.
    if (version === contextVersion && sceneDanmakuIndex === sceneIndex) {
      live.sceneDanmaku = res.danmaku;
    }
  } catch (err) {
    if (sceneDanmakuIndex === sceneIndex) live.sceneDanmaku = [];
    noteMissing("danmaku", err);
  }
}

/** Pull the playing scene's track again — after sending, or after an event. */
export async function refreshSceneDanmaku(version = contextVersion): Promise<void> {
  if (version !== contextVersion) return;
  if (sceneDanmakuIndex !== null) await loadSceneDanmaku(sceneDanmakuIndex);
}

/** Full bootstrap/manual refresh. Later transport catch-ups use `reconcile`. */
export async function refresh(): Promise<void> {
  const version = contextVersion;
  try {
    // Episode playback changes only the video playlist. The story feed always
    // loads the movie's latest timeline page, independent of episode choice.
    await loadRound(version);
    await loadSubmissions(version);
    if (version !== contextVersion) return;
    live.error = null;
    live.errorCode = null;
  } catch (err) {
    if (err instanceof ApiError) {
      live.error = err.message;
      live.errorCode = err.code;
    } else {
      throw err;
    }
  } finally {
    live.loaded = true;
  }
  await loadOptional(version);
}

/** Small authoritative catch-up used by reconnects, the slow poll and rounds. */
async function reconcile(): Promise<void> {
  const version = contextVersion;
  try {
    await loadRound(version);
    await loadSubmissions(version);
    await loadPlaylist(version, !playlistInitialized);
    if (version !== contextVersion) return;
    live.error = null;
    live.errorCode = null;
  } catch (err) {
    if (err instanceof ApiError) {
      live.error = err.message;
      live.errorCode = err.code;
      return;
    }
    throw err;
  } finally {
    live.loaded = true;
  }
}

/* ---------------------------------------------------------------- writing */

export async function castVote(submissionId: string, value: Vote): Promise<void> {
  // Clicking the vote you already hold revokes it, which is what the server's
  // value:0 does.
  const next: 1 | -1 | 0 = myVotes[submissionId] === value ? 0 : value;
  const res = await api.vote(submissionId, next);

  if (next === 0) delete myVotes[submissionId];
  else myVotes[submissionId] = next;
  saveVotes();

  const shotRow = live.submissions.find((s) => s.id === submissionId);
  const row = shotRow ?? live.proposals.find((p) => p.id === submissionId);
  if (row) {
    row.upCount = res.upCount;
    row.downCount = res.downCount;
  }
  if (res.crowdAdopted && shotRow) {
    shotRow.votesFrozen = true;
  }
  if (res.crowdAdopted && live.round) {
    // Update the old round before the authoritative refresh archives it; this
    // keeps the winning row visibly accepted instead of stuck on “AI scoring”.
    live.round.status = "selecting";
    live.round.selectedSubmissionId = submissionId;
    live.round.selectionMode = "crowd";
    live.round.closesAt = new Date().toISOString();
    await refresh();
  }
}

export async function submit(kind: SubmissionKind, content: string): Promise<void> {
  await api.submit(kind, content, viewingMovieSlug.value);
  // The create response is not a timeline row (no username, no score), so pull
  // the authoritative list rather than synthesising one.
  await reconcile();
}

/* -------------------------------------------------------------- transport */

let timer: number | null = null;
let stream: EventSource | null = null;
let running = false;
/** Once the stream has failed to open we stop trying and stay on the timer. */
let streamUnavailable = false;
/** True while an SSE connection is actually up; the poll slows down then. */
export const streamLive = ref(false);

/**
 * §16.4's event names. Every one of them means the same thing here — "the
 * server state you are holding is stale" — because §16.4 is explicit that
 * events carry only ids and display minimums and that a reconnecting client
 * recalibrates over the GET endpoints rather than replaying the stream. So the
 * payloads are normally not parsed. `submission.deleted` is the one exception:
 * it removes the row immediately from current, archived and proposal views,
 * then the normal GET refresh still confirms the authoritative state.
 */
const EVENTS = [
  "round.opened",
  "round.closed",
  "round.published",
  "submission.created",
  "submission.scored",
  "submission.deleted",
  "submission.votes",
  "episode.ended",
  "episode.opened",
  "scene.published",
  "danmaku.created",
] as const;

/* A published round fires several events at once; one refresh answers them
   all. `submission.votes` alone is already coalesced to 2s server-side. */
const EVENT_COALESCE_MS = 400;
let coalesce: number | null = null;

/** Preserve a just-created row before the same transaction's round.opened
 * refresh rolls the old round into the in-memory timeline. This is essential
 * for AI Director: it writes the closing round and starts the next countdown
 * atomically. */
function applyCreatedSubmission(event: Event): void {
  if (event.type !== "submission.created" || !(event instanceof MessageEvent)) return;
  try {
    const frame = JSON.parse(String(event.data)) as {
      data?: {
        submissionId?: unknown;
        kind?: unknown;
        roundId?: unknown;
        username?: unknown;
        content?: unknown;
        votesFrozen?: unknown;
        createdAt?: unknown;
      };
    };
    const data = frame.data;
    if (
      data?.kind !== "next_shot" ||
      typeof data.submissionId !== "string" ||
      typeof data.roundId !== "string" ||
      data.roundId !== live.round?.roundId ||
      typeof data.username !== "string" ||
      typeof data.content !== "string" ||
      typeof data.createdAt !== "string" ||
      live.submissions.some((row) => row.id === data.submissionId)
    ) {
      return;
    }
    live.submissions.push({
      id: data.submissionId,
      username: data.username,
      content: data.content,
      status: "pending",
      upCount: 0,
      downCount: 0,
      votesFrozen: data.votesFrozen === true,
      createdAt: data.createdAt,
      score: null,
    });
  } catch {
    // The coalesced authoritative refresh still follows malformed events.
  }
}

function removeDeletedSubmission(event: Event): void {
  if (event.type !== "submission.deleted" || !(event instanceof MessageEvent)) return;
  try {
    const frame = JSON.parse(String(event.data)) as {
      data?: { submissionId?: unknown };
    };
    const submissionId = frame.data?.submissionId;
    if (typeof submissionId !== "string") return;
    live.submissions = live.submissions.filter((row) => row.id !== submissionId);
    live.proposals = live.proposals.filter((row) => row.id !== submissionId);
    live.archive = live.archive.map((round) => ({
      ...round,
      submissions: round.submissions.filter((row) => row.id !== submissionId),
    }));
    if (myVotes[submissionId] !== undefined) {
      delete myVotes[submissionId];
      saveVotes();
    }
  } catch {
    // A malformed frame cannot be trusted; the scheduled GET refresh below is
    // still the source of truth for current server state.
  }
}

/** A threshold-close can archive its winner while Terra is still finishing.
 * Patch the score event into both current and archived rows so the promised
 * score + roast does not disappear merely because a new round already opened. */
function applyScoredSubmission(event: Event): void {
  if (event.type !== "submission.scored" || !(event instanceof MessageEvent)) return;
  try {
    const frame = JSON.parse(String(event.data)) as {
      data?: {
        submissionId?: unknown;
        status?: unknown;
        total?: unknown;
        roast?: unknown;
      };
    };
    const data = frame.data;
    if (
      typeof data?.submissionId !== "string" ||
      (data.status !== "accepted" && data.status !== "rejected") ||
      typeof data.total !== "number" ||
      data.roast === null ||
      typeof data.roast !== "object"
    ) {
      return;
    }
    const rows = [
      ...live.submissions,
      ...live.archive.flatMap((round) => round.submissions),
    ];
    for (const row of rows) {
      if (row.id !== data.submissionId) continue;
      row.status = data.status;
      row.score = { total: data.total, roast: data.roast as RoastText };
    }
  } catch {
    // The GET refresh remains authoritative if a frame is malformed.
  }
}

function applySubmissionVotes(event: Event): void {
  if (event.type !== "submission.votes" || !(event instanceof MessageEvent)) return;
  try {
    const frame = JSON.parse(String(event.data)) as {
      data?: { submissionId?: unknown; upCount?: unknown; downCount?: unknown };
    };
    const data = frame.data;
    if (
      typeof data?.submissionId !== "string" ||
      typeof data.upCount !== "number" ||
      typeof data.downCount !== "number"
    ) {
      return;
    }
    const rows = [
      ...live.submissions,
      ...live.archive.flatMap((round) => round.submissions),
      ...live.proposals,
    ];
    const row = rows.find((candidate) => candidate.id === data.submissionId);
    if (row) {
      row.upCount = data.upCount;
      row.downCount = data.downCount;
    }
  } catch {
    // The slow reconciliation poll remains the recovery path.
  }
}

function applyDanmaku(event: Event): void {
  if (event.type !== "danmaku.created" || !(event instanceof MessageEvent)) return;
  try {
    const frame = JSON.parse(String(event.data)) as { data?: Danmaku };
    const row = frame.data;
    if (
      !row ||
      typeof row.id !== "string" ||
      live.danmaku.some((item) => item.id === row.id)
    ) {
      return;
    }
    live.danmaku = [row, ...live.danmaku].slice(0, 200);
    if (sceneDanmakuIndex === row.sceneIndex) {
      live.sceneDanmaku = [...live.sceneDanmaku, row];
    }
  } catch {
    // The slow reconciliation poll remains the recovery path.
  }
}

let eventNeedsCore = false;
let eventNeedsPlaylist = false;

function onEvent(event: Event): void {
  applyCreatedSubmission(event);
  removeDeletedSubmission(event);
  applyScoredSubmission(event);
  applySubmissionVotes(event);
  applyDanmaku(event);
  if (event.type.startsWith("submission.") || event.type === "danmaku.created") {
    return;
  }
  if (event.type.startsWith("round.") || event.type.startsWith("episode.")) {
    eventNeedsCore = true;
  }
  if (event.type === "scene.published" || event.type.startsWith("episode.")) {
    eventNeedsPlaylist = true;
  }
  if (coalesce !== null) return;
  coalesce = window.setTimeout(() => {
    coalesce = null;
    const core = eventNeedsCore;
    const playlist = eventNeedsPlaylist;
    eventNeedsCore = false;
    eventNeedsPlaylist = false;
    if (core) void reconcile();
    else if (playlist) void loadPlaylist(contextVersion, !playlistInitialized);
  }, EVENT_COALESCE_MS);
}

function pollDelay(): number {
  if (document.visibilityState === "hidden") return POLL_HIDDEN_MS;
  // Director/render transitions do not all emit SSE events.
  if (activeProductionRound.value) return POLL_ACTIVE_MS;
  // With the stream up the poll is only a safety net against a connection that
  // died without saying so, so it does not need to run at interactive speed.
  return streamLive.value ? POLL_STREAM_MS : POLL_ACTIVE_MS;
}

function scheduleNext(): void {
  if (!running) return;
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(async () => {
    timer = null;
    // A live stream keeps state fresh on its own; keep a slow poll anyway so a
    // silently dead connection still self-heals.
    await reconcile();
    scheduleNext();
  }, pollDelay());
}

// Re-arm an idle stream's slow timer as soon as a round enters production.
watch(() => Boolean(activeProductionRound.value), () => {
  if (!running) return;
  if (timer !== null) window.clearTimeout(timer);
  scheduleNext();
});

function openStream(): void {
  if (streamUnavailable || typeof EventSource === "undefined") return;
  let opened = false;
  try {
    stream = new EventSource(
      `/api/movies/${encodeURIComponent(viewingMovieSlug.value)}/events`,
      { withCredentials: true },
    );
  } catch {
    streamUnavailable = true;
    return;
  }
  stream.onopen = () => {
    const reconnecting = opened;
    opened = true;
    streamLive.value = true;
    // `start()` schedules before EventSource has opened, so that first timer
    // uses the 5-second fallback delay. Re-arm it now at the live-stream delay
    // instead of doing an unnecessary second boot reconciliation.
    if (timer !== null) window.clearTimeout(timer);
    scheduleNext();
    // Whatever happened while the connection was down is caught up by a
    // bounded authoritative read, never by trusting the stream to backfill.
    if (reconnecting) void reconcile();
  };
  // An unnamed `data:` frame arrives as `message`; named ones do not, so both
  // have to be wired up.
  stream.onmessage = onEvent;
  for (const name of EVENTS) stream.addEventListener(name, onEvent);
  stream.onerror = () => {
    streamLive.value = false;
    if (!opened) {
      // The endpoint does not exist (or is blocked); stop retrying forever.
      streamUnavailable = true;
      stream?.close();
      stream = null;
      return;
    }
    // It was working and dropped. EventSource reconnects by itself, and the
    // `onopen` above does the recalibration when it does.
  };
}

function onVisibility(): void {
  if (document.visibilityState === "visible") {
    void reconcile();
    if (timer !== null) window.clearTimeout(timer);
    scheduleNext();
  }
}

export function start(): void {
  if (running) return;
  running = true;
  void refresh();
  openStream();
  scheduleNext();
  document.addEventListener("visibilitychange", onVisibility);
}

export function stop(): void {
  running = false;
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  if (coalesce !== null) {
    window.clearTimeout(coalesce);
    coalesce = null;
  }
  eventNeedsCore = false;
  eventNeedsPlaylist = false;
  stream?.close();
  stream = null;
  streamLive.value = false;
  document.removeEventListener("visibilitychange", onVisibility);
}

export function switchLiveContext(): void {
  contextVersion += 1;
  live.round = null;
  live.submissions = [];
  live.archive = [];
  live.submissionsHasMore = false;
  live.submissionsNextCursor = null;
  live.submissionsLoadingEarlier = false;
  live.proposals = [];
  live.episode = null;
  live.danmaku = [];
  live.sceneDanmaku = [];
  live.playlist = [];
  live.error = null;
  live.errorCode = null;
  live.loaded = false;
  live.noRound = false;
  sceneDanmakuIndex = null;
  loadedEarlierTimeline = false;
  playlistInitialized = false;
  stream?.close();
  stream = null;
  streamLive.value = false;
  streamUnavailable = false;
  if (running) {
    void refresh();
    openStream();
  }
}

/* One shared ticker drives every countdown on the page. */
window.setInterval(() => {
  now.value = Date.now();
}, 1000);
