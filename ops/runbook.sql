-- CrowdMovie MVP operator runbook (§16.6)
--
-- Run exactly ONE action per invocation with psql. Always save stdout/stderr to
-- a root-only operator log: every successful block prints the database user,
-- timestamp, action, target and resulting state before COMMIT.
--
-- Example (use the migrate/admin connection; never paste its password here):
--   psql -X -v ON_ERROR_STOP=1 "$MIGRATE_DATABASE_URL" \
--     -v action=scene_takedown -v scene_index=7 \
--     -v reason='copyright request CM-123' \
--     -f ops/runbook.sql 2>&1 | tee -a /var/log/crowdmovie/operator.log
--
-- Supported actions and required variables:
--   scene_takedown       scene_index, reason
--   scene_restore        scene_index
--   danmaku_hide         danmaku_id
--   danmaku_show         danmaku_id
--   danmaku_global_off   (none)
--   danmaku_global_on    (none)
--   user_ban             user_id, reason
--   user_unban           user_id
--   contact_handle       contact_id
--   contact_reject       contact_id
--   threshold_set        threshold (positive integer)
--   threshold_clear      (restores the environment baseline)
--   episode_discard      movie_slug, episode_index, reason
--                        Deletes one episode that never published a scene,
--                        with its rounds, submissions, votes, scores,
--                        translations, AI runs and finished jobs. Refuses an
--                        episode with any scene or any pending/running job.
--                        Take a database backup first.
--
-- ON_ERROR_STOP plus the count guard makes a missing/already-transitioned
-- target abort before COMMIT. Do not remove either guard.

\set ON_ERROR_STOP on

\if :{?action}
\else
  \echo 'ERROR: pass exactly one -v action=<supported action>'
  \quit 2
\endif

SELECT
  :'action' = 'scene_takedown' AS do_scene_takedown,
  :'action' = 'scene_restore' AS do_scene_restore,
  :'action' = 'danmaku_hide' AS do_danmaku_hide,
  :'action' = 'danmaku_show' AS do_danmaku_show,
  :'action' = 'danmaku_global_off' AS do_danmaku_global_off,
  :'action' = 'danmaku_global_on' AS do_danmaku_global_on,
  :'action' = 'user_ban' AS do_user_ban,
  :'action' = 'user_unban' AS do_user_unban,
  :'action' = 'contact_handle' AS do_contact_handle,
  :'action' = 'contact_reject' AS do_contact_reject,
  :'action' = 'threshold_set' AS do_threshold_set,
  :'action' = 'threshold_clear' AS do_threshold_clear,
  :'action' = 'episode_discard' AS do_episode_discard,
  :'action' = ANY (ARRAY[
    'scene_takedown', 'scene_restore', 'danmaku_hide', 'danmaku_show',
    'danmaku_global_off', 'danmaku_global_on', 'user_ban', 'user_unban',
    'contact_handle', 'contact_reject', 'threshold_set', 'threshold_clear',
    'episode_discard'
  ]) AS action_known
\gset

\if :action_known
\else
  \echo 'ERROR: unsupported action' :action
  \quit 2
\endif

\if :do_scene_takedown
BEGIN ISOLATION LEVEL SERIALIZABLE;
WITH changed AS (
  UPDATE scenes
     SET takedown_at = clock_timestamp(), takedown_reason = :'reason'
   WHERE scene_index = :'scene_index'::integer AND takedown_at IS NULL
   RETURNING scene_index, takedown_at, takedown_reason
)
SELECT 1 / count(*)::integer AS target_count_guard,
       current_user AS operator, clock_timestamp() AS recorded_at,
       'scene_takedown' AS action, max(scene_index) AS scene_index,
       max(takedown_at) AS takedown_at,
       max(takedown_reason) AS takedown_reason
  FROM changed;
COMMIT;
\endif

\if :do_scene_restore
BEGIN ISOLATION LEVEL SERIALIZABLE;
WITH changed AS (
  UPDATE scenes SET takedown_at = NULL, takedown_reason = NULL
   WHERE scene_index = :'scene_index'::integer AND takedown_at IS NOT NULL
   RETURNING scene_index
)
SELECT 1 / count(*)::integer AS target_count_guard,
       current_user AS operator, clock_timestamp() AS recorded_at,
       'scene_restore' AS action, max(scene_index) AS scene_index
  FROM changed;
COMMIT;
\endif

