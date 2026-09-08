import { databaseNow } from './database';
// T3.2 投稿与投票路由 —《技术》§4 校验与反滥用、§5.4 计票、§16.3 接口清单，
// 验收 §17 的 5/6/7/27/31。
//
// Lengths are checked with CJK text and with a ZWJ-family emoji, because §4
// counts what the reader sees: the family below is 5 code points and 8 UTF-16
// units but exactly one grapheme cluster. Invisible characters are written as
// `\u{...}` escapes (see source-hygiene.test.ts).
import pg from 'pg';

import { runMigrations } from '../src/db/migrate';
import { scoreJobKey } from '../src/jobs/keys';
import { INLAND_EMPIRE_MOVIE_ID } from '../src/movies/catalog';
import { tick } from '../src/rounds/clock';
import { buildApp } from '../src/web/app';
import { createScene } from './scene-fixture';
import {
  NEXT_EPISODE_MAX_GRAPHEMES,
  NEXT_SHOT_MAX_GRAPHEMES,
} from '../src/web/routes/submissions';
import {
  ensureDatabase,
  resetStory,
  sleep,
  testConfig,
  TEST_URL,
} from './helpers';

/** One grapheme cluster; 5 code points; 8 UTF-16 code units. */
const FAMILY = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}';

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
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

beforeEach(async () => {
  await resetStory(pool);
});

async function claimGuest(
  instance: ReturnType<typeof buildApp> = app,
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 12);
  const response = await instance.inject({
    method: 'POST',
    url: '/api/identity/guest',
    payload: { username: `st_${suffix}` },
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.find((each) => each.name === 'cm_guest');
  if (cookie === undefined) throw new Error('no guest cookie');
  return `cm_guest=${cookie.value}`;
}

function submit(
  cookie: string | undefined,
  body: unknown,
  instance: ReturnType<typeof buildApp> = app,
  remoteAddress?: string,
) {
  return instance.inject({
    method: 'POST',
    url: '/api/round/current/submissions',
    headers: cookie === undefined ? {} : { cookie },
    payload: body,
    remoteAddress,
  });
}

function vote(
  cookie: string | undefined,
  submissionId: string,
  value: unknown,
  instance: ReturnType<typeof buildApp> = app,
  remoteAddress?: string,
) {
  return instance.inject({
    method: 'POST',
    url: `/api/submissions/${submissionId}/vote`,
    headers: cookie === undefined ? {} : { cookie },
    payload: { value },
    remoteAddress,
  });
}

async function openRound(): Promise<void> {
  await tick(pool);
}

async function currentRoundId(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM rounds WHERE status = 'open' LIMIT 1",
  );
  return result.rows[0].id;
}

/** A submission by a fresh guest in the current round. */
async function postShot(content = '一个还不错的点子'): Promise<{
  id: string;
  cookie: string;
}> {
  const cookie = await claimGuest();
  const response = await submit(cookie, { kind: 'next_shot', content });
  expect(response.statusCode).toBe(201);
  return { id: response.json<{ id: string }>().id, cookie };
}

// --- 身份与封禁 (§16.3, §17.31) ----------------------------------------------

test('未认领身份的写请求被拒绝（401）', async () => {
  await openRound();
  const response = await submit(undefined, {
    kind: 'next_shot',
    content: '匿名的点子',
  });
  expect(response.statusCode).toBe(401);
  expect(response.json<{ error: string }>().error).toBe('identity_required');

  const shot = await postShot();
  expect((await vote(undefined, shot.id, 1)).statusCode).toBe(401);
});

test('被封禁的身份投稿和投票都被拒绝（403）', async () => {
  await openRound();
  const shot = await postShot();
  const banned = await claimGuest();

  await pool.query(
    `UPDATE users SET banned_at = now(), ban_reason = 'test'
      WHERE id = (SELECT user_id FROM submissions WHERE id = $1)`,
    [shot.id],
  );
  expect((await submit(shot.cookie, { kind: 'next_shot', content: 'x' })).statusCode).toBe(403);

  await pool.query(
    "UPDATE users SET banned_at = now() WHERE username_display = (SELECT username_display FROM users ORDER BY created_at DESC LIMIT 1)",
  );
  expect((await vote(banned, shot.id, 1)).statusCode).toBe(403);
});

// --- §4 投稿校验 -------------------------------------------------------------

test('§4 kind 必须是 next_shot 或 next_episode', async () => {
  await openRound();
  const cookie = await claimGuest();
  for (const kind of ['danmaku', '', 42, undefined]) {
    const response = await submit(cookie, { kind, content: '内容' });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('kind_invalid');
  }
});

