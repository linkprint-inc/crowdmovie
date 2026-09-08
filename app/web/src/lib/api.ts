/*
 * Typed client for the Fastify API. Shapes come from the route implementations
 * under app/server/src/web/routes/, which are authoritative over the docs.
 *
 * Endpoints that do not exist yet are declared here against their documented
 * shape. They answer 404 until they ship, which ApiError reports as
 * `notImplemented` so callers render an empty state rather than an error.
 */
import type { SubmissionKind } from "./grapheme";

/* ------------------------------------------------------------------ types */

export type IdentityState = "anonymous" | "guest" | "account";

export interface Identity {
  state: IdentityState;
  username?: string;
}

export type RoundStatus =
  | "open"
  | "selecting"
  | "selected"
  | "generating"
  | "validating"
  | "published"
  | "select_failed"
  | "generation_failed"
  | "validation_failed";

export interface CurrentRound {
  movieId?: string;
  roundId: string;
  roundIndex: number;
  status: RoundStatus;
  opensAt: string;
  /** null 只用于 AI bootstrap 尚未认领的首轮；后继轮由服务器创建倒计时。 */
  closesAt: string | null;
  selectedSubmissionId: string | null;
  selectionMode: "crowd" | "ai" | "auto" | null;
  episodeIndex: number;
  episodeTitle: string;
}

export type SubmissionStatus = "pending" | "rejected" | "accepted";

export interface RoastText {
  en: string;
  "zh-CN": string;
  ja: string;
  es: string;
}

export interface SubmissionScore {
  total: number;
  roast: RoastText;
}

export interface Submission {
  id: string;
  username: string;
  content: string;
  status: SubmissionStatus;
  /** Actual round winner; score acceptance alone does not mean adoption. */
  selection?: "human" | "ai" | null;
  upCount: number;
  downCount: number;
  votesFrozen: boolean;
  createdAt: string;
  score: SubmissionScore | null;
}

export interface GenerationPrompt {
  mode: "current" | "latest";
  roundIndex: number;
  status: RoundStatus;
  prompt: string;
  durationSeconds: number | null;
}

export interface SubmissionRound {
  roundIndex: number;
  /** Optional while an older API version is still serving the frontend. */
  status?: RoundStatus;
  sceneIndex?: number | null;
  sceneTakenDown?: boolean;
  submissions: Submission[];
}

export interface RoundSubmissions {
  roundId: string | null;
  roundIndex: number | null;
  /** Every earlier round with pitches, oldest first, for reload-safe UI. */
  archive?: SubmissionRound[];
  submissions: Submission[];
  /** Older rows exist before this page's oldest row. */
  hasMore: boolean;
  /** Opaque keyset cursor; null once the first-ever submission is loaded. */
  nextCursor: string | null;
}

export interface CreatedSubmission {
  id: string;
  kind: SubmissionKind;
  roundId: string | null;
  episodeId: string;
  createdAt: string;
  status: "pending";
}

export interface VoteResult {
  submissionId: string;
  value: 1 | -1 | 0;
  upCount: number;
  downCount: number;
  /** True only for the vote that closed the round on its first net +10 pitch. */
  crowdAdopted: boolean;
}

/** Documented but not implemented server-side yet — see §16.3. */
export interface EpisodeSummary {
  episodeIndex: number;
  title: string;
  premise: string;
  status: "open" | "ended";
  sceneCount: number;
  submissionCount: number;
  themeSourceUsername: string | null;
  themeSourceVotes: number | null;
  storyOutline: Array<{ sceneIndex: number; summaryZh: string }>;
}

export interface EpisodeDetail extends EpisodeSummary {
  topSubmissions: Submission[];
}

export interface Proposal {
  id: string;
  username: string;
  content: string;
  upCount: number;
  downCount: number;
  createdAt: string;
}

export interface EpisodeBanner {
  episodeIndex: number;
  title: string;
  themeSourceUsername: string | null;
  proposalCount: number;
  status: "open" | "ended";
  /** Ordered summaries written by the Sol director for published scenes. */
  storyOutline: Array<{
    sceneIndex: number;
    summaryZh: string;
  }>;
}

