import type { OverheadTextSegment } from '../../core/events/types';
import type { ImmutableMeshSource } from './meshSource';
import type { ColorRGBA, Rect, Vec2 } from './types';

export type BlendMode = 'normal' | 'additive' | 'multiply';
export type DepthMode = 'none' | 'readwrite' | 'read' | 'sorted';

export interface StrokeStyle {
  color: ColorRGBA;
  widthPx: number;
  dash?: number[];
}

export interface ShadowStyle {
  color: ColorRGBA;
  blurPx: number;
  offsetPx: Vec2;
}

export interface GradientStop {
  offset: number;
  color: ColorRGBA;
}

export interface RadialGradient {
  center: Vec2;
  radius: number;
  stops: GradientStop[];
}

export type FillStyle = ColorRGBA | RadialGradient;

export function isRadialGradient(fill: FillStyle): fill is RadialGradient {
  return 'stops' in fill;
}

export interface Poly2DCommand {
  kind: 'poly2d';
  points: Vec2[];
  fill?: FillStyle;
  stroke?: StrokeStyle;
  zIndex?: number;
  blend?: BlendMode;
  closePath?: boolean;
}

export interface Circle2DCommand {
  kind: 'circle2d';
  center: Vec2;
  radiusPx: number;
  fill?: FillStyle;
  stroke?: StrokeStyle;
  shadow?: ShadowStyle;
  zIndex?: number;
  blend?: BlendMode;
}

export interface Ellipse2DCommand {
  kind: 'ellipse2d';
  center: Vec2;
  radiusX: number;
  radiusY: number;
  fill?: FillStyle;
  stroke?: StrokeStyle;
  zIndex?: number;
  blend?: BlendMode;
}

export interface Sprite2DCommand {
  kind: 'sprite2d';
  textureId: string;
  destPx: Rect;
  uv?: Rect;
  tint?: ColorRGBA;
  zIndex?: number;
  blend?: BlendMode;
}

export type ShaderId = 'scene-base' | 'scene-effects';

export interface Mesh3DCommand {
  kind: 'mesh3d';
  meshId: string;
  materialId: string;
  modelMatrix: Float32Array;
  /** A depthless overlay whose matrix maps its vertices directly to clip space. */
  clipSpace?: true;
  depth?: DepthMode;
  blend?: BlendMode;
  /**
   * Backface culling mode. **Defaults to back-cull** — OSRS/RuneLite render all
   * scene geometry with `GL_CULL_FACE` (`GL_BACK` / `GL_CCW`), so omit this for
   * normal opaque OSRS model geometry. Set `'none'` for intentionally double-sided
   * geometry (2D overlays, flat telegraph tiles, translucent VFX / spotanims,
   * custom lobby effects). `'front'` reverses the culled winding.
   */
  cullFace?: 'front' | 'back' | 'none';
  zIndex?: number;
  uniforms?: Record<string, number | number[] | Float32Array>;
  shaderId?: ShaderId;
  depthBias?: number;
  /**
   * Transparent pass only: `'first'` draws before the far-to-near sorted commands, in queue
   * order. For scene-wide ground decals whose modelMatrix origin says nothing about distance.
   */
  transparentOrder?: 'first';
  /**
   * The command's own geometry again, as part `instanceAtlasPart` of an instancing atlas: a source
   * whose parts share a few index layouts. The renderer may draw a run of consecutive commands of
   * one atlas as a single instanced draw, in the same order and with the same per-vertex values;
   * whenever it does not, it draws the command's own geometry. Untextured scene-base geometry only.
   */
  instanceAtlas?: ImmutableMeshSource;
  instanceAtlasPart?: number;
}

/**
 * Draws one part of immutable geometry the renderer keeps GPU-resident and rebuilds itself
 * after eviction or context loss. Carries no arrays; animated or per-frame geometry keeps
 * embedding them (see {@link NpcMesh3DCommand}).
 */
export interface ResidentMesh3DCommand extends Mesh3DCommand {
  meshSource: ImmutableMeshSource;
  meshSourcePart: number;
}

export function isResidentMesh3DCommand(command: Mesh3DCommand): command is ResidentMesh3DCommand {
  return (command as Partial<ResidentMesh3DCommand>).meshSource !== undefined;
}

export type TerrainMesh3DCommand = ResidentMesh3DCommand & {
  /** OSRS texture ids the mesh samples, sorted. */
  textureIds: number[];
};

export type NpcMesh3DCommand = Mesh3DCommand & {
  positions: Float32Array;
  /** Only programs that read normals (scene-effects) need them; scene-base draws without. */
  normals?: Float32Array;
  colors?: Float32Array;
  perVertexHslColors?: Float32Array;
  perVertexAlphas?: Float32Array;
  perVertexFaceBias?: Float32Array;
  /** Interleaved `(u, v)` per vertex for textured model faces. */
  uvs?: Float32Array;
  /** Texture-array layer per vertex; 0 = untextured (shade from HSL instead). */
  perVertexTextureIds?: Float32Array;
  animated?: boolean;
};

export interface Text2DCommand {
  kind: 'text2d';
  position: Vec2;
  text: string;
  color: ColorRGBA;
  font?: string;
  shadow?: ShadowStyle;
  zIndex?: number;
}

export type RenderCommand =
  | Poly2DCommand
  | Circle2DCommand
  | Ellipse2DCommand
  | Sprite2DCommand
  | Mesh3DCommand
  | Text2DCommand;

export interface OverheadIcon {
  screenX: number;
  screenY: number;
  iconPath: string;
  key: string;
  width: number;
  height: number;
}

