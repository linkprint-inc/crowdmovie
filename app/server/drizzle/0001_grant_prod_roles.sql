-- Custom SQL migration file, put your code below! --

-- Production role grants (implementation plan T0.6). Kept in the migration set
-- so prod privileges are version-controlled and applied by the same runner as
-- the schema. The two prod login roles (crowdmovie_web, crowdmovie_worker)
-- exist ONLY in production; a fresh local / CI database (e.g. crowdmovie_test)
-- has neither, and a bare GRANT would abort migrate() there with
-- "role ... does not exist". Each role's grants are therefore wrapped in a DO
-- block that first checks pg_roles, making this migration a graceful no-op
-- locally while still encoding the production grants exactly once.
--
-- Intent (T0.6):
--   * crowdmovie_web + crowdmovie_worker: SELECT, INSERT, UPDATE on every
--     business table (all 16 tables of §16.1).
--   * crowdmovie_web: additionally DELETE, but ONLY on workflow_jobs and
--     ai_runs (the mutable ledgers); no DELETE on any other table.
--   * No role is granted any DDL.
-- danmaku uses GENERATED ALWAYS AS IDENTITY, so table-level INSERT is
-- sufficient (no sequence USAGE grant required).

DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crowdmovie_web') THEN
		GRANT SELECT, INSERT, UPDATE ON
			"users", "sessions", "password_resets", "episodes", "rounds",
			"submissions", "submission_scores", "submission_votes", "scenes",
			"danmaku", "drafts", "submission_translations", "contact_messages",
			"site_settings", "ai_runs", "workflow_jobs"
		TO crowdmovie_web;
		GRANT DELETE ON "workflow_jobs", "ai_runs" TO crowdmovie_web;
	END IF;

	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crowdmovie_worker') THEN
		GRANT SELECT, INSERT, UPDATE ON
			"users", "sessions", "password_resets", "episodes", "rounds",
			"submissions", "submission_scores", "submission_votes", "scenes",
			"danmaku", "drafts", "submission_translations", "contact_messages",
			"site_settings", "ai_runs", "workflow_jobs"
		TO crowdmovie_worker;
	END IF;
END
$$;
