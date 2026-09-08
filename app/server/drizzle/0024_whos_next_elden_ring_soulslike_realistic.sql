-- Switch the production art direction without changing the clean PDD8 graph.
-- The first shot after this cutover must establish a new ultra-realistic 3D
-- environment with stateless T2VA so the former fighting-game image cannot
-- contaminate the new dark-fantasy look through tail-frame conditioning.

UPDATE "movie_bible_versions"
SET "world_rules" = ("world_rules" - 'visualStyle' - 'actionStyle') || '{
      "visualStyle":"ultra-realistic AAA 3D game environments with Elden Ring-style dark-fantasy scale, monumental ruined geography, ominous atmosphere, physically based weathered materials and sharp tactile detail",
      "actionStyle":"Soulslike restraint and weight, readable attack commitment, stamina-driven evasions, punishing weapon contact, grounded hit reactions and reactive debris",
      "styleCutover":"the first shot whose previous H3 prompt lacks Elden Ring and Soulslike must change to a completely different environment and use stateless T2VA",
      "fighterExit":"a new fighter may enter only after one current fighter is visibly hit and launched completely out of frame; never hide the exit with a cut; the replacement enters afterward from offscreen or through the environment"
    }'::jsonb,
    "style_prompt" = 'Use named famous figures directly and preserve canonical names, recognizable appearance, costumes, props, powers, signature moves, combat behavior and limitations. Render both characters inside a completely realized, ultra-realistic AAA 3D game environment with Elden Ring-style dark-fantasy scale, monumental ruined geography, ominous atmosphere, physically based weathered materials and sharp tactile detail. Keep the environment sharply readable during motion; blur and streaks stay local to fast limbs, weapons, capes, projectiles and impact effects. Stage combat with Soulslike restraint and weight, readable attack commitment, stamina-driven evasions, punishing weapon contact, grounded hit reactions and reactive debris. A fighter leaves only after a visible hit launches them completely out of frame; never make a character vanish or hard-swap the cast, and introduce the replacement afterward from offscreen or through the environment. Use a stabilized medium-wide gameplay camera, locked or tracking smoothly with small amplitude at slow or medium speed. Never use full-frame motion blur, fast or large-amplitude camera movement, radial zoom blur, fog or bokeh wash, camera shake, or shallow depth of field that hides the environment. Choose shot duration from the actual action and dialogue between 5 and 15 seconds; never pad to a fixed duration. The first shot after this visual cutover must switch to a completely different ultra-realistic 3D game environment and use stateless T2VA without the previous tail frame.',
    "negative_prompt" = 'flat arcade arena, plastic materials, static face-off, floaty action, idle fighters, full-frame motion blur, radial zoom blur, fog wash, smeared bloom, bokeh wash, camera shake, shallow depth of field hiding the environment, captions, subtitles, watermarks',
    "workflow_profile" = "workflow_profile" || '{
      "profile":"whos-next-v7",
      "styleProfile":"whos-next-elden-ring-soulslike-realistic-v7",
      "styleCutover":{"newEnvironment":true,"mode":"stateless-t2va"}
    }'::jsonb
WHERE "id" = '11000000-0000-4000-8000-000000000002';
--> statement-breakpoint

UPDATE "movie_sources"
SET "proposal_snapshot" = ("proposal_snapshot" - 'visualRule') || '{
      "seedVersion":9,
      "visualRule":"ultra-realistic Elden Ring-style dark-fantasy 3D game environments with Soulslike restrained, heavy combat, material response and impact"
    }'::jsonb
WHERE "movie_id" = '10000000-0000-4000-8000-000000000002';
--> statement-breakpoint
