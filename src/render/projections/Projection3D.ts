import { getMapSquareBlock, isTileInMapSquareBlock, type MapSquareBlockEntry } from '../../rs/map/mapSquareBlock';
import type { Camera3D, Projection2D, Viewport } from '../core/camera';
import { getRasterDimensions } from '../core/raster';
import type { TileCoord, Vec2, Vec3 } from '../core/types';
import { getTerrainHeight, getTerrainHeightInterpolated } from '../shared/renderUtils';

export interface OrbitCameraState {
  pitch: number;
  yaw: number;
  distance: number;
  /** The client's zoom value (scroll units, 128-896 in game), not a focal length: see {@link zoomToLensStrength}. */
  fovScale: number;
  targetX: number;
  targetY: number;
  targetZ: number;
}

export type RestoredOrbitCameraState = Omit<OrbitCameraState, 'distance'>;

export interface FreeformCameraState {
  posX: number;
  posY: number;
  posZ: number;
  pitch: number;
  yaw: number;
}

export interface OsrsCameraProjection {
  cameraX: number;
  cameraY: number;
  cameraZ: number;
  yawSin: number;
  yawCos: number;
  pitchSin: number;
  pitchCos: number;
}

export type CameraMode = 'orbit' | 'freeform';

/**
 * A view an encounter's cutscene holds the camera at (the server's `cam_moveto` / `cam_lookat`),
 * in world units: the eye and the point it looks at.
 */
export interface ScriptedCameraPose {
  readonly eye: Vec3;
  readonly lookAt: Vec3;
}

const DEG_TO_RAD = Math.PI / 180;

/**
 * OSRS near clip distance: 50 game units = 50/128 tiles.
 * The OSRS engine clips geometry closer than 50 units from the camera.
 */
const OSRS_NEAR_CLIP = 50 / 128;

// `viewportZoom = viewportHeight * lensStrength / 334`, blended per viewport height like the
// camera distance. Do not round the divisor.
export const OSRS_VIEWPORT_MAGIC = 334;
export const OSRS_DEFAULT_FOV_SCALE = 512;
export const OSRS_MIN_FOV_SCALE = 128;

/**
 * Orbit pitch the camera opens at, in degrees below the horizon.
 *
 * The camera opens at a pitch of 128 JAU, and a JAU is 1/2048 of a revolution, so
 * 22.5 degrees is its opening angle. Pitch is not only a viewing angle here:
 * `getOsrsCameraDistance` feeds on it, so raising this also lifts the eye — opening at 45
 * puts the camera more than twice as high above the player as the real client.
 */
export const OSRS_DEFAULT_PITCH = -22.5;
export const OSRS_MAX_FOV_SCALE = 896;
export const RUNELITE_OUTER_ZOOM_LIMIT_MIN = -400;
export const RUNELITE_OUTER_ZOOM_LIMIT_MAX = 400;

/**
 * The lens strength a zoom value projects with. Zoom is the game's own scale — what the
 * scroll wheel steps by 25 — and it maps to a focal length exponentially, so every notch
 * magnifies by the same ratio and 512 is the one value where the two agree. An integer, as
 * RuneLite's `getScale()` reads it. Measured in RuneLite:
 * `getScale()` reads 181 fully zoomed out and 1448 fully zoomed in at a 334px viewport.
 */
export function zoomToLensStrength(zoom: number): number {
  return Math.trunc(2 ** (zoom / 256 + 7));
}

// Exposed as a plain 0-8 strength rather than the zoom it becomes. Level 0 is the game's own
// ceiling exactly, so disabling the expansion is zero; each level adds half that ceiling's
// magnification, so level 8 magnifies five times as much as the game allows.
export const INNER_ZOOM_LEVEL_MIN = 0;
export const INNER_ZOOM_LEVEL_MAX = 8;

export function innerZoomLimitForLevel(level: number): number {
  // `clamp` cannot rescue a NaN — Math.max(1, NaN) is NaN — and a NaN ceiling is a
  // camera that projects nothing rather than one held at a bounded zoom.
  const bounded = Number.isFinite(level)
    ? clamp(Math.round(level), INNER_ZOOM_LEVEL_MIN, INNER_ZOOM_LEVEL_MAX)
    : INNER_ZOOM_LEVEL_MIN;
  return OSRS_MAX_FOV_SCALE + Math.round(256 * Math.log2(1 + bounded / 2));
}

export const INNER_ZOOM_LIMIT_MIN = OSRS_MAX_FOV_SCALE;
export const INNER_ZOOM_LIMIT_MAX = innerZoomLimitForLevel(INNER_ZOOM_LEVEL_MAX);

// Camera distance sizes, blended by viewport height between 334 and 434.
const OSRS_CAMERA_SIZE_SMALL = 256;
const OSRS_CAMERA_SIZE_BIG = 320;

// Unsourced tile bounds; measure before changing them.
const MIN_CAMERA_DISTANCE = 2;
const MAX_CAMERA_DISTANCE = 20;
// 383 JAU, the client's steepest pitch.
const DEFAULT_MIN_PITCH = (-383 * 360) / 2048;
const DEFAULT_MAX_PITCH = -22.5;
// RuneLite's "Expand pitch limit", measured in the client: 60 to 520 JAU. The top end is just
// past straight down, so the camera tips over the player to face slightly back.
const RELAXED_MIN_PITCH = (-520 * 360) / 2048;
const RELAXED_MAX_PITCH = (-60 * 360) / 2048;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pitchDegreesToJau(pitch: number): number {
  return Math.round((clamp(Math.abs(pitch), 0, 360) * 2048) / 360);
}

