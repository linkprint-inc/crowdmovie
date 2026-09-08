-- Who's Next production visual/runtime policy v5.
--
-- The v4 H3 capability keeps PDD Acc 8-step at 1344x768, executes sampling
-- on ComfyUI 8188 through the controlled 8191 guard, and makes the pinned
-- 22/24-frame Motion Context path optional for adjacent continuous action.
-- Shot duration follows content (5-15s); legacy camera-plan suffixes do not
-- prescribe runtime. Backgrounds default to sharp 3D game environments.

UPDATE "movie_bible_versions"
SET "world_rules" = ("world_rules" - 'backgroundDefault') || '{
      "backgroundDefault":"crisp high-detail 3D game environment with sharp level geometry, readable spatial layers, high-frequency textures, physically readable materials and restrained atmosphere when the user gives no background-style direction"
    }'::jsonb,
    "style_prompt" = 'Keep each famous figure in its recognizable original appearance and source visual medium. Do not normalize the cast into one house style. A country-specific film or television figure keeps its canonical name in the original language and script in every creative prompt and field; write 葫芦娃, not an English translation or transliteration. Surrounding prose and spoken dialogue remain English. If the user gives no background-style direction, render only the environment as a crisp high-detail 3D game environment with sharp level geometry, readable spatial layers, high-frequency textures, physically readable materials, restrained atmosphere, and clear environmental interaction. Keep the background in focus while characters move; motion streaks stay local to moving subjects or props. Only an explicit background treatment in a human audience submission overrides that default. Shot duration follows the actual action content from 5 to 15 seconds, with no fixed duration default. Open already in motion and sustain one visible physical beat every 1.5-2 seconds with no idle face-off. Build each move through anticipation, explosive acceleration, hard impact and follow-through. Use a stabilized medium-wide gameplay camera as the baseline: lock it or track smoothly with small amplitude at slow or medium speed while subjects move rapidly. Never combine fast subject motion with a fast large-amplitude push, pull, orbit or whip pan. The legacy repertoire from 00-control-static-camera-8s through 07-speed-ramp-5s may inform spatial intent, but its numeric suffixes and speed recipes never fix duration or override background readability. End mid-action or on an incoming threat.',
    "negative_prompt" = 'source frames, raw copied artwork assets, franchise logos, source recordings, source music, celebrity voice imitation, cloned actor voice, captions, subtitles, watermarks, blood, gore, static face-off, prolonged slow motion, idle fighters, full-frame motion blur, radial zoom blur, fog wash, smeared bloom, bokeh wash, shallow depth of field hiding the 3D game background',
    "camera_rules" = ("camera_rules" - 'durationBinding') || '{
      "durationPolicy":"content-driven from 5 to 15 seconds; no fixed default",
      "durationBinding":"none; numeric camera-plan suffixes are legacy repertoire labels only",
      "stabilizationPriority":"background readability overrides camera speed and amplitude"
    }'::jsonb,
    "workflow_profile" = jsonb_set(
      "workflow_profile" || '{
        "profile":"whos-next-v5",
        "styleProfile":"whos-next-3d-game-kinetic-v5",
        "characterProfile":"whos-next-free-cast-v2",
        "h3Capabilities":"h3-capabilities-v4",
        "engine":"minimax-h3-fl2va-pdd-acc-8step-int8-convrot",
        "executionPort":8188,
        "controlledGatewayPort":8191,
        "resolution":[1344,768],
        "steps":8,
        "continuation":"adjacent-published-motion-context-v0.5.1",
        "newShot":"stateless-t2va",
        "durationPolicy":{"mode":"content-driven","minSeconds":5,"maxSeconds":15},
        "motionContext":{"enabled":true,"optional":true,"pluginVersion":"0.5.1","contextLength":22,"audioContextLength":24,"matchTail":true},
        "combatLora":"H3_Combat_V2.safetensors",
        "combatLoraStrength":0.6,
        "combatTrigger":"prfight2",
        "audioLocale":"en"
      }'::jsonb,
      '{h3Prompt,durationSeconds}',
      '{"min":5,"max":15}'::jsonb,
      true
    )
WHERE "id" = '11000000-0000-4000-8000-000000000002';
--> statement-breakpoint

UPDATE "movie_sources"
SET "proposal_snapshot" = ("proposal_snapshot" - 'visualRule' - 'durationRule') || '{
      "seedVersion":7,
      "visualRule":"characters retain their famous source appearance; only an unspecified environment defaults to a crisp high-detail 3D game background with sharp readable geometry; explicit human background direction wins",
      "durationRule":"each shot follows its actual action content from 5 to 15 seconds; camera-plan numeric suffixes do not set duration"
    }'::jsonb
WHERE "movie_id" = '10000000-0000-4000-8000-000000000002';
--> statement-breakpoint

-- Reset only AI-authored open themes. Human-selected themes remain authoritative.
UPDATE "episodes"
SET "theme" = regexp_replace(
      "theme",
      'polished high-end 3D background style of a recent Pixar theatrical feature',
      'crisp high-detail 3D game environment with sharp readable level geometry',
      'gi'
    )
WHERE "movie_id" = '10000000-0000-4000-8000-000000000002'
  AND "status" = 'open'
  AND "theme_source_submission_id" IS NULL
  AND "theme" ~* 'recent Pixar theatrical feature';
