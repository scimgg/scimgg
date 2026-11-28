import PicoGL, { type App, type Program } from 'picogl';
import type { Texture as PicoTextureHandle } from 'picogl/build/module/texture.js';
import type { TextureLoader } from '../../../rs/texture/TextureLoader';
import { frameProfiler } from '../../../util/FrameProfiler';
import { isUsableWebGL2Context } from '../../../util/gpuDetection';
import { log } from '../../../util/Logger';
import { profiler } from '../../../util/Profiler';
import { renderStats } from '../../../util/RenderStats';
import type { AssetManager, MaterialData, MeshData } from '../../core/assets';
import type { Viewport } from '../../core/camera';
import {
  isResidentMesh3DCommand,
  type Mesh3DCommand,
  type RenderCommand,
  type ResidentMesh3DCommand,
  type ShaderId,
} from '../../core/commands';
import {
  type ImmutableMeshSource,
  instanceAtlasBoundBytes,
  type MeshSourceScope,
  type MeshUploadData,
  RetiredMeshSourceError,
} from '../../core/meshSource';
import { getBackingStoreDimensions } from '../../core/raster';
import {
  type ContextStatusRenderer,
  isSameRenderStatus,
  type Renderer,
  type RendererInitOptions,
  RendererUnsupportedError,
  type RenderFrame,
  type RenderStatus,
} from '../../core/renderer';
import { indexTriangleSoup, SoupIndexingScratch } from '../../core/soupIndexing';
import { classifyMesh3DCommands } from './commandClassifier';
import {
  ATLAS_TEXTURE_UNIT,
  type AtlasRun,
  bindInstances,
  deleteAtlas,
  INSTANCE_FLOATS,
  planAtlasRuns,
  type ResidentAtlas,
  uploadAtlas,
} from './instanceAtlas';
import { TextureArrayManager } from './PicoTexture';
import sceneFragSource from './shaders/scene.frag.glsl';
import sceneBaseVertSource from './shaders/scene-base.vert.glsl';
import sceneEffectsVertSource from './shaders/scene-effects.vert.glsl';

/**
 * Texture-array layers whose scroll animation the vertex shaders can express.
 * Two layers share one `u_textureAnimations` vec4, so this costs 128 uniform
 * vectors. Must stay in sync with TEXTURE_ANIM_MAX_LAYERS / TEXTURE_ANIM_VEC4_COUNT
 * in scene-base.vert.glsl and scene-effects.vert.glsl.
 */
const TEXTURE_ANIM_MAX_LAYERS = 256;
const TEXTURE_ANIM_VEC4_COUNT = TEXTURE_ANIM_MAX_LAYERS / 2;

/**
 * OSRS client tick, in milliseconds. Texture scroll is driven by this clock (not
 * the 600ms game tick) so animated textures keep moving while the simulation is
 * paused, matching the real client.
 */
const CLIENT_TICK_MS = 20;

/**
 * Client cycles after which the scroll offset wraps. The packed anim vectors are
 * whole numbers, so a wrap shifts UVs by an integer - invisible under REPEAT
 * sampling - while keeping the uniform small enough for float precision.
 * Matches RuneLite's `client.getGameCycle() & 127`.
 */
const TEXTURE_ANIM_CYCLE_PERIOD = 128;

const TEXTURE_LAYER_SIZE = 128;
const TEXTURE_BRIGHTNESS = 1.0;

/**
 * How long a lost context may stay lost before the renderer reports failure. The browser
 * may never send `webglcontextrestored` (e.g. after repeated GPU resets), and without a
 * bound the canvas would stay black with nothing telling the user why.
 */
export const CONTEXT_RESTORE_TIMEOUT_MS = 10_000;

const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: false,
  antialias: true,
  depth: true,
  stencil: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
  failIfMajorPerformanceCaveat: false,
};

export { isUsableWebGL2Context };

export interface WebGL2Features {
  webgl2: boolean;
  textureArrays: boolean;
  uniformBuffers: boolean;
  vertexArrayObjects: boolean;
  multiDraw: boolean;
  anisotropicFiltering: boolean;
  maxAnisotropy: number;
  maxTextureSize: number;
  maxTextureArrayLayers: number;
}

export function detectWebGL2Features(gl: WebGL2RenderingContext): WebGL2Features {
  const features: WebGL2Features = {
    webgl2: true,
    textureArrays: true,
    uniformBuffers: true,
    vertexArrayObjects: true,
    multiDraw: false,
    anisotropicFiltering: false,
    maxAnisotropy: 1,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096,
    maxTextureArrayLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) || 256,
  };

  const multiDrawExt = gl.getExtension('WEBGL_multi_draw');
  features.multiDraw = multiDrawExt !== null;

  const anisotropicExt =
    gl.getExtension('EXT_texture_filter_anisotropic') ||
    gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic') ||
    gl.getExtension('MOZ_EXT_texture_filter_anisotropic');

  if (anisotropicExt) {
    features.anisotropicFiltering = true;
    features.maxAnisotropy = gl.getParameter(anisotropicExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1;
  }

  return features;
}

export function isWebGL2Available(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return isUsableWebGL2Context(canvas.getContext('webgl2'));
  } catch {
    return false;
  }
}

class PicoGLAssetManager implements AssetManager {
  private textures = new Map<string, WebGLTexture>();
  private meshes = new Map<
    string,
    {
      vao: WebGLVertexArrayObject;
      vertexBuffer: WebGLBuffer;
      indexBuffer?: WebGLBuffer;
    }
  >();
  private materials = new Map<string, MaterialData>();
  private app: App | null = null;

  setApp(app: App): void {
    this.app = app;
  }

  /**
   * Forgets every GPU handle after a context loss. They died with the context, so they
   * are dropped rather than deleted; `has*` then reports false and callers re-`ensure*`
   * from their own CPU data. Materials are CPU-only and survive.
   */
  releaseContextHandles(): void {
    this.textures.clear();
    this.meshes.clear();
  }

  hasTexture2D(id: string): boolean {
    return this.textures.has(id);
  }

  ensureTexture2D(id: string, source: TexImageSource): void {
    if (this.textures.has(id) || !this.app) return;

    if (source instanceof HTMLImageElement) {
      const texture = this.app.createTexture2D(source, {
        minFilter: PicoGL.LINEAR_MIPMAP_LINEAR,
        magFilter: PicoGL.LINEAR,
        wrapS: PicoGL.REPEAT,
        wrapT: PicoGL.REPEAT,
      });
      if (texture.texture) this.textures.set(id, texture.texture);
    }
  }

  deleteTexture2D(id: string): void {
    const texture = this.textures.get(id);
    if (texture && this.app) {
      this.app.gl.deleteTexture(texture);
      this.textures.delete(id);
    }
  }

  hasMesh(id: string): boolean {
    return this.meshes.has(id);
  }

  ensureMesh(id: string, mesh: MeshData): void {
    if (this.meshes.has(id) || !this.app) return;

    const vertexBuffer = this.app.createVertexBuffer(PicoGL.FLOAT, 3, mesh.positions);
    const vao = this.app.createVertexArray().vertexAttributeBuffer(0, vertexBuffer);
    let indexBufferHandle: WebGLBuffer | undefined;

    if (mesh.indices) {
      const indexBuffer = this.app.createIndexBuffer(
        mesh.indices instanceof Uint16Array ? PicoGL.UNSIGNED_SHORT : PicoGL.UNSIGNED_INT,
        mesh.indices,
      );
      vao.indexBuffer(indexBuffer);
      indexBufferHandle = indexBuffer.buffer;
    }

    this.meshes.set(id, {
      vao: vao.vertexArray,
      vertexBuffer: vertexBuffer.buffer,
      indexBuffer: indexBufferHandle,
    });
  }

  deleteMesh(id: string): void {
    const mesh = this.meshes.get(id);
    if (mesh && this.app) {
      const gl = this.app.gl as WebGL2RenderingContext;
      gl.deleteVertexArray(mesh.vao);
      gl.deleteBuffer(mesh.vertexBuffer);
      if (mesh.indexBuffer) {
        gl.deleteBuffer(mesh.indexBuffer);
      }
      this.meshes.delete(id);
    }
  }

  hasMaterial(id: string): boolean {
    return this.materials.has(id);
  }

  ensureMaterial(id: string, material: MaterialData): void {
    if (!this.materials.has(id)) {
      this.materials.set(id, material);
    }
  }

  deleteMaterial(id: string): void {
    this.materials.delete(id);
  }

  clear(): void {
    for (const id of this.textures.keys()) {
      this.deleteTexture2D(id);
    }
    for (const id of this.meshes.keys()) {
      this.deleteMesh(id);
    }
    this.materials.clear();
  }
}

/** The attribute arrays {@link PicoGLRenderer.createMeshVao} uploads. */
interface MeshVertexArrays {
  positions: Float32Array;
  normals?: Float32Array;
  indices?: Uint16Array | Uint32Array;
  uvs?: Float32Array;
  tileCoords?: Float32Array;
  perVertexTextureIds?: Float32Array;
  perVertexHslColors?: Float32Array;
  perVertexAlphas?: Float32Array;
  perVertexFaceBias?: Float32Array;
}

interface EmbeddedMeshCommand extends Mesh3DCommand, MeshVertexArrays {
  colors?: Float32Array;
  animated?: boolean;
}

/** One uploaded {@link ImmutableMeshSource}: every part's VAO, built and released together. */
interface ResidentSource {
  readonly source: ImmutableMeshSource;
  /** Null for an empty part, which draws nothing. */
  readonly parts: readonly (CachedMeshVao | null)[];
  readonly bytes: number;
  lastUsedFrame: number;
}

/** A source not yet resident: queued to upload ahead of its first draw, or retrying a failed upload. */
interface PendingSource {
  readonly source: ImmutableMeshSource;
  queued: boolean;
  /** Failed attempts so far. */
  attempts: number;
  retryFrame: number;
  /** Arrays `materialize` already handed over, kept so a retry needs no rebuild. */
  arrays: readonly MeshUploadData[] | null;
}

export interface PicoGLRendererOptions {
  /**
   * GPU bytes resident mesh sources may keep before the least recently drawn ones are released
   * at the end of a frame. Sources drawn in the current frame are never released, whatever the
   * budget; a released source is rebuilt from its recipe the next time it is drawn.
   */
  residentSourceBudgetBytes?: number;
}

/**
 * Every source of the current scene is drawn every frame, so the budget only reclaims sources
 * that stopped being drawn (superseded terrain, hidden scenery) without a scene boundary. Four
 * times the largest scene's resident set (Sol Heredit: about 30 MiB of static LOCs and
 * terrain), so no current encounter rebuilds during play; a device policy may lower it.
 */
export const DEFAULT_RESIDENT_SOURCE_BUDGET_BYTES = 128 * 1024 * 1024;

/**
 * Upload-ahead bytes per frame. Once reached, the rest of the queue waits for the next frame;
 * a single larger source still uploads whole. Sol's preloaded effects (about 20 MiB) take five
 * frames, well under the first frame's own upload (its static scenery alone is 27 MiB).
 */
const QUEUED_UPLOAD_BYTES_PER_FRAME = 4 * 1024 * 1024;

/** Longest wait, in frames, between attempts at a resident source that keeps failing. */
const SOURCE_RETRY_MAX_DELAY_FRAMES = 120;
/** Consecutive failed attempts after which a resident source's failure is reported as an error. */
const SOURCE_FAILURE_REPORT_ATTEMPTS = 5;