export function getOsrsCameraDistance(pitch: number, viewportHeight: number): number {
  // Integer throughout.
  const viewportBlend = clamp(Math.round(viewportHeight) - OSRS_VIEWPORT_MAGIC, 0, 100);
  const cameraSize =
    OSRS_CAMERA_SIZE_SMALL + Math.trunc(((OSRS_CAMERA_SIZE_BIG - OSRS_CAMERA_SIZE_SMALL) * viewportBlend) / 100);
  // Not clamped to the game's pitch range: under an expanded pitch limit the camera still
  // moves in and out past it.
  const pitchJau = clamp(pitchDegreesToJau(pitch), 60, 520);
  const distanceFine = Math.trunc((cameraSize * (600 + 3 * pitchJau)) / 256);
  return distanceFine / 128;
}

export function degreesToOsrsCameraYaw(degrees: number): number {
  return Math.round(((((degrees % 360) + 360) % 360) * 2048) / 360) & 2047;
}

const ORIGIN_SQUARE_BLOCK = getMapSquareBlock();

export class Projection3D implements Projection2D, Camera3D {
  private pitch: number;
  private yaw: number;
  private distance: number;
  private fovScale: number;
  private targetX: number;
  private targetY: number;
  private targetZ: number;
  viewport: Viewport;

  private cachedViewMatrix: number[] | null = null;
  private cachedProjMatrix: number[] | null = null;
  private cachedInvViewMatrix: number[] | null = null;
  private cachedInvProjMatrix: number[] | null = null;

  private cameraMode: CameraMode = 'orbit';
  private freeformPosX: number = 13;
  private freeformPosY: number = 10;
  private freeformPosZ: number = 15;
  private freeformPitch: number = -45;
  private freeformYaw: number = 0;

  private relaxPitchLimits: boolean = false;
  private innerZoomLimit: number = INNER_ZOOM_LIMIT_MIN;
  private outerZoomAdjust: number = 0;
  private distanceOverride: boolean = false;

  private terrainHeights: Int32Array[] | null = null;
  /** The squares a ray may pick a tile in: the displayed encounter's arena block. */
  private pickableBlock: readonly MapSquareBlockEntry[] = ORIGIN_SQUARE_BLOCK;
  private scriptedCamera: ScriptedCameraPose | null = null;
  /** Lowest pitch nearby high ground currently forces, in fine units (1/256 JAU). */
  private terrainPitchFloor = 0;

  private getOrbitCameraWorldPosition(): { x: number; y: number; z: number } {
    const pitchRad = Math.abs(this.getViewPitch()) * DEG_TO_RAD;
    const yawRad = this.yaw * DEG_TO_RAD;
    const cp = Math.cos(pitchRad);
    const sp = Math.sin(pitchRad);
    const sy = Math.sin(yawRad);
    const cy = Math.cos(yawRad);

    return {
      x: this.targetX + this.distance * cp * sy,
      y: this.targetY - this.distance * cp * cy,
      z: this.targetZ + this.distance * sp,
    };
  }

  /**
   * Hold the view at a cutscene's pose, or release it with null. The player's own orbit (or
   * freeform) camera is kept underneath and frozen against yaw, pitch and zoom input meanwhile,
   * as the game's cutscene camera ignores them, so release returns exactly to the view they had.
   * The follow target still tracks the player.
   */
  setScriptedCamera(pose: ScriptedCameraPose | null): void {
    const current = this.scriptedCamera;
    if (current === pose) return;
    if (
      current &&
      pose &&
      current.eye.x === pose.eye.x &&
      current.eye.y === pose.eye.y &&
      current.eye.z === pose.eye.z &&
      current.lookAt.x === pose.lookAt.x &&
      current.lookAt.y === pose.lookAt.y &&
      current.lookAt.z === pose.lookAt.z
    )
      return;
    this.scriptedCamera = pose;
    this.cachedViewMatrix = null;
    this.cachedInvViewMatrix = null;
  }

  getScriptedCamera(): ScriptedCameraPose | null {
    return this.scriptedCamera;
  }

  /** The scripted pose as the orbit camera's eye and angle terms (eye = lookAt + d * direction). */
  private scriptedViewTerms(pose: ScriptedCameraPose) {
    const dx = pose.eye.x - pose.lookAt.x;
    const dy = pose.eye.y - pose.lookAt.y;
    const dz = pose.eye.z - pose.lookAt.z;
    const horizontal = Math.hypot(dx, dy);
    const distance = Math.hypot(horizontal, dz) || 1;
    return {
      cp: horizontal / distance,
      sp: dz / distance,
      sy: horizontal > 0 ? dx / horizontal : 0,
      cy: horizontal > 0 ? -dy / horizontal : 1,
    };
  }

