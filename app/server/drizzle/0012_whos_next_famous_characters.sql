-- Who's Next open-brawl policy v2.
--
-- The only story rule is a free-for-all among famous figures from movies,
-- games, animation, comics, history and fine art. There is no fixed cast or
-- venue. Famous figures retain their source appearance; only an unspecified
-- background defaults to the existing 3D comic action look. Terra deletes only
-- meaningless text and keeps every meaningful submission publicly recoverable.

UPDATE "movies"
SET "synopsis_i18n" = '{"zh-CN":"著名的电影、游戏、动画、漫画、历史和美术人物在任意时空大乱斗；人物保持原版著名形象，背景未指定时采用 3D 漫画动作风。观众投稿也可以加入自创人物。","en":"Famous figures from movies, games, animation, comics, history and fine art collide anywhere. Figures keep their iconic source appearance; unspecified backgrounds use the 3D comic-action look. Audience pitches may add original figures.","ja":"映画・ゲーム・アニメ・漫画・歴史・美術の有名人物が、時代も場所も問わず大乱闘。人物は原作で知られる姿を保ち、背景指定がなければ3Dコミック・アクション調になります。投稿にはオリジナル人物も追加できます。","es":"Figuras famosas del cine, videojuegos, animación, cómic, historia y arte luchan en cualquier lugar. Conservan su aspecto original; si no se indica el fondo, se usa el estilo de acción 3D tipo cómic. Las propuestas pueden añadir figuras originales."}'::jsonb,
    "updated_at" = now()
WHERE "id" = '10000000-0000-4000-8000-000000000002';
--> statement-breakpoint

UPDATE "movie_bible_versions"
SET "story_rules" = '{"oneRule":"famous figures from movies, games, animation, comics, history and fine art collide in an unrestricted free-for-all; audience pitches may add original figures"}'::jsonb,
    "world_rules" = '{
      "cast":"no fixed or mandatory resident characters",
      "location":"unrestricted",
      "period":"unrestricted",
      "lore":"none required",
      "characterVisuals":"each famous figure keeps its recognizable original appearance and source visual medium",
      "backgroundDefault":"stylized 3D comic/game-cinematic action environment only when the user gives no background-style direction",
      "backgroundOverride":"an explicit user background treatment overrides the default; mixed media are allowed",
      "language":"English primary audio",
      "bible":"workstation/movie/world-bible.md"
    }'::jsonb,
    "style_prompt" = 'Keep each famous figure in its recognizable original appearance and source visual medium. Do not normalize the cast into one house style. If the user gives no background-style direction, render only the environment as an original stylized 3D comic/game cinematic with clean matte forms, arcade impact flashes, dust, speed lines and chunky readable debris. An explicit user background treatment overrides that default. Locations, periods, lighting and mixed media are unrestricted.',
    "negative_prompt" = 'source frames, raw copied artwork assets, franchise logos, source recordings, source music, celebrity voice imitation, cloned actor voice, captions, subtitles, watermarks, blood, gore',
    "workflow_profile" = "workflow_profile" || '{"profile":"whos-next-v2","styleProfile":"whos-next-mixed-media-v2","characterProfile":"whos-next-free-cast-v2","audioLocale":"en"}'::jsonb
WHERE "id" = '11000000-0000-4000-8000-000000000002';
--> statement-breakpoint

UPDATE "movie_sources"
SET "proposal_snapshot" = "proposal_snapshot" || '{
      "seedVersion":4,
      "storyRule":"famous movie, game, animation, comic, history and fine-art figures in an unrestricted free-for-all; audience originals allowed",
      "visualRule":"characters retain their famous source appearance; only an unspecified background defaults to 3D comic action",
      "scoringRule":"meaningful plus any famous figure is eligible; every meaningful row is visible; only meaningless content is deleted"
    }'::jsonb
WHERE "movie_id" = '10000000-0000-4000-8000-000000000002';
--> statement-breakpoint

-- The former announcer, referee, stunt volunteer and vendor stay in history for
-- rollback and referential integrity, but no longer appear in the active cast.
UPDATE "movie_characters"
SET "status" = 'retired'
WHERE "movie_id" = '10000000-0000-4000-8000-000000000002';
--> statement-breakpoint

-- A long-lived director thread may remember the former fixed cast, city block
-- and forced 3D character treatment. Start the next content turn from v2 files.
DELETE FROM "site_settings" WHERE "key" = 'codex_director_thread_id';
