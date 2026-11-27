# Rendering

[`SceneCompositor`](../../src/render/scene/SceneCompositor.ts) orchestrates each frame and owns the
shared renderers, the NPC clock, the encounter cue player, the event cursor and the timeline-reset
registry. It is a complete encounter scene by itself; encounter compositors (`YamaSceneCompositor`,
`InfernoSceneCompositor`, `ColosseumSceneCompositor`) extend it only for their own presentation.
One that also draws from its own semantic events routes them through `onEncounterEvents()` (Yama
does; the Inferno and Sol need not). Effect controllers live in
[`src/render/effects/controllers/`](../../src/render/effects/controllers/); encounter-owned animated
LOCs go through [runtime scene objects](scene-objects.md); projectile kinematics are in
[projectile motion](projectile-motion.md).

## Frame order

`SceneCompositor.build()`:

1. **Discontinuity check** first: on a rewind, forward jump or timeline change, run the transient
   reset registry *before* any event is consumed
   ([Replay timeline discontinuity](replay-timeline-discontinuity.md)).
2. **Event ingestion**: live visuals take new events via `getUnprocessedEvents()`
   (`lastProcessedEventId`) and hand them to the cue player, controllers and `onEncounterEvents()`;
   history-backed cues come from the replay index. Event audio takes the displayed frame through
   its own `lastPlayedAudioEventId` while unpaused.
3. **NPC poses**: instances sync, NPCs turn and the NPC clock advances to the displayed cycle
   (frozen while `replayPaused`); replay restores poses and corpses.
4. **Draw**: renderers emit commands into the `RenderQueue`, sorted by optional `zIndex`; NPC meshes
   are queued only after their final pose.
5. **Frame audio** syncs to the final poses (silently on a paused or rebuilt frame).

## Spotanim playback and flight

[`spotAnimPlayback.ts`](../../src/render/effects/spotAnimPlayback.ts) is the stateless playback path
for Yama casts/impacts, player graphics, player projectile impacts and encounter cue graphics. It schedules
start and expiry in native client cycles, avoiding fractional-tick boundary drift; only the
renderer's `oneShot` request converts to game ticks. Controllers supply stable instance ids, asset
ids, original start cycles (including delays), transforms, style and height policy; the helper
returns `pending | active | unloaded | expired` and removes stale draws. Loading and retention stay
adapter-owned: Yama drops unloaded effects, player graphics/impacts retain them, the cue player
retains only future unloaded graphics. The cue player uses a zero-duration cache-length fallback
(also for history pruning); the other adapters use three ticks.

On Apple touch devices, the Sol scene enables conservative off-screen rejection for its three
ground melee puff graphics. `SpotAnimRenderer` may omit their commands only when their all-frame
bounds, placed by the normal model matrix, lie wholly outside one of the current camera's side
clip planes. Near/far planes are not tested because the shaders bias clip-space depth. Missing or
nonfinite bounds and skeletal poses keep their draws. Instances, playback, frame sounds, render
centers, events and replay data are unaffected; the view is scoped to one scene build. This is
not a density cap: wide views can keep every puff, and visible blending work is unaffected. The
prepared Shield diagnostic uses the same platform-dependent scene builder.

[`ProjectileFlight`](../../src/render/effects/ProjectileFlight.ts) owns true flight playback
(motion, re-aiming, orientation, animation looping). It does not own cast/impact lifetimes, event
scheduling, asset loading or replay-history selection.

## Transparent effect sorting

- NPCs also use depth-enabled opaque/alpha passes: opaque faces write depth and translucent faces
  read it. Their posed translucent triangles sort back-to-front in quantized camera-depth buckets,
  without face-priority interleaving. Alpha animation updates pass membership and face mappings
  before sorting. The player keeps its priority-sorted rendering policy.
