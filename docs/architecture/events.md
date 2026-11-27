# Events

Events are the semantic bridge from simulation to render/audio: the simulation says *what*
happened (`attackKind: 'magic_fire'`), never a cache or asset id; the renderer decides how it looks.

- `GameEvent = CoreGameEvent | EncounterGameEvent`
  ([`src/core/events/types.ts`](../../src/core/events/types.ts)). `CoreGameEvent` is a closed
  union; `EncounterGameEvent` (`{ eventId, tick, type: string, [key: string]: unknown }`) is how
  encounters emit their own (`fireball_spawned`, `wave_activated`, `zuk_healer_cast`, ...).
- Because of that index signature, narrow to a core variant with the `isCoreEvent` guard, not a
  bare `event.type === '...'` check.
- [`TickEvents`](../../src/core/events/TickEvents.ts): callers `emit` an `EmittableGameEvent<T>`
  (no `eventId`/`tick`); `emit` stamps the tick from `setTick` and a monotonically increasing
  `eventId`; the engine `flush()`es the buffer each tick.
- Several payload fields exist for reasons their names do not carry:
  `hit_applied.targetPosition` drives positional audio attenuation; `xp_drop.predictedHit` is
  emitted on the attack tick so the XP drop overlay can show a hit before a delayed hit lands.
  Read the union.

## Visual batches

Semantic events are the normal API. The narrow exception is a transition that *is* a set of
explicitly scheduled visual instructions, such as a volley with per-occurrence delays, landing tiles
and heights: the encounter emits one `encounter_visual` batch
([`src/core/events/encounterVisual.ts`](../../src/core/events/encounterVisual.ts)) of keyed NPC
clips, NPC projectiles and one-shot graphics. Never also map a semantic event to the same effect.
Each cue's identity is its batch's `eventId`, its family and its ordinal, so batch boundaries and
order are part of the wire contract. A graphic stands on a tile's center, on a tracked actor's
rendered center (its recorded position while the actor is not rendered), or rides an `attached`
actor's rendered model, hidden while the actor is absent. The scene's `EncounterCuePlayer` plays
batches live and restores them in replay from `ReplayEffectIndex`, in every scene, the common one
included: an encounter emits the batch and declares the clips and effects it names in its render
config, and needs no scene code to play it ([presenting an encounter](encounters.md#presenting-it)).

`actor_presentations_removed` drops every drawn presentation of the listed NPC types, corpses
included, before the frame's actors are synced (a practice command replacing a set). Plain
`actor_despawned` is not equivalent: a corpse the simulation already pruned may still be shown.

Recordings from older builds are converted as `ReplayRecorder.load` reads them
([`legacyReplayEvents.ts`](../../src/core/legacyReplayEvents.ts)): `inferno_visual` and Sol
Heredit's `colosseum_visual` become `encounter_visual` and `inferno_clear_minions` becomes
`actor_presentations_removed`, with ids, ticks, frames and parameters kept. A `colosseum_visual`
graphic's `position` is a tile target and its `actorId` an `attached` one; a missing height is 0 and
missing projectiles are none. A malformed recognized event fails the load before anything is
installed.

## Consumption

`SceneCompositor.build()` filters events through `getUnprocessedEvents()` (by
`lastProcessedEventId`) and forwards the new ones to controllers, `onEncounterEvents()` and
`EventAudioPlayer`. The cursor makes a one-shot effect fire once however many frames render the
same tick. A replay discontinuity rewinds the cursor so the landed frame's own events are consumed
again ([Replay timeline discontinuity](replay-timeline-discontinuity.md)).

The tick an event is *delivered* on can matter beyond its `tick` field: `EventAudioPlayer` measures
`delayCycles` from the flush the event arrives on (example: Yama's fireball barrage in
[the sound-ID audit](audio-sound-ids.md#the-fireball-barrages-delays-are-measured-from-the-sets-start-tick)).
