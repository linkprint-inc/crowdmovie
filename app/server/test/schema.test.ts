// Constraint tests against a real PostgreSQL 18 database (see ./database).
// beforeAll creates the database if absent, drops every schema object so the
// migrations apply to a genuinely empty database (proving the
// migration-applies-on-empty-DB requirement), then runs the migrations.
import pg from 'pg';

import { runMigrations } from '../src/db/migrate';
import {
  WHOS_NEXT_MOVIE_ID,
  INLAND_EMPIRE_BIBLE_ID,
  INLAND_EMPIRE_MOVIE_ID,
} from '../src/movies/catalog';
import { ensureDatabase, TEST_URL } from './database';

let pool: pg.Pool;
let seq = 0;
// Unique suffix / integer per call. The DB is reset empty in beforeAll, so a
// simple counter is enough to keep unique keys (username_key, episode_index,
// round_index) from colliding within a run.
const uniq = (): string => `${Date.now().toString(36)}_${(seq += 1)}`;
const nextInt = (): number => (seq += 1);

async function resetSchema(): Promise<void> {
  const client = new pg.Client({ connectionString: TEST_URL });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }
}

async function makeUser(): Promise<string> {
  const s = uniq();
  const r = await pool.query(
    'INSERT INTO users (username_display, username_key) VALUES ($1, $2) RETURNING id',
    [`disp_${s}`, `key_${s}`],
  );
  return r.rows[0].id as string;
}

async function makeEpisode(): Promise<string> {
  const r = await pool.query(
    `INSERT INTO episodes
       (movie_id, bible_version_id, episode_index, title, theme, status)
     VALUES ($1, $2, $3, $4, $5, 'ended') RETURNING id`,
    [INLAND_EMPIRE_MOVIE_ID, INLAND_EMPIRE_BIBLE_ID, nextInt(), 'title', 'theme'],
  );
  return r.rows[0].id as string;
}

async function makeRound(episodeId: string): Promise<string> {
  const r = await pool.query(
    `INSERT INTO rounds
       (movie_id, round_index, episode_id, status, opens_at, closes_at)
     VALUES ($1, $2, $3, 'published', now(), now() + interval '5 minutes')
     RETURNING id`,
    [INLAND_EMPIRE_MOVIE_ID, nextInt(), episodeId],
  );
  return r.rows[0].id as string;
}

beforeAll(async () => {
  await ensureDatabase();
  await resetSchema();
  await runMigrations(TEST_URL);
  pool = new pg.Pool({ connectionString: TEST_URL });
}, 30_000);

afterAll(async () => {
  await pool?.end();
});

test('迁移可在空库应用：public 下创建全部 28 张表', async () => {
  const r = await pool.query(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
  );
  expect(r.rows[0].n).toBe(28);
});

test('同 username_key 二次插入抛 23505 (unique_violation)', async () => {
  const key = `dupkey_${uniq()}`;
  await pool.query(
    'INSERT INTO users (username_display, username_key) VALUES ($1, $2)',
    ['first', key],
  );
  await expect(
    pool.query(
      'INSERT INTO users (username_display, username_key) VALUES ($1, $2)',
      ['second', key],
    ),
  ).rejects.toMatchObject({ code: '23505' });
});

test('同 (round_id, user_id) 的第二条 next_shot 抛 23505 (partial unique)', async () => {
  const userId = await makeUser();
  const episodeId = await makeEpisode();
  const roundId = await makeRound(episodeId);
  await pool.query(
    `INSERT INTO submissions
       (movie_id, kind, round_id, episode_id, user_id, content)
     VALUES ($1, 'next_shot', $2, $3, $4, 'first')`,
    [INLAND_EMPIRE_MOVIE_ID, roundId, episodeId, userId],
  );
  await expect(
    pool.query(
      `INSERT INTO submissions
         (movie_id, kind, round_id, episode_id, user_id, content)
       VALUES ($1, 'next_shot', $2, $3, $4, 'second')`,
      [INLAND_EMPIRE_MOVIE_ID, roundId, episodeId, userId],
    ),
  ).rejects.toMatchObject({ code: '23505' });
});

test("kind='next_shot' 且 round_id IS NULL 违反 CHECK 抛 23514 (check_violation)", async () => {
  const userId = await makeUser();
  const episodeId = await makeEpisode();
  await expect(
    pool.query(
      `INSERT INTO submissions
         (movie_id, kind, round_id, episode_id, user_id, content)
       VALUES ($1, 'next_shot', NULL, $2, $3, 'x')`,
      [INLAND_EMPIRE_MOVIE_ID, episodeId, userId],
    ),
  ).rejects.toMatchObject({ code: '23514' });
});

