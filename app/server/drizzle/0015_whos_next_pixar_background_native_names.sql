-- Who's Next visual policy v4.
--
-- Characters retain their source appearance. Only an unspecified environment
-- takes the recent-Pixar-feature 3D default, while explicit human direction
-- still wins. Country-specific film and television names stay in their
-- canonical original language and script. Camera plans are selected per action
-- from the complete 00-07 repertoire rather than pinning 01 globally.

UPDATE "movies"
SET "synopsis_i18n" = '{"zh-CN":"著名的电影、游戏、动画、漫画、历史和美术人物在任意时空大乱斗；人物保持原版著名形象，国家特有影视角色保留原语言名称。背景未指定时采用皮克斯近期院线动画电影式的高品质 3D 背景，用户指定的背景风格优先，动作高速迅猛。观众投稿也可以加入自创人物。","en":"Famous figures from movies, games, animation, comics, history and fine art collide anywhere. Figures keep their iconic source appearance, and country-specific film and television characters keep their canonical original-language names. Unspecified environments use the polished high-end 3D background style of a recent Pixar theatrical feature; an explicit user style wins. Movement stays fast and forceful, and audience pitches may add original figures.","ja":"映画・ゲーム・アニメ・漫画・歴史・美術の有名人物が、時代も場所も問わず大乱闘。人物は原作で知られる姿を保ち、各国固有の映画・テレビ人物名は原語表記を維持します。背景指定がなければピクサーの近年の劇場アニメ映画のような高品質 3D 背景を使い、ユーザー指定の背景スタイルを優先します。動きは高速で力強く、投稿にはオリジナル人物も追加できます。","es":"Figuras famosas del cine, videojuegos, animación, cómic, historia y arte luchan en cualquier lugar. Conservan su aspecto original y los personajes cinematográficos o televisivos propios de un país mantienen su nombre canónico en la lengua original. Si no se indica el entorno, se usa un fondo 3D pulido al estilo de un largometraje reciente de Pixar; prevalece el estilo explícito del usuario. El movimiento sigue siendo rápido y contundente, y las propuestas pueden añadir figuras originales."}'::jsonb,
    "updated_at" = now()
WHERE "id" = '10000000-0000-4000-8000-000000000002';
--> statement-breakpoint

