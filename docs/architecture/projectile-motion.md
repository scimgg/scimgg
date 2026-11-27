# Explicit-Input Projectile Motion

[`projectileMotion.ts`](../../src/render/effects/projectileMotion.ts) is a pure kinematic primitive:
no event adapters, actor-size heuristics, animation policy or projectile profiles.
[`ProjectileFlight.ts`](../../src/render/effects/ProjectileFlight.ts) wraps it in one per-flight
runtime shared by `ProjectileController` and
[`NpcProjectileFlights`](../../src/render/effects/NpcProjectileFlights.ts), which flies the
`NpcProjectileCue`s (`src/core/events/encounterVisual.ts`) that encounter visual batches carry.
It owns cycle scheduling,
incremental homing, model orientation, cache animation progress and render requests. `sample()`
advances without drawing (replay reconstruction of encounter cues); `update()` uses the same sample and gates
drawing on cache readiness. Motion starts at the first active sample, advances while the mesh is
unavailable, and never re-aims on a held cycle.

Adapters resolve actor/terrain endpoints and choose animation/render policy; neither calculates
flight kinematics or orientation. The player adapter keeps independent launch snapshots, flights,
`ProjectileAim`, scheduled impact graphics and shared asset loading. The scene's
`EncounterCuePlayer` keeps cue events, overlapping volleys, graphics, NPC clips and historical actor
resolution.

## Inputs and Lifetime Boundary

- Endpoint `worldX`/`worldY` are resolved world tile coordinates. The caller resolves actor,
  terrain, origin and tile-center choices; the module adds no footprint or half-tile offset.
- `resolvedOsrsZ` is the resolved reference height in negative-up local units, before the packet
  height; `heightOffset` is the packet's height offset in the same units. Both are required. World
  positive-up height is `(heightOffset - resolvedOsrsZ) / 128`.
- `startOffset` is packet `progress`, interpreted as local units along the initial source-to-target
  horizontal direction (a coincident target leaves the source unchanged).
- `slope` is packet `angle`, interpreted as `slope * pi/128`. Neither interpretation is proven by
  the permitted sources below.
- Creation and re-aiming require a finite, strictly positive `horizonCycles`; advancement requires
  finite nonnegative `elapsedCycles` (client cycles). Violations throw `RangeError`; this is not a
  packet parser. A paused caller supplies zero. Re-aiming takes the remaining horizon and preserves
  position and vertical velocity.

The primitive has **no start/expiry scheduler**: it does not clamp time, despawn, linger, derive a
hit tick or substitute a duration, and past its horizon it simply extrapolates. The flight runtime
samples only `[startCycle, endCycleExclusive)`.

