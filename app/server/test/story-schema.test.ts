// 规范 §3 的四张表：约束是真的、索引是真的、级联是真的。
//
// 和 schema.test.ts 一样打真实的 PostgreSQL：CHECK 与部分唯一索引只有数据库
// 会执行，在应用层重述一遍不算测到。
import pg from 'pg';

import { runMigrations } from '../src/db/migrate';
import { ensureDatabase, TEST_URL } from './helpers';

let pool: pg.Pool;
let seq = 0;
const uniq = (): string => `${Date.now().toString(36)}_${(seq += 1)}`;

beforeAll(async () => {
  await ensureDatabase();
  await runMigrations(TEST_URL);
  pool = new pg.Pool({ connectionString: TEST_URL });
}, 60_000);

afterAll(async () => {
  await pool?.end();
});

async function newUser(): Promise<string> {
  const name = `ss_${uniq()}`;
  const row = await pool.query<{ id: string }>(
    `INSERT INTO users (username_display, username_key, password_hash)
     VALUES ($1, $1, 'x') RETURNING id`,
    [name],
  );
  return row.rows[0].id;
}

async function newProposal(userId: string, status = 'draft'): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `INSERT INTO story_proposals (user_id, title, synopsis, status)
     VALUES ($1, 't', 's', $2) RETURNING id`,
    [userId, status],
  );
  return row.rows[0].id;
}

test('status 只接受五个值', async () => {
  const userId = await newUser();
  await expect(
    pool.query(
      `INSERT INTO story_proposals (user_id, status) VALUES ($1, 'whatever')`,
      [userId],
    ),
  ).rejects.toMatchObject({ code: '23514' });
});

test('每人同时只能有一份 draft 或 pending', async () => {
  const userId = await newUser();
  await newProposal(userId, 'draft');

  // 第二份草稿被部分唯一索引挡住。
  await expect(newProposal(userId, 'pending')).rejects.toMatchObject({
    code: '23505',
  });
});

test('已发布或被拒之后可以再开一份新的', async () => {
  const userId = await newUser();
  const first = await newProposal(userId, 'draft');
  await pool.query(`UPDATE story_proposals SET status = 'approved' WHERE id = $1`, [
    first,
  ]);

  await expect(newProposal(userId, 'draft')).resolves.toEqual(expect.any(String));
});

test('图片的 kind、position 与大小都有 CHECK', async () => {
  const userId = await newUser();
  const proposalId = await newProposal(userId);
  const insert = (kind: string, position: number, bytes: number) =>
    pool.query(
      `INSERT INTO story_images
         (proposal_id, kind, position, file_url, mime, bytes, sha256)
       VALUES ($1, $2, $3, '/media/story/x.jpg', 'image/jpeg', $4, 'abc')`,
      [proposalId, kind, position, bytes],
    );

  await expect(insert('sidekick', 0, 100)).rejects.toMatchObject({ code: '23514' });
  await expect(insert('character', 6, 100)).rejects.toMatchObject({ code: '23514' });
  await expect(insert('character', 0, 0)).rejects.toMatchObject({ code: '23514' });
  await expect(insert('character', 0, 2 * 1024 * 1024 + 1)).rejects.toMatchObject({
    code: '23514',
  });
  await expect(insert('character', 0, 100)).resolves.toBeTruthy();

  // 边界本身必须被接受：position=5 是六个格子里的最后一个，bytes=2097152
  // 正好是 2 MiB。用不同的 (kind, position) 格子，避免撞上
  // story_images_slot_uq 而不是真的测到 CHECK。
  await expect(insert('character', 5, 100)).resolves.toBeTruthy();
  await expect(insert('world', 0, 2 * 1024 * 1024)).resolves.toBeTruthy();
});

test('同一个格子只能有一张图', async () => {
  const userId = await newUser();
  const proposalId = await newProposal(userId);
  const insert = () =>
    pool.query(
      `INSERT INTO story_images
         (proposal_id, kind, position, file_url, mime, bytes, sha256)
       VALUES ($1, 'world', 2, '/media/story/x.jpg', 'image/png', 100, 'abc')`,
      [proposalId],
    );

  await insert();
  await expect(insert()).rejects.toMatchObject({ code: '23505' });
});

test('一人对一份设定只能点一次赞', async () => {
  const author = await newUser();
  const reader = await newUser();
  const proposalId = await newProposal(author);
  const like = () =>
    pool.query('INSERT INTO story_likes (proposal_id, user_id) VALUES ($1, $2)', [
      proposalId,
      reader,
    ]);

  await like();
  await expect(like()).rejects.toMatchObject({ code: '23505' });
});

test('删除提案会带走它的图片、点赞与跟帖', async () => {
  const author = await newUser();
  const reader = await newUser();
  const proposalId = await newProposal(author);
  await pool.query(
    `INSERT INTO story_images
       (proposal_id, kind, position, file_url, mime, bytes, sha256)
     VALUES ($1, 'character', 0, '/media/story/x.jpg', 'image/jpeg', 100, 'abc')`,
    [proposalId],
  );
  await pool.query(
    'INSERT INTO story_likes (proposal_id, user_id) VALUES ($1, $2)',
    [proposalId, reader],
  );
  await pool.query(
    'INSERT INTO story_comments (proposal_id, user_id, content) VALUES ($1, $2, $3)',
    [proposalId, reader, 'hi'],
  );

  await pool.query('DELETE FROM story_proposals WHERE id = $1', [proposalId]);

  for (const table of ['story_images', 'story_likes', 'story_comments']) {
    const left = await pool.query(
      `SELECT 1 FROM ${table} WHERE proposal_id = $1`,
      [proposalId],
    );
    expect(left.rowCount, `${table} 没有跟着删掉`).toBe(0);
  }
});

test('跟帖 id 是自增的，可以直接当楼层号排序', async () => {
  const author = await newUser();
  const reader = await newUser();
  const proposalId = await newProposal(author);
  const rows = await pool.query<{ id: string }>(
    `INSERT INTO story_comments (proposal_id, user_id, content)
     VALUES ($1, $2, 'a'), ($1, $2, 'b') RETURNING id`,
    [proposalId, reader],
  );

  expect(Number(rows.rows[1].id)).toBeGreaterThan(Number(rows.rows[0].id));
});

test('跟帖 status 只接受 visible 或 hidden', async () => {
  const author = await newUser();
  const reader = await newUser();
  const proposalId = await newProposal(author);
  const insert = (status: string) =>
    pool.query(
      `INSERT INTO story_comments (proposal_id, user_id, content, status)
       VALUES ($1, $2, 'hi', $3)`,
      [proposalId, reader, status],
    );

  await expect(insert('whatever')).rejects.toMatchObject({ code: '23514' });
  await expect(insert('visible')).resolves.toBeTruthy();
  await expect(insert('hidden')).resolves.toBeTruthy();
});
