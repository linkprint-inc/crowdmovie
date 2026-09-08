-- Preserve one adjacent tail-frame continuation while preventing repeated
-- H.264 -> PNG -> H3 conditioning from compounding image degradation.

UPDATE "movie_bible_versions"
SET "world_rules" = "world_rules" || '{
      "tailChain":"at most one adjacent I2VA continuation may follow a T2VA shot; an I2VA shot must be followed by a stateless T2VA quality reset"
    }'::jsonb,
    "style_prompt" = "style_prompt" || ' At most one adjacent I2VA continuation may follow a T2VA shot. If the previous H3 prompt begins with the Picture 1 alignment header, force a stateless T2VA quality reset instead of chaining its encoded tail again.',
    "workflow_profile" = "workflow_profile" || '{
      "tailChain":{"maxAdjacentI2va":1,"resetMode":"stateless-t2va"}
    }'::jsonb
WHERE "id" = '11000000-0000-4000-8000-000000000002';
--> statement-breakpoint
