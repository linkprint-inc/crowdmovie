---
name: crowdmovie-short-drama-director
description: Direct Who's Next episode outlines, public next-shot pitches and concrete 5-15 second H3 action shots for an unrestricted famous-figure crossover brawl. Use for CrowdMovie story development, scoring, finalization and shot writing.
---

# CrowdMovie Short-Drama Director

Use this skill only for CrowdMovie. Caller-supplied PostgreSQL facts are current
canon. Obey the current world/style/character Bibles and capability manifests.

## Story rule

Named famous figures from movies, games, animation, comics, history and fine art
can fight each other anywhere. Use them directly. Preserve canonical names,
recognizable appearance, costumes, props, powers, named techniques, combat habits
and limitations. A selected audience pitch may add an original figure; preserve
it. There is no fixed cast, referee, venue, era or lore.

Never invent plot props to carry the fight. Keys, shards, crystals, orbs, gems,
relics, artifacts, energy cores and mystery devices are forbidden unless a
human audience submission explicitly requests one. Use direct fighter-versus-
fighter attack, defense, dodge, counter, impact and launch-out instead. Canonical
signature equipment that belongs to the named figure remains allowed.

Qwen eligibility is true exactly when a pitch is meaningful and contains at
least one famous figure. Keep all meaningful pitches visible and delete only
meaningless ones.

## Write one generation

Use the causal methods and state contract in `../../movie/director-brief-v3.md`
for current production. Write one 5–15 second event with a principal result,
1–3 purposeful camera shots and at most five causal beats. An action has an
actor, direction, contact or clearance, reciprocal reaction, material response,
visible outcome and sound. Choose a stable camera path to reveal that outcome.
Allow a short reaction or result hold where it earns its time. Consume the
preceding consequence; do not repeat the same hit—edge—recover cycle.

## Visual and action style

- Match the successful Spider-Man/Batman rooftop reference: crisp high-detail
  full-3D game characters, a sharply readable layered arena, concrete
  architecture/material cues, a purposefully framed stabilized camera and an
  ordered chain of causal physical actions.
- Keep canonical character identity and signature abilities recognizable.
- Keep the dramatic focus on direct character combat, not collecting,
  protecting, breaking or transferring an AI-invented object.
- Keep level geometry, spatial layers, materials and textures sharp during
  movement. Blur and streaks stay localized to moving limbs, weapons, capes and
  impact effects. Explicitly forbid full-frame motion blur, depth-of-field blur,
  fog wash and camera shake.
- Film every departure and arrival as a connected physical journey: origin,
  canonical travel mechanism, route, force/contact, environmental response and
  final position. A flight close-up may show approach; match screen direction
  and a landmark when cutting to the wide landing. Keep at most two active
  fighters; a newcomer may approach outside the fight but cannot interfere
  until a current fighter visibly exits. Never hard-swap or hide an exit.

## Current H3 production contract

v6 uses film-plan-v1, scene-director-v2 and whos-next-causal-cg-v1. The server
enforces an 8000-English-word ceiling for the plan and compiled prompt, not a
minimum. Each arrival/exit beat supplies a structured passage. The server
compiles ordered shots, cuts and exact dialogue; the director never copies
workflow nodes. T2VA resets preserve the same structured world state. Retain
costume, held objects, persistent damage and exits. Planned states are not
observations. Use the methods in director-brief-v3 rather than appending template
adjectives. The two-fighter, canonical-ability and fixed Acc 8 Step constraints
below remain in force. Four-section format is the initial default; the official
three-field format is an explicit experiment, not an unmeasured quality claim.

## Archived v5 prompt grammar (legacy jobs only)

These formatting and fixed-first-shot rules apply only to v5 replay, not v6:


- T2VA uses exactly `summary`, `detailed_description`, `overall_soundscape`,
  and `non_diegetic_music` in that order.
- The first shot after a reset is the exact eight-second Spider-Man/Batman
  rooftop reference and is not rewritten. Later shots choose 5-15 seconds from
  their actual content while matching its concise specificity.
- For the same continuous physical event, when `previousScene.endFrame` exists,
  set `shot_relation=continuous_event`, `use_previous_end_frame=true` and
  `use_motion_context=false`. Start with the exact official Picture 1 I2VA
  alignment line. Say the shot opens exactly on `<Picture 1>`, preserves its
  framing, lighting, costumes and positions, and the action continues without a
  pause.
- A new shot, new episode or missing end frame uses stateless T2VA with both
  booleans false and no Picture reference.
- If the previous H3 prompt already begins with the Picture 1 I2VA alignment
  header, force a stateless T2VA reset; never chain I2VA into I2VA.
- Keep at most two active fighters. A third figure's weapon, projectile, voice,
  silhouette, or offscreen power counts as an entrance and is forbidden until
  a current fighter is visibly struck and launched completely out of frame.
- Motion Context and target `last_frame` conditioning are disabled.
- Use 1344x768, 24 fps, the full INT8 FL2VA checkpoint, PDD NFE 8, Euler, sigma
  shift 12/3 and CFG 1. External LoRAs and Combat triggers are disabled.
- The server compiles graph nodes. Qwen supplies creative fields and a schema
  placeholder only; it does not choose arbitrary models, files or nodes.

All surrounding prose and spoken dialogue are English, except canonical names
that use another script. Each `dialogue_en` line appears exactly once and in
order inside `<d>[English] ...</d>`. Numeric production timing stays in
structured fields; prompt actions use relative timing.

## Self-review

- One action shot, one readable physical change, 5-15 content-driven seconds.
- Every selected figure and signature ability remains recognizable.
- The prompt matches the reference's concrete background density, stable
  camera, ordered action, local blur and explicit anti-blur constraints.
- The environment stays sharp while motion effects remain local.
- Tail I2VA appears only for an eligible continuous event; Motion Context and
  target last frame never appear.
- Dialogue, duration, workflow length and prompt agree with each other.
- Output matches the caller's exact schema.
