import { isSolHereditSnapshot } from '../../core/encounters/snapshot';
import { type GameEvent, isCoreEvent } from '../../core/events/types';
import { COLOSSEUM_SPOTANIMS } from '../../npcs/colosseum/constants';
import { rgbToHsl } from '../../rs/util/ColorUtil';
import type { Coordinate, SimulationState } from '../../types/simulation';
import { DEFAULT_TILE_MARKER_WIDTH } from '../../types/tileMarkers';
import type { Camera3D, Projection2D, Viewport } from '../core/camera';
import type { RenderQueue } from '../core/commands';
import { rgbaFromHex } from '../core/types';
import { ColosseumVisualController } from '../effects/controllers/ColosseumVisualController';
import type { SpotAnimTransform } from '../effects/spotAnimTypes';
import { isNpcStandingAt } from '../npc/npcStanding';
import { getTerrainHeightInterpolated } from '../shared/renderUtils';
import { PLAYER_ACTOR_ID, SceneCompositor, Z_LAYERS } from './SceneCompositor';
import type { RenderContext } from './types';

/**
 * Sol Heredit's scene: his telegraph animations and the cache ground effects those telegraphs
 * paint, plus the warband's projectiles. Sol's attacks ARE their telegraphs, so the real cache
 * effects are the warning.
 *
 * Tile overlays: sand and beam tiles are painted only in the 2D view, which has no pool LOCs or beam
 * spotanims to show them. The pending-attack outline is the `solHereditTelegraph` practice aid.
 * The `beamDamageTiles` debug flag paints a fired round's tiles on its fire tick, in both views: the
 * tick that tests the tile the player started on. The hit itself lands one tick later.
 */
const DANGER_COLOR = '#E8543F';
const DANGER_FILL = rgbaFromHex(DANGER_COLOR, 0.14);
const DANGER_HSL = rgbToHsl(Number.parseInt(DANGER_COLOR.slice(1), 16));
const DANGER_BORDER = { color: rgbaFromHex(DANGER_COLOR, 0.7), widthPx: DEFAULT_TILE_MARKER_WIDTH };

const BEAM_COLOR = '#F2C14E';
const BEAM_FILL = rgbaFromHex(BEAM_COLOR, 0.16);
const BEAM_HSL = rgbToHsl(Number.parseInt(BEAM_COLOR.slice(1), 16));

/** Debug overlay: the beam tiles on their fire tick, when the player's starting tile is tested. */
const BEAM_DAMAGE_COLOR = '#FF2EC4';
const BEAM_DAMAGE_FILL = rgbaFromHex(BEAM_DAMAGE_COLOR, 0.4);
const BEAM_DAMAGE_HSL = rgbToHsl(Number.parseInt(BEAM_DAMAGE_COLOR.slice(1), 16));

const SAND_COLOR = '#C4622D';
const SAND_FILL = rgbaFromHex(SAND_COLOR, 0.22);
const SAND_HSL = rgbToHsl(Number.parseInt(SAND_COLOR.slice(1), 16));

const tileKey = (tile: Readonly<Coordinate>): string => `${tile[0]},${tile[1]}`;

export interface ColosseumSceneOptions {
  /**
   * Leave Sol's melee puffs out of the frames whose camera provably cannot see them. Their timelines,
   * sounds and every visible puff are unchanged; what goes is GPU submissions nobody can see.
   */
  readonly cullSolMeleeOutsideView?: boolean;
  /**
   * Let the renderer draw runs of Sol's melee puffs, and of his crystals' beams, as single instanced
   * draws, each family while its atlas fits the renderer's allowance (the beams' does not: they draw
   * singly). Every draw is made as before, in the same order; what changes is how many are submitted.
   */
  readonly batchSolEffects?: boolean;
  /**
   * Leave out the beam parts whose every triangle has zero area: they rasterize nothing, so the
   * frame is the same with fewer draws. Every visible part, timing and sound is unchanged.
   */
  readonly skipZeroAreaBeamParts?: boolean;
}

