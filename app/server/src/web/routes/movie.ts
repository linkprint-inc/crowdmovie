import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool } from 'pg';

import { LOCALES } from '../../ai/engine.js';
import {
  findPublicMovie,
  LEGACY_MOVIE_SLUG,
  movieView,
  resolveScheduledProgram,
  type MovieRecord,
} from '../../movies/catalog.js';

interface PlaylistRow {
  scene_index: number;
  episode_index: number;
  duration_seconds: string;
  media: unknown;
  credit_username: string | null;
}

interface ShareRow extends PlaylistRow {
  episode_title: string;
  summary_zh: string;
}

interface SceneMedia {
  video: string;
  sha256: string;
  subtitles: Record<string, string>;
}

const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN ?? 'https://movie.example.com').replace(/\/$/, '');

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character] ?? character,
  );
}

function absolutePublicUrl(value: string): string {
  return new URL(value, `${PUBLIC_ORIGIN}/`).toString();
}

/**
 * Cloudflare caches the numbered public media paths. A reset or re-shoot may
 * replace the bytes behind the same scene number, so the published file hash
 * is part of every client-facing URL. New bytes therefore get a new CDN cache
 * key without making the player guess filenames or waiting for a manual purge.
 */
function versionMediaUrl(value: string, sha256: string): string {
  return `${value}${value.includes('?') ? '&' : '?'}v=${sha256}`;
}

function versionMedia(media: SceneMedia): SceneMedia {
  return {
    video: versionMediaUrl(media.video, media.sha256),
    sha256: media.sha256,
    subtitles: Object.fromEntries(
      Object.entries(media.subtitles).map(([locale, url]) => [
        locale,
        versionMediaUrl(url, media.sha256),
      ]),
    ),
  };
}

/** The scene's subtitle tracks in §10 locale order; none for a scene without dialogue. */
function subtitleTracks(media: SceneMedia): { srclang: string; src: string }[] {
  return LOCALES.flatMap((locale) => {
    const src = media.subtitles[locale];
    return src === undefined ? [] : [{ srclang: locale, src }];
  });
}

