import type { ActorFrameState, EventAudioPlayer, FrameSoundTracker } from '../../audio';
import type { LocWithType } from '../../cache/CacheManager';
import { getSpecialAttackDef } from '../../core/combat/player/specialAttacks/registry';
import { GRID_SIZE, getArenaBounds, getWalkableTiles } from '../../core/constants';
import { getArenaTileExtent } from '../../core/encounters/mapFootprint';
import { type EncounterGraphicCue, isActorPresentationsRemovedEvent } from '../../core/events/encounterVisual';
import { type GameEvent, isCoreEvent } from '../../core/events/types';
import type { ReplayDisplayFrame } from '../../core/ReplayRecorder';
import { TileKeySetCache } from '../../core/tileKeySet';
import { getSpellVisuals } from '../../data/spellVisuals';
import {
  DEFAULT_ANIMATION_SET,
  getPlayerBlockAnimations,
  getWeaponAnimationSetWithFallbacks,
  PLAYER_EAT_SEQ_ID,
  type WeaponAnimationSet,
} from '../../data/weaponAnimations';
import { getWeaponCombatVisuals } from '../../data/weaponCombatVisuals';
import type { ArenaBounds } from '../../rs/collision/WalkabilityAnalyzer';
import type { OverlayTypeLoader, UnderlayTypeLoader } from '../../rs/config/flotype/FloTypeLoader';
import type { LocModelLoader } from '../../rs/config/loctype/LocModelLoader';
import { LocModelType } from '../../rs/config/loctype/LocModelType';
import type { ObjTypeLoader } from '../../rs/config/objtype/ObjTypeLoader';
import type { SeqType } from '../../rs/config/seqtype/SeqType';
import {
  type LocationData,
  type LocTypeInfoLoader,
  MAP_SQUARE_SIZE,
  type MapSquareData,
  type MapSquareLoader,
  populateTileLightOcclusions,
} from '../../rs/map/MapLoader';
import {
  createTerrainContext,
  getMapSquareBlock,
  getMapSquareBlockTileBounds,
  getTerrainContextLoadOffsets,
  isTileInMapSquareBlock,
  type MapSquareBlockEntry,
  type MapSquareOffsets,
  type TerrainContext,
} from '../../rs/map/mapSquareBlock';
import type { ModelData } from '../../rs/model/ModelData';
import type { ModelLoader } from '../../rs/model/ModelLoader';
import type { NpcModelLoader } from '../../rs/model/NpcModelLoader';
import type { PlayerAppearance, PlayerEquipment, PlayerModelLoader } from '../../rs/model/PlayerModelLoader';
import { DEFAULT_MALE_APPEARANCE, modelDataToPlayerMesh } from '../../rs/model/PlayerModelLoader';
import type { SpotAnimModelLoader } from '../../rs/model/SpotAnimModelLoader';
import { packHsl } from '../../rs/util/ColorUtil';
import type { LineMarker } from '../../types/lineMarkers';
import { clampLineWidth, DEFAULT_LINE_MARKER_WIDTH, lineMarkerEndpoints } from '../../types/lineMarkers';
import type { NpcHighlightEntry, NpcHighlightMode } from '../../types/npcHighlight';
import { enabledPillarAdditions, hiddenPillarLocIds, type PillarAdditionsOptions } from '../../types/pillarAdditions';
import { type Coordinate, type NpcSnapshot, OSRS_TICK_MS, type SimulationState } from '../../types/simulation';
import { clampTileGridWidth, type TileGridStyle } from '../../types/tileGrid';
import type { TileIndicatorConfig, TileIndicatorStyle } from '../../types/tileIndicators';
import { DEFAULT_TILE_INDICATOR_CONFIG } from '../../types/tileIndicators';
import { clampTileWidth, DEFAULT_TILE_MARKER_WIDTH, type TileMarker } from '../../types/tileMarkers';
import { isTzhaarTrackedNpc, type TzhaarHpTrackerOptions, tzhaarHighlightColor } from '../../types/tzhaarHpTracker';
import { frameProfiler } from '../../util/FrameProfiler';
import { log } from '../../util/Logger';
import { profiler } from '../../util/Profiler';
import { createTerrainBuilder } from '../backends/picogl/TerrainBuilder';
import { type AnimationSequence, type AnimationSystem, CLIENT_TICK_MS } from '../core/animation';
import type { Projection2D, Viewport } from '../core/camera';
import type {
  FillStyle,
  NpcMesh3DCommand,
  RenderCommand,
  RenderQueue,
  StrokeStyle,
  TerrainMesh3DCommand,
} from '../core/commands';
import { createQueue, resetQueue } from '../core/commands';
import { calculateVisualPlayerPosition } from '../core/interpolation';
import { ImmutableMeshSource, type MeshUploadData } from '../core/meshSource';
import { sharedModelTextureIndex } from '../core/modelTextures';
import {
  type EffectDurationResolver,
  type ReplayEffectDestination,
  ReplayEffectIndex,
  type ReplayFrameReader,
} from '../core/replayEffectIndex';
import { type PlayerAttackIntent, playerAttackSequenceIds, playerPrimarySpec } from '../core/replayPrimaryCues';
import { splitTriangleSoupByAlpha } from '../core/splitMeshByAlpha';
import type { ColorRGBA, Vec2 } from '../core/types';
import { rgba, rgbaFromHex, vec2 } from '../core/types';
import { PLAYER_GRAPHIC_PRELOAD_IDS, PlayerGraphicController } from '../effects/controllers/PlayerGraphicController';
import { ProjectileController, type SurfaceHeightResolver } from '../effects/controllers/ProjectileController';
import { EncounterCuePlayer } from '../effects/EncounterCuePlayer';
import { describePlayerEffects } from '../effects/playerEffectDescriptors';
import type { ActorVisualPositionResolver } from '../effects/projectileAim';
import { ReplayProjectileWork } from '../effects/replayProjectileWork';
import { SpotAnimRenderer } from '../effects/SpotAnimRenderer';
import type { SpotAnimStyle, SpotAnimTransform } from '../effects/spotAnimTypes';
import { createNpcCenterTransformSource } from '../effects/transforms/npcCenterTransform';
import { LocRenderer, type LocRenderOptions } from '../environment/LocRenderer';
import { resolveLocRenderFilter, resolveRenderLoc } from '../environment/locRenderFilter';
import {
  type SceneObjectLocData,
  type SceneObjectLocModelLoader,
  SceneObjectRenderer,
} from '../graphics/SceneObjectRenderer';
import type { FightStartCountdownPhase, SceneObjectController } from '../graphics/sceneObjectTypes';
import {
  type NpcAnimationTrigger,
  NpcInstanceManager,
  type NpcOverlayHeights,
  type NpcTypeLoadConfig,
  PRIMARY_NPC_ACTOR_ID,
} from '../npc/NpcInstanceManager';
import { isNpcStandingAt } from '../npc/npcStanding';
import { UIOverlayRenderer } from '../overlay/UIOverlayRenderer';
import { type PlayerAnimatedMeshPair, PlayerAnimationController } from '../player/PlayerAnimationController';
import type { PlayerAnimationSet, PlayerAnimModelAdapter } from '../player/playerAnimationTypes';
import { composeTerrainHeights, getTerrainHeight, getTerrainHeightInterpolated } from '../shared/renderUtils';
import { resolveEncounterLocRenderOptions } from './encounterLocRenderOptions';
import type { EncounterRenderConfig, NpcRenderConfig } from './encounterRenderConfig';
import { GroundItemRenderer } from './GroundItemRenderer';
import {
  hasNpcHidingPlugin,
  isNpc2DHidden,
  isNpcModelHidden,
  isNpcOverlayHidden,
  type NpcHidingPlugins,
  npcVisibilityFactsWithoutSnapshot,
} from './npcPluginVisibility';
import { SceneSurfaceHeightResolver, type SceneSurfaceTerrainSquare } from './SceneSurfaceHeightResolver';
import { buildTileGridMesh, tileGridMeshId } from './tileGridMesh';

export interface GroundItemLoaderSource {
  getObjTypeLoader(): ObjTypeLoader | null;
  getModelLoader(): ModelLoader | null;
}

import { type DiscontinuityReason, detectTimelineDiscontinuity } from './timelineDiscontinuity';
import type { NpcHitTestData, RenderContext, SceneOptions, TextureIndexMapper } from './types';

export const COLORS = {
  background: rgbaFromHex('#0a0b10'),
  gridLine: rgba(1, 1, 1, 0.08),
  gridLineMajor: rgba(1, 1, 1, 0.15),
  player: rgbaFromHex('#00ffff'),
  playerBorder: rgba(0, 0, 0, 0.8),
  text: rgba(1, 1, 1, 0.9),
  targetTile: rgba(0.08, 0.84, 0.04, 1),
  hoveredTile: rgba(0.93, 0.14, 0.12, 1),
  playerTile: rgba(0.04, 0.56, 0.86, 0.84),
};

/**
 * Forward NDC-z bias for NPC clickbox overlays, whose geometry is coincident
 * with the opaque model surface. Reversed-Z rendering uses depthFunc(GREATER),
 * so without a bias the overlay's fragments tie the model's depth and z-fight
 * (mottled/flickering). The transparent pass does not apply a global forward
 * bias, so these surface-coincident overlays must request one per-command
 * (the same technique used for floor decals).
 */
const NPC_CLICKBOX_OVERLAY_DEPTH_BIAS = 0.0005;

/** One highlight to draw on one NPC, whichever plugin asked for it. */
interface NpcHighlightDraw {
  readonly npc: NpcSnapshot;
  readonly mode: NpcHighlightMode;
  readonly color: string;
}
/** Simulation actor id of the player; projectile aims resolve it to the visual position. */
export const PLAYER_ACTOR_ID = 'player';
/**
 * Line and tile markers are authored on the same 0.5–10 UI scale as Tile
 * Indicators, so `× 0.02` converts to world units exactly as
 * `trueTileConfig.width` does. Line markers default to 1 (0.02, below the
 * NPC/corner outline weight of 0.03); tile markers default to 2 (0.04).
 *
 * Canvas2D takes the UI width verbatim (`widthPx: width`), the way the Tile
 * Indicator strokes already do. Rounding it there collapsed each half-step onto
 * its neighbor — 0.5 and 1 both drew 1px — so half the scale did nothing in
 * the fallback renderer.
 */
function markerWidthWorld(uiWidth: number): number {
  return uiWidth * 0.02;
}

/** Black, matching the fill RuneLite paints under every ground marker. */
const TILE_MARKER_FILL_HSL = packHsl(0, 0, 0);
/** `OverlayUtil.renderPolygon`'s fill, rgba(0, 0, 0, 50), under a bordered pillar mark. */
const RUNELITE_POLYGON_FILL_ALPHA = 50 / 255;
/** The pillar Additions plugins' Tile fill floor (`TILE_FILL_ALPHA`) and stroke width, in px. */
const PILLAR_TILE_FILL_MIN_ALPHA = 40 / 255;
const PILLAR_TILE_STROKE_WIDTH = 2;

const PRIMARY_NPC_DEATH_SPOTANIM_GROUP = 'primary-npc-death';

/** One minute of client cycles: at most 60 animation updates per NPC animation clock catch-up. */
const MAX_NPC_ANIMATION_CATCH_UP_CYCLES = 3000;

export const Z_LAYERS = {
  BACKGROUND: 0,
  GRID: 10,
  TILE_MARKERS: 15,
  WAVE: 20,
  EXPLOSION: 30,
  NPC: 40,
  TRAIL: 50,
  FIREBALL_SHADOW: 55,
  PLAYER: 60,
  FIREBALL: 70,
  TARGET: 80,
  HOVER: 90,
  TEXT: 100,
};

export type { NpcMesh3DCommand, TerrainMesh3DCommand } from '../core/commands';

function tilePolygonCommand(
  projection: Projection2D,
  coord: Coordinate,
  fill?: ColorRGBA,
  stroke?: StrokeStyle,
  zIndex = 0,
): RenderCommand {
  const tile = { x: coord[0], y: coord[1] };
  const points = projection.tilePolygonScreen(tile);
  return {
    kind: 'poly2d',
    points,
    fill,
    stroke,
    zIndex,
  };
}

function tileCornerOutlineCommands(
  projection: Projection2D,
  coord: Coordinate,
  color: ColorRGBA,
  zIndex = 0,
  cornerRatio = 0.3,
  widthPx = 2.5,
): RenderCommand[] {
  const tile = { x: coord[0], y: coord[1] };
  const corners = projection.tilePolygonScreen(tile);
  if (corners.length < 4) return [];

  const commands: RenderCommand[] = [];

  for (let i = 0; i < 4; i++) {
    const corner = corners[i];
    const nextCorner = corners[(i + 1) % 4];
    const prevCorner = corners[(i + 3) % 4];

    const prevX = corner.x + (prevCorner.x - corner.x) * cornerRatio;
    const prevY = corner.y + (prevCorner.y - corner.y) * cornerRatio;
    const nextX = corner.x + (nextCorner.x - corner.x) * cornerRatio;
    const nextY = corner.y + (nextCorner.y - corner.y) * cornerRatio;

    commands.push({
      kind: 'poly2d',
      points: [vec2(prevX, prevY), vec2(corner.x, corner.y), vec2(nextX, nextY)],
      stroke: { color, widthPx },
      zIndex,
      closePath: false,
    });
  }

  return commands;
}

function circleCommand(
  center: Vec2,
  radiusPx: number,
  fill?: FillStyle,
  stroke?: StrokeStyle,
  zIndex = 0,
): RenderCommand {
  return {
    kind: 'circle2d',
    center,
    radiusPx,
    fill,
    stroke,
    zIndex,
  };
}

class PlayerModelAdapter implements PlayerAnimModelAdapter {
  constructor(
    private model: ModelData,
    private originalX: Int32Array,
    private originalY: Int32Array,
    private originalZ: Int32Array,
    private originalFaceAlphas: Int8Array | null,
    private animationSystem: AnimationSystem,
    private buildMeshFn: () => PlayerAnimatedMeshPair | null,
    private applyMeshFn: (meshPair: PlayerAnimatedMeshPair) => void,
  ) {}

  resetPose(): void {
    this.model.verticesX.set(this.originalX);
    this.model.verticesY.set(this.originalY);
    this.model.verticesZ.set(this.originalZ);
    // Restore original face alphas because transforms can mutate them across frame rebuilds.
    if (this.originalFaceAlphas && this.model.faceAlphas) {
      this.model.faceAlphas.set(this.originalFaceAlphas);
    }
  }

  applyFrame(frameId: number): void {
    const frame = this.animationSystem.loadFrame(frameId);
    if (frame) {
      this.model.animate(frame);
    }
  }

  applyFrameInterleaved(primaryFrameId: number, secondaryFrameId: number, interleaveOrder: number[]): void {
    const primaryFrame = this.animationSystem.loadFrame(primaryFrameId);
    const secondaryFrame = this.animationSystem.loadFrame(secondaryFrameId);
    if (primaryFrame && secondaryFrame) {
      this.model.animateInterleaved(primaryFrame, secondaryFrame, interleaveOrder);
    } else if (primaryFrame) {
      this.model.animate(primaryFrame);
    } else if (secondaryFrame) {
      this.model.animate(secondaryFrame);
    }
  }

  commitPose(): void {
    const meshPair = this.buildMeshFn();
    if (meshPair) {
      this.applyMeshFn(meshPair);
    }
  }

  applyMesh(meshPair: PlayerAnimatedMeshPair): void {
    this.applyMeshFn(meshPair);
  }
}

/** Whether an encounter's declared assets are still loading, settled with some unusable, or all drawable. */
export type EncounterAssetState = 'pending' | 'unavailable' | 'ready';

export class SceneCompositor {
  private cachedTerrainMeshes: TerrainMesh3DCommand[] = [];
  /** The terrain load in flight; a repeated request joins it instead of reporting it done. */
  private terrainLoad: Promise<void> | null = null;
  private textureIndexMapper: TextureIndexMapper | null = null;
  protected terrainHeights: Int32Array[] | null = null;
  protected readonly surfaceHeightResolver = new SceneSurfaceHeightResolver();
  protected readonly resolveSurfaceHeight: SurfaceHeightResolver = (worldX, worldY) =>
    this.surfaceHeightResolver.hasTerrain
      ? this.surfaceHeightResolver.resolve(worldX, worldY)
      : getTerrainHeightInterpolated(this.terrainHeights, worldX, worldY);
  /** Zero-allocation mirror of the authoritative arena walkable set; the boundary pass probes each arena tile five times per frame. */
  private readonly walkableLookup = new TileKeySetCache();
  /** Memoized walkability closure, so boundary topology can cache on its identity. */
  private arenaWalkabilityChecker: ((x: number, y: number) => boolean) | null = null;
  private arenaWalkabilityCheckerSource: Set<string> | null = null;
  /** Arena-boundary topology is static between encounter loads, so derive it once instead of every frame. */
  protected arenaBoundaryPairs: Int32Array | null = null;
  private arenaBoundaryPairsKey = '';
  protected terrainBounds: ArenaBounds | null = null;
  /** The encounter footprint's arena squares: the actor height grid and the tile-space gates cover these. */
  private arenaBlock: readonly MapSquareBlockEntry[] = getMapSquareBlock();
  /** The Tile Grid mesh and the terrain it was built on; see buildTileGrid3D. */
  private cachedTileGrid: { readonly heights: Int32Array[]; readonly command: NpcMesh3DCommand } | null = null;
  protected encounterRenderConfig: EncounterRenderConfig | undefined;
  private smoothTerrain = false;
  private terrainVersion = 0;
  private lastTerrainArgs: {
    mapLoader: MapSquareLoader;
    underlayLoader?: UnderlayTypeLoader;
    overlayLoader?: OverlayTypeLoader;
    locations?: LocationData[];
    locTypeInfoLoader?: LocTypeInfoLoader;
  } | null = null;

  protected npcInstanceManager = new NpcInstanceManager();
  /** Subclasses that rebuild clickbox after custom transforms should set this to true. */
  protected deferNpcClickbox = false;
  private playerAnimationSystem: AnimationSystem | null = null;
  private npcLoadStarted = false;

  protected locRenderer = new LocRenderer();
  private groundItemRenderer = new GroundItemRenderer();
  private groundItemLoaderSource: GroundItemLoaderSource | null = null;
  private sceneObjectRenderer: SceneObjectRenderer | null = null;
  private sceneObjectController: SceneObjectController<SimulationState, SceneObjectLocData> | null = null;
  private emittedDeathSpotAnimTick: number | null = null;
  /** Latest state handed to the render pass, so a dynamic transform resolves against this tick, not the one it was created on. */
  protected latestSimulationState: SimulationState | null = null;

  private cachedPlayerMeshes: NpcMesh3DCommand[] = [];
  private playerLoading = false;
  private playerAppearance: PlayerAppearance = DEFAULT_MALE_APPEARANCE;
  private playerEquipment: PlayerEquipment = {};
  private playerMeshVersion = 0;
  private playerAnimController: PlayerAnimationController | null = null;
  // Bottom extent of the player model in OSRS model-space Y units.
  // OSRS model Y: positive = below origin. OSRS uses painter's algorithm
  // (actors drawn after terrain), so model feet below Y=0 are visually hidden.
  // Our depth-tested WebGL renderer needs to lift the model by this amount
  // so the lowest vertex sits exactly at the terrain surface.
  private playerModelBottomY = 0;

  protected speedMultiplier = 1;
  private npcInterpFraction = 0;
  private lastPlayerVisualCenter: [number, number] | null = null;
  private lastProcessedEventId = -1;
  private lastPlayedAudioEventId = -1;
  private lastDisplayedTick: number | undefined = undefined;
  private needsDeathReconciliation = true;
  private lastDeathReconciliationTick: number | undefined = undefined;
  private lastTimelineKey: string | undefined = undefined;
  /**
   * Reason for the current frame's timeline discontinuity (null when contiguous).
   * Set once per build, read by encounter subclasses (e.g. frame-audio
   * silent-sync, facing snap).
   */
  private lastDiscontinuityReason: DiscontinuityReason | null = null;
  private readonly transientResets: Array<{
    name: string;
    reset: (reason: DiscontinuityReason) => void;
  }> = [];
  private projectileTargetId: string | null = null;
  private _introAnimPlaying = false;
  private _introAnimStarted = false;
  private _introAnimComplete = false;
  private pendingIntroSeqId: number | null = null;

  // Player attack animation is triggered through `playerAnimController`, which is
  // null until the async `loadPlayer()` finishes. An `attack_started` event is
  // consumed (and sound/projectile/spotanim fired) exactly once on the frame it
  // arrives, but if the controller isn't ready yet the ANIMATION would silently
  // no-op and be lost forever (sound plays, player stands still). Stash the
  // attack intent here and flush it once the controller exists — latest-wins,
  // matching OSRS one-shot attack-anim behavior. (See flushPendingPlayerAttack.)
  private pendingPlayerAttack: PlayerAttackIntent | null = null;
  private replayPlayerController: PlayerAnimationController | null = null;

  private playerModelMatrix = new Float32Array(16);

  protected spotAnimRenderer = new SpotAnimRenderer();
  private playerGraphicController = new PlayerGraphicController();
  private projectileController = new ProjectileController();
  private replayEffectIndexes = new WeakMap<readonly ReplayDisplayFrame[], ReplayEffectIndex>();
  protected replayEffectIndex: ReplayEffectIndex | undefined;
  private readonly pendingNpcTypeLoadAttempts = new Map<number, number>();
  private readonly failedNpcTypeLoadAttempts = new Set<number>();
  protected effectTick = 0;
  private primaryCycle = 0;
  /** The client cycle this frame displays (30 per tick), for an encounter drawing its own effects. */
  protected get displayedCycle(): number {
    return this.primaryCycle;
  }
  private replayProjectileWork: ReplayProjectileWork | undefined;
  /**
   * The history cutoff of the context this build actually renders. A restored presentation gains its
   * history inside `build()`, so this, not the `build()` argument, is the frame's cutoff.
   */
  private replayThroughFrameIndex: number | undefined;
  /**
   * The NPC clock: the absolute client cycle every scene's NPC animations have reached, or null until
   * it starts or after a reset; see `advanceNpcAnimationClock`.
   */
  private npcAnimationCycle: number | null = null;
  /**
   * Whether this frame rebuilt presentation rather than advancing it. Frame audio then syncs silently,
   * so a seek, restore or late asset load never plays a rebuilt clip's sounds as new.
   */
  private reconstructedVisuals = false;
  /** The scene's `encounter_visual` clips, flights and graphics. */
  private readonly cues = new EncounterCuePlayer(this.spotAnimRenderer, (cue) => this.encounterGraphicStyle(cue));
  /** The history the cue player last synced from; undefined live and while a replay waits for assets. */
  private cueHistory: readonly ReplayDisplayFrame[] | undefined;
  /**
   * Whether the corpses the simulation already pruned still need restoring from history: set when the
   * cues are rebuilt (a seek, a new history or a restore) or a history frame is shown in 2D, which
   * draws no models; cleared once a 3D frame with synced cues has restored them at its destination,
   * and when the history is left or reset.
   */
  private historicalCorpsesPending = false;
  /** Each NPC type the render config declares, with the settings it loads with; see `setEncounterRenderConfig`. */
  private declaredNpcTypes: ReadonlyMap<number, NpcTypeLoadConfig> = new Map();
  private declaredNpcTypeIds: readonly number[] = [];
  /**
   * Every effect the render config declares, once each: its `spotAnimIds` and the primary NPC's death
   * effect. Preloaded with the encounter's assets, and what their readiness waits for.
   */
  private declaredSpotAnimIds: readonly number[] = [];
  private previousEffectCycle: number | undefined;
  private previousEffectFrame: number | undefined;
  private readonly pendingReplaySpotAnims = new Set<number>();
  private readonly initializedRestorations = new WeakSet<NonNullable<RenderContext['restoredPresentation']>>();
  private restoredHistoryOwner: RenderContext['restoredPresentation'];
  protected readonly effectDuration: EffectDurationResolver = (spotAnimId) => {
    const lengths = this.spotAnimRenderer.getFrameLengths(spotAnimId);
    if (lengths) return lengths.reduce((sum, length) => sum + length, 0) || 90;
    if (!this.spotAnimModelLoader) return undefined;
    const sequenceId = this.spotAnimModelLoader.getSequenceId(spotAnimId);
    if (sequenceId < 0) return 90;
    if (!this.playerAnimationSystem) return undefined;
    const sequence = this.playerAnimationSystem.loadSeqType(sequenceId);
    if (!sequence) return 90;
    return sequence.isSkeletalSeq()
      ? Math.max(1, sequence.skeletalEnd - sequence.skeletalStart)
      : sequence.frameLengths?.reduce((sum, length) => sum + length, 0) || 90;
  };
  private uiOverlayRenderer = new UIOverlayRenderer();
  protected spotAnimModelLoader: SpotAnimModelLoader | null = null;
  private eventAudioPlayer: EventAudioPlayer | null = null;
  private frameSoundTracker: FrameSoundTracker | null = null;
  private _disposed = false;
  private reusableQueue: RenderQueue | null = null;

