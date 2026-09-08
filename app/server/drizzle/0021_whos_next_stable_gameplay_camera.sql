-- The first live v4 director canary still wrote a fast tracking rush even
-- though the generated 3D game background was substantially sharper. Make the
-- creative policy match the application and 8191 mechanical rejection gate.

UPDATE "movie_bible_versions"
SET "style_prompt" = replace(
      "style_prompt",
      'Never combine fast subject motion with a fast large-amplitude push, pull, orbit or whip pan.',
      'Never write fast, rapid, high-speed or large-amplitude camera motion.'
    ),
    "camera_rules" = "camera_rules" || '{
      "forbiddenCameraMotion":"fast, rapid, high-speed or large-amplitude camera recipes"
    }'::jsonb
WHERE "id" = '11000000-0000-4000-8000-000000000002';
--> statement-breakpoint