test('§4 拒绝空内容与纯链接', async () => {
  await openRound();
  const cookie = await claimGuest();
  for (const content of ['', '   ', '\n\t ', undefined]) {
    const response = await submit(cookie, { kind: 'next_shot', content });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('content_required');
  }
  for (const content of ['https://example.com/x', 'www.example.com']) {
    const response = await submit(cookie, { kind: 'next_shot', content });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('content_link_only');
  }
  // A pitch that merely mentions a link is still a pitch.
  expect(
    (await submit(cookie, {
      kind: 'next_shot',
      content: '他把 https://example.com 写在了黑板上',
    })).statusCode,
  ).toBe(201);
});

test('§17.5「下一个镜头」上限 140 个用户可见字符，按 grapheme 计数', async () => {
  await openRound();
  expect(NEXT_SHOT_MAX_GRAPHEMES).toBe(140);

  const okCjk = await submit(await claimGuest(), {
    kind: 'next_shot',
    content: '啊'.repeat(140),
  });
  expect(okCjk.statusCode).toBe(201);

  const tooLongCjk = await submit(await claimGuest(), {
    kind: 'next_shot',
    content: '啊'.repeat(141),
  });
  expect(tooLongCjk.statusCode).toBe(400);
  expect(tooLongCjk.json<{ error: string }>().error).toBe('content_too_long');

  // 140 family emoji: 1120 UTF-16 units, 700 code points, 140 graphemes.
  expect(FAMILY.repeat(140).length).toBe(1120);
  const okEmoji = await submit(await claimGuest(), {
    kind: 'next_shot',
    content: FAMILY.repeat(140),
  });
  expect(okEmoji.statusCode).toBe(201);

  const tooLongEmoji = await submit(await claimGuest(), {
    kind: 'next_shot',
    content: FAMILY.repeat(141),
  });
  expect(tooLongEmoji.statusCode).toBe(400);
});

test('§17.5「下一集」上限 1000 个用户可见字符', async () => {
  await openRound();
  expect(NEXT_EPISODE_MAX_GRAPHEMES).toBe(1000);

  const ok = await submit(await claimGuest(), {
    kind: 'next_episode',
    content: '啊'.repeat(1000),
  });
  expect(ok.statusCode).toBe(201);

  const tooLong = await submit(await claimGuest(), {
    kind: 'next_episode',
    content: '啊'.repeat(1001),
  });
  expect(tooLong.statusCode).toBe(400);

  const emoji = await submit(await claimGuest(), {
    kind: 'next_episode',
    content: FAMILY.repeat(1000),
  });
  expect(emoji.statusCode).toBe(201);

  // A 140-grapheme 镜头 limit does not apply to a 总纲, and vice versa.
  const shotTooLong = await submit(await claimGuest(), {
    kind: 'next_shot',
    content: '啊'.repeat(200),
  });
  expect(shotTooLong.statusCode).toBe(400);
});

test('§4 next_shot 归本轮、next_episode 归本集：round_id / episode_id 落库正确', async () => {
  await openRound();
  const roundId = await currentRoundId();

  const shot = await postShot();
  const proposal = await submit(await claimGuest(), {
    kind: 'next_episode',
    content: '下一集应该去海边',
  });
  expect(proposal.statusCode).toBe(201);

  const rows = await pool.query<{
    id: string;
    kind: string;
    round_id: string | null;
    episode_id: string;
  }>('SELECT id, kind, round_id, episode_id FROM submissions ORDER BY created_at');
  const shotRow = rows.rows.find((row) => row.id === shot.id)!;
  const proposalRow = rows.rows.find(
    (row) => row.id === proposal.json<{ id: string }>().id,
  )!;

  expect(shotRow.round_id).toBe(roundId);
  // §16.1 CHECK ((kind='next_shot') = (round_id IS NOT NULL)).
  expect(proposalRow.round_id).toBeNull();
  expect(proposalRow.episode_id).toBe(shotRow.episode_id);
});

test('投稿成功会在同一事务中清空对应的服务端草稿', async () => {
  await openRound();
  const cookie = await claimGuest();

  const saved = await app.inject({
    method: 'PUT',
    url: '/api/me/drafts',
    headers: { cookie },
    payload: { kind: 'next_shot', body: '会被发布的这一段' },
  });
  expect(saved.statusCode).toBe(200);

  const published = await submit(cookie, {
    kind: 'next_shot',
    content: '会被发布的这一段',
  });
  expect(published.statusCode).toBe(201);

  const restored = await app.inject({
    method: 'GET',
    url: '/api/me/drafts',
    headers: { cookie },
  });
  expect(restored.statusCode).toBe(200);
  const row = restored
    .json<{ drafts: Array<{ kind: string; body: string }> }>()
    .drafts.find((draft) => draft.kind === 'next_shot');
  expect(row?.body).toBe('');
});

