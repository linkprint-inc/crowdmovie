CREATE TABLE "story_comments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "story_comments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"proposal_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"content" text NOT NULL,
	"content_language" text,
	"status" text DEFAULT 'visible' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_comments_status_ck" CHECK ("story_comments"."status" IN ('visible','hidden'))
);
--> statement-breakpoint
CREATE TABLE "story_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"position" smallint NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"file_url" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_images_kind_ck" CHECK ("story_images"."kind" IN ('character','world')),
	CONSTRAINT "story_images_position_ck" CHECK ("story_images"."position" BETWEEN 0 AND 5),
	CONSTRAINT "story_images_bytes_ck" CHECK ("story_images"."bytes" > 0 AND "story_images"."bytes" <= 2097152)
);
--> statement-breakpoint
CREATE TABLE "story_likes" (
	"proposal_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_likes_proposal_id_user_id_pk" PRIMARY KEY("proposal_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "story_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"synopsis" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"reject_reason" text,
	"review_model" text,
	"review_output" jsonb,
	"like_count" integer DEFAULT 0 NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"takedown_at" timestamp with time zone,
	"takedown_reason" text,
	CONSTRAINT "story_proposals_status_ck" CHECK ("story_proposals"."status" IN ('draft','pending','approved','rejected','review_failed'))
);
--> statement-breakpoint
ALTER TABLE "story_comments" ADD CONSTRAINT "story_comments_proposal_id_story_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."story_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_comments" ADD CONSTRAINT "story_comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_images" ADD CONSTRAINT "story_images_proposal_id_story_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."story_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_likes" ADD CONSTRAINT "story_likes_proposal_id_story_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."story_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_likes" ADD CONSTRAINT "story_likes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_proposals" ADD CONSTRAINT "story_proposals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "story_comments_proposal_id_id_idx" ON "story_comments" USING btree ("proposal_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "story_images_slot_uq" ON "story_images" USING btree ("proposal_id","kind","position");--> statement-breakpoint
CREATE UNIQUE INDEX "story_proposals_one_active_uq" ON "story_proposals" USING btree ("user_id") WHERE "story_proposals"."status" IN ('draft','pending');--> statement-breakpoint
CREATE INDEX "story_proposals_published_likes_idx" ON "story_proposals" USING btree ("like_count" DESC NULLS LAST,"published_at" DESC NULLS LAST) WHERE "story_proposals"."published_at" IS NOT NULL AND "story_proposals"."takedown_at" IS NULL;--> statement-breakpoint
CREATE INDEX "story_proposals_published_at_idx" ON "story_proposals" USING btree ("published_at" DESC NULLS LAST) WHERE "story_proposals"."published_at" IS NOT NULL AND "story_proposals"."takedown_at" IS NULL;--> statement-breakpoint
CREATE INDEX "story_proposals_user_id_created_at_idx" ON "story_proposals" USING btree ("user_id","created_at" DESC NULLS LAST);