// CrowdAIMovie database schema — a column-for-column transcription of the
// authoritative versioned SQL migrations (merged with the
// per-table detail in §3.1, §5.1, §5.4, §6.3, §6.6, §14.1, §15). §16.1 is the
// single source of truth for field names, types, NULLability, CHECK constraints,
// the two partial unique indexes, and — together with §16.2 — the secondary
// indexes. Fields are neither added, renamed, nor dropped.
//
// Faithful-expansion decisions (documented for review; none change a field's
// name / type / declared NULLability / declared constraints):
//   * UUID primary keys get `DEFAULT gen_random_uuid()` (`.defaultRandom()`).
//     The spec fixes generation for the one non-UUID PK (`danmaku.id` is
//     GENERATED ALWAYS AS IDENTITY); the UUID PKs are left generation-agnostic
//     in prose, so we apply the conventional server-side default. PG 18 ships
//     gen_random_uuid() in core.
//   * `created_at` / `updated_at` get `TIMESTAMPTZ NOT NULL DEFAULT now()`,
//     following the one fully-spelled-out timestamp in the spec
//     (`danmaku.created_at TIMESTAMPTZ NOT NULL DEFAULT now()`).
//   * Where the spec writes only a bare column name (mostly the shorthand
//     timestamp groups like `created_at / upgraded_at` and the terse
//     §5.1/§6.6 tables), the type is inferred from the name and NULLability
//     follows SQL's own default — nullable unless the spec writes NOT NULL, the
//     column is a (part of a) PRIMARY KEY, it is a `field: enum | values`
//     categorical column, or it is a counter mirroring the spec's explicit
//     `up_count/down_count INT NOT NULL DEFAULT 0` pattern.
//   * Foreign keys follow §16.1「外键取舍（明确约定，不是遗漏）」:
//     - Credit-attribution references DO get a FK, because a dangling ID would
//       mis-attribute a published scene: `episodes.theme_source_submission_id`
//       and `rounds.selected_submission_id` (both nullable). The resulting
//       cycle with `submissions.episode_id` / `submissions.round_id` is legal
//       in PostgreSQL and harmless here — rows are always inserted
//       submission-first, and submissions/rounds are never physically deleted
//       (takedown is a soft flag).
//     - Audit / ledger references deliberately get NO FK: `ai_runs.round_id`,
//       `ai_runs.submission_id`, `workflow_jobs.round_id` (append-only tables on
//       the hottest write path — no FK lock overhead, and they must outlive the
//       rows they reference), and `contact_messages.scene_index` (an abuse
//       report must survive the scene's deletion; validity is enforced by the
//       §15 application-level check).

import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const tstz = (name: string) => timestamp(name, { withTimezone: true });

// --- 身份与账号 (§3.1) --------------------------------------------------------

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  usernameDisplay: text('username_display').notNull(),
  usernameKey: text('username_key').notNull().unique(),
  emailKey: text('email_key').unique(), // 游客为 NULL
  passwordHash: text('password_hash'), // NULL=游客，NOT NULL=账号
  emailVerifiedAt: tstz('email_verified_at'),
  guestTokenHash: text('guest_token_hash'),
  role: text('role').notNull().default('user'), // user | admin
  bannedAt: tstz('banned_at'),
  banReason: text('ban_reason'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  upgradedAt: tstz('upgraded_at'),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: tstz('created_at').notNull().defaultNow(),
  lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
  expiresAt: tstz('expires_at').notNull(),
  revokedAt: tstz('revoked_at'),
});

export const passwordResets = pgTable('password_resets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: tstz('expires_at').notNull(), // 建议 30 分钟
  usedAt: tstz('used_at'),
  createdAt: tstz('created_at').notNull().defaultNow(),
});

// --- 影片主数据 ---------------------------------------------------------------

