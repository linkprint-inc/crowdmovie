// 投稿轮次业务时钟 (§5.3). PostgreSQL is the clock: an armed round closes because
// `closes_at <= now()` is true in the database, never because a `setTimeout`
// fired. The worker's in-process timer only decides *when to look* — see
// `nextWakeAt()` and `jobs/scheduler.ts` — so a worker that was asleep, paused
// or restarted reaches exactly the same conclusion as one that was running the
// whole time.
//
// Every empty round begins without a deadline unless its movie has an explicit
// automatic-scene limit. For that movie, post-bootstrap successors receive the
// same server countdown as human-started rounds; an empty expiry becomes one
// visible AI Director submission. The limit counts published and already
// reserved scenes, so human submissions consume the same finite runway.
//
// One tick does three things, in one transaction:
//   1. close every non-empty `open` round whose deadline has passed → `selecting`,
//      freezing that round's 镜头 vote counts in the same transaction (§5 step 2),
//      and enqueue its `round_finalize` job;
//   2. make sure an `open` episode exists;
//   3. make sure an `open`, unarmed round exists.
//
// Two workers must not both create round N+1, and `rounds.round_index` is
// UNIQUE, so the whole tick runs under one advisory lock rather than letting the
// loser take a 23505 on the hot path.
import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../db/tx.js';
import { episodeBootstrapJobKey, roundJobKey } from '../jobs/keys.js';
import { enqueue } from '../jobs/ledger.js';
import { emitEvent } from '../lib/events.js';
import { readAutomaticSceneLimit } from '../lib/site-settings.js';
import {
  reconcileGeneratorLease,
  resolveScheduledProgram,
} from '../movies/catalog.js';

/**
 * Advisory-lock key for the tick. Arbitrary but fixed; it only has to be
 * distinct from the scene-index key in `handlers/publish.ts`.
 */
export const CLOCK_LOCK_KEY = 0x63_6d_63_6c; // "cmcl"
export const DEFAULT_ROUND_LENGTH_MS = 5 * 60 * 1_000;

/**
 * The very first episode has no canon to derive a theme from and no proposal
 * pool to elect one out of. T3.3 owns episode rotation (§5.4) and M4 owns the
 * real `proposeEpisodeTheme` run; until then the bootstrap episode carries this
 * placeholder so `episodes.title/theme NOT NULL` is honoured without inventing
 * story canon here.
 */
export const BOOTSTRAP_EPISODE_TITLE = '第一集';
export const BOOTSTRAP_EPISODE_THEME =
  '开场设定待定：首集主题由 §5.4 的提案或 episode_theme 任务确定。';

export interface EpisodeRow {
  id: string;
  movie_id: string;
  episode_index: number;
  title: string;
  theme: string;
}

export interface TickResult {
  /** Rounds moved `open` → `selecting` by this tick. */
  closedRoundIds: string[];
  /** The round that is now open, whether this tick created it or not. */
  openRoundId: string | null;
  /** False when another worker held the clock lock; nothing was inspected. */
  ran: boolean;
}

export interface OpenRoundResult {
  id: string;
  roundIndex: number;
  created: boolean;
}

/**
 * True only while this movie has an explicit unattended-generation policy and
 * at least one unreserved scene slot. A non-terminal closed round reserves a
 * slot because it may already be scoring, directing or rendering; counting it
 * prevents overlapping jobs from carrying AI generation past the cap.
 */
export async function hasAutomaticSceneCapacity(
  client: PoolClient,
  movieId: string,
): Promise<boolean> {
  const limit = await readAutomaticSceneLimit(client, movieId);
  if (limit === null) return false;
  const result = await client.query<{ occupied: string }>(
    `SELECT
       (SELECT count(*) FROM scenes WHERE movie_id = $1) +
       (SELECT count(*) FROM rounds
         WHERE movie_id = $1
           AND status IN ('selecting', 'selected', 'generating', 'validating'))
       AS occupied`,
    [movieId],
  );
  return Number(result.rows[0]?.occupied ?? 0) < limit;
}

/**
 * Give a scene-less episode exactly one opportunity to write its outline.
 * Eligibility is checked again by the handler after the Sol call, so enqueueing
 * here does not reserve the round or beat a racing user submission.
 */
async function enqueueEpisodeBootstrap(
  client: PoolClient,
  movieId: string,
  roundId: string,
  episodeId: string,
): Promise<void> {
  const eligible = await client.query<{ id: string }>(
    `SELECT r.id FROM rounds r
      WHERE r.id = $1 AND r.movie_id = $2 AND r.episode_id = $3
        AND r.status = 'open' AND r.closes_at IS NULL
        AND NOT EXISTS (
              SELECT 1 FROM submissions s
               WHERE s.round_id = r.id AND s.kind = 'next_shot'
            )
        AND NOT EXISTS (
              SELECT 1 FROM scenes sc
               WHERE sc.movie_id = $2 AND sc.episode_id = $3
            )`,
    [roundId, movieId, episodeId],
  );
  if (eligible.rows[0] === undefined) return;

  await enqueue(client, {
    jobType: 'episode_bootstrap',
    idempotencyKey: episodeBootstrapJobKey(episodeId),
    movieId,
    roundId,
    payload: { episodeId },
  });
}