/** Sol's crystal beams: the charge and fire lines and their impact, one batchable family. */
const SOL_BEAM_SPOTANIMS: readonly number[] = [
  ...COLOSSEUM_SPOTANIMS.crystalCharge,
  ...COLOSSEUM_SPOTANIMS.crystalFire,
  COLOSSEUM_SPOTANIMS.crystalImpact,
];

/** The 3D viewport hands `build` the `Projection3D` it then renders with; 2D projections are not cameras. */
function isCamera3D(projection: Projection2D): projection is Projection2D & Camera3D {
  const candidate = projection as Partial<Camera3D>;
  return typeof candidate.viewMatrix === 'function' && typeof candidate.projectionMatrix === 'function';
}

export class ColosseumSceneCompositor extends SceneCompositor {
  private readonly visuals = new ColosseumVisualController(this.spotAnimRenderer);
  /** The player's rendered tile, for effects on the player; spotanim transforms resolve after it is set. */
  private playerVisualPosition: Readonly<Coordinate> | null = null;

  private readonly cullSolMeleeOutsideView: boolean;

  constructor(options: ColosseumSceneOptions = {}) {
    super();
    this.cullSolMeleeOutsideView = options.cullSolMeleeOutsideView === true;
    // Melee first: the families are admitted in this order against one allowance.
    if (options.batchSolEffects === true)
      this.spotAnimRenderer.setBatchableSpotAnimFamilies([COLOSSEUM_SPOTANIMS.solMelee, SOL_BEAM_SPOTANIMS]);
    if (options.skipZeroAreaBeamParts === true) this.spotAnimRenderer.setZeroAreaPartSkip(SOL_BEAM_SPOTANIMS);
    this.registerTransientReset('colosseum-visuals', () => this.visuals.clear());
  }

  override build(ctx: RenderContext, projection: Projection2D, viewport: Viewport): RenderQueue {
    // `build` reads the camera as is and the viewport draws with it unchanged, so this frame's view
    // is the GPU's. It is dropped again afterwards: no camera outlives the frame it was built for.
    const cull = this.cullSolMeleeOutsideView && ctx.options.renderMode === '3d' && isCamera3D(projection);
    this.spotAnimRenderer.setViewRejection(cull ? projection : null);
    try {
      return super.build(ctx, projection, viewport);
    } finally {
      this.spotAnimRenderer.setViewRejection(null);
    }
  }

  protected override getNpcVisualDeltaMs(): number {
    return 0;
  }

  protected override updateEncounterNpcFacing(playerPosition: Coordinate): number {
    const elapsed = Math.max(0, this.primaryCycle - (this.npcAnimationCycle ?? this.primaryCycle));
    return this.npcInstanceManager.updateNpcVisualFacing(playerPosition, elapsed * 20) ?? 0;
  }

  protected override onEncounterEvents(events: GameEvent[], context: RenderContext): void {
    if (!context.replayHistory) this.visuals.consume(events);
    for (const event of events) {
      if (isCoreEvent(event, 'actor_despawned')) {
        this.visuals.removeActor(event.actorId);
        this.npcInstanceManager.removePresentation(this.actorRenderIdOf(event.actorId));
      }
    }
  }

  protected override reconstructEncounterVisuals(context: RenderContext): void {
    if (!context.replayHistory) return;
    this.visuals.syncReplay(context.replayHistory, this.primaryCycle);
    this.visuals.render(this.primaryCycle, this.terrainHeights, (actorId) =>
      this.resolveGraphicActor(actorId, context.simulationState),
    );
  }

