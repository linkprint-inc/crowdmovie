CREATE TABLE "ai_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"submission_id" uuid,
	"run_type" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"reasoning_effort" text NOT NULL,
	"codex_thread_id" text,
	"prompt_plan_version" text,
	"input_sha256" text,
	"output_json" jsonb,
	"usage_json" jsonb,
	"latency_ms" integer,
	"status" text NOT NULL,
	"error_code" text,
	"error_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contact_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"category" text NOT NULL,
	"scene_index" integer,
	"body" text NOT NULL,
	"source_ip" "inet",
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "danmaku" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "danmaku_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"scene_index" integer NOT NULL,
	"offset_ms" integer NOT NULL,
	"content" text NOT NULL,
	"content_language" text,
	"status" text DEFAULT 'visible' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "danmaku_offset_ms_ck" CHECK ("danmaku"."offset_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"user_id" uuid,
	"kind" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drafts_user_id_kind_pk" PRIMARY KEY("user_id","kind")
);
--> statement-breakpoint
CREATE TABLE "episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"episode_index" integer NOT NULL,
	"title" text NOT NULL,
	"theme" text NOT NULL,
	"theme_source_submission_id" uuid,
	"status" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	CONSTRAINT "episodes_episode_index_unique" UNIQUE("episode_index")
);
--> statement-breakpoint
CREATE TABLE "password_resets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_resets_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_index" bigint NOT NULL,
	"episode_id" uuid NOT NULL,
	"status" text NOT NULL,
	"opens_at" timestamp with time zone NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"selected_submission_id" uuid,
	"selection_mode" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rounds_round_index_unique" UNIQUE("round_index")
);
--> statement-breakpoint
CREATE TABLE "scenes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scene_index" integer NOT NULL,
	"episode_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"credit_user_id" uuid,
	"source_submission_id" uuid,
	"summary_zh" text NOT NULL,
	"duration_seconds" numeric(6, 3) NOT NULL,
	"media" jsonb NOT NULL,
	"director_ai_run_id" uuid NOT NULL,
	"subtitle_ai_run_id" uuid NOT NULL,
	"episode_should_end" boolean NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"takedown_at" timestamp with time zone,
	"takedown_reason" text,
	CONSTRAINT "scenes_scene_index_unique" UNIQUE("scene_index"),
	CONSTRAINT "scenes_round_id_unique" UNIQUE("round_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "site_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submission_scores" (
	"submission_id" uuid PRIMARY KEY NOT NULL,
	"eligible" boolean NOT NULL,
	"score_total" smallint,
	"score_breakdown" jsonb NOT NULL,
	"reason" text NOT NULL,
	"public_roast" jsonb NOT NULL,
	"risk_flags" jsonb NOT NULL,
	"rubric_version" text NOT NULL,
	"ai_run_id" uuid NOT NULL,
	"scored_at" timestamp with time zone NOT NULL,
	CONSTRAINT "submission_scores_score_total_ck" CHECK ("submission_scores"."score_total" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "submission_translations" (
	"submission_id" uuid,
	"locale" text NOT NULL,
	"text" text NOT NULL,
	"ai_run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_translations_submission_id_locale_pk" PRIMARY KEY("submission_id","locale")
);
--> statement-breakpoint
CREATE TABLE "submission_votes" (
	"submission_id" uuid,
	"user_id" uuid,
	"value" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_votes_submission_id_user_id_pk" PRIMARY KEY("submission_id","user_id"),
	CONSTRAINT "submission_votes_value_ck" CHECK ("submission_votes"."value" IN (1, -1))
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"round_id" uuid,
	"episode_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"content" text NOT NULL,
	"content_language" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"up_count" integer DEFAULT 0 NOT NULL,
	"down_count" integer DEFAULT 0 NOT NULL,
	"votes_frozen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submissions_kind_round_ck" CHECK (("submissions"."kind" = 'next_shot') = ("submissions"."round_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username_display" text NOT NULL,
	"username_key" text NOT NULL,
	"email_key" text,
	"password_hash" text,
	"email_verified_at" timestamp with time zone,
	"guest_token_hash" text,
	"role" text DEFAULT 'user' NOT NULL,
	"banned_at" timestamp with time zone,
	"ban_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"upgraded_at" timestamp with time zone,
	CONSTRAINT "users_username_key_unique" UNIQUE("username_key"),
	CONSTRAINT "users_email_key_unique" UNIQUE("email_key")
);
--> statement-breakpoint
CREATE TABLE "workflow_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid,
	"job_type" text NOT NULL,
	"idempotency_key" text,
	"status" text NOT NULL,
	"upstream_job_id" text,
	"payload_json" jsonb,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_jobs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "contact_messages" ADD CONSTRAINT "contact_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "danmaku" ADD CONSTRAINT "danmaku_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "danmaku" ADD CONSTRAINT "danmaku_scene_index_scenes_scene_index_fk" FOREIGN KEY ("scene_index") REFERENCES "public"."scenes"("scene_index") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_credit_user_id_users_id_fk" FOREIGN KEY ("credit_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_source_submission_id_submissions_id_fk" FOREIGN KEY ("source_submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_director_ai_run_id_ai_runs_id_fk" FOREIGN KEY ("director_ai_run_id") REFERENCES "public"."ai_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_subtitle_ai_run_id_ai_runs_id_fk" FOREIGN KEY ("subtitle_ai_run_id") REFERENCES "public"."ai_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_scores" ADD CONSTRAINT "submission_scores_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_scores" ADD CONSTRAINT "submission_scores_ai_run_id_ai_runs_id_fk" FOREIGN KEY ("ai_run_id") REFERENCES "public"."ai_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_translations" ADD CONSTRAINT "submission_translations_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_translations" ADD CONSTRAINT "submission_translations_ai_run_id_ai_runs_id_fk" FOREIGN KEY ("ai_run_id") REFERENCES "public"."ai_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_votes" ADD CONSTRAINT "submission_votes_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_votes" ADD CONSTRAINT "submission_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "danmaku_scene_index_offset_ms_idx" ON "danmaku" USING btree ("scene_index","offset_ms");--> statement-breakpoint
CREATE INDEX "danmaku_created_at_idx" ON "danmaku" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "scenes_credit_user_id_idx" ON "scenes" USING btree ("credit_user_id");--> statement-breakpoint
CREATE INDEX "scenes_episode_id_idx" ON "scenes" USING btree ("episode_id");--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_next_shot_round_user_uq" ON "submissions" USING btree ("round_id","user_id") WHERE "submissions"."kind" = 'next_shot';--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_next_episode_ep_user_uq" ON "submissions" USING btree ("episode_id","user_id") WHERE "submissions"."kind" = 'next_episode';--> statement-breakpoint
CREATE INDEX "submissions_user_id_created_at_idx" ON "submissions" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "submissions_episode_id_kind_idx" ON "submissions" USING btree ("episode_id","kind");