# Fortis Colosseum — facts spec (waves 1–11 and the hand-off to Sol)

What the captures, the Wiki, RuneLite and the game cache establish about the Fortis Colosseum run
before Sol Heredit. Wave 12 itself (Sol) is in [`sol-heredit-facts-spec.md`](./sol-heredit-facts-spec.md).
The simulator's choices where this evidence stops are in
[`fortis-colosseum-policy.md`](./fortis-colosseum-policy.md); everything unresolved, contradicted
or unobserved is in [`fortis-colosseum-open-questions.md`](./fortis-colosseum-open-questions.md).

## Sources

The captures are private; the facts the tests use are extracted into `__tests__/fixtures/*Capture.ts`
files next to the tests. All four captures are contiguous over the listed ticks.

One fact comes from outside these sources: the three west spawn points in §3.2 were observed in
third-party encounter recordings, which are not redistributed and are cited only as such. They are used by
maintainer decision ([open question A2](./fortis-colosseum-open-questions.md)); nothing else here rests on
those recordings.

| Alias | File | Ticks | Contents | Outcome |
|---|---|---|---|---|
| A | `colosseum-waves-1-12-damage-trials-solarflare3-volatility3-bees1-totemic-doom1-death-packet-data.txt` | 770..5369 | Opens in the wave-3 intermission (first `Wave: 3` at A:837): waves 3–11, then Sol. Blasphemy II and Totemic held at the start; Solarflare III, Volatility III, Doom I, Bees I picked | Doom death in the Sol fight (A:5299), lobby A:5308 |
| B | `colosseum-waves-bees-death(no-sol)-packet-data-1.txt` | 1821..3435 | Arena entry, waves 1–8; Relentless III from B:2032, Quartet, Bees I–III, Frailty I | Death in wave 8 at T0+56 (HP 0 at B:3403), lobby B:3410 |
| C | `colosseum-no-sol-packet-data.txt` | 1418..3727 | Lobby, entry (C:1421), waves 1–11, ends in the 11→12 intermission (C:3723) | No death |
| K | `colosseum-sol-heredit-packet-data.txt` | 3959..4237 | **The same run as C**, continued: same Minimus and seated-Sol NPC indices, varp 4133's old value equals C's wave-11 value, and K:3978 reopens the intermission with C:3723's arguments. C:3728..K:3958 is not captured | Wave-12 pick (K:3987), Sol killed |

That is 28 captured waves (A 9, B 8, C 11) and one captured wave-12 hand-off from a wave (A), plus
K's hand-off after C's run.

