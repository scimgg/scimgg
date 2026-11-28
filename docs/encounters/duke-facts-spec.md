# Awakened Duke facts spec

The [capture analysis](./duke-capture-analysis.md) contains the tick-level evidence. The [unverified behavior register](./duke-unverified.md) tracks model choices, known mismatches, and the captures that would resolve them.

The sim starts with Duke asleep. Click **Feed** to use one Arder-musca
poison per tick, for three doses total. Each dose fills 125 of the 370-point
tolerance meter, capped at 370. The final dose starts the wake animation
on the following tick. Duke attacks five ticks into the wake. Swing one
tick into the wake with a six-tick weapon, step out, and re-enter on the
slam tick for your second swing. [Awakened strategy](https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies#Awakened_mode)
The arena renders terrain and scenery from map square `(47, 100)`, archive
`12132` in the pinned build 242 cache (OpenRS2 cache 2772). The room uses both ground and upper
scenery levels for the side fences. Duke occupies a seven-tile-wide footprint.
His southwest anchor `[28, 52]` is a practice placement between the pillars
around the [Wiki map pin](https://oldschool.runescape.wiki/w/Duke_Sucellus#Location).
The pinned cache supplies the sleeping NPC (12166) and awake NPC (12191).
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

The attack clips are melee 10176, magic 10177, gas and bile 10178, gaze 10180, and death
10181. Duke switches to his awake model when the 90-cycle wake clip
(10179) begins, so the player can attack as the clip plays.
The wide frontal icicles (2439) start at Duke's center because their animation
has the forward offset built in. The seven ground icicle graphics start
on the same tick and run west to east across the row in front of him. In 3D,
projectiles and gas clouds show vent flares. The 2D map marks vent flares and
bile pools with tile overlays. Both views mark gaze cover.

Freezing Gaze pairs Duke's eye-opening sequence (10180) with the full-screen
tint and ripples from interface 829, component 2 (cache 2772). The sim plays
the interface model (48318) through its 120-cycle appearance (10216) and then
its fade (10215), closing the overlay after six ticks. The appearance and fade
are visible around 20–23 seconds in the [gameplay reference](https://runescapeguides.com/wp-content/uploads/2025/05/1-36.mp4).

## Source and practiced timings

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

Bile lasts 15 ticks. The first orb spawns in the front lane three ticks
after Duke crosses its activation threshold. The [unverified behavior register](./duke-unverified.md#attack-selection-and-thresholds) records the modeled cutoff. Orbs spawn
every 12 ticks and travel one tile per tick. Sharing a true tile with the
orb causes it to disappear and hit on the following tick. It deals up to
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

## Timing verification ledger

All offsets are game ticks unless specified. One game tick is 30 client cycles. Local coordinates use cache square `(47, 100)`, with X increasing east and Y increasing north.

| Rule | Implemented value | Evidence and status |
| --- | --- | --- |
| Feeding and wake | Three doses, 370 tolerance, awake at final feed +1 and first attack at wake +5 | Tolerance and dose count are published. The wake and attack offsets were observed in both fight modes. See the [opener cross-check](./duke-capture-analysis.md#awakened-opener-and-orb-cross-check). |
| Basic cadence and shatter | 5 ticks, 4 at 440 HP. Chip at windup and shatter at +2, against the tile before player movement. | Observed before and during enrage. All 11 exposed shatter checks match when replayed with the recorded melee windups. See the [damage audit](./duke-capture-analysis.md#damage-replay-audit). |
| Melee or magic | X 27–35, Y 51 at windup selects melee. | The front-row model matches 487 of 501 earlier basic windups and all 19 in the latest capture. Earlier off-row melee exceptions remain open. See [basic attack selection](./duke-capture-analysis.md#basic-attack-selection-by-tick). |
| Magic bolt | Launch at +50 client cycles, hit at +120, with protection checked on impact. | Recorded bolt flights and hit ticks agree. The [capture analysis](./duke-capture-analysis.md#awakened-magic-and-failed-gaze-cross-check) documents the observed impact cues. |
| Freezing Gaze | After five basics. Cover checks at +4, damage at +5, next action at +6. | The [failed gaze cross-check](./duke-capture-analysis.md#awakened-magic-and-failed-gaze-cross-check) includes the check and hit on separate ticks. |
| Gas flare volley | Launches at +0/+3/+5/+7. Each lands at +3, with pulses every two ticks from +4. Fade starts at +18 before enrage or +16 in enrage. | Recorded launches, pulse gaps and fades agree in Awakened mode. The north preference between equally close available rows has [one discriminating sample](./duke-capture-analysis.md#1929-awakened-recording). |
| Flare → bile → basic | 4 then 5 ticks before enrage, 3 then 4 during enrage. | Matches all 37 complete transitions with bile in the [capture analysis](./duke-capture-analysis.md#three-awakened-enrage-recordings). |
| Bile trail | 15 drips, starting at cast +1. Pools appear on the true tile and on later intermediate running tiles. | First-drip placement is [observed in two casts](./duke-capture-analysis.md#1929-awakened-recording). Pool lifetime is modelled as nine ticks. One recorded expiry boundary remains open. |
| Orb | Spawns every 12 ticks, advances one tile per tick, hits on the tick after contact. | Observed from both starting sides. The [threshold cross-check](./duke-capture-analysis.md#awakened-orb-threshold-cross-check) bounds the threshold. The exact cutoff and side selection are open. |

## Practice setup

The simulator uses 1,289 HP for four flares, 1,103 HP for bile eligibility,
560 HP for orbs, and 440 HP for enrage. Attack-only recordings retain their
original five-tick first-swing-to-response delay for replay takeover.

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

## Audio and presentation

The 3D trail uses Acid pool object 30032 from cache 2772. The capture uses
LOC type 10 (model 29311), as at line 6586. Each pool shows for nine ticks and
becomes damaging one tick after placement. A drip on the same tile leaves its
original expiry in place.
[Cache identifier](https://github.com/runelite/runelite/blob/9af7b54deaac35b3153af06195d66c1d68fbea5a/runelite-api/src/main/java/net/runelite/api/gameval/ObjectID.java#L93463) ·
[Puddles in the recording](https://www.youtube.com/watch?v=YwYTtOvnuck&t=116s)

Gas Flares play local warning 5002 at windup. Bile plays local warning 1784.
Both use Duke's area cues 7179 and 7248 at +1 and +35 client cycles. The
warnings and their distinct projectiles appear in `20261127-025030-Duke-Sucellus_10.jsonl`
at lines 5069–5087 and 11687–11744. Vent ignition and idle sounds originate
at the grate. A connected blue bolt plays 7197 locally on arrival.

Duke's impact sound 7181 plays from his center with range 10 when his first
hitsplat that tick deals damage. In the tenth capture on tick 106, the Scythe
rolls zero, 24 and 7 and produces no cue. On tick 133, the three positive
splats produce one cue. See lines 6165–6167 and 6674–6680. The sim applies
this rule to hits resolved from the player.

The sleeping idle sequence 10174 plays three area sounds at cache frames
1, 56 and 57. See `20261126-235612-Duke-Sucellus.jsonl:6184–6218`. All
four recorded defeats play the area roar 7238 at +1 and slouch 7171 at +60
client cycles, measured from sequence 10181. The first defeat is at lines 5729–5786.