  private cachedTileOutlines3DKey = '';
  private cachedTileOutlines3DCommands: RenderCommand[] = [];
  /** Render ids (primary NPC under its alias) whose models the hiding plugins left out of the last frame. */
  private hiddenNpcRenderIds: ReadonlySet<string> = new Set();
  /** The hiding plugins' verdict on the last frame's NPC models; see `resolveHiddenNpcModels`. */
  private isNpcRenderInstanceHidden: ((actorId: string, npcTypeId: number, dying: boolean) => boolean) | undefined;

  constructor() {
    // Base-owned transient render state participates in the uniform timeline
    // discontinuity reset. Encounter subclasses register their own controllers
    // in their constructor (after super()) so they can never forget to reset on
    // a seek — registration IS participation.
    this.registerTransientReset('base-encounter-visuals', (reason) => this.clearEncounterVisuals(reason));
    this.registerTransientReset('event-audio', () => this.eventAudioPlayer?.reset());
    this.registerTransientReset('frame-audio', () => this.frameSoundTracker?.reset());
    this.registerTransientReset('encounter-cues', () => {
      this.cues.clear();
      this.cueHistory = undefined;
      this.historicalCorpsesPending = false;
    });
    this.registerTransientReset('npc-animation-clock', () => {
      this.npcAnimationCycle = null;
    });
    this.registerTransientReset('primary-npc-death-spotanim', () => {
      this.spotAnimRenderer.despawnGroup(PRIMARY_NPC_DEATH_SPOTANIM_GROUP);
      this.emittedDeathSpotAnimTick = null;
      this.latestSimulationState = null;
    });
  }

  /**
   * Spawn the primary NPC's death VFX once, on the tick the encounter is decided.
   *
   * Driven entirely by `encounterRenderConfig.primaryNpc.deathSpotAnimId`, so an encounter opts in
   * by declaring the id and nothing else — there is no per-encounter emission code to forget.
   * The transform re-resolves against the live NPC model matrix every frame rather than the tick's
   * snapshot, so the effect stays on the corpse while the death animation moves it.
   */
  protected renderPrimaryNpcDeathSpotAnim(currentTick: number, simulationState: SimulationState): void {
    this.latestSimulationState = simulationState;
    const primaryNpc = this.encounterRenderConfig?.primaryNpc;
    const spotAnimId = primaryNpc?.deathSpotAnimId;
    if (!primaryNpc || spotAnimId === undefined) {
      return;
    }

    const outcome = simulationState.encounterOutcome;
    if (
      outcome.phase === 'active' ||
      outcome.primaryActorId !== primaryNpc.actorId ||
      currentTick < outcome.decisiveTick ||
      currentTick >= outcome.completionTick ||
      this.emittedDeathSpotAnimTick === outcome.decisiveTick ||
      !this.spotAnimRenderer.isLoaded(spotAnimId)
    ) {
      return;
    }

    this.emittedDeathSpotAnimTick = outcome.decisiveTick;
    this.spotAnimRenderer.spawn({
      instanceId: `primary-npc-death-${outcome.decisiveTick}`,
      spotAnimId,
      transform: createNpcCenterTransformSource({
        getState: () => {
          const state = this.latestSimulationState ?? simulationState;
          const modelMatrix = this.npcInstanceManager.getModelMatrix(PRIMARY_NPC_ACTOR_ID);
          return {
            swX: modelMatrix ? modelMatrix[12] - state.primaryNpcSize / 2 : state.primaryNpcPosition[0],
            swY: modelMatrix ? modelMatrix[13] - state.primaryNpcSize / 2 : state.primaryNpcPosition[1],
            size: state.primaryNpcSize,
            z: modelMatrix?.[14],
            yaw2048: state.primaryNpcFacingAngle,
          };
        },
      }),
      lifecycle: { kind: 'oneShot', startTick: outcome.decisiveTick },
      style: { zIndex: Z_LAYERS.EXPLOSION + 3 },
      groupId: PRIMARY_NPC_DEATH_SPOTANIM_GROUP,
    });
  }

  /**
   * Starts a stopped NPC animation clock on the whole client cycle at or before `cycle`. Live play
   * starts on a tick boundary; a restore lands mid-cycle, and starting there would leave every actor
   * it does not re-pose a fraction of a cycle out of step with live play for every later clip.
   */
  private startNpcAnimationClock(cycle: number): number {
    this.npcAnimationCycle ??= Math.floor(cycle);
    return this.npcAnimationCycle;
  }

  /**
   * Steps cycle-driven NPC animations forward to `cycle` in <=50-cycle slices, the renderer's update
   * budget, starting a stopped clock first. The clock never runs backwards; discontinuities reset it.
   *
   * Only the last MAX_NPC_ANIMATION_CATCH_UP_CYCLES of a gap are stepped. Replay can hold its final
   * snapshot while presentation time runs on without bound, and that is not a discontinuity. Every
   * one-shot clip and death fade is far shorter than the cap, so the skipped time only shifts looping
   * idle phase; replay restores timeline actors and corpses from the absolute cycle anyway.
   */
  private advanceNpcAnimationClock(cycle: number): void {
    const start = this.startNpcAnimationClock(cycle);
    let remaining = Math.min(Math.max(0, cycle - start), MAX_NPC_ANIMATION_CATCH_UP_CYCLES);
    while (remaining > 0) {
      const elapsed = Math.min(remaining, 50);
      this.npcInstanceManager.updateAnimations(elapsed * CLIENT_TICK_MS, 1, []);
      remaining -= elapsed;
    }
    this.npcAnimationCycle = Math.max(start, cycle);
  }

  /**
   * Register a transient-reset participant. Invoked (in registration order, base
   * first) on every timeline discontinuity — rewind, forward-jump, or
   * timeline-change. Use a bound closure so controllers can capture compositor
   * fields (e.g. `this.spotAnimRenderer`). This is the extension point for new
   * encounters: register once in the subclass constructor.
   */
  protected registerTransientReset(name: string, reset: (reason: DiscontinuityReason) => void): void {
    this.transientResets.push({ name, reset });
  }

  /**
   * Drop transient cross-tick render/audio state across ALL registered
   * participants so the next frame is rebuilt from the snapshot. Once-per-build,
   * driven by the base before event consumption. Not normally overridden —
   * register a participant instead.
   */
  protected resetTransientState(reason: DiscontinuityReason): void {
    for (const participant of this.transientResets) {
      participant.reset(reason);
    }
  }

  setEncounterRenderConfig(renderConfig?: EncounterRenderConfig): void {
    this.encounterRenderConfig = renderConfig;
    this.arenaBlock = getMapSquareBlock(renderConfig?.arenaMapSquareOffsets);
    this.declaredNpcTypes = this.declaredNpcTypeConfigs(renderConfig);
    this.declaredNpcTypeIds = [...this.declaredNpcTypes.keys()];
    const deathSpotAnimId = renderConfig?.primaryNpc?.deathSpotAnimId;
    this.declaredSpotAnimIds = [
      ...new Set([...(renderConfig?.spotAnimIds ?? []), ...(deathSpotAnimId === undefined ? [] : [deathSpotAnimId])]),
    ];
    this.npcInstanceManager.setPrimaryNpcRenderConfig(renderConfig?.primaryNpc ?? null);
    this.setSceneObjectController(renderConfig?.createSceneObjectController?.() ?? null);
  }

  protected setSceneObjectLocModelLoader(locModelLoader: SceneObjectLocModelLoader): void {
    this.sceneObjectRenderer = new SceneObjectRenderer(locModelLoader);
    this.sceneObjectRenderer.setTerrainHeights(this.terrainHeights);
  }

  protected setSceneObjectController(
    controller: SceneObjectController<SimulationState, SceneObjectLocData> | null,
  ): void {
    this.sceneObjectController = controller;
  }

  protected getSceneObjectRenderer(): SceneObjectRenderer | null {
    return this.sceneObjectRenderer;
  }

  loadTerrain(
    mapLoader: MapSquareLoader,
    underlayLoader?: UnderlayTypeLoader,
    overlayLoader?: OverlayTypeLoader,
    textureIndexMapper?: TextureIndexMapper,
    locations?: LocationData[],
    locTypeInfoLoader?: LocTypeInfoLoader,
    smoothTerrain?: boolean,
  ): Promise<void> {
    if (this.terrainLoad) return this.terrainLoad;
    if (this.cachedTerrainMeshes.length > 0 || this._disposed) return Promise.resolve();
    this.terrainLoad = this.buildTerrain(
      mapLoader,
      underlayLoader,
      overlayLoader,
      textureIndexMapper,
      locations,
      locTypeInfoLoader,
      smoothTerrain,
    ).finally(() => {
      this.terrainLoad = null;
    });
    return this.terrainLoad;
  }

  private async buildTerrain(
    mapLoader: MapSquareLoader,
    underlayLoader: UnderlayTypeLoader | undefined,
    overlayLoader: OverlayTypeLoader | undefined,
    textureIndexMapper: TextureIndexMapper | undefined,
    locations: LocationData[] | undefined,
    locTypeInfoLoader: LocTypeInfoLoader | undefined,
    smoothTerrain: boolean | undefined,
  ): Promise<void> {
    profiler.start('SceneCompositor.loadTerrain');
    this.textureIndexMapper = textureIndexMapper ?? null;
    this.smoothTerrain = smoothTerrain ?? false;
    this.lastTerrainArgs = { mapLoader, underlayLoader, overlayLoader, locations, locTypeInfoLoader };
    try {
      const meshes = await this.buildTerrainMeshes3D(
        mapLoader,
        underlayLoader,
        overlayLoader,
        locations,
        locTypeInfoLoader,
      );
      if (this._disposed) return;
      this.cachedTerrainMeshes = meshes;
      log.info('SceneBuilder', 'Terrain mesh loaded successfully');
      profiler.end('SceneCompositor.loadTerrain');
    } catch (error) {
      profiler.end('SceneCompositor.loadTerrain');
      if (this._disposed) return;
      log.error('SceneBuilder', 'Failed to load terrain mesh', error);
      throw error;
    }
  }

  setSmoothTerrain(enabled: boolean): void {
    if (this.smoothTerrain === enabled) return;
    this.smoothTerrain = enabled;
    this.terrainVersion++;
    if (this.lastTerrainArgs && this.cachedTerrainMeshes.length > 0) {
      this.cachedTerrainMeshes = [];
      const { mapLoader, underlayLoader, overlayLoader, locations, locTypeInfoLoader } = this.lastTerrainArgs;
      this.loadTerrain(
        mapLoader,
        underlayLoader,
        overlayLoader,
        this.textureIndexMapper ?? undefined,
        locations,
        locTypeInfoLoader,
        enabled,
      );
    }
  }

  isTerrainLoaded(): boolean {
    return this.cachedTerrainMeshes.length > 0;
  }

  getTerrainHeights(): Int32Array[] | null {
    return this.terrainHeights;
  }

  /** Whether `tile` is in one of the encounter's arena squares, where tile-space indicators may draw. */
  protected isInArenaFootprint(tile: Coordinate): boolean {
    return isTileInMapSquareBlock(this.arenaBlock, tile[0], tile[1]);
  }

  async loadNpc(npcModelLoader: NpcModelLoader, animSystem?: AnimationSystem): Promise<void> {
    if (this._disposed) return;
    this.npcLoadStarted = true;
    if (animSystem) {
      this.setAnimationSystem(animSystem);
    }
    await this.loadEncounterNpc(npcModelLoader, animSystem);
  }

  setAnimationSystem(animSystem: AnimationSystem): void {
    this.playerAnimationSystem = animSystem;
    this.spotAnimRenderer.setAnimationSystem(animSystem);
  }

  /**
   * Whether `loadNpc` has run and the primary NPC, if any, is drawable. False until `loadNpc` has run
   * even with no primary NPC to wait for: the viewport only calls `loadNpc` while this is false, and
   * that call is what hands the scene its animation system, without which the player and spot anims
   * would never animate. The other declared types load in the same call; a replay waits for them
   * through `encounterAssetState`.
   */
  isNpcLoaded(): boolean {
    const primaryNpc = this.encounterRenderConfig?.primaryNpc;
    return this.npcLoadStarted && (primaryNpc === undefined || this.isNpcTypeLoaded(primaryNpc.npcTypeId));
  }

  /** Clickboxes for picking: an NPC whose model a hiding plugin left undrawn is not clickable either. */
  getAllNpcHitTestData(): Array<{ actorId: string; hitTestData: NpcHitTestData }> {
    const all = this.npcInstanceManager.getAllHitTestData();
    const hidden = this.hiddenNpcRenderIds;
    return hidden.size === 0 ? all : all.filter(({ actorId }) => !hidden.has(actorId));
  }

  getAllGroundItemHitTestData(): Array<{ groundItemId: string; hitTestData: NpcHitTestData }> {
    return this.groundItemRenderer.getAllHitTestData();
  }

  /**
   * Source for the ground-item cache loaders. Read every frame rather than snapshotted,
   * because a scene builder is constructed before the cache finishes bootstrapping and
   * both loaders are still null at that point.
   */
  setGroundItemLoaderSource(source: GroundItemLoaderSource | null): void {
    this.groundItemLoaderSource = source;
  }

  async loadNpcType(
    npcTypeId: number,
    npcModelLoader: NpcModelLoader,
    animSystem?: AnimationSystem,
    config?: NpcTypeLoadConfig,
  ): Promise<void> {
    if (this._disposed) return;
    this.pendingNpcTypeLoadAttempts.set(npcTypeId, (this.pendingNpcTypeLoadAttempts.get(npcTypeId) ?? 0) + 1);
    try {
      await this.npcInstanceManager.loadNpcType(npcTypeId, npcModelLoader, animSystem, config);
      this.failedNpcTypeLoadAttempts.delete(npcTypeId);
    } catch (error) {
      this.failedNpcTypeLoadAttempts.add(npcTypeId);
      throw error;
    } finally {
      const remaining = (this.pendingNpcTypeLoadAttempts.get(npcTypeId) ?? 1) - 1;
      if (remaining > 0) this.pendingNpcTypeLoadAttempts.set(npcTypeId, remaining);
      else this.pendingNpcTypeLoadAttempts.delete(npcTypeId);
    }
  }

  isNpcTypeLoaded(npcTypeId: number): boolean {
    return this.npcInstanceManager.isNpcTypeLoaded(npcTypeId);
  }

  /** Whether `npcTypeId`'s last load failed and no retry is in flight: settled, with nothing to draw. */
  private isNpcTypeLoadFailed(npcTypeId: number): boolean {
    return !this.pendingNpcTypeLoadAttempts.has(npcTypeId) && this.failedNpcTypeLoadAttempts.has(npcTypeId);
  }

  async loadPlayer(
    playerModelLoader: PlayerModelLoader,
    appearance?: PlayerAppearance,
    equipment?: PlayerEquipment,
  ): Promise<void> {
    if (this.playerLoading || this._disposed) {
      return;
    }

    const newAppearance = appearance ?? this.playerAppearance;
    const newEquipment = equipment ?? this.playerEquipment;

    const configChanged =
      JSON.stringify(newAppearance) !== JSON.stringify(this.playerAppearance) ||
      JSON.stringify(newEquipment) !== JSON.stringify(this.playerEquipment);

    if (this.cachedPlayerMeshes.length > 0 && !configChanged) {
      return;
    }

    profiler.start('SceneCompositor.loadPlayer');
    this.playerLoading = true;

    const visuals = getWeaponCombatVisuals(newEquipment.weapon);
    if (this.spotAnimModelLoader && visuals && visuals.castSpotanim >= 0) {
      this.spotAnimRenderer.loadById(this.spotAnimModelLoader, visuals.castSpotanim);
    }
    if (this.spotAnimModelLoader && visuals && visuals.projectileId >= 0) {
      this.spotAnimRenderer.loadById(this.spotAnimModelLoader, visuals.projectileId);
    }

    try {
      const modelData = playerModelLoader.loadPlayerModel(newAppearance, newEquipment);

      const consumeSnapshot = this.playerAnimController?.getConsumeAnimSnapshot() ?? null;

      if (modelData) {
        modelData.mergedModel.calculateBounds();
        const nextModelBottomY = modelData.mergedModel.minHeight;

        let nextAnimController: PlayerAnimationController | null = null;
        if (this.playerAnimationSystem) {
          const originalVerticesX = new Int32Array(modelData.mergedModel.verticesX);
          const originalVerticesY = new Int32Array(modelData.mergedModel.verticesY);
          const originalVerticesZ = new Int32Array(modelData.mergedModel.verticesZ);
          const originalFaceAlphas = modelData.mergedModel.faceAlphas
            ? new Int8Array(modelData.mergedModel.faceAlphas)
            : null;

          const animSets = getWeaponAnimationSetWithFallbacks(newEquipment.weapon);
          const playerAnimationSet: PlayerAnimationSet = {
            idle: this.loadFrameBasedSeq(animSets, 'idle'),
            walk: this.loadFrameBasedSeq(animSets, 'walk'),
            run: this.loadFrameBasedSeq(animSets, 'run'),
            turnLeft: this.loadFrameBasedSeq(animSets, 'turnLeft'),
            turnRight: this.loadFrameBasedSeq(animSets, 'turnRight'),
            walkBack: this.loadFrameBasedSeq(animSets, 'turn180'),
            idleTurnLeft: this.loadFrameBasedSeq(animSets, 'turn180'),
            idleTurnRight: this.loadFrameBasedSeq(animSets, 'turn180'),
          };
          playerAnimationSet.eat = this.loadFrameBasedSeqById(PLAYER_EAT_SEQ_ID);
          playerAnimationSet.attack = this.loadFrameBasedSeq(animSets, 'attack');
          // Flinch clip. Keyed on the SHIELD first and the weapon only as a fallback, which
          // is how the servers key it — see `getPlayerBlockAnimations`.
          playerAnimationSet.block = this.loadFrameBasedSeqFromIds(
            getPlayerBlockAnimations(newEquipment.weapon, newEquipment.shield),
          );

          const unarmedSets = [DEFAULT_ANIMATION_SET];
          playerAnimationSet.unarmed = {
            idle: this.loadFrameBasedSeq(unarmedSets, 'idle'),
            walk: this.loadFrameBasedSeq(unarmedSets, 'walk'),
            run: this.loadFrameBasedSeq(unarmedSets, 'run'),
            turnLeft: this.loadFrameBasedSeq(unarmedSets, 'turnLeft'),
            turnRight: this.loadFrameBasedSeq(unarmedSets, 'turnRight'),
            walkBack: this.loadFrameBasedSeq(unarmedSets, 'turn180'),
            idleTurnLeft: this.loadFrameBasedSeq(unarmedSets, 'turn180'),
            idleTurnRight: this.loadFrameBasedSeq(unarmedSets, 'turn180'),
          };

          const adapter = new PlayerModelAdapter(
            modelData.mergedModel,
            originalVerticesX,
            originalVerticesY,
            originalVerticesZ,
            originalFaceAlphas,
            this.playerAnimationSystem,
            () => this.playerAnimController?.buildPlayerAnimatedMesh() ?? null,
            (updatedMesh) => this.applyPlayerAnimatedMesh(updatedMesh),
          );

          if (this.playerAnimController) {
            this.playerAnimController.updateModel({
              playerModelData: modelData,
              animationSet: playerAnimationSet,
              modelAdapter: adapter,
            });
            nextAnimController = this.playerAnimController;
          } else {
            nextAnimController = new PlayerAnimationController({
              playerModelData: modelData,
              animationSet: playerAnimationSet,
              modelAdapter: adapter,
              resolveTextureLayer: sharedModelTextureIndex.resolve,
            });
            if (consumeSnapshot) {
              try {
                nextAnimController.restoreConsumeAnim(consumeSnapshot);
              } catch (restoreError) {
                log.warn('SceneBuilder', 'Failed to restore consume animation, continuing without it', restoreError);
              }
            }
          }
        }

        const mesh = modelDataToPlayerMesh(modelData, undefined, sharedModelTextureIndex.resolve);
        const nextCachedMeshes = this.buildPlayerMesh3D(mesh);

        this.playerAppearance = newAppearance;
        this.playerEquipment = newEquipment;
        this.playerMeshVersion++;
        this.playerModelBottomY = nextModelBottomY;
        this.playerAnimController = nextAnimController;
        this.cachedPlayerMeshes = nextCachedMeshes;

        if (this.playerAnimController) {
          this.playerAnimController.applyInitialAnimationFrame();
        }
        log.info('SceneBuilder', 'Player mesh loaded successfully');
      } else {
        log.warn('SceneBuilder', 'Failed to load player model data');
      }
      profiler.end('SceneCompositor.loadPlayer');
    } catch (error) {
      profiler.end('SceneCompositor.loadPlayer');
      log.error('SceneBuilder', 'Failed to load player mesh', error);
      throw error;
    } finally {
      this.playerLoading = false;
    }
  }

  private loadFrameBasedSeq(animSets: WeaponAnimationSet[], slot: keyof WeaponAnimationSet): AnimationSequence | null {
    if (!this.playerAnimationSystem) return null;

    for (const animSet of animSets) {
      const seqId = animSet[slot];
      if (seqId === undefined) continue;
      const seqType = this.playerAnimationSystem.loadSeqType(seqId);
      if (!seqType || seqType.isSkeletalSeq()) {
        continue;
      }

      return this.playerAnimationSystem.createSequenceFromSeqType(seqType) ?? null;
    }

    return null;
  }

  private loadFrameBasedSeqById(seqId: number): AnimationSequence | null {
    if (!this.playerAnimationSystem) return null;
    const seqType = this.playerAnimationSystem.loadSeqType(seqId);
    if (!seqType || seqType.isSkeletalSeq()) return null;
    return this.playerAnimationSystem.createSequenceFromSeqType(seqType) ?? null;
  }

  private loadFrameBasedSeqFromIds(seqIds: readonly number[]): AnimationSequence | null {
    for (const seqId of seqIds) {
      const seq = this.loadFrameBasedSeqById(seqId);
      if (seq) return seq;
    }
    return null;
  }

  private flushPendingPlayerAttack(): void {
    if (!this.playerAnimController || !this.pendingPlayerAttack) return;

    const pending = this.pendingPlayerAttack;
    this.pendingPlayerAttack = null;

    const seq = this.loadFrameBasedSeqFromIds(playerAttackSequenceIds(pending));
    if (seq) {
      this.playerAnimController.triggerAttackWithSequence(seq);
    } else if (pending.kind === 'weapon') {
      this.playerAnimController.triggerAttack();
    }
  }

  protected getPlayerAnimationFrameState(): { seqId: number; currentFrameIndex: number } | null {
    return this.playerAnimController?.getFrameState() ?? null;
  }

  getPrimaryAnimMovementBlock(): { blocksRunning: boolean; blocksWalking: boolean } {
    return this.playerAnimController?.getPrimaryAnimMovementBlock() ?? { blocksRunning: false, blocksWalking: false };
  }

  protected loadPlayerSeqType(seqId: number): SeqType | null {
    if (!this.playerAnimationSystem) {
      return null;
    }
    return this.playerAnimationSystem.loadSeqType(seqId) ?? null;
  }

