-- §16.5 hourly maintenance deletes only expired/revoked sessions and
-- expired/used password-reset tokens. The production runtime role previously
-- had SELECT/INSERT/UPDATE but no DELETE on these two tables, so the first
-- durable maintenance job correctly failed closed instead of silently skipping
-- cleanup. Grant the minimum additional privilege; no other business table is
-- deletable by the worker.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crowdmovie_worker') THEN
		GRANT DELETE ON "sessions", "password_resets" TO crowdmovie_worker;
	END IF;
END
$$;