- NPC type config may add `transparentDepthBiasOffset` in NDC relative to the whole-model
  `depthBias`; the resolved opaque/translucent command values survive animation, instance sync and
  death retention. Highlights still use only whole-model bias. Sol's healing totem alone opts in:
  its translucent platform glow shares planes with opaque platform faces, so strict reversed-Z
  `GREATER` can reject fragments at equal depth. Its offset is an empirical tolerance of eight D24
  window-depth steps, `8 * 2 / (2^24 - 1)` (about `9.54e-7` NDC), towards the camera. This uses the
  command bias while keeping scene depth reads, not cache face-bias data or an upstream
  generated offset. It is fixed, not device-depth-scaled, and applies to the totem's entire
  translucent command, including coplanar alpha-animated body details. Isolated production-path
  captures checked idle/attack poses, multiple pitches/distances, arena placement and foreground
  occluders on RTX 3090/D24/MSAA. One pixel still differed from a selected-face depth-disabled
  diagnostic reference; exact raster parity and other GPU/device behavior remain unverified.
- Flight instances merge the `spotAnimRenderPolicy` default (`cullFace: 'back'`,
  `requireTransparentSort: true`) beneath caller styles, for player and encounter cue projectiles alike,
  independent of graphic id. Cached spotanim models (baked and skeletal, opaque and transparent)
  default to back-face culling, matching the player, NPC, LOC and projectile policy.
  Transparent faces also back-cull in the CPU sorter; without a camera projection the unsorted
  geometry retains GPU back-face culling. Explicit style overrides take precedence over part
  overrides; `none`/`front` apply to both passes and bypass the fast path's back-face shortcut.
  Intentionally two-sided custom geometry can explicitly use `none`; procedural lobby ribbons,
  ground telegraphs and overlays keep their separate policies.
- Backfaces can mask bright front surfaces, as on Colosseum's continuous crystal rays (2689–2692).
  The shared culling default handles this with no per-graphic branch and no brightness gain, bloom,
  lighting, alpha, depth or playback adjustment; encounter-owned floor depth bias is unaffected.
- `spotAnimMeshParts` builds sorting metadata only from emitted transparent triangles (lighting
  sentinel faces converted to black), so opaque or hidden vertices cannot reject a transparent part
  at the near plane. Metadata belongs to the loaded part, so replay instance clears cannot discard it.
  Skeletal poses own fresh geometry and metadata rather than aliasing the next pose's mutable model.
- Before sorting, `SpotAnimRenderer` transforms scratch vertices with the command's real model
  matrix (pitch, continuous yaw, scale), converts back to OSRS units (`worldZ = -osrsHeight / 128`),
  supplies translation separately and uses sorter orientation zero. Depth-enabled effects use the
  sorter's depth-only branch: mixing painter-style priorities for transparent faces with depth
  writes for opaque faces flips foreground layers when animation changes a face's opacity.
- Each active effect owns reusable permutation capacity, kept across same-id, same-graphic upserts.
  Separate instances never share writable sorted output; sorted commands use a distinct GPU-cache
  identity; a missing camera projection keeps unsorted geometry rather than hiding the effect.
- `PicoGLRenderer` sorts the transparent bucket back-to-front by squared camera-to-model-origin
  distance (ties keep input order); each model's internally sorted range stays intact. Object-level
  sorting is approximate for intersecting translucent meshes and implies no contact rule (e.g. the
  Zuk shield).