  /**
   * Every animation on screen that `FrameSoundTracker` should be watching: npcs, the player,
   * and spotanims. All three carry cache `frameSounds`, and a sound that hangs off a spotanim
   * (Yama's per-style attack cue, for one) exists ONLY there — it is absent from the packet
   * stream and from the npc's own clips, so dropping spotanims here silences it outright.
   */
  protected collectActorFrameStates(): ActorFrameState[] {
    const actorFrameStates: ActorFrameState[] = [];

    for (const { actorId, animController, center } of this.npcInstanceManager.getInstanceFrameStates()) {
      const frameState = animController?.getFrameState();
      if (!frameState) {
        continue;
      }
      actorFrameStates.push({
        actorId,
        seqId: frameState.seqId,
        currentFrame: frameState.currentFrameIndex,
        seqType: frameState.seqType,
        position: center,
      });
    }

    const playerFrameState = this.getPlayerAnimationFrameState();
    if (playerFrameState) {
      actorFrameStates.push({
        actorId: 'player',
        seqId: playerFrameState.seqId,
        currentFrame: playerFrameState.currentFrameIndex,
        seqType: this.loadPlayerSeqType(playerFrameState.seqId),
        position: this.getFrameSoundListenerPosition(),
      });
    }

    actorFrameStates.push(...this.spotAnimRenderer.getFrameStates());

    return actorFrameStates;
  }

  /**
   * Tile frame sounds attenuate against: the player's visual center, matching the center
   * `NpcInstanceManager` resolves for the player so an npc standing on the player reads as
   * distance 0.
   *
   * `build` sets the center before either compositor reaches the frame tracker, so the origin
   * fallback is unreachable rather than a real default — do not treat it as one.
   */
  protected getFrameSoundListenerPosition(): [number, number] {
    return this.lastPlayerVisualCenter ?? [0, 0];
  }

  private applyPlayerAnimatedMesh(meshPair: PlayerAnimatedMeshPair): void {
    if (this.cachedPlayerMeshes.length === 0) return;

    for (const cmd of this.cachedPlayerMeshes) {
      const isOpaque = cmd.meshId.endsWith('-opaque');
      const part = isOpaque ? meshPair.opaque : meshPair.transparent;
      if (part) {
        cmd.positions = part.positions;
        cmd.normals = part.normals;
        cmd.perVertexHslColors = part.hslColors;
        cmd.perVertexAlphas = part.alphas;
        cmd.perVertexFaceBias = part.faceBias;
        cmd.uvs = part.uvs;
        cmd.perVertexTextureIds = part.textureIds;
      } else {
        cmd.positions = new Float32Array(0);
        cmd.normals = new Float32Array(0);
      }
    }
  }

  isPlayerLoaded(): boolean {
    return this.cachedPlayerMeshes.length > 0;
  }

  async loadSpotAnims(spotAnimModelLoader: SpotAnimModelLoader): Promise<void> {
    if (this._disposed) return;
    this.spotAnimRenderer.bindLoader(spotAnimModelLoader);
    this.loadEncounterSpotAnims(spotAnimModelLoader);
    await this.loadPlayerGraphicSpotAnims(spotAnimModelLoader);
  }

  /** With a loader, also requires the effects to have been loaded from that loader. */
  isSpotAnimsLoaded(spotAnimModelLoader?: SpotAnimModelLoader): boolean {
    return (
      (!spotAnimModelLoader || this.spotAnimRenderer.isBoundTo(spotAnimModelLoader)) &&
      this.isEncounterSpotAnimsLoaded() &&
      this.isPlayerGraphicSpotAnimsLoaded()
    );
  }

  getResidentMeshSources(): readonly ImmutableMeshSource[] {
    return this.spotAnimRenderer.getResidentMeshSources();
  }

  async loadPlayerGraphicSpotAnims(spotAnimModelLoader: SpotAnimModelLoader): Promise<void> {
    this.spotAnimModelLoader = spotAnimModelLoader;
    this.spotAnimRenderer.bindLoader(spotAnimModelLoader);
    this.spotAnimRenderer.preload(spotAnimModelLoader, PLAYER_GRAPHIC_PRELOAD_IDS);
  }

  /** With a loader, also requires the effects to have been loaded from that loader. */
  isPlayerGraphicSpotAnimsLoaded(spotAnimModelLoader?: SpotAnimModelLoader): boolean {
    return (
      (!spotAnimModelLoader || this.spotAnimRenderer.isBoundTo(spotAnimModelLoader)) &&
      PLAYER_GRAPHIC_PRELOAD_IDS.every((id) => this.spotAnimRenderer.isLoaded(id))
    );
  }

  protected onEncounterEvents(_events: GameEvent[], _context: RenderContext): void {}

  /**
   * Brings the cue player to the frame, then applies this frame's removals: live, it takes the new
   * batches; in replay, what the history owes at the destination, rebuilt on a seek, a new history or
   * a restore. Runs before actors are synced, so a removal never takes the actors that replace the
   * removed ones.
   *
   * An actor the simulation removed outright (`actor_despawned`, an OSRS `del`) leaves nothing drawn:
   * no model or corpse, and (the cue player's own reading of the removal) no clip still to start and
   * no graphic riding it. `actor_presentations_removed` drops every presentation of its NPC types,
   * corpses the simulation already pruned included.
   */
  private syncEncounterCues(events: readonly GameEvent[], ctx: RenderContext): void {
    this.syncEncounterCueSource(events, ctx);
    for (const event of events) {
      if (isCoreEvent(event, 'actor_despawned'))
        this.npcInstanceManager.removePresentation(this.actorRenderIdOf(event.actorId));
      else if (isActorPresentationsRemovedEvent(event))
        this.npcInstanceManager.removePresentationsByNpcType(event.npcTypeIds);
    }
  }

  /**
   * A replay frame shown before the encounter's assets settle holds no cues; readiness retries it.
   * Such a frame, one that rebuilds the cues and one initializing a restored presentation all
   * advance nothing, so their frame sounds sync silently.
   */
  private syncEncounterCueSource(events: readonly GameEvent[], ctx: RenderContext): void {
    const history = ctx.replayHistory;
    const index = this.replayEffectIndex;
    if (!history || !index) {
      this.cues.consumeEvents(events, ctx.simulationState);
      this.cueHistory = undefined;
      this.historicalCorpsesPending = false;
      return;
    }
    if (ctx.options.renderMode === '2d') this.historicalCorpsesPending = true;
    if (ctx.restoredPresentation) this.reconstructedVisuals = true;
    if (this.encounterAssetState() === 'pending') {
      if (this.cueHistory) this.cues.clear();
      this.cueHistory = undefined;
      this.reconstructedVisuals = true;
      return;
    }
    const rebuild = history.frames !== this.cueHistory || this.lastDiscontinuityReason !== null;
    this.cues.syncReplay(index, { cycle: this.primaryCycle, throughFrameIndex: history.throughFrameIndex }, rebuild);
    this.cueHistory = history.frames;
    if (!rebuild) return;
    this.historicalCorpsesPending = true;
    this.reconstructedVisuals = true;
    // Rebuilt actors restart the cycle clock at the destination; skipped history is not replayed.
    this.npcAnimationCycle = null;
  }

  /** How the scene draws a cue graphic (depth bias, view culling); the default style unless overridden. */
  protected encounterGraphicStyle(_cue: EncounterGraphicCue): SpotAnimStyle | undefined {
    return undefined;
  }