test('§4 遗留截止时间已过的空轮先拒绝投稿，tick 取消截止后继续等人', async () => {
  await openRound();
  const roundId = await currentRoundId();
  const cookie = await claimGuest();

  // The deadline is the deadline: the business clock is `closes_at`, not the
  // worker's timer, so a submission after it is refused even before the tick
  // that moves the round to `selecting`.
  await pool.query(
    "UPDATE rounds SET closes_at = now() - interval '1 second' WHERE id = $1",
    [roundId],
  );
  const late = await submit(cookie, { kind: 'next_shot', content: '迟到的点子' });
  expect(late.statusCode).toBe(409);
  expect(late.json<{ error: string }>().error).toBe('round_closed');

  await tick(pool);
  // The same empty round is disarmed instead of being handed to an AI writer.
  expect(
    (await submit(cookie, { kind: 'next_shot', content: '下一轮的点子' })).statusCode,
  ).toBe(201);
  expect(
    (
      await pool.query(
        "SELECT id FROM workflow_jobs WHERE round_id = $1 AND job_type = 'ai_screenwriter'",
        [roundId],
      )
    ).rowCount,
  ).toBe(0);
});

test('§4 一轮都还没开过时 next_shot 同样被拒绝', async () => {
  const response = await submit(await claimGuest(), {
    kind: 'next_shot',
    content: '还没开演',
  });
  expect(response.statusCode).toBe(409);
  expect(response.json<{ error: string }>().error).toBe('round_closed');
});

// --- §17.6 唯一性 ------------------------------------------------------------

test('§17.6 同一用户同一轮次只能投一条 next_shot，第二条被 23505 拦下', async () => {
  await openRound();
  const cookie = await claimGuest();
  expect(
    (await submit(cookie, { kind: 'next_shot', content: '第一条' })).statusCode,
  ).toBe(201);

  const second = await submit(cookie, { kind: 'next_shot', content: '第二条' });
  expect(second.statusCode).toBe(409);
  expect(second.json<{ error: string }>().error).toBe('duplicate_submission');

  const rows = await pool.query("SELECT id FROM submissions WHERE kind = 'next_shot'");
  expect(rows.rowCount).toBe(1);
});