**Arrival convention.** Packet `endtime` is the continuous-time arrival timestamp; a flight renders
over `[startCycle, endCycle)`, reaches the endpoint at `endCycle`, and emits no mesh at or after it.
This matches the impact delay observed for Zuk's player-targeted fireball
(`inferno-waves-69-zuk-packet-data.txt:17980–17988`) and Tumeken's shadow
(`colosseum-no-sol-packet-data.txt:366–370`), and RSMod `fa13b3f` `ProjAnim.kt:30–37` and
`PlayerAttackManager.kt:1614–1616`. Using `endCycle + 1` would delay arrival one cycle while those
impacts stay put. These sources fix the arrival-effect timestamp, not whether the native client
draws on the integer cycle equal to `endCycle` or its within-cycle update/draw phase. RuneLite's
[`Projectile.java:153-175`](https://github.com/runelite/runelite/blob/ced4c4aba7a3cb7cace42e1f0c25a5f79b7faef2/runelite-api/src/main/java/net/runelite/api/Projectile.java#L153-L175)
(BSD-2-Clause, `ced4c4ab`) defines `endCycle` as target arrival with automatic despawn after it; it
does not establish the draw predicate either.

Player flights use `calculateProjectileEndTime` with the same weapon timing profile and footprint
distance as combat. They neither stretch short flights to 30 cycles nor derive an endpoint from the
rounded `hitDelayFromEndTime` tick. Impact graphics keep their arrival timestamp independently of
mesh readiness (a missing projectile asset cannot delay an impact); new attacks replace no existing
flight or impact; simulation damage timing is unaffected.

Animation: player flights loop the whole sequence (flight duration for an unanimated entry), with
sequence height offset and zIndex 68. Inferno loops the cache `frameStep` tail after the initial
sequence (zero progress without animation), with actor height mode.

## Scene surface references

`SceneCompositor` owns a [`SceneSurfaceHeightResolver`](../../src/render/scene/SceneSurfaceHeightResolver.ts)
and a stable `(worldX, worldY) => number` callback shared by player flights and Inferno live/replay
reconstruction. Both endpoints sample their resolved XY point; actor size picks the visual center and
does not average terrain under the footprint. Moving targets resample at their current visual center
without changing the homing integration.

- Sampling uses the classic scene tile's triangles (same shape/rotation geometry as terrain build),
  falling back to bilinear height interpolation where no surface exists. Each rendered map square
  keeps padded terrain context with all raw cache planes; neighbor-only squares supply borders but
  are not registered surfaces. Bridge flags remap the requested scene plane (default 0) to its raw
  plane; the top slot cleared by bridge linking uses only raw-plane-3 terrain fallback.
- Effective type-22 ground decorations contribute their base `LocType.raise` (opcode 96), not a
  morph's, registered with the same LOC exclusions, filters and replacements as scenery rendering.
  The resolver subtracts the raise from the negative-up height; packet heights are applied
  separately by `projectileEndpoint`.
- LOCs and terrain may load in either order; smooth-terrain rebuilds keep ground raises; replay and
  transient resets keep this static data; permanent disposal clears it. The player controller's
  callback is rebound each 3D build. Before terrain contexts exist, and in standalone controllers,
  the point-based bilinear sampler over `terrainHeights` is used. A resolved zero is a valid height.

Only flight references use this. Player impact graphics keep footprint/model-height anchors; encounter
cue graphics keep point-terrain anchors. Dynamic injected tile meshes and nested moving worldviews are
not modeled; flat terrain with zero raise yields the bare terrain height.

## Mathematical model

This is our model, not a verified client implementation or bit-exact emulator. After the initial
offset, horizontal velocity is displacement over horizon `T`; initial vertical velocity (world
positive-up) is horizontal speed × `tan(slope * pi/128)`; acceleration `a` solves
`zt = z + vz*T + a*T*T/2`. Advance with constant-acceleration equations. Re-aiming solves a new
boundary-value problem from the current position and vertical velocity, never redrawing from the
source. Direction is continuous yaw (east towards north) and pitch (positive up), in radians.

The runtime converts to `SpotAnimRenderer`'s model frame: projectile heads point along model **-Z**,
so yaw is `atan2(vx, vy) + pi` in 2048 units and model pitch is the negated pitch. This conversion is
projectile-only.

## Evidence

- The blowpipe uses weapon-specific launch heights and muzzle offset, not thrown-dart defaults: the
  healer-targeted dragon dart at
  `inferno-waves-69-zuk-packet-data.txt:18827`
  has heights 142/146 and progress 105, as does an earlier-wave shot at
  `inferno-waves-1-68-packet-data.txt:35441`.
  Ammo still selects the mesh.
- RuneLite [`Projectile.java:98-105`](https://github.com/runelite/runelite/blob/ced4c4aba7a3cb7cace42e1f0c25a5f79b7faef2/runelite-api/src/main/java/net/runelite/api/Projectile.java#L98-L105)
  documents refreshing an actor target point each frame: target refresh, not integration arithmetic.
- RuneLite `runelite-api/.../api/Perspective.java:58-59`: 128 local units per tile. `Constants.java:124,132`:
  20 ms client cycles, 600 ms ticks (30 cycles).
- **Unproven by permitted sources:** the slope unit and `tan(slope*pi/128)`; the units and
  projection of `progress`; whether velocity and acceleration are recomputed per cycle; whether the
  client interpolates between 20 ms cycles. Do not assert these as client behavior; fractional
  sampling describes our renderer only.
- `zuk-atlatl-dragon-hunter-wand-packet-data.txt:202-216`:
  tick 708 emits 448/449/450 with start/end 2/26, 6/30, 10/36; angle 16, progress 32, heights
  512/124, source (2271,5351), target (2271,5348). Actor spotanim 157 has delay 26 but **omits
  height**; no default is inferred.
- `inferno-waves-69-zuk-packet-data.txt:3107-3109`:
  1375 has start/end 50/126, angle 0, progress 64, heights 390/124, source (2271,5367), target
  (2284,5361).
- Lines 3820-3825 of `inferno-waves-69-zuk-packet-data.txt`: two 1377 packets, start/end
  60/94, angle 16, progress 0, heights 256/124, sources (2276,5354) and (2278,5352), target
  (2280,5358). These define no generative muzzle-placement rule.
- Lines 18164-18172 of `inferno-waves-69-zuk-packet-data.txt`: three 660 packets,
  start/end 0/90, progress 0, heights 70/0, source (2280,5363), angles 41/41/47, targets
  (2280,5358), (2279,5356), (2275,5356). No target RNG is inferred.

Capture-input tests supply `endtime - starttime` as horizons (Jad 24/24/26, blast 76, ranger 34,
sparks 90) over synthetic flat terrain; they check our mathematical solution, not observed client
positions. Expectations are evaluated from the boundary equations (e.g. halfway height
`3*z0/4 + zt/4 + distance*tan(angle)/4`), not snapshotted output.
