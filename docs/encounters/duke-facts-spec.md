# Awakened Duke Sucellus — facts spec

Rules supported by captures, the pinned cache, and published sources for the `duke_practice`
encounter. The [capture analysis](./duke-capture-analysis.md) gives the derivations. The
[unverified behavior register](./duke-unverified.md) records the simulator's models, assumptions,
and known mismatches.

## Captures

The recordings are private. Tests use the extracted ticks, tiles, and IDs in the
[capture fixtures](../../src/encounters/dukePractice/__tests__/fixtures/).

| Alias | File | Ticks | Contents |
|---|---|---|---|
| A0 | `20261126-232238-Duke.jsonl` | 0–183 | Awakened fight in progress, pre-enrage flares and bile |
| R | `20261126-235612-Duke-Sucellus.jsonl` | 467 consecutive ticks | Four regular kills, including three complete feeding sequences |
| A1 | `20261127-002024-Duke-Sucellus_1.jsonl` | 257 consecutive ticks | Awakened opener, orb threshold, and pre-enrage bile |
| A2 | `20261127-005253-Duke-Sucellus_2.jsonl` | 0–462 | Awakened enrage, magic bolts, and flare-to-bile transitions |
| A3 | `20261127-012348-Duke-Sucellus_3.jsonl` | 0–562 | Awakened west-side orb opener and lethal orb contact |
| A4 | `20261127-013711-Duke-Sucellus_4.jsonl` | 0–343 | Awakened magic and bile at the end of the fight |
| A5 | `20261127-014756-Duke-Sucellus_5.jsonl` | 0–419 | Awakened failed gaze and bile-pool removal boundary |
| A6 | `20261127-020616-Duke-Sucellus_6.jsonl` | 0–1112 | Two Awakened attempts, including a complete opener |
| A7 | `20261127-022231-Duke-Sucellus_7.jsonl` | 0–310 | Awakened orb activation and off-row melee windups |
| A8 | `20261127-023028-Duke-Sucellus_8.jsonl` | Through 349 | Awakened enrage cadence and orb contact |
| A9 | `20261127-024405-Duke-Sucellus_9.jsonl` | Through 219 | Awakened enrage vent volley and damage pulses |
| A10 | `20261127-025030-Duke-Sucellus_10.jsonl` | Through 417 | Awakened phase transitions, sound cues, and attack timings |
| A12 | `20261127-192944-Duke-Sucellus_12.jsonl` | 1–165 (battle ticks) | Awakened replay check, vent tie, and first bile drip |

Coordinates are local to map square `(47, 100)`. World coordinates add `(3008, 6400)` to the local
coordinates. X increases east and Y increases north. `A2:t380` cites a tick. `A2:L11783–11815`
cites file lines. Regular-mode R corroborates shared timing. Damage, thresholds, and phase
rules for Awakened Duke use Awakened observations and published Awakened stats.

## Timing verification ledger

**VERIFIED** means the cited observations agree within their recorded scope. **SINGLE-OBSERVATION**
identifies one discriminating sample. **MODEL** marks an implemented fit with unresolved boundaries
or known exceptions. **WIKI-ONLY** identifies a published rule awaiting a capture check.
**30 client cycles = 1 game tick.** Attack offsets start at the windup unless a row names a different
boundary. Placement, animation, and damage may occur on different ticks.

**E** = [`DukePracticeEncounter.ts`](../../src/encounters/dukePractice/DukePracticeEncounter.ts),
**C** = [`constants.ts`](../../src/encounters/dukePractice/constants.ts),
**A** = [`arena.ts`](../../src/encounters/dukePractice/arena.ts),
**P** = [`controls.ts`](../../src/encounters/dukePractice/controls.ts), and
**W** = [`duke.ts`](../../src/npcs/duke/duke.ts).