export const movies = pgTable(
  'movies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    titleI18n: jsonb('title_i18n').notNull(),
    synopsisI18n: jsonb('synopsis_i18n').notNull(),
    posterUrl: text('poster_url'),
    heroUrl: text('hero_url'),
    defaultLocale: text('default_locale').notNull(),
    primaryAudioLocale: text('primary_audio_locale').notNull(),
    subtitleLocales: jsonb('subtitle_locales').notNull(),
    status: text('status').notNull(), // draft | published | archived
    productionStatus: text('production_status').notNull(), // ready | blocked | paused
    rightsStatus: text('rights_status').notNull(), // blocked | original_cleared | licensed
    sourceType: text('source_type').notNull(), // staff_original | story_proposal
    displayOrder: smallint('display_order').notNull().default(0),
    publishedAt: tstz('published_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('movies_status_ck', sql`${t.status} IN ('draft','published','archived')`),
    check(
      'movies_production_status_ck',
      sql`${t.productionStatus} IN ('ready','blocked','paused')`,
    ),
    check(
      'movies_rights_status_ck',
      sql`${t.rightsStatus} IN ('blocked','original_cleared','licensed')`,
    ),
    check(
      'movies_source_type_ck',
      sql`${t.sourceType} IN ('staff_original','story_proposal')`,
    ),
    index('movies_public_display_idx')
      .on(t.displayOrder, t.createdAt)
      .where(sql`${t.status} = 'published'`),
  ],
);

export const movieBibleVersions = pgTable(
  'movie_bible_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    movieId: uuid('movie_id')
      .notNull()
      .references(() => movies.id),
    version: integer('version').notNull(),
    status: text('status').notNull(), // draft | active | retired
    storyRules: jsonb('story_rules').notNull(),
    worldRules: jsonb('world_rules').notNull(),
    stylePrompt: text('style_prompt').notNull(),
    negativePrompt: text('negative_prompt').notNull(),
    cameraRules: jsonb('camera_rules').notNull(),
    workflowProfile: jsonb('workflow_profile').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    activatedAt: tstz('activated_at'),
  },
  (t) => [
    check(
      'movie_bible_versions_status_ck',
      sql`${t.status} IN ('draft','active','retired')`,
    ),
    unique('movie_bible_versions_movie_version_uq').on(t.movieId, t.version),
    unique('movie_bible_versions_id_movie_uq').on(t.id, t.movieId),
    uniqueIndex('movie_bible_versions_one_active_uq')
      .on(t.movieId)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const movieCharacters = pgTable(
  'movie_characters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    movieId: uuid('movie_id')
      .notNull()
      .references(() => movies.id),
    characterKey: text('character_key').notNull(),
    position: smallint('position').notNull(),
    publicCopyI18n: jsonb('public_copy_i18n').notNull(),
    status: text('status').notNull(), // active | retired
  },
  (t) => [
    check(
      'movie_characters_status_ck',
      sql`${t.status} IN ('active','retired')`,
    ),
    unique('movie_characters_movie_key_uq').on(t.movieId, t.characterKey),
    unique('movie_characters_movie_position_uq').on(t.movieId, t.position),
    unique('movie_characters_id_movie_uq').on(t.id, t.movieId),
  ],
);

export const movieCharacterVersions = pgTable(
  'movie_character_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    movieId: uuid('movie_id')
      .notNull()
      .references(() => movies.id),
    bibleVersionId: uuid('bible_version_id').notNull(),
    characterId: uuid('character_id').notNull(),
    visualIdentity: jsonb('visual_identity').notNull(),
    referenceAssets: jsonb('reference_assets').notNull(),
    consistencyAdapter: jsonb('consistency_adapter').notNull(),
    voiceProfile: jsonb('voice_profile').notNull(),
  },
  (t) => [
    unique('movie_character_versions_bible_character_uq').on(
      t.bibleVersionId,
      t.characterId,
    ),
    foreignKey({
      columns: [t.bibleVersionId, t.movieId],
      foreignColumns: [movieBibleVersions.id, movieBibleVersions.movieId],
      name: 'movie_character_versions_bible_movie_fk',
    }),
    foreignKey({
      columns: [t.characterId, t.movieId],
      foreignColumns: [movieCharacters.id, movieCharacters.movieId],
      name: 'movie_character_versions_character_movie_fk',
    }),
  ],
);