// §16.1「外键取舍」：署名链路的 rounds.selected_submission_id 建 FK,
// 悬空 ID 必须被数据库拒绝(否则正片会署错人)。
test('rounds.selected_submission_id 指向不存在的投稿抛 23503 (foreign_key_violation)', async () => {
  const episodeId = await makeEpisode();
  const ghost = '00000000-0000-0000-0000-000000000000';
  await expect(
    pool.query(
      `INSERT INTO rounds
         (movie_id, round_index, episode_id, status, opens_at, closes_at,
          selected_submission_id)
       VALUES ($1, $2, $3, 'selected', now(), now() + interval '5 minutes', $4)`,
      [INLAND_EMPIRE_MOVIE_ID, nextInt(), episodeId, ghost],
    ),
  ).rejects.toMatchObject({ code: '23503' });
});

test('rounds.selected_submission_id 指向真实投稿可正常插入', async () => {
  const userId = await makeUser();
  const episodeId = await makeEpisode();
  const roundId = await makeRound(episodeId);
  const sub = await pool.query(
    `INSERT INTO submissions
       (movie_id, kind, round_id, episode_id, user_id, content)
     VALUES ($1, 'next_shot', $2, $3, $4, 'picked') RETURNING id`,
    [INLAND_EMPIRE_MOVIE_ID, roundId, episodeId, userId],
  );
  const submissionId = sub.rows[0].id as string;
  const r = await pool.query(
    `INSERT INTO rounds
       (movie_id, round_index, episode_id, status, opens_at, closes_at,
        selected_submission_id)
     VALUES ($1, $2, $3, 'selected', now(), now() + interval '5 minutes', $4)
     RETURNING selected_submission_id`,
    [INLAND_EMPIRE_MOVIE_ID, nextInt(), episodeId, submissionId],
  );
  expect(r.rows[0].selected_submission_id).toBe(submissionId);
});

test('submission_votes 主键 (submission_id, user_id) 去重抛 23505', async () => {
  const userId = await makeUser();
  const episodeId = await makeEpisode();
  const roundId = await makeRound(episodeId);
  const sub = await pool.query(
    `INSERT INTO submissions
       (movie_id, kind, round_id, episode_id, user_id, content)
     VALUES ($1, 'next_shot', $2, $3, $4, 'c') RETURNING id`,
    [INLAND_EMPIRE_MOVIE_ID, roundId, episodeId, userId],
  );
  const submissionId = sub.rows[0].id as string;
  await pool.query(
    'INSERT INTO submission_votes (submission_id, user_id, value) VALUES ($1, $2, 1)',
    [submissionId, userId],
  );
  await expect(
    pool.query(
      'INSERT INTO submission_votes (submission_id, user_id, value) VALUES ($1, $2, -1)',
      [submissionId, userId],
    ),
  ).rejects.toMatchObject({ code: '23505' });
});

