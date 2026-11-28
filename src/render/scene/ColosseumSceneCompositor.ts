import { isSolHereditSnapshot } from '../../core/encounters/snapshot';
import type { EncounterGraphicCue } from '../../core/events/encounterVisual';
import { COLOSSEUM_SPOTANIMS } from '../../npcs/colosseum/constants';
import type { ColosseumHeldOrb } from '../../npcs/colosseum/visualEvents';
import { rgbToHsl } from '../../rs/util/ColorUtil';
import type { Coordinate, NpcSnapshot, SimulationState } from '../../types/simulation';
import { DEFAULT_TILE_MARKER_WIDTH } from '../../types/tileMarkers';
import type { Camera3D, Projection2D, Viewport } from '../core/camera';
import type { RenderQueue } from '../core/commands';
import { rgbaFromHex } from '../core/types';
import { type OneShotSpotAnimRequest, updateOneShotSpotAnim } from '../effects/spotAnimPlayback';
import { FLOOR_EFFECT_DEPTH_BIAS } from '../effects/spotAnimRenderPolicy';
import type { SpotAnimStyle, SpotAnimTransform } from '../effects/spotAnimTypes';
import { PRIMARY_NPC_ACTOR_ID } from '../npc/NpcInstanceManager';
import { SceneCompositor, Z_LAYERS } from './SceneCompositor';
import type { RenderContext } from './types';

/**
 * Sol Heredit's scene, waves 1-11 included: his telegraph animations and the cache ground effects
 * those telegraphs paint, plus the warband's and the wave species' projectiles, all played by the
 * shared cue player from the run's `encounter_visual` batches, and the Manticores' held orbs, drawn
 * from the snapshot (`ColosseumHeldOrb`). Sol's attacks ARE their telegraphs, so the real cache effects are the
 * warning. Local to Sol: the floor and culling styles of his effects, his effect batching and
 * zero-area beam-part skipping, and the overlays below.
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

/** Tile effects (attack ripples, sand strikes) sit on the floor; actor effects ride their actor. */
const FLOOR_STYLE: SpotAnimStyle = { depthBias: FLOOR_EFFECT_DEPTH_BIAS };
/**
 * Sol's melee puffs (Spear and Shield) may be left out of frames whose view excludes them; the
 * compositor decides whether a view is set at all. Their timelines go on regardless.
 */
const SOL_MELEE_FLOOR_STYLE: SpotAnimStyle = { ...FLOOR_STYLE, cullOutsideView: true };
const SOL_MELEE_SPOT_ANIM_IDS: ReadonlySet<number> = new Set(COLOSSEUM_SPOTANIMS.solMelee);

/**
 * How Sol's scene draws a cue graphic: tile effects (attack ripples, sand strikes, beams) sit on the
 * floor, and Sol's melee puffs may be left out of frames whose view excludes them; effects riding an
 * actor draw as the actor does.
 */
