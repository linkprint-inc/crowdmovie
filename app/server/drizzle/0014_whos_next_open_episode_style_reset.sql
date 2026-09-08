-- Remove the former background default from an already-open AI-authored episode.
-- Human-sourced episode themes are deliberately untouched: their explicit style
-- remains authoritative.

UPDATE "episodes"
SET "theme" = regexp_replace(
      "theme",
      'The ([^.]+) environment uses the stylized 3D comic/game-cinematic background treatment while every fighter retains the recognizable appearance and visual medium of the original source\.',
      E'The \\1 environment uses realistic live-action cinematic treatment with physically grounded lighting, practical textures, atmospheric depth, and interactive debris while every fighter retains the recognizable appearance and visual medium of the original source.',
      'g'
    )
WHERE "movie_id" = '10000000-0000-4000-8000-000000000002'
  AND "status" = 'open'
  AND "theme_source_submission_id" IS NULL
  AND "theme" LIKE '%stylized 3D comic/game-cinematic background treatment%';
--> statement-breakpoint

UPDATE "movie_bible_versions"
SET "world_rules" = "world_rules" || '{"backgroundOverride":"only an explicit background treatment in a human audience submission overrides the default; AI-authored outlines, pitches, shots and thread memory do not"}'::jsonb,
    "style_prompt" = "style_prompt" || ' Only an explicit background treatment in a human audience submission overrides this default; never preserve an obsolete default from an AI-authored outline, pitch, previous shot or thread memory.'
WHERE "id" = '11000000-0000-4000-8000-000000000002';
--> statement-breakpoint

-- The thread created during the v3 cutover may have already read the stale open
-- episode theme. Force the next director turn to load the corrected trusted facts.
DELETE FROM "site_settings" WHERE "key" = 'codex_director_thread_id';
