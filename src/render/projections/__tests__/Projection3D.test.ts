import { describe, expect, it } from 'vitest';
import { getMapSquareBlock } from '../../../rs/map/mapSquareBlock';
import type { Viewport } from '../../core/camera';
import { getBackingStoreDimensions, getRasterDimensions } from '../../core/raster';
import type { Vec2 } from '../../core/types';
import { composeTerrainHeights } from '../../shared/renderUtils';
import {
  createProjection3D,
  degreesToOsrsCameraYaw,
  getOsrsCameraDistance,
  INNER_ZOOM_LEVEL_MAX,
  INNER_ZOOM_LEVEL_MIN,
  INNER_ZOOM_LIMIT_MAX,
  INNER_ZOOM_LIMIT_MIN,
  innerZoomLimitForLevel,
  OSRS_DEFAULT_PITCH,
  OSRS_MAX_FOV_SCALE,
  OSRS_MIN_FOV_SCALE,
  type Projection3D,
  RUNELITE_OUTER_ZOOM_LIMIT_MAX,
  RUNELITE_OUTER_ZOOM_LIMIT_MIN,
  zoomToLensStrength,
} from '../Projection3D';

/** 2048 angle units = full revolution */
const RS_ANGLE_UNITS = 2048;
const RS_TO_RAD = (2 * Math.PI) / RS_ANGLE_UNITS;

function rsSin(jau: number): number {
  return Math.sin(jau * RS_TO_RAD);
}
function rsCos(jau: number): number {
  return Math.cos(jau * RS_TO_RAD);
}

const OSRS_VIEWPORT_MAGIC = 334;

/** `zoom` is the client's zoom value; its lens strength is `2^(zoom / 256 + 7)`, truncated. */
function osrsViewportZoom(viewportHeight: number, zoom: number): number {
  const lensStrength = Math.trunc(2 ** (zoom / 256 + 7));
  return Math.floor((viewportHeight * lensStrength) / OSRS_VIEWPORT_MAGIC);
}

// Independent reference translated from RuneLite Perspective.localToCanvasCpu().
function osrsWorldToScreen(
  worldX: number,
  worldY: number,
  worldZ: number,
  cameraX: number,
  cameraY: number,
  cameraZ: number,
  cameraPitch: number,
  cameraYaw: number,
  viewportWidth: number,
  viewportHeight: number,
  viewportZoom: number,
): { x: number; y: number } | null {
  const x = worldX - cameraX;
  const y = worldY - cameraY;
  const z = worldZ - cameraZ;

  const yawSin = rsSin(cameraYaw);
  const yawCos = rsCos(cameraYaw);
  const x1 = x * yawCos + y * yawSin;
  const y1 = y * yawCos - x * yawSin;

  const pitchSin = rsSin(cameraPitch);
  const pitchCos = rsCos(cameraPitch);
  const y2 = z * pitchCos - y1 * pitchSin;
  const z1 = y1 * pitchCos + z * pitchSin;

  if (z1 < 50) return null;

  const screenX = viewportWidth / 2 + (x1 * viewportZoom) / z1;
  const screenY = viewportHeight / 2 + (y2 * viewportZoom) / z1;

  return { x: screenX, y: screenY };
}

function transformWorldByMatrix(
  matrix: number[],
  world: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  return {
    x: matrix[0] * world.x + matrix[4] * world.y + matrix[8] * world.z + matrix[12],
    y: matrix[1] * world.x + matrix[5] * world.y + matrix[9] * world.z + matrix[13],
    z: matrix[2] * world.x + matrix[6] * world.y + matrix[10] * world.z + matrix[14],
  };
}

