// BEGIN / COMMIT / ROLLBACK in one place. Several §5 rules are stated as "in the
// same transaction" (投稿 + 评分任务, 投票 + 计票缓存, 关闭轮次 + 冻结计票 +
// 入队, 发布 + 写 scenes), and each of those is only true if the client is
// released exactly once on every path — including the one where COMMIT itself
// throws.
import type { Pool, PoolClient } from 'pg';

export async function withTransaction<T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // A failed ROLLBACK means the connection is already broken; the original
    // error is the one worth reporting, so this one is swallowed.
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