export const movieAssets = pgTable(
  'movie_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    movieId: uuid('movie_id')
      .notNull()
      .references(() => movies.id),
    kind: text('kind').notNull(),
    storageUrl: text('storage_url').notNull(),
    sha256: text('sha256').notNull(),
    rightsStatus: text('rights_status').notNull(), // pending | original | licensed | rejected
    evidenceRef: text('evidence_ref'),
    expiresAt: tstz('expires_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'movie_assets_rights_status_ck',
      sql`${t.rightsStatus} IN ('pending','original','licensed','rejected')`,
    ),
    index('movie_assets_movie_kind_idx').on(t.movieId, t.kind),
  ],
);

export const movieSources = pgTable('movie_sources', {
  movieId: uuid('movie_id')
    .primaryKey()
    .references(() => movies.id),
  storyProposalId: uuid('story_proposal_id').unique().references(
    (): AnyPgColumn => storyProposals.id,
  ),
  authorUserId: uuid('author_user_id').references(() => users.id),
  proposalSnapshot: jsonb('proposal_snapshot').notNull(),
  adaptationGrantVersion: text('adaptation_grant_version'),
  adaptationGrantedAt: tstz('adaptation_granted_at'),
  attributionText: text('attribution_text'),
  selectedBy: uuid('selected_by').references(() => users.id),
  selectedAt: tstz('selected_at').notNull().defaultNow(),
});

export const storyGenerators = pgTable(
  'story_generators',
  {
    key: text('key').primaryKey(),
    timezone: text('timezone').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    leaseMovieId: uuid('lease_movie_id').references(() => movies.id),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: tstz('lease_expires_at'),
    heartbeatAt: tstz('heartbeat_at'),
  },
  (t) => [
    check(
      'story_generators_lease_ck',
      sql`(${t.leaseMovieId} IS NULL AND ${t.leaseToken} IS NULL AND ${t.leaseExpiresAt} IS NULL) OR (${t.leaseMovieId} IS NOT NULL AND ${t.leaseToken} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL)`,
    ),
  ],
);

export const movieScheduleWindows = pgTable(
  'movie_schedule_windows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    generatorKey: text('generator_key')
      .notNull()
      .references(() => storyGenerators.key),
    movieId: uuid('movie_id')
      .notNull()
      .references(() => movies.id),
    startMinute: smallint('start_minute').notNull(),
    endMinute: smallint('end_minute').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    label: text('label').notNull(),
  },
  (t) => [
    check(
      'movie_schedule_windows_minutes_ck',
      sql`${t.startMinute} >= 0 AND ${t.startMinute} < ${t.endMinute} AND ${t.endMinute} <= 1440`,
    ),
    index('movie_schedule_windows_lookup_idx').on(
      t.generatorKey,
      t.enabled,
      t.startMinute,
      t.endMinute,
    ),
  ],
);

// --- 剧情主循环 (§5.4) --------------------------------------------------------

export const episodes = pgTable(
  'episodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    movieId: uuid('movie_id')
      .notNull()
      .references(() => movies.id),
    bibleVersionId: uuid('bible_version_id').notNull(),
    episodeIndex: integer('episode_index').notNull(),
    title: text('title').notNull(),
    theme: text('theme').notNull(),
    // 民选主题来源；NULL = AI 自拟。复合 FK 在迁移中避免循环声明歧义。
    themeSourceSubmissionId: uuid('theme_source_submission_id'),
    status: text('status').notNull(), // open | ended
    openedAt: tstz('opened_at').notNull().defaultNow(),
    endedAt: tstz('ended_at'),
    endReason: text('end_reason'),
  },
  (t) => [
    unique('episodes_movie_index_uq').on(t.movieId, t.episodeIndex),
    unique('episodes_id_movie_uq').on(t.id, t.movieId),
    uniqueIndex('episodes_one_open_per_movie_uq')
      .on(t.movieId)
      .where(sql`${t.status} = 'open'`),
    foreignKey({
      columns: [t.bibleVersionId, t.movieId],
      foreignColumns: [movieBibleVersions.id, movieBibleVersions.movieId],
      name: 'episodes_bible_movie_fk',
    }),
  ],
);