describe('Projection3D — OSRS camera accuracy', () => {
  describe('zoom to lens strength', () => {
    it("converts the client's zoom value exponentially, agreeing with it only at 512", () => {
      expect(zoomToLensStrength(OSRS_MIN_FOV_SCALE)).toBe(181);
      expect(zoomToLensStrength(512)).toBe(512);
      expect(zoomToLensStrength(OSRS_MAX_FOV_SCALE)).toBe(1448);
    });

    it('magnifies every scroll notch by the same ratio', () => {
      const ratio = zoomToLensStrength(537) / zoomToLensStrength(512);
      expect(zoomToLensStrength(162) / zoomToLensStrength(137)).toBeCloseTo(ratio, 2);
      expect(zoomToLensStrength(887) / zoomToLensStrength(862)).toBeCloseTo(ratio, 2);
    });

    it("stays a positive lens at RuneLite's widest outer limit", () => {
      expect(zoomToLensStrength(OSRS_MIN_FOV_SCALE - RUNELITE_OUTER_ZOOM_LIMIT_MAX)).toBe(61);
    });

    it("matches RuneLite's measured scale at other viewport heights, whatever the width", () => {
      for (const [width, height, scale] of [
        [1600, 503, 272],
        [765, 900, 487],
      ]) {
        const cam = createProjection3D({ width, height, dpr: 1 });
        cam.updateCamera({ fovScale: OSRS_MIN_FOV_SCALE });
        expect(cam.getProjectionMatrix()[5]).toBeCloseTo((2 * scale) / height, 12);
      }
    });

    it('projects with the lens strength, not the zoom value', () => {
      const cam = createProjection3D({ width: 800, height: 334, dpr: 1 });
      cam.updateCamera({ fovScale: OSRS_MIN_FOV_SCALE });
      // In a 334-high viewport the screen scale equals the lens strength.
      expect(cam.getProjectionMatrix()[5]).toBeCloseTo((2 * 181) / 334, 12);
    });
  });

  describe('camera distance', () => {
    it('keeps following pitch past the game range under an expanded pitch limit', () => {
      // Measured in RuneLite at a 334px viewport: 766 and -53 units horizontally.
      expect(getOsrsCameraDistance((-60 * 360) / 2048, 334) * 128).toBe(780);
      expect(getOsrsCameraDistance((-520 * 360) / 2048, 334) * 128).toBe(2160);
    });

    it('tips the camera over the player at the top of the expanded range', () => {
      const cam = createProjection3D({ width: 800, height: 334, dpr: 1 }, { yaw: 180, targetX: 50.5, targetY: 50.5 });
      cam.setCameraLimits({ relaxPitch: true });
      cam.updateCamera({ pitch: -100 });
      // At the game's pitches this yaw puts the camera north of the player; past straight down it
      // swings to the south side, as RuneLite's reading (52 units south) shows.
      expect((cam.getCameraWorldPosition().y - 50.5) * 128).toBeCloseTo(2160 * Math.cos((520 * Math.PI) / 1024), 6);
      expect(cam.getCameraWorldPosition().y).toBeLessThan(50.5);
    });

    it('matches the client in integer units in a fixed-size viewport', () => {
      expect(getOsrsCameraDistance(-22.5, 334) * 128).toBe(984);
      expect(getOsrsCameraDistance((-383 * 360) / 2048, 334) * 128).toBe(1749);
    });
  });

  describe('viewport zoom formula', () => {
    it('matches OSRS viewportZoom = floor(height * fovScale / 334)', () => {
      const fovScale = 512;

      const testCases = [
        { height: 334, expected: Math.floor((334 * 512) / 334) },
        { height: 503, expected: Math.floor((503 * 512) / 334) },
        { height: 600, expected: Math.floor((600 * 512) / 334) },
        { height: 768, expected: Math.floor((768 * 512) / 334) },
        { height: 1080, expected: Math.floor((1080 * 512) / 334) },
      ];

      for (const { height, expected } of testCases) {
        expect(osrsViewportZoom(height, fovScale)).toBe(expected);
      }
    });

    it('produces correct FOV from viewport zoom', () => {
      const fovScale = 512;
      const height = 334;
      const zoom = osrsViewportZoom(height, fovScale);
      const fov = 2 * Math.atan(height / (2 * zoom));
      const fovDeg = (fov * 180) / Math.PI;

      expect(fovDeg).toBeCloseTo(36.1, 0);
    });

    it('our projection uses the OSRS viewport zoom formula', () => {
      const viewport: Viewport = { width: 800, height: 600, dpr: 1 };
      const cam = createProjection3D(viewport);

      const proj = cam.getProjectionMatrix();
      const zoom = osrsViewportZoom(600, 512);

      expect(proj[0]).toBeCloseTo((2 * zoom) / 800, 12);
      expect(proj[5]).toBeCloseTo((2 * zoom) / 600, 12);
    });

    it('floors viewport zoom at raster size for high-DPI canvases', () => {
      const viewport: Viewport = { width: 800, height: 600, dpr: 1.5 };
      const cam = createProjection3D(viewport);
      const proj = cam.getProjectionMatrix();

      const { width: rasterWidth, height: rasterHeight } = getRasterDimensions(viewport);
      const zoom = osrsViewportZoom(rasterHeight, 512);

      expect(proj[0]).toBeCloseTo((2 * zoom) / rasterWidth, 12);
      expect(proj[5]).toBeCloseTo((2 * zoom) / rasterHeight, 12);
    });

    it('uses the same integer coercion as canvas backing dimensions for fractional DPR', () => {
      const viewport: Viewport = { width: 301, height: 201, dpr: 1.5 };
      const cam = createProjection3D(viewport);
      const proj = cam.getProjectionMatrix();

      const { width: rasterWidth, height: rasterHeight } = getRasterDimensions(viewport);
      const zoom = osrsViewportZoom(rasterHeight, 512);

      expect(rasterWidth).toBe(451);
      expect(rasterHeight).toBe(301);
      expect(proj[0]).toBeCloseTo((2 * zoom) / rasterWidth, 12);
      expect(proj[5]).toBeCloseTo((2 * zoom) / rasterHeight, 12);
    });

    it('frames a stretched canvas exactly as an unstretched one: only the backing store follows paintScale', () => {
      const viewport: Viewport = { width: 1102, height: 721, dpr: 2 };
      const stretched: Viewport = { ...viewport, paintScale: { x: 1.17, y: 1 } };
      expect(createProjection3D(stretched).getProjectionMatrix()).toEqual(
        createProjection3D(viewport).getProjectionMatrix(),
      );
      expect(getBackingStoreDimensions(stretched)).toEqual({ width: Math.floor(1102 * 2 * 1.17), height: 1442 });
      expect(getBackingStoreDimensions(viewport)).toEqual(getRasterDimensions(viewport));
    });

    it('clamps fractional zero-DPR raster dimensions to a finite projection matrix', () => {
      // A hidden or zero-sized viewport must not poison the projection math:
      // raster dims floor to 0 without the helper's clamp, producing NaN/Infinity.
      const cam = createProjection3D({ width: 0, height: 0, dpr: 0 });
      const proj = cam.getProjectionMatrix();

      for (const value of proj) {
        expect(Number.isFinite(value)).toBe(true);
      }
    });

    it('projects tile deltas relative to the camera target so far-from-origin scenes still render', () => {
      const cam = createProjection3D(
        { width: 800, height: 600, dpr: 1 },
        {
          pitch: -45,
          yaw: 180,
          targetX: 31,
          targetY: 37,
        },
      );

      const delta = cam.tileDeltaToScreen({ x: 0, y: -2 });

      expect(delta).not.toBeNull();
      expect(Number.isFinite(delta!.x)).toBe(true);
      expect(Number.isFinite(delta!.y)).toBe(true);
    });

    it('FOV is viewport-size-independent (constant for given fovScale)', () => {
      const cam1 = createProjection3D({ width: 800, height: 400, dpr: 1 });
      const cam2 = createProjection3D({ width: 1920, height: 1080, dpr: 1 });

      const f1 = cam1.getProjectionMatrix()[5];
      const f2 = cam2.getProjectionMatrix()[5];
      const fov1 = (2 * Math.atan(1 / f1) * 180) / Math.PI;
      const fov2 = (2 * Math.atan(1 / f2) * 180) / Math.PI;

      // Should be within ~0.2° due to floor() quantization
      expect(Math.abs(fov1 - fov2)).toBeLessThan(0.2);
    });
  });

  describe('camera distance formula', () => {
    it('uses OSRS camera distance from viewport height and pitch when no override is supplied', () => {
      const viewport: Viewport = { width: 800, height: 600, dpr: 1 };
      const cam = createProjection3D(viewport, { pitch: -45 });

      expect(cam.getCameraState().distance).toBeCloseTo(getOsrsCameraDistance(-45, 600), 6);
    });

    it('does not let render scale / DPR change OSRS world-space camera distance', () => {
      const visibleViewport: Viewport = { width: 800, height: 360, dpr: 2 };
      const cam = createProjection3D(visibleViewport, { pitch: -45 });

      expect(cam.getCameraState().distance).toBeCloseTo(getOsrsCameraDistance(-45, 360), 6);
      expect(cam.getCameraState().distance).not.toBeCloseTo(getOsrsCameraDistance(-45, 720), 6);

      cam.updateViewport({ width: 800, height: 380, dpr: 3 });
      expect(cam.getCameraState().distance).toBeCloseTo(getOsrsCameraDistance(-45, 380), 6);
      expect(cam.getCameraState().distance).not.toBeCloseTo(getOsrsCameraDistance(-45, 1140), 6);
    });

    it('updates OSRS camera distance when pitch changes without a distance override', () => {
      const cam = createProjection3D({ width: 800, height: 600, dpr: 1 }, { pitch: -45 });

      cam.updateCamera({ pitch: -60 });

      expect(cam.getCameraState().distance).toBeCloseTo(getOsrsCameraDistance(-60, 600), 6);
    });

    it('preserves explicit distance overrides for non-OSRS camera modes', () => {
      const cam = createProjection3D({ width: 800, height: 600, dpr: 1 }, { pitch: -45, distance: 15 });

      cam.updateCamera({ pitch: -60 });

      expect(cam.getCameraState().distance).toBe(15);
    });

    it('opens at a given zoom without moving the camera off the pitch-driven distance', () => {
      const cam = createProjection3D({ width: 800, height: 600, dpr: 1 }, { pitch: -45, fovScale: 212 });

      expect(cam.getCameraState().fovScale).toBe(212);
      expect(cam.getCameraState().distance).toBeCloseTo(getOsrsCameraDistance(-45, 600), 6);

      cam.updateCamera({ pitch: -60 });
      expect(cam.getCameraState().distance).toBeCloseTo(getOsrsCameraDistance(-60, 600), 6);
    });

    it("holds an opening zoom to the game's own range", () => {
      const viewport: Viewport = { width: 800, height: 600, dpr: 1 };
      expect(createProjection3D(viewport, { fovScale: 20 }).getCameraState().fovScale).toBe(OSRS_MIN_FOV_SCALE);
      expect(createProjection3D(viewport, { fovScale: 4000 }).getCameraState().fovScale).toBe(OSRS_MAX_FOV_SCALE);
    });
  });

  describe('OSRS camera transform', () => {
    it('uses OSRS camera yaw cardinal directions', () => {
      const viewport: Viewport = { width: 800, height: 600, dpr: 1 };
      const pitch = -45;
      const distance = getOsrsCameraDistance(pitch, viewport.height);
      const target = { targetX: 31.5, targetY: 37.5, targetZ: 75 / 128 };

      const north = createProjection3D(viewport, { ...target, pitch, yaw: 0 });
      expect(north.getCameraWorldPosition().x).toBeCloseTo(target.targetX, 6);
      expect(north.getCameraWorldPosition().y).toBeCloseTo(
        target.targetY - distance * Math.cos((Math.abs(pitch) * Math.PI) / 180),
        6,
      );

      const west = createProjection3D(viewport, { ...target, pitch, yaw: 90 });
      expect(west.getCameraWorldPosition().x).toBeCloseTo(
        target.targetX + distance * Math.cos((Math.abs(pitch) * Math.PI) / 180),
        6,
      );
      expect(west.getCameraWorldPosition().y).toBeCloseTo(target.targetY, 6);

      const south = createProjection3D(viewport, { ...target, pitch, yaw: 180 });
      expect(south.getCameraWorldPosition().x).toBeCloseTo(target.targetX, 6);
      expect(south.getCameraWorldPosition().y).toBeCloseTo(
        target.targetY + distance * Math.cos((Math.abs(pitch) * Math.PI) / 180),
        6,
      );

      const east = createProjection3D(viewport, { ...target, pitch, yaw: 270 });
      expect(east.getCameraWorldPosition().x).toBeCloseTo(
        target.targetX - distance * Math.cos((Math.abs(pitch) * Math.PI) / 180),
        6,
      );
      expect(east.getCameraWorldPosition().y).toBeCloseTo(target.targetY, 6);
    });

    it('keeps freeform forward and right movement aligned with the view yaw', () => {
      const cam = createProjection3D({ width: 800, height: 600, dpr: 1 });
      cam.setCameraMode('freeform');
      const cases = [
        { yaw: 0, forward: [0, 1], right: [1, 0] },
        { yaw: 90, forward: [-1, 0], right: [0, 1] },
        { yaw: 180, forward: [0, -1], right: [-1, 0] },
        { yaw: 270, forward: [1, 0], right: [0, -1] },
      ] as const;

      for (const { yaw, forward, right } of cases) {
        cam.updateFreeformCamera({ posX: 0, posY: 0, posZ: 10, pitch: 0, yaw });
        cam.moveFreeform(1, 0, 0);
        expect(cam.getFreeformState().posX).toBeCloseTo(forward[0], 6);
        expect(cam.getFreeformState().posY).toBeCloseTo(forward[1], 6);

        cam.updateFreeformCamera({ posX: 0, posY: 0 });
        cam.moveFreeform(0, 1, 0);
        expect(cam.getFreeformState().posX).toBeCloseTo(right[0], 6);
        expect(cam.getFreeformState().posY).toBeCloseTo(right[1], 6);
      }
    });

    it('allows freeform pitch to look above the horizon', () => {
      const cam = createProjection3D({ width: 800, height: 600, dpr: 1 });
      cam.setCameraMode('freeform');
      cam.updateFreeformCamera({ pitch: 45 });

      const centerRay = cam.screenToRay({ x: 400, y: 300 });

      expect(centerRay).not.toBeNull();
      expect(centerRay?.direction.z).toBeGreaterThan(0);
    });

    it('projects the camera focal point to viewport center', () => {
      const viewport: Viewport = { width: 800, height: 600, dpr: 1 };
      const cam = createProjection3D(viewport, {
        pitch: -45,
        yaw: 90,
        targetX: 31.5,
        targetY: 37.5,
        targetZ: 75 / 128,
      });

      const view = cam.getViewMatrix();
      const focusCamera = transformWorldByMatrix(view, { x: 31.5, y: 37.5, z: 75 / 128 });

      expect(focusCamera.x).toBeCloseTo(0, 6);
      expect(focusCamera.y).toBeCloseTo(0, 6);
      expect(focusCamera.z).toBeLessThan(0);
    });

    it('matches RuneLite worldToScreen for the same camera globals', () => {
      const viewport: Viewport = { width: 800, height: 600, dpr: 1 };
      const cam = createProjection3D(viewport, {
        pitch: -45,
        yaw: 90,
        targetX: 31.5,
        targetY: 37.5,
        targetZ: 75 / 128,
      });
      const state = cam.getCameraState();
      const camera = cam.getCameraWorldPosition();
      const point = { x: 30.5, y: 37.5, z: 75 / 128 };

      const view = cam.getViewMatrix();
      const proj = cam.getProjectionMatrix();
      const cameraPoint = transformWorldByMatrix(view, point);
      const clipX = proj[0] * cameraPoint.x;
      const clipY = proj[5] * cameraPoint.y;
      const clipW = -cameraPoint.z;
      const actual = {
        x: (clipX / clipW + 1) * 0.5 * viewport.width,
        y: (1 - clipY / clipW) * 0.5 * viewport.height,
      };

      const expected = osrsWorldToScreen(
        point.x * 128,
        point.y * 128,
        -point.z * 128,
        camera.x * 128,
        camera.y * 128,
        -camera.z * 128,
        Math.round((Math.abs(state.pitch) * RS_ANGLE_UNITS) / 360),
        degreesToOsrsCameraYaw(state.yaw),
        viewport.width,
        viewport.height,
        osrsViewportZoom(viewport.height, state.fovScale),
      );

      expect(expected).not.toBeNull();
      expect(actual.x).toBeCloseTo(expected!.x, 6);
      expect(actual.y).toBeCloseTo(expected!.y, 6);
    });

    it('exports OSRS sorter camera globals with matching signs', () => {
      const viewport: Viewport = { width: 800, height: 600, dpr: 1 };
      const cam = createProjection3D(viewport, {
        pitch: -45,
        yaw: 90,
        targetX: 31.5,
        targetY: 37.5,
        targetZ: 75 / 128,
      });
      const position = cam.getCameraWorldPosition();
      const sorter = cam.getOsrsCameraProjection();

      expect(sorter.cameraX).toBeCloseTo(position.x * 128, 6);
      expect(sorter.cameraY).toBeCloseTo(-position.z * 128, 6);
      expect(sorter.cameraZ).toBeCloseTo(position.y * 128, 6);
      expect(sorter.yawSin).toBeCloseTo(1, 6);
      expect(sorter.yawCos).toBeCloseTo(0, 6);
      expect(sorter.pitchSin).toBeCloseTo(Math.sin((45 * Math.PI) / 180), 6);
      expect(sorter.pitchCos).toBeCloseTo(Math.cos((45 * Math.PI) / 180), 6);
    });
  });

  describe('pitch clamp range', () => {
    it('matches OSRS scene pitch clamp of 128..383 JAU', () => {
      const minPitchDeg = (128 * 360) / RS_ANGLE_UNITS;
      const maxPitchDeg = (383 * 360) / RS_ANGLE_UNITS;

      expect(minPitchDeg).toBeCloseTo(22.5, 4);
      expect(maxPitchDeg).toBeCloseTo(67.324, 1);
    });

    it('clamps pitch to OSRS range (min: ~-22.5°)', () => {
      const cam = createProjection3D({ width: 800, height: 600, dpr: 1 });

      cam.updateCamera({ pitch: -10 });
      const state = cam.getCameraState();
      expect(state.pitch).toBe(-22.5);
    });

    it('clamps pitch to OSRS range (max: 383 JAU, ~-67.32°)', () => {
      const cam = createProjection3D({ width: 800, height: 600, dpr: 1 });

      cam.updateCamera({ pitch: -85 });
      const state = cam.getCameraState();
      expect(state.pitch).toBe((-383 * 360) / 2048);
    });

    it('accepts pitch within OSRS range', () => {
      const cam = createProjection3D({ width: 800, height: 600, dpr: 1 });

      cam.updateCamera({ pitch: -45 });
      expect(cam.getCameraState().pitch).toBe(-45);

      cam.updateCamera({ pitch: -30 });
      expect(cam.getCameraState().pitch).toBe(-30);

      cam.updateCamera({ pitch: -60 });
      expect(cam.getCameraState().pitch).toBe(-60);
    });
  });

  describe('near clip plane', () => {
    it('uses OSRS near clip of 50 game units = 50/128 tiles', () => {
      const cam = createProjection3D({ width: 800, height: 600, dpr: 1 });

      const proj = cam.getProjectionMatrix();
      const near_far_term = proj[14];

      const expectedNear = 50 / 128;
      const far = 200;
      const expectedProj14 = (2 * far * expectedNear) / (far - expectedNear);
      expect(near_far_term).toBeCloseTo(expectedProj14, 4);
    });
  });

  describe('projection matches OSRS worldToScreen', () => {
    it('projects a point to the same screen position as OSRS software renderer', () => {
      const viewport: Viewport = { width: 800, height: 600, dpr: 1 };
      const cam = createProjection3D(viewport, {
        pitch: -45,
        yaw: 180,
        distance: 600 / 128,
        targetX: 31,
        targetY: 37,
        targetZ: 0,
      });

      const state = cam.getCameraState();
      const pitchRad = (state.pitch * Math.PI) / 180;
      const yawRad = (state.yaw * Math.PI) / 180;
      const camX = state.targetX + state.distance * Math.cos(Math.abs(pitchRad)) * Math.sin(yawRad);
      const camY = state.targetY - state.distance * Math.cos(Math.abs(pitchRad)) * Math.cos(yawRad);
      const camZ = state.targetZ + state.distance * Math.sin(Math.abs(pitchRad));

      const osrsCamX = camX * 128;
      const osrsCamY = camY * 128;
      const osrsCamZ = -camZ * 128; // OSRS: negative height = up

      // Our yaw=180° means looking south. OSRS camera yaw 1024 = south.
      // Our pitch=-45° → OSRS scene pitch ≈ 256 JAU
      // pitch in degrees = scenePitch * 360/2048, so scenePitch = degrees * 2048/360
      const osrsPitch = Math.round((Math.abs(state.pitch) * RS_ANGLE_UNITS) / 360);
      // Camera yaw projection convention: 0=north, 512=west, 1024=south, 1536=east.
      const osrsYaw = degreesToOsrsCameraYaw(state.yaw);

      const zoom = osrsViewportZoom(600, 512);

      const testX = 31 * 128 + 64;
      const testY = 37 * 128 + 64;
      const testZ = 0;

      const osrsResult = osrsWorldToScreen(
        testX,
        testY,
        testZ,
        osrsCamX,
        osrsCamY,
        osrsCamZ,
        osrsPitch,
        osrsYaw,
        800,
        600,
        zoom,
      );

      expect(osrsResult).not.toBeNull();
    });
  });

  describe('OSRS reference constants', () => {
    it('SINE/COSINE tables match RuneLite Perspective.java', () => {
      // RuneLite: UNIT = 0.0030679615 ≈ π/1024
      // SINE[i] = (int)(65536 * sin(i * UNIT))
      const UNIT = Math.PI / 1024;

      expect(Math.floor(65536 * Math.sin(0 * UNIT))).toBe(0);
      expect(Math.floor(65536 * Math.sin(512 * UNIT))).toBe(65536);
      expect(Math.floor(65536 * Math.sin(1024 * UNIT))).toBe(0);

      expect(Math.sin(128 * UNIT)).toBeCloseTo(Math.sin((22.5 * Math.PI) / 180), 6);
      expect(Math.sin(383 * UNIT)).toBeCloseTo(Math.sin((67.324 * Math.PI) / 180), 2);
    });

    it('atan2 constant 325.949... = 2048/(2π)', () => {
      const constant = RS_ANGLE_UNITS / (2 * Math.PI);
      expect(constant).toBeCloseTo(325.949, 2);
    });

    it('default fovScale 512 matches the game zoom value 512', () => {
      //   fovScale = Math.trunc(Math.pow(2, zoomValue / 256 + 7))
      // zoom value 512 → 2^(2+7) = 512
      const scriptValue = 512;
      const fovScale = Math.trunc(2 ** (scriptValue / 256 + 7));
      expect(fovScale).toBe(512);
    });
  });
});

