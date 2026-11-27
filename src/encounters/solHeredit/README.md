# Sol Heredit

The final wave of the Fortis Colosseum, registered as `sol_heredit` and routed at `/sol-heredit`.

**Status: playable; several mechanics are fitted or unverified.** The manifest in [`src/encounters/modules.ts`](../modules.ts) sets
`isWorkInProgress: true`. Many rules are fitted models or simulator policy rather than recovered game
rules, and the in-world presentation has only been checked by the automated simulation and renderer
tests. The practice setup defaults to Blasphemy III.

## Evidence

- [Facts spec](../../../docs/encounters/sol-heredit-facts-spec.md): the
  [capture inventory](../../../docs/encounters/sol-heredit-facts-spec.md#captures) (aliases K, M, N,
  L, A, B and C) and the
  [timing verification ledger](../../../docs/encounters/sol-heredit-facts-spec.md#timing-verification-ledger),
  with each rule's value, sample count and status.
- [Capture analysis](../../../docs/encounters/sol-heredit-capture-analysis.md): the derivations
  behind the tile sets, beam timing, pursuit and special selection.
- [Unverified behavior register](../../../docs/encounters/sol-heredit-unverified.md): every model,
  policy and known omission, with the recording that would verify it.

The tests read facts extracted into `__tests__/fixtures/`, not the captures themselves. The
ground-attack and pursuit tests (`captureConformance.test.ts`, `pursuit.test.ts`) use extracts from
K, M and N. The beam tests (`beamTimeline.test.ts`) use K, M, N, L and A. They take the recorded
inputs (Sol's attack ticks, crystal spawn tiles, NPC order and fitted ready-delay rolls) as given and
omit the known death-tick charge. Passing replay tests therefore do not show that the autonomous timing
is correct.

## Practice controls

These are practice aids, not modeled game behavior.

- **Sol Attacks** off stops his own attacks. Switching it off mid-fight cancels any attack in
  flight: a telegraph, triple or grapple already shown finishes visually but deals no damage.
- **Attack Style** (a setup choice) pins regular attacks to spear or shield, read at each launch.
  The seeded style roll is still drawn and variant alternation is unchanged. The pin also overrides
  the forced spear that opens the fight and follows each transition.
- **Light Beams** off cancels the current beam round and stops new crystals spawning. With Sol Attacks
  off and Light Beams on, ready beams warn without an attack telegraph.
- **Molten Sand** off hides the sand rather than skipping it. Strikes still roll and form, so the
  seeded stream is unchanged, but no bolt is shown, nothing burns and the snapshot lists no pools.
  Switched back on, every pool formed meanwhile shows and burns.
- **Attack Telegraphs** outlines where his next attack will land.
- **Trigger grapple** and **Trigger triple attack** queue a special for his next ready, in-reach
  attack slot. It launches through the same path as a rolled special, so it never overlaps an attack
  in flight. It launches at any HP, even with Sol Attacks off. With Sol Attacks on, a pending forced
  spear still goes first. Repeating a command replaces the queued special.
- **Add beam crystal**, **Strike molten sand** and **Clear molten sand** act immediately.
- **Boss HP presets** (Start, 90%, 75%, 50%, 10%) set his HP. Setting it into enrage starts the
  sand drip with the same first-single delay roll as a natural enrage. Leaving enrage stops it, and
  re-entering re-arms it. A preset also clears Totemic's totem and re-arms its half-HP trigger.

## Code map

| Owner | Holds |
| --- | --- |
| `constants.ts` | arena, transition schedule, sand and beam-round timing, Sol's modifier constants |
| `phases.ts` | the five HP transitions and enrage, taunt text |
| `moltenSand.ts` | sunfire strikes and the pools they leave |
| `beams.ts` | beam rounds: readiness, warning, charge, fire and hit |
| `modifierEffects.ts` | Sol's composition of the shared modifiers: Bees, Quartet, Totemic, Solarflare and Volatility scheduling and cleanup |
| `modifiers.ts` | the offered modifiers and setup notes |
| `controls.ts`, `commands.ts` | practice toggles, HP presets and commands |
| `arenaBoundary.ts` | the arena-fence LOCs, which also feed collision |
| `SolHereditEncounter.ts` | wires the above to the `Encounter` contract |
| `SolHereditSceneObjectController.ts`, `renderConfig.ts` | pool and fence LOCs; NPC clips and render settings |
| [`src/npcs/colosseum/`](../../npcs/colosseum/) | Sol (`sol.ts`), his attack scheduler and special selection (`attackScheduler.ts`), tile sets and aim (`solAttacks.ts`), grapple, beam crystals, the Fremennik warband, and their constants |
| [`../colosseum/modifiers/`](../colosseum/modifiers/) | the shared Colosseum modifiers: rules (Doom, Blasphemy, Frailty, Myopia), Bees, Totemic, Solarflare and its route runner, Volatility |
| `src/core` | shared behavior: `pursuePlayer` routing, `npcStickyPursuit.ts` (warband), `combat/npcRegeneration.ts` |
| `src/audio/solHereditAudioRules.ts` | sand, beam warning and beam impact sounds |
| `src/render/scene/ColosseumSceneCompositor.ts` | Sol-specific graphic styles, batching and tile overlays; shared cue playback is in `EncounterCuePlayer` |

Telegraph geometry, asset identities and sampled timings are capture-backed. Per-tile variants, pool
rotations and sub-tick presentation are modeled; the register's
[presentation rows](../../../docs/encounters/sol-heredit-unverified.md#presentation--chat) list them.
Sol's eager-prayer failure emits a chat message; the Solarflare prayer drop does not.

The modifier icons (`public/assets/encounters/modifier-*.png`) are not committed: `npm run setup`
draws each from one cache sprite, as listed in
[`scripts/assets/sprite-manifest.json`](../../../scripts/assets/sprite-manifest.json). The warbander
and totem clip sounds are rendered from cache sound data by the
[runtime synth](../../../docs/architecture/audio-synth.md). Sol's arena entrance (`10876`/`10877`) is
not wired: the simulation starts with him already in the arena.

## Not simulated

Varied crystal spawn tiles (each edge has one fixed spawn, including the first crystal's), the
Volatility III sand pool, Volatility on the Quartet warbander's death, the grapple's item strip on
failure, modifier audio, and Colosseum waves 1–11.
