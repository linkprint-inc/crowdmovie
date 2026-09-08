// 持久化任务账本 (§5.1). `workflow_jobs` **is** the queue — there is no Redis,
// no broker and no second copy of queue state anywhere (§2 明确不引入). Every
// durable fact about a job lives in one row, and the database constraints are
// the only guard: `NOTIFY` merely saves a worker from waiting for the next poll.
//
// The five-step ordering of §5.1, and where each step lives:
//   1. enqueue()    — a `pending` row written **inside the caller's business
//                     transaction**, with `pg_notify` deferred to that commit.
//   2. claimNext()  — `FOR UPDATE SKIP LOCKED` over jobs whose `available_at`
//                     has arrived; the winner goes `running` with a lease.
//   3. (caller)     — the worker re-checks round state / idempotency before it
//                     does any real work. That belongs to T3.2, not here.
//   4. complete() / fail() — result, error summary and retry budget written back.
//   5. recover()    — lease-expired `running` rows become claimable again;
//                     `pending` and due `retryable_failed` rows are picked up by
//                     the ordinary claimNext() path, which is the rest of what
//                     §5.1 step 5 asks the recovery scanner to do.
//
// Retry backoff is a future `available_at`, never a sleep: a worker holding a
// timer is a worker that loses the retry when the process dies.
//
// Nothing in this file knows what a round, a submission or a director package
// is. Business logic belongs to T3.2/T3.3 — this is the transport.
import type { QueryResult, QueryResultRow } from 'pg';
import pg from 'pg';

import type { Config } from '../config.js';

// --- 类型与通道 -------------------------------------------------------------

