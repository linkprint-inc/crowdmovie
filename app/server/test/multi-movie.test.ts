import { databaseNow } from './database';
import pg from 'pg';

import { runMigrations } from '../src/db/migrate';
import { withTransaction } from '../src/db/tx';
import {
  WHOS_NEXT_BIBLE_ID,
  WHOS_NEXT_MOVIE_ID,
  INLAND_EMPIRE_BIBLE_ID,
  INLAND_EMPIRE_MOVIE_ID,
  reconcileGeneratorLease,
} from '../src/movies/catalog';
import { buildApp } from '../src/web/app';
import {
  ensureDatabase,
  resetStory,
  restorePrimarySchedule,
  testConfig,
  TEST_URL,
} from './helpers';
import { createScene, insertDanmaku } from './scene-fixture';

let pool: pg.Pool;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  await ensureDatabase();
  await runMigrations(TEST_URL);
  pool = new pg.Pool({ connectionString: TEST_URL });
  app = buildApp(testConfig, pool, {
    guestClaimRateLimit: 10_000,
    submissionRateLimit: 10_000,
    voteRateLimit: 10_000,
    danmakuIpRateLimit: 10_000,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

beforeEach(async () => {
  await resetStory(pool);
  await restorePrimarySchedule(pool);
  await pool.query(
    `UPDATE story_generators SET lease_movie_id = NULL, lease_token = NULL,
       lease_expires_at = NULL, heartbeat_at = NULL`,
  );
});

afterEach(async () => {
  // Restore the 0011 seed: Who\'s Next is production-ready and rights-cleared.
  await pool.query(
    `UPDATE movies SET production_status = 'ready', rights_status = 'original_cleared'
      WHERE id = $1`,
    [WHOS_NEXT_MOVIE_ID],
  );
});

async function claimGuest(): Promise<{ cookie: string; userId: string }> {
  const username = `mm_${Math.random().toString(36).slice(2, 12)}`;
  const response = await app.inject({
    method: 'POST',
    url: '/api/identity/guest',
    payload: { username },
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.find((each) => each.name === 'cm_guest');
  if (cookie === undefined) throw new Error('no guest cookie');
  const user = await pool.query<{ id: string }>(
    'SELECT id FROM users WHERE username_display = $1',
    [username],
  );
  return { cookie: `cm_guest=${cookie.value}`, userId: user.rows[0].id };
}

test('影片目录公开两部片，Who\'s Next 使用自由角色与现实动作电影环境配置', async () => {
  const catalog = await app.inject({ method: 'GET', url: '/api/movies' });
  expect(catalog.statusCode).toBe(200);
  const movies = catalog.json<{
    movies: Array<{
      slug: string;
      titleI18n: Record<string, string>;
      defaultLocale: string;
      primaryAudioLocale: string;
      subtitleLocales: string[];
      productionStatus: string;
      rightsStatus: string;
      posterImages: string[];
      storySetting: string | null;
    }>;
  }>().movies;
  expect(movies.map((movie) => movie.slug)).toEqual([
    'whos-next',
    'inland-empire-high',
  ]);
  expect(movies.every((movie) => movie.posterImages.length === 0)).toBe(true);
  expect(movies.every((movie) => movie.storySetting === null)).toBe(true);
  expect(movies[0]).toMatchObject({
    titleI18n: expect.objectContaining({ en: 'Who\'s Next' }),
    defaultLocale: 'en',
    primaryAudioLocale: 'en',
    subtitleLocales: ['en', 'zh-CN', 'ja', 'es'],
    productionStatus: 'ready',
    rightsStatus: 'original_cleared',
  });

  const response = await app.inject({
    method: 'GET',
    url: '/api/movies/whos-next/characters',
  });
  expect(response.statusCode).toBe(200);
  const characters = response.json<{
    characters: Array<{
      key: string;
      visualIdentity: { originalDesign: boolean; style: string };
    }>;
  }>().characters;
  expect(characters).toEqual([]);

  const bible = await pool.query<{
    style_prompt: string;
    negative_prompt: string;
    world_rules: Record<string, string>;
    workflow_profile: {
      profile: string;
      audioLocale: string;
      styleProfile: string;
      characterProfile: string;
      promptGrammar: string[];
      firstShot: { pinnedReference: boolean; durationSeconds: number; noiseSeed: number };
      h3Prompt: {
        mode: string;
        skillRevision: string;
        fieldOrder: string[];
        durationSeconds: { min: number; max: number };
        singleContinuousShot: boolean;
      };
    };
  }>(
    `SELECT b.style_prompt, b.negative_prompt, b.world_rules, b.workflow_profile
       FROM movie_bible_versions b
      WHERE b.id = $1`,
    [WHOS_NEXT_BIBLE_ID],
  );
  expect(bible.rows[0].style_prompt).toMatch(/named famous figures directly/i);
  expect(bible.rows[0].style_prompt).toMatch(/Spider-Man and Batman rooftop reference/i);
  expect(bible.rows[0].style_prompt).toMatch(/crisp high-detail full-3D game characters/i);
  expect(bible.rows[0].style_prompt).toMatch(/at least six concrete architecture or material cues/i);
  expect(bible.rows[0].style_prompt).toMatch(/stabilized medium-wide gameplay camera/i);
  expect(bible.rows[0].style_prompt).toMatch(/duration from the actual action and dialogue/i);
  expect(bible.rows[0].style_prompt).toMatch(/never pad to a fixed duration/i);
  expect(bible.rows[0].world_rules.tailChain).toMatch(/stateless T2VA quality reset/i);
  expect(bible.rows[0].negative_prompt).toMatch(/full-frame motion blur/);
  expect(bible.rows[0].workflow_profile).toMatchObject({
    profile: 'whos-next-v8',
    audioLocale: 'en',
    styleProfile: 'whos-next-spiderman-batman-quality-reference-v8',
    characterProfile: 'whos-next-famous-cast-v3',
    h3Capabilities: 'h3-capabilities-v5',
    executionPort: 8188,
    controlledGatewayPort: 8191,
    resolution: [1344, 768],
    engine: 'minimax-h3-fl2va-pdd-acc-8nfe-full-int8-convrot',
    model: 'minimax_h3_fl2va_int8_convrot.safetensors',
    steps: 8,
    nfe: '8',
    imageConditioning: { firstFrame: true, lastFrame: false },
    continuation: 'previous-published-tail-first-frame-i2va',
    tailChain: { maxAdjacentI2va: 1, resetMode: 'stateless-t2va' },
    promptGrammar: [
      'summary',
      'detailed_description',
      'overall_soundscape',
      'non_diegetic_music',
    ],
    firstShot: { pinnedReference: true, durationSeconds: 8, noiseSeed: 81880001 },
    durationPolicy: {
      mode: 'content-driven',
      minSeconds: 5,
      maxSeconds: 15,
      fixedDefault: false,
    },
    motionContext: { enabled: false },
    externalLoras: { enabled: false },
  });
  expect(bible.rows[0].workflow_profile.h3Prompt).toEqual({
    mode: 'T2VA/I2VA',
    skill: 'h3-prompt-writing',
    skillRevision: 'd21241f0a4b3acbb34c97dae47fa417b7065e438',
    guide: 'skills/h3-prompt-writing/references/base-en.txt',
    fieldOrder: [
      'integrated_multimodal_description',
      'overall_soundscape',
      'non_diegetic_music',
    ],
    durationSeconds: { min: 5, max: 15 },
    singleContinuousShot: true,
  });
});

test('影片级投稿接口在轮次切换后仍返回全部有意义的历史投稿', async () => {
  const { userId } = await claimGuest();
  const episode = await pool.query<{ id: string }>(
    `INSERT INTO episodes
       (movie_id, bible_version_id, episode_index, title, theme, status)
     VALUES ($1, $2, 1, 'Open brawl', 'Any famous figure anywhere', 'open')
     RETURNING id`,
    [WHOS_NEXT_MOVIE_ID, WHOS_NEXT_BIBLE_ID],
  );
  const episodeId = episode.rows[0].id;
  const historicalRound = await pool.query<{ id: string }>(
    `INSERT INTO rounds
       (movie_id, round_index, episode_id, status, opens_at, closes_at)
     VALUES ($1, 1, $2, 'published', now() - interval '10 minutes', now() - interval '5 minutes')
     RETURNING id`,
    [WHOS_NEXT_MOVIE_ID, episodeId],
  );
  await pool.query(
    `INSERT INTO submissions
       (movie_id, kind, round_id, episode_id, user_id, content, status)
     VALUES ($1, 'next_shot', $2, $3, $4, $5, 'rejected')`,
    [
      WHOS_NEXT_MOVIE_ID,
      historicalRound.rows[0].id,
      episodeId,
      userId,
      '贝吉塔大战超人，冲击波和眼中激光对中抵消。',
    ],
  );
  await pool.query(
    `INSERT INTO rounds
       (movie_id, round_index, episode_id, status, opens_at)
     VALUES ($1, 2, $2, 'open', now())`,
    [WHOS_NEXT_MOVIE_ID, episodeId],
  );

  const response = await app.inject({
    method: 'GET',
    url: '/api/movies/whos-next/round/current/submissions',
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    roundIndex: 2,
    submissions: [],
    archive: [
      {
        roundIndex: 1,
        submissions: [
          {
            content: '贝吉塔大战超人，冲击波和眼中激光对中抵消。',
            status: 'rejected',
          },
        ],
      },
    ],
  });
});

test('影片级投稿接口只在第一条真人镜头剧情后启动本轮倒计时', async () => {
  const scheduled = await pool.query<{
    movie_id: string;
    slug: string;
    bible_id: string;
  }>(
    `SELECT m.id AS movie_id, m.slug, b.id AS bible_id
       FROM story_generators g
       JOIN movie_schedule_windows w ON w.generator_key = g.key AND w.enabled
       JOIN movies m ON m.id = w.movie_id
       JOIN movie_bible_versions b ON b.movie_id = m.id AND b.status = 'active'
      WHERE g.key = 'primary'
        AND (extract(hour FROM timezone(g.timezone, now()))::int * 60
             + extract(minute FROM timezone(g.timezone, now()))::int)
            >= w.start_minute
        AND (extract(hour FROM timezone(g.timezone, now()))::int * 60
             + extract(minute FROM timezone(g.timezone, now()))::int)
            < w.end_minute`,
  );
  const movie = scheduled.rows[0];
  await pool.query(
    `UPDATE movies SET production_status = 'ready', rights_status = 'original_cleared'
      WHERE id = $1`,
    [movie.movie_id],
  );
  const episode = await pool.query<{ id: string }>(
    `INSERT INTO episodes
       (movie_id, bible_version_id, episode_index, title, theme, status)
     VALUES ($1, $2, 1, 'Audience round', 'Wait for a submitted shot', 'open')
     RETURNING id`,
    [movie.movie_id, movie.bible_id],
  );
  const round = await pool.query<{ id: string }>(
    `INSERT INTO rounds
       (movie_id, round_index, episode_id, status, opens_at, closes_at)
     VALUES ($1, 1, $2, 'open', now(), NULL)
     RETURNING id`,
    [movie.movie_id, episode.rows[0].id],
  );
  const firstAuthor = await claimGuest();
  const before = Date.now();
  const first = await app.inject({
    method: 'POST',
    url: `/api/movies/${movie.slug}/round/current/submissions`,
    headers: { cookie: firstAuthor.cookie },
    payload: { kind: 'next_shot', content: '第一条真人镜头剧情' },
  });
  expect(first.statusCode).toBe(201);
  const armed = await pool.query<{ closes_at: Date | null }>(
    'SELECT closes_at FROM rounds WHERE id = $1',
    [round.rows[0].id],
  );
  const deadline = armed.rows[0].closes_at;
  if (deadline === null) throw new Error('movie-scoped submission did not arm round');
  expect(deadline.getTime() - before).toBeGreaterThanOrEqual(2_500);
  expect(deadline.getTime() - await databaseNow(pool)).toBeLessThanOrEqual(
    testConfig.ROUND_LENGTH_MS,
  );

  const secondAuthor = await claimGuest();
  const second = await app.inject({
    method: 'POST',
    url: `/api/movies/${movie.slug}/round/current/submissions`,
    headers: { cookie: secondAuthor.cookie },
    payload: { kind: 'next_shot', content: '第二条投稿不延长截止时间' },
  });
  expect(second.statusCode).toBe(201);
  const afterSecond = await pool.query<{ closes_at: Date | null }>(
    'SELECT closes_at FROM rounds WHERE id = $1',
    [round.rows[0].id],
  );
  expect(afterSecond.rows[0].closes_at?.getTime()).toBe(deadline.getTime());
});

test('影片目录从同名公开故事取两张角色图和两张场景图作为拼图海报', async () => {
  const { userId } = await claimGuest();
  const proposal = await pool.query<{ id: string }>(
    `INSERT INTO story_proposals
       (user_id, title, synopsis, status, published_at)
     VALUES ($1, 'Inland Empire High', 'Poster source', 'approved', now())
     RETURNING id`,
    [userId],
  );
  const proposalId = proposal.rows[0].id;
  await pool.query(
    `INSERT INTO story_images
       (proposal_id, kind, position, caption, file_url, mime, bytes, sha256)
     VALUES
       ($1, 'character', 0, 'C0', '/media/c0.webp', 'image/webp', 10, 'c0'),
       ($1, 'character', 1, 'C1', '/media/c1.webp', 'image/webp', 10, 'c1'),
       ($1, 'character', 2, 'C2', '/media/c2.webp', 'image/webp', 10, 'c2'),
       ($1, 'world', 0, 'W0', '/media/w0.webp', 'image/webp', 10, 'w0'),
       ($1, 'world', 1, 'W1', '/media/w1.webp', 'image/webp', 10, 'w1'),
       ($1, 'world', 2, 'W2', '/media/w2.webp', 'image/webp', 10, 'w2')`,
    [proposalId],
  );

  const catalog = await app.inject({ method: 'GET', url: '/api/movies' });
  expect(catalog.statusCode).toBe(200);
  const movies = catalog.json<{
    movies: Array<{
      slug: string;
      posterImages: string[];
      storySetting: string | null;
    }>;
  }>().movies;

  expect(
    movies.find((movie) => movie.slug === 'inland-empire-high')?.posterImages,
  ).toEqual([
    '/media/c0.webp',
    '/media/c1.webp',
    '/media/w0.webp',
    '/media/w1.webp',
  ]);
  expect(
    movies.find((movie) => movie.slug === 'whos-next')?.posterImages,
  ).toEqual([]);
  expect(
    movies.find((movie) => movie.slug === 'inland-empire-high')?.storySetting,
  ).toBe('Poster source');
});

test('测试用双片排期严格按 America/Los_Angeles 的 11:00 和 23:00 边界解析', async () => {
  const boundaries = await pool.query<{ local_minute: number; slug: string }>(
    `SELECT sample.local_minute, m.slug
       FROM (VALUES (659), (660), (1379), (1380)) AS sample(local_minute)
       JOIN movie_schedule_windows w
         ON w.generator_key = 'primary' AND w.enabled
        AND sample.local_minute >= w.start_minute
        AND sample.local_minute < w.end_minute
       JOIN movies m ON m.id = w.movie_id
      ORDER BY sample.local_minute`,
  );
  expect(boundaries.rows).toEqual([
    { local_minute: 659, slug: 'whos-next' },
    { local_minute: 660, slug: 'inland-empire-high' },
    { local_minute: 1379, slug: 'inland-empire-high' },
    { local_minute: 1380, slug: 'whos-next' },
  ]);

  const expected = await pool.query<{
    slug: string;
    local_minute: number;
  }>(
    `SELECT m.slug,
            (extract(hour FROM timezone(g.timezone, now()))::int * 60
             + extract(minute FROM timezone(g.timezone, now()))::int) AS local_minute
       FROM story_generators g
       JOIN movie_schedule_windows w ON w.generator_key = g.key AND w.enabled
       JOIN movies m ON m.id = w.movie_id
      WHERE g.key = 'primary'
        AND (extract(hour FROM timezone(g.timezone, now()))::int * 60
             + extract(minute FROM timezone(g.timezone, now()))::int)
            >= w.start_minute
        AND (extract(hour FROM timezone(g.timezone, now()))::int * 60
             + extract(minute FROM timezone(g.timezone, now()))::int)
            < w.end_minute`,
  );

  const response = await app.inject({ method: 'GET', url: '/api/program/current' });
  expect(response.statusCode).toBe(200);
  const body = response.json<{
    timezone: string;
    movie: { slug: string };
    startsAt: string;
    endsAt: string;
  }>();
  expect(body.timezone).toBe('America/Los_Angeles');
  expect(body.movie.slug).toBe(expected.rows[0].slug);
  expect(Date.parse(body.endsAt)).toBeGreaterThan(Date.parse(body.startsAt));
  expect(expected.rows[0].local_minute).toBeGreaterThanOrEqual(0);
});

test('集号、轮号和镜头号可在不同影片重复，播放清单和弹幕不会串片', async () => {
  const inland = await createScene(pool, {
    movieId: INLAND_EMPIRE_MOVIE_ID,
    bibleVersionId: INLAND_EMPIRE_BIBLE_ID,
    episodeIndex: 1,
    sceneIndex: 1,
    mediaMovieSlug: 'inland-empire-high',
  });
  const whosNext = await createScene(pool, {
    movieId: WHOS_NEXT_MOVIE_ID,
    bibleVersionId: WHOS_NEXT_BIBLE_ID,
    episodeIndex: 1,
    sceneIndex: 1,
    mediaMovieSlug: 'whos-next',
  });
  const { userId } = await claimGuest();
  await insertDanmaku(pool, {
    movieId: INLAND_EMPIRE_MOVIE_ID,
    userId,
    sceneIndex: 1,
    offsetMs: 100,
    content: '高校片弹幕',
  });
  await insertDanmaku(pool, {
    movieId: WHOS_NEXT_MOVIE_ID,
    userId,
    sceneIndex: 1,
    offsetMs: 200,
    content: 'Who\'s Next 弹幕',
  });

  const inlandPlaylist = await app.inject({
    method: 'GET',
    url: '/api/movies/inland-empire-high/playlist',
  });
  const whosNextPlaylist = await app.inject({
    method: 'GET',
    url: '/api/movies/whos-next/playlist',
  });
  expect(inlandPlaylist.json<{ scenes: Array<{ videoUrl: string }> }>().scenes)
    .toEqual([
      expect.objectContaining({
        videoUrl: expect.stringMatching(
          /^\/media\/inland-empire-high\/000001\.mp4\?v=[a-f0-9]{64}$/,
        ),
      }),
    ]);
  expect(whosNextPlaylist.json<{ scenes: Array<{ videoUrl: string }> }>().scenes)
    .toEqual([
      expect.objectContaining({
        videoUrl: expect.stringMatching(
          /^\/media\/whos-next\/000001\.mp4\?v=[a-f0-9]{64}$/,
        ),
      }),
    ]);

  const inlandDanmaku = await app.inject({
    method: 'GET',
    url: '/api/movies/inland-empire-high/scenes/1/danmaku',
  });
  const whosNextDanmaku = await app.inject({
    method: 'GET',
    url: '/api/movies/whos-next/scenes/1/danmaku',
  });
  expect(
    inlandDanmaku.json<{ danmaku: Array<{ content: string }> }>().danmaku,
  ).toEqual([expect.objectContaining({ content: '高校片弹幕' })]);
  expect(
    whosNextDanmaku.json<{ danmaku: Array<{ content: string }> }>().danmaku,
  ).toEqual([expect.objectContaining({ content: 'Who\'s Next 弹幕' })]);

  const episodes = await Promise.all([
    app.inject({ method: 'GET', url: '/api/movies/inland-empire-high/episodes' }),
    app.inject({ method: 'GET', url: '/api/movies/whos-next/episodes' }),
  ]);
  expect(episodes[0].json<{ episodes: Array<{ episodeIndex: number }> }>().episodes[0]
    .episodeIndex).toBe(1);
  expect(episodes[1].json<{ episodes: Array<{ episodeIndex: number }> }>().episodes[0]
    .episodeIndex).toBe(1);
  expect(inland.movieId).not.toBe(whosNext.movieId);
});

test('数据库拒绝跨影片关系和同一生成器的重叠排期', async () => {
  const inland = await createScene(pool, {
    movieId: INLAND_EMPIRE_MOVIE_ID,
    bibleVersionId: INLAND_EMPIRE_BIBLE_ID,
  });

  await expect(
    pool.query(
      `INSERT INTO rounds
         (movie_id, round_index, episode_id, status, opens_at, closes_at)
       VALUES ($1, 99, $2, 'published', now(), now())`,
      [WHOS_NEXT_MOVIE_ID, inland.episodeId],
    ),
  ).rejects.toMatchObject({
    code: '23503',
    constraint: 'rounds_episode_movie_fk',
  });

  await expect(
    pool.query(
      `INSERT INTO movie_schedule_windows
         (generator_key, movie_id, start_minute, end_minute, enabled, label)
       VALUES ('primary', $1, 600, 700, true, 'overlap test')`,
      [INLAND_EMPIRE_MOVIE_ID],
    ),
  ).rejects.toMatchObject({ code: '23P01' });
});

test('排期切片时旧影片先排空，只有完成后新影片才能取得唯一 GPU 租约', async () => {
  const scheduled = await pool.query<{ scheduled_id: string; previous_id: string }>(
    `SELECT w.movie_id AS scheduled_id,
            CASE WHEN w.movie_id = $1 THEN $2::uuid ELSE $1::uuid END AS previous_id
       FROM story_generators g
       JOIN movie_schedule_windows w ON w.generator_key = g.key AND w.enabled
      WHERE g.key = 'primary'
        AND (extract(hour FROM timezone(g.timezone, now()))::int * 60
             + extract(minute FROM timezone(g.timezone, now()))::int)
            >= w.start_minute
        AND (extract(hour FROM timezone(g.timezone, now()))::int * 60
             + extract(minute FROM timezone(g.timezone, now()))::int)
            < w.end_minute`,
    [INLAND_EMPIRE_MOVIE_ID, WHOS_NEXT_MOVIE_ID],
  );
  const { scheduled_id: scheduledId, previous_id: previousId } = scheduled.rows[0];
  // Whichever movie the synthetic two-movie schedule picks must be eligible
  // for the lease state machine; the seed only clears Who\'s Next.
  await pool.query(
    `UPDATE movies SET production_status = 'ready', rights_status = 'original_cleared'
      WHERE id = $1`,
    [scheduledId],
  );
  await pool.query(
    `UPDATE story_generators SET lease_movie_id = $1,
       lease_token = gen_random_uuid(), lease_expires_at = now() + interval '1 minute',
       heartbeat_at = now() WHERE key = 'primary'`,
    [previousId],
  );
  const job = await pool.query<{ id: string }>(
    `INSERT INTO workflow_jobs
       (movie_id, job_type, idempotency_key, status)
     VALUES ($1, 'round_finalize', $2, 'pending')
     RETURNING id`,
    [previousId, `drain-${Math.random()}`],
  );

  const draining = await withTransaction(pool, (client) =>
    reconcileGeneratorLease(client),
  );
  expect(draining).toMatchObject({
    movieId: previousId,
    scheduledMovieId: scheduledId,
    state: 'draining',
  });

  await pool.query(
    `UPDATE workflow_jobs SET status = 'succeeded', finished_at = now()
      WHERE id = $1`,
    [job.rows[0].id],
  );
  const acquired = await withTransaction(pool, (client) =>
    reconcileGeneratorLease(client),
  );
  expect(acquired).toMatchObject({
    movieId: scheduledId,
    scheduledMovieId: scheduledId,
    state: 'active',
  });

  const generator = await pool.query<{ lease_movie_id: string }>(
    `SELECT lease_movie_id FROM story_generators WHERE key = 'primary'`,
  );
  expect(generator.rows[0].lease_movie_id).toBe(scheduledId);
});
