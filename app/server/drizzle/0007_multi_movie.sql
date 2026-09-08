-- Multi-movie expand/backfill/contract migration.
-- Existing rows are assigned to the original Inland Empire High movie before
-- movie_id is made mandatory. New identifiers are deterministic so application
-- code, tests and operational tooling can refer to the two launch movies.

CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint

CREATE TABLE "movies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL UNIQUE,
	"title_i18n" jsonb NOT NULL,
	"synopsis_i18n" jsonb NOT NULL,
	"poster_url" text,
	"hero_url" text,
	"default_locale" text NOT NULL,
	"primary_audio_locale" text NOT NULL,
	"subtitle_locales" jsonb NOT NULL,
	"status" text NOT NULL,
	"production_status" text NOT NULL,
	"rights_status" text NOT NULL,
	"source_type" text NOT NULL,
	"display_order" smallint DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "movies_status_ck" CHECK ("status" IN ('draft','published','archived')),
	CONSTRAINT "movies_production_status_ck" CHECK ("production_status" IN ('ready','blocked','paused')),
	CONSTRAINT "movies_rights_status_ck" CHECK ("rights_status" IN ('blocked','original_cleared','licensed')),
	CONSTRAINT "movies_source_type_ck" CHECK ("source_type" IN ('staff_original','story_proposal'))
);
--> statement-breakpoint

CREATE TABLE "movie_bible_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"movie_id" uuid NOT NULL REFERENCES "movies"("id"),
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"story_rules" jsonb NOT NULL,
	"world_rules" jsonb NOT NULL,
	"style_prompt" text NOT NULL,
	"negative_prompt" text NOT NULL,
	"camera_rules" jsonb NOT NULL,
	"workflow_profile" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	CONSTRAINT "movie_bible_versions_movie_version_uq" UNIQUE("movie_id","version"),
	CONSTRAINT "movie_bible_versions_id_movie_uq" UNIQUE("id","movie_id"),
	CONSTRAINT "movie_bible_versions_status_ck" CHECK ("status" IN ('draft','active','retired'))
);
--> statement-breakpoint

CREATE TABLE "movie_characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"movie_id" uuid NOT NULL REFERENCES "movies"("id"),
	"character_key" text NOT NULL,
	"position" smallint NOT NULL,
	"public_copy_i18n" jsonb NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "movie_characters_movie_key_uq" UNIQUE("movie_id","character_key"),
	CONSTRAINT "movie_characters_movie_position_uq" UNIQUE("movie_id","position"),
	CONSTRAINT "movie_characters_id_movie_uq" UNIQUE("id","movie_id"),
	CONSTRAINT "movie_characters_status_ck" CHECK ("status" IN ('active','retired'))
);
--> statement-breakpoint

CREATE TABLE "movie_character_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"movie_id" uuid NOT NULL REFERENCES "movies"("id"),
	"bible_version_id" uuid NOT NULL,
	"character_id" uuid NOT NULL,
	"visual_identity" jsonb NOT NULL,
	"reference_assets" jsonb NOT NULL,
	"consistency_adapter" jsonb NOT NULL,
	"voice_profile" jsonb NOT NULL,
	CONSTRAINT "movie_character_versions_bible_character_uq" UNIQUE("bible_version_id","character_id"),
	CONSTRAINT "movie_character_versions_bible_movie_fk" FOREIGN KEY ("bible_version_id","movie_id") REFERENCES "movie_bible_versions"("id","movie_id"),
	CONSTRAINT "movie_character_versions_character_movie_fk" FOREIGN KEY ("character_id","movie_id") REFERENCES "movie_characters"("id","movie_id")
);
--> statement-breakpoint

CREATE TABLE "movie_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"movie_id" uuid NOT NULL REFERENCES "movies"("id"),
	"kind" text NOT NULL,
	"storage_url" text NOT NULL,
	"sha256" text NOT NULL,
	"rights_status" text NOT NULL,
	"evidence_ref" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "movie_assets_rights_status_ck" CHECK ("rights_status" IN ('pending','original','licensed','rejected'))
);
--> statement-breakpoint

CREATE TABLE "movie_sources" (
	"movie_id" uuid PRIMARY KEY REFERENCES "movies"("id"),
	"story_proposal_id" uuid UNIQUE REFERENCES "story_proposals"("id"),
	"author_user_id" uuid REFERENCES "users"("id"),
	"proposal_snapshot" jsonb NOT NULL,
	"adaptation_grant_version" text,
	"adaptation_granted_at" timestamp with time zone,
	"attribution_text" text,
	"selected_by" uuid REFERENCES "users"("id"),
	"selected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "story_generators" (
	"key" text PRIMARY KEY,
	"timezone" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"lease_movie_id" uuid REFERENCES "movies"("id"),
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone
);
--> statement-breakpoint