  getCameraWorldPosition(): Vec3 {
    if (this.scriptedCamera) return { ...this.scriptedCamera.eye };
    if (this.cameraMode === 'freeform') {
      return { x: this.freeformPosX, y: this.freeformPosY, z: this.freeformPosZ };
    }
    return this.getOrbitCameraWorldPosition();
  }

  getOsrsCameraProjection(): OsrsCameraProjection {
    const position = this.getCameraWorldPosition();
    if (this.scriptedCamera) {
      const { cp, sp, sy, cy } = this.scriptedViewTerms(this.scriptedCamera);
      return {
        cameraX: position.x * 128,
        cameraY: -position.z * 128,
        cameraZ: position.y * 128,
        yawSin: sy,
        yawCos: cy,
        pitchSin: sp,
        pitchCos: cp,
      };
    }
    const pitch = this.cameraMode === 'freeform' ? this.freeformPitch : this.getViewPitch();
    const yaw = this.cameraMode === 'freeform' ? this.freeformYaw : this.yaw;
    const pitchRad = (this.cameraMode === 'freeform' ? -pitch : Math.abs(pitch)) * DEG_TO_RAD;
    const yawRad = yaw * DEG_TO_RAD;

    return {
      cameraX: position.x * 128,
      cameraY: -position.z * 128,
      cameraZ: position.y * 128,
      yawSin: Math.sin(yawRad),
      yawCos: Math.cos(yawRad),
      pitchSin: Math.sin(pitchRad),
      pitchCos: Math.cos(pitchRad),
    };
  }

  constructor(viewport: Viewport, options: Partial<OrbitCameraState> = {}) {
    this.viewport = viewport;
    this.pitch = options.pitch ?? OSRS_DEFAULT_PITCH;
    this.yaw = options.yaw ?? 0;
    this.distanceOverride = options.distance !== undefined;
    this.distance = options.distance ?? this.getOsrsDistanceForCurrentViewport();
    // No limits are configured yet, so an opening zoom is held to the game's own range.
    this.fovScale = clamp(
      Math.round(options.fovScale ?? OSRS_DEFAULT_FOV_SCALE),
      OSRS_MIN_FOV_SCALE,
      OSRS_MAX_FOV_SCALE,
    );
    this.targetX = options.targetX ?? 13;
    this.targetY = options.targetY ?? 10;
    this.targetZ = options.targetZ ?? this.getFollowHeight();
  }

  setTerrainHeights(heights: Int32Array[] | null): void {
    this.terrainHeights = heights;
  }

  /**
   * Picking accepts tiles in these squares only (default: the origin square). A hole in a sparse
   * block is not pickable even though it lies inside the block's rectangle.
   */
  setPickableMapSquareBlock(block: readonly MapSquareBlockEntry[] = ORIGIN_SQUARE_BLOCK): void {
    this.pickableBlock = block;
  }

  private getTerrainHeightAt(tileX: number, tileY: number): number {
    return getTerrainHeight(this.terrainHeights, tileX, tileY);
  }

  private getTerrainHeightInterpolated(x: number, y: number): number {
    return getTerrainHeightInterpolated(this.terrainHeights, x, y);
  }

  getPlayerCenterZ(simTileX: number, simTileY: number): number {
    const terrainZ = -this.getTerrainHeightInterpolated(simTileX, simTileY) / 128;
    return terrainZ + this.getFollowHeight();
  }

  /**
   * The game computes this in integers as `25 + 25 * zoom / 256` from the zoom value, not the
   * lens strength, so the inner term truncates before the add. It runs on whatever zoom
   * RuneLite's expanded limits allow, and the follow height floors at 0.
   */
  getFollowHeight(): number {
    return Math.max(0, 25 + Math.trunc((25 * this.fovScale) / 256)) / 128;
  }

  updateCamera(state: Partial<OrbitCameraState>): void {
    // A cutscene holds the view: the player's angles and zoom wait for it to end (setScriptedCamera).
    if (this.scriptedCamera) {
      const { targetX, targetY, targetZ } = state;
      this.applyCameraUpdate({ targetX, targetY, targetZ });
      return;
    }
    this.applyCameraUpdate(state);
  }

  private applyCameraUpdate(state: Partial<OrbitCameraState>): void {
    if (state.pitch !== undefined) {
      const minPitch = this.relaxPitchLimits ? RELAXED_MIN_PITCH : DEFAULT_MIN_PITCH;
      const maxPitch = this.relaxPitchLimits ? RELAXED_MAX_PITCH : DEFAULT_MAX_PITCH;
      this.pitch = Math.max(minPitch, Math.min(maxPitch, state.pitch));
      if (!this.distanceOverride) {
        this.distance = this.getOsrsDistanceForCurrentViewport();
      }
    }
    if (state.yaw !== undefined) {
      this.yaw = state.yaw % 360;
    }
    if (state.distance !== undefined) {
      this.distanceOverride = true;
      this.distance = Math.max(MIN_CAMERA_DISTANCE, Math.min(MAX_CAMERA_DISTANCE, state.distance));
    }
    if (state.fovScale !== undefined) {
      this.fovScale = clamp(Math.round(state.fovScale), this.getMinFovScale(), this.getMaxFovScale());
    }
    if (state.targetX !== undefined) this.targetX = state.targetX;
    if (state.targetY !== undefined) this.targetY = state.targetY;
    if (state.targetZ !== undefined) this.targetZ = state.targetZ;
    this.invalidateMatrixCache();
  }

