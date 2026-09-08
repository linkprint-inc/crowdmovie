-- Make the proven clean PDD8 Spider-Man/Batman prompt the production quality
-- reference. The executable graph remains full INT8, NFE8 and LoRA-free.

UPDATE "movie_bible_versions"
SET "world_rules" = ("world_rules" - 'visualStyle' - 'actionStyle' - 'styleCutover') || '{
      "visualStyle":"crisp high-detail full-3D game characters in sharply readable layered arenas with concrete architecture, material and weather cues",
      "actionStyle":"ordered causal action beats, canonical signature moves, readable silhouettes, hard impacts and reactive debris with motion streaks localized to moving subjects",
      "qualityReference":"the exact eight-second Spider-Man and Batman rain-slick rooftop prompt is the first shot after reset and the density, clarity and structure benchmark for every later shot",
      "promptGrammar":"summary, detailed_description, overall_soundscape, non_diegetic_music"
    }'::jsonb,
    "style_prompt" = 'Use named famous figures directly and preserve canonical names, appearance, costumes, props, powers and signature moves. Match the successful Spider-Man and Batman rooftop reference: crisp high-detail full-3D game characters, a sharply readable layered arena, at least six concrete architecture or material cues, a stabilized medium-wide gameplay camera tracking slowly sideways, an ordered causal chain of canonical physical actions, strong silhouettes, hard impacts, reactive debris and only localized limb, cape, weapon and impact streaks. Explicitly state no full-frame motion blur, no depth-of-field blur, no fog wash and no camera shake. End mid-action. Use the four concise fields summary, detailed_description, overall_soundscape and non_diegetic_music. The first shot after a reset uses the exact eight-second reference prompt without rewriting. Choose every later duration from the actual action and dialogue between 5 and 15 seconds; never pad to a fixed duration. At most one adjacent I2VA continuation may follow a clean T2VA shot; then force a stateless T2VA quality reset.',
    "negative_prompt" = 'full-frame motion blur, depth-of-field blur, fog wash, camera shake, soft unreadable background, generic fighter placeholder, static face-off, floaty action, captions, subtitles, watermarks',
    "workflow_profile" = "workflow_profile" || '{
      "profile":"whos-next-v8",
      "styleProfile":"whos-next-spiderman-batman-quality-reference-v8",
      "promptGrammar":["summary","detailed_description","overall_soundscape","non_diegetic_music"],
      "firstShot":{"pinnedReference":true,"durationSeconds":8,"noiseSeed":81880001}
    }'::jsonb
WHERE "id" = '11000000-0000-4000-8000-000000000002';
--> statement-breakpoint

UPDATE "movie_sources"
SET "proposal_snapshot" = ("proposal_snapshot" - 'visualRule') || '{
      "seedVersion":10,
      "visualRule":"match the exact clean PDD8 Spider-Man and Batman rooftop prompt for crisp full-3D character identity, sharp layered backgrounds, stable camera and localized motion blur"
    }'::jsonb
WHERE "movie_id" = '10000000-0000-4000-8000-000000000002';
--> statement-breakpoint