describe('Projection3D — setCameraLimits', () => {
  const viewport: Viewport = { width: 800, height: 600, dpr: 1 };

  it('restores captured poses exactly without relaxing subsequent live-control limits', () => {
    const cam = createProjection3D(viewport);
    const recorded = {
      pitch: -80,
      yaw: 215,
      fovScale: 1600,
      targetX: 42.5,
      targetY: 46.5,
      targetZ: 2.3828125,
    };
    const oldView = cam.viewMatrix();
    const oldProjection = cam.projectionMatrix();

    cam.restoreOrbitCamera(recorded);
    expect(cam.getCameraState()).toEqual({ ...recorded, distance: getOsrsCameraDistance(-80, viewport.height) });
    expect(cam.viewMatrix()).not.toEqual(oldView);
    expect(cam.projectionMatrix()).not.toEqual(oldProjection);

    // The distance is the game's, derived from pitch and the viewer's own viewport.
    cam.updateViewport({ width: 1600, height: 300, dpr: 2 });
    expect(cam.getCameraState()).toEqual({ ...recorded, distance: getOsrsCameraDistance(-80, 300) });

    cam.updateCamera({ pitch: -80, fovScale: 1600 });
    expect(cam.getCameraState()).toMatchObject({ pitch: (-383 * 360) / 2048, fovScale: 896 });
  });

  describe('relaxPitch', () => {
    it('defaults to OSRS pitch clamp [383 JAU, 128 JAU]', () => {
      const cam = createProjection3D(viewport);
      cam.updateCamera({ pitch: -10 });
      expect(cam.getCameraState().pitch).toBe(-22.5);
      cam.updateCamera({ pitch: -80 });
      expect(cam.getCameraState().pitch).toBe((-383 * 360) / 2048);
    });

    it("relaxPitch expands pitch to RuneLite's measured 60-520 JAU", () => {
      const cam = createProjection3D(viewport);
      cam.setCameraLimits({ relaxPitch: true });

      cam.updateCamera({ pitch: 5 });
      expect(cam.getCameraState().pitch).toBe((-60 * 360) / 2048);

      cam.updateCamera({ pitch: -100 });
      expect(cam.getCameraState().pitch).toBe((-520 * 360) / 2048);

      cam.updateCamera({ pitch: -15 });
      expect(cam.getCameraState().pitch).toBe(-15);
    });

    it('re-clamps current pitch when limits change', () => {
      const cam = createProjection3D(viewport);
      cam.setCameraLimits({ relaxPitch: true });
      cam.updateCamera({ pitch: -80 });
      expect(cam.getCameraState().pitch).toBe(-80);

      cam.setCameraLimits({ relaxPitch: false });
      expect(cam.getCameraState().pitch).toBe((-383 * 360) / 2048);
    });
  });

  describe('innerZoom', () => {
    it('defaults to OSRS max fovScale 896', () => {
      const cam = createProjection3D(viewport);
      cam.updateCamera({ fovScale: INNER_ZOOM_LIMIT_MAX });
      expect(cam.getCameraState().fovScale).toBe(OSRS_MAX_FOV_SCALE);
    });

    it('innerZoom expands the ceiling to the configured limit', () => {
      const cam = createProjection3D(viewport);
      cam.setCameraLimits({ innerZoomLimit: INNER_ZOOM_LIMIT_MAX });

      cam.updateCamera({ fovScale: INNER_ZOOM_LIMIT_MAX });
      expect(cam.getCameraState().fovScale).toBe(INNER_ZOOM_LIMIT_MAX);

      cam.updateCamera({ fovScale: INNER_ZOOM_LIMIT_MAX + 1 });
      expect(cam.getCameraState().fovScale).toBe(INNER_ZOOM_LIMIT_MAX);
    });
  });

  describe('outerZoomAdjust', () => {
    it('defaults to OSRS min fovScale 128', () => {
      const cam = createProjection3D(viewport);
      cam.updateCamera({ fovScale: OSRS_MIN_FOV_SCALE - 1 });
      expect(cam.getCameraState().fovScale).toBe(OSRS_MIN_FOV_SCALE);
    });

    it('positive adjust lowers min fovScale like RuneLite outerLimit', () => {
      const cam = createProjection3D(viewport);
      cam.setCameraLimits({ outerZoomAdjust: 400 });

      cam.updateCamera({ fovScale: -272 });
      expect(cam.getCameraState().fovScale).toBe(-272);

      cam.updateCamera({ fovScale: -273 });
      expect(cam.getCameraState().fovScale).toBe(-272);
    });

    it('negative adjust raises min fovScale like RuneLite outerLimit', () => {
      const cam = createProjection3D(viewport);
      cam.setCameraLimits({ outerZoomAdjust: -400 });

      cam.updateCamera({ fovScale: 527 });
      expect(cam.getCameraState().fovScale).toBe(528);
    });

    it('clamps outerZoomAdjust to RuneLite [-400, 400]', () => {
      const cam = createProjection3D(viewport);
      cam.setCameraLimits({ outerZoomAdjust: RUNELITE_OUTER_ZOOM_LIMIT_MAX + 1 });

      cam.updateCamera({ fovScale: OSRS_MIN_FOV_SCALE - RUNELITE_OUTER_ZOOM_LIMIT_MAX - 1 });
      expect(cam.getCameraState().fovScale).toBe(OSRS_MIN_FOV_SCALE - RUNELITE_OUTER_ZOOM_LIMIT_MAX);

      cam.setCameraLimits({ outerZoomAdjust: RUNELITE_OUTER_ZOOM_LIMIT_MIN - 1 });
      cam.updateCamera({ fovScale: OSRS_MIN_FOV_SCALE - RUNELITE_OUTER_ZOOM_LIMIT_MIN - 1 });
      expect(cam.getCameraState().fovScale).toBe(OSRS_MIN_FOV_SCALE - RUNELITE_OUTER_ZOOM_LIMIT_MIN);
    });

    it('re-clamps current fovScale when outer limit tightens', () => {
      const cam = createProjection3D(viewport);
      cam.setCameraLimits({ outerZoomAdjust: 400 });
      cam.updateCamera({ fovScale: -200 });
      expect(cam.getCameraState().fovScale).toBe(-200);

      cam.setCameraLimits({ outerZoomAdjust: 0 });
      expect(cam.getCameraState().fovScale).toBe(OSRS_MIN_FOV_SCALE);
    });

    it('combined RuneLite limits affect fovScale but not orbit distance', () => {
      const cam = createProjection3D(viewport);
      cam.setCameraLimits({
        relaxPitch: true,

        innerZoomLimit: INNER_ZOOM_LIMIT_MAX,
        outerZoomAdjust: 400,
      });

      cam.updateCamera({ pitch: -80, fovScale: INNER_ZOOM_LIMIT_MAX, distance: 0.5 });

      expect(cam.getCameraState().pitch).toBe(-80);
      expect(cam.getCameraState().fovScale).toBe(INNER_ZOOM_LIMIT_MAX);
      expect(cam.getCameraState().distance).toBe(2);
    });
  });
});