  // Recorded poses can exceed the viewer's live-control limits, so they are not clamped. The
  // distance is not part of a pose: it follows pitch exactly as it does in live play.
  restoreOrbitCamera(state: RestoredOrbitCameraState): void {
    // A recorded pitch already includes any terrain raise.
    this.pitch = state.pitch;
    this.terrainPitchFloor = 0;
    this.yaw = state.yaw;
    this.distanceOverride = false;
    this.distance = this.getOsrsDistanceForCurrentViewport();
    this.fovScale = state.fovScale;
    this.targetX = state.targetX;
    this.targetY = state.targetY;
    this.targetZ = state.targetZ;
    this.invalidateMatrixCache();
  }

  /**
   * The pitch the camera is drawn at: the player's own, or steeper where the client lifts it
   * over nearby high ground (see {@link stepTerrainPitch}). Replays record this one.
   */
  getViewPitch(): number {
    return Math.min(this.pitch, (-(this.terrainPitchFloor / 256) * 360) / 2048);
  }

  /**
   * Near higher ground the client steepens the camera so the land does not hide the player.
   * The tallest rise of any tile corner within 4 tiles of the focal tile, above the ground
   * at the focal point, sets a minimum pitch of half a JAU per height unit (up to 383 JAU).
   * The floor eases toward that each 20ms client cycle, 1/24 of the gap when rising and
   * 1/80 when falling, so it lifts quickly and settles back slowly.
   *
   * Measured in RuneLite with the game's pitch limits. With "Expand pitch limit" on, the
   * client settled lower on the same slope (280 JAU against 383), so the raise is weaker
   * there; this applies the same raise either way.
   */
  stepTerrainPitch(deltaMs: number): void {
    const target = this.getTerrainPitchFloorTarget();
    const current = this.terrainPitchFloor;
    if (target === current) return;
    const perCycle = target > current ? 1 / 24 : 1 / 80;
    const next = current + (target - current) * (1 - (1 - perCycle) ** (deltaMs / 20));
    this.terrainPitchFloor = Math.abs(target - next) < 1 ? target : next;
    if (!this.distanceOverride) this.distance = this.getOsrsDistanceForCurrentViewport();
    this.invalidateMatrixCache();
  }

  private getTerrainPitchFloorTarget(): number {
    const heights = this.terrainHeights;
    if (!heights) return 0;
    const tileX = Math.floor(this.targetX);
    const tileY = Math.floor(this.targetY);
    const focalHeight = this.getTerrainHeightInterpolated(this.targetX, this.targetY);
    let rise = 0;
    for (let x = tileX - 4; x <= tileX + 4; x++) {
      for (let y = tileY - 4; y <= tileY + 4; y++) {
        const height = heights[x]?.[y];
        if (height !== undefined) rise = Math.max(rise, focalHeight - height);
      }
    }
    return clamp(rise * 128, 0, 383 * 256);
  }

  setCameraLimits(options: { relaxPitch?: boolean; innerZoomLimit?: number; outerZoomAdjust?: number }): void {
    this.relaxPitchLimits = !!options.relaxPitch;
    this.innerZoomLimit = clamp(
      Math.round(options.innerZoomLimit ?? INNER_ZOOM_LIMIT_MIN),
      INNER_ZOOM_LIMIT_MIN,
      INNER_ZOOM_LIMIT_MAX,
    );
    this.outerZoomAdjust = clamp(
      options.outerZoomAdjust ?? 0,
      RUNELITE_OUTER_ZOOM_LIMIT_MIN,
      RUNELITE_OUTER_ZOOM_LIMIT_MAX,
    );

    this.applyCameraUpdate({ pitch: this.pitch, fovScale: this.fovScale });
    this.invalidateMatrixCache();
  }

  private getMinFovScale(): number {
    // RuneLite CameraPlugin.applyConfigs(): CAMERA_ZOOM_*_MIN = defaultMin - outerLimit.
    return OSRS_MIN_FOV_SCALE - this.outerZoomAdjust;
  }

  private getMaxFovScale(): number {
    // RuneLite CameraConfig.INNER_ZOOM_LIMIT replaces CAMERA_ZOOM_*_MAX. It is clamped
    // to OSRS_MAX_FOV_SCALE at its floor, so an unset limit is already the game's own.
    return this.innerZoomLimit;
  }

  private getOsrsDistanceForCurrentViewport(): number {
    // OSRS camera distance uses the visible game viewport height in the client's own
    // pixels. Browser DPR/renderScale only change backing-buffer fidelity, and a scaled
    // fixed frame only magnifies; neither may move the world-space camera.
    return getOsrsCameraDistance(this.getViewPitch(), this.viewport.logicalHeight ?? this.viewport.height);
  }

  private invalidateMatrixCache(): void {
    this.cachedViewMatrix = null;
    this.cachedProjMatrix = null;
    this.cachedInvViewMatrix = null;
    this.cachedInvProjMatrix = null;
  }

  updateViewport(viewport: Viewport): void {
    this.viewport = viewport;
    if (!this.distanceOverride) {
      this.distance = this.getOsrsDistanceForCurrentViewport();
    }
    this.cachedProjMatrix = null;
    this.cachedInvProjMatrix = null;
  }

