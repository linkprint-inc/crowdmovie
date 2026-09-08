ALTER TABLE "rounds" ALTER COLUMN "closes_at" DROP NOT NULL;--> statement-breakpoint
UPDATE "rounds" SET "closes_at" = NULL
 WHERE "status" = 'open'
   AND NOT EXISTS (
         SELECT 1 FROM "submissions" s
          WHERE s."round_id" = "rounds"."id" AND s."kind" = 'next_shot');