\if :do_danmaku_hide
BEGIN ISOLATION LEVEL SERIALIZABLE;
WITH changed AS (
  UPDATE danmaku SET status = 'hidden'
   WHERE id = :'danmaku_id'::bigint AND status = 'visible'
   RETURNING id, scene_index, status
)
SELECT 1 / count(*)::integer AS target_count_guard,
       current_user AS operator, clock_timestamp() AS recorded_at,
       'danmaku_hide' AS action, max(id) AS danmaku_id,
       max(scene_index) AS scene_index, max(status) AS status
  FROM changed;
COMMIT;
\endif

\if :do_danmaku_show
BEGIN ISOLATION LEVEL SERIALIZABLE;
WITH changed AS (
  UPDATE danmaku SET status = 'visible'
   WHERE id = :'danmaku_id'::bigint AND status = 'hidden'
   RETURNING id, scene_index, status
)
SELECT 1 / count(*)::integer AS target_count_guard,
       current_user AS operator, clock_timestamp() AS recorded_at,
       'danmaku_show' AS action, max(id) AS danmaku_id,
       max(scene_index) AS scene_index, max(status) AS status
  FROM changed;
COMMIT;
\endif

\if :do_danmaku_global_off
BEGIN ISOLATION LEVEL SERIALIZABLE;
WITH changed AS (
  INSERT INTO site_settings (key, value, updated_at)
  VALUES ('danmaku_enabled', 'false'::jsonb, clock_timestamp())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  RETURNING key, value, updated_at
)
SELECT current_user AS operator, clock_timestamp() AS recorded_at,
       'danmaku_global_off' AS action, key, value, updated_at
  FROM changed;
COMMIT;
\endif

\if :do_danmaku_global_on
BEGIN ISOLATION LEVEL SERIALIZABLE;
WITH changed AS (
  INSERT INTO site_settings (key, value, updated_at)
  VALUES ('danmaku_enabled', 'true'::jsonb, clock_timestamp())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  RETURNING key, value, updated_at
)
SELECT current_user AS operator, clock_timestamp() AS recorded_at,
       'danmaku_global_on' AS action, key, value, updated_at
  FROM changed;
COMMIT;
\endif

\if :do_user_ban
BEGIN ISOLATION LEVEL SERIALIZABLE;
WITH changed AS (
  UPDATE users
     SET banned_at = clock_timestamp(), ban_reason = :'reason'
   WHERE id = :'user_id'::uuid AND banned_at IS NULL
   RETURNING id, username_display, banned_at, ban_reason
)
SELECT 1 / count(*)::integer AS target_count_guard,
       current_user AS operator, clock_timestamp() AS recorded_at,
       'user_ban' AS action, max(id::text)::uuid AS user_id,
       max(username_display) AS username, max(banned_at) AS banned_at,
       max(ban_reason) AS ban_reason
  FROM changed;
COMMIT;
\endif

\if :do_user_unban
BEGIN ISOLATION LEVEL SERIALIZABLE;
WITH changed AS (
  UPDATE users SET banned_at = NULL, ban_reason = NULL
   WHERE id = :'user_id'::uuid AND banned_at IS NOT NULL
   RETURNING id, username_display
)
SELECT 1 / count(*)::integer AS target_count_guard,
       current_user AS operator, clock_timestamp() AS recorded_at,
       'user_unban' AS action, max(id::text)::uuid AS user_id,
       max(username_display) AS username
  FROM changed;
COMMIT;
\endif

\if :do_contact_handle
BEGIN ISOLATION LEVEL SERIALIZABLE;
WITH changed AS (
  UPDATE contact_messages
     SET status = 'handled', handled_at = clock_timestamp()
   WHERE id = :'contact_id'::uuid AND status = 'open'
   RETURNING id, status, handled_at
)
SELECT 1 / count(*)::integer AS target_count_guard,
       current_user AS operator, clock_timestamp() AS recorded_at,
       'contact_handle' AS action, max(id::text)::uuid AS contact_id,
       max(status) AS status, max(handled_at) AS handled_at
  FROM changed;
COMMIT;
\endif

\if :do_contact_reject
BEGIN ISOLATION LEVEL SERIALIZABLE;
WITH changed AS (
  UPDATE contact_messages
     SET status = 'rejected', handled_at = clock_timestamp()
   WHERE id = :'contact_id'::uuid AND status = 'open'
   RETURNING id, status, handled_at
)
SELECT 1 / count(*)::integer AS target_count_guard,
       current_user AS operator, clock_timestamp() AS recorded_at,
       'contact_reject' AS action, max(id::text)::uuid AS contact_id,
       max(status) AS status, max(handled_at) AS handled_at
  FROM changed;
COMMIT;
\endif