  getCameraState(): OrbitCameraState {
    return {
      pitch: this.pitch,
      yaw: this.yaw,
      distance: this.distance,
      fovScale: this.fovScale,
      targetX: this.targetX,
      targetY: this.targetY,
      targetZ: this.targetZ,
    };
  }

  getCameraMode(): CameraMode {
    return this.cameraMode;
  }

  setCameraMode(mode: CameraMode): void {
    if (this.cameraMode === mode) return;

    if (mode === 'freeform') {
      const position = this.getOrbitCameraWorldPosition();
      this.freeformPosX = position.x;
      this.freeformPosY = position.y;
      this.freeformPosZ = position.z;
      this.freeformPitch = this.getViewPitch();
      this.freeformYaw = this.yaw;
    }

    this.cameraMode = mode;
    this.cachedViewMatrix = null;
    this.cachedInvViewMatrix = null;
  }

  getFreeformState(): FreeformCameraState {
    return {
      posX: this.freeformPosX,
      posY: this.freeformPosY,
      posZ: this.freeformPosZ,
      pitch: this.freeformPitch,
      yaw: this.freeformYaw,
    };
  }

  updateFreeformCamera(state: Partial<FreeformCameraState>): void {
    if (this.scriptedCamera) return;
    if (state.posX !== undefined) this.freeformPosX = state.posX;
    if (state.posY !== undefined) this.freeformPosY = state.posY;
    if (state.posZ !== undefined) this.freeformPosZ = Math.max(0.5, state.posZ);
    if (state.pitch !== undefined) this.freeformPitch = Math.max(-89, Math.min(89, state.pitch));
    if (state.yaw !== undefined) this.freeformYaw = state.yaw;
    this.cachedViewMatrix = null;
    this.cachedInvViewMatrix = null;
  }

  moveFreeform(forward: number, right: number, up: number): void {
    if (this.scriptedCamera) return;
    const yawRad = this.freeformYaw * DEG_TO_RAD;
    const forwardX = -Math.sin(yawRad);
    const forwardY = Math.cos(yawRad);
    const rightX = Math.cos(yawRad);
    const rightY = Math.sin(yawRad);

    this.freeformPosX += forwardX * forward + rightX * right;
    this.freeformPosY += forwardY * forward + rightY * right;
    this.freeformPosZ = Math.max(0.5, this.freeformPosZ + up);

    this.cachedViewMatrix = null;
    this.cachedInvViewMatrix = null;
  }

  viewMatrix(): Float32Array {
    return new Float32Array(this.getViewMatrix());
  }

  projectionMatrix(): Float32Array {
    return new Float32Array(this.getProjectionMatrix());
  }

  tileToScreen(tile: TileCoord): Vec2 | null {
    const worldPos = this.tileToWorld(tile);
    return this.projectToScreenOrNull(worldPos);
  }

  tileDeltaToScreen(delta: Vec2): Vec2 | null {
    // Project relative to the orbit camera target (the focal point) rather than
    // the world origin. In OSRS-style perspective the screen-space size of a
    // tile depends on depth, so the only meaningful "screen-space delta" is the
    // one measured at what the camera is looking at - and the world origin is
    // routinely behind the near clip when the player is far from [0,0].
    const originWorld = { x: this.targetX, y: this.targetY, z: this.targetZ };
    const offsetWorld = { x: this.targetX + delta.x, y: this.targetY + delta.y, z: this.targetZ };
    const origin = this.projectToScreenOrNull(originWorld);
    const offset = this.projectToScreenOrNull(offsetWorld);
    if (!origin || !offset) return null;
    return { x: offset.x - origin.x, y: offset.y - origin.y };
  }

  screenToTile(screenPx: Vec2): TileCoord | null {
    const ray = this.screenToRay(screenPx);
    if (!ray) return null;

    if (!this.terrainHeights) {
      if (ray.direction.z >= 0) return null;
      const t = -ray.origin.z / ray.direction.z;
      if (t < 0) return null;
      const hitX = ray.origin.x + ray.direction.x * t;
      const hitY = ray.origin.y + ray.direction.y * t;
      const tileX = Math.floor(hitX);
      const tileY = Math.floor(hitY);
      if (!isTileInMapSquareBlock(this.pickableBlock, tileX, tileY)) return null;
      return { x: tileX, y: tileY };
    }

    const stepSize = 0.2;
    const maxSteps = 300;

    for (let i = 0; i < maxSteps; i++) {
      const t = i * stepSize;
      const x = ray.origin.x + ray.direction.x * t;
      const y = ray.origin.y + ray.direction.y * t;
      const z = ray.origin.z + ray.direction.z * t;

      const tileX = Math.floor(x);
      const tileY = Math.floor(y);

      if (!isTileInMapSquareBlock(this.pickableBlock, tileX, tileY)) continue;

      const terrainZ = -this.getTerrainHeightAt(tileX, tileY) / 128;

      if (z <= terrainZ) {
        return { x: tileX, y: tileY };
      }
    }

    return null;
  }

