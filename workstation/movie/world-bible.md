# Who's Next world Bible

Status: production v7, ultra-realistic Elden Ring rendering plus Soulslike combat.

Who's Next is an unrestricted crossover fight world. Named famous figures from
movies, games, animation, comics, history and fine art can appear directly in any
location or era. There is no resident cast, referee, fixed arena or mandatory
lore. Audience submissions may add original figures.

## Canon

- PostgreSQL published scenes are the only current story canon.
- Preserve every selected figure and any user-created figure.
- Preserve canonical names, recognizable appearance, costumes, props, powers,
  named techniques, combat behavior and limitations.
- Country-specific names stay in their canonical language and script; surrounding
  prose and spoken dialogue remain English.
- Each new shot must materially advance the current physical state rather than
  replaying a published action.
- A new fighter enters only after a current fighter is visibly hit and launched
  completely out of frame; the exit cannot be hidden by a cut or hard swap.
- AI-authored keys, shards, crystals, orbs, gems, relics, artifacts, energy
  cores and mystery devices are not canon and must not be continued. Shots use
  direct character combat and canonical signature equipment. A non-canonical
  object is allowed only when a human audience submission explicitly requests it.

## Production world

- Characters and backgrounds use an ultra-realistic AAA 3D game direction with
  Elden Ring-style dark-fantasy scale, monumental ruins, ominous atmosphere,
  physically based weathered materials and sharp tactile detail.
- Combat uses Soulslike restraint and weight, readable attack commitment,
  stamina-driven evasions, punishing contact and grounded hit reactions.
- Arenas remain sharp and spatially readable throughout rapid subject motion.
- Each generated video is one continuous 5-15 second shot at 1344x768 and 24 fps.
- Inference uses the full INT8 FL2VA checkpoint, PDD Acc NFE 8, Euler, sigma
  shift 12/3 and CFG 1. No external LoRA or Motion Context is used.
- A continuous event may use only the immediately previous published tail PNG as
  its I2VA first frame. It never supplies a target last frame. New shots and new
  episodes are stateless T2VA.
