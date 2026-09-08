import { databaseNow } from './database';
// T3.2 轮次状态机与 worker —《技术》§5 状态机、§5.2 通道并发、§5.3 时钟与恢复、
// §6.4 终审选择规则，验收 §17 的 6/7/8/9/18/19/20/27。
//
// Everything runs against the real PostgreSQL database, because every guarantee
// under test is a database guarantee: `closes_at <= now()`, conditional state
// transitions, `SKIP LOCKED`, `scenes.round_id UNIQUE`, advisory locks. A fake
// would be testing itself.
//
// Concurrency claims are proven with row locks and DB row counts rather than by
// racing promises: a JS race that happens to serialise proves nothing.
//
// The publish step's media gate (§5 step 5) is real here too: the fixture below
// encodes one small MP4 with ffmpeg once and copies it — plus four WebVTT
// sidecars — into the round's pending path before a round is allowed to publish.
// A test that skipped that would be asserting against a handler that publishes
// fiction, which is exactly the bug the gate exists to stop.
import { execFile as execFileCallback } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import pg from 'pg';

import {
  LOCALES,
} from '../src/ai/engine';
import { createStubEngine, STUB_RUBRIC_VERSION } from '../src/ai/stub';
import { createStubReviewer } from '../src/ai/story-review';
import type { Config } from '../src/config';
import { runMigrations } from '../src/db/migrate';
import { INLAND_EMPIRE_MOVIE_ID } from '../src/movies/catalog';
import { HANDLERS, type HandlerRegistry } from '../src/jobs/handlers/index';
import { NOT_STORY_CONTENT_FLAG } from '../src/jobs/handlers/score';
import type {
  HandlerContext,
  HandlerOutcome,
  RoundEngineSettings,
} from '../src/jobs/handlers/common';
import { loadPreviousScene } from '../src/jobs/handlers/common';
import { pickHighestScore } from '../src/jobs/handlers/finalize';
import { SCENE_INDEX_LOCK_KEY } from '../src/jobs/handlers/publish';
import { subtitleHandler } from '../src/jobs/handlers/subtitle';
import { episodeBootstrapJobKey, roundJobKey } from '../src/jobs/keys';
import {
  CHANNEL_CONCURRENCY,
  claimNext,
  complete,
  defer,
  enqueue,
  type Job,
  type JobType,
} from '../src/jobs/ledger';
import {
  ChannelRunner,
  silentLogger,
  startWorker,
  type Worker,
} from '../src/jobs/scheduler';
import { CLOCK_LOCK_KEY, nextWakeAt, tick } from '../src/rounds/clock';
import { buildApp } from '../src/web/app';
import {
  ensureDatabase,
  resetStory,
  restorePrimarySchedule,
  sleep,
  testConfig,
  TEST_URL,
  waitFor,
} from './helpers';

const execFile = promisify(execFileCallback);

let pool: pg.Pool;
let app: ReturnType<typeof buildApp>;
const workers: Worker[] = [];

let mediaDir: string;
/** One encoded MP4, copied per round rather than re-encoded. */
let sampleMp4: string;

const engine = createStubEngine();
// This suite never drives a `story_review` job; the field only exists so the
// `HandlerContext` literal below satisfies the interface.
const reviewer = createStubReviewer();
const settings: RoundEngineSettings = {
  topK: 10,
  voteAdoptThreshold: 10,
  roundLengthMs: testConfig.ROUND_LENGTH_MS,
  deferDelayMs: 50,
  // Filled in by beforeAll — the object is shared by reference with every
  // HandlerContext below, so the assignment reaches them all.
  mediaDir: '',
};

beforeAll(async () => {
  await ensureDatabase();
  await runMigrations(TEST_URL);
  pool = new pg.Pool({ connectionString: TEST_URL });
  app = buildApp(testConfig, pool, {
    guestClaimRateLimit: 10_000,
    submissionRateLimit: 10_000,
    voteRateLimit: 10_000,
  });
  await app.ready();

  mediaDir = await mkdtemp(join(tmpdir(), 'cm-round-media-'));
  settings.mediaDir = mediaDir;
  sampleMp4 = join(mediaDir, 'sample.mp4');
  await execFile('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=160x120:r=12:d=1',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=1',
    '-shortest',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    sampleMp4,
  ]);
}, 120_000);

afterEach(async () => {
  // Stopped here rather than inside each test so a failing assertion cannot
  // leave a worker running against the next test's data.
  while (workers.length > 0) await workers.pop()?.stop();
});

