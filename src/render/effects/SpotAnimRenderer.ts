import type { ActorFrameState } from '../../audio/FrameSoundTracker';
import type { SeqType } from '../../rs/config/seqtype/SeqType';
import type { AnimatedSpotAnimData, SpotAnimMeshData, SpotAnimModelLoader } from '../../rs/model/SpotAnimModelLoader';
import { log } from '../../util/Logger';
import { perfFlags } from '../../util/PerfFlags';
import { renderStats } from '../../util/RenderStats';
import type { AnimationSystem } from '../core/animation';
import type { Camera3D } from '../core/camera';
import type { NpcMesh3DCommand, RenderQueue, ResidentMesh3DCommand } from '../core/commands';
import {
  type FaceSortInput,
  type SorterProjection,
  sortModelFaces,
  sortTransparentFacesOnly,
} from '../core/FacePrioritySorter';
import {
  ImmutableMeshSource,
  instanceAtlasBoundBytes,
  type MeshBounds,
  type MeshSourceOptions,
  type MeshUploadData,
} from '../core/meshSource';
import { permuteTransparentTriangles, type UnlitPermuteOutputBuffers } from '../core/splitMeshByAlpha';
import { getAnimFrameIndex } from '../shared/renderUtils';
import { SkeletalSpotAnimPoser } from './SkeletalSpotAnimPoser';
import {
  createSpotAnimMeshParts,
  type SpotAnimMeshPart,
  type SpotAnimResidentGeometry,
  type SpotAnimTransparentSort,
  spotAnimOpaqueUploads,
  spotAnimPartBounds,
  spotAnimTransparentFaceMap,
  withResidentOpaqueParts,
} from './spotAnimMeshParts';
import type {
  SpotAnimFrameProgressResolver,
  SpotAnimLifecycle,
  SpotAnimSpawnRequest,
  SpotAnimStyle,
  SpotAnimTransform,
  TransformSource,
} from './spotAnimTypes';
import { isBoundsOutsideView, writeViewProjection } from './spotAnimViewRejection';

const SCALE = 1 / 128;
const TILE_TO_OSRS = 128;
const TRIG_EPSILON = 1e-6;
let nextSpotAnimInstanceId = 0;

/** Never mutate a baked entry: it is shared by every renderer drawing from the same loader. */
interface SpotAnimMeshCacheEntry {
  static: SpotAnimMeshPart[];
  frames: SpotAnimMeshPart[][];
  frameLengths: number[];
  frameStep: number;
  heightOffset: number;
  /**
   * Kept so `getFrameStates` can hand `FrameSoundTracker` the same `frameSounds` the real
   * client reads off this spotanim's sequence. Absent for a static (unanimated) spotanim.
   */
  seqType?: SeqType;
  /** Model-space bounds of every baked part, for framing. Absent or null when nothing is baked. */
  bounds?: MeshBounds | null;
  /** The resident source of the opaque parts; absent when the effect has none. */
  source?: ImmutableMeshSource;
  /** Where a shared bake came from and who holds it; absent for a renderer-local entry. */
  bakedFrom?: SharedBake;
}

/** A shared entry's origin and holders. Holds no arrays: its resident source's retirement reads it. */
interface SharedBake {
  readonly loader: SpotAnimModelLoader;
  readonly generation: number;
  /** The renderers whose cache holds the entry. A disposed one leaves; a collected one no longer counts. */
  readonly holders: Set<WeakRef<SpotAnimRenderer>>;
  /** Set when the entry leaves the shared map unheld; its resident source retires with it. */
  released: boolean;
}

function isHeld(bake: SharedBake): boolean {
  for (const holder of bake.holders) if (holder.deref()) return true;
  return false;
}

/**
 * Baked spotanim geometry shared by every `SpotAnimRenderer`, keyed by loader and spotanim id, so
 * renderers drawing at once, or a restarted scene reloading the same effects, bake each once.
 * An entry no renderer holds any more (its scene was disposed, or dropped) stays only until the
 * next bake: that bake releases it first, and its resident source retires, so the effects of an
 * encounter left behind do not stay on the CPU or the GPU beside the next encounter's.
 * `loader.clearCache()` invalidates every entry baked before it and retires their resident sources;
 * replacing the loader retires its sources too (`retireResidentSources`).
 */
interface SharedBakedEntries {
  /** The loader's `cacheGeneration` these entries were baked under. */
  generation: number;
  readonly entries: Map<number, SpotAnimMeshCacheEntry>;
}

/** Every mesh a spotanim bakes to: its animation frames, or its one static mesh. */
function bakeSpotAnimMeshes(
  loader: SpotAnimModelLoader,
  id: number,
): { animation: AnimatedSpotAnimData | null; meshes: SpotAnimMeshData[] } {
  const animation = loader.loadAnimatedSpotAnim(id);
  if (animation && animation.frames.length > 0) return { animation, meshes: animation.frames };
  const mesh = loader.loadSpotAnimMesh(id);
  return { animation: null, meshes: mesh ? [mesh] : [] };
}

/**
 * The recipe of a spotanim's resident source: rebake every frame from the loader and keep the
 * opaque parts. Built here, in a scope holding only the loader and id, so it closes over no arrays.
 */
function spotAnimOpaqueRecipe(loader: SpotAnimModelLoader, id: number): () => readonly MeshUploadData[] {
  return () =>
    spotAnimOpaqueUploads(bakeSpotAnimMeshes(loader, id).meshes.map((mesh) => createSpotAnimMeshParts('', mesh)));
}

/**
 * Loader-scoped, owned by the loader (whose replacement retires it), and retired the moment the
 * loader's generation moves on, so it can never upload or rebuild against cleared caches, or once
 * its entry is released unheld, so the renderer frees its upload.
 */
function spotAnimSourceOptions(bake: SharedBake): MeshSourceOptions {
  const { loader, generation } = bake;
  return {
    scope: 'loader',
    owner: loader,
    isRetired: () => bake.released || loader.cacheGeneration !== generation,
  };
}

/**
 * The recipe of an instancing atlas over `ids`: every part of every frame of each, in that order
 * (the order {@link SpotAnimRenderer} numbers them in), as the arrays its draws upload. Built here,
 * in a scope holding only the loader and the ids, so it closes over no arrays.
 */
function spotAnimAtlasRecipe(loader: SpotAnimModelLoader, ids: readonly number[]): () => MeshUploadData[] {
  return () => {
    const uploads: MeshUploadData[] = [];
    for (const id of ids) {
      for (const mesh of bakeSpotAnimMeshes(loader, id).meshes) {
        for (const part of createSpotAnimMeshParts('', mesh)) {
          uploads.push({
            positions: part.positions,
            perVertexHslColors: part.perVertexHslColors,
            perVertexAlphas: part.perVertexAlphas,
            perVertexFaceBias: part.perVertexFaceBias,
          });
        }
      }
    }
    return uploads;
  };
}

/** The instancing atlas of a set of baked spotanims, and the atlas part each of their parts is. */
interface SpotAnimAtlas {
  readonly source: ImmutableMeshSource;
  readonly partIndex: ReadonlyMap<SpotAnimMeshPart, number>;
}

/**
 * What the atlases of one renderer's families may take together, by their upper bound
 * ({@link instanceAtlasBoundBytes}), before any is built: a family over what is left keeps drawing
 * singly and builds nothing. An engineering guardrail, not a measured device budget.
 */
const ATLAS_ALLOWANCE_BYTES = 1024 * 1024;

/** The state of a batchable family: why it carries an atlas, or why not. */
type SpotAnimFamilyStatus = 'pending' | 'over-allowance' | 'unbuildable' | 'admitted';

