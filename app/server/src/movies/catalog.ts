import type { QueryResultRow } from 'pg';

import type { Queryable } from '../jobs/ledger.js';

/**
 * Stable seed identifiers from drizzle/0007_multi_movie.sql. The second movie
 * keeps its 0007 identifiers; drizzle/0010_whos_next.sql re-seeds it as Who\'s Next.
 */
export const INLAND_EMPIRE_MOVIE_ID =
  '10000000-0000-4000-8000-000000000001';
export const WHOS_NEXT_MOVIE_ID =
  '10000000-0000-4000-8000-000000000002';
export const INLAND_EMPIRE_BIBLE_ID =
  '11000000-0000-4000-8000-000000000001';
export const WHOS_NEXT_BIBLE_ID =
  '11000000-0000-4000-8000-000000000002';
export const LEGACY_MOVIE_SLUG = 'inland-empire-high';
export const PRIMARY_GENERATOR_KEY = 'primary';
export const GENERATOR_LEASE_MS = 15_000;

export interface MovieRecord {
  id: string;
  slug: string;
  titleI18n: Record<string, string>;
  synopsisI18n: Record<string, string>;
  posterUrl: string | null;
  heroUrl: string | null;
  sceneStillUrl?: string | null;
  defaultLocale: string;
  primaryAudioLocale: string;
  subtitleLocales: string[];
  productionStatus: string;
  rightsStatus: string;
}

interface MovieRow extends QueryResultRow {
  id: string;
  slug: string;
  title_i18n: Record<string, string>;
  synopsis_i18n: Record<string, string>;
  poster_url: string | null;
  hero_url: string | null;
  scene_still_url?: string | null;
  default_locale: string;
  primary_audio_locale: string;
  subtitle_locales: string[];
  production_status: string;
  rights_status: string;
}

export function movieView(row: MovieRow): MovieRecord {
  return {
    id: row.id,
    slug: row.slug,
    titleI18n: row.title_i18n,
    synopsisI18n: row.synopsis_i18n,
    posterUrl: row.poster_url,
    heroUrl: row.hero_url,
    sceneStillUrl: row.scene_still_url ?? null,
    defaultLocale: row.default_locale,
    primaryAudioLocale: row.primary_audio_locale,
    subtitleLocales: row.subtitle_locales,
    productionStatus: row.production_status,
    rightsStatus: row.rights_status,
  };
}

export async function findPublicMovie(
  db: Queryable,
  slug: string,
): Promise<MovieRecord | null> {
  const result = await db.query<MovieRow>(
    `SELECT id, slug, title_i18n, synopsis_i18n, poster_url, hero_url,
            default_locale, primary_audio_locale, subtitle_locales,
            production_status, rights_status,
            (SELECT s.media #>> '{end_frame,image}' ||
                    CASE WHEN s.media #>> '{end_frame,sha256}' IS NOT NULL
                      THEN '?v=' || (s.media #>> '{end_frame,sha256}') ELSE '' END
               FROM scenes s WHERE s.movie_id = movies.id AND s.takedown_at IS NULL
                 AND nullif(s.media #>> '{end_frame,image}', '') IS NOT NULL
               ORDER BY s.scene_index DESC LIMIT 1) AS scene_still_url
       FROM movies
      WHERE slug = $1 AND status = 'published'`,
    [slug],
  );
  return result.rows[0] === undefined ? null : movieView(result.rows[0]);
}

export interface ScheduledProgram {
  generatorKey: string;
  timezone: string;
  state: 'active' | 'switching' | 'blocked';
  scheduledMovie: MovieRecord;
  leaseMovieId: string | null;
  startsAt: Date;
  endsAt: Date;
  databaseNow: Date;
}

interface ProgramRow extends MovieRow {
  generator_key: string;
  timezone: string;
  lease_movie_id: string | null;
  lease_expires_at: Date | null;
  starts_at: Date;
  ends_at: Date;
  database_now: Date;
}

/**
 * Resolve the unique schedule window with PostgreSQL's clock and configured
 * IANA timezone. The exclusion constraint guarantees this query cannot return
 * two enabled windows for one generator.
 */