test('同一用户一小时内跨四个连续轮次都可投稿，不存在每小时三条配额', async () => {
  await openRound();
  const cookie = await claimGuest();
  const submissionIds: string[] = [];

  for (let index = 1; index <= 4; index += 1) {
    const response = await submit(cookie, {
      kind: 'next_shot',
      content: `同一小时内的第 ${index} 条`,
    });
    expect(response.statusCode).toBe(201);
    submissionIds.push(response.json<{ id: string }>().id);

    if (index < 4) {
      await pool.query(
        "UPDATE rounds SET closes_at = now() - interval '1 second' WHERE status = 'open'",
      );
      await tick(pool);
    }
  }

  const rows = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM submissions s
      WHERE user_id = (SELECT user_id FROM submissions WHERE id = $1)
        AND s.kind = 'next_shot'
        AND s.created_at >= now() - interval '1 hour'`,
    [submissionIds[0]],
  );
  expect(Number(rows.rows[0].n)).toBe(4);
});

test('§4 同一用户同一集只能投一条 next_episode，跨轮次仍然只有一条', async () => {
  await openRound();
  const cookie = await claimGuest();
  expect(
    (await submit(cookie, { kind: 'next_episode', content: '总纲一' })).statusCode,
  ).toBe(201);
  expect(
    (await submit(cookie, { kind: 'next_episode', content: '总纲二' })).statusCode,
  ).toBe(409);

  // A new round does not open a new proposal pool — the episode does.
  expect(
    (
      await submit(await claimGuest(), {
        kind: 'next_shot',
        content: '让这一轮按用户投稿正常关闭',
      })
    ).statusCode,
  ).toBe(201);
  await pool.query("UPDATE rounds SET closes_at = now() - interval '1 second'");
  await tick(pool);
  const afterNewRound = await submit(cookie, {
    kind: 'next_episode',
    content: '总纲三',
  });
  expect(afterNewRound.statusCode).toBe(409);

  // …but a 镜头 submission in the new round is fine.
  expect(
    (await submit(cookie, { kind: 'next_shot', content: '新一轮的镜头' })).statusCode,
  ).toBe(201);
});

// --- §6.3 同事务入队 ---------------------------------------------------------

test('§6.3 投稿与初评任务在同一事务中写入', async () => {
  await openRound();
  const roundId = await currentRoundId();
  const shot = await postShot();

  const job = await pool.query<{
    job_type: string;
    status: string;
    round_id: string;
    payload_json: { submissionId: string };
  }>('SELECT job_type, status, round_id, payload_json FROM workflow_jobs WHERE idempotency_key = $1', [
    scoreJobKey(shot.id, INLAND_EMPIRE_MOVIE_ID),
  ]);
  expect(job.rowCount).toBe(1);
  expect(job.rows[0].job_type).toBe('submission_score');
  expect(job.rows[0].status).toBe('pending');
  expect(job.rows[0].round_id).toBe(roundId);
  expect(job.rows[0].payload_json.submissionId).toBe(shot.id);

  // A rejected submission leaves no orphan job behind.
  const before = await pool.query('SELECT id FROM workflow_jobs');
  await submit(shot.cookie, { kind: 'next_shot', content: '重复的一条' });
  const after = await pool.query('SELECT id FROM workflow_jobs');
  expect(after.rowCount).toBe(before.rowCount);
});

test('§6.3 next_episode 的初评任务挂在当前轮次下作为审计锚点', async () => {
  await openRound();
  const roundId = await currentRoundId();
  const response = await submit(await claimGuest(), {
    kind: 'next_episode',
    content: '下一集的总纲',
  });
  expect(response.statusCode).toBe(201);

  const job = await pool.query<{ round_id: string }>(
    'SELECT round_id FROM workflow_jobs WHERE idempotency_key = $1',
    [scoreJobKey(response.json<{ id: string }>().id, INLAND_EMPIRE_MOVIE_ID)],
  );
  expect(job.rows[0].round_id).toBe(roundId);
});

// --- 读取接口 ----------------------------------------------------------------

test('GET /api/round/current：没有轮次时 404，有轮次时返回业务时钟', async () => {
  const missing = await app.inject({ method: 'GET', url: '/api/round/current' });
  expect(missing.statusCode).toBe(404);

  await openRound();
  const response = await app.inject({ method: 'GET', url: '/api/round/current' });
  expect(response.statusCode).toBe(200);
  const body = response.json<{
    roundIndex: number;
    status: string;
    opensAt: string;
    closesAt: string | null;
    episodeIndex: number;
  }>();
  expect(body.roundIndex).toBe(1);
  expect(body.status).toBe('open');
  expect(body.episodeIndex).toBe(1);
  // 未点火的轮次没有截止时间：页面据此显示“等第一条投稿”而不是一个假倒计时
  // （§5.3）。
  expect(Date.parse(body.opensAt)).not.toBeNaN();
  expect(body.closesAt).toBeNull();

  await postShot('点燃这一轮');
  const armed = await app.inject({ method: 'GET', url: '/api/round/current' });
  const closesAt = armed.json<{ closesAt: string | null }>().closesAt;
  if (closesAt === null) throw new Error('the round was not armed');
  // testConfig 的 ROUND_LENGTH_MS 是 3 秒，从第一条投稿那一刻起算。
  expect(Date.parse(closesAt) - await databaseNow(pool)).toBeGreaterThan(1_000);
  expect(Date.parse(closesAt) - await databaseNow(pool)).toBeLessThanOrEqual(3_000);
});

test('§17.7 投稿立刻出现在当前轮次列表中，且只公开总分与四语毒舌', async () => {
  await openRound();
  const shot = await postShot('会被评分的点子');

  const before = await app.inject({
    method: 'GET',
    url: '/api/round/current/submissions',
  });
  const listedBefore = before.json<{
    submissions: { id: string; score: unknown; content: string }[];
  }>();
  expect(listedBefore.submissions).toHaveLength(1);
  expect(listedBefore.submissions[0].id).toBe(shot.id);
  expect(listedBefore.submissions[0].score).toBeNull();

  // §6.3 公开策略: score_breakdown / reason / risk_flags never leave the server.
  await pool.query(
    `INSERT INTO ai_runs (movie_id, round_id, submission_id, run_type, provider, model,
                          reasoning_effort, status)
     SELECT movie_id, round_id, id, 'submission_score', 'stub', 'stub', 'high', 'succeeded'
       FROM submissions WHERE id = $1`,
    [shot.id],
  );
  await pool.query(
    `INSERT INTO submission_scores (submission_id, eligible, score_total,
        score_breakdown, reason, public_roast, risk_flags, rubric_version,
        ai_run_id, scored_at)
     VALUES ($1, true, 77, '{"continuity":30}'::jsonb, 'SECRET REASON',
             '{"en":"a","zh-CN":"b","ja":"c","es":"d"}'::jsonb,
             '["SECRET FLAG"]'::jsonb, 'v1',
             (SELECT id FROM ai_runs WHERE submission_id = $1), now())`,
    [shot.id],
  );

  const after = await app.inject({
    method: 'GET',
    url: '/api/round/current/submissions',
  });
  const body = after.json<{
    submissions: Record<string, unknown>[];
  }>();
  const listed = body.submissions[0];
  const score = listed.score as { total: number; roast: Record<string, string> };
  expect(score.total).toBe(77);
  expect(Object.keys(score.roast).sort()).toEqual(['en', 'es', 'ja', 'zh-CN']);

  // Asserted as an exact key set, not as absent substrings: a future
  // `SELECT sc.*` would leak the internals without ever naming them here.
  expect(Object.keys(listed).sort()).toEqual([
    'content',
    'createdAt',
    'id',
    'score',
    'status',
    'upCount',
    'downCount',
    'username',
    'votesFrozen',
  ].sort());
  expect(Object.keys(score).sort()).toEqual(['roast', 'total']);
  expect(after.body).not.toContain('SECRET REASON');
  expect(after.body).not.toContain('SECRET FLAG');
  expect(after.body).not.toContain('continuity');

  // A full reload after the next round opens still restores this row, its
  // score and roast in the recent-round archive. SSE is an optimisation, not
  // the only way an AI Director/user winner remains visible.
  await pool.query("UPDATE submissions SET status = 'accepted' WHERE id = $1", [shot.id]);
  const firstRoundId = await currentRoundId();
  await pool.query("UPDATE rounds SET status = 'published' WHERE id = $1", [firstRoundId]);
  await tick(pool);

  const reloaded = await app.inject({
    method: 'GET',
    url: '/api/round/current/submissions',
  });
  const reloadedBody = reloaded.json<{
    roundIndex: number;
    submissions: unknown[];
    archive: Array<{
      roundIndex: number;
      submissions: Array<Record<string, unknown>>;
    }>;
  }>();
  expect(reloadedBody.roundIndex).toBe(2);
  expect(reloadedBody.submissions).toEqual([]);
  expect(reloadedBody.archive).toHaveLength(1);
  expect(reloadedBody.archive[0].roundIndex).toBe(1);
  expect(reloadedBody.archive[0].submissions[0]).toMatchObject({
    id: shot.id,
    status: 'accepted',
    score: {
      total: 77,
      roast: { 'zh-CN': 'b' },
    },
  });
});

test('时间线重载返回全部历史轮次，不把已生成镜头截成最近三轮', async () => {
  await openRound();

  for (let index = 1; index <= 5; index += 1) {
    const shot = await postShot(`历史镜头 ${index}`);
    const roundId = await currentRoundId();
    await pool.query("UPDATE submissions SET status = 'accepted' WHERE id = $1", [shot.id]);
    await pool.query("UPDATE rounds SET status = 'published' WHERE id = $1", [roundId]);
    await tick(pool);
  }

  const response = await app.inject({
    method: 'GET',
    url: '/api/round/current/submissions',
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<{
    archive: Array<{
      roundIndex: number;
      submissions: Array<{ content: string }>;
    }>;
  }>();

  expect(body.archive.map((round) => round.roundIndex)).toEqual([1, 2, 3, 4, 5]);
  expect(body.archive.map((round) => round.submissions[0].content)).toEqual([
    '历史镜头 1',
    '历史镜头 2',
    '历史镜头 3',
    '历史镜头 4',
    '历史镜头 5',
  ]);
});

test.each([false, true])('时间线区分选中但生成失败与已出片，并返回真实场次和下架状态 (%s)', async (takenDown) => {
  await openRound();
  const failed = await postShot('已选中但生成失败');
  const published = await postShot('成功出片的投稿');
  const failedRoundId = await currentRoundId();
  await pool.query("UPDATE rounds SET status = 'generation_failed' WHERE id = $1", [failedRoundId]);
  await pool.query("UPDATE submissions SET status = 'accepted' WHERE id = ANY($1::uuid[])", [[failed.id, published.id]]);
  await createScene(pool, {
    sceneIndex: 1,
    sourceSubmissionId: published.id,
    takedownAt: takenDown ? new Date() : undefined,
  });
  await pool.query(
    `UPDATE submissions SET round_id = s.round_id, episode_id = s.episode_id
       FROM scenes s WHERE submissions.id = $1 AND s.source_submission_id = $1`,
    [published.id],
  );
  await tick(pool);
  const response = await app.inject({ method: 'GET', url: '/api/round/current/submissions' });
  expect(response.statusCode).toBe(200);
  expect(response.json().archive).toEqual([
    expect.objectContaining({
      roundIndex: 1, status: 'generation_failed', sceneIndex: null, sceneTakenDown: false,
      submissions: [expect.objectContaining({ id: failed.id, status: 'accepted' })],
    }),
    expect.objectContaining({
      roundIndex: 2, status: 'published', sceneIndex: 1, sceneTakenDown: takenDown,
      submissions: [expect.objectContaining({ id: published.id, status: 'accepted' })],
    }),
  ]);
});

test('投稿时间线每页最多 100 条，用光标向前读取直到最早一条', async () => {
  await openRound();
  const roundId = await currentRoundId();
  const episode = await pool.query<{ episode_id: string }>(
    'SELECT episode_id FROM rounds WHERE id = $1',
    [roundId],
  );
  const suffix = Math.random().toString(36).slice(2, 12);

  // One round may receive many different users. Give every row an explicit
  // timestamp so the test also proves that page boundaries are stable.
  for (let index = 1; index <= 205; index += 1) {
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (username_display, username_key)
       VALUES ($1, $2) RETURNING id`,
      [`timeline-${index}`, `timeline-${suffix}-${index}`],
    );
    await pool.query(
      `INSERT INTO submissions
         (movie_id, kind, round_id, episode_id, user_id, content, created_at)
       VALUES ($1, 'next_shot', $2, $3, $4, $5,
               timestamptz '2026-01-01 00:00:00+00' + ($6 * interval '1 second'))`,
      [
        INLAND_EMPIRE_MOVIE_ID,
        roundId,
        episode.rows[0].episode_id,
        user.rows[0].id,
        `timeline ${index}`,
        index,
      ],
    );
  }

  let cursor: string | null = null;
  const contents: string[] = [];
  const pageSizes: number[] = [];
  do {
    const suffix = cursor === null ? '' : `?before=${encodeURIComponent(cursor)}`;
    const response = await app.inject({
      method: 'GET',
      url: `/api/round/current/submissions${suffix}`,
    });
    expect(response.statusCode).toBe(200);
    const page = response.json<{
      submissions: Array<{ content: string }>;
      archive: Array<{ submissions: Array<{ content: string }> }>;
      hasMore: boolean;
      nextCursor: string | null;
    }>();
    const rows = [
      ...page.archive.flatMap((round) => round.submissions),
      ...page.submissions,
    ];
    pageSizes.push(rows.length);
    contents.unshift(...rows.map((row) => row.content));
    cursor = page.nextCursor;
    if (!page.hasMore) expect(cursor).toBeNull();
  } while (cursor !== null);

  expect(pageSizes).toEqual([100, 100, 5]);
  expect(contents).toHaveLength(205);
  expect(new Set(contents).size).toBe(205);
  expect(contents[0]).toBe('timeline 1');
  expect(contents.at(-1)).toBe('timeline 205');
});

