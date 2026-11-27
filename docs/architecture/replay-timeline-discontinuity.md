# Replay Timeline Discontinuity

Render and audio components build transient cross-tick state assuming a contiguous forward tick
stream. Replay breaks that (scrub back, jump forward, pause, enter/exit, takeover), leaving stale
future effects or missing in-flight ones. The base `SceneCompositor` classifies every tick
transition and drives one uniform reset for every encounter.

## Classifier

[`detectTimelineDiscontinuity(prev, next)`](../../src/render/scene/timelineDiscontinuity.ts) returns
`'rewind' | 'forward-jump' | 'timeline-change' | null`:

- `timeline-change` wins, and only once a previous key existed; the first frame never resets.
- `rewind`: tick moved back. `forward-jump`: skipped more than one tick. Same tick and `tick + 1`
  return `null`, so normal playback never hitches.
- `paused` is deliberately not an input: a held frame must not reset repeatedly.

`RenderContext.timeline?: ReplayTimeline` carries `{ timelineKey, paused, timeMs? }`. The viewports
supply the replay key or `'live'`; it changes on live↔replay, engine swap (takeover) and scene
load. Surfaces without a descriptor (lobby, 2D) still get tick-based rewind/jump detection.

## Reset registry

`SceneCompositor` runs the classifier at the top of `build()`, before `getUnprocessedEvents()`, and
rewinds both the render cursor (`lastProcessedEventId`) and audio cursor
(`lastPlayedAudioEventId`) to `-1`, so the landed frame's own events are consumed again. Scene
transitions use the same registry; it is the only reset path.

Participation is registration: an encounter compositor calls
`this.registerTransientReset(name, (reason) => ...)` in its constructor after `super()` for each
piece of transient cross-tick state. An unregistered piece of transient state is the one way to get a
stale-on-seek bug. Closures receive only the `DiscontinuityReason`; reconstruction happens in the
normal per-frame update from snapshots, never inside a reset.

Base participants clear encounter visuals (including `NpcInstanceManager` death fades,
attack-trigger dedup and each instance's `NpcAnimationController`, plus `NpcVisualTracker.snap()`),
event audio and the primary NPC's death spotanim. Yama registers `yama-effects` (wave, attack,
fireball, void-flare instances), `yama-overlays` and `yama-frame-audio`; Inferno registers
`inferno-visual-events` and `inferno-frame-audio`. The Yama overlay reset exists because replay
frames share one cumulative damage log: a `DamageHistoryEntry` keeps object identity across frames,
so a reference-keyed fade set would wrongly suppress an overlay that must reappear after seeking back.

## Replay clock and transport

- Viewport interpolation reads `ReplayFrameStore.playheadMs`; never reconstruct sub-tick progress
  from wall time or reset it on pause. The 3D player still uses `PlayerVisualTracker` (turning,
  animation-blocked movement, route backlog) advanced by elapsed replay time; discontinuous seeks
  seed a snapshot pose, not the live tracker's private backlog.
- History holds lean snapshots without cumulative damage history; presentation uses the matching
  committed frame's restored damage log, including during scrub previews.
- Registered viewports acknowledge consumed ticks via the frame store. Transport waits before
  advancing past an unconsumed tick and re-anchors its wall-time origin while held (no catch-up
  burst); a multi-tick RAF gap or hidden document pauses playback. Seek/load epochs reject stale
  acknowledgments; natural completion waits for the final playhead acknowledgment. Rendererless
  surfaces bypass the gate.
- Camera playback step-holds observations: deduplicated samples do not establish a motion onset, so
  interpolating towards the next one invents movement. Cursor capture keeps a committed anchor plus a
  pending latest observation within its time/displacement budget; clicks and visibility/frame-space
  changes delimit coalescing. Capacity enforcement never thins accepted history.
- Animation clocks do not advance while `replayPaused`, so held or seeked frames hold their pose.

## Capture coverage

[`ReplayCaptureBudget`](../../src/core/ReplayCaptureBudget.ts) applies per-track entry limits and a
shared 64 MiB UTF-8 JSON budget to ancillary capture (limits and provenance types:
[`capture.ts`](../../src/replay/format/capture.ts)). Accounting updates only the appended/replaced
entry, never serializing the recording on input. Combat frames, actions, events and damage history
are outside the budget and keep recording; this is not a heap guarantee or duration limit.

