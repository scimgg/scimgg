# Zulrah — open questions

Implemented behavior the [facts spec](./zulrah-facts-spec.md) does not establish. Each row gives the
simulator's value, its label, and the evidence that would settle it. Four private gameplay captures
cover part of the fight: zulrah-packet-data-1.txt (**Z1**), rotation 3 from its magma phase into the
next rotation; zulrah-packet-data-2.txt (**Z2**), rotation 2 from the opening through phase 10;
zulrah-packet-data-3.txt (**Z3**), rotation 4 from phase 3 through phase 12; and
zulrah-packet-data-4.txt (**Z4**), rotation 2 from phase 3 through phase 10 and into the next rotation,
rotation 2 again.
Further captures or frame-stepped video against the 0.6 s tick settle the rest (`CONTRIBUTING.md`).

Labels: **POLICY**, a simulator choice no source decides; **INFERENCE**, derived from a source but
not stated by it; **OBSERVATION**, seen in a capture but not yet a rule (one case, or not modeled);
**UNVERIFIED**, no source; **FOR DISCUSSION**, a change made from the captures that is open for
discussion with the contributor.

Paths: **N/** = `src/npcs/zulrah/`, **E/** = `src/encounters/zulrah/`.

## Timing

| Question | Simulator | Label | Settled by |
|---|---|---|---|
| Opening: arrival to spawn | Rises on the fight's first tick | OBSERVATION | Z2: the player arrives on t2968 and Zulrah is added on t2973, 5 ticks later. One case |
| Opening: attackable | 4 ticks after the rise; `ZULRAH_OPENING_RISE_TICKS` | OBSERVATION | Z2: the first click, at spawn + 4 (t2977), cast at once; earlier clicks are untested |
| Drawn between SINKFAST's end and the emerge | Hidden for that one tick; no capture removes the NPC | POLICY | Video of a dive |
| Minimap dot and NPC markers on that tick | Still shown at the spot Zulrah sank from; only the model is hidden | UNVERIFIED (the project owner is not sure what the game shows) | Video of a dive with the minimap and RuneLite NPC indicators in view |
| Turn gaps of 4 | Every turn 3 ticks apart | OBSERVATION | Z1 has three 4-tick gaps where the turn kind changes (attack t462 → barrage t466, barrage t319 → orb t323, orb t531 → stare t535), but 3 at t376 → t379. Z3's extra phase has one between two attacks (t855 → t859) and dived 4 ticks after its last attack (t868 → t872) |
| Tail stare | Slam 6 ticks after the stare starts; next stare 3 ticks after the slam; `N/constants.ts` `ZULRAH_TAIL` | UNVERIFIED | Tail animation start to hitsplat, and slam to next stare |
| Stun with a knockback | A hit on t blocks t..t+6 (`ZULRAH_TAIL.stunTicks` 7), knockback or not | OBSERVATION | With a knockback the player first moves a tick later: Z2 t3119 → t3127, Z1 t549 → t557. Consistent with 1 tick of knockback + the 7-tick stun. Z4 t2256 → t2265 is an upper bound only, as clicks were not made every tick. Without one Z4 agrees with Z2: hit t2064, first move t2071 |
| Knockback | Not modeled; left to the contributor | OBSERVATION | Four of the ten captured tail hits pushed the player. Three pushed it west, each ending on 22,68: from 24,68 (Z1 t242, Z2 t3119, 2 tiles) and from 23,68 (Z1 t549, 1 tile, stopped at the island's edge). Z4 t2256 pushed it east, 2 tiles from 32,69 to 34,69, facing angle 512 (toward Zulrah). Each was a left tail. On the hit tick the game sends a teleport plus an exactmove over 30 cycles, the player faces Zulrah (angle 1536) and plays seq 1157 `human_troll_flyback`, and the `busy` varbit is set for that tick. The player first moves a tick later than without a knockback. No push for a player already on 22,68 (Z1 t249), on 32,70 at the north-east edge (Z2 t3008, t3015, t3247, t3254) or on 30,60 at the south edge (Z4 t2064, a left tail). Likely rule (inferred, from pushes west and east): up to 2 tiles directly away from Zulrah, stopping at the first unwalkable tile. The simulator has no forced player movement, so this needs shared engine support |
| Stun start | The hit tick is the first stunned tick, as the engine runs Zulrah's turn before the player's | INFERENCE | "You're stunned!" answers clicks from the tick after the hit (Z2 t3248, with an attack click that tick); walking on the hit tick itself is not seen |

## Tail

| Question | Simulator | Label | Settled by |
|---|---|---|---|
| Area hit | 3x3 around the locked tile | INFERENCE ("moving two tiles away") | A player one tile off the target, on each side |
| Locked tile | The player's tile when the stare starts | INFERENCE ("stare at the player's position") | Moving during the stare |
| TAIL_LEFT vs TAIL_RIGHT | Alternates, left first | POLICY | Which animation plays for targets on each side |
| Pillar safe tiles | 24,63 24,62 25,62 (west pillar) and 32,63 32,62 31,62 (east) take no slam while Zulrah is at the middle spot; `N/constants.ts` `ZULRAH_TAIL_SAFE_TILES` | REPORTED (from play) | — |
| What the stun blocks | Moving and attacking; prayer, food, potions and gear still work | INFERENCE (Stun status page); Z1 t245 shows eating while stunned | Praying and switching while stunned |
| Stun graphic | Spotanim 245 `stunned_thieving` on the player, on every hit | — | Measured (facts spec); seq 1157 belongs to the knockback, above |
| Envenoms | No | INFERENCE (venom is stated for ranged and magic only) | A tail hit on an un-envenomed player |

## Facing

| Question | Simulator | Label | Settled by |
|---|---|---|---|
| While spitting venom | Faces each barrage's landing sites until its next attack | UNVERIFIED | A cloud phase |
| During the tail stare | Holds its bearing on the locked tile until the slam | INFERENCE ("stare at the player's position") | Walking away during a stare. OBSERVATION: the captured stares face one of a few fixed tiles, never the player's: (16,67), (38,55), (39,51), (39,48), (32,48), (32,52), (39,49), each stare's with the player's tile in the fixture (`ZULRAH_CAPTURE_TAIL_SIDES`); always west (angle 512) or south to south-east (about 1820–1980), never north. Not modeled |

## Clouds

| Question | Simulator | Label | Settled by |
|---|---|---|---|
| Clouds per barrage | 2; `ZULRAH_CLOUD.perBarrage` | POLICY | Orbs per barrage |
| Landing sites | 8 fixed sites. A 4-barrage phase fills them in order, base first, arm tips clear; other barrages land first on the site nearest the player, then random; `E/clouds.ts` | INFERENCE (fill, tips clear); POLICY (order, other barrages) | Cloud positions over several barrages |
| Flight; lifetime | 3 ticks; 30 ticks | UNVERIFIED | Orb launch to cloud; cloud appearance to disappearance |
| Damage | 1–5 typeless a tick, once however many clouds overlap | UNVERIFIED ("varying damage per tick") | Hitsplats in one cloud, and in two |
| Orb launched as Zulrah dives | Not modelled | Gap | — |

## Snakelings

| Question | Simulator | Label | Settled by |
|---|---|---|---|
| Landing tile | Random walkable tile 1–3 tiles from the player | POLICY | Landing tiles relative to the player |
| Style odds | 50/50 | POLICY | Melee vs magic counts over many orbs |
| Orb flight; first attack | 3 ticks; 3 ticks after landing | UNVERIFIED | Video |
| Magic range; bolt timing | 7 tiles; lands the next tick | UNVERIFIED | Video |
| Venom chance | 25% per attack (`SNAKELING_VENOM_CHANCE`) | POLICY | Many hits on an un-envenomed player |
| Lifetime | 67 ticks | INFERENCE ("more than 40 seconds") | Spawn to die-off of an idle snakeling |
| Dying NPC 2047 | Unused; 2045/2046 play 2408 | UNVERIFIED | A snakeling dying |
| Orb launched as Zulrah dives | Not modelled | Gap | — |

## Venom

| Question | Simulator | Label | Settled by |
|---|---|---|---|
| Immunity steps per potion | Poison immunity / 18 s: Antidote++ 40, anti-venom 41, anti-venom+ 50, extended anti-venom+ 59; venom immunity is the steps below -38 | INFERENCE (wiki durations and RuneLite's cutoff). Anti-venom's 41 fits /w/Anti-venom (read 2026-11-27): "immunity to venom for 36-54 seconds" is 3 steps below -38, depending on the clock's phase; 41 steps of poison immunity is the page's "12 minutes" to within one step | The poison varp after each potion |
| Step clock with the counter at 0 | Stopped; a counter leaving 0 starts it with a full 30 ticks | UNVERIFIED | Z2 never shows the counter at 0. Ticks from poisoning or drinking from clean to the first step |
| Re-drinking over a running immunity | Resets to the potion's full value (`Math.min(current, -steps)`); the step clock keeps its phase | REPORTED (from play) | Reported by the project owner for extended anti-venom+ (to -59); not yet captured. Z2 shows the clock keeping its phase across a drink from venom (t3222, next step t3232) |
| A weaker potion over a longer running immunity | Keeps the longer immunity, and its step clock | POLICY (approved by the project owner; not captured) | The poison varp after, e.g., anti-venom+ drunk at -55 |

## Attacks and rotation

| Question | Simulator | Label | Settled by |
|---|---|---|---|
| Blue magic/ranged split | 75% magic; `TANZANITE_MAGIC_CHANCE` | POLICY ("much more frequently") | Blue attacks counted by style |
| Rotation odds | Equal | POLICY ("chosen at random") | Many fight starts |
| Out-of-pattern phases after the first rotation | Not modeled | Gap | — |
| South spot | (26,54), derived from projectile sources and targets and facing angles (facts spec) | INFERENCE | The captures agree on every signal but the decoded move tile, which reads (33,50) in Z1 (t276) and Z4 (t2015, t2098), (34,54) in Z2 (t3068, t3148) and (38,53) in Z3 (t922); a capture with tile markers would settle it |
| Extra phases | Not modeled; each rotation follows the wiki's table | OBSERVATION | Z3: between rotation 4 phases 3 and 4 (the wiki's 4 and 5), Zulrah surfaced blue at the middle (t832, no form change), spat 3 barrages ((22,67)+(22,64) t835, (32,66)+(32,69) t838, (25,60)+(31,60) t841), made 7 attacks t849–t868 (magic, magic, ranged, ranged, magic, magic, magic) and dived t872. One case; the table is unchanged |
| Player start | (28,61) | INFERENCE (wiki tile marker) | The boat arrival |

## Loadouts

| Question | Simulator | Label | Settled by |
|---|---|---|---|
| Items not in the catalog | Shark and cheap food → Anglerfish; Zul-andra teleport and house tablets → empty; Crystal halberd → Dragon halberd; Twinflame staff → Staff of the Dead, with Fire runes in the Void hybrid pouch | POLICY | Catalog support for those items |
| Melee ring | Ring of suffering (ri) worn, Bellator ring carried | POLICY | — |
| Blowpipe darts | Dragon | UNVERIFIED | — |