| Short | Source |
|---|---|
| **W-Main** | Wiki [Fortis Colosseum](https://oldschool.runescape.wiki/w/Fortis_Colosseum?oldid=15404131), rev 15404131 |
| **W-Strat** | Wiki [Fortis Colosseum/Strategies](https://oldschool.runescape.wiki/w/Fortis_Colosseum/Strategies?oldid=15414089), rev 15414089 |
| **W-Mod** | Wiki [Fortis Colosseum/Modifiers](https://oldschool.runescape.wiki/w/Fortis_Colosseum/Modifiers?oldid=15163385), rev 15163385 (its source comment names cache enum 5312, structs 891–915) |
| **W-NPC** | Wiki NPC articles: [Serpent shaman](https://oldschool.runescape.wiki/w/Serpent_shaman?oldid=15200480) 15200480, [Jaguar warrior](https://oldschool.runescape.wiki/w/Jaguar_warrior?oldid=15319602) 15319602, [Javelin Colossus](https://oldschool.runescape.wiki/w/Javelin_Colossus?oldid=15411467) 15411467, [Manticore](https://oldschool.runescape.wiki/w/Manticore?oldid=15200487) 15200487, [Shockwave Colossus](https://oldschool.runescape.wiki/w/Shockwave_Colossus?oldid=15200488) 15200488, [Minotaur (Fortis Colosseum)](https://oldschool.runescape.wiki/w/Minotaur_(Fortis_Colosseum)?oldid=15412054) 15412054, [Minimus](https://oldschool.runescape.wiki/w/Minimus?oldid=15303372) 15303372 |
| **W-News** | Wiki update posts: *Undead Pirates, Colosseum Changes & more!* (10 Apr 2024), *Varlamore Tweaks, GameJam V Commences & More!* (24 Apr 2024) |
| **RL** | RuneLite 1.13.7-SNAPSHOT (BSD-2), `runelite-api/.../gameval/{NpcID,VarbitID,VarPlayerID,InterfaceID,AnimationID,SpotanimID,ObjectID}.java`, for id names |
| **Cache** | Game cache: NPC, enum, struct and varbit configs; ClientScripts; map square 28_48 locations (OpenRS2 cache 2437 for walkability) |

Sim coordinates are world coordinates minus `(1792, 3072)` (map square 28_48), no flips. NPC tiles
are south-west corners. `d` is Chebyshev distance. 30 client cycles = 1 tick.

**Status labels** follow the [Sol ledger](./sol-heredit-facts-spec.md#timing-verification-ledger):
**VERIFIED** (agreement in every cited capture sample, not proof of universality),
**SINGLE-OBSERVATION**, **CAPTURE-FIT** (a model reproducing every cited sample), **DERIVED**,
**WIKI-ONLY**, **CACHE**, **UNVERIFIED**.

## 1. Run structure

### 1.1 Wave start T0

**T0 is the tick of the `Wave: N` game message.** On that tick varp 4133
`colosseum_wave_start_time` takes the server cycle, every initial wave NPC is added with that
`creationcycle` and `spawnangle=south`, and Doom points return to 0 with the tier unchanged. "Your
Doom points have reset to 0." is sent only when points were held (C:1641, A:4970; absent at C:2863
and C:3445, whose count varbit 9801 was already 0). 202/202 initial adds share the new
4133 value (A 85, B 51, C 66). **VERIFIED.** Wave 12 has no `Wave: 12` message; its T0 is the 4133
change (A:4970, K:3992).

### 1.2 Boundary chronology

| Step | Tick | Evidence (n) | Status |
|---|---|---|---|
| Last required wave NPC plays its death sequence | Tc−3 or Tc−4 (per species, §6.1) | 27/27 completed waves | VERIFIED |
| **Completion Tc**: that NPC's `del`; "Wave N completed! Wave duration: m:ss.cc"; varp 4131 +1, 4136 = Tc−T0 ticks, 4137 += that | Tc | 27/27 (A 9, B 7, C 11); e.g. A:837→1104 = 267 ticks = "2:40.20" | VERIFIED |
| Modifier actors cleared | Tc | Solarflare orbs deleted (A:1727, 2132, 2518, 3051, 3544, 4181, 4868), four new ones at the next T0; Bee swarms, alive or awaiting respawn, deleted (B:2564, B:2922, B:3299), new ones at the next T0+5 (B:2366, 2635, 2980, 3352); Volatility III molten pools replaced by a non-blocking loc (A:4868–4869). No healing totem outlived its wave (each left with its target or was killed 8–36 ticks before Tc) | VERIFIED |
| **Offers open**: Minimus 12808 added one tile north of the player (seq 10862, facing the player); varbit 9788 → 0; varps 264/265/266 = the three offers; modal interface 865 `colosseum_intermission_2` opens with ClientScript 4931; busy (12393) → 1 | Tc+3 | 27/27 at Tc+3; tile = player + (0,+1) in 27/27 (e.g. C:1482 (31,41)→(31,42), A:4871 (21,36)→(21,37)); the north tile was never blocked | VERIFIED |
| Closing without choosing; talking to Minimus reopens the interface with **identical** arguments and "You must make a choice before continuing!" | ≤1 tick after the talk | A:1108→1109; three reopens C:2617–2631 | VERIFIED |
| Selection: varbit 9788 = **button 1/2/3**, not the modifier id; may change many times; clicking a selected button deselects | — | A:3062→1, 3234→3, 3242→1; Cache ClientScript `colosseum_intermission_2_mod_button_click` | VERIFIED + CACHE |
| **Confirm Tk**: interface closes, Minimus `del`, the tiered modifier's stack varbit +1 (§4.1); varp 4135 = the pick's Glory, 4134 → 0, busy → 0 | Tk | 30/30 confirms (A 10, B 8, C 11, K 1); selection and confirm can share a tick (C:1446, B:1857, C:1529) | VERIFIED |
| **Next wave T0 = Tk + 5** | Tk+5 | 30/30, including both wave-12 hand-offs | VERIFIED |

Intermission length Tc→T0 is player-driven: 11 ticks minimum (B 2→3, C 2→3, C 5→6), 197 maximum
(A 8→9). No time-out was observed. The player keeps their tile through every intermission and
wave start 1–11: no teleport at any of the 30 boundaries. **VERIFIED.**

### 1.3 Entry before wave 1

C (fully) and B (from entry+4): `oploc1` on `colosseum_entrance` (C:1421), teleport to (32,22)
facing north (C:1424 = E), seated Sol 12827 added at (31,51) at E+1 with blocker loc 50703,
leftover stack varbits from the previous run cleared at E+2 (C:1426), Minimus added at **(32,34)**
at E+4 with "A Grand Champion approaches!" and the run varps reset (C:1428), busy → 0 with "Let me
know when you want to begin." at E+7. A scripted walk north from (32,22) at one tile per tick ends
at (32,32) (B:1821–1827) unless the player clicks first (C:1432). The interface opens only after
the player talks to Minimus (C:1443 → C:1444; B:1853 → B:1854), with completed-wave argument 0 and
the title "Fortis Colosseum". **VERIFIED** (C), B consistent.

### 1.4 Hand-off to wave 12

Offsets from the final T0 (the 4133 change, Tk+5):

| Offset | A | K | Event | Status |
|---|---|---|---|---|
| 0 | 4970 | 3992 | 4133 change, no `Wave: 12` message; seated Sol plays 10876 `npc_colossi_finalboss_01_arena_jump` | VERIFIED (A seq; 4133 both) |
| +1 | 4971 | 3993 | "Sol Heredit jumps down from his seat..."; fade overlay | VERIFIED |
| +4 | 4974 | 3996 | player teleported to (33,31) on plane 2; seated Sol `del` | VERIFIED |
| +5 | 4975 | 3997 | player teleported to (33,31) plane 0 | VERIFIED |
| **+6 = C** | 4976 | 3998 | Sol 12821 added at (31,36) (the Sol docs' *control*); busy → 0; the 48 shield-combatant locs (50753–50758) of the Sol enclosure are added | VERIFIED |

So **C = T0 + 6** for wave 12. In waves 1–11 the Solarflare orbs appear at T0 and Bees at T0+5; in
wave 12 at C+3 and C+8 (the existing `SOL_SOLARFLARE_SPAWN_TICK`, `SOL_BEES_SPAWN_TICK`). DERIVED.

### 1.5 Death

Run state persists after death until the next entry, which clears it (C:1426, C:1428). B: HP 0 at
B:3403, `human_death` B:3406, lobby teleport and every arena NPC deleted at B:3410. A: Doom 15/15 at
A:5299 (seq 10873, spotanim 2711), lobby A:5308. **VERIFIED** (two deaths).

## 2. Compositions and reinforcements

### 2.1 Per wave

Every wave 1–11 starts with the Fremennik warband trio (archer 12814, seer 12815, berserker 12816);
Quartet adds a fourth member (§3.1).

| Wave | Initial, besides the warband (T0) | Reinforcements (T0+66) | Captures |
|---|---|---|---|
| 1 | Serpent shaman | none captured: waves ended at T0+28 (C), T0+51 (B). W-Strat lists a jaguar warrior | B, C |
| 2 | shaman, Javelin Colossus | Jaguar warrior | B, C |
| 3 | shaman, 2× Javelin | Jaguar | A, B, C |
| 4 | shaman, Manticore | Jaguar + shaman | A, B, C |
| 5 | shaman, Javelin, Manticore | Jaguar + shaman | A, B, C |
| 6 | shaman, 2× Javelin, Manticore | Jaguar + shaman | A, B, C |
| 7 | Javelin, Manticore, Shockwave Colossus | Minotaur | A, B, C |
| 8 | 2× Javelin, Manticore, Shockwave | Minotaur (A, C; B died at T0+56) | A, B, C |
| 9 | Javelin, 2× Manticore | Minotaur | A, C |
| 10 | 2× Javelin, 2× Manticore | Minotaur + shaman | A, C |
| 11 | Javelin, 2× Manticore, Shockwave | Minotaur + shaman | A, C |

Identical type multisets in every capture that has the wave, and the same as W-Strat's wave
breakdown (which adds wave 1's jaguar). **VERIFIED.** Two modifiers change the wave and were never
picked in these captures (**WIKI-ONLY**):

- **Dynamic Duo**: "Shockwave Colossi always spawn in pairs"; "the paired Colossus spawns near the
  main Colossus, but not necessarily on one of the 12 default spawns" (W-Mod); "around the location
  of the first" (W-Strat).
- **Red Flag**: minotaurs spawn as 12813 (RL `COLOSSEUM_MINOTAUR_ROUTEFIND`), which "can no longer be
  safespotted" and routefinds around obstacles (W-Mod, W-NPC Minotaur); other NPCs can move into its
  tiles (W-Strat). Same stats row as 12812; cache param 26 is 4 where 12812 has 2 (meaning unknown).

### 2.2 Reinforcements

| Fact | Value | Evidence | Status |
|---|---|---|---|
| Timing | **T0+66**, not kill-dependent | 38/38 adds in the 25 waves that reached +66 (A 3–11, B 2–7, C 2–11); every one arrived with initial NPCs still alive, e.g. C:1600 (wave 2, the javelin dies at +75) | VERIFIED |
| Tiles | y = 48, x ∈ {31, 32, 33} (inside the north gate), `spawnangle=south`; two together take distinct x; no type↔x mapping (jaguar, shaman and minotaur each seen at all three) | 38 adds, e.g. A:1193 shaman (32,48) + jaguar (31,48); A:3627 shaman (33,48) + minotaur (31,48) | VERIFIED (selection rule UNVERIFIED) |
| First step | T0+67, one tile per tick south / south-west | 35/38 (serpents C:1864 +76, A:4311 and C:3511 +68) | VERIFIED |
| Gates | no gate or door loc changes at the north entrance around T0+66 | A:898–906 and the other reinforcement ticks | VERIFIED (absence) |
| South gate | "from either the north or south gates, depending on which one they are closest to" | W-Main; every captured reinforcement entered north | WIKI-ONLY |
| Player at T0+66 | at the start of T0+66 the player stood north of the arena's middle (y ≥ 40, or C's east side at y 34–38) in all 25 reinforced waves. Only C:1600 (wave 2, player (42,34)) was nearer the south opening (Chebyshev 16 to x 31–34, y 18; 17 to y 51), yet its jaguar came north; by SW tile to the captured (32,48) and its footprint mirror (32,19) it was nearer north (14 against 15), as all the others were. The player stood on (43,36) at the start of T0+64 | fixture `CAPTURED_PLAYER_TILES` (A 3–11, B 2–7, C 2–11) | VERIFIED (positions); the measure is UNVERIFIED |
| Same-tick clear | reinforcements arriving on the tick the wave is cleared "will be automatically killed" | W-Main, W-Strat; only wave 1 was ever cleared before +66 | WIKI-ONLY |
| Serpent center spawn | in waves 4–6, 10–11 a shaman reinforcement spawns in the arena center if the player stands next to the jaguar/minotaur spawn point | W-NPC Serpent shaman | WIKI-ONLY |

Other mid-wave adds are modifier actors: Bees at T0+5 (B waves 5–8), healing totems from T0+12
(Totemic, A waves 3–11; [Sol facts §Totemic](./sol-heredit-facts-spec.md#totemic)), Volatility gibs
12828–12831 at death removals (A waves 8–11).

### 2.3 First movement

Warband members first step at T0+2 (89/89, the existing `WARBAND_FIRST_MOVE_TICKS`). Every other
wave NPC that moved first stepped at T0+1 (javelin 34, manticore 27, shaman 26/29, minotaur 11,
shockwave 8; jaguars from add+1). **VERIFIED.**

## 3. Spawn tiles

### 3.1 Warband formation and anchor

| Fact | Value | Evidence | Status |
|---|---|---|---|
| Formation | center = berserker − (0,1); berserker N, archer W, seer E of the center; the Quartet extra S | 28/28 trios; 5/5 Quartet extras (seer B:2201/2630/2975, archer B:2361/3347) | VERIFIED; matches `WARBAND_SLOT_OFFSETS` in `src/npcs/colosseum/warband.ts` |
| Anchor box | berserker x 29..35, y 34..40 (center x 29..35, y 33..39); 23 distinct centers in 28 waves | per-wave spawns, e.g. A w3 (31,35), A w10 (33,40), B w1 (33,38), C w1 (29,35), C w9 (29,39) | VERIFIED range; distribution UNVERIFIED |
| Overlap | the trio does not avoid other spawns | B:2361 archer on the javelin at (29,37) | VERIFIED |

### 3.2 Spawn-point pool (non-warband initial NPCs)

| Fact | Value | Evidence | Status |
|---|---|---|---|
| Points (SW tiles) | nine: (44,32) ×15, (29,37) ×11, (29,31) ×10, (32,27) ×10, (35,37) ×10, (40,35) ×9, (35,31) ×8, (44,37) ×6, (33,42) ×6 | all 85 initial non-warband spawns in the 28 waves | VERIFIED |
| West points (SW tiles) | three more: (19,32), (25,34), (19,37), used by the shaman and the 3×3 species; the 1×1 and 3×3 footprints lie on the floor at each. All three are within Chebyshev 4 of the start tile (23,36) | observed in third-party encounter recordings (not redistributed); none in A, B or C | OBSERVED (third-party); used by maintainer decision |
| Shared | every species uses the pool by its SW tile: the size-1 shaman uses the same tiles as the 3×3 NPCs; javelins appear at all nine | same | VERIFIED |
| Reuse | no point used twice in one wave | 0/28 | VERIFIED |
| Count | W-Strat and W-Mod (Dynamic Duo) refer to "the 12 default spawns"; W-Main calls the locations "completely random". The nine captured and the three west points make twelve | W-Strat, W-Mod; the west points as above | WIKI-ONLY (count) |
| Player avoidance | waiting on the NW-pillar start tile "prevents NPCs from spawning too close"; "By clicking towards the pillar on the 5th tick, NPCs are prevented from spawning in the west area" | W-Strat, "Wave clearing procedure" | WIKI-ONLY |
| Player position | every used point was at least Chebyshev 6 from the player's tile at the start of T0 (82 spawns, 27 waves; A wave 3 starts with no earlier position). The player started T0 on the Wiki's start tile (23,36) in 22 waves, from which the two points 6 away, (29,37) and (29,31), are used. B:1862 started Tk and T0−4 on (34,32), 1 from (35,31), and T0−3 on (32,32), 3 from it, then walked off; (35,31) was used | fixture `CAPTURED_PLAYER_TILES` | VERIFIED (positions); radius and decision tick UNVERIFIED |
| C waves 1–4 | the player north of center, (30..32, 41..43) through T0; all 8 spawns used (44,32), (44,37), (32,27), the three points farthest from them. A uniform choice among the twelve gives that with p ≈ 2×10⁻⁶, and among the points clear of the player by the simulator's rule ([policy](./fortis-colosseum-policy.md#layout)) with p ≈ 2×10⁻⁵; no single radius explains it together with (29,37) at 6 from (23,36) | C:1451/1534/1641/1798 | DERIVED anomaly |

## 4. Arena geometry

| Feature | Value | Source | Status |
|---|---|---|---|
| Walkable floor (waves) | 870 tiles, bounding box x 16..48 × y 18..51, roughly octagonal; east side x ≤ 46 for y 30..39 (emperor's box), x ≤ 47–48 elsewhere | Cache map square 28_48 + the project's walkability analysis (`src/test/helpers/colosseumCollision.ts`) | CACHE |
| Pillars | four 3×3 `PILLAR_CIVITAS01_COLOSSEUM01` (loc 52490), SW (24,26), (39,26), (24,41), (39,41); block movement and line of sight | Cache; `src/render/scene/__tests__/ColosseumAssets.test.ts` | CACHE |
| North gate | x 31..34 at y 51 (gate kit locs 52266/52267 at (31,51)/(34,51), closed gate 52270/52271 at (32,51)/(33,51)); seated Sol 12827 (size 4) sits at (31,51) through waves 1–11 with blocker loc 50703 | Cache; C:1425–1426 | CACHE + VERIFIED |
| South gate | x 31..34 at y 18 (locs 52155/52160 at (33,18)/(31,18), invisible wall 38847 at (32,18)/(33,18)) | Cache | CACHE |
| West gate | closed, locs 52156/52157 at (16,33)/(16,35); no known role | Cache | CACHE |
| Sol enclosure (wave 12 only) | x 26..39 × y 28..41 minus the four pillar-corner tiles (`SOL_ARENA`); 48 shield-combatant locs 50753–50758 on x = 25/40, y = 27/42 (`SOL_BOUNDARY_WARRIORS`) added at C (A:4976, K:3998) | `src/encounters/solHeredit/constants.ts`, `arenaBoundary.ts`; RL ObjectID `SHIELD_COMBATANT_1..6` | VERIFIED |
| Solarflare orbs (waves) | four added at T0 on (38,40), (27,40), (27,29), (38,29) (add order), first step T0+1; each walks a closed square of side 4 from its spawn corner, the same route in every wave and at every tier, outward first (e.g. (38,40) → (38,44) → (42,44) → (42,40)) | A waves 5–11 (A:1333, 1779, 2182, 2645, 3248, 3561, 4245), 28/28 orbs; one full tier-I lap A:1333–1386; `CAPTURED_WAVE_SOLARFLARE` in `src/encounters/colosseum/waves/__tests__/fixtures/waveLayoutCapture.ts` | VERIFIED |
| No wave locs | no gate or door changes at wave boundaries or reinforcement ticks | all boundaries | VERIFIED (absence) |

## 5. Modifiers

### 5.1 Catalog

Cache enum 5312 maps the offer key to a struct: param 1895 bit index in the owned mask, 1896 name,
1897–1899 tier I–III text, 1901 tiered flag, 1903 Glory per wave per tier. Stack varbit names are
RL VarbitID; the key → struct → varbit mapping is ClientScript `script4980`. Every observed stack
change and owned mask (e.g. C:1482 mask 16 = bit 4 Blasphemy; A:1107 mask 144 = Blasphemy +
Totemic) agrees. **CACHE + VERIFIED.**

| Key | Struct | Name | Tiers | Stack varbit | Glory/wave/tier | Tier text (cache, abbreviated) |
|---|---|---|---|---|---|---|
| 0 | 915 | Mantimayhem | 3 | 4588 | 150 | extra projectile per orb / …and Venom on hit / …and melee orbs anywhere in the sequence |
| 1 | 891 | Reentry | 3 | 9792 | 150 | javelins leave a temporary / big permanent / very big permanent pool of molten sand |
| 2 | 892 | Bees! | 3 | **9791** `colosseum_modifier_toxicity_stacks_client` | 150 | one / two / three swarms |
| 3 | 893 | Volatility | 3 | 9799 | 100 | enemies explode on death / in a large radius / …and leave molten sand |
| 4 | 894 | Blasphemy | 3 | 9790 | 100 | prayer drained by 20 / 40 / 60% of off-prayer damage |
| 5 | 897 | Relentless | 3 | 9798 | 200 | ignore 33% Defence, +1 / 66%, +3 / all Defence, +6 |
| 6 | 898 | Quartet | 1 | — | 100 | an extra random warbander every wave |
| 7 | 899 | Totemic | 1 | — | 200 | healing totems aid enemies |
| 8 | 900 | Doom | 3 | 10681 | 200 | a Doom stack per damage taken; death at 15 / 10 / 5; resets each wave |
| 9 | 901 | Dynamic Duo | 1 | — | 150 | Shockwave Colossi always spawn in pairs |
| 10 | 902 | Solarflare | 3 | 9797 | 250 | orbits slowly / quickly, more damage / very quickly, disables prayer |
| 11 | 903 | Myopia | 3 | 9795 | 200 | range reduced by 2 / 4 / 6 tiles |
| 12 | 906 | Frailty | 3 | 9796 | 200 | max HP reduced by 10 / 20 / 40%, no boosting |
| 13 | 907 | Red Flag | 1 | — | 250 | minotaurs can no longer be safespotted |

There is no separate "Toxicity" modifier: varbit 9791's internal name belongs to Bees! (struct 892).
The Doom Scorpion (NPC 12822) was a fourteenth modifier until 10 Apr 2024, when Mantimayhem replaced
it (W-News). Varbit 9801 `colosseum_doom_stacks_client` holds the current Doom count.

### 5.2 Selection interface contract

Cache ClientScript `colosseum_intermission_2_init` (4931) takes `(completedWave, offer1, offer2,
offer3, previousLootGp, nextLootGp, totalLoot, ownedMask)`; offers are enum-5312 keys. Completed
wave 0 shows the title "Fortis Colosseum" and disables Claim; otherwise "Wave N Completed!". An
offered tiered modifier is drawn at **owned tier + 1** (" (II)"/" (III)", text param 1898/1899).
Clicking a button toggles `%colosseum_selected_modifier` (9788); **Continue** is enabled only while
it is > 0 (`script4932`); **Claim** opens a confirm. The hover panel shows the name, the next tier's
text and "+param 1903 Glory per wave". Interface 865 components: RL InterfaceID
`COLOSSEUM_INTERMISSION_2` (`MOD_BUTTON_1..3`, `RIGHT_BUTTON` = Continue, `LEFT_BUTTON` = Claim).
**CACHE.**

### 5.3 Offer rules

| Rule | Source | Status |
|---|---|---|
| Three distinct modifiers per offer | 30/30 captured offers | VERIFIED |
| A tier-III modifier, or an owned single-tier one, is never offered again | 0 violations in 30 (e.g. Blasphemy after C w5, Relentless after B w2 / C w7, Doom after C w8, Quartet after B w3, Totemic in A) | VERIFIED |
| The first offer is Blasphemy / Relentless / Frailty | W-Strat ("will always consist of"); both captured wave-0 offers (B:1854, C:1444) | VERIFIED (n=2) |
| "a preference towards upgrades" | W-Strat; ≥1 upgrade offered in 19/22 offers where one was possible (not C w1, B w6, A w8); two upgrades at once in C w2/w4/w6, A w9/w10 | WIKI-ONLY weight; preference consistent |
| Red Flag and Dynamic Duo "available before wave 7" | W-Strat; first seen offered after wave 6 (B, C, A) | consistent |
| Mantimayhem not offered going into wave 12 | W-News 24 Apr 2024 | WIKI-ONLY |
| Reentry, Red Flag, Dynamic Duo "will not be given as an option after wave 11" | W-Mod only (no news post); none offered after wave 11 in A, C/K | WIKI-ONLY; consistent |
| Earliest wave seen offered | Mantimayhem, Doom, Quartet, Frailty 1; Reentry, Totemic 3; Bees!, Solarflare 4; Volatility, Myopia 5; Dynamic Duo, Red Flag 6 | VERIFIED as observations, not gates |

### 5.4 Observed offers and picks

Offers as drawn (owned tier + 1); "after" = waves completed; tick = interface open.

| Cap | After | Tick | Offers | Pick (stack change at Tk) |
|---|---|---|---|---|
| A | 3 | 1107 | Blasphemy III / Reentry / Mantimayhem (Blasphemy II, Totemic held) | Blasphemy III (A:1122) |
| A | 4 | 1295 | Relentless / Solarflare / Quartet | Solarflare I (A:1328) |
| A | 5 | 1730 | Solarflare II / Quartet / Volatility | Solarflare II (A:1774) |
| A | 6 | 2135 | Solarflare III / Quartet / Mantimayhem | Solarflare III (A:2177) |
| A | 7 | 2521 | Frailty / Red Flag / Volatility | Volatility I (A:2640) |
| A | 8 | 3054 | Doom / Red Flag / Frailty | Doom I (A:3243) |
| A | 9 | 3547 | Volatility II / Doom II / Relentless | Volatility II (A:3556) |
| A | 10 | 4184 | Volatility III / Doom II / Frailty | Volatility III (A:4240) |
| A | 11 | 4871 | Doom II / Frailty / Bees! | Bees! I (A:4965) |
| B | 0 | 1854 | Blasphemy / Relentless / Frailty | Relentless I (B:1857) |
| B | 1 | 1916 | Relentless II / Frailty / Quartet | Relentless II (B:1926) |
| B | 2 | 2029 | Relentless III / Quartet / Mantimayhem | Relentless III (B:2032) |
| B | 3 | 2181 | Quartet / Frailty / Reentry | Quartet (B:2196) |
| B | 4 | 2336 | Bees! / Doom / Blasphemy | Bees! I (B:2356) |
| B | 5 | 2567 | Bees! II / Volatility / Myopia | Bees! II (B:2625) |
| B | 6 | 2925 | Dynamic Duo / Frailty / Red Flag | Frailty I (B:2970) |
| B | 7 | 3302 | Bees! III / Mantimayhem / Volatility | Bees! III (B:3342) |
| C | 0 | 1444 | Blasphemy / Relentless / Frailty | Blasphemy I (C:1446) |
| C | 1 | 1482 | Frailty / Mantimayhem / Doom | Doom I (C:1529) |
| C | 2 | 1633 | Blasphemy II / Mantimayhem / Doom II | Blasphemy II (C:1636) |
| C | 3 | 1778 | Doom II / Totemic / Relentless | Relentless I (C:1793) |
| C | 4 | 1933 | Relentless II / Doom II / Quartet | Doom II (C:1956) |
| C | 5 | 2117 | Blasphemy III / Volatility / Bees! | Blasphemy III (C:2120) |
| C | 6 | 2395 | Relentless II / Doom III / Red Flag | Relentless II (C:2404) |
| C | 7 | 2617 | Relentless III / Volatility / Solarflare | Relentless III (C:2636) |
| C | 8 | 2832 | Doom III / Volatility / Red Flag | Doom III (C:2858) |
| C | 9 | 3054 | Quartet / Frailty / Solarflare | Frailty I (C:3059) |
| C | 10 | 3434 | Frailty II / Reentry / Myopia | Myopia I (C:3440) |
| C/K | 11 | C:3723, K:3978 | Frailty II / Quartet / Solarflare | Frailty II (K:3987) |

A's picks before the capture are DERIVED: Blasphemy I and II in waves 0–1 (9790 = 2 at A:770) and
Totemic going into wave 3 (button 2 at A:829, no stack change, first totem A:850).

### 5.5 Effects at wave boundaries

| Fact | Value | Evidence | Status |
|---|---|---|---|
| Frailty timing | a new tier's maximum HP appears on the next **T0**, five ticks after the confirm, not on the confirm | B:2970→2975, C:3059→3064, K:3987→3992 | VERIFIED |
| Frailty arithmetic | max HP = base − floor(base × 10/20/40%), always from base, not compounded: 99 → 90 (I) → 80 (II) | 99→90 at B:2975 and C:3064, 90→80 at K:3992; Wiki Strategies (oldid 15354864) gives 90/80/60 | VERIFIED (I, II); III WIKI-ONLY |
| Frailty and current HP | the player was at full HP at every captured change, so whether current HP is clamped or set to the new maximum is not shown | — | UNVERIFIED |
| Doom | points reset at T0, tier kept; message only when points were held (§1.1) | C:1641, A:4970; C:2863, C:3445 | VERIFIED |
| Totemic in waves | a totem appears on the tick a fighter is first at or below 50% HP, on the tile diagonal SW of it (else NE), heals floor(30%) of its max HP (jaguar and shaman 37, minotaur 67, javelin 66; 2 of 19 capped at the missing HP), and leaves 0–1 ticks after its target dies; no target received a second totem | Run A waves 3–11, 55 totems (A:850–4832); [Sol facts §Totemic](./sol-heredit-facts-spec.md#totemic) | VERIFIED |
| Doom from javelin artillery | two stacks per hit (W-NPC Javelin Colossus rev 15411467, a bug note; W-Strat) | no artillery hit the player in A/B/C | WIKI-ONLY |
| Volatility gib | on the dying NPC's **removal** tick: the explosion around its last footprint, and a gib NPC (12828 human, 12829 manticore, 12830 minotaur, 12831 colossi; seqs 10834–10837, explosion spotanims 2713/2721–2723) added on its south-west tile for 3 ticks | Run A, 33/33 wave gibs; the warband and shaman use 12828. No jaguar (12810) or Red Flag minotaur (12813) gib is captured | VERIFIED; jaguar and 12813 mappings UNVERIFIED |

## 6. Wave NPCs

### 6.1 Identity and stats

Ids and names: RL NpcID and the cache; HP, stats, bonuses and attack speed: `monsters.json` (Wiki
infobox dataset, [provenance](../legal/data-provenance.md)); max hits: W-NPC infoboxes.

| NPC | Id | RL name | Size | HP | Speed | Wiki max hit | Spawn seq | Death seq → `del` |
|---|---|---|---|---|---|---|---|---|
| Serpent shaman | 12811 | `COLOSSEUM_STANDARD_MAGER` | 1 | 125 | 5 | 28 magic | 10861 | 10860, +3 (29/29) |
| Jaguar warrior | 12810 | `COLOSSEUM_JAGUAR_WARRIOR` | 2 | 125 | 5 | 47 ×3 slash | 10862 | 10849, +3 (14/14) |
| Minotaur | 12812 (Red Flag 12813) | `COLOSSEUM_MINOTAUR` (`_ROUTEFIND`) | 3 | 225 | 5 | 74 crush | 10845 | 10846, +4 (11/11) |
| Javelin Colossus | 12817 | `COLOSSEUM_JAVELIN_COLOSSUS` | 3 | 220 | 5 | 48 ranged (49/51/54 at Relentless I/II/III) | none | 10894, +3 (32/32) |
| Manticore | 12818 | `COLOSSEUM_MANTICORE` | 3 | 250 | 10 | 31 melee / 36 ranged / 31 magic | 10871 | 10866, +4 (26/26) |
| Shockwave Colossus | 12819 | `COLOSSEUM_SHOCKWAVE_COLOSSUS` | 3 | 125 | 5 | 56 magic | none | 10895, +4 (7/7) |

Capture HP closure agrees: splats minus heals sum to exactly the Wiki HP in 29/29 shamans, 14/14
jaguars and most colossi and manticores (the rest differ by natural regeneration or totem heals);
minotaurs close at 225 only with the passive regeneration in §6.5. Totemic heals are floor(30%):
37, 37, 67, 66. **VERIFIED.** The death sequence starts on the killing tick or the next, as the
existing queued-death rule ([npc-hit-queue-and-death.md](../architecture/npc-hit-queue-and-death.md)).

### 6.2 Shared attack gate, line of sight and prayer

| Fact | Value | Evidence | Status |
|---|---|---|---|
| Gate | ready, in range (box distance 1..range to the player's **start-of-tick** tile) and in line of sight, evaluated from the NPC's **post-movement** position that tick; it may move and attack on one tick | Javelin 444/444 attacks, shockwave 63/63, manticore 191/191 throws, shaman 241/241 casts; no attack on ready ticks failing the gate except ticks where the NPC or player was already dying (javelin 6, shockwave 1) and one shaman step-out tick (B:2254) | CAPTURE-FIT |
| Line of sight | a ray traced **from the player's tile to the NPC** (the footprint tile nearest the player for 3×3 NPCs), RuneLite tile stepping, pillar tiles block. This is the existing target-to-attacker contract of `hasNpcAttackReach` (`src/core/combat/npcAttackRequest.ts`) | the fits above; the reverse ray or a center ray misses dozens. Decisive: A:3637–3718 shaman at (25,44) never casts at the player at (22,42–43) (the player→NPC ray hits (24,43)), then moves to (24,44) and casts on the same tick, A:3719 | CAPTURE-FIT |
| Projectile target | the player's start-of-tick tile; source the NPC's tile (3×3: center SW+(1,1)) after movement | 370 javelin, 63 shockwave, 572 orbs, 241 shaman | VERIFIED |
| Prayer | decided by the protection prayer active **after the launch/cast tick's input**, not at landing; protected damage is 0 | shaman 186/186 prayed-at-cast zeros (incl. off before landing), 5 unprayed-at-cast hits that were prayed later (e.g. C:1867→1871 = 28); javelin 25/25 prayed at launch, off at landing, zero, 3/3 the reverse damaged (A:2651→2654 35); manticore 489/489 orbs; shockwave 9/9 on-at-launch, off-at-landing zeros (no reverse witness) | VERIFIED (shockwave consistent) |
| Spawn lockout | no attack before add+3 | javelin: 3 attacked at add+3, none on 65 earlier gate-passing ticks; shaman first cast ≥ add+3 (9/9 that could cast at +3 did); minotaur first action add+3 (C:2478 heals at +3 with its target in reach at +1/+2). Shockwave (earliest add+5) and jaguar (none reached the player before add+5, B:1997) never passed the gate earlier | CAPTURE-FIT (javelin, shaman, minotaur); consistent for the others |
| Spawn step | every non-warband NPC steps once on add+1, even when the gate already passes | colossi 42/42 (A:838 (29,31)→(28,32)), manticore 27/27, shaman 8/8 | VERIFIED |
| Movement | walk one tile per tick, never run; only while the gate fails; stops on the first tile where it passes; the standard greedy step toward the player (diagonal, else x, else y), blocked by pillars and by the other wave NPCs' footprints (not the warband's, Solarflare orbs', thralls', bees' or totems'), so NPCs stall behind pillars | shaman 1588/1594 scored decisions; minotaur 606/615; jaguar 564/595 (misses are the player under its 2×2 footprint and some diagonals); javelin and shockwave 7,572/7,581 ticks replayed through `standardNpcCombatMove` from add+2 (misses: the player under the footprint, deaths, stalls B:2742, C:3367); manticores follow the same step but were not replayed separately | CAPTURE-FIT |
| Hits in flight | a released javelin, shockwave or shaman projectile still lands after its source dies, including one cast on its killing tick. Manticore orbs are the exception (§6.8) | javelin B:1995→1998, C:2732→2735; shockwave B:3293→3298, C:3480→3484; shaman A:1967→1970, C:3226→3229, in flight at death A:1171, C:1474 | VERIFIED |
| No melee | javelin, shockwave, manticore and shaman never melee; at d=1 they use their normal attack; nothing attacks at d=0 | javelin 76 ranged at d=1 (A), shaman 45 casts at d=1 | VERIFIED |

The warband is different: breadth-first routing that ignores NPCs, a slot formation and a fixed
6-tick cycle; see [Sol facts §Fremennik warband](./sol-heredit-facts-spec.md#fremennik-warband-and-quartet).
Waves need no new warband behavior (28/28 waves). **VERIFIED.**

### 6.3 Serpent shaman (12811)

| Fact | Value | Evidence | Status |
|---|---|---|---|
| Cast | seq 10859 + spotanim 1458 (height 92) + projectile 1459 on the cast tick | 241/241 (1458 missing in 10, each displaced by a thrall impact in the same slot) | VERIFIED |
| Projectile | start 67, heights 172→146, slope 14, progress 32; **end = max(80, 67 + 4d)** cycles | 241/241, d 1..10 | CAPTURE-FIT |
| Impact | spotanim 1460 on the player, delay = end, only on an accurate cast; absent ⇒ 0 splat | 185/241 present; 56/56 absent were 0 | VERIFIED |
| Hit tick | **cast+3 for d ≤ 8, cast+4 for d 9–10** (not floor(end/30), which gives +3 at d 9–10) | every cast, e.g. C:1454→1458 d10, C:1459→1462 d1, C:1970→1974 d9 | VERIFIED |
| Cycle / range | 5 ticks; range 10 (casts at d 9–10 16/16, none at d ≥ 11 in 32 ticks); W-NPC "range of 10 tiles" | 196/210 gaps of 5, longer only when the gate failed | VERIFIED |
| Style | magic (Water Surge, W-NPC) | — | VERIFIED |
| Damage | observed unprayed 3..28 (max 28 at C:1871); Wiki max 28 (W-Strat says 27) | 10 unprayed impacts | consistent |
| Poison / venom | not testable: the recording player held poison immunity throughout | varp 102 ≤ 0 in A, B, C | UNVERIFIED |
| Player underneath | steps off and does not cast that tick | B:2102, B:2254 | VERIFIED (n=2) |
| Walk-in with the player adjacent | the add+1 step is taken even with reach (8/8); no capture has the player adjacent on add+1 | — | UNVERIFIED |

### 6.4 Jaguar warrior (12810)

| Fact | Value | Evidence | Status |
|---|---|---|---|
| Attack | seq 10847; no spotanim, projectile or map_anim | 70 attacks (A 37, B 16, C 17) | VERIFIED |
| Hits | **three splats on the attack tick itself**; W-NPC: "each hit having its own independent accuracy and strength roll", max 47 each | 65/65 attacks not on its own killing tick | VERIFIED timing; rolls WIKI-ONLY |
| Gate | ready (5 ticks) and **cardinally** adjacent (footprint gap (0,1) or (1,0)) from its post-move tile to the player's start tile; diagonal adjacency and the player underneath never attack | 70/70; diagonal A:1407, C:1763; underneath C:1610 | CAPTURE-FIT |
| Move and attack | same tick allowed | 4/70, e.g. C:1732 walk (42,40)→(43,41) and attack | VERIFIED |
| Killing tick | the attack animation can play on the tick it is killed, with no splats | A:1443, A:1908, C:1626 | VERIFIED (n=3) |
| No extras | no leap, bleed or staggered splats | 150/150 one-tile walks; no bleed splat | VERIFIED (absence) |
| Prayer | Protect from Melee at attack and landing: 0 in 195 splats; timing not discriminated | 65 attacks | VERIFIED |
| Damage | one unprayed attack, 0/0/0 (C:1732) | — | UNVERIFIED |

### 6.5 Minotaur (12812)

| Fact | Value | Evidence | Status |
|---|---|---|---|
| Melee | seq 10843, one splat at **attack+1**; cardinal adjacency from the post-move tile; 5-tick cycle | 66/66 (A 42, B 6, C 18), e.g. C:2488→2489 | CAPTURE-FIT |
| Movement | moves on add+1 ("will immediately move upon spawning", W-NPC); greedy, stalls behind pillars (C:3143–3195, A:2274–2334 at d=2, no attack) | 606/615 | CAPTURE-FIT |
| **Passive regeneration** | **+5 HP every 20 ticks from the spawn tick**, capped at max, no hitsplat: the pulse lands at the end of its own turn on add+20k (k ≥ 1), i.e. ahead of the hits of add+20k+1 | one zero-mismatch fit across 11/11 lives (9 different add residues mod 20; 340/340 headbars, every life closes at exactly 0); the order is fixed by B:3062, C:2748 and the final hits B:3082, A:2389; without regeneration 217 headbar mismatches; visible rises C:2497, C:2952, C:3173, A:4412 | CAPTURE-FIT |
| **Heal another enemy** | seq **10844** (`npc_minotaur_boss_attack_magic`) is an ally heal, not an attack: C:2478, add+3, the minotaur walks (31,46)→(30,45) and casts; the javelin at (27,40) takes 7 (10→3 HP) and a heal splat 217 on the same tick restores it to 220; spotanim 444 on the healed NPC; no projectile; the combat-task failure message "An enemy was healed by the Minotaur" | one case | SINGLE-OBSERVATION |
| Heal after-effect | adjacent from C:2487 but first melee at C:2488 = heal+10 | one case | SINGLE-OBSERVATION |
| Heal rule (Wiki) | Mod Arcane, quoted on W-NPC Minotaur: timer-driven; melee when the player is in melee range; otherwise scan a 10-tile radius from its center for a non-minotaur below 75% HP whose center is in line of sight of the minotaur's center and ≤ 7 tiles away, and heal it (to full). With both radii Chebyshev from the center, the 7 binds and the 10 adds nothing. W-Strat says "within 6 tiles" | — | WIKI-ONLY (conflicting radius) |
| Heal witnesses | the Wiki rule (center ≤ 7, center line of sight, < 75%, non-minotaur, ready) reproduces the positive case and every negative: no heal at C:2707 (javelin fill 1), C:2929 (manticore fill 2), A:4311, A:2711, A:3314. The 10-tile radius alone would heal at A:2714 and A:3317, and dropping line of sight would heal at C:2710, C:2932 and A:2735; C:3511 would heal at add+1/+2 but is out of reach by add+3 | `minotaurCapture.test.ts` replays all 11 lives | CAPTURE-FIT; 6/7/8 not separated |
| Heal and the player diagonal | the Wiki's melee range includes diagonal; the minotaur only swings cardinally (66/66). Whether a diagonal player suppresses the heal is not captured | — | UNVERIFIED |
| Prayer | Protect from Melee: 0 in 66/66 | — | VERIFIED |
| Damage | never unprayed | — | UNVERIFIED |

### 6.6 Javelin Colossus (12817)

| Fact | Value | Evidence | Status |
|---|---|---|---|
| Ranged attack | seq 10892 + projectile 2673, start 58, end **90 at every distance**, slope 16, heights 200→138; hit **launch+3** | 370/370 projectiles; splats A 173/173, B 75/76 (the miss after the player's death), C 121/121 | VERIFIED |
| Cycle / range | 5 ticks; range 15 (attacks at d 15, none at d ≥ 16 with LOS) | 379/412 gaps of 5, none shorter, longer ones are LOS/range waits | VERIFIED |
| First attack | earliest add+3 | 3 instances | VERIFIED |
| **Attack pattern** | strict per-instance **R R R R A** (every fifth attack is artillery); the counter persists across line-of-sight gaps (A:842 R, a 172-tick gap, A:1014/1019/1024 R, A:1029 A) | 34/34 instances, 0 violations; W-NPC "every five attacks", W-Strat "after every four auto-attacks" | VERIFIED |
| Artillery cast T | seq 10893 + NPC spotanim 2676 (delay 60) | 74 casts (4 with the spotanim slot displaced by a player effect) | VERIFIED |
| Artillery target | **the player's tile at the start of T+2**, one tile | 74/74 (e.g. A:1811 target (21,42), not the T tile (22,41)) | VERIFIED |
| Artillery cues | T+3: map_anim 1446 shadow + 2674 `artillery_slow`, delay 30, on the target tile; T+6: map_anim 2265 blast; single tile, no 3×3 pattern | A 37/37, B 15/15, C 22/22 | VERIFIED |
| Cancel on death | the falling javelin is released on the colossus's T+3 turn. A death before that cancels it: cast B:2559, death processed T+2 (B:2561), no cues; cast A:915, killed on T+3 (A:918), shadow sent (from the T+2 turn) but no blast. After release the blast still lands at T+6: casts A:2124 and C:3359, both killed on T+5. T+4 as the release turn fits as well | 4 cases | CAPTURE-FIT |
| Artillery damage | "up to 40 typeless", ignores Protect from Missiles, lands 6 ticks after the cast (W-Strat); with Doom it adds **two** stacks (W-NPC, W-Strat: a bug). **No artillery ever damaged the player** (0/74); the only damage window consistent with every miss is a 1×1 check on the player's start-of-T+6 tile | negative evidence only | WIKI-ONLY damage; window UNVERIFIED |
| Ranged damage | observed unprayed max 46 (A:3874), under the Wiki 48 | 9 samples | consistent |

### 6.7 Shockwave Colossus (12819)

| Fact | Value | Evidence | Status |
|---|---|---|---|
| Attack | seq 10903 + projectile 2520, start 50, progress 40, heights 158→100; single-target magic, **no ground cue or area** | 63 casts; W-NPC "no special mechanics" | VERIFIED |
| Flight / hit | **end = 76 + 8d** cycles (d from the NPC center to the target tile), hit at **launch + floor(end/30)**: d 2–5 +3, 6–9 +4, 10–12 +5, 13–16 +6 | 63/63 ends; 62/63 splats (the miss is B:3404, after the player's death) | VERIFIED (unobserved d DERIVED) |
| Impact | player spotanim 2254, delay = end; absent in ~14/63 (slot conflicts), so not a cue to key on | — | VERIFIED |
| Cycle / range | 5 ticks; 15 (attack at d 15, B:3263; none at d 16–18) | — | VERIFIED |
| Damage | one unprayed sample, 21 (B:3399→3403, Relentless III); Wiki 56 | — | UNVERIFIED |

### 6.8 Manticore (12818)

| Step | Tick | Evidence | Status |
|---|---|---|---|
| Spot S | first tick ≥ add+3 with line of sight and d ≤ 15 | 26/26 first charges at S+4 | CAPTURE-FIT |
| Charge C | S+4: seq 10868 `triple_charge`; persists without line of sight | e.g. one LOS tick at C−4, then none, still charged | CAPTURE-FIT |
| Orbs shown | C+1, C+2, C+3: overhead spotanims in slots 1/2/3 (heights 300/400/500), first style, second style, melee 2685 | A:1137–1139 | VERIFIED |
| Throw T | first tick **≥ C+6** with line of sight, d ≤ 15 and no stagger block: seq 10869 `triple_throw` | 0 mismatches over 1,204 ready ticks | CAPTURE-FIT |
| Orbs fired | T, T+1, T+2, each a projectile (start 0, end 30) and each **lands +1** (T+1, T+2, T+3); each slot clears as its orb launches. The first orb leaves from the post-step tile, later ones from the tile it started that tick on (A:2864) | 190/191 throws had 3 orbs | VERIFIED |
| Death mid-throw | **no orb lands on or after the manticore's killing tick**, not even as a blocked 0; an orb due on the killing tick still launches (A:4177) but nothing later (no third orb at A:4178); a ready manticore with reach starts no throw on its killing tick (A:1218, C:3047, C:3716) | 10/10 kills mid-throw, e.g. A:1723, A:4177/4178, C:1864 | VERIFIED |
| Orb after line of sight is lost | a started throw finished without reach once (A:2864) | one case | SINGLE-OBSERVATION |
| Next charge | **T+4** always; a 10-tick cycle under continuous line of sight (W: 10) | 181/181 | VERIFIED |
| Holding | without line of sight a charged manticore keeps its orbs indefinitely and does not recharge (holds up to 203 ticks, A:2660→2863) | — | VERIFIED |
| Style order | the **third orb is always melee** (572/572); the first two are ranged→magic or magic→ranged, **fixed per instance** (0/27 changed); magic-first 10, ranged-first 12 over independent decisions; W-NPC "either use a range-magic or magic-range…the last hit is always melee" | — | VERIFIED order; odds consistent with 50/50 |
| Ids | magic 2681, ranged 2683, melee 2685 (projectile and overhead); impacts 2682/2684 | — | VERIFIED |
| Pairs (waves 9–11) | the two share one order (6/6 pairs; W-NPC: the other copies the pattern when within 15 tiles with sight). W-NPC: "any other manticore that is ready to attack … will have its attack delayed by 5 ticks"; captured, one that was ready when the other threw on tick o cannot throw on o..o+4 and throws at o+5, and they then alternate 5 apart (A:3428→3433, C:3636→3641). The captures cannot tell "ready at o" from any reading that also blocks a not-yet-ready one, because no overlap occurred. When both are ready on one tick, the lower NPC index throws first (A:3422→3428/3433, C:3630→3636/3641) | 10/10 blocked ticks; tie 2/2 (one in A, one in C) | VERIFIED stagger; copy condition WIKI-ONLY; tie CAPTURE-FIT (n=2) |
| Overlap | W-NPC: two manticores "can overlap attacks" if one is not yet ready; never captured (no throws < 5 apart) | — | WIKI-ONLY |
| Melee orb type | stab: cache NpcType 12818 param 26 is 0, as on the stab-only berserker (jaguar 1 slash, minotaur 2 crush); the Wiki names no melee type | — | DERIVED (CACHE) |
| Damage | unprayed magic 13 (A:1703), ranged 9 (C:2018), melee 33 under Relentless III (B:3179), above the Wiki's 31 | 3 samples | UNVERIFIED distribution |
| Mantimayhem | never active (varbit 4588 only reset 2→0 at C:1426) | — | UNVERIFIED |

## 7. Completion

A wave completes on the `del` of its last required NPC, not its killing hit (27/27): the death
sequence plays Tc−3 (shaman, jaguar, javelin, warband) or Tc−4 (manticore, shockwave, minotaur).
Modifier actors (Bee swarms, Solarflare orbs, healing totems) do not hold a wave open; swarms and
orbs are deleted at Tc, and no totem was ever still present then (§1.2). **VERIFIED.** Quartet's extra warbander is a wave NPC like the trio; no
capture isolates it as the last one alive (DERIVED).
