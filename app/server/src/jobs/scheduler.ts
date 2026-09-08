// The worker process (§5.2 通道 + §5.3 调度与恢复).
//
// Three independent things run here, and none of them is allowed to be the
// business clock:
//   * **channel loops** — one per §5.2 channel, each claiming only its own job
//     types and never running more than that channel's concurrency at once;
//   * **the round clock** — a timer that only decides *when to look*; the
//     decision itself is `closes_at <= now()` inside PostgreSQL (§5.3);
//   * **the recovery scan** — once at startup and periodically after, so a job
//     abandoned by a dead worker comes back (§5.3).
//
// Wake-ups arrive from `startListener` (NOTIFY plus a poll fallback) and may
// overlap; §5.1 warns that the listener does not dedupe, so each channel runner
// collapses re-entrant wakes into one drain.
import type { Pool } from 'pg';

import {
  CodexInvocationError,
  QwenInvocationError,
} from '../ai/codex.js';
import type { ContentEngine } from '../ai/engine.js';
import type { StoryReviewer } from '../ai/story-review.js';
import type { Config } from '../config.js';
import type { H3GatewayClient } from '../h3/gateway.js';
import { nextWakeAt, tick } from '../rounds/clock.js';
import { currentGeneratorMovieId } from '../movies/catalog.js';
import { HANDLERS, type HandlerRegistry } from './handlers/index.js';
import { maintenanceJobKey } from './keys.js';
import {
  JOB_FAILURE_STATUS,
  insertFailedAiRun,
  TERMINAL_ROUND_STATUSES,
  type RoundEngineSettings,
  type WorkerLogger,
} from './handlers/common.js';
import {
  CHANNELS,
  CHANNEL_CONCURRENCY,
  channelJobTypes,
  claimNext,
  complete,
  defer,
  enqueue,
  fail,
  ledgerSettings,
  recover,
  renewLease,
  startListener,
  type Channel,
  type Job,
  type JobType,
  type Listener,
} from './ledger.js';

/** Never spin: the floor between two clock ticks. */
const CLOCK_MIN_INTERVAL_MS = 25;
/** Ceiling between ticks even when nothing is due — a safety net, not the clock. */
const CLOCK_MAX_INTERVAL_MS = 5_000;
const DEFAULT_DEFER_DELAY_MS = 1_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1_000;
/**
 * How long a job may keep deferring before §5.2「达到上限后必须进入明确失败状
 * 态，不得无限循环」applies to it. Half an hour is six production rounds: long
 * enough that a genuinely slow H3 generation (§5「如果 H3 生成速度超过 5 分钟」)
 * never trips it, short enough that a wedged pipeline is a loud failure within
 * one operator coffee break rather than a silent stall.
 */
const DEFAULT_MAX_DEFER_MS = 30 * 60 * 1_000;

export const consoleLogger: WorkerLogger = {
  info: (details, message) => console.log('[crowdmovie]', message, details),
  warn: (details, message) => console.warn('[crowdmovie]', message, details),
  error: (details, message) => console.error('[crowdmovie]', message, details),
};

export const silentLogger: WorkerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface WorkerOptions {
  pool: Pool;
  config: Config;
  engine: ContentEngine;
  /** 故事设定送审用的接缝；生产不配置时失败关闭。 */
  reviewer?: StoryReviewer;
  h3?: H3GatewayClient;
  /** Defaults to the full §5 pipeline; tests substitute a smaller registry. */
  handlers?: HandlerRegistry;
  log?: WorkerLogger;
  /** How long a deferred job waits before the worker looks at it again. */
  deferDelayMs?: number;
  /**
   * How long a job may go on deferring before it is written off as stuck.
   * Defaults to DEFAULT_MAX_DEFER_MS; tests shorten it to seconds.
   */
  maxDeferMs?: number;
  /** Overrides `config.FINAL_TOP_K` (§6.4). */
  topK?: number;
  /** Overrides `config.MEDIA_DIR`; tests point it at a temporary directory. */
  mediaDir?: string;
  /** Recovery scan interval; defaults to one lease period (§5.3). */
  recoverIntervalMs?: number;
  /** Hourly by default; only active when a maintenance handler is registered. */
  maintenanceIntervalMs?: number;
  /**
   * How long `stop()` waits for in-flight handlers. 0 abandons them where they
   * stand — what a stop timeout (or `kill -9`) does in production, and what the
   * crash-recovery tests need in order to leave a `running` job behind.
   */
  shutdownTimeoutMs?: number;
}

