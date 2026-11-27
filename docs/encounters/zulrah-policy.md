# Zulrah — simulator policy

Decisions the simulator takes where the [facts spec](./zulrah-facts-spec.md) runs out. Each is
registered, with what would settle it, in the [open questions](./zulrah-open-questions.md).

## Rules

- A wiki word without a number ("several seconds", "much more frequently") becomes one named
  constant, labelled POLICY beside the code.
- A cache id is used only for what its gameval name describes.
- Timing is composed from fixed per-turn and per-transition durations, never fitted to an overall
  fight length.

## Values

| Area | Decision |
|---|---|
| Actor | One NPC for the whole fight. Between forms it is `hidden` and untargetable, then transforms at its next spot, keeping HP and hits in flight |
| Opening | Rises on the fight's first tick (reported from play), over 4 ticks; first barrage 12 ticks later |
| Turns | Every attack, tail stare, cloud barrage and snakeling orb takes 3 ticks; each phase has its listed turns |
| Form change | Dive 2 (SINKFAST), underwater 2, emerge 2 (EMERGEFAST), the bob, then 3 quiet ticks; first turn 4 ticks after the bob |
| Facing | South with no target until first damaged or its first attack, then the player; the locked tile during a tail stare; the landing sites while spitting venom, and the landing tile while spitting a snakeling orb |
| Tail | Slam 6 ticks after the stare starts, 3x3, 5-tick stun that blocks moving and attacking, spotanim 80 on the player; TAIL_LEFT and TAIL_RIGHT alternate; no hit or stun on the three tiles behind each pillar (24,63 24,62 25,62 and 32,63 32,62 31,62) while at the middle spot |
| Clouds | 2 per barrage, 3-tick flight, 30-tick life, 1–5 typeless a tick; 8 fixed sites; a 4-barrage phase fills them base first, otherwise nearest the player first |
| Snakelings | Orb lands 3 ticks later, 1–3 tiles from the player; 50/50 style; first attack 3 ticks after landing; magic range 7; 25% venom per attack |
| Blue | Magic 75% of the time |
| Rotations | Equally likely |
| Projectiles | 1045 ranged, 1044 cloud orb, 1046 magic; generic magic-spell flight |
| Venom immunity | One shared poison/venom immunity timer, set to each anti-venom's venom duration (45 s, 216 s, 378 s) |
| Arena | Map squares 35_47 and 35_48: the engine accepts any tile inside the arena bounds (`isInTileSpace`), and terrain heights are composed across both squares |
| Loadouts | The wiki's five inventory setups slot for slot, plus Ranged Only with a Twisted bow; substitutions are in the open questions |
