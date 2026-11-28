# NPC hit queue and deferred death

Evidence: a survey of about 2,400 zero-HP episodes across the captures. RSMod
(ISC, `fa13b3f`) and 2004Scape/Server (MIT, `647886c`) corroborate individual rules where cited
below.

## Observed behavior

| Rule | Evidence | Status |
|---|---|---|
| Reaching 0 HP does not end the NPC's current turn. It may still move and attack on the kill tick (K). | B:3356 berserker swing; many Inferno kill-tick attacks | OBSERVED |
| If another hit is processed after the lethal one in the victim's queue pass, or another accepted hit is still pending at the end of that pass, death processing runs on K. Otherwise it runs on K+1. | 100/104 non-ToB, non-boss overkill kills (the other 4 hit the movement floor); scythe: 85/87 early (2 floor), lethal-last 15/15 at K+1; C:2142, C:2432 (a lower-index thrall queued before the victim's turn) | CAPTURE-FIT MODEL |
| Burn kills always process death at K+1, even with an incoming hit pending, and the NPC still acts on K. | 23/23 burn kills; Inferno 1-68: 7288 and 7694 | OBSERVED |
| The death animation starts at `max(deathProcessTick, lastStepTick + 3)`. | All 89 warband deaths in the three wave captures; Inferno ranger 3590; B:2210 | OBSERVED (ordinary NPCs) |
| Hits from a dead or dying NPC that are already released (projectiles) still land on the player. | Inferno 1-68: 1312→1313 (9), 5091→5093 (14) | OBSERVED |
| Unreleased windups and some delayed melee are canceled by the source's death. | B:3356 (no splat at 3357); Jad 5173→5174 | OBSERVED |
| Accepted hits landing on a zero-HP victim render as 0 and have no further effect. | 10 episodes, e.g. Inferno 1-68: 7288→7289, 7694→7695 | OBSERVED |
| Same-tick hits on one victim apply in enqueue order. Multi-hit splats are separate ordered entries. | C:1606 `45,0,0`; B:2210 older Shadow `48` then newer thrall `0` | OBSERVED |
| On K, a manual spell and a Burst/Barrage area still reach the zero-HP NPC, and a Blood spell heals off it ("phantom barrage"). | Inferno 35-68: t1219, t1196, t294, t756, t3082 (see [Phantom barrage](#phantom-barrage-kill-tick-spells)) | OBSERVED |
| Bosses and scripted adds have custom lifecycles. | Sol 4/4 same-tick; Yama, Zuk, ToB vary | OBSERVED, out of scope |

## Contracts

### 1. Ordered queue (shared)
- World-owned monotonic `nextHitSequence`. Every pending hit gets an immutable `enqueueSequence`, allocated
  only by the central enqueue (`CombatSystem.queuePendingHit`).
- World-owned `nextNpcProcessingOrder`. Every registered NPC gets an immutable `processingOrder`. Live play uses
  registration order (MODEL; not the server's index allocator). Capture fixtures may supply observed indices.
- A victim's due hits are processed in `enqueueSequence` order. `impactTick` gates eligibility only, never
  precedence. No sorting by attacker, style, damage, or player vs NPC.
- Multi-hit attacks are consecutive individual entries. `attackGroupId` is for presentation only.
- Draining is per target actor and tolerates insertion. Claim and remove an entry before running its callbacks;
  never rebuild `pendingHits` from a stale snapshot; visit each entry at most once per pass; future entries stay.
- `impactTick` is absolute. Each producer accounts for receiver order once; NPC→NPC delays (including
  Zuk→glyph) come from the shared helper `npcProjectileHitDelay`.

### 2. Per-NPC interleaved turns
After retaliation (a pre-pass: a reaction only comes from a player attack, never from inside this band) and
the encounter's `prepareNpcBand`, each NPC takes one turn, in `processingOrder`:
0. Its removal, if due (`removeNpcIfDue`); a removed NPC takes no turn.
1. Service its incoming-hit queue and any due death transition.
2. Run its burn, poison and regen timers.
3. Decide whether it may act (`canNpcActThisTurn`).
4. Move (`moveNpc`, default: its definition's `move`).
5. Resolve local effects (`resolveNpcLocalEffects`).
6. Run its action hook (`processNpcTick`), then commit returned attack requests immediately.

Then the encounter's `completeNpcBand`, then the player band.

The roster is walked live in `processingOrder`. An NPC registered during the band (by an earlier NPC's hit
pass, movement or action) takes its turn this tick, after every NPC registered before it: OBSERVED, W69
t877 (`docs/encounters/zuk-facts-spec.md` section 5), where Jad's half-health hit spawns his healers and
the two in range cast on that tick. Each instance gets at most one turn per tick, and a removed or replaced
actor (identity check) loses its turn. A spawn from `completeNpcBand`, `processPostTick` or a command waits for the next tick. Every NPC in the world
must be registered (`WorldState.registerNpc`); the engine refuses one without a `processingOrder`.

Encounter-wide preparation and completion stay once per tick (`resolveHazards`, `prepareNpcBand`,
`completeNpcBand`, `processPostTick`) and hold encounter-wide work. The one exception is Sol, an immediate
boss with his own sequence: his phases, beams, parries, local effects and attacks run in `completeNpcBand`,
after every NPC's damage. No band hook may repeat work a per-actor hook does for the same NPC.

Only movement falls back to the definition: without `moveNpc`, the engine calls the NPC's definition
`move`. `resolveNpcLocalEffects` and `processNpcTick` have no fallback, so an encounter forwards them
explicitly. Sol runs his own local effects and attack in `completeNpcBand`, and Yama runs every flare's
local effects in `resolveHazards`; a definition fallback would run those a second time.

The NPC's turn owns its requests. Every movement request and returned attack must name the turn's NPC (the
engine throws otherwise), attacks are committed for the retained instance, and once the NPC is removed or
replaced the rest are dropped rather than re-bound to a same-id successor.

Zuk registers the glyph before Zuk, as both Zuk captures index it (46150/46151, 57610/57611), so the glyph
steps before Zuk aims; the 135-cast capture conformance depends on it. NPC→NPC projectile delays come from
the one helper `npcProjectileHitDelay` (section 1): `floor(endtime / 30)` in either turn order (Jal-Zek→glyph
t104→t108, endtime 140).

### 3. Life state
- `alive=false` on the first transition to 0 HP; it is the projection of the death state used for
  targeting, healing and HP effects.
- NPC death record: `{ status: 'pending' | 'started', killTick, processTick, causeStage: 'hit-queue' | 'timer' | 'scripted' }`.
  Removal means absence from the world.
- Predicates: `canNpcActThisTurn`, `canReceiveNewAttack`, `canReceiveHealing`, `isCurrentActorInstance`.
- Definition policy `deathPolicy: 'immediate' | 'queued'`, default `immediate` (section 5 lists the opt-ins).
- First lethal hit (`hpBefore > 0 && hpAfter === 0`):
  - Set HP to 0 and `alive=false`, and create the death record once.
  - Clear burn and poison, and stop regen.
  - Record K for rewards and the defeat notification.
  - Emit `actor_died` exactly once.
  - Keep accepted incoming hits.
  - For `queued`: `processTick = K+1`, promoted to K by the hit-queue rule above.
  - For `immediate`: start death now.
- Death processing stops ordinary movement and interaction, clears pursuit and retaliation, and cancels
  unreleased windups. The corpse is retained for presentation and zero impacts.
- A timer kill (burn; poison is a MODEL extrapolated from burn) creates pending death at K+1. It never
  reopens the completed hit pass, and a due queued hit that kills first prevents the timer pulse.
- Presentation: `deathAnimationTick = max(processTick, lastStepTick + 3)` for queued NPCs killed by a hit or a
  timer; a scripted death (`markNpcDead`) animates at its `processTick`, with no movement floor. Record
  `lastStepTick` when the engine applies movement, including a pending-death NPC's final permitted step.
  The floor never grants extra turns. Through the production rule (`warbandCapture.test.ts`) all 89 warband
  deaths in the three wave captures fit, 13 of them promoted to K. A fixed `K + 1` delay fits 82; the seven
  it misses start on K, five promoted by a lower-index thrall's queued hit (C:2142, C:2432, B:3386, B:3392,
  A:4279) and two by overkill (C:1815, A:1141).
- Death presentation of a queued NPC (its death sound, e.g. Jal-Xil 599 at W69 t156 for a t155 kill, Jad
  409 at t984 for t983) belongs to the death animation tick: the definition's `onDeathAnimation`, called
  exactly once per life (`claimNpcDeathAnimation`), from the NPC's turn on that tick or, for a death that
  animates as it is processed (a scripted one), from its death processing. Jad's corpse is removed six
  ticks after his death animation (t984 -> t990).
- A zero impact on a dying NPC still plays its hit sound, without a defend reaction: Inferno 1-68 7289,
  the Jal-Xil killed by a burn on 7288 takes a 0 at 7289 with its hit sound 600 and its death sequence.

| Concern | Active | Pending, HP 0 | Death started | Removed |
|---|---|---|---|---|
| New targeting | yes | only a manual spell's primary or a Burst/Barrage area ([phantom barrage](#phantom-barrage-kill-tick-spells)) | no | no |
| Accepted incoming hit | damage | render 0 | render 0 | drop |
| Healing/regen | yes | no | no | no |
| Ordinary action | yes | its permitted turn only | no | no |
| Movement occupancy (blocking NPCs) | yes | yes | yes | no |
| Committed outgoing hit | yes | persists | persists | persists (retained source identity) |
| Unreleased windup | normal | owner policy | cancel | cancel |
| Rewards/kill hook | none | once, at K | no | no |

- `onDefeated` and the encounter defeat notification stay anchored to K in the post band.
- Overkill must not repeat `actor_died`, Death Charge, spec refunds or other on-kill effects.
- Prune grace runs from `max(killTick, deathAnimationTick)`, preserving `retainAfterDeath` and boss retention.
- A corpse keeps blocking NPC movement until it is removed (`npcOccupancy.ts`). Removal happens in the
  removed NPC's own turn (`Encounter.removeNpcIfDue`, step 0 of section 2): its tiles still block every NPC
  whose turn came earlier that tick and are free for every later one (Inferno 1-68: the lower-index mager
  waits out the removal tick at Q t4119/t4120 and Q t4180/t4181, and the lower-index bat at P t7626/t7627,
  while the higher-index bat at P:140314-140366 enters on the removal tick t7687). Pruning only bounds a
  corpse nothing removes, so an encounter whose NPCs block removes them on their captured removal tick:
  Inferno's per-species delays (`waveNpcs.ts`), Jad's +6, and Zuk's sets and healers at +2
  (`ZukWaveDirector.ts`).
- Scripted revival resets the death state and starts a new life generation. Pending hits from the earlier life must not cross it.

### Phantom barrage (kill-tick spells)
The player band of K runs after the victim's lethal queue pass and before its death processing (K+1), so for
that one band a `queued` NPC is at 0 HP with a pending death. Two spell paths still reach it:

- A **manual** spell cast (spell-on-NPC) may take it as its primary. Autocast, melee and ranged refuse it and
  drop the target, as for any dead NPC. Autocast's single-target refusal is simulator policy; the captures do
  not distinguish it from an autocast that takes the primary.
- An Ancient **Burst/Barrage area**, manual or autocast, includes pending-death neighbors. Chinchompa areas
  stay strict (no evidence).

Everything else follows the ordinary model. Accuracy rolls normally. A Blood spell heals at launch from the rolled
damage, which the [Blood Barrage](https://oldschool.runescape.wiki/w/Blood_Barrage) article states even for
targets with little health left; XP is capped by HP at launch, so a kill-tick target gives none. The hit
persists and later lands as a zero impact on the corpse, or is dropped with it. It is queued after the
victim's pass, so death still processes at K+1: no death speed-up. Once death has started, or for an
`immediate` NPC, the window is closed.

Distance is emergent. A Barrage chain phantoms only when the previous lethal cast lands on the tick the next
one fires: the magic delay `1 + floor((46 + 10d) / 30)` reaches the Barrage speed of 5 at `d >= 8` from the
primary. At `d = 5..7` it lands a tick early and death processes before the next cast.

Evidence, `inferno-waves-(35ish)-to-68-packet-data.txt` (byte-identical to the tbow copy). Per cast tick, the
magic `experience` delta is 51 (Blood Barrage base) plus twice the capped damage, and the heal is the
hitpoints change net of the player's own hitsplats that tick.

| Cast | Lines | Observation |
|---|---|---|
| t1219 | 27846, 27866-27914 | Manual click t1217 on the Jal-AkRek-Xil. On t1219 it and the Jal-AkRek-Mej take lethal 1 and 15 from the t1214 cast (d=8), then the cast fires on both: 377 on each, HP 75 → 87, magic XP 51 (0 capped). Both death animations t1220. |
| t1196 | 27478, 27509-27541 | Manual cast on a primary killed that tick: accepted (377), base XP only, no heal (a roll below 4). |
| t294 | 10234-10272 | Manual cast on a primary killed that tick: accepted, splashed (85). |
| t756 | 18988, 19012-19046 | Manual cast (d=10) on three stacked nibblers, two killed that tick: HP 78 → 97 (+19) against 6 capped damage. |
| t3082 | 67184-67217 | Autocast (`opnpc2`): a nibbler killed that tick still takes the area impact (377). |

Corroboration from RSMod (ISC, `fa13b3f`) and 2004Scape/Server (MIT, `647886c`) is partial. RSMod cannot
reproduce this: `Npc.isValidTarget()` requires `hitpoints > 0`
([NpcExtensions.kt:20-22](https://github.com/rsmod/rsmod/blob/fa13b3f67172ef36e15d6b1514358aee61411796/api/npc/src/main/kotlin/org/rsmod/api/npc/NpcExtensions.kt#L20-L22))
for every player attack including manual spells
([PvNCombat.kt:227-231, 301-313](https://github.com/rsmod/rsmod/blob/fa13b3f67172ef36e15d6b1514358aee61411796/api/combat/combat-scripts/src/main/kotlin/org/rsmod/api/combat/PvNCombat.kt#L227-L313))
and for interaction validity
([PlayerInteractionProcessor.kt:449-451](https://github.com/rsmod/rsmod/blob/fa13b3f67172ef36e15d6b1514358aee61411796/api/game-process/src/main/kotlin/org/rsmod/api/game/process/player/PlayerInteractionProcessor.kt#L449-L451)),
and it has no Ancient spells. 2004Scape has the asymmetry: melee and ranged refuse zero HP
([player_melee.rs2:13](https://github.com/2004Scape/Server/blob/647886c42f8a22c0f18e5dbe79c2697f052f8d2e/data/src/scripts/skill_combat/scripts/player/player_melee.rs2#L13),
[player_ranged.rs2:11](https://github.com/2004Scape/Server/blob/647886c42f8a22c0f18e5dbe79c2697f052f8d2e/data/src/scripts/skill_combat/scripts/player/player_ranged.rs2#L11)),
magic deliberately does not
([player_magic.rs2:91](https://github.com/2004Scape/Server/blob/647886c42f8a22c0f18e5dbe79c2697f052f8d2e/data/src/scripts/skill_combat/scripts/player/player_magic.rs2#L91)),
but it routes autocast through the same spell trigger
([player_magic.rs2:6-17](https://github.com/2004Scape/Server/blob/647886c42f8a22c0f18e5dbe79c2697f052f8d2e/data/src/scripts/skill_combat/scripts/player/player_magic.rs2#L6-L17)),
which would let autocast phantom, and predates Ancient Magicks.

### 4. Committed hits vs windups
- A narrow `sourceDeathPolicy: 'persist' | 'cancel-before-impact'` runs through `AttackPlan`,
  `NpcAttackRequest`, `AttackResolution` and `PendingHit`.
- Player attacks and released NPC projectiles `persist`. The warband berserker's delayed melee is
  `cancel-before-impact`. Classify other NPC melee per profile, never by inferring from style.
- A `cancel-before-impact` hit on the player from an NPC already dead this tick lands nothing, even on the
  swing tick its queued death still allows (`CombatSystem.commitAttack`): no melee swing at the player on
  an NPC's killing tick shows a splat (Inferno P t959 and 13 more, B:3356). A swing at another NPC still
  lands (15/15 Jal-Nib swings on their killing tick damage the pillar, P t1503).
- Jad's pre-release attack stays in `JadState.pendingAttack`; its released hit `persist`s.
- A windup due on the NPC's own death-animation tick may still launch there: the engine asks the
  definition's `releaseOnDeathAnimation` once, in that NPC's turn slot, when `isNpcDeathReleaseDue`
  (death started by the hit queue or a timer, never a scripted death), and commits each request
  through `CombatSystem.processDeathReleaseRequest`, the only path that accepts a dying source. The
  NPC still cannot start an attack; definitions return only what they had scheduled. OBSERVED for
  Jal-Ak (Inferno waves Q t1083, t3860).
- An attack already committed and due on the killing turn is a separate contract. It is tied to
  the kill tick, not to the death animation, which a recent step can delay. When the hit queue
  promotes a death to its kill tick, that NPC's ordinary turn is suppressed. The engine then asks
  the encounter's optional `releaseNpcKillTurn` once, in that turn slot and before the
  death-animation release, while `isNpcKillTurnReleaseDue` holds (queued policy, death started on
  this tick, not scripted). A pending death keeps its ordinary turn and is never asked. Requests
  go through the same `processDeathReleaseRequest`, gated by the matching `'kill-turn'` timing.
  The encounter routes the call to the owning NPC, so that NPC's own RNG stream is used. OBSERVED
  for the Fortis Colosseum Manticore: the orb due on the kill tick launches but never lands
  ([facts spec §6.9](../encounters/fortis-colosseum-facts-spec.md)).
- Persistent hits use the retained source and target runtime identity (`PendingHitRuntime`), never a new actor
  with the same ID. The target must be the same registered instance.
- Zero-impact path: emit `hit_applied` and a zero/block splat in queue order. No new rolls or procs, no
  freeze/poison/burn/drain/heal/self-damage, and no repeated defeat or reward.
- Multi-hit batches are accepted atomically at launch. Later components are not rejected because an earlier
  one killed (`processSupplementalHitRequest`). Keep per-hit rolls; never aggregate or reroll.
- Keep damage attribution when the source has been pruned.

### 5. Encounter integration
- Per-actor adapters `moveNpc(actor, ...)` and `processNpcTick(actor, ...)`; the engine owns queue, timer,
  movement and commit.
  - **Sol:** warband via its own turn; Sol is immediate/custom; beam, phases, totems and modifier cleanup are
    owner-sequenced (`prepareNpcBand`/`completeNpcBand`).
  - **Inferno:** each ordinary-wave species is removed in its own turn (`removeNpcIfDue`) at its per-species
    delay after the death animation; a Jal-Ak's children are added before the parent leaves.
  - **Zuk:** glyph registered first; glyph targeting and cleanup are owner-sequenced; corpse removal in
    `removeNpcIfDue`.
  - **Yama:** hazard healing and flare ordering are owner-sequenced; a zero-HP flare never detonates. The
    flares a beat decided spawn in `completeNpcBand`, after every flare's hit queue, so a flare killed anywhere
    in the band frees its slot and tile first.
- Thralls are not simulated. NPC→NPC fixtures through the production scheduler test the ordering.

| NPC | Policy | Owner rules |
|---|---|---|
| Warband berserker, archer, seer | queued | Pursuit route cleared at death processing; berserker melee `cancel-before-impact` |
| Jal-Zek, Jal-Xil (ordinary and wave 69) | queued | Released projectiles persist (Inferno 1-68 1312→1313) |
| Jal-Nib, Jal-MejRah, Jal-ImKot | queued | Removed at their per-species delay after the death animation (`INFERNO_REMOVAL_DELAY_TICKS`); a digging Jal-ImKot surfaces when its death starts |
| Jal-Ak, Jal-AkRek-Mej, Jal-AkRek-Xil, Jal-AkRek-Ket | queued | A Jal-Ak read scheduled before death still releases on its death-animation tick (section 4); its children are added before its removal |
| JalTok-Jad | queued | Unreleased `pendingAttack` canceled at death processing (5173→5174); removal 6 ticks after his death animation |
| Yt-HurKot, Jal-MejJak | queued | A dying healer never heals and a dying NPC is never healed, even on its permitted turn |
| Void flare (player kill) | queued | Detonation and `destroyVoidFlare` are scripted deaths at nonzero HP, whose queued hits are discarded |
| Sol, Yama, TzKal-Zuk, glyph, crystals, Solarflare, Bees, healing totems, lobby/test actors | immediate | Custom lifecycles |

[`deathPolicy.test.ts`](../../src/npcs/__tests__/deathPolicy.test.ts) pins every row except the two
ordinary-wave Inferno rows (Jal-Nib, Jal-MejRah, Jal-ImKot; Jal-Ak and its children) and the lobby/test
actors. Those Inferno definitions declare `queued` directly and are registered by
`registerInfernoWaveDefinitions` in [`waveNpcs.ts`](../../src/npcs/inferno/waveNpcs.ts).

### 6. `alive` audit
- Opted-in definitions guard "may it act" with `canNpcActThisTurn` (including `selectNpcAttack`, which takes
  the tick) and target checks with `canReceiveNewAttack`; healing uses `isNpcLiving`/`canReceiveHealing`.
- Movement helpers (`pursuePlayer`, `pursuePlayerSticky`, `calculateLinearPatrolMove`)
  compute movement only; the definition or encounter that calls them owns eligibility.
- Deliberately strict `alive` (a dying NPC does not do or suffer these): retaliation start and processing,
  the snapshot's combat target and attack timer, the overlap-escape rule, burn/poison application, Zuk's
  scripted-minion filter, and the prune skip. Movement occupancy is deliberately not life-based
  (section 3). Auto-attack refuses a dying target.
- Presentation uses `isNpcStandingAt` (`src/render/npc/npcStanding.ts`): an NPC with `alive: false` and a
  later `deathAnimationTick` is drawn standing, moving and attacking, with its pinned healthbar at 0 and its
  minimap dot, until the death animation starts.

### 7. Replay
Takeover re-simulates the recorded prefix, which rebuilds the state the snapshot does not carry
(`processingOrder`, the death record, `lifeGeneration`, `lastStepTick`). A recording whose bootstrap version
differs from `ENGINE_RUN_BOOTSTRAP_VERSION` (`src/core/engineRunConfig.ts`) keeps playback but not takeover.

## Known gaps
- Hidden server script queues are not modeled. There are no placeholder flags.
- 15 Inferno single-hitsplat kills (P 9, Q 6, mostly Jal-Ak) start their death sequence on the kill tick
  rather than the next; unexplained (finding N9 in
  [`inferno-open-questions.md`](../encounters/inferno-open-questions.md)).
- The movement-arrival mechanism behind `lastStep + 3` is not recovered; it is the observed model.
- Poison timing follows burn as a MODEL.
- Live NPC processing order is registration order, not the server allocator.
- The thrall-promoted warband deaths are fitted from the observed packets; thralls themselves are not simulated.
- A standing queued death still loses its outline, the 2D void flare marker and the flare fuse bar on the kill
  tick.
- The standing presentation is covered by unit tests only; it has not been confirmed in-world.
- No guard against an NPC that spawns another every turn (no production case).
- Phantom casts are captured only for Blood Barrage. The manual exception for every other combat spell, and
  the kill-tick window after a burn or poison kill, are MODEL.