export interface Worker {
  stop(): Promise<void>;
}

function startLeaseHeartbeat(
  pool: Pool,
  job: Job,
  leaseMs: number,
  log: WorkerLogger,
): () => Promise<void> {
  const intervalMs = Math.max(25, Math.floor(leaseMs / 3));
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight = Promise.resolve();

  const schedule = (): void => {
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  const tick = (): void => {
    timer = null;
    inFlight = renewLease(pool, job.id, leaseMs)
      .then((renewed) => {
        if (renewed === null) {
          stopped = true;
          log.warn({ jobId: job.id }, 'lease lost during handler execution');
        }
      })
      .catch((error: unknown) => {
        log.error(
          { jobId: job.id, err: (error as Error).message },
          'job lease renewal failed',
        );
      })
      .finally(schedule);
  };
  schedule();

  return async () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    await inFlight;
  };
}

/**
 * One §5.2 channel. Claims are serialised through a single drain loop so a
 * duplicated wake cannot run the concurrency check twice in parallel and let
 * `active` exceed the limit.
 *
 * Exported for the test that proves that guard: driving the class directly is
 * the only way to hold every claim on a barrier and release genuinely
 * simultaneous wakes, and a wake race that has to be *timed* is a wake race that
 * passes by luck.
 */
export class ChannelRunner {
  private active = 0;
  private draining = false;
  private woken = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly channel: Channel,
    private readonly jobTypes: readonly JobType[],
    private readonly concurrency: number,
    private readonly runJob: (job: Job) => Promise<void>,
    private readonly claim: (jobTypes: readonly JobType[]) => Promise<Job | null>,
    private readonly isStopped: () => boolean,
    private readonly log: WorkerLogger,
  ) {}

  async wake(): Promise<void> {
    if (this.draining) {
      // A notification arrived mid-drain; finish the current pass and go round
      // again rather than starting a second claim loop.
      this.woken = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.woken = false;
        while (this.active < this.concurrency && !this.isStopped()) {
          const job = await this.claim(this.jobTypes);
          if (job === null) break;
          this.start(job);
        }
      } while (this.woken && !this.isStopped());
    } catch (error) {
      this.log.error(
        { channel: this.channel, err: (error as Error).message },
        'channel drain failed',
      );
    } finally {
      this.draining = false;
    }
  }

  private start(job: Job): void {
    this.active += 1;
    const running = this.runJob(job)
      // runJob handles handler errors itself; this catches a failure to write
      // the *result* back (a dropped connection during complete()/fail()).
      // Without it that rejection is unhandled and takes the process down —
      // losing every other channel over one transient database blip.
      .catch((error: unknown) => {
        this.log.error(
          { jobId: job.id, err: (error as Error).message },
          'job bookkeeping failed',
        );
      })
      .finally(() => {
        this.active -= 1;
        this.inFlight.delete(running);
        // A finished job frees a slot; look again without waiting for a poll.
        if (!this.isStopped()) void this.wake();
      });
    this.inFlight.add(running);
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }
}

