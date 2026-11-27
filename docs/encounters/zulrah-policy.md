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
| Opening | Rises on the fight's first tick (reported from play), at the middle spot facing south; attackable 4 ticks later and first barrage 11 ticks after the rise (capture) |
| Turns | Every attack, tail stare, cloud barrage and snakeling orb takes 3 ticks; each phase has its listed turns. A phase dives once its last turn's projectile has landed and its 3-tick turn is over (capture) |
| Form change | Dive 2 (SINKFAST), underwater 2, emerge 2 (EMERGEFAST), 3 ticks before the first turn |
| Facing | Faces (28,62) on surfacing, which from the middle spot is south, the opening rise's spawn angle (capture); the player on an attack turn; the locked tile during a tail stare; the first cloud's center while spitting venom, and the orb's tile while spitting a snakeling orb |
| Tail | Slam 6 ticks after the stare starts, 3x3, 5-tick stun that blocks moving and attacking, spotanim 80 on the player; TAIL_LEFT and TAIL_RIGHT alternate; no hit or stun on the three tiles behind each pillar (24,63 24,62 25,62 and 32,63 32,62 31,62) while at the middle spot |
| Clouds | 2 per barrage, 3-tick flight, 30-tick life, 1–5 typeless a tick; 8 fixed sites; a 4-barrage phase fills them base first, otherwise nearest the player first |
| Snakelings | Orb lands 3 ticks later, 1–3 tiles from the player; 50/50 style; first attack 3 ticks after landing; magic range 7; 25% venom per attack |
| Blue | Magic 75% of the time |
| Rotations | Equally likely |
| Projectiles | 1044 ranged, 1045 cloud orbs, 1046 magic, 1047 snakeling orb; attacks fly 40→90 cycles at any distance (capture) |
| Venom immunity | The game's single poison counter (`core/poison.ts`): Antidote++ -40, anti-venom -41, anti-venom+ -50, extended anti-venom+ -59 steps, venom blocked below -38. The 30-tick step clock keeps its phase through drinks and envenoming and starts fresh only when the counter leaves 0 (capture), so a venom immunity drunk from clean is the top of its wiki range and one drunk over a running counter falls inside it. A re-sip resets to the potion's full value (reported by the project owner from play); a weaker potion over a longer running immunity keeps the longer one (owner-approved policy) |
| Arena | Map squares 35_47 and 35_48: the engine accepts any tile inside the arena bounds (`isInTileSpace`), and terrain heights are composed across both squares |
| Arena before the cache bake | The island's own 69 walkable tiles (`zulrahIslandTiles`, the pinned cache's bake tile for tile), without collision (no pillar line of sight) until the bake replaces it, as Sol Heredit serves its own arena; never the global default, which the cache sets to Yama's arena |
| Loadouts | The wiki's five inventory setups slot for slot, plus Ranged Only with a Twisted bow; substitutions are in the open questions |