export const rounds = pgTable(
  'rounds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    movieId: uuid('movie_id')
      .notNull()
      .references(() => movies.id),
    roundIndex: bigint('round_index', { mode: 'number' }).notNull(),
    episodeId: uuid('episode_id').notNull(),
    // open|selecting|selected|generating|validating|published|select_failed|generation_failed|validation_failed
    status: text('status').notNull(),
    opensAt: tstz('opens_at').notNull(),
    // NULL 表示本轮还没有点火：没有任何投稿的轮次不走时钟，也不占用编号（§5.3）。
    // 第一条 next_shot 投稿在同一个事务里写入 `now() + ROUND_LENGTH_MS`。
    closesAt: tstz('closes_at'),
    selectedSubmissionId: uuid('selected_submission_id'),
    selectionMode: text('selection_mode'), // crowd | ai | auto
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('rounds_movie_index_uq').on(t.movieId, t.roundIndex),
    unique('rounds_id_episode_movie_uq').on(t.id, t.episodeId, t.movieId),
    uniqueIndex('rounds_one_open_global_uq')
      .on(t.status)
      .where(sql`${t.status} = 'open'`),
    foreignKey({
      columns: [t.episodeId, t.movieId],
      foreignColumns: [episodes.id, episodes.movieId],
      name: 'rounds_episode_movie_fk',
    }),
  ],
);

export const submissions = pgTable(
  'submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    movieId: uuid('movie_id')
      .notNull()
      .references(() => movies.id),
    kind: text('kind').notNull(), // next_shot | next_episode
    roundId: uuid('round_id'), // next_shot 必填
    episodeId: uuid('episode_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    content: text('content').notNull(),
    contentLanguage: text('content_language'),
    status: text('status').notNull().default('pending'), // pending | rejected | accepted
    upCount: integer('up_count').notNull().default(0),
    downCount: integer('down_count').notNull().default(0),
    votesFrozenAt: tstz('votes_frozen_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'submissions_kind_round_ck',
      sql`(${t.kind} = 'next_shot') = (${t.roundId} IS NOT NULL)`,
    ),
    uniqueIndex('submissions_next_shot_round_user_uq')
      .on(t.roundId, t.userId)
      .where(sql`${t.kind} = 'next_shot'`),
    uniqueIndex('submissions_next_episode_ep_user_uq')
      .on(t.episodeId, t.userId)
      .where(sql`${t.kind} = 'next_episode'`),
    unique('submissions_id_movie_uq').on(t.id, t.movieId),
    foreignKey({
      columns: [t.episodeId, t.movieId],
      foreignColumns: [episodes.id, episodes.movieId],
      name: 'submissions_episode_movie_fk',
    }),
    foreignKey({
      columns: [t.roundId, t.episodeId, t.movieId],
      foreignColumns: [rounds.id, rounds.episodeId, rounds.movieId],
      name: 'submissions_round_episode_movie_fk',
    }),
    // §16.2 派生数据索引
    index('submissions_user_id_created_at_idx').on(t.userId, t.createdAt.desc()),
    index('submissions_episode_id_kind_idx').on(t.episodeId, t.kind),
    index('submissions_movie_timeline_idx')
      .on(t.movieId, t.createdAt.desc(), t.id.desc())
      .where(sql`${t.kind} = 'next_shot'`),
  ],
);

export const submissionScores = pgTable(
  'submission_scores',
  {
    submissionId: uuid('submission_id')
      .primaryKey()
      .references(() => submissions.id),
    eligible: boolean('eligible').notNull(),
    scoreTotal: smallint('score_total'), // CHECK 0..100 below (nullable per spec)
    scoreBreakdown: jsonb('score_breakdown').notNull(), // 内部，不对外
    reason: text('reason').notNull(), // 内部，不对外
    publicRoast: jsonb('public_roast').notNull(), // {en, zh-CN, ja, es}
    riskFlags: jsonb('risk_flags').notNull(), // 内部，不对外
    rubricVersion: text('rubric_version').notNull(),
    aiRunId: uuid('ai_run_id')
      .notNull()
      .references(() => aiRuns.id),
    scoredAt: tstz('scored_at').notNull(),
  },
  (t) => [
    check(
      'submission_scores_score_total_ck',
      sql`${t.scoreTotal} BETWEEN 0 AND 100`,
    ),
  ],
);