/**
 * §14.2's shape, under §14.2's names. The server also echoes `videoSceneId` /
 * `videoTimeMs` for the player that shipped before this file existed; nothing
 * here reads them, so those two aliases can be dropped server-side.
 */
export interface Danmaku {
  id: string;
  username: string;
  content: string;
  sceneIndex: number;
  offsetMs: number;
  createdAt: string;
}

/** The anchor §14.1 requires: a real published scene and a position inside it. */
export interface DanmakuAnchor {
  sceneIndex: number;
  offsetMs: number;
}

export interface SceneDanmaku {
  sceneIndex: number;
  total: number;
  /** §14.2: over 500 comments on one scene come back evenly sampled. */
  truncated: boolean;
  danmaku: Danmaku[];
}

/** §12 的草稿箱: one row per kind, `PRIMARY KEY (user_id, kind)`. */
export type DraftKind = "next_shot" | "next_episode" | "danmaku";

export interface ServerDraft {
  movieSlug?: string;
  kind: DraftKind;
  body: string;
  updatedAt: string;
}

export interface MyStats {
  submissions: number;
  accepted: number;
  netVotes: number;
  episodes: number;
  themesSet: number;
}

export interface MySubmission {
  id: string;
  kind: SubmissionKind;
  episodeIndex: number | null;
  roundIndex: number | null;
  content: string;
  /** The 初评 verdict (§6.3) — which is not the same fact as `adopted`. */
  status: SubmissionStatus;
  score: number | null;
  netVotes: number;
  isEpisodeTheme: boolean;
  /** True once this pitch became a scene that is still live (§17.32). */
  adopted: boolean;
  /** That scene's index, for the credit the reader can go and watch. */
  sceneIndex: number | null;
  createdAt: string;
}

export interface MySubmissionPage {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  submissions: MySubmission[];
}

export interface HallEntry {
  username: string;
  acceptedCount: number;
  netVotes: number;
  /** The first episode they set the theme of — kept for the row's medal. */
  themeEpisodeIndex: number | null;
  /** Every episode theme they authored; empty for most contributors. */
  themeEpisodeIndexes?: number[];
}

/**
 * §11's playlist entry, under §11's names. The entry the spec draws has four
 * fields and no more; `src` / `tracks` / `durationMs` are the same data under
 * the pre-spec player's names and nothing here reads them any more.
 *
 * `authorUsername` is the one field that is *not* an alias — §11's entry does
 * not carry the scene's contributor credit at all, and the player's chrome bar
 * is the only place that credit is shown. It is optional here so the page
 * survives its removal, but removing it removes the credit line with it.
 */
export interface PlaylistScene {
  sceneIndex: number;
  episodeIndex: number;
  videoUrl: string;
  /** One WebVTT URL per locale (§11: all four, never guessed by the client). */
  subtitles: Record<string, string>;
  authorUsername?: string | null;
}

export interface MovieSummary {
  id: string;
  slug: string;
  titleI18n: Record<string, string>;
  synopsisI18n: Record<string, string>;
  posterUrl: string | null;
  /** Two character images followed by two world images for the picker mosaic. */
  posterImages?: string[];
  /** Full movie setting from the matching published story bible. */
  storySetting?: string | null;
  heroUrl: string | null;
  sceneStillUrl?: string | null;
  defaultLocale: string;
  primaryAudioLocale: string;
  subtitleLocales: string[];
  productionStatus: "ready" | "blocked" | "paused";
  rightsStatus: "blocked" | "original_cleared" | "licensed";
}

export interface CurrentProgram {
  generatorKey: string;
  timezone: string;
  state: "active" | "switching" | "blocked";
  movie: MovieSummary;
  activeMovieId: string | null;
  roundIndex: number | null;
  startsAt: string;
  endsAt: string;
  serverNow: string;
}

export interface MovieCharacter {
  key: string;
  position: number;
  copyI18n: Record<
    string,
    { name?: string; role?: string; bio?: string; archetype?: string; grade?: string; personality?: string; props?: string; fn?: string; voice?: string }
  >;
  visualIdentity: unknown;
  referenceAssets: unknown;
}

/* --------------------------------------------------- 故事设定（规范 §4） */

export type StoryStatus = "draft" | "pending" | "approved" | "rejected" | "review_failed";

export type StoryImageKind = "character" | "world";