  screenToTileEdge(screenPx: Vec2): { x: number; y: number; edge: 'north' | 'east' | 'south' | 'west' } | null {
    const tile = this.screenToTile(screenPx);
    if (!tile) return null;
    const { x, y } = tile;

    // World-space corners of the tile (SW-origin: integer tile spans
    // [x, x+1] x [y, y+1]), projected to screen with per-corner terrain height.
    const corner = (cx: number, cy: number): Vec2 | null => {
      const z = -this.getTerrainHeightInterpolated(cx, cy) / 128;
      return this.projectToScreenOrNull({ x: cx, y: cy, z });
    };
    const sw = corner(x, y);
    const se = corner(x + 1, y);
    const ne = corner(x + 1, y + 1);
    const nw = corner(x, y + 1);
    if (!sw || !se || !ne || !nw) return null;

    const edges: { edge: 'north' | 'east' | 'south' | 'west'; a: Vec2; b: Vec2 }[] = [
      { edge: 'south', a: sw, b: se },
      { edge: 'east', a: se, b: ne },
      { edge: 'north', a: nw, b: ne },
      { edge: 'west', a: sw, b: nw },
    ];

    let best: { edge: 'north' | 'east' | 'south' | 'west'; dist: number } | null = null;
    for (const { edge, a, b } of edges) {
      const dist = pointToSegmentDistance(screenPx, a, b);
      if (!best || dist < best.dist) best = { edge, dist };
    }
    return best ? { x, y, edge: best.edge } : null;
  }

  tilePolygonScreen(tile: TileCoord): Vec2[] {
    const x = tile.x;
    const y = tile.y;
    const level = tile.level;

    // Hand-unrolled and scalar-threaded because grid lines and arena boundaries call this across much of the arena every frame.
    // Allocating corner objects here creates significant per-frame garbage.
    const sw = this.projectWorldToScreenOrNull(x - 0.5, y - 0.5, level);
    if (!sw) return [];
    const se = this.projectWorldToScreenOrNull(x + 0.5, y - 0.5, level);
    if (!se) return [];
    const ne = this.projectWorldToScreenOrNull(x + 0.5, y + 0.5, level);
    if (!ne) return [];
    const nw = this.projectWorldToScreenOrNull(x - 0.5, y + 0.5, level);
    if (!nw) return [];

    return [sw, se, ne, nw];
  }

  private projectWorldToScreenOrNull(x: number, y: number, level: number | undefined): Vec2 | null {
    const z = level ?? -this.getTerrainHeightInterpolated(x, y) / 128;
    return this.projectScreenFromWorld(x, y, z);
  }

  tileToWorld(tile: TileCoord): Vec3 {
    return { x: tile.x, y: tile.y, z: tile.level ?? -this.getTerrainHeightInterpolated(tile.x, tile.y) / 128 };
  }

  private projectToScreenOrNull(world: { x: number; y: number; z: number }): Vec2 | null {
    return this.projectScreenFromWorld(world.x, world.y, world.z);
  }

  private projectScreenFromWorld(x: number, y: number, z: number): Vec2 | null {
    const view = this.getViewMatrix();
    const proj = this.getProjectionMatrix();

    const vx = view[0] * x + view[4] * y + view[8] * z + view[12];
    const vy = view[1] * x + view[5] * y + view[9] * z + view[13];
    const vz = view[2] * x + view[6] * y + view[10] * z + view[14];
    const vw = view[3] * x + view[7] * y + view[11] * z + view[15];

    if (-vz < OSRS_NEAR_CLIP) return null;

    const px = proj[0] * vx + proj[4] * vy + proj[8] * vz + proj[12] * vw;
    const py = proj[1] * vx + proj[5] * vy + proj[9] * vz + proj[13] * vw;
    const pw = proj[3] * vx + proj[7] * vy + proj[11] * vz + proj[15] * vw;

    if (pw <= 0) return null;
    const ndcX = px / pw;
    const ndcY = py / pw;

    const screenX = (ndcX + 1) * 0.5 * this.viewport.width;
    const screenY = (1 - ndcY) * 0.5 * this.viewport.height;

    return { x: screenX, y: screenY };
  }

  private getInverseViewMatrix(): number[] | null {
    if (this.cachedInvViewMatrix) return this.cachedInvViewMatrix;
    this.cachedInvViewMatrix = this.invertMatrix(this.getViewMatrix());
    return this.cachedInvViewMatrix;
  }

  private getInverseProjectionMatrix(): number[] | null {
    if (this.cachedInvProjMatrix) return this.cachedInvProjMatrix;
    this.cachedInvProjMatrix = this.invertMatrix(this.getProjectionMatrix());
    return this.cachedInvProjMatrix;
  }