An exhausted track keeps its accepted history and publishes an immutable `stoppedAtMs` with an
entry/byte-limit reason; coverage is exclusive at that timestamp. Playback hides unavailable cursor,
click, menu and held-input tracks, drops an unavailable recorded layout, and falls back to per-tick
camera snapshots after the continuous track stops. An omitted oversized marker snapshot stays empty
(never the viewer's markers). The Replay control and replay bar show capture notices.
Forking strictly before a cutoff reopens the track; at or after it does not erase the gap.
Export/load preserves provenance and cutoffs, and loading requires the capture metadata. Fresh
recordings mark the overlay snapshot `not-recorded` until a run starts with one, and every other
track `bounded-v1`.

Each recorded frame can carry the engine's `dpsProjection`, captured once at recording. Practice's Stats
and the DPS overlay consume that, never the viewer's live engine; recordings without it show no
theoretical projection.

## Recorded menus

[`replayMenu.ts`](../../src/core/replayMenu.ts) is a callback-free open/update/close log. Opens
whitelist-copy labels and two-level entries; updates carry only geometry and hover. Live capture
records main/submenu top-left positions relative to the game frame, plus scale. `ReplayFrameStore`
builds a shared-entry timeline once per menu-track identity and binary-searches it. The menu
renders passively (no listeners or focus targets); live context menus are blocked during replay.
Recorded menus suppress synthetic hover beneath them; viewer tooltips remain. Losing menu or
layout coverage hides the menu rather than showing stale state.

## Reconstruction after a seek

Reset first, then rebuild from snapshots and indexed history. Reconstruction never advances the
simulation or dispatches historical events to audio; frame-sound trackers silently synchronize
(including on late readiness). Unavailable cache assets retry on held frames without changing the
recorded origin. `ReplayEffectIndex` is the one history index: player and Yama effects, and the
encounter cues every scene's cue player restores; each is described below.

- Player tile position and effect state carried in the snapshot (e.g. Yama waves and fireballs) are
  snapshot/tick-derived.
- [`ReplayEffectIndex`](../../src/render/core/replayEffectIndex.ts) restores player projectiles,
  impacts and graphics and Yama cast/impact effects from their original event clocks, with
  historical targets from `ReplayActorHistory`. Repeated seeks use binary/lifetime-window lookups,
  not prefix scans.
- NPC despawn-timer bars (currently the Yama void flare) derive from the snapshot's
  `targetableFromTick`, `despawnTick` and `despawnTimerLeadTicks` (`npcDespawnTimerRatio`); recent
  indexed explosion/destruction events restore explosions.

**Player and Yama primaries.** `ReplayEffectIndex` also indexes player primary cues and Yama body
triggers in its single append pass; `ReplayPrimaryIndex` resolves them into accepted primaries and
binary-searches per destination. A rejected low-priority cue never becomes an origin. Player lookup
uses the event's weapon and attack kind (the owning frame's equipment as weapon fallback and for
block). Consume, block and self-cast cues keep event order and the final attack follows them,
matching the live deferred attack flush; consume restoration keeps the unarmed pose and
weapon/shield hiding. Yama shares the live trigger descriptor and NPC duration, priority and delay
rules, including its secondary melee clip. `restorePrimaryAt` restores only primary phase and
fractional client-cycle remainder; the next render updates the mesh once without advancing it
again. Timelines invalidate with animation-metadata identity.