test('投稿时间线拒绝损坏的分页光标', async () => {
  await openRound();
  const response = await app.inject({
    method: 'GET',
    url: '/api/round/current/submissions?before=not-a-cursor',
  });
  expect(response.statusCode).toBe(400);
  expect(response.json<{ error: string }>().error).toBe('cursor_invalid');
});

// --- §17.27 投票 -------------------------------------------------------------

test('§17.27 不能给自己的投稿投票（403）', async () => {
  await openRound();
  const shot = await postShot();
  const response = await vote(shot.cookie, shot.id, 1);
  expect(response.statusCode).toBe(403);
  expect(response.json<{ error: string }>().error).toBe('self_vote');

  const counts = await pool.query('SELECT * FROM submission_votes');
  expect(counts.rowCount).toBe(0);
});

test('§17.27 每人每条一票，可改票、可撤票，计票缓存同事务维护', async () => {
  await openRound();
  const shot = await postShot();
  const alice = await claimGuest();
  const bob = await claimGuest();

  const up = await vote(alice, shot.id, 1);
  expect(up.statusCode).toBe(200);
  expect(up.json<{ upCount: number; downCount: number }>()).toMatchObject({
    upCount: 1,
    downCount: 0,
  });

  // A second vote from the same identity replaces the first, never adds to it.
  const changed = await vote(alice, shot.id, -1);
  expect(changed.json<{ upCount: number; downCount: number }>()).toMatchObject({
    upCount: 0,
    downCount: 1,
  });
  const rows = await pool.query('SELECT * FROM submission_votes WHERE submission_id = $1', [
    shot.id,
  ]);
  expect(rows.rowCount).toBe(1);

  const both = await vote(bob, shot.id, 1);
  expect(both.json<{ upCount: number; downCount: number }>()).toMatchObject({
    upCount: 1,
    downCount: 1,
  });

  // 撤票.
  const revoked = await vote(alice, shot.id, 0);
  expect(revoked.json<{ upCount: number; downCount: number }>()).toMatchObject({
    upCount: 1,
    downCount: 0,
  });
  const remaining = await pool.query(
    'SELECT user_id FROM submission_votes WHERE submission_id = $1',
    [shot.id],
  );
  expect(remaining.rowCount).toBe(1);

  // The cache columns agree with the vote table (§5.4 同事务维护).
  const cached = await pool.query<{ up_count: number; down_count: number }>(
    'SELECT up_count, down_count FROM submissions WHERE id = $1',
    [shot.id],
  );
  expect(cached.rows[0]).toEqual({ up_count: 1, down_count: 0 });
});

