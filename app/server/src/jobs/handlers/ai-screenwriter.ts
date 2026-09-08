// `ai_screenwriter` writes one public next-shot pitch for an empty automatic
// round. It is stored as an ordinary submission under the reserved,
// inaccessible `AI Director` user, then sent through the same scoring,
// selection, directing and publishing pipeline as a human pitch.
import type { Pool } from 'pg';

import { withTransaction } from '../../db/tx.js';
import { emitEvent } from '../../lib/events.js';
import { englishWordCount } from '../../lib/english-words.js';
import { readAutomaticSceneLimit } from '../../lib/site-settings.js';
import { AUTOMATIC_SHOT_MAX_ENGLISH_WORDS } from '../../ai/validate.js';
import {
  AI_DIRECTOR_USERNAME,
  AI_DIRECTOR_USERNAME_KEY,
} from '../../lib/username.js';
import {
  CLOCK_LOCK_KEY,
  ensureOpenRound,
  hasAutomaticSceneCapacity,
} from '../../rounds/clock.js';
import { roundJobKey, scoreJobKey } from '../keys.js';
import { enqueue } from '../ledger.js';
import {
  insertAiRun,
  hasUnfinishedEarlierRound,
  loadEpisode,
  loadEpisodeScenes,
  loadPreviousScene,
  loadRound,
  requireRoundId,
  timed,
  type Handler,
} from './common.js';

export const AI_SHOT_MAX_ENGLISH_WORDS = AUTOMATIC_SHOT_MAX_ENGLISH_WORDS;

interface ExistingSystemUser {
  id: string;
  username_display: string;
  email_key: string | null;
  password_hash: string | null;
  guest_token_hash: string | null;
}

async function reopenDisabledAutomaticRound(
  pool: Pool,
  roundId: string,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [CLOCK_LOCK_KEY]);
    const result = await client.query<{ id: string }>(
      `UPDATE rounds
          SET status = 'open', selection_mode = NULL,
              selected_submission_id = NULL, closes_at = NULL,
              updated_at = now()
        WHERE id = $1 AND status = 'selecting'
          AND selection_mode = 'auto' AND selected_submission_id IS NULL
          AND NOT EXISTS (
                SELECT 1 FROM submissions s
                 WHERE s.round_id = rounds.id AND s.kind = 'next_shot'
              )
        RETURNING id`,
      [roundId],
    );
    return result.rows[0] !== undefined;
  });
}