/**
 * The single `open` episode (§5.4「同一时刻只有一个 status=open 的集」), creating
 * the bootstrap one if the table is empty. Runs inside the caller's transaction.
 */
export async function ensureOpenEpisode(
  client: PoolClient,
  movieId: string,
): Promise<EpisodeRow> {
  const existing = await client.query<EpisodeRow>(
    `SELECT id, movie_id, episode_index, title, theme FROM episodes
      WHERE status = 'open' AND movie_id = $1
      ORDER BY episode_index
      LIMIT 1`,
    [movieId],
  );
  if (existing.rowCount !== null && existing.rowCount > 0) {
    return existing.rows[0];
  }

  const created = await client.query<EpisodeRow>(
    `INSERT INTO episodes
       (movie_id, bible_version_id, episode_index, title, theme, status)
     SELECT $1, b.id,
            (SELECT coalesce(max(episode_index), 0) + 1
               FROM episodes WHERE movie_id = $1),
            $2, $3, 'open'
       FROM movie_bible_versions b
      WHERE b.movie_id = $1 AND b.status = 'active'
     RETURNING id, movie_id, episode_index, title, theme`,
    [movieId, BOOTSTRAP_EPISODE_TITLE, BOOTSTRAP_EPISODE_THEME],
  );
  // §16.4 `episode.opened`（新集横幅）. This is the bootstrap path; subsequent
  // `episode.ended` / `episode.opened` pairs are emitted atomically by the
  // publish handler only after an ending scene passes the media gate (§5.4).
  if (created.rows[0] === undefined) {
    throw new Error(`movie ${movieId} has no active bible version`);
  }
  await emitEvent(client, {
    type: 'episode.opened',
    data: {
      movieId,
      episodeId: created.rows[0].id,
      episodeIndex: created.rows[0].episode_index,
      title: created.rows[0].title,
    },
  });
  return created.rows[0];
}

/**
 * Make sure there is one open round and return it. Callers must hold
 * `CLOCK_LOCK_KEY`: both the periodic clock and the +10 crowd winner path use
 * this helper, so closing one round and opening its successor is one serial,
 * atomic operation rather than two competing INSERTs.
 */
export async function ensureOpenRound(
  client: PoolClient,
  options: { movieId: string; countdownMs?: number },
): Promise<OpenRoundResult> {
  const existing = await client.query<{
    id: string;
    movie_id: string;
    round_index: string;
    episode_id: string;
    episode_index: number;
    opens_at: Date;
    closes_at: Date | null;
  }>(
    `SELECT r.id, r.movie_id, r.round_index, r.episode_id, r.opens_at, r.closes_at,
            e.episode_index
       FROM rounds r JOIN episodes e ON e.id = r.episode_id
      WHERE r.status = 'open' ORDER BY r.round_index LIMIT 1`,
  );
  if (existing.rows[0] !== undefined) {
    const current = existing.rows[0];
    if (current.movie_id !== options.movieId) {
      throw new Error(
        `open round ${current.id} belongs to ${current.movie_id}, not ${options.movieId}`,
      );
    }
    if (options.countdownMs !== undefined && current.closes_at === null) {
      const armed = await client.query<{ closes_at: Date }>(
        `UPDATE rounds
            SET closes_at = now()
                            + make_interval(secs => $2::double precision / 1000),
                updated_at = now()
          WHERE id = $1 AND status = 'open' AND closes_at IS NULL
          RETURNING closes_at`,
        [current.id, options.countdownMs],
      );
      if (armed.rows[0] !== undefined) {
        await emitEvent(client, {
          type: 'round.opened',
          data: {
            roundId: current.id,
            movieId: options.movieId,
            roundIndex: Number(current.round_index),
            opensAt: current.opens_at.toISOString(),
            closesAt: armed.rows[0].closes_at.toISOString(),
            episodeIndex: current.episode_index,
          },
        });
      }
    }
    await enqueueEpisodeBootstrap(
      client,
      options.movieId,
      current.id,
      current.episode_id,
    );
    return {
      id: current.id,
      roundIndex: Number(current.round_index),
      created: false,
    };
  }

  const episode = await ensureOpenEpisode(client, options.movieId);
  // `opens_at` is when submissions begin being accepted. Bootstrap omits the
  // countdown; automatic successors and human submissions use the validated
  // worker setting for the same server-owned window.
  const opened = await client.query<{
    id: string;
    round_index: string;
    opens_at: Date;
    closes_at: Date | null;
  }>(
    `INSERT INTO rounds
       (movie_id, round_index, episode_id, status, opens_at, closes_at)
     VALUES ($1,
             (SELECT coalesce(max(round_index), 0) + 1
                FROM rounds WHERE movie_id = $1),
             $2, 'open', now(),
             CASE WHEN $3::double precision IS NULL THEN NULL
                  ELSE now() + make_interval(secs => $3::double precision / 1000)
             END)
     RETURNING id, round_index, opens_at, closes_at`,
    [options.movieId, episode.id, options.countdownMs ?? null],
  );

  await emitEvent(client, {
    type: 'round.opened',
    data: {
      roundId: opened.rows[0].id,
      movieId: options.movieId,
      roundIndex: Number(opened.rows[0].round_index),
      opensAt: opened.rows[0].opens_at.toISOString(),
      closesAt: opened.rows[0].closes_at?.toISOString() ?? null,
      episodeIndex: episode.episode_index,
    },
  });
  await enqueueEpisodeBootstrap(
    client,
    options.movieId,
    opened.rows[0].id,
    episode.id,
  );

  return {
    id: opened.rows[0].id,
    roundIndex: Number(opened.rows[0].round_index),
    created: true,
  };
}