afterAll(async () => {
  if (pool !== undefined) await restorePrimarySchedule(pool);
  await app?.close();
  await pool?.end();
  if (mediaDir !== undefined) await rm(mediaDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetStory(pool);
  // This legacy pipeline suite always exercises Inland Empire. Pin its window
  // for the duration of the file so CI behaves the same at 10:00 and 22:00;
  // multi-movie.test.ts separately verifies the real 11:00/23:00 schedule.
  await rm(join(mediaDir, 'pending'), { recursive: true, force: true });
});

function track(worker: Worker): Worker {
  workers.push(worker);
  return worker;
}

// --- 测试工具 ----------------------------------------------------------------

async function claimGuest(): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const response = await app.inject({
    method: 'POST',
    url: '/api/identity/guest',
    payload: { username: `rt_${suffix}` },
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.find((each) => each.name === 'cm_guest');
  if (cookie === undefined) throw new Error('no guest cookie');
  return `cm_guest=${cookie.value}`;
}

function submit(cookie: string, content: string, kind = 'next_shot') {
  return app.inject({
    method: 'POST',
    url: '/api/round/current/submissions',
    headers: { cookie },
    payload: { kind, content },
  });
}

/**
 * Claim one job of `jobType` and run it through its real handler exactly the way
 * `scheduler.ts` does — including writing the outcome back to the ledger — but
 * synchronously, one job at a time, so a test can assert on each step.
 */
async function driveJob(
  jobType: JobType,
  withEngine = engine,
  h3?: HandlerContext['h3'],
): Promise<{ job: Job; outcome: HandlerOutcome }> {
  const job = await claimNext(pool, [jobType], { leaseMs: 60_000 });
  if (job === null) throw new Error(`no ${jobType} job to claim`);
  const handler = HANDLERS[jobType];
  if (handler === undefined) throw new Error(`no handler for ${jobType}`);
  const context: HandlerContext = {
    pool,
    engine: withEngine,
    reviewer,
    job,
    settings,
    log: silentLogger,
    ...(h3 === undefined ? {} : { h3 }),
  };
  const outcome = await handler(context);
  if (outcome.kind === 'defer') await defer(pool, job.id, new Date());
  else await complete(pool, job.id);
  return { job, outcome };
}

/** As above, but the job is required to finish. */
async function driveOnce(
  jobType: JobType,
  withEngine = engine,
  h3?: HandlerContext['h3'],
): Promise<{ job: Job; note?: string }> {
  const { job, outcome } = await driveJob(jobType, withEngine, h3);
  if (outcome.kind !== 'done') {
    throw new Error(`${jobType} deferred: ${outcome.reason}`);
  }
  return { job, note: outcome.note };
}

async function expireRound(roundId: string): Promise<void> {
  await pool.query(
    "UPDATE rounds SET closes_at = now() - interval '1 second' WHERE id = $1",
    [roundId],
  );
}

async function roundStatus(roundId: string): Promise<string> {
  const result = await pool.query<{ status: string }>(
    'SELECT status FROM rounds WHERE id = $1',
    [roundId],
  );
  return result.rows[0].status;
}

/** `null` while the round is still 未点火 (§5.3): nobody has submitted yet. */
async function roundDeadline(roundId: string): Promise<Date | null> {
  const result = await pool.query<{ closes_at: Date | null }>(
    'SELECT closes_at FROM rounds WHERE id = $1',
    [roundId],
  );
  return result.rows[0].closes_at;
}

async function enableAutomaticScenes(limit: number): Promise<void> {
  await pool.query(
    `INSERT INTO site_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [`movie:${INLAND_EMPIRE_MOVIE_ID}:automatic_scene_limit`, JSON.stringify(limit)],
  );
}

async function openRound(): Promise<{ id: string; episode_id: string }> {
  const result = await pool.query<{ id: string; episode_id: string }>(
    "SELECT id, episode_id FROM rounds WHERE status = 'open' LIMIT 1",
  );
  if (result.rows[0] === undefined) throw new Error('no open round');
  return result.rows[0];
}

/**
 * Put the five files the publish gate (§5 step 5) requires at the pending path
 * `video_generate` names for `roundId`. `omit` drops one of them, which is how
 * the gate's per-file assertions are made without hand-building a path.
 */
async function writePendingMedia(
  roundId: string,
  omit: string[] = [],
): Promise<void> {
  const dir = join(mediaDir, 'pending');
  await mkdir(dir, { recursive: true });
  if (!omit.includes('mp4')) {
    await copyFile(sampleMp4, join(dir, `${roundId}.mp4`));
  }
  for (const locale of LOCALES) {
    if (omit.includes(locale)) continue;
    await writeFile(
      join(dir, `${roundId}.${locale}.vtt`),
      'WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nfixture cue\n',
      'utf8',
    );
  }
}

/** `testConfig` pointed at this suite's temporary media root. */
function workerConfig(): Config {
  return { ...testConfig, MEDIA_DIR: mediaDir };
}

/**
 * The real pipeline plus the one thing M5 will do and the stub cannot: leave
 * files on disk. `subtitle_author` is the last step before the publish gate, so
 * writing all five there stands in for「video_generate 下载 MP4」and
 * 「subtitle_author 渲染四份 WebVTT」together.
 *
 * Only the worker-driven tests need it — a test that drives jobs by hand knows
 * the round id and calls `writePendingMedia` itself.
 */
const filmingHandlers: HandlerRegistry = {
  ...HANDLERS,
  subtitle_author: async (context) => {
    // Before the real handler, not after: `subtitle_author` enqueues
    // `media_validate_publish` inside its transaction, so the media channel can
    // be running the publish job the instant that COMMIT lands. Files written
    // afterwards would arrive too late — which is how the gate first proved
    // itself here.
    if (context.job.roundId !== null) {
      await writePendingMedia(context.job.roundId);
    }
    return subtitleHandler(context);
  },
};

// Tests whose subject is the user-submission pipeline intentionally keep the
// new-episode bootstrap pending so it cannot win the empty first round before
// the fixture submits. Bootstrap itself is covered independently above.
const manualStoryHandlers: HandlerRegistry = {
  ...HANDLERS,
  episode_bootstrap: undefined,
};
const manualFilmingHandlers: HandlerRegistry = {
  ...filmingHandlers,
  episode_bootstrap: undefined,
};

/**
 * Take a round from `open` all the way to `validating` with the real handlers,
 * leaving its `media_validate_publish` job pending, and its media on disk.
 * Deterministic: no worker, no timers, one job at a time.
 */
async function driveToValidating(cookie: string, content: string): Promise<string> {
  await tick(pool);
  const round = await openRound();
  expect((await submit(cookie, content)).statusCode).toBe(201);
  await expireRound(round.id);
  await tick(pool);

  await driveOnce('submission_score');
  await driveOnce('round_finalize');
  await driveOnce('scene_director');
  await driveOnce('video_generate');
  await driveOnce('subtitle_author');
  expect(await roundStatus(round.id)).toBe('validating');
  await writePendingMedia(round.id);
  return round.id;
}

// --- §5.3 时钟 ---------------------------------------------------------------

test('§5.3 时钟：首次 tick 建集与第一轮，轮次未点火而 opens_at 是绝对时间', async () => {
  const before = Date.now();
  const result = await tick(pool);
  expect(result.ran).toBe(true);
  expect(result.openRoundId).not.toBeNull();

  const rounds = await pool.query<{
    round_index: string;
    status: string;
    opens_at: Date;
    closes_at: Date | null;
  }>('SELECT round_index, status, opens_at, closes_at FROM rounds');
  expect(rounds.rowCount).toBe(1);
  expect(Number(rounds.rows[0].round_index)).toBe(1);
  expect(rounds.rows[0].status).toBe('open');
  // 新轮次未点火：截止时间由第一条投稿写入，时钟不预先编一个出来。
  expect(rounds.rows[0].closes_at).toBeNull();
  // opens_at 取数据库自己的 now()，是一个绝对时间而不是相对刻度（§5.3）。
  expect(rounds.rows[0].opens_at.getTime()).toBeGreaterThanOrEqual(before - 1_000);
  expect(rounds.rows[0].opens_at.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);

  const episodes = await pool.query('SELECT * FROM episodes');
  expect(episodes.rowCount).toBe(1);
  const bootstrap = await pool.query<{ status: string }>(
    `SELECT status FROM workflow_jobs
      WHERE idempotency_key = $1 AND job_type = 'episode_bootstrap'`,
    [episodeBootstrapJobKey(episodes.rows[0].id as string)],
  );
  expect(bootstrap.rows).toEqual([{ status: 'pending' }]);
});

test('空轮持续等待真人镜头剧情，bootstrap 不创建 AI 自动编剧任务', async () => {
  await tick(pool);
  const round = await openRound();
  let outlineCalls = 0;
  let shotCalls = 0;
  const screenwriter = createStubEngine({
    proposeEpisodeTheme: () => {
      outlineCalls += 1;
      return {
        title: '等待观众的开场',
        theme: '只更新本集大纲，在有人投稿前不生成镜头。',
      };
    },
    writeAutomaticShot: () => {
      shotCalls += 1;
      return { content: '这条 AI 镜头不应该被生成' };
    },
  });

  await driveOnce('episode_bootstrap', screenwriter);
  await tick(pool);

  expect(outlineCalls).toBe(1);
  expect(shotCalls).toBe(0);
  expect(
    (
      await pool.query<{ title: string; theme: string }>(
        'SELECT title, theme FROM episodes WHERE id = $1',
        [round.episode_id],
      )
    ).rows[0],
  ).toEqual({
    title: '等待观众的开场',
    theme: '只更新本集大纲，在有人投稿前不生成镜头。',
  });
  expect(await roundStatus(round.id)).toBe('open');
  expect(await roundDeadline(round.id)).toBeNull();
  expect(
    (
      await pool.query(
        "SELECT id FROM workflow_jobs WHERE job_type = 'ai_screenwriter'",
      )
    ).rowCount,
  ).toBe(0);
});

test('后续新集 bootstrap 把上一集主题交给 Sol，避免重复背景', async () => {
  await tick(pool);
  const firstRound = await openRound();
  const firstOutline = createStubEngine({
    proposeEpisodeTheme: () => ({
      title: 'Ashen Cathedral Siege',
      theme: 'A ruined basalt cathedral suspended over a molten chasm.',
    }),
  });
  await driveOnce('episode_bootstrap', firstOutline);

  await pool.query(
    `UPDATE rounds SET status = 'generation_failed', updated_at = now()
      WHERE id = $1`,
    [firstRound.id],
  );
  await pool.query(
    `UPDATE episodes SET status = 'ended', ended_at = now(),
                         end_reason = 'fixture rotation'
      WHERE id = $1`,
    [firstRound.episode_id],
  );
  const secondEpisode = await pool.query<{ id: string }>(
    `INSERT INTO episodes
       (movie_id, bible_version_id, episode_index, title, theme, status)
     SELECT movie_id, bible_version_id, 2, '第一集',
            '开场设定待定：首集主题由 §5.4 的提案或 episode_theme 任务确定。',
            'open'
       FROM episodes WHERE id = $1
     RETURNING id`,
    [firstRound.episode_id],
  );
  const secondRound = await pool.query<{ id: string }>(
    `INSERT INTO rounds
       (movie_id, round_index, episode_id, status, opens_at, closes_at)
     VALUES ($1, 2, $2, 'open', now(), NULL)
     RETURNING id`,
    [INLAND_EMPIRE_MOVIE_ID, secondEpisode.rows[0].id],
  );
  await enqueue(pool, {
    jobType: 'episode_bootstrap',
    idempotencyKey: episodeBootstrapJobKey(secondEpisode.rows[0].id),
    movieId: INLAND_EMPIRE_MOVIE_ID,
    roundId: secondRound.rows[0].id,
    payload: { episodeId: secondEpisode.rows[0].id },
  });

  let receivedPreviousTheme: string | null | undefined;
  const secondOutline = createStubEngine({
    proposeEpisodeTheme: (input) => {
      receivedPreviousTheme = input.previousTheme;
      return {
        title: 'Frozen Ossuary Crossing',
        theme: 'A frozen ossuary bridge under an aurora.',
      };
    },
  });
  await driveOnce('episode_bootstrap', secondOutline);

  expect(receivedPreviousTheme).toBe(
    'A ruined basalt cathedral suspended over a molten chasm.',
  );
});

test('影片开启自动补片后，bootstrap 创建 AI 投稿并为剩余额度打开下一轮倒计时', async () => {
  await enableAutomaticScenes(2);
  await tick(pool);
  const round = await openRound();
  let shotCalls = 0;
  const autonomous = createStubEngine({
    proposeEpisodeTheme: () => ({
      title: '自动开场',
      theme: 'Sonic and Superman race for a falling crown.',
    }),
    writeAutomaticShot: () => {
      shotCalls += 1;
      return {
        content:
          'Sonic Spin Dashes under Superman and kicks the falling crown skyward. "Catch me!"',
      };
    },
  });

  await driveOnce('episode_bootstrap', autonomous);
  expect(await roundStatus(round.id)).toBe('selecting');
  expect(
    (
      await pool.query(
        `SELECT id FROM workflow_jobs
          WHERE round_id = $1 AND job_type = 'ai_screenwriter'`,
        [round.id],
      )
    ).rowCount,
  ).toBe(1);

  await driveOnce('ai_screenwriter', autonomous);
  expect(shotCalls).toBe(1);
  const submission = await pool.query<{ content: string; username_display: string }>(
    `SELECT s.content, u.username_display
       FROM submissions s JOIN users u ON u.id = s.user_id
      WHERE s.round_id = $1`,
    [round.id],
  );
  expect(submission.rows).toEqual([
    {
      content:
        'Sonic Spin Dashes under Superman and kicks the falling crown skyward. "Catch me!"',
      username_display: 'AI Director',
    },
  ]);

  const successor = await openRound();
  expect(successor.id).not.toBe(round.id);
  expect(await roundDeadline(successor.id)).not.toBeNull();
});

test('后继 AI 编剧等待上一轮正式发布后再读取完整前幕', async () => {
  await enableAutomaticScenes(2);
  await tick(pool);
  const first = await openRound();
  const previousSceneCounts: number[] = [];
  const autonomous = createStubEngine({
    proposeEpisodeTheme: () => ({
      title: '按发布顺序续写',
      theme: 'Sonic races Vader toward an unstable Chaos Emerald.',
    }),
    writeAutomaticShot: (input) => {
      previousSceneCounts.push(input.previousScenes.length);
      return {
        content:
          input.previousScenes.length === 0
            ? 'Sonic Spin Dashes past Vader and knocks the Chaos Emerald into the clockwork gears.'
            : 'Godzilla tears through the roof as the energized gears launch the Chaos Emerald skyward.',
      };
    },
  });

  await driveOnce('episode_bootstrap', autonomous);
  await driveOnce('ai_screenwriter', autonomous);
  const successor = await openRound();
  await expireRound(successor.id);
  await tick(pool);

  const deferred = await driveJob('ai_screenwriter', autonomous);
  expect(deferred.outcome).toEqual({
    kind: 'defer',
    reason: 'an earlier scene is not published yet',
  });
  expect(previousSceneCounts).toEqual([0]);

  await driveOnce('submission_score', autonomous);
  await driveOnce('round_finalize', autonomous);
  await driveOnce('scene_director', autonomous);
  await driveOnce('video_generate', autonomous);
  await driveOnce('subtitle_author', autonomous);
  await writePendingMedia(first.id);
  await driveOnce('media_validate_publish', autonomous);

  await driveOnce('ai_screenwriter', autonomous);
  expect(previousSceneCounts).toEqual([0, 1]);
});

test('自动补片达到影片额度后不再点火，但真人投稿仍可继续', async () => {
  await enableAutomaticScenes(1);
  await tick(pool);
  const first = await openRound();
  const autonomous = createStubEngine({
    proposeEpisodeTheme: () => ({
      title: '最后一个自动名额',
      theme: 'Batman intercepts G1 Optimus Prime inside a museum atrium.',
    }),
    writeAutomaticShot: () => ({
      content:
        'Batman grapples across G1 Optimus Prime’s charge and snaps, "Not today!"',
    }),
  });

  await driveOnce('episode_bootstrap', autonomous);
  await driveOnce('ai_screenwriter', autonomous);
  const successor = await openRound();
  expect(await roundDeadline(successor.id)).toBeNull();

  await driveOnce('submission_score', autonomous);
  await driveOnce('round_finalize', autonomous);
  await driveOnce('scene_director', autonomous);
  await driveOnce('video_generate', autonomous);
  await driveOnce('subtitle_author', autonomous);
  await writePendingMedia(first.id);
  await driveOnce('media_validate_publish', autonomous);
  expect(
    Number(
      (
        await pool.query<{ count: string }>(
          'SELECT count(*) FROM scenes WHERE movie_id = $1',
          [INLAND_EMPIRE_MOVIE_ID],
        )
      ).rows[0].count,
    ),
  ).toBe(1);

  await tick(pool);
  expect(await roundDeadline(successor.id)).toBeNull();
  expect(
    (
      await pool.query(
        `SELECT id FROM workflow_jobs
          WHERE round_id = $1 AND job_type = 'ai_screenwriter'`,
        [successor.id],
      )
    ).rowCount,
  ).toBe(0);

  const human = await submit(
    await claimGuest(),
    'Spider-Man web-swings past Dracula and steals the moonlit key.',
  );
  expect(human.statusCode).toBe(201);
  expect(await roundDeadline(successor.id)).not.toBeNull();
});

test('真人投稿会占用自动 scene 名额，后续空轮在总额度处停止点火', async () => {
  await enableAutomaticScenes(2);
  await tick(pool);
  const first = await openRound();
  const autonomous = createStubEngine({
    proposeEpisodeTheme: () => ({
      title: '人机共同接龙',
      theme: 'The audience can take either of the first two scene slots.',
    }),
    writeAutomaticShot: () => ({
      content:
        'Sonic races Van Gogh through a rain of painted stars. "Keep up!"',
    }),
  });
  await driveOnce('episode_bootstrap', autonomous);
  await driveOnce('ai_screenwriter', autonomous);

  const second = await openRound();
  expect(second.id).not.toBe(first.id);
  expect(await roundDeadline(second.id)).not.toBeNull();
  expect(
    (
      await submit(
        await claimGuest(),
        'G1 Optimus Prime catches Sonic and hurls him through Van Gogh’s starry portal.',
      )
    ).statusCode,
  ).toBe(201);
  await expireRound(second.id);
  await tick(pool);

  expect(await roundStatus(second.id)).toBe('selecting');
  const third = await openRound();
  expect(third.id).not.toBe(second.id);
  expect(await roundDeadline(third.id)).toBeNull();
  expect(
    (
      await pool.query(
        `SELECT id FROM workflow_jobs
          WHERE round_id = $1 AND job_type = 'ai_screenwriter'`,
        [third.id],
      )
    ).rowCount,
  ).toBe(0);
});

test('有人投稿的轮次截止后，新开的空轮不预设五分钟截止时间', async () => {
  await tick(pool);
  const first = await openRound();
  expect((await submit(await claimGuest(), '真人提交的镜头剧情')).statusCode).toBe(
    201,
  );
  await expireRound(first.id);

  await tick(pool);

  const successor = await openRound();
  expect(successor.id).not.toBe(first.id);
  expect(await roundDeadline(successor.id)).toBeNull();
});

test('本集已有大纲时 bootstrap 不重写，也不创建 AI 镜头投稿', async () => {
  await tick(pool);
  const round = await openRound();
  await pool.query(
    `UPDATE episodes SET title = $2, theme = $3 WHERE id = $1`,
    [round.episode_id, '已有标题', '已有的多镜头集级剧情大纲'],
  );
  let outlineCalls = 0;
  const screenwriter = createStubEngine({
    proposeEpisodeTheme: () => {
      outlineCalls += 1;
      return { title: '不应采用', theme: '不应采用' };
    },
  });

  await driveOnce('episode_bootstrap', screenwriter);
  expect(outlineCalls).toBe(0);
  expect(await roundStatus(round.id)).toBe('open');
  expect(await roundDeadline(round.id)).toBeNull();
  expect(
    (
      await pool.query(
        `SELECT id FROM ai_runs
          WHERE round_id = $1 AND run_type = 'generation_event'`,
        [round.id],
      )
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await pool.query(
        `SELECT id FROM submissions
          WHERE round_id = $1 AND kind = 'next_shot'`,
        [round.id],
      )
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await pool.query(
        `SELECT id FROM workflow_jobs
          WHERE round_id = $1 AND job_type = 'ai_screenwriter'`,
        [round.id],
      )
    ).rowCount,
  ).toBe(0);
});

test('bootstrap 写大纲期间若用户先投稿，不抢占、不删除用户轮次', async () => {
  const author = await claimGuest();
  await tick(pool);
  const round = await openRound();
  expect((await submit(author, '用户抢先提交的首镜头')).statusCode).toBe(201);

  let outlineCalls = 0;
  const screenwriter = createStubEngine({
    proposeEpisodeTheme: () => {
      outlineCalls += 1;
      return { title: '竞态后的大纲', theme: '先建立目标，再逐镜头升级冲突。' };
    },
  });
  await driveOnce('episode_bootstrap', screenwriter);

  expect(outlineCalls).toBe(1);
  expect(await roundStatus(round.id)).toBe('open');
  expect(await roundDeadline(round.id)).not.toBeNull();
  expect(
    (
      await pool.query(
        `SELECT id FROM submissions
          WHERE round_id = $1 AND kind = 'next_shot'`,
        [round.id],
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (
      await pool.query(
        `SELECT id FROM workflow_jobs
          WHERE idempotency_key = $1 AND job_type = 'ai_screenwriter'`,
        [roundJobKey('ai_screenwriter', round.id, INLAND_EMPIRE_MOVIE_ID)],
      )
    ).rowCount,
  ).toBe(0);
});

test('§5.3 时钟：未到 closes_at 的轮次不关闭，重复 tick 也不会多开一轮', async () => {
  await tick(pool);
  const round = await openRound();
  await tick(pool);
  await tick(pool);

  const rounds = await pool.query('SELECT id FROM rounds');
  expect(rounds.rowCount).toBe(1);
  expect(await roundStatus(round.id)).toBe('open');
});

test('§5.3 空轮不靠倒计时推进：bootstrap worker 未执行前编号原地不动', async () => {
  await tick(pool);
  const round = await openRound();
  // 未点火：新开的轮次没有截止时间，倒计时也就无从谈起。
  expect(await roundDeadline(round.id)).toBeNull();

  await tick(pool);
  await tick(pool);

  const rounds = await pool.query('SELECT id FROM rounds');
  expect(rounds.rowCount).toBe(1);
  expect(await roundStatus(round.id)).toBe('open');
  expect(await roundDeadline(round.id)).toBeNull();
  // 空轮不由倒计时关闭，所以没有终审任务。episode_bootstrap
  // 只可以补本集大纲，不得自己发明首镜头。
  const jobs = await pool.query(
    "SELECT id FROM workflow_jobs WHERE job_type = 'round_finalize'",
  );
  expect(jobs.rowCount).toBe(0);
});

test('§5.3 第一条投稿点火：截止时间从这条投稿起算，之后照常关闭', async () => {
  const cookie = await claimGuest();
  await tick(pool);
  const round = await openRound();

  const before = Date.now();
  expect((await submit(cookie, '点燃这一轮的第一条')).statusCode).toBe(201);
  const deadline = await roundDeadline(round.id);
  if (deadline === null) throw new Error('the round was not armed');
  // testConfig 的 ROUND_LENGTH_MS 是 3 秒；点火从投稿那一刻算起，而不是从
  // 轮次创建时算起，所以后来的人也有完整一轮的时间投票。
  expect(deadline.getTime() - before).toBeGreaterThanOrEqual(2_500);
  expect(deadline.getTime() - await databaseNow(pool)).toBeLessThanOrEqual(3_000);

  // 第二条投稿不会重新点火：截止时间只由第一条决定。
  expect((await submit(await claimGuest(), '第二条不该改截止时间')).statusCode).toBe(201);
  expect((await roundDeadline(round.id))?.getTime()).toBe(deadline.getTime());

  await expireRound(round.id);
  const result = await tick(pool);
  expect(result.closedRoundIds).toEqual([round.id]);
});

test('§5.3 启动恢复会取消空轮的遗留截止时间，不创建 AI 编剧任务', async () => {
  await tick(pool);
  const round = await openRound();
  // 迁移之前留下的轮次：有截止时间，却一条投稿也没有。
  await expireRound(round.id);

  const result = await tick(pool);

  expect(result.closedRoundIds).toEqual([]);
  expect(result.openRoundId).toBe(round.id);
  expect(await roundStatus(round.id)).toBe('open');
  expect(await roundDeadline(round.id)).toBeNull();
  expect(
    (
      await pool.query<{ status: string }>(
        `SELECT status FROM workflow_jobs
          WHERE idempotency_key = $1 AND job_type = 'ai_screenwriter'`,
        [roundJobKey('ai_screenwriter', round.id, INLAND_EMPIRE_MOVIE_ID)],
      )
    ).rowCount,
  ).toBe(0);
  // 遗留的过期时间已经被取消，lookahead 不会在它上空转。
  expect(await nextWakeAt(pool)).toBeNull();

  const repeated = await tick(pool);
  expect(repeated.openRoundId).toBe(round.id);
  expect(
    (
      await pool.query("SELECT id FROM rounds WHERE status = 'open'")
    ).rowCount,
  ).toBe(1);
});

test('§5.3 启动恢复保持未点火后继轮无截止时间', async () => {
  await tick(pool);
  const first = await openRound();
  await pool.query(
    "UPDATE rounds SET status = 'generating', selection_mode = 'auto' WHERE id = $1",
    [first.id],
  );

  await tick(pool);
  const successor = await openRound();
  expect(successor.id).not.toBe(first.id);
  await pool.query('UPDATE rounds SET closes_at = NULL WHERE id = $1', [successor.id]);
  expect(await roundDeadline(successor.id)).toBeNull();

  const recovered = await tick(pool);
  expect(recovered.openRoundId).toBe(successor.id);
  const deadline = await roundDeadline(successor.id);
  expect(deadline).toBeNull();
});

test('遗留 AI screenwriter 任务不再写镜头，并把空轮恢复为等待真人投稿', async () => {
  await tick(pool);
  const round = await openRound();
  await pool.query(
    `UPDATE rounds
        SET status = 'selecting', selection_mode = 'auto', closes_at = now()
      WHERE id = $1`,
    [round.id],
  );
  await enqueue(pool, {
    jobType: 'ai_screenwriter',
    idempotencyKey: roundJobKey(
      'ai_screenwriter',
      round.id,
      INLAND_EMPIRE_MOVIE_ID,
    ),
    movieId: INLAND_EMPIRE_MOVIE_ID,
    roundId: round.id,
  });
  let shotCalls = 0;
  const retiredWriter = createStubEngine({
    writeAutomaticShot: () => {
      shotCalls += 1;
      return { content: '不应该生成的遗留 AI 镜头' };
    },
  });

  await driveOnce('ai_screenwriter', retiredWriter);

  expect(shotCalls).toBe(0);
  const restored = await pool.query<{
    status: string;
    selection_mode: string | null;
    selected_submission_id: string | null;
    closes_at: Date | null;
  }>(
    `SELECT status, selection_mode, selected_submission_id, closes_at
       FROM rounds WHERE id = $1`,
    [round.id],
  );
  expect(restored.rows[0]).toEqual({
    status: 'open',
    selection_mode: null,
    selected_submission_id: null,
    closes_at: null,
  });
  expect(
    (
      await pool.query(
        "SELECT id FROM submissions WHERE round_id = $1 AND kind = 'next_shot'",
        [round.id],
      )
    ).rowCount,
  ).toBe(0);
});

test('§5.3 时钟：以数据库 closes_at 为准关闭，同事务冻结计票并入队 round_finalize', async () => {
  await tick(pool);
  const round = await openRound();
  const cookie = await claimGuest();
  expect((await submit(cookie, '冻结前的投稿')).statusCode).toBe(201);

  // The in-process timer has not fired and never will in this test: moving
  // `closes_at` into the past is the only thing that closes the round.
  await expireRound(round.id);
  const result = await tick(pool);

  expect(result.closedRoundIds).toEqual([round.id]);
  expect(await roundStatus(round.id)).toBe('selecting');

  const frozen = await pool.query<{ votes_frozen_at: Date | null }>(
    'SELECT votes_frozen_at FROM submissions WHERE round_id = $1',
    [round.id],
  );
  expect(frozen.rows[0].votes_frozen_at).not.toBeNull();

  const job = await pool.query(
    'SELECT status FROM workflow_jobs WHERE idempotency_key = $1',
    [roundJobKey('round_finalize', round.id, INLAND_EMPIRE_MOVIE_ID)],
  );
  expect(job.rowCount).toBe(1);

  // §17.8: closing one round opens exactly one more.
  const open = await pool.query("SELECT id FROM rounds WHERE status = 'open'");
  expect(open.rowCount).toBe(1);
});

test('§5.3 时钟：另一个进程持有时钟锁时本次 tick 不做任何事', async () => {
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock($1)', [CLOCK_LOCK_KEY]);

    const result = await tick(pool);
    expect(result.ran).toBe(false);
    const rounds = await pool.query('SELECT id FROM rounds');
    expect(rounds.rowCount).toBe(0);

    await holder.query('ROLLBACK');
  } finally {
    holder.release();
  }

  // With the lock released the very same call does create the round, so the
  // assertion above is about the lock and not about a broken tick.
  expect((await tick(pool)).ran).toBe(true);
});

// --- §6.4 选择规则 -----------------------------------------------------------

test('§6.4 决胜顺序由后端执行：Terra 初评分 → 更早投稿 → 较小 ID', () => {
  const early = new Date('2026-01-01T00:00:00Z');
  const late = new Date('2026-01-01T00:00:05Z');
  const rows = [
    { id: 'bbb', score_total: 50, created_at: early },
    { id: 'aaa', score_total: 50, created_at: early },
    { id: 'ccc', score_total: 90, created_at: late },
    { id: 'ddd', score_total: 50, created_at: early },
  ];

  expect(pickHighestScore(rows)).toBe('ccc');
  // Tied on score → the earlier submission.
  expect(
    pickHighestScore([rows[0], { ...rows[2], score_total: rows[0].score_total }]),
  ).toBe('bbb');
  // Tied on score and time → the smaller ID.
  expect(pickHighestScore([rows[0], rows[1], rows[3]])).toBe('aaa');
});

test('§6.4 倒数结束直接取 Terra 最高分，不调用 Sol 终审', async () => {
  const cookieA = await claimGuest();
  const cookieB = await claimGuest();
  await tick(pool);
  const round = await openRound();
  expect((await submit(cookieA, 'alpha pitch')).statusCode).toBe(201);
  expect((await submit(cookieB, 'beta pitch')).statusCode).toBe(201);
  await expireRound(round.id);
  await tick(pool);
  await driveOnce('submission_score');
  await driveOnce('submission_score');

  const scores = await pool.query<{ id: string; score_total: number }>(
    `SELECT s.id, sc.score_total FROM submissions s
       JOIN submission_scores sc ON sc.submission_id = s.id
      WHERE s.round_id = $1 ORDER BY sc.score_total DESC`,
    [round.id],
  );
  const best = scores.rows[0].id;
  const worst = scores.rows[1].id;
  expect(best).not.toBe(worst);

  let finalizeCalls = 0;
  const spy = createStubEngine({
    finalizeRound: (_input, base) => {
      finalizeCalls += 1;
      return { ...base, selectedSubmissionId: worst };
    },
  });
  await driveOnce('round_finalize', spy);

  const selected = await pool.query<{ selected_submission_id: string; selection_mode: string }>(
    'SELECT selected_submission_id, selection_mode FROM rounds WHERE id = $1',
    [round.id],
  );
  expect(selected.rows[0].selected_submission_id).toBe(best);
  expect(selected.rows[0].selection_mode).toBe('ai');
  expect(finalizeCalls).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT id FROM ai_runs WHERE round_id = $1 AND run_type = 'round_final'",
        [round.id],
      )
    ).rowCount,
  ).toBe(0);
});

test('§5.4 到点关闭的轮次按 Terra 分数选择，不按缓存票数追认直采', async () => {
  const cookie = await claimGuest();
  await tick(pool);
  const round = await openRound();
  expect((await submit(cookie, '只有投票接口首次到十才直采')).statusCode).toBe(201);
  await expireRound(round.id);
  await tick(pool);
  await driveOnce('submission_score');

  await pool.query(
    'UPDATE submissions SET up_count = 10 WHERE round_id = $1',
    [round.id],
  );
  let finalizeCalls = 0;
  const spy = createStubEngine({
    finalizeRound: (input, base) => {
      finalizeCalls += 1;
      return base;
    },
  });
  await driveOnce('round_finalize', spy);

  const selected = await pool.query<{ selection_mode: string }>(
    'SELECT selection_mode FROM rounds WHERE id = $1',
    [round.id],
  );
  expect(selected.rows[0].selection_mode).toBe('ai');
  expect(finalizeCalls).toBe(0);
});

test('§5.4 民选直采仍跑一次 Terra，哪怕 0 分和不合格也必须拍', async () => {
  const cookie = await claimGuest();
  await tick(pool);
  const round = await openRound();
  expect((await submit(cookie, '已经由十票直接送去拍摄')).statusCode).toBe(201);
  const submission = await pool.query<{ id: string }>(
    'SELECT id FROM submissions WHERE round_id = $1',
    [round.id],
  );
  await pool.query(
    `UPDATE rounds
        SET status = 'selecting', selected_submission_id = $2,
            selection_mode = 'crowd', closes_at = now()
      WHERE id = $1`,
    [round.id, submission.rows[0].id],
  );
  await enqueue(pool, {
    jobType: 'round_finalize',
    idempotencyKey: roundJobKey(
      'round_finalize',
      round.id,
      INLAND_EMPIRE_MOVIE_ID,
    ),
    movieId: INLAND_EMPIRE_MOVIE_ID,
    roundId: round.id,
  });

  let scoreCalls = 0;
  const lateReject = createStubEngine({
    scoreSubmission: (input, base) => {
      scoreCalls += 1;
      return {
        ...base,
        eligible: false,
        scoreTotal: 0,
        scoreBreakdown: {
          continuity: 0,
          filmability15s: 0,
          characterConsistency: 0,
          dramaticValue: 0,
          originality: 0,
        },
        riskFlags: [NOT_STORY_CONTENT_FLAG],
      };
    },
  });
  const result = await driveOnce('submission_score', lateReject);

  expect(result.note).toBeUndefined();
  expect(scoreCalls).toBe(1);
  await driveOnce('round_finalize', lateReject);
  expect(
    (
      await pool.query<{ status: string }>(
        'SELECT status FROM submissions WHERE id = $1',
        [submission.rows[0].id],
      )
    ).rows[0].status,
  ).toBe('accepted');
  expect(
    (
      await pool.query<{
        eligible: boolean;
        score_total: number;
        public_roast: Record<string, string>;
      }>(
        `SELECT eligible, score_total, public_roast
           FROM submission_scores WHERE submission_id = $1`,
        [submission.rows[0].id],
      )
    ).rows[0],
  ).toMatchObject({ eligible: false, score_total: 0 });
  const storedRoast = await pool.query<{ public_roast: Record<string, string> }>(
    'SELECT public_roast FROM submission_scores WHERE submission_id = $1',
    [submission.rows[0].id],
  );
  expect(storedRoast.rows[0].public_roast['zh-CN']).toBeTruthy();
  const selected = await pool.query<{
    status: string;
    selected_submission_id: string;
    selection_mode: string;
  }>('SELECT status, selected_submission_id, selection_mode FROM rounds WHERE id = $1', [
    round.id,
  ]);
  expect(selected.rows[0]).toEqual({
    status: 'selected',
    selected_submission_id: submission.rows[0].id,
    selection_mode: 'crowd',
  });
});

test('§6.4 无有效镜头剧情时终止本轮，不创建自动导演任务', async () => {
  // 「无有效投稿」是投过稿但全被安全门挡下，不是没有人投稿：一条投稿都没有的
  // 轮次根本不会关闭（§5.3 空轮不推进），也就走不到这一步。
  const cookie = await claimGuest();
  await tick(pool);
  const round = await openRound();
  expect((await submit(cookie, '会被安全门挡下的投稿')).statusCode).toBe(201);
  await expireRound(round.id);
  await tick(pool);

  const rejecting = createStubEngine({
    scoreSubmission: (input, base) => ({
      ...base,
      eligible: false,
      scoreTotal: 0,
      scoreBreakdown: {
        continuity: 0,
        filmability15s: 0,
        characterConsistency: 0,
        dramaticValue: 0,
        originality: 0,
      },
      riskFlags: ['stub_rejected'],
    }),
  });
  await driveOnce('submission_score', rejecting);

  let finalizeCalls = 0;
  const spy = createStubEngine({
    finalizeRound: (input, base) => {
      finalizeCalls += 1;
      return base;
    },
  });
  await driveOnce('round_finalize', spy);

  expect(finalizeCalls).toBe(0);
  const row = await pool.query<{
    status: string;
    selection_mode: string | null;
    selected_submission_id: string | null;
  }>(
    'SELECT status, selection_mode, selected_submission_id FROM rounds WHERE id = $1',
    [round.id],
  );
  expect(row.rows[0]).toEqual({
    status: 'select_failed',
    selection_mode: null,
    selected_submission_id: null,
  });
  expect(
    (
      await pool.query(
        "SELECT id FROM workflow_jobs WHERE round_id = $1 AND job_type = 'scene_director'",
        [round.id],
      )
    ).rowCount,
  ).toBe(0);
});

test('§6.4 不 eligible 的投稿不进入候选集（§17.28 安全门）', async () => {
  const cookie = await claimGuest();
  await tick(pool);
  const round = await openRound();
  expect((await submit(cookie, '违规内容')).statusCode).toBe(201);
  await expireRound(round.id);
  await tick(pool);

  const rejecting = createStubEngine({
    scoreSubmission: (input, base) => ({
      ...base,
      eligible: false,
      scoreTotal: 0,
      scoreBreakdown: {
        continuity: 0,
        filmability15s: 0,
        characterConsistency: 0,
        dramaticValue: 0,
        originality: 0,
      },
      riskFlags: ['stub_rejected'],
    }),
  });
  await driveOnce('submission_score', rejecting);
  await pool.query('UPDATE submissions SET up_count = 99 WHERE round_id = $1', [
    round.id,
  ]);
  await driveOnce('round_finalize');

  const row = await pool.query<{ status: string; selection_mode: string | null }>(
    'SELECT status, selection_mode FROM rounds WHERE id = $1',
    [round.id],
  );
  expect(row.rows[0]).toEqual({ status: 'select_failed', selection_mode: null });
  const status = await pool.query<{ status: string }>(
    'SELECT status FROM submissions WHERE round_id = $1',
    [round.id],
  );
  expect(status.rows[0].status).toBe('rejected');
});

test('完全无意义的唯一投稿删除后，轮次回到等待真人镜头的未点火状态', async () => {
  const author = await claimGuest();
  const voter = await claimGuest();
  await tick(pool);
  const round = await openRound();
  const meaninglessText = 'asdf qwer 1234';
  const created = await submit(author, meaninglessText);
  expect(created.statusCode).toBe(201);
  const submissionId = created.json<{ id: string }>().id;
  expect(await roundDeadline(round.id)).not.toBeNull();

  const vote = await app.inject({
    method: 'POST',
    url: `/api/submissions/${submissionId}/vote`,
    headers: { cookie: voter },
    payload: { value: 1 },
  });
  expect(vote.statusCode).toBe(200);

  const meaningless = createStubEngine({
    scoreSubmission: (input, base) => ({
      ...base,
      eligible: false,
      scoreTotal: 0,
      scoreBreakdown: {
        continuity: 0,
        filmability15s: 0,
        characterConsistency: 0,
        dramaticValue: 0,
        originality: 0,
      },
      reason: 'No story proposal.',
      riskFlags: [NOT_STORY_CONTENT_FLAG],
    }),
  });
  await driveOnce('submission_score', meaningless);

  expect(
    (await pool.query('SELECT 1 FROM submissions WHERE id = $1', [submissionId]))
      .rowCount,
  ).toBe(0);
  expect(
    (await pool.query('SELECT 1 FROM submission_votes WHERE submission_id = $1', [
      submissionId,
    ])).rowCount,
  ).toBe(0);
  expect(
    (await pool.query('SELECT 1 FROM submission_scores WHERE submission_id = $1', [
      submissionId,
    ])).rowCount,
  ).toBe(0);
  expect(await roundDeadline(round.id)).not.toBeNull();

  const audit = await pool.query<{
    submission_id: string | null;
    output_json: Record<string, unknown>;
    input_sha256: string;
  }>(
    `SELECT submission_id, output_json, input_sha256
       FROM ai_runs WHERE run_type = 'submission_score'`,
  );
  expect(audit.rows).toHaveLength(1);
  expect(audit.rows[0].submission_id).toBeNull();
  expect(audit.rows[0].output_json).toEqual({
    disposition: 'deleted_not_story_content',
    rubricVersion: STUB_RUBRIC_VERSION,
  });
  expect(JSON.stringify(audit.rows[0])).not.toContain(meaninglessText);

  // The clock sees that the armed round is empty again and disarms it instead
  // of handing it to the retired AI screenwriter path.
  await expireRound(round.id);
  await tick(pool);
  expect(await roundDeadline(round.id)).toBeNull();
  expect(
    (
      await pool.query(
        "SELECT id FROM workflow_jobs WHERE job_type = 'ai_screenwriter'",
      )
    ).rowCount,
  ).toBe(0);

  // Physical deletion releases the per-round uniqueness constraint, so the
  // same author can replace nonsense with an actual pitch and arm a new window.
  expect((await submit(author, 'Marisa locks the cafeteria doors.')).statusCode).toBe(201);
  expect(await roundDeadline(round.id)).not.toBeNull();
});

// --- §5.3 评分补完与 §5 串行化 -----------------------------------------------

test('§5.3 未完成初评的投稿会让 selecting 延长，而不是被静默排除', async () => {
  const cookie = await claimGuest();
  await tick(pool);
  const round = await openRound();
  expect((await submit(cookie, '还没评分的投稿')).statusCode).toBe(201);
  await expireRound(round.id);
  await tick(pool);

  const { job, outcome } = await driveJob('round_finalize');
  expect(outcome).toMatchObject({ kind: 'defer' });
  expect(await roundStatus(round.id)).toBe('selecting');

  // The deferral did not spend an attempt — a busy pipeline must not be able
  // to kill a healthy round (see ledger.defer).
  const after = await pool.query<{ attempt_count: number; status: string }>(
    'SELECT attempt_count, status FROM workflow_jobs WHERE id = $1',
    [job.id],
  );
  expect(after.rows[0].attempt_count).toBe(0);
  expect(after.rows[0].status).toBe('pending');

  // Once the score lands the same job completes and picks the submission.
  await driveOnce('submission_score');
  await driveOnce('round_finalize');
  expect(await roundStatus(round.id)).toBe('selected');
});

test('§5.3 评分任务已 dead 的投稿不会让轮次永远等待', async () => {
  const cookie = await claimGuest();
  await tick(pool);
  const round = await openRound();
  expect((await submit(cookie, '评分任务会 dead 的投稿')).statusCode).toBe(201);
  await expireRound(round.id);
  await tick(pool);

  await pool.query(
    "UPDATE workflow_jobs SET status = 'dead' WHERE job_type = 'submission_score'",
  );
  await driveOnce('round_finalize');
  expect(await roundStatus(round.id)).toBe('select_failed');
  expect(
    (
      await pool.query(
        "SELECT id FROM workflow_jobs WHERE round_id = $1 AND job_type = 'scene_director'",
        [round.id],
      )
    ).rowCount,
  ).toBe(0);
});

test('§5 上一轮未发布时，下一轮的终审被推迟而不是并行开拍', async () => {
  const cookie = await claimGuest();
  await tick(pool);
  const first = await openRound();
  expect((await submit(await claimGuest(), '第一轮的投稿')).statusCode).toBe(201);
  await expireRound(first.id);
  await tick(pool);
  await driveOnce('submission_score');
  await driveOnce('round_finalize');
  await driveOnce('scene_director');
  expect(await roundStatus(first.id)).toBe('generating');

  const second = await openRound();
  expect(second.id).not.toBe(first.id);
  expect((await submit(cookie, '第二轮的投稿')).statusCode).toBe(201);
  await expireRound(second.id);
  await tick(pool);
  await driveOnce('submission_score');

  const { outcome } = await driveJob('round_finalize');
  expect(outcome).toMatchObject({ kind: 'defer' });
  expect(await roundStatus(second.id)).toBe('selecting');

  // Finish round one; round two is then free to proceed.
  await driveOnce('video_generate');
  await driveOnce('subtitle_author');
  await writePendingMedia(first.id);
  await driveOnce('media_validate_publish');
  expect(await roundStatus(first.id)).toBe('published');

  await driveOnce('round_finalize');
  expect(await roundStatus(second.id)).toBe('selected');
});

// --- §5.4 分集 ---------------------------------------------------------------

test('§17.29 导演结束本集时采用达标提案，并原子迁移已打开的下一轮', async () => {
  const proposalAuthor = await claimGuest();
  const shotAuthor = await claimGuest();
  await tick(pool);
  const firstRound = await openRound();
  const proposalResponse = await submit(
    proposalAuthor,
    '下一集转入废弃商场的夜间竞标',
    'next_episode',
  );
  expect(proposalResponse.statusCode).toBe(201);
  const proposalId = proposalResponse.json<{ id: string }>().id;
  expect((await submit(shotAuthor, '本集最后一个镜头')).statusCode).toBe(201);

  await expireRound(firstRound.id);
  await tick(pool);
  await driveOnce('submission_score');
  await driveOnce('submission_score');
  await pool.query('UPDATE submissions SET up_count = 7 WHERE id = $1', [
    proposalId,
  ]);
  await pool.query(
    `INSERT INTO site_settings (key, value) VALUES ($1, $2::jsonb)`,
    ['vote_adopt_threshold_override', '7'],
  );
  await driveOnce('round_finalize');

  const endingEngine = createStubEngine({
    directScene: (input, base) => ({
      ...base,
      episodeShouldEnd: true,
      episodeEndReason: '第一集冲突已经收束',
    }),
  });
  await driveOnce('scene_director', endingEngine);
  await driveOnce('video_generate');
  await driveOnce('subtitle_author');
  await writePendingMedia(firstRound.id);

  // The clock already opened round 2 while round 1 was being filmed. A shot
  // submitted there must follow that round into the newly opened episode.
  const secondRound = await openRound();
  const futureResponse = await submit(
    await claimGuest(),
    '新一集开场：商场卷帘门缓缓升起',
  );
  expect(futureResponse.statusCode).toBe(201);
  const futureSubmissionId = futureResponse.json<{ id: string }>().id;

  await driveOnce('media_validate_publish');

  const episodes = await pool.query<{
    id: string;
    episode_index: number;
    status: string;
    theme: string;
    theme_source_submission_id: string | null;
    end_reason: string | null;
  }>('SELECT * FROM episodes ORDER BY episode_index');
  expect(episodes.rows).toHaveLength(2);
  expect(episodes.rows[0]).toMatchObject({
    episode_index: 1,
    status: 'ended',
    end_reason: '第一集冲突已经收束',
  });
  expect(episodes.rows[1]).toMatchObject({
    episode_index: 2,
    status: 'open',
    theme: '下一集转入废弃商场的夜间竞标',
    theme_source_submission_id: proposalId,
  });
  expect(
    (
      await pool.query<{ votes_frozen_at: Date | null }>(
        'SELECT votes_frozen_at FROM submissions WHERE id = $1',
        [proposalId],
      )
    ).rows[0].votes_frozen_at,
  ).not.toBeNull();
  expect(
    (
      await pool.query<{ episode_id: string }>(
        'SELECT episode_id FROM rounds WHERE id = $1',
        [secondRound.id],
      )
    ).rows[0].episode_id,
  ).toBe(episodes.rows[1].id);
  expect(
    (
      await pool.query<{ episode_id: string }>(
        'SELECT episode_id FROM submissions WHERE id = $1',
        [futureSubmissionId],
      )
    ).rows[0].episode_id,
  ).toBe(episodes.rows[1].id);
  expect(
    (
      await pool.query(
        "SELECT id FROM workflow_jobs WHERE job_type = 'episode_theme'",
      )
    ).rowCount,
  ).toBe(0);
});

test('§17.29 没有达标提案时由 episode_theme 任务准备主题再原子开集', async () => {
  const shotAuthor = await claimGuest();
  await tick(pool);
  const firstRound = await openRound();
  expect((await submit(shotAuthor, '没有民选提案的收尾镜头')).statusCode).toBe(
    201,
  );
  await expireRound(firstRound.id);
  await tick(pool);
  await driveOnce('submission_score');
  await driveOnce('round_finalize');

  let themeCalls = 0;
  const endingEngine = createStubEngine({
    directScene: (input, base) => ({
      ...base,
      episodeShouldEnd: true,
      episodeEndReason: '旧目标已经完成',
    }),
    proposeEpisodeTheme: () => {
      themeCalls += 1;
      return { title: '第二集：夜班商场', theme: '众人争夺废弃商场的夜间经营权' };
    },
  });
  await driveOnce('scene_director', endingEngine);
  await driveOnce('video_generate');
  await driveOnce('subtitle_author');
  await writePendingMedia(firstRound.id);

  const firstPublish = await driveJob('media_validate_publish', endingEngine);
  expect(firstPublish.outcome).toMatchObject({
    kind: 'defer',
    reason: 'episode theme is being prepared',
  });
  expect(await roundStatus(firstRound.id)).toBe('validating');
  expect((await pool.query('SELECT id FROM scenes')).rowCount).toBe(0);
  expect(
    (await pool.query<{ status: string }>('SELECT status FROM episodes')).rows[0]
      .status,
  ).toBe('open');

  await driveOnce('episode_theme', endingEngine);
  expect(themeCalls).toBe(1);
  // A worker killed after committing the ai_run but before completing the job
  // reclaims the same row without buying a second Sol turn.
  await pool.query(
    `UPDATE workflow_jobs SET status = 'pending', available_at = now()
      WHERE idempotency_key = $1`,
    [roundJobKey('episode_theme', firstRound.id, INLAND_EMPIRE_MOVIE_ID)],
  );
  await driveOnce('episode_theme', endingEngine);
  expect(themeCalls).toBe(1);
  await driveOnce('media_validate_publish', endingEngine);

  const episodes = await pool.query<{
    episode_index: number;
    title: string;
    theme: string;
    theme_source_submission_id: string | null;
    status: string;
  }>('SELECT * FROM episodes ORDER BY episode_index');
  expect(episodes.rows[0].status).toBe('ended');
  expect(episodes.rows[1]).toMatchObject({
    episode_index: 2,
    title: '第二集：夜班商场',
    theme: '众人争夺废弃商场的夜间经营权',
    theme_source_submission_id: null,
    status: 'open',
  });
  const audit = await pool.query<{
    provider: string;
    reasoning_effort: string;
    status: string;
  }>(
    "SELECT provider, reasoning_effort, status FROM ai_runs WHERE round_id = $1 AND run_type = 'generation_event'",
    [firstRound.id],
  );
  expect(audit.rows).toEqual([
    { provider: 'stub', reasoning_effort: 'xhigh', status: 'succeeded' },
  ]);
});

// --- §17.18/19/20 不重复正片 --------------------------------------------------

test('§17.18 重复领取同一个发布任务只产出一个片段，scene_index 不变', async () => {
  const cookie = await claimGuest();
  const roundId = await driveToValidating(cookie, '只应该发布一次');

  await driveOnce('media_validate_publish');
  const first = await pool.query<{ id: string; scene_index: number }>(
    'SELECT id, scene_index FROM scenes WHERE round_id = $1',
    [roundId],
  );
  expect(first.rowCount).toBe(1);
  expect(first.rows[0].scene_index).toBe(1);

  // Exactly what a worker that died after COMMIT but before complete() leaves
  // behind: the job is claimable again and runs a second time.
  await pool.query(
    `UPDATE workflow_jobs SET status = 'pending', available_at = now()
      WHERE idempotency_key = $1`,
    [roundJobKey('media_validate_publish', roundId, INLAND_EMPIRE_MOVIE_ID)],
  );
  // The pre-flight re-verification of §5.1 step 3 catches it before any work
  // happens; the transactional guard is exercised by the lock test below.
  const second = await driveOnce('media_validate_publish');
  expect(second.note).toBe('round is published');

  const scenes = await pool.query<{ id: string; scene_index: number }>(
    'SELECT id, scene_index FROM scenes',
  );
  expect(scenes.rowCount).toBe(1);
  expect(scenes.rows[0].id).toBe(first.rows[0].id);
  expect(scenes.rows[0].scene_index).toBe(1);
});

test('§17.18 重放已成功的 video_generate 只会留下一个字幕任务', async () => {
  const author = await claimGuest();
  await tick(pool);
  const round = await openRound();
  expect((await submit(author, '视频任务会被重放')).statusCode).toBe(201);
  await expireRound(round.id);
  await tick(pool);
  await driveOnce('submission_score');
  await driveOnce('round_finalize');
  await driveOnce('scene_director');
  await driveOnce('video_generate');

  // `video_generate` is the one step that leaves its round `generating` on
  // success, so its `status = 'generating'` pre-flight cannot tell a replay from
  // a first run. §5「同一轮选择和生成任务必须具备幂等键」is the only thing left
  // standing between a restart and a second (expensive) 字幕定稿 run.
  expect(await roundStatus(round.id)).toBe('generating');
  // Exactly what a worker killed after COMMIT but before complete() leaves.
  await pool.query(
    `UPDATE workflow_jobs SET status = 'pending', available_at = now()
      WHERE idempotency_key = $1`,
    [roundJobKey('video_generate', round.id, INLAND_EMPIRE_MOVIE_ID)],
  );
  await driveOnce('video_generate');

  const subtitleJobs = await pool.query(
    "SELECT id FROM workflow_jobs WHERE job_type = 'subtitle_author'",
  );
  expect(subtitleJobs.rowCount).toBe(1);

  // …and once that one is taken there is no second one waiting to be claimed:
  // a duplicate would be claimed and executed like any other job.
  await driveOnce('subtitle_author');
  expect(await claimNext(pool, ['subtitle_author'])).toBeNull();
}, 30_000);

test('v4 只持久化紧邻已发布镜头的受控 motion-context ID', async () => {
  const author = await claimGuest();
  await tick(pool);
  const round = await openRound();
  expect((await submit(author, 'Sonic vaults across a crisp 3D game arena.')).statusCode).toBe(201);
  await expireRound(round.id);
  await tick(pool);
  await driveOnce('submission_score');
  await driveOnce('round_finalize');
  await driveOnce('scene_director');

  const completedJob = {
    jobId: 'motion-job',
    promptId: 'motion-prompt',
    roundId: round.id,
    motionContextId: round.id,
    status: 'completed',
    outputs: [],
    error: null,
    styleEnforced: true,
    characterEnforced: true,
  };
  const fakeH3 = {
    submitWorkflow: vi.fn(async () => completedJob),
    getJob: vi.fn(async () => completedJob),
    downloadVideo: vi.fn(async (_job: unknown, destination: string) => {
      await mkdir(join(destination, '..'), { recursive: true });
      await copyFile(sampleMp4, destination);
      return 'a'.repeat(64);
    }),
  } as unknown as NonNullable<HandlerContext['h3']>;

  await driveOnce('video_generate', engine, fakeH3);
  const subtitleJob = await pool.query<{ payload_json: Record<string, unknown> }>(
    "SELECT payload_json FROM workflow_jobs WHERE round_id=$1 AND job_type='subtitle_author'",
    [round.id],
  );
  expect(subtitleJob.rows[0].payload_json.motionContextId).toBeNull();

  await driveOnce('subtitle_author');
  const publishJob = await pool.query<{ payload_json: Record<string, unknown> }>(
    "SELECT payload_json FROM workflow_jobs WHERE round_id=$1 AND job_type='media_validate_publish'",
    [round.id],
  );
  expect(publishJob.rows[0].payload_json.motionContextId).toBeNull();

  await driveOnce('media_validate_publish');
  const published = await pool.query<{
    episode_id: string;
    media: { motion_context?: { id?: string; plugin_version?: string } };
  }>('SELECT episode_id, media FROM scenes WHERE round_id=$1', [round.id]);
  expect(published.rows[0].media.motion_context).toBeNull();
  await expect(
    loadPreviousScene(pool, INLAND_EMPIRE_MOVIE_ID, published.rows[0].episode_id),
  ).resolves.toMatchObject({ motionContextId: null });

  await pool.query(
    `UPDATE scenes
        SET media = jsonb_set(media, '{motion_context}', '{"id":"../bad","plugin_version":"0.5.1"}'::jsonb)
      WHERE round_id=$1`,
    [round.id],
  );
  await expect(
    loadPreviousScene(pool, INLAND_EMPIRE_MOVIE_ID, published.rows[0].episode_id),
  ).resolves.toMatchObject({ motionContextId: null });
}, 30_000);

test('§5 媒体校验不通过时不得发布：时长越界与摘要损坏都拒绝写 scenes', async () => {
  const cookie = await claimGuest();
  const roundId = await driveToValidating(cookie, '媒体校验会失败');
  const key = roundJobKey('media_validate_publish', roundId, INLAND_EMPIRE_MOVIE_ID);

  const attempt = async (patch: Record<string, unknown>): Promise<string> => {
    await pool.query(
      `UPDATE workflow_jobs
          SET status = 'pending', available_at = now(),
              payload_json = payload_json || $2::jsonb
        WHERE idempotency_key = $1`,
      [key, JSON.stringify(patch)],
    );
    try {
      await driveOnce('media_validate_publish');
      return 'published';
    } catch (error) {
      return (error as Error).message;
    }
  };

  // §5 step 5「检查MP4、时长、音轨和字幕文件」and §17.11 的 15 秒上限.
  expect(await attempt({ durationSeconds: 99 })).toMatch(/out of range/);
  expect(await attempt({ durationSeconds: 0 })).toMatch(/out of range/);
  expect(await attempt({ durationSeconds: 12, sha256: 'nope' })).toMatch(
    /sha256 is malformed/,
  );
  expect(
    await attempt({
      sha256: 'a'.repeat(64),
      videoPath: '',
    }),
  ).toMatch(/videoPath is empty/);

  // Nothing reached the movie, and the round never advanced.
  expect(await roundStatus(roundId)).toBe('validating');
  const scenes = await pool.query('SELECT id FROM scenes');
  expect(scenes.rowCount).toBe(0);

  // With honest media it publishes, so the assertions above are about the
  // checks and not about a handler that can never succeed.
  expect(await attempt({ videoPath: `/media/pending/${roundId}.mp4` })).toBe(
    'published',
  );
  const published = await pool.query('SELECT scene_index FROM scenes');
  expect(published.rowCount).toBe(1);
});

// --- §5 step 5 / §17.16 落盘校验 ----------------------------------------------

/**
 * The gate this suite exists to hold. §17.16「H3输出验证通过后才能加入播放列表
 * 和剧情正史」and §5「要求视频与英、中、日、西四份字幕文件全部就绪；任一缺失或
 * 校验失败即进入 validation_failed」.
 *
 * With filming deferred (M5) this is the state a stub round genuinely ends in.
 * Publishing anyway is what produced a playlist full of scenes that 404.
 */
test('§17.16 媒体文件不存在时不写 scenes，轮次落到 validation_failed', async () => {
  const cookie = await claimGuest();
  const roundId = await driveToValidating(cookie, '没有媒体文件的一轮');

  // Exactly the world the stub pipeline leaves behind: every row is in place,
  // nothing was ever filmed.
  await rm(join(mediaDir, 'pending'), { recursive: true, force: true });

  const result = await driveOnce('media_validate_publish');
  expect(result.note).toMatch(/validation_failed/);
  expect(await roundStatus(roundId)).toBe('validation_failed');

  const scenes = await pool.query('SELECT id FROM scenes');
  expect(scenes.rowCount).toBe(0);

  // The job is finished, not retried: a file that is absent now will be absent
  // on the fifth attempt too, and a round stuck in `validating` blocks every
  // later round's finalize (§5).
  const job = await pool.query<{ status: string }>(
    'SELECT status FROM workflow_jobs WHERE idempotency_key = $1',
    [roundJobKey('media_validate_publish', roundId, INLAND_EMPIRE_MOVIE_ID)],
  );
  expect(job.rows[0].status).toBe('succeeded');
});

test('§17.13 四份字幕缺任意一份即不发布', async () => {
  for (const locale of LOCALES) {
    await resetStory(pool);
    await rm(join(mediaDir, 'pending'), { recursive: true, force: true });

    const cookie = await claimGuest();
    const roundId = await driveToValidating(cookie, `缺 ${locale} 字幕的一轮`);
    await rm(join(mediaDir, 'pending'), { recursive: true, force: true });
    await writePendingMedia(roundId, [locale]);

    const result = await driveOnce('media_validate_publish');
    expect(result.note).toMatch(new RegExp(`\\.${locale}\\.vtt`));
    expect(await roundStatus(roundId)).toBe('validation_failed');
    expect((await pool.query('SELECT id FROM scenes')).rowCount).toBe(0);
  }
}, 60_000);

// 没有对白就没有字幕：subtitle_author 不写空 .vtt，publish 不要求也不登记字幕
// URL。播放器因此不会给 <video> 挂上空字幕轨——iOS 把 <track> 交给 AVFoundation
// 一起校验，一条空轨就让整段片子报"不支持"。
test('没有对白的片段不写空字幕文件，发布时不登记字幕 URL', async () => {
  const silent = createStubEngine({
    directScene: (_input, base) => ({ ...base, dialogueEn: [] }),
  });
  // Earlier tests published their own 000001.* here; the assertion below is
  // about what *this* publish leaves behind.
  await rm(join(mediaDir, 'inland-empire-high'), { recursive: true, force: true });
  await tick(pool);
  const round = await openRound();
  const cookie = await claimGuest();
  expect((await submit(cookie, '一段没有台词的追逐')).statusCode).toBe(201);
  await expireRound(round.id);
  await tick(pool);
  await driveOnce('submission_score');
  await driveOnce('round_finalize');
  await driveOnce('scene_director', silent);
  await driveOnce('video_generate');
  await driveOnce('subtitle_author');
  expect(await roundStatus(round.id)).toBe('validating');

  // The real subtitle handler ran and had nothing to render.
  const pending = await readdir(join(mediaDir, 'pending')).catch(() => [] as string[]);
  expect(pending.filter((name) => name.endsWith('.vtt'))).toEqual([]);

  // Only the MP4 is staged, exactly what video_generate leaves behind.
  await writePendingMedia(round.id, [...LOCALES]);
  await driveOnce('media_validate_publish');
  expect(await roundStatus(round.id)).toBe('published');

  const scenes = await pool.query<{
    media: { video: string; subtitles: Record<string, string> };
  }>('SELECT media FROM scenes');
  expect(scenes.rowCount).toBe(1);
  expect(scenes.rows[0].media.video).toBe('/media/inland-empire-high/000001.mp4');
  expect(scenes.rows[0].media.subtitles).toEqual({});
  const published = await readdir(join(mediaDir, 'inland-empire-high'));
  expect(published).toContain('000001.mp4');
  expect(published.filter((name) => name.endsWith('.vtt'))).toEqual([]);
});

test('§5 视频文件存在但不是可播放的视频时不发布', async () => {
  const cookie = await claimGuest();
  const roundId = await driveToValidating(cookie, '视频文件是坏的');

  // All five files exist; the MP4 is not an MP4. An existence check alone would
  // let this into the playlist, where it plays as a broken element.
  await writeFile(join(mediaDir, 'pending', `${roundId}.mp4`), 'not a video', 'utf8');

  const result = await driveOnce('media_validate_publish');
  expect(result.note).toMatch(/not a probeable video file/);
  expect(await roundStatus(roundId)).toBe('validation_failed');
  expect((await pool.query('SELECT id FROM scenes')).rowCount).toBe(0);
});

test('§5 字幕缺一语时不得发布（§17.13 四份字幕缺一即失败）', async () => {
  const cookie = await claimGuest();
  const roundId = await driveToValidating(cookie, '字幕会缺一语');

  // Corrupt the stored subtitle package the way a half-written run would.
  await pool.query(
    `UPDATE ai_runs
        SET output_json = jsonb_set(output_json, '{cues,0,text,ja}', '""'::jsonb)
      WHERE round_id = $1 AND run_type = 'scene_subtitles'`,
    [roundId],
  );

  await expect(driveOnce('media_validate_publish')).rejects.toThrow(
    /cues\[0\]\.text\.ja/,
  );
  expect(await roundStatus(roundId)).toBe('validating');
  const scenes = await pool.query('SELECT id FROM scenes');
  expect(scenes.rowCount).toBe(0);
});

test('§17.20 两个发布事务被 scene_index 锁串行化，落败者不写第二个片段', async () => {
  const cookie = await claimGuest();
  const roundId = await driveToValidating(cookie, '两个 worker 抢同一轮');

  const holder = await pool.connect();
  let settled = false;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock($1)', [SCENE_INDEX_LOCK_KEY]);

    // The handler must block on the lock, not race past it.
    const running = driveOnce('media_validate_publish').then((result) => {
      settled = true;
      return result;
    });
    await sleep(300);
    expect(settled).toBe(false);

    // The lock holder publishes the round exactly as the handler would.
    await holder.query(
      "UPDATE rounds SET status = 'published' WHERE id = $1 AND status = 'validating'",
      [roundId],
    );
    await holder.query(
      `INSERT INTO scenes (movie_id, scene_index, episode_id, round_id, summary_zh,
                           duration_seconds, media, director_ai_run_id,
                           subtitle_ai_run_id, episode_should_end, published_at)
       SELECT r.movie_id, coalesce(max(s.scene_index), 0) + 1, r.episode_id, r.id, 'raced',
              12, '{}'::jsonb,
              (SELECT id FROM ai_runs WHERE round_id = r.id AND run_type = 'scene_director'),
              (SELECT id FROM ai_runs WHERE round_id = r.id AND run_type = 'scene_subtitles'),
              false, now()
         FROM rounds r LEFT JOIN scenes s ON s.movie_id = r.movie_id
        WHERE r.id = $1
        GROUP BY r.movie_id, r.episode_id, r.id`,
      [roundId],
    );
    await holder.query('COMMIT');

    const result = await running;
    expect(result.note).toBe('round was already published');
  } finally {
    holder.release();
  }

  const scenes = await pool.query('SELECT scene_index FROM scenes');
  expect(scenes.rowCount).toBe(1);
});

// --- §5.2 通道并发 -----------------------------------------------------------

test('§5.2 scoring 通道并发上限为 2：第三个任务留在 pending', async () => {
  let release: (() => void) | null = null;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const worker = track(
    startWorker({
      pool,
      config: workerConfig(),
      engine,
      log: silentLogger,
      handlers: {
        submission_score: async () => {
          await held;
          return { kind: 'done' };
        },
      },
      shutdownTimeoutMs: 0,
    }),
  );

  const ids: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const result = await enqueue(pool, {
      jobType: 'submission_score',
      movieId: INLAND_EMPIRE_MOVIE_ID,
      idempotencyKey: `concurrency_scoring_${i}`,
    });
    ids.push(result.job.id);
  }

  const runningCount = async (): Promise<number> => {
    const result = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM workflow_jobs WHERE id = ANY($1::uuid[]) AND status = 'running'",
      [ids],
    );
    return Number(result.rows[0].n);
  };

  await waitFor(async () => (await runningCount()) === 2, 'two jobs running');
  // Several poll intervals later the count must still be 2 — the channel is
  // capped, not merely slow to start the third.
  await sleep(400);
  expect(await runningCount()).toBe(2);

  release!();
  await waitFor(async () => {
    const result = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM workflow_jobs WHERE id = ANY($1::uuid[]) AND status = 'succeeded'",
      [ids],
    );
    return Number(result.rows[0].n) === 4;
  }, 'all four scoring jobs to finish');

  await worker.stop();
}, 30_000);

test('§5.2 director 通道并发必须保持 1', async () => {
  let release: (() => void) | null = null;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  track(
    startWorker({
      pool,
      config: workerConfig(),
      engine,
      log: silentLogger,
      handlers: {
        scene_director: async () => {
          await held;
          return { kind: 'done' };
        },
      },
      shutdownTimeoutMs: 0,
    }),
  );

  const ids: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const result = await enqueue(pool, {
      jobType: 'scene_director',
      movieId: INLAND_EMPIRE_MOVIE_ID,
      idempotencyKey: `concurrency_director_${i}`,
    });
    ids.push(result.job.id);
  }

  const runningCount = async (): Promise<number> => {
    const result = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM workflow_jobs WHERE id = ANY($1::uuid[]) AND status = 'running'",
      [ids],
    );
    return Number(result.rows[0].n);
  };

  await waitFor(async () => (await runningCount()) === 1, 'one director job running');
  await sleep(400);
  expect(await runningCount()).toBe(1);

  release!();
  // Drained one at a time, and drained completely — the cap is a queue, not a
  // ceiling that drops work.
  await waitFor(async () => {
    const result = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM workflow_jobs WHERE id = ANY($1::uuid[]) AND status = 'succeeded'",
      [ids],
    );
    return Number(result.rows[0].n) === 3;
  }, 'all three director jobs to finish');
}, 30_000);

test('§5.3 活着的长任务续租，不会被恢复扫描误判为死亡 worker', async () => {
  const held = barrier();
  let calls = 0;
  const worker = track(
    startWorker({
      pool,
      config: {
        ...workerConfig(),
        JOB_LEASE_MS: 300,
        JOB_POLL_INTERVAL_MS: 20,
      },
      engine,
      log: silentLogger,
      handlers: {
        scene_director: async () => {
          calls += 1;
          await held.wait;
          return { kind: 'done' };
        },
      },
      recoverIntervalMs: 50,
    }),
  );
  const queued = await enqueue(pool, {
    jobType: 'scene_director',
    movieId: INLAND_EMPIRE_MOVIE_ID,
    idempotencyKey: 'long_director_renews_lease',
  });

  await waitFor(async () => calls === 1, 'long director to start');
  await sleep(750);
  const active = await pool.query<{
    status: string;
    attempt_count: number;
    lease_live: boolean;
  }>(
    `SELECT status, attempt_count, lease_expires_at > now() AS lease_live
       FROM workflow_jobs WHERE id = $1`,
    [queued.job.id],
  );
  expect(active.rows[0]).toEqual({
    status: 'running',
    attempt_count: 1,
    lease_live: true,
  });
  expect(calls).toBe(1);

  held.open();
  await waitFor(async () => {
    const result = await pool.query<{ status: string }>(
      'SELECT status FROM workflow_jobs WHERE id = $1',
      [queued.job.id],
    );
    return result.rows[0]?.status === 'succeeded';
  }, 'long director to complete');
  await worker.stop();
}, 30_000);

/** A promise that only this test can settle — the barrier a claim parks on. */
function barrier(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Enough of a `Job` for the runner, which only ever reads `id`. */
function fakeJob(id: string): Job {
  const now = new Date();
  return {
    id,
    movieId: null,
    roundId: null,
    jobType: 'submission_score',
    idempotencyKey: id,
    status: 'running',
    upstreamJobId: null,
    payload: null,
    attemptCount: 1,
    availableAt: now,
    leaseExpiresAt: now,
    lastError: null,
    createdAt: now,
    startedAt: now,
    finishedAt: null,
    updatedAt: now,
  };
}

test('§5.2 同一刻到达的多个唤醒不会突破通道并发上限', async () => {
  // `active < concurrency` and the `start()` that spends the slot are separated
  // by an `await claim()`. Two wakes that both reach the check before either has
  // claimed would each see a free slot and each start a job, so the runner has
  // to collapse re-entrant wakes into a single drain (§5.1「监听器不做去重」).
  //
  // The simultaneity is forced rather than hoped for: every claim parks on a
  // barrier this test opens by hand, so all four wakes are provably suspended
  // inside the window at the same moment. A version of this that raced real
  // promises would serialise under a loaded suite and prove nothing.
  const concurrency = CHANNEL_CONCURRENCY.scoring;
  const claims = barrier();
  const handlers = barrier();
  let stopped = false;
  let claimed = 0;
  let active = 0;
  let peak = 0;

  const runner = new ChannelRunner(
    'scoring',
    ['submission_score'],
    concurrency,
    async () => {
      active += 1;
      peak = Math.max(peak, active);
      await handlers.wait;
      active -= 1;
    },
    async () => {
      await claims.wait;
      claimed += 1;
      return fakeJob(`wake_race_${claimed}`);
    },
    () => stopped,
    silentLogger,
  );

  const wakes = [runner.wake(), runner.wake(), runner.wake(), runner.wake()];
  claims.open();
  await Promise.all(wakes);

  // The queue is bottomless here, so anything above the cap is the runner's
  // doing and not a shortage of work.
  expect(peak).toBe(concurrency);
  expect(claimed).toBe(concurrency);

  stopped = true;
  handlers.open();
  await runner.drain();
});

// --- §5 失败状态 -------------------------------------------------------------

test('§5 导演任务耗尽重试后轮次进入 generation_failed，不写正片', async () => {
  const cookie = await claimGuest();
  await tick(pool);
  const round = await openRound();
  expect((await submit(cookie, '会拍砸的投稿')).statusCode).toBe(201);
  await expireRound(round.id);
  await tick(pool);

  const broken = createStubEngine({
    directScene: () => {
      throw new Error('stub director always fails');
    },
  });
  track(
    startWorker({
      pool,
      config: workerConfig(),
      engine: broken,
      log: silentLogger,
      // The clock must not open new rounds under this test's feet.
      deferDelayMs: 50,
    }),
  );

  await waitFor(
    async () => (await roundStatus(round.id)) === 'generation_failed',
    'round to fail',
  );
  const scenes = await pool.query('SELECT id FROM scenes');
  expect(scenes.rowCount).toBe(0);
  const job = await pool.query<{ status: string; attempt_count: number }>(
    'SELECT status, attempt_count FROM workflow_jobs WHERE idempotency_key = $1',
    [roundJobKey('scene_director', round.id, INLAND_EMPIRE_MOVIE_ID)],
  );
  expect(job.rows[0].status).toBe('dead');
  expect(job.rows[0].attempt_count).toBe(testConfig.JOB_MAX_ATTEMPTS);
}, 30_000);

test('§5.3 恢复扫描判 dead 的任务同样让轮次失败，且不挡住下一轮', async () => {
  const author = await claimGuest();
  await tick(pool);
  const first = await openRound();
  expect((await submit(author, '会在恢复扫描里被判死的一轮')).statusCode).toBe(201);
  await expireRound(first.id);
  await tick(pool);

  await driveOnce('submission_score');
  await driveOnce('round_finalize');
  await driveOnce('scene_director');
  expect(await roundStatus(first.id)).toBe('generating');

  // Exactly what a worker killed on its last attempt leaves behind: the row is
  // still `running`, the attempts are spent and the lease has expired. No
  // handler ever runs again for it, so runJob's catch branch cannot be what
  // fails the round — only §5.3 的恢复扫描 can.
  const videoJob = await pool.query<{ id: string }>(
    'SELECT id FROM workflow_jobs WHERE idempotency_key = $1',
    [roundJobKey('video_generate', first.id, INLAND_EMPIRE_MOVIE_ID)],
  );
  await pool.query(
    `UPDATE workflow_jobs
        SET status = 'running', attempt_count = $2,
            lease_expires_at = now() - interval '1 minute'
      WHERE id = $1`,
    [videoJob.rows[0].id, testConfig.JOB_MAX_ATTEMPTS],
  );

  // §5「系统保留下一轮投稿」— the next round is already open and collecting.
  const second = await openRound();
  expect(second.id).not.toBe(first.id);
  expect((await submit(await claimGuest(), '下一轮的点子')).statusCode).toBe(201);
  await expireRound(second.id);

  track(
    startWorker({
      pool,
      config: workerConfig(),
      engine,
      handlers: manualFilmingHandlers,
      log: silentLogger,
      // Both rounds above were expired by hand; the clock must not close a third
      // one under this test's feet.
      deferDelayMs: 50,
      recoverIntervalMs: 200,
    }),
  );

  await waitFor(
    async () => (await roundStatus(first.id)) === 'generation_failed',
    'the abandoned round to reach a failure state',
  );
  const dead = await pool.query<{ status: string }>(
    'SELECT status FROM workflow_jobs WHERE id = $1',
    [videoJob.rows[0].id],
  );
  expect(dead.rows[0].status).toBe('dead');

  // §5「生成失败时不得提前推进剧情」and「上一段正式发布后，下一段才能进入最终选
  // 择和拍摄流程」: the dead round writes no scene, and a failure state is
  // terminal, so the movie keeps moving instead of stalling behind it forever.
  await waitFor(
    async () => (await roundStatus(second.id)) === 'published',
    'the next round to publish',
  );
  const scenes = await pool.query<{ scene_index: number; round_id: string }>(
    'SELECT scene_index, round_id FROM scenes',
  );
  expect(scenes.rows).toEqual([{ scene_index: 1, round_id: second.id }]);
}, 60_000);

test('§5.2 无限推迟的任务必须走到明确失败状态，不得永远等下去', async () => {
  const author = await claimGuest();
  await tick(pool);
  const first = await openRound();
  expect((await submit(await claimGuest(), '卡住前面那一轮的投稿')).statusCode).toBe(201);
  await expireRound(first.id);
  await tick(pool);
  await driveOnce('submission_score');
  await driveOnce('round_finalize');
  await driveOnce('scene_director');
  expect(await roundStatus(first.id)).toBe('generating');

  // A round wedged in a non-terminal state with nothing left that could move it:
  // its video job is already `succeeded`, so no retry, no recovery scan and no
  // failure state will ever arrive for it on its own.
  await pool.query(
    `UPDATE workflow_jobs SET status = 'succeeded', lease_expires_at = NULL
      WHERE idempotency_key = $1`,
    [roundJobKey('video_generate', first.id, INLAND_EMPIRE_MOVIE_ID)],
  );

  const second = await openRound();
  expect((await submit(author, '被卡在后面的一轮')).statusCode).toBe(201);
  await expireRound(second.id);
  await tick(pool);
  await driveOnce('submission_score');

  track(
    startWorker({
      pool,
      config: workerConfig(),
      engine,
      log: silentLogger,
      deferDelayMs: 20,
      // Production leaves this at DEFAULT_MAX_DEFER_MS; shortened here so the
      // bound is reached in a test rather than in half an hour.
      maxDeferMs: 300,
    }),
  );

  // §5.2「达到上限后必须进入明确失败状态，不得无限循环」. defer() refunds the
  // claim's attempt on purpose, so `attempt_count` can never end this job —
  // without a separate bound it would defer for ever.
  await waitFor(
    async () => (await roundStatus(second.id)) === 'select_failed',
    'the blocked round to fail loudly',
  );

  const job = await pool.query<{ status: string; last_error: string }>(
    'SELECT status, last_error FROM workflow_jobs WHERE idempotency_key = $1',
    [roundJobKey('round_finalize', second.id, INLAND_EMPIRE_MOVIE_ID)],
  );
  expect(job.rows[0].status).toBe('dead');
  expect(job.rows[0].last_error).toMatch(/an earlier round is still generating/);

  // Only the job that could not proceed was written off: nothing was invented
  // for the round that was actually stuck, and no scene was published.
  expect(await roundStatus(first.id)).toBe('generating');
  const scenes = await pool.query('SELECT id FROM scenes');
  expect(scenes.rowCount).toBe(0);
}, 30_000);

// --- §11 正式编号 -------------------------------------------------------------

test('§11 失败轮次不占用正式编号：scene_index 连续，不跟着 round_index 跳号', async () => {
  const author = await claimGuest();

  const publishRound = async (content: string): Promise<string> => {
    const round = await openRound();
    expect((await submit(author, content)).statusCode).toBe(201);
    await expireRound(round.id);
    await tick(pool);
    await driveOnce('submission_score');
    await driveOnce('round_finalize');
    await driveOnce('scene_director');
    await driveOnce('video_generate');
    await driveOnce('subtitle_author');
    await writePendingMedia(round.id);
    await driveOnce('media_validate_publish');
    expect(await roundStatus(round.id)).toBe('published');
    return round.id;
  };

  await tick(pool);
  const first = await publishRound('第一轮：正常发布');

  // Round two burns a `round_index` and produces nothing. That a round really
  // reaches this state is proven by the recovery test above; here it is the
  // fixture that makes `round_index` and `scene_index` diverge — the only
  // situation in which the difference between them is observable.
  const failed = await openRound();
  await pool.query(
    "UPDATE rounds SET status = 'generation_failed', updated_at = now() WHERE id = $1",
    [failed.id],
  );
  await tick(pool);

  const third = await publishRound('第三轮：跳过失败轮之后');

  const scenes = await pool.query<{
    scene_index: number;
    round_id: string;
    round_index: string;
    media: { video: string };
  }>(
    `SELECT s.scene_index, s.round_id, s.media, r.round_index
       FROM scenes s JOIN rounds r ON r.id = s.round_id
      ORDER BY s.scene_index`,
  );

  // §11「每个正式发布片段拥有不可变的连续整数 scene_index」/ §17.17 播放器严格按
  // scene_index 连续播放：编号来自已发布片段的最大值，不是轮次序号。
  expect(scenes.rows.map((row) => row.scene_index)).toEqual([1, 2]);
  expect(scenes.rows.map((row) => row.round_id)).toEqual([first, third]);
  // §11「失败和重试任务使用内部任务 ID，不占用正式电影编号」— round 2 consumed
  // round_index 2, and numbering the next scene after it would skip 000002.mp4
  // for ever, which is exactly what the player is forbidden to encounter.
  expect(Number(scenes.rows[1].round_index)).toBe(3);
  expect(scenes.rows[1].scene_index).toBe(2);
  expect(scenes.rows[1].media.video).toBe('/media/inland-empire-high/000002.mp4');
}, 30_000);

// --- §17.6/7/8/9/27 三轮连跑 --------------------------------------------------

test('三轮连跑：每 3 秒只关一轮，每轮评分、选出获胜者并发布唯一片段', async () => {
  const author = await claimGuest();
  const voter = await claimGuest();

  track(
    startWorker({
      pool,
      config: workerConfig(),
      engine,
      handlers: manualFilmingHandlers,
      log: silentLogger,
      deferDelayMs: 50,
    }),
  );

  const roundIds: string[] = [];
  const submissionIds: string[] = [];

  for (let index = 1; index <= 3; index += 1) {
    const round = await waitFor(async () => {
      const result = await pool.query<{ id: string }>(
        "SELECT id FROM rounds WHERE status = 'open' AND round_index = $1",
        [index],
      );
      return result.rows[0] ?? null;
    }, `round ${index} to open`);
    roundIds.push(round.id);

    const created = await submit(author, `第 ${index} 轮的点子`);
    expect(created.statusCode).toBe(201);
    submissionIds.push(created.json<{ id: string }>().id);

    // §17.7 投稿能够实时显示在当前轮次列表中 — visible before it is scored.
    const listed = await app.inject({
      method: 'GET',
      url: '/api/round/current/submissions',
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json<{ submissions: { id: string; score: unknown }[] }>();
    expect(body.submissions.map((each) => each.id)).toContain(
      submissionIds[index - 1],
    );

    // §17.6 同一用户同一轮次只能成功投稿一次。
    const duplicate = await submit(author, '同一轮的第二条');
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<{ error: string }>().error).toBe('duplicate_submission');

    if (index === 1) {
      // §17.27 冻结前可以投票，冻结后被拒绝。
      const vote = await app.inject({
        method: 'POST',
        url: `/api/submissions/${submissionIds[0]}/vote`,
        headers: { cookie: voter },
        payload: { value: 1 },
      });
      expect(vote.statusCode).toBe(200);
      expect(vote.json<{ upCount: number }>().upCount).toBe(1);
    }

    if (index < 3) {
      await waitFor(async () => {
        const result = await pool.query(
          "SELECT id FROM rounds WHERE round_index = $1 AND status = 'open'",
          [index + 1],
        );
        return result.rowCount === 1;
      }, `round ${index + 1} to open`);
    }
  }

  await waitFor(async () => {
    const result = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM scenes',
    );
    return Number(result.rows[0].n) === 3;
  }, 'three scenes to publish');

  // §17.27 冻结后的投票被拒绝。
  const frozenVote = await app.inject({
    method: 'POST',
    url: `/api/submissions/${submissionIds[0]}/vote`,
    headers: { cookie: voter },
    payload: { value: -1 },
  });
  expect(frozenVote.statusCode).toBe(409);
  expect(frozenVote.json<{ error: string }>().error).toBe('votes_frozen');

  // §17.8 每个周期只关闭和处理一个轮次：三轮首尾相接，没有重叠。
  const rounds = await pool.query<{
    id: string;
    round_index: string;
    status: string;
    opens_at: Date;
    closes_at: Date;
    first_submission_at: Date;
    selected_submission_id: string;
    selection_mode: string;
  }>(
    `SELECT r.*,
            (SELECT min(s.created_at)
               FROM submissions s
              WHERE s.round_id = r.id) AS first_submission_at
       FROM rounds r
      ORDER BY r.round_index`,
  );
  const closedRounds = rounds.rows.filter((row) => row.status === 'published');
  expect(closedRounds).toHaveLength(3);
  for (let index = 0; index < 3; index += 1) {
    const row = rounds.rows[index];
    expect(row.id).toBe(roundIds[index]);
    expect(row.selected_submission_id).toBe(submissionIds[index]);
    expect(row.selection_mode).toBe('ai');
    // Every round is armed by its first user pitch. Later submissions do not
    // extend that server-owned voting window.
    const remainingAtFirstPitch =
      row.closes_at.getTime() - row.first_submission_at.getTime();
    expect(remainingAtFirstPitch).toBeGreaterThan(2_500);
    expect(remainingAtFirstPitch).toBeLessThanOrEqual(3_000);
    if (index > 0) {
      // The next round opens when the previous one closes: no gap, no overlap.
      expect(row.opens_at.getTime()).toBeGreaterThanOrEqual(
        rounds.rows[index - 1].closes_at.getTime(),
      );
    }
  }

  // §17.9 (stub): every accepted submission carries a 0–100 总分 and four-language
  // 毒舌评论, and the public list exposes those two and nothing else.
  const scores = await pool.query<{
    submission_id: string;
    score_total: number;
    public_roast: Record<string, string>;
    eligible: boolean;
  }>('SELECT * FROM submission_scores WHERE submission_id = ANY($1::uuid[])', [
    submissionIds,
  ]);
  expect(scores.rowCount).toBe(3);
  for (const score of scores.rows) {
    expect(score.eligible).toBe(true);
    expect(score.score_total).toBeGreaterThanOrEqual(0);
    expect(score.score_total).toBeLessThanOrEqual(100);
    expect(Object.keys(score.public_roast).sort()).toEqual([
      'en',
      'es',
      'ja',
      'zh-CN',
    ]);
  }

  // 一轮一个片段，编号连续且不重复 (§16.1 scene_index 永不回收、永不重排).
  const scenes = await pool.query<{
    scene_index: number;
    round_id: string;
    credit_user_id: string;
    source_submission_id: string;
    media: { video: string; subtitles: Record<string, string> };
  }>('SELECT * FROM scenes ORDER BY scene_index');
  expect(scenes.rows.map((row) => row.scene_index)).toEqual([1, 2, 3]);
  expect(scenes.rows.map((row) => row.round_id)).toEqual(roundIds);
  expect(scenes.rows.map((row) => row.source_submission_id)).toEqual(submissionIds);
  expect(scenes.rows[0].media.video).toBe('/media/inland-empire-high/000001.mp4');
  expect(Object.keys(scenes.rows[0].media.subtitles).sort()).toEqual([
    'en',
    'es',
    'ja',
    'zh-CN',
  ]);
}, 60_000);

// --- §17.18/19 Worker 中途死亡 ------------------------------------------------

test('§17.19 worker 在轮次中途死亡后恢复：轮次续走，片段不重复、编号不回收', async () => {
  const author = await claimGuest();

  let enteredDirector = false;
  const hangingEngine = createStubEngine({
    directScene: async () => {
      enteredDirector = true;
      // Never resolves: the worker is killed while holding this job.
      await new Promise<never>(() => undefined);
      throw new Error('unreachable');
    },
  });

  // A long lease and no recovery scan of its own: the abandoned job must still
  // be `running` with a live lease when this worker is killed, so the *next*
  // worker's recovery scan is provably the thing that revives it.
  const dying = track(
    startWorker({
      pool,
      config: { ...workerConfig(), JOB_LEASE_MS: 120_000 },
      engine: hangingEngine,
      handlers: manualStoryHandlers,
      log: silentLogger,
      deferDelayMs: 50,
      recoverIntervalMs: 120_000,
      // kill -9 has no graceful drain.
      shutdownTimeoutMs: 0,
    }),
  );

  await waitFor(async () => {
    const result = await pool.query(
      "SELECT id FROM rounds WHERE status = 'open' AND round_index = 1",
    );
    return result.rowCount === 1;
  }, 'round 1 to open');
  expect((await submit(author, '中途死掉那一轮的点子')).statusCode).toBe(201);

  const directorJob = await waitFor(async () => {
    // `enteredDirector` is checked here, not asserted after the wait: claimNext
    // marks the row `running` *before* the handler body runs, so waiting on the
    // row alone can return in the window between the two — and then the
    // assertion reads a flag the handler has not set yet. What this test needs
    // is a worker that is genuinely inside the director call, which is both
    // conditions together.
    if (!enteredDirector) return null;
    const result = await pool.query<{ id: string; attempt_count: number }>(
      `SELECT id, attempt_count FROM workflow_jobs
        WHERE job_type = 'scene_director' AND status = 'running'`,
    );
    // claimNext marks the row running immediately before invoking the handler;
    // wait for both facts so the assertion cannot land in that tiny gap.
    return enteredDirector ? (result.rows[0] ?? null) : null;
  }, 'the director job to be claimed');
  expect(enteredDirector).toBe(true);
  expect(directorJob.attempt_count).toBe(1);

  await dying.stop();
  // A killed process cannot release its lease; the row is left `running` with a
  // lease that will expire. §5.3 的恢复扫描 is what has to notice.
  await pool.query(
    "UPDATE workflow_jobs SET lease_expires_at = now() - interval '1 minute' WHERE id = $1",
    [directorJob.id],
  );

  track(
    startWorker({
      pool,
      config: workerConfig(),
      engine,
      handlers: manualFilmingHandlers,
      log: silentLogger,
      deferDelayMs: 50,
      // §5.3「Worker 启动时立即执行一次恢复扫描」— the periodic scan is pushed
      // far out of reach, so the abandoned job can only come back if the
      // *startup* scan does its job.
      recoverIntervalMs: 600_000,
    }),
  );

  // 第二轮同样要有人投稿才会走完：空轮不推进（§5.3），所以这里点火第二轮，
  // 断言的仍然是崩溃之后编号不回收、片段不重复。
  await waitFor(async () => {
    const result = await pool.query(
      "SELECT id FROM rounds WHERE status = 'open' AND round_index = 2",
    );
    return result.rowCount === 1;
  }, 'round 2 to open');
  expect((await submit(author, '崩溃之后那一轮的点子')).statusCode).toBe(201);

  // The abandoned round finishes, and the pipeline keeps going into round 2.
  await waitFor(async () => {
    const result = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM scenes',
    );
    return Number(result.rows[0].n) === 2;
  }, 'two scenes to publish');

  const scenes = await pool.query<{ scene_index: number; round_id: string }>(
    'SELECT scene_index, round_id FROM scenes ORDER BY scene_index',
  );
  // §17.18/19: no duplicate scene, no reused or skipped index.
  expect(scenes.rows.map((row) => row.scene_index)).toEqual([1, 2]);
  expect(new Set(scenes.rows.map((row) => row.round_id)).size).toBe(2);

  const duplicates = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM (
       SELECT round_id FROM scenes GROUP BY round_id HAVING count(*) > 1
     ) AS d`,
  );
  expect(Number(duplicates.rows[0].n)).toBe(0);

  // §5「同一轮选择和生成任务必须具备幂等键」— one director job for that round,
  // reused across the crash rather than duplicated by the recovery scan.
  const directorJobs = await pool.query<{ attempt_count: number; status: string }>(
    "SELECT attempt_count, status FROM workflow_jobs WHERE job_type = 'scene_director'",
  );
  const firstRoundJob = await pool.query<{ attempt_count: number; status: string }>(
    'SELECT attempt_count, status FROM workflow_jobs WHERE id = $1',
    [directorJob.id],
  );
  expect(firstRoundJob.rows[0].status).toBe('succeeded');
  // The killed attempt was counted at claim time (§5.1), so the retry is #2.
  expect(firstRoundJob.rows[0].attempt_count).toBe(2);
  // One per round, never two for the same one.
  expect(directorJobs.rowCount).toBe(scenes.rowCount);
}, 60_000);