function renderSharePage(row: ShareRow, movieSlug: string): string {
  const media = versionMedia(readMedia(row.scene_index, row.media));
  const sceneLabel = String(row.scene_index).padStart(6, '0');
  const episodeLabel = String(row.episode_index).padStart(2, '0');
  const canonicalUrl = `${PUBLIC_ORIGIN}/share/${encodeURIComponent(movieSlug)}/${sceneLabel}`;
  const videoUrl = absolutePublicUrl(media.video);
  const title = `CrowdAIMovie · EP ${episodeLabel} · SCENE ${sceneLabel}`;
  const credit = row.credit_username === null ? 'CrowdAIMovie' : `@${row.credit_username}`;
  const description = `${row.summary_zh} — ${credit}`;
  const durationSeconds = Math.round(Number(row.duration_seconds));
  const tracks = subtitleTracks(media)
    .map(
      ({ srclang, src }) =>
        `<track kind="subtitles" srclang="${escapeHtml(srclang)}" src="${escapeHtml(src)}">`,
    )
    .join('\n        ');

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}">
    <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
    <meta property="og:type" content="video.other">
    <meta property="og:site_name" content="CrowdAIMovie">
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
    <meta property="og:video" content="${escapeHtml(videoUrl)}">
    <meta property="og:video:secure_url" content="${escapeHtml(videoUrl)}">
    <meta property="og:video:type" content="video/mp4">
    <meta property="video:duration" content="${durationSeconds}">
    <style>
      body{margin:0;background:#f5ead1;color:#17130f;font:16px/1.5 system-ui,sans-serif}
      main{max-width:900px;margin:0 auto;padding:32px 20px 48px}video{width:100%;background:#17130f}
      .label{font-weight:800;letter-spacing:.08em}.credit{color:#665d52}a{color:#164fd8;font-weight:800}
    </style>
  </head>
  <body>
    <main>
      <p class="label">EP ${episodeLabel} · SCENE ${sceneLabel}</p>
      <h1>${escapeHtml(row.episode_title)}</h1>
      <p>${escapeHtml(row.summary_zh)}</p>
      <video controls preload="metadata" src="${escapeHtml(media.video)}">
        ${tracks}
      </video>
      <p class="credit">${escapeHtml(credit)}</p>
      <p><a href="/">进入 CrowdAIMovie 放映厅</a></p>
    </main>
  </body>
</html>`;
}

/**
 * Read the four §10 file URLs out of a `scenes.media` document.
 *
 * Every field is required. A scene row whose media document is incomplete
 * cannot be played and cannot be repaired by guessing — §11 forbids exactly
 * that guess — so this throws and the request fails loudly, naming the scene,
 * instead of shipping a playlist entry the player would break on. The one
 * legitimate absence is a subtitle: a scene without dialogue registers none.
 */
function readMedia(sceneIndex: number, media: unknown): SceneMedia {
  const document = media as Partial<SceneMedia> | null;
  const video = document?.video;
  const sha256 = document?.sha256;
  const subtitles = document?.subtitles;
  if (typeof video !== 'string' || video.length === 0) {
    throw new Error(`scene ${sceneIndex} has no media.video`);
  }
  if (subtitles === null || typeof subtitles !== 'object') {
    throw new Error(`scene ${sceneIndex} has no media.subtitles`);
  }
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(`scene ${sceneIndex} has malformed media.sha256`);
  }
  const registered: Record<string, string> = {};
  for (const locale of LOCALES) {
    const url = subtitles[locale];
    if (url === undefined) continue;
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error(`scene ${sceneIndex} has a malformed ${locale} subtitle`);
    }
    registered[locale] = url;
  }
  return { video, sha256, subtitles: registered };
}

function playlistView(rows: PlaylistRow[]): { scenes: Record<string, unknown>[] } {
  return {
    scenes: rows.map((row) => {
      const media = versionMedia(readMedia(row.scene_index, row.media));
      return {
        sceneIndex: row.scene_index,
        episodeIndex: row.episode_index,
        videoUrl: media.video,
        subtitles: media.subtitles,
        src: media.video,
        durationMs: Math.round(Number(row.duration_seconds) * 1000),
        authorUsername: row.credit_username,
        tracks: subtitleTracks(media).map(({ srclang, src }) => ({
          srclang,
          src,
          label: srclang,
        })),
      };
    }),
  };
}

async function loadPlaylist(
  pool: Pool,
  movieId: string,
  episodeIndex?: number,
  afterSceneIndex?: number,
): Promise<{ scenes: Record<string, unknown>[] }> {
  const rows = await pool.query<PlaylistRow>(
    `SELECT s.scene_index, e.episode_index, s.duration_seconds, s.media,
            u.username_display AS credit_username
       FROM scenes s
       JOIN episodes e ON e.id = s.episode_id AND e.movie_id = s.movie_id
       LEFT JOIN users u ON u.id = s.credit_user_id
      WHERE s.movie_id = $1 AND s.takedown_at IS NULL
        AND ($2::int IS NULL OR e.episode_index = $2)
        AND ($3::int IS NULL OR s.scene_index > $3)
      ORDER BY s.scene_index ASC`,
    [movieId, episodeIndex ?? null, afterSceneIndex ?? null],
  );
  return playlistView(rows.rows);
}

async function requireMovie(
  pool: Pool,
  slug: string,
  reply: FastifyReply,
): Promise<MovieRecord | null> {
  const movie = await findPublicMovie(pool, slug);
  if (movie !== null) return movie;
  await reply
    .code(404)
    .send({ error: 'movie_not_found', message: '影片不存在' });
  return null;
}

export interface MovieRoutesOptions {
  pool: Pool;
}

export async function movieRoutes(
  app: FastifyInstance,
  options: MovieRoutesOptions,
): Promise<void> {
  const { pool } = options;

  app.get('/api/movies', async () => {
    const rows = await pool.query<
      Parameters<typeof movieView>[0] & {
        poster_images: string[];
        story_setting: string | null;
      }
    >(
      `SELECT m.id, m.slug, m.title_i18n, m.synopsis_i18n,
              m.poster_url, m.hero_url, m.default_locale,
              m.primary_audio_locale, m.subtitle_locales,
              m.production_status, m.rights_status,
              (SELECT s.media #>> '{end_frame,image}' ||
                      CASE WHEN s.media #>> '{end_frame,sha256}' IS NOT NULL
                        THEN '?v=' || (s.media #>> '{end_frame,sha256}') ELSE '' END
                 FROM scenes s WHERE s.movie_id = m.id AND s.takedown_at IS NULL
                   AND nullif(s.media #>> '{end_frame,image}', '') IS NOT NULL
                 ORDER BY s.scene_index DESC LIMIT 1) AS scene_still_url,
              poster_story.synopsis AS story_setting,
              ARRAY(
                SELECT picked.file_url
                  FROM (
                    (SELECT i.file_url, 0 AS kind_order, i.position
                       FROM story_images i
                      WHERE i.proposal_id = poster_story.id
                        AND i.kind = 'character'
                      ORDER BY i.position
                      LIMIT 2)
                    UNION ALL
                    (SELECT i.file_url, 1 AS kind_order, i.position
                       FROM story_images i
                      WHERE i.proposal_id = poster_story.id
                        AND i.kind = 'world'
                      ORDER BY i.position
                      LIMIT 2)
                  ) picked
                 ORDER BY picked.kind_order, picked.position
              ) AS poster_images
         FROM movies m
         LEFT JOIN LATERAL (
           SELECT p.id, p.synopsis
             FROM story_proposals p
            WHERE p.published_at IS NOT NULL
              AND p.takedown_at IS NULL
              AND (
                lower(btrim(p.title)) = lower(btrim(COALESCE(m.title_i18n->>'en', '')))
                OR lower(btrim(p.title)) = lower(btrim(COALESCE(m.title_i18n->>'zh-CN', '')))
              )
            ORDER BY p.published_at DESC, p.id DESC
            LIMIT 1
         ) poster_story ON true
        WHERE m.status = 'published'
        ORDER BY m.display_order, m.created_at`,
    );
    return {
      movies: rows.rows.map((row) => ({
        ...movieView(row),
        posterImages: row.poster_images,
        storySetting: row.story_setting,
      })),
    };
  });

  app.get('/api/program/current', async (_request, reply) => {
    const program = await resolveScheduledProgram(pool);
    if (program === null) {
      return reply.code(503).send({
        error: 'program_off_air',
        message: '当前没有可用排期',
      });
    }
    const round = await pool.query<{ round_index: string; movie_id: string }>(
      `SELECT movie_id, round_index FROM rounds
        WHERE status = 'open' ORDER BY opens_at DESC LIMIT 1`,
    );
    return {
      generatorKey: program.generatorKey,
      timezone: program.timezone,
      state: program.state,
      movie: program.scheduledMovie,
      activeMovieId: program.leaseMovieId,
      roundIndex:
        round.rows[0]?.movie_id === program.scheduledMovie.id
          ? Number(round.rows[0].round_index)
          : null,
      startsAt: program.startsAt.toISOString(),
      endsAt: program.endsAt.toISOString(),
      serverNow: program.databaseNow.toISOString(),
    };
  });

  app.get<{ Params: { movieSlug: string } }>(
    '/api/movies/:movieSlug',
    async (request, reply) => {
      const movie = await requireMovie(pool, request.params.movieSlug, reply);
      return movie ?? undefined;
    },
  );

  app.get<{ Params: { movieSlug: string } }>(
    '/api/movies/:movieSlug/characters',
    async (request, reply) => {
      const movie = await requireMovie(pool, request.params.movieSlug, reply);
      if (movie === null) return;
      const rows = await pool.query<{
        character_key: string;
        position: number;
        public_copy_i18n: Record<string, unknown>;
        visual_identity: unknown;
        reference_assets: unknown;
      }>(
        `SELECT c.character_key, c.position, c.public_copy_i18n,
                v.visual_identity, v.reference_assets
           FROM movie_characters c
           JOIN movie_bible_versions b
             ON b.movie_id = c.movie_id AND b.status = 'active'
           JOIN movie_character_versions v
             ON v.character_id = c.id AND v.bible_version_id = b.id
          WHERE c.movie_id = $1 AND c.status = 'active'
          ORDER BY c.position`,
        [movie.id],
      );
      return {
        movieId: movie.id,
        characters: rows.rows.map((row) => ({
          key: row.character_key,
          position: row.position,
          copyI18n: row.public_copy_i18n,
          visualIdentity: row.visual_identity,
          referenceAssets: row.reference_assets,
        })),
      };
    },
  );

  const afterSceneIndex = (
    value: string | undefined,
    reply: FastifyReply,
  ): number | undefined | null => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      void reply.code(400).send({
        error: 'after_scene_index_invalid',
        message: 'afterSceneIndex 必须是非负整数',
      });
      return null;
    }
    return parsed;
  };

  app.get<{ Params: { movieSlug: string }; Querystring: { afterSceneIndex?: string } }>(
    '/api/movies/:movieSlug/playlist',
    async (request, reply) => {
      const movie = await requireMovie(pool, request.params.movieSlug, reply);
      if (movie === null) return;
      const after = afterSceneIndex(request.query.afterSceneIndex, reply);
      if (after === null) return;
      return loadPlaylist(pool, movie.id, undefined, after);
    },
  );

  app.get<{
    Params: { movieSlug: string; episodeIndex: string };
    Querystring: { afterSceneIndex?: string };
  }>(
    '/api/movies/:movieSlug/episodes/:episodeIndex/playlist',
    async (request, reply) => {
      const movie = await requireMovie(pool, request.params.movieSlug, reply);
      if (movie === null) return;
      const episodeIndex = Number(request.params.episodeIndex);
      if (!Number.isSafeInteger(episodeIndex) || episodeIndex < 1) {
        return reply
          .code(404)
          .send({ error: 'episode_not_found', message: '该集不存在' });
      }
      const after = afterSceneIndex(request.query.afterSceneIndex, reply);
      if (after === null) return;
      return loadPlaylist(pool, movie.id, episodeIndex, after);
    },
  );

  // One-release compatibility layer: legacy reads are permanently pinned to
  // the original film and can never follow the schedule into another movie.
  app.get<{ Querystring: { afterSceneIndex?: string } }>(
    '/api/movie/playlist',
    async (request, reply) => {
      const movie = await requireMovie(pool, LEGACY_MOVIE_SLUG, reply);
      if (movie === null) return;
      const after = afterSceneIndex(request.query.afterSceneIndex, reply);
      if (after === null) return;
      return loadPlaylist(pool, movie.id, undefined, after);
    },
  );

  const shareScene = async (
    movieSlug: string,
    sceneIndexValue: string,
    reply: FastifyReply,
  ): Promise<FastifyReply | void> => {
    if (!/^\d+$/.test(sceneIndexValue)) {
      return reply.code(404).type('text/plain').send('Not Found');
    }
    const sceneIndex = Number(sceneIndexValue);
    if (!Number.isSafeInteger(sceneIndex) || sceneIndex < 1) {
      return reply.code(404).type('text/plain').send('Not Found');
    }
    const movie = await findPublicMovie(pool, movieSlug);
    if (movie === null) {
      return reply.code(404).type('text/plain').send('Not Found');
    }
    const result = await pool.query<ShareRow>(
      `SELECT s.scene_index, e.episode_index, e.title AS episode_title,
              s.summary_zh, s.duration_seconds, s.media,
              u.username_display AS credit_username
         FROM scenes s
         JOIN episodes e ON e.id = s.episode_id AND e.movie_id = s.movie_id
         LEFT JOIN users u ON u.id = s.credit_user_id
        WHERE s.movie_id = $1 AND s.scene_index = $2
          AND s.takedown_at IS NULL`,
      [movie.id, sceneIndex],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return reply.code(404).type('text/plain').send('Not Found');
    }
    return reply
      .type('text/html; charset=utf-8')
      .header('Cache-Control', 'public, max-age=60, no-transform')
      .send(renderSharePage(row, movieSlug));
  };

  // Legacy share links stay pinned to the original movie. New links include
  // the movie slug so per-movie scene indexes can never collide.
  app.get<{ Params: { sceneIndex: string } }>(
    '/share/:sceneIndex',
    async (request, reply) =>
      shareScene(LEGACY_MOVIE_SLUG, request.params.sceneIndex, reply),
  );
  app.get<{ Params: { movieSlug: string; sceneIndex: string } }>(
    '/share/:movieSlug/:sceneIndex',
    async (request, reply) =>
      shareScene(request.params.movieSlug, request.params.sceneIndex, reply),
  );
}
