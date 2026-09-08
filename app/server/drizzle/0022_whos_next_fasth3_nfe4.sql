-- Switch the controlled v4 profile to the official four-NFE path of the
-- pinned PDD acceleration checkpoint. Image conditioning is disabled; only
-- stateless T2VA and the adjacent latent Motion Context path remain.

UPDATE "movie_bible_versions"
SET "workflow_profile" = "workflow_profile" || '{
      "engine":"minimax-h3-fl2va-pdd-acc-4nfe-int8-convrot",
      "steps":4,
      "imageConditioning":"disabled",
      "endFrameReference":false
    }'::jsonb
WHERE "id" = '11000000-0000-4000-8000-000000000002';
--> statement-breakpoint