  screenToRay(
    screenPx: Vec2,
  ): { origin: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } } | null {
    const ndcX = (screenPx.x / this.viewport.width) * 2 - 1;
    const ndcY = 1 - (screenPx.y / this.viewport.height) * 2;

    const invProj = this.getInverseProjectionMatrix();
    const invView = this.getInverseViewMatrix();
    if (!invProj || !invView) return null;

    // Reversed-Z: near plane is at NDC z=+1, far plane at NDC z=-1
    let nearX = invProj[0] * ndcX + invProj[4] * ndcY + invProj[8] * 1 + invProj[12];
    let nearY = invProj[1] * ndcX + invProj[5] * ndcY + invProj[9] * 1 + invProj[13];
    let nearZ = invProj[2] * ndcX + invProj[6] * ndcY + invProj[10] * 1 + invProj[14];
    const nearW = invProj[3] * ndcX + invProj[7] * ndcY + invProj[11] * 1 + invProj[15];
    if (nearW !== 0) {
      nearX /= nearW;
      nearY /= nearW;
      nearZ /= nearW;
    }
    let farX = invProj[0] * ndcX + invProj[4] * ndcY + invProj[8] * -1 + invProj[12];
    let farY = invProj[1] * ndcX + invProj[5] * ndcY + invProj[9] * -1 + invProj[13];
    let farZ = invProj[2] * ndcX + invProj[6] * ndcY + invProj[10] * -1 + invProj[14];
    const farW = invProj[3] * ndcX + invProj[7] * ndcY + invProj[11] * -1 + invProj[15];
    if (farW !== 0) {
      farX /= farW;
      farY /= farW;
      farZ /= farW;
    }

    const worldNearX = invView[0] * nearX + invView[4] * nearY + invView[8] * nearZ + invView[12];
    const worldNearY = invView[1] * nearX + invView[5] * nearY + invView[9] * nearZ + invView[13];
    const worldNearZ = invView[2] * nearX + invView[6] * nearY + invView[10] * nearZ + invView[14];

    const worldFarX = invView[0] * farX + invView[4] * farY + invView[8] * farZ + invView[12];
    const worldFarY = invView[1] * farX + invView[5] * farY + invView[9] * farZ + invView[13];
    const worldFarZ = invView[2] * farX + invView[6] * farY + invView[10] * farZ + invView[14];

    let dirX = worldFarX - worldNearX;
    let dirY = worldFarY - worldNearY;
    let dirZ = worldFarZ - worldNearZ;
    const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
    if (len > 0) {
      dirX /= len;
      dirY /= len;
      dirZ /= len;
    }

    return {
      origin: { x: worldNearX, y: worldNearY, z: worldNearZ },
      direction: { x: dirX, y: dirY, z: dirZ },
    };
  }

  getViewMatrix(): number[] {
    if (this.cachedViewMatrix) return this.cachedViewMatrix;

    let camX: number, camY: number, camZ: number;
    let cp: number, sp: number, cy: number, sy: number;

    if (this.scriptedCamera) {
      ({ cp, sp, sy, cy } = this.scriptedViewTerms(this.scriptedCamera));
      ({ x: camX, y: camY, z: camZ } = this.scriptedCamera.eye);
    } else if (this.cameraMode === 'freeform') {
      camX = this.freeformPosX;
      camY = this.freeformPosY;
      camZ = this.freeformPosZ;

      const pitchRad = -this.freeformPitch * DEG_TO_RAD;
      const yawRad = this.freeformYaw * DEG_TO_RAD;
      cp = Math.cos(pitchRad);
      sp = Math.sin(pitchRad);
      cy = Math.cos(yawRad);
      sy = Math.sin(yawRad);
    } else {
      const pitchRad = Math.abs(this.getViewPitch()) * DEG_TO_RAD;
      const yawRad = this.yaw * DEG_TO_RAD;
      cp = Math.cos(pitchRad);
      sp = Math.sin(pitchRad);
      cy = Math.cos(yawRad);
      sy = Math.sin(yawRad);

      const position = this.getOrbitCameraWorldPosition();
      camX = position.x;
      camY = position.y;
      camZ = position.z;
    }

    // Right-handed view matrix (det=+1) matching OSRS conventions.
    // At yaw=0: camera south of target, looking north. East=screen right.
    const rx = cy,
      ry = sy,
      rz = 0;
    const ux = -sp * sy,
      uy = sp * cy,
      uz = cp;
    const nfx = cp * sy,
      nfy = -cp * cy,
      nfz = sp;

    this.cachedViewMatrix = [
      rx,
      ux,
      nfx,
      0,
      ry,
      uy,
      nfy,
      0,
      rz,
      uz,
      nfz,
      0,
      -(rx * camX + ry * camY + rz * camZ),
      -(ux * camX + uy * camY + uz * camZ),
      -(nfx * camX + nfy * camY + nfz * camZ),
      1,
    ];

    return this.cachedViewMatrix;
  }

  getProjectionMatrix(): number[] {
    if (this.cachedProjMatrix) return this.cachedProjMatrix;

    // OSRS/RuneLite project directly with:
    //   screen = viewportCenter + cameraSpaceXY * viewportZoom / depth
    // where viewportZoom is computed from the raster viewport height.
    // Use the same integer coercion as canvas backing dimensions.
    const { width: rasterWidth, height: rasterHeight } = getRasterDimensions(this.viewport);
    const viewportZoom = Math.floor((rasterHeight * zoomToLensStrength(this.fovScale)) / OSRS_VIEWPORT_MAGIC);
    const near = OSRS_NEAR_CLIP;
    const far = 200;

    const sx = (2 * viewportZoom) / rasterWidth;
    const sy = (2 * viewportZoom) / rasterHeight;

    // Reversed-Z projection: near plane → NDC +1, far plane → NDC -1.
    // Matches RuneLite GPU plugin which uses glDepthFunc(GL_GREATER) + glClearDepth(0).
    // This gives far better depth precision for close geometry (cape symbols, etc.)
    // and matches how OSRS face bias values are designed to work.
    const nf = 1 / (far - near);
    this.cachedProjMatrix = [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];

    return this.cachedProjMatrix;
  }

  private invertMatrix(m: number[]): number[] | null {
    const inv = new Array(16);

    inv[0] =
      m[5] * m[10] * m[15] -
      m[5] * m[11] * m[14] -
      m[9] * m[6] * m[15] +
      m[9] * m[7] * m[14] +
      m[13] * m[6] * m[11] -
      m[13] * m[7] * m[10];
    inv[4] =
      -m[4] * m[10] * m[15] +
      m[4] * m[11] * m[14] +
      m[8] * m[6] * m[15] -
      m[8] * m[7] * m[14] -
      m[12] * m[6] * m[11] +
      m[12] * m[7] * m[10];
    inv[8] =
      m[4] * m[9] * m[15] -
      m[4] * m[11] * m[13] -
      m[8] * m[5] * m[15] +
      m[8] * m[7] * m[13] +
      m[12] * m[5] * m[11] -
      m[12] * m[7] * m[9];
    inv[12] =
      -m[4] * m[9] * m[14] +
      m[4] * m[10] * m[13] +
      m[8] * m[5] * m[14] -
      m[8] * m[6] * m[13] -
      m[12] * m[5] * m[10] +
      m[12] * m[6] * m[9];
    inv[1] =
      -m[1] * m[10] * m[15] +
      m[1] * m[11] * m[14] +
      m[9] * m[2] * m[15] -
      m[9] * m[3] * m[14] -
      m[13] * m[2] * m[11] +
      m[13] * m[3] * m[10];
    inv[5] =
      m[0] * m[10] * m[15] -
      m[0] * m[11] * m[14] -
      m[8] * m[2] * m[15] +
      m[8] * m[3] * m[14] +
      m[12] * m[2] * m[11] -
      m[12] * m[3] * m[10];
    inv[9] =
      -m[0] * m[9] * m[15] +
      m[0] * m[11] * m[13] +
      m[8] * m[1] * m[15] -
      m[8] * m[3] * m[13] -
      m[12] * m[1] * m[11] +
      m[12] * m[3] * m[9];
    inv[13] =
      m[0] * m[9] * m[14] -
      m[0] * m[10] * m[13] -
      m[8] * m[1] * m[14] +
      m[8] * m[2] * m[13] +
      m[12] * m[1] * m[10] -
      m[12] * m[2] * m[9];
    inv[2] =
      m[1] * m[6] * m[15] -
      m[1] * m[7] * m[14] -
      m[5] * m[2] * m[15] +
      m[5] * m[3] * m[14] +
      m[13] * m[2] * m[7] -
      m[13] * m[3] * m[6];
    inv[6] =
      -m[0] * m[6] * m[15] +
      m[0] * m[7] * m[14] +
      m[4] * m[2] * m[15] -
      m[4] * m[3] * m[14] -
      m[12] * m[2] * m[7] +
      m[12] * m[3] * m[6];
    inv[10] =
      m[0] * m[5] * m[15] -
      m[0] * m[7] * m[13] -
      m[4] * m[1] * m[15] +
      m[4] * m[3] * m[13] +
      m[12] * m[1] * m[7] -
      m[12] * m[3] * m[5];
    inv[14] =
      -m[0] * m[5] * m[14] +
      m[0] * m[6] * m[13] +
      m[4] * m[1] * m[14] -
      m[4] * m[2] * m[13] -
      m[12] * m[1] * m[6] +
      m[12] * m[2] * m[5];
    inv[3] =
      -m[1] * m[6] * m[11] +
      m[1] * m[7] * m[10] +
      m[5] * m[2] * m[11] -
      m[5] * m[3] * m[10] -
      m[9] * m[2] * m[7] +
      m[9] * m[3] * m[6];
    inv[7] =
      m[0] * m[6] * m[11] -
      m[0] * m[7] * m[10] -
      m[4] * m[2] * m[11] +
      m[4] * m[3] * m[10] +
      m[8] * m[2] * m[7] -
      m[8] * m[3] * m[6];
    inv[11] =
      -m[0] * m[5] * m[11] +
      m[0] * m[7] * m[9] +
      m[4] * m[1] * m[11] -
      m[4] * m[3] * m[9] -
      m[8] * m[1] * m[7] +
      m[8] * m[3] * m[5];
    inv[15] =
      m[0] * m[5] * m[10] -
      m[0] * m[6] * m[9] -
      m[4] * m[1] * m[10] +
      m[4] * m[2] * m[9] +
      m[8] * m[1] * m[6] -
      m[8] * m[2] * m[5];

    let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
    if (det === 0) return null;

    det = 1 / det;
    for (let i = 0; i < 16; i++) inv[i] *= det;

    return inv;
  }
}

export function createProjection3D(viewport: Viewport, options?: Partial<OrbitCameraState>): Projection3D {
  return new Projection3D(viewport, options);
}

export function pointToSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const px = p.x - a.x;
    const py = p.y - a.y;
    return Math.sqrt(px * px + py * py);
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  const ex = p.x - cx;
  const ey = p.y - cy;
  return Math.sqrt(ex * ex + ey * ey);
}