CREATE TABLE "movie_schedule_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generator_key" text NOT NULL REFERENCES "story_generators"("key"),
	"movie_id" uuid NOT NULL REFERENCES "movies"("id"),
	"start_minute" smallint NOT NULL,
	"end_minute" smallint NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"label" text NOT NULL,
	CONSTRAINT "movie_schedule_windows_minutes_ck" CHECK (
		"start_minute" >= 0 AND "start_minute" < "end_minute" AND "end_minute" <= 1440
	),
	CONSTRAINT "movie_schedule_windows_no_overlap" EXCLUDE USING gist (
		"generator_key" WITH =,
		int4range("start_minute"::integer, "end_minute"::integer, '[)') WITH &&
	) WHERE ("enabled")
);
--> statement-breakpoint

INSERT INTO "movies" (
	"id", "slug", "title_i18n", "synopsis_i18n", "default_locale",
	"primary_audio_locale", "subtitle_locales", "status", "production_status",
	"rights_status", "source_type", "display_order", "published_at"
) VALUES
(
	'10000000-0000-4000-8000-000000000001',
	'inland-empire-high',
	'{"zh-CN":"内陆帝国高校","en":"Inland Empire High","ja":"インランド・エンパイア高校","es":"Instituto Inland Empire"}'::jsonb,
	'{"zh-CN":"六名学生共同推动一部由观众续写的校园连续剧。","en":"Six students drive a crowd-written school serial."}'::jsonb,
	'zh-CN', 'en', '["en","zh-CN","ja","es"]'::jsonb,
	'published', 'ready', 'original_cleared', 'staff_original', 10, now()
),
(
	'10000000-0000-4000-8000-000000000002',
	'workplace-journey-west',
	'{"zh-CN":"职场西游记","en":"Workplace Journey to the West","ja":"オフィス西遊記","es":"Viaje corporativo al Oeste"}'::jsonb,
	'{"zh-CN":"四位性格迥异的同事在一家荒诞科技公司里，护送关键项目穿过层层组织迷宫。","en":"Four mismatched coworkers carry a critical project through a surreal tech company."}'::jsonb,
	'zh-CN', 'zh-CN', '["zh-CN","en","ja","es"]'::jsonb,
	'published', 'blocked', 'blocked', 'staff_original', 20, now()
)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "movie_bible_versions" (
	"id", "movie_id", "version", "status", "story_rules", "world_rules",
	"style_prompt", "negative_prompt", "camera_rules", "workflow_profile", "activated_at"
) VALUES
(
	'11000000-0000-4000-8000-000000000001',
	'10000000-0000-4000-8000-000000000001', 1, 'active',
	'{"engine":"crowd_continuation","continuity":"immutable_history","tone":"surreal school drama"}'::jsonb,
	'{"setting":"Inland Empire high school","language":"English primary audio"}'::jsonb,
	'Established stylized ensemble animation, stable character silhouettes and school palette.',
	'identity drift, costume drift, photoreal celebrity likeness, copied franchise styling',
	'{"defaultShot":"new_shot","continuousEventRequiresExplicitApproval":true}'::jsonb,
	'{"profile":"inland-empire-high-v1","engine":"configured-workflow","version":1,"h3Prompt":{"mode":"T2VA","skill":"h3-prompt-writing","skillRevision":"d21241f0a4b3acbb34c97dae47fa417b7065e438","guide":"skills/h3-prompt-writing/references/base-en.txt","fieldOrder":["integrated_multimodal_description","overall_soundscape","non_diegetic_music"],"durationSeconds":{"min":4,"max":15},"singleContinuousShot":true}}'::jsonb,
	now()
),
(
	'11000000-0000-4000-8000-000000000002',
	'10000000-0000-4000-8000-000000000002', 1, 'active',
	'{"engine":"crowd_continuation","premise":"protect the Golden Release project","roles":["mentor-manager","ace-engineer","sales-operator","reliability-lead"],"rule":"office conflict only; no scene or dialogue copied from existing adaptations"}'::jsonb,
	'{"setting":"original near-future Chinese technology company","departments":["Product Mountain","Finance Cave","Operations River","Executive Cloud"],"language":"Mandarin Chinese"}'::jsonb,
	'Original stylized 3D game cinematic, graphic proportions, jade and amber office lighting, four distinct original silhouettes, expressive but non-photoreal faces, cinematic Chinese workplace comedy.',
	'photoreal actors, celebrity likeness, cloned voice, classic television costumes, recognizable television music, copied staging, franchise logos, identity drift, costume drift',
	'{"defaultShot":"new_shot","continuousEventRequiresExplicitApproval":true,"axisRule":"preserve screen direction within event"}'::jsonb,
	'{"profile":"workplace-journey-v1","engine":"configured-workflow","version":1,"audioLocale":"zh-CN","h3Prompt":{"mode":"T2VA","skill":"h3-prompt-writing","skillRevision":"d21241f0a4b3acbb34c97dae47fa417b7065e438","guide":"skills/h3-prompt-writing/references/base-en.txt","fieldOrder":["integrated_multimodal_description","overall_soundscape","non_diegetic_music"],"durationSeconds":{"min":4,"max":15},"singleContinuousShot":true}}'::jsonb,
	now()
)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "movie_sources" ("movie_id", "proposal_snapshot", "attribution_text") VALUES
('10000000-0000-4000-8000-000000000001', '{"source":"staff_original","seedVersion":1}'::jsonb, 'CrowdMovie original'),
('10000000-0000-4000-8000-000000000002', '{"source":"staff_original","seedVersion":1,"rightsRule":"original visuals and non-imitative voices only"}'::jsonb, 'CrowdMovie original')
ON CONFLICT ("movie_id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "movie_characters" ("id", "movie_id", "character_key", "position", "public_copy_i18n", "status") VALUES
('12000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','koishi',1,'{"zh-CN":{"name":"古明地恋","role":"学生"},"en":{"name":"Koishi","role":"Student"}}'::jsonb,'active'),
('12000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','marisa',2,'{"zh-CN":{"name":"雾雨魔理沙","role":"学生"},"en":{"name":"Marisa","role":"Student"}}'::jsonb,'active'),
('12000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','reimu',3,'{"zh-CN":{"name":"博丽灵梦","role":"学生"},"en":{"name":"Reimu","role":"Student"}}'::jsonb,'active'),
('12000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','flandre',4,'{"zh-CN":{"name":"芙兰朵露","role":"学生"},"en":{"name":"Flandre","role":"Student"}}'::jsonb,'active'),
('12000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001','reisen',5,'{"zh-CN":{"name":"铃仙","role":"学生"},"en":{"name":"Reisen","role":"Student"}}'::jsonb,'active'),
('12000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000001','cirno',6,'{"zh-CN":{"name":"琪露诺","role":"学生"},"en":{"name":"Cirno","role":"Student"}}'::jsonb,'active'),
('12000000-0000-4000-8000-000000000101','10000000-0000-4000-8000-000000000002','mentor',1,'{"zh-CN":{"name":"唐主管","role":"项目负责人","bio":"温和坚定，擅长把混乱会议重新拉回目标。"},"en":{"name":"Director Tang","role":"Project lead"}}'::jsonb,'active'),
('12000000-0000-4000-8000-000000000102','10000000-0000-4000-8000-000000000002','ace',2,'{"zh-CN":{"name":"悟空","role":"首席工程师","bio":"技术极强、反权威，习惯用最快的补丁劈开流程山。"},"en":{"name":"Wukong","role":"Principal engineer"}}'::jsonb,'active'),
('12000000-0000-4000-8000-000000000103','10000000-0000-4000-8000-000000000002','operator',3,'{"zh-CN":{"name":"八戒","role":"商务运营","bio":"懂人情也懂预算，总能闻到需求膨胀的味道。"},"en":{"name":"Bajie","role":"Business operations"}}'::jsonb,'active'),
('12000000-0000-4000-8000-000000000104','10000000-0000-4000-8000-000000000002','reliability',4,'{"zh-CN":{"name":"沙工","role":"可靠性负责人","bio":"少说多做，背着所有人忘记记录的生产事故。"},"en":{"name":"Engineer Sha","role":"Reliability lead"}}'::jsonb,'active')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "movie_character_versions" (
	"movie_id", "bible_version_id", "character_id", "visual_identity",
	"reference_assets", "consistency_adapter", "voice_profile"
)
SELECT
	c."movie_id",
	CASE WHEN c."movie_id" = '10000000-0000-4000-8000-000000000001'
		THEN '11000000-0000-4000-8000-000000000001'::uuid
		ELSE '11000000-0000-4000-8000-000000000002'::uuid END,
	c."id",
	jsonb_build_object(
		'identityVersion', 1,
		'originalDesign', true,
		'silhouetteKey', c."character_key",
		'style', CASE WHEN c."movie_id" = '10000000-0000-4000-8000-000000000002'
			THEN 'stylized 3D game cinematic' ELSE 'established stylized animation' END
	),
	'[]'::jsonb,
	'{"status":"not_configured","checksum":null}'::jsonb,
	jsonb_build_object(
		'locale', CASE WHEN c."movie_id" = '10000000-0000-4000-8000-000000000002' THEN 'zh-CN' ELSE 'en' END,
		'imitationProhibited', true,
		'providerVoiceId', null
	)
FROM "movie_characters" c
ON CONFLICT ("bible_version_id", "character_id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "story_generators" ("key", "timezone", "enabled")
VALUES ('primary', 'America/Los_Angeles', true)
ON CONFLICT ("key") DO UPDATE SET "timezone" = EXCLUDED."timezone";
--> statement-breakpoint

INSERT INTO "movie_schedule_windows" ("id", "generator_key", "movie_id", "start_minute", "end_minute", "enabled", "label") VALUES
('13000000-0000-4000-8000-000000000001','primary','10000000-0000-4000-8000-000000000002',0,660,true,'职场西游记 · 夜间'),
('13000000-0000-4000-8000-000000000002','primary','10000000-0000-4000-8000-000000000001',660,1380,true,'内陆帝国高校 · 日间'),
('13000000-0000-4000-8000-000000000003','primary','10000000-0000-4000-8000-000000000002',1380,1440,true,'职场西游记 · 夜间')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

-- Expand: columns are nullable until all historical rows are backfilled.
ALTER TABLE "episodes" ADD COLUMN "movie_id" uuid;
ALTER TABLE "episodes" ADD COLUMN "bible_version_id" uuid;
ALTER TABLE "rounds" ADD COLUMN "movie_id" uuid;
ALTER TABLE "submissions" ADD COLUMN "movie_id" uuid;
ALTER TABLE "scenes" ADD COLUMN "movie_id" uuid;
ALTER TABLE "danmaku" ADD COLUMN "movie_id" uuid;
ALTER TABLE "drafts" ADD COLUMN "movie_id" uuid;
ALTER TABLE "ai_runs" ADD COLUMN "movie_id" uuid;
ALTER TABLE "workflow_jobs" ADD COLUMN "movie_id" uuid;
ALTER TABLE "contact_messages" ADD COLUMN "movie_id" uuid;
--> statement-breakpoint

-- A legacy clock race could leave the denormalized episode_id on a submission
-- pointing at the episode that was open when the request began, while the
-- authoritative round_id already belonged to the newly opened episode. The
-- round is the ownership boundary used by scoring and selection, so normalize
-- that redundant field before adding the composite parent constraint. Scenes
-- use the same rule defensively even though production currently has no such
-- mismatch.
UPDATE "submissions" s
SET "episode_id" = r."episode_id"
FROM "rounds" r
WHERE r."id" = s."round_id" AND s."episode_id" <> r."episode_id";
UPDATE "scenes" s
SET "episode_id" = r."episode_id"
FROM "rounds" r
WHERE r."id" = s."round_id" AND s."episode_id" <> r."episode_id";
--> statement-breakpoint

UPDATE "episodes"
SET "movie_id" = '10000000-0000-4000-8000-000000000001',
	"bible_version_id" = '11000000-0000-4000-8000-000000000001';
UPDATE "rounds" r SET "movie_id" = e."movie_id" FROM "episodes" e WHERE e."id" = r."episode_id";
UPDATE "submissions" s SET "movie_id" = e."movie_id" FROM "episodes" e WHERE e."id" = s."episode_id";
UPDATE "scenes" s SET "movie_id" = e."movie_id" FROM "episodes" e WHERE e."id" = s."episode_id";
UPDATE "danmaku" d SET "movie_id" = s."movie_id" FROM "scenes" s WHERE s."scene_index" = d."scene_index";
UPDATE "drafts" SET "movie_id" = '10000000-0000-4000-8000-000000000001';
UPDATE "ai_runs" a SET "movie_id" = r."movie_id" FROM "rounds" r WHERE r."id" = a."round_id";
UPDATE "workflow_jobs" j SET "movie_id" = r."movie_id" FROM "rounds" r WHERE r."id" = j."round_id";
UPDATE "contact_messages" c SET "movie_id" = s."movie_id" FROM "scenes" s WHERE s."scene_index" = c."scene_index";
--> statement-breakpoint

DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "episodes" WHERE "movie_id" IS NULL OR "bible_version_id" IS NULL)
		OR EXISTS (SELECT 1 FROM "rounds" WHERE "movie_id" IS NULL)
		OR EXISTS (SELECT 1 FROM "submissions" WHERE "movie_id" IS NULL)
		OR EXISTS (SELECT 1 FROM "scenes" WHERE "movie_id" IS NULL)
		OR EXISTS (SELECT 1 FROM "danmaku" WHERE "movie_id" IS NULL)
		OR EXISTS (SELECT 1 FROM "drafts" WHERE "movie_id" IS NULL)
		OR EXISTS (SELECT 1 FROM "ai_runs" WHERE "movie_id" IS NULL)
	THEN
		RAISE EXCEPTION 'multi-movie backfill left required movie_id values unresolved';
	END IF;
END
$$;
--> statement-breakpoint

ALTER TABLE "danmaku" DROP CONSTRAINT "danmaku_scene_index_scenes_scene_index_fk";
ALTER TABLE "episodes" DROP CONSTRAINT "episodes_theme_source_submission_id_submissions_id_fk";
ALTER TABLE "rounds" DROP CONSTRAINT "rounds_episode_id_episodes_id_fk";
ALTER TABLE "rounds" DROP CONSTRAINT "rounds_selected_submission_id_submissions_id_fk";
ALTER TABLE "scenes" DROP CONSTRAINT "scenes_episode_id_episodes_id_fk";
ALTER TABLE "scenes" DROP CONSTRAINT "scenes_round_id_rounds_id_fk";
ALTER TABLE "submissions" DROP CONSTRAINT "submissions_round_id_rounds_id_fk";
ALTER TABLE "submissions" DROP CONSTRAINT "submissions_episode_id_episodes_id_fk";
ALTER TABLE "episodes" DROP CONSTRAINT "episodes_episode_index_unique";
ALTER TABLE "rounds" DROP CONSTRAINT "rounds_round_index_unique";
ALTER TABLE "scenes" DROP CONSTRAINT "scenes_scene_index_unique";
ALTER TABLE "drafts" DROP CONSTRAINT "drafts_user_id_kind_pk";
DROP INDEX "danmaku_scene_index_offset_ms_idx";
DROP INDEX "scenes_episode_id_idx";
--> statement-breakpoint

ALTER TABLE "episodes" ALTER COLUMN "movie_id" SET NOT NULL;
ALTER TABLE "episodes" ALTER COLUMN "bible_version_id" SET NOT NULL;
ALTER TABLE "rounds" ALTER COLUMN "movie_id" SET NOT NULL;
ALTER TABLE "submissions" ALTER COLUMN "movie_id" SET NOT NULL;
ALTER TABLE "scenes" ALTER COLUMN "movie_id" SET NOT NULL;
ALTER TABLE "danmaku" ALTER COLUMN "movie_id" SET NOT NULL;
ALTER TABLE "drafts" ALTER COLUMN "movie_id" SET NOT NULL;
ALTER TABLE "ai_runs" ALTER COLUMN "movie_id" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "episodes" ADD CONSTRAINT "episodes_movie_index_uq" UNIQUE ("movie_id","episode_index");
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_id_movie_uq" UNIQUE ("id","movie_id");
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_movie_index_uq" UNIQUE ("movie_id","round_index");
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_id_episode_movie_uq" UNIQUE ("id","episode_id","movie_id");
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_id_movie_uq" UNIQUE ("id","movie_id");
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_movie_index_uq" UNIQUE ("movie_id","scene_index");
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_user_id_movie_id_kind_pk" PRIMARY KEY ("user_id","movie_id","kind");
--> statement-breakpoint

ALTER TABLE "episodes" ADD CONSTRAINT "episodes_movie_id_movies_id_fk" FOREIGN KEY ("movie_id") REFERENCES "movies"("id");
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_bible_movie_fk" FOREIGN KEY ("bible_version_id","movie_id") REFERENCES "movie_bible_versions"("id","movie_id");
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_movie_id_movies_id_fk" FOREIGN KEY ("movie_id") REFERENCES "movies"("id");
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_episode_movie_fk" FOREIGN KEY ("episode_id","movie_id") REFERENCES "episodes"("id","movie_id");
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_movie_id_movies_id_fk" FOREIGN KEY ("movie_id") REFERENCES "movies"("id");
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_episode_movie_fk" FOREIGN KEY ("episode_id","movie_id") REFERENCES "episodes"("id","movie_id");
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_round_episode_movie_fk" FOREIGN KEY ("round_id","episode_id","movie_id") REFERENCES "rounds"("id","episode_id","movie_id");
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_movie_id_movies_id_fk" FOREIGN KEY ("movie_id") REFERENCES "movies"("id");
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_episode_movie_fk" FOREIGN KEY ("episode_id","movie_id") REFERENCES "episodes"("id","movie_id");
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_round_episode_movie_fk" FOREIGN KEY ("round_id","episode_id","movie_id") REFERENCES "rounds"("id","episode_id","movie_id");
ALTER TABLE "danmaku" ADD CONSTRAINT "danmaku_movie_id_movies_id_fk" FOREIGN KEY ("movie_id") REFERENCES "movies"("id");
ALTER TABLE "danmaku" ADD CONSTRAINT "danmaku_scene_movie_fk" FOREIGN KEY ("scene_index","movie_id") REFERENCES "scenes"("scene_index","movie_id");
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_movie_id_movies_id_fk" FOREIGN KEY ("movie_id") REFERENCES "movies"("id");
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_movie_id_movies_id_fk" FOREIGN KEY ("movie_id") REFERENCES "movies"("id");
ALTER TABLE "workflow_jobs" ADD CONSTRAINT "workflow_jobs_movie_id_movies_id_fk" FOREIGN KEY ("movie_id") REFERENCES "movies"("id");
ALTER TABLE "contact_messages" ADD CONSTRAINT "contact_messages_movie_id_movies_id_fk" FOREIGN KEY ("movie_id") REFERENCES "movies"("id");
--> statement-breakpoint

-- Credit and source attribution must also remain within one movie.
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_theme_source_submission_movie_fk"
	FOREIGN KEY ("theme_source_submission_id","movie_id") REFERENCES "submissions"("id","movie_id") DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_selected_submission_movie_fk"
	FOREIGN KEY ("selected_submission_id","movie_id") REFERENCES "submissions"("id","movie_id") DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_source_submission_movie_fk"
	FOREIGN KEY ("source_submission_id","movie_id") REFERENCES "submissions"("id","movie_id");
--> statement-breakpoint

ALTER TABLE "contact_messages" ADD CONSTRAINT "contact_messages_movie_scene_ck"
	CHECK (("movie_id" IS NULL) = ("scene_index" IS NULL));
--> statement-breakpoint

CREATE UNIQUE INDEX "movie_bible_versions_one_active_uq" ON "movie_bible_versions" ("movie_id") WHERE "status" = 'active';
CREATE INDEX "movie_assets_movie_kind_idx" ON "movie_assets" ("movie_id","kind");
CREATE INDEX "movie_schedule_windows_lookup_idx" ON "movie_schedule_windows" ("generator_key","enabled","start_minute","end_minute");
CREATE INDEX "movies_public_display_idx" ON "movies" ("display_order","created_at") WHERE "status" = 'published';
CREATE UNIQUE INDEX "episodes_one_open_per_movie_uq" ON "episodes" ("movie_id") WHERE "status" = 'open';
CREATE UNIQUE INDEX "rounds_one_open_global_uq" ON "rounds" ((1)) WHERE "status" = 'open';
CREATE INDEX "scenes_movie_episode_id_idx" ON "scenes" ("movie_id","episode_id");
CREATE INDEX "danmaku_movie_scene_offset_ms_idx" ON "danmaku" ("movie_id","scene_index","offset_ms");
--> statement-breakpoint

DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crowdmovie_web') THEN
		GRANT SELECT ON "movies", "movie_bible_versions", "movie_characters",
			"movie_character_versions", "movie_assets", "movie_sources",
			"story_generators", "movie_schedule_windows" TO crowdmovie_web;
		GRANT INSERT, UPDATE ON "movie_sources" TO crowdmovie_web;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crowdmovie_worker') THEN
		GRANT SELECT, INSERT, UPDATE ON "movies", "movie_bible_versions",
			"movie_characters", "movie_character_versions", "movie_assets",
			"movie_sources", "story_generators", "movie_schedule_windows"
		TO crowdmovie_worker;
	END IF;
END
$$;