/**
 * One family of `setBatchableSpotAnimFamilies` and what came of it. Re-evaluated only when one of
 * its entries changes (a bake, a rebake, a release); its atlas source retires with `lease`.
 */
interface BatchFamily {
  /** Sorted; the atlas lists their parts in this order. */
  readonly ids: readonly number[];
  /** The entries last evaluated, by id; undefined while one is unbaked or skeletal. */
  readonly entries: (SpotAnimMeshCacheEntry | undefined)[];
  /** The atlas's upper bound over those entries; NaN while one is missing. */
  boundBytes: number;
  status: SpotAnimFamilyStatus;
  atlas: SpotAnimAtlas | null;
  /** Whether building `atlas` from these entries was attempted; a failed build is not retried until they change. */
  built: boolean;
  /** Cleared when the atlas is dropped, which retires its source. Holds nothing else. */
  lease: { live: boolean };
}

function dropFamilyAtlas(family: BatchFamily): void {
  family.lease.live = false;
  family.lease = { live: true };
  family.atlas = null;
  family.built = false;
}

function bakeEntry(loader: SpotAnimModelLoader, id: number): SpotAnimMeshCacheEntry {
  const bakedFrom: SharedBake = {
    loader,
    generation: loader.cacheGeneration,
    holders: new Set(),
    released: false,
  };
  const { animation, meshes } = bakeSpotAnimMeshes(loader, id);
  if (meshes.length === 0) {
    log.warn('SpotAnimRenderer', `Failed to load spotanim mesh ${id}`);
    return { static: [], frames: [], frameLengths: [], frameStep: -1, heightOffset: 0, bounds: null, bakedFrom };
  }
  const embedded = meshes.map((mesh, frameIdx) =>
    createSpotAnimMeshParts(animation ? `spotanim-${id}-frame-${frameIdx}` : `spotanim-${id}`, mesh),
  );
  const uploads = spotAnimOpaqueUploads(embedded);
  // Loader-scoped: the entry, and so the source, is shared by every scene drawing from this loader.
  const source =
    uploads.length > 0
      ? new ImmutableMeshSource(
          `spotanim-${id}`,
          uploads,
          spotAnimOpaqueRecipe(loader, id),
          spotAnimSourceOptions(bakedFrom),
        )
      : undefined;
  const parts = source ? withResidentOpaqueParts(embedded, source) : embedded;
  const bounds = spotAnimPartBounds(parts);
  if (!animation) {
    return {
      static: parts[0] ?? [],
      frames: [],
      frameLengths: [],
      frameStep: -1,
      heightOffset: 0,
      bounds,
      source,
      bakedFrom,
    };
  }
  return {
    static: [],
    frames: parts,
    frameLengths: animation.frameLengths,
    frameStep: animation.seqType.frameStep,
    heightOffset: animation.seqType.heightOffset,
    seqType: animation.seqType,
    bounds,
    source,
    bakedFrom,
  };
}

/**
 * One live effect. An upsert of a live id updates its record in place, so an effect re-requested
 * every frame allocates nothing; the record owns its lifecycle, so a caller may reuse its request.
 */
interface ActiveSpotAnimInstance {
  readonly instanceId: string;
  spotAnimId: number;
  transform: TransformSource;
  lifecycle: SpotAnimLifecycle;
  style?: SpotAnimStyle;
  groupId?: string;
  frameProgress?: number | SpotAnimFrameProgressResolver;
  heightOffsetMode: 'sequence' | 'actor';
  /** See {@link SpotAnimSpawnRequest.projectile}. */
  projectile: boolean;
  permuteBuffers?: UnlitPermuteOutputBuffers;
  /**
   * Tile this instance was last drawn at since its last spawn or upsert, when `hasRenderCenter`, so
   * its frame sounds attenuate from where it appears.
   */
  readonly renderCenter: [number, number];
  hasRenderCenter: boolean;
}

/** `source` written into `target` when they are the same kind, else a copy of it. */
function copyLifecycle(target: SpotAnimLifecycle | undefined, source: SpotAnimLifecycle): SpotAnimLifecycle {
  if (target?.kind === 'oneShot' && source.kind === 'oneShot') {
    target.startTick = source.startTick;
    target.durationTicks = source.durationTicks;
    return target;
  }
  if (target?.kind === 'duration' && source.kind === 'duration') {
    target.startTick = source.startTick;
    target.endTick = source.endTick;
    return target;
  }
  if (target?.kind === 'persistent' && source.kind === 'persistent') {
    target.startTick = source.startTick;
    return target;
  }
  if (target?.kind === 'manual' && source.kind === 'manual') return target;
  return { ...source };
}

/** A transparent part's visibility key, after its mesh id; see `isTransparentPartVisible`. */
interface VisibilityKey {
  orientation: number;
  pitchRad: number;
  scale: number;
  regionX: number;
  regionZ: number;
}

/** The keys of one mesh id's parts found visible in the frame numbered `frame`: `keys[0, count)`. */
interface VisibleKeys {
  frame: number;
  count: number;
  readonly keys: VisibilityKey[];
}

/** Equal exactly when the two numbers print the same, as a string key compared them: -0 is 0, NaN is NaN. */
function sameKeyNumber(left: number, right: number): boolean {
  return left === right || (Number.isNaN(left) && Number.isNaN(right));
}

export class SpotAnimRenderer {
  private static readonly sharedBaked = new WeakMap<SpotAnimModelLoader, SharedBakedEntries>();

  private static sharedBakedEntry(loader: SpotAnimModelLoader, id: number): SpotAnimMeshCacheEntry {
    let shared = SpotAnimRenderer.sharedBaked.get(loader);
    if (!shared) {
      shared = { generation: loader.cacheGeneration, entries: new Map() };
      SpotAnimRenderer.sharedBaked.set(loader, shared);
    } else if (shared.generation !== loader.cacheGeneration) {
      // `loader.clearCache()` invalidates everything baked from it: release all of it, not just `id`.
      shared.entries.clear();
      shared.generation = loader.cacheGeneration;
    }
    const entries = shared.entries;
    const cached = entries.get(id);
    if (cached) return cached;
    // Released before baking, so a new encounter's effects never sit beside those of one left behind.
    entries.forEach((held, heldId) => {
      const bake = held.bakedFrom;
      if (!bake || isHeld(bake)) return;
      bake.released = true;
      entries.delete(heldId);
    });
    const entry = bakeEntry(loader, id);
    entries.set(id, entry);
    return entry;
  }

  /** This renderer, as its shared entries record it: weakly, so a renderer never disposed still lets go. */
  private readonly holder = new WeakRef<SpotAnimRenderer>(this);

  private meshCache = new Map<number, SpotAnimMeshCacheEntry>();
  /** The loader every entry was baked or posed from; see {@link bindLoader}. */
  private boundLoader: SpotAnimModelLoader | null = null;
  private skeletalPosers = new Map<number, SkeletalSpotAnimPoser>();
  private pendingSkeletal = new Map<number, SpotAnimModelLoader>();
  private animationSystem: AnimationSystem | null = null;
  private activeInstances = new Map<string, ActiveSpotAnimInstance>();

  getActiveInstanceCount(): number {
    return this.activeInstances.size;
  }
  private groups = new Map<string, Set<string>>();
  private sortVerticesX = new Float64Array(0);
  private sortVerticesY = new Float64Array(0);
  private sortVerticesZ = new Float64Array(0);
  private sortModelMatrix = new Float32Array(16);
  private commandPool: NpcMesh3DCommand[] = [];
  private commandPoolSize = 0;
  private residentPool: ResidentMesh3DCommand[] = [];
  private residentPoolSize = 0;
  private terrainHeights: Int32Array[] | null = null;
  private currentTick = 0;
  private interpolatedTick = 0;
  private hasSorterProjection = false;
  private sorterCameraX = 0;
  private sorterCameraY = 0;
  private sorterCameraZ = 0;
  private sorterYawSin = 0;
  private sorterYawCos = 1;
  private sorterPitchSin = 0;
  private sorterPitchCos = 1;