\if :do_threshold_set
BEGIN ISOLATION LEVEL SERIALIZABLE;
WITH checked AS (
  SELECT :'threshold'::integer AS threshold
), changed AS (
  INSERT INTO site_settings (key, value, updated_at)
  SELECT 'vote_adopt_threshold_override', to_jsonb(threshold), clock_timestamp()
    FROM checked WHERE threshold >= 1
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  RETURNING key, value, updated_at
)
SELECT 1 / count(*)::integer AS threshold_guard,
       current_user AS operator, clock_timestamp() AS recorded_at,
       'threshold_set' AS action, max(key) AS key,
       max(value::text)::jsonb AS value, max(updated_at) AS updated_at
  FROM changed;
COMMIT;
\endif

\if :do_threshold_clear
BEGIN ISOLATION LEVEL SERIALIZABLE;
WITH changed AS (
  DELETE FROM site_settings WHERE key = 'vote_adopt_threshold_override'
  RETURNING key, value
)
SELECT current_user AS operator, clock_timestamp() AS recorded_at,
       'threshold_clear' AS action,
       count(*) AS removed_rows,
       'environment VOTE_ADOPT_THRESHOLD is active' AS resulting_state
  FROM changed;
COMMIT;
\endif

\if :do_episode_discard
BEGIN ISOLATION LEVEL SERIALIZABLE;
-- The target is resolved once. An episode with a published scene, or with a
-- job still pending/running, is not a target, so the guard below aborts.
CREATE TEMP TABLE episode_discard_target ON COMMIT DROP AS
  SELECT e.id, e.movie_id, e.episode_index
    FROM episodes e
    JOIN movies m ON m.id = e.movie_id
   WHERE m.slug = :'movie_slug'
     AND e.episode_index = :'episode_index'::integer
     AND NOT EXISTS (SELECT 1 FROM scenes s WHERE s.episode_id = e.id)
     AND NOT EXISTS (
       SELECT 1 FROM workflow_jobs j
         JOIN rounds r ON r.id = j.round_id
        WHERE r.episode_id = e.id AND j.status IN ('pending', 'running')
     );
SELECT 1 / count(*)::integer AS target_count_guard FROM episode_discard_target;
WITH gone AS (
  DELETE FROM submission_votes v
   USING submissions s, episode_discard_target t
   WHERE v.submission_id = s.id AND s.episode_id = t.id
   RETURNING 1
) SELECT count(*) AS votes_removed FROM gone;
WITH gone AS (
  DELETE FROM submission_scores sc
   USING submissions s, episode_discard_target t
   WHERE sc.submission_id = s.id AND s.episode_id = t.id
   RETURNING 1
) SELECT count(*) AS scores_removed FROM gone;
WITH gone AS (
  DELETE FROM submission_translations tr
   USING submissions s, episode_discard_target t
   WHERE tr.submission_id = s.id AND s.episode_id = t.id
   RETURNING 1
) SELECT count(*) AS translations_removed FROM gone;
WITH gone AS (
  DELETE FROM ai_runs a
   USING rounds r, episode_discard_target t
   WHERE a.round_id = r.id AND r.episode_id = t.id
   RETURNING 1
) SELECT count(*) AS ai_runs_removed FROM gone;
WITH gone AS (
  DELETE FROM workflow_jobs j
   USING rounds r, episode_discard_target t
   WHERE j.round_id = r.id AND r.episode_id = t.id
   RETURNING 1
) SELECT count(*) AS jobs_removed FROM gone;
-- Rounds point at their selected submission and submissions point at their
-- round, so both go in one statement; the constraints are checked at its end.
WITH gone_rounds AS (
  DELETE FROM rounds r USING episode_discard_target t
   WHERE r.episode_id = t.id RETURNING 1
), gone_submissions AS (
  DELETE FROM submissions s USING episode_discard_target t
   WHERE s.episode_id = t.id RETURNING 1
)
SELECT (SELECT count(*) FROM gone_rounds) AS rounds_removed,
       (SELECT count(*) FROM gone_submissions) AS submissions_removed;
WITH changed AS (
  DELETE FROM episodes e USING episode_discard_target t
   WHERE e.id = t.id
   RETURNING e.movie_id, e.episode_index
)
SELECT 1 / count(*)::integer AS target_count_guard,
       current_user AS operator, clock_timestamp() AS recorded_at,
       'episode_discard' AS action, :'movie_slug' AS movie_slug,
       max(episode_index) AS episode_index, :'reason' AS reason
  FROM changed;
COMMIT;
\endif
