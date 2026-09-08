// 规范 §5.4 的任务处理器。
//
// The two verdicts this suite cares about most are the fourth and fifth: when
// the reviewer is unreachable, and when an image is missing from disk, the
// proposal must land in `review_failed`, never in `rejected`. Both are our
// failure, not the author's. Reporting downtime to a writer as a judgement on
// what they wrote is the one failure mode here that damages something real.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import pg from 'pg';

import { createStubReviewer, type StoryReviewer } from '../src/ai/story-review';
import { runMigrations } from '../src/db/migrate';
import { storyReviewJobKey } from '../src/jobs/keys';
import { enqueue } from '../src/jobs/ledger';
import { silentLogger, startWorker } from '../src/jobs/scheduler';
import { storyReviewHandler } from '../src/jobs/handlers/story-review';
import { createStubEngine } from '../src/ai/stub';
import { storyImagePath } from '../src/lib/story-images';
import { ensureDatabase, resetStory, testConfig, TEST_URL, waitFor } from './helpers';

let pool: pg.Pool;
let mediaDir: string;
let seq = 0;
const uniq = (): string => `${Date.now().toString(36)}_${(seq += 1)}`;

beforeAll(async () => {
  await ensureDatabase();
  await runMigrations(TEST_URL);
  pool = new pg.Pool({ connectionString: TEST_URL });
  mediaDir = await mkdtemp(join(tmpdir(), 'cm-review-'));
}, 60_000);

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await resetStory(pool);
});