  /**
   * Visibility cache, valid for one frame: the transparent parts found visible, by mesh id and then
   * orientation and region. Entries of earlier frames are reused, so a frame allocates nothing.
   */
  private visibleParts = new Map<string, VisibleKeys>();
  private renderFrame = 0;
  /** The families of `setBatchableSpotAnimFamilies`, in admission order. */
  private batchFamilies: BatchFamily[] = [];
  /** Every part of an admitted family's spotanims: its atlas source and its part there. */
  private readonly batchParts = new Map<SpotAnimMeshPart, readonly [ImmutableMeshSource, number]>();
  /** Spotanims whose certified zero-area parts are left out of the queue (`setZeroAreaPartSkip`). */
  private zeroAreaSkipIds: ReadonlySet<number> = new Set();
  /** Where `render` puts a transform with the sequence's height offset added. */
  private readonly offsetTransform: SpotAnimTransform = { position: [0, 0, 0] };
  /** The view `setViewRejection` was given, as `projection × view`; read only while `hasViewRejection`. */
  private readonly viewRejection = new Float64Array(16);
  private hasViewRejection = false;
  /** See {@link setHideProjectiles}. */
  private hideProjectiles = false;
  /** An instance's model matrix, for the view test before its commands exist. */
  private readonly rejectionModelMatrix = new Float32Array(16);
  private readonly sorterProjection: SorterProjection = {
    cameraX: 0,
    cameraY: 0,
    cameraZ: 0,
    yawSin: 0,
    yawCos: 1,
    pitchSin: 0,
    pitchCos: 1,
    orientation: 0,
    modelX: 0,
    modelY: 0,
    modelZ: 0,
  };
  /** The sorter's input for the part being sorted, rewritten for every sort; the sorter keeps none of it. */
  private readonly sortInput: FaceSortInput = {
    verticesX: this.sortVerticesX,
    verticesY: this.sortVerticesY,
    verticesZ: this.sortVerticesZ,
    verticesCount: 0,
    indices1: [],
    indices2: [],
    indices3: [],
    faceCount: 0,
    faceRenderPriorities: null,
    priority: 0,
    faceAlphas: null,
    faceColors3: [],
  };

  dispose(): void {
    this.meshCache.forEach((entry) => {
      entry.bakedFrom?.holders.delete(this.holder);
    });
    this.meshCache.clear();
    this.boundLoader = null;
    this.skeletalPosers.clear();
    this.pendingSkeletal.clear();
    this.activeInstances.clear();
    this.groups.clear();
    this.commandPool.length = 0;
    this.commandPoolSize = 0;
    this.residentPool.length = 0;
    this.residentPoolSize = 0;
    this.terrainHeights = null;
    this.visibleParts.clear();
    this.hasViewRejection = false;
    for (const family of this.batchFamilies) dropFamilyAtlas(family);
    this.batchFamilies = [];
    this.batchParts.clear();
    this.zeroAreaSkipIds = new Set();
  }

  /**
   * Drop every live instance without destroying the (static, timeline-agnostic)
   * mesh cache.
   *
   * `dispose()` is too destructive for a replay seek — it throws away loaded
   * meshes that would have to be rebuilt. Encounter controllers explicitly
   * despawn the groups they own on a discontinuity, but any instance spawned
   * outside a reset participant (one-shot event spotanims, ad-hoc spawns) would
   * otherwise survive the jump and hang in the air on the seeked frame. This is
   * the base-owned catch-all, called from the compositor's transient reset.
   */
  clearActiveInstances(): void {
    this.activeInstances.clear();
    this.groups.clear();
    this.commandPool.length = 0;
    this.commandPoolSize = 0;
    this.residentPool.length = 0;
    this.residentPoolSize = 0;
    this.visibleParts.clear();
  }

  setTerrainHeights(heights: Int32Array[] | null): void {
    this.terrainHeights = heights;
  }

  /**
   * The camera the next `render` is drawn with, for instances styled `cullOutsideView`; `null`
   * leaves every draw in. Only the matrix product is kept, never the camera.
   */
  setViewRejection(camera: Pick<Camera3D, 'viewMatrix' | 'projectionMatrix'> | null): void {
    this.hasViewRejection = camera !== null && writeViewProjection(camera, this.viewRejection);
  }

  /**
   * Entity Hider's Hide projectiles: leaves every instance spawned as a projectile out of the next
   * `render`. Like view rejection, the instance stays live, so its timeline and frame sounds go on.
   */
  setHideProjectiles(hidden: boolean): void {
    this.hideProjectiles = hidden;
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
      this.hasSorterProjection = false;
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
  }

  preload(loader: SpotAnimModelLoader, ids: number[]): void {
    for (const id of ids) {
      this.loadById(loader, id);
    }
  }

  /**
   * Skeletal sequences are posed per frame instead of baked, so their `SkeletalSeq` has to come
   * from the animation system rather than the cache loader. Without one they stay unrenderable:
   * the rest pose a bake would produce is a flat lattice of particle quads, not a neutral stand-in.
   */
  setAnimationSystem(animationSystem: AnimationSystem | null): void {
    this.animationSystem = animationSystem;
    if (!animationSystem) {
      return;
    }
    const pending = Array.from(this.pendingSkeletal);
    this.pendingSkeletal.clear();
    for (const [id, loader] of pending) {
      this.loadSkeletalById(loader, id);
    }
  }

  private loadSkeletalById(loader: SpotAnimModelLoader, id: number): void {
    if (!this.animationSystem) {
      // The scene loads spotanims and the NPC (which carries the animation system) from separate
      // effects with no ordering between them. Leaving this uncached rather than caching it empty
      // keeps `isLoaded` false, so spawn sites hold off until `setAnimationSystem` drains this.
      this.pendingSkeletal.set(id, loader);
      return;
    }

    const data = loader.loadSkeletalSpotAnimModel(id);
    const skeletalSeq = data ? this.animationSystem.loadSkeletalSeq(data.seqType.skeletalId) : undefined;
    if (!data || !skeletalSeq) {
      log.warn('SpotAnimRenderer', `Skeletal spotanim ${id} could not be prepared for posing; it will not render`);
      // Cached rather than left pending so `isSpotAnimsLoaded` still settles — a scene must not hang
      // waiting on an effect the cache cannot supply. That makes the failure final: a later
      // `setAnimationSystem` will not retry this id, because `loadById` short-circuits on a cache hit.
      this.meshCache.set(id, { static: [], frames: [], frameLengths: [], frameStep: -1, heightOffset: 0 });
      return;
    }

    const poser = new SkeletalSpotAnimPoser(loader, data, skeletalSeq);
    this.skeletalPosers.set(id, poser);
    // `frames` stays empty because the meshes come from the poser. The duration is published as one
    // frameLength per client tick rather than a single total: the sum is what lifecycle expiry and
    // frame progress read, and it is the same either way, but the cache explorer's preview derives
    // its frame count and scrubber from the entry count and would otherwise show a single frame.
    this.meshCache.set(id, {
      static: [],
      frames: [],
      frameLengths: new Array<number>(poser.durationClientTicks).fill(1),
      frameStep: -1,
      heightOffset: data.seqType.heightOffset,
      seqType: data.seqType,
    });
  }