/**
 * Advance the business clock once. Safe to call as often as you like: every
 * decision is a conditional statement against the database, so a duplicate tick
 * changes nothing.
 */
export async function tick(
  pool: Pool,
  roundLengthMs = DEFAULT_ROUND_LENGTH_MS,
): Promise<TickResult> {
  return withTransaction(pool, async (client) => {
    const locked = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1) AS locked',
      [CLOCK_LOCK_KEY],
    );
    if (!locked.rows[0].locked) {
      return { closedRoundIds: [], openRoundId: null, ran: false };
    }

    // Resolve the backend program against PostgreSQL's clock. A movie remains
    // viewable outside its window, but only this scheduled, production-ready
    // movie may own an open writing round or start new content work.
    const scheduled = await resolveScheduledProgram(client);
    const scheduledMovieId = scheduled?.scheduledMovie.id ?? null;
    // `switching` still names the next eligible movie; the lease reconciliation
    // below decides when it may actually open. Only a rights/production block
    // removes the scheduled movie from the writable set.
    const activeMovieId =
      scheduled !== null && scheduled.state !== 'blocked'
        ? scheduledMovieId
        : null;

    const automaticCapacity =
      activeMovieId === null
        ? false
        : await hasAutomaticSceneCapacity(client, activeMovieId);

    // If an operator lowers or disables the cap while an empty successor is
    // armed, cancel only that automatic deadline. Human-started rounds keep
    // their submissions and deadline and continue through the normal path.
    if (!automaticCapacity) {
      await client.query(
        `UPDATE rounds
            SET closes_at = NULL, updated_at = now()
          WHERE status = 'open' AND movie_id = $1::uuid
            AND closes_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM submissions s
                             WHERE s.round_id = rounds.id AND s.kind = 'next_shot')`,
        [activeMovieId],
      );
    }

    // An empty round from the prior slot has no audience contribution to save.
    // End it terminally so it cannot synthesize an AI pitch after its movie has
    // gone off-air and unnecessarily retain the sole GPU lease.
    const switchedEmpty = await client.query<{
      id: string;
      movie_id: string;
      round_index: string;
    }>(
      `UPDATE rounds
          SET status = 'select_failed', closes_at = coalesce(closes_at, now()),
              updated_at = now()
        WHERE status = 'open'
          AND movie_id IS DISTINCT FROM $1::uuid
          AND NOT EXISTS (SELECT 1 FROM submissions s
                           WHERE s.round_id = rounds.id AND s.kind = 'next_shot')
        RETURNING id, movie_id, round_index`,
      [activeMovieId],
    );
    for (const row of switchedEmpty.rows) {
      await emitEvent(client, {
        type: 'round.closed',
        data: {
          movieId: row.movie_id,
          roundId: row.id,
          roundIndex: Number(row.round_index),
          selectionMode: 'schedule_switch',
        },
      });
    }

    // An enabled automatic successor that reaches its deadline without a human
    // pitch reserves one scene slot and queues the ordinary AI submission path.
    const emptyClosed = automaticCapacity
      ? await client.query<{
          id: string;
          movie_id: string;
          round_index: string;
        }>(
          `UPDATE rounds
              SET status = 'selecting', selection_mode = 'auto',
                  selected_submission_id = NULL, updated_at = now()
            WHERE status = 'open' AND movie_id = $1
              AND closes_at <= now()
              AND NOT EXISTS (SELECT 1 FROM submissions s
                               WHERE s.round_id = rounds.id AND s.kind = 'next_shot')
            RETURNING id, movie_id, round_index`,
          [activeMovieId],
        )
      : { rows: [] };
    for (const row of emptyClosed.rows) {
      await enqueue(client, {
        jobType: 'ai_screenwriter',
        idempotencyKey: roundJobKey('ai_screenwriter', row.id, row.movie_id),
        movieId: row.movie_id,
        roundId: row.id,
      });
      await emitEvent(client, {
        type: 'round.closed',
        data: {
          movieId: row.movie_id,
          roundId: row.id,
          roundIndex: Number(row.round_index),
          selectionMode: 'auto',
        },
      });
    }

    const closed = await client.query<{
      id: string;
      movie_id: string;
      round_index: string;
    }>(
      `UPDATE rounds SET status = 'selecting', updated_at = now()
        WHERE status = 'open'
          AND EXISTS (SELECT 1 FROM submissions s
                       WHERE s.round_id = rounds.id AND s.kind = 'next_shot')
          AND (closes_at <= now() OR movie_id IS DISTINCT FROM $1::uuid)
        RETURNING id, movie_id, round_index`,
      [activeMovieId],
    );

    for (const row of closed.rows) {
      // §5 step 2「截止投稿并锁定候选集合，同时冻结本轮镜头投稿计票」. Frozen in
      // the same transaction that closes the round, so a vote racing the
      // deadline either lands before the freeze or is rejected by it — the
      // vote route takes the same row lock (see routes/submissions.ts).
      await client.query(
        `UPDATE submissions SET votes_frozen_at = now()
          WHERE round_id = $1 AND kind = 'next_shot' AND votes_frozen_at IS NULL`,
        [row.id],
      );
      // §5.1 step 1: the job row and the state change commit together.
      await enqueue(client, {
        jobType: 'round_finalize',
        idempotencyKey: roundJobKey('round_finalize', row.id, row.movie_id),
        movieId: row.movie_id,
        roundId: row.id,
      });
      // §16.4 `round.closed`（轮次推进与倒计时校准）.
      await emitEvent(client, {
        type: 'round.closed',
        data: {
          movieId: row.movie_id,
          roundId: row.id,
          roundIndex: Number(row.round_index),
        },
      });
    }

    const closedRoundIds = [
      ...switchedEmpty.rows,
      ...emptyClosed.rows,
      ...closed.rows,
    ].map((row) => row.id);
    const lease = await reconcileGeneratorLease(client);
    if (
      scheduled === null ||
      lease.state !== 'active' ||
      lease.movieId === null ||
      lease.movieId !== activeMovieId
    ) {
      return { closedRoundIds, openRoundId: null, ran: true };
    }

    const awaitingAi = await client.query<{ awaiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM rounds r
          WHERE r.movie_id = $1 AND r.status = 'selecting'
            AND r.selection_mode = 'auto'
            AND r.selected_submission_id IS NULL
            AND NOT EXISTS (
                  SELECT 1 FROM submissions s
                   WHERE s.round_id = r.id AND s.kind = 'next_shot'
                )
       ) AS awaiting`,
      [lease.movieId],
    );
    if (emptyClosed.rows.length > 0 || awaitingAi.rows[0].awaiting) {
      return { closedRoundIds, openRoundId: null, ran: true };
    }

    // Reserve the next automatic window only while the cap still has room.
    // Otherwise keep one unarmed round so humans can continue contributing.
    const capacityAfterClose = await hasAutomaticSceneCapacity(
      client,
      lease.movieId,
    );
    const hasPriorActivity = await client.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM rounds
          WHERE movie_id = $1 AND status <> 'open'
       ) AS present`,
      [lease.movieId],
    );
    const opened = await ensureOpenRound(client, {
      movieId: lease.movieId,
      ...(capacityAfterClose && hasPriorActivity.rows[0].present
        ? { countdownMs: roundLengthMs }
        : {}),
    });

    return {
      closedRoundIds,
      openRoundId: opened?.id ?? null,
      ran: true,
    };
  });
}

/**
 * When the clock next has something to do: the open round's deadline, or null
 * when nothing is open / the initial bootstrap round has no deadline. §5.3「进程内定时器只负责在接近截止时间时
 * 唤醒检查」— the timer derived from this is a wake-up, and the tick it wakes
 * re-reads the database before deciding anything.
 */
export async function nextWakeAt(pool: Pool): Promise<Date | null> {
  const result = await pool.query<{ closes_at: Date }>(
    `SELECT closes_at FROM rounds
      WHERE status = 'open' AND closes_at IS NOT NULL
      ORDER BY closes_at LIMIT 1`,
  );
  return result.rowCount === 0 ? null : result.rows[0].closes_at;
}