**Encounter cues.** `ReplayRecorder.getDisplayFrames()` exposes the frame array as a readonly
state/events projection; `ReplayFrameStore` keeps that identity across playhead updates, and
`RenderContext.replayHistory` supplies it with the inclusive displayed index (future frames are
never inputs). `ReplayEffectIndex.cues` (`EncounterCueIndex`) indexes every `encounter_visual` batch
in the same append pass, and the scene's `EncounterCuePlayer` takes from it what a destination owes:
flights through their exclusive end, graphics still playing or pending, and clips not yet started,
which a restored presentation hands to live play. The scene rebuilds the cues on the first
history-backed display, a changed history identity, or a discontinuity; history-identity changes run
the full base registry before event cursors are consumed, so same-tick replacements also clear
player graphics, projectiles and overlays. Recordings in older encounter shapes are converted as
`ReplayRecorder.load` reads them, so the index only sees today's. `ProjectileFlight.updateReplay` steps only an active flight's horizon from
`ReplayActorHistory`, keeping integer-cycle state and sampling the final fractional step without
committing it, so coarse and fine presentation share one trajectory. Historical NPC positions mirror
`NpcInstanceManager` (exact tick boundary uses current position; positive fractions interpolate
previous to current); player positions follow the snapshot's previous position and path.

In a scene with cue presentation (`npcPresentation: 'cues'`, the Inferno's), each actor's
`ReplayDeferredPrimaryIndex` checkpoints accepted state plus a bounded pending tail at
source-frame boundaries. Delayed cues may start out of emission order, so sorting all cues and
taking the newest eligible would let future source frames reject earlier delayed cues; checkpoints
keep source eligibility and same-time chronological order. `restoreDeferredReplayAnimation`
restores primary and canonical base phase without updating historical meshes, excludes cues before
spawn, holds destination movement constant, and starts a walking clip at the earlier of the first
due cue or 50 client cycles after spawn. Corpses restore from their local `despawnTick` without
stepping death animations. In 3D, every encounter's replay presentation waits until each spot
animation and NPC type its render config declares has settled (`SceneCompositor.encounterAssetState`:
loaded or failed, which is not proof of usable geometry), retrying without latching; a 2D view never
waits.

**Limits.** These are canonical tick-origin reconstructions, not recordings of the render loop:
original RAF arrival offsets, free-running idle/movement phase, full player locomotion backlog and
display-rate homing are not recorded, so exact original phase and bit-identical 30/60/144 Hz
trajectories are not promised. Live playback is unaffected.

## Plugin display data

Plugins derive output from the displayed simulation, never a private recording. `GridProviders`
selects live or recorded `SimulationState` for snapshot consumers (health bars, infoboxes,
attack/tick counters). Plugins needing time or history use
[`useDisplayTimeline`](../../src/contexts/DisplayTimelineContext.tsx): `getSnapshot()` returns the
displayed `state`, absolute interpolated `tick`, `history` reference and inclusive `frameIndex`;
`subscribe()` notifies only on change. It owns no clock, RAF, event bus or serialized data. Without a
renderer, live display advances at committed tick boundaries.

- Current values from `state`; progress and animation age from `tick` (ms = `tick * OSRS_TICK_MS`).
- History-dependent output from recorded events bounded by `frameIndex`, indexed incrementally.
- Capture new observations only when existing facts cannot express them. Exact Prayer Flick Helper
  click/arrival stamps and manual Zuk timer actions are unavailable; tick-level prayer state must not
  impersonate them.

The [XP projector](../../src/components/xpDrops.ts) derives staggered births and stack offsets from
`xp_drop` events and, on seek, queries them at their original ages; grouping and rise speed stay
viewer preferences. Animated consumers subscribe imperatively and update existing DOM nodes. Do not
put per-frame clock values in the broad React context or replay events on the live `tickBus`, which
drives tutorials and other live side effects. Reset derived indexes and keyed UI when history
identity changes, even if tick numbers/event ids repeat.

A loaded recording's history must not become live-run history on ordinary exit: exit uses `startRun`
after releasing the live intro, successful Take Over keeps its validated forked prefix, and reset
clears a loaded recording unless a fresh live run already replaced it.

## Tests

[`timelineDiscontinuity.test.ts`](../../src/render/scene/__tests__/timelineDiscontinuity.test.ts)
covers the classifier and [`timelineReset.test.ts`](../../src/render/scene/__tests__/timelineReset.test.ts)
registry dispatch. A new participant needs a case that seeks past its state and asserts it cleared.
Live/replay comparisons should check the same displayed time across seek versus continuous playback,
pause, preview and history replacement, that repeated seeks do not re-read old event arrays, and
that replay navigation never advances the live engine.