  /**
   * Binds this renderer to `loader`. On a change (the loader was replaced, a cache reload), every
   * entry from another loader is rebaked or reposed from this one at once, so nothing drawn,
   * prepared or rebuilt from here refers to the replaced loader again.
   */
  bindLoader(loader: SpotAnimModelLoader): void {
    if (this.boundLoader === loader) return;
    this.boundLoader = loader;
    for (const [id, entry] of [...this.meshCache]) {
      if (entry.bakedFrom && entry.bakedFrom.loader !== loader) {
        this.holdShared(id, SpotAnimRenderer.sharedBakedEntry(loader, id));
      }
    }
    for (const id of [...this.skeletalPosers.keys()]) {
      this.skeletalPosers.delete(id);
      this.meshCache.delete(id);
      this.loadSkeletalById(loader, id);
    }
    for (const id of [...this.pendingSkeletal.keys()]) this.pendingSkeletal.set(id, loader);
  }

  /** Whether the effects loaded so far came from `loader`. */
  isBoundTo(loader: SpotAnimModelLoader): boolean {
    return this.boundLoader === loader;
  }

  loadById(loader: SpotAnimModelLoader, id: number): void {
    if (id < 0) return;
    this.bindLoader(loader);
    if (this.entry(id)) return;

    if (loader.isSkeletalOnly(id)) {
      this.loadSkeletalById(loader, id);
      return;
    }

    this.holdShared(id, SpotAnimRenderer.sharedBakedEntry(loader, id));
  }

  /** Caches a shared entry for `id`, letting go of the one it replaces. */
  private holdShared(id: number, entry: SpotAnimMeshCacheEntry): SpotAnimMeshCacheEntry {
    const previous = this.meshCache.get(id);
    if (previous === entry) return entry;
    previous?.bakedFrom?.holders.delete(this.holder);
    entry.bakedFrom?.holders.add(this.holder);
    this.meshCache.set(id, entry);
    return entry;
  }

  isLoaded(id: number): boolean {
    return this.meshCache.has(id);
  }

  /** Loaded with something to draw: false while pending and for an effect the cache could not supply. */
  isUsable(id: number): boolean {
    const entry = this.meshCache.get(id);
    return entry !== undefined && (entry.static.length > 0 || entry.frames.length > 0 || this.skeletalPosers.has(id));
  }

  /**
   * This renderer's entry for `id`, current with its loader: when the loader has cleared its caches
   * since the bake, the stale entry (opaque source, transparent parts and bounds alike) is replaced
   * by a fresh bake before anything reads or draws it, so generations never mix.
   */
  private entry(id: number): SpotAnimMeshCacheEntry | undefined {
    const entry = this.meshCache.get(id);
    const bakedFrom = entry?.bakedFrom;
    if (!bakedFrom || bakedFrom.generation === bakedFrom.loader.cacheGeneration) return entry;
    return this.holdShared(id, SpotAnimRenderer.sharedBakedEntry(bakedFrom.loader, id));
  }

  /**
   * Lets the backend draw runs of each family's baked parts as single instanced draws: their
   * commands carry one instancing atlas of all the family's frames (`Mesh3DCommand.instanceAtlas`).
   * An encounter's render policy opts in; no families (the default) opts out. Families are admitted
   * in the order given while their atlases' upper bounds fit {@link ATLAS_ALLOWANCE_BYTES} together;
   * one that does not, or is not baked yet, builds nothing and draws singly. Skeletal spotanims and
   * transparent parts drawn fully sorted (permuted per instance) never carry an atlas.
   *
   * Each family's ids are copied and sorted, empty families are dropped, and a family listed again
   * keeps what it built. An id in two families, or twice in one, is a configuration error: it throws
   * and nothing changes.
   */
  setBatchableSpotAnimFamilies(families: readonly (readonly number[])[]): void {
    const canonical = families.filter((ids) => ids.length > 0).map((ids) => [...ids].sort((a, b) => a - b));
    const seen = new Set<number>();
    for (const ids of canonical) {
      for (const id of ids) {
        if (seen.has(id)) throw new Error(`Spotanim ${id} is listed in more than one batchable family`);
        seen.add(id);
      }
    }
    const kept = new Map(this.batchFamilies.map((family) => [family.ids.join(','), family]));
    this.batchFamilies = canonical.map((ids) => {
      const key = ids.join(',');
      const existing = kept.get(key);
      kept.delete(key);
      return (
        existing ?? {
          ids,
          entries: ids.map(() => undefined),
          boundBytes: Number.NaN,
          status: 'pending',
          atlas: null,
          built: false,
          lease: { live: true },
        }
      );
    });
    for (const removed of kept.values()) dropFamilyAtlas(removed);
    this.syncFamilyEntries();
    this.admitBatchFamilies();
  }

  /**
   * Leaves the certified zero-area parts (`hasOnlyRepeatedCornerTriangles`) of these baked spotanims
   * out of the queue. They rasterize nothing with the scene-base program the spotanims draw with, so
   * the frame is the same; the instance, its timing, sounds and every other part are untouched.
   */
  setZeroAreaPartSkip(ids: readonly number[]): void {
    this.zeroAreaSkipIds = new Set(ids);
  }

  /**
   * Re-evaluates the families once one of their entries changed since the last look; allocates
   * nothing when none did, which is every frame but those after a bake.
   */
  private refreshBatchFamilies(): void {
    if (this.syncFamilyEntries()) this.admitBatchFamilies();
  }

  /** Takes each family's current entries; a family any of whose entries changed is pending again. */
  private syncFamilyEntries(): boolean {
    let changed = false;
    for (const family of this.batchFamilies) {
      for (let index = 0; index < family.ids.length; index++) {
        const id = family.ids[index] as number;
        const entry = this.skeletalPosers.has(id) ? undefined : this.entry(id);
        if (entry === family.entries[index]) continue;
        family.entries[index] = entry;
        changed = true;
        dropFamilyAtlas(family);
        family.status = 'pending';
        family.boundBytes = Number.NaN;
      }
    }
    return changed;
  }

  /**
   * Admits the families in order against the allowance: a family that is not ready, or whose bound
   * does not fit what is left, takes none of it. Builds the atlas of an admitted family once per set
   * of entries; drops (and so retires) the atlas of one no longer admitted.
   */
  private admitBatchFamilies(): void {
    let allowance = ATLAS_ALLOWANCE_BYTES;
    this.batchParts.clear();
    for (const family of this.batchFamilies) {
      if (family.status === 'pending') family.boundBytes = this.familyBoundBytes(family);
      if (!(family.boundBytes <= allowance)) {
        // NaN (not ready) or over what is left: nothing is built and nothing taken.
        if (family.atlas) dropFamilyAtlas(family);
        family.status = Number.isNaN(family.boundBytes) ? 'pending' : 'over-allowance';
        continue;
      }
      if (!family.built) {
        family.built = true;
        family.atlas = this.buildFamilyAtlas(family);
      }
      if (!family.atlas) {
        family.status = 'unbuildable';
        continue;
      }
      family.status = 'admitted';
      allowance -= family.boundBytes;
      const source = family.atlas.source;
      for (const [part, index] of family.atlas.partIndex) this.batchParts.set(part, [source, index]);
    }
  }

  /**
   * The family's atlas upper bound from what its bakes already know (resident part descriptors,
   * embedded arrays), so nothing is baked again to learn it; NaN until every id is baked.
   */
  private familyBoundBytes(family: BatchFamily): number {
    const vertexCounts: number[] = [];
    for (const entry of family.entries) {
      if (!entry?.bakedFrom) return Number.NaN;
      for (const parts of entry.frames.length > 0 ? entry.frames : [entry.static]) {
        for (const part of parts) {
          vertexCounts.push(
            part.resident
              ? (part.resident.source.parts[part.resident.part]?.vertexCount ?? Number.NaN)
              : (part.positions?.length ?? 0) / 3,
          );
        }
      }
    }
    return instanceAtlasBoundBytes(vertexCounts);
  }