describe('Projection3D — camera follow height', () => {
  const viewport: Viewport = { width: 800, height: 600, dpr: 1 };

  it('follow height at default zoom (fovScale=512) is ~0.586 tiles', () => {
    const cam = createProjection3D(viewport);
    expect(cam.getFollowHeight()).toBeCloseTo(75 / 128, 6);
  });

  it('truncates the inner term in integer arithmetic, as the game does', () => {
    const cam = createProjection3D(viewport);
    // 25 * 700 / 256 = 68.359...; the game's integer divide keeps 68, so the
    // focal point is 93/128 rather than the 93.36/128 float arithmetic gives.
    cam.updateCamera({ fovScale: 700 });
    expect(cam.getFollowHeight()).toBeCloseTo((25 + 68) / 128, 12);

    // Every zoom stop must land on a whole fine unit, as the game's follow height does.
    for (let fov = OSRS_MIN_FOV_SCALE; fov <= OSRS_MAX_FOV_SCALE; fov += 25) {
      cam.updateCamera({ fovScale: fov });
      expect(Number.isInteger(cam.getFollowHeight() * 128)).toBe(true);
    }
  });

  it('keeps following the zoom past the game range, as the game does under RuneLite limits', () => {
    const cam = createProjection3D(viewport);
    cam.setCameraLimits({ innerZoomLimit: INNER_ZOOM_LIMIT_MAX, outerZoomAdjust: RUNELITE_OUTER_ZOOM_LIMIT_MAX });

    cam.updateCamera({ fovScale: INNER_ZOOM_LIMIT_MAX });
    expect(cam.getFollowHeight()).toBe((25 + Math.trunc((25 * INNER_ZOOM_LIMIT_MAX) / 256)) / 128);
    // A player model is ~1.4 tiles; even the expanded ceiling frames a point inside them.
    expect(cam.getFollowHeight()).toBeLessThan(1.4);

    // The follow height floors a negative value at 0.
    cam.updateCamera({ fovScale: OSRS_MIN_FOV_SCALE - RUNELITE_OUTER_ZOOM_LIMIT_MAX });
    expect(cam.getFollowHeight()).toBe(0);
  });

  it('getPlayerCenterZ uses zoom-dependent height, not hardcoded 0.9', () => {
    const cam = createProjection3D(viewport);
    const z = cam.getPlayerCenterZ(31, 37);
    expect(z).toBeCloseTo(cam.getFollowHeight(), 6);
    expect(z).not.toBeCloseTo(0.9, 2);
  });
});

