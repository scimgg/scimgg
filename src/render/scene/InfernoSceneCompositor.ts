import { zukWaveState } from '../../core/encounters/snapshot';
import { type GameEvent, isCoreEvent } from '../../core/events/types';
import type { ReplayDisplayFrame } from '../../core/ReplayRecorder';
import { type ZukIntroCameraPoint, zukIntroAddTick, zukIntroCutsceneFrame } from '../../encounters/zuk/introCutscene';
import { zukTargetsPlayer } from '../../encounters/zuk/targeting';
import { ZUK_NPC_ID } from '../../npcs/inferno/constants';
import { rgbToHsl } from '../../rs/util/ColorUtil';
import { type Coordinate, type NpcSnapshot, OSRS_TICK_MS, type SimulationState } from '../../types/simulation';
import { DEFAULT_TILE_MARKER_WIDTH } from '../../types/tileMarkers';
import type { Projection2D, Viewport } from '../core/camera';
import type { RenderQueue } from '../core/commands';
import { rgbaFromHex } from '../core/types';
import { InfernoVisualController } from '../effects/controllers/InfernoVisualController';
import { isNpcStandingAt } from '../npc/npcStanding';
import { getTerrainHeightInterpolated } from '../shared/renderUtils';
import { SceneCompositor, Z_LAYERS } from './SceneCompositor';
import type { RenderContext, SceneCutsceneFrame } from './types';

const ZUK_SAFE_COLOR = '#79C99E';
const ZUK_SAFE_FILL = rgbaFromHex(ZUK_SAFE_COLOR, 0.04);
const ZUK_SAFE_BORDER = { color: rgbaFromHex(ZUK_SAFE_COLOR, 0.65), widthPx: DEFAULT_TILE_MARKER_WIDTH };
const ZUK_SAFE_HSL = rgbToHsl(Number.parseInt(ZUK_SAFE_COLOR.slice(1), 16));

function isClearMinionsEvent(
  event: GameEvent,
): event is GameEvent & { readonly type: 'inferno_clear_minions'; readonly npcTypeIds: readonly number[] } {
  return (
    event.type === 'inferno_clear_minions' &&
    Array.isArray(event.npcTypeIds) &&
    event.npcTypeIds.every((npcTypeId: unknown) => typeof npcTypeId === 'number' && Number.isInteger(npcTypeId))
  );
}

export class InfernoSceneCompositor extends SceneCompositor {
  private readonly visuals = new InfernoVisualController(this.spotAnimRenderer);
  private replayHistory: readonly ReplayDisplayFrame[] | undefined;
  private reconstructedHistory = false;

  constructor() {
    super();
    this.registerTransientReset('inferno-visual-events', () => {
      this.visuals.clear();
      this.replayHistory = undefined;
    });
  }

  /** Wave 69's intro after wave 68: its fade and scripted camera (`zukIntroCutsceneFrame`). */
  getCutsceneFrame(state: SimulationState, interpolatedTick: number): SceneCutsceneFrame | null {
    const snapshot = state.encounter;
    if (snapshot.kind !== 'inferno') return null;
    const frame = zukIntroCutsceneFrame(snapshot.visuals.zukControlTick, interpolatedTick);
    if (!frame) return null;
    if (!frame.camera) return { fadeOpacity: frame.fadeOpacity, camera: null };
    const { eye, lookAt, shake } = frame.camera;
    // OSRS heights are negative up: a point `height` above the ground is world z (height - ground) / 128.
    const point = ({ tile, height }: ZukIntroCameraPoint, offset: readonly [number, number, number]) => {
      const x = tile[0] + 0.5 + offset[0] / 128;
      const y = tile[1] + 0.5 + offset[2] / 128;
      return { x, y, z: (height + offset[1] - getTerrainHeightInterpolated(this.terrainHeights, x, y)) / 128 };
    };
    return { fadeOpacity: frame.fadeOpacity, camera: { eye: point(eye, shake), lookAt: point(lookAt, [0, 0, 0]) } };
  }

  override build(ctx: RenderContext, projection: Projection2D, viewport: Viewport): RenderQueue {
    this.reconstructedHistory = false;
    return super.build(ctx, projection, viewport);
  }

