# Awakened Duke Sucellus — unverified behavior register

This register lists the game behavior choices that still need capture evidence, including known
exceptions and the recordings that could resolve them. The [facts spec](./duke-facts-spec.md) holds
the supported rules and defines the [capture aliases](./duke-facts-spec.md#captures). The
[capture analysis](./duke-capture-analysis.md) gives the underlying observations and comparisons.

**MODEL** identifies a fit to the recorded samples with unknown bounds or distribution.
**POLICY** identifies a deliberate simulator choice. **UNVERIFIED** identifies a boundary or known
exception that remains open.

**E** = [`DukePracticeEncounter.ts`](../../src/encounters/dukePractice/DukePracticeEncounter.ts),
**A** = [`arena.ts`](../../src/encounters/dukePractice/arena.ts), **P** =
[`controls.ts`](../../src/encounters/dukePractice/controls.ts), and **C** =
[`constants.ts`](../../src/encounters/dukePractice/constants.ts).

## Attack selection and thresholds

| Behavior | Current sim choice and code | Label | Evidence so far | Recording that would verify it |
|---|---|---|---|---|
| Melee selection outside the front row | Melee at X 27–35, Y 51 before movement at windup. Magic elsewhere. A `isInMeleeLane`, E `processNpcTick` | MODEL with known exceptions | 487/501 earlier basics and 19/19 in A12. Fourteen earlier off-row melee windups. [Selection audit](./duke-capture-analysis.md#basic-attack-selection-by-tick) · [Follow-up trials](./duke-capture-analysis.md#follow-up-trials) | Repeated windups with the same tile and phase and different prior steps |
| Gas flare distance ties | Nearest available vent. North wins a tie between rows. A same-row tie keeps west-first order. E `targetedVent`, A `VENTS` | MODEL for the north preference, POLICY within a row | A12:t146 is the only available-vent tie that distinguishes rows. [Recorded tie](./duke-capture-analysis.md#1929-awakened-recording) | Another available-vent tie between rows and a same-row tie |
| Bile eligibility and trigger | At 1,103 HP or below, each completed volley has an independent 27/58 chance to queue bile. P `BILE_HP`, E `BILE_CHANCE`, `launchFlare` | MODEL | Bile followed 27/58 complete eligible volleys in eight calibration captures. [Cross-check](./duke-capture-analysis.md#awakened-orb-threshold-cross-check) | Volleys with exact HP near 1,103, including consecutive volleys at the same HP |
| Orb activation cutoff | Begin the countdown at 560 HP. P `ORB_HP`, E `processPostTick` | MODEL | Full-HP opener data brackets the cutoff at 547–569 HP. [Threshold cross-check](./duke-capture-analysis.md#awakened-orb-threshold-cross-check) | Known cumulative damage with smaller hits through that HP window |
| Orb spawn side | Independent, equal east or west odds at every spawn. E `resolveOrb` | MODEL | Earlier sample has 41 spawns per side, with both opener sides and repeated sides observed. [West-side opener](./duke-capture-analysis.md#awakened-west-side-orb-opener-and-final-contact) | Longer spawn sequences with the player in different positions, distinguishing openers from later sweeps |

Replays store an encounter seed for the modeled bile and orb choices. Combat rolls use a separate
random stream.

## Damage and hazard boundaries

| Behavior | Current sim choice and code | Label | Evidence so far | Recording that would verify it |
|---|---|---|---|---|
| Icicle maximum and accuracy | Crush accuracy, 0–16 damage, floor half the roll with Protect from Melee. E `attackAccuracy`, `HAZARD_DAMAGE.spikes` | MODEL | Protected hits of 8 and an unprotected hit of 13 imply an unprotected cap of at least 16 given the published halving rule. [Damage sources](./duke-facts-spec.md#melee-and-magic) | Hits with and without protection and with differing crush defence |
| Slam damage roll | Skip accuracy. Uniform 0–81, floor 75% of the roll with Protect from Melee. E `SLAM_DAMAGE`, `resolveHazards` | MODEL | Captures establish the exposed tiles and impact tick. The published maximum supports the cap. [Shatter audit](./duke-capture-analysis.md#2-damage-replay-audit) · [Standard NPC damage roll](https://oldschool.runescape.wiki/w/Successful_hit) | Repeated exposed slams with prayer on and off to test the lower bound, distribution, and rounding |
| Magic prayer mitigation and perfect-kill boundary | Floor 51% of the unprotected roll with Protect from Magic. An accurate zero invalidates the perfect kill. E `BOLT_DAMAGE`, `resolveHazards` | MODEL mitigation, UNVERIFIED accurate-zero boundary | The multiplier reaches the published protected cap of 36. An inaccurate bolt produced a block with no impact effect. [Bolt audit](./duke-capture-analysis.md#2-damage-replay-audit) | Protected intermediate damage rolls and a confirmed accurate zero in an otherwise clean kill |
| Freezing Gaze damage and cover | Uniform 65–121 on failure. Use pillar cover tiles. E `HAZARD_DAMAGE.gaze`, A `COVER_TILES` | MODEL damage range, UNVERIFIED outer cover boundary | A5:t359 includes a failed gaze for 93. Captures establish the cover check and damage ticks. [Failed gaze](./duke-capture-analysis.md#awakened-magic-and-failed-gaze-cross-check) | Failed gazes across a wider damage sample and checks at the outer cover tiles and their neighbors |
| Gas damage and face covering | Uniform 16–27 regardless of headgear. E `HAZARD_DAMAGE.vent` | MODEL lower bound, UNVERIFIED covering reductions | The unmasked cap of 27 is supported. A12:t150 and 152 deal 26 and 25. [Awakened strategy](https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies#Awakened_mode) | Controlled vent-pulse hits with each gas mask or Slayer helmet and with an uncovered face |
| Bile pool removal tick | Visible for nine ticks, damaging from placement +1 through +8. A later drip on the same tile keeps its original expiry. E `BILE_POOL_TICKS`, `dropBile` | MODEL lifetime with a known damage exception | A5:t359 hits on the removal tick, nine ticks after placement. [Damage replay audit](./duke-capture-analysis.md#2-damage-replay-audit) | Re-enter on the final two visible ticks and the removal tick. Repeat with another drip on the same tile |
| Orb contact damage | Uniform 25–27. E `resolveOrb` | MODEL | All 31 recorded nonlethal contacts fall in this range. [Orb evidence](./duke-capture-analysis.md#awakened-orb-threshold-cross-check) | More nonlethal contacts across different player HP values |

## Opener presentation

| Behavior | Current sim choice and code | Label | Evidence so far | Recording that would verify it |
|---|---|---|---|---|
| Inventory decrement and tolerance display | Feed consumes a dose and updates tolerance on the same sim tick. E `onNpcInteraction` | POLICY | A1:t7–9 removes doses, with meter updates one tick later at A1:t8–10. [Opener cross-check](./duke-capture-analysis.md#awakened-opener-and-orb-cross-check) | An opener with input timestamps and the inventory, tolerance, and NPC updates captured together |
| Sleeping NPC variant | Use NPC 12166 for sleeping Duke. C `DUKE_ASLEEP_NPC_ID` | UNVERIFIED variant selection | The cache contains two Awakened sleeping types. A1 uses 12167 and switches to 12191 when he wakes. [Opener cross-check](./duke-capture-analysis.md#awakened-opener-and-orb-cross-check) | Complete new entries with both sleeping variants and the room state before the first dose |