export function colosseumGraphicStyle(cue: EncounterGraphicCue): SpotAnimStyle | undefined {
  if (cue.target.kind !== 'tile') return undefined;
  return SOL_MELEE_SPOT_ANIM_IDS.has(cue.spotAnimId) ? SOL_MELEE_FLOOR_STYLE : FLOOR_STYLE;
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
  private readonly cullSolMeleeOutsideView: boolean;
  /** This frame's held Manticore orbs, its state, and each drawn orb's request by instance id. */
  private heldOrbs: readonly ColosseumHeldOrb[] = [];
  private heldOrbState: SimulationState | null = null;
  private readonly heldOrbRequests = new Map<
    string,
    { readonly orb: ColosseumHeldOrb; readonly request: OneShotSpotAnimRequest }
  >();
  private heldOrbPlayerPosition: readonly [number, number] = [0, 0];

  constructor(options: ColosseumSceneOptions = {}) {
    super();
    this.cullSolMeleeOutsideView = options.cullSolMeleeOutsideView === true;
    this.registerTransientReset('colosseum-held-orbs', () => this.clearHeldOrbs());
    // Melee first: the families are admitted in this order against one allowance.
    if (options.batchSolEffects === true)
      this.spotAnimRenderer.setBatchableSpotAnimFamilies([COLOSSEUM_SPOTANIMS.solMelee, SOL_BEAM_SPOTANIMS]);
    if (options.skipZeroAreaBeamParts === true) this.spotAnimRenderer.setZeroAreaPartSkip(SOL_BEAM_SPOTANIMS);
  }

  override build(ctx: RenderContext, projection: Projection2D, viewport: Viewport): RenderQueue {
    const snapshot = ctx.simulationState.encounter;
    this.heldOrbs = isSolHereditSnapshot(snapshot) ? (snapshot.visuals.heldOrbs ?? []) : [];
    this.heldOrbState = ctx.simulationState;
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

  protected override encounterGraphicStyle(cue: EncounterGraphicCue): SpotAnimStyle | undefined {
    return colosseumGraphicStyle(cue);
  }

  /**
   * The primary instance is built with Sol's model as soon as it loads and is otherwise kept for the
   * scene's life. A run on waves 1-11 has no Sol until C, so it goes while his snapshot is absent and
   * is rebuilt from that snapshot when he is added.
   */
  protected override syncNpcInstances(
    npcs: NpcSnapshot[],
    is2D: boolean,
    simulationState?: SimulationState,
    paused = false,
  ): void {
    super.syncNpcInstances(npcs, is2D, simulationState, paused);
    const primary = this.encounterRenderConfig?.primaryNpc;
    if (primary && !npcs.some((npc) => npc.id === primary.actorId)) {
      this.npcInstanceManager.removePresentation(PRIMARY_NPC_ACTOR_ID);
    }
  }

  /** After the cue player, once every actor's rendered position is known: the held orbs. */
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
    this.heldOrbPlayerPosition = playerVisualPosition;
    this.renderHeldOrbs();
  }

  /**
   * Draws the snapshot's held orbs, each from the start of the frame's tick as the server re-sends
   * it, and drops the ones it no longer lists. Derived from the frame's snapshot alone, so a replay
   * seek lands on the frame play shows.
   */
  private renderHeldOrbs(): void {
    const state = this.heldOrbState;
    if (!state) return;
    const startCycle = state.currentTick * 30;
    const listed = new Set<string>();
    for (const orb of this.heldOrbs) {
      const id = `colosseum-held-${orb.actorId}-${orb.height}`;
      listed.add(id);
      let held = this.heldOrbRequests.get(id);
      if (held?.orb.spotAnimId !== orb.spotAnimId || held.request.startCycle !== startCycle) {
        held = {
          orb,
          request: {
            instanceId: id,
            spotAnimId: orb.spotAnimId,
            startCycle,
            transformSource: { kind: 'dynamic', resolve: this.heldOrbTransform(orb) },
            heightOffsetMode: 'actor',
            fallbackDurationCycles: 0,
          },
        };
        this.heldOrbRequests.set(id, held);
      }
      if (this.resolveAttachedActor(orb.actorId, state, this.heldOrbPlayerPosition) === null)
        this.spotAnimRenderer.despawn(id);
      else updateOneShotSpotAnim(this.spotAnimRenderer, held.request, this.displayedCycle);
    }
    for (const id of this.heldOrbRequests.keys()) {
      if (listed.has(id)) continue;
      this.spotAnimRenderer.despawn(id);
      this.heldOrbRequests.delete(id);
    }
  }

  /** Rides the holder's rendered model `orb.height` (OSRS units) above it, in one record of its own. */
  private heldOrbTransform(orb: ColosseumHeldOrb): () => SpotAnimTransform | null {
    const transform: SpotAnimTransform = { position: [0, 0, 0] };
    const lift = orb.height / 128;
    return () => {
      const state = this.heldOrbState;
      const actor = state && this.resolveAttachedActor(orb.actorId, state, this.heldOrbPlayerPosition);
      if (!actor) return null;
      transform.position[0] = actor.position[0];
      transform.position[1] = actor.position[1];
      transform.position[2] = actor.position[2] + lift;
      transform.yaw2048 = actor.yaw2048;
      transform.pitchRad = actor.pitchRad;
      transform.scale = actor.scale;
      return transform;
    };
  }

  private clearHeldOrbs(): void {
    for (const id of this.heldOrbRequests.keys()) this.spotAnimRenderer.despawn(id);
    this.heldOrbRequests.clear();
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