  /**
   * The atlas over the family's current bakes; null when they come from different loaders or
   * generations, or do not number their parts as the atlas recipe does.
   */
  private buildFamilyAtlas(family: BatchFamily): SpotAnimAtlas | null {
    const { ids, lease } = family;
    const entries = family.entries as SpotAnimMeshCacheEntry[];
    const bakes = entries.map((entry) => entry.bakedFrom as SharedBake);
    const { loader, generation } = bakes[0] as SharedBake;
    if (bakes.some((bake) => bake.loader !== loader || bake.generation !== generation)) return null;
    const uploads = spotAnimAtlasRecipe(loader, ids)();
    const partIndex = new Map<SpotAnimMeshPart, number>();
    for (const entry of entries) {
      for (const parts of entry.frames.length > 0 ? entry.frames : [entry.static]) {
        for (const part of parts) {
          const upload = uploads[partIndex.size];
          const vertexCount = part.resident
            ? part.resident.source.parts[part.resident.part]?.vertexCount
            : (part.positions?.length ?? 0) / 3;
          if (!upload || upload.positions.length / 3 !== vertexCount) {
            log.warn('SpotAnimRenderer', `Instancing atlas of ${ids.join(',')} does not match its bakes`);
            return null;
          }
          partIndex.set(part, partIndex.size);
        }
      }
    }
    if (partIndex.size !== uploads.length) return null;
    const source = new ImmutableMeshSource(
      `spotanim-atlas-${ids.join('-')}`,
      uploads,
      spotAnimAtlasRecipe(loader, ids),
      {
        scope: 'loader',
        owner: loader,
        isRetired: () => !lease.live || loader.cacheGeneration !== generation || bakes.some((bake) => bake.released),
        use: 'instanceAtlas',
      },
    );
    return { source, partIndex };
  }

  /**
   * The resident sources of every effect loaded so far, and the instancing atlas once there is one,
   * for the renderer to upload ahead of first cast.
   */
  getResidentMeshSources(): ImmutableMeshSource[] {
    const sources: ImmutableMeshSource[] = [];
    for (const id of [...this.meshCache.keys()]) {
      const source = this.entry(id)?.source;
      if (source) sources.push(source);
    }
    this.refreshBatchFamilies();
    for (const family of this.batchFamilies)
      if (family.status === 'admitted' && family.atlas) sources.push(family.atlas.source);
    return sources;
  }

  getFrameLengths(id: number): number[] | undefined {
    return this.entry(id)?.frameLengths;
  }

  /**
   * Model-space bounds of every baked part of `id` across all its frames, for callers that need the
   * effect's extent. Null for a skeletal spotanim, whose poses are built on demand, and for an
   * effect with no geometry.
   */
  getBakedBounds(id: number): MeshBounds | null {
    return this.entry(id)?.bounds ?? null;
  }

  getFrameStep(id: number): number | undefined {
    return this.entry(id)?.frameStep;
  }

  /**
   * Per-instance frame state for `FrameSoundTracker`, so the sounds a spotanim's sequence
   * carries play the way the real client plays them: off the animation, not off a rule.
   *
   * Namespaced because instance ids are controller-chosen (`'attack-player-impact'`) and would
   * otherwise be free to collide with an npc's actor id.
   */
  getFrameStates(): ActorFrameState[] {
    const states: ActorFrameState[] = [];
    this.activeInstances.forEach((instance, instanceId) => {
      const cacheEntry = this.entry(instance.spotAnimId);
      if (!cacheEntry?.seqType?.frameSounds?.size) return;
      const frameProgress = this.resolveFrameProgress(instance, cacheEntry.frameLengths);
      states.push({
        actorId: `spotanim:${instanceId}`,
        seqId: cacheEntry.seqType.id,
        currentFrame: this.resolveFrameIndex(cacheEntry, frameProgress),
        seqType: cacheEntry.seqType,
        position: instance.hasRenderCenter
          ? [instance.renderCenter[0], instance.renderCenter[1]]
          : this.staticCenterOf(instance),
      });
    });
    return states;
  }

  /**
   * Where an instance that `render` has not reached yet sounds from. A dynamic transform needs
   * tick arguments this method does not have, so it reports no position at all and the tracker
   * plays it unattenuated rather than dropping it — one frame later `renderCenter` takes over.
   */
  private staticCenterOf(instance: ActiveSpotAnimInstance): [number, number] | null {
    return instance.transform.kind === 'static'
      ? [instance.transform.value.position[0], instance.transform.value.position[1]]
      : null;
  }

  spawn(req: SpotAnimSpawnRequest): string {
    const instanceId = req.instanceId ?? `spotanim-${nextSpotAnimInstanceId++}`;
    this.insertInstance(instanceId, req);
    return instanceId;
  }

  spawnBatch(reqs: SpotAnimSpawnRequest[]): string[] {
    const ids: string[] = [];
    for (const req of reqs) {
      ids.push(this.spawn(req));
    }
    return ids;
  }

  /**
   * Spawns the effect, or replaces a live one of the same id as if it were spawned anew, apart from
   * keeping its permutation workspace while the effect is the same. The request is not kept: its
   * fields are copied, and its transform, style and frame progress are read from then on.
   */
  upsert(req: SpotAnimSpawnRequest): string {
    const instanceId = req.instanceId ?? `spotanim-${nextSpotAnimInstanceId++}`;
    const instance = this.activeInstances.get(instanceId);
    if (!instance) {
      this.insertInstance(instanceId, req);
      return instanceId;
    }
    if (instance.groupId !== req.groupId) {
      this.removeFromGroups(instanceId);
      this.addToGroup(instanceId, req.groupId);
    }
    if (instance.spotAnimId !== req.spotAnimId) instance.permuteBuffers = undefined;
    assignRequest(instance, req);
    return instanceId;
  }

  despawn(id: string): void {
    if (!this.activeInstances.has(id)) {
      return;
    }
    this.activeInstances.delete(id);
    this.removeFromGroups(id);
  }

  despawnGroup(groupId: string): void {
    const ids = this.groups.get(groupId);
    if (!ids) {
      return;
    }
    for (const id of ids) {
      this.activeInstances.delete(id);
    }
    this.groups.delete(groupId);
  }

  tick(currentTick: number, interpolatedTick: number): void {
    this.currentTick = currentTick;
    this.interpolatedTick = interpolatedTick;

    // Deleting the entry being visited is safe: iteration goes on with the next.
    this.activeInstances.forEach((instance, id) => {
      if (this.shouldExpire(instance, interpolatedTick)) this.despawn(id);
    });
  }

  render(queue: RenderQueue): void {
    this.commandPoolSize = 0;
    this.residentPoolSize = 0;
    this.renderFrame++;
    this.refreshBatchFamilies();

    // forEach, not for-of: a Map iterator's results are allocated wherever it is not optimized away.
    this.activeInstances.forEach((instance) => {
      this.renderInstance(queue, instance);
    });
    this.commandPool.length = this.commandPoolSize;
    this.residentPool.length = this.residentPoolSize;
  }