describe('Projection3D — viewport logicalHeight', () => {
  /** The fixed client's own viewport: exactly the bottom of the 334..434 camera-size blend. */
  const client: Viewport = { width: 512, height: 334, dpr: 1 };
  /** The same client magnified 2x. Its CSS height is past the TOP of that blend. */
  const magnified: Viewport = { width: 1024, height: 668, dpr: 2 };

  function distanceOf(viewport: Viewport): number {
    return createProjection3D(viewport).getCameraState().distance;
  }

  it('takes world-space distance from the client height, not the magnified CSS one', () => {
    // A 2x frame is the same client drawn larger, not a taller viewport showing more
    // world; without this the camera pulls back to the far end of the blend purely
    // because the UI got bigger.
    expect(distanceOf({ ...magnified, logicalHeight: client.height })).toBe(distanceOf(client));
    expect(distanceOf(magnified)).toBeGreaterThan(distanceOf(client));
  });

  it('follows the CSS height where no separate client height is given', () => {
    // The resizable layouts genuinely grow the world they show, so the default must
    // stay `height` — defaulting logicalHeight to the fixed client's 334 would freeze
    // every other layout at the small end of the blend.
    expect(distanceOf(magnified)).toBe(getOsrsCameraDistance(OSRS_DEFAULT_PITCH, magnified.height));
    expect(distanceOf(client)).toBe(getOsrsCameraDistance(OSRS_DEFAULT_PITCH, client.height));
  });

  it('recomputes on updateViewport, so scaling a live frame does not keep the old distance', () => {
    const cam = createProjection3D(magnified);
    cam.updateViewport({ ...magnified, logicalHeight: client.height });
    expect(cam.getCameraState().distance).toBe(distanceOf(client));
  });
});

