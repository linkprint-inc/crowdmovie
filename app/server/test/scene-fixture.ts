// Published-scene fixtures for the 弹幕 and 播放清单 suites. Not a test file
// (the vitest glob only picks up `*.test.ts`) — just the rows a `scenes` record
// needs before it can legally exist: an episode, a round, and the two `ai_runs`
// its NOT NULL foreign keys point at (§16.1).
//
// Kept out of helpers.ts so the round suites and these suites do not have to
// share edits to one fixture file.
import type pg from 'pg';

import { sceneMediaPaths } from '../src/jobs/handlers/publish';
import {
  INLAND_EMPIRE_BIBLE_ID,
  INLAND_EMPIRE_MOVIE_ID,
} from '../src/movies/catalog';

export interface SceneOptions {
  /** Defaults to the legacy Inland Empire film. */
  movieId?: string;
  /** Must be an active Bible for movieId; defaults to Inland's Bible. */
  bibleVersionId?: string;
  /** Optional media namespace used by the multi-film playlist routes. */
  mediaMovieSlug?: string;
  /** Defaults to one past the highest scene that exists. */
  sceneIndex?: number;
  durationSeconds?: number;
  takedownAt?: Date;
  /** Defaults to a fresh episode; pass one to group scenes into an episode. */
  episodeId?: string;
  /** Only used when a new episode is created. */
  episodeIndex?: number;
  /** §16.1「自动续写为 NULL」— who the published 片段 is credited to. */
  creditUserId?: string;
  /** The 投稿 this 片段 was made from, when there was one. */
  sourceSubmissionId?: string;
}

export interface SceneFixture {
  movieId: string;
  sceneIndex: number;
  episodeId: string;
  episodeIndex: number;
  durationSeconds: number;
}

/** An episode with no open round attached; `status='ended'` so the five-minute
 *  clock in other suites never adopts it. */
async function createEpisode(
  pool: pg.Pool,
  episodeIndex: number | undefined,
  movieId: string,
  bibleVersionId: string,
): Promise<{ id: string; episode_index: number }> {
  const result = await pool.query<{ id: string; episode_index: number }>(
    `INSERT INTO episodes
       (movie_id, bible_version_id, episode_index, title, theme, status)
     VALUES ($1, $2,
             coalesce($3, (SELECT coalesce(max(episode_index), 0) + 1
                             FROM episodes WHERE movie_id = $1)),
             'fixture episode', 'fixture theme', 'ended')
     RETURNING id, episode_index`,
    [movieId, bibleVersionId, episodeIndex ?? null],
  );
  return result.rows[0];
}

/** A published scene, media document included, ready to anchor 弹幕 to. */
export async function createScene(
  pool: pg.Pool,
  options: SceneOptions = {},
): Promise<SceneFixture> {
  const durationSeconds = options.durationSeconds ?? 15;
  const movieId = options.movieId ?? INLAND_EMPIRE_MOVIE_ID;
  const bibleVersionId = options.bibleVersionId ?? INLAND_EMPIRE_BIBLE_ID;

  let episodeId = options.episodeId;
  let episodeIndex = options.episodeIndex ?? 0;
  if (episodeId === undefined) {
    const episode = await createEpisode(
      pool,
      options.episodeIndex,
      movieId,
      bibleVersionId,
    );
    episodeId = episode.id;
    episodeIndex = episode.episode_index;
  } else if (options.episodeIndex === undefined) {
    const found = await pool.query<{ episode_index: number }>(
      'SELECT episode_index FROM episodes WHERE id = $1',
      [episodeId],
    );
    episodeIndex = found.rows[0].episode_index;
  }

  const round = await pool.query<{ id: string }>(
    `INSERT INTO rounds (movie_id, round_index, episode_id, status, opens_at, closes_at)
     VALUES ($1, (SELECT coalesce(max(round_index), 0) + 1
                    FROM rounds WHERE movie_id = $1),
             $2, 'published', now(), now())
     RETURNING id`,
    [movieId, episodeId],
  );
  const roundId = round.rows[0].id;

  const runIds: string[] = [];
  for (const runType of ['scene_director', 'scene_subtitles'] as const) {
    const run = await pool.query<{ id: string }>(
      `INSERT INTO ai_runs (movie_id, round_id, run_type, provider, model, reasoning_effort,
                            status, finished_at)
       VALUES ($1, $2, $3, 'fixture', 'none', 'none', 'succeeded', now())
       RETURNING id`,
      [movieId, roundId, runType],
    );
    runIds.push(run.rows[0].id);
  }

  const inserted = await pool.query<{ scene_index: number }>(
    `INSERT INTO scenes
      (movie_id, scene_index, episode_id, round_id, summary_zh, duration_seconds, media,
        director_ai_run_id, subtitle_ai_run_id, episode_should_end,
        published_at, takedown_at, takedown_reason,
        credit_user_id, source_submission_id)
     VALUES ($10, coalesce($1, (SELECT coalesce(max(scene_index), 0) + 1
                            FROM scenes WHERE movie_id = $10)),
             $2, $3, 'fixture scene', $4,
             jsonb_build_object('video', '', 'sha256', '', 'subtitles', '{}'::jsonb),
             $5, $6, false, now(), $7,
             CASE WHEN $7::timestamptz IS NULL THEN NULL ELSE 'fixture takedown' END,
             $8, $9)
     RETURNING scene_index`,
    [
      options.sceneIndex ?? null,
      episodeId,
      roundId,
      durationSeconds,
      runIds[0],
      runIds[1],
      options.takedownAt ?? null,
      options.creditUserId ?? null,
      options.sourceSubmissionId ?? null,
      movieId,
    ],
  );
  const sceneIndex = inserted.rows[0].scene_index;

  // Filled in after the insert so the media document names the index the row
  // actually got, exactly as handlers/publish.ts does it (§10/§11).
  const paths = sceneMediaPaths(sceneIndex, options.mediaMovieSlug);
  await pool.query(
    `UPDATE scenes SET media = $3::jsonb
      WHERE movie_id = $1 AND scene_index = $2`,
    [
      movieId,
      sceneIndex,
      JSON.stringify({
        video: paths.video,
        sha256: 'f'.repeat(64),
        subtitles: paths.subtitles,
      }),
    ],
  );

  return { movieId, sceneIndex, episodeId, episodeIndex, durationSeconds };
}

/** Insert 弹幕 directly, bypassing the route — for the read-path and
 *  rate-limit suites, which need history that predates the request. */
export async function insertDanmaku(
  pool: pg.Pool,
  input: {
    userId: string;
    sceneIndex: number;
    offsetMs: number;
    content: string;
    movieId?: string;
    status?: 'visible' | 'hidden';
    createdAt?: Date;
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO danmaku
       (movie_id, user_id, scene_index, offset_ms, content, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, coalesce($7, now()))
     RETURNING id`,
    [
      input.movieId ?? INLAND_EMPIRE_MOVIE_ID,
      input.userId,
      input.sceneIndex,
      input.offsetMs,
      input.content,
      input.status ?? 'visible',
      input.createdAt ?? null,
    ],
  );
  return result.rows[0].id;
}