test('§5.4 第一个净赞达到 10 的镜头关轮候选、旧轮清零并原子开启新轮', async () => {
  await openRound();
  const oldRoundId = await currentRoundId();
  const first = await postShot('第一个到十赞的镜头');
  const second = await postShot('晚一步到十赞的镜头');
  // Keep this database-heavy election test independent of the suite's short
  // three-second clock; production still uses the configured five minutes.
  await pool.query(
    "UPDATE rounds SET closes_at = now() + interval '1 hour' WHERE id = $1",
    [oldRoundId],
  );

  for (let index = 0; index < 9; index += 1) {
    const firstVote = await vote(await claimGuest(), first.id, 1);
    const secondVote = await vote(await claimGuest(), second.id, 1);
    expect(firstVote.statusCode).toBe(200);
    expect(secondVote.statusCode).toBe(200);
    expect(firstVote.json<{ crowdAdopted: boolean }>().crowdAdopted).toBe(false);
    expect(secondVote.json<{ crowdAdopted: boolean }>().crowdAdopted).toBe(false);
  }

  const winnerVote = await vote(await claimGuest(), first.id, 1);
  expect(winnerVote.statusCode).toBe(200);
  expect(winnerVote.json<{
    upCount: number;
    downCount: number;
    crowdAdopted: boolean;
  }>()).toMatchObject({ upCount: 10, downCount: 0, crowdAdopted: true });

  // Once the first contender commits, all pitches from the old round are
  // frozen. The other contender cannot also become a winner.
  const late = await vote(await claimGuest(), second.id, 1);
  expect(late.statusCode).toBe(409);
  expect(late.json<{ error: string }>().error).toBe('votes_frozen');

  const oldRound = await pool.query<{
    status: string;
    selected_submission_id: string;
    selection_mode: string;
    closes_at: Date;
  }>(
    `SELECT status, selected_submission_id, selection_mode, closes_at
       FROM rounds WHERE id = $1`,
    [oldRoundId],
  );
  expect(oldRound.rows[0]).toMatchObject({
    status: 'selecting',
    selected_submission_id: first.id,
    selection_mode: 'crowd',
  });
  expect(oldRound.rows[0].closes_at.getTime()).toBeLessThanOrEqual(await databaseNow(pool));

  const pitches = await pool.query<{
    id: string;
    status: string;
    votes_frozen_at: Date | null;
  }>(
    `SELECT id, status, votes_frozen_at FROM submissions
      WHERE round_id = $1 ORDER BY id`,
    [oldRoundId],
  );
  expect(pitches.rows.every((row) => row.votes_frozen_at !== null)).toBe(true);
  // Reaching the line cannot skip the one Terra/high score + roast. The route
  // records the crowd candidate but leaves its status pending for that worker.
  expect(pitches.rows.find((row) => row.id === first.id)?.status).toBe('pending');

  const successor = await pool.query<{
    id: string;
    round_index: string;
    closes_at: Date | null;
  }>(
    "SELECT id, round_index, closes_at FROM rounds WHERE status = 'open'",
  );
  expect(successor.rowCount).toBe(1);
  expect(successor.rows[0].id).not.toBe(oldRoundId);
  expect(Number(successor.rows[0].round_index)).toBe(2);
  expect(successor.rows[0].closes_at).toBeNull();

  expect(
    (
      await pool.query(
        "SELECT id FROM workflow_jobs WHERE round_id = $1 AND job_type = 'round_finalize'",
        [oldRoundId],
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT id FROM workflow_jobs WHERE round_id = $1 AND job_type = 'scene_director'",
        [oldRoundId],
      )
    ).rowCount,
  ).toBe(0);
});

