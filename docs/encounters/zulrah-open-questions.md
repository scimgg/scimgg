# Zulrah — open questions

Implemented behavior the [facts spec](./zulrah-facts-spec.md) does not establish. Each row gives the
simulator's value, its label, and the evidence that would settle it. There are no Zulrah captures;
frame-stepped video against the 0.6 s tick is the means to settle these (`CONTRIBUTING.md`).

Labels: **POLICY**, a simulator choice no source decides; **INFERENCE**, derived from a source but
not stated by it; **UNVERIFIED**, no source.

Paths: **N/** = `src/npcs/zulrah/`, **E/** = `src/encounters/zulrah/`.

## Timing

| Question | Simulator | Label | Settled by |
|---|---|---|---|
| Form change | Dive 2, underwater 2, emerge 2, the bob, then 3 quiet ticks; first turn 4 ticks after the bob; `E/rotation.ts` | POLICY | Ticks from dive start to resurface, and to the first attack |
| Opening | Rise 4 ticks from the fight's first tick, then 12 ticks before the first barrage; `E/rotation.ts` | POLICY | Ticks from arriving to Zulrah appearing, and to its first spit |
| Cloud barrage and snakeling turn length | 3 ticks, as attacks | POLICY | A cloud-only phase (rotation 1, phase 1) |
| Tail stare | Slam 6 ticks after the stare starts; next stare 3 ticks after the slam; `N/constants.ts` `ZULRAH_TAIL` | UNVERIFIED | Tail animation start to hitsplat, and slam to next stare |
| Stun length | 5 ticks; `ZULRAH_TAIL.stunTicks` | UNVERIFIED | Hitsplat to the player's first move |

## Tail

| Question | Simulator | Label | Settled by |
|---|---|---|---|
| Area hit | 3x3 around the locked tile | INFERENCE ("moving two tiles away") | A player one tile off the target, on each side |
| Locked tile | The player's tile when the stare starts | INFERENCE ("stare at the player's position") | Moving during the stare |
| TAIL_LEFT vs TAIL_RIGHT | Alternates, left first | POLICY | Which animation plays for targets on each side |
| Pillar safe tiles | 24,63 24,62 25,62 (west pillar) and 32,63 32,62 31,62 (east) take no slam while Zulrah is at the middle spot; `N/constants.ts` `ZULRAH_TAIL_SAFE_TILES` | REPORTED (from play) | — |
| What the stun blocks | Moving and attacking; prayer, food, potions and gear still work | INFERENCE (Stun status page) | Praying, eating and switching while stunned |
| Stun graphic | Spotanim 80 STUNNED on the player; no player animation | UNVERIFIED | A tail hit |
| Envenoms | No | INFERENCE (venom is stated for ranged and magic only) | A tail hit on an un-envenomed player |

## Facing

| Question | Simulator | Label | Settled by |
|---|---|---|---|
| Before the first hit | South, no target until the player first damages Zulrah; then tracks the player across forms | UNVERIFIED | Facing before and after the first hit |
| During the tail stare | Holds its bearing on the locked tile until the slam | INFERENCE ("stare at the player's position") | Walking away during a stare |
| While spitting venom | Faces each barrage's landing sites until its next attack | UNVERIFIED | A cloud phase |

## Clouds

| Question | Simulator | Label | Settled by |
|---|---|---|---|
| Clouds per barrage | 2; `ZULRAH_CLOUD.perBarrage` | POLICY | Orbs per barrage |
| Landing sites | 8 fixed sites. A 4-barrage phase fills them in order, base first, arm tips clear; other barrages land first on the site nearest the player, then random; `E/clouds.ts` | INFERENCE (fill, tips clear); POLICY (order, other barrages) | Cloud positions over several barrages |
| Flight; lifetime | 3 ticks; 30 ticks | UNVERIFIED | Orb launch to cloud; cloud appearance to disappearance |
| Damage | 1–5 typeless a tick, once however many clouds overlap | UNVERIFIED ("varying damage per tick") | Hitsplats in one cloud, and in two |
| Spit animation | 5069 ACIDX1 | UNVERIFIED (5068 ACIDX3 exists) | A barrage compared with a ranged attack |
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
| Out-of-pattern phases after the first rotation | Not modelled | Gap | — |
| Projectile graphics | 1045 ranged, 1044 cloud orb, 1046 magic | POLICY | The projectile each attack shows |
| Projectile flight | Generic magic-spell timing | UNVERIFIED | Launch to hitsplat at several distances |
| Spot tiles | Middle (26,64), south (26,55), west (16,65), east (36,64), south-west tile in 35_47's frame; middle sits one tile off the base so a halberd reaches it from the middle tiles (y 62), reported from play | INFERENCE (island geometry) | Tile markers of Zulrah's footprint at each spot |
| Player start | (28,61) | INFERENCE (wiki tile marker) | The boat arrival |

## Loadouts

| Question | Simulator | Label | Settled by |
|---|---|---|---|
| Items not in the catalog | Shark and cheap food → Anglerfish; Zul-andra teleport and house tablets → empty; Crystal halberd → Dragon halberd; Twinflame staff → Staff of the Dead, with Fire runes in the Void hybrid pouch | POLICY | Catalog support for those items |
| Melee ring | Ring of suffering (ri) worn, Bellator ring carried | POLICY | — |
| Blowpipe darts | Dragon | UNVERIFIED | — |