  protected override renderEncounterDebugOverlays(
    queue: RenderQueue,
    projection: Projection2D,
    simulationState: SimulationState,
    _interpolatedTick: number,
    is2D: boolean,
    _debugFlags: Record<string, boolean | number>,
  ): void {
    const zuk = zukWaveState(simulationState.encounter);
    if (simulationState.mechanicsConfig.zukShieldSafeTiles !== true || zuk === null) return;
    if (!simulationState.npcs.some((npc) => npc.archetypeId === 'zuk' && npc.alive)) return;
    if (!is2D && !this.terrainHeights) return;
    const bounds = this.getGridBounds();
    const walkable = this.getArenaWalkabilityChecker();
    if (!bounds || !walkable) return;
    if (!simulationState.npcs.some((npc) => npc.archetypeId === 'zuk_shield' && npc.alive)) return;
    const shieldNextX = zuk.shieldNextX;
    if (shieldNextX === null) return;
    const isSafe = (x: number, y: number) =>
      x >= bounds.minX &&
      x <= bounds.maxX &&
      y >= bounds.minY &&
      y <= bounds.maxY &&
      walkable(x, y) &&
      !zukTargetsPlayer(shieldNextX, [x, y]);
    const edges: [Coordinate, Coordinate][] = [];
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      for (let y = bounds.minY; y <= bounds.maxY; y++) {
        if (!isSafe(x, y)) continue;
        if (is2D) {
          const points = [
            [x, y],
            [x + 1, y],
            [x + 1, y + 1],
            [x, y + 1],
          ].map(([px, py]) => projection.tileToScreen({ x: px, y: py, level: 0 }));
          if (points.every((point) => point !== null)) {
            queue.commands.push({ kind: 'poly2d', points, fill: ZUK_SAFE_FILL, zIndex: Z_LAYERS.GRID + 1 });
          }
        } else {
          this.pushTileMesh3D(queue, x, y, ZUK_SAFE_HSL, ZUK_SAFE_FILL.a, 'zuk-safe-fill', 0.008, Z_LAYERS.GRID + 1);
        }
        if (!isSafe(x, y - 1))
          edges.push([
            [x, y],
            [x + 1, y],
          ]);
        if (!isSafe(x + 1, y))
          edges.push([
            [x + 1, y],
            [x + 1, y + 1],
          ]);
        if (!isSafe(x, y + 1))
          edges.push([
            [x, y + 1],
            [x + 1, y + 1],
          ]);
        if (!isSafe(x - 1, y))
          edges.push([
            [x, y],
            [x, y + 1],
          ]);
      }
    }
    queue.commands.push(
      ...this.createJoinedEdgeCommands(edges, is2D ? projection : null, {
        ...ZUK_SAFE_BORDER,
        hslColor: ZUK_SAFE_HSL,
        zIndex: Z_LAYERS.GRID + 2,
      }),
    );
  }

  protected override onEncounterEvents(events: GameEvent[], ctx: RenderContext): void {
    for (const event of events) {
      if (isCoreEvent(event, 'actor_despawned')) {
        this.npcInstanceManager.removePresentation(this.actorRenderIdOf(event.actorId));
      }
      if (isClearMinionsEvent(event)) this.npcInstanceManager.removePresentationsByNpcType(event.npcTypeIds);
    }
    const history = ctx.replayHistory;
    if (history) {
      // Neither a frame held for assets nor one initializing a restored presentation advances the
      // fight, so its clips' frame sounds must not play as new.
      if (ctx.restoredPresentation) this.reconstructedVisuals = true;
      if (!this.isReplayReconstructionSettled()) {
        if (this.replayHistory) this.visuals.clear();
        this.replayHistory = undefined;
        this.reconstructedVisuals = true;
        return;
      }
      const frame = {
        cycle: this.primaryCycle,
        resolveActor: this.createActorVisualPositionResolver(ctx.simulationState.playerPosition),
        terrainHeights: this.terrainHeights,
        resolveSurfaceHeight: this.resolveSurfaceHeight,
      };
      if (history.frames !== this.replayHistory || this.lastDiscontinuityReason !== null) {
        this.visuals.reconstruct(history, frame, this.replayEffectIndex);
        // Rebuilt actors restart the clock at the destination; skipped history is not replayed.
        this.npcAnimationCycle = null;
        this.reconstructedHistory = true;
        this.reconstructedVisuals = true;
      } else this.visuals.syncReplay(history, frame, this.replayEffectIndex);
    } else {
      this.visuals.consumeEvents(events);
    }
    this.replayHistory = history?.frames;
  }

  protected override syncNpcInstances(
    npcs: NpcSnapshot[],
    is2D: boolean,
    state?: SimulationState,
    paused = false,
  ): void {
    super.syncNpcInstances(npcs, is2D, state, paused);
    if (!this.reconstructedHistory || is2D || !state) return;
    const liveActorIds = new Set(npcs.filter((npc) => npc.alive).map((npc) => this.npcRenderIdOf(npc)));
    for (const npc of npcs) {
      if (npc.alive || npc.despawnTick === undefined) continue;
      const id = this.npcRenderIdOf(npc);
      this.npcInstanceManager.reconstructDyingInstance(
        { ...npc, id },
        Math.max(0, state.currentTick + this.npcInterpFraction - npc.despawnTick) * OSRS_TICK_MS,
      );
    }
    const history = this.replayEffectIndex;
    const throughFrameIndex = this.replayThroughFrameIndex;
    if (!history || throughFrameIndex === undefined) return;
    const destination = { cycle: this.primaryCycle, throughFrameIndex };
    for (const presentation of history.deathPresentations(
      destination,
      this.npcInstanceManager.getMaximumLoadedDeathDurationMs(),
    )) {
      const id = this.npcRenderIdOf(presentation.npc);
      if (liveActorIds.has(id)) continue;
      this.npcInstanceManager.reconstructDyingInstance(
        id === presentation.npc.id ? presentation.npc : { ...presentation.npc, id },
        presentation.elapsedMs,
      );
    }
  }

  private isReplayReconstructionSettled(): boolean {
    return this.encounterAssetState() !== 'pending';
  }

  protected override getNpcVisualDeltaMs(): number {
    return 0;
  }

  protected override updateEncounterNpcFacing(playerPosition: [number, number]): number {
    const cycle = ((this.latestSimulationState?.currentTick ?? 0) + this.npcInterpFraction) * 30;
    const delta = this.npcAnimationCycle === null ? 0 : Math.max(0, cycle - this.npcAnimationCycle);
    return this.npcInstanceManager.updateNpcVisualFacing(playerPosition, delta * 20) ?? 0;
  }

  protected override getEncounterAttackTriggers(
    state: Pick<SimulationState, 'currentTick' | 'npcs'>,
    interpolatedTick = state.currentTick,
  ): [] {
    const cycle = interpolatedTick * 30;
    this.startNpcAnimationClock(state.currentTick * 30);
    for (const { cue, cycle: start } of this.visuals.takeAnimations(cycle)) {
      this.advanceNpcAnimationClock(start);
      const primary = this.encounterRenderConfig?.primaryNpc;
      const npcTypeId =
        cue.actorId === primary?.actorId
          ? primary.npcTypeId
          : state.npcs.find((npc) => npc.id === cue.actorId)?.npcTypeId;
      const clips = this.encounterRenderConfig?.preloadNpcTypes?.find(
        (type) => type.npcTypeId === npcTypeId,
      )?.attackClips;
      if (clips?.[cue.clipId] === undefined) continue;
      this.npcInstanceManager.updateAnimations(0, 1, [
        {
          actorId: this.actorRenderIdOf(cue.actorId),
          trigger: 'attack',
          clipId: cue.clipId,
          tick: start / 30,
        },
      ]);
    }
    this.advanceNpcAnimationClock(cycle);
    return [];
  }

  protected override restoreEncounterPrimaries(ctx: RenderContext): boolean {
    const history = ctx.replayHistory;
    const index = this.replayEffectIndex;
    if (!history || !index) return false;
    if (history.frames !== this.replayHistory) return true;
    const cycle = this.primaryCycle;
    this.advanceNpcAnimationClock(cycle);
    for (const npc of ctx.simulationState.npcs) {
      if (!isNpcStandingAt(npc, cycle)) continue;
      const timeline = index.inferno.primaryTimeline(npc.id);
      if (!timeline) continue;
      const actorId = this.npcRenderIdOf(npc);
      if (
        this.npcInstanceManager.restoreDeferredReplayAnimation(actorId, timeline, {
          cycle,
          throughFrameIndex: history.throughFrameIndex,
          spawnTick: this.presentedFromTick(npc, ctx.simulationState),
        })
      )
        this.reconstructedVisuals = true;
    }
    return true;
  }

  /**
   * The tick an NPC's drawn life starts, which bounds the cues a seek restores. Its spawn tick, except
   * Zuk after wave 68: his spawn tick is control C (the cast clock's epoch), but the intro adds him,
   * rising, at C-8 (`zukIntroAddTick`).
   */
  private presentedFromTick(npc: NpcSnapshot, state: SimulationState): number {
    const spawnTick = npc.spawnTick ?? 0;
    const snapshot = state.encounter;
    if (npc.npcTypeId !== ZUK_NPC_ID || snapshot.kind !== 'inferno') return spawnTick;
    const controlTick = snapshot.visuals.zukControlTick;
    return controlTick !== null && spawnTick === controlTick ? zukIntroAddTick(controlTick) : spawnTick;
  }

  protected override renderEncounterAttackEffects(
    _currentTick: number,
    _interpolatedTick: number,
    playerVisualPosition: [number, number],
    _npcPosition: Coordinate,
    _npcFacingAngle: number,
    _playerFacingAngle: number,
    _mechanicsConfig: SimulationState['mechanicsConfig'],
    is2D: boolean,
  ): void {
    if (is2D) return;
    this.visuals.update(
      {
        cycle: this.primaryCycle,
        resolveActor: this.createActorVisualPositionResolver(playerVisualPosition),
        terrainHeights: this.terrainHeights,
        resolveSurfaceHeight: this.resolveSurfaceHeight,
      },
      this.replayProjectileWork,
    );
  }

  override dispose(): void {
    this.visuals.dispose();
    super.dispose();
  }
}