test('§16.6 直采热覆盖在投票事务中生效', async () => {
  await openRound();
  const shot = await postShot('运营把这一轮的直采线调到二');
  await pool.query(
    `INSERT INTO site_settings (key, value) VALUES ($1, $2::jsonb)`,
    ['vote_adopt_threshold_override', '2'],
  );

  const first = await vote(await claimGuest(), shot.id, 1);
  expect(first.json<{ crowdAdopted: boolean }>().crowdAdopted).toBe(false);
  const second = await vote(await claimGuest(), shot.id, 1);
  expect(second.json<{ crowdAdopted: boolean }>().crowdAdopted).toBe(true);
});

test('投票值只能是 +1 / -1 / 0，投稿不存在返回 404', async () => {
  await openRound();
  const shot = await postShot();
  const voter = await claimGuest();
  for (const value of [2, -2, 0.5, '1', null, undefined]) {
    const response = await vote(voter, shot.id, value);
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('value_invalid');
  }
  expect(
    (await vote(voter, '11111111-1111-4111-8111-111111111111', 1)).statusCode,
  ).toBe(404);
  expect((await vote(voter, 'not-a-uuid', 1)).statusCode).toBe(404);
});

test('§17.27 冻结后到达的投票被拒绝（409）', async () => {
  await openRound();
  const shot = await postShot();
  const voter = await claimGuest();
  expect((await vote(voter, shot.id, 1)).statusCode).toBe(200);

  await pool.query("UPDATE rounds SET closes_at = now() - interval '1 second'");
  await tick(pool);

  const late = await vote(voter, shot.id, -1);
  expect(late.statusCode).toBe(409);
  expect(late.json<{ error: string }>().error).toBe('votes_frozen');
  const cached = await pool.query<{ up_count: number; down_count: number }>(
    'SELECT up_count, down_count FROM submissions WHERE id = $1',
    [shot.id],
  );
  expect(cached.rows[0]).toEqual({ up_count: 1, down_count: 0 });
});

