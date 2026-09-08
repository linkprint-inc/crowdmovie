-- Who's Next may fill an unattended empty round with a visible AI Director
-- submission until published/in-flight scenes reach 50. Human submissions stay
-- available after the automatic cap.

INSERT INTO "site_settings" ("key", "value", "updated_at")
VALUES (
  'movie:10000000-0000-4000-8000-000000000002:automatic_scene_limit',
  '50'::jsonb,
  now()
)
ON CONFLICT ("key") DO UPDATE
SET "value" = EXCLUDED."value",
    "updated_at" = EXCLUDED."updated_at";
--> statement-breakpoint