describe('innerZoomLimitForLevel', () => {
  it('reaches further in at every step, so a bigger number is always a closer camera', () => {
    const levels = Array.from(
      { length: INNER_ZOOM_LEVEL_MAX - INNER_ZOOM_LEVEL_MIN + 1 },
      (_, index) => INNER_ZOOM_LEVEL_MIN + index,
    );
    const limits = levels.map(innerZoomLimitForLevel);

    expect(limits).toEqual([...limits].sort((a, b) => a - b));
    expect(new Set(limits).size).toBe(limits.length);
  });

  it("reads level 0 as the game's own ceiling, which is what replaces the on/off flag", () => {
    expect(innerZoomLimitForLevel(INNER_ZOOM_LEVEL_MIN)).toBe(OSRS_MAX_FOV_SCALE);
    expect(innerZoomLimitForLevel(1)).toBeGreaterThan(OSRS_MAX_FOV_SCALE);
  });

  it("adds half the game ceiling's magnification per level", () => {
    const ceiling = zoomToLensStrength(OSRS_MAX_FOV_SCALE);
    expect(zoomToLensStrength(innerZoomLimitForLevel(2)) / ceiling).toBeCloseTo(2, 2);
    // Levels land on whole zoom values, so the multiple is only as fine as one zoom unit.
    expect(zoomToLensStrength(innerZoomLimitForLevel(INNER_ZOOM_LEVEL_MAX)) / ceiling).toBeCloseTo(5, 1);
  });

  it('holds a level from outside the picker inside the offered range', () => {
    expect(innerZoomLimitForLevel(-4)).toBe(OSRS_MAX_FOV_SCALE);
    expect(innerZoomLimitForLevel(99)).toBe(INNER_ZOOM_LIMIT_MAX);
    expect(innerZoomLimitForLevel(Number.NaN)).toBe(OSRS_MAX_FOV_SCALE);
  });
});

describe('Projection3D — configurable inner zoom limit', () => {
  const viewport: Viewport = { width: 800, height: 600, dpr: 1 };

  it("zooms in to the configured limit rather than RuneLite's fixed 1400", () => {
    const cam = createProjection3D(viewport);
    cam.setCameraLimits({ innerZoomLimit: 1200 });

    cam.updateCamera({ fovScale: 5000 });
    expect(cam.getCameraState().fovScale).toBe(1200);
  });

  it('clamps the configured limit to its own bounds', () => {
    const cam = createProjection3D(viewport);

    // Below the vanilla ceiling would CONTRACT the range this setting only ever expands.
    cam.setCameraLimits({ innerZoomLimit: 100 });
    cam.updateCamera({ fovScale: 5000 });
    expect(cam.getCameraState().fovScale).toBe(INNER_ZOOM_LIMIT_MIN);

    cam.setCameraLimits({ innerZoomLimit: 99999 });
    cam.updateCamera({ fovScale: 99999 });
    expect(cam.getCameraState().fovScale).toBe(INNER_ZOOM_LIMIT_MAX);
  });

  it("defaults to the game's own ceiling when no limit is given", () => {
    const cam = createProjection3D(viewport);

    cam.setCameraLimits({});
    cam.updateCamera({ fovScale: 5000 });
    expect(cam.getCameraState().fovScale).toBe(OSRS_MAX_FOV_SCALE);

    cam.setCameraLimits({ innerZoomLimit: 1200 });
    cam.updateCamera({ fovScale: 5000 });
    expect(cam.getCameraState().fovScale).toBe(1200);

    cam.setCameraLimits({ innerZoomLimit: innerZoomLimitForLevel(INNER_ZOOM_LEVEL_MIN) });
    cam.updateCamera({ fovScale: 5000 });
    expect(cam.getCameraState().fovScale).toBe(OSRS_MAX_FOV_SCALE);
  });
});

describe('Projection3D — fovScale updates', () => {
  const viewport: Viewport = { width: 800, height: 600, dpr: 1 };

  it('clamps fovScale to the OSRS zoom bounds', () => {
    const cam = createProjection3D(viewport);

    cam.updateCamera({ fovScale: OSRS_MIN_FOV_SCALE - 100 });
    expect(cam.getCameraState().fovScale).toBe(OSRS_MIN_FOV_SCALE);

    cam.updateCamera({ fovScale: OSRS_MAX_FOV_SCALE + 100 });
    expect(cam.getCameraState().fovScale).toBe(OSRS_MAX_FOV_SCALE);
  });

  it('updates projection zoom and follow height together, as the game does', () => {
    const cam = createProjection3D(viewport);

    cam.updateCamera({ fovScale: 640 });
    const proj = cam.getProjectionMatrix();
    const zoom = osrsViewportZoom(600, 640);

    expect(cam.getCameraState().fovScale).toBe(640);
    expect(proj[0]).toBeCloseTo((2 * zoom) / 800, 12);
    expect(proj[5]).toBeCloseTo((2 * zoom) / 600, 12);
    // 25 * 640 / 256 is exactly 62.5, so this is the stop where the game's
    // integer divide and float arithmetic visibly disagree: 87, not 87.5.
    expect(cam.getFollowHeight()).toBeCloseTo((25 + 62) / 128, 12);
  });
});

const VIEWPORT: Viewport = { width: 800, height: 600, dpr: 1 };

function createTopDownProjection(): Projection3D {
  // A steep, high pitch keeps the whole arena in front of the near clip so the
  // corner ordering is unambiguous on screen.
  return createProjection3D(VIEWPORT, { targetX: 32, targetY: 32, yaw: 180, pitch: -87.5, distance: 18 });
}

function flatTerrain(): Int32Array[] {
  // Indexed [tileX][tileY], and the interpolator also reads tileX+1 / tileY+1.
  return terrainAtHeight(0);
}

function terrainAtHeight(height: number): Int32Array[] {
  return Array.from({ length: 65 }, () => new Int32Array(65).fill(height));
}