export const submissionVotes = pgTable(
  'submission_votes',
  {
    submissionId: uuid('submission_id').references(() => submissions.id),
    userId: uuid('user_id').references(() => users.id),
    value: smallint('value').notNull(), // CHECK (value IN (1,-1)) below
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.submissionId, t.userId] }),
    check('submission_votes_value_ck', sql`${t.value} IN (1, -1)`),
  ],
);

export const scenes = pgTable(
  'scenes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    movieId: uuid('movie_id')
      .notNull()
      .references(() => movies.id),
    sceneIndex: integer('scene_index').notNull(), // 影片内永不回收、永不重排
    episodeId: uuid('episode_id').notNull(),
    roundId: uuid('round_id').notNull().unique(),
    creditUserId: uuid('credit_user_id').references(() => users.id), // 自动续写为 NULL
    sourceSubmissionId: uuid('source_submission_id').references(
      () => submissions.id,
    ),
    summaryZh: text('summary_zh').notNull(),
    durationSeconds: numeric('duration_seconds', {
      precision: 6,
      scale: 3,
    }).notNull(), // ffprobe 实测
    media: jsonb('media').notNull(), // {video, sha256, subtitles:{en,zh-CN,ja,es}}
    directorAiRunId: uuid('director_ai_run_id')
      .notNull()
      .references(() => aiRuns.id),
    subtitleAiRunId: uuid('subtitle_ai_run_id')
      .notNull()
      .references(() => aiRuns.id),
    episodeShouldEnd: boolean('episode_should_end').notNull(),
    publishedAt: tstz('published_at').notNull(),
    takedownAt: tstz('takedown_at'), // 运营下架
    takedownReason: text('takedown_reason'),
  },
  (t) => [
    unique('scenes_movie_index_uq').on(t.movieId, t.sceneIndex),
    foreignKey({
      columns: [t.episodeId, t.movieId],
      foreignColumns: [episodes.id, episodes.movieId],
      name: 'scenes_episode_movie_fk',
    }),
    foreignKey({
      columns: [t.roundId, t.episodeId, t.movieId],
      foreignColumns: [rounds.id, rounds.episodeId, rounds.movieId],
      name: 'scenes_round_episode_movie_fk',
    }),
    // §16.2 派生数据索引
    index('scenes_credit_user_id_idx').on(t.creditUserId),
    index('scenes_movie_episode_id_idx').on(t.movieId, t.episodeId),
  ],
);

// --- 互动与页面支撑 (§14.1, §15) ---------------------------------------------

export const danmaku = pgTable(
  'danmaku',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    movieId: uuid('movie_id')
      .notNull()
      .references(() => movies.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    sceneIndex: integer('scene_index').notNull(),
    offsetMs: integer('offset_ms').notNull(), // CHECK (offset_ms >= 0) below
    content: text('content').notNull(),
    contentLanguage: text('content_language'),
    status: text('status').notNull().default('visible'), // visible | hidden
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('danmaku_offset_ms_ck', sql`${t.offsetMs} >= 0`),
    foreignKey({
      columns: [t.sceneIndex, t.movieId],
      foreignColumns: [scenes.sceneIndex, scenes.movieId],
      name: 'danmaku_scene_movie_fk',
    }),
    // §16.2 派生数据索引
    index('danmaku_movie_scene_offset_ms_idx').on(
      t.movieId,
      t.sceneIndex,
      t.offsetMs,
    ),
    index('danmaku_created_at_idx').on(t.createdAt),
  ],
);

export const drafts = pgTable(
  'drafts',
  {
    userId: uuid('user_id').references(() => users.id),
    movieId: uuid('movie_id')
      .notNull()
      .references(() => movies.id),
    kind: text('kind').notNull(), // next_shot | next_episode | danmaku
    body: text('body').notNull().default(''),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.movieId, t.kind] })], // 每影片每类各保留一份
);

