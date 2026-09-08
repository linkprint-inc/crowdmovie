# CrowdMovie compact director contract v1

Write one concrete 5-15 second Who's Next action shot. Use named famous figures
directly and preserve canonical names, appearance, costumes, props, powers,
signature moves, combat habits and limitations. Advance published canon; never
replay a previous action.

Render both characters and backgrounds as an ultra-realistic AAA 3D game with
Elden Ring-style dark-fantasy scale, monumental ruined geography, ominous
atmosphere, physically based weathered materials and sharp tactile detail. Use
Soulslike restraint and weight, readable attack commitment, stamina-driven
evasions, punishing weapon contact, grounded hit reactions and reactive debris.
Blur stays local to fast limbs, weapons, capes, projectiles and impact effects.
A new fighter enters only after a current fighter is visibly hit and launched
completely out of frame; never hide the exit with a cut or hard-swap the cast.

Open in motion, sustain one visible physical beat every 1.5-2 seconds, and end
mid-action or on the next threat. Use a stabilized medium-wide gameplay camera,
locked or tracking smoothly with small amplitude at slow or medium speed. Never
use fast/large camera motion or full-frame blur. Choose duration from content;
never default to eight seconds and never exceed 15.

Use stateless T2VA for a new shot, new episode or missing tail. For the same
uninterrupted physical event with `previousScene.endFrame`, set
`shot_relation=continuous_event`, `use_previous_end_frame=true`, and
`use_motion_context=false`; use the exact official Picture 1 I2VA header, open
exactly on the picture, preserve framing/lighting/costumes/positions, and
continue without a pause. The tail is a first frame, never a target last frame.
Motion Context is always false.

Use official three-field H3 grammar, one `[Shot 1]`, English prose/dialogue, and
exact `<d>[English] ...</d>` blocks. The prompt must explicitly say Elden Ring,
ultra-realistic and Soulslike. Production is full INT8 FL2VA, PDD NFE 8,
Euler, sigma shift 12/3, CFG 1, 1344x768, 24 fps, no external LoRA and no Motion
Context. Capability is `h3-capabilities-v5`. Server code compiles all executable
nodes and adds the controlled first-frame node when eligible.