interface ShaderProgramEntry {
  program: Program;
  uniformLocations: {
    viewProjMatrix: WebGLUniformLocation | null;
    currentTick: WebGLUniformLocation | null;
    brightness: WebGLUniformLocation | null;
    contrast: WebGLUniformLocation | null;
    saturation: WebGLUniformLocation | null;
    colorBanding: WebGLUniformLocation | null;
    hasTextures: WebGLUniformLocation | null;
    textures: WebGLUniformLocation | null;
    discardAlpha: WebGLUniformLocation | null;
    zBias: WebGLUniformLocation | null;
    priorityStepNdc: WebGLUniformLocation | null;
    animParams: WebGLUniformLocation | null;
    textureAnimations: WebGLUniformLocation | null;
    textureAnimTime: WebGLUniformLocation | null;
    instanceAtlas: WebGLUniformLocation | null;
  };
}

/** scene-base with `INSTANCED_ATLAS` defined; see scene-base.vert.glsl and `instanceAtlas.ts`. */
function instancedSceneBaseSource(source: string): string {
  const defined = source.replace(/^(#version[^\n]*\n)/, '$1#define INSTANCED_ATLAS\n');
  if (defined === source) throw new Error('scene-base has no #version line to define INSTANCED_ATLAS after');
  return defined;
}

/** One GL buffer of a cached VAO: what it holds and how much storage it has. */
interface MeshBufferSlot {
  readonly attribute: keyof MeshVertexArrays;
  readonly buffer: WebGLBuffer;
  readonly target: number;
  readonly usage: number;
  /** Allocated bytes; at least the bytes last uploaded, more after a grow-only reallocation. */
  capacityBytes: number;
  /**
   * An animated mesh's copy of everything the buffer holds, over its whole storage, so a rewrite
   * whose values the buffer already starts with is skipped: the buffer would end up the same.
   */
  contents?: VertexData;
}

type VertexData = Float32Array | Uint16Array | Uint32Array;

/**
 * Whether `contents` starts with exactly `data`'s values. Zero is told apart from negative zero,
 * so equal means equal bytes; a NaN never matches, which only costs an upload.
 */
function startsWith(contents: VertexData, data: VertexData): boolean {
  const length = data.length;
  if (length > contents.length) return false;
  for (let index = 0; index < length; index++) {
    const value = data[index];
    const held = contents[index];
    if (value !== held || (value === 0 && 1 / value !== 1 / held)) return false;
  }
  return true;
}

function emptyLike(data: VertexData, length: number): VertexData {
  return data instanceof Float32Array
    ? new Float32Array(length)
    : data instanceof Uint16Array
      ? new Uint16Array(length)
      : new Uint32Array(length);
}

interface CachedMeshVao {
  vao: WebGLVertexArrayObject;
  /** Every buffer of the VAO, in creation order, with its storage. */
  slots: MeshBufferSlot[];
  posBuffer?: WebGLBuffer;
  normBuffer?: WebGLBuffer;
  hslColorBuffer?: WebGLBuffer;
  alphaBuffer?: WebGLBuffer;
  faceBiasBuffer?: WebGLBuffer;
  uvBuffer?: WebGLBuffer;
  textureIdBuffer?: WebGLBuffer;
  tileCoordBuffer?: WebGLBuffer;
  indexBuffer?: WebGLBuffer;
  /** Vertices drawn; the buffers may hold room for more, never drawn. */
  vertexCount: number;
  indexCount?: number;
  indexType?: number;
  /** Allocated bytes across `slots`. */
  bytes: number;
  lastUsedFrame: number;
}

type SortedMeshPassEntry = {
  vao: WebGLVertexArrayObject;
  indexCount?: number;
  indexType?: number;
  vertexCount: number;
  mvp: Float32Array;
};

function hasEmbeddedMesh(cmd: Mesh3DCommand): cmd is EmbeddedMeshCommand {
  return 'positions' in cmd && (cmd as EmbeddedMeshCommand).positions instanceof Float32Array;
}

/**
 * Whether each program's vertex shader reads `a_normal`. Lighting is baked into the HSL colors,
 * so scene-base has no normal input; only scene-effects reads normals, as procedural seeds.
 * PicoGLRenderer.test.ts checks this table against the shader sources.
 */
const PROGRAM_READS_NORMALS: Readonly<Record<ShaderId, boolean>> = {
  'scene-base': false,
  'scene-effects': true,
};

/** Normals get a GPU buffer only when the command's program reads them. */
function uploadsNormals(cmd: EmbeddedMeshCommand): boolean {
  return cmd.normals !== undefined && PROGRAM_READS_NORMALS[cmd.shaderId ?? 'scene-base'];
}

/**
 * A static mesh whose alphas are all exactly 1 draws from the constant `a_alpha` of 1.0 that a
 * disabled attribute array reads, so it needs no alpha buffer. Animated meshes keep theirs: their
 * alphas may change between draws, and the layout check would otherwise rebuild the VAO.
 */
function uploadsAlphas(mesh: MeshVertexArrays, animated: boolean): boolean {
  const alphas = mesh.perVertexAlphas;
  if (alphas === undefined) return false;
  if (animated) return true;
  for (let i = 0; i < alphas.length; i++) {
    if (alphas[i] !== 1) return true;
  }
  return false;
}

/**
 * Likewise a static mesh whose face bias is all +0 draws from the constant `a_faceBias` of 0.0, so it
 * needs no face-bias buffer. Only bitwise +0 counts: a -0 is a different shader input and keeps its
 * buffer. Animated meshes keep theirs, as with alphas.
 */
function uploadsFaceBias(mesh: MeshVertexArrays, animated: boolean): boolean {
  const faceBias = mesh.perVertexFaceBias;
  if (faceBias === undefined) return false;
  if (animated) return true;
  for (let i = 0; i < faceBias.length; i++) {
    const value = faceBias[i];
    if (value !== 0 || 1 / value < 0) return true;
  }
  return false;
}

/**
 * An immutable soup as an indexed mesh when that takes fewer bytes, else the soup itself. Distinct
 * vertices are compared over exactly the attributes `createMeshVao` uploads for it, so every draw
 * reads what the soup gave it, in the same order; see {@link indexTriangleSoup}. Animated meshes are
 * rewritten in place and stay soups. A mesh that arrives indexed (terrain, merged static LOCs, which
 * the finalizer builds indexed by the same rule) is uploaded as it is. The indexed arrays are views
 * into `scratch`: upload them before indexing the next mesh.
 */
function indexedSoup(mesh: MeshVertexArrays, normals: boolean, scratch: SoupIndexingScratch): MeshVertexArrays {
  if (mesh.indices) return mesh;
  const uploaded: [keyof MeshVertexArrays, Float32Array | undefined, number][] = [
    ['positions', mesh.positions, 3],
    ['normals', normals ? mesh.normals : undefined, 3],
    ['uvs', mesh.uvs, 2],
    ['perVertexTextureIds', mesh.perVertexTextureIds, 1],
    ['perVertexHslColors', mesh.perVertexHslColors, 1],
    ['tileCoords', mesh.tileCoords, 2],
    ['perVertexAlphas', uploadsAlphas(mesh, false) ? mesh.perVertexAlphas : undefined, 1],
    ['perVertexFaceBias', uploadsFaceBias(mesh, false) ? mesh.perVertexFaceBias : undefined, 1],
  ];
  const present = uploaded.filter((entry): entry is [keyof MeshVertexArrays, Float32Array, number] => !!entry[1]);
  const indexed = indexTriangleSoup(
    present.map(([, data, size]) => ({ data, size })),
    mesh.positions.length / 3,
    scratch,
  );
  if (!indexed) return mesh;
  // Attributes that are not uploaded are left out: they would only be read to decide not to upload them.
  const result: MeshVertexArrays = { positions: mesh.positions, indices: indexed.indices };
  for (const [index, [attribute]] of present.entries()) {
    (result as unknown as Record<string, Float32Array>)[attribute] = indexed.attributes[index] as Float32Array;
  }
  return result;
}

/** The cached VAO has exactly the optional attribute buffers the animated upload path updates. */
function matchesAttributeLayout(cached: CachedMeshVao, cmd: EmbeddedMeshCommand): boolean {
  return (
    (cached.normBuffer !== undefined) === uploadsNormals(cmd) &&
    (cached.hslColorBuffer !== undefined) === (cmd.perVertexHslColors !== undefined) &&
    (cached.alphaBuffer !== undefined) === uploadsAlphas(cmd, cmd.animated === true) &&
    (cached.faceBiasBuffer !== undefined) === uploadsFaceBias(cmd, cmd.animated === true) &&
    (cached.uvBuffer !== undefined) === (cmd.uvs !== undefined) &&
    (cached.textureIdBuffer !== undefined) === (cmd.perVertexTextureIds !== undefined)
  );
}

function indexTypeOf(gl: WebGL2RenderingContext, indices: Uint16Array | Uint32Array): number {
  return indices instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
}

/**
 * Beyond {@link matchesAttributeLayout}, what a resize rewrites in place: the index buffer
 * (present, and of the same type) and tile coordinates. A mismatch rebuilds the VAO instead.
 */
function matchesResizeLayout(cached: CachedMeshVao, cmd: EmbeddedMeshCommand, indexType: number | undefined): boolean {
  return (
    (cached.tileCoordBuffer !== undefined) === (cmd.tileCoords !== undefined) &&
    (cached.indexBuffer !== undefined) === (cmd.indices !== undefined) &&
    cached.indexType === indexType
  );
}

/**
 * Storage for a buffer that outgrew its capacity: half again as much, or the need if larger.
 * Geometric growth bounds a mesh to a few reallocations however its vertex count wanders, and
 * x1.5 (rather than x2) caps the unused tail at half the largest pose; a mesh whose count never
 * grows keeps exactly the storage it was created with. 4-byte aligned for float and index data.
 */
function grownCapacityBytes(capacityBytes: number, neededBytes: number): number {
  return Math.max(neededBytes, Math.ceil((capacityBytes * 1.5) / 4) * 4);
}

/**
 * What one renderer's instancing atlases may hold on the GPU together, as texture and index data
 * (driver, program and VAO overhead is not counted). An atlas is admitted by its upper bound before
 * it is built and by its actual size before anything is allocated for it; one that does not fit
 * draws singly. An engineering guardrail, not a measured device budget.
 */
const ATLAS_BUDGET_BYTES = 1024 * 1024;
/** The most one frame's instance stream may take; a frame that needs more draws every command singly. */
const MAX_INSTANCE_STREAM_BYTES = 64 * 1024;

const STATUS_OK: RenderStatus = { kind: 'ok' };

export class PicoGLRenderer implements ContextStatusRenderer {
  readonly id = 'picogl';
  readonly assets: AssetManager;

  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private app: App | null = null;
  private viewport: Viewport = { width: 800, height: 600, dpr: 1 };
  private features: WebGL2Features | null = null;
  private programs = new Map<ShaderId, ShaderProgramEntry>();
  private assetManager: PicoGLAssetManager;
  private contextStatus: RenderStatus = STATUS_OK;
  private readonly contextStatusListeners = new Set<(status: RenderStatus) => void>();
  private restoreTimeout: ReturnType<typeof setTimeout> | null = null;
  private restoreVisibilityHandler: (() => void) | null = null;
  private contextLostHandler: ((event: Event) => void) | null = null;
  private contextRestoredHandler: ((event: Event) => void) | null = null;

  private meshVaoCache = new Map<string, CachedMeshVao>();
  private frameCounter = 0;
  private readonly CACHE_EVICTION_INTERVAL = 60;
  private readonly CACHE_MAX_STALE_FRAMES = 120;
  /**
   * Immutable sources by id: uploaded, or pending (queued or retrying). An id holds at most one
   * source across both maps; see {@link claimId}. Exempt from the stale-frame eviction above.
   */
  private residentSources = new Map<string, ResidentSource>();
  private pendingSources = new Map<string, PendingSource>();
  private residentSourceBytes = 0;
  private readonly residentSourceBudgetBytes: number;

  private textureArrayManager: TextureArrayManager | null = null;
  private textureArray: PicoTextureHandle | null = null;
  private hasTextures = false;
  private textureAnimations = new Float32Array(TEXTURE_ANIM_VEC4_COUNT * 4);
  private textureAnimTimeCycles = 0;
  private viewProjMatrix: Float32Array;
  private mvpMatrix: Float32Array;
  private opaqueCommands: Mesh3DCommand[];
  private sortedCommands: Mesh3DCommand[];
  private transparentCommands: Mesh3DCommand[];
  private noDepthCommands: Mesh3DCommand[];
  private sortedVaos: SortedMeshPassEntry[];
  private sortedMvpPool: Float32Array[];
  private sortedMvpPoolSize = 0;
  /**
   * The VAO binding and depth mask this renderer last set, so a draw asking for the value already
   * set issues no call. `undefined` is unknown: the next request always reaches GL. Trusted only
   * within one {@link renderCommands}, whose every GL call is this renderer's own; it is forgotten
   * at both ends of the frame, which also leaves no VAO bound, as before, for PicoGL and the uploads
   * outside it. Every VAO bind and depth mask in the draw loop goes through these.
   */
  private boundVao: WebGLVertexArrayObject | null | undefined = undefined;
  /**
   * Instancing atlases by source id (`Mesh3DCommand.instanceAtlas`): uploaded, or null when one
   * cannot be (its commands then always draw singly). Released with their sources; see `releaseSources`.
   */
  private atlases = new Map<string, { readonly source: ImmutableMeshSource; readonly atlas: ResidentAtlas | null }>();
  /** Atlases `prepareResidentSources` was handed, still to upload at the start of a frame. */
  private readonly queuedAtlases = new Set<ImmutableMeshSource>();
  /** The instanced scene-base program: built with the first atlas, or on the first frame with a run; null if it failed. */
  private instancedProgram: ShaderProgramEntry | null | undefined = undefined;
  /** One frame's instance attributes, uploaded once per frame with runs; grown, never shrunk. */
  private instanceBuffer: WebGLBuffer | null = null;
  private instanceCapacityBytes = 0;
  /** Whether an instance buffer allocation has failed: warned about once, not every frame it recurs. */
  private instanceAllocationFailed = false;
  /** Whether a frame has needed more than {@link MAX_INSTANCE_STREAM_BYTES}: warned about once. */
  private instanceStreamCapped = false;
  private instanceStaging = new Float32Array(0);
  private readonly opaqueRuns: AtlasRun[] = [];
  private readonly transparentRuns: AtlasRun[] = [];
  /** Working memory for indexing static soups at upload: bounded by the largest, reused by each. */
  private readonly indexingScratch = new SoupIndexingScratch();
  private depthMaskState: boolean | undefined = undefined;

  constructor(options: PicoGLRendererOptions = {}) {
    this.residentSourceBudgetBytes = options.residentSourceBudgetBytes ?? DEFAULT_RESIDENT_SOURCE_BUDGET_BYTES;
    this.assetManager = new PicoGLAssetManager();
    this.assets = this.assetManager;
    this.viewProjMatrix = new Float32Array(16);
    this.mvpMatrix = new Float32Array(16);
    this.opaqueCommands = [];
    this.sortedCommands = [];
    this.transparentCommands = [];
    this.noDepthCommands = [];
    this.sortedVaos = [];
    this.sortedMvpPool = [];
  }

  supports(kind: '2d' | '3d'): boolean {
    return kind === '2d' || kind === '3d';
  }

  getFeatures(): WebGL2Features | null {
    return this.features;
  }

  getViewport(): Viewport {
    return this.viewport;
  }

  private contextAttributes: WebGLContextAttributes = CONTEXT_ATTRIBUTES;

  init(canvas: HTMLCanvasElement, options?: RendererInitOptions): void {
    profiler.start('PicoGLRenderer.init');

    profiler.start('PicoGLRenderer.getContext');
    this.contextAttributes =
      options?.antialias === undefined ? CONTEXT_ATTRIBUTES : { ...CONTEXT_ATTRIBUTES, antialias: options.antialias };
    const gl = canvas.getContext('webgl2', this.contextAttributes);
    profiler.end('PicoGLRenderer.getContext');
    if (!isUsableWebGL2Context(gl)) {
      profiler.end('PicoGLRenderer.init');
      throw new RendererUnsupportedError(
        gl ? 'PicoGLRenderer: WebGL2 not supported (unusable context)' : 'PicoGLRenderer: WebGL2 not supported',
      );
    }

    this.canvas = canvas;
    this.gl = gl;
    this.features = detectWebGL2Features(gl);
    this.app = PicoGL.createApp(canvas, this.contextAttributes);
    this.assetManager.setApp(this.app);

    this.configureGLState();
    // Before compiling, not after: a context that is already lost by the time
    // we compile makes createShader return null, and without the restore listener
    // installed the session never recovers — it renders with an empty program map
    // for the rest of its life.
    this.setupContextLossHandlers();
    try {
      this.buildPrograms(this.app, gl);
    } catch (error) {
      // A lost context makes createShader return null, and picogl then throws from
      // shaderSource with a type error naming WebGLShader — nothing about the real
      // cause. That case waits for the restore, which recompiles; a scene-base failure
      // otherwise leaves nothing to draw with and must not be a silently black canvas.
      if (!gl.isContextLost()) {
        this.dispose();
        profiler.end('PicoGLRenderer.init');
        throw error;
      }
      log.warn('Renderer', 'Shader compilation skipped - WebGL context lost');
    }
    // The lost event may already have been dispatched before the listener existed, in
    // which case it never arrives; entering the lost state here still bounds the wait.
    if (gl.isContextLost()) this.handleContextLost();
    profiler.end('PicoGLRenderer.init');
  }

  getContextStatus(): RenderStatus {
    return this.contextStatus;
  }

  subscribeContextStatus(listener: (status: RenderStatus) => void): () => void {
    this.contextStatusListeners.add(listener);
    return () => {
      this.contextStatusListeners.delete(listener);
    };
  }

  private setContextStatus(status: RenderStatus): void {
    if (isSameRenderStatus(this.contextStatus, status)) return;
    this.contextStatus = status;
    for (const listener of [...this.contextStatusListeners]) listener(status);
  }

  private setupContextLossHandlers(): void {
    if (!this.canvas) return;

    this.contextLostHandler = (event: Event) => {
      event.preventDefault(); // Required to allow context restoration
      this.handleContextLost();
    };

    this.contextRestoredHandler = () => {
      this.handleContextRestored();
    };

    this.canvas.addEventListener('webglcontextlost', this.contextLostHandler);
    this.canvas.addEventListener('webglcontextrestored', this.contextRestoredHandler);
  }

  private handleContextLost(): void {
    if (this.contextStatus.kind === 'lost') return;
    this.releaseContextResources();
    this.setContextStatus({ kind: 'lost' });
    this.startRestoreWait();
    log.warn('Renderer', 'WebGL context lost - pausing rendering');
  }

  /**
   * Drops every handle owned by the lost context. They are invalid in the restored
   * one, and reusing them draws nothing; each cache rebuilds from CPU-side data — mesh
   * VAOs from the next frame's embedded command data, resident sources from their
   * recipes, the texture array from the retained {@link TextureArrayManager}, programs
   * from source.
   */
  private releaseContextResources(): void {
    this.forgetDrawState();
    this.meshVaoCache.clear();
    // Their handles died with the context; a restored one uploads them again on first use.
    this.atlases.clear();
    this.instancedProgram = undefined;
    this.instanceBuffer = null;
    this.instanceCapacityBytes = 0;
    this.residentSources.clear();
    this.residentSourceBytes = 0;
    // A restored context starts every pending source afresh; its arrays are still good.
    for (const pending of this.pendingSources.values()) {
      pending.attempts = 0;
      pending.retryFrame = 0;
    }
    this.sortedVaos.length = 0;
    this.assetManager.releaseContextHandles();
    this.programs.clear();
    this.textureArray = null;
    this.hasTextures = false;
  }

  /**
   * Gives the browser one full {@link CONTEXT_RESTORE_TIMEOUT_MS} of uninterrupted
   * visibility to restore the context. A hidden page may legitimately sit on a lost
   * context (mobile Safari drops GPU state on backgrounding), so hiding cancels the
   * timer and showing the page again starts a fresh one.
   */
  private startRestoreWait(): void {
    this.stopRestoreWait();
    this.restoreVisibilityHandler = () => {
      if (document.visibilityState === 'hidden') this.clearRestoreTimeout();
      else this.armRestoreTimeout();
    };
    document.addEventListener('visibilitychange', this.restoreVisibilityHandler);
    if (document.visibilityState !== 'hidden') this.armRestoreTimeout();
  }

  private stopRestoreWait(): void {
    this.clearRestoreTimeout();
    if (this.restoreVisibilityHandler) {
      document.removeEventListener('visibilitychange', this.restoreVisibilityHandler);
      this.restoreVisibilityHandler = null;
    }
  }

  private armRestoreTimeout(): void {
    this.clearRestoreTimeout();
    this.restoreTimeout = setTimeout(() => {
      this.restoreTimeout = null;
      this.stopRestoreWait();
      this.setContextStatus({ kind: 'failed', reason: 'context-timeout' });
      log.error('Renderer', `WebGL context not restored within ${CONTEXT_RESTORE_TIMEOUT_MS}ms`);
    }, CONTEXT_RESTORE_TIMEOUT_MS);
  }

  private clearRestoreTimeout(): void {
    if (this.restoreTimeout === null) return;
    clearTimeout(this.restoreTimeout);
    this.restoreTimeout = null;
  }

  private handleContextRestored(): void {
    if (!this.canvas) {
      log.error('Renderer', 'Cannot restore context - canvas is null');
      return;
    }
    log.info('Renderer', 'WebGL context restored - reinitializing');
    this.stopRestoreWait();
    this.setContextStatus({ kind: 'restoring' });

    try {
      const gl = this.canvas.getContext('webgl2', this.contextAttributes);
      if (!isUsableWebGL2Context(gl)) {
        throw new Error('Failed to restore WebGL2 context');
      }
      this.gl = gl;
      this.forgetDrawState();
      this.features = detectWebGL2Features(gl);
      // A new App, not the old one: its tracked state (bound program, VAO, texture
      // units) describes the lost context and would skip binds the new one needs.
      this.app = PicoGL.createApp(this.canvas, this.contextAttributes);
      this.assetManager.setApp(this.app);

      this.configureGLState();
      this.buildPrograms(this.app, gl);
      if (this.textureArrayManager) {
        try {
          this.textureArray = this.textureArrayManager.reupload(this.app, TEXTURE_LAYER_SIZE, TEXTURE_BRIGHTNESS);
        } catch (error) {
          if (gl.isContextLost()) throw error;
          // Untextured drawing beats none, as on a failed first load.
          log.error('Renderer', 'Texture re-upload failed - drawing untextured', error);
          this.textureArray = null;
        }
        this.hasTextures = this.textureArray !== null;
      }

      // Texture uploads can lose the context without throwing. Only a live rebuild completes recovery.
      if (gl.isContextLost()) throw new Error('WebGL context lost during restoration');
      this.setContextStatus(STATUS_OK);
      log.info('Renderer', 'Context restoration complete');
    } catch (error) {
      const lostAgain = this.gl?.isContextLost() === true;
      // On a live context the programs built so far are real GPU objects; on a lost
      // one they died with it and are only forgotten.
      if (!lostAgain) {
        for (const entry of this.programs.values()) entry.program.delete();
      }
      this.releaseContextResources();
      if (lostAgain) {
        // Lost again mid-restore; the browser sends another restored event to retry.
        this.setContextStatus({ kind: 'lost' });
        this.startRestoreWait();
        log.warn('Renderer', 'WebGL context lost again during restoration');
        return;
      }
      this.setContextStatus({ kind: 'failed', reason: 'context-restore' });
      log.error('Renderer', 'Failed to restore context', error);
    }
  }

  private configureGLState(): void {
    if (!this.app) return;
    const gl = this.app.gl as WebGL2RenderingContext;
    gl.clearDepth(0);
    this.app.enable(PicoGL.DEPTH_TEST);
    this.app.depthFunc(PicoGL.GREATER);
    // OSRS backface-culls every model face by default (RuneLite GpuPlugin
    // glEnable(GL_CULL_FACE); default GL_BACK / GL_CCW). Backface culling is the
    // default render state here; double-sided geometry opts out per draw via
    // cullFace: 'none' (see renderCommands + Mesh3DCommand.cullFace).
    this.app.enable(PicoGL.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    this.app.disable(PicoGL.BLEND);
    this.app.clearColor(0, 0, 0, 1);
  }

  /**
   * Compiles each scene program on its own. Draws whose program is missing fall back
   * to scene-base (see bindProgram), so only a scene-base failure, or a context lost
   * mid-compile, throws; any other failure is reported and skipped.
   */
  private createProgramEntry(
    app: App,
    gl: WebGL2RenderingContext,
    vertSource: string,
    instanced = false,
  ): ShaderProgramEntry {
    const picoProgram = app.createProgram(vertSource, sceneFragSource);
    if (!picoProgram.linked) {
      picoProgram.delete();
      throw new Error('Shader program failed to link');
    }
    const webglProgram = picoProgram.program;
    return {
      program: picoProgram,
      uniformLocations: {
        viewProjMatrix: gl.getUniformLocation(webglProgram, 'u_viewProjMatrix'),
        currentTick: gl.getUniformLocation(webglProgram, 'u_currentTick'),
        brightness: gl.getUniformLocation(webglProgram, 'u_brightness'),
        contrast: gl.getUniformLocation(webglProgram, 'u_contrast'),
        saturation: gl.getUniformLocation(webglProgram, 'u_saturation'),
        colorBanding: gl.getUniformLocation(webglProgram, 'u_colorBanding'),
        hasTextures: gl.getUniformLocation(webglProgram, 'u_hasTextures'),
        textures: gl.getUniformLocation(webglProgram, 'u_textures'),
        discardAlpha: gl.getUniformLocation(webglProgram, 'u_discardAlpha'),
        zBias: gl.getUniformLocation(webglProgram, 'u_zBias'),
        priorityStepNdc: gl.getUniformLocation(webglProgram, 'u_priorityStepNdc'),
        animParams: gl.getUniformLocation(webglProgram, 'u_animParams'),
        textureAnimations: gl.getUniformLocation(webglProgram, 'u_textureAnimations[0]'),
        textureAnimTime: gl.getUniformLocation(webglProgram, 'u_textureAnimTime'),
        instanceAtlas: instanced ? gl.getUniformLocation(webglProgram, 'u_instanceAtlas') : null,
      },
    };
  }

  /**
   * The instanced scene-base program, compiled the first time a frame has an atlas run, so a frame
   * without one never pays for it. Null, for good, when it fails: every command then draws singly.
   */
  private instancedProgramEntry(): ShaderProgramEntry | null {
    if (this.instancedProgram !== undefined) return this.instancedProgram;
    const { app, gl } = this;
    if (!app || !gl) return null;
    try {
      const entry = this.createProgramEntry(app, gl, instancedSceneBaseSource(sceneBaseVertSource), true);
      const bindWebGLProgram = gl.useProgram.bind(gl);
      bindWebGLProgram(entry.program.program);
      if (entry.uniformLocations.instanceAtlas) gl.uniform1i(entry.uniformLocations.instanceAtlas, ATLAS_TEXTURE_UNIT);
      if (entry.uniformLocations.textureAnimations)
        gl.uniform4fv(entry.uniformLocations.textureAnimations, this.textureAnimations);
      bindWebGLProgram(null);
      this.instancedProgram = entry;
    } catch (error) {
      if (!gl.isContextLost()) log.error('Renderer', 'Instanced scene-base program failed - drawing singly', error);
      this.instancedProgram = gl.isContextLost() ? undefined : null;
    }
    return this.instancedProgram ?? null;
  }

  private buildPrograms(app: App, gl: WebGL2RenderingContext): void {
    profiler.start('PicoGLRenderer.compileShaders');
    try {
      for (const entry of this.programs.values()) {
        entry.program.delete();
      }
      this.programs.clear();
      this.instancedProgram?.program.delete();
      this.instancedProgram = undefined;

      const sources = [
        ['scene-base', sceneBaseVertSource],
        ['scene-effects', sceneEffectsVertSource],
      ] as const;
      for (const [shaderId, vertSource] of sources) {
        try {
          this.programs.set(shaderId, this.createProgramEntry(app, gl, vertSource));
        } catch (error) {
          if (shaderId === 'scene-base' || gl.isContextLost()) throw error;
          log.error('Renderer', `Shader program ${shaderId} failed - falling back to scene-base`, error);
        }
      }
      this.uploadTextureAnimations();
    } finally {
      profiler.end('PicoGLRenderer.compileShaders');
    }
  }

  resize(newViewport: Viewport): void {
    this.viewport = newViewport;

    if (!this.canvas || !this.app || !this.gl) return;

    const { width, height } = getBackingStoreDimensions(newViewport);

    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.canvas.style.width = `${newViewport.width}px`;
    this.canvas.style.height = `${newViewport.height}px`;

    this.app.viewport(0, 0, width, height);
  }

  loadTextures(textureLoader: TextureLoader): void {
    profiler.start('PicoGLRenderer.loadTextures');
    if (!this.app) {
      log.warn('Renderer', 'Cannot load textures - renderer not initialized');
      profiler.end('PicoGLRenderer.loadTextures');
      return;
    }

    if (this.textureArrayManager) {
      this.textureArrayManager.dispose();
      this.textureArrayManager = null;
    }
    this.textureArray = null;
    this.hasTextures = false;
    this.textureAnimations.fill(0);

    try {
      this.textureArrayManager = new TextureArrayManager(textureLoader);
      const textureIds = textureLoader.getTextureIds();

      if (textureIds.length === 0) {
        log.warn('Renderer', 'No textures to load');
        profiler.end('PicoGLRenderer.loadTextures');
        return;
      }

      log.info('Renderer', `Loading ${textureIds.length} textures...`);
      profiler.start('PicoGLRenderer.textureArrayManager.loadTextures');
      this.textureArray = this.textureArrayManager.loadTextures(
        this.app,
        textureIds,
        TEXTURE_LAYER_SIZE,
        TEXTURE_BRIGHTNESS,
      );
      profiler.end('PicoGLRenderer.textureArrayManager.loadTextures');
      this.hasTextures = true;
      this.buildTextureAnimations(textureLoader, textureIds);
      log.info('Renderer', `Loaded ${textureIds.length} textures successfully`);
      profiler.end('PicoGLRenderer.loadTextures');
    } catch (error) {
      profiler.end('PicoGLRenderer.loadTextures');
      log.error('Renderer', 'Failed to load textures', error);
      if (this.textureArrayManager) {
        this.textureArrayManager.dispose();
        this.textureArrayManager = null;
      }
      this.textureArray = null;
      this.hasTextures = false;
    }
  }

  /**
   * Cache each texture-array layer's per-cycle UV scroll and push it to every
   * program. Layers mirror {@link TextureArrayManager.loadTextures}: layer 0 is
   * the white placeholder, so texture `textureIds[i]` lives at layer `i + 1`.
   */
  private buildTextureAnimations(textureLoader: TextureLoader, textureIds: number[]): void {
    this.textureAnimations.fill(0);

    const layerCount = Math.min(textureIds.length, TEXTURE_ANIM_MAX_LAYERS - 1);
    if (textureIds.length > layerCount) {
      log.warn(
        'Renderer',
        `Texture animation limit exceeded: ${textureIds.length} textures > ${layerCount} animatable layers`,
      );
    }

    for (let i = 0; i < layerCount; i++) {
      const [animU, animV] = textureLoader.getAnimationUv(textureIds[i]);
      if (animU === 0 && animV === 0) continue;
      const layer = i + 1;
      const offset = (layer >> 1) * 4 + (layer & 1) * 2;
      this.textureAnimations[offset] = animU;
      this.textureAnimations[offset + 1] = animV;
    }

    this.uploadTextureAnimations();
  }

  private uploadTextureAnimations(): void {
    const gl = this.gl;
    if (!gl) return;

    // Bound rather than called directly so the linter's react-hooks rule does not
    // mistake `gl.useProgram` for a conditionally called hook, matching bindProgram.
    const bindWebGLProgram = gl.useProgram.bind(gl);
    for (const entry of [...this.programs.values(), ...(this.instancedProgram ? [this.instancedProgram] : [])]) {
      const location = entry.uniformLocations.textureAnimations;
      if (!location) continue;
      bindWebGLProgram(entry.program.program);
      gl.uniform4fv(location, this.textureAnimations);
    }
    bindWebGLProgram(null);
  }

  getTextureArrayManager(): TextureArrayManager | null {
    return this.textureArrayManager;
  }

  private evictStaleCacheEntries(): void {
    if (!this.gl || this.frameCounter % this.CACHE_EVICTION_INTERVAL !== 0) return;

    const threshold = this.frameCounter - this.CACHE_MAX_STALE_FRAMES;
    const keysToDelete: string[] = [];

    for (const [key, cached] of this.meshVaoCache) {
      if (cached.lastUsedFrame < threshold) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.deleteCachedMeshVao(key, this.meshVaoCache.get(key)!);
    }
  }

  private deleteCachedMeshVao(meshId: string, cached: CachedMeshVao): void {
    this.deleteVaoHandles(cached);
    this.meshVaoCache.delete(meshId);
  }

  private deleteVaoHandles(cached: CachedMeshVao): void {
    if (!this.gl) return;
    for (const slot of cached.slots) {
      this.gl.deleteBuffer(slot.buffer);
    }
    this.gl.deleteVertexArray(cached.vao);
    // Deleting the bound VAO reverts the binding to none.
    if (this.boundVao === cached.vao) this.boundVao = null;
  }

  /**
   * Uploads every part of a source, all or nothing: residency is published only once every nonempty
   * part has its VAO and GL reports no error, so an allocation that failed (`OUT_OF_MEMORY` from
   * `bufferData`) is caught too. A failure deletes what was created and keeps the arrays for a retry
   * (see {@link recordFailure}). Once uploaded, the arrays are dropped.
   */
  private uploadResidentSource(source: ImmutableMeshSource): ResidentSource | null {
    const gl = this.gl;
    if (!gl) return null;
    const pending = this.pendingSources.get(source.id);
    if (pending && pending.attempts > 0 && this.frameCounter < pending.retryFrame) return null;
    let arrays = pending?.arrays ?? null;
    if (!arrays) {
      try {
        arrays = source.materialize();
      } catch (error) {
        if (error instanceof RetiredMeshSourceError) this.forgetSource(source);
        else this.recordFailure(source, null, error);
        return null;
      }
    }
    // Error flags raised before this upload are not its failure; each read clears one.
    for (let flags = 0; flags < 8 && gl.getError(); flags++);
    const parts: (CachedMeshVao | null)[] = [];
    let bytes = 0;
    let failure: Error | null = null;
    for (const part of arrays) {
      if (part.positions.length === 0) {
        parts.push(null);
        continue;
      }
      const cached = this.createMeshVao(part, false, false);
      if (!cached) {
        failure = new Error(`GPU upload of mesh source ${source.id} failed`);
        break;
      }
      parts.push(cached);
      bytes += cached.bytes;
    }
    const glError = gl.getError();
    if (glError && !failure)
      failure = new Error(`GPU upload of mesh source ${source.id} failed: GL error 0x${glError.toString(16)}`);
    if (failure) {
      for (const created of parts) if (created) this.deleteVaoHandles(created);
      this.recordFailure(source, arrays, failure);
      return null;
    }
    this.pendingSources.delete(source.id);
    const resident: ResidentSource = { source, parts, bytes, lastUsedFrame: this.frameCounter };
    this.residentSources.set(source.id, resident);
    this.residentSourceBytes += bytes;
    return resident;
  }

  /**
   * Schedules the next attempt: the next frame, then with doubling waits up to
   * {@link SOURCE_RETRY_MAX_DELAY_FRAMES}, so a broken source costs one attempt per interval rather
   * than one per frame. The first failure is a warning; a source still failing after
   * {@link SOURCE_FAILURE_REPORT_ATTEMPTS} attempts is logged once as an error, which reports it.
   */
  private recordFailure(source: ImmutableMeshSource, arrays: readonly MeshUploadData[] | null, error: unknown): void {
    const pending = this.pendingSources.get(source.id) ?? this.newPendingSource(source);
    pending.attempts++;
    pending.arrays = arrays;
    pending.retryFrame = this.frameCounter + Math.min(2 ** (pending.attempts - 1), SOURCE_RETRY_MAX_DELAY_FRAMES);
    if (pending.attempts === 1) {
      log.warn('Renderer', `Mesh source ${source.id} could not be made resident; retrying`, error);
    } else if (pending.attempts === SOURCE_FAILURE_REPORT_ATTEMPTS) {
      log.error(
        'Renderer',
        new Error(`Mesh source ${source.id} is still not resident after ${pending.attempts} attempts`, {
          cause: error,
        }),
      );
    }
  }

  private newPendingSource(source: ImmutableMeshSource): PendingSource {
    const pending: PendingSource = { source, queued: false, attempts: 0, retryFrame: 0, arrays: null };
    this.pendingSources.set(source.id, pending);
    return pending;
  }

  /**
   * Supersede-by-id, for every way a source is tracked: claiming an id for `source` drops whatever
   * other source holds it, resident or pending, with its upload, recipe and arrays.
   */
  private claimId(source: ImmutableMeshSource): void {
    const resident = this.residentSources.get(source.id);
    if (resident && resident.source !== source) this.releaseResidentSource(resident);
    const pending = this.pendingSources.get(source.id);
    if (pending && pending.source !== source) this.pendingSources.delete(source.id);
  }

  private releaseResidentSource(resident: ResidentSource): void {
    for (const part of resident.parts) {
      if (part) this.deleteVaoHandles(part);
    }
    this.residentSources.delete(resident.source.id);
    this.residentSourceBytes -= resident.bytes;
  }

  /** Drops every tracked source that `matches`, resident, pending or an atlas. The one release path. */
  private releaseSources(matches: (source: ImmutableMeshSource) => boolean): void {
    for (const resident of [...this.residentSources.values()]) {
      if (matches(resident.source)) this.releaseResidentSource(resident);
    }
    for (const [id, pending] of this.pendingSources) {
      if (matches(pending.source)) this.pendingSources.delete(id);
    }
    for (const source of this.queuedAtlases) {
      if (matches(source)) this.queuedAtlases.delete(source);
    }
    for (const [id, held] of this.atlases) {
      if (!matches(held.source)) continue;
      if (held.atlas && this.gl) {
        deleteAtlas(this.gl, held.atlas);
        // Deleting a bound VAO unbinds it.
        if (held.atlas.layouts.some((layout) => layout.vao === this.boundVao)) this.boundVao = null;
      }
      this.atlases.delete(id);
    }
  }

  /**
   * The uploaded atlas of `source`, uploaded now if it has none; null while it is retired or when it
   * cannot be drawn instanced. A new source under a held id supersedes the old one, as with meshes.
   */
  private residentAtlas(source: ImmutableMeshSource): ResidentAtlas | null {
    if (source.retired) {
      this.forgetSource(source);
      return null;
    }
    const held = this.atlases.get(source.id);
    if (held?.source === source) return held.atlas;
    if (held) this.releaseSources((tracked) => tracked === held.source);
    const gl = this.gl;
    if (!gl) return null;
    let atlas: ResidentAtlas | null = null;
    // Retired atlases draw nothing more; released now rather than between frames, so the one that
    // supersedes another (a rebake) is not refused for the storage of the one it replaces.
    this.releaseSources((tracked) => tracked.use === 'instanceAtlas' && tracked.retired);
    let free = ATLAS_BUDGET_BYTES;
    for (const held of this.atlases.values()) free -= held.atlas?.bytes ?? 0;
    // Both refusals are known from the source's descriptors, so the atlas is never built, and kept
    // for this source like any other failure, so they are not tried again every frame. The bound
    // holds for unindexed soups only, as atlas sources are: an indexed part's indices are unbounded.
    if (source.parts.some((part) => part.attributes.includes('indices'))) {
      log.warn('Renderer', `Instancing atlas ${source.id} has an indexed part; drawing singly`);
    } else if (instanceAtlasBoundBytes(source.parts.map((part) => part.vertexCount)) > free) {
      log.warn('Renderer', `Instancing atlas ${source.id} does not fit the atlas budget; drawing singly`);
    } else {
      try {
        atlas = uploadAtlas(
          gl,
          source,
          source.materialize(),
          (part) => indexedSoup(part, false, this.indexingScratch),
          this.features?.maxTextureSize ?? 0,
          free,
        );
      } catch (error) {
        if (error instanceof RetiredMeshSourceError) return null;
        log.warn('Renderer', `Instancing atlas ${source.id} could not be uploaded; drawing singly`, error);
      }
      // The upload binds its VAOs directly and leaves none bound.
      this.boundVao = undefined;
    }
    if (atlas) {
      renderStats.recordBufferUpload(atlas.uploadBytes);
    }
    this.atlases.set(source.id, { source, atlas });
    return atlas;
  }

  /**
   * Writes every run's instances (its commands' MVP matrices, computed as the per-command uniform
   * is, and atlas rows) and uploads them in one call. False when the buffer cannot be had: the
   * frame then draws every command singly.
   */
  private uploadInstances(
    gl: WebGL2RenderingContext,
    lists: readonly (readonly [readonly Mesh3DCommand[], readonly AtlasRun[]])[],
    instances: number,
    viewProjMatrix: Float32Array,
  ): boolean {
    const floats = instances * INSTANCE_FLOATS;
    const bytes = floats * 4;
    if (bytes > MAX_INSTANCE_STREAM_BYTES) {
      if (!this.instanceStreamCapped)
        log.warn('Renderer', `A frame needs ${instances} instances, over the instance stream cap; drawing singly`);
      this.instanceStreamCapped = true;
      return false;
    }
    if (this.instanceStaging.length < floats)
      this.instanceStaging = new Float32Array(
        Math.min(MAX_INSTANCE_STREAM_BYTES / 4, Math.max(floats, this.instanceStaging.length * 2)),
      );
    const staging = this.instanceStaging;
    const mvp = this.mvpMatrix;
    for (const [list, runs] of lists) {
      for (const run of runs) {
        for (let index = run.start; index < run.end; index++) {
          const cmd = list[index] as Mesh3DCommand;
          this.multiplyMatrices(mvp, viewProjMatrix, cmd.modelMatrix);
          const offset = (run.firstInstance + index - run.start) * INSTANCE_FLOATS;
          staging.set(mvp, offset);
          staging[offset + 16] = cmd.instanceAtlasPart ?? 0;
        }
      }
    }
    if (!this.instanceBuffer) {
      this.instanceBuffer = gl.createBuffer();
      if (!this.instanceBuffer) return false;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    if (bytes > this.instanceCapacityBytes) {
      const capacityBytes = Math.min(MAX_INSTANCE_STREAM_BYTES, grownCapacityBytes(this.instanceCapacityBytes, bytes));
      // Checked, as resident uploads are: WebGL reports a failed allocation (out of memory) only as
      // an error flag, and a reallocation that failed leaves the buffer unusable. Flags raised
      // before it are not its failure. Only (re)allocations pay for the check, not every frame.
      for (let flags = 0; flags < 8 && gl.getError(); flags++);
      gl.bufferData(gl.ARRAY_BUFFER, capacityBytes, gl.DYNAMIC_DRAW);
      const error = gl.getError();
      if (error !== gl.NO_ERROR) {
        // Dropped whole, so nothing counts storage it may not have; a later frame allocates afresh.
        gl.deleteBuffer(this.instanceBuffer);
        this.instanceBuffer = null;
        this.instanceCapacityBytes = 0;
        if (!this.instanceAllocationFailed && !gl.isContextLost())
          log.warn(
            'Renderer',
            `Instance buffer of ${capacityBytes} bytes could not be allocated (GL error 0x${error.toString(16)}); drawing singly`,
          );
        this.instanceAllocationFailed = true;
        return false;
      }
      this.instanceCapacityBytes = capacityBytes;
      renderStats.recordBufferReallocation();
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, staging, 0, floats);
    renderStats.recordBufferUpload(bytes);
    return true;
  }

  private forgetSource(source: ImmutableMeshSource): void {
    this.releaseSources((tracked) => tracked === source);
  }

  /**
   * Releases every source whose owner token is `owner` (a replaced cache loader), so nothing here
   * keeps it or its recipes alive. A source drawn again afterwards simply uploads again.
   */
  retireResidentSources(owner: object): void {
    this.releaseSources((source) => source.owner === owner);
  }

  /** The resident upload of `source`, made now if it has none; null while it cannot be, or once retired. */
  private ensureResident(source: ImmutableMeshSource): { resident: ResidentSource; uploaded: boolean } | null {
    if (source.retired) {
      this.forgetSource(source);
      return null;
    }
    this.claimId(source);
    const resident = this.residentSources.get(source.id);
    if (resident) return { resident, uploaded: false };
    const uploaded = this.uploadResidentSource(source);
    return uploaded ? { resident: uploaded, uploaded: true } : null;
  }

  /** The VAO for one part of a resident command. */
  private residentPart(cmd: ResidentMesh3DCommand): CachedMeshVao | null {
    const ensured = this.ensureResident(cmd.meshSource);
    if (!ensured) return null;
    if (ensured.uploaded) renderStats.recordVaoCacheMiss();
    else renderStats.recordVaoCacheHit();
    ensured.resident.lastUsedFrame = this.frameCounter;
    return ensured.resident.parts[cmd.meshSourcePart] ?? null;
  }

  /**
   * Queues sources to upload before their first draw, so the build each made while loading leaves
   * the CPU at load rather than at first use. Only a source still holding that build is queued, so
   * preparing never rebuilds. The queue drains at the start of frames, a bounded amount per frame.
   */
  prepareResidentSources(sources: readonly ImmutableMeshSource[]): void {
    for (const source of sources) {
      if (!source.holdsFirstBuild || source.retired) continue;
      if (source.use === 'instanceAtlas') {
        this.queuedAtlases.add(source);
        continue;
      }
      this.claimId(source);
      (this.pendingSources.get(source.id) ?? this.newPendingSource(source)).queued = true;
    }
  }

  private uploadQueuedSources(): void {
    // An atlas prepared ahead uploads, with the program that draws it, before the first frame that
    // needs it, rather than in it. One per frame.
    for (const source of this.queuedAtlases) {
      this.queuedAtlases.delete(source);
      if (this.residentAtlas(source)) this.instancedProgramEntry();
      break;
    }
    let bytes = 0;
    for (const pending of [...this.pendingSources.values()]) {
      if (bytes >= QUEUED_UPLOAD_BYTES_PER_FRAME) break;
      if (pending.queued) bytes += this.ensureResident(pending.source)?.resident.bytes ?? 0;
    }
  }

  /**
   * Runs between frames, never during one: drops retired sources, then releases the least recently
   * drawn sources not drawn this frame until resident bytes fit the budget.
   */
  private evictResidentSources(): void {
    this.releaseSources((source) => source.retired);
    if (this.residentSourceBytes <= this.residentSourceBudgetBytes) return;
    const idle = [...this.residentSources.values()]
      .filter((resident) => resident.lastUsedFrame < this.frameCounter)
      .sort((left, right) => left.lastUsedFrame - right.lastUsedFrame);
    for (const resident of idle) {
      if (this.residentSourceBytes <= this.residentSourceBudgetBytes) break;
      this.releaseResidentSource(resident);
    }
  }

  /**
   * The scene boundary. Mesh ids are scene-local (every scene has a
   * `merged-static-locs-opaque`, a `tile-grid-…` over the same bounds, ...), so a new scene must not draw the
   * previous one's cached buffers. Deletes the embedded mesh VAOs and buffers and releases every
   * scene-scoped source. Loader-scoped sources stay: they are identified by object, so a new scene
   * can only draw one by holding the very source, baked from the same loader. The context, programs
   * and texture array stay too.
   */
  releaseSceneMeshes(): void {
    this.deleteMeshCache('scene');
  }

  /** Deletes every embedded mesh, and the resident and pending sources of `scope`, or all of them. */
  private deleteMeshCache(scope: MeshSourceScope | 'all'): void {
    for (const cached of this.meshVaoCache.values()) {
      this.deleteVaoHandles(cached);
    }
    this.meshVaoCache.clear();
    this.releaseSources((source) => scope === 'all' || source.scope === scope);
    this.sortedVaos.length = 0;
    this.sortedMvpPoolSize = 0;
  }

  /** VAO count and allocated mesh buffer bytes (grown capacity included), for the render stats only. */
  private recordMeshStats(): void {
    let vaos = this.meshVaoCache.size;
    let bytes = this.residentSourceBytes + this.instanceCapacityBytes;
    for (const cached of this.meshVaoCache.values()) bytes += cached.bytes;
    for (const { atlas } of this.atlases.values()) {
      vaos += atlas?.layouts.length ?? 0;
      bytes += atlas?.bytes ?? 0;
    }
    for (const resident of this.residentSources.values()) {
      for (const part of resident.parts) if (part) vaos++;
    }
    renderStats.setVaoCacheSize(vaos);
    renderStats.setEstimatedGpuMemoryBytes(bytes);
  }

  render(frame: RenderFrame): void {
    if (!this.app || !this.gl || this.contextStatus.kind !== 'ok') return;

    this.frameCounter++;
    this.evictStaleCacheEntries();
    renderStats.beginFrame();
    this.uploadQueuedSources();

    const { camera, queue } = frame;

    if (queue.clear) {
      const c = queue.clear.color;
      this.app.clearColor(c.r, c.g, c.b, c.a);
    }
    this.app.clear();

    const tick = queue.tick ?? 0;
    const brightness = queue.brightness ?? 0.6;
    const contrast = queue.contrast ?? 1.0;
    const saturation = queue.saturation ?? 1.0;
    this.textureAnimTimeCycles = (performance.now() / CLIENT_TICK_MS) % TEXTURE_ANIM_CYCLE_PERIOD;

    if (camera.kind === '3d' && this.programs.size > 0 && queue.commands.length > 0) {
      const viewMatrix = camera.camera.viewMatrix();
      const projMatrix = camera.camera.projectionMatrix();
      const viewProjMatrix = this.viewProjMatrix;
      this.multiplyMatrices(viewProjMatrix, projMatrix, viewMatrix);
      const eyeX = -(viewMatrix[0] * viewMatrix[12] + viewMatrix[1] * viewMatrix[13] + viewMatrix[2] * viewMatrix[14]);
      const eyeY = -(viewMatrix[4] * viewMatrix[12] + viewMatrix[5] * viewMatrix[13] + viewMatrix[6] * viewMatrix[14]);
      const eyeZ = -(viewMatrix[8] * viewMatrix[12] + viewMatrix[9] * viewMatrix[13] + viewMatrix[10] * viewMatrix[14]);

      this.gl.disableVertexAttribArray(6);
      this.gl.vertexAttrib1f(6, 1.0);

      this.renderCommands(queue.commands, viewProjMatrix, tick, brightness, contrast, saturation, eyeX, eyeY, eyeZ);
    }
    this.evictResidentSources();

    if (renderStats.isEnabled()) this.recordMeshStats();
    renderStats.endFrame();
  }

  private bindVertexArray(gl: WebGL2RenderingContext, vao: WebGLVertexArrayObject | null): void {
    if (this.boundVao === vao) return;
    gl.bindVertexArray(vao);
    this.boundVao = vao;
  }

  private setDepthMask(gl: WebGL2RenderingContext, flag: boolean): void {
    if (this.depthMaskState === flag) return;
    gl.depthMask(flag);
    this.depthMaskState = flag;
  }

  private forgetDrawState(): void {
    this.boundVao = undefined;
    this.depthMaskState = undefined;
  }

  private multiplyMatrices(result: Float32Array, a: Float32Array, b: Float32Array): void {
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        result[col * 4 + row] =
          a[0 * 4 + row] * b[col * 4 + 0] +
          a[1 * 4 + row] * b[col * 4 + 1] +
          a[2 * 4 + row] * b[col * 4 + 2] +
          a[3 * 4 + row] * b[col * 4 + 3];
      }
    }
  }

  private getSortedMvp(): Float32Array {
    if (this.sortedMvpPoolSize >= this.sortedMvpPool.length) {
      this.sortedMvpPool.push(new Float32Array(16));
    }
    return this.sortedMvpPool[this.sortedMvpPoolSize++];
  }

  private renderCommands(
    commands: RenderCommand[],
    viewProjMatrix: Float32Array,
    tick: number,
    brightness: number,
    contrast: number,
    saturation: number,
    eyeX: number,
    eyeY: number,
    eyeZ: number,
  ): void {
    if (!this.app || !this.gl || this.programs.size === 0) return;

    renderStats.recordCommandCount(commands.length);

    const gl = this.gl;
    this.forgetDrawState();
    try {
      this.drawPasses(gl, commands, viewProjMatrix, tick, brightness, contrast, saturation, eyeX, eyeY, eyeZ);
    } finally {
      // Draws leave their VAO bound for the next to reuse; nothing outside the frame expects one.
      // Unknown means the frame bound none, so the binding is still whatever it found.
      if (this.boundVao !== undefined) this.bindVertexArray(gl, null);
      this.forgetDrawState();
    }
  }

  private drawPasses(
    gl: WebGL2RenderingContext,
    commands: RenderCommand[],
    viewProjMatrix: Float32Array,
    tick: number,
    brightness: number,
    contrast: number,
    saturation: number,
    eyeX: number,
    eyeY: number,
    eyeZ: number,
  ): void {
    let currentShaderId: ShaderId | 'scene-base-instanced' | null = null;
    let currentProgramEntry: ShaderProgramEntry | null = null;
    let currentDiscardAlpha = 0.0;
    let currentZBias = 0.0;
    let passZBias = 0.0;

    const applyPassUniforms = (entry: ShaderProgramEntry): void => {
      const { discardAlpha, zBias } = entry.uniformLocations;
      if (discardAlpha) {
        gl.uniform1f(discardAlpha, currentDiscardAlpha);
      }
      if (zBias) {
        gl.uniform1f(zBias, currentZBias);
      }
    };

    const bindProgram = (requestedShaderId: ShaderId): ShaderProgramEntry | null => {
      const resolvedShaderId = this.programs.has(requestedShaderId) ? requestedShaderId : 'scene-base';
      return bindProgramEntry(resolvedShaderId, this.programs.get(resolvedShaderId));
    };

    const bindProgramEntry = (
      resolvedShaderId: ShaderId | 'scene-base-instanced',
      entry: ShaderProgramEntry | null | undefined,
    ): ShaderProgramEntry | null => {
      if (currentProgramEntry && currentShaderId === resolvedShaderId) {
        return currentProgramEntry;
      }
      if (!entry) {
        return null;
      }

      const webglProgram = entry.program.program;
      const bindWebGLProgram = gl.useProgram.bind(gl);
      bindWebGLProgram(webglProgram);
      renderStats.recordShaderSwitch();

      const {
        currentTick,
        brightness: brightnessLoc,
        contrast: contrastLoc,
        saturation: saturationLoc,
        colorBanding,
        priorityStepNdc,
        hasTextures,
        textures,
        textureAnimTime,
      } = entry.uniformLocations;

      if (currentTick) {
        gl.uniform1f(currentTick, tick);
      }
      if (brightnessLoc) {
        gl.uniform1f(brightnessLoc, brightness);
      }
      if (contrastLoc) {
        gl.uniform1f(contrastLoc, contrast);
      }
      if (saturationLoc) {
        gl.uniform1f(saturationLoc, saturation);
      }
      if (colorBanding) {
        gl.uniform1f(colorBanding, 255.0);
      }
      if (priorityStepNdc) {
        gl.uniform1f(priorityStepNdc, 5e-9);
      }
      if (textureAnimTime) {
        gl.uniform1f(textureAnimTime, this.textureAnimTimeCycles);
      }

      if (this.hasTextures && this.textureArray) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textureArray.texture);
        if (textures) {
          gl.uniform1i(textures, 0);
        }
        if (hasTextures) {
          gl.uniform1f(hasTextures, 1.0);
        }
        renderStats.recordTextureBind();
      } else if (hasTextures) {
        gl.uniform1f(hasTextures, 0.0);
      }

      applyPassUniforms(entry);
      currentShaderId = resolvedShaderId;
      currentProgramEntry = entry;
      return entry;
    };

    const mvpMatrix = this.mvpMatrix;
    const {
      opaque: opaqueCommands,
      sorted: sortedCommands,
      transparent: transparentCommands,
      noDepth: noDepthCommands,
    } = classifyMesh3DCommands(commands);
    transparentCommands.sort((left, right) => {
      const leftFirst = left.transparentOrder === 'first';
      if (leftFirst !== (right.transparentOrder === 'first')) return leftFirst ? -1 : 1;
      if (leftFirst) return 0;
      const leftX = left.modelMatrix[12] - eyeX;
      const leftY = left.modelMatrix[13] - eyeY;
      const leftZ = left.modelMatrix[14] - eyeZ;
      const rightX = right.modelMatrix[12] - eyeX;
      const rightY = right.modelMatrix[13] - eyeY;
      const rightZ = right.modelMatrix[14] - eyeZ;
      return rightX * rightX + rightY * rightY + rightZ * rightZ - (leftX * leftX + leftY * leftY + leftZ * leftZ);
    });

    // Runs of consecutive commands drawing one atlas layout with one state become single
    // instanced draws, after sorting and in that order. Anything that stops one leaves every
    // command to draw singly, exactly as without atlases.
    const opaqueRuns = this.opaqueRuns;
    const transparentRuns = this.transparentRuns;
    opaqueRuns.length = 0;
    transparentRuns.length = 0;
    const resolveAtlas = (source: ImmutableMeshSource) => this.residentAtlas(source);
    let instances = planAtlasRuns(opaqueCommands, resolveAtlas, opaqueRuns, 0);
    instances = planAtlasRuns(transparentCommands, resolveAtlas, transparentRuns, instances);
    const instancedProgram = instances > 0 ? this.instancedProgramEntry() : null;
    if (
      instances > 0 &&
      (!instancedProgram ||
        !this.uploadInstances(
          gl,
          [
            [opaqueCommands, opaqueRuns],
            [transparentCommands, transparentRuns],
          ],
          instances,
          viewProjMatrix,
        ))
    ) {
      opaqueRuns.length = 0;
      transparentRuns.length = 0;
    }

    /** Draws one run as one instanced draw, with the state its first command would set. */
    const drawRun = (list: readonly Mesh3DCommand[], run: AtlasRun): void => {
      const first = list[run.start] as Mesh3DCommand;
      const programEntry = bindProgramEntry('scene-base-instanced', instancedProgram);
      const instanceBuffer = this.instanceBuffer;
      if (!programEntry || !instanceBuffer) return;
      const commandZBias = first.depthBias ?? passZBias;
      if (commandZBias !== currentZBias) {
        currentZBias = commandZBias;
        if (programEntry.uniformLocations.zBias) gl.uniform1f(programEntry.uniformLocations.zBias, currentZBias);
      }
      if (first.cullFace === 'none') gl.disable(gl.CULL_FACE);
      else if (first.cullFace === 'front') gl.cullFace(gl.FRONT);

      const layout = run.atlas.layouts[run.layout] as (typeof run.atlas.layouts)[number];
      const count = run.end - run.start;
      this.bindVertexArray(gl, layout.vao);
      bindInstances(gl, instanceBuffer, run.firstInstance);
      gl.activeTexture(gl.TEXTURE0 + ATLAS_TEXTURE_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, run.atlas.texture);
      gl.activeTexture(gl.TEXTURE0);
      gl.drawElementsInstanced(gl.TRIANGLES, layout.indexCount, layout.indexType, 0, count);
      renderStats.recordDrawCall((layout.indexCount / 3) * count);

      if (first.cullFace === 'none') gl.enable(gl.CULL_FACE);
      else if (first.cullFace === 'front') gl.cullFace(gl.BACK);
    };

    const drawMeshCommand = (cmd: Mesh3DCommand, modelMatrix: Float32Array): CachedMeshVao | null => {
      // A resident command's geometry is already on the GPU, or is rebuilt here from its source.
      const resident = isResidentMesh3DCommand(cmd) ? this.residentPart(cmd) : undefined;
      const embedded = resident === undefined && hasEmbeddedMesh(cmd) ? cmd : null;
      const vertexCount = resident?.vertexCount ?? (embedded ? embedded.positions.length / 3 : 0);
      if (vertexCount === 0) return null;

      const requestedShaderId: ShaderId = cmd.shaderId ?? 'scene-base';
      const programEntry = bindProgram(requestedShaderId);
      if (!programEntry) return null;

      const commandZBias = cmd.depthBias ?? passZBias;
      if (commandZBias !== currentZBias) {
        currentZBias = commandZBias;
        if (programEntry.uniformLocations.zBias) {
          gl.uniform1f(programEntry.uniformLocations.zBias, currentZBias);
        }
      }

      if (programEntry.uniformLocations.viewProjMatrix) {
        if (!cmd.clipSpace) this.multiplyMatrices(mvpMatrix, viewProjMatrix, modelMatrix);
        gl.uniformMatrix4fv(
          programEntry.uniformLocations.viewProjMatrix,
          false,
          cmd.clipSpace ? modelMatrix : mvpMatrix,
        );
      }

      if (currentShaderId === 'scene-effects' && programEntry.uniformLocations.animParams) {
        if (cmd.uniforms?.u_animParams) {
          const p = cmd.uniforms.u_animParams as number[];
          gl.uniform4f(programEntry.uniformLocations.animParams, p[0], p[1], p[2], p[3]);
        } else {
          gl.uniform4f(programEntry.uniformLocations.animParams, 0.0, 0.0, 0.0, 0.0);
        }
      }

      // Default render state is backface-cull (BACK). Only exceptions touch it here:
      // 'none' = double-sided, 'front' = reverse winding. Restored after the draw.
      if (cmd.cullFace === 'none') {
        gl.disable(gl.CULL_FACE);
      } else if (cmd.cullFace === 'front') {
        gl.cullFace(gl.FRONT);
      }

      const cached = resident ?? (embedded ? this.embeddedMeshVao(embedded, vertexCount) : undefined);

      if (cached) {
        this.bindVertexArray(gl, cached.vao);
        if (cached.indexCount !== undefined && cached.indexType !== undefined) {
          gl.drawElements(gl.TRIANGLES, cached.indexCount, cached.indexType, 0);
          renderStats.recordDrawCall(cached.indexCount / 3);
        } else {
          gl.drawArrays(gl.TRIANGLES, 0, cached.vertexCount);
          renderStats.recordDrawCall(cached.vertexCount / 3);
        }
      }

      if (cmd.cullFace === 'none') {
        gl.enable(gl.CULL_FACE);
      } else if (cmd.cullFace === 'front') {
        gl.cullFace(gl.BACK);
      }

      return cached ?? null;
    };

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.GREATER);
    this.setDepthMask(gl, true);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);

    frameProfiler.beginPhase('passOpaque');
    gl.disable(gl.BLEND);
    currentDiscardAlpha = 0.0;
    passZBias = 0.0;
    currentZBias = passZBias;
    if (currentProgramEntry) {
      applyPassUniforms(currentProgramEntry);
    }
    for (let index = 0, run = 0; index < opaqueCommands.length; index++) {
      const atlasRun = opaqueRuns[run];
      if (atlasRun?.start === index) {
        drawRun(opaqueCommands, atlasRun);
        index = atlasRun.end - 1;
        run++;
        continue;
      }
      const cmd = opaqueCommands[index] as Mesh3DCommand;
      drawMeshCommand(cmd, cmd.modelMatrix);
    }
    frameProfiler.endPhase('passOpaque');
    frameProfiler.beginPhase('passSorted');
    // Matches RuneLite RENDERMODE_SORTED_NO_DEPTH: faces are priority-sorted
    // and drawn without depth write so later faces always overwrite earlier ones.
    // This eliminates z-fighting between coplanar faces (cape symbols, boots vs cape).
    if (sortedCommands.length > 0) {
      // 2a: Color pass — depth test ON (reads scene depth for occlusion),
      //     depth write OFF (faces don't compete with each other)
      this.setDepthMask(gl, false);
      const sortedVaos = this.sortedVaos;
      sortedVaos.length = 0;
      this.sortedMvpPoolSize = 0;
      for (const cmd of sortedCommands) {
        const cached = drawMeshCommand(cmd, cmd.modelMatrix);
        if (cached) {
          const mvpCopy = this.getSortedMvp();
          mvpCopy.set(mvpMatrix);
          sortedVaos.push({
            vao: cached.vao,
            indexCount: cached.indexCount,
            indexType: cached.indexType,
            vertexCount: cached.vertexCount,
            mvp: mvpCopy,
          });
        }
      }

      // 2b: Depth-only pass — write player depth for subsequent scene occlusion.
      // Reuses VAOs from pass 2a (buffers already uploaded, same geometry).
      // Draws with the default backface-cull state (BACK/CCW) rather than re-applying each
      // command's cullFace. Correct for occlusion today: the only sorted command is the
      // back-culled player, and its front-face depth is the right occluder. If a 'none'/'front'
      // sorted command is ever added, thread its cullFace through sortedVaos and apply it here.
      this.setDepthMask(gl, true);
      gl.colorMask(false, false, false, false);
      const sortedProgram = bindProgram('scene-base');
      for (const entry of sortedVaos) {
        if (sortedProgram?.uniformLocations.viewProjMatrix) {
          gl.uniformMatrix4fv(sortedProgram.uniformLocations.viewProjMatrix, false, entry.mvp);
        }
        this.bindVertexArray(gl, entry.vao);
        if (entry.indexCount !== undefined && entry.indexType !== undefined) {
          gl.drawElements(gl.TRIANGLES, entry.indexCount, entry.indexType, 0);
          renderStats.recordDrawCall(entry.indexCount / 3);
        } else {
          gl.drawArrays(gl.TRIANGLES, 0, entry.vertexCount);
          renderStats.recordDrawCall(entry.vertexCount / 3);
        }
      }
      gl.colorMask(true, true, true, true);
    }
    frameProfiler.endPhase('passSorted');
    frameProfiler.beginPhase('passTransparent');
    gl.enable(gl.BLEND);
    // Matches RuneLite's scene blending: color channels use standard SRC_ALPHA /
    // ONE_MINUS_SRC_ALPHA over-blend, but the destination alpha channel is left
    // untouched (src=ONE, dst=ONE) so we don't accidentally clobber the render
    // target's alpha with per-fragment translucency. Combined with the RuneLite
    // shader semantics (opaque texel discard + v_color.a as the only translucency
    // source), the transparent pass needs no global depth bias — currentZBias is 0,
    // so translucent draws are not shifted forward.
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE);
    currentDiscardAlpha = 1.0;
    passZBias = 0.0;
    currentZBias = passZBias;
    if (currentProgramEntry) {
      applyPassUniforms(currentProgramEntry);
    }
    for (let index = 0, run = 0; index < transparentCommands.length; index++) {
      const cmd = transparentCommands[index] as Mesh3DCommand;
      this.setDepthMask(gl, cmd.depth === 'readwrite');
      const atlasRun = transparentRuns[run];
      if (atlasRun?.start === index) {
        drawRun(transparentCommands, atlasRun);
        index = atlasRun.end - 1;
        run++;
        continue;
      }
      drawMeshCommand(cmd, cmd.modelMatrix);
    }
    this.setDepthMask(gl, true);
    frameProfiler.endPhase('passTransparent');
    if (noDepthCommands.length > 0) {
      frameProfiler.beginPhase('passNoDepth');
      gl.disable(gl.DEPTH_TEST);
      this.setDepthMask(gl, false);
      currentDiscardAlpha = 0.0;
      passZBias = 0.0;
      currentZBias = passZBias;
      if (currentProgramEntry) {
        applyPassUniforms(currentProgramEntry);
      }
      for (const cmd of noDepthCommands) {
        drawMeshCommand(cmd, cmd.modelMatrix);
      }
      gl.enable(gl.DEPTH_TEST);
      this.setDepthMask(gl, true);
      frameProfiler.endPhase('passNoDepth');
    }
  }
  /**
   * The cached VAO for an embedded-array command: built on first draw, rebuilt when the
   * program needs normals it lacks or an animated mesh's attribute layout changes, and
   * rewritten in place every draw for animated meshes, whatever their vertex count.
   */
  private embeddedMeshVao(cmd: EmbeddedMeshCommand, vertexCount: number): CachedMeshVao | undefined {
    const gl = this.gl;
    if (!gl) return undefined;
    let cached = this.meshVaoCache.get(cmd.meshId);
    if (!cached) {
      const newVao = this.createMeshVao(cmd, cmd.animated === true, uploadsNormals(cmd));
      if (newVao) {
        this.meshVaoCache.set(cmd.meshId, newVao);
        cached = newVao;
        renderStats.recordVaoCacheMiss();
      }
      return cached;
    }

    cached.lastUsedFrame = this.frameCounter;
    if (!cmd.animated && uploadsNormals(cmd) && !cached.normBuffer) {
      // Built for a program without normals; this draw's program reads them.
      this.deleteCachedMeshVao(cmd.meshId, cached);
      cached = this.createMeshVao(cmd, false, true) ?? undefined;
      if (cached) this.meshVaoCache.set(cmd.meshId, cached);
    } else if (cmd.animated && cached.posBuffer) {
      const resized = cached.vertexCount !== vertexCount;
      const indexType = cmd.indices ? indexTypeOf(gl, cmd.indices) : undefined;
      // The index layout is checked at any count: a static soup indexed down to this many vertices
      // draws through indices this soup does not have.
      if (!matchesAttributeLayout(cached, cmd) || !matchesResizeLayout(cached, cmd, indexType)) {
        // createMeshVao uploads every attribute, so the rebuilt VAO needs no sub-data pass.
        this.deleteCachedMeshVao(cmd.meshId, cached);
        cached = this.createMeshVao(cmd, true, uploadsNormals(cmd)) ?? undefined;
        if (cached) this.meshVaoCache.set(cmd.meshId, cached);
      } else {
        this.rewriteMeshVao(gl, cached, cmd, resized);
        if (resized) renderStats.recordVaoRebuildAvoided();
      }
    }
    renderStats.recordVaoCacheHit();
    return cached;
  }

  /**
   * Animated meshes re-upload their attributes in place on every draw. At the same vertex count
   * that is every per-vertex attribute a pose changes; on a resize it is everything a rebuild
   * would upload, indices and tile coordinates included, into buffers that only ever grow. The
   * draw counts follow the new arrays, so storage past them is never drawn. An attribute whose
   * values its buffer already starts with is skipped: an unchanged pose, colors that no pose
   * changes, or the same contents drawn again through a VAO that several draws share.
   */
  private rewriteMeshVao(
    gl: WebGL2RenderingContext,
    cached: CachedMeshVao,
    cmd: EmbeddedMeshCommand,
    resized: boolean,
  ): void {
    // The index buffer binding belongs to whichever VAO is bound, and a draw leaves its VAO bound.
    // Rewriting with this mesh's own VAO bound rebinds its own index buffer, changing nothing else.
    this.bindVertexArray(gl, cached.vao);
    for (const slot of cached.slots) {
      if (!resized && (slot.attribute === 'indices' || slot.attribute === 'tileCoords')) continue;
      const data = cmd[slot.attribute];
      if (!data) continue;
      if (slot.contents && startsWith(slot.contents, data)) continue;
      gl.bindBuffer(slot.target, slot.buffer);
      if (data.byteLength > slot.capacityBytes) {
        const capacityBytes = grownCapacityBytes(slot.capacityBytes, data.byteLength);
        gl.bufferData(slot.target, capacityBytes, slot.usage);
        cached.bytes += capacityBytes - slot.capacityBytes;
        slot.capacityBytes = capacityBytes;
        // Reallocated storage starts zeroed.
        if (slot.contents) slot.contents = emptyLike(data, capacityBytes / data.BYTES_PER_ELEMENT);
        renderStats.recordBufferReallocation();
      }
      gl.bufferSubData(slot.target, 0, data);
      slot.contents?.set(data);
      renderStats.recordBufferUpload(data.byteLength);
    }
    if (resized) {
      cached.vertexCount = cmd.positions.length / 3;
      cached.indexCount = cmd.indices?.length;
    }
  }

  /**
   * Uploads every attribute once with `bufferData`, at exactly its size. `animated` meshes get
   * dynamic buffers, rewritten in place on later draws; `normals` says whether the drawing
   * program reads them. Null, with nothing left allocated, when any GL object cannot be created.
   */
  private createMeshVao(source: MeshVertexArrays, animated: boolean, normals: boolean): CachedMeshVao | null {
    const gl = this.gl;
    if (!gl) return null;
    // bufferData copies each array before this returns, so the scratch is free for the next mesh.
    const mesh = animated ? source : indexedSoup(source, normals, this.indexingScratch);
    const vao = gl.createVertexArray();
    if (!vao) return null;

    // Set when a buffer cannot be created: such a VAO would draw with an attribute missing.
    let incomplete = false;
    const cached: CachedMeshVao = {
      vao,
      slots: [],
      vertexCount: mesh.positions.length / 3,
      bytes: 0,
      lastUsedFrame: this.frameCounter,
    };
    const upload = (
      attribute: keyof MeshVertexArrays,
      target: number,
      data: Float32Array | Uint16Array | Uint32Array,
      usage: number,
    ): WebGLBuffer | undefined => {
      const buffer = gl.createBuffer();
      if (!buffer) {
        incomplete = true;
        return undefined;
      }
      gl.bindBuffer(target, buffer);
      gl.bufferData(target, data, usage);
      renderStats.recordBufferUpload(data.byteLength);
      cached.slots.push({
        attribute,
        buffer,
        target,
        usage,
        capacityBytes: data.byteLength,
        // Only animated meshes are rewritten, so only they keep a copy to compare against.
        ...(animated ? { contents: data.slice() } : {}),
      });
      cached.bytes += data.byteLength;
      return buffer;
    };
    const vertexAttribute = (
      location: number,
      size: number,
      attribute: Exclude<keyof MeshVertexArrays, 'indices'>,
      data: Float32Array,
      usage: number,
    ): WebGLBuffer | undefined => {
      const buffer = upload(attribute, gl.ARRAY_BUFFER, data, usage);
      if (buffer) {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
      }
      return buffer;
    };
    const usage = animated ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW;

    // Bound before any buffer, so the index buffer below lands in this VAO and no other.
    this.bindVertexArray(gl, vao);

    cached.posBuffer = vertexAttribute(0, 3, 'positions', mesh.positions, usage);

    if (normals && mesh.normals) {
      cached.normBuffer = vertexAttribute(1, 3, 'normals', mesh.normals, usage);
    }

    if (mesh.uvs) {
      cached.uvBuffer = vertexAttribute(2, 2, 'uvs', mesh.uvs, usage);
    } else {
      gl.disableVertexAttribArray(2);
      gl.vertexAttrib2f(2, 0.0, 0.0);
    }

    if (mesh.perVertexTextureIds) {
      cached.textureIdBuffer = vertexAttribute(3, 1, 'perVertexTextureIds', mesh.perVertexTextureIds, usage);
    } else {
      gl.disableVertexAttribArray(3);
      gl.vertexAttrib1f(3, 0.0);
    }

    if (mesh.perVertexHslColors) {
      cached.hslColorBuffer = vertexAttribute(4, 1, 'perVertexHslColors', mesh.perVertexHslColors, usage);
    }

    if (mesh.tileCoords) {
      cached.tileCoordBuffer = vertexAttribute(5, 2, 'tileCoords', mesh.tileCoords, gl.STATIC_DRAW);
    } else {
      gl.disableVertexAttribArray(5);
      gl.vertexAttrib2f(5, -1000.0, 0.0);
    }

    if (mesh.perVertexAlphas && uploadsAlphas(mesh, animated)) {
      cached.alphaBuffer = vertexAttribute(6, 1, 'perVertexAlphas', mesh.perVertexAlphas, usage);
    } else {
      gl.disableVertexAttribArray(6);
      gl.vertexAttrib1f(6, 1.0);
    }

    if (mesh.perVertexFaceBias && uploadsFaceBias(mesh, animated)) {
      cached.faceBiasBuffer = vertexAttribute(7, 1, 'perVertexFaceBias', mesh.perVertexFaceBias, usage);
    } else {
      gl.disableVertexAttribArray(7);
      gl.vertexAttrib1f(7, 0.0);
    }

    if (mesh.indices) {
      cached.indexBuffer = upload('indices', gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      if (cached.indexBuffer) {
        cached.indexCount = mesh.indices.length;
        cached.indexType = indexTypeOf(gl, mesh.indices);
      }
    }

    this.bindVertexArray(gl, null);
    if (incomplete) {
      this.deleteVaoHandles(cached);
      return null;
    }
    return cached;
  }

  dispose(): void {
    if (this.canvas && this.contextLostHandler && this.contextRestoredHandler) {
      this.canvas.removeEventListener('webglcontextlost', this.contextLostHandler);
      this.canvas.removeEventListener('webglcontextrestored', this.contextRestoredHandler);
      this.contextLostHandler = null;
      this.contextRestoredHandler = null;
    }
    this.stopRestoreWait();
    const gl = this.gl;
    const canvas = this.canvas;

    this.deleteMeshCache('all');
    this.assetManager.clear();
    if (gl && this.instanceBuffer) {
      gl.deleteBuffer(this.instanceBuffer);
    }
    this.instanceBuffer = null;
    this.instanceCapacityBytes = 0;
    this.instanceStaging = new Float32Array(0);

    for (const entry of this.programs.values()) {
      entry.program.delete();
    }
    this.programs.clear();
    this.instancedProgram?.program.delete();
    this.instancedProgram = undefined;

    this.textureArrayManager?.dispose();
    this.textureArrayManager = null;
    this.textureArray = null;
    this.hasTextures = false;
    this.viewProjMatrix.fill(0);
    this.mvpMatrix.fill(0);
    this.opaqueCommands.length = 0;
    this.sortedCommands.length = 0;
    this.transparentCommands.length = 0;
    this.noDepthCommands.length = 0;
    this.sortedMvpPool.length = 0;

    this.app = null;
    this.gl = null;
    this.canvas = null;
    this.features = null;
    this.contextStatus = STATUS_OK;

    // The objects above are already deleted; what remains is the context itself and its
    // drawing buffers (MSAA storage included), which would otherwise wait for garbage
    // collection. Released last, with the listeners and timers gone, so it never reads
    // as a game loss.
    //
    // Scope: this assumes the canvas is attached while its owner uses it, as the 3D
    // viewport's is. One still in the document may be initialized again (React
    // StrictMode replays effects on the same element) and would then get this context
    // back lost, so only a canvas that has left the document is released.
    if (gl && canvas && !canvas.isConnected) {
      try {
        if (!gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext();
      } catch {
        // Releasing early is an optimization; garbage collection still frees the context.
      }
    }
  }
}

export function createPicoGLRenderer(): Renderer {
  return new PicoGLRenderer();
}