export async function resolveScheduledProgram(
  db: Queryable,
  generatorKey = PRIMARY_GENERATOR_KEY,
): Promise<ScheduledProgram | null> {
  const result = await db.query<ProgramRow>(
    `WITH generator_clock AS (
       SELECT g.key, g.timezone, g.lease_movie_id, g.lease_expires_at,
              now() AS database_now,
              timezone(g.timezone, now()) AS local_now
         FROM story_generators g
        WHERE g.key = $1 AND g.enabled
     )
     SELECT m.id, m.slug, m.title_i18n, m.synopsis_i18n,
            m.poster_url, m.hero_url, m.default_locale,
            m.primary_audio_locale, m.subtitle_locales,
            m.production_status, m.rights_status,
            c.key AS generator_key, c.timezone, c.lease_movie_id,
            c.lease_expires_at, c.database_now,
            ((date_trunc('day', c.local_now)
                + make_interval(mins => w.start_minute::int))
              AT TIME ZONE c.timezone) AS starts_at,
            ((date_trunc('day', c.local_now)
                + make_interval(mins => w.end_minute::int))
              AT TIME ZONE c.timezone) AS ends_at
       FROM generator_clock c
       JOIN movie_schedule_windows w ON w.generator_key = c.key AND w.enabled
       JOIN movies m ON m.id = w.movie_id
      WHERE extract(hour FROM c.local_now)::int * 60
              + extract(minute FROM c.local_now)::int
            >= w.start_minute
        AND extract(hour FROM c.local_now)::int * 60
              + extract(minute FROM c.local_now)::int
            < w.end_minute
      LIMIT 1`,
    [generatorKey],
  );
  const row = result.rows[0];
  if (row === undefined) return null;

  const eligible =
    row.production_status === 'ready' &&
    (row.rights_status === 'original_cleared' ||
      row.rights_status === 'licensed');
  const anotherLeaseActive =
    row.lease_movie_id !== null &&
    row.lease_movie_id !== row.id &&
    row.lease_expires_at !== null &&
    row.lease_expires_at > row.database_now;

  return {
    generatorKey: row.generator_key,
    timezone: row.timezone,
    state: !eligible ? 'blocked' : anotherLeaseActive ? 'switching' : 'active',
    scheduledMovie: movieView(row),
    leaseMovieId: row.lease_movie_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    databaseNow: row.database_now,
  };
}

export interface GeneratorLease {
  movieId: string | null;
  token: string | null;
  scheduledMovieId: string | null;
  state: 'active' | 'draining' | 'blocked' | 'off_air';
}

/**
 * Reconcile the one physical generator under a row lock. A movie that already
 * owns unfinished work keeps the lease after its schedule window ends; the new
 * movie can only acquire it after the old pipeline reaches a terminal state.
 */
export async function reconcileGeneratorLease(
  db: Queryable,
  generatorKey = PRIMARY_GENERATOR_KEY,
  leaseMs = GENERATOR_LEASE_MS,
): Promise<GeneratorLease> {
  const generator = await db.query<{
    lease_movie_id: string | null;
    lease_token: string | null;
  } & QueryResultRow>(
    `SELECT lease_movie_id, lease_token
       FROM story_generators
      WHERE key = $1 AND enabled
      FOR UPDATE`,
    [generatorKey],
  );
  if (generator.rows[0] === undefined) {
    return { movieId: null, token: null, scheduledMovieId: null, state: 'off_air' };
  }

  const scheduled = await resolveScheduledProgram(db, generatorKey);
  if (scheduled === null) {
    return { movieId: null, token: null, scheduledMovieId: null, state: 'off_air' };
  }
  const scheduledMovieId = scheduled.scheduledMovie.id;
  const previousMovieId = generator.rows[0].lease_movie_id;
  if (previousMovieId !== null && previousMovieId !== scheduledMovieId) {
    const unfinished = await db.query<{ exists: boolean } & QueryResultRow>(
      `SELECT EXISTS (
         SELECT 1 FROM workflow_jobs
          WHERE movie_id = $1
            AND job_type NOT IN ('story_review','maintenance')
            AND status IN ('pending','running','retryable_failed')
       ) AS exists`,
      [previousMovieId],
    );
    if (unfinished.rows[0].exists) {
      const renewed = await db.query<{
        lease_token: string;
      } & QueryResultRow>(
        `UPDATE story_generators SET
           lease_token = coalesce(lease_token, gen_random_uuid()),
           lease_expires_at = now() + make_interval(secs => $2::double precision / 1000),
           heartbeat_at = now()
         WHERE key = $1
         RETURNING lease_token`,
        [generatorKey, leaseMs],
      );
      return {
        movieId: previousMovieId,
        token: renewed.rows[0].lease_token,
        scheduledMovieId,
        state: 'draining',
      };
    }
  }

  if (scheduled.state === 'blocked') {
    return {
      movieId: previousMovieId,
      token: generator.rows[0].lease_token,
      scheduledMovieId,
      state: 'blocked',
    };
  }

  const acquired = await db.query<{
    lease_token: string;
  } & QueryResultRow>(
    `UPDATE story_generators SET
       lease_movie_id = $2,
       lease_token = CASE WHEN lease_movie_id = $2 AND lease_token IS NOT NULL
                          THEN lease_token ELSE gen_random_uuid() END,
       lease_expires_at = now() + make_interval(secs => $3::double precision / 1000),
       heartbeat_at = now()
     WHERE key = $1
     RETURNING lease_token`,
    [generatorKey, scheduledMovieId, leaseMs],
  );
  return {
    movieId: scheduledMovieId,
    token: acquired.rows[0].lease_token,
    scheduledMovieId,
    state: 'active',
  };
}

export async function currentGeneratorMovieId(
  db: Queryable,
  generatorKey = PRIMARY_GENERATOR_KEY,
): Promise<string | null> {
  const result = await db.query<{ lease_movie_id: string | null } & QueryResultRow>(
    `SELECT lease_movie_id
       FROM story_generators
      WHERE key = $1 AND enabled AND lease_expires_at > now()`,
    [generatorKey],
  );
  return result.rows[0]?.lease_movie_id ?? null;
}
