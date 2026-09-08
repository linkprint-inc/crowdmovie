-- Who's Next becomes the only scheduled programme, all day, and therefore the
-- live page's movie. Inland Empire High keeps its published history for replay
-- but no longer has a schedule window, so it can never own the generator.
--
-- Rights: the Who's Next house cast, house look and English voice anchors are
-- original CrowdMovie work, so the movie is cleared as original. Guest heroes
-- are text-described original rebuilds in the house look; see
-- workstation/movie/world-bible.md.

-- Disable every window first so the exclusion constraint never sees a
-- half-updated overlap, then widen the first window to the whole day. The
-- other two rows stay disabled; the test helpers still use them to exercise
-- the two-movie switching state machine.
UPDATE "movie_schedule_windows"
SET "enabled" = false
WHERE "generator_key" = 'primary';
--> statement-breakpoint

UPDATE "movie_schedule_windows"
SET "movie_id" = '10000000-0000-4000-8000-000000000002',
    "start_minute" = 0,
    "end_minute" = 1440,
    "label" = 'Who''s Next · 全天',
    "enabled" = true
WHERE "id" = '13000000-0000-4000-8000-000000000001';
--> statement-breakpoint

UPDATE "movies"
SET "production_status" = 'ready',
    "rights_status" = 'original_cleared',
    "display_order" = 10,
    "updated_at" = now()
WHERE "id" = '10000000-0000-4000-8000-000000000002';
UPDATE "movies"
SET "display_order" = 20,
    "updated_at" = now()
WHERE "id" = '10000000-0000-4000-8000-000000000001';
--> statement-breakpoint

UPDATE "movie_bible_versions"
SET "world_rules" = "world_rules" || '{"bible":"workstation/movie/world-bible.md"}'::jsonb
WHERE "id" = '11000000-0000-4000-8000-000000000002';
--> statement-breakpoint

-- The long-lived Sol director thread remembers Inland Empire High canon. Drop
-- the pointer so the first Who's Next turn starts a fresh thread.
DELETE FROM "site_settings" WHERE "key" = 'codex_director_thread_id';