  private renderInstance(queue: RenderQueue, instance: ActiveSpotAnimInstance): void {
    // Future-scheduled timed lifecycles must remain hidden until their start tick; manual
    // lifecycles have no time reference.
    const lifecycle = instance.lifecycle;
    if (
      (lifecycle.kind === 'oneShot' || lifecycle.kind === 'duration' || lifecycle.kind === 'persistent') &&
      this.interpolatedTick < lifecycle.startTick
    ) {
      return;
    }

    const cacheEntry = this.entry(instance.spotAnimId);
    if (!cacheEntry) return;

    const transform = this.resolveTransform(instance.transform);
    if (!transform) return;
    instance.renderCenter[0] = transform.position[0];
    instance.renderCenter[1] = transform.position[1];
    instance.hasRenderCenter = true;
    // After the render center, like view rejection: a hidden projectile still sounds from where it flies.
    if (this.hideProjectiles && instance.projectile) return;
    const sequenceHeightOffset = instance.heightOffsetMode === 'sequence' ? cacheEntry.heightOffset : 0;
    const renderTransform =
      sequenceHeightOffset === 0 ? transform : this.withHeightOffset(transform, sequenceHeightOffset * SCALE);

    const frameProgress = this.resolveFrameProgress(instance, cacheEntry.frameLengths);
    const poser = this.skeletalPosers.get(instance.spotAnimId);
    if (this.hasViewRejection && instance.style?.cullOutsideView === true && !poser) {
      // The same matrix the instance's commands would get, against bounds spanning every frame.
      this.fillModelMatrix(this.rejectionModelMatrix, renderTransform);
      if (isBoundsOutsideView(this.viewRejection, this.rejectionModelMatrix, cacheEntry.bounds ?? null)) return;
    }
    const meshParts = poser
      ? poser.partsFor(poser.frameAt(frameProgress))
      : this.resolveMeshParts(cacheEntry, frameProgress);
    if (!meshParts || meshParts.length === 0) return;
    const skipZeroArea = !poser && this.zeroAreaSkipIds.has(instance.spotAnimId);

    // Indexed loops on the per-frame paths: an array iterator is allocated wherever it is not optimized away.
    for (let index = 0; index < meshParts.length; index++) {
      const part = meshParts[index] as SpotAnimMeshPart;
      if (skipZeroArea && part.hasOnlyRepeatedCornerTriangles) continue;
      if (part.resident) {
        this.pushResidentCommand(queue, part, part.resident, renderTransform, instance.style);
        continue;
      }
      const positions = part.positions;
      if (!positions) continue;
      if (part.blend === 'normal') {
        const cullFace = instance.style?.cullFace ?? part.cullFace;
        const useSkipSort = perfFlags.skipTransparentSort && !instance.style?.requireTransparentSort;
        if (useSkipSort) {
          // GPU back-face culling replaces per-face CPU cull.
          if (
            (cullFace === undefined || cullFace === 'back') &&
            !this.isTransparentPartVisible(part, renderTransform)
          ) {
            continue;
          }
          this.pushMeshCommand(queue, part, positions, renderTransform, instance.style, cullFace ?? 'back');
          renderStats.recordTransparentSkippedSort();
        } else {
          const cmd = this.pushMeshCommand(queue, part, positions, renderTransform, instance.style);
          const sorted = this.getSortedTransparentPart(part, positions, cmd.modelMatrix, cullFace ?? 'back', instance);
          if (sorted) {
            cmd.positions = sorted.positions;
            cmd.perVertexHslColors = sorted.hslColors;
            cmd.perVertexAlphas = sorted.alphas;
            cmd.perVertexFaceBias = sorted.faceBias;
          }
          // Permuted/culled buffers must never overwrite the immutable baked VAO, nor draw as the atlas does.
          this.setInstanceAtlas(cmd, null);
          cmd.meshId = `${part.meshId}-sorted`;
          cmd.animated = true;
          renderStats.recordTransparentFullSort();
        }
      } else {
        this.pushMeshCommand(queue, part, positions, renderTransform, instance.style);
      }
    }
  }

  /** An opaque baked part, drawn from its GPU-resident source with this instance's matrix. */
  private pushResidentCommand(
    queue: RenderQueue,
    part: SpotAnimMeshPart,
    resident: SpotAnimResidentGeometry,
    transform: SpotAnimTransform,
    style?: SpotAnimStyle,
  ): void {
    let cmd = this.residentPool[this.residentPoolSize];
    if (!cmd) {
      cmd = {
        kind: 'mesh3d',
        meshId: '',
        materialId: 'osrs-npc',
        modelMatrix: new Float32Array(16),
        meshSource: resident.source,
        meshSourcePart: 0,
      };
      this.residentPool.push(cmd);
    }
    this.residentPoolSize++;
    cmd.meshId = part.meshId;
    cmd.materialId = part.materialId;
    cmd.meshSource = resident.source;
    cmd.meshSourcePart = resident.part;
    cmd.depth = part.depth;
    cmd.blend = part.blend;
    cmd.zIndex = style?.zIndex ?? part.zIndex;
    cmd.depthBias = style?.depthBias ?? part.depthBias;
    cmd.cullFace = style?.cullFace ?? part.cullFace ?? 'back';
    this.setInstanceAtlas(cmd, part);
    this.fillModelMatrix(cmd.modelMatrix, transform);
    queue.commands.push(cmd);
  }

  /** Points `cmd` at `part` in its family's atlas, or at none: pooled commands are reused for any part. */
  private setInstanceAtlas(cmd: NpcMesh3DCommand | ResidentMesh3DCommand, part: SpotAnimMeshPart | null): void {
    const atlasPart = part ? this.batchParts.get(part) : undefined;
    // Without an atlas, a command that never had one is left as it was, without the keys.
    if (atlasPart === undefined && cmd.instanceAtlas === undefined) return;
    cmd.instanceAtlas = atlasPart?.[0];
    cmd.instanceAtlasPart = atlasPart?.[1];
  }

  private pushMeshCommand(
    queue: RenderQueue,
    part: SpotAnimMeshPart,
    positions: Float32Array,
    transform: SpotAnimTransform,
    style?: SpotAnimStyle,
    forceCullFace?: 'front' | 'back' | 'none',
  ): NpcMesh3DCommand {
    const cmd = this.getOrCreateCommand(this.commandPoolSize++);
    cmd.meshId = part.meshId;
    // A baked part owns immutable buffers, so the meshId alone identifies its geometry. A posed
    // skeletal part reuses one meshId across every frame with different buffers behind it, and
    // marks itself animated so the upload is not skipped as an already-cached mesh.
    cmd.animated = part.animated ?? false;
    cmd.materialId = part.materialId;
    cmd.positions = positions;
    cmd.perVertexHslColors = part.perVertexHslColors;
    cmd.perVertexAlphas = part.perVertexAlphas;
    cmd.perVertexFaceBias = part.perVertexFaceBias;
    cmd.depth = part.depth;
    cmd.blend = part.blend;
    cmd.zIndex = style?.zIndex ?? part.zIndex;
    cmd.depthBias = style?.depthBias ?? part.depthBias;
    // Cached spotanim models use the same backface culling as actors and LOCs. Drawing
    // opaque backfaces can mask bright front surfaces; explicitly two-sided effects may opt out.
    cmd.cullFace = forceCullFace ?? style?.cullFace ?? part.cullFace ?? 'back';
    this.setInstanceAtlas(cmd, part);
    this.fillModelMatrix(cmd.modelMatrix, transform);
    queue.commands.push(cmd);
    return cmd;
  }

  /** `transform` raised by `offset`, in a record reused by every call. */
  private withHeightOffset(transform: SpotAnimTransform, offset: number): SpotAnimTransform {
    const raised = this.offsetTransform;
    raised.position[0] = transform.position[0];
    raised.position[1] = transform.position[1];
    raised.position[2] = transform.position[2] + offset;
    raised.yaw2048 = transform.yaw2048;
    raised.pitchRad = transform.pitchRad;
    raised.scale = transform.scale;
    return raised;
  }

  private insertInstance(instanceId: string, req: SpotAnimSpawnRequest): void {
    const instance: ActiveSpotAnimInstance = {
      instanceId,
      spotAnimId: req.spotAnimId,
      transform: req.transform,
      lifecycle: copyLifecycle(undefined, req.lifecycle),
      heightOffsetMode: 'sequence',
      projectile: false,
      renderCenter: [0, 0],
      hasRenderCenter: false,
    };
    assignRequest(instance, req);
    this.activeInstances.set(instanceId, instance);
    this.addToGroup(instanceId, req.groupId);
  }