describe('Projection3D.tilePolygonScreen', () => {
  it('returns exactly four corners for an on-screen tile', () => {
    const projection = createTopDownProjection();
    projection.setTerrainHeights(flatTerrain());

    const corners = projection.tilePolygonScreen({ x: 32, y: 32 });

    expect(corners).toHaveLength(4);
    for (const c of corners) {
      expect(Number.isFinite(c.x)).toBe(true);
      expect(Number.isFinite(c.y)).toBe(true);
    }
  });

  it('emits corners in SW, SE, NE, NW order', () => {
    const projection = createTopDownProjection();
    projection.setTerrainHeights(flatTerrain());

    const [sw, se, ne, nw] = projection.tilePolygonScreen({ x: 32, y: 32 });

    // The projection of each corner must match projecting that exact world point
    // via the public tileToScreen(), which resolves height the same way. This
    // pins both the ±0.5 offsets and their order without depending on the screen
    // orientation the camera happens to produce.
    const expectCorner = (actual: Vec2, cx: number, cy: number) => {
      const expected = projection.tileToScreen({ x: cx, y: cy });
      expect(expected).not.toBeNull();
      expect(actual.x).toBeCloseTo(expected!.x, 9);
      expect(actual.y).toBeCloseTo(expected!.y, 9);
    };

    expectCorner(sw, 31.5, 31.5);
    expectCorner(se, 32.5, 31.5);
    expectCorner(ne, 32.5, 32.5);
    expectCorner(nw, 31.5, 32.5);
  });

  it('describes a non-degenerate quad', () => {
    const projection = createTopDownProjection();
    projection.setTerrainHeights(flatTerrain());

    const [sw, se, ne, nw] = projection.tilePolygonScreen({ x: 30, y: 34 });

    // Shoelace area must be non-zero; a corner-ordering slip would collapse or
    // bow-tie the quad.
    const area =
      0.5 *
      Math.abs(
        sw.x * se.y -
          se.x * sw.y +
          (se.x * ne.y - ne.x * se.y) +
          (ne.x * nw.y - nw.x * ne.y) +
          (nw.x * sw.y - sw.x * nw.y),
      );
    expect(area).toBeGreaterThan(0);
  });

  it('honors an explicit level instead of sampling terrain', () => {
    const projection = createTopDownProjection();
    // Non-zero terrain so an ignored `level` would show up as a different result.
    projection.setTerrainHeights(terrainAtHeight(-512));

    const sampled = projection.tilePolygonScreen({ x: 32, y: 32 });
    const levelled = projection.tilePolygonScreen({ x: 32, y: 32, level: 0 });

    expect(sampled).toHaveLength(4);
    expect(levelled).toHaveLength(4);
    expect(levelled[0].y).not.toBeCloseTo(sampled[0].y, 3);

    // level=0 must equal projecting the same corners at z=0.
    const flat = createTopDownProjection();
    flat.setTerrainHeights(flatTerrain());
    const flatCorners = flat.tilePolygonScreen({ x: 32, y: 32 });
    for (let i = 0; i < 4; i++) {
      expect(levelled[i].x).toBeCloseTo(flatCorners[i].x, 9);
      expect(levelled[i].y).toBeCloseTo(flatCorners[i].y, 9);
    }
  });

  it('returns an empty array when the tile is behind the near clip', () => {
    const projection = createProjection3D(VIEWPORT, { targetX: 32, targetY: 32, yaw: 180, pitch: -45, distance: 5 });
    projection.setTerrainHeights(flatTerrain());

    // At yaw=180 the camera sits north of the target looking south, so large +Y
    // is behind it.
    const corners = projection.tilePolygonScreen({ x: 32, y: 4000 });

    expect(corners).toEqual([]);
  });

  it('returns a fresh array each call, so callers may retain the result', () => {
    const projection = createTopDownProjection();
    projection.setTerrainHeights(flatTerrain());

    const first = projection.tilePolygonScreen({ x: 32, y: 32 });
    const second = projection.tilePolygonScreen({ x: 32, y: 32 });

    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(first[0].x).toBeCloseTo(second[0].x, 9);
  });

  it('agrees with tileToScreen for the tile center', () => {
    const projection = createTopDownProjection();
    projection.setTerrainHeights(flatTerrain());

    const corners = projection.tilePolygonScreen({ x: 20, y: 40 });
    const centre = projection.tileToScreen({ x: 20, y: 40 });
    expect(centre).not.toBeNull();

    const meanX = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
    const meanY = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;

    expect(meanX).toBeCloseTo(centre!.x, 0);
    expect(meanY).toBeCloseTo(centre!.y, 0);
  });
});

describe('Projection3D — terrain pitch raise', () => {
  const viewport: Viewport = { width: 800, height: 600, dpr: 1 };
  const JAU_TO_DEG = 360 / 2048;

  /** Flat ground at height 0, with one corner `rise` units higher (heights grow downward). */
  function terrainWithRise(x: number, y: number, rise: number): Int32Array[] {
    const heights = Array.from({ length: 65 }, () => new Int32Array(65));
    heights[x]![y] = -rise;
    return heights;
  }

  function settle(cam: Projection3D): void {
    for (let i = 0; i < 2000; i++) cam.stepTerrainPitch(20);
  }

  it('leaves the pitch alone on flat ground', () => {
    const cam = createProjection3D(viewport, { pitch: -30, targetX: 32.5, targetY: 32.5 });
    cam.setTerrainHeights(terrainWithRise(0, 0, 0));
    settle(cam);
    expect(cam.getViewPitch()).toBe(-30);
  });

  it('lifts the pitch half a JAU per unit of rise within 4 tiles, and keeps the player pitch', () => {
    const cam = createProjection3D(viewport, { pitch: OSRS_DEFAULT_PITCH, targetX: 32.5, targetY: 32.5 });
    // 600 units above the focal point forces at least 300 JAU.
    cam.setTerrainHeights(terrainWithRise(36, 32, 600));
    settle(cam);

    expect(cam.getViewPitch()).toBeCloseTo(-300 * JAU_TO_DEG, 1);
    expect(cam.getCameraState().pitch).toBe(OSRS_DEFAULT_PITCH);
    expect(cam.getCameraState().distance).toBeCloseTo(getOsrsCameraDistance(cam.getViewPitch(), 600), 2);
  });

  it('ignores ground further than 4 tiles away and never goes past 383 JAU', () => {
    const far = createProjection3D(viewport, { pitch: OSRS_DEFAULT_PITCH, targetX: 32.5, targetY: 32.5 });
    far.setTerrainHeights(terrainWithRise(37, 32, 600));
    settle(far);
    expect(far.getViewPitch()).toBe(OSRS_DEFAULT_PITCH);

    const cliff = createProjection3D(viewport, { pitch: OSRS_DEFAULT_PITCH, targetX: 32.5, targetY: 32.5 });
    cliff.setTerrainHeights(terrainWithRise(33, 33, 5000));
    settle(cliff);
    expect(cliff.getViewPitch()).toBeCloseTo(-383 * JAU_TO_DEG, 6);
  });

  it('lifts faster than it settles back', () => {
    const cam = createProjection3D(viewport, { pitch: OSRS_DEFAULT_PITCH, targetX: 32.5, targetY: 32.5 });
    cam.setTerrainHeights(terrainWithRise(34, 32, 600));
    // Each cycle closes 1/24 of the gap on the way up.
    for (let i = 0; i < 15; i++) cam.stepTerrainPitch(20);
    expect(cam.getViewPitch()).toBeCloseTo(-300 * (1 - (23 / 24) ** 15) * JAU_TO_DEG, 6);

    settle(cam);
    cam.setTerrainHeights(terrainWithRise(0, 0, 0));
    cam.stepTerrainPitch(20);
    // And 1/80 on the way back down.
    expect(cam.getViewPitch()).toBeCloseTo(-(300 - 300 / 80) * JAU_TO_DEG, 6);
  });

  it('does not carry a terrain raise across a restored replay pose', () => {
    const cam = createProjection3D(viewport, { pitch: OSRS_DEFAULT_PITCH, targetX: 32.5, targetY: 32.5 });
    cam.setTerrainHeights(terrainWithRise(34, 32, 600));
    settle(cam);

    cam.restoreOrbitCamera({ ...cam.getCameraState(), pitch: -40 });
    expect(cam.getViewPitch()).toBe(-40);
  });
});

