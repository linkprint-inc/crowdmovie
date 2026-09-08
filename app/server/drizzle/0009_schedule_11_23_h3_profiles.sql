-- Data-only correction for databases that already applied the original 0005
-- seed.  Disable the three windows first so the exclusion constraint is never
-- evaluated against a half-updated schedule.
UPDATE "movie_schedule_windows"
SET "enabled" = false
WHERE "generator_key" = 'primary'
  AND "id" IN (
    '13000000-0000-4000-8000-000000000001',
    '13000000-0000-4000-8000-000000000002',
    '13000000-0000-4000-8000-000000000003'
  );
--> statement-breakpoint

UPDATE "movie_schedule_windows"
SET
  "movie_id" = CASE "id"
    WHEN '13000000-0000-4000-8000-000000000001' THEN '10000000-0000-4000-8000-000000000002'::uuid
    WHEN '13000000-0000-4000-8000-000000000002' THEN '10000000-0000-4000-8000-000000000001'::uuid
    WHEN '13000000-0000-4000-8000-000000000003' THEN '10000000-0000-4000-8000-000000000002'::uuid
  END,
  "start_minute" = CASE "id"
    WHEN '13000000-0000-4000-8000-000000000001' THEN 0
    WHEN '13000000-0000-4000-8000-000000000002' THEN 660
    WHEN '13000000-0000-4000-8000-000000000003' THEN 1380
  END,
  "end_minute" = CASE "id"
    WHEN '13000000-0000-4000-8000-000000000001' THEN 660
    WHEN '13000000-0000-4000-8000-000000000002' THEN 1380
    WHEN '13000000-0000-4000-8000-000000000003' THEN 1440
  END,
  "label" = CASE "id"
    WHEN '13000000-0000-4000-8000-000000000001' THEN '职场西游记 · 夜间'
    WHEN '13000000-0000-4000-8000-000000000002' THEN '内陆帝国高校 · 日间'
    WHEN '13000000-0000-4000-8000-000000000003' THEN '职场西游记 · 夜间'
  END
WHERE "generator_key" = 'primary'
  AND "id" IN (
    '13000000-0000-4000-8000-000000000001',
    '13000000-0000-4000-8000-000000000002',
    '13000000-0000-4000-8000-000000000003'
  );
--> statement-breakpoint

UPDATE "movie_schedule_windows"
SET "enabled" = true
WHERE "generator_key" = 'primary'
  AND "id" IN (
    '13000000-0000-4000-8000-000000000001',
    '13000000-0000-4000-8000-000000000002',
    '13000000-0000-4000-8000-000000000003'
  );
--> statement-breakpoint

UPDATE "movie_bible_versions"
SET "workflow_profile" = "workflow_profile" || jsonb_build_object(
  'h3Prompt', jsonb_build_object(
    'mode', 'T2VA',
    'skill', 'h3-prompt-writing',
    'skillRevision', 'd21241f0a4b3acbb34c97dae47fa417b7065e438',
    'guide', 'skills/h3-prompt-writing/references/base-en.txt',
    'fieldOrder', jsonb_build_array(
      'integrated_multimodal_description',
      'overall_soundscape',
      'non_diegetic_music'
    ),
    'durationSeconds', jsonb_build_object('min', 4, 'max', 15),
    'singleContinuousShot', true
  )
)
WHERE "id" IN (
  '11000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000002'
);
