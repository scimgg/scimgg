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
- [`presentationModules.ts`](../../src/encounters/presentationModules.ts): an optional row per base
  kind, for picker art, an opening camera, an audio layer, or a scene builder of its own.
- `ENCOUNTER_RENDER_CONFIGS` ([`renderConfigs.ts`](../../src/encounters/renderConfigs.ts)):
  the one registration of each encounter's render config, keyed by its base kind. It is node-safe,
  so cache trimming and frame-sound extraction read the same map. `getEncounterRenderConfig`
  resolves a registered kind, a variant through its base kind, and adds the descriptor's map squares.
- `createSceneBuilderForKind` ([`sceneBuilderFactory.ts`](../../src/render/scene/sceneBuilderFactory.ts))
  makes every encounter scene. It rejects a kind the registry does not run (unknown, withheld or
  retired), resolves the render config unless the caller passes one, and hands it to the base
  kind's own scene builder, or else to the common `SceneCompositor`, which loads every NPC type and
  effect the config declares and holds a 3D replay frame until they settle.
- [`registry.ts`](../../src/encounters/registry.ts): owns the populated `encounterRegistry`, so
  `src/core` keeps only the `EncounterRegistry` class and never imports a concrete encounter.
- [`slugs.ts`](../../src/encounters/slugs.ts) derives routes; `registered: false` withholds an entry
  from routing.

[`encounterModules.test.ts`](../../src/encounters/__tests__/encounterModules.test.ts) pins catalog,
registry, presentation, slug and lobby agreement, audio layer order, opening cameras, and an
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

## Map footprint

The core descriptor owns an encounter's map squares. `mapSquare` is the origin square: its
south-west tile is simulation (0, 0), and a tile with y ≥ 64 is simply in the square to the north
(coordinates are translated by whole squares, never flipped). `mapSquareOffsets` lists every square
the encounter loads, relative to the origin; omitted, it is the origin alone. Each offset is an
arena square unless it is marked `sceneryOnly: true`. An authored render config never declares map
squares: `withDescriptorMapBlock` ([`encounterMapBlock.ts`](../../src/render/scene/encounterMapBlock.ts))
copies the origin and squares from the descriptor for `getEncounterRenderConfig`, whose config every
scene made by kind receives unless its caller passes one.

**The origin is the arena's south-west square.** Every arena offset has `dx >= 0` and `dy >= 0`,
and some arena square sits in the origin's column and some in its row, so the arena's tiles all
lie in `0 <= x < width`, `0 <= y < height`. Scenery-only squares may lie anywhere, the origin
included: an L-shaped arena declares its empty corner as the scenery-only origin. Any arena shape
can be declared this way, and a negative arena origin would buy nothing but origin bookkeeping in
every consumer, so `resolveEncounterMapFootprint` rejects one ("choose the arena's south-west map
square as mapSquare") and the registry test checks every descriptor.

[`resolveEncounterMapFootprint`](../../src/core/encounters/mapFootprint.ts) resolves a descriptor once
(the result keeps its identity) into the scene's squares and the arena's block of
[`mapSquareBlock.ts`](../../src/rs/map/mapSquareBlock.ts) entries:

- **Scene squares** (`sceneOffsets`), every declared square: the terrain mesh and locs (render
  config `mapSquareOffsets`), `loadMapLocs`, the cache trim ([`cacheRoots.ts`](../../scripts/cacheRoots.ts))
  and the collision bake (`CacheManager.buildArenaConfig`). A scene of several squares widens the
  loc filter's bounds to all of them; the origin alone keeps the encounter's own filter, or the
  default arena clip. The bake writes every square's static collision, and the descriptor's
  `dynamicLocs` (origin-local, so they may reach a neighbor), into one block map before it reads
  any walkable tile, so a loc on a seam blocks on both sides: a large object's far tiles, a wall's
  reciprocal flag.
- **Arena block**, the squares not marked scenery only, with their rectangle from tile (0, 0),
  `arenaTileExtent` (width and height in tiles). Grid resolves it for the displayed kind through `getEncounterMapFootprint`
  (variant kinds through their parent descriptor). It covers:
  - the minimap, which loads only the arena squares and composes them north up into one bitmap at
    4 px per tile: a 1x2 arena is 256x512, the north square at raster (0, 0) and the south at
    (0, 256). The canvas is laid out at one square's scale behind the unchanged aperture, so px per
    tile stay uniform and a taller bitmap is not squeezed; missing squares stay black. One transform
    (`minimapTerrainTransform`) places the terrain for the first render, a yaw change and every
    frame, and NPC dots use the same spacing. It rasterizes once per footprint or load, and a load
    for another footprint never paints;
  - the 2D Debug view's projection extent (`RenderViewport`'s `tileExtent`);
  - 3D picking (`Projection3D.setPickableMapSquareBlock`) and `SceneCompositor`'s hover,
    destination and true-tile indicators and 2D grid lines (render config `arenaMapSquareOffsets`).
    A tile in a hole of a sparse layout is not arena even though the rectangle contains it;
  - the actor height grid (`composeTerrainHeights`): the arena squares composed into one grid from
    tile (0, 0), each vertex taken from the square it is the south-west corner of. A lone origin
    square keeps its own grid;
  - RuneLite ground-marker interchange ([`tilePackIO.ts`](../../src/util/tilePackIO.ts)). Import
    skips an entry that is not an object with a numeric region and a whole local tile (0-63), keeps
    regions of arena squares, and adds the square's tile offset to the local coordinates. Export
    writes every marker, in region `floor(sim / 64)` from the origin on each axis, and local
    `sim - 64 * floor(sim / 64)` (0-63, even for a marker south or west of the arena); a marker
    outside the arena is exported but does not import back. For a 1x2 arena at 35_47, sim (28, 64)
    is region 9008, local (28, 0). Native marker packs and replay markers
    already hold simulation coordinates and are not rewritten.