  /**
   * Where an `attached` graphic rides `actorId` this frame: the player's rendered tile center on the
   * ground, or an NPC's rendered model (position and facing) while it stands; null while it is not drawn.
   */
  protected resolveAttachedActor(
    actorId: string,
    state: Pick<SimulationState, 'npcs'>,
    playerVisualPosition: readonly [number, number],
  ): SpotAnimTransform | null {
    if (actorId === PLAYER_ACTOR_ID) {
      const x = playerVisualPosition[0] + 0.5;
      const y = playerVisualPosition[1] + 0.5;
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

  /**
   * The tick an NPC's drawn life starts, bounding the cue clips a seek restores on it: its spawn tick
   * unless the encounter presents it earlier.
   */
  protected presentedFromTick(npc: NpcSnapshot, _state: SimulationState): number {
    return npc.spawnTick ?? 0;
  }

  /** The render config's clip keys for `actorId`'s NPC type, the primary NPC's alias included. */
  private attackClipsOf(actorId: string, state: Pick<SimulationState, 'npcs'>): Record<string, number> | undefined {
    const primary = this.encounterRenderConfig?.primaryNpc;
    const npcTypeId =
      actorId === primary?.actorId ? primary.npcTypeId : state.npcs.find((npc) => npc.id === actorId)?.npcTypeId;
    return npcTypeId === undefined ? undefined : this.declaredNpcTypes.get(npcTypeId)?.attackClips;
  }

  protected reconstructEncounterVisuals(_context: RenderContext): void {}

  /**
   * Restores replayed NPC poses, returning whether it did (live triggers are then skipped). At the
   * displayed cycle and after the NPC clock reaches it: each standing actor's cue clips from its
   * timeline, within its presented life, every snapshot corpse at its exact age, so continuous replay
   * shows the frame a seek would, and the encounter's own timelines. Cue clips wait, like the rest of
   * the cue player, until the frame's cues are synced (not while the encounter's assets are pending);
   * the snapshot's corpses and the encounter's own timelines need nothing of it. Live triggers never
   * run in replay.
   */
  private restoreEncounterPrimaries(ctx: RenderContext): boolean {
    const history = ctx.replayHistory;
    const index = this.replayEffectIndex;
    if (!history || !index) return false;
    const cuesSynced = history.frames === this.cueHistory;
    const cycle = this.primaryCycle;
    this.advanceNpcAnimationClock(cycle);
    const { npcs } = ctx.simulationState;
    for (const npc of npcs) {
      const actorId = this.npcRenderIdOf(npc);
      if (!isNpcStandingAt(npc, cycle)) {
        if (npc.despawnTick !== undefined)
          this.npcInstanceManager.reconstructDyingInstance(
            actorId === npc.id ? npc : { ...npc, id: actorId },
            Math.max(0, cycle / 30 - npc.despawnTick) * OSRS_TICK_MS,
          );
        continue;
      }
      const timeline = cuesSynced ? index.cues.primaryTimeline(npc.id) : undefined;
      if (!timeline) continue;
      if (
        this.npcInstanceManager.restoreDeferredReplayAnimation(actorId, timeline, {
          cycle,
          throughFrameIndex: history.throughFrameIndex,
          spawnTick: this.presentedFromTick(npc, ctx.simulationState),
        })
      )
        this.reconstructedVisuals = true;
    }
    if (this.restoreEncounterTimelines({ cycle, throughFrameIndex: history.throughFrameIndex }))
      this.reconstructedVisuals = true;
    return true;
  }

  /**
   * Restores, at the destination, any primary timeline the encounter keeps beside its cue clips (its
   * `createEncounterReplayReader`'s), once the NPC clock has reached it; returns whether one was
   * rebuilt rather than continued. None by default.
   */
  protected restoreEncounterTimelines(_destination: ReplayEffectDestination): boolean {
    return false;
  }

  /**
   * The encounter's own reader of a new replay history, fed in the shared index's append pass beside
   * the cue, actor and player readers; read back through `replayEffectIndex.encounter`. None by default.
   */
  protected createEncounterReplayReader(): ReplayFrameReader | undefined {
    return undefined;
  }

  /**
   * On a 3D replay frame while `historicalCorpsesPending`: the corpses still on display whose NPCs the
   * simulation already pruned, from history, at their age at the destination. After the NPC clock
   * reaches it and before the models are queued, so the frame draws them as posed. A frame whose cues
   * are not synced (assets still pending) leaves them to the next.
   */
  private reconstructPrunedCorpses(npcs: readonly NpcSnapshot[]): void {
    const index = this.replayEffectIndex;
    const throughFrameIndex = this.replayThroughFrameIndex;
    if (!this.historicalCorpsesPending || !index || throughFrameIndex === undefined) return;
    if (this.cueHistory !== index.frames) return;
    this.historicalCorpsesPending = false;
    const liveActorIds = new Set<string>();
    for (const npc of npcs) if (npc.alive) liveActorIds.add(this.npcRenderIdOf(npc));
    for (const presentation of index.deathPresentations(
      { cycle: this.primaryCycle, throughFrameIndex },
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

  private restorePlayerPrimary(ctx: RenderContext): void {
    const history = ctx.replayHistory;
    const index = this.replayEffectIndex;
    const controller = this.playerAnimController;
    const system = this.playerAnimationSystem;
    if (!history || !index || !controller || !system) {
      this.replayPlayerController = null;
      return;
    }
    const metadata = system.loadSeqType(PLAYER_EAT_SEQ_ID) ?? system;
    const result = index.playerPrimaryTimeline.sample(
      { cycle: this.primaryCycle, throughFrameIndex: history.throughFrameIndex },
      metadata,
      (cue) => {
        for (const id of cue.sequenceIds) {
          const type = system.loadSeqType(id);
          if (!type) continue;
          if (type.isSkeletalSeq()) continue;
          const sequence = system.createSequenceFromSeqType(type);
          if (sequence) return playerPrimarySpec(sequence, cue.kind);
        }
        return null;
      },
    );
    controller.restorePrimaryAt(result.primary);
    if (result.rebuilt || this.replayPlayerController !== controller) this.reconstructedVisuals = true;
    this.replayPlayerController = controller;
  }

  protected prepareReplaySpotAnim(spotAnimId: number): void {
    if (spotAnimId < 0) return;
    if (this.spotAnimModelLoader) this.spotAnimRenderer.loadById(this.spotAnimModelLoader, spotAnimId);
    if (this.spotAnimRenderer.isLoaded(spotAnimId)) {
      if (this.pendingReplaySpotAnims.delete(spotAnimId)) this.reconstructedVisuals = true;
    } else this.pendingReplaySpotAnims.add(spotAnimId);
  }

  setEventAudioPlayer(player: EventAudioPlayer | null): void {
    this.eventAudioPlayer = player;
  }

  /** Plays the sounds embedded in the frames of every drawn clip and spot animation, once per frame. */
  setFrameSoundTracker(tracker: FrameSoundTracker | null): void {
    this.frameSoundTracker = tracker;
  }

  /** Sync NPC instances for rendering. Default: sync as-is. Override to remap IDs. */
  protected syncNpcInstances(
    npcs: NpcSnapshot[],
    is2D: boolean,
    simulationState?: SimulationState,
    paused = false,
  ): void {
    const primaryNpc = this.encounterRenderConfig?.primaryNpc;
    // An encounter with a primary NPC waits for its model; one without (e.g. the Inferno) syncs
    // every snapshot NPC whose type has loaded.
    if (is2D || (primaryNpc && !this.isNpcTypeLoaded(primaryNpc.npcTypeId))) return;
    const remappedNpcs = primaryNpc
      ? npcs.map((npc) => {
          const id = this.actorRenderIdOf(npc.id);
          // An NPC fighting the encounter's primary NPC must resolve against the same
          // alias, so anything tracking the boss (e.g. Zuk's enrage healer) aims at the
          // PRIMARY_NPC_ACTOR_ID instance.
          const target = npc.combatTargetId;
          const combatTargetId = target ? this.actorRenderIdOf(target) : target;
          if (id === npc.id && combatTargetId === target) return npc;
          const remapped: NpcSnapshot = { ...npc, id };
          if (combatTargetId !== target) remapped.combatTargetId = combatTargetId;
          return remapped;
        })
      : npcs;
    this.npcInstanceManager.syncInstances(
      remappedNpcs,
      this.npcInterpFraction,
      this.primaryCycle,
      simulationState?.currentTick,
    );
    if (!simulationState) return;

    const shouldReconcile =
      this.needsDeathReconciliation ||
      this.lastDiscontinuityReason !== null ||
      (paused && this.lastDeathReconciliationTick !== simulationState.currentTick);
    if (!shouldReconcile) return;
    this.needsDeathReconciliation = false;
    this.lastDeathReconciliationTick = simulationState.currentTick;

    // A jump keeps a live instance but drops in-flight corpses, so without this a seek past an
    // NPC's death restarts its clip from frame 0 (re-arming the clip's frame sounds) or loses the
    // corpse entirely. Its age since `despawnTick` puts it back on the right frame.
    const presentationTick = simulationState.currentTick + this.npcInterpFraction;
    for (const npc of remappedNpcs) {
      if (npc.alive || npc.role === 'boss' || npc.despawnTick === undefined) continue;
      this.npcInstanceManager.reconstructDyingInstance(
        npc,
        Math.max(0, presentationTick - npc.despawnTick) * OSRS_TICK_MS,
      );
    }

    const outcome = simulationState.encounterOutcome;
    if (!primaryNpc || outcome.phase === 'active' || outcome.primaryActorId !== primaryNpc.actorId) return;
    const deadPrimary = remappedNpcs.find((npc) => npc.id === PRIMARY_NPC_ACTOR_ID && !npc.alive);
    if (!deadPrimary) return;
    const elapsedMs = Math.max(0, simulationState.currentTick - outcome.decisiveTick) * OSRS_TICK_MS;
    this.npcInstanceManager.reconstructDyingInstance(deadPrimary, elapsedMs);
  }

  /**
   * Live visual-position lookup for projectile homing. OSRS projectiles re-read
   * their target actor's position every cycle, so renderers must resolve against
   * the interpolated render position rather than the launch-time snapshot.
   * Returns null for actors with no live instance, which leaves a projectile
   * aimed where its target was last seen.
   */
  protected createActorVisualPositionResolver(playerVisualPos: readonly [number, number]): ActorVisualPositionResolver {
    return (actorId) => {
      if (actorId === PLAYER_ACTOR_ID) return playerVisualPos;
      return this.npcInstanceManager.getVisualPosition(this.actorRenderIdOf(actorId));
    };
  }

  /** Render encounter 3D effects early (after terrain, before NPC rendering). */
  protected renderEncounterEffectsEarly(
    _queue: RenderQueue,
    _currentTick: number,
    _interpolatedTick: number,
    _mechanicsConfig: SimulationState['mechanicsConfig'],
    _options: SceneOptions,
  ): void {}

  protected renderEncounterEffectsLate(
    _queue: RenderQueue,
    _projection: Projection2D,
    _currentTick: number,
    _interpolatedTick: number,
    _simulationState: SimulationState,
    _mechanicsConfig: SimulationState['mechanicsConfig'],
    _is2D: boolean,
    _options: SceneOptions,
  ): void {}

  protected renderEncounterDebugOverlays(
    _queue: RenderQueue,
    _projection: Projection2D,
    _simulationState: SimulationState,
    _interpolatedTick: number,
    _is2D: boolean,
    _debugFlags: Record<string, boolean | number>,
  ): void {}

  protected renderEncounterNpc2D(
    _queue: RenderQueue,
    _projection: Projection2D,
    _simulationState: SimulationState,
  ): void {}

  /** Turns NPCs toward their targets on the NPC clock: by the displayed cycles since it last advanced. */
  private updateEncounterNpcFacing(playerVisualPosition: [number, number]): number {
    const elapsed = this.npcAnimationCycle === null ? 0 : Math.max(0, this.primaryCycle - this.npcAnimationCycle);
    return this.npcInstanceManager.updateNpcVisualFacing(playerVisualPosition, elapsed * CLIENT_TICK_MS) ?? 0;
  }

  /**
   * Plays, on the NPC clock, each cue clip due by now and each trigger the encounter derives from its
   * snapshot (`encounterNpcTriggers`), each at its own start cycle, in start order (emission order,
   * then the encounter's, within a cycle), stepping the clock to each start and then to now. A cue clip
   * on an actor no longer standing, or under a clip key its type does not declare, is skipped; one of an
   * actor life that has ended never reaches here (see `ActorCueLife`).
   */
  private advanceNpcAnimationsToTick(state: SimulationState, interpolatedTick = state.currentTick): void {
    const cycle = interpolatedTick * 30;
    this.startNpcAnimationClock(state.currentTick * 30);
    const due: { readonly cycle: number; readonly trigger: NpcAnimationTrigger }[] = [];
    for (const { cue, cycle: start } of this.cues.takeAnimations(cycle)) {
      // Only on an actor still standing when it starts, as a replayed pose is: one killed on the cue's
      // tick may still swing until its death animation (B:3356), a corpse never does.
      if (!state.npcs.some((npc) => npc.id === cue.actorId && isNpcStandingAt(npc, start))) continue;
      if (this.attackClipsOf(cue.actorId, state)?.[cue.clipId] === undefined) continue;
      // A fresh trigger each time: the instance manager keeps one whose model has not loaded yet.
      due.push({
        cycle: start,
        trigger: {
          actorId: this.actorRenderIdOf(cue.actorId),
          trigger: 'attack',
          clipId: cue.clipId,
          tick: start / 30,
        },
      });
    }
    for (const trigger of this.encounterNpcTriggers(state))
      due.push({ cycle: (trigger.tick ?? state.currentTick) * 30, trigger });
    // Stable: same-cycle triggers keep the order above.
    due.sort((left, right) => left.cycle - right.cycle);
    for (const { cycle: start, trigger } of due) {
      this.advanceNpcAnimationClock(start);
      this.npcInstanceManager.updateAnimations(0, 1, [trigger]);
    }
    this.advanceNpcAnimationClock(cycle);
  }

  /**
   * Triggers the encounter derives from this frame's snapshot rather than from cue clips, such as a
   * boss body animation with its own priority and delay; played on the NPC clock from their tick. None
   * by default.
   */
  protected encounterNpcTriggers(_state: SimulationState): readonly NpcAnimationTrigger[] {
    return [];
  }

  protected renderEncounterAttackEffects(
    _currentTick: number,
    _interpolatedTick: number,
    _playerVisualPos: [number, number],
    _npcPosition: Coordinate,
    _npcFacingAngle: number,
    _playerFacingAngle: number,
    _mechanicsConfig: SimulationState['mechanicsConfig'],
    _is2D: boolean,
  ): void {}

  private loadEncounterSpotAnims(spotAnimModelLoader: SpotAnimModelLoader): void {
    if (this.declaredSpotAnimIds.length > 0)
      this.spotAnimRenderer.preload(spotAnimModelLoader, [...this.declaredSpotAnimIds]);
  }

  /** Whether every effect the render config declares has settled, usable or not. */
  private isEncounterSpotAnimsLoaded(): boolean {
    const ids = this.declaredSpotAnimIds;
    for (let index = 0; index < ids.length; index++)
      if (!this.spotAnimRenderer.isLoaded(ids[index] as number)) return false;
    return true;
  }

  /**
   * Loads every NPC type the render config declares, once each: the primary NPC with its preload
   * entry's clips and its death settings, and every other `preloadNpcTypes` entry as declared. A type
   * that fails to load is settled but unusable and does not stop the others; only the primary's
   * failure rejects, since the scene cannot be ready without it.
   */
  private async loadEncounterNpc(npcModelLoader: NpcModelLoader, animSystem?: AnimationSystem): Promise<void> {
    const primaryNpcTypeId = this.encounterRenderConfig?.primaryNpc?.npcTypeId;
    const pending = [...this.declaredNpcTypes]
      .filter(([npcTypeId]) => !this.isNpcTypeLoaded(npcTypeId))
      .map(async ([npcTypeId, config]) => {
        try {
          await this.loadNpcType(npcTypeId, npcModelLoader, animSystem, config);
        } catch (error) {
          if (npcTypeId === primaryNpcTypeId) throw error;
          log.error('SceneBuilder', `Failed to load encounter NPC type ${npcTypeId}`, error);
        }
      });
    await Promise.all(pending);
  }

  /** Each NPC type `config` declares, with the settings it loads with. */
  private declaredNpcTypeConfigs(config: EncounterRenderConfig | undefined): Map<number, NpcTypeLoadConfig> {
    const types = new Map<number, NpcTypeLoadConfig>();
    const primaryNpc = config?.primaryNpc;
    if (primaryNpc) {
      const preload = config.preloadNpcTypes?.find((type) => type.npcTypeId === primaryNpc.npcTypeId);
      types.set(primaryNpc.npcTypeId, { ...preload, ...this.getPrimaryNpcDeathLoadConfig(primaryNpc) });
    }
    for (const type of config?.preloadNpcTypes ?? []) {
      if (!types.has(type.npcTypeId)) types.set(type.npcTypeId, type);
    }
    return types;
  }

  /**
   * Whether the encounter's declared assets can be drawn: `pending` while any NPC type or effect is
   * still loading or not yet requested, `unavailable` once all have settled but some could not be
   * loaded (a failed NPC model, an effect the cache could not supply), else `ready`.
   */
  private encounterAssetState(): EncounterAssetState {
    // Checked every replay frame: indexed loops over lists derived once, when the config was set.
    let unavailable = false;
    const npcTypeIds = this.declaredNpcTypeIds;
    for (let index = 0; index < npcTypeIds.length; index++) {
      const npcTypeId = npcTypeIds[index] as number;
      if (this.isNpcTypeLoaded(npcTypeId)) continue;
      if (!this.isNpcTypeLoadFailed(npcTypeId)) return 'pending';
      unavailable = true;
    }
    if (!this.isEncounterSpotAnimsLoaded()) return 'pending';
    const spotAnimIds = this.declaredSpotAnimIds;
    for (let index = 0; !unavailable && index < spotAnimIds.length; index++)
      if (!this.spotAnimRenderer.isUsable(spotAnimIds[index] as number)) unavailable = true;
    return unavailable ? 'unavailable' : 'ready';
  }

  private getPrimaryNpcDeathLoadConfig(primaryNpc: NpcRenderConfig): NpcTypeLoadConfig {
    return {
      deathSeqId: primaryNpc.deathSeqId,
      bossDeathAnimationEnabled: true,
      ...(primaryNpc.deathRetentionTicks === undefined
        ? {}
        : { deathDurationMs: primaryNpc.deathRetentionTicks * OSRS_TICK_MS }),
    };
  }

  protected getTerrainMapSquare(): { x: number; y: number } {
    const mapSquare = this.encounterRenderConfig?.terrainMapSquare;
    if (!mapSquare) {
      throw new Error(
        'getTerrainMapSquare(): encounterRenderConfig.terrainMapSquare is not set. ' +
          'Set it on the EncounterRenderConfig, or override getTerrainMapSquare() in the subclass.',
      );
    }
    return mapSquare;
  }

  /**
   * Get arena grid bounds for grid line rendering. Override per encounter.
   * Returns null if there are no specific arena bounds (grid draws full viewport).
   */
  protected getGridBounds(): { minX: number; maxX: number; minY: number; maxY: number } | null {
    return getArenaBounds() ?? this.terrainBounds;
  }

  protected getArenaWalkabilityChecker(): ((x: number, y: number) => boolean) | null {
    const tiles = getWalkableTiles();
    if (!tiles) {
      this.arenaWalkabilityChecker = null;
      this.arenaWalkabilityCheckerSource = null;
      return null;
    }
    if (this.arenaWalkabilityCheckerSource !== tiles || !this.arenaWalkabilityChecker) {
      this.arenaWalkabilityCheckerSource = tiles;
      const lookup = this.walkableLookup;
      this.arenaWalkabilityChecker = (x: number, y: number) => lookup.get(tiles).has(x, y);
    }
    return this.arenaWalkabilityChecker;
  }

  async loadLocs(locModelLoader: LocModelLoader, locsWithTypes: LocWithType[]): Promise<void> {
    if (this._disposed) return;
    const options = this.getLocRenderOptions();
    const filter = resolveLocRenderFilter(options);
    this.surfaceHeightResolver.setGroundDecorations(
      locsWithTypes.flatMap((entry) => {
        const resolved = resolveRenderLoc(entry, filter, locModelLoader);
        if (!resolved || resolved.location.type !== LocModelType.FLOOR_DECORATION) return [];
        const { location, locType } = resolved;
        return [{ x: location.localX, y: location.localY, plane: location.level, raise: locType.raise }];
      }),
    );
    this.locRenderer.setTerrainHeights(this.terrainHeights);
    locModelLoader.setTextureLayerResolver(sharedModelTextureIndex.resolve);
    this.setSceneObjectLocModelLoader(locModelLoader);
    await this.locRenderer.load(locModelLoader, locsWithTypes, options);
  }

  /**
   * Per-encounter loc-render filter, resolved by the shared
   * {@link resolveEncounterLocRenderOptions} so viewport interaction filters identically.
   * With no declared config the renderer falls back to the default self-contained-arena
   * filter (clip to global arena bounds + 5 tiles, level 0 only). Subclasses can
   * override for non-data-driven behavior.
   */
  protected getLocRenderOptions(): LocRenderOptions | undefined {
    return resolveEncounterLocRenderOptions(this.encounterRenderConfig);
  }

  isLocsLoaded(): boolean {
    return this.locRenderer.isLoaded();
  }

  isIntroAnimationComplete(): boolean {
    if (this.pendingIntroSeqId !== null) return false;
    return this._introAnimStarted && !this._introAnimPlaying && this._introAnimComplete;
  }

  /**
   * Wall-clock ms until the playing intro animation ends at the current speed, assuming frames keep
   * coming; null until it is playing at the requested tempo (its sequence may still be loading,
   * or an FPS-capped renderer may not have built at the new tempo yet) and once it ends.
   */
  getIntroAnimationRemainingMs(expectedSpeedMultiplier: number): number | null {
    if (!this._introAnimPlaying || expectedSpeedMultiplier !== this.speedMultiplier) return null;
    const remainingAnimMs = this.playerAnimController?.getIntroRemainingAnimMs() ?? null;
    return remainingAnimMs === null ? null : remainingAnimMs / this.speedMultiplier;
  }

  resetIntroState(): void {
    // Scene transitions reuse the same uniform transient reset as a replay
    // discontinuity, across base AND subclass participants, so nothing (including
    // encounter effect controllers) leaks between scenes.
    this.resetTransientState('timeline-change');
  }

  /**
   * Clear all encounter-specific transient visual state.
   * Called on scene transitions and tick-backward jumps to ensure
   * nothing from a previous encounter persists (hitsplats, health bars,
   * player spotanims, projectiles).
   */
  private clearEncounterVisuals(reason: DiscontinuityReason = 'timeline-change'): void {
    this.pendingReplaySpotAnims.clear();
    this.previousEffectFrame = undefined;
    this.needsDeathReconciliation = true;
    this.lastDeathReconciliationTick = undefined;
    this.lastProcessedEventId = -1;
    this.lastPlayedAudioEventId = -1;
    this._introAnimPlaying = false;
    this._introAnimStarted = false;
    this._introAnimComplete = false;
    this.pendingIntroSeqId = null;
    this.pendingPlayerAttack = null;
    this.projectileTargetId = null;
    this.uiOverlayRenderer.dispose();
    this.playerGraphicController.dispose();
    this.projectileController.dispose();
    // Drop in-flight death fades, the one-shot NPC attack-trigger dedup, and any
    // persisted per-instance attack/death animation clips so nothing from a
    // future/previous tick survives the jump; the next sync rebuilds from snapshot.
    this.npcInstanceManager.resetTransientState();
    // The player's animation controller carries a queued-signal list plus a
    // mid-flight primary sequence (attack / eat / intro) and its frame
    // accumulators. Left alone, a seek freezes the player in a half-finished
    // swing from the tick that was jumped away from.
    this.playerAnimController?.reset();
    // Base-owned catch-all for spot anims: encounter controllers despawn the
    // groups they own, but one-shot / ungrouped instances would otherwise hang
    // in the air across the jump. Keeps the (static) mesh cache.
    this.spotAnimRenderer.clearActiveInstances();
    // Scene objects hold deterministic baked geometry keyed by bakeKey, not timeline state.
    // Re-anchor animation phase on a scrub; clear only on a real scene or timeline swap.
    if (reason === 'timeline-change') {
      this.clearSceneObjects();
    } else {
      this.sceneObjectRenderer?.resetTimeline();
    }
  }

  private clearSceneObjects(): void {
    this.sceneObjectRenderer?.clear();
  }

  private syncAndRenderSceneObjects(
    queue: RenderQueue,
    currentTick: number,
    interpolatedTick: number,
    simulationState: SimulationState,
    unprocessedEvents: readonly GameEvent[],
    hiddenLocIds: ReadonlySet<number>,
    fightStartCountdown: FightStartCountdownPhase | undefined,
  ): void {
    const renderer = this.sceneObjectRenderer;
    if (!renderer) {
      return;
    }

    renderer.setTerrainHeights(this.terrainHeights);
    const controller = this.sceneObjectController;
    if (!controller) {
      renderer.clear();
      return;
    }

    controller.consumeEvents(unprocessedEvents);
    const specs = controller.update({
      currentTick,
      interpolatedTick,
      state: simulationState,
      terrainHeights: this.terrainHeights,
      fightStartCountdown,
    });
    renderer.sync(specs, currentTick);
    renderer.render(queue, currentTick, interpolatedTick, hiddenLocIds);
  }

  dispose(): void {
    this._disposed = true;
    this.replayEffectIndexes = new WeakMap();
    this.replayEffectIndex = undefined;
    this.pendingNpcTypeLoadAttempts.clear();
    this.failedNpcTypeLoadAttempts.clear();
    this.pendingReplaySpotAnims.clear();

    this.cachedTerrainMeshes = [];
    this.terrainHeights = null;
    this.surfaceHeightResolver.clear();
    this.terrainBounds = null;
    this.cachedTileGrid = null;
    this.walkableLookup.clear();
    this.arenaWalkabilityChecker = null;
    this.arenaWalkabilityCheckerSource = null;
    this.arenaBoundaryPairs = null;
    this.arenaBoundaryPairsKey = '';
    this.textureIndexMapper = null;
    this.lastTerrainArgs = null;
    this.cachedPlayerMeshes.length = 0;
    this.cachedTileOutlines3DCommands.length = 0;
    this.cachedTileOutlines3DKey = '';
    this.playerAnimController = null;
    this.playerAnimationSystem = null;
    this.spotAnimModelLoader = null;
    this.eventAudioPlayer = null;
    this.frameSoundTracker = null;
    this.cues.clear();
    this.cueHistory = undefined;
    this.historicalCorpsesPending = false;
    this.projectileTargetId = null;
    this.lastProcessedEventId = -1;
    this.lastPlayedAudioEventId = -1;
    this.pendingIntroSeqId = null;
    this.pendingPlayerAttack = null;
    this.npcAnimationCycle = null;
    this.reusableQueue = null;

    this.locRenderer.dispose();
    this.groundItemRenderer.dispose();
    this.sceneObjectRenderer?.clear();
    this.sceneObjectRenderer = null;
    this.sceneObjectController = null;
    this.spotAnimRenderer.dispose();
    this.npcInstanceManager.dispose();
    this.uiOverlayRenderer.dispose();
    this.playerGraphicController.dispose();
    this.projectileController.dispose();
  }

  private getUnprocessedEvents(events: GameEvent[]): GameEvent[] {
    if (events.length === 0) {
      return [];
    }

    const unprocessed: GameEvent[] = [];
    for (const event of events) {
      if (event.eventId <= this.lastProcessedEventId) {
        continue;
      }
      unprocessed.push(event);
      this.lastProcessedEventId = event.eventId;
    }
    return unprocessed;
  }

  private getUnplayedAudioEvents(events: GameEvent[]): GameEvent[] {
    if (events.length === 0) {
      return [];
    }

    const unplayed: GameEvent[] = [];
    for (const event of events) {
      if (event.eventId <= this.lastPlayedAudioEventId) {
        continue;
      }
      unplayed.push(event);
      this.lastPlayedAudioEventId = event.eventId;
    }
    return unplayed;
  }

  private buildPlayerMesh3D(mesh: {
    positions: Float32Array;
    hslColors: Float32Array;
    alphas: Float32Array;
    normals?: Float32Array;
    faceBias?: Float32Array;
    uvs?: Float32Array;
    textureIds?: Float32Array;
  }): NpcMesh3DCommand[] {
    const SCALE = 1 / 128;

    const modelMatrix = new Float32Array([SCALE, 0, 0, 0, 0, 0, -SCALE, 0, 0, SCALE, 0, 0, 0, 0, 0, 1]);

    const normals = mesh.normals ?? new Float32Array(mesh.positions.length);

    const split = splitTriangleSoupByAlpha({
      positions: mesh.positions,
      normals,
      hslColors: mesh.hslColors,
      alphas: mesh.alphas,
      faceBias: mesh.faceBias,
      uvs: mesh.uvs,
      textureIds: mesh.textureIds,
    });

    const result: NpcMesh3DCommand[] = [];
    if (split.opaque) {
      result.push({
        kind: 'mesh3d',
        meshId: `player-model-v${this.playerMeshVersion}-opaque`,
        materialId: 'osrs-npc',
        modelMatrix,
        positions: split.opaque.positions,
        normals: split.opaque.normals,
        perVertexHslColors: split.opaque.hslColors,
        perVertexAlphas: split.opaque.alphas,
        perVertexFaceBias: split.opaque.faceBias,
        uvs: split.opaque.uvs,
        perVertexTextureIds: split.opaque.textureIds,
        depth: 'sorted',
        // Cull the flat down-facing base cap at model Y=0 (coplanar with terrain) so it does not z-fight the floor.
        cullFace: 'back',
        zIndex: Z_LAYERS.PLAYER + 10,
        animated: true,
      });
    }
    if (split.transparent) {
      result.push({
        kind: 'mesh3d',
        meshId: `player-model-v${this.playerMeshVersion}-transparent`,
        materialId: 'osrs-npc',
        modelMatrix,
        positions: split.transparent.positions,
        normals: split.transparent.normals,
        perVertexHslColors: split.transparent.hslColors,
        perVertexAlphas: split.transparent.alphas,
        perVertexFaceBias: split.transparent.faceBias,
        uvs: split.transparent.uvs,
        perVertexTextureIds: split.transparent.textureIds,
        depth: 'read',
        cullFace: 'back',
        blend: 'normal',
        zIndex: Z_LAYERS.PLAYER + 10,
        animated: true,
      });
    }
    return result;
  }

  private createPlayerModelMatrix(
    scale: number,
    worldX: number,
    worldY: number,
    terrainHeight: number,
    facingAngle: number,
  ): Float32Array {
    const s = scale;
    const theta = (facingAngle / 2048) * 2 * Math.PI;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);

    const m = this.playerModelMatrix;
    m[0] = s * cos;
    m[1] = -s * sin;
    m[2] = 0;
    m[3] = 0;
    m[4] = 0;
    m[5] = 0;
    m[6] = -s;
    m[7] = 0;
    m[8] = s * sin;
    m[9] = s * cos;
    m[10] = 0;
    m[11] = 0;
    m[12] = worldX;
    m[13] = worldY;
    m[14] = terrainHeight;
    m[15] = 1;
    return m;
  }

  build(ctx: RenderContext, projection: Projection2D, viewport: Viewport): RenderQueue {
    const restoration = ctx.restoredPresentation;
    const currentTick = ctx.simulationState.currentTick;
    const initializeRestoration =
      restoration &&
      (currentTick === restoration.tick ||
        !this.initializedRestorations.has(restoration) ||
        (this.restoredHistoryOwner === restoration &&
          this.lastDisplayedTick !== undefined &&
          currentTick > this.lastDisplayedTick + 1));
    if (initializeRestoration) {
      const { frames } = restoration.history;
      let throughFrameIndex = restoration.history.throughFrameIndex;
      // The recorder retains this array and appends live frames to it. A capped/hidden viewport
      // may first draw after GO, so initialize at the actual displayed phase, not a missed hold.
      while (throughFrameIndex + 1 < frames.length && frames[throughFrameIndex + 1].state.currentTick <= currentTick)
        throughFrameIndex += 1;
      ctx = {
        ...ctx,
        // The engine can already be on GO while React still displays the restored boundary.
        // Never consume that next tick's events against the held snapshot.
        events:
          frames[throughFrameIndex]?.state.currentTick === currentTick ? frames[throughFrameIndex].events : ctx.events,
        replayHistory: { frames, throughFrameIndex },
        frameDeltaMs: 0,
      };
    }
    this.replayProjectileWork = ctx.replayHistory ? new ReplayProjectileWork() : undefined;
    this.replayThroughFrameIndex = ctx.replayHistory?.throughFrameIndex;
    try {
      const queue = this.buildScene(ctx, projection, viewport);
      this.updateFrameAudio(ctx.timeline?.paused ?? ctx.replayPaused ?? false);
      // Decided before recording the restoration, so it is retried until encounter assets settle.
      if (ctx.replayHistory && !this.isEncounterReplayPresentationReady(ctx)) queue.replayPresentationReady = false;
      if (restoration && initializeRestoration) {
        if (queue.replayPresentationReady) this.initializedRestorations.add(restoration);
        this.restoredHistoryOwner = restoration;
      } else this.restoredHistoryOwner = undefined;
      return queue;
    } finally {
      this.replayProjectileWork = undefined;
      this.replayThroughFrameIndex = undefined;
    }
  }

  /**
   * Plays the frame sounds this frame's final poses reached. A paused, discontinuous or rebuilt frame
   * only syncs the tracker, so a seek, scrub or restore never replays stale frame sounds.
   */
  private updateFrameAudio(paused: boolean): void {
    if (!this.frameSoundTracker || this._disposed) return;
    const actors = this.collectActorFrameStates();
    if (paused || this.lastDiscontinuityReason !== null || this.reconstructedVisuals) {
      this.frameSoundTracker.silentSync(actors);
    } else this.frameSoundTracker.update(actors, this.getFrameSoundListenerPosition());
  }

  /**
   * Whether the encounter could reconstruct this history frame; called only for history contexts. A 2D
   * view draws no models or effects, so it never waits; a 3D one waits until every declared asset has
   * settled, usable or not.
   */
  private isEncounterReplayPresentationReady(context: RenderContext): boolean {
    return context.options.renderMode !== '3d' || this.encounterAssetState() !== 'pending';
  }

  private buildScene(ctx: RenderContext, projection: Projection2D, viewport: Viewport): RenderQueue {
    if (this._disposed) return createQueue(COLORS.background);
    if (!this.reusableQueue) {
      this.reusableQueue = createQueue(COLORS.background);
    }
    const queue = resetQueue(this.reusableQueue, COLORS.background);
    const { simulationState, events, options, interaction, interpolatedTick, speedMultiplier, frameDeltaMs } = ctx;
    const { currentTick, playerPosition, primaryNpcPosition, mechanicsConfig } = simulationState;
    const timelineKey = ctx.timeline?.timelineKey;
    const history = ctx.replayHistory;
    this.primaryCycle = (ctx.timeline?.timeMs ?? interpolatedTick * OSRS_TICK_MS) / CLIENT_TICK_MS;
    this.effectTick = history
      ? (ctx.timeline?.timeMs ?? interpolatedTick * OSRS_TICK_MS) / OSRS_TICK_MS
      : interpolatedTick;
    const restoredHandoff =
      history === undefined &&
      ctx.restoredPresentation !== undefined &&
      this.restoredHistoryOwner === ctx.restoredPresentation &&
      this.initializedRestorations.has(ctx.restoredPresentation) &&
      timelineKey === this.lastTimelineKey &&
      this.lastDisplayedTick !== undefined &&
      currentTick >= this.lastDisplayedTick &&
      currentTick <= this.lastDisplayedTick + 1;
    // Only the recognized restored engine may retire its initialization history without resetting
    // the controllers it just sampled. Replay seeks, replacements and scene changes still reset.
    const historyChanged = history?.frames !== this.replayEffectIndex?.frames && !restoredHandoff;
    const fractionalRewind =
      history !== undefined &&
      ((this.previousEffectCycle !== undefined && this.effectTick * 30 < this.previousEffectCycle) ||
        (this.previousEffectFrame !== undefined && history.throughFrameIndex < this.previousEffectFrame));
    const discontinuity = historyChanged
      ? 'timeline-change'
      : fractionalRewind
        ? 'rewind'
        : detectTimelineDiscontinuity(
            { lastDisplayedTick: this.lastDisplayedTick, lastTimelineKey: this.lastTimelineKey },
            { currentTick, timelineKey },
          );
    this.lastDiscontinuityReason = discontinuity;
    if (discontinuity) {
      this.resetTransientState(discontinuity);
    }
    if (history) {
      let index = this.replayEffectIndexes.get(history.frames);
      if (!index) {
        index = new ReplayEffectIndex(history.frames, this.createEncounterReplayReader());
        this.replayEffectIndexes.set(history.frames, index);
      }
      index.extend();
      this.replayEffectIndex = index;
    } else this.replayEffectIndex = undefined;
    this.reconstructedVisuals =
      history !== undefined && (discontinuity !== null || this.previousEffectFrame === undefined);
    this.previousEffectCycle = history ? this.effectTick * 30 : undefined;
    this.previousEffectFrame = history?.throughFrameIndex;
    this.lastDisplayedTick = currentTick;
    this.lastTimelineKey = timelineKey;
    // Canonical replay-pause signal: prefer the timeline contract, fall back to
    // the replayPaused flag. Drives event-audio suppression + animation
    // clock freeze below so a held/scrubbed frame doesn't free-run or replay sound.
    const paused = ctx.timeline?.paused ?? ctx.replayPaused ?? false;
    const unprocessedEvents = this.getUnprocessedEvents(events);
    for (const event of unprocessedEvents) {
      const eventRecord = event as Record<string, unknown>;

      const introSeqId = eventRecord.animationSeqId;
      if (event.type === 'intro_started' && typeof introSeqId === 'number') {
        this.pendingIntroSeqId = introSeqId;
        this._introAnimStarted = true;
        this._introAnimPlaying = false;
        this._introAnimComplete = false;
      }
      if (event.type === 'intro_completed') {
        this.pendingIntroSeqId = null;
        this._introAnimPlaying = false;
        this._introAnimComplete = true;
      }
      if (!history && event.type === 'item_consumed') {
        this.playerAnimController?.triggerConsume();
      }
      // Flinch on every incoming hit, including blocked/zero-damage ones — OSRS
      // schedules the defend animation from the attacker and never gates it on
      // damage. Whether it actually plays is decided by the controller's
      // forcedPriority arbitration, which keeps it from cutting off an attack.
      if (!history && event.type === 'hit_applied' && eventRecord.targetId === 'player') {
        this.playerAnimController?.triggerBlock();
      }
      const spellAnimId = eventRecord.animationId;
      const spellSpotAnimId = eventRecord.spotAnimId;
      if (
        !history &&
        event.type === 'spell_self_cast' &&
        typeof spellAnimId === 'number' &&
        typeof spellSpotAnimId === 'number'
      ) {
        const castSeq = this.loadFrameBasedSeqById(spellAnimId);
        if (castSeq) {
          this.playerAnimController?.triggerAttackWithSequence(castSeq);
        }
      }
      if (isCoreEvent(event, 'attack_started') && event.sourceId === 'player') {
        const targetId = event.targetId;
        const spellId = event.spellId;
        const weaponIdFromEvent = event.weaponId;

        this.projectileTargetId = targetId;
        if (history) continue;

        const spellVis = spellId !== undefined ? getSpellVisuals(spellId) : undefined;

        if (spellId !== undefined && !spellVis) {
          this.pendingPlayerAttack = { kind: 'spell', castAnimationId: 1162, fallbackAnimationId: undefined };
          continue;
        }

        if (spellVis) {
          // Stash the attack-anim intent; flushed after the event loop once the
          // player controller exists. Sequence resolution is deferred to flush
          // time so a not-yet-ready animation system can't drop the seq either.
          this.pendingPlayerAttack = {
            kind: 'spell',
            castAnimationId: spellVis.castAnimationId,
            fallbackAnimationId: spellVis.fallbackAnimationId,
          };
        } else {
          // Use weaponId from the event itself so that same-tick weapon swap + attack
          // plays the new weapon's animation, not the old weapon's.
          const currentWeaponId = weaponIdFromEvent;
          // When this attack is a special, play the weapon's spec animation
          // (e.g. dragon claws Slice and Dice) instead of the normal swing.
          const specDef =
            event.usingSpecialAttack === true && currentWeaponId !== undefined
              ? getSpecialAttackDef(currentWeaponId)
              : undefined;
          const specAnimationId = specDef?.animationId;
          this.pendingPlayerAttack = {
            kind: 'weapon',
            weaponId: currentWeaponId,
            attackKind: event.attackKind,
            ...(specAnimationId !== undefined ? { specAnimationId } : {}),
          };
        }
      }
    }

    if (!history && this.pendingIntroSeqId !== null && this.playerAnimController) {
      const introSeq = this.loadFrameBasedSeqById(this.pendingIntroSeqId);
      if (introSeq) {
        this.playerAnimController.enqueueSignal({ type: 'intro', overrideSequence: introSeq });
        this.pendingIntroSeqId = null;
        this._introAnimPlaying = true;
      }
    }
    // Flush the pending player attack AFTER the intro flush so an attack that
    // becomes ready on the same frame wins over the intro (it's the newer action).
    if (!history) this.flushPendingPlayerAttack();
    this.syncEncounterCues(unprocessedEvents, ctx);
    this.onEncounterEvents(unprocessedEvents, ctx);
    this.eventAudioPlayer?.updateReplayClock(
      ctx.replayHistory && !ctx.restoredPresentation ? (ctx.timeline?.timeMs ?? interpolatedTick * OSRS_TICK_MS) : null,
      paused,
    );
    if (this.eventAudioPlayer && !paused) {
      const unplayedAudioEvents = this.getUnplayedAudioEvents(events);
      if (unplayedAudioEvents.length > 0) this.eventAudioPlayer.onEvents(unplayedAudioEvents, playerPosition);
    }
    const destination = { cycle: this.effectTick * 30, throughFrameIndex: history?.throughFrameIndex ?? 0 };
    const playerEffects = this.replayEffectIndex
      ? this.replayEffectIndex.playerEffects(destination, this.effectDuration)
      : describePlayerEffects({ state: simulationState, events: unprocessedEvents });
    for (const effect of playerEffects) {
      switch (effect.kind) {
        case 'graphic':
          if (history) {
            this.prepareReplaySpotAnim(effect.spotAnimId);
          }
          if (this.playerGraphicController.consumeDescriptor(effect) && history && effect.tick < currentTick)
            this.reconstructedVisuals = true;
          break;
        case 'projectile':
        case 'impact':
          if (history && effect.target.npcTypeId > 0 && !this.isNpcTypeLoaded(effect.target.npcTypeId)) break;
          if (history) {
            switch (effect.kind) {
              case 'projectile':
                this.prepareReplaySpotAnim(effect.visuals.projectileId);
                this.prepareReplaySpotAnim(effect.visuals.hitSpotanim);
                break;
              case 'impact':
                this.prepareReplaySpotAnim(effect.spotAnimId);
                break;
              default: {
                const exhaustive: never = effect;
                throw exhaustive;
              }
            }
          }
          if (
            this.projectileController.consumeDescriptor(
              effect,
              this.npcInstanceManager.getNpcTypeOverlayHeights(effect.target.npcTypeId)?.hitsplatHeight ?? 0,
            ) &&
            history &&
            effect.tick < currentTick
          )
            this.reconstructedVisuals = true;
          break;
        default: {
          const exhaustive: never = effect;
          throw exhaustive;
        }
      }
    }
    if (history) this.reconstructEncounterVisuals(ctx);
    this.projectileController.setReplaySampler(this.replayEffectIndex?.actors.sampler(destination));
    this.speedMultiplier =
      speedMultiplier && Number.isFinite(speedMultiplier) && speedMultiplier > 0 ? speedMultiplier : 1;
    const is2D = options.renderMode === '2d';
    const hidingPlugins: NpcHidingPlugins = {
      entityHider: options.entityHider ?? null,
      tzhaarHpTracker: options.tzhaarHpTracker ?? null,
    };
    const hideLocalPlayer = hidingPlugins.entityHider?.hideLocalPlayer === true;
    const hideLocalPlayer2D = hidingPlugins.entityHider?.hideLocalPlayer2D === true;
    this.spotAnimRenderer.setHideProjectiles(hidingPlugins.entityHider?.hideProjectiles === true);
    this.isNpcRenderInstanceHidden = this.resolveHiddenNpcModels(simulationState.npcs, hidingPlugins);
    const pillarAdditions = enabledPillarAdditions(options.pillarAdditions);
    const hiddenPillars = hiddenPillarLocIds(options.pillarAdditions);

    queue.tick = interpolatedTick ?? currentTick;
    queue.brightness = options.brightness;
    queue.contrast = options.contrast;
    queue.saturation = options.saturation;

    frameProfiler.beginPhase('syncNpcs');
    this.npcInterpFraction = Math.max(0, Math.min(1, (interpolatedTick ?? currentTick) - currentTick));
    this.syncNpcInstances(simulationState.npcs, is2D, simulationState, paused);
    frameProfiler.endPhase('syncNpcs');

    this.groundItemRenderer.setLoaders(
      this.groundItemLoaderSource?.getObjTypeLoader() ?? null,
      this.groundItemLoaderSource?.getModelLoader() ?? null,
    );
    this.groundItemRenderer.sync(simulationState.groundItems, this.terrainHeights);

    const { playerPreviousPosition, playerMovementPath, playerIsRunning, playerFacingAngle } = simulationState;
    let visualPosition: [number, number];
    let isVisuallyMoving: boolean;
    let simIsMoving: boolean;
    let stepFacingAngle: number;
    let stepTargetAngle: number;
    let visualIsRunning: boolean;
    let isTurning: boolean;
    let locomotionState: 'walk' | 'turnLeft' | 'turnRight' | 'walkBack' | null;

    if (ctx.playerVisual) {
      visualPosition = ctx.playerVisual.position;
      isVisuallyMoving = ctx.playerVisual.isVisuallyMoving;
      simIsMoving = ctx.playerVisual.simIsMoving;
      stepFacingAngle = ctx.playerVisual.facingAngle;
      stepTargetAngle = ctx.playerVisual.targetAngle;
      visualIsRunning = ctx.playerVisual.isRunning;
      isTurning = ctx.playerVisual.isTurning;
      locomotionState = ctx.playerVisual.locomotionState;
    } else {
      const tickProgress = (interpolatedTick ?? currentTick) - currentTick;
      const result = calculateVisualPlayerPosition(
        playerPreviousPosition,
        playerMovementPath,
        playerPosition,
        tickProgress,
        playerFacingAngle,
      );
      const simPathActive = playerMovementPath.length > 0;
      visualPosition = result.position;
      isVisuallyMoving = result.isVisuallyMoving;
      simIsMoving = simPathActive;
      stepFacingAngle = result.facingAngle;
      stepTargetAngle = playerFacingAngle;
      visualIsRunning = (simPathActive || isVisuallyMoving) && playerIsRunning;
      isTurning = simPathActive && stepFacingAngle !== stepTargetAngle;
      locomotionState = null;
    }

    this.lastPlayerVisualCenter = [visualPosition[0] + 0.5, visualPosition[1] + 0.5];

    // Every NPC pose and corpse is final before any model is queued: facing on the clock as it stood,
    // then the clock to the destination, then corpses at their absolute age, so a frame never draws
    // a model its own clock step has since posed differently or expired.
    const encounterNpcFacingAngle = this.updateEncounterNpcFacing(visualPosition);

    if (!is2D) {
      frameProfiler.beginPhase('npcAnims');
      if (!history || !this.restoreEncounterPrimaries(ctx))
        this.advanceNpcAnimationsToTick(simulationState, interpolatedTick);
      // Advances nothing: applies triggers held for a model that has loaded since, and settles poses.
      this.npcInstanceManager.updateAnimations(0, this.speedMultiplier, []);
      this.reconstructPrunedCorpses(simulationState.npcs);
      frameProfiler.endPhase('npcAnims');
    }

    if (!is2D) {
      queue.commands.push(...this.cachedTerrainMeshes);

      frameProfiler.beginPhase('locs');
      this.locRenderer.setTerrainHeights(this.terrainHeights);
      this.locRenderer.setSpeedMultiplier(this.speedMultiplier);
      this.locRenderer.setHiddenLocIds(hiddenPillars);
      this.locRenderer.renderLocs(queue);
      frameProfiler.endPhase('locs');

      this.groundItemRenderer.render(queue);

      frameProfiler.beginPhase('sceneObjects');
      this.syncAndRenderSceneObjects(
        queue,
        currentTick,
        interpolatedTick ?? currentTick,
        simulationState,
        unprocessedEvents,
        hiddenPillars,
        ctx.fightStartCountdown,
      );
      frameProfiler.endPhase('sceneObjects');

      frameProfiler.beginPhase('encounterFx');
      this.renderEncounterEffectsEarly(queue, currentTick, interpolatedTick ?? currentTick, mechanicsConfig, options);
      frameProfiler.endPhase('encounterFx');

      frameProfiler.beginPhase('npcRender');
      this.renderNpcModels(queue);
      frameProfiler.endPhase('npcRender');
    }

    frameProfiler.beginPhase('gridOverlays');
    // The grid lines and arena outline are screen-space poly2d commands, which only a 2D render
    // consumes; the 3D backend draws mesh3d alone, and 3D mode draws its grid as a mesh. Building
    // them in 3D re-projected every arena tile each frame for nothing.
    if (is2D) {
      this.buildGridLines(queue, projection, viewport);
      this.buildArenaBoundary(queue, projection);
    } else if (ctx.options.tileGrid) {
      this.buildTileGrid3D(queue, ctx.options.tileGrid);
    }
    this.renderPrimaryNpcDeathSpotAnim(currentTick, simulationState);
    this.renderEncounterEffectsLate(
      queue,
      projection,
      currentTick,
      interpolatedTick ?? currentTick,
      simulationState,
      mechanicsConfig,
      is2D,
      options,
    );
    this.renderEncounterDebugOverlays(
      queue,
      projection,
      simulationState,
      interpolatedTick ?? currentTick,
      is2D,
      options.encounterDebugFlags,
    );
    if (ctx.options.showTileMarkers && ctx.tileMarkers && ctx.tileMarkers.length > 0) {
      this.buildTileMarkers(
        queue,
        projection,
        ctx.tileMarkers,
        is2D,
        ctx.options.showTileMarkerLabels,
        ctx.options.tileMarkerWidth,
      );
    }
    if (ctx.options.showLineMarkers && ctx.lineMarkers && ctx.lineMarkers.length > 0) {
      this.buildLineMarkers(
        queue,
        projection,
        ctx.lineMarkers,
        is2D,
        ctx.options.showLineMarkerLabels,
        ctx.options.lineMarkerWidth,
      );
    }
    if (!is2D) {
      for (const { locIds, options: pillarOptions } of pillarAdditions) {
        if (pillarOptions.markPillarTiles) this.buildPillarTileMarkers(queue, locIds, pillarOptions);
      }
    }
    this.renderEncounterNpc2D(queue, projection, simulationState);
    frameProfiler.endPhase('gridOverlays');

    // Built AFTER updateAnimations (not in the gridOverlays phase above) so the
    // clickbox overlay snapshots the SAME posed vertices the NPC model renders this
    // frame. Snapshotting earlier lags the overlay one animation commit behind the
    // model, so the model surface clips through it — the residual animation flicker.
    const markableNpcs = hasNpcHidingPlugin(hidingPlugins)
      ? simulationState.npcs.filter((npc) => !isNpcOverlayHidden(npc, hidingPlugins, PLAYER_ACTOR_ID))
      : simulationState.npcs;
    if (ctx.options.showNpcHighlights && ctx.npcHighlights && ctx.npcHighlights.length > 0) {
      this.buildNpcHighlights(queue, projection, ctx.npcHighlights, markableNpcs, is2D);
    }
    if (hidingPlugins.tzhaarHpTracker && hidingPlugins.tzhaarHpTracker.highlightStyle !== 'none') {
      this.buildTzhaarHighlights(queue, projection, hidingPlugins.tzhaarHpTracker, markableNpcs, is2D);
    }
    if (!is2D) {
      this.cues.update(
        {
          cycle: this.primaryCycle,
          resolveActor: this.createActorVisualPositionResolver(visualPosition),
          resolveAttachment: (actorId) => this.resolveAttachedActor(actorId, simulationState, visualPosition),
          terrainHeights: this.terrainHeights,
          resolveSurfaceHeight: this.resolveSurfaceHeight,
        },
        this.replayProjectileWork,
      );
    }
    this.renderEncounterAttackEffects(
      currentTick,
      interpolatedTick ?? currentTick,
      visualPosition,
      primaryNpcPosition,
      encounterNpcFacingAngle,
      stepFacingAngle,
      mechanicsConfig,
      is2D,
    );

    // Skip 3D face-sorting projection in 2D mode because mesh data is not rendered.
    if (!is2D) {
      const cameraApi = projection as Projection2D & {
        getCameraState?: () => {
          pitch: number;
          yaw: number;
          distance: number;
          targetX: number;
          targetY: number;
          targetZ: number;
        };
        getCameraWorldPosition?: () => { x: number; y: number; z: number };
        getOsrsCameraProjection?: () => {
          cameraX: number;
          cameraY: number;
          cameraZ: number;
          yawSin: number;
          yawCos: number;
          pitchSin: number;
          pitchCos: number;
        };
      };
      const cameraState = cameraApi.getCameraState?.();
      if (cameraState) {
        const playerWorldX = visualPosition[0] + 0.5;
        const playerWorldY = visualPosition[1] + 0.5;
        const terrainHeight = -getTerrainHeightInterpolated(this.terrainHeights, playerWorldX, playerWorldY) / 128;
        const bottomLift = this.getPlayerModelLift();
        const playerWorldZ = terrainHeight + bottomLift;

        // World coords → OSRS game units (128 per tile)
        // OSRS X = world X * 128, OSRS Y = -world Z * 128 (height, neg=up), OSRS Z = world Y * 128
        const TILE_TO_OSRS = 128;
        const osrsCameraProjection = cameraApi.getOsrsCameraProjection?.();
        const pitchRad = Math.abs(cameraState.pitch) * (Math.PI / 180);
        const yawRad = cameraState.yaw * (Math.PI / 180);
        const cp = Math.cos(pitchRad);
        const sp = Math.sin(pitchRad);
        const cy = Math.cos(yawRad);
        const sy = Math.sin(yawRad);
        const cameraWorldPosition = cameraApi.getCameraWorldPosition?.();
        const camWorldX = cameraWorldPosition?.x ?? cameraState.targetX + cameraState.distance * cp * sy;
        const camWorldY = cameraWorldPosition?.y ?? cameraState.targetY - cameraState.distance * cp * cy;
        const camWorldZ = cameraWorldPosition?.z ?? cameraState.targetZ + cameraState.distance * sp;
        const sorterProjection = osrsCameraProjection ?? {
          cameraX: camWorldX * TILE_TO_OSRS,
          cameraY: -camWorldZ * TILE_TO_OSRS,
          cameraZ: camWorldY * TILE_TO_OSRS,
          yawSin: sy,
          yawCos: cy,
          pitchSin: sp,
          pitchCos: cp,
        };

        this.playerAnimController?.setSorterProjection({
          cameraX: sorterProjection.cameraX,
          cameraY: sorterProjection.cameraY,
          cameraZ: sorterProjection.cameraZ,
          yawSin: sorterProjection.yawSin,
          yawCos: sorterProjection.yawCos,
          pitchSin: sorterProjection.pitchSin,
          pitchCos: sorterProjection.pitchCos,
          orientation: stepFacingAngle,
          modelX: playerWorldX * TILE_TO_OSRS,
          modelY: -playerWorldZ * TILE_TO_OSRS,
          modelZ: playerWorldY * TILE_TO_OSRS,
        });

        this.npcInstanceManager.setSorterProjection({
          cameraX: sorterProjection.cameraX,
          cameraY: sorterProjection.cameraY,
          cameraZ: sorterProjection.cameraZ,
          yawSin: sorterProjection.yawSin,
          yawCos: sorterProjection.yawCos,
          pitchSin: sorterProjection.pitchSin,
          pitchCos: sorterProjection.pitchCos,
        });

        this.spotAnimRenderer.setSorterProjection({
          cameraX: sorterProjection.cameraX,
          cameraY: sorterProjection.cameraY,
          cameraZ: sorterProjection.cameraZ,
          yawSin: sorterProjection.yawSin,
          yawCos: sorterProjection.yawCos,
          pitchSin: sorterProjection.pitchSin,
          pitchCos: sorterProjection.pitchCos,
        });
      } else {
        this.playerAnimController?.setSorterProjection(null);
        this.npcInstanceManager.setSorterProjection(null);
        this.spotAnimRenderer.setSorterProjection(null);
      }
    }

    // Transparent sort runs AFTER animations + projection setup
    if (!is2D) {
      frameProfiler.beginPhase('npcTransSort');
      this.npcInstanceManager.updateTransparentSort();
      frameProfiler.endPhase('npcTransSort');
    }

    frameProfiler.beginPhase('playerAnim');
    this.restorePlayerPrimary(ctx);
    this.playerAnimController?.updatePlayerAnimation({
      deltaMs: paused ? 0 : frameDeltaMs,
      isMoving: isVisuallyMoving,
      simIsMoving,
      isRunning: visualIsRunning,
      locomotionState,
      visualAngle: stepFacingAngle,
      targetAngle: stepTargetAngle,
      speedMultiplier: this.speedMultiplier,
      isTurning,
    });

    if (!is2D && this.playerAnimController) {
      const playerWorldX = visualPosition[0] + 0.5;
      const playerWorldY = visualPosition[1] + 0.5;
      const terrainHeight = -getTerrainHeightInterpolated(this.terrainHeights, playerWorldX, playerWorldY) / 128;
      const playerWorldZ = terrainHeight + this.getPlayerModelLift();
      this.playerAnimController.refreshSorterModelY(-playerWorldZ * 128);
    }

    if (this._introAnimPlaying && this.playerAnimController?.isIntroAnimComplete()) {
      this._introAnimPlaying = false;
      this._introAnimComplete = true;
    }

    this.buildPlayer(
      queue,
      projection,
      playerPosition,
      visualPosition,
      stepFacingAngle,
      options.tileIndicatorConfig ?? DEFAULT_TILE_INDICATOR_CONFIG,
      !hideLocalPlayer,
    );
    frameProfiler.endPhase('playerAnim');

    if (!is2D) {
      frameProfiler.beginPhase('projectiles');
      this.playerGraphicController.update(this.spotAnimRenderer, {
        currentTick,
        interpolatedTick: this.effectTick,
        playerVisualPosition: visualPosition,
        facingAngle: stepFacingAngle,
        playerModelLift: this.getPlayerModelLift(),
        spotAnimModelLoader: this.spotAnimModelLoader,
      });
      this.projectileController.setTerrainHeights(this.terrainHeights);
      this.projectileController.setSurfaceHeightResolver(this.resolveSurfaceHeight);
      // The primary NPC's smoothed angle, as its model matrix was drawn, for projectile targeting.
      const encounterFacing = this.npcInstanceManager.getPrimaryNpcSmoothedFacingAngle();
      let projNpcFacingAngle: number | undefined;
      if (encounterFacing !== undefined) {
        projNpcFacingAngle = encounterFacing;
      } else {
        const targetId = this.projectileTargetId ?? simulationState.attackTarget;
        const primaryTarget = simulationState.npcs.find((n) => n.id === targetId);
        projNpcFacingAngle = primaryTarget?.facingAngle ?? 0;
      }
      this.projectileController.update(
        this.spotAnimRenderer,
        currentTick,
        this.effectTick,
        this.spotAnimModelLoader,
        projNpcFacingAngle,
        this.createActorVisualPositionResolver(visualPosition),
        this.replayProjectileWork,
      );
      frameProfiler.endPhase('projectiles');
    }

    frameProfiler.beginPhase('spotAnims');
    this.spotAnimRenderer.setTerrainHeights(this.terrainHeights);
    this.spotAnimRenderer.tick(currentTick, this.effectTick);
    this.spotAnimRenderer.render(queue);
    frameProfiler.endPhase('spotAnims');

    frameProfiler.beginPhase('uiOverlays');
    this.uiOverlayRenderer.setTerrainHeights(this.terrainHeights);
    const npcOverlayHeights = this.buildNpcOverlayHeightsMap(simulationState.npcs);
    const presentedNpcs = is2D
      ? simulationState.npcs
      : simulationState.npcs.filter((npc) => npc.alive || npcOverlayHeights.has(npc.id));
    const npcOverlayState = {
      ...simulationState,
      npcs: hasNpcHidingPlugin(hidingPlugins)
        ? presentedNpcs.filter((npc) => !isNpc2DHidden(npc, hidingPlugins, PLAYER_ACTOR_ID))
        : presentedNpcs,
    };
    this.uiOverlayRenderer.setNpcOverlayHeights(npcOverlayHeights);
    this.uiOverlayRenderer.update(currentTick, unprocessedEvents);
    this.uiOverlayRenderer.buildOverheadTexts(
      queue,
      projection,
      npcOverlayState,
      interpolatedTick ?? currentTick,
      this.npcInterpFraction,
    );
    if (!hideLocalPlayer2D) {
      this.uiOverlayRenderer.buildPrayerOverheads(queue, projection, simulationState, visualPosition);
      this.uiOverlayRenderer.buildHitsplats(
        queue,
        projection,
        simulationState,
        visualPosition,
        interpolatedTick ?? currentTick,
      );
      this.uiOverlayRenderer.buildHealthBar(
        queue,
        projection,
        simulationState,
        visualPosition,
        interpolatedTick ?? currentTick,
      );
    }
    if (options.showAttackTimerMetronome) {
      this.uiOverlayRenderer.buildPlayerAttackTimerBar(
        queue,
        projection,
        simulationState,
        visualPosition,
        interpolatedTick ?? currentTick,
      );
    }
    if (options.playerOverheadNumbers) {
      this.uiOverlayRenderer.buildOverheadNumbers(
        queue,
        projection,
        simulationState,
        visualPosition,
        options.playerOverheadNumbers,
      );
    }
    this.uiOverlayRenderer.buildNpcHitsplats(
      queue,
      projection,
      npcOverlayState.npcs,
      interpolatedTick ?? currentTick,
      this.npcInterpFraction,
      simulationState.currentTick,
    );
    this.uiOverlayRenderer.buildNpcHealthBars(
      queue,
      projection,
      npcOverlayState.npcs,
      interpolatedTick ?? currentTick,
      this.npcInstanceManager.getDyingActorIds(),
      this.npcInterpFraction,
      simulationState.currentTick,
    );
    this.uiOverlayRenderer.buildNpcTimerBars(
      queue,
      projection,
      npcOverlayState.npcs,
      interpolatedTick ?? currentTick,
      this.npcInterpFraction,
      simulationState.currentTick,
    );
    if (options.showNpcAttackTimerMetronome) {
      this.uiOverlayRenderer.buildNpcAttackTimerBars(
        queue,
        projection,
        npcOverlayState.npcs,
        currentTick,
        this.npcInterpFraction,
      );
    }
    const tzhaarHpTracker = hidingPlugins.tzhaarHpTracker;
    if (tzhaarHpTracker && tzhaarHpTracker.showHp !== 'off') {
      this.uiOverlayRenderer.buildNpcHpTexts(
        queue,
        projection,
        presentedNpcs.filter(
          (npc) => isTzhaarTrackedNpc(npc.npcTypeId) && !isNpcOverlayHidden(npc, hidingPlugins, PLAYER_ACTOR_ID),
        ),
        tzhaarHpTracker,
        this.npcInterpFraction,
        simulationState.currentTick,
      );
    }
    frameProfiler.endPhase('uiOverlays');

    if (interaction.targetTile) {
      this.buildTargetTile(
        queue,
        projection,
        interaction.targetTile,
        playerPosition,
        options.tileIndicatorConfig ?? DEFAULT_TILE_INDICATOR_CONFIG,
      );
    }

    if (interaction.hoveredTile) {
      this.buildHoveredTile(
        queue,
        projection,
        interaction.hoveredTile,
        options.showCoordinates,
        interaction.targetTile,
        playerPosition,
        options.tileIndicatorConfig ?? DEFAULT_TILE_INDICATOR_CONFIG,
      );
    }

    if (!is2D) {
      this.buildTileOutlines3D(
        queue,
        interaction.hoveredTile,
        interaction.targetTile,
        simulationState,
        options.tileIndicatorConfig ?? DEFAULT_TILE_INDICATOR_CONFIG,
      );
      if (options.showNpcClickbox && !this.deferNpcClickbox) {
        this.buildNpcClickboxOverlay3D(queue);
      }
    }

    return queue;
  }

  async buildTerrainMesh3D(
    mapLoader: MapSquareLoader,
    underlayLoader?: UnderlayTypeLoader,
    overlayLoader?: OverlayTypeLoader,
    locations?: LocationData[],
    locTypeInfoLoader?: LocTypeInfoLoader,
  ): Promise<TerrainMesh3DCommand> {
    profiler.start('SceneCompositor.buildTerrainMesh3D');
    try {
      const meshes = await this.buildTerrainMeshes3D(
        mapLoader,
        underlayLoader,
        overlayLoader,
        locations,
        locTypeInfoLoader,
      );
      const mesh = meshes[0];
      if (!mesh) throw new Error('SceneCompositor: terrain mesh was not built');
      return mesh;
    } finally {
      profiler.end('SceneCompositor.buildTerrainMesh3D');
    }
  }

  private prepareCenterTerrain(terrainHeights: Int32Array[], terrainBounds: ArenaBounds): void {
    this.terrainHeights = terrainHeights;
    this.npcInstanceManager.setTerrainHeights(this.terrainHeights);
    this.spotAnimRenderer.setTerrainHeights(this.terrainHeights);
    this.terrainBounds = terrainBounds;
  }

  async buildTerrainMeshes3D(
    mapLoader: MapSquareLoader,
    underlayLoader?: UnderlayTypeLoader,
    overlayLoader?: OverlayTypeLoader,
    locations?: LocationData[],
    locTypeInfoLoader?: LocTypeInfoLoader,
  ): Promise<TerrainMesh3DCommand[]> {
    const configuredOffsets = this.encounterRenderConfig?.mapSquareOffsets;
    const renderedOffsets: MapSquareOffsets = configuredOffsets ?? [{ dx: 0, dy: 0 }];
    const renderedBlock = getMapSquareBlock(renderedOffsets);
    const terrainLevels = [...new Set(this.encounterRenderConfig?.locRender?.levels ?? [0])].filter(
      (level) => Number.isInteger(level) && level >= 0,
    );
    const { x: centerMapX, y: centerMapY } = this.getTerrainMapSquare();
    const loadedEntries = await Promise.all(
      getTerrainContextLoadOffsets(renderedOffsets).map(async ({ dx, dy }) => {
        const mapX = centerMapX + dx;
        const mapY = centerMapY + dy;
        return { mapX, mapY, mapData: await mapLoader.loadMapSquare(mapX, mapY) };
      }),
    );
    if (this._disposed) return [];
    const loadedSquares = new Map<string, MapSquareData>();
    for (const { mapX, mapY, mapData } of loadedEntries) {
      if (mapData) loadedSquares.set(`${mapX},${mapY}`, mapData);
    }
    const centerMapData = loadedSquares.get(`${centerMapX},${centerMapY}`);
    if (!centerMapData) throw new Error(`SceneCompositor: map square ${centerMapX},${centerMapY} not found`);
    const { minX, maxX, minY, maxY } = getMapSquareBlockTileBounds(renderedBlock);
    // Actors stand only in the arena, so the shared height grid covers its squares; scenery squares
    // keep their heights in their own terrain contexts. One arena square keeps its grid as it is.
    const arenaHeights = composeTerrainHeights(
      this.arenaBlock.flatMap(({ dx, dy, tileOffsetX, tileOffsetY }) => {
        const heights = loadedSquares.get(`${centerMapX + dx},${centerMapY + dy}`)?.tileHeights[0];
        return heights ? [{ tileOffsetX, tileOffsetY, heights }] : [];
      }),
    );
    this.prepareCenterTerrain(arenaHeights ?? centerMapData.tileHeights[0], {
      minX,
      maxX,
      minY,
      maxY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    });

    const surfaceSquares: SceneSurfaceTerrainSquare[] = [];
    const meshes = renderedBlock.flatMap(({ dx, dy, tileOffsetX, tileOffsetY }) => {
      const mapX = centerMapX + dx;
      const mapY = centerMapY + dy;
      const mapData = loadedSquares.get(`${mapX},${mapY}`);
      if (!mapData) return [];
      const context = createTerrainContext(mapData, (neighborX, neighborY) =>
        loadedSquares.get(`${neighborX},${neighborY}`),
      );
      surfaceSquares.push({ terrain: context, tileOffsetX, tileOffsetY });
      const contextLocations = this.getContextLocations(locations, tileOffsetX, tileOffsetY, context);
      if (contextLocations && locTypeInfoLoader) {
        populateTileLightOcclusions(context, contextLocations, locTypeInfoLoader);
      }
      return terrainLevels
        .filter((level) => level < context.tileHeights.length)
        .map((level) =>
          this.buildTerrainCommand(context, level, mapX, mapY, tileOffsetX, tileOffsetY, underlayLoader, overlayLoader),
        );
    });
    this.surfaceHeightResolver.setTerrain(surfaceSquares);
    return meshes;
  }

  private getContextLocations(
    locations: LocationData[] | undefined,
    tileOffsetX: number,
    tileOffsetY: number,
    context: TerrainContext,
  ): LocationData[] | undefined {
    if (!locations) return undefined;
    const minX = tileOffsetX - context.coreOriginX;
    const minY = tileOffsetY - context.coreOriginY;
    const maxX = tileOffsetX + MAP_SQUARE_SIZE + context.coreOriginX;
    const maxY = tileOffsetY + MAP_SQUARE_SIZE + context.coreOriginY;
    return locations
      .filter(({ localX, localY }) => localX >= minX && localX < maxX && localY >= minY && localY < maxY)
      .map((location) => ({
        ...location,
        localX: location.localX - tileOffsetX + context.coreOriginX,
        localY: location.localY - tileOffsetY + context.coreOriginY,
      }));
  }

  private buildTerrainCommand(
    mapData: TerrainContext,
    terrainLevel: number,
    mapX: number,
    mapY: number,
    tileOffsetX: number,
    tileOffsetY: number,
    underlayLoader?: UnderlayTypeLoader,
    overlayLoader?: OverlayTypeLoader,
  ): TerrainMesh3DCommand {
    const { source, textureIds } = createTerrainMeshSource({
      id: `terrain-${mapX}-${mapY}-level-${terrainLevel}`,
      context: mapData,
      level: terrainLevel,
      underlayLoader,
      overlayLoader,
      smoothTerrain: this.smoothTerrain,
      textureIndexMapper: this.textureIndexMapper,
    });
    const scale = 1 / 128;
    return {
      kind: 'mesh3d',
      meshId: `terrain-${mapX}-${mapY}-level-${terrainLevel}-v${this.terrainVersion}`,
      materialId: 'osrs-terrain',
      modelMatrix: new Float32Array([scale, 0, 0, 0, 0, 0, -scale, 0, 0, scale, 0, 0, tileOffsetX, tileOffsetY, 0, 1]),
      meshSource: source,
      meshSourcePart: 0,
      textureIds,
      depth: 'readwrite',
    };
  }

  protected buildGridLines(queue: RenderQueue, projection: Projection2D, viewport?: Viewport): void {
    const bounds = this.getGridBounds();
    // The arena rectangle starts at tile (0, 0): its south-west square is the origin.
    const arena = getArenaTileExtent(this.arenaBlock);
    const margin = 3;
    let minX = Math.max(0, (bounds?.minX ?? 0) - margin);
    let maxX = Math.min(arena.width - 1, (bounds?.maxX ?? arena.width - 1) + margin);
    let minY = Math.max(0, (bounds?.minY ?? 0) - margin);
    let maxY = Math.min(arena.height - 1, (bounds?.maxY ?? arena.height - 1) + margin);

    if (viewport) {
      const vpMargin = 2;
      for (let col = minX; col <= maxX; col++) {
        const screen = projection.tileToScreen({ x: col, y: minY });
        if (screen && screen.x > -viewport.width && screen.x < viewport.width * 2) {
          minX = Math.max(minX, col - vpMargin);
          break;
        }
      }
      for (let col = maxX; col >= minX; col--) {
        const screen = projection.tileToScreen({ x: col, y: minY });
        if (screen && screen.x > -viewport.width && screen.x < viewport.width * 2) {
          maxX = Math.min(maxX, col + vpMargin);
          break;
        }
      }
      for (let row = minY; row <= maxY; row++) {
        const screen = projection.tileToScreen({ x: minX, y: row });
        if (screen && screen.y > -viewport.height && screen.y < viewport.height * 2) {
          minY = Math.max(minY, row - vpMargin);
          break;
        }
      }
      for (let row = maxY; row >= minY; row--) {
        const screen = projection.tileToScreen({ x: minX, y: row });
        if (screen && screen.y > -viewport.height && screen.y < viewport.height * 2) {
          maxY = Math.min(maxY, row + vpMargin);
          break;
        }
      }
    }

    for (let col = minX; col <= maxX; col++) {
      for (let row = minY; row <= maxY; row++) {
        const isMajor = col % 8 === 0 || row % 8 === 0;
        const color = isMajor ? COLORS.gridLineMajor : COLORS.gridLine;
        queue.commands.push(
          tilePolygonCommand(projection, [col, row], undefined, { color, widthPx: 1 }, Z_LAYERS.GRID),
        );
      }
    }
  }

  /**
   * Boundary edges of the walkable arena, as `[tileX, tileY, neighborX, neighborY]`
   * quads. Emitted in the original scan order (x outer, y inner, neighbors
   * east/west/north/south) so the resulting command order is unchanged.
   *
   * Keyed on the walkability mirror's revision rather than the checker closure's
   * identity: the closure is memoized per source set, so keying on it would have
   * kept stale topology across any change the mirror itself picks up (a resized
   * set refreshes the mirror but reuses the closure). Tying both to one signal
   * keeps the drawn boundary and the probes it was derived from in step.
   */
  private getArenaBoundaryPairs(
    bounds: { minX: number; maxX: number; minY: number; maxY: number },
    walkable: (x: number, y: number) => boolean,
  ): Int32Array {
    // Resolve the mirror before reading its revision: it is built lazily inside
    // the checker closure, so keying first would use a revision one step behind
    // and rebuild redundantly on the frame after every arena change.
    const tiles = getWalkableTiles();
    if (tiles) this.walkableLookup.get(tiles);
    const key = `${bounds.minX},${bounds.maxX},${bounds.minY},${bounds.maxY}:${this.walkableLookup.revision}`;
    if (this.arenaBoundaryPairs && this.arenaBoundaryPairsKey === key) {
      return this.arenaBoundaryPairs;
    }

    const pairs: number[] = [];
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      for (let y = bounds.minY; y <= bounds.maxY; y++) {
        if (!walkable(x, y)) continue;
        if (!walkable(x + 1, y)) pairs.push(x, y, x + 1, y);
        if (!walkable(x - 1, y)) pairs.push(x, y, x - 1, y);
        if (!walkable(x, y + 1)) pairs.push(x, y, x, y + 1);
        if (!walkable(x, y - 1)) pairs.push(x, y, x, y - 1);
      }
    }

    this.arenaBoundaryPairs = new Int32Array(pairs);
    this.arenaBoundaryPairsKey = key;
    return this.arenaBoundaryPairs;
  }

  protected buildArenaBoundary(queue: RenderQueue, projection: Projection2D): void {
    const bounds = this.getGridBounds();
    if (!bounds) return;
    const walkable = this.getArenaWalkabilityChecker();
    if (!walkable) return;

    // Which tile edges border unwalkable ground is fixed for the loaded arena, so
    // only the projection of those edges is per-frame work. Rediscovering them by
    // scanning every arena tile cost five walkability probes and a tile-polygon
    // projection per tile, every frame.
    const pairs = this.getArenaBoundaryPairs(bounds, walkable);
    if (pairs.length === 0) return;

    const arenaColor = rgbaFromHex('#FFD700', 0.8);
    const stroke: StrokeStyle = { color: arenaColor, widthPx: 2 };
    const z = Z_LAYERS.GRID + 5;
    const EPS = 0.5;

    // Consecutive quads share a tile (its edges are emitted together), so one
    // memo slot removes every repeat projection of the owning tile.
    let cachedX = Number.NaN;
    let cachedY = Number.NaN;
    let corners: Vec2[] = [];

    for (let i = 0; i < pairs.length; i += 4) {
      const x = pairs[i];
      const y = pairs[i + 1];
      if (x !== cachedX || y !== cachedY) {
        cachedX = x;
        cachedY = y;
        corners = projection.tilePolygonScreen({ x, y });
      }
      if (corners.length < 4) continue;

      const nCorners = projection.tilePolygonScreen({ x: pairs[i + 2], y: pairs[i + 3] });
      if (nCorners.length < 4) continue;

      const shared: Vec2[] = [];
      for (const c of corners) {
        for (const nc of nCorners) {
          if (Math.abs(c.x - nc.x) < EPS && Math.abs(c.y - nc.y) < EPS) {
            shared.push(c);
            break;
          }
        }
      }
      if (shared.length >= 2) {
        queue.commands.push({
          kind: 'poly2d',
          points: [shared[0], shared[1]],
          stroke,
          zIndex: z,
          closePath: false,
        });
      }
    }
  }

  private getTileSize(projection: Projection2D, pos: Coordinate): number {
    const corners = projection.tilePolygonScreen({ x: pos[0], y: pos[1] });
    if (corners.length < 4) return 0;
    const dx = corners[1].x - corners[0].x;
    const dy = corners[1].y - corners[0].y;
    const edge1 = Math.sqrt(dx * dx + dy * dy);
    const dx2 = corners[2].x - corners[1].x;
    const dy2 = corners[2].y - corners[1].y;
    const edge2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
    return (edge1 + edge2) / 2;
  }

  private buildPlayer(
    queue: RenderQueue,
    projection: Projection2D,
    trueTilePos: Coordinate,
    visualPos: [number, number],
    facingAngle: number,
    tileIndicatorConfig: TileIndicatorConfig,
    /** False under Entity Hider's Hide local player: the Tile Indicators true tile is a plugin's and stays. */
    drawAvatar: boolean,
  ): void {
    const trueTileConfig = tileIndicatorConfig.trueTile;
    if (trueTileConfig.enabled) {
      const color = rgbaFromHex(trueTileConfig.color, trueTileConfig.opacity);
      if (trueTileConfig.cornerOnly) {
        const cornerCommands = tileCornerOutlineCommands(
          projection,
          trueTilePos,
          color,
          Z_LAYERS.PLAYER - 1,
          0.3,
          trueTileConfig.width,
        );
        queue.commands.push(...cornerCommands);
      } else {
        queue.commands.push(
          tilePolygonCommand(
            projection,
            trueTilePos,
            undefined,
            { color, widthPx: trueTileConfig.width },
            Z_LAYERS.PLAYER - 1,
          ),
        );
      }
    }

    if (!drawAvatar) return;
    const center = projection.tileToScreen({ x: visualPos[0], y: visualPos[1] });
    if (!center) return;
    const tileSize = this.getTileSize(projection, trueTilePos);
    const radius = Math.max(4, tileSize * 0.35);

    const shadowOffset = Math.max(1, tileSize * 0.07);
    const borderWidth = Math.max(1, tileSize * 0.07);

    queue.commands.push({
      kind: 'circle2d',
      center,
      radiusPx: radius * 1.5,
      fill: {
        center: center,
        radius: radius * 1.5,
        stops: [
          { offset: 0.5, color: rgba(0, 1, 1, 0.3) },
          { offset: 1, color: rgba(0, 1, 1, 0) },
        ],
      },
      zIndex: Z_LAYERS.PLAYER - 0.5,
    });

    queue.commands.push(
      circleCommand(
        vec2(center.x + shadowOffset, center.y + shadowOffset),
        radius,
        rgba(0, 0, 0, 0.5),
        undefined,
        Z_LAYERS.PLAYER,
      ),
    );

    queue.commands.push(
      circleCommand(
        center,
        radius,
        COLORS.player,
        { color: COLORS.playerBorder, widthPx: borderWidth },
        Z_LAYERS.PLAYER + 1,
      ),
    );

    if (this.cachedPlayerMeshes.length > 0) {
      const SCALE = 1 / 128;
      const worldX = visualPos[0] + 0.5;
      const worldY = visualPos[1] + 0.5;
      const terrainHeight =
        -getTerrainHeightInterpolated(this.terrainHeights, visualPos[0] + 0.5, visualPos[1] + 0.5) / 128;
      const bottomLift = this.getPlayerModelLift();

      const modelMatrix = this.createPlayerModelMatrix(SCALE, worldX, worldY, terrainHeight + bottomLift, facingAngle);
      for (const meshPart of this.cachedPlayerMeshes) {
        const playerCommand: NpcMesh3DCommand = {
          ...meshPart,
          modelMatrix,
        };
        queue.commands.push(playerCommand);
      }
    } else {
      const magentaHsl = packHsl(213, 255, 128);
      const sphereMesh = this.createSphereMesh(0.5, 8, 8, magentaHsl);
      const fallbackWorldX = visualPos[0] + 0.5;
      const fallbackWorldY = visualPos[1] + 0.5;
      const fallbackWorldZ = 5;

      const sphereCommand: NpcMesh3DCommand = {
        kind: 'mesh3d',
        meshId: `debug-player-sphere-${visualPos[0]}-${visualPos[1]}`,
        materialId: 'osrs-npc',
        cullFace: 'none',
        modelMatrix: new Float32Array([
          1,
          0,
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          0,
          1,
          0,
          fallbackWorldX,
          fallbackWorldY,
          fallbackWorldZ,
          1,
        ]),
        positions: sphereMesh.positions,
        normals: sphereMesh.normals,
        perVertexHslColors: sphereMesh.perVertexHslColors,
        depth: 'readwrite',
        zIndex: Z_LAYERS.PLAYER + 10,
      };
      queue.commands.push(sphereCommand);
    }
  }

  /**
   * Vertical lift applied to the player model, in world units.
   *
   * Two terms, both constant across an animation's frames:
   *   - `playerModelBottomY`: the rest-pose model bottom, so the feet sit on the
   *     terrain instead of sinking through it (OSRS hides sub-ground geometry
   *     with its painter's algorithm; a depth-tested renderer cannot).
   *   - the active sequence's `heightOffset` (SeqType opcode 16).
   *
   * Deliberately NOT per-frame. Measuring the posed model's lowest vertex each
   * frame tracks the whole model - weapon included - so any animation that
   * swings a weapon below foot level lifted the entire body off the ground.
   */
  private getPlayerModelLift(): number {
    const animationHeightOffset = this.playerAnimController?.getAnimationHeightOffset() ?? 0;
    return (this.playerModelBottomY + animationHeightOffset) / 128;
  }

  private createSphereMesh(
    radius: number,
    latSegments: number,
    lonSegments: number,
    hslColor: number,
  ): { positions: Float32Array; normals: Float32Array; perVertexHslColors: Float32Array } {
    const vertices: number[] = [];
    const normals: number[] = [];

    for (let lat = 0; lat <= latSegments; lat++) {
      const theta = (lat * Math.PI) / latSegments;
      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);

      for (let lon = 0; lon <= lonSegments; lon++) {
        const phi = (lon * 2 * Math.PI) / lonSegments;
        const sinPhi = Math.sin(phi);
        const cosPhi = Math.cos(phi);

        const x = cosPhi * sinTheta;
        const y = cosTheta;
        const z = sinPhi * sinTheta;

        vertices.push(radius * x, radius * y, radius * z);
        normals.push(x, y, z);
      }
    }

    const indices: number[] = [];
    for (let lat = 0; lat < latSegments; lat++) {
      for (let lon = 0; lon < lonSegments; lon++) {
        const first = lat * (lonSegments + 1) + lon;
        const second = first + lonSegments + 1;

        indices.push(first, second, first + 1);
        indices.push(second, second + 1, first + 1);
      }
    }

    const flatPositions: number[] = [];
    const flatNormals: number[] = [];
    const flatHslColors: number[] = [];

    for (const idx of indices) {
      flatPositions.push(vertices[idx * 3], vertices[idx * 3 + 1], vertices[idx * 3 + 2]);
      flatNormals.push(normals[idx * 3], normals[idx * 3 + 1], normals[idx * 3 + 2]);
      flatHslColors.push(hslColor);
    }

    return {
      positions: new Float32Array(flatPositions),
      normals: new Float32Array(flatNormals),
      perVertexHslColors: new Float32Array(flatHslColors),
    };
  }

  private buildTargetTile(
    queue: RenderQueue,
    projection: Projection2D,
    target: Coordinate,
    playerPos: Coordinate,
    tileIndicatorConfig: TileIndicatorConfig,
  ): void {
    if (target[0] === playerPos[0] && target[1] === playerPos[1]) return;
    if (!this.isInArenaFootprint(target)) return;

    const destinationConfig = tileIndicatorConfig.destinationTile;
    if (destinationConfig.enabled) {
      const color = rgbaFromHex(destinationConfig.color, destinationConfig.opacity);
      if (destinationConfig.cornerOnly) {
        const cornerCommands = tileCornerOutlineCommands(
          projection,
          target,
          color,
          Z_LAYERS.TARGET,
          0.3,
          destinationConfig.width,
        );
        queue.commands.push(...cornerCommands);
      } else {
        queue.commands.push(
          tilePolygonCommand(
            projection,
            target,
            undefined,
            { color, widthPx: destinationConfig.width },
            Z_LAYERS.TARGET,
          ),
        );
      }
    }
  }

  private buildHoveredTile(
    queue: RenderQueue,
    projection: Projection2D,
    hovered: Coordinate,
    showCoordinates: boolean,
    targetTile: Coordinate | null,
    playerPos: Coordinate,
    tileIndicatorConfig: TileIndicatorConfig,
  ): void {
    if (!this.isInArenaFootprint(hovered)) return;
    if (targetTile && hovered[0] === targetTile[0] && hovered[1] === targetTile[1]) return;
    if (hovered[0] === playerPos[0] && hovered[1] === playerPos[1]) return;

    const hoverConfig = tileIndicatorConfig.hoverTile;
    if (hoverConfig.enabled) {
      const color = rgbaFromHex(hoverConfig.color, hoverConfig.opacity);
      if (hoverConfig.cornerOnly) {
        const cornerCommands = tileCornerOutlineCommands(
          projection,
          hovered,
          color,
          Z_LAYERS.HOVER,
          0.3,
          hoverConfig.width,
        );
        queue.commands.push(...cornerCommands);
      } else {
        queue.commands.push(
          tilePolygonCommand(projection, hovered, undefined, { color, widthPx: hoverConfig.width }, Z_LAYERS.HOVER),
        );
      }
    }

    // Coordinate text is drawn as a DOM corner overlay in the viewport
    // (RenderViewport3D / RenderViewport), not in-canvas, so it stays legible
    // regardless of camera projection. `showCoordinates` still gates that overlay.
    void showCoordinates;
  }

  private static fillCornerGap(
    positions: number[],
    normals: number[],
    hslColors: number[],
    cx: number,
    cy: number,
    ch: number,
    hw: number,
    dirX: number,
    dirY: number,
    hslColor: number,
  ): void {
    const ex = cx + dirX * hw;
    const ey = cy + dirY * hw;
    positions.push(cx, cy, ch, ex, cy, ch, ex, ey, ch);
    positions.push(cx, cy, ch, ex, ey, ch, cx, ey, ch);
    normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1);
    normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1);
    hslColors.push(hslColor, hslColor, hslColor);
    hslColors.push(hslColor, hslColor, hslColor);
  }

