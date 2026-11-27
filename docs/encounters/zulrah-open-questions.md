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
| Stun with a knockback | A hit on t blocks t..t+6 (`ZULRAH_TAIL.stunTicks` 7), knockback or not | OBSERVATION | With a knockback the player first moves a tick later: Z2 t3119 → t3127, Z1 t549 → t557. Consistent with 1 tick of knockback + the 7-tick stun. Z4 t2256 → t2265 is an upper bound only, as clicks were not made every tick. Without one Z4 agrees with Z2: hit t2064, first move t2071 |
| Knockback | Not modeled; left to the contributor | OBSERVATION | Four of the ten captured tail hits pushed the player. Three pushed it west, each ending on 22,68: from 24,68 (Z1 t242, Z2 t3119, 2 tiles) and from 23,68 (Z1 t549, 1 tile, stopped at the island's edge). Z4 t2256 pushed it east, 2 tiles from 32,69 to 34,69, facing angle 512 (toward Zulrah). Each was a left tail. On the hit tick the game sends a teleport plus an exactmove over 30 cycles, the player faces Zulrah (angle 1536) and plays seq 1157 `human_troll_flyback`, and the `busy` varbit is set for that tick. The player first moves a tick later than without a knockback. No push for a player already on 22,68 (Z1 t249), on 32,70 at the north-east edge (Z2 t3008, t3015, t3247, t3254) or on 30,60 at the south edge (Z4 t2064, a left tail). Likely rule (inferred, from pushes west and east): up to 2 tiles directly away from Zulrah, stopping at the first unwalkable tile. The simulator has no forced player movement, so this needs shared engine support |
| Stun start | The hit tick is the first stunned tick, as the engine runs Zulrah's turn before the player's | INFERENCE | "You're stunned!" answers clicks from the tick after the hit (Z2 t3248, with an attack click that tick); walking on the hit tick itself is not seen |
| Zulrah's death | Every form plays seq 5804 SNAKEBOSS_DEATH from the killing tick (`E/renderConfig.ts`, `bossDeathAnimationEnabled`), and the corpse is drawn for the clip's own length | UNVERIFIED | No capture has a kill. A kill would show the seq, the tick it starts on and how long the NPC stays |

## Tail

| Question | Simulator | Label | Settled by |
|---|---|---|---|
| Area hit | 3x3 around the locked tile, with the pillar safe tiles below (`N/zulrah.ts` `isInTailArea`, `isTailSafeTile`) | INFERENCE ("moving two tiles away"); left to the contributor | OBSERVATION, not modeled (each slam in `ZULRAH_CAPTURE_TAIL_SLAMS`): the player was hit exactly when its start-of-tick tile on the slam tick was within one tile of the whip sound's tile, 18/18. The current model matches 13/18. It misses four hits, where the player moved off the locked tile but stayed within one of the whip: Z1 t242, t549; Z2 t3119; Z4 t2064. It predicts one hit that missed, on the locked tile itself, the whip 3 tiles off: Z4 t2071. The Z3 misses on the safe tile (32,62) (t883, t891) follow from where the whip landed, 3 and 5 tiles off, with no safe-tile rule needed |
| Where the whip lands | Not modeled | OBSERVATION | Fits 18/18: a fixed tile for each zone of the player's stare-start tile, its 45° sector from Zulrah's center (28.5,67.5), and side. West, (22,68) and (24,66): right (23,68), left (23,66). North-west tip, (24,70): left (24,69). East arm, (32,69) and (32,70): right (32,69), left (32,70). South base and south-east, (29,62), (30,60), (32,62): right (27,61), left (29,61). Each right tile is on Zulrah's right as it faces the zone, each left on its left. The zone is locked at the stare start: the player changed zone mid-stare 3 times (Z1 t535, Z2 t3105, Z4 t2187) and the whip kept the starting zone each time. Limits: a lookup fitted to 18 slams; the west right and east-arm left cells rest on one slam each; the north-west tip's right cell is unseen; the boundary between the west and the north-west tip lies only somewhere between (22,68) and (24,70). Settled by slams from more tiles and both sides |
| Locked tile | The player's tile when the stare starts | INFERENCE ("stare at the player's position") | Moving during the stare: the zone above is locked then (3 of 3) |
| TAIL_LEFT vs TAIL_RIGHT | By the player's start-of-tick tile as the stare starts: west of Zulrah's center column (x 28 at the middle spot) TAIL_LEFT, east TAIL_RIGHT (the side sets the stare: left 6, right 5); `N/zulrah.ts` `zulrahTailSide` | INFERENCE (14 of 18 stares, confirmed by the project owner for the first 12); POLICY for the center column: TAIL_LEFT | Left with the player west: Z1 t236 (24,70), t535 (22,68), t543 (24,70); Z2 t3105 (24,66), t3113 (24,70). Right with the player east: Z2 t3003, t3010, t3242, t3249 (32,70); Z3 t878 (32,62); Z4 t2066 (30,60), t2187 (29,62), t2194 (32,70), t2243 (32,69). The exceptions: Z1 t244, right with the player at (22,68), just knocked back there at t242; Z3 t885, left with the player at (32,62); Z4 t2058, left with the player at (29,62), the tile that got right at t2187, Zulrah facing (32,52) both times; Z4 t2250, left with the player at (32,69). Neither the player's tile nor Zulrah's facing explains them. A stare with the player in the center column, and more stares with the player east |
| Pillar safe tiles | 24,63 24,62 25,62 (west pillar) and 32,63 32,62 31,62 (east) take no slam while Zulrah is at the middle spot; `N/constants.ts` `ZULRAH_TAIL_SAFE_TILES` | Captured for 32,62 (Z3: the player stood there through TAIL_RIGHT t878 and TAIL_LEFT t885, no hit, no stun); REPORTED (from play) for the other five | A player on each of the other five through a slam |
| What the stun blocks | Moving and attacking; prayer, food, potions and gear still work | INFERENCE (Stun status page); Z1 t245 shows eating while stunned | Praying and switching while stunned |
| Stun graphic | Spotanim 245 `stunned_thieving` on the player, on every hit | — | Measured (facts spec); seq 1157 belongs to the knockback, above |
| Envenoms | No | INFERENCE (venom is stated for ranged and magic only) | A tail hit on an un-envenomed player |

## Facing

| Question | Simulator | Label | Settled by |
|---|---|---|---|
| During the tail stare | Holds its bearing on the locked tile until the slam | INFERENCE ("stare at the player's position") | Walking away during a stare. OBSERVATION: the captured stares face one of a few fixed tiles, never the player's: (16,67), (38,55), (39,51), (39,48), (32,48), (32,52), (39,49), each stare's with the player's tile in the fixture (`ZULRAH_CAPTURE_TAIL_SIDES`); always west (angle 512) or south to south-east (about 1820–1980), never north. Not modeled |

## Clouds

| Question | Simulator | Label | Settled by |
|---|---|---|---|
| Landing sites | 9 sites around the island's U; each phase's barrages follow its captured sequence, else the fill, else a random pair at most two steps apart; `E/clouds.ts` | FOR DISCUSSION | Evidence: all 108 captured cloud orbs used the 9 sites (south-west tiles (22,67), (22,64), (22,61), (25,60), (28,60), (31,60), (32,63), (32,66), (32,69)); every barrage's two sites were at most two steps apart on the U (49 of 54 neighbors, 5 one site apart, all in Z3); the spot does not change the set; a repeated phase repeated its sequence wherever the player stood (the fill in Z2's opening and Z1's rotation 3 last phase; Z1's red middle phase at its start and from t516; rotation 4's green south matched rotation 3's green middle; Z4 repeated Z2's rotation 2 phases 3, 4, 7 and 8). Captured: the opening (Z2), rotation 2 phases 3, 4, 7, 8 (Z2, Z4) and 10, the fill (Z4), rotation 3 phases 2, 6, 8, 11 (Z1), rotation 4 phases 4, 6, 9 (Z3). Partly captured: rotation 4 phase 12, the fill's first barrage (Z3 t1090). Inferred, the fill (INFERENCE: three fills matched exactly): rotation 1 phase 10, the rest of rotation 4 phase 12. Fallback (POLICY: one of the 15 pairs at most two steps apart at random, either orb first, from the seeded cloud stream): rotation 1 phases 3, 6, 7, 8; rotation 4 phase 2. Phase indexes are 0-based into `ZULRAH_ROTATIONS`. Settled by captures of the fallback phases |
| Rotation 1's blue south and jad west (phases 7, 8) | Fallback | INFERENCE (not applied) | Same form, spot and specials as rotation 2's phases 7 and 8, so they likely share those sequences; they stay on the fallback until captured |
| Damage | 1–5 typeless a tick, once however many clouds overlap | UNVERIFIED ("varying damage per tick") | Hitsplats in one cloud, and in two |

## Snakelings

| Question | Simulator | Label | Settled by |
|---|---|---|---|
| Landing tile | One of the 9 cloud sites' centers; a phase follows its captured orb sequence, else picks a site it has not used yet at random; no walkability check; `E/snakelingOrbs.ts` | FOR DISCUSSION | Evidence: all 51 captured orbs (Z1 17, Z2 11, Z3 15, Z4 8) targeted the 9 centers (23,68), (23,65), (23,62), (26,61), (29,61), (32,61), (33,64), (33,67), (33,70), wherever the player stood; none twice in a phase; six landed on (33,70), off the walkable island; rotation 3's red middle phase took (23,68) for its last orb in both rounds (Z1 t232, t531). Captured: rotation 2 phases 3, 4, 7 (Z2; Z4 repeated 4 and 7), rotation 3 phases 1, 2, 6, 8, 10 (Z1), rotation 4 phases 6, 7, 11 (Z3). Partly captured, on the fallback: rotation 4 phase 3, its last orb (29,61) (Z3 t813). Fallback (POLICY): rotation 1 phases 3, 6, 7; rotation 4 phases 1, 3. Rotation 1's blue south (phase 7) has rotation 2 phase 7's form, spot and specials, so likely its orbs (not applied). Settled by captures of the fallback phases |
| Style odds | 50/50 | POLICY | Melee vs magic counts over many orbs |
| First attack | 3 ticks after landing | UNVERIFIED | Video |
| Magic range; bolt timing | 7 tiles; lands the next tick | UNVERIFIED | Video |
| Venom chance | 25% per attack (`SNAKELING_VENOM_CHANCE`) | POLICY | Many hits on an un-envenomed player |
| Lifetime | Dies off 51 ticks after appearing (`SNAKELING.lifetimeTicks`): the engine's scripted death, the death animation on that tick, as a kill without a hit | Measured (facts spec); 51 is the most common | 8 captured: 50 twice (Z1 t435 → t485, t438 → t488), 51 four times (Z2), 52 (Z3 t929 → t981), 53 (Z3 t935 → t988); probably random. All disagree with the wiki's "more than 40 seconds" (67+ ticks) |
| Removal after a snakeling's death | The engine's corpse retention prunes it 10 ticks after death (`DEAD_ACTOR_PRUNE_GRACE_TICKS`), kill or expiry alike | Gap | Z2 removes it 2 ticks after the death animation, after a kill (t3198 → t3200) and an expiry (t3147 → t3149). The retention is engine-wide, not changed here |
| A killed snakeling's death animation | On the hit tick (the snakeling's death is immediate) | Gap | Z2: a recoil hit on t3197, the death animation on t3198 |
| Dying NPC 2047 | Unused; 2045/2046 play 2408 | UNVERIFIED | A snakeling dying |

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
| Rotation 2, phase 5 (blue south) attacks | 5, as the wiki tables | OBSERVATION | Z4 made all 5 (t2018–t2030). Z2 made 2 (t3074, t3077) before its specials, with the player in sight at t3080 and t3083, so line of sight does not explain it; every other rotation 2 phase matches in both |
| South spot | (26,54), derived from projectile sources and targets and facing angles (facts spec) | INFERENCE | The captures agree on every signal but the decoded move tile, which reads (33,50) in Z1 (t276) and Z4 (t2015, t2098), (34,54) in Z2 (t3068, t3148) and (38,53) in Z3 (t922); a capture with tile markers would settle it |
| Halberd reach to the middle form | Only from the arms' inner columns, x 24 and 32 from y 63 to 70: the base's front row (y 62) is 3 tiles from the footprint's south edge (y 65), and y 63 between the pillars (x 25–31) is not walkable in the pinned cache's bake, so a halberd user on the base walks round a pillar and up an arm first; `E/constants.ts` `zulrahIslandTiles`, `E/rotation.ts` `ZULRAH_SPOTS` | OBSERVATION | Z4's 13 halberd swings at the middle form all came from the east arm, (32,67), (32,69) and (32,70); none from the base, and no capture has the player on y 63 between the pillars. The contributor reports from play hitting the middle form from the base without walking, which would need the spot at (26,64) (the captures track (26,65)) or y 63 walkable there. Settled by a capture, or tile markers on video, of a halberd swing at the middle form from a base tile: the player's tile, Zulrah's tracked tile, and whether a step came before the swing |
| Giving up blocked attacks | After 8 consecutive blocked ticks, the remaining attacks are dropped and the next special or the dive comes on the 9th; `ZULRAH_LOS_GIVE_UP_TICKS` | POLICY (approved by the project owner; unverified) | Six captured waits, blocked tick to next turn: Z3 blue middle t1013 → special t1018 (5); Z1 blue east t301 → dive t307 (6); Z3 green middle t1083 → special t1090 (7); Z2 green east t3137 → dive t3145 (8, the one the policy matches); Z1 blue middle t363 → special t373 (10); Z3 green middle t997 → dive t1007 (10). Z3's three with the player on (32,62) behind the east pillar. Probably random; more blocked phases, timed |
| Extra phases | Not modeled; each rotation follows the wiki's table | OBSERVATION | Z3: between rotation 4 phases 3 and 4 (the wiki's 4 and 5), Zulrah surfaced blue at the middle (t832, no form change), spat 3 barrages ((22,67)+(22,64) t835, (32,66)+(32,69) t838, (25,60)+(31,60) t841), made 7 attacks t849–t868 (magic, magic, ranged, ranged, magic, magic, magic) and dived t872. One case; the table is unchanged |
| Player start | (28,61) | INFERENCE (wiki tile marker) | The boat arrival |

## Loadouts

| Question | Simulator | Label | Settled by |
|---|---|---|---|
| Items not in the catalog | Shark and cheap food → Anglerfish; Zul-andra teleport and house tablets → empty; Crystal halberd → Dragon halberd; Twinflame staff → Staff of the Dead, with Fire runes in the Void hybrid pouch | POLICY | Catalog support for those items |
| Melee ring | Ring of suffering (ri) worn, Bellator ring carried | POLICY | — |
| Blowpipe darts | Dragon | UNVERIFIED | — |