export const submissionTranslations = pgTable(
  'submission_translations',
  {
    submissionId: uuid('submission_id').references(() => submissions.id),
    locale: text('locale').notNull(), // en | zh-CN | ja | es
    text: text('text').notNull(),
    aiRunId: uuid('ai_run_id')
      .notNull()
      .references(() => aiRuns.id),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.submissionId, t.locale] })],
);

export const contactMessages = pgTable(
  'contact_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id), // 未登录访客为 NULL
    movieId: uuid('movie_id').references(() => movies.id),
    category: text('category').notNull(), // general | appeal | copyright | bug
    sceneIndex: integer('scene_index'), // 申诉时关联的片段；业务层校验影片归属
    body: text('body').notNull(),
    sourceIp: inet('source_ip'),
    status: text('status').notNull().default('open'), // open | handled | rejected
    createdAt: tstz('created_at').notNull().defaultNow(),
    handledAt: tstz('handled_at'),
  },
  (t) => [
    check(
      'contact_messages_movie_scene_ck',
      sql`(${t.movieId} IS NULL) = (${t.sceneIndex} IS NULL)`,
    ),
  ],
);

export const siteSettings = pgTable('site_settings', {
  key: text('key').primaryKey(), // 如 danmaku_enabled、vote_adopt_threshold_override
  value: jsonb('value').notNull(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

// --- 流程与审计 (§5.1, §6.6) --------------------------------------------------

export const aiRuns = pgTable('ai_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  movieId: uuid('movie_id')
    .notNull()
    .references(() => movies.id),
  roundId: uuid('round_id').notNull(), // 审计留痕，不建 FK（§16.1 外键取舍）
  submissionId: uuid('submission_id'), // 审计留痕，不建 FK（§16.1 外键取舍）
  runType: text('run_type').notNull(), // submission_score | round_final | scene_director | generation_event
  provider: text('provider').notNull(), // openai_codex
  model: text('model').notNull(), // gpt-5.6-sol
    reasoningEffort: text('reasoning_effort').notNull(), // none | high | xhigh
  codexThreadId: text('codex_thread_id'),
  promptPlanVersion: text('prompt_plan_version'),
  inputSha256: text('input_sha256'),
  outputJson: jsonb('output_json'),
  usageJson: jsonb('usage_json'),
  latencyMs: integer('latency_ms'),
  status: text('status').notNull(), // running | succeeded | retryable_failed | dead
  errorCode: text('error_code'),
  errorSummary: text('error_summary'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  finishedAt: tstz('finished_at'),
});

export const workflowJobs = pgTable(
  'workflow_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    movieId: uuid('movie_id').references(() => movies.id),
    roundId: uuid('round_id'), // 任务账本，不建 FK（§16.1 外键取舍）
    jobType: text('job_type').notNull(), // submission_score | round_finalize | episode_bootstrap | ai_screenwriter | scene_director | video_generate | subtitle_author | media_validate_publish | episode_theme | story_review | maintenance
    idempotencyKey: text('idempotency_key').unique(),
    status: text('status').notNull(), // pending | running | succeeded | retryable_failed | dead
    upstreamJobId: text('upstream_job_id'),
    payloadJson: jsonb('payload_json'),
    attemptCount: integer('attempt_count').notNull().default(0),
    availableAt: tstz('available_at').notNull().defaultNow(),
    leaseExpiresAt: tstz('lease_expires_at'),
    lastError: text('last_error'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    startedAt: tstz('started_at'),
    finishedAt: tstz('finished_at'),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'workflow_jobs_movie_scope_ck',
      sql`${t.jobType} IN ('story_review','maintenance') OR ${t.movieId} IS NOT NULL`,
    ),
  ],
);

// --- 用户提交的故事设定（《故事设定投稿技术规范》§3） -------------------------
//
// The four tables below are defined by the story-proposal SQL migrations,
// not by §16.1 of the technical doc — that section names them and points here.
//
// Two shapes differ from the tables above, both on purpose:
//   * ON DELETE CASCADE. Unlike submissions and scenes, which are never
//     physically deleted, a draft belongs to its author and can be thrown away;
//     when it goes, its images, likes and replies go with it.
//   * The review verdict is stored on the proposal row rather than in
//     `ai_runs`, whose `round_id` is NOT NULL. A story proposal belongs to no
//     round, and inventing one would corrupt that table's meaning.

export const storyProposals = pgTable(
  'story_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull().default(''),
    synopsis: text('synopsis').notNull().default(''),
    // draft | pending | approved | rejected | review_failed
    status: text('status').notNull().default('draft'),
    /** 公开给作者本人的拒绝理由。 */
    rejectReason: text('reject_reason'),
    /** 实际审核的模型标识；stub 跑的就记 stub（§5.3）。 */
    reviewModel: text('review_model'),
    /** 审核原始结论，内部留痕，不对外。 */
    reviewOutput: jsonb('review_output'),
    /**
     * Cache of the row count in `story_likes` for this proposal. Recomputed
     * under a row lock in the same transaction as each write to
     * story_likes, and deliberately never incremented in place — a plain
     * `SET like_count = like_count + 1` is exactly the race two concurrent
     * likes/unlikes would hit (§4.3).
     */
    likeCount: integer('like_count').notNull().default(0),
    /**
     * Cache of the row count in `story_comments` for this proposal. Same
     * rule as `likeCount`: recomputed under a row lock in the same
     * transaction as each write to story_comments, never incremented in
     * place (§3, §4.3).
     */
    commentCount: integer('comment_count').notNull().default(0),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
    submittedAt: tstz('submitted_at'),
    reviewedAt: tstz('reviewed_at'),
    /** 非 NULL 即在列表页可见。 */
    publishedAt: tstz('published_at'),
    takedownAt: tstz('takedown_at'),
    takedownReason: text('takedown_reason'),
  },
  (t) => [
    check(
      'story_proposals_status_ck',
      sql`${t.status} IN ('draft','pending','approved','rejected','review_failed')`,
    ),
    // 每人同时只有一份在写或在审。已发布或被拒之后可以再开新的。
    uniqueIndex('story_proposals_one_active_uq')
      .on(t.userId)
      .where(sql`${t.status} IN ('draft','pending')`),
    index('story_proposals_published_likes_idx')
      .on(t.likeCount.desc(), t.publishedAt.desc())
      .where(sql`${t.publishedAt} IS NOT NULL AND ${t.takedownAt} IS NULL`),
    index('story_proposals_published_at_idx')
      .on(t.publishedAt.desc())
      .where(sql`${t.publishedAt} IS NOT NULL AND ${t.takedownAt} IS NULL`),
    index('story_proposals_user_id_created_at_idx').on(
      t.userId,
      t.createdAt.desc(),
    ),
  ],
);

export const storyImages = pgTable(
  'story_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => storyProposals.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // character | world
    position: smallint('position').notNull(), // 0..5，即界面上的第几个格子
    caption: text('caption').notNull().default(''),
    fileUrl: text('file_url').notNull(),
    mime: text('mime').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('story_images_kind_ck', sql`${t.kind} IN ('character','world')`),
    check('story_images_position_ck', sql`${t.position} BETWEEN 0 AND 5`),
    // 2 MiB，与上传路由的 bodyLimit 是同一个数字。
    check(
      'story_images_bytes_ck',
      sql`${t.bytes} > 0 AND ${t.bytes} <= 2097152`,
    ),
    uniqueIndex('story_images_slot_uq').on(t.proposalId, t.kind, t.position),
  ],
);

export const storyLikes = pgTable(
  'story_likes',
  {
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => storyProposals.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  // 只有赞、没有踩：这个排序信号要决定下次视频的主设定，越简单越难被操纵。
  (t) => [primaryKey({ columns: [t.proposalId, t.userId] })],
);

export const storyComments = pgTable(
  'story_comments',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => storyProposals.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    content: text('content').notNull(),
    contentLanguage: text('content_language'),
    status: text('status').notNull().default('visible'), // visible | hidden
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('story_comments_status_ck', sql`${t.status} IN ('visible','hidden')`),
    // id 自增，所以「按 id 升序」就是楼层顺序。
    index('story_comments_proposal_id_id_idx').on(t.proposalId, t.id),
  ],
);