  private getTileOverlayBounds(): Pick<ArenaBounds, 'minX' | 'maxX' | 'minY' | 'maxY'> {
    return this.terrainBounds ?? { minX: 0, maxX: GRID_SIZE - 1, minY: 0, maxY: GRID_SIZE - 1 };
  }

  protected createOutlineMesh3D(
    minTileX: number,
    minTileY: number,
    maxTileX: number,
    maxTileY: number,
    hslColor: number,
    lineWidth: number = 0.05,
    zIndex: number = Z_LAYERS.HOVER,
    opacity: number = 1,
  ): NpcMesh3DCommand {
    const heightOffset = 0.01;
    const hw = lineWidth / 2;
    const h = (gx: number, gy: number) => -getTerrainHeight(this.terrainHeights, gx, gy) / 128 + heightOffset;

    const positions: number[] = [];
    const normals: number[] = [];
    const hslColors: number[] = [];

    const addVertex = (x: number, y: number, z: number) => {
      positions.push(x, y, z);
      normals.push(0, 0, 1);
      hslColors.push(hslColor);
    };

    const addQuad = (
      ax: number,
      ay: number,
      az: number,
      bx: number,
      by: number,
      bz: number,
      cx: number,
      cy: number,
      cz: number,
      dx: number,
      dy: number,
      dz: number,
    ) => {
      addVertex(ax, ay, az);
      addVertex(bx, by, bz);
      addVertex(cx, cy, cz);
      addVertex(ax, ay, az);
      addVertex(cx, cy, cz);
      addVertex(dx, dy, dz);
    };

    const bounds = this.getTileOverlayBounds();
    const startX = Math.max(minTileX, bounds.minX);
    const endX = Math.min(maxTileX + 1, bounds.maxX + 1);
    const startY = Math.max(minTileY, bounds.minY);
    const endY = Math.min(maxTileY + 1, bounds.maxY + 1);
    const visibleX = (x: number) => x >= bounds.minX && x <= bounds.maxX + 1;
    const visibleY = (y: number) => y >= bounds.minY && y <= bounds.maxY + 1;

    for (let tx = startX; visibleY(minTileY) && tx < endX; tx++) {
      const wy = minTileY;
      const nextX = Math.min(tx + 1, endX);
      const hL = h(tx, minTileY);
      const hR = h(nextX, minTileY);
      addQuad(tx, wy - hw, hL, nextX, wy - hw, hR, nextX, wy + hw, hR, tx, wy + hw, hL);
    }
    for (let tx = startX; visibleY(maxTileY + 1) && tx < endX; tx++) {
      const wy = maxTileY + 1;
      const nextX = Math.min(tx + 1, endX);
      const hL = h(tx, maxTileY + 1);
      const hR = h(nextX, maxTileY + 1);
      addQuad(nextX, wy + hw, hR, tx, wy + hw, hL, tx, wy - hw, hL, nextX, wy - hw, hR);
    }
    for (let ty = startY; visibleX(maxTileX + 1) && ty < endY; ty++) {
      const wx = maxTileX + 1;
      const nextY = Math.min(ty + 1, endY);
      const hB = h(wx, ty);
      const hT = h(wx, nextY);
      addQuad(wx + hw, ty, hB, wx + hw, nextY, hT, wx - hw, nextY, hT, wx - hw, ty, hB);
    }
    for (let ty = startY; visibleX(minTileX) && ty < endY; ty++) {
      const wx = minTileX;
      const nextY = Math.min(ty + 1, endY);
      const hB = h(wx, ty);
      const hT = h(wx, nextY);
      addQuad(wx - hw, nextY, hT, wx - hw, ty, hB, wx + hw, ty, hB, wx + hw, nextY, hT);
    }

    for (const [x, y, dirX, dirY] of [
      [minTileX, minTileY, -1, -1],
      [maxTileX + 1, minTileY, 1, -1],
      [maxTileX + 1, maxTileY + 1, 1, 1],
      [minTileX, maxTileY + 1, -1, 1],
    ]) {
      if (visibleX(x) && visibleY(y)) {
        SceneCompositor.fillCornerGap(positions, normals, hslColors, x, y, h(x, y), hw, dirX, dirY, hslColor);
      }
    }

    const result: NpcMesh3DCommand = {
      kind: 'mesh3d',
      meshId: `outline-${minTileX}-${minTileY}-${maxTileX}-${maxTileY}-${hslColor}-${opacity}-${lineWidth}`,
      materialId: 'tile-outline',
      cullFace: 'none',
      modelMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      perVertexHslColors: new Float32Array(hslColors),
      depth: 'none',
      zIndex,
    };
    if (opacity < 1) {
      const vertexCount = positions.length / 3;
      result.perVertexAlphas = new Float32Array(vertexCount).fill(opacity);
    }
    return result;
  }