UPDATE "movie_bible_versions"
SET "world_rules" = ("world_rules" - 'backgroundDefault' - 'backgroundOverride' - 'cameraDefault' - 'namingRule') || '{
      "backgroundDefault":"polished high-end 3D background style of a recent Pixar theatrical feature, with expressive production design, cinematic lighting, rich materials, atmospheric depth and interactive debris, when the user gives no background-style direction",
      "backgroundOverride":"only an explicit background treatment in a human audience submission overrides the default; AI-authored outlines, pitches, shots and thread memory do not",
      "namingRule":"country-specific film and television figures keep their canonical name in the original language and script in every creative prompt and field; write 葫芦娃, not an English translation or transliteration; surrounding prose and spoken dialogue remain English",
      "actionDefault":"open already in motion; one visible physical beat every 1.5-2 seconds; anticipation, explosive burst with visible speed evidence, impact and follow-through; end with active momentum",
      "cameraSelection":"select exactly one action-motivated plan from the full 00-07 repertoire; no plan is the global default"
    }'::jsonb,
    "style_prompt" = 'Keep each famous figure in its recognizable original appearance and source visual medium. Do not normalize the cast into one house style. A country-specific film or television figure keeps its canonical name in the original language and script in every creative prompt and field; write 葫芦娃, not an English translation or transliteration. Surrounding prose and spoken dialogue remain English. If the user gives no background-style direction, render only the environment in the polished high-end 3D background style of a recent Pixar theatrical feature, with expressive production design, cinematic lighting, rich materials, atmospheric depth, natural particles and interactive debris. Only an explicit background treatment in a human audience submission overrides that default. Open already in motion and sustain one visible physical beat every 1.5-2 seconds with no idle face-off. Build each move through anticipation, explosive acceleration with visible speed evidence, hard impact and follow-through. Use one dominant camera idea in official motion type plus amplitude plus speed grammar. Select exactly one action-motivated plan from 00-control-static-camera-8s, 01-tracking-rush-8s, 02-whip-pan-8s, 03-fast-orbit-8s, 04-push-in-impact-8s, 05-pov-5s, 06-crane-dive-8s or 07-speed-ramp-5s; no plan is the global default. End mid-action or on an incoming threat.',
    "camera_rules" = ("camera_rules" - 'defaultPlan') || '{
      "planSelection":"exactly one action-motivated plan per shot; no global default",
      "plans":{
        "00-control-static-camera-8s":"locked frame for clearly readable high-speed subject movement, never an idle face-off",
        "01-tracking-rush-8s":"linear pursuit or travel",
        "02-whip-pan-8s":"rapid lateral reversals",
        "03-fast-orbit-8s":"circling melee",
        "04-push-in-impact-8s":"one decisive collision",
        "05-pov-5s":"subjective incoming impact or knockback",
        "06-crane-dive-8s":"vertical flight or diving",
        "07-speed-ramp-5s":"one brief isolated speed-contrast beat"
      },
      "dominantIdeaCount":1,
      "supportingImpactAccentMaximum":2,
      "grammar":"motion type plus amplitude plus speed",
      "opening":"already in motion",
      "beatCadenceSeconds":"1.5-2",
      "ending":"mid-action or incoming threat"
    }'::jsonb,
    "workflow_profile" = "workflow_profile" || '{"profile":"whos-next-v4","styleProfile":"whos-next-pixar-feature-kinetic-v4","characterProfile":"whos-next-free-cast-v2","h3Capabilities":"h3-capabilities-v3","engine":"minimax-h3-fl2va-pdd-acc-8step-int8-convrot","continuation":"previous-published-end-frame-i2va","newShot":"stateless-t2va","combatLora":"H3_Combat_V2.safetensors","combatLoraStrength":0.6,"combatTrigger":"prfight2","audioLocale":"en"}'::jsonb
WHERE "id" = '11000000-0000-4000-8000-000000000002';
--> statement-breakpoint

UPDATE "movie_sources"
SET "proposal_snapshot" = ("proposal_snapshot" - 'visualRule' - 'defaultCamera' - 'namingRule') || '{
      "seedVersion":6,
      "visualRule":"characters retain their famous source appearance; only an unspecified environment defaults to the polished high-end 3D background style of a recent Pixar theatrical feature; explicit human background direction wins",
      "namingRule":"country-specific film and television figures retain canonical original-language names and scripts, for example 葫芦娃",
      "actionRule":"start in motion, sustain a visible physical beat every 1.5-2 seconds, select one action-motivated camera plan from 00-07, and end with active momentum",
      "cameraRule":"select exactly one of 00-control-static-camera-8s through 07-speed-ramp-5s for the action; no global default"
    }'::jsonb
WHERE "movie_id" = '10000000-0000-4000-8000-000000000002';
--> statement-breakpoint

-- Reset stale AI-authored open themes so they cannot override the new fallback.
-- Human-sourced episode themes remain authoritative and are deliberately untouched.
UPDATE "episodes"
SET "theme" = regexp_replace(
      regexp_replace(
        "theme",
        'realistic live-action (cinematic treatment|cinema)',
        'polished high-end 3D background style of a recent Pixar theatrical feature',
        'gi'
      ),
      'stylized 3D comic/game-cinematic background treatment',
      'polished high-end 3D background style of a recent Pixar theatrical feature',
      'gi'
    )
WHERE "movie_id" = '10000000-0000-4000-8000-000000000002'
  AND "status" = 'open'
  AND "theme_source_submission_id" IS NULL
  AND (
    "theme" ~* 'realistic live-action (cinematic treatment|cinema)'
    OR "theme" ~* 'stylized 3D comic/game-cinematic background treatment'
  );
--> statement-breakpoint

-- Remove the obsolete persistent-thread cursor. Every scene now starts an
-- isolated director thread from a complete v4 Markdown brief.
DELETE FROM "site_settings" WHERE "key" = 'codex_director_thread_id';
