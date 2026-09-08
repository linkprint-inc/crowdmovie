-- Activate the clean full-INT8 PDD NFE8 workflow. Characters and environments
-- share Street Fighter 6-style 3D rendering; action combines SF6 readability
-- with Mortal Kombat 11 weight. Adjacent continuous shots may use only the
-- immediately previous published tail PNG as their I2VA first frame.

UPDATE "movie_bible_versions"
SET "world_rules" = ("world_rules" - 'backgroundDefault' - 'backgroundOverride') || '{
      "visualStyle":"all characters and environments use polished high-budget Street Fighter 6-style 3D fighting-game rendering",
      "actionStyle":"Street Fighter 6 silhouette and screen-direction clarity plus Mortal Kombat 11 grounded combinations, counters, contact force, hit-stop and reactive debris",
      "continuity":"same continuous physical event may use the immediately previous published tail PNG as I2VA first_frame; new shots and episodes use stateless T2VA; target last_frame and Motion Context are disabled"
    }'::jsonb,
    "style_prompt" = 'Use named famous figures directly and preserve canonical names, recognizable appearance, costumes, props, powers, signature moves, combat behavior and limitations. Render both characters and environments in a polished high-budget Street Fighter 6-style 3D fighting-game look. Build sharp readable arena geometry, materials, textures and spatial layers. Keep the background sharp during motion; streaks stay local to fast limbs, weapons, capes, projectiles and impact effects. Stage combat with Street Fighter 6 silhouette clarity, screen direction, spacing and impact graphics plus Mortal Kombat 11 grounded weight, close-range combinations, counter timing, contact force, hit-stop and reactive debris. Use a stabilized medium-wide gameplay camera, locked or tracking smoothly with small amplitude at slow or medium speed. Never use full-frame motion blur, fast or large-amplitude camera movement, radial zoom blur, fog or bokeh wash, camera shake, or shallow depth of field that hides the arena. Choose shot duration from the actual action and dialogue between 5 and 15 seconds; never default to eight seconds. Open in motion, sustain one visible physical beat every 1.5-2 seconds, and end mid-action or on an incoming threat.',
    "negative_prompt" = 'static face-off, prolonged slow motion, idle fighters, full-frame motion blur, radial zoom blur, fog wash, smeared bloom, bokeh wash, camera shake, shallow depth of field hiding the arena, captions, subtitles, watermarks',
    "camera_rules" = "camera_rules" || '{
      "baseline":"stabilized medium-wide gameplay camera",
      "motion":"locked or smooth small-amplitude tracking at slow or medium speed",
      "forbidden":"fast or large-amplitude camera motion, full-frame blur, radial zoom blur, fog or bokeh wash, camera shake, shallow depth of field hiding arena geometry"
    }'::jsonb,
    "workflow_profile" = '{
      "profile":"whos-next-v6",
      "styleProfile":"whos-next-street-fighter-6-mk11-kinetic-v6",
      "characterProfile":"whos-next-famous-cast-v3",
      "h3Capabilities":"h3-capabilities-v5",
      "engine":"minimax-h3-fl2va-pdd-acc-8nfe-full-int8-convrot",
      "model":"minimax_h3_fl2va_int8_convrot.safetensors",
      "textEncoder":"qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
      "pddFile":"MiniMax-H3-FL2VA-Acc-8Step.safetensors",
      "executionPort":8188,
      "controlledGatewayPort":8191,
      "resolution":[1344,768],
      "fps":24,
      "steps":8,
      "nfe":"8",
      "sampler":"euler",
      "sigmaShift":{"video":12,"audio":3},
      "guidance":1,
      "durationPolicy":{"mode":"content-driven","minSeconds":5,"maxSeconds":15,"fixedDefault":false},
      "continuation":"previous-published-tail-first-frame-i2va",
      "newShot":"stateless-t2va",
      "imageConditioning":{"firstFrame":true,"lastFrame":false},
      "motionContext":{"enabled":false},
      "externalLoras":{"enabled":false},
      "audioLocale":"en",
      "h3Prompt":{
        "mode":"T2VA/I2VA",
        "skill":"h3-prompt-writing",
        "skillRevision":"d21241f0a4b3acbb34c97dae47fa417b7065e438",
        "guide":"skills/h3-prompt-writing/references/base-en.txt",
        "fieldOrder":["integrated_multimodal_description","overall_soundscape","non_diegetic_music"],
        "durationSeconds":{"min":5,"max":15},
        "singleContinuousShot":true
      }
    }'::jsonb
WHERE "id" = '11000000-0000-4000-8000-000000000002';
--> statement-breakpoint

UPDATE "movie_sources"
SET "proposal_snapshot" = ("proposal_snapshot" - 'visualRule' - 'durationRule') || '{
      "seedVersion":8,
      "visualRule":"characters and environments use Street Fighter 6-style 3D fighting-game rendering; action combines Street Fighter 6 readability with Mortal Kombat 11 weight",
      "durationRule":"each shot follows actual content from 5 to 15 seconds; there is no fixed eight-second default",
      "continuityRule":"an adjacent continuous event may use the previous published tail PNG as its first frame; new shots are stateless"
    }'::jsonb
WHERE "movie_id" = '10000000-0000-4000-8000-000000000002';
--> statement-breakpoint