  protected override restoreEncounterPrimaries(context: RenderContext): boolean {
    const history = context.replayHistory;
    if (!history) return false;
    const timelines = this.visuals.syncReplay(history, this.primaryCycle);
    this.advanceNpcAnimationClock(this.primaryCycle);
    for (const npc of context.simulationState.npcs) {
      const actorId = this.npcRenderIdOf(npc);
      if (!isNpcStandingAt(npc, this.primaryCycle)) {
        if (npc.despawnTick !== undefined)
          this.npcInstanceManager.reconstructDyingInstance(
            { ...npc, id: actorId },
            Math.max(0, this.primaryCycle / 30 - npc.despawnTick) * 600,
          );
        continue;
      }
      const timeline = timelines.get(npc.id);
      if (!timeline) continue;
      if (
        this.npcInstanceManager.restoreDeferredReplayAnimation(actorId, timeline, {
          cycle: this.primaryCycle,
          throughFrameIndex: history.throughFrameIndex,
          spawnTick: npc.spawnTick ?? 0,
        })
      )
        this.reconstructedVisuals = true;
    }
    return true;
  }

  /**
   * Plays each cue's clip at the cycle it was scheduled for, then burns the ground effects.
   *
   * The per-tile start cycles carry Sol's two-cycles-per-ring ripple, which is what makes the
   * shape of an attack readable as it spreads outward.
   */
  protected override getEncounterAttackTriggers(
    state: Pick<SimulationState, 'currentTick' | 'npcs'>,
    interpolatedTick = state.currentTick,
  ): [] {
    const cycle = interpolatedTick * 30;
    this.startNpcAnimationClock(state.currentTick * 30);
    const primary = this.encounterRenderConfig?.primaryNpc;
    for (const entry of this.visuals.takeAnimations(cycle)) {
      // A member killed this tick may still swing (B:3356): it stands until its death animation.
      if (!state.npcs.some((npc) => npc.id === entry.cue.actorId && isNpcStandingAt(npc, entry.cycle))) continue;
      const npcTypeId =
        entry.cue.actorId === primary?.actorId
          ? primary.npcTypeId
          : state.npcs.find((npc) => npc.id === entry.cue.actorId)?.npcTypeId;
      const clips = this.encounterRenderConfig?.preloadNpcTypes?.find(
        (type) => type.npcTypeId === npcTypeId,
      )?.attackClips;
      if (clips?.[entry.cue.clipId] === undefined) continue;
      this.advanceNpcAnimationClock(entry.cycle);
      this.npcInstanceManager.updateAnimations(0, 1, [
        {
          actorId: this.actorRenderIdOf(entry.cue.actorId),
          trigger: 'attack',
          clipId: entry.cue.clipId,
          tick: entry.cycle / 30,
        },
      ]);
    }
    this.advanceNpcAnimationClock(cycle);
    this.visuals.render(cycle, this.terrainHeights, (actorId) => this.resolveGraphicActor(actorId, state));
    return [];
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
    this.playerVisualPosition = [...playerVisualPosition];
    if (is2D) return;
    const throughFrameIndex = this.replayThroughFrameIndex;
    this.visuals.updateProjectiles(
      {
        cycle: this.primaryCycle,
        resolveActor: this.createActorVisualPositionResolver(playerVisualPosition),
        terrainHeights: this.terrainHeights,
        resolveSurfaceHeight: this.resolveSurfaceHeight,
      },
      throughFrameIndex === undefined
        ? undefined
        : this.replayEffectIndex?.actors.sampler({ cycle: this.primaryCycle, throughFrameIndex }, 'snapshot'),
      this.replayProjectileWork,
    );
  }

  private resolveGraphicActor(actorId: string, state: Pick<SimulationState, 'npcs'>): SpotAnimTransform | null {
    if (actorId === PLAYER_ACTOR_ID) {
      if (!this.playerVisualPosition) return null;
      const x = this.playerVisualPosition[0] + 0.5;
      const y = this.playerVisualPosition[1] + 0.5;
      return { position: [x, y, -getTerrainHeightInterpolated(this.terrainHeights, x, y) / 128] };
    }
    if (!state.npcs.some((npc) => npc.id === actorId && isNpcStandingAt(npc, this.primaryCycle))) return null;
    const matrix = this.npcInstanceManager.getModelMatrix(this.actorRenderIdOf(actorId));
    return matrix
      ? {
          position: [matrix[12], matrix[13], matrix[14]],
          yaw2048: (Math.atan2(matrix[8], matrix[0]) * 2048) / (2 * Math.PI),
        }
      : null;
  }