Corroboration: official RuneLite (BSD-2-Clause) at `ced4c4aba7a3cb7cace42e1f0c25a5f79b7faef2`.
Cite RuneLite by its own commit, never by a simulator commit.
[`GpuPlugin.java:1297-1319`](https://github.com/runelite/runelite/blob/ced4c4aba7a3cb7cace42e1f0c25a5f79b7faef2/runelite-client/src/main/java/net/runelite/client/plugins/gpu/GpuPlugin.java#L1297-L1319)
uses priority interleaving only for `RENDERMODE_SORTED_NO_DEPTH`;
[`ModelUploader.java:262-274`](https://github.com/runelite/runelite/blob/ced4c4aba7a3cb7cace42e1f0c25a5f79b7faef2/runelite-client/src/main/java/net/runelite/client/plugins/gpu/ModelUploader.java#L262-L274)
separates opaque and alpha output even in the depth-sorted path;
[`Zone.java:496-581`](https://github.com/runelite/runelite/blob/ced4c4aba7a3cb7cace42e1f0c25a5f79b7faef2/runelite-client/src/main/java/net/runelite/client/plugins/gpu/Zone.java#L496-L581)
orders alpha model origins within zones and keeps sorted model ranges. These are behavioral
references for independent code, not a port or proof of the client's projectile render mode.

## Background suspension clock

`useSimulationWiring` suspends `animationFrames` when the document is hidden, and on visible blur
only when that setting is on; native frame requests are canceled and callbacks parked. Its
`BackgroundClock` excludes exactly those intervals (including an unfinished one). Live tick anchors,
input-arrival deadlines, prayer-flick timestamps, both viewport interpolation clocks and NPC/minimap
animation deltas use that active time, so suspension does not restart the live tick: at 1x, pausing
450 ms into a tick leaves 150 ms after resume, and a 400 ms input with 300 ms lag still belongs to
tick 2.

RAF timestamps and replay-recording arguments stay raw browser times. `ReplayRecorder` (given the
shared clock by `useReplay`) normalizes epoch-style DOM timestamps, then converts frame anchors and
ancillary events to active time, keeping pause history for delayed/coalesced native events. A
standalone recorder's clock is unsuspended. Resume resets FPS scheduling, not interpolation phase.
This is not a wall-time replacement for audio, CSS animations or media.

## GPU-resident scene geometry

Merged static LOCs and terrain are immutable for a scene's lifetime, so their draw commands
(`ResidentMesh3DCommand`) carry an `ImmutableMeshSource` and a part index instead of vertex arrays.
The scene owner (`LocRenderer`, `SceneCompositor`) owns the source's recipe and lifetime; the
renderer owns its GPU residency. `materialize()` first hands over the build made while loading and
drops it, so after the first upload no CPU copy stays reachable. Later calls rebuild the arrays from
the recipe (cache loaders, the map's placements and terrain context, settings captured at build
time), byte for byte, without reloading animated LOC frames.

`PicoGLRenderer` tracks each source by id, resident or pending (queued to upload ahead, or waiting
to retry); a different source under the same id supersedes the old one in either state. Resident
sources are exempt from the stale-frame eviction of embedded meshes. Between frames, a byte budget
releases the least recently drawn sources not drawn that frame; a scene release releases the
scene-scoped ones, and dispose and context loss release all. A released source is rebuilt on its
next draw, once for all its parts. Animated and per-frame geometry keeps embedding its arrays.

Baked opaque spotanim frames are resident too: one loader-scoped source per effect, owned by the
loader that baked it, so scene releases alone keep it. `SpotAnimRenderer` tracks the renderers
holding each shared bake through weak references. Disposing a renderer releases its holds;
collecting an undisposed renderer also makes its holds inactive. An unheld bake remains reusable
until the next new bake from that loader sweeps it and retires its source. The renderer then frees
the retired upload between frames. This releases unused effects from departed encounters without
retiring effects another live renderer still holds. Once spotanims load, the viewport queues them with
`prepareResidentSources`, which uploads load-time bakes ahead of first use, a bounded amount per
frame, and never rebuilds. A source retires when its loader clears its caches: it never uploads or
rebuilds again, and `SpotAnimRenderer` replaces the stale entry with a fresh bake before its next
read or draw. When the viewport's spotanim loader is replaced, `retireResidentSources(loader)`
releases that loader's sources.

A resident upload is published only if every nonempty part got its VAO and GL reports no error at
the end of the upload (error flags raised before it are cleared first). A failed build or upload
deletes what it created, keeps any arrays already handed over, and retries with growing waits; a
persistent failure is logged once as an error, which is what reports it. A context restore resets
pending retries.

Animated embedded meshes keep their VAO when the vertex count changes. Their buffers are rewritten
in place and only grow; draw counts follow the new arrays, so storage past them is never drawn. A
resize uploads everything a rebuild would. Layout changes (an attribute appearing or disappearing,
the program's need for normals, the index type) still rebuild the VAO. Grown storage is released
with the VAO.

## Known limitation: format-3 face depth offsets

Format-3 models (`ModelData.decodeV3`, the trailer read per RuneLite `ModelLoader.decodeType3`)
can end with a per-face depth offset block (`faceZOffsets`). The decoder does not read it, so these
models reach the face-bias path (`faceBias`, used by the LOC mesh loader) without it, and their
overlapping faces render with no per-face offset. Reading it would change the draws of the affected
models, so it is a rendering change of its own: wire it into `faceBias`,
regenerate the render goldens, and check the affected models in the 3D scene, which the tests
cannot confirm.