  private createCornerOutlineMesh3D(
    tileX: number,
    tileY: number,
    hslColor: number,
    lineWidth: number = 0.03,
    cornerRatio: number = 0.25,
    zIndex: number = Z_LAYERS.HOVER,
    opacity: number = 1,
  ): NpcMesh3DCommand {
    const heightOffset = 0.01;

    const hSW = -getTerrainHeight(this.terrainHeights, tileX, tileY) / 128 + heightOffset;
    const hSE = -getTerrainHeight(this.terrainHeights, tileX + 1, tileY) / 128 + heightOffset;
    const hNE = -getTerrainHeight(this.terrainHeights, tileX + 1, tileY + 1) / 128 + heightOffset;
    const hNW = -getTerrainHeight(this.terrainHeights, tileX, tileY + 1) / 128 + heightOffset;

    const x0 = tileX;
    const x1 = tileX + 1;
    const y0 = tileY;
    const y1 = tileY + 1;
    const hw = lineWidth / 2;
    const cr = cornerRatio;

    const positions: number[] = [];
    const normals: number[] = [];
    const hslColors: number[] = [];

    const addVertex = (x: number, y: number, z: number) => {
      positions.push(x, y, z);
      normals.push(0, 0, 1);
      hslColors.push(hslColor);
    };

    const addQuad = (
      ax: number,
      ay: number,
      az: number,
      bx: number,
      by: number,
      bz: number,
      cx: number,
      cy: number,
      cz: number,
      dx: number,
      dy: number,
      dz: number,
    ) => {
      addVertex(ax, ay, az);
      addVertex(bx, by, bz);
      addVertex(cx, cy, cz);
      addVertex(ax, ay, az);
      addVertex(cx, cy, cz);
      addVertex(dx, dy, dz);
    };

    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

    const swSouthEndX = lerp(x0, x1, cr);
    const swSouthEndH = lerp(hSW, hSE, cr);
    addQuad(x0, y0 - hw, hSW, swSouthEndX, y0 - hw, swSouthEndH, swSouthEndX, y0 + hw, swSouthEndH, x0, y0 + hw, hSW);
    const swWestEndY = lerp(y0, y1, cr);
    const swWestEndH = lerp(hSW, hNW, cr);
    addQuad(x0 - hw, y0, hSW, x0 - hw, swWestEndY, swWestEndH, x0 + hw, swWestEndY, swWestEndH, x0 + hw, y0, hSW);

    const seSouthStartX = lerp(x1, x0, cr);
    const seSouthStartH = lerp(hSE, hSW, cr);
    addQuad(
      seSouthStartX,
      y0 - hw,
      seSouthStartH,
      x1,
      y0 - hw,
      hSE,
      x1,
      y0 + hw,
      hSE,
      seSouthStartX,
      y0 + hw,
      seSouthStartH,
    );
    const seEastEndY = lerp(y0, y1, cr);
    const seEastEndH = lerp(hSE, hNE, cr);
    addQuad(x1 + hw, y0, hSE, x1 + hw, seEastEndY, seEastEndH, x1 - hw, seEastEndY, seEastEndH, x1 - hw, y0, hSE);

    const neNorthStartX = lerp(x1, x0, cr);
    const neNorthStartH = lerp(hNE, hNW, cr);
    addQuad(
      x1,
      y1 + hw,
      hNE,
      neNorthStartX,
      y1 + hw,
      neNorthStartH,
      neNorthStartX,
      y1 - hw,
      neNorthStartH,
      x1,
      y1 - hw,
      hNE,
    );
    const neEastStartY = lerp(y1, y0, cr);
    const neEastStartH = lerp(hNE, hSE, cr);
    addQuad(
      x1 + hw,
      neEastStartY,
      neEastStartH,
      x1 + hw,
      y1,
      hNE,
      x1 - hw,
      y1,
      hNE,
      x1 - hw,
      neEastStartY,
      neEastStartH,
    );

    const nwNorthEndX = lerp(x0, x1, cr);
    const nwNorthEndH = lerp(hNW, hNE, cr);
    addQuad(nwNorthEndX, y1 + hw, nwNorthEndH, x0, y1 + hw, hNW, x0, y1 - hw, hNW, nwNorthEndX, y1 - hw, nwNorthEndH);
    const nwWestStartY = lerp(y1, y0, cr);
    const nwWestStartH = lerp(hNW, hSW, cr);
    addQuad(
      x0 - hw,
      nwWestStartY,
      nwWestStartH,
      x0 - hw,
      y1,
      hNW,
      x0 + hw,
      y1,
      hNW,
      x0 + hw,
      nwWestStartY,
      nwWestStartH,
    );

    SceneCompositor.fillCornerGap(positions, normals, hslColors, x0, y0, hSW, hw, -1, -1, hslColor);
    SceneCompositor.fillCornerGap(positions, normals, hslColors, x1, y0, hSE, hw, 1, -1, hslColor);
    SceneCompositor.fillCornerGap(positions, normals, hslColors, x1, y1, hNE, hw, 1, 1, hslColor);
    SceneCompositor.fillCornerGap(positions, normals, hslColors, x0, y1, hNW, hw, -1, 1, hslColor);

    const result: NpcMesh3DCommand = {
      kind: 'mesh3d',
      meshId: `corner-outline-${tileX}-${tileY}-${hslColor}-${opacity}-${lineWidth}`,
      materialId: 'tile-outline',
      cullFace: 'none',
      modelMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      perVertexHslColors: new Float32Array(hslColors),
      depth: 'none',
      zIndex,
    };
    if (opacity < 1) {
      const vertexCount = positions.length / 3;
      result.perVertexAlphas = new Float32Array(vertexCount).fill(opacity);
    }
    return result;
  }