  protected override renderEncounterDebugOverlays(
    queue: RenderQueue,
    projection: Projection2D,
    simulationState: SimulationState,
    _interpolatedTick: number,
    is2D: boolean,
    debugFlags: Record<string, boolean | number>,
  ): void {
    if (!isSolHereditSnapshot(simulationState.encounter)) return;
    if (!is2D && !this.terrainHeights) return;
    const { sandTiles, beamTiles, beamFiredTiles, dangerTiles } = simulationState.encounter.state;
    // Painted coldest first so an imminent attack reads over the standing hazards beneath it.
    if (is2D) {
      this.paintTiles(queue, projection, is2D, sandTiles, SAND_FILL, SAND_HSL, 'sol-sand', 0.006);
      this.paintTiles(queue, projection, is2D, beamTiles, BEAM_FILL, BEAM_HSL, 'sol-beam', 0.008);
    }
    if (debugFlags?.beamDamageTiles) {
      const fill = BEAM_DAMAGE_FILL;
      this.paintTiles(queue, projection, is2D, beamFiredTiles, fill, BEAM_DAMAGE_HSL, 'sol-beam-damage', 0.012);
    }
    if (simulationState.mechanicsConfig.solHereditTelegraph !== true) return;
    this.paintTiles(queue, projection, is2D, dangerTiles, DANGER_FILL, DANGER_HSL, 'sol-danger', 0.01);
    if (dangerTiles.length > 0) this.outlineTiles(queue, projection, is2D, dangerTiles);
  }

  private paintTiles(
    queue: RenderQueue,
    projection: Projection2D,
    is2D: boolean,
    tiles: readonly Readonly<Coordinate>[],
    fill: ReturnType<typeof rgbaFromHex>,
    hsl: number,
    meshKey: string,
    lift: number,
  ): void {
    for (const [x, y] of tiles) {
      if (is2D) {
        const points = [
          [x, y],
          [x + 1, y],
          [x + 1, y + 1],
          [x, y + 1],
        ].map(([px, py]) => projection.tileToScreen({ x: px, y: py, level: 0 }));
        if (points.every((point) => point !== null)) {
          queue.commands.push({ kind: 'poly2d', points, fill, zIndex: Z_LAYERS.GRID + 1 });
        }
      } else {
        this.pushTileMesh3D(queue, x, y, hsl, fill.a, meshKey, lift, Z_LAYERS.GRID + 1);
      }
    }
  }

  /** Outlines only the outer boundary of the danger set, so interior tile seams stay quiet. */
  private outlineTiles(
    queue: RenderQueue,
    projection: Projection2D,
    is2D: boolean,
    tiles: readonly Readonly<Coordinate>[],
  ): void {
    const covered = new Set(tiles.map(tileKey));
    const edges: [Coordinate, Coordinate][] = [];
    for (const [x, y] of tiles) {
      if (!covered.has(tileKey([x, y - 1])))
        edges.push([
          [x, y],
          [x + 1, y],
        ]);
      if (!covered.has(tileKey([x, y + 1])))
        edges.push([
          [x, y + 1],
          [x + 1, y + 1],
        ]);
      if (!covered.has(tileKey([x - 1, y])))
        edges.push([
          [x, y],
          [x, y + 1],
        ]);
      if (!covered.has(tileKey([x + 1, y])))
        edges.push([
          [x + 1, y],
          [x + 1, y + 1],
        ]);
    }
    queue.commands.push(
      ...this.createJoinedEdgeCommands(edges, is2D ? projection : null, {
        ...DANGER_BORDER,
        hslColor: DANGER_HSL,
        zIndex: Z_LAYERS.GRID + 2,
      }),
    );
  }
}