export interface StoryPreviewImage {
  kind: StoryImageKind;
  url: string;
}

export interface StorySummary {
  id: string;
  title: string;
  authorUsername: string;
  likeCount: number;
  commentCount: number;
  publishedAt: string;
  /** 全部人物图与设定图，人物在前，各组按 position 排序。 */
  previewImages: StoryPreviewImage[];
}

export interface StoryPage {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  sort: "hot" | "new";
  stories: StorySummary[];
}

export interface StoryImage {
  position: number;
  caption: string;
  url: string;
}

export interface StoryDetail {
  id: string;
  title: string;
  synopsis: string;
  authorUsername: string;
  likeCount: number;
  commentCount: number;
  publishedAt: string;
  likedByMe: boolean;
  characters: StoryImage[];
  worlds: StoryImage[];
}

export interface StoryComment {
  id: number;
  floor: number;
  username: string;
  content: string;
  createdAt: string;
}

export interface StoryCommentPage {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  comments: StoryComment[];
}

/** 作者自己看到的那一份，含拒稿理由。 */
export interface MyStoryProposal {
  id: string;
  title: string;
  synopsis: string;
  status: StoryStatus;
  rejectReason: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  publishedAt: string | null;
}

export interface MyStoryImage {
  id: string;
  kind: StoryImageKind;
  position: number;
  caption: string;
  url: string;
}

/**
 * 当前在写或在审的那份，带着它自己的图片。
 *
 * `GET /api/stories/:id` only serves published proposals, so this is the only
 * shape that can repopulate the editor's twelve slots after a reload.
 */
export interface MyStoryDraft extends MyStoryProposal {
  images: MyStoryImage[];
}

export interface MyStory {
  draft: MyStoryDraft | null;
  proposals: MyStoryProposal[];
}

export interface UploadedStoryImage {
  id: string;
  kind: StoryImageKind;
  position: number;
  caption: string;
  url: string;
  mime: string;
  bytes: number;
}

/* ------------------------------------------------------------------ error */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** `max` on content_too_long, `username` on already_identified. */
  readonly detail: Record<string, unknown>;

  constructor(status: number, code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  /**
   * True when the endpoint itself is not built yet, rather than when a call
   * failed. Keyed off the status, not the code: an unmatched route comes back
   * in Fastify's default envelope whose `error` is the status phrase ("Not
   * Found"), so there is no app code to match on. The server's only meaningful
   * 404 is submission_not_found.
   */
  get notImplemented(): boolean {
    return this.status === 404 && this.code !== "submission_not_found";
  }
}

/* ----------------------------------------------------------------- client */

type Json = Record<string, unknown>;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      // Session identity is carried entirely by the cm_session / cm_guest
      // cookies; there is no token header and no CSRF token.
      credentials: "include",
      ...init,
      headers: {
        Accept: "application/json",
        // Fastify answers 415 for a POST body without this.
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(0, "network", "network request failed");
  }

  let body: Json = {};
  if (res.status !== 204) {
    try {
      body = (await res.json()) as Json;
    } catch {
      body = {};
    }
  }

  if (!res.ok) {
    // Two envelopes exist: the handlers' {error, message} and Fastify's
    // default {statusCode, error, message}. Fastify's `error` is a status
    // phrase ("Not Found"), not a machine code, so only trust it when the
    // response did not come from Fastify's own error serialiser.
    const fastifyDefault = typeof body.statusCode === "number";
    const code = !fastifyDefault && typeof body.error === "string" ? body.error : httpCode(res.status);
    const message = typeof body.message === "string" ? body.message : `HTTP ${res.status}`;
    throw new ApiError(res.status, code, message, body);
  }

  return body as T;
}

function httpCode(status: number): string {
  if (status === 404) return "not_implemented";
  if (status === 401) return "identity_required";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "http_error";
}

/**
 * POST a file as the raw request body.
 *
 * Deliberately not `request()`: that helper JSON-encodes anything with a body
 * and stamps `Content-Type: application/json`, which the upload endpoint
 * answers 415 for. The file's own type is the header.
 */
async function postFile<T>(path: string, file: File): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: file,
    headers: { "Content-Type": file.type },
  });
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
}

function put<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PUT", body: JSON.stringify(body) });
}