  private hexToPackedHsl(hex: string): number {
    const normalized = hex.startsWith('#') ? hex.slice(1) : hex;
    const fullHex =
      normalized.length === 3
        ? normalized
            .split('')
            .map((c) => c + c)
            .join('')
        : normalized;

    if (!/^[0-9a-fA-F]{6}$/.test(fullHex)) {
      return packHsl(0, 0, 127);
    }

    const r = Number.parseInt(fullHex.slice(0, 2), 16) / 255;
    const g = Number.parseInt(fullHex.slice(2, 4), 16) / 255;
    const b = Number.parseInt(fullHex.slice(4, 6), 16) / 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    const l = (max + min) / 2;

    let h = 0;
    let s = 0;

    if (delta !== 0) {
      s = delta / (1 - Math.abs(2 * l - 1));
      if (max === r) {
        h = 60 * (((g - b) / delta) % 6);
      } else if (max === g) {
        h = 60 * ((b - r) / delta + 2);
      } else {
        h = 60 * ((r - g) / delta + 4);
      }
    }

    if (h < 0) {
      h += 360;
    }

    const osrsH = Math.max(0, Math.min(255, Math.round((h / 360) * 255)));
    const osrsS = Math.max(0, Math.min(255, Math.round(s * 255)));
    const osrsL = Math.max(0, Math.min(255, Math.round(l * 255)));
    return packHsl(osrsH, osrsS, osrsL);
  }

  /**
   * Inferno or Colosseum Additions' marks on the tiles under each standing pillar of `locIds`,
   * hidden or not, as the
   * plugin's overlay draws them: one outline around the footprint in the tile color (line, and
   * bordered over RuneLite's black 50/255 polygon fill), or the footprint filled in that color at
   * an alpha of at least 40/255 (TzhaarColoAdditionsOverlay.java). 3D only, where pillars are drawn.
   */
  private buildPillarTileMarkers(
    queue: RenderQueue,
    locIds: ReadonlySet<number>,
    options: PillarAdditionsOptions,
  ): void {
    if (!this.terrainHeights) return;
    const footprints = [
      ...this.locRenderer.getLocFootprints(locIds),
      ...(this.sceneObjectRenderer?.getLocFootprints(locIds) ?? []),
    ];
    if (footprints.length === 0) return;

    const style = options.pillarMarkerStyle;
    const packedHsl = this.hexToPackedHsl(options.pillarTileColor);
    const fill =
      style === 'tileFill'
        ? { hsl: packedHsl, alpha: Math.max(options.pillarTileOpacity, PILLAR_TILE_FILL_MIN_ALPHA) }
        : style === 'borderedTile'
          ? { hsl: TILE_MARKER_FILL_HSL, alpha: RUNELITE_POLYGON_FILL_ALPHA }
          : null;
    for (const { x, y, sizeX, sizeY } of footprints) {
      if (fill) {
        for (let tx = x; tx < x + sizeX; tx++) {
          for (let ty = y; ty < y + sizeY; ty++) {
            this.pushTileMesh3D(
              queue,
              tx,
              ty,
              fill.hsl,
              fill.alpha,
              `pillar-tile-fill-${fill.hsl}-${fill.alpha}`,
              0.008,
              Z_LAYERS.TILE_MARKERS - 1,
            );
          }
        }
      }
      if (style !== 'tileFill' && options.pillarTileOpacity > 0) {
        queue.commands.push(
          this.createOutlineMesh3D(
            x,
            y,
            x + sizeX - 1,
            y + sizeY - 1,
            packedHsl,
            markerWidthWorld(PILLAR_TILE_STROKE_WIDTH),
            Z_LAYERS.TILE_MARKERS,
            options.pillarTileOpacity,
          ),
        );
      }
    }
  }

  private buildTileMarkers(
    queue: RenderQueue,
    projection: Projection2D,
    markers: TileMarker[],
    is2D: boolean,
    showLabels: boolean = true,
    uiWidth: number = DEFAULT_TILE_MARKER_WIDTH,
  ): void {
    if (!is2D && !this.terrainHeights) return;

    const width = clampTileWidth(uiWidth);

    for (const marker of markers) {
      const fillAlpha = marker.fillOpacity ?? 0;
      if (is2D) {
        queue.commands.push(
          tilePolygonCommand(
            projection,
            [marker.x, marker.y],
            fillAlpha > 0 ? rgba(0, 0, 0, fillAlpha) : undefined,
            marker.opacity > 0 ? { color: rgbaFromHex(marker.color, marker.opacity), widthPx: width } : undefined,
            Z_LAYERS.TILE_MARKERS,
          ),
        );
      } else {
        const packedHsl = this.hexToPackedHsl(marker.color);
        if (fillAlpha > 0) {
          // Alpha is baked into the vertex buffers and the meshId is the VAO cache
          // key, so it belongs in the id — without it the cache keeps serving the
          // buffers built at the previous fill and the slider stops doing anything.
          this.pushTileMesh3D(
            queue,
            marker.x,
            marker.y,
            TILE_MARKER_FILL_HSL,
            fillAlpha,
            `tile-marker-fill-${fillAlpha}`,
            0.008,
            Z_LAYERS.TILE_MARKERS - 1,
          );
        }
        // A fully transparent border means "fill only", so skip outline meshes that draw nothing.
        if (marker.opacity > 0) {
          queue.commands.push(
            this.createOutlineMesh3D(
              marker.x,
              marker.y,
              marker.x,
              marker.y,
              packedHsl,
              markerWidthWorld(width),
              Z_LAYERS.TILE_MARKERS,
              marker.opacity,
            ),
          );
        }
      }
    }

    if (!showLabels) return;

    for (const marker of markers) {
      const label = marker.label?.trim();
      if (!label) {
        continue;
      }

      if (is2D) {
        const corners = projection.tilePolygonScreen({ x: marker.x, y: marker.y });
        if (corners.length === 0) {
          continue;
        }
        const center = corners.reduce(
          (acc, corner) => {
            acc.x += corner.x;
            acc.y += corner.y;
            return acc;
          },
          vec2(0, 0),
        );
        center.x /= corners.length;
        center.y /= corners.length;

        queue.commands.push({
          kind: 'text2d',
          position: vec2(center.x - label.length * 3, center.y + 4),
          text: label,
          color: rgbaFromHex(marker.color),
          font: '16px "RuneScape Small", sans-serif',
          zIndex: Z_LAYERS.TEXT,
          shadow: { color: rgba(0, 0, 0, 1), blurPx: 0, offsetPx: vec2(1, 1) },
        });
      } else {
        const centerX = marker.x + 0.5;
        const centerY = marker.y + 0.5;
        const terrainHeight = -getTerrainHeightInterpolated(this.terrainHeights, centerX, centerY) / 128;
        const screen = projection.tileToScreen({
          x: centerX,
          y: centerY,
          level: terrainHeight,
        });
        if (!screen) continue;

        if (!queue.tileMarkerLabels) {
          queue.tileMarkerLabels = [];
        }

        queue.tileMarkerLabels.push({
          screenX: screen.x,
          screenY: screen.y,
          text: label,
          color: marker.color,
          key: `${marker.x},${marker.y}`,
        });
      }
    }
  }

  private buildLineMarkers(
    queue: RenderQueue,
    projection: Projection2D,
    lines: LineMarker[],
    is2D: boolean,
    showLabels: boolean = true,
    uiWidth: number = DEFAULT_LINE_MARKER_WIDTH,
  ): void {
    if (!is2D && !this.terrainHeights) return;

    const width = clampLineWidth(uiWidth);
    const styles = new Map<string, LineMarker[]>();
    for (const line of lines) {
      const key = `${line.color}-${line.opacity}`;
      const group = styles.get(key);
      if (group) group.push(line);
      else styles.set(key, [line]);
    }
    for (const group of styles.values()) {
      const { color, opacity } = group[0];
      const edges = group.map((line) => {
        const { ax, ay, bx, by } = lineMarkerEndpoints(line);
        return [
          [ax, ay],
          [bx, by],
        ] satisfies [Coordinate, Coordinate];
      });
      queue.commands.push(
        ...this.createJoinedEdgeCommands(edges, is2D ? projection : null, {
          color: rgbaFromHex(color, opacity),
          widthPx: width,
          hslColor: this.hexToPackedHsl(color),
          zIndex: Z_LAYERS.TILE_MARKERS,
        }),
      );
    }

    if (!showLabels) return;

    for (const line of lines) {
      const label = line.label?.trim();
      if (!label) continue;

      const { ax, ay, bx, by } = lineMarkerEndpoints(line);
      const midX = (ax + bx) / 2;
      const midY = (ay + by) / 2;

      if (is2D) {
        const screen = projection.tileToScreen({ x: midX, y: midY, level: 0 });
        if (!screen) continue;
        queue.commands.push({
          kind: 'text2d',
          position: vec2(screen.x - label.length * 3, screen.y + 4),
          text: label,
          color: rgbaFromHex(line.color),
          font: '16px "RuneScape Small", sans-serif',
          zIndex: Z_LAYERS.TEXT,
          shadow: { color: rgba(0, 0, 0, 1), blurPx: 0, offsetPx: vec2(1, 1) },
        });
      } else {
        const terrainHeight = -getTerrainHeightInterpolated(this.terrainHeights, midX, midY) / 128;
        const screen = projection.tileToScreen({ x: midX, y: midY, level: terrainHeight });
        if (!screen) continue;
        if (!queue.tileMarkerLabels) {
          queue.tileMarkerLabels = [];
        }
        queue.tileMarkerLabels.push({
          screenX: screen.x,
          screenY: screen.y,
          text: label,
          color: line.color,
          key: `line:${line.orientation}:${line.x},${line.y}`,
        });
      }
    }
  }

  protected createJoinedEdgeCommands(
    edges: readonly (readonly [Coordinate, Coordinate])[],
    projection: Projection2D | null,
    style: StrokeStyle & { readonly hslColor: number; readonly zIndex: number },
  ): RenderCommand[] {
    const commands: RenderCommand[] = [];
    const { hslColor, zIndex, ...stroke } = style;
    const width = markerWidthWorld(stroke.widthPx);
    const opacity = stroke.color.a;
    const junctions = new Map<string, { readonly position: Coordinate; readonly neighbors: Coordinate[] }>();
    for (const [start, end] of edges) {
      for (const [position, neighbor] of [
        [start, end],
        [end, start],
      ]) {
        const key = position.join(',');
        const junction = junctions.get(key);
        if (junction) junction.neighbors.push(neighbor);
        else junctions.set(key, { position, neighbors: [neighbor] });
      }
      if (!projection) {
        commands.push(this.createEdgeMesh3D(start[0], start[1], end[0], end[1], hslColor, width, zIndex, opacity));
      }
    }
    for (const {
      position: [x, y],
      neighbors,
    } of junctions.values()) {
      if (projection) {
        const pairs =
          neighbors.length >= 3
            ? [neighbors.filter(([nx]) => nx === x), neighbors.filter(([, ny]) => ny === y)]
            : [neighbors];
        for (const [first, second] of pairs) {
          const start = projection.tileToScreen({ x: (x + first[0]) / 2, y: (y + first[1]) / 2, level: 0 });
          const corner = projection.tileToScreen({ x, y, level: 0 });
          const end = second
            ? projection.tileToScreen({ x: (x + second[0]) / 2, y: (y + second[1]) / 2, level: 0 })
            : corner;
          if (!start || !corner || !end) continue;
          commands.push({
            kind: 'poly2d',
            points: (second ? [start, corner, end] : [start, corner]).map((point) => vec2(point.x, point.y)),
            stroke,
            closePath: false,
            zIndex,
          });
        }
      } else {
        if (neighbors.length !== 2) continue;
        const dirX = neighbors.reduce((sum, [nx]) => sum + x - nx, 0);
        const dirY = neighbors.reduce((sum, [, ny]) => sum + y - ny, 0);
        if (dirX === 0 || dirY === 0) continue;
        const positions: number[] = [];
        const normals: number[] = [];
        const colors: number[] = [];
        SceneCompositor.fillCornerGap(
          positions,
          normals,
          colors,
          x,
          y,
          -getTerrainHeight(this.terrainHeights, x, y) / 128 + 0.01,
          width / 2,
          dirX,
          dirY,
          hslColor,
        );
        const cornerMesh: NpcMesh3DCommand = {
          kind: 'mesh3d',
          meshId: `edge-join-${x}-${y}-${dirX}-${dirY}-${hslColor}-${opacity}-${width}`,
          materialId: 'tile-outline',
          cullFace: 'none',
          modelMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
          positions: new Float32Array(positions),
          normals: new Float32Array(normals),
          perVertexHslColors: new Float32Array(colors),
          perVertexAlphas: new Float32Array(positions.length / 3).fill(opacity),
          depth: 'none',
          zIndex,
        };
        commands.push(cornerMesh);
      }
    }
    return commands;
  }

  private createEdgeMesh3D(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    hslColor: number,
    lineWidth: number = markerWidthWorld(DEFAULT_LINE_MARKER_WIDTH),
    zIndex: number = Z_LAYERS.TILE_MARKERS,
    opacity: number = 1,
  ): NpcMesh3DCommand {
    const heightOffset = 0.01;
    const hw = lineWidth / 2;
    const h = (gx: number, gy: number) => -getTerrainHeight(this.terrainHeights, gx, gy) / 128 + heightOffset;

    const positions: number[] = [];
    const normals: number[] = [];
    const hslColors: number[] = [];

    const addVertex = (x: number, y: number, z: number) => {
      positions.push(x, y, z);
      normals.push(0, 0, 1);
      hslColors.push(hslColor);
    };

    const hA = h(ax, ay);
    const hB = h(bx, by);
    const horizontal = ay === by;
    const ox = horizontal ? 0 : hw;
    const oy = horizontal ? hw : 0;

    addVertex(ax - ox, ay - oy, hA);
    addVertex(bx - ox, by - oy, hB);
    addVertex(bx + ox, by + oy, hB);
    addVertex(ax - ox, ay - oy, hA);
    addVertex(bx + ox, by + oy, hB);
    addVertex(ax + ox, ay + oy, hA);

    const result: NpcMesh3DCommand = {
      kind: 'mesh3d',
      meshId: `edge-${ax}-${ay}-${bx}-${by}-${hslColor}-${opacity}-${lineWidth}`,
      materialId: 'tile-outline',
      cullFace: 'none',
      modelMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      perVertexHslColors: new Float32Array(hslColors),
      depth: 'none',
      zIndex,
    };
    if (opacity < 1) {
      const vertexCount = positions.length / 3;
      result.perVertexAlphas = new Float32Array(vertexCount).fill(opacity);
    }
    return result;
  }