Movement does not read the footprint: the baked walkable region and collision (`ArenaConfig`)
decide where actors stand. The player's move gate (`isValidArenaCoordinate`) follows the arena
config's bounds, or the origin square when it has none, and the pathfinder's 128-tile window is
relative to the start. Replays store simulation coordinates and take the footprint from the
encounter's metadata; nothing about it is serialized.

The Inferno loads and bakes five squares but presents one: its playable floor (x 17-45, y 17-46)
is all in 35_83, so its four neighbors are scenery only.

Known limits:

- Yama's `FireballController` clips explosion tiles to the origin square.
- The Debug view accepts a click anywhere in the arena rectangle; a hole in a sparse layout is left
  to walkability.
- Scenery-only squares are outside the actor height grid, so an encounter scene object placed there
  samples the nearest arena edge; cache locs use their own square's terrain.

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
prayers and pending hits run on. The Inferno's wave-69 intro uses both.

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
6. Add an entry to `modules.ts` and register its render config in `ENCOUNTER_RENDER_CONFIGS`. Add a
   `presentationModules.ts` row only for picker art, an opening camera, audio rules or a scene of
   its own. Then add lobby access and tutorials where applicable.
7. Test source-backed behavior, full-engine tick timing, NPC stage enrollment, reset/seed
   determinism, snapshot cloneability and manifest agreement. Give each new kind, variants included,
   a scenario in `ENCOUNTER_DYNAMIC_COVERAGE` in
   [`cache-runtime.check.ts`](../../scripts/cache-runtime.check.ts), which fails until one exists.

### Presenting it

A new encounter needs no scene code of its own to animate, fly, place and replay its effects. The
default encounter cue player, and the cue index in `ReplayEffectIndex` it restores from, consume
`encounter_visual` batches; `actor_presentations_removed` is a lifecycle instruction that drops
presentations, not a cue. An encounter's semantic events still reach their existing consumers
(audio rules, controllers), but nothing maps an arbitrary boss event to a default cue, and there is
no mapper to register: a boss that emits only its own `attack_started`-like event plays no clip in
the default scene. Build the batch at the decision point instead, with a pure local function if
that helps. The protocol is in [Visual batches](events.md#visual-batches).

1. **Emit** each visual transition that is a set of scheduled instructions as one `encounter_visual`
   batch (`emitEncounterVisual`) where the mechanic decides it, with every per-occurrence fact it
   needs (delays, targets, heights) recorded there, never recovered later from a landed frame. A
   practice command that replaces a set of NPC types emits `actor_presentations_removed`.
2. **Declare** the assets in its `renderConfig.ts`, registered in `ENCOUNTER_RENDER_CONFIGS`: each
   NPC type with keyed `attackClips` (the batch's `clipId`s) and every spot animation. The same
   declarations drive loading, replay readiness, cache trimming and frame-sound extraction
   (`npx tsx scripts/extract-frame-sounds.ts` for new clips; name new sound ids in
   `audio/soundNames.ts`).
3. **Use the default scene**: no presentation row, or one without a `sceneBuilder`. The common
   `SceneCompositor` gets the kind's resolved render config and plays the batches on one NPC clock,
   live and after any seek.
4. **Override only real presentation differences** in a scene subclass, which the row's
   `sceneBuilder` constructs and configures (`configureEncounterScene`) from the options it is
   given, render config already resolved: an opening camera or
   cutscene, overlays, a graphic's draw style (`encounterGraphicStyle`). Persistent LOC hazards are a
   snapshot plus a scene-object controller ([scene objects](scene-objects.md)); explicit event sounds
   are local `audioRules.ts` registered in `presentationModules.ts`. No history reader, seek hook,
   boss-name branch or import from another encounter. A scene presenting from its snapshot rather
   than from batches (Yama) adds only its own `createEncounterReplayReader`, `encounterNpcTriggers`
   and `restoreEncounterTimelines`.

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
