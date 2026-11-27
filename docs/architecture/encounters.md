# Encounters

An encounter is one live fight. Its identity lives in
[`encounters/catalog.ts`](../../src/encounters/catalog.ts); the live object implements
[`Encounter`](../../src/core/encounters/types.ts) directly under `src/encounters/<name>/`; reusable
NPC behavior lives in definitions under [`src/npcs/`](../../src/npcs/).

- **One runtime contract.** Do not add a forwarding façade or a shared runtime base class: the hook
  names encounters share come from the engine contract, not from a lifecycle worth abstracting.
- **The encounter owns** phase coordination, spawn schedules, arena-wide hazards, outcome, seeds,
  practice commands and explicit NPC stage order. **Each NPC owns** its attack sequence, charge
  timers, ability latches and parent/child identity, on its own actor.
- Extract a focused module beside the encounter only at a distinct state owner or coherent
  algorithmic boundary, not to move orchestration lines.

## Per-tick pipeline

[`SimulationEngine.advanceTick`](../../src/core/SimulationEngine.ts) is the authority. Choose a hook
from this order; do not recreate timing by scanning pending hits or diffing state.

1. Pending encounter commands, `onTickStart` rules, then the input band (client ops in click order).
2. `resolveHazards`: tile damage against the player's end-of-last-tick position.
3. NPC band ([NPC hit queue](npc-hit-queue-and-death.md#2-per-npc-interleaved-turns)): due
   retaliation, then `prepareNpcBand`, then one whole turn per NPC in `processingOrder`: its own
   pending hits and any due death processing, its burn, poison and regen, then (if it may still
   act) `moveNpc` (default: [definition movement](npc-combat-movement.md)), `resolveNpcLocalEffects`
   and `processNpcTick`, whose attacks are committed at once. A player's freeze is written when the
   attack is cast (player band) and costs the NPC's steps from the next tick, not on impact; a death
   costs the step and the swing (unless its definition is `queued`).
4. `completeNpcBand`: encounter-wide work after every NPC's turn, before the player moves.
5. Player band: player-targeted pending hits, player timers, then item pickup, player movement and
   autoattack. An immediate player hit therefore lands after the NPC turn; a queued hit on the
   player lands before the player moves and attacks.
6. `processPostTick`: post-player-move work.
7. Defeat adjudication, pruning and event flush.

Why NPCs precede the player, with reference-engine evidence:
[NPC-before-player tick phases](movement-and-facing.md#npc-before-player-tick-phases).

An encounter that defers work must choose the hook it lands in, because the player's position and
prayer differ per stage; each encounter keeps its own effect queue. An already-launched effect may
outlive its source (void-flare detonation removes the charging NPC while its delayed impact stays
pending). Death, despawn and encounter completion are
different cancellation boundaries; do not make every effect vanish with its source.

`CombatSystem` notifies each target NPC (including supplemental targets) when a player hit is
committed; `combat.retaliation` owns the policy. Encounters must not discover attacks by scanning
`world.pendingHits`: cast-time reactions have already missed that tick's scan, and immediate hits
never enter it. See [NPC retaliation](npc-retaliation.md).

## NPC definitions and identity

An `NpcDefinition<State, Config>` pairs static behavior with typed, actor-owned state. Definitions
are registered with the encounter at construction; core consumes the collection without importing
concrete NPC modules. Damage, defeat and despawn notifications arrive at the engine's lifecycle
boundaries automatically; movement, action and local-effect stages stay explicitly ordered by the
encounter, so a disabled mechanic or boss-before-minions rule cannot vanish into a global AI loop.

Actor data holds no definitions, closures or registries. Do not replace this boundary with a core
union of boss states, untyped property bags or encounter-side state maps.

| Identity | Meaning |
|---|---|
| `id` | One live actor instance |
| `npcTypeId` | OSRS cache/model identity |
| `definition.id` | The simulation definition, paired by the factory |
| `archetypeId` | Encounter-semantic/render key (e.g. `'yama'`, `'zuk_mager'`) |
| `role` | `'boss' \| 'minion' \| 'npc'`, lifecycle/UI only |

A child NPC keeps its parent's id after its combat target changes. Shared NPC code must not import
concrete encounters; encounters supply immutable configuration, initial targets, arena constraints
and seeded randomness. Values-only variants share a definition; different rules compose explicit
behavior rather than accumulating mode flags.

## Spawning and removing actors

Never touch `world.actors` directly.

- `ctx.spawnNpc(actor)` registers the actor and seeds its movement history at the current tick;
  it throws on a duplicate id. The encounter still owns construction, id allocation,
  `spawnTick`/`despawnTick`, initial target and cooldown, and its own spawn events. One spawned
  during an NPC turn takes its own turn later that tick (it registers after everyone else); one
  spawned by `completeNpcBand` or `processPostTick` waits for the next tick. The engine seeds its
  history at the spawn tick either way.
- `ctx.despawnNpc(id)` removes the actor with no death (OSRS `del`): no `alive: false`, no
  `actor_died`, no death clip, no `onNpcDefeated`. The renderer diffs `SimulationState.npcs`, so an
  absent actor vanishes while `alive: false` plays a death animation (a queued death stands until its
  `deathAnimationTick`).

## Registration

Every other declaration is a checked projection of the catalog:

- [`modules.ts`](../../src/encounters/modules.ts): node-safe runtime manifest (factory, descriptor,
  `variantFactories`, controls, intro). It must stay free of render/UI imports: its node consumers
  would otherwise pull picogl, which needs a browser global.
- [`presentationModules.ts`](../../src/encounters/presentationModules.ts): scene builder, render
  config, opening camera, audio layer, picker art.
- [`registry.ts`](../../src/encounters/registry.ts): owns the populated `encounterRegistry`, so
  `src/core` keeps only the `EncounterRegistry` class and never imports a concrete encounter.
- [`slugs.ts`](../../src/encounters/slugs.ts) derives routes; `registered: false` withholds an entry
  from routing.

[`encounterModules.test.ts`](../../src/encounters/__tests__/encounterModules.test.ts) pins catalog,
registry, presentation, slug and lobby agreement, audio layer precedence, opening cameras, and an
import boundary: no `src/core` runtime import from `src/encounters` (the pure catalog excepted),
`src/render` or `src/components`.

### Alias kinds

Zuk is Inferno wave 69. `/zuk` and the Zuk lobby entry open `inferno` with start wave 69.

In code, `zuk` is an alias kind, listed in the Inferno's catalog entry as `retiredKinds` in
[`catalog.ts`](../../src/encounters/catalog.ts). It has no factory and is never live.
`canonicalEncounterKind` and `baseEncounterKind` resolve it to `inferno`, so saved loadouts and
mechanics, tile packs and the `encounter: 'zuk'` practice commands answer for the Inferno. The saved
stores fold any `zuk` entry into the Inferno's on load; on a shared key the `zuk` value wins.
Entering it goes through `resolveEncounterEntry` in `modules.ts`, which returns `inferno` with the
Inferno's `retiredEntries` run setup (start wave 69), saved as a setup pick would be. Once entered,
the address becomes `/inferno/`, and the saved start wave keeps a reload there at wave 69.

## Determinism and run setup

Use the shared [`mulberry32`](../../src/core/rng.ts); never hand-roll a PRNG. Persist every
randomness input through `getSeeds()` / `reset(seeds)`; an encounter may derive independent streams
per mechanic. If `reset` replaces objects that definition registrations captured, rebuild the
collection too: the engine re-reads `getNpcDefinitions()` after reset, before constructing actors.

[`simulationEngineFactory.ts`](../../src/encounters/simulationEngineFactory.ts) takes one
`EncounterSetupConfig { kind, options?, mechanics }` for fresh runs and replay reconstruction alike;
the engine applies mechanics before the loadout. Constructor options are fixed per instance; live
practice changes use `engine.setMechanicsConfig` without resetting ticks or actors.

- Each factory parses its own raw `options` record: default missing/invalid fields, ignore unknown
  ones, keep seeds out. Option types belong to the encounter, not a global union.
- Rule variants are separate kinds (`variantFactories`) whose factories close over a rule object
  (e.g. Yama contracts' `YamaContractConfig`); rule objects are never option payloads and must not
  be serialized.
- Replay bootstrap: `bootstrap.encounterConfig` holds only raw constructor options,
  `bootstrap.mechanicsConfig` the mechanics, `runConfig.encounter` the kind and seeds.
  Reconstruction resets with the recorded seeds, which override any constructor-time random choice.
  Unknown option fields are preserved.
- The engine applies the run's mechanics before it builds the world: `configureRunStart` runs, then
  `getDefaultPlayerStart(mechanics)` and `createNpcs` open that setup (the Inferno's wave 69 starts
  stages apart). A tick-zero mechanics edit calls `configureRunStart` again with an
  `EncounterRunStartContext` to swap the opening actors and start tile when the setup's stage changes.
- `createNpcs(playerStart)` and run-start setup must not derive NPC or encounter state from the
  player's start tile. Countdown start positioning commits a new start after the world is built
  ([movement and facing](movement-and-facing.md#countdown-start-positioning)); the Inferno (wave 69 included),
  Yama, Sol Heredit and the lobby all ignore it; one that did would open from inconsistent state.
- A practice restart (`planPracticeRestart`'s `startPosition`) and a plain restart
  (`planRestartStart`) may name where the new run opens (the Inferno keeps the player's tile). The
  encounter decides and validates it against the run it is planning; the engine opens there and
  records it as `bootstrap.startPosition`, so a reconstruction never re-derives it.

## Scripted player control

Two engine rules let an encounter run a cutscene without a hand-made player path:
`EncounterEngineRules.playerInputLocked` (a busy tick drops that tick's inputs, clears the attack
target and does not walk; the live loop drops the walk target clicked meanwhile) and
`EncounterContext.teleportPlayer` (a scripted placement and facing, from an NPC-band hook). Timers,
prayers and pending hits run on. The Inferno's wave-69 intro uses both. The lock is read once, at
the start of the tick.

`EncounterEngineRules.playerStunned` is the narrower stun: the player cannot walk or attack (attack
and pick-up inputs are dropped and the attack target cleared, and the live loop drops the walk
target), but prayer, food, potion and gear inputs go through. It is read at the start of the tick
and again just before the player moves, after the hazards, NPC band, player hit queue and timers,
so a stun an NPC applies in its turn blocks that same tick's walk and attack; the inputs already
run that tick stand. Zulrah's tail uses it. It is ignored while `playerInputLocked` holds.

## Practice controls

Raw HP edits synchronize phase state without spawning actors. Named phase presets rebuild their
actors, removing dead and living remnants. An adjudicated defeat cannot be revived by HP edit or
spawn command (reset instead); reviving before the defeat is adjudicated is supported.

## Adding an encounter

1. Add kind, variants, slug and availability to the catalog.
2. Implement one `Encounter` under `src/encounters/<name>/`.
3. Put NPC state, factories and behavior under `src/npcs/<family>/`; construct every defined actor
   through its factory and register the definitions with the encounter.
4. Define clone-safe `state` and `visuals` in the encounter's `snapshot.ts` and add its variant to
   [`core/encounters/snapshot.ts`](../../src/core/encounters/snapshot.ts). Custom one-shot events
   use locally typed emitters and guards.
5. Add only the projections needed: mechanics keys in
   [`types/simulation.ts`](../../src/types/simulation.ts), commands in
   [`core/encounters/commands.ts`](../../src/core/encounters/commands.ts).
6. Add one entry each to `modules.ts` and `presentationModules.ts`, then lobby access and tutorials
   where applicable.
7. Test source-backed behavior, full-engine tick timing, NPC stage enrollment, reset/seed
   determinism, snapshot cloneability and manifest agreement.

## Adding or reusing an NPC

- Import common services from core, never an encounter, its state or its config type.
- Give the definition only the handlers it needs. Registration supplies configuration and
  encounter-owned services (seeded stream, detached-impact sink). The engine validates
  definition/actor pairing at admission for initial and dynamic spawns; a mismatch fails rather
  than silently skipping lifecycle handlers.
- Call the collection's movement, tick, post-tick and local-effect stages where the encounter needs
  them, collecting returned requests; do not hand NPC code mutable encounter output arrays.
- A different target, arena or schedule is composition, not a copy of the behavior.
- Test two independent instances, seed reconstruction, and death versus despawn, without a concrete
  encounter instance. Behavior rules: [Reusable NPC behavior](npc-behaviors.md).

Mechanic sources follow the [source policy](../../AGENTS.md#mechanics-and-source-safety): another
simulator's implementation is never a source for porting.