  private buildNpcHighlights(
    queue: RenderQueue,
    projection: Projection2D,
    highlights: NpcHighlightEntry[],
    npcs: NpcSnapshot[],
    is2D: boolean,
  ): void {
    const highlightsByNpcType = new Map<number, NpcHighlightEntry[]>();
    for (const highlight of highlights) {
      const group = highlightsByNpcType.get(highlight.npcTypeId);
      if (group) {
        group.push(highlight);
      } else {
        highlightsByNpcType.set(highlight.npcTypeId, [highlight]);
      }
    }

    const draws: NpcHighlightDraw[] = [];
    for (const npc of npcs) {
      if (!npc.alive) continue;
      for (const highlight of highlightsByNpcType.get(npc.npcTypeId) ?? []) {
        draws.push({ npc, mode: highlight.mode, color: highlight.color });
      }
    }
    this.drawNpcHighlights(queue, projection, draws, is2D);
  }

  /**
   * TzHaar HP Tracker's highlight: every tracked NPC in its alive or dead color. A dead one keeps its
   * mark until it leaves the snapshot, as the plugin marks an NPC it hides.
   */
  private buildTzhaarHighlights(
    queue: RenderQueue,
    projection: Projection2D,
    options: TzhaarHpTrackerOptions,
    npcs: NpcSnapshot[],
    is2D: boolean,
  ): void {
    const style = options.highlightStyle;
    if (style === 'none') return;
    const draws: NpcHighlightDraw[] = [];
    for (const npc of npcs) {
      if (isTzhaarTrackedNpc(npc.npcTypeId)) {
        draws.push({ npc, mode: style, color: tzhaarHighlightColor(npc, options) });
      }
    }
    this.drawNpcHighlights(queue, projection, draws, is2D);
  }

  /** The NPC highlight renderer every highlighting plugin draws through. */
  private drawNpcHighlights(
    queue: RenderQueue,
    projection: Projection2D,
    draws: readonly NpcHighlightDraw[],
    is2D: boolean,
  ): void {
    if (draws.length === 0 || (!is2D && !this.terrainHeights)) return;

    let hitDataByActorId: Map<string, NpcHitTestData> | null = null;
    const bounds = this.getTileOverlayBounds();

    for (const { npc, mode, color } of draws) {
      const startX = Math.max(npc.position[0], bounds.minX);
      const endX = Math.min(npc.position[0] + npc.size, bounds.maxX + 1);
      const startY = Math.max(npc.position[1], bounds.minY);
      const endY = Math.min(npc.position[1] + npc.size, bounds.maxY + 1);

      if (mode === 'trueTile') {
        if (is2D) {
          for (let tx = startX; tx < endX; tx++) {
            for (let ty = startY; ty < endY; ty++) {
              queue.commands.push(
                tilePolygonCommand(
                  projection,
                  [tx, ty],
                  undefined,
                  { color: rgbaFromHex(color), widthPx: 2 },
                  Z_LAYERS.TILE_MARKERS + 1,
                ),
              );
            }
          }
        } else {
          const packedHsl = this.hexToPackedHsl(color);
          queue.commands.push(
            this.createOutlineMesh3D(
              npc.position[0],
              npc.position[1],
              npc.position[0] + npc.size - 1,
              npc.position[1] + npc.size - 1,
              packedHsl,
              0.04,
              Z_LAYERS.TILE_MARKERS + 1,
            ),
          );
        }
        continue;
      }

      if (mode === 'swTile') {
        if (is2D) {
          queue.commands.push(
            tilePolygonCommand(
              projection,
              [npc.position[0], npc.position[1]],
              undefined,
              { color: rgbaFromHex(color), widthPx: 2 },
              Z_LAYERS.TILE_MARKERS + 1,
            ),
          );
        } else {
          const packedHsl = this.hexToPackedHsl(color);
          queue.commands.push(
            this.createOutlineMesh3D(
              npc.position[0],
              npc.position[1],
              npc.position[0],
              npc.position[1],
              packedHsl,
              0.04,
              Z_LAYERS.TILE_MARKERS + 1,
            ),
          );
        }
        continue;
      }

      if (mode !== 'clickbox') continue;

      if (is2D) {
        for (let tx = startX; tx < endX; tx++) {
          for (let ty = startY; ty < endY; ty++) {
            queue.commands.push(
              tilePolygonCommand(
                projection,
                [tx, ty],
                undefined,
                { color: rgbaFromHex(color), widthPx: 2 },
                Z_LAYERS.TILE_MARKERS + 1,
              ),
            );
          }
        }
        continue;
      }

      const actorId = this.npcRenderIdOf(npc);
      // A model a hiding plugin left undrawn has no surface to paint.
      if (this.hiddenNpcRenderIds.has(actorId)) continue;
      hitDataByActorId ??= new Map<string, NpcHitTestData>(
        this.npcInstanceManager.getAllHitTestData().map(({ actorId, hitTestData }) => [actorId, hitTestData]),
      );
      const hitTestData = hitDataByActorId.get(actorId);
      if (!hitTestData) continue;

      const { verticesX, verticesY, verticesZ, indices1, indices2, indices3, faceCount, faceColors3, modelMatrix } =
        hitTestData;
      const positions: number[] = [];
      const normals: number[] = [];
      const hslColors: number[] = [];
      const alphas: number[] = [];
      const packedHsl = this.hexToPackedHsl(color);
      const alpha = 0.3;

      for (let f = 0; f < faceCount; f++) {
        if (faceColors3 && faceColors3[f] === -2) continue;

        const i1 = indices1[f];
        const i2 = indices2[f];
        const i3 = indices3[f];

        const x1 = verticesX[i1],
          y1 = verticesY[i1],
          z1 = verticesZ[i1];
        const x2 = verticesX[i2],
          y2 = verticesY[i2],
          z2 = verticesZ[i2];
        const x3 = verticesX[i3],
          y3 = verticesY[i3],
          z3 = verticesZ[i3];

        const ex = x2 - x1,
          ey = y2 - y1,
          ez = z2 - z1;
        const fx = x3 - x1,
          fy = y3 - y1,
          fz = z3 - z1;
        let nx = ey * fz - ez * fy;
        let ny = ez * fx - ex * fz;
        let nz = ex * fy - ey * fx;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 0) {
          nx /= len;
          ny /= len;
          nz /= len;
        }

        positions.push(x1, y1, z1, x2, y2, z2, x3, y3, z3);
        normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
        hslColors.push(packedHsl, packedHsl, packedHsl);
        alphas.push(alpha, alpha, alpha);
      }

      if (positions.length === 0) continue;

      queue.commands.push({
        kind: 'mesh3d',
        meshId: `npc-highlight-clickbox-${actorId}-${color}`,
        materialId: 'tile-outline',
        modelMatrix,
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        perVertexHslColors: new Float32Array(hslColors),
        perVertexAlphas: new Float32Array(alphas),
        blend: 'normal',
        // 'readwrite': write depth so only the NEAREST front face draws per pixel — one
        // uniform translucent layer instead of cumulative stacking where model faces
        // overlap. depthBias wins against the coincident model surface, and building this
        // after updateAnimations keeps the overlay frame-synced with the model (no lag).
        depth: 'readwrite',
        cullFace: 'back',
        zIndex: Z_LAYERS.HOVER - 1,
        animated: true,
        depthBias: (hitTestData.depthBias ?? 0) + NPC_CLICKBOX_OVERLAY_DEPTH_BIAS,
      } as NpcMesh3DCommand);
    }
  }

  /**
   * The hiding plugins' verdict on this frame's NPC models, by render id (the encounter's primary NPC
   * under its alias). Also what makes their clickboxes unpickable. Undefined, allocating nothing,
   * while neither plugin is on.
   */
  private resolveHiddenNpcModels(
    npcs: readonly NpcSnapshot[],
    plugins: NpcHidingPlugins,
  ): ((actorId: string, npcTypeId: number, dying: boolean) => boolean) | undefined {
    if (!hasNpcHidingPlugin(plugins)) {
      if (this.hiddenNpcRenderIds.size > 0) this.hiddenNpcRenderIds = new Set();
      return undefined;
    }
    const snapshotRenderIds = new Set<string>();
    const hidden = new Set<string>();
    for (const npc of npcs) {
      const renderId = this.npcRenderIdOf(npc);
      snapshotRenderIds.add(renderId);
      if (isNpcModelHidden(npc, plugins, PLAYER_ACTOR_ID)) hidden.add(renderId);
    }
    this.hiddenNpcRenderIds = hidden;
    return (actorId, npcTypeId, dying) =>
      snapshotRenderIds.has(actorId)
        ? hidden.has(actorId)
        : isNpcModelHidden(npcVisibilityFactsWithoutSnapshot(npcTypeId, dying), plugins, PLAYER_ACTOR_ID);
  }

  /**
   * The render instance a snapshot NPC syncs to. Resolve snapshot NPCs through this, never an inline
   * comparison or a role check: an encounter without a configured primary NPC (the Inferno) keeps
   * its boss under its own id. Override alongside `syncNpcInstances` when that remaps ids differently.
   */
  protected npcRenderIdOf(npc: NpcSnapshot): string {
    return this.actorRenderIdOf(npc.id);
  }

  /**
   * The render instance id for a simulation actor id (event, cue, target or projectile actor): the
   * configured primary NPC's actor under `PRIMARY_NPC_ACTOR_ID`, any other id unchanged.
   */
  protected actorRenderIdOf(actorId: string): string {
    return actorId === this.encounterRenderConfig?.primaryNpc?.actorId ? PRIMARY_NPC_ACTOR_ID : actorId;
  }

  /** Draw the synced NPC instances, leaving out the models this frame's hiding plugins keep undrawn. */
  protected renderNpcModels(queue: RenderQueue): void {
    this.npcInstanceManager.renderAll(queue, this.isNpcRenderInstanceHidden);
  }

  buildTileOutlines3D(
    queue: RenderQueue,
    hoveredTile: Coordinate | null,
    targetTile: Coordinate | null,
    simulationState: SimulationState,
    tileIndicatorConfig: TileIndicatorConfig,
  ): void {
    if (!this.terrainHeights) return;
    const playerTile = simulationState.playerPosition;
    const po = simulationState.playerOutline;
    const tileIndicatorStyleKey = (style?: TileIndicatorStyle): string => {
      if (!style) return 'n';
      return `${style.enabled ? 1 : 0},${style.color},${style.opacity},${style.width},${style.cornerOnly ? 1 : 0}`;
    };
    let key = `${hoveredTile?.[0] ?? 'n'},${hoveredTile?.[1] ?? 'n'}|${targetTile?.[0] ?? 'n'},${targetTile?.[1] ?? 'n'}|${playerTile[0]},${playerTile[1]}|${po ? `${po.style},${po.color},${po.lineWidth ?? ''}` : 'n'}|ti:${tileIndicatorStyleKey(tileIndicatorConfig?.trueTile)}|${tileIndicatorStyleKey(tileIndicatorConfig?.destinationTile)}|${tileIndicatorStyleKey(tileIndicatorConfig?.hoverTile)}`;
    for (const npc of simulationState.npcs) {
      if (!npc.outline || !npc.alive) continue;
      const o = npc.outline;
      key += `|${npc.position[0]},${npc.position[1]},${npc.size},${o.style},${o.color},${o.lineWidth ?? ''}`;
    }

    if (key === this.cachedTileOutlines3DKey && this.cachedTileOutlines3DCommands.length > 0) {
      queue.commands.push(...this.cachedTileOutlines3DCommands);
    } else {
      const commands: RenderCommand[] = [];

      if (this.isInArenaFootprint(playerTile)) {
        const trueTileConfig = tileIndicatorConfig.trueTile;
        if (trueTileConfig.enabled) {
          const trueTileHsl = this.hexToPackedHsl(trueTileConfig.color);
          const lineWidth = trueTileConfig.width * 0.02;
          if (trueTileConfig.cornerOnly) {
            commands.push(
              this.createCornerOutlineMesh3D(
                playerTile[0],
                playerTile[1],
                trueTileHsl,
                lineWidth,
                0.25,
                Z_LAYERS.HOVER,
                trueTileConfig.opacity,
              ),
            );
          } else {
            commands.push(
              this.createOutlineMesh3D(
                playerTile[0],
                playerTile[1],
                playerTile[0],
                playerTile[1],
                trueTileHsl,
                lineWidth,
                Z_LAYERS.HOVER,
                trueTileConfig.opacity,
              ),
            );
          }
        }
      }
      for (const npc of simulationState.npcs) {
        if (!npc.outline || !npc.alive) continue;
        const o = npc.outline;
        const lw = o.lineWidth ?? 0.03;
        const sizeOffset = npc.size - 1;
        if (o.style === 'corner') {
          commands.push(this.createCornerOutlineMesh3D(npc.position[0], npc.position[1], o.color, lw));
        } else {
          commands.push(
            this.createOutlineMesh3D(
              npc.position[0],
              npc.position[1],
              npc.position[0] + sizeOffset,
              npc.position[1] + sizeOffset,
              o.color,
              lw,
            ),
          );
        }
      }
      if (
        targetTile &&
        (targetTile[0] !== playerTile[0] || targetTile[1] !== playerTile[1]) &&
        this.isInArenaFootprint(targetTile)
      ) {
        const destinationConfig = tileIndicatorConfig.destinationTile;
        if (destinationConfig.enabled) {
          const destinationHsl = this.hexToPackedHsl(destinationConfig.color);
          const lineWidth = destinationConfig.width * 0.02;
          if (destinationConfig.cornerOnly) {
            commands.push(
              this.createCornerOutlineMesh3D(
                targetTile[0],
                targetTile[1],
                destinationHsl,
                lineWidth,
                0.25,
                Z_LAYERS.HOVER,
                destinationConfig.opacity,
              ),
            );
          } else {
            commands.push(
              this.createOutlineMesh3D(
                targetTile[0],
                targetTile[1],
                targetTile[0],
                targetTile[1],
                destinationHsl,
                lineWidth,
                Z_LAYERS.HOVER,
                destinationConfig.opacity,
              ),
            );
          }
        }
      }
      if (
        hoveredTile &&
        (hoveredTile[0] !== playerTile[0] || hoveredTile[1] !== playerTile[1]) &&
        (!targetTile || hoveredTile[0] !== targetTile[0] || hoveredTile[1] !== targetTile[1]) &&
        this.isInArenaFootprint(hoveredTile)
      ) {
        const hoverConfig = tileIndicatorConfig.hoverTile;
        if (hoverConfig.enabled) {
          const hoverHsl = this.hexToPackedHsl(hoverConfig.color);
          const lineWidth = hoverConfig.width * 0.02;
          if (hoverConfig.cornerOnly) {
            commands.push(
              this.createCornerOutlineMesh3D(
                hoveredTile[0],
                hoveredTile[1],
                hoverHsl,
                lineWidth,
                0.25,
                Z_LAYERS.HOVER,
                hoverConfig.opacity,
              ),
            );
          } else {
            commands.push(
              this.createOutlineMesh3D(
                hoveredTile[0],
                hoveredTile[1],
                hoveredTile[0],
                hoveredTile[1],
                hoverHsl,
                lineWidth,
                Z_LAYERS.HOVER,
                hoverConfig.opacity,
              ),
            );
          }
        }
      }
      this.cachedTileOutlines3DKey = key;
      this.cachedTileOutlines3DCommands = commands;
      queue.commands.push(...commands);
    }
  }

  private buildNpcOverlayHeightsMap(npcs: NpcSnapshot[]): Map<string, NpcOverlayHeights> {
    const map = new Map<string, NpcOverlayHeights>();
    for (const npc of npcs) {
      const actorId = this.npcRenderIdOf(npc);
      const heights = this.npcInstanceManager.getNpcOverlayHeights(actorId);
      if (heights) map.set(npc.id, heights);
    }
    return map;
  }

  buildNpcClickboxOverlay3D(queue: RenderQueue): void {
    const allHitData = this.npcInstanceManager.getAllHitTestData();
    if (allHitData.length === 0) return;

    const redHsl = packHsl(0, 255, 100);
    const alpha = 0.3;

    for (const { actorId, hitTestData } of allHitData) {
      const { verticesX, verticesY, verticesZ, indices1, indices2, indices3, faceCount, faceColors3, modelMatrix } =
        hitTestData;

      const positions: number[] = [];
      const normals: number[] = [];
      const hslColors: number[] = [];
      const alphas: number[] = [];

      for (let f = 0; f < faceCount; f++) {
        if (faceColors3 && faceColors3[f] === -2) continue;

        const i1 = indices1[f];
        const i2 = indices2[f];
        const i3 = indices3[f];

        const x1 = verticesX[i1],
          y1 = verticesY[i1],
          z1 = verticesZ[i1];
        const x2 = verticesX[i2],
          y2 = verticesY[i2],
          z2 = verticesZ[i2];
        const x3 = verticesX[i3],
          y3 = verticesY[i3],
          z3 = verticesZ[i3];

        const ex = x2 - x1,
          ey = y2 - y1,
          ez = z2 - z1;
        const fx = x3 - x1,
          fy = y3 - y1,
          fz = z3 - z1;
        let nx = ey * fz - ez * fy;
        let ny = ez * fx - ex * fz;
        let nz = ex * fy - ey * fx;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 0) {
          nx /= len;
          ny /= len;
          nz /= len;
        }

        positions.push(x1, y1, z1, x2, y2, z2, x3, y3, z3);
        normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
        hslColors.push(redHsl, redHsl, redHsl);
        alphas.push(alpha, alpha, alpha);
      }

      if (positions.length === 0) continue;

      const clickboxCmd: NpcMesh3DCommand = {
        kind: 'mesh3d',
        meshId: `npc-clickbox-overlay-${actorId}`,
        materialId: 'tile-outline',
        modelMatrix,
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        perVertexHslColors: new Float32Array(hslColors),
        perVertexAlphas: new Float32Array(alphas),
        blend: 'normal',
        // 'readwrite': nearest front face only per pixel — a single uniform layer, not
        // cumulative on overlap. depthBias wins vs the coincident model; build-order sync
        // (after updateAnimations) keeps it aligned with the animated model.
        depth: 'readwrite',
        cullFace: 'back',
        zIndex: Z_LAYERS.HOVER - 1,
        animated: true,
        depthBias: (hitTestData.depthBias ?? 0) + NPC_CLICKBOX_OVERLAY_DEPTH_BIAS,
      };
      queue.commands.push(clickboxCmd);
    }
  }

  protected pushTileMesh3D(
    queue: RenderQueue,
    x: number,
    y: number,
    hslColor: number,
    alpha: number,
    meshIdPrefix: string,
    heightOffset: number,
    zIndex: number,
  ): void {
    if (!this.terrainHeights) return;

    const h00 = -getTerrainHeight(this.terrainHeights, x, y) / 128 + heightOffset;
    const h10 = -getTerrainHeight(this.terrainHeights, x + 1, y) / 128 + heightOffset;
    const h01 = -getTerrainHeight(this.terrainHeights, x, y + 1) / 128 + heightOffset;
    const h11 = -getTerrainHeight(this.terrainHeights, x + 1, y + 1) / 128 + heightOffset;

    const positions = new Float32Array([
      x,
      y,
      h00,
      x + 1,
      y,
      h10,
      x + 1,
      y + 1,
      h11,
      x,
      y,
      h00,
      x + 1,
      y + 1,
      h11,
      x,
      y + 1,
      h01,
    ]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const hslColors = new Float32Array([hslColor, hslColor, hslColor, hslColor, hslColor, hslColor]);
    const alphas = new Float32Array([alpha, alpha, alpha, alpha, alpha, alpha]);

    queue.commands.push({
      kind: 'mesh3d',
      meshId: `${meshIdPrefix}-${x}-${y}`,
      materialId: 'tile-outline',
      cullFace: 'none',
      modelMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      positions,
      normals,
      perVertexHslColors: hslColors,
      perVertexAlphas: alphas,
      depth: 'none',
      blend: 'normal',
      zIndex,
    } as NpcMesh3DCommand);
  }

  /**
   * The Tile Grid plugin's lines, rebuilt only when the bounds, terrain or style change.
   * See {@link buildTileGridMesh} for why markers and outlines always draw over it.
   */
  private buildTileGrid3D(queue: RenderQueue, style: TileGridStyle): void {
    const heights = this.terrainHeights;
    if (!heights || !(style.opacity > 0)) return;
    const bounds = this.getTileOverlayBounds();
    const hslColor = this.hexToPackedHsl(style.color);
    const opacity = Math.min(1, style.opacity);
    const lineWidth = markerWidthWorld(clampTileGridWidth(style.width));
    const cached = this.cachedTileGrid;
    if (cached?.heights !== heights || cached.command.meshId !== tileGridMeshId(bounds, hslColor, opacity, lineWidth)) {
      const command = buildTileGridMesh({
        bounds,
        cornerHeight: (x, y) => -getTerrainHeight(heights, x, y) / 128,
        hslColor,
        opacity,
        lineWidth,
      });
      this.cachedTileGrid = command ? { heights, command: { ...command, zIndex: Z_LAYERS.GRID } } : null;
    }
    if (this.cachedTileGrid) queue.commands.push(this.cachedTileGrid.command);
  }
}

/**
 * What one terrain mesh is built from: the square's terrain context (the scene's surface
 * resolver keeps it for picking anyway), the floor loaders, and the settings it was built under.
 */
interface TerrainMeshRecipe {
  readonly id: string;
  readonly context: TerrainContext;
  readonly level: number;
  readonly underlayLoader: UnderlayTypeLoader | undefined;
  readonly overlayLoader: OverlayTypeLoader | undefined;
  readonly smoothTerrain: boolean;
  readonly textureIndexMapper: TextureIndexMapper | null;
}

/**
 * A terrain mesh's resident source and the texture ids it samples. Its own function so the
 * rebuild closure's scope holds the recipe and nothing else, not the first build.
 */
function createTerrainMeshSource(recipe: TerrainMeshRecipe): { source: ImmutableMeshSource; textureIds: number[] } {
  const { upload, textureIds } = buildTerrainUpload(recipe);
  const source = new ImmutableMeshSource(recipe.id, [upload], () => [buildTerrainUpload(recipe).upload]);
  return { source, textureIds };
}

/** Terrain draws with scene-base, which reads no normals, so the interleaved ones are not copied out. */
function buildTerrainUpload(recipe: TerrainMeshRecipe): { upload: MeshUploadData; textureIds: number[] } {
  const { context } = recipe;
  const mesh = createTerrainBuilder().buildMesh(
    context,
    recipe.level,
    context.coreOriginX,
    context.coreOriginY,
    MAP_SQUARE_SIZE,
    MAP_SQUARE_SIZE,
    {
      overlayLoader: recipe.overlayLoader,
      underlayLoader: recipe.underlayLoader,
      smoothTerrain: recipe.smoothTerrain,
      coordinateOrigin: { x: context.coreOriginX, y: context.coreOriginY },
    },
  );
  const { vertexCount, stride, vertices } = mesh;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const tileCoords = new Float32Array(vertexCount * 2);
  const perVertexTextureIds = new Float32Array(vertexCount);
  const perVertexHslColors = new Float32Array(vertexCount);
  const indices = vertexCount > 65535 ? new Uint32Array(vertexCount) : new Uint16Array(vertexCount);
  const textureIdSet = new Set<number>();
  const mapper = recipe.textureIndexMapper;

  for (let i = 0; i < vertexCount; i++) {
    const src = i * stride;
    const pos = i * 3;
    const uv = i * 2;
    const tc = i * 2;

    positions[pos] = vertices[src];
    positions[pos + 1] = vertices[src + 1];
    positions[pos + 2] = vertices[src + 2];

    uvs[uv] = vertices[src + 6];
    uvs[uv + 1] = vertices[src + 7];

    const textureId = vertices[src + 8];
    const hslColor = vertices[src + 9];

    if (textureId >= 0) {
      textureIdSet.add(textureId);
      perVertexTextureIds[i] = mapper ? mapper(textureId) : textureId;
    } else {
      perVertexTextureIds[i] = -1;
    }
    perVertexHslColors[i] = hslColor;

    tileCoords[tc] = vertices[src + 10];
    tileCoords[tc + 1] = vertices[src + 11];

    indices[i] = i;
  }

  return {
    upload: { positions, indices, uvs, perVertexTextureIds, perVertexHslColors, tileCoords },
    textureIds: [...textureIdSet].sort((a, b) => a - b),
  };
}