export const aiScreenwriterHandler: Handler = async ({
  pool,
  engine,
  job,
  log,
  settings,
}) => {
  const roundId = requireRoundId(job);
  const persisted = await pool.query<{ submission_id: string | null }>(
    `SELECT payload_json ->> 'submissionId' AS submission_id
       FROM workflow_jobs WHERE id = $1`,
    [job.id],
  );
  if (typeof persisted.rows[0]?.submission_id === 'string') {
    return { kind: 'done', note: 'AI Director submission already committed' };
  }

  const round = await loadRound(pool, roundId);
  if (round === null) throw new Error(`round ${roundId} is missing`);
  const limit = await readAutomaticSceneLimit(pool, round.movie_id);
  if (limit === null || limit === 0) {
    const reopened = await reopenDisabledAutomaticRound(pool, roundId);
    return {
      kind: 'done',
      note: reopened
        ? 'automatic scene policy disabled; round reopened'
        : 'automatic scene policy disabled; existing work preserved',
    };
  }
  if (
    round.status !== 'selecting' ||
    round.selection_mode !== 'auto' ||
    round.selected_submission_id !== null
  ) {
    return {
      kind: 'done',
      note: `round is not awaiting AI Director (${round.status})`,
    };
  }
  // A successor may reach its automatic deadline while the previous scene is
  // still rendering or validating. Do not ask Qwen to write against an empty
  // published-scene list: defer the content call until that scene is durable,
  // then load the complete ordered history below.
  if (
    await hasUnfinishedEarlierRound(pool, round.movie_id, round.round_index)
  ) {
    return { kind: 'defer', reason: 'an earlier scene is not published yet' };
  }

  const episode = await loadEpisode(pool, round.episode_id);
  const input = {
    roundId,
    episodeIndex: episode.episode_index,
    episodeTitle: episode.title,
    episodeOutline: episode.theme,
    previousScene: await loadPreviousScene(pool, round.movie_id, round.episode_id),
    previousChapter: await loadPreviousScene(pool, round.movie_id, null),
    previousScenes: await loadEpisodeScenes(
      pool,
      round.movie_id,
      round.episode_id,
    ),
  };
  const generated = await timed(() => engine.writeAutomaticShot(input));
  const content = generated.value.content.trim();
  if (content.length === 0) throw new Error('AI Director shot is empty');
  if (englishWordCount(content) > AI_SHOT_MAX_ENGLISH_WORDS) {
    throw new Error(
      `AI Director shot exceeds ${AI_SHOT_MAX_ENGLISH_WORDS} English words`,
    );
  }

  const committed = await withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [CLOCK_LOCK_KEY]);
    const lockedJob = await client.query<{ submission_id: string | null }>(
      `SELECT payload_json ->> 'submissionId' AS submission_id
         FROM workflow_jobs WHERE id = $1 FOR UPDATE`,
      [job.id],
    );
    if (typeof lockedJob.rows[0]?.submission_id === 'string') {
      return {
        submissionId: lockedJob.rows[0].submission_id,
        shotAiRunId: null,
        replay: true,
        disabled: false,
      };
    }

    // A runtime zero/missing limit is an operator stop switch. Already
    // materialized work remains untouched; only this empty claim is reopened.
    const currentLimit = await readAutomaticSceneLimit(client, round.movie_id);
    if (currentLimit === null || currentLimit === 0) {
      const reopened = await client.query<{ id: string }>(
        `UPDATE rounds
            SET status = 'open', selection_mode = NULL, closes_at = NULL,
                updated_at = now()
          WHERE id = $1 AND status = 'selecting'
            AND selection_mode = 'auto' AND selected_submission_id IS NULL
            AND NOT EXISTS (
                  SELECT 1 FROM submissions s
                   WHERE s.round_id = rounds.id AND s.kind = 'next_shot'
                )
          RETURNING id`,
        [roundId],
      );
      return {
        submissionId: null,
        shotAiRunId: null,
        replay: false,
        disabled: reopened.rows[0] !== undefined,
      };
    }

    const claimed = await client.query<{ episode_id: string }>(
      `SELECT episode_id FROM rounds
        WHERE id = $1 AND movie_id = $2 AND status = 'selecting'
          AND selection_mode = 'auto' AND selected_submission_id IS NULL
        FOR UPDATE`,
      [roundId, round.movie_id],
    );
    if (claimed.rows[0] === undefined) {
      return {
        submissionId: null,
        shotAiRunId: null,
        replay: false,
        disabled: false,
      };
    }

    await client.query(
      `INSERT INTO users (username_display, username_key)
       VALUES ($1, $2)
       ON CONFLICT (username_key) DO NOTHING`,
      [AI_DIRECTOR_USERNAME, AI_DIRECTOR_USERNAME_KEY],
    );
    const systemUser = await client.query<ExistingSystemUser>(
      `SELECT id, username_display, email_key, password_hash, guest_token_hash
         FROM users WHERE username_key = $1 FOR UPDATE`,
      [AI_DIRECTOR_USERNAME_KEY],
    );
    const aiUser = systemUser.rows[0];
    if (
      aiUser === undefined ||
      aiUser.username_display !== AI_DIRECTOR_USERNAME ||
      aiUser.email_key !== null ||
      aiUser.password_hash !== null ||
      aiUser.guest_token_hash !== null
    ) {
      throw new Error(
        'reserved AI Director username is occupied by an interactive user',
      );
    }

    const inserted = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO submissions
         (movie_id, kind, round_id, episode_id, user_id, content, status,
          votes_frozen_at)
       VALUES ($1, 'next_shot', $2, $3, $4, $5, 'pending', now())
       RETURNING id, created_at`,
      [round.movie_id, roundId, round.episode_id, aiUser.id, content],
    );
    const submission = inserted.rows[0];

    const shotAiRunId = await insertAiRun(client, engine, {
      roundId,
      submissionId: submission.id,
      runType: 'generation_event',
      input,
      output: generated.value,
      latencyMs: generated.latencyMs,
    });
    await client.query(
      `UPDATE rounds
          SET selected_submission_id = $2, selection_mode = 'auto',
              updated_at = now()
        WHERE id = $1`,
      [roundId, submission.id],
    );

    await enqueue(client, {
      jobType: 'submission_score',
      idempotencyKey: scoreJobKey(submission.id, round.movie_id),
      movieId: round.movie_id,
      roundId,
      payload: { submissionId: submission.id },
    });
    await enqueue(client, {
      jobType: 'round_finalize',
      idempotencyKey: roundJobKey(
        'round_finalize',
        roundId,
        round.movie_id,
      ),
      movieId: round.movie_id,
      roundId,
    });
    await emitEvent(client, {
      type: 'submission.created',
      data: {
        submissionId: submission.id,
        movieId: round.movie_id,
        kind: 'next_shot',
        roundId,
        episodeId: round.episode_id,
        username: AI_DIRECTOR_USERNAME,
        content,
        votesFrozen: true,
        createdAt: submission.created_at.toISOString(),
      },
    });

    // Keep one public successor available while this shot renders. Only arm it
    // when another automatic slot remains; at the cap it stays human-writable.
    const capacity = await hasAutomaticSceneCapacity(client, round.movie_id);
    await ensureOpenRound(client, {
      movieId: round.movie_id,
      ...(capacity ? { countdownMs: settings.roundLengthMs } : {}),
    });
    await client.query(
      `UPDATE workflow_jobs
          SET payload_json = coalesce(payload_json, '{}'::jsonb)
                             || jsonb_build_object(
                                  'submissionId', $2::text,
                                  'shotAiRunId', $3::text
                                ),
              updated_at = now()
        WHERE id = $1`,
      [job.id, submission.id, shotAiRunId],
    );
    return {
      submissionId: submission.id,
      shotAiRunId,
      replay: false,
      disabled: false,
    };
  });

  if (committed.submissionId === null) {
    return {
      kind: 'done',
      note: committed.disabled
        ? 'automatic scene policy disabled; round reopened'
        : 'round was claimed by another path',
    };
  }
  log.info(
    {
      roundId,
      submissionId: committed.submissionId,
      shotAiRunId: committed.shotAiRunId,
    },
    'AI Director submission created and sent to scoring',
  );
  return {
    kind: 'done',
    ...(committed.replay
      ? { note: 'AI Director submission already committed' }
      : {}),
  };
};