export interface OverheadTextOverlay {
  screenX: number;
  screenY: number;
  text: string;
  textColor: string;
  segments?: readonly OverheadTextSegment[];
  fontSize: number;
  key: string;
}

export interface HitsplatOverlay {
  /** Screen X of the hitsplat center */
  screenX: number;
  /** Screen Y of the hitsplat center */
  screenY: number;
  /** Damage number to display (0 = blue block splat) */
  amount: number;
  type: 'damage' | 'block' | 'poison' | 'venom' | 'heal' | 'doom' | 'burn';
  /** Unique key for DOM recycling */
  key: string;
  /** 0..1 progress through the hitsplat lifecycle */
  progress: number;
  /** Scaled width in pixels */
  width: number;
  /** Scaled height in pixels */
  height: number;
  /** Scaled font size in pixels */
  fontSize: number;
}

export interface HealthBarOverlay {
  /** Screen X of the health bar center */
  screenX: number;
  /** Screen Y of the health bar top-left */
  screenY: number;
  /** Current HP ratio 0..1 */
  ratio: number;
  /** Width of the health bar in pixels */
  width: number;
  /** Height of the health bar in pixels */
  height: number;
  /** Unique key for DOM recycling */
  key: string;
  /** 0..1 progress through the health bar lifecycle (for fade-out) */
  progress: number;
}

export function healthBarFillWidthPx(ratio: number, barWidthPx: number): number {
  if (ratio <= 0) return 0;
  // The foreground sprites have a 1px dark border; 2px exposes one green column.
  return Math.max(2, ratio * barWidthPx);
}

export type ChargeBarDirection = 'fill' | 'drain';

/**
 * Visible filled width (px) of a charge/progress bar.
 *
 * `chargeProgress` is the 0..1 elapsed fraction toward the bar's event (a
 * voidflare detonating, etc.) and is clamped to that range.
 * - `'fill'`  — bar grows empty → full as progress increases (Yama voidflares
 *   charging up to explode).
 * - `'drain'` — bar shrinks full → empty as progress increases, for NPCs whose
 *   indicator should deplete over time. The mirror of `'fill'`.
 *
 * Unlike {@link healthBarFillWidthPx} there is no minimum fill: an empty charge
 * bar should read as genuinely empty.
 */
export function chargeBarFillWidthPx(
  chargeProgress: number,
  barWidthPx: number,
  direction: ChargeBarDirection,
): number {
  const clamped = Math.min(1, Math.max(0, chargeProgress));
  const filledFraction = direction === 'drain' ? 1 - clamped : clamped;
  return barWidthPx * filledFraction;
}

export interface TimerBarOverlay {
  screenX: number;
  screenY: number;
  ratio: number;
  width: number;
  height: number;
  key: string;
}

export interface TickCounterOverlay {
  screenX: number;
  screenY: number;
  text: string;
  textColor: string;
  fontSize: number;
  key: string;
}

/**
 * Stacking order of the DOM overlay layers RenderViewport{,3D} hang over the
 * canvas. Each layer is created lazily on the first frame that needs it, so
 * without explicit z-indices their paint order is whichever appeared first.
 *
 * Three orderings have to hold at once. The tick counter sits ON the prayer
 * overhead icon unless the player opts into `tickCounterAbovePrayerIcon`, so it
 * must outrank the icon layer. Forced chat outranks everything here: a large or
 * offset counter must not cover speech. Hitsplats must outrank health and timer
 * bars when their rectangles overlap on short NPCs.
 *
 * A cutscene's fade to black outranks every layer, so it covers the scene's
 * prayers, bars and splats along with the scene.
 */
export const OVERLAY_LAYER_Z_INDEX = {
  healthBars: 1,
  timerBars: 2,
  hitsplats: 3,
  overheadIcons: 8,
  tickCounters: 9,
  overheadTexts: 10,
  cutsceneFade: 11,
} as const;

export interface TileMarkerLabelOverlay {
  screenX: number;
  screenY: number;
  text: string;
  color: string;
  key: string;
}

export interface RenderQueue {
  replayPresentationReady: boolean;
  clear?: { color: ColorRGBA };
  commands: RenderCommand[];
  overheadIcons?: OverheadIcon[];
  overheadTexts?: OverheadTextOverlay[];
  hitsplats?: HitsplatOverlay[];
  healthBars?: HealthBarOverlay[];
  timerBars?: TimerBarOverlay[];
  tickCounters?: TickCounterOverlay[];
  tileMarkerLabels?: TileMarkerLabelOverlay[];
  tick?: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
}

export function createQueue(clear?: ColorRGBA): RenderQueue {
  return {
    replayPresentationReady: true,
    clear: clear ? { color: clear } : undefined,
    commands: [],
  };
}

/**
 * Reset an existing queue for reuse, avoiding per-frame allocation.
 */
export function resetQueue(queue: RenderQueue, clear?: ColorRGBA): RenderQueue {
  queue.replayPresentationReady = true;
  queue.clear = clear ? { color: clear } : undefined;
  queue.commands.length = 0;
  queue.overheadIcons = undefined;
  queue.overheadTexts = undefined;
  queue.hitsplats = undefined;
  queue.healthBars = undefined;
  queue.timerBars = undefined;
  queue.tickCounters = undefined;
  queue.tileMarkerLabels = undefined;
  queue.tick = undefined;
  queue.brightness = undefined;
  queue.contrast = undefined;
  queue.saturation = undefined;
  return queue;
}
