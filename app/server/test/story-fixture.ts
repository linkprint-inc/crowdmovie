// Story-table fixtures for the §16.3 page suites (剧集 / 名人堂 / 我的剧本).
// Not a test file — the vitest glob only picks up `*.test.ts`.
//
// Rows are written directly rather than driven through the round engine,
// because these endpoints are read models: what they have to get right is which
// rows they count, not how the rows came to exist. Driving a whole 5-minute
// round to produce one 投稿 would make the tests slower and no stronger.
import type pg from 'pg';
import {
  INLAND_EMPIRE_BIBLE_ID,
  INLAND_EMPIRE_MOVIE_ID,
} from '../src/movies/catalog';

export interface EpisodeOptions {
  /** Defaults to one past the highest that exists. */
  episodeIndex?: number;
  title?: string;
  theme?: string;
  status?: 'open' | 'ended';
  /** §16.1 民选主题来源; NULL means AI 自拟. */
  themeSourceSubmissionId?: string;
}

export interface EpisodeFixture {
  id: string;
  episodeIndex: number;
}

export async function createEpisode(
  pool: pg.Pool,
  options: EpisodeOptions = {},
): Promise<EpisodeFixture> {
  const result = await pool.query<{ id: string; episode_index: number }>(
    `INSERT INTO episodes (movie_id, bible_version_id, episode_index, title, theme, status,
                           theme_source_submission_id)
     VALUES ($1, $2,
             coalesce($3, (SELECT coalesce(max(episode_index), 0) + 1
                             FROM episodes WHERE movie_id = $1)),
             $4, $5, $6, $7)
     RETURNING id, episode_index`,
    [
      INLAND_EMPIRE_MOVIE_ID,
      INLAND_EMPIRE_BIBLE_ID,
      options.episodeIndex ?? null,
      options.title ?? 'fixture 集标题',
      options.theme ?? 'fixture 本集设定',
      options.status ?? 'ended',
      options.themeSourceSubmissionId ?? null,
    ],
  );
  return { id: result.rows[0].id, episodeIndex: result.rows[0].episode_index };
}

/** Point an existing episode at the proposal that set its theme (§5.4). */
export async function setEpisodeTheme(
  pool: pg.Pool,
  episodeId: string,
  submissionId: string,
): Promise<void> {
  await pool.query(
    'UPDATE episodes SET theme_source_submission_id = $2 WHERE id = $1',
    [episodeId, submissionId],
  );
}

export interface RoundOptions {
  episodeId: string;
  status?: string;
  roundIndex?: number;
}

export async function createRound(
  pool: pg.Pool,
  options: RoundOptions,
): Promise<{ id: string; roundIndex: number }> {
  const result = await pool.query<{ id: string; round_index: string }>(
    `INSERT INTO rounds (movie_id, round_index, episode_id, status, opens_at, closes_at)
     VALUES ($1, coalesce($2, (SELECT coalesce(max(round_index), 0) + 1
                                FROM rounds WHERE movie_id = $1)),
             $3, $4, now(), now())
     RETURNING id, round_index`,
    [
      INLAND_EMPIRE_MOVIE_ID,
      options.roundIndex ?? null,
      options.episodeId,
      options.status ?? 'published',
    ],
  );
  return {
    id: result.rows[0].id,
    roundIndex: Number(result.rows[0].round_index),
  };
}

export interface SubmissionOptions {
  userId: string;
  episodeId: string;
  /** Required for `next_shot` by the §16.1 CHECK; omit for `next_episode`. */
  roundId?: string;
  kind?: 'next_shot' | 'next_episode';
  content?: string;
  status?: 'pending' | 'rejected' | 'accepted';
  upCount?: number;
  downCount?: number;
  /** §5.4 冻结: 累计获赞 only counts frozen submissions (§16.2). */
  frozen?: boolean;
  createdAt?: Date;
}

export async function createSubmission(
  pool: pg.Pool,
  options: SubmissionOptions,
): Promise<{ id: string }> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO submissions
       (movie_id, kind, round_id, episode_id, user_id, content, status,
        up_count, down_count, votes_frozen_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             CASE WHEN $10::boolean THEN now() ELSE NULL END,
             coalesce($11, now()))
     RETURNING id`,
    [
      INLAND_EMPIRE_MOVIE_ID,
      options.kind ?? 'next_shot',
      options.roundId ?? null,
      options.episodeId,
      options.userId,
      options.content ?? 'fixture 投稿内容',
      options.status ?? 'pending',
      options.upCount ?? 0,
      options.downCount ?? 0,
      options.frozen ?? false,
      options.createdAt ?? null,
    ],
  );
  return { id: result.rows[0].id };
}

/**
 * A §6.3 初评 row and the `ai_runs` row its NOT NULL foreign key needs. The run
 * says `fixture`/`none` because no model ran (§6.6 — an audit row claiming
 * `gpt-5.6-sol` here would be a false one).
 */
export async function scoreSubmission(
  pool: pg.Pool,
  input: {
    submissionId: string;
    roundId: string;
    total: number;
    eligible?: boolean;
  },
): Promise<void> {
  const run = await pool.query<{ id: string }>(
    `INSERT INTO ai_runs (movie_id, round_id, submission_id, run_type, provider, model,
                          reasoning_effort, status, finished_at)
     VALUES ($1, $2, $3, 'submission_score', 'fixture', 'none', 'none', 'succeeded', now())
     RETURNING id`,
    [INLAND_EMPIRE_MOVIE_ID, input.roundId, input.submissionId],
  );
  await pool.query(
    `INSERT INTO submission_scores
       (submission_id, eligible, score_total, score_breakdown, reason,
        public_roast, risk_flags, rubric_version, ai_run_id, scored_at)
     VALUES ($1, $2, $3, '{}'::jsonb, 'fixture reason',
             $4::jsonb, '[]'::jsonb, 'fixture-v1', $5, now())`,
    [
      input.submissionId,
      input.eligible ?? true,
      input.total,
      JSON.stringify({
        en: 'fixture roast',
        'zh-CN': 'fixture 毒舌',
        ja: 'fixture 辛口',
        es: 'fixture burla',
      }),
      run.rows[0].id,
    ],
  );
}
