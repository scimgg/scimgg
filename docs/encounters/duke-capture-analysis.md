# Awakened Duke Sucellus capture analysis

## Scope, citations, and evidence discipline

The [timing verification ledger](./duke-facts-spec.md#timing-verification-ledger) tracks the status
of each rule. The [capture inventory](./duke-facts-spec.md#captures) maps the aliases A0–A10, A12,
and R to private recording files. The [unverified behavior register](./duke-unverified.md) records
known exceptions and the observations that could resolve them. Tests use the extracted
[capture fixtures](../../src/encounters/duke/__tests__/fixtures/).

**OBSERVED** marks a recorded event or tile. **DERIVED** marks a conclusion computed from the
recorded events or the outcome of replaying them through a model. **UNCERTAIN** marks a boundary
or hypothesis that the recordings leave open.

Each section uses the named capture's own ticks. `A2:t380` refers to a game tick and
`A2:L11783–11815` refers to file lines. Tiles are local to map square `(47, 100)`. Player movement
checks use `me.tile` before or after movement as stated. Client-cycle offsets are relative to the
specified attack or graphic start. R is regular-mode evidence for shared timings. Awakened damage
and phase rules use the Awakened captures.

## 1. Capture cross-checks

### First Awakened capture (A0)

**OBSERVED (A0).** `20261126-232238-Duke.jsonl` records 184 consecutive ticks of a members-world
fight on revision 243. Duke is already awake at tick 0. His health bar drops
from 140/160 to 83/160 before the player's death at tick 177. The capture
covers the pre-enrage fight and both flare and bile thresholds. The timings
below use the capture's tick numbers and its player true tile (`me.tile`).
Cycle offsets are relative to the start of Duke's action.

#### Melee

- All 14 melee actions show chip damage, sequence 10176, frontal graphic
  2439 and ground graphics 2440, 2441, 2442, 2443, 2442, 2441, 2440 together
  on windup. The ground graphics run from X 28 to 34 at Y 51. Duke plays area
  sounds 7177, 7168 and 7224 at client cycles 5, 39 and 40. See ticks 20,
  45 and 166 (lines 4693–4704, 5193–5209 and 7646–7660). Chip reaches 6
  under Protect from Melee at ticks 66 and 87 (lines 5574 and 5953).
- On the tick 45 windup the player steps to the left pillar diagonal.
  They re-enter at `[28, 51]` and attack on tick 47, then stay there on
  tick 48. The only melee damage is the chip on tick 45. Duke also chips
  the player behind the right pillar at tick 98. They re-enter at
  `[34, 51]` on tick 100 without a slam hit (lines 5193–5240 and 6185–6250).
  A pre-movement check at windup +2 fits all 14 attacks. A check one tick
  later would catch six successful re-entries.

#### Other attacks

| Mechanic | Capture evidence |
| --- | --- |
| Basic cadence | Consecutive basic attacks are five ticks apart before enrage. |
| Blue magic bolt | All eight casts use sequence 10177 and projectile 2434. At ticks 124–128 a bolt produces a block hitsplat with zero damage and lacks the 2435 impact graphic and 7197 sound normally associated with landed bolts. See lines 4326–4432 and 6679–6761. |
| Freezing Gaze | All four casts open interface 829 with sequence 10180, report a successful dodge at +4, and close the interface at +6. See ticks 14–20, 50–56, 92–98 and 139–145. |
| Gas flares | Complete volleys have windup gaps of 3, 2 and 2 ticks. The final flare of the first bile volley shows launch at +20 cycles, vent ignition at +3 ticks, idle at +4 and fade at +18. See lines 6479–6510, 6558–6559 and tick 133. |
| Post-gaze volley | Gaze starts at tick 139, a basic follows at 145, and the four-flare volley starts at 150. The targets are grates. See ticks 139–157. |
| Bile cast | Both casts confirm the four-tick gap after the final flare, sequence 10178, projectile 1354, warning sound 1784 and Duke's two area cues. The first pool appears the next tick. |
| Bile pools | All 23 pools with observed placement and removal last nine ticks. A pool appears on both the true tile and the intermediate tile after a running step. Pool hits range from 9–12. See lines 6586–6824 and 7575–7937. |

The map records agree with Duke's southwest anchor `[28, 52]`, both pillar
columns, and all nine grate centers (initial scenery records, lines
1669–2307, and initial Duke record, line 4180). The opening wakeup,
enrage cadence, Orb of Darkness, victory, and maximum hits remain outside
this capture's coverage.

### Regular-mode cross-check

**OBSERVED (R).** `20261126-235612-Duke-Sucellus.jsonl` records 467 consecutive game ticks
and four regular kills. The first fight is already underway when the recording
starts. The other three show the player feeding Duke before combat.

The two connecting slams land at ticks 33 and 57, two ticks after windup.
In both cases the player starts the impact tick on the front row and steps a
tile south on that tick. Protect from Melee is active and the hits deal 15
and 37 damage (lines 4858–4930 and 5460–5543). In 38 other cases the player
starts that tick off the front row and reaches it without taking a slam.
The pre-movement check at windup +2 accounts for all 45 melee actions.
This corroborates the Awakened step-back routes and supplies the connecting
hits that the Awakened capture lacked.

The first dose raises the regular tolerance counter to 125. The
second fills it to the regular cap of 200, and sequence 10179 starts the
following tick (lines 6500, 6533 and 6568). All three complete openings
switch from sleeping NPC 12167 to awake NPC
12191 and start sequence 10179 at ticks 106, 212 and 338. Duke begins his
first melee attack five ticks later in each case (111, 217 and 343).
The player starts a six-tick Bandos godsword swing during the wake animation
at 107, 214 and 339, steps into cover, then swings again at 113, 220 and 345
without slam damage. The Awakened sim uses these wake and swing offsets
with the Awakened tolerance cap and starting poison stack.

All eight gazes report successful cover at windup +4 and close interface 829
at +6. The four deaths start sequence 10181 with NPC 12192 on ticks 64, 179,
303 and 419. Loot and the kill-count message appear four ticks after each.
These observations are for regular mode.

### Awakened opener and orb cross-check

**OBSERVED (A1).** `20261127-002024-Duke-Sucellus_1.jsonl` records 257 consecutive ticks
on revision 243. The player feeds Duke at the start and leaves the arena
at tick 250 with Duke at 470 HP, above the enrage threshold.

- **Feed and wakeup.** The inventory loses one dose per tick at 7–9.
  The tolerance meter updates one tick after each inventory change,
  showing 125, 250 and 370 at ticks 8–10. The corresponding splats are
  125, 125 and 120, capped by the remaining tolerance. This run uses
  sleeping NPC 12167. At tick 11 it switches to 12191 and starts
  sequence 10179, followed by the first melee windup at tick 16.
  The player swings at ticks 12 and 16, and is back in cover by tick 17.
  The sim uses the tolerance-update-to-wake and wake-to-windup offsets.
  It combines the inventory decrement and tolerance update into the Feed
  tick and uses sleeping NPC 12166. See lines 4417–4530 and 4590–4758.
- **Slam.** All 29 shatter checks fit the sim's pre-movement rule at
  windup +2. In 24 cases the player re-enters the front row on that
  tick and takes no slam damage. Chip damage reaches 7 with Protect
  from Melee at ticks 36 and 125 (lines 5060 and 6542). At tick 230, Duke winds up melee while
  the player starts at `[32, 50]`, with no chip splat. At tick 235
  he casts magic with the player at `[30, 50]`. The melee range check
  for Y 50 needs more examples. See lines 8488–8520 and 8627–8649.
- **Orb.** Duke reaches 542 HP at tick 224. NPC 11708 spawns at
  `[36, 51]` on tick 227 and moves one tile west each tick. The player
  and orb share `[31, 51]` at the end of tick 232. The orb deals 25
  damage and despawns on tick 233. The captured skill updates show
  eight-level drains. Prayer drops by nine, consistent with an eight-point
  drain plus the ordinary drain that tick. The second orb spawns from the same side
  at tick 239, six ticks after contact and twelve after the first spawn.
  Graphic 379 plays at both spawns and at the first contact.
  The enrage capture below has full sweeps and more examples of contact.
  See lines 8364–8433, 8558–8605 and 8720–8942.
- **Bile.** The four-flare volleys at ticks 135 and 172 finish without
  bile. Bile starts at tick 225, four ticks after the last flare.
  Pools appear from ticks 226 through 240. All 13 complete pool
  lifetimes are nine ticks. The first pool hit sets poison varp 102
  to 10 at tick 229, which means the first ordinary poison pulse deals
  2 damage. See lines 8380–8476 and the acid pool spawn and removal
  records through tick 249.
- **Gaze and magic.** All five completed gazes report safe cover at
  windup +4 and close at +6. The standard bolt at tick 235 launches
  at +50 cycles and hits for 44 at +120 (lines 8641, 8667 and 8716).

### Awakened enrage cross-check

**OBSERVED (A2).** `20261127-005253-Duke-Sucellus_2.jsonl` has consecutive snapshots from
ticks 0–462 on revision 243. The fight is underway at tick 0. The player
dies at tick 436 with Duke's health bar at 2/160. The capture shows the
bar's resolution, so the exact remaining HP is unknown.

- **Enrage cadence and magic.** Duke uses basic attacks four ticks apart
  from ticks 258–270. The five enraged magic windups at ticks 316, 344,
  348, 430 and 438 use sequence 10177, launch projectile 2434 at client
  cycle +50, and schedule arrival at +120. They use charge sound 7161
  at +1 and projectile sound 7214 at +50, as before enrage. The sim uses
  the same bolt animation, audio and timing in both phases.
  See lines 10454–10497, 11089–11213 and 12867–12932.
- **Flares and bile.** All 13 volleys launch at offsets 0, 3, 5 and 7.
  The two bile casts follow the last flare by four ticks before enrage
  (123–127) and three ticks during enrage (423–426). The next basic starts
  five and four ticks later, respectively. The two casts are 299 ticks
  apart, with eight volleys between them that finish without bile.
  The exact cast trigger is open. All 21 complete acid pool lifetimes are nine
  ticks. See lines 6479–6700 and 12675–12886.
- **Orb.** The boss crosses the orb threshold at tick 225 and the first
  orb spawns to the east at 228. All 18 spawns are 12 ticks apart. An
  uninterrupted orb traverses 10 tiles and disappears on the 11th tick
  after spawn. In each of the seven observed contacts, the player and orb
  share a true tile on one snapshot and the orb despawns with a 25–26
  damage splat the next tick. The spawn schedule continues after contact.
  Consecutive orbs can start on the same side, even after a complete
  sweep. The side selection rule is still open. Graphic 379 plays when
  the orb appears or disappears. See lines 8496–8975, 10630–10896
  and 11617–11876.
- **Protected chip.** Icicles hit for 7 under Protect from Melee on ticks
  90 and 174. See lines 5929–5934 and 7507–7513.
- **Final slam.** Duke winds up at tick 434. The player has 40 HP and
  stands at `[32, 51]` at the end of tick 435. On tick 436, the player
  steps to `[31, 50]` while taking 28 slam damage and 12 bile pool damage.
  This matches the sim's shatter check on windup +2 using the true tile
  before that tick's movement. See lines 12983–13072.

### Awakened west-side orb opener and final contact

**OBSERVED (A3).** `20261127-012348-Duke-Sucellus_3.jsonl` has consecutive snapshots from
ticks 0–562 on revision 243. The fight is already underway at tick 0.
Duke's health bar is 5/160 from the player's final hit on tick 502
through death on tick 505.

- **Final contact.** The player reaches west pillar cover at `[27, 51]`
  on tick 503 with 18 HP. The orb reaches that tile on tick 504. On
  tick 505 the successful gaze avoidance message appears, the orb
  disappears with graphic 379 on `[27, 51]`, and an 18-damage splat
  finishes the player. See lines 14350–14462.
- **Orb schedule and damage.** Duke crosses the orb threshold at tick
  252 and the first orb spawns at `[26, 51]` on tick 255. All 21
  spawns are 12 ticks apart through tick 495. The six nonlethal hits
  deal 25, 25, 25, 26, 27 and 27, each one tick after sharing a true
  tile. The first spawn can be on either side across the recordings.
  Seven consecutive orbs in this run start on the west side from
  ticks 351–423. See lines 8821–8865, 9657–9662, 10368–10664,
  10913–12576 and 13567–13904.
- **Flares, bile and magic.** The single flare at tick 18 and all 13
  complete four-flare volleys match the sim's counts and offsets.
  Bile casts at ticks 265, 399 and 435 follow the last flare by
  four, three and three ticks. The last two come from consecutive volleys.
  All 36 complete acid pools last nine ticks. The enraged bolt on
  tick 461 again launches at +50 client cycles and arrives at +120.
  See lines 4531, 8989–9052, 11933–11979, 12818–12874 and 13446–13465.

### Awakened magic and failed gaze cross-check

**OBSERVED (A4 and A5).** `20261127-013711-Duke-Sucellus_4.jsonl` and
`20261127-014756-Duke-Sucellus_5.jsonl` have consecutive snapshots at
ticks 0–343 and 0–419, respectively. Both fights are underway at tick 0.

- **Fourth capture finish.** Duke casts magic on tick 326. The bolt
  launches at +50 client cycles and lands at +120, dealing 55 damage
  with Protect from Melee active. A bile pool deals 9 damage on that
  tick and finishes the remaining 6 HP on tick 331. Duke's bar is
  32/160. See lines 10455–10587.
- **Fifth capture finish.** Gaze winds up on tick 354. The failed
  avoidance message appears at windup +4 on tick 358. The 10 damage
  that tick is from a bile pool. The gaze splat for 93 and a bile
  splat for 9 appear on tick 359, when the player dies with Duke's
  bar at 33/160. This is the first failed gaze in the captures. It
  places damage one tick after the avoidance message.
  See lines 11238–11385.
- **Orb.** Both captures keep 12 ticks between all spawns. The nine
  nonlethal contacts deal 25–27 damage on the tick after sharing a
  true tile. The first orbs spawn at ticks 198 and 252, three ticks
  after boss damage with the bar at 53/160 in both cases. That puts the
  apparent arming point around one third HP. The exact HP cutoff is
  open. See lines 7884–7965 in the fourth capture and 9084–9149 in the fifth.
- **Bile.** The fourth capture has two casts in seven eligible volleys.
  The fifth has five in seven, including three consecutive casts at
  ticks 96, 143 and 190. Each cast starts four ticks after the final
  flare before enrage or three ticks after during enrage. The next
  basic starts five or four ticks after the cast, respectively.
  All 68 complete pool lifetimes are nine ticks.

### Two Awakened attempts and a complete opener

**OBSERVED (A6).** `20261127-020616-Duke-Sucellus_6.jsonl` has consecutive snapshots from
ticks 0–1112 on revision 243. The first attempt is underway at tick 0.
The second starts from sleeping Duke.

- **Opener.** The three poison splats show 125, 125 and 120 at ticks
  730–732. Duke wakes on 733. The player attacks on 734 and again on
  738, the tick Duke starts his first melee attack. See lines 21621–21873.
- **First finish.** The player shares `[28, 51]` with an orb at the end
  of tick 269. The orb hits the remaining 18 HP and disappears on tick
  270 with Duke's health bar at 33/160. See lines 9490–9554.
- **Second finish.** The melee windup on tick 1092 starts with the player
  at `[28, 50]`. The player returns to `[28, 51]` from the south on
  tick 1093 and takes 36 from shatter and 26 from orb contact on tick
  1094. Bile deals 9 on tick 1095 and finishes the remaining 7 HP on
  1097. Duke's health bar is 33/160. The sim currently selects magic from
  `[28, 50]`. The exact melee selection rule outside the front row
  is open. The fourth capture starts a magic windup from that same true
  tile on tick 326. The previous frame shows the visible player at
  `[29, 50]` in the fourth capture and `[29, 51]` in the sixth.
  See fourth capture lines 10428–10467 and sixth capture lines 28844–29027.
  Across 64 basic windups with Duke's last visible bar at 40/160 or
  lower, the front-row check matches 60 using the starting true tile,
  42 using the starting visible tile, and 48 using the ending true tile.
- **Phase timing.** In the second attempt, recorded damage from full
  HP puts Duke at 570 before the hit on tick 998 and 537 after it.
  The first orb spawns at 1001. All later spawns in both attempts are
  12 ticks apart. All 14 successful gaze messages appear on windup +4.
  The two attempts add nine bile casts in 11 eligible volleys. All
  99 complete acid pools last nine ticks.
  See lines 7917–7972, 26677–26770 and 28729–28792.

### Awakened orb threshold cross-check

**OBSERVED (A7).** `20261127-022231-Duke-Sucellus_7.jsonl` has consecutive snapshots from
ticks 0–310 on revision 243. Duke starts asleep. He wakes on tick 3,
starts his first melee attack on tick 8, and is at roughly 440 HP from
recorded damage when the player leaves on tick 297. See lines 4339,
4491 and 10213–10319.

- **Orb.** Counting damage from full HP, Duke falls from 581 to 547
  on tick 252. The orb starts on tick 255 and further spawns are 12
  ticks apart through tick 291. Contacts deal 26 and 25. Alongside the
  prior full opener, the recorded hits bracket the cutoff from 547
  through 569 HP. See lines 9307–9382, 9778–9783 and 9975–9980.
- **Gaze, gas and bile.** All six gaze success messages are at windup +4.
  Three of five eligible flare volleys are followed by bile. All three
  casts start four ticks after the last flare and five ticks before
  the next basic. All 37 complete pool lifetimes are nine ticks.
  See lines 6237–6307, 7878–7938 and 9676–9740.
- **Melee and magic.** Melee windups on ticks 65, 70, 196 and 285 start
  outside the practice melee lane. The player takes no chip damage on
  those windups. Other attacks use magic with the player on Y 50, so
  the exact attack-selection rule remains open. Both bolts use the
  +50-cycle release and +120-cycle arrival. See lines 5501, 5626, 8181,
  10026 and 10134–10245.

### Three Awakened enrage recordings

**OBSERVED (A8–A10).** `20261127-023028-Duke-Sucellus_8.jsonl`, `20261127-024405-Duke-Sucellus_9.jsonl`
and `20261127-025030-Duke-Sucellus_10.jsonl` have consecutive snapshots
through ticks 349, 219 and 417, respectively. The ninth fight is already
underway at tick 0.

- **Enrage cadence.** In the eighth fight, the last flare winds up on tick
  304 and the next basic starts on 307. The following basics start on 311
  and 315. Another four-flare volley starts on 319, its last launch winds
  up on 326, and bile, magic and gaze start on 329, 333 and 337. In the
  tenth fight, the last pre-enrage gap is five ticks (317 to 322). Gaze
  starts on 326 and the next basic on 332. Flares wind up on 336, 339, 341
  and 343 before basics on 346, 350 and 354. See eighth capture lines
  10082–10905 and tenth capture lines 10558–11466. These sequences fit the
  sim's existing four-tick basics, six-tick gaze recovery and the
  three-tick gap from the last flare to the next action in enrage.
- **Projectile targets.** All eight blue bolts (2434) are actor-targeted
  at the local player. All 86 flare projectiles (2436) are tile-targeted
  at grates. In the eighth fight, Duke starts magic on tick 311 while
  the player's pre-move true tile is `[34, 50]`. The player reaches cover
  at `[35, 51]` before taking the bolt for 45 on tick 315, when Duke also
  starts melee.
  The bolt releases at +50 client cycles, lands at +120 and plays 7197
  locally on a hit. See lines 10293–10402 in the eighth capture.
  The sim steers the bolt from its current position toward the rendered
  player and keeps the gas flare aimed at the selected grate.
- **Gaze and melee range.** The tenth fight has a Gaze windup on tick 376
  with local sound 7215. On 380, the player runs from `[33, 49]` into
  cover at `[35, 51]` on the same tick as the failed avoidance message.
  Gaze still hits for 96 on 381. See lines 11893–12031. The ninth fight
  has melee windups on 186 and 194 from pre-move tiles `[33, 50]` and
  `[30, 49]`, both without chip damage. Earlier recordings and the
  eighth fight also show magic windups from Y 50. The exact attack
  selection rule outside the front row remains open. See ninth capture
  lines 7930–7952 and 8126–8150.
- **Area sounds.** Every recorded orb spawn in the three fights uses
  6545 at the spawn tile with range 4. The 23 recorded contacts use 179
  with range 4, one tile ahead of the contact burst. The game plays
  2707 from `[31, 52]` with range 10 as the icicles rise in all 103
  melee windups. Repeating vent smoke uses 3052 with range 3 on the
  animation reset and 7226 with range 5 four cycles later. See eighth
  capture lines 8817–8820 and 9001–9005, ninth capture lines 8126–8142
  and tenth capture lines 5145–5164.

### Basic attack selection by tick

**DERIVED.** The front-row check matches 487 of 501 basic windups across the 12 captures
when using the player's true tile before movement. That sample uses sequences
10176 and 10177 for NPC 12191, with a living player and snapshots on both sides
of the windup. Checking the true tile after movement matches 404 of 501.
All 27 magic windups start outside the melee lane. The 14 exceptions are melee
windups outside the lane, with no icicle chip.

**UNCERTAIN.** The trigger for those extra melee windups remains open.

- **Stepping in.** Duke starts magic on tick 134 when the player begins at
  `[34, 50]` and steps behind the front pillar at `[35, 51]` on the same
  tick. See `20261126-232238-Duke.jsonl:6911–6937`.
- **Stepping out.** During enrage, the player begins at `[34, 51]` on tick
  380 and ends at `[34, 50]`. Duke starts melee and the icicles deal 5 that
  tick. See `20261127-005253-Duke-Sucellus_2.jsonl:11783–11815`.

## 2. Damage replay audit

**DERIVED.** The audit fed successive recorded true tiles to the simulation's movement engine
over 4,211 ticks from 12 captures. Every movement endpoint matched. It supplied
the recorded attack windup ticks, bile casts, and orb spawn ticks and sides,
and used a fixed positive damage roll. This checks hit timing with the recorded
sequence as input. It leaves damage amounts, poison and venom pulses, and the
full autonomous fight sequence outside the comparison.

- **Direct splats.** After excluding the first 18 ticks of each continuous
  segment for hazards already in progress, 500 of 503 damage or block splats
  matched by tick in the original audit, with 20 extra simulated splats.
  With corrected vent targeting and pulses, 501 of 503 match with 15 extras.
  Supplying the recorded attack choices and grate targets to the corrected sim
  raises that to 503 of 503 with three extras. Aggregate counts can match when
  two mechanics overlap, so use the individual checks below to identify causes.
- **Slam.** With the recorded melee casts, all 11 front-row exposures took the
  hit at windup +2. The sim dealt no slam damage in the 455 other observed melee
  impact checks. The sim's default melee/magic selection missed two of the 11
  slams, at `20261127-022231-Duke-Sucellus_7.jsonl:5558` and
  `20261127-020616-Duke-Sucellus_6.jsonl:28792–28922`. The latter windup
  starts from `[28, 50]` four ticks after bile. Duke uses magic in that
  same phase from the same tile four ticks after bile in
  `20261127-013711-Duke-Sucellus_4.jsonl:10380–10467`. The rule that
  distinguishes those windups is still open.
- **Gas flares.** Skipping landed smoke matches 375 of 376 targets, up from
  332. The count rises to 376 when the replay includes the flare already in
  flight at the beginning of `20261127-024405-Duke-Sucellus_9.jsonl`
  (lines 4239–4300). In that recording, the regression matches the four
  targets at ticks 198–205 and
  all three gas hits at ticks 202, 207, and 209. In
  `20261127-022231-Duke-Sucellus_7.jsonl:5529–5607`, gas hits on ticks 66
  and 68. Tick 67 has only the slam splat, and tick 69 has none. The shorter
  enrage pulse window matches every uninterrupted fade with a visible health
  bar at launch and expiry in the Awakened captures (221 before enrage and
  60 during it). The regular-mode recording has two earlier fade offsets and
  retains two extra simulated vent splats at ticks 42 and 44.
- **Bile.** The full pre-enrage and enrage movement windows in the fixture match
  all positive encounter damage ticks. Other windows diverge. In
  `20261127-014756-Duke-Sucellus_5.jsonl:11183–11385`, a pool still hits on
  its removal tick, nine ticks after placement. In
  `20261127-022231-Duke-Sucellus_7.jsonl:9733–9899`, the capture shows an
  intermediate running tile that the endpoint-only replay does not reconstruct.
- **Magic, gaze and orb.** The sim matched the arrival tick of 24 bolts with
  a damage or block splat on that tick. One additional bolt has the impact
  sound but no recorded splat
  (`20261127-022231-Duke-Sucellus_7.jsonl:10138–10221`). Both failed
  gazes and all 41 observed orb contacts hit on the recorded ticks.

### Magic attack selection experiments

The trials ran each attack selector over the same 501 observed basic windups
and resolved damage through the simulation. They kept the recorded movement
and attack start times. An off-row melee selection still has no icicle chip,
and its slam still checks the player's true tile two ticks later.

| Attack selector | False bolt windups | Recorded bolt windups lost | Missed slams recovered |
| --- | ---: | ---: | ---: |
| Current check | 14 | 0 | 0 |
| Extend melee one row south | 3 | 18 | 1 |
| Allow melee if either the current or previous tick's true tile is in range | 6 | 10 | 1 |
| Allow melee across the full front row | 13 | 0 | 0 |
| Allow melee while returning north within three tiles of the front row on the first attack after a pre-enrage volley | 13 | 0 | 1 |
| Allow melee on the first attack after enrage bile if the player walked one step off the front row on the previous tick | 13 | 0 | 1 |
| Allow melee after approaching the center of the front row from two rows back, then immediately stepping diagonally away within the central three columns | 10 | 0 | 0 |
| Combine the last four changes | 7 | 0 | 2 |

The center route repeats in `20261127-014756-Duke-Sucellus_5.jsonl` at
windup 200, `20261127-022231-Duke-Sucellus_7.jsonl` at windups 196 and 285,
and `20261127-024405-Duke-Sucellus_9.jsonl` at windup 57. The combined
trial matches all 503 eligible direct splats by tick and drops extra splats
from 15 to 8. Those eight include five bolts from mismatched attack choices,
two vent hits in the regular-mode recording, and the bolt with a recorded
impact sound and no splat. The wall and both special-return changes each
have one positive example outside the existing melee lane. The trial results
use the same captures that suggested the rules. Production retains the
current selection until independent examples establish the conditions.

#### Follow-up trials

Three patterns each appeared in two separate captures. The replay used
previous movement and the sim's own previous attack choices for these trials.

| Additional melee condition | Matching windups |
| --- | --- |
| The last run started on the exposed front row, took its first step along the row toward the center, and ended one row south. | `20261127-002024-Duke-Sucellus_1.jsonl:8508` (230), `20261127-020616-Duke-Sucellus_6.jsonl:28992` (1096) |
| On the first basic after enrage bile, the prior step was lateral and returned to the column where the bile was cast, one row south of Duke. | `20261127-014756-Duke-Sucellus_5.jsonl:11169` (350), `20261127-024405-Duke-Sucellus_9.jsonl:7930` (186) |
| The previous bolt arrives on this tick and the player is farther south than at its windup. | `20261127-013711-Duke-Sucellus_4.jsonl:10546–10551` (330), `20261127-024405-Duke-Sucellus_9.jsonl:8126–8131` (194) |

Allowing the run to start on a pillar diagonal also suppresses the real bolt
at tick 430 in `20261127-005253-Duke-Sucellus_2.jsonl:12867–12886`. That
capture's pool placements confirm the run's first step was on the front row.
The four patterns with repeated examples, including the center route, remove
10 of 14 false windups and keep all 27 real bolts. They leave seven extra
direct splats. Including the three single-example changes from the first
trial leaves one false windup and four extra direct splats.

The remaining windup is tick 1019
(`20261127-020616-Duke-Sucellus_6.jsonl:27098–27226`). Duke uses melee
after two bolts as the player steps from `[34, 50]` to `[35, 51]`.
The same step produces a third consecutive bolt at tick 134 in
`20261126-232238-Duke.jsonl:6679–6937`, so a two-bolt limit fails.
At tick 1019 the player had held the starting tile for three ticks. A trial
that extends melee only when the player held still on the previous tick after
two consecutive bolts fits the last windup. There is one supporting example.
An independent trial holding `[34, 50]` through three basic attacks would
test whether staying still distinguishes those casts.

### 19:29 Awakened recording

**OBSERVED (A12).** `20261127-192944-Duke-Sucellus_12.jsonl` starts with Duke already awake.

**DERIVED.** The replay used 165 consecutive battle ticks and matched every movement
endpoint. After seeding the opening counters from the first recorded
volley and gaze, the sim scheduled all 41 windups at their recorded ticks.
The replay supplied the observed bile decision and orb directions, applied
the recorded health-bar changes at their tick boundary, and used a fixed
combat roll. The four orb spawns match at ticks 120, 132, 144, and 156 after the
48-damage threshold hit at 117 (lines 6537–6610).

- **Melee and magic.** All 19 basic attack choices match. Magic winds up
  at ticks 153 and 157 and hits at 157 and 161 (lines 7335–7528). All 17
  melee windups start in the front row. The recording has two consecutive
  bolts and does not exercise the three-bolt hypothesis. Expanding melee
  one row south would suppress the real bolt at tick 157.
- **Vent tie.** At tick 146 the player is on `[29, 48]`, equally far
  from the available grates at `[28, 46]` and `[28, 50]`. The game
  targets the northern grate (lines 7142–7181) and hits for 26 and 25 at
  ticks 150 and 152 (lines 7245 and 7303). The simulator now prefers the
  northern grate on an equal-distance tie between rows. This is the only
  available-grate distance tie found in the 13 captures.
- **First bile drip.** When the player runs from `[29, 51]` to
  `[27, 51]` on the bile cast tick (24), the first pool appears on
  `[27, 51]` only (line 4731). The pool on the intermediate tile
  `[28, 51]` appears at 28, after the player returns to that tile, and
  first hits at 29 (lines 4789 and 4806). A two-step run on the cast tick in
  `20261127-020616-Duke-Sucellus_6.jsonl` also drops its first pool only
  on the final tile (ticks 1088–1089).

**DERIVED.** The sim matches the ticks of all 23 direct damage or block splats and all
four bile splats, with zero extras. The same changes leave the hit history
unchanged over 4,211 battle ticks from the earlier 12 captures. Focused
capture tests cover the flare targets, pool placements, and damage ticks.

### Gas flare repeat targets

**OBSERVED.** In `20261126-232238-Duke.jsonl`, both windups at ticks 74 and 76
target `[28, 46]`. The first projectile lands at tick 77 (lines 5694–5746).
The follow-up smoke NPC spawns at 78 and replaces the prior pulse (lines
5758–5800). In `20261127-005253-Duke-Sucellus_2.jsonl`, Duke targets
`[34, 46]` at 373 and again at 391. Its previous smoke starts fading at 389
and the old NPC remains until 393 (lines 11672, 11976, 12023 and 12060).

**DERIVED.** The audit paired 379 projectile records with their windup and
preceding player tile across 13 recordings. Of those, 65 targeted the same
grate as an earlier flare that was still airborne. The other 247 repeat
targets came at least 18 ticks after the previous shot at that grate.
Picking the closest grate without regard to smoke matches 319 targets. Excluding grates from
landing until fade matches 378 without pre-capture context. The remaining
case, at tick 2 of `20261127-024405-Duke-Sucellus_9.jsonl`, also fits when
the pre-existing flare at `[28, 50]` is included. Its smoke ignites at
the windup boundary, so the next flare targets `[28, 46]` (lines 4270–4300).
This supports keeping landed smoke as an exclusion while allowing repeat
targets before landing and during the fade.

## 3. Evidence audit

The audit used all 13 available recordings. The regular recording supports shared
opener timing and vent geometry. The Awakened phase and damage samples use only the
12 Awakened recordings. Counts below state the conditions used to isolate each observation.

### Trigger and selection samples

- **Melee selection.** A4:t326 and A6:t1092 start at `[28, 50]` during
  enrage, four ticks after bile. A4 uses magic and A6 uses melee. The
  cases agree on phase, starting true tile, and time since bile, so another
  variable is needed to explain the difference. The
  [follow-up trials](#follow-up-trials) rule out a two-bolt cap.
- **Vent ties.** Among the 379 windups in the
  [target audit](#gas-flare-repeat-targets), only A12:t146 has two equally
  close eligible grates after accounting for active smoke. The player starts
  at `[29, 48]` and Duke picks `[28, 50]` over `[28, 46]`
  (A12:L7142–7181). The sample contains no same-row choice between tied nearest
  grates.
- **Bile.** 34 of 69 complete four-flare volleys with a preceding HP bar
  at 103/160 or lower are followed by bile. This sample requires all four
  offsets and a recorded next action within five ticks of the last flare.
  It excludes volleys near the ambiguous HP-bar boundary. From full HP
  in A7, Duke has 1,089 HP before the final flare at t98 and casts bile at
  t102 (A7:L6237–6311). A5 has consecutive casts before enrage and A3
  has consecutive casts during enrage. These observations constrain
  eligibility and rule out a mandatory skipped volley. They leave the
  exact HP comparison, sampling tick, and random or history-dependent rule open.
  [Published eligibility](https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies#Awakened_mode)
- **Orb cutoff.** The table sums all positive splats on the awake NPC
  from a full-HP opener, including splats without the player-owned flag. At each crossing, the first orb appears three ticks
  later. An inclusive cutoff must be at least the highest post-hit value
  and below the lowest pre-hit value. The four crossings still leave
  every integer from 547 to 569 possible.

| Capture | HP-change tick | HP before → after | First orb | Crossing and spawn lines |
|---|---:|---:|---:|---|
| A1 | 224 | 584 → 542 | 227 | L8369–8425 |
| A6, second attempt | 998 | 570 → 537 | 1001 | L26692–26758 |
| A7 | 252 | 581 → 547 | 255 | L9307–9382 |
| A8 | 244 | 582 → 518 | 247 | L8749–8817 |

- **Orb side.** 54 spawns are west and 57 east when the player is alive
  in the snapshots before and at the spawn. A3:t255 and A8:t247 provide
  observed west first spawns. A1:t227 and A7:t255 provide east first spawns.
  Both sides occur while the player starts the tick in each half of the room.
  A3's seven consecutive west spawns also rule out strict alternation. The
  sample leaves independence, the exact odds, and dependence on earlier
  player positions open.

### Damage and cover samples

- **Icicles.** The [melee facts](./duke-facts-spec.md#melee-and-magic) cite
  protected 8s and an unprotected 13 in Awakened mode. The 13 exceeds the
  11 cap given for regular mode. If the published melee-prayer halving applies,
  the protected hits require a cap of at least 16. Neither the maximum nor the
  defence roll follows from these splats.
  [Regular and Awakened strategy](https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies)
- **Shatter and bolt.** The Wiki gives 81 and about 60 for shatter without
  and with Protect from Melee, and 71 and 36 for the bolt without and with
  Protect from Magic. Its general successful-hit rule supports a roll from
  zero to max, with exceptions for monster mechanics. The positive isolated
  hits, including a magic-protected 21 in A9:t71 (L5546–5609), do not reveal the
  pre-prayer roll. The caps support the simulator's chosen multipliers without
  settling their exact values or rounding.
  [Awakened strategy](https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies#Awakened_mode) ·
  [Successful hit](https://oldschool.runescape.wiki/w/Successful_hit)
- **Zero and missed bolts.** A0:t128 has a block without the usual impact
  graphic 2435 or sound 7197 (L6679–6761). A2:t352 has a zero splat and a
  separate 26 on the same tick as both the scheduled bolt impact and an
  icicle windup (L11173–11285). The overlap prevents attributing the zero
  to the bolt. The Wiki documents that a connecting zero can invalidate a
  perfect kill. The recordings do not include an otherwise clean Awakened
  kill after a confirmed miss.
  [Perfect kill rules](https://oldschool.runescape.wiki/w/Duke_Sucellus#Mechanics)
- **Gaze.** All 88 matched successful Awakened cover checks start on
  `[27, 51]` or `[35, 51]` before movement. A5 fails from `[31, 50]`
  and takes 93 at t359. A10 fails from `[33, 49]` despite reaching
  `[35, 51]` on the check tick and takes 96 at t381
  (A5:L11238–11385, A10:L11893–12031). The two failed rolls cannot establish
  a 65 minimum. The rear pillar cover tiles remain untested.
- **Gas.** Six isolated nonlethal pulse hits are 25, 26, and four 27s.
  The filter requires a nearby idle smoke sound, one direct splat, and no
  competing pool, orb or attack at that tick. Low and high examples are
  A12:t152 (L7303) and A9:t202 (L8311). The equipment records contain
  Oathplate helms and empty head slots. They cannot measure a gas mask or
  Slayer helmet's reduction. The sampled range leaves the minimum open.
- **Bile pool expiry.** All 414 matched appearances and removals are nine
  ticks apart. In A8 the player holds `[30, 50]` at the end of ticks
  334–337 while bile is active. The pool placed at 335 still expires at
  344 (L10850–10990).
  The only removal tick where the player starts on that exact pool
  tile is A5:t359. The player stands on the pool at `[29, 50]`,
  placed at t350, and takes 9 pool damage alongside 93 from Gaze before
  the removal is reported. Poison immunity is active (A5:L11119,
  L11183–11385). This is a known discrepancy with the sim's +8 cutoff.
  The other lifetimes establish visual expiry, while that sole exposure
  leaves its damage behavior across situations open.
- **Orb damage.** 35 isolated nonlethal contacts have exactly one direct
  splat, a shared true tile on the preceding tick, and both the orb
  despawn and contact sound. Damage is 25 on 16 contacts, 26 on 13,
  and 27 on six. Lethal hits are excluded because the splat can be
  clipped to the player's remaining HP. The observed 25 is the sample
  minimum. The 27 maximum also has a published source.
  [Awakened strategy](https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies#Awakened_mode)

### Opener type and feed timing

- **Feeding offsets.** A1 removes its three inventory doses on ticks 7–9
  and records the matching tolerance splats 125, 125 and 120 on ticks
  8–10. A6 repeats those offsets at 729–731 and 730–732. These are two
  complete Awakened feeding sequences (A1:L4432–4502, A6:L21608–21678).
  Combining the inventory and meter changes in the sim is a presentation choice.
- **Sleeping type.** A1:t0, A7:t0 and A8:t0 show NPC 12167 at Duke's
  combat anchor. A6 feeds 12167 during the second opener, after spawning
  12166 at the room entrance on t499 (A6:L12419 and L21621–21678).
  Pinned cache 2772 gives 12167 the `Feed` action and has no action on
  12166. Both use model 49194, idle 10174 and size 7. The sim displays
  12166 with a local `Feed` action. The on-anchor Feed identity in the
  captured openers is established.
