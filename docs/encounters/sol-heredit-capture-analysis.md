# Sol Heredit capture analysis

## Scope, citations, and evidence discipline

The derivations behind the Sol Heredit rules. The
[timing verification ledger](./sol-heredit-facts-spec.md#timing-verification-ledger) records each
rule's status, and the [unverified behavior register](./sol-heredit-unverified.md) lists the models
and policies these derivations do not settle. Sections 1–7 analyze K and M; §§8–9 cover Sol's
movement, §10 adds N, §§11–12 cover transitions and beams across K/M/N, and §13 the long fight L.
Where a later section narrows a K/M conclusion, it says so.

Capture citation aliases used throughout, including in tables and data blocks:

- **K** = `colosseum-sol-heredit-packet-data.txt`, ticks 3959..4237, control **3998**; wave 12 of
  wave capture C's run.
- **M** = `colosseum-sol-heredit-solar-flare-doom-volatility-packet-data.txt`, ticks 8266..8537, control **8273**.
- **N** = `colosseum-sol-heredit-packet-data-2.txt`, ticks 7279..7796, control **7302**, Sol npc index 41843.
- **L** = `colosseum-sol-heredit-long-fight-packet-data-3.txt`, ticks 3422..5848, contiguous, control **3451**, Sol death **5833**; Relentless II is explicit at L:3440.
- **A**, **B** and **C** are the wave captures listed in the [capture inventory](./sol-heredit-facts-spec.md#captures).
- A table headed K or M assigns that capture to every tick in it. `K:4006` is a complete capture-and-tick citation. Inclusive ranges describe an exhaustively searched window, not a claim that every tick contains the event.
- **OBSERVED** means packet fields or their lossless transcription. **DERIVED** means a computation over those fields; the computation is stated. **UNCERTAIN** means a hypothesis or a limit, not a rule to implement without further evidence.

**OBSERVED [K:3959..4237; M:8266..8537]:** both captures are contiguous (279 and 272 ticks) and both end in a kill. The two fight clocks start at Sol's addition and `busy 1->0`, K:3998 and M:8273, not the earlier jump/cutscene starts K:3992 and M:8267.

**DERIVED [K:3998; M:8273]:** world `(1823,3108)` minus supplied spawn sim `(31,36)` gives offset `(1792,3072)`. All tile coordinates below are sim coordinates unless explicitly called world. No axes are flipped. `+X` east, `+Y` north. Convert any cited tick to encounter-relative time with `K tick - 3998` or `M tick - 8273`; multiply by 0.6 for seconds. Sol's packet tile is called `S=(sx,sy)`. The repeated 5-by-5 block of melee effects is `S+[0..4]x[0..4]`; its central tile is `C=S+(2,2)`.

**Conventions.** Actor animation records are named **`sequence`**, not `anim`. A
`facing player=...` record inside Sol's actor update is Sol targeting the player; a
`facing npc=...` inside the player's update is the player's own target. Hits and actor spotanims
belong to the actor whose update block contains them. Hit records include zero hits and several
hits on one tick. An omitted `map_anim` delay is zero; Sol's melee uses even delays 0..20.
No burst was deduplicated as a scene reload.

Sections 1–7 are derived from the packets alone, without Wiki or external implementation
material and without importing inferences from earlier-wave NPCs.

## 1. Melee geometry and timing

### Arena perimeter LOCs

**OBSERVED [K:3998; M:8273]:** 48 loc placement records use
`shield_combatant_1..6` (50753..50758), shape 10, level 0. They are LOCs, not NPC
actors. Both captures agree on all coordinates and rotations; cosmetic variant
selection differs. In local coordinates:

| Side | Tiles | Rotation |
|---|---|---:|
| North | x=27..38, y=42 | 0 |
| East | x=40, y=29..40 | 1 |
| South | x=27..38, y=27 | 2 |
| West | x=25, y=29..40 | 3 |

`arenaBoundary.ts` reproduces K's exact variant arrangement; `arenaBoundary.test.ts` compares it
with the K and M placements extracted in `__tests__/fixtures/solBoundaryGuardsCapture.ts`. Cache
collision baking must include these dynamic LOCs; the static Colosseum map alone does not contain
the fight fence.

### 1.1 Effect IDs do not identify different attack shapes

**OBSERVED [every burst in the tables below]:** all three IDs **2669, 2670, 2671 occur together in every burst**, for both spear and shield attacks. They partition the burst: no duplicate tile within a burst and no tile receives two of these IDs. The number per ID varies even for identical geometry: K:4006 has `20/8/16`, M:8282 has `15/17/12`, both with exactly the same 44 tiles. K:4086 and K:4103 are identical 160-tile shield shapes with different ID assignments. Thus **none of these IDs uniquely means narrow spear, wide spear, or shield**. Treating 2669/2670/2671 as three mechanical shapes is contradicted. A random visual-variant selector is plausible but its probability distribution is **UNCERTAIN**. The per-burst counts are in §1.4 and Appendix A keeps the per-tile assignment of K:4086 and K:4103. The ground-attack fixture stores tiles and delays only, not graphic ids; production cycles the three ids by tile index.

**OBSERVED [K:4003..4215; M:8279..8511]:** every melee burst follows the corresponding Sol `sequence` by exactly **3 ticks**. Spear uses `npc_colossi_finalboss_01_melee_attack_telegraph (10883)`; shield uses `npc_colossi_finalboss_01_shieldslam_telegraph (10885)`. The table reports both the warning-sequence tick and the ground-effect emission tick. Calling only the latter the telegraph would lose three ticks of warning.

**DERIVED [all 4,800 tiles, K:4006..4215; M:8282..8511]:** every emitted melee tile `P` has delay

```text
delayCycles(P) = 2 * max(abs(P.x - C.x), abs(P.y - C.y))
C = S + (2,2)
```

All delays are below 30 cycles, so floor-binning gives the emission tick for every tile, while visual propagation is spread within that tick (2 cycles per Chebyshev-distance step). This is a **visual delay identity**, not proof of the server damage-resolution instant.

**UNCERTAIN in K/M [K:4003..4221; M:8279..8512]:** no damaging spear or shield hit is recorded. The player repeatedly moves out immediately before emission and returns on emission, e.g. K:4005 `(33,34)` then K:4006 `(33,35)`, although `(33,35)` is in the K:4006 set; no player hit follows. The emitted visual set is therefore not a simultaneous end-of-tick position test. N's four regular hits (§10) show that damage tests the tile the player starts the landing tick on, which also explains these returns.

### 1.2 Exact observed set model

**DERIVED [all burst ticks below]:** the following set definitions reproduce **every emitted tile and no extra tile** in both captures: K 2,314 tiles in 25 bursts; M 2,486 tiles in 29 bursts. They also explain the differing counts near edges without treating clipped spears as new attack types. With N's diagonal spears and the ten-tile shield cap (§10), the same model reproduces all 114 bursts (K 25, M 29, N 60) in `__tests__/fixtures/solGroundAttackCapture.ts`, which `captureConformance.test.ts` checks tile by tile.

```text
A = {(x,y): x=26..39, y=28..41}
    minus {(26,28),(39,28),(26,41),(39,41)}

Shield H4 = {P in A: max(abs(P.x-C.x),abs(P.y-C.y)) != 4}
Shield H5 = {P in A: max(abs(P.x-C.x),abs(P.y-C.y)) != 5}

For a spear, transform P-S=(dx,dy) to (lateral, forward):
S: (dx, -dy)       N: (dx, dy-4)
W: (dy, -dx)       E: (dy, dx-4)

D1 = {P in A: 0<=lateral<=4 and
      (-4<=forward<=1 or (forward>=2 and lateral in {1,3}))}
D0 = {P in A: 0<=lateral<=4 and
      (-4<=forward<=1 or (forward>=2 and lateral in {0,2,4}))}
```

Here `D` is the observed cardinal direction; `1` is the two-prong variant, `0` the three-prong variant. The non-forward 5-by-5 footprint and the immediately adjacent forward row are fully covered in both variants. This K/M model infers no diagonal geometry and assumes no range beyond `A`; N's diagonal spears are in §10.

**OBSERVED / DERIVED [K:4013,4019,4086,4091,4103,4122,4158,4182,4187,4192,4197; M shield rows below]:** shields affect the observed arena except a complete Chebyshev-distance ring around `C`, clipped by `A`. For H4 the missing ring is radius 4, for H5 radius 5. A **four-sided missing/safe-visual ring does exist**, including its full four sides when it fits inside `A`, e.g. K:4182/H4. This does not make the shield a diagonal spear. `A` is an effect-domain boundary supported by shield-combatant LOCs on its outside: at K:3998 and M:8273, x=25/40 with y=29..40 and y=27/42 with x=27..38. These packets do not by themselves prove a complete collision map.

### 1.3 ASCII diagrams relative to Sol

**DERIVED [K:4006,4039,4080,4115,4145,4209,4215; M:8511]:** cardinal spear templates below are direct normalizations of the observed cardinal sets. Forward points up on the page only in these local-coordinate diagrams. `B` denotes an emitted tile in Sol's 5-by-5 block, `#` an emitted external tile, `.` absent; the block's actual southwest tile remains `S`, not a rotated world origin. The prongs stop at `A`; their exact lengths are in the fixture. These two diagrams plus the observed directions S/N/E/W cover every K/M spear shape.

```text
local lateral   0 1 2 3 4       0 1 2 3 4
forward >=2     . # . # .       # . # . #
forward =1      # # # # #       # # # # #
forward =0      B B B B B       B B B B B
forward =-1     B B B B B       B B B B B
forward =-2     B B C B B       B B C B B
forward =-3     B B B B B       B B B B B
forward =-4     B B B B B       B B B B B
                   D1              D0
```

**DERIVED [K:4182/H4,4187/H5; M:8355/H4,8360/H5]:** shield diagrams, world axes (north up/east right), centered on `C`, show the complete underlying observed ring rule before the explicitly documented arena clipping. `C`, `B`, and `S` all receive effects; `.` is the missing ring. Exterior `#` continues only within `A`. There is no facing rotation for shields in these samples (compare K west-facing 4086 with M south-facing 8355).

```text
          H4 (dx from C = -5..5)     H5 (dx from C = -6..6)
dy +6                               #############
dy +5     ###########               #...........#
dy +4     #.........#               #.#########.#
dy +3     #.#######.#               #.#########.#
dy +2     #.#BBBBB#.#               #.##BBBBB##.#
dy +1     #.#BBBBB#.#               #.##BBBBB##.#
dy  0     #.#BBCBB#.#               #.##BBCBB##.#
dy -1     #.#BBBBB#.#               #.##BBBBB##.#
dy -2     #.#SBBBB#.#               #.##SBBBB##.#
dy -3     #.#######.#               #.#########.#
dy -4     #.........#               #.#########.#
dy -5     ###########               #...........#
dy -6                               #############
```

### 1.4 Every melee burst, sequence tick, Sol position and facing

**OBSERVED** table. `G` is ground emission, `T` is warning sequence, `S.y` with `S.x=31` throughout. `a@tick` is the most recent Sol-facing **fallback angle packet** at or before G, not an invented exact interpolated orientation; a different tick means there was no fresh facing packet on G. Off-cardinal fallback angles such as 79/1969/944 occur with cardinal tile sets, not diagonal fans. `n1/n2/n3` are counts for 2669/2670/2671. Each row has `G-T=3`.

| Capture | T | G | S.y | Set | Facing a@tick | Tiles | n1/n2/n3 |
|---|---:|---:|---:|---|---|---:|---|
| K | 4003 | 4006 | 36 | S1 | 0@3999 | 44 | 20/8/16 |
| K | 4010 | 4013 | 36 | H4 | 79@4013 | 169 | 53/53/63 |
| K | 4016 | 4019 | 36 | H5 | 0@4019 | 165 | 59/61/45 |
| K | 4029 | 4032 | 35 | S1 | 0@4027 | 42 | 6/10/26 |
| K | 4036 | 4039 | 35 | S0 | 79@4039 | 48 | 17/12/19 |
| K | 4044 | 4047 | 33 | S1 | 0@4047 | 38 | 15/13/10 |
| K | 4070 | 4073 | 31 | S1 | 0@4073 | 34 | 16/8/10 |
| K | 4077 | 4080 | 30 | W0 | 432@4079 | 42 | 14/12/16 |
| K | 4083 | 4086 | 30 | H4 | 512@4086 | 160 | 56/59/45 |
| K | 4088 | 4091 | 30 | H5 | 512@4088 | 163 | 55/54/54 |
| K | 4100 | 4103 | 30 | H4 | 512@4100 | 160 | 57/44/59 |
| K | 4112 | 4115 | 30 | N1 | 1024@4115 | 42 | 13/10/19 |
| K | 4119 | 4122 | 32 | H4 | 944@4122 | 160 | 45/57/58 |
| K | 4136 | 4139 | 32 | N1 | 1024@4139 | 38 | 15/11/12 |
| K | 4142 | 4145 | 32 | N0 | 944@4145 | 42 | 11/15/16 |
| K | 4148 | 4151 | 32 | N1 | 1024@4151 | 38 | 18/9/11 |
| K | 4155 | 4158 | 33 | H4 | 1024@4155 | 160 | 55/48/57 |
| K | 4167 | 4170 | 34 | N1 | 1024@4165 | 34 | 21/5/8 |
| K | 4173 | 4176 | 34 | N0 | 944@4176 | 36 | 14/12/10 |
| K | 4179 | 4182 | 34 | H4 | 1024@4182 | 160 | 57/52/51 |
| K | 4184 | 4187 | 34 | H5 | 1024@4184 | 152 | 51/51/50 |
| K | 4189 | 4192 | 34 | H4 | 1024@4189 | 160 | 47/60/53 |
| K | 4194 | 4197 | 34 | H5 | 1024@4194 | 152 | 44/58/50 |
| K | 4206 | 4209 | 34 | E1 | 1536@4209 | 36 | 14/9/13 |
| K | 4212 | 4215 | 34 | E0 | 1457@4215 | 39 | 11/14/14 |
| M | 8279 | 8282 | 36 | S1 | 0@8274 | 44 | 15/17/12 |
| M | 8286 | 8289 | 36 | H4 | 79@8289 | 169 | 56/56/57 |
| M | 8299 | 8302 | 35 | S1 | 0@8297 | 42 | 12/12/18 |
| M | 8306 | 8309 | 35 | H4 | 1969@8308 | 160 | 50/57/53 |
| M | 8312 | 8315 | 35 | S1 | 0@8315 | 42 | 10/19/13 |
| M | 8319 | 8322 | 35 | S0 | 1969@8322 | 48 | 15/13/20 |
| M | 8326 | 8329 | 35 | S1 | 0@8329 | 42 | 11/15/16 |
| M | 8340 | 8343 | 34 | S0 | 1969@8343 | 45 | 13/19/13 |
| M | 8346 | 8349 | 34 | S1 | 0@8349 | 40 | 10/16/14 |
| M | 8352 | 8355 | 34 | H4 | 1969@8355 | 160 | 44/58/58 |
| M | 8357 | 8360 | 34 | H5 | 0@8360 | 152 | 45/52/55 |
| M | 8362 | 8365 | 34 | S1 | 0@8360 | 40 | 17/14/9 |
| M | 8368 | 8371 | 34 | S0 | 1969@8371 | 45 | 12/13/20 |
| M | 8374 | 8377 | 34 | S1 | 0@8374 | 40 | 14/14/12 |
| M | 8391 | 8394 | 34 | H4 | 0@8391 | 160 | 52/57/51 |
| M | 8396 | 8399 | 34 | S1 | 0@8391 | 40 | 12/9/19 |
| M | 8409 | 8412 | 33 | S0 | 1969@8412 | 42 | 12/9/21 |
| M | 8415 | 8418 | 33 | H4 | 0@8418 | 160 | 50/58/52 |
| M | 8420 | 8423 | 33 | S1 | 0@8418 | 38 | 9/10/19 |
| M | 8426 | 8429 | 33 | H4 | 1969@8429 | 160 | 46/63/51 |
| M | 8431 | 8434 | 33 | H5 | 0@8434 | 152 | 52/56/44 |
| M | 8443 | 8446 | 32 | H4 | 0@8443 | 160 | 60/47/53 |
| M | 8448 | 8451 | 32 | S1 | 0@8443 | 36 | 6/14/16 |
| M | 8454 | 8457 | 32 | H4 | 1969@8457 | 160 | 57/53/50 |
| M | 8466 | 8469 | 32 | S1 | 0@8464 | 36 | 11/16/9 |
| M | 8472 | 8475 | 32 | S0 | 79@8475 | 39 | 12/14/13 |
| M | 8478 | 8481 | 32 | H4 | 0@8478 | 160 | 61/49/50 |
| M | 8483 | 8486 | 32 | S1 | 0@8478 | 36 | 12/18/6 |
| M | 8508 | 8511 | 32 | W1 | 512@8509 | 38 | 17/11/10 |

**DERIVED [same table]:** consecutive uninterrupted spear selections often separate by 7 ticks early (K:4029->4036, M:8312->8319->8326), 6 later (K:4136->4142->4148, M:8340->8346), while shield selections separate by 6 early (K:4010->4016) and 5 later (K:4179->4184->4189->4194). These are measured examples, not an averaged global cadence; movement, triples, grapple and phase pauses also occur. Spear variants alternate across consecutive spear uses, including M:8329 S1 ->8343 S0 across the intervening taunt. Shield H4/H5 similarly alternate in runs. A complete selection/state-reset algorithm and an HP-speed threshold remain **UNCERTAIN**.

## 2. Crystal beams: exact cycles, lines, and patrols

### 2.1 Every charge/fire/impact emission

**OBSERVED / DERIVED [all rows in the cycle table]:** numbered beams correspond to **different crystal NPCs on different sides**, not four graphic stages of one NPC. Beam 1 is north-side firing south; 2 east-side firing west; 3 south-side firing north; 4 west-side firing east. The charge IDs are `2688+b`, fire IDs `2692+b` for beam number `b=1..4`. Each active beam emits exactly 13 line tiles in each charge/fire batch. The formulas below are lossless tile enumerations, checked for every entry; `i=1..13`, delay `3*i` client cycles:

| Beam | Crystal tile | Exact charge/fire tiles | 2697 impact tile at fire, delay 39 |
|---|---|---|---|
| 1 | `(q,41)` | `(q,41-i)` | `(q,27)` |
| 2 | `(39,q)` | `(39-i,q)` | `(25,q)` |
| 3 | `(q,28)` | `(q,28+i)` | `(q,42)` |
| 4 | `(26,q)` | `(26+i,q)` | `(40,q)` |

**DERIVED [K:4032..4221; M:8302..8511]:** visual travel is one tile per 3 client cycles, or 10 tiles per 30-cycle game tick. For an emission at E, tiles i=1..9 have floor-time E, i=10..13 have floor-time E+1; impact is E+1 with delay 39. This is the **line propagation rate**, distinct from the crystal's 1 tile per 2 ticks patrol rate. The impact lies one tile beyond the last line tile but has the same delay as that last tile. No player laser damage was observed, so these visual times do not prove damaging duration or collision order.

Every table row is **OBSERVED**, with `q1/q2/q3/q4` specifying the exact tile sets via the preceding formulas. `-` means no beam of that number yet. Charge and fire of each completed row use identical tiles and delays.

| Capture | Charge E | Fire F | F-E | q1 | q2 | q3 | q4 | Charge-start gap |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| K | 4032 | 4036 | 4 | 28 | - | - | - | - |
| K | 4073 | 4077 | 4 | 32 | 30 | - | - | 41 |
| K | 4115 | 4119 | 4 | 38 | 34 | 27 | - | 42 |
| K | 4151 | 4155 | 4 | 29 | 37 | 36 | - | 36 |
| K | 4187 | 4191 | 4 | 34 | 30 | 31 | 39 | 36 |
| K | 4209 | 4212 | 3 | 28 | 34 | 37 | 35 | 22 |
| K | 4221 | none | - | 28 | 36 | 37 | 33 | 12 |
| M | 8302 | 8306 | 4 | 28 | - | - | - | - |
| M | 8343 | 8347 | 4 | 32 | 29 | - | - | 41 |
| M | 8383 | 8387 | 4 | 37 | 36 | - | - | 40 |
| M | 8418 | 8422 | 4 | 28 | 35 | 31 | - | 35 |
| M | 8451 | 8455 | 4 | 36 | 33 | 33 | - | 33 |
| M | 8481 | 8485 | 4 | 28 | 35 | 31 | 35 | 30 |
| M | 8511 | none | - | 38 | 35 | 35 | 35 | 30 |

**DERIVED [cycle table]:** each capture has **7 charge rounds, 6 completed firing rounds, one interrupted terminal round**. Per-beam completed firings: K `6,5,4,2` (17 impacts); M `6,5,3,1` (15 impacts). K's last completed warning is shorter, 3 rather than 4 ticks; do not erase that sample by averaging. K:4221 emits charge on the death tick; M:8511 charges one tick before death. Neither terminal charge subsequently fires within the capture. Fire-to-next-charge gaps: K `37,38,32,32,18,9`; M `37,36,31,29,26,26`. These are sample gaps, not bounds on a universal random cooldown.

### 2.2 All crystal spawns and exact movement

**OBSERVED**:

| Capture / beam | NPC index | Spawn tick | Spawn tile | First crawl tick -> tile | Despawn sequence / removal |
|---|---:|---:|---|---|---|
| K/1 | 53998 | 4024 | (29,41) | 4027 -> (28,41) | 4221 / 4222 |
| K/2 | 56363 | 4065 | (39,31) | 4068 -> (39,30) | 4221 / 4222 |
| K/3 | 57984 | 4107 | (28,28) | 4110 -> (27,28) | 4221 / 4222 |
| K/4 | 60736 | 4162 | (26,31) | 4165 -> (26,30) | 4221 / 4222 |
| M/1 | 46578 | 8294 | (29,41) | 8297 -> (28,41) | 8512 / 8513 |
| M/2 | 47794 | 8335 | (39,30) | 8338 -> (39,29) | 8512 / 8513 |
| M/3 | 50120 | 8404 | (29,28) | 8407 -> (28,28) | 8512 / 8513 |
| M/4 | 52181 | 8461 | (26,30) | 8464 -> (26,29) | 8512 / 8513 |

**OBSERVED [spawn/charge/fire/despawn ticks above]:** crystal sequences are spawn **10798**, charge **10801**, attack **10802**, despawn **10800**. All eight first crawls occur spawn+3. **DERIVED [crawl records in the fixture]:** interior horizontal patrol endpoints repeatedly reverse at x=27 and x=38, vertical at y=29 and y=40, but there are initial reversals before an endpoint (K/1 28->29 at 4039, K/4 30->31 at 4167; M/3 28->29 at 8409). Charge/fire holds pause movement; ordinary completed rounds resume at F+3, K's shortened final completed round at F+2 (4214). The first-step rule in §10 (first step towards the edge's low end, then back up) explains these early reversals.

Every crystal step, by tick, is in `__tests__/fixtures/solBeamCapture.ts` (`SOL_BEAM_TIMELINES`),
which `beamTimeline.test.ts` replays for K, M, N, L and A.

## 3. Sunfire lightning and persistent pools

**OBSERVED** exact sets below. Each listed tile receives **2698 with delay=30**, hence visual start E+1 (**DERIVED**, floor(30/30)=1). Every pre-death corresponding pool addition is a loc placement record for `colosseum_holy_fire` (50746), shape 10, **E+5 on the same tile**, not a second map-animation effect. The last two K lightning bursts and last M burst do not produce a pool before the kill/cleanup. `P` is the last recorded player position at emission. Each row is its own capture/tick citation.

| Capture | E | P | Exact tile set | 50746 addition tick |
|---|---:|---|---|---:|
| K | 4023 | (33,35) | (33,35),(34,36),(35,36),(37,33),(30,38),(29,34) | 4028 |
| K | 4064 | (33,32) | (33,32),(33,34),(37,32),(33,31),(36,30) | 4069 |
| K | 4106 | (30,32) | (32,36),(30,32),(27,35),(31,36),(30,31) | 4111 |
| K | 4161 | (33,38) | (33,38),(32,38),(35,35),(37,34),(35,40) | 4166 |
| K | 4200 | (33,39) | (33,39),(34,37),(32,40),(30,36),(29,37) | 4205 |
| K | 4207 | (36,37) | (36,40) | 4212 |
| K | 4210 | (36,36) | (32,34) | 4215 |
| K | 4213 | (36,36) | (39,33) | 4218 |
| K | 4216 | (36,37) | (35,41) | none |
| K | 4219 | (36,37) | (35,38) | none |
| M | 8293 | (32,35) | (32,35),(33,35),(32,33),(35,36),(28,36),(32,31) | 8298 |
| M | 8334 | (33,34) | (33,34),(34,34),(35,33),(37,37),(30,35),(29,37) | 8339 |
| M | 8403 | (33,33) | (33,33),(34,33),(37,34),(36,30) | 8408 |
| M | 8460 | (34,31) | (33,32),(30,31),(30,28),(34,31),(37,31) | 8465 |
| M | 8502 | (33,31) | (37,32),(33,31),(34,29),(37,28) | 8507 |
| M | 8510 | (29,34) | (31,37) | none |

**DERIVED [table]:** all ten multi-tile bursts include the player's emission-time tile. All listed multi-tile positions lie within Chebyshev radius 4 of that player, with observed maximum 4. Batch counts K `6,5,5,5,5`, M `6,6,4,5,4`; distinctness within each batch is observed, but neither a fixed number of attempted rolls nor the rejection/dedup algorithm follows. The later single-tile bursts are not always underfoot; M:8510 `(31,37)` is distance 3 from `(29,34)`, while K:4210 `(32,34)` is distance 4 from `(36,36)`. K end-phase singles repeat every 3 ticks at 4207,4210,4213,4216,4219; M only supplies one such single after its final multi-burst, so a universal initial offset is not established (K +7, M +8 from the preceding multi-burst).

**OBSERVED [K:4028..4223; M:8298..8514]:** pools persist across later attacks. K has 29 pool additions and no intermediate expiry; all 29 receive despawn animation **10814** on 4221 and again on 4222, then replacement **29733** on 4223. M has 25 additions, despawn animations on 8512 and 8513, replacements on 8514. All pools thus survive until death in these short samples; a longer natural lifetime is **UNCERTAIN**. Shape is 10, per-placement rotation 0..3 (e.g. K:4028 `0,1,2,2,1,0`, in the row's tile order). Do not infer damage duration from the duration of 2698 alone.

**OBSERVED / UNCERTAIN [K:4064..4069]:** the only positive player-HP hit is at 4067: hit type16 value8, HP80->72, plus a separate type73 value1 Doom marker and `doom_stacks 0->1`, player moving `(33,31)->(32,30)`. The preceding lightning burst E=4064 included `(33,31)` and emitted visual delay30. The hit is E+3, two ticks before pool LOC addition E+5. This is compatible with delayed lightning/pool formation damage, but not proof: movement and hit resolution order are not exposed, and attribution cannot simply use the player's destination tile. No melee burst occurs between K:4047 and K:4073 and no beam fire between K:4036 and K:4077, which narrows the candidates but does not justify declaring a damage range from 8.

## 4. Triple attacks and prayer history

**OBSERVED**:

| Capture | Warning T, sequence / spotanim | Player hits (type:value) | Offsets from T | Protect-from-melee ON / OFF |
|---|---|---|---|---|
| K | 4051, 10887 / 2668 | 4054 12:0; 4057 12:0; 4060 12:0 | +3,+6,+9 | ON4054/4057/4060; OFF4055/4058/4061 |
| K | 4124, 10886 / 2667 | 4127 12:0; 4130 12:0; 4134 12:0 | +3,+6,+10 | ON4127/4130/4134; OFF4128/4131/4135 |
| K | 4218, 10886 / 2667 | 4221 12:0, then Sol dies | +3 only | ON4221; OFF4222 |
| M | 8380, 10887 / 2668 | 8383 12:0; 8386 12:0; 8389 12:0 | +3,+6,+9 | ON8383/8386/8389; OFF8384/8387/8390 |
| M | 8489, 10886 / 2667 | 8492 12:0; 8495 12:0; 8499 12:0 | +3,+6,+10 | ON8492/8495/8499; OFF8493/8496/8500 |

**DERIVED [table]:** four completed triples, exactly three received player zero hits each. First use has spacings **3,3**; later completed use **3,4**. The first-hit warning is **3 ticks in both variants**. The shorter variant changes the observed third-hit timing, not the observed first-hit warning. K's final triple is interrupted by death on its first-hit tick, not a one-hit variant. No positive player HP loss is associated with any of these 13 triple hit records.

**OBSERVED [K:4051..4061,4124..4135,4218..4222; M:8380..8390,8489..8500]:** prayer varbit4118 switches on on every zero-hit tick and off the following tick. No protect-magic or protect-range transitions occur in either complete capture; Piety/allactive changes are separate. K additionally drops Piety at4056 and restores it later; M drops Piety at8391. These are successful one-tick-on samples. **UNCERTAIN:** the server's tolerated early/late prayer-history window, whether a continuously held overhead would have different results, and unprotected damage cannot be inferred from them.

**OBSERVED [same windows]:** no melee2669..2671 burst is part of the three-hit sequence. Nearby effects are independently attributable: K4054/4059 player scythe effect1896; K4124/4129/4134 scythe1895; K4220 scythe1895 and K4221 beam charge plus death; M8382/8387 scythe1896 and M8383/8387 crystal charge/fire; M8491/8496 scythe1896. Thus do not count scythe ground effects or Sol's received hits as triple hits. In K and M every player zero hit is a triple hit; no other zero player hit occurs.

## 5. Grapple, HP, phase correlations, and modifiers

### Grapple

**OBSERVED [K:4093..4097]:** `grapple_pending (9800) 0->1`, sequence10884 delay30, taunt `I'LL CUT YOUR FEET OFF!` on4093. On4097 `pending 1->0`, explicit message `You perfectly parry Sol Heredit's grapple!`, and player sequence `warguild_parry_defend (4177)`. No player hit. The 17/8/5 hits on4097 target **Sol**, not the player.

**OBSERVED [M:8436..8440]:** same pending/sequence/delay on8436, but taunt **`I'LL BREAK YOUR LEGS!`**. On8440 the same successful-parry message and player sequence4177, pending clears, no player hit. **DERIVED:** two observed equipment-body-part prompts, not boots-only; warning packet to result =4 ticks, delay30 means sequence visual begins warning+1. **UNCERTAIN:** the exact clicked equipment slot/action is not recorded, no item-removal packet is shown, and these successful parries do not prove what gets stripped on failure or enumerate all eligible slots.

### HP is present, including regeneration

**OBSERVED [K:4000; M:8275]:** `hpbar_hud_npc (1683) -1->12821`, `hpbar_hud_basehp (6100) 0->1500`, `hpbar_hud_hp (6099) 0->1500`, boss HUD enabled. Subsequent hp6099 decreases track hits on Sol. This explicitly establishes **1500 displayed base/current starting HP**, not merely an unexplained HUD counter.

**OBSERVED [K:4099,4199; M:8374,8474]:** hp6099 increases by1: K803->804,145->146; M859->860,286->287. **DERIVED:** 100-tick separation within each capture and first increment control+101. Sum of all hits on Sol is1502 in each capture, matching `1500+1+1` and final HP0 at K4221/M8512. `tracking_damage_dealt_to_npcs` increases by1502 in each capture. This supports an observed regeneration schedule; universality beyond these fights remains untested.

### Phase-associated taunts, lightning, and crystal additions

**OBSERVED** HP here is the final HUD value received by the taunt tick, not a guessed trigger threshold:

| Taunt | K tick / HP | M tick / HP | Observed subsequent events |
|---|---|---|---|
| Let's start by testing your footwork. | 4001 /1500 | 8276 /1500 | First spear sequence4003/8279 |
| Not bad. Let's try something else... | 4022 /1349 | 8292 /1319 | lightning+1, crystal1+2, next attack+7 |
| Impressive. Let's see how you handle this... | 4063 /1114 | 8333 /1124 | lightning+1, crystal2+2, next attack+7 |
| You can't win! | 4105 /734 | 8402 /727 | lightning+1, crystal3+2, next attack+7 |
| Ralos guides my hand! | 4160 /362 | 8459 /354 | lightning+1, crystal4+2, next attack+7 |
| LET'S END THIS! | 4199 /146 | 8501 /97 | lightning+1, no fifth crystal, next attack+7 |

**DERIVED [table]:** the ordering of these five transitions is identical in both fights even though elapsed tick offsets differ. Every transition has a lightning batch at+1 and ordinary attack restart at+7; the first four add a crystal at+2. Thresholds near **90%,75%,50%,25%,10%** of1500 are consistent with the observed HP values and ordering, but the exact thresholds and whether transitions wait for an attack/special to finish are **UNCERTAIN**. In particular, K's second taunt waits until after its first triple despite HP crossing lower values earlier (K4055 HP1145, K4060 HP1114, taunt4063). This is substantially more usable than assuming crystal spawns are on a fixed timer.

**OBSERVED / DERIVED [K:3982,3987,4067; M:8267]:** K is **not an unmodified baseline**: `colosseum_selected_modifier 0->1` at3982, `colosseum_modifier_frailty_stacks_client 1->2` at3987, and Doom triggers at4067. M resets Doom3->0 at8267. The filenames do not enumerate all accumulated modifiers or their levels. Consequently differences between the two kills cannot automatically be attributed solely to the three words in M's filename.

### Solar Flare: four actors, exact repeated paths

**OBSERVED [M:8276..8523]:** four `colosseum_solar_flare (12826)` NPCs are added at8276, not one. All four make their first crawl at8277, continue every2 ticks along four-tile sides, and wait7 ticks between the last step of one side and the first step of the next. No player damage is recorded from these orbs.

**DERIVED**, lossless path description for M8277..8517: segment `j` starts at `8277+13*j`; its four unit steps occur at offsets0,2,4,6. Directions repeat every four segments. Start corners and direction order:

| NPC index | Spawn tile M8276 | Repeating directions | First corner destinations M8283,8296,8309,8322 |
|---|---|---|---|
| 45944 | (34,36) | N,E,S,W | (34,40),(38,40),(38,36),(34,36) |
| 45945 | (34,33) | E,S,W,N | (38,33),(38,29),(34,29),(34,33) |
| 45943 | (31,36) | W,N,E,S | (27,36),(27,40),(31,40),(31,36) |
| 45946 | (31,33) | S,W,N,E | (31,29),(27,29),(27,33),(31,33) |

All19 segments j=0..18 are complete; last four crawls are8511/8513/8515/8517. Full lap period52 ticks; repeated spawn-corner returns8322,8374,8426,8478. All four removed at8523, eleven ticks after Sol's death, and they continue crawling after8512. There is no orb in K3959..4237. This describes observed movement, not collision radius or damage.

## 6. Exact death sequence

Every row is **OBSERVED**, tick-relative deltas **DERIVED** by subtraction. Unlisted intervening ticks have no new Sol death/arena-cleanup event of these kinds; player movement and UI traffic continue.

| Relative to death D | K D=4221 | M D=8512 |
|---|---|---|
| D | Sol HP26->0, received26/0/0; player triple zero hit; sequence10888 and spotanim2680; four crystals sequence10800; 29 pools loc_anim10814; new terminal charge emitted | Sol HP20->0, received11/9/0; sequence10888 and spotanim2680; four crystals sequence10800; 25 pools loc_anim10814; previous tick's charge does not fire |
| D+1 | 4222 four crystals removed; pools repeat10814; Sol says `A worthy... opponent...`; melee prayer off | 8513 four crystals removed; pools repeat10814; Sol says `Ralos has smiled upon you...`; solar orbs still crawl |
| D+2 | 4223 all29 pool locations changed to29733 | 8514 all25 pool locations changed to29733 |
| D+3..7 | 4224..4228 no new Sol/LOC death event | 8515..8519 no new Sol/LOC death event; orbs crawl8515/8517 |
| D+8 | 4229 master12808 added at(38,31), sequence10862, rewards message | 8520 no new Sol death event |
| D+9 | 4230 Sol removed; reward chest50741 added at(37,33), rotation1 | 8521 Sol removed; gib12832 added at S=(31,32), spawnangle west, sequence10836; explosion2724 at C=(33,34); 81 fireblast131 effects |
| D+10 | 4231 no new Sol death event | 8522 master12808 at(38,31), sequence10862, rewards message |
| D+11 | 4232 no new Sol death event | 8523 four solar orbs removed; chest50741 at(37,33), rotation1 |
| D+12 | 4233 no new Sol death event | 8524 gib removed |

**DERIVED / OBSERVED [M:8521]:** 81 fireblast impact tiles form the exact 9-by-9 square centered on C: `{(x,y): x=29..37,y=30..38}`. Explosion is9 ticks after death, not on the lethal tick; no player hit is recorded. This sample establishes the visual footprint, not a Volatility damage range or universal delay for every NPC. Area sound7992 accompanies it (see sound section).

**DERIVED [M:8521, all81 tiles]:** fireblast delay is `2*max(abs(x-33),abs(y-34))`, exactly0/2/4/6/8 cycles by concentric square distance. The center 2724 effect has no explicit delay. Like the ordinary melee ground effects, all81 fireblasts are within one floor-binned tick, not81 separate tick hazards.

**OBSERVED [K:3992,4221; M:8267,8512]:** last-wave-duration varp 4136 becomes 229 and 245, equal to `4221-3992` and `8512-8267`: the wave timer includes the 6-tick entrance before control. The completion chat's `Wave duration` string reports total-duration values (2262/2108 × 0.6), not these spans, so it does not calibrate the fight clock.

## 7. Effect inventory and sounds

### All distinct map/actor spot-effect IDs, counts and tick bounds

**OBSERVED** exhaustive inventory of `map_anim` and `spotanim` IDs over the full capture ranges. `count@first..last`; `-` means absent in the entire corresponding capture. Projectile records are absent. Sequence IDs are a separate namespace, cataloged above and below; sound IDs are also separate.

| ID | Kind / name | K count@ticks | M count@ticks |
|---:|---|---|---|
| 131 | map fireblast_impact | - | 81@8521 |
| 1171 | spot dragon_claws_spot | 1@4192 | 1@8506 |
| 1542 | spot sanguinesti_staff_heal | 17@4006..4203 | 14@8402..8506 |
| 1895 | map dragon_halberd_special_south_blue | 19@4111..4220 | - |
| 1896 | map dragon_halberd_special_north_blue | 15@4006..4080 | 40@8284..8501 |
| 1897 | map dragon_halberd_special_east_blue | 5@4086..4106 | 1@8511 |
| 1898 | map dragon_halberd_special_west_blue | 1@4209 | - |
| 2666 | spot npc_colossi_colossi_01_land | 1@3998 | 1@8273 |
| 2667 | spot npc_colossi_colossi_tripleattack_01_telegraph | 2@4124..4218 | 1@8489 |
| 2668 | spot npc_colossi_colossi_tripleattack_01_telegraph_shorter | 1@4051 | 1@8380 |
| 2669 | map spotanim_colossi_finalboss_01_melee | 784@4006..4215 | 793@8282..8511 |
| 2670 | map spotanim_colossi_finalboss_02_melee | 745@4006..4215 | 859@8282..8511 |
| 2671 | map spotanim_colossi_finalboss_03_melee | 785@4006..4215 | 834@8282..8511 |
| 2680 | spot npc_colossi_finalboss_01_death | 1@4221 | 1@8512 |
| 2689 | map crystal charge beam01 | 91@4032..4221 | 91@8302..8511 |
| 2690 | map crystal charge beam02 | 78@4073..4221 | 78@8343..8511 |
| 2691 | map crystal charge beam03 | 65@4115..4221 | 52@8418..8511 |
| 2692 | map crystal charge beam04 | 39@4187..4221 | 26@8481..8511 |
| 2693 | map crystal attack beam01 | 78@4036..4212 | 78@8306..8485 |
| 2694 | map crystal attack beam02 | 65@4077..4212 | 65@8347..8485 |
| 2695 | map crystal attack beam03 | 52@4119..4212 | 39@8422..8485 |
| 2696 | map crystal attack beam04 | 26@4191..4212 | 13@8485 |
| 2697 | map crystal attack impact01 | 17@4036..4212 | 15@8306..8485 |
| 2698 | map sunfire lightning beam01 | 31@4023..4219 | 26@8293..8510 |
| 2712 | spot vfx_doom_scorpion_attack_impact_01 | 1@4067 | - |
| 2724 | map vfx_colosseum_finalboss_explosion_01 | - | 1@8521 |
| 2804 | spot spotanim_elder_maul_special | 1@4000 | 1@8278 |
| 3288 | spot death_charge_upgrade_cast_spotanim | 1@3975 | - |

**OBSERVED [K:3992; M:8267]:** seated boss uses sequence10876 (arena jump), then active Sol10877 (land) on control tick. Other encounter sequences are10883/10885 (melee/shield warnings),10884 (grapple),10887/10886 (first/later triple),10888 (death), crystal10798/10801/10802/10800, master10862, gib10836, pool LOC animation10814. Do not confuse actor `sequence` and `spotanim` IDs with the same textual name.

**OBSERVED / DERIVED [K:3999,4002; M:8274,8277]:** landing camera shake is sent at control+1 for axes0,1,2, each `random=5, amplitude=0, rate=0`; `cam_reset` follows at control+4. These are the only camera-shake/reset records in either full capture, not evidence of additional camera-shake packets for ordinary slams.

### Mechanically correlated audio

**OBSERVED** sound schedules; provenance is occurrence/correlation, not a claim that every sound is boss-owned:

- Lightning: synth8053 delay30 and10046 delay90 on **every E in section3** (K4023..4219 ten batches; M8293..8510 six batches).
- Beam preparations: synth8253 delay75 and8213 delay210 at K4029,4070,4112,4148,4184 and M8299,8340,8380,8415,8448,8478. These occur charge-3 in every listed ordinary round. K4206/4218 and M8508 instead send8213 delay180, retaining8253 delay75. The terminal preparations are included even though no fire follows.
- Beam fire: area8230 once per impact,17 K occurrences at4036,4077,4119,4155,4191,4212 and15 M at8306,8347,8387,8422,8455,8485. Coordinates equal the impact coordinates, loops1/range20/size20. No extra delay field.
- Triple/prayer samples: synth2676 on all13 zero-hit prayer-on ticks in section4. Synth2841 delay20 at K4054,4060,4130 and M8383;2842 delay20 at M8386;2843 delay20 at K4127 and M8492,8499;2844 delay20 at K4057,4134,4221 and M8389,8495. These changing sounds do not establish different damage styles; only melee overhead toggles are observed.
- Doom/damage K4067: synth8025 and synth521 delay20. M8521 explosion: area7992, loops1/range8/size6 at(33,34).
- Reward chest K4230/M8523: area7971 delay10 and7998 delay45, loops1/range15 at(37,33).

**OBSERVED** remaining distinct sound IDs and counts (`count@first..last`) so the audio inventory is complete. Area `-1` is a recorded sentinel, not a valid sound to play. The correlation of2524 with player scythe attacks and effects1895..1898 is visible at K4006/M8284; these must not be promoted to Sol mechanics.

| ID | K | M |
|---:|---|---|
| -1 | 43@4002..4221 | 44@8280..8512 |
| 2238 | 3@3967..4190 | 3@8275..8502 |
| 2401 | 2@3970..4003 | 2@8276..8367 |
| 5034 | 1@3975 | - |
| 8010 | 1@3987 | - |
| 3825 | 2@3998,4173 | 2@8273,8448 |
| 8984 | 1@4000, delay2 | 1@8278, delay2 |
| 2247 | 2@4002,4194 | 2@8280,8509 |
| 2524 | 40@4006..4220 | 41@8284..8511 |
| 2663 | 9@4055,4056,4058,4061,4128,4131,4135,4222,4226 | 8@8384,8387,8390,8391,8493,8496,8500,8515 |
| 5056 | 1@4075 | - |
| 4138 | 1@4192, delay10 | 1@8506, delay10 |
| 4140 | 1@4192, delay30 | 1@8506, delay30 |
| 4141 | 2@4192, delays42/60 | 2@8506, delays42/60 |

## 8. Presentation and Sol movement

- **OBSERVED [K:4003,4006; M:8279,8282; §1.4]:** the regular warning sequence precedes the
  ground-effect emission by three ticks; the 0..20-cycle ripple then plays within the emission tick.
- **OBSERVED [K:4093; M:8436]:** grapple sequence 10884 carries delay 30, so its clip starts one
  tick after the shout. The taunt and the response window keep their own clocks.
- **OBSERVED [§4, including K:4051]:** triple spotanims 2668/2667 accompany their sequences at
  warning time. They play on Sol, not on ground tiles.
- **OBSERVED [K:4039..4040; K:4114..4115]:** Sol-owned `facing player` records carry non-cardinal
  fallback angles (79 then 104, and 919 then 1024), distinct from player-owned `facing npc` records.
  Off-cardinal angles occur with cardinal tile sets (§1.4), so they are targeting, not attack
  direction. Fallback-angle packets are not an exhaustive rendered orientation trace.
- **OBSERVED [K:3996..3998; M:8271..8273]:** the player is teleported to `(33,31)` on plane 2 two
  ticks before control, then to the same x/y on plane 0 one tick before control. Sol spawns at
  `(31,36)` facing coordinate `(33,34)`.

**OBSERVED [K:3998..4237; M:8273..8537]:** all Sol movement records keep local x=31. K has six
walks and two runs; M has four walks and no runs. There are no Sol crawl records; the many `crawl`
lines belong to crystals and orbs.

| Capture | Walk ticks, destination local y | Run ticks, destination local y |
| --- | --- | --- |
| K | 4027:35, 4042:34, 4043:33, 4076:30, 4154:33, 4165:34 | 4068:31 (two south steps), 4118:32 (two north steps) |
| M | 8297:35, 8338:34, 8407:33, 8441:32 | none |

## 9. Pursuit and movement locks: conditional conformance

The per-tick K/M/N movement frames are in `__tests__/fixtures/solPursuitCapture.ts`, excluding entry
and death (K4003..4220, M8279..8511, N7310..7780). Each frame takes the player's trajectory and Sol's
attack and phase cues, including same-tick cues, from the capture. A match is therefore
capture-conditioned conformance: it does not recover the server algorithm or test autonomous attack
scheduling and phase ordering. Predicted paths are checked as well as endpoints, including a
recursive replay that does not reset Sol's position from each new packet.

| Capture | Living combat ticks | Out-of-range start tiles | Movement ticks | Path/endpoint mismatches | Unsupported evaluated geometry |
| --- | --- | --- | --- | --- | --- |
| K | 218 | 44 | 8 | 0 | 0 |
| M | 233 | 44 | 4 | 0 | 0 |

Thus **451/451 conditional endpoints and all 12 movement paths match**, including
439 stationary ticks. Only 88 ticks have an out-of-range start tile, so 451 must
not be presented as 451 independent tests of movement-release timing. Both
one-step prediction and recursive replay give zero errors.

N adds 471 frames, including the only diagonal pursuit (§10). `pursuit.test.ts` runs the production
mover over all 922 frames and every recorded path, including both run intermediates, plus separate
cases for lock application, routing around terrain, walls and actors, clipped arena corners, the
underneath step, binding, lifecycle conditions, preset reset and engine tick ordering.

### Candidate rules and evidence strength

1. Read the live target at the NPC-before-player movement stage. For
   analysis this is the player's previous recorded tile, not an additional lag
   to introduce in the engine. K4042 distinguishes it: targeting the player's
   end-of-tick tile would predict two steps instead of the recorded one.
2. Measure separation from Sol's 5x5 footprint, not his center or an arbitrarily
   chosen contact anchor. In the observed N/S pursuits, the player's X lies
   inside Sol's X extent, so X remains unchanged. The two run paths are exactly
   K4068 `(31,33)->(31,32)->(31,31)` and K4118
   `(31,30)->(31,31)->(31,32)`.
3. After a movement lock, take enough steps to reach cardinal melee contact,
   provisionally capped at two per tick. Ten walks need one step to contact; the
   two runs need two. The captures establish two-step packets, **not** a universal
   speed cap or whether the mechanism is intrinsic running versus queue draining.
4. Keep the start-of-tick adjacency check for launching attacks.
   K4043->4044, K4076->4077, K4118->4119 and K4154->4155 show movement followed by
   a warning the next tick. This does not justify adding a separate arrival timer.

All lock offsets below use the **packet warning/taunt tick**, not visual onset:

| Event | Release | What the evidence establishes |
| --- | --- | --- |
| Spear | T+6 | K4112..4118: stationary at +3,+4,+5 with a stationary distant target, then moves at +6. Four observed moves occur at spear +6. |
| Phase taunt | T+5 | Six out-of-range episodes: K4027/4068/4165 and M8297/8338/8407 all resume at taunt+5. |
| Grapple | T+5 | M8436..8441: no move at +3/+4, moves at +5. Because its sequence has delay30, this is visual-onset+4. Resume-after-parry is an unresolved alternative. |
| Shield | T+4 | K/M fit every fixed release 4..10; N:7344→7348 leaves 4 as the only fit (§10). |
| Triple | T+1 (no additional root) | K/M/N fit every fixed release 0..17. L's long triples chase on the next tick (4/4, §13); the short-triple release is UNVERIFIED. |

A joint sweep of all 7 shield values and all 18 triple values yields **126/126 zero-error K/M
combinations**. A speed-one candidate misses the two runs; caps 2..19 all fit. The current-tick
target candidate has one mismatch (K4042). These sweeps are conditional on the other candidate
choices; with N, each of spear 6, shield 4, grapple 5 and phase 5 is the only value fitting all 922
frames.

The [Wiki strategy page, revision 15351350](https://oldschool.runescape.wiki/w/Fortis_Colosseum/Strategies?oldid=15351350#Sol_Heredit)
publishes four ticks from AOE use. It does not resolve why K4112..4118 releases
at warning+6; do not equate those anchors or silently discard either source.

### Boundaries

- K/M pursuit is all north/south; N adds the diagonal cases (§10). Corner, obstacle and
  standing-under behavior beyond N's samples remain unverified.
- Contact and direction must be recomputed **after each step**, with each intermediate
  footprint validated against collision. A single `sign(delta) * steps` calculation is wrong for
  unequal diagonal gaps; Chebyshev distance one at a corner is not cardinal melee contact.
- A phase arriving during another lock could replace, cancel or extend it. These samples do not
  determine that policy.

### Simulator policies

These make unrecorded cases executable; they are not packet evidence.

- **Route:** the shared Wiki-order route (`findNpcMeleeRoute` through `pursuePlayer`), at most two
  steps per tick (§10). With the player underneath, one random cardinal step out; with no route,
  hold. Shared movement code supplies collision and occupancy; the destination rule stays Sol's.
- **Locks** run from the warning event: spear 6, shield 4, grapple 5, phase 5, triple 1. A
  practice-triggered grapple takes the same lock without changing its four-tick response window or
  delayed clip.
- **Overlapping locks:** a phase lock keeps any later existing deadline (maximum-deadline
  composition). The captures do not distinguish this from cancellation or replacement.
- **Pending phase:** while a transition is pending Sol does not move; the encounter's normal stage
  then publishes the taunt and schedules the transition, without reordering crystal movement,
  hazard processing or random draws.
- **Opening hold:** Sol holds his spawn tile through control+5. M shows him idle with the player out
  of reach through +5 (M:8273..8278); N, whose player never approaches, first moves at +6 (N:7308).
  Boss-HP presets do not reapply the hold.
- **Stage:** movement runs in the NPC-before-player stage with the pre-movement attack reach check.
  A two-step request carries both intermediate tiles, so running and interpolation keep the engine's
  normal path semantics.

### RSMod comparison at a verified permissive revision

Inspected revision: `rsmod/rsmod@fa13b3f67172ef36e15d6b1514358aee61411796`.
Its [root license](https://github.com/rsmod/rsmod/blob/fa13b3f67172ef36e15d6b1514358aee61411796/LICENSE.md)
was verified **before** reading implementation. The inspected tree has no
submodules or additional license files overriding that scope. This was read-only
corroboration; no external code or implementation structure was copied into the
simulator.

The [NPC movement dispatcher](https://github.com/rsmod/rsmod/blob/fa13b3f67172ef36e15d6b1514358aee61411796/api/game-process/src/main/kotlin/org/rsmod/api/game/process/npc/NpcMovementProcessor.kt#L121-L137)
uses `naiveDestination` for entity-target routes. Both combat interaction and
[player-follow mode](https://github.com/rsmod/rsmod/blob/fa13b3f67172ef36e15d6b1514358aee61411796/api/game-process/src/main/kotlin/org/rsmod/api/game/process/npc/mode/NpcPlayerFollowModeProcessor.kt#L18-L42)
enter this path. Follow mode additionally teleports beyond 15 tiles, which is not
a Sol rule. Rectangle/contact reach strategies are goal/reach predicates, not a
second entity-chase direction selector in this dispatcher.

For square 5x5/1x1 actors, our `naiveCombatDestination` matches the
[RSMod formula](https://github.com/rsmod/rsmod/blob/fa13b3f67172ef36e15d6b1514358aee61411796/engine/routefinder/src/main/kotlin/org/rsmod/routefinder/RouteFinding.kt#L1746-L1806).
The mismatch is the chosen destination policy, not an incorrect translation:

| Case | RSMod contact destination | RSMod path at the applicable one/two-step budget | Captured Sol path |
| --- | --- | --- | --- |
| K4042 | (32,34) | (32,34) | (31,34) |
| K4068 | (32,31) | (32,32), (32,31) | (31,32), (31,31) |
| K4118 | (33,32) | (32,31), (33,32) | (31,31), (31,32) |

These comparisons evaluate the destination formula and its diagonal-first step
policy on the stated positions; they do not claim a complete RSMod server replay.
All three fail on the first step. Changing the speed budget cannot fix that
direction error. None of the inspected alternative modes supplies a matching
drop-in pursuit policy.

What RSMod **does** corroborate is the separation of direction, speed and action
gates: [walk/run budgets are one/two](https://github.com/rsmod/rsmod/blob/fa13b3f67172ef36e15d6b1514358aee61411796/engine/game/src/main/kotlin/org/rsmod/game/movement/MoveSpeed.kt#L3-L10),
[each intermediate step is validated](https://github.com/rsmod/rsmod/blob/fa13b3f67172ef36e15d6b1514358aee61411796/api/game-process/src/main/kotlin/org/rsmod/api/game/process/npc/NpcMovementProcessor.kt#L65-L99),
and [NPCs process before players](https://github.com/rsmod/rsmod/blob/fa13b3f67172ef36e15d6b1514358aee61411796/api/game-process/src/main/kotlin/org/rsmod/api/game/process/GameCycle.kt#L46-L56).
These do not establish Sol's speed selection or lock durations.

## 10. Capture N and the rules it settles

N is a third kill (7279..7796, contiguous), with Doom and Volatility stacks active
(`colosseum_selected_modifier` 3->0->3 at N:7286/7287, volatility 0->1 at N:7291, doom 2->0 at
N:7296). Tests replay each implemented rule below against the K/M/N extracts.

### Movement

- **OBSERVED [N:7342,7409,7417,7561]:** the only diagonal pursuit on record. 7409, 7417 and 7561
  take a straight step then a diagonal one (S,SE; E,SE; W,NW); 7342 runs W,W. A breadth-first
  search over 5x5 footprint positions, expanding W, E, S, N, SW, SE, NW, NE
  ([OSRS Wiki, Pathfinding](https://oldschool.runescape.wiki/w/Pathfinding?oldid=14947485)) and
  stopping at the first position with the player orthogonally adjacent, reproduces all four,
  including the equal-length ties 7417 (E beats S) and 7561 (W beats N), and every path in K and M.
  This is the engine's `findNpcMeleeRoute`. The Wiki does not state that NPCs use it, so
  it is an observed fit.
- **OBSERVED [N:7389, N:7754]:** with the player underneath and Sol free to move, he takes one
  cardinal step (north; west, which leaves the player still underneath). In the other 11 underneath
  frames he was locked. The shared `random-cardinal` escape fits both; a deterministic
  "away along the dominant center axis" rule also fits, and two samples cannot choose.
- **OBSERVED [N:7302..7308]:** the player idles at (33,31), out of reach, and Sol first moves at
  control+6 with a two-tile run south. M holds through +5 with the player out of reach.
- **DERIVED:** shield-lock boundary frames exist in N (e.g. shield N:7344, still at 7347, moves at
  7348), so four ticks is the only fitting shield lock. K/M/N do not constrain the triple
  release (§13).

### Spears, shields and damage

- **DERIVED [K 14, M 18, N 31 spears]:** the spear points at where the player stood at the START of
  its landing tick (telegraph+3); telegraph-tick positions miss 8 (end of tick) or 9 (start of
  tick). Measured from Sol's center, a candidate rule (diagonal when the shorter offset is more than
  half the longer, otherwise the longer axis) fits all 63 sampled positions. N:7376 at offset
  (-4,-2) is west, so standard 45-degree octants do not fit. The fit does not determine the
  selector: production first aims a target within a face's width at that face, a simulator policy
  that also fits all 63 (register, [spear aim](./sol-heredit-unverified.md#sol-attacks--selection)).
- **OBSERVED [N:7353 SW/1, N:7360 SW/2, N:7558 NW/2]:** a diagonal spear covers Sol's 25 body
  tiles plus three-tile diagonal lines leaving the aimed corner: variant 1 at offsets -1 and +1 from
  the corner diagonal, variant 2 at -3, 0 and +3. Lines stop at three tiles with in-arena tiles
  still ahead. NE and SE are unobserved and implemented by symmetry.
- **OBSERVED [N:7327, N:7333]:** shield slams reach Chebyshev distance 10 from Sol's center at most.
  Both east-wall slams equal the ring model capped at 10; all 51 shields in K/M/N fit the cap.
- **OBSERVED [N:7386 33, N:7565 43, N:7716 33, N:7763 20]:** four regular-attack hits (the separate
  type-73 splats are Doom stack markers). Each start-of-tick tile is in its burst and each
  destination is outside it, so damage checks the start-of-tick tile. All four sit inside the Wiki's
  "up to 44"; they do not settle the distribution (see the
  [damage register](./sol-heredit-unverified.md#damage-rolls)).

### Beams and crystals

- **OBSERVED:** the first crystal charges spawn+8 = taunt+10 in all three captures. Every
  transition's next charge is at least taunt+10: K 10,10,10,27,10; M 10,10,16,22,10; N
  10,10,16,21,10. Where it is later, the running cycle already placed it there.
- **DERIVED:** §12 derives the taunt+10 rule and the fire-to-charge waits from warnings being
  keyed to Sol's telegraphs.
- **OBSERVED:** crystals skip the step due on the warning tick (all rounds), resume three ticks after
  an ordinary fire and two after an enraged one (K:4214; N:7739/7751/7763/7774), and every crystal's
  first step goes towards its edge's low end with every later step heading back up (12/12).
  Replaying each capture's crystals from their recorded spawn tiles reproduces every step. N's
  second crystal spawned on its low end (39,29) and first stepped at +4 rather than +3, the low-end
  rule confirmed in §13.
- **OBSERVED [N:7463..7766]:** all 12 warning pairs sit three ticks before their charge; `8213`
  delay 210 lands on the fire tick eight times and 180 four times (enraged).

### HP, sand and specials

- **OBSERVED [N:7503, 7603, 7703]:** HP +1 at control+201/301/401; damage dealt totals 1503.
  Control+101 falls at 1500/1500, so the heal due then is lost. Regeneration is implemented as a
  generic opt-in NPC timer (`src/core/combat/npcRegeneration.ts`).
- **OBSERVED:** transition sand is emitted at taunt+1, pools appear at emission+5, and none of N's 39
  pools is removed before death. The first enraged single strike follows the burst by +6 (N), +7
  (K), +8 (M); production draws it from that range (MODEL). N's four skipped enrage drips
  (7752..7758, 7773) do not land on the player's tile; pool or out-of-arena rolls would explain them.
- **OBSERVED:** the triples at N:7470 and N:7515 are both short (HP 1312, 1227) and the long ones
  follow "You can't win!" (N:7630), so a second triple above 50% is still short: the variant follows
  the phase, not first use.
- **OBSERVED [N:7748]:** "I'LL BREAK YOUR BACK!" is a new grapple slot call (cape).

## 11. When a phase transition happens

**OBSERVED:** every one of the 15 transitions (5 per capture) taunts exactly on Sol's next attack
slot, the previous telegraph plus that attack's cooldown, and his next attack follows seven ticks
after the taunt. An attack in flight when HP crosses still lands first.

| capture | HP crosses | previous action | taunt | next attack |
| --- | --- | --- | --- | --- |
| K | 4022 | shield 4016 (+6) | 4022 | 4029 |
| K | 4060 | short triple 4051 (+12), last hit 4060 | 4063 | 4070 |
| K | 4102 | shield 4100 (+5), lands 4103 | 4105 | 4112 |
| K | 4157 | shield 4155 (+5), lands 4158 | 4160 | 4167 |
| K | 4198 | shield 4194 (+5) | 4199 | 4206 |
| M | 8290 | shield 8286 (+6) | 8292 | 8299 |
| M | 8331 | spear 8326 (+7) | 8333 | 8340 |
| M | 8398 | spear 8396 (+6), lands 8399 | 8402 | 8409 |
| M | 8458 | shield 8454 (+5) | 8459 | 8466 |
| M | 8497 | long triple 8489 (+12), last hit 8499 | 8501 | 8508 |
| N | 7455 | shield 7450 (+6) | 7456 | 7463 |
| N | 7567 | shield 7562 (+6) | 7568 | 7575 |
| N | 7626 | shield 7625 (+5), lands 7628 | 7630 | 7637 |
| N | 7688 | long triple 7678 (+12), last hit 7688 | 7690 | 7697 |
| N | 7719 | spear 7718 (+6), lands 7721 | 7724 | 7731 |

**DERIVED [K/M/N]:** a triple is followed by Sol's next action after 12 ticks in 7 of 8 samples,
short and long alike (K 4051, 4124; M 8489; N 7470, 7515, 7649, 7678). The exception,
M:8380→8391 (11 ticks), is a short triple in phase 2. L shows phase-2 short triples resume after 11
(10/10 across L/M) while slow short and long triples take 12 (§13); the code uses
`SHORT_FAST_TRIPLE_COOLDOWN_TICKS` and `TRIPLE_COOLDOWN_TICKS`.

**UNCERTAIN:** the player was within reach at all 15 taunts, so whether reach gates a transition is
unrecorded; the implementation does not gate it. No capture crosses two thresholds at once; they
take consecutive slots.

## 12. Beams are announced on Sol's attacks

**OBSERVED:** all 26 beam warnings (`synth_sound 8253`) across K, M and N fall on a tick Sol
starts an attack: 23 on a spear or shield telegraph, 3 on a triple (K 4218, M 8380, N 7678), none
on a tick without one. The charge follows three ticks later, the tick that attack lands, and the
fire four ticks after that (three enraged). A player who dodges the attack on its last tick onto a
beam line has four ticks until ordinary visual fire (three enraged). K/M/N have no beam hit;
L:5583→5584 gives the sampled fire-start tile / fire+1 damage boundary (§13).

**DERIVED:** §10's two beam rules are consequences, not separate mechanics. The first crystal charges
at spawn+8 because it spawns at taunt+2 and Sol's next telegraph is taunt+7; no charge comes
sooner than taunt+10 because the taunt takes his attack slot. M 8501, where the enrage taunt fell
where a warning was due, is the same case.

**DERIVED:** after each fire the next round becomes ready after a delay, and its warning goes out
on Sol's first telegraph from then. Each fire bounds the delay: above the last telegraph it
skipped, at most the one it warned on. By the phase at the fire:

| phase | K/M/N bounds (skipped, warned] |
| --- | --- |
| 1 | K (15,34], M (20,34], N (24,31] (19,25] (22,35] |
| 2 | K (23,35], M (27,33] (22,28], N (24,29] (19,25] |
| 3 | K (23,29] (24,29], M (21,26] (17,23], N (22,28] (18,23] |
| 4 | K (3,15], M (4,23], N (3,16] |
| 5 | K (0,6], N (0,6] (0,6] (0,5] (4,∞) |

No fixed delay fits even one phase (phase 3: K 4155 skips +24, M 8455 warns at +23), so the delay
is modeled as a seeded roll; measuring from the warning or the charge instead does not
remove the conflict. Phase-4 warnings come after the enrage taunt, which readies an idle clock at
once, so those bounds do not cap the ordinary delay. Pooled with L's bounds (§13), the samples show
no phase dependence (e.g. L:4172 needs (26,32], L:5647 (20,25]): `BEAM_READY_DELAY_TICKS` is a
uniform 22–29 and `BEAM_ENRAGE_READY_DELAY_TICKS` is 5, both MODEL fits.
`__tests__/beamTimeline.test.ts` replays K/M/N/L/A with the recorded attack ticks, crystal spawn
tiles, NPC order and, for each gap, the smallest roll it allows. It matches every warning, charge
and fire of the 83 warned K/M/N/L rounds (88 with A). That is conditioned replay conformance, not
autonomous timing correctness or a random-delay law; production does not reproduce server NPC
index allocation.

**Grapples and reach:** a ready grapple can carry a beam warning (L:5478). Sol attacks only with
the player in reach, so in an ordinary fight beams also wait while the player stays away; no
capture tests that.

## 13. Capture L: long-fight audit

- **Triple cadence:** short triples in phase 2 resume after **11 ticks**
  (L:4575→4586, L:5105→5116; M:8380→8391), 10/10 across L/M. Slow short
  and long triples remain 12 ticks. This explains M's 11-tick exception (§11).
- **Triple movement:** no extra root after a long-triple launch, implemented T+1
  release; all four out-of-reach episodes chase during the combo (L:5581→5582,
  L:5628→5629, L:5191→5194, L:5444→5447). Long is VERIFIED 4/4; short
  +1 is UNVERIFIED with no escape samples (0/25).
- **Grapple:** correct early defence resolves at T+3, immediately
  (L:4698→4701; one sample). Wrong-slot then correct-slot succeeds in the
  same tick at L:4701; recovery across ticks is simulator policy, unverified.
  HANDS text/markup is captured (L:4698/4854/5287/5540).
  Failure, item stripping and empty-slot targeting remain unobserved: no
  capture contains inventory/equipment packets.
- **Damage:** all 37 unprotected regular exposures across L/N/A hit; the
  top-heavy `max(U[0,44], U[0,44])` fit remains a model with minimum 0.
  A floor near 8 is contradicted by L:5538 (5) and L:4551 (7). Relentless II
  triples show +3 (L:4511 28, L:5584 18, L:5150/5201/5400 48); regular
  maximum is not raised, and ranks I/III remain Wiki extrapolation. The
  simulator's Relentless also changes warband accuracy/max hits (capture
  UNVERIFIED), not regular AoE, grapple or arena/modifier hazards.
- **Beams:** L:5583 selects the start-of-fire-tick tile and hits for 67 at
  L:5584 (one positive witness), separately from the long triple's 18.
  Specials do not suppress beams in general. A:5184 remains unexplained by
  three undistinguished hypotheses; see the register. Tracking 4516/4134
  excludes the beam and Solarflare hit L:5838, aiding attribution.
- **Readiness/patrol:** 57 L rounds confirm warning+3 charge and 4/3-tick
  ordinary/enraged fire windows, including grapple warning L:5478. Uniform
  post-fire readiness 22–29 is a fit to the pooled bounds (§12); enrage
  acceleration is observed (L:5748→5755), exact reset is a model. Low-end
  first steps at spawn+4 agree 3/3 (L:3978→3982, A:5133→5137,
  N:7570→7574). Spawn distribution is unknown; warning-tick steps correlate
  with NPC index (L:5640/5672/5704), documented but not modeled.
- **Sand/selection/modifiers:** earliest pool persists ≥1,853 ticks
  (L:3982..5835). L's enrage singles (L:5756..5822) stay on the three-tick
  grid; two enrage placement attempts fit L's skips better (6/26 empty slots;
  one attempt predicts 11.8, P(≤6) = 0.014; two predict 5.6), but are not
  modeled. L:5628→5650 rules out a three-regular special minimum;
  the escalating selection is a MODEL: first special 25%, then two regulars
  refractory and `min(60%, 2% + 7.5% × (g−2))`, grapple share 10/38.
  Solarflare route/timing matches,
  including post-death hit L:5838 and D+11 removal L:5844.
- **Special-selection fit (MODEL):** 358 non-forced slots below 90% across
  L/K/M/N, 76% of them from L; phase 0 has none (0/104). With g the regulars
  since the last special (forced openers count), g 0–1 never specials (0/98;
  shortest gap 2, L:5628→5640, L:5645→5650). Observed 5/97 at g 2–3, 21/101 at
  4–6 and 23/46 at ≥7; the implemented ramp predicts about 6%, 23% and 46%,
  about 14.5% per slot overall and a mean gap of 6.0 regulars (observed 6.1,
  n=49). The 60% cap is unconstrained: only 5 slots reach g 10. Before the
  fight's first special a flat 25% fits 4/16 slots: L:3990 and N:7470 take the
  first eligible slot while M waits 10, so a ramp counted from the fight start
  or from the unlock leaves one side an outlier. Per-phase rates are equal
  (15.3% of 98 slots at 90–75%, 14.6% of 260 below), and no Relentless
  difference is detected in these samples (rank-II L 14.7% vs K/M/N 15.3%;
  rank is confounded with run). More grapples later only reflects the
  grapple unlocking at 75%. Once unlocked, 10 of 38 specials were grapples
  (CI 15–42%).

## Appendix A. Identical geometry, different graphic ids

**OBSERVED**, packed ASCII grids for two K shield bursts with identical 160-tile geometry (§1.1).
`x=a..b,y=c..d` fixes **sim** coordinates; x increases left-to-right, rows descend from c to d, and
`/` separates rows. `1=2669`, `2=2670`, `3=2671`, `.`=no effect. The tile sets of every K/M/N burst
are in `__tests__/fixtures/solGroundAttackCapture.ts`; the fixture does not keep the graphic ids.

```text
K 4086 x=26..39,y=41..28: .131132321221./21132323322132/31131321132222/12313313221232/32211122122132/311.........21/231.2311123.12/123.2212232.33/132.2321132.13/222.1112233.32/233.1121331.31/311.2211133.21/332.2312111.11/.22.........2.
K 4103 x=26..39,y=41..28: .211331231113./22212322312133/13211131323333/31121122112223/13331331313112/313.........22/111.2133223.33/123.1112323.33/322.3313111.33/313.1132211.12/133.1332332.11/312.3323212.11/222.2231213.21/.31.........3.
```
