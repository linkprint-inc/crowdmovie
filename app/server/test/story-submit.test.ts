// 规范 §4.2 的完整性校验。
//
// The shape that matters: an incomplete proposal is refused with a `missing`
// array that names every unmet condition at once. A gate that reports one
// problem per attempt makes the author submit six times to learn six things.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';

import { runMigrations } from '../src/db/migrate';
import { buildApp } from '../src/web/app';
import { ensureDatabase, resetStory, testConfig, TEST_URL } from './helpers';

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(64, 7),
]);

/** 500 个可数单位的大纲，刚好到下限。 */
const SYNOPSIS_500 = '字'.repeat(500);

let pool: pg.Pool;
let app: ReturnType<typeof buildApp>;
let mediaDir: string;
let seq = 0;
const uniq = (): string => `${Date.now().toString(36)}_${(seq += 1)}`;

beforeAll(async () => {
  await ensureDatabase();
  await runMigrations(TEST_URL);
  pool = new pg.Pool({ connectionString: TEST_URL });
  mediaDir = await mkdtemp(join(tmpdir(), 'cm-submit-'));
  app = buildApp({ ...testConfig, MEDIA_DIR: mediaDir }, pool, {
    guestClaimRateLimit: 10_000,
    authIpRateLimit: 10_000,
    storyRateLimit: 10_000,
    events: false,
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

interface Draft {
  cookie: string;
  id: string;
}

async function newDraft(): Promise<Draft> {
  const username = `sb_${uniq()}`;
  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, email: `${username}@example.com`, password: 'password123' },
  });
  const session = registered.cookies.find((each) => each.name === 'cm_session');
  if (session === undefined) throw new Error('no session cookie');
  const cookie = `cm_session=${session.value}`;
  const created = await app.inject({
    method: 'POST',
    url: '/api/stories',
    headers: { cookie },
  });
  return { cookie, id: created.json().id as string };
}

async function addImage(
  draft: Draft,
  kind: string,
  position: number,
  caption = '一段合格的说明',
): Promise<void> {
  const uploaded = await app.inject({
    method: 'POST',
    url: `/api/stories/${draft.id}/images?kind=${kind}&position=${position}`,
    headers: { cookie: draft.cookie, 'content-type': 'image/jpeg' },
    payload: JPEG,
  });
  expect(uploaded.statusCode).toBe(201);
  if (caption !== '') {
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/stories/${draft.id}/images/${uploaded.json().id as string}`,
      headers: { cookie: draft.cookie },
      payload: { caption },
    });
    expect(saved.statusCode).toBe(200);
  }
}

/** A proposal that satisfies every rule: title, 500 units, 4 + 4 captioned. */
async function completeDraft(): Promise<Draft> {
  const draft = await newDraft();
  await app.inject({
    method: 'PUT',
    url: `/api/stories/${draft.id}`,
    headers: { cookie: draft.cookie },
    payload: { title: '夜行电车', synopsis: SYNOPSIS_500 },
  });
  for (const kind of ['character', 'world']) {
    for (let position = 0; position < 4; position += 1) {
      await addImage(draft, kind, position);
    }
  }
  return draft;
}

const submit = (draft: Draft) =>
  app.inject({
    method: 'POST',
    url: `/api/stories/${draft.id}/submit`,
    headers: { cookie: draft.cookie },
  });

describe('完整的提案可以提交', () => {
  test('状态变成 pending，并且入队了审核任务', async () => {
    const draft = await completeDraft();

    const response = await submit(draft);

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('pending');
    const job = await pool.query<{ payload_json: { proposalId: string } }>(
      `SELECT payload_json FROM workflow_jobs WHERE job_type = 'story_review'`,
    );
    expect(job.rowCount).toBe(1);
    expect(job.rows[0].payload_json.proposalId).toBe(draft.id);
  });

  test('提交之后就不能再改了', async () => {
    const draft = await completeDraft();
    await submit(draft);

    const edit = await app.inject({
      method: 'PUT',
      url: `/api/stories/${draft.id}`,
      headers: { cookie: draft.cookie },
      payload: { title: '改标题', synopsis: SYNOPSIS_500 },
    });

    expect(edit.statusCode).toBe(409);
  });

  test('重复提交不会入队第二个任务', async () => {
    const draft = await completeDraft();
    await submit(draft);

    const again = await submit(draft);

    expect(again.statusCode).toBe(409);
    const jobs = await pool.query(
      `SELECT 1 FROM workflow_jobs WHERE job_type = 'story_review'`,
    );
    expect(jobs.rowCount).toBe(1);
  });

  test('6 张也可以，上限是 6 不是 4', async () => {
    const draft = await completeDraft();
    await addImage(draft, 'character', 4);
    await addImage(draft, 'character', 5);

    expect((await submit(draft)).statusCode).toBe(200);
  });
});

describe('不完整的提案被拒，并一次说清缺什么', () => {
  test('大纲差一个单位就不行', async () => {
    const draft = await completeDraft();
    await app.inject({
      method: 'PUT',
      url: `/api/stories/${draft.id}`,
      headers: { cookie: draft.cookie },
      payload: { title: '夜行电车', synopsis: '字'.repeat(499) },
    });

    const response = await submit(draft);

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('incomplete');
    expect(response.json().missing).toContain('synopsis_too_short');
  });

  test('人物图只有 3 张不行', async () => {
    const draft = await newDraft();
    await app.inject({
      method: 'PUT',
      url: `/api/stories/${draft.id}`,
      headers: { cookie: draft.cookie },
      payload: { title: '夜行电车', synopsis: SYNOPSIS_500 },
    });
    for (let position = 0; position < 3; position += 1) {
      await addImage(draft, 'character', position);
    }
    for (let position = 0; position < 4; position += 1) {
      await addImage(draft, 'world', position);
    }

    const response = await submit(draft);

    expect(response.json().missing).toContain('character_images_too_few');
  });

  test('世界观图只有 3 张不行', async () => {
    const draft = await newDraft();
    await app.inject({
      method: 'PUT',
      url: `/api/stories/${draft.id}`,
      headers: { cookie: draft.cookie },
      payload: { title: '夜行电车', synopsis: SYNOPSIS_500 },
    });
    for (let position = 0; position < 4; position += 1) {
      await addImage(draft, 'character', position);
    }
    for (let position = 0; position < 3; position += 1) {
      await addImage(draft, 'world', position);
    }

    const response = await submit(draft);

    expect(response.json().missing).toContain('world_images_too_few');
  });

  test('有一张图没写说明就不行，并指明是哪一张', async () => {
    const draft = await completeDraft();
    await pool.query(
      `UPDATE story_images SET caption = ''
        WHERE proposal_id = $1 AND kind = 'world' AND position = 2`,
      [draft.id],
    );

    const response = await submit(draft);

    expect(response.statusCode).toBe(400);
    expect(response.json().missing).toContain('caption_required:world:3');
  });

  test('标题空着不行', async () => {
    const draft = await completeDraft();
    await pool.query(`UPDATE story_proposals SET title = '' WHERE id = $1`, [
      draft.id,
    ]);

    const response = await submit(draft);

    expect(response.json().missing).toContain('title_required');
  });

  test('缺多项时一次全列出来 —— 不让作者试六次学六件事', async () => {
    const draft = await newDraft();

    const response = await submit(draft);

    const missing = response.json().missing as string[];
    expect(missing).toContain('title_required');
    expect(missing).toContain('synopsis_too_short');
    expect(missing).toContain('character_images_too_few');
    expect(missing).toContain('world_images_too_few');
  });

  test('被拒的提案没有入队任何任务', async () => {
    const draft = await newDraft();

    await submit(draft);

    const jobs = await pool.query(
      `SELECT 1 FROM workflow_jobs WHERE job_type = 'story_review'`,
    );
    expect(jobs.rowCount).toBe(0);
  });
});

describe('被拒之后重投', () => {
  test('reopen 把它退回草稿', async () => {
    const draft = await completeDraft();
    await submit(draft);
    await pool.query(
      `UPDATE story_proposals SET status = 'rejected', reject_reason = '不行'
        WHERE id = $1`,
      [draft.id],
    );

    const reopened = await app.inject({
      method: 'POST',
      url: `/api/stories/${draft.id}/reopen`,
      headers: { cookie: draft.cookie },
    });

    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().status).toBe('draft');
    // 旧的拒绝理由清掉了，不然作者会以为新稿子也被拒了。
    expect(reopened.json().rejectReason).toBeNull();
  });

  test('上一次判决的留痕一并清掉，不只是给作者看的那一条', async () => {
    const draft = await completeDraft();
    await submit(draft);
    await pool.query(
      `UPDATE story_proposals SET
         status = 'rejected',
         reject_reason = '不行',
         review_output = '{"approved":false,"reasons":["不行"]}'::jsonb,
         review_model = 'gpt-5.6-sol'
       WHERE id = $1`,
      [draft.id],
    );

    await app.inject({
      method: 'POST',
      url: `/api/stories/${draft.id}/reopen`,
      headers: { cookie: draft.cookie },
    });

    // 这两列不对外，但它们描述的是一份即将被重写的稿子。留着，这一行就还能被
    // 读成「已判决」—— 与 scheduler.ts 在审核失败时的做法是同一条规矩。
    const row = await pool.query<{
      review_output: unknown;
      review_model: string | null;
    }>('SELECT review_output, review_model FROM story_proposals WHERE id = $1', [
      draft.id,
    ]);
    expect(row.rows[0].review_output).toBeNull();
    expect(row.rows[0].review_model).toBeNull();
  });

  test('重投会真的重新审一遍，不会被幂等键吞掉', async () => {
    const draft = await completeDraft();
    await submit(draft);
    await pool.query(
      `UPDATE story_proposals SET status = 'rejected' WHERE id = $1`,
      [draft.id],
    );
    await app.inject({
      method: 'POST',
      url: `/api/stories/${draft.id}/reopen`,
      headers: { cookie: draft.cookie },
    });

    const again = await submit(draft);

    expect(again.statusCode).toBe(200);
    const jobs = await pool.query(
      `SELECT 1 FROM workflow_jobs WHERE job_type = 'story_review'`,
    );
    expect(jobs.rowCount).toBe(2);
  });

  test('审核失败的也能重投', async () => {
    const draft = await completeDraft();
    await submit(draft);
    await pool.query(
      `UPDATE story_proposals SET status = 'review_failed' WHERE id = $1`,
      [draft.id],
    );

    const reopened = await app.inject({
      method: 'POST',
      url: `/api/stories/${draft.id}/reopen`,
      headers: { cookie: draft.cookie },
    });

    expect(reopened.statusCode).toBe(200);
  });

  test('已发布的不能退回草稿 —— 发布即锁定', async () => {
    const draft = await completeDraft();
    await submit(draft);
    await pool.query(
      `UPDATE story_proposals SET status = 'approved', published_at = now()
        WHERE id = $1`,
      [draft.id],
    );

    const reopened = await app.inject({
      method: 'POST',
      url: `/api/stories/${draft.id}/reopen`,
      headers: { cookie: draft.cookie },
    });

    expect(reopened.statusCode).toBe(409);
  });
});