/** §16.5 的 `job_type` 全集. */
export const JOB_TYPES = [
  'submission_score',
  'round_finalize',
  'episode_bootstrap',
  'ai_screenwriter',
  'scene_director',
  'video_generate',
  'subtitle_author',
  'media_validate_publish',
  'episode_theme',
  'story_review',
  'maintenance',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'retryable_failed',
  'dead',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * §5.2 的执行通道。The channel name doubles as the `LISTEN/NOTIFY` channel, so
 * this map is also what decides which connection gets woken by an enqueue.
 *
 * `maintenance` (§16.5, hourly housekeeping) has no row in the §5.2 table — it
 * is an operational job type rather than one of the six content channels — so it
 * gets its own channel instead of borrowing one and stealing its concurrency.
 *
 * `story_review` gets its own for the same reason and one more: a story review
 * is thirteen model calls deep, and running it on `scoring` would let a queue
 * of proposals starve the five-minute round of the submission scoring it must
 * finish before it closes.
 */
export const JOB_CHANNEL: Record<JobType, Channel> = {
  submission_score: 'scoring',
  round_finalize: 'round',
  episode_bootstrap: 'director',
  ai_screenwriter: 'director',
  scene_director: 'director',
  episode_theme: 'director',
  video_generate: 'video',
  subtitle_author: 'subtitle',
  media_validate_publish: 'media',
  story_review: 'story',
  maintenance: 'maintenance',
};

export const CHANNELS = [
  'scoring',
  'director',
  'round',
  'video',
  'subtitle',
  'media',
  'story',
  'maintenance',
] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * §5.2 初始并发。`director`、`video`、`subtitle` 必须保持 1 — the database's
 * conditional state updates are the real guarantee, but running a second one is
 * pointless work and doubles the AI spend on a race it is going to lose.
 */
export const CHANNEL_CONCURRENCY: Record<Channel, number> = {
  scoring: 2,
  director: 1,
  round: 1,
  video: 1,
  subtitle: 1,
  media: 1,
  story: 1,
  maintenance: 1,
};

/** The job types a channel's worker should claim, in declaration order. */
export function channelJobTypes(channel: Channel): JobType[] {
  return JOB_TYPES.filter((jobType) => JOB_CHANNEL[jobType] === channel);
}

export interface Job {
  id: string;
  movieId: string | null;
  roundId: string | null;
  jobType: JobType;
  idempotencyKey: string | null;
  status: JobStatus;
  upstreamJobId: string | null;
  payload: unknown;
  attemptCount: number;
  availableAt: Date;
  leaseExpiresAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
}

interface JobRow extends QueryResultRow {
  id: string;
  movie_id: string | null;
  round_id: string | null;
  job_type: JobType;
  idempotency_key: string | null;
  status: JobStatus;
  upstream_job_id: string | null;
  payload_json: unknown;
  attempt_count: number;
  available_at: Date;
  lease_expires_at: Date | null;
  last_error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    movieId: row.movie_id,
    roundId: row.round_id,
    jobType: row.job_type,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    upstreamJobId: row.upstream_job_id,
    payload: row.payload_json,
    attemptCount: row.attempt_count,
    availableAt: row.available_at,
    leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Anything that can run a statement: a `Pool` (each call its own autocommit
 * transaction) or a `PoolClient` mid-`BEGIN`. enqueue() must accept the latter —
 * joining the caller's business transaction is the whole point of §5.1 step 1.
 */
export interface Queryable {
  query<R extends QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

// --- 可调项 -----------------------------------------------------------------

export const DEFAULT_LEASE_MS = 60_000;
export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_BACKOFF_BASE_MS = 1_000;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_RECONNECT_DELAY_MS = 1_000;

/**
 * Ceiling on the exponential backoff. With the default budget the schedule never
 * reaches it; it exists so that raising `JOB_MAX_ATTEMPTS` cannot silently park
 * a job days into the future.
 */
export const BACKOFF_CAP_MS = 60_000;

export interface RetryPolicy {
  /** Attempts allowed in total, counted at claim time. */
  maxAttempts: number;
  /** First retry delay; doubles per attempt, jittered, capped at BACKOFF_CAP_MS. */
  backoffBaseMs: number;
}

export interface LedgerSettings extends RetryPolicy {
  leaseMs: number;
  pollIntervalMs: number;
}

/** The operator-tunable half of the ledger, read out of the validated env. */
export function ledgerSettings(config: Config): LedgerSettings {
  return {
    leaseMs: config.JOB_LEASE_MS,
    pollIntervalMs: config.JOB_POLL_INTERVAL_MS,
    backoffBaseMs: config.JOB_BACKOFF_BASE_MS,
    maxAttempts: config.JOB_MAX_ATTEMPTS,
  };
}

// --- 入队（§5.1 第 1 步） ---------------------------------------------------

export interface EnqueueSpec {
  jobType: JobType;
  /** Required for content jobs; global story review/maintenance jobs leave it null. */
  movieId?: string;
  /**
   * Required, not optional: §5「同一轮选择和生成任务必须具备幂等键」. It is the
   * unique index that stops a retried timer or a re-delivered notification from
   * producing a second scene.
   */
  idempotencyKey: string;
  roundId?: string;
  /** Database IDs, versions and small structured parameters only (§5.1). */
  payload?: unknown;
  /** Defaults to now. A future value delays the first attempt. */
  availableAt?: Date;
}

export interface EnqueueResult {
  job: Job;
  /**
   * False when `idempotencyKey` already existed. The existing row is returned
   * untouched — an enqueue is a request for the job to exist, not a request to
   * restate its payload, and rewriting a running job's payload from a duplicate
   * caller would be a way to corrupt it.
   */
  created: boolean;
}

/**
 * Insert a `pending` job and ask PostgreSQL to notify its channel.
 *
 * Pass the transaction the business state change is running in: the row and the
 * notification then become visible together, or not at all. `pg_notify` inside a
 * transaction is queued and delivered by the server at COMMIT (and discarded on
 * ROLLBACK) — no application-side "send after commit" hook is involved.
 *
 * A duplicate key is not an error: the job already exists, which is exactly what
 * the caller wanted. No notification is sent in that case; if the original one
 * was lost, the poll fallback (§5.3) picks the job up.
 */
export async function enqueue(
  db: Queryable,
  spec: EnqueueSpec,
): Promise<EnqueueResult> {
  const inserted = await db.query<JobRow>(
    `INSERT INTO workflow_jobs
       (movie_id, round_id, job_type, idempotency_key, status, payload_json, available_at)
     VALUES (coalesce($1::uuid, (SELECT movie_id FROM rounds WHERE id = $2)),
             $2, $3, $4, 'pending', $5::jsonb, coalesce($6::timestamptz, now()))
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [
      spec.movieId ?? null,
      spec.roundId ?? null,
      spec.jobType,
      spec.idempotencyKey,
      spec.payload === undefined ? null : JSON.stringify(spec.payload),
      spec.availableAt ?? null,
    ],
  );

  if (inserted.rowCount === 0) {
    const existing = await db.query<JobRow>(
      'SELECT * FROM workflow_jobs WHERE idempotency_key = $1',
      [spec.idempotencyKey],
    );
    return { job: toJob(existing.rows[0]), created: false };
  }

  const job = toJob(inserted.rows[0]);
  await db.query('SELECT pg_notify($1, $2)', [
    JOB_CHANNEL[job.jobType],
    JSON.stringify({ id: job.id, jobType: job.jobType }),
  ]);
  return { job, created: true };
}

// --- 领取（§5.1 第 2 步） ---------------------------------------------------

/**
 * Claim one due job, or return null when the queue is empty for these types.
 *
 * One statement, deliberately: the `FOR UPDATE SKIP LOCKED` scan locks the row
 * and the enclosing UPDATE marks it `running` before the lock is released, so
 * two workers racing on the same job cannot both come back holding it — the
 * loser skips the locked row and takes the next one (or nothing).
 *
 * `AS MATERIALIZED` is load-bearing, not decoration. Written as
 * `WHERE id IN (SELECT ... LIMIT 1 FOR UPDATE SKIP LOCKED)` the locking scan is
 * an ordinary subquery, and the planner is free to put it on the *inner* side of
 * a semi join — where it is re-executed once per outer row. Each re-execution
 * skips the rows already locked and locks a fresh one, so a single claimNext()
 * marked several jobs `running` (attempt spent, lease set) while returning only
 * `rows[0]`. The extra jobs had no worker and only came back via the §5.3
 * recovery scan, one attempt poorer. Which plan the planner picks depends on
 * the table statistics, which is why this surfaced as a rare flake rather than
 * an outright failure. A materialized CTE is evaluated exactly once by
 * definition, so the claim can only ever touch one row.
 *
 * `attempt_count` is incremented here rather than at failure time, because an
 * attempt that ends with the worker's process being killed is still an attempt;
 * counting at claim time is what stops a job that crashes its worker from
 * looping forever through the recovery scanner. For the same reason
 * `started_at` marks the start of the *current* attempt, not of the first one.
 */
export async function claimNext(
  db: Queryable,
  jobTypes: readonly JobType[],
  options: {
    leaseMs?: number;
    movieId?: string | null;
    /** When true, no content job is claimable without this exact movie lease. */
    restrictToMovie?: boolean;
  } = {},
): Promise<Job | null> {
  if (jobTypes.length === 0) return null;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;

  const claimed = await db.query<JobRow>(
    `WITH candidate AS MATERIALIZED (
       SELECT id FROM workflow_jobs
       WHERE job_type = ANY($1::text[])
         AND status IN ('pending', 'retryable_failed')
         AND available_at <= now()
         AND (NOT $4::boolean OR movie_id = $3)
       ORDER BY available_at, created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE workflow_jobs SET
       status = 'running',
       attempt_count = attempt_count + 1,
       started_at = now(),
       lease_expires_at = now() + make_interval(secs => $2::double precision / 1000),
       updated_at = now()
     FROM candidate
     WHERE workflow_jobs.id = candidate.id
     RETURNING workflow_jobs.*`,
    [
      [...jobTypes],
      leaseMs,
      options.movieId ?? null,
      options.restrictToMovie ?? false,
    ],
  );

  return claimed.rowCount === 0 ? null : toJob(claimed.rows[0]);
}

/**
 * Push this job's lease out by `leaseMs` from now. Returns the new expiry, or
 * null if the job is no longer `running` — which means the recovery scanner
 * already took it away and this worker's result will be rejected.
 *
 * H3 video generation runs for minutes; a long job renews rather than holding an
 * hour-long lease, so that a crash is still noticed within one lease period.
 */
export async function renewLease(
  db: Queryable,
  jobId: string,
  leaseMs: number,
): Promise<Date | null> {
  const renewed = await db.query<JobRow>(
    `UPDATE workflow_jobs SET
       lease_expires_at = now() + make_interval(secs => $2::double precision / 1000),
       updated_at = now()
     WHERE id = $1 AND status = 'running'
     RETURNING *`,
    [jobId, leaseMs],
  );
  return renewed.rowCount === 0 ? null : renewed.rows[0].lease_expires_at;
}

// --- 回写结果（§5.1 第 4 步） -----------------------------------------------

/**
 * Mark a claimed job `succeeded`. Returns false when the row was not `running`,
 * i.e. this worker lost its lease and someone else owns the job now — the caller
 * must treat that as "my work may be about to be redone" rather than success.
 */
export async function complete(db: Queryable, jobId: string): Promise<boolean> {
  const done = await db.query<JobRow>(
    `UPDATE workflow_jobs SET
       status = 'succeeded',
       lease_expires_at = NULL,
       finished_at = now(),
       updated_at = now()
     WHERE id = $1 AND status = 'running'
     RETURNING id`,
    [jobId],
  );
  return done.rowCount === 1;
}

export interface FailOptions extends Partial<RetryPolicy> {
  /**
   * True for 429s, timeouts and transient upstream failures; false for errors
   * that will fail identically forever (schema mismatch after its own retries,
   * a payload that no longer matches the round). §5.2 requires that even the
   * retryable ones stop at a limit — 不得无限循环.
   */
  retryable: boolean;
}

/**
 * Record a failed attempt. Retryable and within budget → `retryable_failed`
 * with `available_at` pushed into the future by an exponentially growing,
 * jittered delay. Otherwise → `dead`.
 *
 * The branch is evaluated in SQL against the stored `attempt_count`, so the
 * decision cannot be made on a stale read.
 */
export async function fail(
  db: Queryable,
  jobId: string,
  error: string,
  options: FailOptions,
): Promise<Job | null> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const retrying = '$2::boolean AND attempt_count < $5::int';

  const failed = await db.query<JobRow>(
    `UPDATE workflow_jobs SET
       status = CASE WHEN ${retrying} THEN 'retryable_failed' ELSE 'dead' END,
       available_at = CASE WHEN ${retrying}
         THEN now() + make_interval(secs => least(
                $4::double precision * power(2, greatest(attempt_count - 1, 0)),
                $6::double precision
              ) * (0.5 + random() * 0.5) / 1000)
         ELSE available_at END,
       finished_at = CASE WHEN ${retrying} THEN NULL ELSE now() END,
       lease_expires_at = NULL,
       last_error = $3,
       updated_at = now()
     WHERE id = $1 AND status = 'running'
     RETURNING *`,
    [jobId, options.retryable, error, backoffBaseMs, maxAttempts, BACKOFF_CAP_MS],
  );

  return failed.rowCount === 0 ? null : toJob(failed.rows[0]);
}

/**
 * Put a claimed job back on the queue, due at `availableAt`, **without spending
 * an attempt**.
 *
 * This is not a retry. §5 has two places where a worker legitimately has nothing
 * to do yet and must come back later: a round whose submissions are still being
 * scored (§5.3「评分积压会延长 selecting，但不会改变投稿资格」) and a round
 * waiting for the previous one to finish generating (§5「上一段正式发布后，下一
 * 段才能进入最终选择和拍摄流程」). Neither is an error, and neither may consume
 * the retry budget: a busy pipeline that deferred five times would otherwise
 * push a perfectly healthy round into `dead` and drop submissions that §5.3
 * forbids dropping.
 *
 * So the claim's `attempt_count += 1` is undone here. That is safe precisely
 * because the caller did no work — a handler that has already touched the world
 * must fail() instead. `greatest(…, 0)` keeps the column sane if a job is ever
 * deferred without having been claimed through claimNext().
 *
 * Returns false when the row was not `running` — the lease was lost, and the job
 * now belongs to whoever recovered it.
 */
export async function defer(
  db: Queryable,
  jobId: string,
  availableAt: Date,
): Promise<boolean> {
  const deferred = await db.query<JobRow>(
    `UPDATE workflow_jobs SET
       status = 'pending',
       attempt_count = greatest(attempt_count - 1, 0),
       available_at = $2,
       lease_expires_at = NULL,
       updated_at = now()
     WHERE id = $1 AND status = 'running'
     RETURNING id`,
    [jobId, availableAt],
  );
  return deferred.rowCount === 1;
}

// --- 恢复扫描（§5.1 第 5 步） -----------------------------------------------

/** Identity of a job the scan wrote off, enough for the caller to act on it. */
export interface DeadJob {
  id: string;
  jobType: JobType;
  roundId: string | null;
}

export interface RecoverResult {
  /** Jobs handed back to the queue. */
  requeued: number;
  /**
   * Jobs whose retry budget was already spent when their worker died. Reported
   * individually rather than counted: a job dying here is as final as one dying
   * in `fail()`, and the caller owns what that means for the round behind it
   * (§5「生成失败时不得提前推进剧情」). Which round state that is, is business
   * knowledge this file deliberately does not have.
   */
  dead: DeadJob[];
}

/**
 * Re-arm every job abandoned by a dead worker: `running` rows whose lease has
 * expired go back to `pending` and become claimable immediately. §5.3 has the
 * worker run this once at startup and periodically afterwards.
 *
 * There is no lease argument — recovery does not take the job, it puts it back;
 * whichever worker claims it next writes the new lease.
 *
 * The attempt was already counted when the job was claimed, so a job that kills
 * its worker every time still runs out of budget and lands in `dead` instead of
 * being resurrected forever.
 */
export async function recover(
  db: Queryable,
  options: { maxAttempts?: number } = {},
): Promise<RecoverResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const recovered = await db.query<
    {
      id: string;
      job_type: JobType;
      round_id: string | null;
      status: JobStatus;
    } & QueryResultRow
  >(
    `UPDATE workflow_jobs SET
       status = CASE WHEN attempt_count >= $1::int THEN 'dead' ELSE 'pending' END,
       available_at = now(),
       lease_expires_at = NULL,
       finished_at = CASE WHEN attempt_count >= $1::int THEN now() ELSE finished_at END,
       last_error = 'lease expired: worker did not finish before lease_expires_at',
       updated_at = now()
     WHERE status = 'running' AND lease_expires_at < now()
     RETURNING id, job_type, round_id, status`,
    [maxAttempts],
  );

  let requeued = 0;
  const dead: DeadJob[] = [];
  for (const row of recovered.rows) {
    if (row.status === 'dead') {
      dead.push({ id: row.id, jobType: row.job_type, roundId: row.round_id });
    } else requeued += 1;
  }
  return { requeued, dead };
}

// --- 唤醒：LISTEN + 轮询兜底（§5.3） ----------------------------------------

/**
 * Why a wake happened. `connect` covers both the first connection and every
 * reconnect, and always means "poll everything": notifications sent while the
 * connection was down are gone for good (§5.3「断开重连后必须立即补做一次全量
 * 轮询」).
 */
export type WakeReason = 'connect' | 'notify' | 'poll';

export interface ListenerOptions {
  connectionString: string;
  channels: readonly Channel[];
  /**
   * Called on every wake. It may be async; overlapping calls are possible (a
   * poll can fire while a previous wake is still draining), so the handler has
   * to be safe to re-enter — claimNext() already is.
   */
  onWake: (reason: WakeReason) => void | Promise<void>;
  /** Safety net for lost notifications. */
  pollIntervalMs?: number;
  reconnectDelayMs?: number;
  /** Reported to `pg_stat_activity.application_name`. */
  applicationName?: string;
  /** Connection and handler failures. Without it they are logged to stderr. */
  onError?: (error: Error) => void;
}

export interface Listener {
  stop(): Promise<void>;
}

export const LISTENER_APPLICATION_NAME = 'crowdmovie-ledger-listener';

/**
 * Keep a dedicated connection LISTENing on `channels`, and poll regardless.
 *
 * The poll is not a fallback for bugs — it is the design (§5.3). A notification
 * is a best-effort optimisation: it is lost if it is sent while this connection
 * is down, and it is never retried by the server. So the queue state in
 * PostgreSQL is the only thing the worker may treat as authoritative, and the
 * timer guarantees it is re-read even if no notification ever arrives.
 */
export function startListener(options: ListenerOptions): Listener {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const reconnectDelayMs =
    options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;

  let stopped = false;
  let client: pg.Client | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const report = (error: Error): void => {
    if (options.onError) options.onError(error);
    else console.error('[crowdmovie] ledger listener', error);
  };

  const wake = (reason: WakeReason): void => {
    if (stopped) return;
    try {
      const result = options.onWake(reason);
      if (result instanceof Promise) result.catch(report);
    } catch (error) {
      report(error as Error);
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer !== null) return;
    const dying = client;
    client = null;
    if (dying) dying.end().catch(() => undefined);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
  };

  const connect = (): void => {
    if (stopped) return;
    const next = new pg.Client({
      connectionString: options.connectionString,
      application_name: options.applicationName ?? LISTENER_APPLICATION_NAME,
    });
    client = next;

    // A dropped connection arrives here, not as a rejected query.
    next.on('error', (error: Error) => {
      if (stopped || client !== next) return;
      report(error);
      scheduleReconnect();
    });
    next.on('notification', () => wake('notify'));

    void (async () => {
      try {
        await next.connect();
        for (const channel of options.channels) {
          // Channel names come from the CHANNELS constant, never from data, so
          // quoting them is enough — they are identifiers, not parameters.
          await next.query(`LISTEN "${channel}"`);
        }
      } catch (error) {
        if (stopped || client !== next) return;
        report(error as Error);
        scheduleReconnect();
        return;
      }
      if (stopped || client !== next) return;
      // Everything notified while we were away is unrecoverable, so a fresh
      // connection always starts with a full sweep of the ledger.
      wake('connect');
    })();
  };

  const pollTimer = setInterval(() => wake('poll'), pollIntervalMs);
  connect();

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(pollTimer);
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const dying = client;
      client = null;
      if (dying) await dying.end().catch(() => undefined);
    },
  };
}