  private addToGroup(instanceId: string, groupId: string | undefined): void {
    if (!groupId) return;
    let group = this.groups.get(groupId);
    if (!group) {
      group = new Set();
      this.groups.set(groupId, group);
    }
    group.add(instanceId);
  }

  private removeFromGroups(instanceId: string): void {
    for (const [groupId, ids] of this.groups) {
      if (ids.delete(instanceId) && ids.size === 0) {
        this.groups.delete(groupId);
      }
    }
  }

  private shouldExpire(instance: ActiveSpotAnimInstance, interpolatedTick: number): boolean {
    const lifecycle = instance.lifecycle;
    if (lifecycle.kind === 'manual') {
      return false;
    }
    if (lifecycle.kind === 'persistent') {
      return false;
    }
    if (lifecycle.kind === 'duration') {
      return interpolatedTick >= lifecycle.endTick;
    }
    const duration = lifecycle.durationTicks ?? this.getDefaultDurationTicks(instance.spotAnimId);
    return interpolatedTick >= lifecycle.startTick + duration;
  }

  private getDefaultDurationTicks(spotAnimId: number): number {
    return this.frameLengthsToGameTicks(this.entry(spotAnimId)?.frameLengths ?? []);
  }

  private resolveTransform(source: TransformSource): SpotAnimTransform | null {
    if (source.kind === 'static') {
      return source.value;
    }
    return source.resolve(this.currentTick, this.interpolatedTick, this.terrainHeights);
  }

  private resolveFrameProgress(instance: ActiveSpotAnimInstance, frameLengths: number[]): number {
    const custom = instance.frameProgress;
    if (typeof custom === 'number') {
      return Math.max(0, Math.min(1, custom));
    }
    if (typeof custom === 'function') {
      return Math.max(0, Math.min(1, custom(this.currentTick, this.interpolatedTick)));
    }

    const lifecycle = instance.lifecycle;
    if (lifecycle.kind === 'manual') {
      return 0;
    }

    if (lifecycle.kind === 'persistent') {
      return this.resolvePersistentFrameProgress(lifecycle.startTick, frameLengths, instance.spotAnimId);
    }

    const elapsed = this.interpolatedTick - lifecycle.startTick;
    if (elapsed <= 0) {
      return 0;
    }

    const duration =
      lifecycle.kind === 'duration'
        ? Math.max(lifecycle.endTick - lifecycle.startTick, 0.001)
        : Math.max(lifecycle.durationTicks ?? this.frameLengthsToGameTicks(frameLengths), 0.001);

    return Math.max(0, Math.min(1, elapsed / duration));
  }

  private frameLengthsToGameTicks(frameLengths: number[]): number {
    if (frameLengths.length === 0) {
      return 3;
    }
    let total = 0;
    for (let index = 0; index < frameLengths.length; index++) {
      total += frameLengths[index] as number;
    }
    return total > 0 ? total / 30 : 3;
  }

  private resolvePersistentFrameProgress(startTick: number, frameLengths: number[], spotAnimId: number): number {
    const elapsed = this.interpolatedTick - startTick;
    if (elapsed <= 0) {
      return 0;
    }

    const duration = Math.max(this.frameLengthsToGameTicks(frameLengths), 0.001);
    const frameStep = this.entry(spotAnimId)?.frameStep ?? -1;
    if (frameStep >= 0) {
      const wrapped = ((elapsed % duration) + duration) % duration;
      return Math.max(0, Math.min(1, wrapped / duration));
    }

    return Math.max(0, Math.min(1, elapsed / duration));
  }

  /**
   * Frame index this instance is showing. Shared by the mesh lookup and by `getFrameStates`
   * so a spotanim's frame sound can never fire on a different frame than the one on screen.
   */
  private resolveFrameIndex(cacheEntry: SpotAnimMeshCacheEntry, frameProgress: number): number {
    if (cacheEntry.frames.length <= 1) {
      return 0;
    }
    let totalDuration = 0;
    for (let index = 0; index < cacheEntry.frameLengths.length; index++) {
      totalDuration += cacheEntry.frameLengths[index] as number;
    }
    return getAnimFrameIndex(frameProgress, cacheEntry.frameLengths, totalDuration);
  }

  private resolveMeshParts(cacheEntry: SpotAnimMeshCacheEntry, frameProgress: number): SpotAnimMeshPart[] {
    if (cacheEntry.frames.length === 0) {
      return cacheEntry.static;
    }
    return cacheEntry.frames[this.resolveFrameIndex(cacheEntry, frameProgress)] ?? [];
  }

  private getOrCreateCommand(index: number): NpcMesh3DCommand {
    if (index < this.commandPool.length) {
      return this.commandPool[index];
    }
    const cmd: NpcMesh3DCommand = {
      kind: 'mesh3d',
      meshId: '',
      materialId: 'osrs-npc',
      modelMatrix: new Float32Array(16),
      positions: new Float32Array(0),
      perVertexFaceBias: new Float32Array(0),
      depth: 'readwrite',
    };
    this.commandPool.push(cmd);
    return cmd;
  }

  private getSortedTransparentPart(
    part: SpotAnimMeshPart,
    positions: Float32Array,
    modelMatrix: Float32Array,
    cullFace: 'back' | 'front' | 'none',
    instance: ActiveSpotAnimInstance,
  ): {
    positions: Float32Array;
    hslColors: Float32Array;
    alphas: Float32Array;
    faceBias?: Float32Array;
  } | null {
    if (!this.hasSorterProjection) {
      return null;
    }

    const hslColors = part.perVertexHslColors;
    const alphas = part.perVertexAlphas;
    if (!hslColors || !alphas) {
      return null;
    }

    const meta = part.transparentSort;
    if (!meta) {
      return null;
    }

    const projection = this.buildSorterProjection(modelMatrix[12], modelMatrix[13], modelMatrix[14]);

    const sortInput = this.transformSortModel(meta, positions, modelMatrix);
    const sortedFaces = sortModelFaces(sortInput, projection, cullFace).transparentFaces;

    const faceBias = part.perVertexFaceBias;
    instance.permuteBuffers ??= {
      positions: new Float32Array(positions.length),
      hslColors: new Float32Array(hslColors.length),
      alphas: new Float32Array(alphas.length),
      faceBias: faceBias ? new Float32Array(faceBias.length) : undefined,
    };
    const output = instance.permuteBuffers;
    if (output.positions.length < positions.length) output.positions = new Float32Array(positions.length);
    if (output.hslColors.length < hslColors.length) output.hslColors = new Float32Array(hslColors.length);
    if (output.alphas.length < alphas.length) output.alphas = new Float32Array(alphas.length);
    if (faceBias && (!output.faceBias || output.faceBias.length < faceBias.length)) {
      output.faceBias = new Float32Array(faceBias.length);
    }

    return permuteTransparentTriangles(
      sortedFaces,
      spotAnimTransparentFaceMap(meta),
      positions,
      undefined,
      hslColors,
      alphas,
      faceBias,
      output,
    );
  }

