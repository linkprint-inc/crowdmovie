-- Who's Next live-action kinetic visual policy v3.
--
-- Famous figures retain their source appearance and user-directed background
-- styles still win. Only an unspecified environment changes from the former 3D
-- comic fallback to realistic live-action cinema. Default action now uses dense
-- physical beats and a low-risk single-axis tracking rush.

UPDATE "movies"
SET "synopsis_i18n" = '{"zh-CN":"著名的电影、游戏、动画、漫画、历史和美术人物在任意时空大乱斗；人物保持原版著名形象，背景未指定时采用现实动作电影风格，动作高速迅猛。观众投稿也可以加入自创人物。","en":"Famous figures from movies, games, animation, comics, history and fine art collide anywhere. Figures keep their iconic source appearance; unspecified environments use realistic live-action action-cinema treatment with fast, forceful movement. Audience pitches may add original figures.","ja":"映画・ゲーム・アニメ・漫画・歴史・美術の有名人物が、時代も場所も問わず大乱闘。人物は原作で知られる姿を保ち、背景指定がなければ実写アクション映画調の環境で高速かつ力強く動きます。投稿にはオリジナル人物も追加できます。","es":"Figuras famosas del cine, videojuegos, animación, cómic, historia y arte luchan en cualquier lugar. Conservan su aspecto original; si no se indica el entorno, se usa un tratamiento de cine de acción realista con movimiento rápido y contundente. Las propuestas pueden añadir figuras originales."}'::jsonb,
    "updated_at" = now()
WHERE "id" = '10000000-0000-4000-8000-000000000002';
--> statement-breakpoint

UPDATE "movie_bible_versions"
SET "world_rules" = "world_rules" || '{
      "backgroundDefault":"realistic live-action cinematic environment with physically grounded lighting, practical textures, atmospheric depth and interactive debris when the user gives no background-style direction",
      "backgroundOverride":"an explicit user background treatment overrides the default; mixed media are allowed",
      "actionDefault":"open already in motion; one visible physical beat every 1.5-2 seconds; anticipation, explosive burst with visible speed evidence, impact and follow-through; end with active momentum",
      "cameraDefault":"prefer an 8-second single-axis high-speed tracking rush along the main direction of travel unless the action motivates another dominant camera move"
    }'::jsonb,
    "style_prompt" = 'Keep each famous figure in its recognizable original appearance and source visual medium. Do not normalize the cast into one house style. If the user gives no background-style direction, render only the environment as realistic live-action cinema with practical textures, physically grounded lighting, atmospheric depth, natural particles and interactive debris. An explicit user background treatment overrides that default. Open already in motion and sustain one visible physical beat every 1.5-2 seconds with no idle face-off. Build each move through anticipation, explosive acceleration with visible speed evidence, hard impact and follow-through. Use one dominant camera idea in official motion type plus amplitude plus speed grammar. Prefer an 8-second single-axis high-speed tracking rush unless the action needs another move. End mid-action or on an incoming threat.',
    "negative_prompt" = 'source frames, raw copied artwork assets, franchise logos, source recordings, source music, celebrity voice imitation, cloned actor voice, captions, subtitles, watermarks, blood, gore, static face-off, prolonged slow motion, idle fighters',
    "camera_rules" = "camera_rules" || '{"defaultPlan":"01-tracking-rush-8s","dominantIdeaCount":1,"supportingImpactAccentMaximum":2,"grammar":"motion type plus amplitude plus speed","opening":"already in motion","beatCadenceSeconds":"1.5-2","ending":"mid-action or incoming threat"}'::jsonb,
    "workflow_profile" = "workflow_profile" || '{"profile":"whos-next-v3","styleProfile":"whos-next-live-action-kinetic-v3","characterProfile":"whos-next-free-cast-v2","audioLocale":"en"}'::jsonb
WHERE "id" = '11000000-0000-4000-8000-000000000002';
--> statement-breakpoint

UPDATE "movie_sources"
SET "proposal_snapshot" = "proposal_snapshot" || '{
      "seedVersion":5,
      "visualRule":"characters retain their famous source appearance; only an unspecified environment defaults to realistic live-action action cinema",
      "actionRule":"start in motion, sustain a visible physical beat every 1.5-2 seconds, use a motivated high-speed camera move, and end with active momentum",
      "defaultCamera":"01-tracking-rush-8s: single-axis high-speed tracking along the main direction of travel"
    }'::jsonb
WHERE "movie_id" = '10000000-0000-4000-8000-000000000002';
--> statement-breakpoint

-- A persistent director thread may retain the former 3D background fallback or
-- static staging habits. Start the next content turn from the v3 trusted files.
DELETE FROM "site_settings" WHERE "key" = 'codex_director_thread_id';