function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

/* -------------------------------------------------------------- endpoints */

export const api = {
  /* --- implemented server-side --- */

  identity: () => request<Identity>("/api/identity"),

  claimGuest: (username: string) =>
    post<{ id: string; username: string }>("/api/identity/guest", { username }),

  register: (input: { username?: string; email: string; password: string }) =>
    post<{ id: string; username: string; state: "account" }>("/api/auth/register", input),

  login: (identifier: string, password: string) =>
    post<{ id: string; username: string; state: "account" }>("/api/auth/login", {
      identifier,
      password,
    }),

  logout: () => post<{ ok: true }>("/api/auth/logout"),

  movies: () => request<{ movies: MovieSummary[] }>("/api/movies"),

  generationPrompt: (movieSlug: string) =>
    request<{ generation: GenerationPrompt | null }>(`/api/movies/${encodeURIComponent(movieSlug)}/generation-prompt`),

  currentProgram: () => request<CurrentProgram>("/api/program/current"),

  movie: (movieSlug: string) =>
    request<MovieSummary>(`/api/movies/${encodeURIComponent(movieSlug)}`),

  movieCharacters: (movieSlug: string) =>
    request<{ movieId: string; characters: MovieCharacter[] }>(
      `/api/movies/${encodeURIComponent(movieSlug)}/characters`,
    ),

  currentRound: (movieSlug?: string) =>
    request<CurrentRound>(
      movieSlug === undefined
        ? "/api/round/current"
        : `/api/movies/${encodeURIComponent(movieSlug)}/round/current`,
    ),

  currentSubmissions: (movieSlug?: string, before?: string) => {
    const base =
      movieSlug === undefined
        ? "/api/round/current/submissions"
        : `/api/movies/${encodeURIComponent(movieSlug)}/round/current/submissions`;
    const query = before === undefined ? "" : `?before=${encodeURIComponent(before)}`;
    return request<RoundSubmissions>(`${base}${query}`);
  },

  submit: (kind: SubmissionKind, content: string, movieSlug?: string) =>
    post<CreatedSubmission>(
      movieSlug === undefined
        ? "/api/round/current/submissions"
        : `/api/movies/${encodeURIComponent(movieSlug)}/round/current/submissions`,
      { kind, content },
    ),

  vote: (submissionId: string, value: 1 | -1 | 0) =>
    post<VoteResult>(`/api/submissions/${encodeURIComponent(submissionId)}/vote`, { value }),

  playlist: (
    movieSlug?: string,
    episodeIndex?: number | null,
    afterSceneIndex?: number,
  ) => {
    if (movieSlug === undefined) {
      const query =
        afterSceneIndex === undefined ? "" : `?afterSceneIndex=${afterSceneIndex}`;
      return request<{ scenes: PlaylistScene[] }>(`/api/movie/playlist${query}`);
    }
    const base = `/api/movies/${encodeURIComponent(movieSlug)}`;
    const path =
      episodeIndex === undefined || episodeIndex === null
        ? `${base}/playlist`
        : `${base}/episodes/${episodeIndex}/playlist`;
    const query =
      afterSceneIndex === undefined ? "" : `?afterSceneIndex=${afterSceneIndex}`;
    return request<{ scenes: PlaylistScene[] }>(`${path}${query}`);
  },

  recentDanmaku: (movieSlug?: string) =>
    request<{ danmaku: Danmaku[] }>(
      movieSlug === undefined
        ? "/api/danmaku/recent"
        : `/api/movies/${encodeURIComponent(movieSlug)}/danmaku/recent`,
    ),

  /** §14.2: the comment track for one scene, ordered by `offsetMs`. */
  sceneDanmaku: (sceneIndex: number, movieSlug?: string) =>
    request<SceneDanmaku>(
      movieSlug === undefined
        ? `/api/movie/scenes/${sceneIndex}/danmaku`
        : `/api/movies/${encodeURIComponent(movieSlug)}/scenes/${sceneIndex}/danmaku`,
    ),

  /**
   * §14.1: the anchor is required and is never invented. `sceneIndex` is the
   * scene being watched and `offsetMs` the playback position inside it; the
   * server rejects an index that is not a published scene and an offset past
   * that scene's measured duration.
   */
  sendDanmaku: (content: string, anchor: DanmakuAnchor, movieSlug?: string) =>
    post<Danmaku>("/api/danmaku", {
      content,
      movieSlug,
      sceneIndex: anchor.sceneIndex,
      offsetMs: anchor.offsetMs,
    }),

  /* --- documented in §16.3, may still answer 404 --- */

  currentEpisode: () => request<EpisodeBanner>("/api/episode/current"),

  episodeProposals: () => request<{ proposals: Proposal[] }>("/api/episode/current/proposals"),

  episodes: (movieSlug?: string) =>
    request<{ episodes: EpisodeSummary[] }>(
      movieSlug === undefined
        ? "/api/episodes"
        : `/api/movies/${encodeURIComponent(movieSlug)}/episodes`,
    ),

  episode: (episodeIndex: number, movieSlug?: string) =>
    request<EpisodeDetail>(
      movieSlug === undefined
        ? `/api/episodes/${episodeIndex}`
        : `/api/movies/${encodeURIComponent(movieSlug)}/episodes/${episodeIndex}`,
    ),

  hallOfFame: () => request<{ entries: HallEntry[] }>("/api/hall-of-fame"),

  myStats: () => request<MyStats>("/api/me/stats"),

  mySubmissions: () => request<MySubmissionPage>("/api/me/submissions"),

  myDrafts: () => request<{ drafts: ServerDraft[] }>("/api/me/drafts"),

  /** §12「自动保存」— one kind per call, upserted over the row that is there. */
  saveDraft: (kind: DraftKind, body: string, movieSlug?: string) =>
    put<{ kind: DraftKind; body: string; updatedAt: string }>("/api/me/drafts", {
      movieSlug,
      kind,
      body,
    }),

  /** §15. `sceneIndex` is null unless the writer named a scene. */
  contact: (input: {
    category: string;
    movieSlug?: string;
    sceneIndex: number | null;
    body: string;
  }) =>
    post<{ ok: true }>("/api/contact", input),

  /* --- 故事设定（规范 §4） --- */

  stories: (options: { sort?: "hot" | "new"; limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams();
    if (options.sort !== undefined) query.set("sort", options.sort);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.offset !== undefined) query.set("offset", String(options.offset));
    const suffix = query.toString();
    return request<StoryPage>(`/api/stories${suffix === "" ? "" : `?${suffix}`}`);
  },

  story: (id: string) => request<StoryDetail>(`/api/stories/${id}`),

  storyComments: (id: string, options: { limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.offset !== undefined) query.set("offset", String(options.offset));
    const suffix = query.toString();
    return request<StoryCommentPage>(
      `/api/stories/${id}/comments${suffix === "" ? "" : `?${suffix}`}`,
    );
  },

  commentOnStory: (id: string, content: string) =>
    post<StoryComment>(`/api/stories/${id}/comments`, { content }),

  likeStory: (id: string, value: 1 | 0) =>
    post<{ storyId: string; likeCount: number; likedByMe: boolean }>(
      `/api/stories/${id}/like`,
      { value },
    ),

  /* --- 编辑器（仅注册账号） --- */

  myStory: () => request<MyStory>("/api/me/story"),

  createStory: () => post<MyStoryProposal>("/api/stories"),

  saveStory: (id: string, input: { title: string; synopsis: string }) =>
    put<MyStoryProposal>(`/api/stories/${id}`, input),

  deleteStory: (id: string) => del<void>(`/api/stories/${id}`),

  uploadStoryImage: (id: string, kind: StoryImageKind, position: number, file: File) =>
    postFile<UploadedStoryImage>(
      `/api/stories/${id}/images?kind=${kind}&position=${position}`,
      file,
    ),

  saveStoryCaption: (id: string, imageId: string, caption: string) =>
    put<UploadedStoryImage>(`/api/stories/${id}/images/${imageId}`, { caption }),

  deleteStoryImage: (id: string, imageId: string) =>
    del<void>(`/api/stories/${id}/images/${imageId}`),

  submitStory: (id: string) => post<MyStoryProposal>(`/api/stories/${id}/submit`),

  reopenStory: (id: string) => post<MyStoryProposal>(`/api/stories/${id}/reopen`),
};