describe('Projection3D — scripted (cutscene) camera', () => {
  const viewport: Viewport = { width: 800, height: 600, dpr: 1 };

  it('draws a pose that matches the orbit view it reproduces', () => {
    const cam = createProjection3D(viewport, { pitch: -40, yaw: 70, targetX: 30.5, targetY: 40.5, targetZ: 0.9 });
    const orbitView = cam.getViewMatrix().slice();
    const orbitProjection = cam.getOsrsCameraProjection();
    cam.setScriptedCamera({ eye: cam.getCameraWorldPosition(), lookAt: { x: 30.5, y: 40.5, z: 0.9 } });
    for (const [index, value] of cam.getViewMatrix().entries())
      expect(value).toBeCloseTo(orbitView[index] ?? Number.NaN, 9);
    const scripted = cam.getOsrsCameraProjection();
    for (const key of Object.keys(orbitProjection) as (keyof typeof orbitProjection)[])
      expect(scripted[key]).toBeCloseTo(orbitProjection[key], 6);
  });

  it('looks from the eye at the look-at point, outside the orbit limits', () => {
    const cam = createProjection3D(viewport, { pitch: -45, yaw: 180, targetX: 31.5, targetY: 44.5 });
    // Wave 69's intro view: further and flatter than the player's camera may go.
    const pose = { eye: { x: 35.5, y: 35.5, z: 1000 / 128 }, lookAt: { x: 28.5, y: 56.5, z: 140 / 128 } };
    cam.setScriptedCamera(pose);
    expect(cam.getCameraWorldPosition()).toEqual(pose.eye);
    const centre = cam['projectToScreenOrNull'](pose.lookAt) as Vec2 | null;
    expect(centre?.x).toBeCloseTo(400, 6);
    expect(centre?.y).toBeCloseTo(300, 6);
  });

  it("holds the player's angles and zoom while it is up, and releases to exactly their view", () => {
    const cam = createProjection3D(viewport, { pitch: -45, yaw: 180, targetX: 31.5, targetY: 44.5 });
    const before = cam.getCameraState();
    cam.setScriptedCamera({ eye: { x: 35.5, y: 35.5, z: 8 }, lookAt: { x: 28.5, y: 56.5, z: 1 } });
    cam.updateCamera({ yaw: 90, pitch: -60, fovScale: 300, targetX: 20.5, targetY: 21.5 });
    cam.updateFreeformCamera({ yaw: 45 });
    cam.moveFreeform(5, 0, 0);
    // The follow target still tracks the player underneath.
    expect(cam.getCameraState()).toEqual({ ...before, targetX: 20.5, targetY: 21.5 });
    cam.setScriptedCamera(null);
    const released = createProjection3D(viewport, { ...before, targetX: 20.5, targetY: 21.5 });
    expect(cam.getViewMatrix()).toEqual(released.getViewMatrix());
    cam.updateCamera({ yaw: 90 });
    expect(cam.getCameraState().yaw).toBe(90);
  });
});

describe('Projection3D — arena footprint picking', () => {
  // The camera looks down on the seam between the origin square (y 0-63) and the one north of it.
  const seamCamera = () =>
    createProjection3D(VIEWPORT, { targetX: 28, targetY: 64, yaw: 180, pitch: -87.5, distance: 18 });
  const NORTH_ARENA = getMapSquareBlock([
    { dx: 0, dy: 0 },
    { dx: 0, dy: 1 },
  ]);
  const pick = (projection: Projection3D, x: number, y: number) => {
    const screen = projection.tileToScreen({ x: x + 0.5, y: y + 0.5 });
    if (!screen) throw new Error('tile off screen');
    return projection.screenToTile(screen);
  };

  // A ray over a tile outside the footprint is not picked there. On flat ground nothing is picked; a
  // ray march carries on to the first footprint tile it is under, as it always has at the arena edge.
  const outside = (tile: { x: number; y: number } | null) => tile === null || tile.y < 64;

  it.each([
    ['flat ground', null],
    ['ray-marched terrain', 'terrain'],
  ] as const)('picks only origin-square tiles by default (%s)', (_label, terrain) => {
    const projection = seamCamera();
    if (terrain) projection.setTerrainHeights(flatTerrain());
    expect(pick(projection, 28, 63)).toEqual({ x: 28, y: 63 });
    expect(outside(pick(projection, 28, 64))).toBe(true);
    if (!terrain) expect(pick(projection, 28, 64)).toBeNull();
  });

  it.each([
    ['flat ground', null],
    ['ray-marched terrain', 'terrain'],
  ] as const)('picks the tiles of every arena square (%s)', (_label, terrain) => {
    const projection = seamCamera();
    projection.setPickableMapSquareBlock(NORTH_ARENA);
    if (terrain) {
      projection.setTerrainHeights(
        composeTerrainHeights([
          { tileOffsetX: 0, tileOffsetY: 0, heights: flatTerrain() },
          { tileOffsetX: 0, tileOffsetY: 64, heights: flatTerrain() },
        ]),
      );
    }
    expect(pick(projection, 28, 63)).toEqual({ x: 28, y: 63 });
    expect(pick(projection, 28, 64)).toEqual({ x: 28, y: 64 });
    projection.setPickableMapSquareBlock();
    expect(outside(pick(projection, 28, 64))).toBe(true);
  });

  it('rejects a hole in a sparse block even inside its rectangle', () => {
    const projection = createProjection3D(VIEWPORT, { targetX: 64, targetY: 64, yaw: 180, pitch: -87.5, distance: 18 });
    // An L: the origin, the square north of it and the one north-east; the square east of the origin is a hole.
    projection.setPickableMapSquareBlock(
      getMapSquareBlock([
        { dx: 0, dy: 0 },
        { dx: 0, dy: 1 },
        { dx: 1, dy: 1 },
      ]),
    );
    expect(pick(projection, 63, 63)).toEqual({ x: 63, y: 63 });
    expect(pick(projection, 64, 64)).toEqual({ x: 64, y: 64 });
    expect(pick(projection, 64, 63)).toBeNull();
  });

  it('follows terrain on the square north of the origin instead of clamping to tile 63', () => {
    const projection = createProjection3D(VIEWPORT, { targetX: 28, targetY: 64, yaw: 180, pitch: -87.5, distance: 18 });
    const raised = composeTerrainHeights([
      { tileOffsetX: 0, tileOffsetY: 0, heights: flatTerrain() },
      { tileOffsetX: 0, tileOffsetY: 64, heights: terrainAtHeight(-640) },
    ]);
    projection.setTerrainHeights(raised);
    // Ground level on the origin square, five tiles up (-640 / 128) on the north square.
    expect(projection.getPlayerCenterZ(28.5, 10.5) - projection.getFollowHeight()).toBeCloseTo(0, 9);
    expect(projection.getPlayerCenterZ(28.5, 74.5) - projection.getFollowHeight()).toBeCloseTo(5, 9);
  });
});