/** A complete, submittable proposal already at `pending`. */
async function pendingProposal(caption = '正常说明'): Promise<string> {
  const name = `sr_${uniq()}`;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (username_display, username_key, password_hash)
     VALUES ($1, $1, 'x') RETURNING id`,
    [name],
  );
  const proposal = await pool.query<{ id: string }>(
    `INSERT INTO story_proposals (user_id, title, synopsis, status, submitted_at)
     VALUES ($1, '夜行电车', '一列永不到站的电车', 'pending', now())
     RETURNING id`,
    [user.rows[0].id],
  );
  const proposalId = proposal.rows[0].id;
  for (const kind of ['character', 'world'] as const) {
    for (let position = 0; position < 4; position += 1) {
      const fileUrl = `/media/story/${proposalId}/${kind}-${position}.png`;
      await pool.query(
        `INSERT INTO story_images
           (proposal_id, kind, position, caption, file_url, mime, bytes, sha256)
         VALUES ($1, $2, $3, $4, $5, 'image/png', 100, 'abc')`,
        [proposalId, kind, position, caption, fileUrl],
      );
      // The stub reviewer never looks at the bytes, but the handler reads the
      // file before it calls one. A proposal whose images are not on disk is a
      // storage failure, and this suite is about verdicts — so the fixtures
      // are real files, and the missing-file path gets its own test below.
      const path = storyImagePath(mediaDir, fileUrl);
      if (path === null) throw new Error(`fixture url escapes mediaDir: ${fileUrl}`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }
  }
  return proposalId;
}

/** Run one worker with only this handler registered, until `probe` is true. */
async function runWorker(
  reviewer: StoryReviewer | undefined,
  probe: () => Promise<unknown>,
): Promise<void> {
  const worker = startWorker({
    pool,
    config: testConfig,
    engine: createStubEngine(),
    ...(reviewer === undefined ? {} : { reviewer }),
    handlers: { story_review: storyReviewHandler },
    log: silentLogger,
    // 让这套测试不受轮次时钟影响。
    roundLengthMs: 3_600_000,
    mediaDir,
  });
  try {
    await waitFor(probe, 'the review job to settle');
  } finally {
    await worker.stop();
  }
}

async function statusOf(proposalId: string): Promise<{
  status: string;
  reject_reason: string | null;
  review_model: string | null;
  review_output: unknown;
  published_at: Date | null;
}> {
  const row = await pool.query<{
    status: string;
    reject_reason: string | null;
    review_model: string | null;
    review_output: unknown;
    published_at: Date | null;
  }>(
    `SELECT status, reject_reason, review_model, review_output, published_at
       FROM story_proposals WHERE id = $1`,
    [proposalId],
  );
  return row.rows[0];
}

test('审核通过就发布，并如实记下审核的是谁', async () => {
  const proposalId = await pendingProposal();
  await enqueue(pool, {
    jobType: 'story_review',
    idempotencyKey: storyReviewJobKey(proposalId, 1),
    payload: { proposalId },
  });

  await runWorker(createStubReviewer(), async () => {
    const row = await statusOf(proposalId);
    return row.status !== 'pending' ? row : null;
  });

  const row = await statusOf(proposalId);
  expect(row.status).toBe('approved');
  expect(row.published_at).not.toBeNull();
  expect(row.review_model).toBe('stub');
});

test('生产未配置审核器时失败关闭，不能由隐式 stub 自动通过', async () => {
  const proposalId = await pendingProposal();
  await enqueue(pool, {
    jobType: 'story_review',
    idempotencyKey: storyReviewJobKey(proposalId, 1),
    payload: { proposalId },
  });

  await runWorker(undefined, async () => {
    const row = await statusOf(proposalId);
    return row.status !== 'pending' ? row : null;
  });

  const row = await statusOf(proposalId);
  expect(row.status).toBe('review_failed');
  expect(row.published_at).toBeNull();
  expect(row.review_model).toBeNull();
});

test('审核不通过就拒绝，并把理由留给作者', async () => {
  const proposalId = await pendingProposal('REJECT_ME');
  await enqueue(pool, {
    jobType: 'story_review',
    idempotencyKey: storyReviewJobKey(proposalId, 1),
    payload: { proposalId },
  });

  await runWorker(createStubReviewer(), async () => {
    const row = await statusOf(proposalId);
    return row.status !== 'pending' ? row : null;
  });

  const row = await statusOf(proposalId);
  expect(row.status).toBe('rejected');
  expect(row.published_at).toBeNull();
  expect(row.reject_reason).toBeTruthy();
});

test('审核器拒绝却不给理由时按调用失败处理，不能写成空理由拒绝', async () => {
  const proposalId = await pendingProposal();
  await enqueue(pool, {
    jobType: 'story_review',
    idempotencyKey: storyReviewJobKey(proposalId, 1),
    payload: { proposalId },
  });
  const inconsistent: StoryReviewer = {
    identity: { provider: 'test', model: 'inconsistent' },
    review: async () => ({ ok: false, reasons: [] }),
  };

  await runWorker(inconsistent, async () => {
    const row = await statusOf(proposalId);
    return row.status !== 'pending' ? row : null;
  });

  const row = await statusOf(proposalId);
  expect(row.status).toBe('review_failed');
  expect(row.reject_reason).toBeNull();
});

test('拒绝理由指明是第几张图出的问题，作者才知道改哪张', async () => {
  const proposalId = await pendingProposal();
  // 只污染第 3 张人物图。
  await pool.query(
    `UPDATE story_images SET caption = 'REJECT_ME'
      WHERE proposal_id = $1 AND kind = 'character' AND position = 2`,
    [proposalId],
  );
  await enqueue(pool, {
    jobType: 'story_review',
    idempotencyKey: storyReviewJobKey(proposalId, 1),
    payload: { proposalId },
  });

  await runWorker(createStubReviewer(), async () => {
    const row = await statusOf(proposalId);
    return row.status !== 'pending' ? row : null;
  });

  const row = await statusOf(proposalId);
  expect(row.status).toBe('rejected');
  expect(row.reject_reason).toContain('character');
  expect(row.reject_reason).toContain('3');
});

test('审核服务不可用、重试耗尽后是 review_failed，不是 rejected', async () => {
  const proposalId = await pendingProposal();
  await enqueue(pool, {
    jobType: 'story_review',
    idempotencyKey: storyReviewJobKey(proposalId, 1),
    payload: { proposalId },
  });

  const broken: StoryReviewer = {
    identity: { provider: 'test', model: 'unreachable' },
    review: () => Promise.reject(new Error('connect ECONNREFUSED')),
  };

  await runWorker(broken, async () => {
    const row = await statusOf(proposalId);
    return row.status !== 'pending' ? row : null;
  });

  const row = await statusOf(proposalId);
  // 服务宕机不是对作者作品的判决。
  expect(row.status).toBe('review_failed');
  expect(row.status).not.toBe('rejected');
  expect(row.reject_reason).toBeNull();
});

test('重新提交后审核又失败：review_failed 不能带着上一次拒绝的痕迹', async () => {
  const proposalId = await pendingProposal();
  // 模拟"已经被拒绝过一次，作者重新打开、编辑、再次提交"之后的状态：这份提案
  // 回到了 pending，但上一次审核留下的 reject_reason / review_output 还在行上
  // ——它们属于上一次的判决，不属于这一次的审核。
  await pool.query(
    `UPDATE story_proposals SET
       reject_reason = '上一次：character image 1: stub reviewer refused the image',
       review_output = '{"approved":false,"reasons":["character image 1: stub reviewer refused the image"]}'::jsonb
     WHERE id = $1`,
    [proposalId],
  );
  await enqueue(pool, {
    jobType: 'story_review',
    idempotencyKey: storyReviewJobKey(proposalId, 2),
    payload: { proposalId },
  });

  const broken: StoryReviewer = {
    identity: { provider: 'test', model: 'unreachable' },
    review: () => Promise.reject(new Error('connect ECONNREFUSED')),
  };

  await runWorker(broken, async () => {
    const row = await statusOf(proposalId);
    return row.status !== 'pending' ? row : null;
  });

  const row = await statusOf(proposalId);
  // 这一次的审核根本没跑起来——它不能替这份提案背上一次的判决。
  expect(row.status).toBe('review_failed');
  expect(row.reject_reason).toBeNull();
  expect(row.review_output).toBeNull();
});

test('图片文件不在盘上也是 review_failed —— 存储故障不是对作品的判决', async () => {
  const proposalId = await pendingProposal();
  // 删掉一张图的文件，行还在。这是存储故障，不是内容问题。
  const missing = await pool.query<{ file_url: string }>(
    `SELECT file_url FROM story_images
      WHERE proposal_id = $1 AND kind = 'character' AND position = 0`,
    [proposalId],
  );
  const path = storyImagePath(mediaDir, missing.rows[0].file_url);
  await rm(path as string);
  await enqueue(pool, {
    jobType: 'story_review',
    idempotencyKey: storyReviewJobKey(proposalId, 1),
    payload: { proposalId },
  });

  await runWorker(createStubReviewer(), async () => {
    const row = await statusOf(proposalId);
    return row.status !== 'pending' ? row : null;
  });

  const row = await statusOf(proposalId);
  expect(row.status).toBe('review_failed');
  expect(row.reject_reason).toBeNull();
});

test('已经审过的提案不会被重复审一遍', async () => {
  const proposalId = await pendingProposal();
  await pool.query(
    `UPDATE story_proposals SET status = 'approved', published_at = now()
      WHERE id = $1`,
    [proposalId],
  );
  await enqueue(pool, {
    jobType: 'story_review',
    idempotencyKey: storyReviewJobKey(proposalId, 1),
    payload: { proposalId },
  });

  let calls = 0;
  const counting: StoryReviewer = {
    identity: { provider: 'test', model: 'counting' },
    review: async () => {
      calls += 1;
      return { ok: true, reasons: [] };
    },
  };

  await runWorker(counting, async () => {
    const job = await pool.query<{ status: string }>(
      `SELECT status FROM workflow_jobs WHERE job_type = 'story_review'`,
    );
    return job.rows[0]?.status === 'succeeded' ? job.rows[0] : null;
  });

  expect(calls).toBe(0);
});

test('§5.3 恢复扫描判 dead 的 story_review 任务同样落到 review_failed —— 这条路径从没跑过 handler', async () => {
  const proposalId = await pendingProposal();
  const { job } = await enqueue(pool, {
    jobType: 'story_review',
    idempotencyKey: storyReviewJobKey(proposalId, 1),
    payload: { proposalId },
  });

  // 伪造"worker 在最后一次尝试上被杀掉"留下的痕迹：行还停在 running，尝试数已经
  // 用满，租约已经过期。没有 claimNext 会再碰它——只有 recover() 的恢复扫描能把
  // 它判死，而恢复扫描传给 markJobDead 的只是 id + jobType + roundId（ledger.ts
  // 的 DeadJob），从未把 payload 读进内存过。
  await pool.query(
    `UPDATE workflow_jobs
        SET status = 'running', attempt_count = $2,
            lease_expires_at = now() - interval '1 minute'
      WHERE id = $1`,
    [job.id, testConfig.JOB_MAX_ATTEMPTS],
  );

  // 用一个"一旦被调用就露馅"的 reviewer：如果 handler 真的跑了一遍，calls 就不
  // 会是 0——证明 review_failed 是恢复扫描直接判出来的，不是靠 handler 兜底。
  let calls = 0;
  const uncalled: StoryReviewer = {
    identity: { provider: 'test', model: 'must-not-be-called' },
    review: async () => {
      calls += 1;
      return { ok: true, reasons: [] };
    },
  };

  await runWorker(uncalled, async () => {
    const row = await statusOf(proposalId);
    return row.status !== 'pending' ? row : null;
  });

  expect(calls).toBe(0);
  const row = await statusOf(proposalId);
  expect(row.status).toBe('review_failed');
  const deadJob = await pool.query<{ status: string }>(
    'SELECT status FROM workflow_jobs WHERE id = $1',
    [job.id],
  );
  expect(deadJob.rows[0].status).toBe('dead');
});
