-- Re-seed the second launch movie as Who's Next, an English-language absurd
-- hero-brawl action comedy. drizzle/0007 seeded this slot as a Mandarin
-- workplace comedy; the movie, bible, characters, character versions and
-- schedule windows keep their deterministic 0007 identifiers so application
-- constants, tests and media paths keyed by movie id stay valid. Data only:
-- production has no episodes, scenes or media for this movie, and it stays
-- production_status=blocked / rights_status=blocked until the house-cast
-- assets, English voice profiles and the guest-hero rights review exist. The
-- English source bible lives in workstation/movies/whos-next/.

UPDATE "movies"
SET "slug" = 'whos-next',
    "title_i18n" = '{"zh-CN":"下一个上场","en":"Who''s Next","ja":"次は誰だ","es":"¿Quién sigue?"}'::jsonb,
    "synopsis_i18n" = '{"zh-CN":"所有超级英雄、动作英雄和漫画英雄挤在同一个街区，打个不停。观众决定下一个上场的是谁、用什么打。","en":"Every superhero, action hero and comic-book hero is on one city block, and they will not stop fighting. The audience picks who fights next and what they fight with."}'::jsonb,
    "default_locale" = 'en',
    "primary_audio_locale" = 'en',
    "subtitle_locales" = '["en","zh-CN","ja","es"]'::jsonb,
    "updated_at" = now()
WHERE "id" = '10000000-0000-4000-8000-000000000002';
--> statement-breakpoint

UPDATE "movie_bible_versions"
SET "story_rules" = '{"engine":"crowd_continuation","premise":"every superhero, action hero and comic hero on one city block, fighting nonstop; no lore, no origin, no reason","houseCast":["announcer","referee","rookie","vendor"],"everyShotIsAction":true,"shotRule":"every shot shows at least one hit, throw, dodge, crash or stunt; no dialogue-only shots; talking happens mid-action","guestPolicy":"named fictional heroes are rebuilt in the house look, keep canon powers and personality but never canon plot, and never appear without a house cast member","rule":"absurd cartoon-safe action comedy only; nobody dies; no real people, no source footage, audio, music, logos or actor likeness"}'::jsonb,
    "world_rules" = '{"setting":"the Block, one original city block that gets wrecked every episode and rebuilt by the next","locations":["Diner","Parking Garage","Construction Site","Bus Stop","Vending Alley","Rooftop","Hardware Store","Snack Cart"],"physics":"powers work, physics does not; anything is a weapon; nobody dies and everyone gets back up","language":"English primary audio","bible":"workstation/movies/whos-next/world-bible.md"}'::jsonb,
    "style_prompt" = 'Original stylized 3D game cinematic, graphic proportions, clean matte materials, bright midday city-block lighting, arcade fighting-game impact flashes and dust, four distinct original house silhouettes, every guest hero rebuilt in the same house proportions, expressive but non-photoreal faces, absurd action comedy.',
    "negative_prompt" = 'photoreal actors, celebrity likeness, cloned voice, copied franchise artwork, source footage, franchise logos, recognizable source music, blood, gore, identity drift, costume drift',
    "camera_rules" = '{"defaultShot":"new_shot","continuousEventRequiresExplicitApproval":true,"axisRule":"preserve screen direction within event"}'::jsonb,
    "workflow_profile" = "workflow_profile" || '{"profile":"whos-next-v1","audioLocale":"en"}'::jsonb
WHERE "id" = '11000000-0000-4000-8000-000000000002';
--> statement-breakpoint

UPDATE "movie_sources"
SET "proposal_snapshot" = '{"source":"staff_original","seedVersion":2,"rightsRule":"original house look and non-imitative English voices only; guest heroes gated by rights review"}'::jsonb
WHERE "movie_id" = '10000000-0000-4000-8000-000000000002';
--> statement-breakpoint

UPDATE "movie_characters"
SET "character_key" = 'announcer',
    "public_copy_i18n" = '{"zh-CN":{"name":"达斯蒂·马龙","role":"擂台播报员","bio":"站在每场架的正中间从不被打到，三个字一句地解说，经常解说错场。"},"en":{"name":"Dusty Malone","role":"Ring announcer","bio":"Stands in the middle of every fight, never gets touched, and calls the action three words at a time, usually the wrong fight."}}'::jsonb
WHERE "id" = '12000000-0000-4000-8000-000000000101';
UPDATE "movie_characters"
SET "character_key" = 'referee',
    "public_copy_i18n" = '{"zh-CN":{"name":"本尼·惠斯尔","role":"裁判","bio":"规则每一镜都在变，每次有人倒地他都读秒，最后总是被埋在瓦砾里。"},"en":{"name":"Benny Whistle","role":"Referee","bio":"Enforces rules that change every shot, counts to ten over every knockdown, and ends up under the rubble."}}'::jsonb
WHERE "id" = '12000000-0000-4000-8000-000000000102';
UPDATE "movie_characters"
SET "character_key" = 'rookie',
    "public_copy_i18n" = '{"zh-CN":{"name":"加里队长","role":"菜鸟英雄","bio":"唯一没有真正超能力的英雄：一条浴巾披风加略高于常人的力气。被扔进每一场架，总是第一个爬起来。"},"en":{"name":"Captain Gary","role":"Rookie hero","bio":"The only hero with no real powers: a towel cape and slightly above-average strength. Gets thrown into every fight and always gets back up first."}}'::jsonb
WHERE "id" = '12000000-0000-4000-8000-000000000103';
UPDATE "movie_characters"
SET "character_key" = 'vendor',
    "public_copy_i18n" = '{"zh-CN":{"name":"卢佩·萨尔加多","role":"小吃车老板","bio":"卖的小吃会随机给人五秒钟的超能力，她从来不抬头看架。"},"en":{"name":"Lupe Salgado","role":"Snack cart vendor","bio":"Sells the snacks that grant random five-second superpowers and never once looks up from the grill."}}'::jsonb
WHERE "id" = '12000000-0000-4000-8000-000000000104';
--> statement-breakpoint

UPDATE "movie_character_versions" v
SET "visual_identity" = v."visual_identity" || jsonb_build_object('silhouetteKey', c."character_key"),
    "voice_profile" = v."voice_profile" || '{"locale":"en"}'::jsonb
FROM "movie_characters" c
WHERE c."id" = v."character_id"
  AND v."movie_id" = '10000000-0000-4000-8000-000000000002';
--> statement-breakpoint

UPDATE "movie_schedule_windows"
SET "label" = 'Who''s Next · 夜间'
WHERE "generator_key" = 'primary'
  AND "id" IN (
    '13000000-0000-4000-8000-000000000001',
    '13000000-0000-4000-8000-000000000003'
  );
