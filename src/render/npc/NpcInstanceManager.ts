import type { ActorId } from '../../core/actors/types';
import type { NpcType } from '../../rs/config/npctype/NpcType';
import {
  modelDataToMesh,
  type NpcMeshData,
  type NpcModelData,
  type NpcModelLoader,
} from '../../rs/model/NpcModelLoader';
import type { SkeletalSeq } from '../../rs/model/skeletal/SkeletalSeq';
import {
  type FaceTextureGeometry,
  faceTextureLayer,
  modelHasTextures,
  writeFaceTextureAttributes,
} from '../../rs/model/textureUv';
import { writeUnitNormal } from '../../rs/model/VertexNormal';
import { type Coordinate, type NpcSnapshot, OSRS_TICK_MS } from '../../types/simulation';
import type { AnimatedModel, AnimationSystem } from '../core/animation';
import type { NpcMesh3DCommand, RenderQueue } from '../core/commands';
import { type FaceSortInput, type SorterProjection, sortModelFaces } from '../core/FacePrioritySorter';
import { sharedModelTextureIndex } from '../core/modelTextures';
import type { ReplayActorDestination, ReplayDeferredPrimaryIndex } from '../core/replayDeferredPrimaryIndex';
import type { ReplayEffectDestination } from '../core/replayEffectIndex';
import { type PrimarySample, primaryPhase, type ReplayPrimaryIndex } from '../core/replayPrimaryIndex';
import {
  applySplitMap,
  buildFaceSplitMap,
  buildTransparentFaceMap,
  createSplitMapBuffers,
  type FaceSplitMap,
  type PermuteOutputBuffers,
  permuteTransparentTriangles,
  type SplitMapBuffers,
  type SplitTextureAttributes,
  splitTriangleSoupByAlpha,
  type TransparentFaceMap,
} from '../core/splitMeshByAlpha';
import type { NpcDeathClipRenderConfig, NpcRenderConfig } from '../scene/encounterRenderConfig';
import type { ModelBounds, NpcHitTestData } from '../scene/types';
import { getLocCenterHeight } from '../shared/renderUtils';
import {
  type AnimClipRef,
  type AnimPlayMode,
  CLIENT_TICK_MS,
  type NpcAnimationSet,
  type NpcAnimModelAdapter,
  type SkeletalClipRef,
} from './animationTypes';
import { NpcAnimationController, npcPrimarySpec } from './NpcAnimationController';
import { NpcFacingController, type NpcFacingStep } from './NpcFacingController';
import { deriveNpcRenderFacingIntent, type NpcRenderFacingIntent } from './npcFacingIntent';
import { interpolateNpcPosition, npcCrawlProgress } from './npcRenderPosition';
import { isNpcStandingAt } from './npcStanding';

/**
 * Health bar width in pixels by NPC size, capped at size 5. Every width here has a sprite set under
 * `/assets/ui/healthbar/`, which the preloader warms from this table.
 */
export const HEALTHBAR_WIDTH_BY_SIZE: Readonly<Record<number, number>> = { 1: 40, 2: 60, 3: 80, 4: 100, 5: 120 };

export const PRIMARY_NPC_ACTOR_ID = 'primary-npc';