  /**
   * Runs sortTransparentFacesOnly once per unique (meshId, orientation) combo per frame,
   * then returns the cached result for all other instances with the same key.
   * 120 wave instances with 2 yaws × 2 frames = ~4 sort calls instead of 120.
   */
  private isTransparentPartVisible(part: SpotAnimMeshPart, transform: SpotAnimTransform): boolean {
    if (!this.hasSorterProjection) return true;

    const orientation = transform.yaw2048 ?? 0;

    const wx = transform.position[0] * TILE_TO_OSRS;
    const wz = transform.position[1] * TILE_TO_OSRS;

    // Cache by meshId|orientation|coarseRegion. The face-area result mostly depends
    // on orientation. Position matters only at very close range — use a 32-tile
    // (4096 OSRS unit) grid so the entire arena fits in ~2x2 buckets.
    // Use Math.floor instead of >> to handle negative coords correctly.
    const regionX = Math.floor(wx / 4096);
    const regionZ = Math.floor(wz / 4096);
    const pitchRad = transform.pitchRad ?? 0;
    const scale = transform.scale ?? 1;
    if (!part.animated && this.isKnownVisible(part.meshId, orientation, pitchRad, scale, regionX, regionZ)) {
      renderStats.recordVisibilityCacheHit();
      return true;
    }

    renderStats.recordVisibilityCacheMiss();
    const meta = part.transparentSort;
    const positions = part.positions;
    const hslColors = part.perVertexHslColors;
    const alphas = part.perVertexAlphas;
    if (!meta || !positions || !hslColors || !alphas) {
      this.recordVisible(part.meshId, orientation, pitchRad, scale, regionX, regionZ);
      return true;
    }

    const projection = this.buildSorterProjection(transform.position[0], transform.position[1], transform.position[2]);

    this.fillModelMatrix(this.sortModelMatrix, transform);
    const sortInput = this.transformSortModel(meta, positions, this.sortModelMatrix);
    const visible = sortTransparentFacesOnly(meta.triToModelFace, sortInput, projection).length > 0;
    // Only cache 'visible' results. 'Not visible' depends on exact position —
    // caching it would hide instances at other positions that should render.
    if (visible && !part.animated) {
      this.recordVisible(part.meshId, orientation, pitchRad, scale, regionX, regionZ);
    }
    return visible;
  }

  private isKnownVisible(
    meshId: string,
    orientation: number,
    pitchRad: number,
    scale: number,
    regionX: number,
    regionZ: number,
  ): boolean {
    const visible = this.visibleParts.get(meshId);
    if (!visible || visible.frame !== this.renderFrame) return false;
    for (let index = 0; index < visible.count; index++) {
      const key = visible.keys[index] as VisibilityKey;
      if (
        sameKeyNumber(key.orientation, orientation) &&
        sameKeyNumber(key.pitchRad, pitchRad) &&
        sameKeyNumber(key.scale, scale) &&
        sameKeyNumber(key.regionX, regionX) &&
        sameKeyNumber(key.regionZ, regionZ)
      ) {
        return true;
      }
    }
    return false;
  }

  /** Records a visible key this frame; a key already known is recorded again, which changes nothing. */
  private recordVisible(
    meshId: string,
    orientation: number,
    pitchRad: number,
    scale: number,
    regionX: number,
    regionZ: number,
  ): void {
    let visible = this.visibleParts.get(meshId);
    if (!visible) {
      visible = { frame: this.renderFrame, count: 0, keys: [] };
      this.visibleParts.set(meshId, visible);
    } else if (visible.frame !== this.renderFrame) {
      visible.frame = this.renderFrame;
      visible.count = 0;
    }
    let key = visible.keys[visible.count];
    if (!key) {
      key = { orientation: 0, pitchRad: 0, scale: 0, regionX: 0, regionZ: 0 };
      visible.keys.push(key);
    }
    visible.count++;
    key.orientation = orientation;
    key.pitchRad = pitchRad;
    key.scale = scale;
    key.regionX = regionX;
    key.regionZ = regionZ;
  }

  /** The sorter's view of a model at a world position, in a record reused by every call. */
  private buildSorterProjection(worldX: number, worldY: number, worldZ: number): SorterProjection {
    const projection = this.sorterProjection;
    projection.cameraX = this.sorterCameraX;
    projection.cameraY = this.sorterCameraY;
    projection.cameraZ = this.sorterCameraZ;
    projection.yawSin = this.sorterYawSin;
    projection.yawCos = this.sorterYawCos;
    projection.pitchSin = this.sorterPitchSin;
    projection.pitchCos = this.sorterPitchCos;
    projection.modelX = worldX * TILE_TO_OSRS;
    projection.modelY = -worldZ * TILE_TO_OSRS;
    projection.modelZ = worldY * TILE_TO_OSRS;
    return projection;
  }

  /** Projects the part's soup vertices (sort vertex `v` is `positions[3v..3v+2]`) into sorter space. */
  private transformSortModel(
    meta: SpotAnimTransparentSort,
    positions: Float32Array,
    matrix: Float32Array,
  ): FaceSortInput {
    const model = meta.model;
    if (this.sortVerticesX.length < model.verticesCount) {
      this.sortVerticesX = new Float64Array(model.verticesCount);
      this.sortVerticesY = new Float64Array(model.verticesCount);
      this.sortVerticesZ = new Float64Array(model.verticesCount);
    }
    for (let vertex = 0; vertex < model.verticesCount; vertex++) {
      const vertexX = positions[vertex * 3];
      const vertexY = positions[vertex * 3 + 1];
      const vertexZ = positions[vertex * 3 + 2];
      this.sortVerticesX[vertex] = (matrix[0] * vertexX + matrix[4] * vertexY + matrix[8] * vertexZ) * TILE_TO_OSRS;
      this.sortVerticesY[vertex] = -(matrix[2] * vertexX + matrix[6] * vertexY + matrix[10] * vertexZ) * TILE_TO_OSRS;
      this.sortVerticesZ[vertex] = (matrix[1] * vertexX + matrix[5] * vertexY + matrix[9] * vertexZ) * TILE_TO_OSRS;
    }
    const input = this.sortInput;
    input.verticesX = this.sortVerticesX;
    input.verticesY = this.sortVerticesY;
    input.verticesZ = this.sortVerticesZ;
    input.verticesCount = model.verticesCount;
    input.indices1 = model.indices1;
    input.indices2 = model.indices2;
    input.indices3 = model.indices3;
    input.faceCount = model.faceCount;
    input.faceRenderPriorities = model.faceRenderPriorities;
    input.priority = model.priority;
    input.faceAlphas = model.faceAlphas;
    input.faceColors3 = model.faceColors3;
    return input;
  }

  private fillModelMatrix(out: Float32Array, transform: SpotAnimTransform): void {
    const yaw2048 = transform.yaw2048 ?? 0;
    const pitchRad = transform.pitchRad ?? 0;
    const scale = transform.scale ?? 1;
    const s = SCALE * scale;

    const yaw = (yaw2048 / 2048) * 2 * Math.PI;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(pitchRad);
    const sp = Math.sin(pitchRad);

    out[0] = s * cy;
    out[1] = -s * sy;
    out[2] = 0;
    out[3] = 0;

    out[4] = s * sy * sp;
    out[5] = s * cy * sp;
    out[6] = -s * cp;
    out[7] = 0;

    out[8] = s * sy * cp;
    out[9] = s * cy * cp;
    out[10] = s * sp;
    out[11] = 0;

    out[12] = transform.position[0];
    out[13] = transform.position[1];
    out[14] = transform.position[2];
    out[15] = 1;
  }
}

/** Writes a spawn request into an instance, as a fresh spawn of it would hold it. */
function assignRequest(instance: ActiveSpotAnimInstance, req: SpotAnimSpawnRequest): void {
  instance.spotAnimId = req.spotAnimId;
  instance.transform = req.transform;
  instance.lifecycle = copyLifecycle(instance.lifecycle, req.lifecycle);
  instance.style = req.style;
  instance.groupId = req.groupId;
  instance.frameProgress = req.frameProgress;
  instance.heightOffsetMode = req.heightOffsetMode ?? 'sequence';
  instance.projectile = req.projectile === true;
  instance.hasRenderCenter = false;
}