test('§4 与轮次截止事务竞速的投票会等待行锁，然后被冻结拒绝', async () => {
  await openRound();
  const shot = await postShot();
  const voter = await claimGuest();

  const holder = await pool.connect();
  let settled = false;
  try {
    await holder.query('BEGIN');
    // The freeze in rounds/clock.ts takes exactly this row lock.
    await holder.query('SELECT id FROM submissions WHERE id = $1 FOR UPDATE', [
      shot.id,
    ]);

    const voting = vote(voter, shot.id, 1).then((response) => {
      settled = true;
      return response;
    });
    await sleep(300);
    // Proof the vote is serialised against the close rather than racing it.
    expect(settled).toBe(false);

    await holder.query(
      'UPDATE submissions SET votes_frozen_at = now() WHERE id = $1',
      [shot.id],
    );
    await holder.query('COMMIT');

    const response = await voting;
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe('votes_frozen');
  } finally {
    holder.release();
  }

  const votes = await pool.query('SELECT * FROM submission_votes');
  expect(votes.rowCount).toBe(0);
});

// --- §4 反滥用 ---------------------------------------------------------------

test('§4 投稿与投票按身份限流（429）', async () => {
  const limited = buildApp(testConfig, pool, {
    guestClaimRateLimit: 10_000,
    submissionRateLimit: 2,
    voteRateLimit: 2,
  });
  await limited.ready();
  try {
    await openRound();
    const cookie = await claimGuest(limited);
    // Every request from a different address, so only the per-identity counter
    // can be what stops the third one (§4「限制单个 Cookie ……的提交频率」).
    // Two are allowed per window, valid or not.
    await submit(cookie, { kind: 'next_shot', content: '一' }, limited, '10.0.0.1');
    await submit(cookie, { kind: 'bogus', content: '二' }, limited, '10.0.0.2');
    const third = await submit(
      cookie,
      { kind: 'next_shot', content: '三' },
      limited,
      '10.0.0.3',
    );
    expect(third.statusCode).toBe(429);

    const shot = await postShot();
    const voter = await claimGuest(limited);
    await vote(voter, shot.id, 1, limited, '10.0.1.1');
    await vote(voter, shot.id, -1, limited, '10.0.1.2');
    expect((await vote(voter, shot.id, 0, limited, '10.0.1.3')).statusCode).toBe(429);
  } finally {
    await limited.close();
  }
});

test('§4 投稿与投票按 IP 限流：换身份不重置计数（429）', async () => {
  const limited = buildApp(testConfig, pool, {
    guestClaimRateLimit: 10_000,
    submissionRateLimit: 2,
    voteRateLimit: 2,
  });
  await limited.ready();
  try {
    await openRound();
    // §4「限制单个 Cookie 和 IP 的提交频率」— two axes, so a script that claims
    // a fresh guest per request must still hit the ceiling.
    await submit(await claimGuest(limited), { kind: 'next_shot', content: '一' }, limited);
    await submit(await claimGuest(limited), { kind: 'next_shot', content: '二' }, limited);
    const third = await submit(
      await claimGuest(limited),
      { kind: 'next_shot', content: '三' },
      limited,
    );
    expect(third.statusCode).toBe(429);

    const shot = await postShot();
    await vote(await claimGuest(limited), shot.id, 1, limited);
    await vote(await claimGuest(limited), shot.id, 1, limited);
    expect(
      (await vote(await claimGuest(limited), shot.id, 1, limited)).statusCode,
    ).toBe(429);
  } finally {
    await limited.close();
  }
});