function deathClipDurationsMs(config: NpcTypeLoadConfig | undefined): Record<string, number> | undefined {
  const entries = Object.entries(config?.deathClips ?? {}).flatMap(([cause, clip]) =>
    clip.durationMs === undefined ? [] : [[cause, clip.durationMs] as const],
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
const PLAYER_ACTOR_ID = 'player';
const DEFAULT_NPC_Z_INDEX = 45;
const TRIG_EPSILON = 1e-6;
const TILE_TO_OSRS = 128;
const MODEL_SCALE = 1 / 128;
export const CLIENT_TICKS_PER_GAME_TICK = OSRS_TICK_MS / CLIENT_TICK_MS;
const ANGLE_FULL = 2048;

export function usesBoundingBoxClickboxForNpcSize(npcSize: number): boolean {
  return npcSize === 1;
}

/** Model geometry never contributes lift; only the active sequence's cache heightOffset does. */
export function npcModelLiftFromAnimationHeightOffset(animationHeightOffset: number | undefined): number {
  return animationHeightOffset ?? 0;
}

/**
 * Exact OSRS look-at bearing (2048-unit angle) from a source visual center to a
 * target visual center. Mirrors the simulation's south=0 convention:
 * `round(atan2(-dx, -dy) * 2048/(2π))` normalized into `[0, 2048)`. Returns 0
 * when the centers coincide.
 */
function computeFacingBearing(sourceX: number, sourceY: number, targetX: number, targetY: number): number {
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  if (dx === 0 && dy === 0) return 0;
  const radians = Math.atan2(-dx, -dy);
  return ((Math.round(radians * (ANGLE_FULL / (2 * Math.PI))) % ANGLE_FULL) + ANGLE_FULL) % ANGLE_FULL;
}

interface NpcRenderPlacement {
  position: [number, number];
  size: number;
}

interface NpcFacingFrame {
  readonly playerVisualPosition: [number, number];
  readonly scaledNpcDeltaMs: number;
  readonly snap: boolean;
}

export interface NpcTypeLoadConfig {
  idleSeqId?: number;
  walkSeqId?: number;
  idlePlayMode?: AnimPlayMode;
  attackClips?: Record<string, number>;
  deathSeqId?: number;
  /** See {@link import('../scene/encounterRenderConfig').EncounterNpcTypeRenderConfig.spawnSeqId}. */
  spawnSeqId?: number;
  /** See {@link import('../scene/encounterRenderConfig').EncounterNpcTypeRenderConfig.deathClips}. */
  deathClips?: Record<string, NpcDeathClipRenderConfig>;
  bossDeathAnimationEnabled?: boolean;
  deathDurationMs?: number;
  /** See {@link import('../scene/encounterRenderConfig').EncounterNpcTypeRenderConfig.holdDeathUntilRemoved}. */
  holdDeathUntilRemoved?: boolean;
  depthBias?: number;
  /** See {@link import('../scene/encounterRenderConfig').EncounterNpcTypeRenderConfig.transparentDepthBiasOffset}. */
  transparentDepthBiasOffset?: number;
}

export interface NpcOverlayHeights {
  readonly hitsplatHeight: number;
  readonly healthBarHeight: number;
  readonly healthBarWidth: number;
  readonly baseHeight: number;
}

type TransparentStaticAttrs = {
  hslColors: Float32Array;
  alphas: Float32Array;
  faceBias: Float32Array | undefined;
  uvs?: Float32Array;
  textureIds?: Float32Array;
};

type AnimatedNpcMeshData = {
  positions: Float32Array;
  normals: Float32Array;
  hslColors: Float32Array;
  alphas: Float32Array;
  faceBias: Float32Array;
  modelFaceIndices: Uint32Array;
  faceColors3: Int32Array;
  uvs?: Float32Array;
  textureIds?: Float32Array;
};

type AnimMeshScratch = {
  positions: Float32Array;
  normals: Float32Array;
  hslColors: Float32Array;
  alphas: Float32Array;
  faceBias: Float32Array;
  modelFaceIndices: Uint32Array;
  /** Allocated by the first textured build and kept across untextured ones until the scratch grows. */
  uvs: Float32Array | null;
  textureIds: Float32Array | null;
};

/** Reallocates only when `faceCount` exceeds the scratch capacity (contents are not preserved). */
function ensureAnimMeshScratch(
  scratch: AnimMeshScratch | null,
  faceCount: number,
  hasTextures: boolean,
): AnimMeshScratch {
  let next = scratch;
  if (!next || next.modelFaceIndices.length < faceCount) {
    next = {
      positions: new Float32Array(faceCount * 9),
      normals: new Float32Array(faceCount * 9),
      hslColors: new Float32Array(faceCount * 3),
      alphas: new Float32Array(faceCount * 3),
      faceBias: new Float32Array(faceCount * 3),
      modelFaceIndices: new Uint32Array(faceCount),
      uvs: null,
      textureIds: null,
    };
  }
  if (hasTextures && (!next.uvs || !next.textureIds)) {
    const capacity = next.modelFaceIndices.length;
    next.uvs = new Float32Array(capacity * 6);
    next.textureIds = new Float32Array(capacity * 3);
  }
  return next;
}

class NpcModelAdapter implements NpcAnimModelAdapter {
  constructor(
    private model: NpcModelData['mergedModel'],
    private originalX: Int32Array,
    private originalY: Int32Array,
    private originalZ: Int32Array,
    private originalFaceAlphas: Int8Array | null,
    private widthScale: number,
    private heightScale: number,
    private animationSystem: AnimationSystem,
    private buildMeshFn: () => AnimatedNpcMeshData | null,
    private applyMeshFn: (mesh: AnimatedNpcMeshData) => void,
    private snapshotPosedVerticesFn?: (vx: Int32Array, vy: Int32Array, vz: Int32Array) => void,
  ) {
    const restFaceAlphas = originalFaceAlphas ?? model?.faceAlphas ?? null;
    this.originalFaceAlphas = restFaceAlphas ? new Int8Array(restFaceAlphas) : null;
  }

  resetPose(): void {
    if (!this.model) return;
    this.model.verticesX.set(this.originalX);
    this.model.verticesY.set(this.originalY);
    this.model.verticesZ.set(this.originalZ);
    if (this.originalFaceAlphas && this.model.faceAlphas) {
      this.model.faceAlphas.set(this.originalFaceAlphas);
    }
  }

  applySkeletal(seq: SkeletalSeq, frame: number): void {
    this.model?.animateSkeletal(seq, frame);
  }

  applyFrame(frameId: number): void {
    if (!this.model) return;
    const frame = this.animationSystem.loadFrame(frameId);
    if (frame) {
      this.model.animate(frame);
    }
  }

  applyFrameInterleaved(primaryFrameId: number, secondaryFrameId: number, masks: number[]): void {
    if (!this.model) return;
    const primaryFrame = this.animationSystem.loadFrame(primaryFrameId);
    const secondaryFrame = this.animationSystem.loadFrame(secondaryFrameId);
    if (primaryFrame && secondaryFrame) {
      this.model.animateInterleaved(primaryFrame, secondaryFrame, masks);
    } else if (primaryFrame) {
      this.model.animate(primaryFrame);
    } else if (secondaryFrame) {
      this.model.animate(secondaryFrame);
    }
  }

  resize(): void {
    if (!this.model) return;
    if (this.widthScale !== 128 || this.heightScale !== 128) {
      this.model.resize(this.widthScale, this.heightScale, this.widthScale);
    }
  }

  commitPose(): void {
    this.resize();
    if (this.snapshotPosedVerticesFn && this.model) {
      this.snapshotPosedVerticesFn(this.model.verticesX, this.model.verticesY, this.model.verticesZ);
    }
    const mesh = this.buildMeshFn();
    if (mesh) {
      this.applyMeshFn(mesh);
    }
  }
}

interface NpcTypeRenderData {
  npcTypeId: number;
  modelData: NpcModelData | null;
  litColors: NpcModelData['litColors'];
  baseMeshCommands: NpcMesh3DCommand[];
  faceSplitMap: FaceSplitMap | null;
  splitBuffers: SplitMapBuffers | null;
  modelBounds: ModelBounds | null;
  animationSet: NpcAnimationSet | null;
  restVerticesX: Int32Array | null;
  restVerticesY: Int32Array | null;
  restVerticesZ: Int32Array | null;
  restFaceAlphas: Int8Array | null;
  size: number;
  widthScale: number;
  heightScale: number;
  transparentFaceMap: TransparentFaceMap | null;
  alphaAnimated: boolean;
  unsortedTransparentStatic: TransparentStaticAttrs | null;
  bossDeathAnimationEnabled: boolean;
  deathDurationMs: number | null;
  /** Corpse retention per `deathCause`, for the causes whose death clip overrides it. */
  deathClipDurationsMs?: Readonly<Record<string, number>>;
  /** The corpse lasts while its NPC is in the snapshot, rather than for its death clip's length. */
  holdDeathUntilRemoved?: boolean;
  depthBias?: number;
}

interface NpcRenderInstance {
  actorId: string;
  npcTypeId: number;
  animController: NpcAnimationController | null;
  modelAdapter: NpcAnimModelAdapter | null;
  animatedModel: AnimatedModel | null;
  instanceMeshCommands: NpcMesh3DCommand[];
  currentModelMatrix: Float32Array;
  originalVerticesX: Int32Array | null;
  originalVerticesY: Int32Array | null;
  originalVerticesZ: Int32Array | null;
  originalFaceAlphas: Int8Array | null;
  // Null until a resized pose is committed; raw rest vertices have not had NPC scaling applied.
  posedVerticesX: Int32Array | null;
  posedVerticesY: Int32Array | null;
  posedVerticesZ: Int32Array | null;
  instanceFaceSplitMap: FaceSplitMap | null;
  instanceSplitBuffers: SplitMapBuffers | null;
  alphaAnimated: boolean;
  dynamicTransparentFaceMap: TransparentFaceMap | null;
  dynamicTransparentStatic: TransparentStaticAttrs | null;
  dynamicFaceAlphas: Int8Array | null;
  dynamicFaceColors3: Int32Array | null;
  lastAttackTriggerTick: number;
  transparentSortDirty: boolean;
  permuteSortOutputBuffers: PermuteOutputBuffers | null;
  /**
   * Last render position + size written into `currentModelMatrix` by
   * {@link NpcInstanceManager.syncInstances} (interpolated when
   * an interpolation fraction is supplied). Consumed by encounter-agnostic seams such as
   * {@link NpcInstanceManager.updatePrimaryNpcVisualFacing} so they can
   * compute look-at math against the exact position the model is
   * rendered at, not the raw simulation snapshot. Optional so synthetic
   * instances (tests, bootstrap) fall back to encounter config.
   */
  lastRenderPosition?: [number, number];
  lastRenderSize?: number;
  lastRenderFacingAngle?: number;
  /**
   * Encounter-agnostic render-facing intent cached from the latest snapshot
   * (see {@link NpcRenderFacingIntent}). Drives per-frame smooth turning in
   * {@link NpcInstanceManager.updateNpcVisualFacing}. Undefined for synthetic
   * instances / older snapshots (primary falls back to player-facing).
   */
  currentFacingIntent?: NpcRenderFacingIntent;
  /** Snapshot spawn tick, the origin of the type's spawn clip (see {@link NpcAnimationSet.spawn}). */
  spawnTick?: number;
}

export type NpcAnimationTrigger = {
  readonly actorId: string;
  readonly trigger: string;
  readonly tick?: number;
  readonly clipId?: string;
  readonly durationGameTicks?: number;
  readonly delayClientTicks?: number;
};

function sameAnimationTrigger(first: NpcAnimationTrigger, second: NpcAnimationTrigger): boolean {
  return (
    first.tick === second.tick &&
    first.trigger === second.trigger &&
    first.clipId === second.clipId &&
    first.durationGameTicks === second.durationGameTicks &&
    first.delayClientTicks === second.delayClientTicks
  );
}

interface DyingInstance {
  instance: NpcRenderInstance;
  deathTimerMs: number;
  deathDurationMs: number;
  /** The clip its death cause selected; undefined plays the controller's default death clip. */
  deathClip?: AnimClipRef;
}

export class NpcInstanceManager {
  private typeRegistry = new Map<number, NpcTypeRenderData>();
  private instanceRegistry = new Map<string, NpcRenderInstance>();
  private dyingInstances = new Map<string, DyingInstance>();
  /** Actor ids of the last `syncInstances` snapshot: the removal signal for held corpses. */
  private snapshotActorIds: ReadonlySet<string> = new Set();
  private pendingAttackTriggersByActor = new Map<string, NpcAnimationTrigger[]>();
  private readonly appliedAttackTriggers = new WeakMap<NpcRenderInstance, NpcAnimationTrigger[]>();
  private readonly replayPrimaryControllers = new WeakSet<NpcAnimationController>();
  /**
   * Instances whose spawn clip has been sampled onto their controller, or ruled out. Replaced on
   * a timeline discontinuity, whose controller reset drops the clip, so every live instance
   * re-derives it from its spawn tick at the new destination.
   */
  private spawnClipSettled = new WeakSet<NpcRenderInstance>();
  private dyingActorIdsCache: ReadonlySet<string> | null = null;
  private dyingActorIdsCacheDirty = true;
  private primaryNpcRenderConfig: NpcRenderConfig | null = null;
  private animSystem: AnimationSystem | null = null;
  private terrainHeights: Int32Array[] | null = null;
  private movementByActorId = new Map<string, boolean>();
  private sorterCameraX = 0;
  private sorterCameraY = 0;
  private sorterCameraZ = 0;
  private sorterYawSin = 0;
  private sorterYawCos = 1;
  private sorterPitchSin = 0;
  private sorterPitchCos = 1;
  private hasSorterProjection = false;
  /**
   * Grow-only scratch shared by every type's {@link buildAnimatedMesh}, sized for the largest model
   * seen so far. Each call returns exact-length views of the used range in {@link animMeshDataCache};
   * consumers copy out of them before the next build (see {@link applyUpdatedMeshToInstance}).
   */
  private animMeshScratch: AnimMeshScratch | null = null;
  private animMeshDataCache: AnimatedNpcMeshData | null = null;
  // Per-actor smooth-turning state. The controller owns one NpcVisualTracker
  // per live NPC (seeded from its current facing, fractional-cycle state
  // retained across frames); this manager resolves each frame's target angle
  // from the cached render-facing intent. Reset in dispose()/resetTransientState.
  private readonly facingController = new NpcFacingController();
  // Set on a replay timeline discontinuity so the next facing pass snaps every
  // NPC to its resolved target instead of rotating from a stale future angle.
  private facingSnapPending = false;
  /** Scratch for deriving transparent model-face indices without a per-frame allocation. */
  private transparentFaceIndexScratch: Uint32Array | null = null;
  private primaryNpcSmoothedFacingAngle: number | undefined = undefined;

  setPrimaryNpcRenderConfig(config: NpcRenderConfig | null): void {
    this.primaryNpcRenderConfig = config;
  }

  async loadNpcType(
    npcTypeId: number,
    npcModelLoader: NpcModelLoader,
    animSystem?: AnimationSystem,
    config?: NpcTypeLoadConfig,
  ): Promise<void> {
    if (this.typeRegistry.has(npcTypeId)) return;
    if (animSystem) this.animSystem = animSystem;
    const effectiveAnimSystem = animSystem ?? this.animSystem;

    const modelData = npcModelLoader.loadNpcModelData(npcTypeId);
    if (!modelData || !modelData.mergedModel) {
      throw new Error(`Failed to load NPC model (ID: ${npcTypeId})`);
    }

    const model = modelData.mergedModel;
    const modelBounds = this.computeModelBounds(modelData);
    const mesh = modelDataToMesh(modelData.mergedModel, modelData.litColors ?? undefined, {
      resolveTextureLayer: sharedModelTextureIndex.resolve,
    });

    const restVerticesX = new Int32Array(model.verticesX);
    const restVerticesY = new Int32Array(model.verticesY);
    const restVerticesZ = new Int32Array(model.verticesZ);
    const restFaceAlphas = model.faceAlphas ? new Int8Array(model.faceAlphas) : null;

    let instanceRef: NpcRenderInstance | null = null;
    let animController: NpcAnimationController | null = null;
    let modelAdapter: NpcAnimModelAdapter | null = null;
    let animatedModel: AnimatedModel | null = null;
    let originalVerticesX: Int32Array | null = null;
    let originalVerticesY: Int32Array | null = null;
    let originalVerticesZ: Int32Array | null = null;
    let originalFaceAlphas: Int8Array | null = null;
    let animationSet: NpcAnimationSet | null = null;
    let alphaAnimated = false;

    if (effectiveAnimSystem?.isInitialized()) {
      model.computeAnimationTables();
      animatedModel = effectiveAnimSystem.createAnimatedModel(model);

      const npcType = npcModelLoader.loadNpcType(npcTypeId);
      animationSet = npcType ? this.loadAnimationSet(effectiveAnimSystem, npcType, config) : null;
      if (animationSet) {
        originalVerticesX = new Int32Array(model.verticesX);
        originalVerticesY = new Int32Array(model.verticesY);
        originalVerticesZ = new Int32Array(model.verticesZ);
        originalFaceAlphas = model.faceAlphas ? new Int8Array(model.faceAlphas) : null;

        modelAdapter = new NpcModelAdapter(
          model,
          originalVerticesX,
          originalVerticesY,
          originalVerticesZ,
          originalFaceAlphas,
          modelData.widthScale,
          modelData.heightScale,
          effectiveAnimSystem,
          () => this.buildAnimatedMesh(modelData, animController !== null, animatedModel),
          (updatedMesh) => {
            if (!instanceRef) return;
            this.applyUpdatedMeshToInstance(instanceRef, typeData, updatedMesh);
          },
          (vx, vy, vz) => {
            if (!instanceRef) return;
            if (!instanceRef.posedVerticesX) instanceRef.posedVerticesX = new Int32Array(vx.length);
            if (!instanceRef.posedVerticesY) instanceRef.posedVerticesY = new Int32Array(vy.length);
            if (!instanceRef.posedVerticesZ) instanceRef.posedVerticesZ = new Int32Array(vz.length);
            instanceRef.posedVerticesX.set(vx);
            instanceRef.posedVerticesY.set(vy);
            instanceRef.posedVerticesZ.set(vz);
          },
        );

        animController = new NpcAnimationController({
          animationSet,
          modelAdapter,
        });
      }
    }

    const { position: initialPosition, size: initialSize } = this.getInitialModelPlacement(npcTypeId, modelData.size);
    const initialModelMatrix = new Float32Array(16);
    this.computeModelMatrixInto(initialModelMatrix, initialPosition, initialSize, 0);
    const { commands, faceSplitMap, splitBuffers, transparentFaceMap, unsortedTransparentStatic } = this.buildNpcMesh3D(
      mesh,
      npcTypeId,
      initialModelMatrix,
      animController !== null,
    );
    const transparentDepthBias =
      config?.transparentDepthBiasOffset === undefined
        ? config?.depthBias
        : (config?.depthBias ?? 0) + config.transparentDepthBiasOffset;
    for (const command of commands) {
      command.depthBias = command.depth === 'read' ? transparentDepthBias : config?.depthBias;
    }
    alphaAnimated = this.isAnimationSetAlphaAnimated(animationSet, effectiveAnimSystem);
    applySplitMap(faceSplitMap, mesh.positions, mesh.normals, mesh.hslColors, mesh.alphas, mesh.faceBias, splitBuffers);

    const typeData: NpcTypeRenderData = {
      npcTypeId,
      modelData,
      litColors: modelData.litColors,
      baseMeshCommands: commands,
      faceSplitMap,
      splitBuffers,
      modelBounds,
      animationSet,
      restVerticesX,
      restVerticesY,
      restVerticesZ,
      restFaceAlphas,
      size: modelData.size,
      widthScale: modelData.widthScale,
      heightScale: modelData.heightScale,
      transparentFaceMap,
      alphaAnimated,
      unsortedTransparentStatic,
      bossDeathAnimationEnabled: config?.bossDeathAnimationEnabled ?? false,
      deathDurationMs: config?.deathDurationMs ?? null,
      deathClipDurationsMs: deathClipDurationsMs(config),
      holdDeathUntilRemoved: config?.holdDeathUntilRemoved ?? false,
      depthBias: config?.depthBias,
    };

    this.typeRegistry.set(npcTypeId, typeData);

    if (this.isPrimaryNpcType(npcTypeId)) {
      const instance: NpcRenderInstance = {
        actorId: PRIMARY_NPC_ACTOR_ID,
        npcTypeId,
        animController,
        modelAdapter,
        animatedModel,
        instanceMeshCommands: commands.map((cmd) => ({ ...cmd })),
        currentModelMatrix: initialModelMatrix,
        originalVerticesX,
        originalVerticesY,
        originalVerticesZ,
        originalFaceAlphas,
        posedVerticesX: null,
        posedVerticesY: null,
        posedVerticesZ: null,
        instanceFaceSplitMap: faceSplitMap,
        instanceSplitBuffers: this.seedSplitBuffers(typeData),
        alphaAnimated,
        dynamicTransparentFaceMap: transparentFaceMap,
        dynamicTransparentStatic: unsortedTransparentStatic,
        dynamicFaceAlphas: model.faceAlphas ? new Int8Array(model.faceAlphas) : null,
        dynamicFaceColors3: typeData.litColors ? new Int32Array(typeData.litColors.faceColors3) : null,
        lastAttackTriggerTick: -1,
        transparentSortDirty: true,
        permuteSortOutputBuffers: null,
        lastRenderPosition: [initialPosition[0], initialPosition[1]],
        lastRenderSize: initialSize,
        lastRenderFacingAngle: 0,
      };
      instanceRef = instance;
      this.instanceRegistry.set(PRIMARY_NPC_ACTOR_ID, instance);
    }
  }

  /**
   * @param cycle Presentation clock in client cycles (`tick * 30`). Spawn clips are only
   *   started when it is supplied, since their phase is derived from it.
   */
  syncInstances(npcs: NpcSnapshot[], interpFraction = 1, cycle?: number, currentTick?: number): void {
    const seenIds = new Set<string>();

    for (const npc of npcs) {
      // A hidden NPC has no model: dropping it here removes its instance, and it is rebuilt (with its
      // spawn clip) when it shows again.
      if (npc.hidden) continue;
      seenIds.add(npc.id);
      const typeData = this.typeRegistry.get(npc.npcTypeId);
      // A death animation that starts after the killing tick (a queued death) keeps the NPC standing as
      // a live instance until then, moving and attacking. Without a clock it starts at once.
      const deathPending = !npc.alive && cycle !== undefined && isNpcStandingAt(npc, cycle);

      if (!npc.alive && !deathPending && (npc.role !== 'boss' || typeData?.bossDeathAnimationEnabled === true)) {
        const existing = this.instanceRegistry.get(npc.id);
        if (existing && !this.dyingInstances.has(npc.id)) {
          this.enterDyingState(npc.id, existing, typeData, npc.deathCause);
        }
        continue;
      }
      // A seek back into the delay takes the corpse back to the standing NPC.
      if (deathPending && this.dyingInstances.delete(npc.id)) this.markDyingActorIdsCacheDirty();

      if (!typeData) continue;

      const crawlProgress = npcCrawlProgress(npc, interpFraction, currentTick);
      this.movementByActorId.set(
        npc.id,
        crawlProgress !== null
          ? crawlProgress < 1
          : npc.previousPosition[0] !== npc.position[0] || npc.previousPosition[1] !== npc.position[1],
      );

      // An NPC that changed type (a transformation) gets a fresh instance of its new model.
      const current = this.instanceRegistry.get(npc.id);
      if (current && current.npcTypeId !== npc.npcTypeId) this.removePresentation(npc.id);
      const existing = this.instanceRegistry.get(npc.id);
      const instance = existing ?? this.createInstance(npc, typeData);
      if (!existing) {
        this.instanceRegistry.set(npc.id, instance);
      }
      instance.spawnTick = npc.spawnTick;
      if (cycle !== undefined) this.settleSpawnClip(instance, cycle);

      const modelMatrix = instance.currentModelMatrix;
      const prevM0 = modelMatrix[0];
      const prevM1 = modelMatrix[1];
      const prevM8 = modelMatrix[8];
      const prevM9 = modelMatrix[9];
      const prevM12 = modelMatrix[12];
      const prevM13 = modelMatrix[13];
      const prevM14 = modelMatrix[14];
      const interpPos = interpolateNpcPosition(npc, interpFraction, currentTick);
      this.computeModelMatrixInto(
        modelMatrix,
        interpPos,
        typeData.size,
        npc.facingAngle,
        npcModelLiftFromAnimationHeightOffset(instance.animController?.getAnimationHeightOffset()),
      );
      instance.lastRenderPosition = [interpPos[0], interpPos[1]];
      instance.lastRenderSize = typeData.size;
      instance.lastRenderFacingAngle = npc.facingAngle;
      instance.currentFacingIntent = deriveNpcRenderFacingIntent(npc);
      if (
        prevM0 !== modelMatrix[0] ||
        prevM1 !== modelMatrix[1] ||
        prevM8 !== modelMatrix[8] ||
        prevM9 !== modelMatrix[9] ||
        prevM12 !== modelMatrix[12] ||
        prevM13 !== modelMatrix[13] ||
        prevM14 !== modelMatrix[14]
      ) {
        instance.transparentSortDirty = true;
      }

      for (const cmd of instance.instanceMeshCommands) {
        cmd.modelMatrix = modelMatrix;
      }
    }

    for (const [id] of this.instanceRegistry) {
      if (id === PRIMARY_NPC_ACTOR_ID) continue;
      if (!seenIds.has(id)) {
        this.instanceRegistry.delete(id);
        this.pendingAttackTriggersByActor.delete(id);
        this.movementByActorId.delete(id);
        this.facingController.drop(id);
      }
    }
    this.snapshotActorIds = seenIds;
    for (const [id, dying] of this.dyingInstances) {
      if (this.holdsDeathUntilRemoved(dying.instance.npcTypeId) && !seenIds.has(id)) {
        this.dyingInstances.delete(id);
        this.markDyingActorIdsCacheDirty();
      }
    }
  }

  removePresentation(actorId: string): void {
    this.instanceRegistry.delete(actorId);
    if (this.dyingInstances.delete(actorId)) {
      this.markDyingActorIdsCacheDirty();
    }
    this.pendingAttackTriggersByActor.delete(actorId);
    this.movementByActorId.delete(actorId);
    this.facingController.drop(actorId);
    this.clearPrimarySmoothedFacingIfPrimary(actorId);
  }

  removePresentationsByNpcType(npcTypeIds: readonly number[]): void {
    for (const [actorId, instance] of this.instanceRegistry) {
      if (npcTypeIds.includes(instance.npcTypeId)) this.removePresentation(actorId);
    }
    for (const [actorId, dying] of this.dyingInstances) {
      if (npcTypeIds.includes(dying.instance.npcTypeId)) this.removePresentation(actorId);
    }
  }

  /**
   * @param elapsedMs Time since the NPC's defeat (`despawnTick`); a delayed death animation
   *   (`deathAnimationTick`) is measured from its own start, and before it the NPC is left to
   *   `syncInstances`, which keeps it standing.
   */
  reconstructDyingInstance(npc: NpcSnapshot, elapsedMs: number): void {
    const typeData = this.typeRegistry.get(npc.npcTypeId);
    if (npc.alive || !typeData || (npc.role === 'boss' && !typeData.bossDeathAnimationEnabled)) {
      return;
    }

    const delayMs =
      npc.deathAnimationTick !== undefined && npc.despawnTick !== undefined
        ? Math.max(0, npc.deathAnimationTick - npc.despawnTick) * OSRS_TICK_MS
        : 0;
    if (elapsedMs < delayMs) return;
    const targetMs = Math.max(0, elapsedMs - delayMs);
    // A held corpse lasts exactly while its NPC is in the snapshot (see `syncInstances`), so a seek
    // past the clip's end lands on its last frame; anything else lasts for the clip.
    const expired = typeData.holdDeathUntilRemoved
      ? !this.snapshotActorIds.has(npc.id)
      : targetMs >= this.getDeathDurationMs(typeData, npc.deathCause);
    if (expired) {
      this.instanceRegistry.delete(npc.id);
      if (this.dyingInstances.delete(npc.id)) {
        this.markDyingActorIdsCacheDirty();
      }
      this.pendingAttackTriggersByActor.delete(npc.id);
      this.movementByActorId.delete(npc.id);
      this.facingController.drop(npc.id);
      this.clearPrimarySmoothedFacingIfPrimary(npc.id);
      return;
    }

    if (this.instanceRegistry.has(npc.id)) {
      return;
    }

    let dying = this.dyingInstances.get(npc.id);
    if (dying?.deathTimerMs === targetMs) {
      return;
    }

    if (!dying || targetMs < dying.deathTimerMs) {
      if (dying) {
        this.dyingInstances.delete(npc.id);
      }
      const instance = this.createInstance(npc, typeData);
      this.instanceRegistry.set(npc.id, instance);
      dying = this.enterDyingState(npc.id, instance, typeData, npc.deathCause);
    }

    const controller = dying.instance.animController;
    if (controller) {
      controller.restoreDeathAt(targetMs / CLIENT_TICK_MS, dying.deathClip);
      controller.update({
        deltaMs: 0,
        speedMultiplier: 1,
        turn: { isTurning: false, turnDeltaSigned: 0 },
        movement: { isMoving: false },
      });
    }
    this.refreshAnimationHeightOffset(dying.instance);
    dying.deathTimerMs = targetMs;
  }

  setInstanceFacingAngle(actorId: string, position: [number, number], size: number, facingAngle: number): void {
    const instance = this.instanceRegistry.get(actorId);
    if (!instance) return;
    const modelMatrix = instance.currentModelMatrix;
    const prevM0 = modelMatrix[0];
    const prevM1 = modelMatrix[1];
    const prevM8 = modelMatrix[8];
    const prevM9 = modelMatrix[9];
    const prevM12 = modelMatrix[12];
    const prevM13 = modelMatrix[13];
    const prevM14 = modelMatrix[14];
    this.computeModelMatrixInto(
      modelMatrix,
      position,
      size,
      facingAngle,
      npcModelLiftFromAnimationHeightOffset(instance.animController?.getAnimationHeightOffset()),
    );
    if (
      prevM0 !== modelMatrix[0] ||
      prevM1 !== modelMatrix[1] ||
      prevM8 !== modelMatrix[8] ||
      prevM9 !== modelMatrix[9] ||
      prevM12 !== modelMatrix[12] ||
      prevM13 !== modelMatrix[13] ||
      prevM14 !== modelMatrix[14]
    ) {
      instance.transparentSortDirty = true;
    }
    for (const cmd of instance.instanceMeshCommands) {
      cmd.modelMatrix = modelMatrix;
    }
    instance.lastRenderFacingAngle = facingAngle;
  }

  /**
   * Direct seam: advance ONLY the primary NPC toward the player
   * and cache the result. Production drives the primary through
   * {@link updateNpcVisualFacing} (intent-aware); this keeps the exact
   * player-facing used by unit tests and a primary with no cached intent.
   */
  updatePrimaryNpcVisualFacing(playerVisualPosition: [number, number], scaledNpcDeltaMs: number): number | undefined {
    if (!this.primaryNpcRenderConfig) return undefined;
    const instance = this.instanceRegistry.get(PRIMARY_NPC_ACTOR_ID);
    if (!instance) return undefined;
    if (!this.typeRegistry.has(instance.npcTypeId)) return undefined;
    const smoothed = this.advanceInstanceFacing(instance, { playerVisualPosition, scaledNpcDeltaMs, snap: false });
    this.primaryNpcSmoothedFacingAngle = smoothed;
    return smoothed;
  }

  /**
   * Smooth-turn every live NPC once per frame toward the bearing its cached
   * render-facing intent implies, writing the result through
   * {@link setInstanceFacingAngle}. Caches the primary's angle for
   * {@link getPrimaryNpcSmoothedFacingAngle}, clearing it when no primary
   * instance is live this frame.
   */
  updateNpcVisualFacing(playerVisualPosition: [number, number], scaledNpcDeltaMs: number): number | undefined {
    const frame: NpcFacingFrame = { playerVisualPosition, scaledNpcDeltaMs, snap: this.facingSnapPending };
    let primaryAngle: number | undefined;
    let sawPrimary = false;
    for (const [actorId, instance] of this.instanceRegistry) {
      const smoothed = this.advanceInstanceFacing(instance, frame);
      if (actorId === PRIMARY_NPC_ACTOR_ID) {
        primaryAngle = smoothed;
        sawPrimary = true;
      }
    }
    this.primaryNpcSmoothedFacingAngle = sawPrimary ? primaryAngle : undefined;
    this.facingSnapPending = false;
    return this.primaryNpcSmoothedFacingAngle;
  }

  private advanceInstanceFacing(instance: NpcRenderInstance, frame: NpcFacingFrame): number {
    const typeData = this.typeRegistry.get(instance.npcTypeId);
    const placement = this.resolveInstanceRenderPlacement(instance, typeData);
    const target = this.resolveFacingTarget(instance, placement, frame.playerVisualPosition);
    const step: NpcFacingStep = {
      actorId: instance.actorId,
      seedAngle: instance.lastRenderFacingAngle ?? 0,
      targetAngle: target.angle,
      turnSpeed: typeData?.modelData?.rotationSpeed,
      deltaMs: frame.scaledNpcDeltaMs,
    };
    const smoothed =
      target.mode === 'fixed' || frame.snap ? this.facingController.snapTo(step) : this.facingController.smoothTo(step);
    this.setInstanceFacingAngle(
      instance.actorId,
      [placement.position[0], placement.position[1]],
      placement.size,
      smoothed,
    );
    return smoothed;
  }

  /**
   * Resolve the target facing for one instance. Every NPC — including the
   * primary — follows its intent: `fixed` snaps, `turn-to-angle` smooths to the
   * angle, `track-actor` smooths to the live bearing (snapshot-angle fallback if
   * the target has no live instance). Only a MISSING primary intent uses the
   * exact-player fallback (the direct {@link updatePrimaryNpcVisualFacing}
   * seam / bootstrap); a missing non-primary intent smooths its snapshot angle.
   */
  private resolveFacingTarget(
    instance: NpcRenderInstance,
    placement: NpcRenderPlacement,
    playerVisualPosition: [number, number],
  ): { mode: 'fixed' | 'smooth'; angle: number } {
    const sourceX = placement.position[0] + placement.size / 2;
    const sourceY = placement.position[1] + placement.size / 2;
    const intent = instance.currentFacingIntent;
    const fallbackAngle = instance.lastRenderFacingAngle ?? 0;

    if (intent === undefined) {
      if (instance.actorId === PRIMARY_NPC_ACTOR_ID) {
        const px = playerVisualPosition[0] + 0.5;
        const py = playerVisualPosition[1] + 0.5;
        return { mode: 'smooth', angle: computeFacingBearing(sourceX, sourceY, px, py) };
      }
      return { mode: 'smooth', angle: fallbackAngle };
    }
    switch (intent.kind) {
      case 'fixed':
        return { mode: 'fixed', angle: intent.angle };
      case 'turn-to-angle':
        return { mode: 'smooth', angle: intent.angle };
      case 'track-actor': {
        const center = this.resolveActorCenter(intent.targetId, playerVisualPosition);
        if (!center) return { mode: 'smooth', angle: fallbackAngle };
        return { mode: 'smooth', angle: computeFacingBearing(sourceX, sourceY, center[0], center[1]) };
      }
      default: {
        const exhaustive: never = intent;
        return exhaustive;
      }
    }
  }

  /** Player center is `playerVisualPosition + 0.5`; any NPC is its render position + size/2. */
  private resolveActorCenter(targetId: ActorId, playerVisualPosition: [number, number]): [number, number] | null {
    if (targetId === PLAYER_ACTOR_ID) {
      return [playerVisualPosition[0] + 0.5, playerVisualPosition[1] + 0.5];
    }
    const target = this.instanceRegistry.get(targetId);
    return target ? this.resolveInstanceCenter(target) : null;
  }

  private resolveInstanceCenter(instance: NpcRenderInstance): [number, number] | null {
    if (!instance.lastRenderPosition) return null;
    const size = instance.lastRenderSize ?? this.typeRegistry.get(instance.npcTypeId)?.size ?? 1;
    return [instance.lastRenderPosition[0] + size / 2, instance.lastRenderPosition[1] + size / 2];
  }

  /** Render position + size to face from; the primary falls back to its base position. */
  private resolveInstanceRenderPlacement(
    instance: NpcRenderInstance,
    typeData: NpcTypeRenderData | undefined,
  ): NpcRenderPlacement {
    const primaryFallback =
      instance.actorId === PRIMARY_NPC_ACTOR_ID ? this.primaryNpcRenderConfig?.basePosition : undefined;
    const position: [number, number] = instance.lastRenderPosition ?? primaryFallback ?? [0, 0];
    const size = instance.lastRenderSize ?? typeData?.size ?? 1;
    return { position, size };
  }

  getPrimaryNpcSmoothedFacingAngle(): number | undefined {
    return this.primaryNpcSmoothedFacingAngle;
  }

  private clearPrimarySmoothedFacingIfPrimary(actorId: ActorId): void {
    if (actorId === PRIMARY_NPC_ACTOR_ID) {
      this.primaryNpcSmoothedFacingAngle = undefined;
    }
  }

  setInstanceModelMatrix(actorId: string, modelMatrix: Float32Array): void {
    const instance = this.instanceRegistry.get(actorId);
    if (!instance) return;
    instance.currentModelMatrix = modelMatrix;
    instance.transparentSortDirty = true;
    for (const cmd of instance.instanceMeshCommands) {
      cmd.modelMatrix = modelMatrix;
    }
  }

  setSorterProjection(
    camera: {
      cameraX: number;
      cameraY: number;
      cameraZ: number;
      yawSin: number;
      yawCos: number;
      pitchSin: number;
      pitchCos: number;
    } | null,
  ): void {
    if (!camera) {
      if (this.hasSorterProjection) {
        this.hasSorterProjection = false;
        this.markAllTransparentSortDirty();
      }
      return;
    }

    if (
      this.hasSorterProjection &&
      this.sorterCameraX === camera.cameraX &&
      this.sorterCameraY === camera.cameraY &&
      this.sorterCameraZ === camera.cameraZ &&
      Math.abs(this.sorterYawSin - camera.yawSin) <= TRIG_EPSILON &&
      Math.abs(this.sorterYawCos - camera.yawCos) <= TRIG_EPSILON &&
      Math.abs(this.sorterPitchSin - camera.pitchSin) <= TRIG_EPSILON &&
      Math.abs(this.sorterPitchCos - camera.pitchCos) <= TRIG_EPSILON
    ) {
      return;
    }

    this.sorterCameraX = camera.cameraX;
    this.sorterCameraY = camera.cameraY;
    this.sorterCameraZ = camera.cameraZ;
    this.sorterYawSin = camera.yawSin;
    this.sorterYawCos = camera.yawCos;
    this.sorterPitchSin = camera.pitchSin;
    this.sorterPitchCos = camera.pitchCos;
    this.hasSorterProjection = true;
    this.markAllTransparentSortDirty();
  }

  updateTransparentSort(): void {
    if (!this.hasSorterProjection) return;

    for (const [, instance] of this.instanceRegistry) {
      this.sortTransparentForInstance(instance);
    }
    for (const [, dying] of this.dyingInstances) {
      this.sortTransparentForInstance(dying.instance);
    }
  }

  updateAnimations(deltaMs: number, speedMultiplier: number, attackTriggers: NpcAnimationTrigger[]): void {
    const attackTriggersByActor = new Map<string, NpcAnimationTrigger[]>();
    for (const trigger of attackTriggers) {
      if (trigger.trigger !== 'attack') {
        continue;
      }

      const readyInstance = this.instanceRegistry.get(trigger.actorId);
      const pending = this.pendingAttackTriggersByActor.get(trigger.actorId);
      if (!readyInstance || !readyInstance.animController) {
        if (pending && trigger.tick !== undefined && pending[0]?.tick === trigger.tick) {
          if (!pending.some((previous) => sameAnimationTrigger(previous, trigger))) {
            pending.push(trigger);
          }
        } else {
          this.pendingAttackTriggersByActor.set(trigger.actorId, [trigger]);
        }
        continue;
      }
      this.pendingAttackTriggersByActor.delete(trigger.actorId);

      const actorTriggers = attackTriggersByActor.get(trigger.actorId);
      if (actorTriggers) {
        actorTriggers.push(trigger);
      } else {
        attackTriggersByActor.set(
          trigger.actorId,
          pending && trigger.tick !== undefined && pending[0]?.tick === trigger.tick
            ? [...pending, trigger]
            : [trigger],
        );
      }
    }

    for (const [actorId, instance] of this.instanceRegistry) {
      if (!instance.animController) {
        continue;
      }

      const typeData = this.typeRegistry.get(instance.npcTypeId);
      const attackClips = typeData?.animationSet?.attackClips;

      const triggers = attackTriggersByActor.get(actorId) ?? this.pendingAttackTriggersByActor.get(actorId);
      if (triggers) {
        this.pendingAttackTriggersByActor.delete(actorId);
        for (const trigger of triggers) {
          this.applyAttackTrigger(instance, attackClips, trigger);
        }
      }

      instance.animController.update({
        deltaMs,
        speedMultiplier,
        turn: { isTurning: false, turnDeltaSigned: 0 },
        movement: { isMoving: this.movementByActorId.get(actorId) === true },
      });
      this.refreshAnimationHeightOffset(instance);
    }

    for (const [actorId, dying] of this.dyingInstances) {
      dying.deathTimerMs += Math.max(0, deltaMs) * Math.max(0, speedMultiplier);

      if (dying.instance.animController) {
        dying.instance.animController.update({
          deltaMs,
          speedMultiplier,
          turn: { isTurning: false, turnDeltaSigned: 0 },
          movement: { isMoving: false },
        });
        this.refreshAnimationHeightOffset(dying.instance);
      }

      if (dying.deathTimerMs >= dying.deathDurationMs && !this.holdsDeathUntilRemoved(dying.instance.npcTypeId)) {
        this.dyingInstances.delete(actorId);
        this.markDyingActorIdsCacheDirty();
      }
    }
  }

  restoreReplayPrimary(
    actorId: string,
    timeline: ReplayPrimaryIndex<NpcAnimationTrigger, AnimClipRef>,
    destination: ReplayEffectDestination,
  ): boolean {
    const instance = this.instanceRegistry.get(actorId);
    const animationSet = instance && this.typeRegistry.get(instance.npcTypeId)?.animationSet;
    const controller = instance?.animController;
    if (!controller || !animationSet) return false;
    const result = timeline.sample(destination, animationSet, (trigger) => {
      const clip = (trigger.clipId ? animationSet.attackClips?.[trigger.clipId] : undefined) ?? animationSet.attack;
      return clip
        ? npcPrimarySpec(clip, {
            durationClientTicks:
              trigger.durationGameTicks === undefined
                ? undefined
                : trigger.durationGameTicks * CLIENT_TICKS_PER_GAME_TICK,
            delayClientTicks: trigger.delayClientTicks,
          })
        : undefined;
    });
    this.pendingAttackTriggersByActor.delete(actorId);
    controller.restorePrimaryAt(result.primary ?? this.sampleSpawnPrimary(instance, destination.cycle));
    const rebuilt = result.rebuilt || !this.replayPrimaryControllers.has(controller);
    this.replayPrimaryControllers.add(controller);
    return rebuilt;
  }

  restoreDeferredReplayAnimation(
    actorId: string,
    timeline: ReplayDeferredPrimaryIndex<AnimClipRef>,
    destination: ReplayActorDestination,
  ): boolean {
    const instance = this.instanceRegistry.get(actorId);
    const animationSet = instance && this.typeRegistry.get(instance.npcTypeId)?.animationSet;
    const controller = instance?.animController;
    if (!controller || !animationSet) return false;
    const result = timeline.sample(destination, animationSet, (clipId) => {
      const clip = animationSet.attackClips?.[clipId];
      return clip ? npcPrimarySpec(clip) : null;
    });
    const spawnPrimary = this.sampleSpawnPrimary(instance, destination.cycle);
    if (result.firstCycle === undefined) {
      if (this.replayPrimaryControllers.has(controller)) controller.restorePrimaryAt(spawnPrimary);
      return result.rebuilt;
    }
    this.pendingAttackTriggersByActor.delete(actorId);
    controller.restorePrimaryAt(result.primary ?? spawnPrimary);
    const spawnCycle = destination.spawnTick * CLIENT_TICKS_PER_GAME_TICK;
    controller.restoreBaseAt(
      Math.max(0, destination.cycle - spawnCycle),
      this.movementByActorId.get(actorId) === true,
      Math.min(50, Math.max(0, result.firstCycle - spawnCycle)),
    );
    const rebuilt = result.rebuilt || !this.replayPrimaryControllers.has(controller);
    this.replayPrimaryControllers.add(controller);
    return rebuilt;
  }

  /**
   * Put the type's spawn clip on an instance's primary slot once, at the phase `cycle` implies,
   * so a seek lands mid-clip on the right frame instead of restarting it. An instance present
   * before its spawn tick waits for the clock to reach it; one first seen after the clip ended
   * is settled with nothing to play, or on the clip's held last frame when its type has no idle.
   */
  private settleSpawnClip(instance: NpcRenderInstance, cycle: number): void {
    if (this.spawnClipSettled.has(instance)) return;
    const controller = instance.animController;
    const hasSpawnClip = this.typeRegistry.get(instance.npcTypeId)?.animationSet?.spawn !== undefined;
    if (!controller || !hasSpawnClip || instance.spawnTick === undefined) {
      this.spawnClipSettled.add(instance);
      return;
    }
    if (cycle < instance.spawnTick * CLIENT_TICKS_PER_GAME_TICK) return;
    this.spawnClipSettled.add(instance);
    const sample = this.sampleSpawnPrimary(instance, cycle);
    if (sample) controller.restorePrimaryAt(sample);
  }

  private sampleSpawnPrimary(instance: NpcRenderInstance, cycle: number): PrimarySample<AnimClipRef> | null {
    const animationSet = this.typeRegistry.get(instance.npcTypeId)?.animationSet;
    const clip = animationSet?.spawn;
    if (!clip || instance.spawnTick === undefined) return null;
    const elapsedCycles = cycle - instance.spawnTick * CLIENT_TICKS_PER_GAME_TICK;
    if (elapsedCycles < 0) return null;
    const phase = primaryPhase(0, elapsedCycles);
    // With no idle to settle into, the clip holds its last frame for the rest of the instance's
    // life, as a death clip does, rather than snapping back to the unanimated model (Inferno's
    // pillar collapse: its rubble pose must not stand back up before the NPC is removed).
    if (!animationSet.idle) return { clip, duration: Number.POSITIVE_INFINITY, ...phase };
    const { duration } = npcPrimarySpec(clip);
    return phase.elapsedTicks < duration ? { clip, duration, ...phase } : null;
  }

  private applyAttackTrigger(
    instance: NpcRenderInstance,
    attackClips: Record<string, AnimClipRef> | undefined,
    trigger: NpcAnimationTrigger,
  ): void {
    const triggerTick = trigger.tick;
    if (triggerTick !== undefined) {
      const previousTriggers = this.appliedAttackTriggers.get(instance);
      if (triggerTick === instance.lastAttackTriggerTick && previousTriggers) {
        if (previousTriggers.some((previous) => sameAnimationTrigger(previous, trigger))) return;
        previousTriggers.push(trigger);
      } else {
        this.appliedAttackTriggers.set(instance, [trigger]);
      }
      instance.lastAttackTriggerTick = triggerTick;
    }

    const clipId = trigger.clipId;
    const durationClientTicks =
      trigger.durationGameTicks !== undefined ? trigger.durationGameTicks * CLIENT_TICKS_PER_GAME_TICK : undefined;
    const delayClientTicks = trigger.delayClientTicks;
    if (clipId && attackClips?.[clipId]) {
      instance.animController!.triggerAttack({ clip: attackClips[clipId], durationClientTicks, delayClientTicks });
    } else {
      instance.animController!.triggerAttack({ durationClientTicks, delayClientTicks });
    }
  }

  /**
   * Reset one-shot attack-trigger state. Called on tick rewind / scene reset so a
   * stale pending trigger never fires in a new scene, and so the dedup guard
   * doesn't suppress a legitimately re-played beat tick after a rewind.
   */
  resetAttackTriggerState(): void {
    this.pendingAttackTriggersByActor.clear();
    for (const instance of this.instanceRegistry.values()) {
      instance.lastAttackTriggerTick = -1;
      this.appliedAttackTriggers.delete(instance);
    }
  }

  /**
   * Drop all transient cross-tick render state so the next syncInstances +
   * updateAnimations rebuilds purely from the snapshot. Called by the base
   * SceneCompositor on a replay timeline discontinuity (rewind / forward-jump /
   * timeline-change). Clears in-flight death fades (so a corpse can't render
   * alongside the live NPC after seeking back before its death), resets the
   * one-shot attack-trigger dedup, and resets each live instance's animation
   * controller (so a persisted attack/death clip doesn't survive the jump).
   * Loaded GPU meshes / type registry are intentionally preserved.
   */
  resetTransientState(): void {
    if (this.dyingInstances.size > 0) {
      this.dyingInstances.clear();
      this.markDyingActorIdsCacheDirty();
    }
    this.resetAttackTriggerState();
    for (const instance of this.instanceRegistry.values()) {
      instance.animController?.reset();
    }
    this.spawnClipSettled = new WeakSet();
    this.facingController.reset();
    this.facingSnapPending = true;
  }

  /**
   * Instances `isHidden` names (by render id) are left undrawn, and go on animating. A dying one is
   * asked too, since its corpse can outlast the NPC's snapshot entry.
   */
  renderAll(queue: RenderQueue, isHidden?: (actorId: string, npcTypeId: number, dying: boolean) => boolean): void {
    for (const [actorId, instance] of this.instanceRegistry) {
      if (isHidden?.(actorId, instance.npcTypeId, false)) continue;
      for (const cmd of instance.instanceMeshCommands) {
        queue.commands.push(cmd);
      }
    }
    for (const [actorId, dying] of this.dyingInstances) {
      if (isHidden?.(actorId, dying.instance.npcTypeId, true)) continue;
      for (const cmd of dying.instance.instanceMeshCommands) {
        queue.commands.push(cmd);
      }
    }
  }

  getHitTestData(actorId: string): NpcHitTestData | null {
    const instance = this.instanceRegistry.get(actorId) ?? this.dyingInstances.get(actorId)?.instance;
    if (!instance) return null;
    const typeData = this.typeRegistry.get(instance.npcTypeId);
    if (!typeData?.modelData?.mergedModel) return null;
    const model = typeData.modelData.mergedModel;
    const vx = instance.posedVerticesX ?? instance.originalVerticesX ?? model.verticesX;
    const vy = instance.posedVerticesY ?? instance.originalVerticesY ?? model.verticesY;
    const vz = instance.posedVerticesZ ?? instance.originalVerticesZ ?? model.verticesZ;
    return {
      verticesX: vx,
      verticesY: vy,
      verticesZ: vz,
      verticesCount: model.verticesCount,
      indices1: model.indices1,
      indices2: model.indices2,
      indices3: model.indices3,
      faceCount: model.faceCount,
      faceColors3: instance.dynamicFaceColors3 ?? typeData.litColors?.faceColors3 ?? null,
      modelMatrix: instance.currentModelMatrix,
      depthBias: typeData.depthBias,
      useBoundingBox: usesBoundingBoxClickboxForNpcSize(typeData.size),
    };
  }

  getAllHitTestData(): Array<{ actorId: string; hitTestData: NpcHitTestData }> {
    const result: Array<{ actorId: string; hitTestData: NpcHitTestData }> = [];
    for (const [actorId] of this.instanceRegistry) {
      const data = this.getHitTestData(actorId);
      if (data) result.push({ actorId, hitTestData: data });
    }
    return result;
  }

  getModelMatrix(actorId: string): Float32Array | null {
    return (
      this.instanceRegistry.get(actorId)?.currentModelMatrix ??
      this.dyingInstances.get(actorId)?.instance.currentModelMatrix ??
      null
    );
  }

  /**
   * Current interpolated SW-corner position of a live NPC instance — the exact
   * position its model is rendered at this frame, not the raw simulation
   * snapshot. Returns null when the actor has no live instance (type not
   * loaded, despawned, or dead), which lets projectile homing fall back to the
   * last position it saw rather than snapping to a stale tile.
   */
  getVisualPosition(actorId: string): [number, number] | null {
    const position = this.instanceRegistry.get(actorId)?.lastRenderPosition;
    return position ? [position[0], position[1]] : null;
  }

  getNpcTypeModelData(npcTypeId: number): NpcModelData | null {
    return this.typeRegistry.get(npcTypeId)?.modelData ?? null;
  }

  getNpcTypeModelBounds(npcTypeId: number): ModelBounds | null {
    return this.typeRegistry.get(npcTypeId)?.modelBounds ?? null;
  }

  getNpcTypeSize(npcTypeId: number): number {
    return this.typeRegistry.get(npcTypeId)?.size ?? 1;
  }

  getNpcTypeFaceSplitMap(npcTypeId: number): FaceSplitMap | null {
    return this.typeRegistry.get(npcTypeId)?.faceSplitMap ?? null;
  }

  getNpcTypeOverlayHeights(
    npcTypeId: number,
  ): { hitsplatHeight: number; healthBarHeight: number; healthBarWidth: number } | null {
    const typeData = this.typeRegistry.get(npcTypeId);
    if (!typeData?.modelBounds) return null;

    const bounds = typeData.modelBounds;
    const effectiveHeight = (-bounds.minY * typeData.heightScale) / 128;

    const size = typeData.size;
    const healthBarWidth = HEALTHBAR_WIDTH_BY_SIZE[Math.min(size, 5)] ?? 40;

    return {
      hitsplatHeight: effectiveHeight / 2 / 128,
      healthBarHeight: (effectiveHeight + 15) / 128,
      healthBarWidth,
    };
  }

  getNpcOverlayHeights(actorId: string): NpcOverlayHeights | null {
    const instance = this.instanceRegistry.get(actorId) ?? this.dyingInstances.get(actorId)?.instance;
    if (!instance) return null;
    const typeHeights = this.getNpcTypeOverlayHeights(instance.npcTypeId);
    const geometry = this.getHitTestData(actorId);
    if (!typeHeights || !geometry) return null;

    if (!instance.posedVerticesY) return { ...typeHeights, baseHeight: geometry.modelMatrix[14] };

    let modelHeight = 0;
    for (let vertex = 0; vertex < geometry.verticesCount; vertex++) {
      modelHeight = Math.max(modelHeight, -geometry.verticesY[vertex]);
    }
    return {
      hitsplatHeight: modelHeight / 2 / 128,
      healthBarHeight: (modelHeight + 15) / 128,
      healthBarWidth: typeHeights.healthBarWidth,
      baseHeight: geometry.modelMatrix[14],
    };
  }

  getNpcTypeSplitBuffers(npcTypeId: number): SplitMapBuffers | null {
    return this.typeRegistry.get(npcTypeId)?.splitBuffers ?? null;
  }

  setNpcTypeSplitBuffers(npcTypeId: number, splitBuffers: SplitMapBuffers | null): void {
    const typeData = this.typeRegistry.get(npcTypeId);
    if (!typeData) return;
    typeData.splitBuffers = splitBuffers;
  }

  getPrimaryNpcMeshCommands(npcTypeId: number): NpcMesh3DCommand[] {
    const instance = this.instanceRegistry.get(PRIMARY_NPC_ACTOR_ID);
    if (instance && instance.npcTypeId === npcTypeId) {
      return instance.instanceMeshCommands;
    }
    return this.typeRegistry.get(npcTypeId)?.baseMeshCommands ?? [];
  }

  getInstanceMeshCommands(actorId: string): NpcMesh3DCommand[] | null {
    return this.instanceRegistry.get(actorId)?.instanceMeshCommands ?? null;
  }

  setTerrainHeights(heights: Int32Array[] | null): void {
    this.terrainHeights = heights;
  }

  getTerrainHeights(): Int32Array[] | null {
    return this.terrainHeights;
  }

  getDyingActorIds(): ReadonlySet<string> {
    if (!this.dyingActorIdsCacheDirty && this.dyingActorIdsCache) {
      return this.dyingActorIdsCache;
    }
    this.dyingActorIdsCache = new Set(this.dyingInstances.keys());
    this.dyingActorIdsCacheDirty = false;
    return this.dyingActorIdsCache;
  }

  /**
   * Animation state for every npc the frame tracker should watch, `center` being the tile its
   * frame sounds attenuate from (null until the instance has been drawn).
   *
   * Dying instances are included because `enterDyingState` moves them OUT of `instanceRegistry`
   * before playing the death clip — iterating only the registry drops every death sound the cache
   * carries (Yama seq 12161, voidflare 12134) at exactly the moment they fire.
   */
  getInstanceFrameStates(): Array<{
    actorId: string;
    animController: NpcAnimationController | null;
    center: [number, number] | null;
  }> {
    const result: Array<{
      actorId: string;
      animController: NpcAnimationController | null;
      center: [number, number] | null;
    }> = [];
    for (const [actorId, instance] of this.instanceRegistry) {
      result.push({ actorId, animController: instance.animController, center: this.resolveInstanceCenter(instance) });
    }
    for (const [actorId, dying] of this.dyingInstances) {
      result.push({
        actorId,
        animController: dying.instance.animController,
        center: this.resolveInstanceCenter(dying.instance),
      });
    }
    return result;
  }

  isNpcTypeLoaded(npcTypeId: number): boolean {
    return this.typeRegistry.has(npcTypeId);
  }

  getMaximumLoadedDeathDurationMs(): number {
    let maximum = 0;
    for (const typeData of this.typeRegistry.values()) {
      maximum = Math.max(maximum, this.getDeathDurationMs(typeData));
      for (const deathCause of Object.keys(typeData.animationSet?.deathClips ?? {})) {
        maximum = Math.max(maximum, this.getDeathDurationMs(typeData, deathCause));
      }
    }
    return maximum;
  }

  dispose(): void {
    this.typeRegistry.clear();
    this.instanceRegistry.clear();
    this.dyingInstances.clear();
    this.snapshotActorIds = new Set();
    this.pendingAttackTriggersByActor.clear();
    this.markDyingActorIdsCacheDirty();
    this.dyingActorIdsCache = null;
    this.animSystem = null;
    this.terrainHeights = null;
    this.hasSorterProjection = false;
    this.animMeshScratch = null;
    this.animMeshDataCache = null;
    this.transparentFaceIndexScratch = null;
    this.movementByActorId.clear();
    this.facingController.reset();
    this.facingSnapPending = false;
    this.primaryNpcSmoothedFacingAngle = undefined;
  }

  private markDyingActorIdsCacheDirty(): void {
    this.dyingActorIdsCacheDirty = true;
  }

  /** The death clip a snapshot's cause selects, falling back to the type's default. */
  private resolveDeath(
    typeData: NpcTypeRenderData | undefined,
    deathCause: string | undefined,
  ): { clip: AnimClipRef | undefined; configuredDurationMs: number | null | undefined } {
    // Own properties only: the cause comes from snapshots (replays included), and a name such as
    // `__proto__` or `toString` would otherwise resolve to an inherited value instead of a clip.
    const deathClips = typeData?.animationSet?.deathClips;
    if (deathCause !== undefined && deathClips !== undefined && Object.hasOwn(deathClips, deathCause)) {
      const durations = typeData?.deathClipDurationsMs;
      const durationMs = durations !== undefined && Object.hasOwn(durations, deathCause) ? durations[deathCause] : null;
      return { clip: deathClips[deathCause], configuredDurationMs: durationMs ?? null };
    }
    return { clip: typeData?.animationSet?.death, configuredDurationMs: typeData?.deathDurationMs };
  }

  private holdsDeathUntilRemoved(npcTypeId: number): boolean {
    return this.typeRegistry.get(npcTypeId)?.holdDeathUntilRemoved === true;
  }

  private getDeathDurationMs(typeData: NpcTypeRenderData | undefined, deathCause?: string): number {
    const { clip: deathClip, configuredDurationMs: configuredDeathDurationMs } = this.resolveDeath(
      typeData,
      deathCause,
    );
    if (!deathClip || configuredDeathDurationMs !== null) {
      return configuredDeathDurationMs ?? OSRS_TICK_MS;
    }
    if (deathClip.kind === 'frame') {
      return deathClip.frameLengths.reduce((sum, length) => sum + length, 0) * CLIENT_TICK_MS;
    }
    return (deathClip.skeletalEnd - deathClip.skeletalStart) * CLIENT_TICK_MS;
  }

  private enterDyingState(
    actorId: string,
    instance: NpcRenderInstance,
    typeData: NpcTypeRenderData | undefined,
    deathCause: string | undefined,
  ): DyingInstance {
    const dying: DyingInstance = {
      instance,
      deathTimerMs: 0,
      deathDurationMs: this.getDeathDurationMs(typeData, deathCause),
      deathClip: this.resolveDeath(typeData, deathCause).clip,
    };
    this.dyingInstances.set(actorId, dying);
    this.markDyingActorIdsCacheDirty();
    this.instanceRegistry.delete(actorId);
    this.pendingAttackTriggersByActor.delete(actorId);
    // Drop the tracker so the corpse freezes at its last rendered facing and a
    // reused actor id re-seeds fresh; clear the cached primary angle on boss death.
    this.facingController.drop(actorId);
    this.clearPrimarySmoothedFacingIfPrimary(actorId);

    if (!instance.animController && typeData) {
      instance.animController = this.createDyingAnimController(instance, typeData);
    }
    instance.animController?.triggerDeath(dying.deathClip);
    return dying;
  }

  private createDyingAnimController(
    instance: NpcRenderInstance,
    typeData: NpcTypeRenderData,
  ): NpcAnimationController | null {
    if (!typeData.animationSet || !typeData.modelData?.mergedModel || !this.animSystem) return null;
    if (!instance.originalVerticesX || !instance.originalVerticesY || !instance.originalVerticesZ) return null;

    const model = typeData.modelData.mergedModel;
    const modelAdapter = new NpcModelAdapter(
      model,
      instance.originalVerticesX,
      instance.originalVerticesY,
      instance.originalVerticesZ,
      instance.originalFaceAlphas,
      typeData.widthScale,
      typeData.heightScale,
      this.animSystem,
      () => this.buildAnimatedMesh(typeData.modelData!, true, null),
      (updatedMesh) => {
        this.applyUpdatedMeshToInstance(instance, typeData, updatedMesh);
      },
      (vx, vy, vz) => {
        if (!instance.posedVerticesX) instance.posedVerticesX = new Int32Array(vx.length);
        if (!instance.posedVerticesY) instance.posedVerticesY = new Int32Array(vy.length);
        if (!instance.posedVerticesZ) instance.posedVerticesZ = new Int32Array(vz.length);
        instance.posedVerticesX.set(vx);
        instance.posedVerticesY.set(vy);
        instance.posedVerticesZ.set(vz);
      },
    );

    instance.modelAdapter = modelAdapter;
    return new NpcAnimationController({
      animationSet: typeData.animationSet,
      modelAdapter,
    });
  }

  private computeModelMatrixInto(
    out: Float32Array,
    position: [number, number],
    size: number,
    facingAngle: number,
    modelLift = 0,
  ): void {
    const SCALE = 1 / 128;
    const tx = position[0] + size / 2;
    const ty = position[1] + size / 2;
    const tz = getLocCenterHeight(this.terrainHeights, position[0], position[1], size, size) + modelLift * MODEL_SCALE;
    const theta = (facingAngle / 2048) * 2 * Math.PI;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    out[0] = SCALE * cos;
    out[1] = -SCALE * sin;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = 0;
    out[6] = -SCALE;
    out[7] = 0;
    out[8] = SCALE * sin;
    out[9] = SCALE * cos;
    out[10] = 0;
    out[11] = 0;
    out[12] = tx;
    out[13] = ty;
    out[14] = tz;
    out[15] = 1;
  }

  private refreshAnimationHeightOffset(instance: NpcRenderInstance): void {
    if (
      !instance.animController ||
      instance.lastRenderPosition === undefined ||
      instance.lastRenderSize === undefined ||
      instance.lastRenderFacingAngle === undefined
    ) {
      return;
    }
    this.computeModelMatrixInto(
      instance.currentModelMatrix,
      instance.lastRenderPosition,
      instance.lastRenderSize,
      instance.lastRenderFacingAngle,
      npcModelLiftFromAnimationHeightOffset(instance.animController.getAnimationHeightOffset()),
    );
    for (const command of instance.instanceMeshCommands) {
      command.modelMatrix = instance.currentModelMatrix;
    }
  }

  private createInstance(npc: NpcSnapshot, typeData: NpcTypeRenderData): NpcRenderInstance {
    const currentModelMatrix = new Float32Array(16);
    this.computeModelMatrixInto(currentModelMatrix, npc.position, typeData.size, npc.facingAngle);
    const instanceMeshCommands = typeData.baseMeshCommands.map((cmd) => ({
      ...cmd,
      meshId: `${cmd.meshId}-${npc.id}`,
      modelMatrix: currentModelMatrix,
    }));

    const originalVerticesX = typeData.restVerticesX ? new Int32Array(typeData.restVerticesX) : null;
    const originalVerticesY = typeData.restVerticesY ? new Int32Array(typeData.restVerticesY) : null;
    const originalVerticesZ = typeData.restVerticesZ ? new Int32Array(typeData.restVerticesZ) : null;
    const originalFaceAlphas = typeData.restFaceAlphas ? new Int8Array(typeData.restFaceAlphas) : null;

    const instance: NpcRenderInstance = {
      actorId: npc.id,
      npcTypeId: npc.npcTypeId,
      animController: null,
      modelAdapter: null,
      animatedModel: null,
      instanceMeshCommands,
      currentModelMatrix,
      originalVerticesX,
      originalVerticesY,
      originalVerticesZ,
      originalFaceAlphas,
      posedVerticesX: null,
      posedVerticesY: null,
      posedVerticesZ: null,
      instanceFaceSplitMap: typeData.faceSplitMap,
      instanceSplitBuffers: typeData.faceSplitMap ? this.seedSplitBuffers(typeData) : null,
      alphaAnimated: typeData.alphaAnimated,
      dynamicTransparentFaceMap: typeData.transparentFaceMap,
      dynamicTransparentStatic: typeData.unsortedTransparentStatic,
      dynamicFaceAlphas: typeData.modelData?.mergedModel?.faceAlphas
        ? new Int8Array(typeData.modelData.mergedModel.faceAlphas)
        : null,
      dynamicFaceColors3: typeData.litColors ? new Int32Array(typeData.litColors.faceColors3) : null,
      lastAttackTriggerTick: -1,
      transparentSortDirty: true,
      permuteSortOutputBuffers: null,
      lastRenderPosition: [npc.position[0], npc.position[1]],
      lastRenderSize: typeData.size,
      lastRenderFacingAngle: npc.facingAngle,
      currentFacingIntent: deriveNpcRenderFacingIntent(npc),
    };

    if (
      typeData.animationSet &&
      typeData.modelData?.mergedModel &&
      this.animSystem &&
      originalVerticesX &&
      originalVerticesY &&
      originalVerticesZ
    ) {
      const model = typeData.modelData.mergedModel;
      const modelAdapter = new NpcModelAdapter(
        model,
        originalVerticesX,
        originalVerticesY,
        originalVerticesZ,
        originalFaceAlphas,
        typeData.widthScale,
        typeData.heightScale,
        this.animSystem,
        () => this.buildAnimatedMesh(typeData.modelData!, true, null),
        (updatedMesh) => {
          this.applyUpdatedMeshToInstance(instance, typeData, updatedMesh);
        },
        (vx, vy, vz) => {
          if (!instance.posedVerticesX) instance.posedVerticesX = new Int32Array(vx.length);
          if (!instance.posedVerticesY) instance.posedVerticesY = new Int32Array(vy.length);
          if (!instance.posedVerticesZ) instance.posedVerticesZ = new Int32Array(vz.length);
          instance.posedVerticesX.set(vx);
          instance.posedVerticesY.set(vy);
          instance.posedVerticesZ.set(vz);
        },
      );

      instance.modelAdapter = modelAdapter;
      instance.animController = new NpcAnimationController({
        animationSet: typeData.animationSet,
        modelAdapter,
      });
    }

    return instance;
  }

  private isAnimationSetAlphaAnimated(
    animationSet: NpcAnimationSet | null,
    animSystem: AnimationSystem | null | undefined,
  ): boolean {
    if (!animationSet || !animSystem) {
      return false;
    }

    const clips: Array<AnimClipRef | undefined> = [
      animationSet.idle,
      animationSet.walk,
      animationSet.death,
      animationSet.spawn,
      animationSet.turnLeft,
      animationSet.turnRight,
    ];

    if (animationSet.attackClips) {
      for (const clip of Object.values(animationSet.attackClips)) {
        clips.push(clip);
      }
    }
    clips.push(...Object.values(animationSet.deathClips ?? {}));

    for (const clip of clips) {
      if (!clip) continue;
      if (clip.kind === 'skeletal') {
        if (clip.seq.hasAlphaTransform) {
          return true;
        }
        continue;
      }

      for (const frameId of clip.frameIds) {
        const frame = animSystem.loadFrame(frameId);
        if (frame?.hasAlphaTransform) {
          return true;
        }
      }
    }

    return false;
  }

  private applySplitBuffersToCommands(commands: NpcMesh3DCommand[], split: SplitMapBuffers): void {
    for (const cmd of commands) {
      if (cmd.meshId.includes('-opaque')) {
        cmd.positions = split.opaquePositions;
        cmd.normals = split.opaqueNormals;
        cmd.perVertexHslColors = split.opaqueHslColors;
        cmd.perVertexAlphas = split.opaqueAlphas;
        cmd.perVertexFaceBias = split.opaqueFaceBias;
        cmd.uvs = split.opaqueUvs;
        cmd.perVertexTextureIds = split.opaqueTextureIds;
        cmd.cullFace = 'back';
      } else if (cmd.meshId.includes('-transparent')) {
        cmd.positions = split.transparentPositions;
        cmd.normals = split.transparentNormals;
        cmd.perVertexHslColors = split.transparentHslColors;
        cmd.perVertexAlphas = split.transparentAlphas;
        cmd.perVertexFaceBias = split.transparentFaceBias;
        cmd.uvs = split.transparentUvs;
        cmd.perVertexTextureIds = split.transparentTextureIds;
        cmd.cullFace = 'back';
      }
    }
  }

  /**
   * Model-face indices of the transparent triangles, as a lookup map.
   *
   * The transparent face SET only changes when a face's alpha crosses the opaque
   * threshold, which is rare next to the render rate - but the `Map` inside
   * {@link buildTransparentFaceMap} was being rebuilt on every animated frame.
   * The indices are derived into a scratch buffer and the existing map is reused
   * whenever they are unchanged.
   */
  protected resolveTransparentFaceMap(
    existing: TransparentFaceMap | null,
    transparentTriIndices: Uint32Array,
    modelFaceIndices: Uint32Array,
  ): TransparentFaceMap {
    const count = transparentTriIndices.length;
    let scratch = this.transparentFaceIndexScratch;
    if (!scratch || scratch.length < count) {
      scratch = new Uint32Array(count);
      this.transparentFaceIndexScratch = scratch;
    }
    for (let i = 0; i < count; i++) {
      scratch[i] = modelFaceIndices[transparentTriIndices[i]];
    }

    if (existing && existing.triToModelFace.length === count) {
      const previous = existing.triToModelFace;
      let same = true;
      for (let i = 0; i < count; i++) {
        if (previous[i] !== scratch[i]) {
          same = false;
          break;
        }
      }
      if (same) return existing;
    }

    // slice(), not subarray(): the map retains this array, so it must not alias
    // the scratch buffer the next frame overwrites.
    return buildTransparentFaceMap(scratch.slice(0, count));
  }

  private applyUpdatedMeshToInstance(
    instance: NpcRenderInstance,
    typeData: NpcTypeRenderData,
    updatedMesh: AnimatedNpcMeshData,
  ): void {
    if (instance.alphaAnimated) {
      const meshTextures: SplitTextureAttributes | undefined =
        updatedMesh.uvs && updatedMesh.textureIds
          ? { uvs: updatedMesh.uvs, textureIds: updatedMesh.textureIds }
          : undefined;
      const splitMap = buildFaceSplitMap(updatedMesh.alphas, updatedMesh.positions.length / 3);
      const splitBuffers = this.ensureSplitBuffersCapacity(
        splitMap,
        instance.instanceSplitBuffers,
        meshTextures !== undefined,
      );
      applySplitMap(
        splitMap,
        updatedMesh.positions,
        updatedMesh.normals,
        updatedMesh.hslColors,
        updatedMesh.alphas,
        updatedMesh.faceBias,
        splitBuffers,
        meshTextures,
      );

      instance.instanceFaceSplitMap = splitMap;
      instance.instanceSplitBuffers = splitBuffers;

      // `applySplitMap()` above already produced the transparent slice and its model-face
      // indices. Recovering them with a second `splitTriangleSoupByAlpha()` call would allocate
      // ten typed arrays per animated frame of every alpha-animated NPC for nothing.
      const transparentTriIndices = splitMap.transparentTriIndices;
      const transparentTriCount = transparentTriIndices.length;
      const modelFaceIndices = updatedMesh.modelFaceIndices;

      if (transparentTriCount > 0 && modelFaceIndices) {
        instance.dynamicTransparentFaceMap = this.resolveTransparentFaceMap(
          instance.dynamicTransparentFaceMap,
          transparentTriIndices,
          modelFaceIndices,
        );
      } else {
        instance.dynamicTransparentFaceMap = null;
      }

      if (transparentTriCount > 0) {
        // Exact-length by construction: ensureSplitBuffersCapacity only reuses
        // buffers whose lengths match the split map exactly.
        const srcHslColors = splitBuffers.transparentHslColors;
        const srcAlphas = splitBuffers.transparentAlphas;
        // Mirrors splitTriangleSoupByAlpha, which left faceBias undefined when the
        // source mesh had none rather than emitting a zero-filled buffer.
        const srcFaceBias = updatedMesh.faceBias ? splitBuffers.transparentFaceBias : undefined;

        const currentStatic = instance.dynamicTransparentStatic;
        const ownsStatic = !!currentStatic && currentStatic !== typeData.unsortedTransparentStatic;
        const canReuseStatic =
          ownsStatic &&
          currentStatic.hslColors.length === srcHslColors.length &&
          currentStatic.alphas.length === srcAlphas.length &&
          (!srcFaceBias || (!!currentStatic.faceBias && currentStatic.faceBias.length === srcFaceBias.length));

        if (canReuseStatic && currentStatic) {
          currentStatic.hslColors.set(srcHslColors);
          currentStatic.alphas.set(srcAlphas);
          if (srcFaceBias) {
            currentStatic.faceBias!.set(srcFaceBias);
          } else {
            currentStatic.faceBias = undefined;
          }
          if (splitBuffers.transparentUvs && splitBuffers.transparentTextureIds) {
            if (!currentStatic.uvs || currentStatic.uvs.length !== splitBuffers.transparentUvs.length) {
              currentStatic.uvs = new Float32Array(splitBuffers.transparentUvs.length);
              currentStatic.textureIds = new Float32Array(splitBuffers.transparentTextureIds.length);
            }
            currentStatic.uvs.set(splitBuffers.transparentUvs);
            currentStatic.textureIds!.set(splitBuffers.transparentTextureIds);
          }
          instance.dynamicTransparentStatic = currentStatic;
        } else {
          const hslColors = new Float32Array(srcHslColors.length);
          hslColors.set(srcHslColors);
          const alphas = new Float32Array(srcAlphas.length);
          alphas.set(srcAlphas);
          let faceBias: Float32Array | undefined;
          if (srcFaceBias) {
            faceBias = new Float32Array(srcFaceBias.length);
            faceBias.set(srcFaceBias);
          }
          instance.dynamicTransparentStatic = {
            hslColors,
            alphas,
            faceBias,
            uvs: splitBuffers.transparentUvs ? new Float32Array(splitBuffers.transparentUvs) : undefined,
            textureIds: splitBuffers.transparentTextureIds
              ? new Float32Array(splitBuffers.transparentTextureIds)
              : undefined,
          };
        }
      } else {
        instance.dynamicTransparentStatic = null;
      }

      if (typeData.modelData?.mergedModel?.faceAlphas) {
        const sourceFaceAlphas = typeData.modelData.mergedModel.faceAlphas;
        if (!instance.dynamicFaceAlphas || instance.dynamicFaceAlphas.length !== sourceFaceAlphas.length) {
          instance.dynamicFaceAlphas = new Int8Array(sourceFaceAlphas.length);
        }
        instance.dynamicFaceAlphas.set(sourceFaceAlphas);
      } else {
        instance.dynamicFaceAlphas = null;
      }
      if (!instance.dynamicFaceColors3 || instance.dynamicFaceColors3.length !== updatedMesh.faceColors3.length) {
        instance.dynamicFaceColors3 = new Int32Array(updatedMesh.faceColors3.length);
      }
      instance.dynamicFaceColors3.set(updatedMesh.faceColors3);

      this.applySplitBuffersToCommands(instance.instanceMeshCommands, splitBuffers);
      instance.transparentSortDirty = true;
      return;
    }

    const splitMap = instance.instanceFaceSplitMap;
    if (!splitMap) {
      return;
    }
    const split = applySplitMap(
      splitMap,
      updatedMesh.positions,
      updatedMesh.normals,
      updatedMesh.hslColors,
      updatedMesh.alphas,
      updatedMesh.faceBias,
      instance.instanceSplitBuffers ?? undefined,
      updatedMesh.uvs && updatedMesh.textureIds
        ? { uvs: updatedMesh.uvs, textureIds: updatedMesh.textureIds }
        : undefined,
    );
    instance.instanceSplitBuffers = split;
    this.applySplitBuffersToCommands(instance.instanceMeshCommands, split);

    if (typeData.transparentFaceMap) {
      instance.dynamicTransparentFaceMap = typeData.transparentFaceMap;
    }
    if (typeData.unsortedTransparentStatic) {
      instance.dynamicTransparentStatic = typeData.unsortedTransparentStatic;
    }
    if (typeData.modelData?.mergedModel?.faceAlphas) {
      const sourceFaceAlphas = typeData.modelData.mergedModel.faceAlphas;
      if (!instance.dynamicFaceAlphas || instance.dynamicFaceAlphas.length !== sourceFaceAlphas.length) {
        instance.dynamicFaceAlphas = new Int8Array(sourceFaceAlphas.length);
      }
      instance.dynamicFaceAlphas.set(sourceFaceAlphas);
    } else {
      instance.dynamicFaceAlphas = null;
    }
    instance.dynamicFaceColors3 = null;
    instance.transparentSortDirty = true;
  }

  private ensureSplitBuffersCapacity(
    splitMap: FaceSplitMap,
    existing: SplitMapBuffers | null,
    hasTextures: boolean = false,
  ): SplitMapBuffers {
    const opaqueVertCount = splitMap.opaqueVertCount;
    const transparentVertCount = splitMap.transparentVertCount;

    if (!existing) {
      return createSplitMapBuffers(splitMap, hasTextures);
    }

    const exactMatch =
      existing.opaquePositions.length === opaqueVertCount * 3 &&
      existing.opaqueNormals.length === opaqueVertCount * 3 &&
      existing.opaqueHslColors.length === opaqueVertCount &&
      existing.opaqueAlphas.length === opaqueVertCount &&
      existing.transparentPositions.length === transparentVertCount * 3 &&
      existing.transparentNormals.length === transparentVertCount * 3 &&
      existing.transparentHslColors.length === transparentVertCount &&
      existing.transparentAlphas.length === transparentVertCount;

    if (!exactMatch) {
      return createSplitMapBuffers(splitMap, hasTextures);
    }

    if (opaqueVertCount > 0 && !existing.opaqueFaceBias) {
      existing.opaqueFaceBias = new Float32Array(opaqueVertCount);
    }
    if (transparentVertCount > 0 && !existing.transparentFaceBias) {
      existing.transparentFaceBias = new Float32Array(transparentVertCount);
    }
    if (hasTextures) {
      if (opaqueVertCount > 0 && !existing.opaqueUvs) {
        existing.opaqueUvs = new Float32Array(opaqueVertCount * 2);
        existing.opaqueTextureIds = new Float32Array(opaqueVertCount);
      }
      if (transparentVertCount > 0 && !existing.transparentUvs) {
        existing.transparentUvs = new Float32Array(transparentVertCount * 2);
        existing.transparentTextureIds = new Float32Array(transparentVertCount);
      }
    }

    return existing;
  }

  private buildNpcMesh3D(
    mesh: NpcMeshData,
    npcTypeId: number,
    modelMatrix: Float32Array,
    animated: boolean,
  ): {
    commands: NpcMesh3DCommand[];
    faceSplitMap: FaceSplitMap;
    splitBuffers: SplitMapBuffers;
    transparentFaceMap: TransparentFaceMap | null;
    unsortedTransparentStatic: NpcTypeRenderData['unsortedTransparentStatic'];
  } {
    const normals = mesh.normals ?? new Float32Array(mesh.positions.length);

    const split = splitTriangleSoupByAlpha({
      positions: mesh.positions,
      normals,
      hslColors: mesh.hslColors,
      alphas: mesh.alphas,
      faceBias: mesh.faceBias,
      modelFaceIndices: mesh.modelFaceIndices,
      uvs: mesh.uvs,
      textureIds: mesh.textureIds,
    });

    const hasTextures = mesh.uvs !== undefined && mesh.textureIds !== undefined;
    const faceSplitMap = buildFaceSplitMap(mesh.alphas, mesh.positions.length / 3);
    const splitBuffers = createSplitMapBuffers(faceSplitMap, hasTextures);
    const meshBaseId = `npc-${npcTypeId}`;

    const transparentFaceMap = split.transparentModelFaceIndices
      ? buildTransparentFaceMap(split.transparentModelFaceIndices)
      : null;

    const emptyVec3 = new Float32Array(0);
    const emptyScalar = new Float32Array(0);
    const commands: NpcMesh3DCommand[] = [
      {
        kind: 'mesh3d',
        meshId: `${meshBaseId}-opaque`,
        materialId: 'osrs-npc',
        modelMatrix,
        positions: split.opaque?.positions ?? emptyVec3,
        normals: split.opaque?.normals ?? emptyVec3,
        perVertexHslColors: split.opaque?.hslColors ?? emptyScalar,
        perVertexAlphas: split.opaque?.alphas ?? emptyScalar,
        perVertexFaceBias: split.opaque?.faceBias,
        uvs: split.opaque?.uvs,
        perVertexTextureIds: split.opaque?.textureIds,
        depth: 'readwrite',
        cullFace: 'back',
        zIndex: DEFAULT_NPC_Z_INDEX,
        animated,
      },
      {
        kind: 'mesh3d',
        meshId: `${meshBaseId}-transparent`,
        materialId: 'osrs-npc',
        modelMatrix,
        positions: split.transparent?.positions ?? emptyVec3,
        normals: split.transparent?.normals ?? emptyVec3,
        perVertexHslColors: split.transparent?.hslColors ?? emptyScalar,
        perVertexAlphas: split.transparent?.alphas ?? emptyScalar,
        perVertexFaceBias: split.transparent?.faceBias,
        uvs: split.transparent?.uvs,
        perVertexTextureIds: split.transparent?.textureIds,
        depth: 'read',
        blend: 'normal',
        cullFace: 'back',
        zIndex: DEFAULT_NPC_Z_INDEX,
        animated,
      },
    ];

    const unsortedTransparentStatic = split.transparent
      ? {
          hslColors: new Float32Array(split.transparent.hslColors),
          alphas: new Float32Array(split.transparent.alphas),
          faceBias: split.transparent.faceBias ? new Float32Array(split.transparent.faceBias) : undefined,
          uvs: split.transparent.uvs ? new Float32Array(split.transparent.uvs) : undefined,
          textureIds: split.transparent.textureIds ? new Float32Array(split.transparent.textureIds) : undefined,
        }
      : null;

    return { commands, faceSplitMap, splitBuffers, transparentFaceMap, unsortedTransparentStatic };
  }

  private getInitialModelPlacement(npcTypeId: number, defaultSize: number): { position: Coordinate; size: number } {
    if (this.isPrimaryNpcType(npcTypeId) && this.primaryNpcRenderConfig) {
      return {
        position: this.primaryNpcRenderConfig.basePosition,
        size: this.primaryNpcRenderConfig.size,
      };
    }

    return {
      position: [0, 0],
      size: defaultSize,
    };
  }

  private isPrimaryNpcType(npcTypeId: number): boolean {
    return this.primaryNpcRenderConfig?.npcTypeId === npcTypeId;
  }

  private computeModelBounds(modelData: NpcModelData): ModelBounds {
    const model = modelData.mergedModel!;

    let bMinX = Infinity;
    let bMaxX = -Infinity;
    let bMinY = Infinity;
    let bMaxY = -Infinity;
    let bMinZ = Infinity;
    let bMaxZ = -Infinity;
    for (let i = 0; i < model.verticesCount; i++) {
      const vx = model.verticesX[i];
      const vy = model.verticesY[i];
      const vz = model.verticesZ[i];
      if (vx < bMinX) bMinX = vx;
      if (vx > bMaxX) bMaxX = vx;
      if (vy < bMinY) bMinY = vy;
      if (vy > bMaxY) bMaxY = vy;
      if (vz < bMinZ) bMinZ = vz;
      if (vz > bMaxZ) bMaxZ = vz;
    }

    const centerX = (bMaxX + bMinX) / 2;
    const centerY = (bMaxY + bMinY) / 2;
    const centerZ = (bMaxZ + bMinZ) / 2;
    let halfX = (bMaxX - bMinX + 1) / 2;
    const halfY = (bMaxY - bMinY + 1) / 2;
    let halfZ = (bMaxZ - bMinZ + 1) / 2;

    const MIN_HALF = 32;
    if (halfX < MIN_HALF) halfX = MIN_HALF;
    if (halfZ < MIN_HALF) halfZ = MIN_HALF;

    const CLICK_PAD = 8;
    halfX += CLICK_PAD;
    halfZ += CLICK_PAD;

    return {
      minX: centerX - halfX,
      minY: centerY - halfY,
      minZ: centerZ - halfZ,
      maxX: centerX + halfX,
      maxY: centerY + halfY,
      maxZ: centerZ + halfZ,
    };
  }

  private seedSplitBuffers(typeData: NpcTypeRenderData): SplitMapBuffers | null {
    if (!typeData.faceSplitMap) return null;
    const transparentBase = typeData.baseMeshCommands.find((cmd) => cmd.meshId.includes('-transparent'));
    const opaqueBase = typeData.baseMeshCommands.find((cmd) => cmd.meshId.includes('-opaque'));
    const buffers = createSplitMapBuffers(
      typeData.faceSplitMap,
      transparentBase?.uvs !== undefined || opaqueBase?.uvs !== undefined,
    );

    if (transparentBase?.positions) buffers.transparentPositions.set(transparentBase.positions);
    if (transparentBase?.normals) buffers.transparentNormals.set(transparentBase.normals);
    if (transparentBase?.perVertexHslColors) buffers.transparentHslColors.set(transparentBase.perVertexHslColors);
    if (transparentBase?.perVertexAlphas) buffers.transparentAlphas.set(transparentBase.perVertexAlphas);
    if (transparentBase?.perVertexFaceBias && buffers.transparentFaceBias) {
      buffers.transparentFaceBias.set(transparentBase.perVertexFaceBias);
    }
    if (transparentBase?.uvs && buffers.transparentUvs) buffers.transparentUvs.set(transparentBase.uvs);
    if (transparentBase?.perVertexTextureIds && buffers.transparentTextureIds) {
      buffers.transparentTextureIds.set(transparentBase.perVertexTextureIds);
    }
    if (opaqueBase?.positions) buffers.opaquePositions.set(opaqueBase.positions);
    if (opaqueBase?.normals) buffers.opaqueNormals.set(opaqueBase.normals);
    if (opaqueBase?.perVertexHslColors) buffers.opaqueHslColors.set(opaqueBase.perVertexHslColors);
    if (opaqueBase?.perVertexAlphas) buffers.opaqueAlphas.set(opaqueBase.perVertexAlphas);
    if (opaqueBase?.perVertexFaceBias && buffers.opaqueFaceBias) {
      buffers.opaqueFaceBias.set(opaqueBase.perVertexFaceBias);
    }
    if (opaqueBase?.uvs && buffers.opaqueUvs) buffers.opaqueUvs.set(opaqueBase.uvs);
    if (opaqueBase?.perVertexTextureIds && buffers.opaqueTextureIds) {
      buffers.opaqueTextureIds.set(opaqueBase.perVertexTextureIds);
    }
    return buffers;
  }

  private buildAnimatedMesh(
    modelData: NpcModelData,
    useSkeletal: boolean,
    animatedModel: AnimatedModel | null,
  ): AnimatedNpcMeshData | null {
    if (!modelData.mergedModel || !modelData.litColors) {
      return null;
    }

    const model = modelData.mergedModel;
    const litColors = modelData.litColors;
    const verticesX = useSkeletal ? model.verticesX : animatedModel?.verticesX;
    const verticesY = useSkeletal ? model.verticesY : animatedModel?.verticesY;
    const verticesZ = useSkeletal ? model.verticesZ : animatedModel?.verticesZ;
    if (!verticesX || !verticesY || !verticesZ) {
      return null;
    }

    let validFaceCount = 0;
    for (let f = 0; f < model.faceCount; f++) {
      if (litColors.faceColors3[f] !== -2) {
        validFaceCount++;
      }
    }

    const scalarCount = validFaceCount * 3;
    const vectorCount = validFaceCount * 9;
    // UVs are derived from the posed vertices, so they are recomputed with the
    // positions every animated frame (as RuneLite's SceneUploader does per draw).
    const hasTextures = modelHasTextures(model.faceTextures, model.faceCount);

    const scratch = ensureAnimMeshScratch(this.animMeshScratch, validFaceCount, hasTextures);
    this.animMeshScratch = scratch;
    let mesh = this.animMeshDataCache;
    // Views are rebuilt only when the used range, texture presence or backing scratch changes, so a
    // steady model reuses them; stale capacity past the used range is never exposed.
    if (
      !mesh ||
      mesh.positions.buffer !== scratch.positions.buffer ||
      mesh.modelFaceIndices.length !== validFaceCount ||
      (mesh.uvs !== undefined) !== hasTextures ||
      (mesh.uvs !== undefined && mesh.uvs.buffer !== scratch.uvs?.buffer)
    ) {
      mesh = {
        positions: scratch.positions.subarray(0, vectorCount),
        normals: scratch.normals.subarray(0, vectorCount),
        hslColors: scratch.hslColors.subarray(0, scalarCount),
        alphas: scratch.alphas.subarray(0, scalarCount),
        faceBias: scratch.faceBias.subarray(0, scalarCount),
        modelFaceIndices: scratch.modelFaceIndices.subarray(0, validFaceCount),
        faceColors3: litColors.faceColors3,
        uvs: hasTextures ? scratch.uvs!.subarray(0, scalarCount * 2) : undefined,
        textureIds: hasTextures ? scratch.textureIds!.subarray(0, scalarCount) : undefined,
      };
      this.animMeshDataCache = mesh;
    }
    mesh.faceColors3 = litColors.faceColors3;

    const { positions, normals, hslColors, alphas, faceBias, modelFaceIndices } = mesh;
    const uvs = mesh.uvs ?? null;
    const textureIds = mesh.textureIds ?? null;
    const uvGeometry: FaceTextureGeometry | null = hasTextures
      ? {
          verticesX,
          verticesY,
          verticesZ,
          indices1: model.indices1,
          indices2: model.indices2,
          indices3: model.indices3,
          textureCoords: model.textureCoords,
          textureMappingP: model.textureMappingP,
          textureMappingM: model.textureMappingM,
          textureMappingN: model.textureMappingN,
        }
      : null;

    let posWrite = 0;
    let scalarWrite = 0;
    let faceWrite = 0;

    for (let f = 0; f < model.faceCount; f++) {
      const hslA = litColors.faceColors1[f] ?? model.faceColors[f];
      let hslB = litColors.faceColors2[f] ?? model.faceColors[f];
      let hslC = litColors.faceColors3[f];
      if (hslC === -2) {
        continue;
      }

      if (hslC === -1) {
        hslC = hslA;
        hslB = hslA;
      }

      const faceAlpha = model.faceAlphas ? (255 - (model.faceAlphas[f] & 0xff)) / 255 : 1.0;
      const fb = model.faceBias ? (model.faceBias[f] === -1 ? 0 : model.faceBias[f] & 0xff) : 0;

      const i1 = model.indices1[f];
      const i2 = model.indices2[f];
      const i3 = model.indices3[f];

      positions[posWrite] = verticesX[i1];
      positions[posWrite + 1] = verticesY[i1];
      positions[posWrite + 2] = verticesZ[i1];
      writeUnitNormal(model.normals, i1, normals, posWrite);
      hslColors[scalarWrite] = hslA & 0xffff;
      alphas[scalarWrite] = faceAlpha;
      faceBias[scalarWrite] = fb;

      positions[posWrite + 3] = verticesX[i2];
      positions[posWrite + 4] = verticesY[i2];
      positions[posWrite + 5] = verticesZ[i2];
      writeUnitNormal(model.normals, i2, normals, posWrite + 3);
      hslColors[scalarWrite + 1] = hslB & 0xffff;
      alphas[scalarWrite + 1] = faceAlpha;
      faceBias[scalarWrite + 1] = fb;

      positions[posWrite + 6] = verticesX[i3];
      positions[posWrite + 7] = verticesY[i3];
      positions[posWrite + 8] = verticesZ[i3];
      writeUnitNormal(model.normals, i3, normals, posWrite + 6);
      hslColors[scalarWrite + 2] = hslC & 0xffff;
      alphas[scalarWrite + 2] = faceAlpha;
      faceBias[scalarWrite + 2] = fb;

      if (uvGeometry && uvs && textureIds) {
        const layer = faceTextureLayer(model.faceTextures, f, sharedModelTextureIndex.resolve);
        writeFaceTextureAttributes(uvGeometry, f, layer, uvs, textureIds, scalarWrite);
      }

      modelFaceIndices[faceWrite] = f;
      posWrite += 9;
      scalarWrite += 3;
      faceWrite++;
    }

    return mesh;
  }

  /**
   * The type's clips, or null when it has nothing to animate. A type with an idle seq is built
   * around it and stays unanimated if that seq does not load. One with no idle (cache -1 and no
   * override) still plays its configured walk, attack and lifecycle clips, resting on its
   * unanimated model when none is playing.
   */
  private loadAnimationSet(
    animSystem: AnimationSystem,
    npcType: Pick<NpcType, 'idleSeqId' | 'walkSeqId'>,
    config: NpcTypeLoadConfig | undefined,
  ): NpcAnimationSet | null {
    const idleSeqId = config?.idleSeqId ?? npcType.idleSeqId;
    const walkSeqId = config?.walkSeqId ?? npcType.walkSeqId;

    if (idleSeqId === -1) {
      const animationSet: NpcAnimationSet = {};
      if (walkSeqId !== -1) {
        const walkClip = this.loadAnimClip(animSystem, walkSeqId, 'walk');
        if (walkClip) animationSet.walk = walkClip;
      }
      this.loadAttackClips(animSystem, config, animationSet);
      this.loadLifecycleClips(animSystem, config, animationSet);
      const { walk, attackClips, death, deathClips, spawn } = animationSet;
      return walk || attackClips || death || deathClips || spawn ? animationSet : null;
    }

    const idleSeqType = animSystem.loadSeqType(idleSeqId);
    if (!idleSeqType) return null;

    if (idleSeqType.isSkeletalSeq()) {
      const idleSkelSeq = animSystem.loadSkeletalSeq(idleSeqType.skeletalId);
      if (!idleSkelSeq) return null;

      const attackClips: Record<string, SkeletalClipRef> = {};
      if (config?.attackClips) {
        for (const [clipId, seqId] of Object.entries(config.attackClips)) {
          if (seqId < 0) continue;
          const seqType = animSystem.loadSeqType(seqId);
          if (seqType?.isSkeletalSeq()) {
            const skelSeq = animSystem.loadSkeletalSeq(seqType.skeletalId);
            if (skelSeq) {
              attackClips[clipId] = {
                kind: 'skeletal',
                id: clipId,
                seqId: seqType.id,
                seqType,
                seq: skelSeq,
                skeletalStart: seqType.skeletalStart,
                skeletalEnd: seqType.skeletalEnd,
              };
            }
          }
        }
      }

      const animationSet: NpcAnimationSet = {
        idle: {
          kind: 'skeletal',
          id: 'idle',
          seqId: idleSeqType.id,
          seqType: idleSeqType,
          seq: idleSkelSeq,
          skeletalStart: idleSeqType.skeletalStart,
          skeletalEnd: idleSeqType.skeletalEnd,
        },
      };
      animationSet.idlePlayMode = config?.idlePlayMode;

      if (walkSeqId !== -1) {
        const walkSeqType = animSystem.loadSeqType(walkSeqId);
        const walkSkelSeq = walkSeqType?.isSkeletalSeq() ? animSystem.loadSkeletalSeq(walkSeqType.skeletalId) : null;
        if (walkSeqType && walkSkelSeq) {
          animationSet.walk = {
            kind: 'skeletal',
            id: 'walk',
            seqId: walkSeqType.id,
            seqType: walkSeqType,
            seq: walkSkelSeq,
            skeletalStart: walkSeqType.skeletalStart,
            skeletalEnd: walkSeqType.skeletalEnd,
          };
        }
      }

      if (Object.keys(attackClips).length > 0) {
        animationSet.attackClips = attackClips;
        animationSet.attack = attackClips.default;
      }

      this.loadLifecycleClips(animSystem, config, animationSet);
      return animationSet;
    }

    if (!(idleSeqType.frameIds?.length > 0)) return null;

    const animationSet: NpcAnimationSet = {
      idle: {
        kind: 'frame',
        id: 'idle',
        seqId: idleSeqType.id,
        seqType: idleSeqType,
        frameIds: idleSeqType.frameIds,
        frameLengths: idleSeqType.frameLengths,
      },
    };
    animationSet.idlePlayMode = config?.idlePlayMode;

    if (walkSeqId !== -1) {
      const walkClip = this.loadAnimClip(animSystem, walkSeqId, 'walk');
      if (walkClip) animationSet.walk = walkClip;
    }

    this.loadLifecycleClips(animSystem, config, animationSet);
    this.loadAttackClips(animSystem, config, animationSet);
    return animationSet;
  }

  /** Configured attack clips of either seq kind, keyed by clip id. */
  private loadAttackClips(
    animSystem: AnimationSystem,
    config: NpcTypeLoadConfig | undefined,
    animationSet: NpcAnimationSet,
  ): void {
    const attackClips: Record<string, AnimClipRef> = {};
    for (const [clipId, seqId] of Object.entries(config?.attackClips ?? {})) {
      if (seqId < 0) continue;
      const attackClip = this.loadAnimClip(animSystem, seqId, clipId);
      if (attackClip) attackClips[clipId] = attackClip;
    }
    if (Object.keys(attackClips).length > 0) {
      animationSet.attackClips = attackClips;
      animationSet.attack = attackClips.default;
    }
  }

  /** The one-shot clips bracketing an instance's life: spawn, the default death and per-cause deaths. */
  private loadLifecycleClips(
    animSystem: AnimationSystem,
    config: NpcTypeLoadConfig | undefined,
    animationSet: NpcAnimationSet,
  ): void {
    if (config?.deathSeqId !== undefined && config.deathSeqId >= 0) {
      const deathClip = this.loadAnimClip(animSystem, config.deathSeqId, 'death');
      if (deathClip) animationSet.death = deathClip;
    }
    if (config?.spawnSeqId !== undefined && config.spawnSeqId >= 0) {
      const spawnClip = this.loadAnimClip(animSystem, config.spawnSeqId, 'spawn');
      if (spawnClip) animationSet.spawn = spawnClip;
    }
    const deathClips: Record<string, AnimClipRef> = {};
    for (const [cause, { seqId }] of Object.entries(config?.deathClips ?? {})) {
      const clip = seqId >= 0 ? this.loadAnimClip(animSystem, seqId, `death:${cause}`) : null;
      if (clip) deathClips[cause] = clip;
    }
    if (Object.keys(deathClips).length > 0) animationSet.deathClips = deathClips;
  }

  private loadAnimClip(animSystem: AnimationSystem, seqId: number, clipId: string): AnimClipRef | null {
    const seqType = animSystem.loadSeqType(seqId);
    if (!seqType) return null;

    if (seqType.isSkeletalSeq()) {
      const skelSeq = animSystem.loadSkeletalSeq(seqType.skeletalId);
      if (!skelSeq) return null;
      return {
        kind: 'skeletal',
        id: clipId,
        seqId,
        seqType,
        seq: skelSeq,
        skeletalStart: seqType.skeletalStart,
        skeletalEnd: seqType.skeletalEnd,
      };
    }

    if (seqType.frameIds?.length > 0) {
      return {
        kind: 'frame',
        id: clipId,
        seqId,
        seqType,
        frameIds: seqType.frameIds,
        frameLengths: seqType.frameLengths,
      };
    }

    return null;
  }

  private markAllTransparentSortDirty(): void {
    for (const [, instance] of this.instanceRegistry) {
      instance.transparentSortDirty = true;
    }
    for (const [, dying] of this.dyingInstances) {
      dying.instance.transparentSortDirty = true;
    }
  }

  private sortTransparentForInstance(instance: NpcRenderInstance): void {
    if (!instance.transparentSortDirty) return;

    const typeData = this.typeRegistry.get(instance.npcTypeId);
    const model = typeData?.modelData?.mergedModel;
    const litColors = typeData?.litColors;
    const faceColors3 = instance.alphaAnimated
      ? (instance.dynamicFaceColors3 ?? litColors?.faceColors3)
      : litColors?.faceColors3;
    const faceMap = instance.alphaAnimated ? instance.dynamicTransparentFaceMap : typeData?.transparentFaceMap;
    const staticAttrs = instance.alphaAnimated
      ? instance.dynamicTransparentStatic
      : typeData?.unsortedTransparentStatic;
    if (!model || !faceColors3 || !faceMap || !staticAttrs) {
      instance.transparentSortDirty = false;
      return;
    }

    const transparentCmd = instance.instanceMeshCommands.find((cmd) => cmd.meshId.includes('-transparent'));
    if (!transparentCmd || !transparentCmd.positions || !transparentCmd.perVertexAlphas) {
      instance.transparentSortDirty = false;
      return;
    }

    const vx = instance.posedVerticesX ?? typeData.restVerticesX ?? model.verticesX;
    const vy = instance.posedVerticesY ?? typeData.restVerticesY ?? model.verticesY;
    const vz = instance.posedVerticesZ ?? typeData.restVerticesZ ?? model.verticesZ;

    const mat = instance.currentModelMatrix;
    const worldTx = mat[12];
    const worldTy = mat[13];
    const worldTz = mat[14];
    const sinTheta = mat[8] / MODEL_SCALE;
    const cosTheta = mat[0] / MODEL_SCALE;
    const theta = Math.atan2(sinTheta, cosTheta);
    const osrsOrientation = ((Math.round(theta * (2048 / (2 * Math.PI))) % 2048) + 2048) % 2048;

    const projection: SorterProjection = {
      cameraX: this.sorterCameraX,
      cameraY: this.sorterCameraY,
      cameraZ: this.sorterCameraZ,
      yawSin: this.sorterYawSin,
      yawCos: this.sorterYawCos,
      pitchSin: this.sorterPitchSin,
      pitchCos: this.sorterPitchCos,
      orientation: osrsOrientation,
      modelX: worldTx * TILE_TO_OSRS,
      modelY: -worldTz * TILE_TO_OSRS,
      modelZ: worldTy * TILE_TO_OSRS,
    };

    const sortInput: FaceSortInput = {
      verticesX: vx,
      verticesY: vy,
      verticesZ: vz,
      verticesCount: model.verticesCount,
      indices1: model.indices1,
      indices2: model.indices2,
      indices3: model.indices3,
      faceCount: model.faceCount,
      // NPC opaque faces write depth and translucent faces read it; sort their alpha
      // geometry back-to-front rather than interleaving painter-style priorities.
      faceRenderPriorities: null,
      priority: model.priority,
      faceAlphas: instance.dynamicFaceAlphas ?? model.faceAlphas,
      faceColors3,
    };

    const sorted = sortModelFaces(sortInput, projection);

    const splitBuffers = instance.instanceSplitBuffers;
    if (!splitBuffers) {
      instance.transparentSortDirty = false;
      return;
    }
    if (!instance.permuteSortOutputBuffers) {
      const maxTransparentFaces = splitBuffers.transparentPositions.length / 9;
      const maxVerts = maxTransparentFaces * 3;
      instance.permuteSortOutputBuffers = {
        positions: new Float32Array(maxTransparentFaces * 9),
        normals: new Float32Array(maxTransparentFaces * 9),
        hslColors: new Float32Array(maxVerts),
        alphas: new Float32Array(maxVerts),
        faceBias: staticAttrs.faceBias ? new Float32Array(maxVerts) : undefined,
        uvs: staticAttrs.uvs ? new Float32Array(maxVerts * 2) : undefined,
        textureIds: staticAttrs.textureIds ? new Float32Array(maxVerts) : undefined,
      };
    }
    const permuted = permuteTransparentTriangles(
      sorted.transparentFaces,
      faceMap,
      splitBuffers.transparentPositions,
      splitBuffers.transparentNormals,
      staticAttrs.hslColors,
      staticAttrs.alphas,
      staticAttrs.faceBias,
      instance.permuteSortOutputBuffers,
      staticAttrs.uvs && staticAttrs.textureIds
        ? { uvs: staticAttrs.uvs, textureIds: staticAttrs.textureIds }
        : undefined,
    );

    const out = instance.permuteSortOutputBuffers;
    if (out && (permuted.positions.buffer !== out.positions.buffer || permuted.normals.buffer !== out.normals.buffer)) {
      instance.permuteSortOutputBuffers = {
        positions: new Float32Array(permuted.positions.buffer),
        normals: new Float32Array(permuted.normals.buffer),
        hslColors: new Float32Array(permuted.hslColors.buffer),
        alphas: new Float32Array(permuted.alphas.buffer),
        faceBias: permuted.faceBias ? new Float32Array(permuted.faceBias.buffer) : undefined,
        uvs: permuted.uvs ? new Float32Array(permuted.uvs.buffer) : undefined,
        textureIds: permuted.textureIds ? new Float32Array(permuted.textureIds.buffer) : undefined,
      };
    }
    transparentCmd.positions = permuted.positions;
    transparentCmd.normals = permuted.normals;
    transparentCmd.perVertexHslColors = permuted.hslColors;
    transparentCmd.perVertexAlphas = permuted.alphas;
    transparentCmd.perVertexFaceBias = permuted.faceBias;
    transparentCmd.uvs = permuted.uvs;
    transparentCmd.perVertexTextureIds = permuted.textureIds;

    instance.transparentSortDirty = false;
  }
}