export function startWorker(options: WorkerOptions): Worker {
  const { pool, config, engine } = options;
  const reviewer = options.reviewer;
  const log = options.log ?? consoleLogger;
  const handlers = options.handlers ?? HANDLERS;
  const ledger = ledgerSettings(config);
  const settings: RoundEngineSettings = {
    topK: options.topK ?? config.FINAL_TOP_K,
    voteAdoptThreshold: config.VOTE_ADOPT_THRESHOLD,
    roundLengthMs: config.ROUND_LENGTH_MS,
    deferDelayMs: options.deferDelayMs ?? DEFAULT_DEFER_DELAY_MS,
    mediaDir: options.mediaDir ?? config.MEDIA_DIR,
    h3PollIntervalMs: config.H3_POLL_INTERVAL_MS,
    h3WorkflowRepairRetries: config.H3_WORKFLOW_REPAIR_RETRIES,
  };
  const shutdownTimeoutMs =
    options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const maxDeferMs = options.maxDeferMs ?? DEFAULT_MAX_DEFER_MS;

  let stopped = false;
  let clockTimer: NodeJS.Timeout | null = null;
  let recoverTimer: NodeJS.Timeout | null = null;
  let maintenanceTimer: NodeJS.Timeout | null = null;
  let listener: Listener | null = null;
  const isStopped = (): boolean => stopped;

  /**
   * §5「生成失败时不得提前推进剧情」. A job that has spent its retry budget leaves
   * its round in the matching failure state — the story does not advance, the
   * round produces no scene, and the *next* round's finalize is unblocked
   * because a failed round is terminal.
   *
   * Every path that can end a job for good comes through here: a handler that
   * threw its last attempt, a job the recovery scan wrote off, and a job that
   * deferred past its bound. A round left behind by any of them is a round the
   * pipeline waits on for ever.
   */
  const markRoundFailed = async (
    job: Pick<Job, 'jobType' | 'roundId'>,
  ): Promise<void> => {
    const status = JOB_FAILURE_STATUS[job.jobType];
    if (status === undefined || job.roundId === null) return;
    await pool.query(
      `UPDATE rounds SET status = $2, updated_at = now()
        WHERE id = $1 AND status <> ALL($3::text[])`,
      [job.roundId, status, [...TERMINAL_ROUND_STATUSES]],
    );
    log.error({ roundId: job.roundId, status, jobType: job.jobType }, 'round failed');
  };

  /**
   * A `story_review` job that has spent its retry budget leaves its proposal in
   * `review_failed`, not `rejected`.
   *
   * This distinction is the whole point: `rejected` is a verdict on what the
   * author wrote, and a reviewer that was unreachable has not made one. Telling
   * a writer their story was refused because our endpoint was down is a lie the
   * author cannot argue with — `review_failed` says "try again" instead.
   *
   * The proposal id is read out of the job's own payload rather than passed in,
   * because the recovery scan reports a dead job as id + type + round and never
   * carries a payload.
   */
  const markProposalReviewFailed = async (
    job: Pick<Job, 'id' | 'jobType'>,
  ): Promise<void> => {
    if (job.jobType !== 'story_review') return;
    await pool.query(
      `UPDATE story_proposals SET
         status = 'review_failed',
         -- A resubmission can die with an *older* rejection's reject_reason and
         -- review_output still sitting on the row: those belong to whichever
         -- attempt actually produced a verdict, not to this one, which never
         -- reached a verdict at all. Clearing them here makes review_failed
         -- prove at the source that no judgement was made, instead of leaning
         -- on a display layer to notice the status and hide stale text.
         reject_reason = NULL,
         review_output = NULL,
         updated_at = now()
        WHERE status = 'pending'
          AND id = (
            SELECT (payload_json->>'proposalId')::uuid
              FROM workflow_jobs WHERE id = $1
          )`,
      [job.id],
    );
    log.error({ jobId: job.id }, 'story review failed after its retry budget');
  };

  /** Everything that ends a job for good comes through here. */
  const markJobDead = async (
    job: Pick<Job, 'id' | 'jobType' | 'roundId'>,
  ): Promise<void> => {
    await markRoundFailed(job);
    await markProposalReviewFailed(job);
  };

  const runJob = async (job: Job): Promise<void> => {
    const handler = handlers[job.jobType];
    if (handler === undefined) {
      // Unreachable: only job types with handlers are ever claimed.
      log.error({ jobType: job.jobType }, 'no handler registered');
      await fail(pool, job.id, 'no handler registered', { retryable: false });
      return;
    }

    if (job.movieId !== null) {
      const leaseMovieId = await currentGeneratorMovieId(pool);
      if (leaseMovieId !== job.movieId) {
        await defer(pool, job.id, new Date(Date.now() + settings.deferDelayMs));
        return;
      }
      if (job.roundId !== null) {
        const round = await pool.query<{ movie_id: string }>(
          'SELECT movie_id FROM rounds WHERE id = $1',
          [job.roundId],
        );
        if (round.rows[0]?.movie_id !== job.movieId) {
          const failed = await fail(
            pool,
            job.id,
            'job movie_id does not match its round movie_id',
            { retryable: false },
          );
          if (failed?.status === 'dead') await markJobDead(job);
          return;
        }
      }
    }

    const stopLeaseHeartbeat = startLeaseHeartbeat(
      pool,
      job,
      ledger.leaseMs,
      log,
    );
    try {
      const outcome = await handler({
        pool,
        engine,
        reviewer,
        h3: options.h3,
        job,
        settings,
        log,
      });
      if (outcome.kind === 'defer') {
        // §5.2「达到上限后必须进入明确失败状态，不得无限循环」.
        //
        // defer() refunds the claim's attempt on purpose — a round waiting for
        // an earlier one must not burn its retry budget (see ledger.defer) — but
        // that also means `attempt_count` can never reach the cap on this path,
        // so wall-clock time is the only bound a deferral can have. `created_at`
        // is immutable and is set when the job became due, which for a
        // `round_finalize` is the moment its round closed: `now - created_at` is
        // exactly how long this round has been unable to move. Past the bound
        // the round fails loudly rather than waiting for an upstream round that
        // is never coming back.
        const waitedMs = Date.now() - job.createdAt.getTime();
        if (waitedMs > maxDeferMs) {
          const message = `deferred for ${waitedMs}ms without progressing: ${outcome.reason}`;
          const stuck = await fail(pool, job.id, message, { retryable: false });
          log.error(
            { jobId: job.id, jobType: job.jobType, waitedMs },
            'job deferred past its bound',
          );
          if (stuck?.status === 'dead') await markJobDead(job);
          return;
        }
        const delayMs = outcome.delayMs ?? settings.deferDelayMs;
        const ok = await defer(pool, job.id, new Date(Date.now() + delayMs));
        if (!ok) log.warn({ jobId: job.id }, 'lease lost before defer');
        return;
      }
      const ok = await complete(pool, job.id);
      // §5.1: a lost lease means someone else owns the job now, so this
      // worker's result may be redone. Never reported as success.
      if (!ok) log.warn({ jobId: job.id }, 'lease lost before completion');
    } catch (error) {
      const message = (error as Error).message || String(error);
      // §5.2: even business errors (schema mismatch, media checks) get a
      // bounded retry; the attempt cap is what turns them into a hard failure.
      const failed = await fail(pool, job.id, message, {
        retryable: true,
        maxAttempts: ledger.maxAttempts,
        backoffBaseMs: ledger.backoffBaseMs,
      });
      if (
        (error instanceof CodexInvocationError ||
          error instanceof QwenInvocationError) &&
        job.roundId !== null
      ) {
        const payload = job.payload as Record<string, unknown> | null;
        try {
          await insertFailedAiRun(pool, engine, {
            roundId: job.roundId,
            submissionId:
              typeof payload?.submissionId === 'string'
                ? payload.submissionId
                : null,
            runType: error.runType,
            input: error.input,
            provider:
              error instanceof QwenInvocationError
                ? error.provider
                : 'openai_codex',
            model: error.model,
            reasoningEffort: error.reasoningEffort,
            threadId: error.threadId,
            usage: error.usage,
            latencyMs: error.latencyMs,
            status: failed?.status === 'dead' ? 'dead' : 'retryable_failed',
            errorCode: error.code,
            errorSummary: message,
          });
        } catch (auditError) {
          log.error(
            { jobId: job.id, err: (auditError as Error).message },
            'failed to persist Codex failure audit',
          );
        }
      }
      log.error(
        { jobId: job.id, jobType: job.jobType, err: message },
        'job attempt failed',
      );
      if (failed?.status === 'dead') await markJobDead(job);
    } finally {
      await stopLeaseHeartbeat();
    }
  };

  const runners: ChannelRunner[] = [];
  for (const channel of CHANNELS) {
    const jobTypes = channelJobTypes(channel).filter(
      (jobType) => handlers[jobType] !== undefined,
    );
    if (jobTypes.length === 0) continue;
    const globalChannel = channel === 'story' || channel === 'maintenance';
    runners.push(
      new ChannelRunner(
        channel,
        jobTypes,
        CHANNEL_CONCURRENCY[channel],
        runJob,
        async (types) => {
          if (globalChannel) {
            return claimNext(pool, types, { leaseMs: ledger.leaseMs });
          }
          const movieId = await currentGeneratorMovieId(pool);
          if (movieId === null) return null;
          return claimNext(pool, types, {
            leaseMs: ledger.leaseMs,
            movieId,
            restrictToMovie: true,
          });
        },
        isStopped,
        log,
      ),
    );
  }

  const wakeAll = (): void => {
    if (stopped) return;
    for (const runner of runners) void runner.wake();
  };

  const enqueueMaintenance = async (): Promise<void> => {
    if (stopped || handlers.maintenance === undefined) return;
    try {
      const queued = await enqueue(pool, {
        jobType: 'maintenance',
        idempotencyKey: maintenanceJobKey(new Date()),
      });
      if (queued.created) {
        log.info({ jobId: queued.job.id }, 'hourly maintenance queued');
      }
      // Direct wake is the recovery path when this process enqueues before its
      // LISTEN connection has completed or PostgreSQL notification is lost.
      wakeAll();
    } catch (error) {
      log.error({ err: (error as Error).message }, 'maintenance enqueue failed');
    }
  };

  // --- 时钟 (§5.3) -----------------------------------------------------------

  const scheduleTick = async (): Promise<void> => {
    if (stopped) return;
    let delay = CLOCK_MAX_INTERVAL_MS;
    try {
      const at = await nextWakeAt(pool);
      if (at !== null) delay = Math.min(delay, at.getTime() - Date.now());
    } catch (error) {
      log.error({ err: (error as Error).message }, 'clock lookahead failed');
    }
    if (stopped) return;
    clockTimer = setTimeout(
      () => void clockTick(),
      Math.max(delay, CLOCK_MIN_INTERVAL_MS),
    );
  };

  const clockTick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await tick(pool, config.ROUND_LENGTH_MS);
      if (result.closedRoundIds.length > 0) {
        log.info({ roundIds: result.closedRoundIds }, 'rounds closed');
        // The enqueue's NOTIFY normally does this; waking directly means the
        // finalize starts even if the notification is lost.
        wakeAll();
      }
    } catch (error) {
      log.error({ err: (error as Error).message }, 'clock tick failed');
    }
    await scheduleTick();
  };

  // --- 恢复扫描 (§5.3) -------------------------------------------------------

  const recoveryScan = async (): Promise<void> => {
    try {
      const result = await recover(pool, { maxAttempts: ledger.maxAttempts });
      // A job the scan writes off is as dead as one that failed in runJob, and
      // §5 does not have a second rule for it: its round has to reach the same
      // failure state here. Skipping this is what strands a round mid-pipeline —
      // and because a non-terminal round blocks every later round's finalize
      // (§5「上一段正式发布后，下一段才能进入最终选择和拍摄流程」), the whole
      // movie stops advancing rather than losing one scene.
      for (const dead of result.dead) await markJobDead(dead);
      if (result.requeued > 0 || result.dead.length > 0) {
        log.info(
          { requeued: result.requeued, dead: result.dead.length },
          'recovery scan requeued abandoned jobs',
        );
        wakeAll();
      }
    } catch (error) {
      log.error({ err: (error as Error).message }, 'recovery scan failed');
    }
  };

  // §5.3「Worker 启动时立即执行一次恢复扫描」, before anything else is claimed.
  const started = (async () => {
    await recoveryScan();
    if (stopped) return;
    recoverTimer = setInterval(
      () => void recoveryScan(),
      options.recoverIntervalMs ?? ledger.leaseMs,
    );
    listener = startListener({
      connectionString: config.DATABASE_URL,
      channels: CHANNELS,
      onWake: () => wakeAll(),
      pollIntervalMs: ledger.pollIntervalMs,
      applicationName: 'crowdmovie-worker',
      onError: (error) => log.error({ err: error.message }, 'listener error'),
    });
    if (handlers.maintenance !== undefined) {
      await enqueueMaintenance();
      maintenanceTimer = setInterval(
        () => void enqueueMaintenance(),
        options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS,
      );
    }
    await clockTick();
  })();
  started.catch((error: unknown) => {
    log.error({ err: (error as Error).message }, 'worker failed to start');
  });

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (clockTimer !== null) clearTimeout(clockTimer);
      if (recoverTimer !== null) clearInterval(recoverTimer);
      if (maintenanceTimer !== null) clearInterval(maintenanceTimer);
      await started.catch(() => undefined);
      await listener?.stop();
      if (shutdownTimeoutMs <= 0) return;
      // Graceful within a deadline: past it the handlers are abandoned exactly
      // as a `kill -9` would, and the recovery scan (§5.3) picks their jobs up.
      let deadline: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(runners.map((runner) => runner.drain())),
        new Promise((resolve) => {
          deadline = setTimeout(resolve, shutdownTimeoutMs);
        }),
      ]);
      if (deadline !== undefined) clearTimeout(deadline);
    },
  };
}