| Timing | Value | Code | Capture evidence (n) | Status |
|---|---|---|---|---|
| Awakened poison tolerance | 125 per dose, capped at 370 after three | C `DUKE_POISON_PER_DOSE`, `DUKE_POISON_TOLERANCE` | A1:t8–10, A6:t730–732 | VERIFIED |
| Final tolerance → wake → first attack | Wake +1 from the final tolerance update, first attack +5 from wake | C `DUKE_WAKE_AFTER_FEED_TICKS`, `DUKE_FIRST_ATTACK_DELAY_TICKS` | A1:t10→11→16, A6:t732→733→738, R three complete openers | VERIFIED for the stated boundaries |
| Basic attack cadence | 5 ticks before enrage, 4 during enrage | E `wardenCadence` | A2:t258–270, A8:t304–319, and A10:t317→322 and enrage window | VERIFIED |
| Exact enrage threshold | 440 HP | P `ENRAGE_HP` | Phase timings agree with the [published threshold](https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies#Awakened_mode) | WIKI-ONLY for exact HP |
| Melee or magic | Melee at X 27–35, Y 51 before movement at windup | A `isInMeleeLane`, E `processNpcTick` | 487/501 earlier basics and 19/19 in A12. [Selection audit](./duke-capture-analysis.md#basic-attack-selection-by-tick) | MODEL with 14 earlier off-row melee exceptions |
| Icicles and shatter | Chip check at windup, shatter +2 from the start-of-tick tile on X 28–34, Y 51 | A `SLAM_TILES`, C `DUKE_SLAM_IMPACT_DELAY_TICKS` | All 11 exposed shatter checks with recorded melee windups. [Damage replay audit](./duke-capture-analysis.md#2-damage-replay-audit) | VERIFIED |
| Magic bolt travel | Release +50 client cycles, arrival +120 cycles (4 ticks) | C `DUKE_MAGIC_PROJECTILE`, `DUKE_MAGIC_FLIGHT_TICKS` | A1:L8641–8716, A2:L10454–10497, A12:L7335–7528 | VERIFIED |
| Freezing Gaze cadence and cover | After five basics. Cover +4, damage +5 if exposed, next action +6 | E `processNpcTick`, C `DUKE_GAZE_*` | A1 five completed gazes, A5:t354→358→359, A10 pre-enrage transition | VERIFIED |
| Four-flare volley | Launch offsets +0/+3/+5/+7 | E `launchFlare` | A2 all 13 volleys and the [enrage cross-check](./duke-capture-analysis.md#three-awakened-enrage-recordings) | VERIFIED |
| Flare travel, gas pulse and fade | Landing +3, first damage +4 and every 2 thereafter, fade at +18 before enrage or +16 during enrage | C `DUKE_GAS_FLIGHT_TICKS`, `DUKE_VENT_*` | A7:L5529–5607. Awakened fades with launch and expiry HP present (221 before enrage, 60 during enrage) | VERIFIED for sampled Awakened fades and pulses |
| Vent distance tie between rows | North wins when available grates are equally close | E `targetedVent` | A12:t146 and L7142–7181 (1) | SINGLE-OBSERVATION |
| Final flare → bile → next basic | 4 then 5 ticks before enrage, 3 then 4 during enrage | E `launchFlare`, `beginBile`, `wardenCadence` | 37 complete transitions (26 before enrage, 11 during enrage). A10:t130→134→139 and A3:t396→399→403 | VERIFIED |
| Bile trail and first drip | First pool +1 after cast, 15 drips. Later drips can include a running step's intermediate tile | E `BILE_TICKS`, `resolveHazards` | A1:t226–240, A6:t1088→1089 and A12:t24→25 | VERIFIED for the sampled drips |
| Bile pool lifetime and first hit | 9 ticks visible, damaging from placement +1 | E `BILE_POOL_TICKS`, `dropBile` | A0 and A1 complete lifetimes. A5:t359 hits on removal tick. [Damage replay audit](./duke-capture-analysis.md#2-damage-replay-audit) | MODEL at the expiry boundary |
| Orb countdown and sweep | First spawn +3 from threshold crossing, then every 12 ticks. Moves one tile per tick and hits one tick after sharing a tile | E `ORB_SPAWN_DELAY_TICKS`, `ORB_PERIOD`, `resolveOrb` | A1:t224→227 and 232→233, A7:t252→255, A12:t117→120 | VERIFIED for the recorded sweeps. Exact HP threshold is open |

## 1. Actors and arena

An opening attempt starts with Duke asleep. **Feed** uses one Arder-musca poison per tick. Three
doses fill the 370-point tolerance meter. The wake animation starts one tick after the final
tolerance update, with Duke ready to attack five ticks later. A six-tick weapon can swing at wake
+1 and again on the shatter tick after stepping out. [Awakened strategy](https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies#Awakened_mode)

The arena renders terrain and scenery from map square `(47, 100)`, archive
`12132` in the pinned build 242 cache (OpenRS2 cache 2772). The room uses both ground and upper
scenery levels for the side fences. Duke occupies a seven-tile-wide footprint.
His southwest anchor `[28, 52]` is a practice placement between the pillars
around the [Wiki map pin](https://oldschool.runescape.wiki/w/Duke_Sucellus#Location).
The actor definition (W) uses cache sleeping NPC 12166 and awake NPC 12191. A1 uses sleeping NPC 12167.
Cache floor clipping across local Y 52–53 closes the arena behind the front
lane. Ground clicks under either form of Duke path to the edge of the lane.
The front lane is for step-backs and orb crossings. The tile directly behind
either front pillar is outside the slam and still takes icicle chip damage
during the [melee cycle](https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies#Battle_phase).
The pillars form two columns, with three walkable tiles between the front and
rear pillar on each side. Teal floor markers show where the pillars block
gaze during the warning. The nine grate centers (LOC 47555) are at local X
28, 31, and 34 and local Y 42, 46, and 50. The front pillar pair (LOC 47513)
is at Y 52 and the salt-pillar pair (LOC 47523) is at Y 48.

## 2. Combat stats and mechanics

The encounter uses the 1,697-HP Awakened combat stat record for both the
sleeping and awake forms. Duke's base Defence is 316, his slash defence bonus
is +65, and his demonbane vulnerability is 70% of the usual bonus. Awakened
Duke is immune to stat drains. [Awakened infobox](https://oldschool.runescape.wiki/w/Duke_Sucellus#Awakened),
[Strategy guide](https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies).

The [OSRS Wiki strategy page](https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies#Awakened_mode)
documents 1,697 boss HP, a five-tick basic attack cycle that drops to four at
440 HP, and a gaze after five basic attacks. The sim checks cover and
reports the result four ticks after windup. A failed check deals damage
one tick later. Duke starts the next attack at windup +6. Gas follows three basic attacks after the
first gaze, then five, four, or three basic attacks apart as the fight
progresses. Gaze takes priority over a competing vent attack.

### Melee and magic

The melee windup checks the target in the 3×3 icicle area immediately and
starts sequence 10176 at its cache speed. The sim uses the NPC crush
accuracy roll with Duke's 435 Attack and +200 attack bonus. Protect from
Melee halves the chip roll and rounds down. Awakened recordings show 8
with melee prayer (`20261127-012348-Duke-Sucellus_3.jsonl:8445–8472`,
`20261127-013711-Duke-Sucellus_4.jsonl:9038–9068` and
`20261127-020616-Duke-Sucellus_6.jsonl:6169–6195`), and 13 without it
(`20261127-005253-Duke-Sucellus_2.jsonl:12482–12511`). The [unverified behavior register](./duke-unverified.md#damage-and-hazard-boundaries) records the modeled chip cap.
The shatter checks the seven front-row tiles (X 28–34, Y 51) two ticks after
windup, before player movement. The two pillar diagonals can bait icicles and
sit outside the shatter row. Step out before the slam tick and click Duke
again on that tick to attack from the front row. The enrage capture shows a
connecting slam at windup +2 when the player starts the tick in the front row.
[Battle phase](https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies#Battle_phase) ·
[Awakened walkthrough](https://www.youtube.com/watch?v=h-Pqf0Y0td4&t=58s)

On a basic attack, the sim checks the player's true tile before movement
on the windup tick. Melee covers the row next to Duke, including the two
diagonals behind the front pillars. Beyond that row, the sim selects magic.
In both phases, the blue bolt leaves Duke's mouth 50 client cycles
into windup and arrives at cycle 120 (four game ticks). The projectile and
impact graphic track the player's rendered position. In
`20261127-002024-Duke-Sucellus_1.jsonl` (lines 8637 and 8663–8667), the bolt
targets the player at visible tile `[30, 50]` while the true tile is
`[29, 50]`. The impact graphic is attached to the player.
The sim rolls bolt accuracy with Duke's 465 Magic and +150 magic attack
bonus. It checks Protect from Magic on arrival and plays the impact
graphic and sound when the bolt connects. Any magic hit,
including a protected hit for zero, disqualifies a perfect kill. Icicle chip
damage is allowed. See the
[strategy page](https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies#Battle_phase)
and [perfect kill rules](https://oldschool.runescape.wiki/w/Duke_Sucellus#Mechanics).

The slam uses Duke's 500 Strength and +38 melee strength bonus to roll up to
81 (60 with Protect from Melee). The magic bolt uses his 465 Magic and +32
magic strength bonus to roll up to 71 (36 with Protect from Magic). Both use
the shared NPC damage formula. The icicles keep their separate chip cap, and
Freezing Gaze caps at 121. See the
[Awakened infobox](https://oldschool.runescape.wiki/w/Duke_Sucellus#Awakened)
and [Awakened strategy guide](https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies#Awakened_mode).

### Gas flares and bile

The four-flare volley launches at offsets 0, 3, 5, and 7 ticks. In the
[uninterrupted Awakened footage](https://www.youtube.com/watch?v=h-Pqf0Y0td4&t=203s),
the four spit animations start around 3:24.3, 3:26.2, 3:27.3, and 3:28.6.
The [enrage example](https://www.youtube.com/watch?v=h-Pqf0Y0td4&t=282s)
shows the same first two gaps before pausing. The sim uses this cadence
for its four-flare volleys.

The sim matches all 37 recorded transitions with a final flare, a bile
warning and a following basic. The intervals count from the windup cue.

| Phase | Last flare windup to bile warning | Bile warning to next basic | Total |
| --- | ---: | ---: | ---: |
| Before enrage (26 transitions) | 4 ticks | 5 ticks | 9 ticks |
| Enrage (11 transitions) | 3 ticks | 4 ticks | 7 ticks |

The last flare lands three ticks after windup. Bile starts one tick after
that landing before enrage and on the landing tick during enrage. The next
attack checks the player's true tile before movement. In the tenth capture,
the flare, bile and melee windups are on ticks 130, 134 and 139. In the third
capture the same sequence in enrage is on ticks 396, 399 and 403. Both melee
windups deal chip immediately. See `20261127-025030-Duke-Sucellus_10.jsonl`
lines 6614–6828 and `20261127-012348-Duke-Sucellus_3.jsonl` lines 11918–12126.
With run off, start moving on the first drip tick and get back to melee range
before the next basic checks your tile.
[Pre-enrage walkthrough](https://www.youtube.com/watch?v=h-Pqf0Y0td4&t=208s) ·
[RecklessNg's kill](https://www.youtube.com/watch?v=YwYTtOvnuck&t=109s) ·
[Enrage walkthrough](https://www.youtube.com/watch?v=h-Pqf0Y0td4&t=331s)

In both bile casts in `20261126-232238-Duke.jsonl` (lines 6554–6590 and
7537–7579), the warning and Duke's sequence 10178 start together. Local sound
1784 plays with the warning. The first pool appears 30 client cycles later.
Graphic 1354 launches toward the player on cycle 32 and arrives on cycle 51, with
heights 130 and 160 and an initial forward offset of 32 local units. Duke's
area audio plays sound 7179 on cycle 1 and 7248 on cycle 35. The sim
reproduces these cues when a volley is followed by bile.
The first pool appears only on the player's true tile. Later drips can also
leave a pool on the intermediate tile of a run.

Each flare targets the nearest vent that has no landed, active smoke at
windup. An equal-distance tie between rows favors the northern vent.
Moving south between launches draws later shots to a different row.
Duke uses sequence 10178, and projectile 2436 leaves on client cycle 20
and arrives on cycle 90 (three game ticks). The first smoke graphic (2431)
starts at landing. Idle smoke (2432) starts the next tick and damage pulses
every two ticks from windup +4. The fade (2433) starts at windup +18 before
enrage and +16 for flares launched during enrage. A second flare can target
the same grate before the first lands. The new smoke NPC replaces the
previous pulse on the tick before the second projectile arrives
(`20261126-232238-Duke.jsonl:5736–5800`). The first four-flare volley resumes
basic attacks four ticks after the last flare. At tick 150, the due grate
volley starts one basic attack after Gaze.

Duke's attack clips, frontal icicles, and blue bolt travel and impact use the shared
[visual batches](../architecture/events.md#visual-batches). Older recordings can
still play those effects from their snapshots.

### Orb of Darkness

The first orb spawns in the front lane three ticks after Duke crosses its activation threshold.
Orbs spawn every 12 ticks and travel one tile per tick. The exact HP cutoff remains open.
[Orb model](./duke-unverified.md#attack-selection-and-thresholds)

Sharing a true tile with the orb causes it to disappear and hit on the following tick. It deals up to
27 damage and drains
the six simulated skill levels and eight prayer points. The sim uses an
eight-level drain on each skill from the
[Awakened strategy](https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies#Awakened_mode).
The newer Awakened capture confirms eight levels from each skill, including
Attack, Strength and Defence, for the observed contact.
The 3D scene uses the cache model for the
[Orb of Darkness](https://oldschool.runescape.wiki/w/Orb_of_Darkness) (11708)
and plays graphic 379 on spawn, contact, and sweep completion.
The 3D model and 2D marker interpolate between the orb's tick positions.
The westbound orb in `20261127-022231-Duke-Sucellus_7.jsonl` (lines
9385–9404) visibly moves between centers while its true tile advances
from X 36 to 35 to 34. Contact checks use the true tile.
The [recorded kill and walkthrough](https://www.youtube.com/watch?v=h-Pqf0Y0td4)
illustrate stepping out for the slam and walking bile alongside the basic cycle.

## 3. Effect ID dictionary

Sequences, graphics, and sounds come from the pinned cache and the cited captures. The [capture analysis](./duke-capture-analysis.md#1-capture-cross-checks) gives packet and tick context.

| Effect | Cache IDs and timing | Evidence |
|---|---|---|
| Sleep and wake | Idle sequence `10174`, with area sounds at frames 1, 56, and 57. Wake `10179` runs for 90 client cycles. The awake model replaces the sleeping one at the start of the wake clip. | R:L6184–6218, A1:t11, cache 2772 |
| Melee icicles | Sequence `10176` and wide frontal graphic `2439` at Duke's center. Ground graphics `2440, 2441, 2442, 2443, 2442, 2441, 2440` start on the same tick from west to east. The forward offset is baked into graphic `2439`. | A0:L4693–4704, L5193–5209, L7646–7660 |
| Magic bolt | Sequence `10177`, projectile `2434`, impact graphic `2435`. Connected bolts play local sound `7197` on arrival. | A1:L8637–8716, A2:L10454–10497. [Bolt audit](./duke-capture-analysis.md#2-damage-replay-audit) |
| Gas flare | Sequence `10178`, projectile `2436`, and smoke graphics `2431`, `2432`, `2433` for landing, idle, and fade. Local warning `5002` plays on windup. Vent ignition and idle sounds originate at the grate. | A10:L5069–5087 and L5145–5164, A7:L5529–5607 |
| Bile | Sequence `10178`, projectile `1354`, local warning `1784`, and acid-pool LOC `30032` with type `10` and model `29311`. Both flare and bile use area cues `7179` and `7248` at +1 and +35 client cycles. | A0:L6554–6590, A10:L11687–11744, cache 2772. [RuneLite cache identifier](https://github.com/runelite/runelite/blob/9af7b54deaac35b3153af06195d66c1d68fbea5a/runelite-api/src/main/java/net/runelite/api/gameval/ObjectID.java#L93463) |
| Freezing Gaze | Eye-opening sequence `10180`. Interface `829`, component `2`, uses model `48318` with appearance sequence `10216` (120 cycles), then fade `10215`. The simulator closes the overlay after six ticks. | A1 successful gazes, A5:t354–359, cache 2772. [Recorded appearance and fade, 20–23 seconds](https://runescapeguides.com/wp-content/uploads/2025/05/1-36.mp4) |
| Orb of Darkness | NPC `11708`, with graphic `379` on spawn, contact, and sweep completion. | A1:t227, 233, and 239. [Orb cross-check](./duke-capture-analysis.md#awakened-west-side-orb-opener-and-final-contact) |
| Duke hit cue | Area sound `7181` at Duke's center, range 10, when the first player hit of the tick deals damage. | A10:t106 has Scythe splats 0, 24, and 7 with no cue. At t133 three positive splats produce one cue (L6165–6167 and L6674–6680). |
| Duke death | Sequence `10181`, area roar `7238` at +1 and slouch `7171` at +60 client cycles. | R all four kills, first at L5729–5786 |

The 3D renderer shows flares as projectiles and smoke and uses the cache LOC for bile pools. The
simulator displays each pool for nine ticks, with damage starting one tick after placement. Later
drips on the same tile preserve its expiry. The 2D renderer marks flares and pools with tile
overlays. Both views mark gaze cover. [Recorded pool placement](https://www.youtube.com/watch?v=YwYTtOvnuck&t=116s)

## 4. Practice setup

The simulator uses 1,289 HP for four flares, 1,103 HP for bile eligibility, 560 HP for orbs, and
440 HP for enrage. Attack-only recordings retain their original five-tick first-swing-to-response
delay for replay takeover. [Modeled HP gates](./duke-unverified.md#attack-selection-and-thresholds)

The starting loadout includes brewed poison. The default loadout opens with Burning claws and Oathplate
helm equipped. It carries a Scythe of Vitur, Emberlight, an Avernic defender, two non-divine super
combat potions, five super restores, five Saradomin brews, three halibut, nine anglerfish, and one
stack of three [Arder-musca poisons](https://oldschool.runescape.wiki/w/Arder-musca_poison).
The alternate weapon presets and the low-stat fallback carry the same three-dose stack.

**Start at** selects the next attempt's starting phase. **Practice → Jump to
phase** changes Duke's phase in the current attempt. Both start the later
phases with Duke awake. Vents, Bile and Orbs begin at a four-flare volley after
one five-tick interval. The timers for the next Gaze use the three, two and one
basics since Gaze observed at ticks 86, 123 and 254 in
`20261127-025030-Duke-Sucellus_10.jsonl`. These are fixed points in each phase's
rotation. A normal fight carries its counters forward as Duke loses HP.

The orb first spawns three ticks into Orbs or Enrage practice. Enrage starts
its first basic after four ticks and its first volley after three basics,
matching the sequence on ticks 346–365 in the same capture. In the full fight,
Duke starts asleep and his first volley follows the first Gaze and three
basics. Older recordings retain their original setup and phase jumps. Bile
uses its usual chance at eligible HP. **Always Bile** forces the cast after
every completed volley at any HP.