test('迁移种子把 Who\'s Next 排成全天唯一节目并应用唯一大乱斗规则', async () => {
  const windows = await pool.query(
    `SELECT movie_id, start_minute, end_minute, label
       FROM movie_schedule_windows
      WHERE generator_key = 'primary' AND enabled
      ORDER BY start_minute`,
  );
  expect(windows.rows).toEqual([
    {
      movie_id: WHOS_NEXT_MOVIE_ID,
      start_minute: 0,
      end_minute: 1440,
      label: 'Who\'s Next · 全天',
    },
  ]);

  const movies = await pool.query(
    `SELECT slug, production_status, rights_status, display_order
       FROM movies ORDER BY display_order`,
  );
  expect(movies.rows).toEqual([
    {
      slug: 'whos-next',
      production_status: 'ready',
      rights_status: 'original_cleared',
      display_order: 10,
    },
    {
      slug: 'inland-empire-high',
      production_status: 'ready',
      rights_status: 'original_cleared',
      display_order: 20,
    },
  ]);

  const policy = await pool.query<{
    synopsis_i18n: Record<string, string>;
    story_rules: {
      oneRule: string;
    };
    world_rules: {
      cast: string;
      location: string;
      characterVisuals: string;
      backgroundDefault: string;
      backgroundOverride: string;
      namingRule: string;
      visualStyle: string;
      actionStyle: string;
      qualityReference: string;
      promptGrammar: string;
      tailChain: string;
    };
    camera_rules: {
      planSelection: string;
      plans: Record<string, string>;
      dominantIdeaCount: number;
      beatCadenceSeconds: string;
    };
    workflow_profile: {
      profile: string;
      styleProfile: string;
      characterProfile: string;
      promptGrammar: string[];
      firstShot: { pinnedReference: boolean; durationSeconds: number; noiseSeed: number };
    };
  }>(
    `SELECT m.synopsis_i18n, b.story_rules, b.world_rules, b.camera_rules, b.workflow_profile
       FROM movies m
       JOIN movie_bible_versions b ON b.movie_id = m.id AND b.status = 'active'
      WHERE m.id = $1`,
    [WHOS_NEXT_MOVIE_ID],
  );
  const customerSynopsis = policy.rows[0].synopsis_i18n['zh-CN'];
  expect(customerSynopsis).toContain('决定谁登场');
  expect(customerSynopsis).toContain('也可以创造自己的角色');
  expect(customerSynopsis).toContain('下一个镜头');
  expect(customerSynopsis).not.toContain('背景未指定');
  expect(customerSynopsis).not.toContain('皮克斯');
  expect(policy.rows[0].synopsis_i18n).toMatchObject({
    en: 'Now it’s your turn to direct: choose iconic figures from movies, games, animation, comics, history, and art—or create characters of your own. Decide who appears, where they meet, how they clash, and which signature moves they unleash. Write the next shot and vote for the stories you love, giving your idea a chance to become the next movie clip on screen.',
    ja: '今度はあなたが監督です。映画、ゲーム、アニメ、漫画、歴史、美術の名高い人物を選ぶことも、自分だけのキャラクターを生み出すこともできます。誰を登場させ、どこで出会わせ、どう戦わせ、どんな技を繰り出すかを決めてください。次のショットを書き、気に入った展開に投票すれば、あなたのアイデアが次に上映される映画の一場面になるかもしれません。',
    es: 'Ahora te toca dirigir: elige personajes icónicos del cine, los videojuegos, la animación, los cómics, la historia y el arte, o crea tus propios personajes. Decide quién aparece, dónde se encuentran, cómo se enfrentan y qué movimientos especiales desatan. Escribe el siguiente plano y vota por las historias que más te gusten para que tu idea tenga la oportunidad de convertirse en el próximo fragmento de la película que se proyecte.',
  });
  expect(Object.keys(policy.rows[0].story_rules)).toEqual(['oneRule']);
  expect(policy.rows[0].story_rules.oneRule).toContain(
    'movies, games, animation, comics, history and fine art',
  );
  expect(policy.rows[0].story_rules.oneRule).toContain('audience pitches may add original figures');
  expect(policy.rows[0].world_rules).toMatchObject({
    cast: 'no fixed or mandatory resident characters',
    location: 'unrestricted',
    visualStyle: expect.stringContaining('crisp high-detail full-3D'),
    actionStyle: expect.stringContaining('ordered causal action beats'),
    qualityReference: expect.stringContaining('Spider-Man and Batman'),
    promptGrammar: 'summary, detailed_description, overall_soundscape, non_diegetic_music',
    continuity: expect.stringContaining('previous published tail PNG'),
    tailChain: expect.stringContaining('at most one adjacent I2VA'),
    namingRule: expect.stringContaining('葫芦娃'),
  });
  expect(policy.rows[0].camera_rules).toMatchObject({
    planSelection: 'exactly one action-motivated plan per shot; no global default',
    dominantIdeaCount: 1,
    beatCadenceSeconds: '1.5-2',
    stabilizationPriority: 'background readability overrides camera speed and amplitude',
    forbiddenCameraMotion: 'fast, rapid, high-speed or large-amplitude camera recipes',
  });
  expect(Object.keys(policy.rows[0].camera_rules.plans).sort()).toEqual([
    '00-control-static-camera-8s',
    '01-tracking-rush-8s',
    '02-whip-pan-8s',
    '03-fast-orbit-8s',
    '04-push-in-impact-8s',
    '05-pov-5s',
    '06-crane-dive-8s',
    '07-speed-ramp-5s',
  ]);
  expect(policy.rows[0].camera_rules).not.toHaveProperty('defaultPlan');
  expect(policy.rows[0].workflow_profile).toMatchObject({
    profile: 'whos-next-v8',
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

  const characters = await pool.query<{ status: string; count: number }>(
    `SELECT status, count(*)::int AS count FROM movie_characters
      WHERE movie_id = $1 GROUP BY status ORDER BY status`,
    [WHOS_NEXT_MOVIE_ID],
  );
  expect(characters.rows).toEqual([{ status: 'retired', count: 4 }]);

  const thread = await pool.query(
    `SELECT 1 FROM site_settings WHERE key = 'codex_director_thread_id'`,
  );
  expect(thread.rowCount).toBe(0);
});
