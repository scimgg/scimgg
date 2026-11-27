import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { getMapSquareBlock } from '../../rs/map/mapSquareBlock';
import {
  createMinimapWheelHandler,
  type MinimapRaster,
  minimapCanvasPoint,
  minimapCssScale,
  minimapNpcDotPosition,
  minimapSquarePixelOrigin,
  minimapTerrainTransform,
  resolveMinimapRaster,
  resolveMinimapZoom,
} from '../Minimap';

const minimapSourcePath = fileURLToPath(new URL('../Minimap.tsx', import.meta.url));
const minimapSource = readFileSync(minimapSourcePath, 'utf8');

function getNumericConstantValue(name: string, resolved: Record<string, number>): number {
  const match = minimapSource.match(new RegExp(`const\\s+${name}\\s*=\\s*([^;]+);`));
  if (!match) {
    throw new Error(`Constant ${name} not found in Minimap.tsx`);
  }

  const expression = match[1].trim();
  const dependencies = Object.keys(resolved);
  const dependencyValues = dependencies.map((dependency) => resolved[dependency]);
  const value = Function(...dependencies, `return (${expression});`)(...dependencyValues);

  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`Constant ${name} did not evaluate to a number`);
  }

  return value;
}

const constants: Record<string, number> = {};
constants.MINIMAP_FRAME_WIDTH = getNumericConstantValue('MINIMAP_FRAME_WIDTH', constants);
constants.MINIMAP_FRAME_HEIGHT = getNumericConstantValue('MINIMAP_FRAME_HEIGHT', constants);
constants.MINIMAP_CLIP_SIZE = getNumericConstantValue('MINIMAP_CLIP_SIZE', constants);
constants.MINIMAP_CLIP_TOP = getNumericConstantValue('MINIMAP_CLIP_TOP', constants);
constants.MINIMAP_CLIP_RIGHT = getNumericConstantValue('MINIMAP_CLIP_RIGHT', constants);
constants.COMPASS_CLIP_SIZE = getNumericConstantValue('COMPASS_CLIP_SIZE', constants);
constants.ORBS_OVERFLOW_LEFT = getNumericConstantValue('ORBS_OVERFLOW_LEFT', constants);
constants.COMPASS_CLIP_LEFT = getNumericConstantValue('COMPASS_CLIP_LEFT', constants);
constants.COMPASS_CLIP_TOP = getNumericConstantValue('COMPASS_CLIP_TOP', constants);
constants.TOTAL_WIDTH = getNumericConstantValue('TOTAL_WIDTH', constants);
constants.TOTAL_HEIGHT = getNumericConstantValue('TOTAL_HEIGHT', constants);

describe('Minimap geometry constants', () => {
  it('minimap clip fits within measured frame opening', () => {
    expect(constants.MINIMAP_CLIP_TOP).toBeGreaterThanOrEqual(7);
    expect(constants.MINIMAP_CLIP_RIGHT).toBeGreaterThanOrEqual(5);
    expect(constants.MINIMAP_CLIP_SIZE).toBeLessThanOrEqual(156);
  });

  it('minimap clip is centered on frame opening', () => {
    const measuredCenterX = 99.5;
    const measuredCenterY = 83.5;

    const centerX = constants.MINIMAP_FRAME_WIDTH - constants.MINIMAP_CLIP_RIGHT - constants.MINIMAP_CLIP_SIZE / 2;
    const centerY = constants.MINIMAP_CLIP_TOP + constants.MINIMAP_CLIP_SIZE / 2;

    expect(Math.abs(centerX - measuredCenterX)).toBeLessThanOrEqual(3);
    expect(Math.abs(centerY - measuredCenterY)).toBeLessThanOrEqual(3);
  });

  it('compass clip positions are integers', () => {
    expect(Number.isInteger(constants.COMPASS_CLIP_LEFT)).toBe(true);
    expect(Number.isInteger(constants.COMPASS_CLIP_TOP)).toBe(true);
  });

  it('compass clip is large enough to fill ring', () => {
    expect(constants.COMPASS_CLIP_SIZE).toBeGreaterThanOrEqual(35);
  });

  it('ORBS_OVERFLOW_LEFT is declared before dependent constants', () => {
    const orbsDeclarationIndex = minimapSource.indexOf('const ORBS_OVERFLOW_LEFT');
    const compassLeftDeclarationIndex = minimapSource.indexOf('const COMPASS_CLIP_LEFT');
    const totalWidthDeclarationIndex = minimapSource.indexOf('const TOTAL_WIDTH');

    expect(orbsDeclarationIndex).toBeGreaterThan(-1);
    expect(compassLeftDeclarationIndex).toBeGreaterThan(orbsDeclarationIndex);
    expect(totalWidthDeclarationIndex).toBeGreaterThan(orbsDeclarationIndex);

    expect(Number.isFinite(constants.ORBS_OVERFLOW_LEFT)).toBe(true);
    expect(Number.isFinite(constants.COMPASS_CLIP_LEFT)).toBe(true);
    expect(Number.isFinite(constants.TOTAL_WIDTH)).toBe(true);
    expect(Number.isFinite(constants.TOTAL_HEIGHT)).toBe(true);
  });
});

/**
 * We don't instantiate a real `WheelEvent` because jsdom is not required here
 * — the handler only reads `altKey`/`deltaY` and calls `preventDefault`/
 * `stopPropagation`, so a structural cast is sufficient.
 */
function makeWheel({ altKey, deltaY }: { altKey: boolean; deltaY: number }): {
  event: WheelEvent;
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
} {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  const event = { altKey, deltaY, preventDefault, stopPropagation } as unknown as WheelEvent;
  return { event, preventDefault, stopPropagation };
}

describe('createMinimapWheelHandler', () => {
  it('Alt+wheel is a no-op so the event can bubble to DraggablePanel for UI scaling', () => {
    const setMinimapZoom = vi.fn();
    const handler = createMinimapWheelHandler(setMinimapZoom);

    const { event, preventDefault, stopPropagation } = makeWheel({ altKey: true, deltaY: 100 });
    handler(event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(setMinimapZoom).not.toHaveBeenCalled();
  });

  it('Alt+wheel with negative deltaY also no-ops (direction-independent)', () => {
    const setMinimapZoom = vi.fn();
    const handler = createMinimapWheelHandler(setMinimapZoom);

    const { event, preventDefault, stopPropagation } = makeWheel({ altKey: true, deltaY: -100 });
    handler(event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(setMinimapZoom).not.toHaveBeenCalled();
  });

  it('plain wheel consumes the event and zooms in (deltaY < 0 → zoom in)', () => {
    const setMinimapZoom = vi.fn();
    const handler = createMinimapWheelHandler(setMinimapZoom);

    const { event, preventDefault, stopPropagation } = makeWheel({ altKey: false, deltaY: -120 });
    handler(event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(setMinimapZoom).toHaveBeenCalledOnce();

    const updater = setMinimapZoom.mock.calls[0][0] as (prev: number) => number;
    // Zoom is held in OSRS units, so the clamped range is literally [2, 8].
    const start = 4;
    const result = updater(start);
    expect(result).toBeGreaterThan(start);
  });

  it('plain wheel consumes the event and zooms out (deltaY > 0 → zoom out)', () => {
    const setMinimapZoom = vi.fn();
    const handler = createMinimapWheelHandler(setMinimapZoom);

    const { event, preventDefault, stopPropagation } = makeWheel({ altKey: false, deltaY: 120 });
    handler(event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(setMinimapZoom).toHaveBeenCalledOnce();

    const updater = setMinimapZoom.mock.calls[0][0] as (prev: number) => number;
    const start = 4;
    const result = updater(start);
    expect(result).toBeLessThan(start);
  });

  it('zoom updater clamps so the result never exceeds the documented OSRS bounds (zoom 2..8)', () => {
    const setMinimapZoom = vi.fn();
    const handler = createMinimapWheelHandler(setMinimapZoom);

    // Zoom in repeatedly from an already-high value — must clamp at the upper bound.
    handler(makeWheel({ altKey: false, deltaY: -1 }).event);
    const zoomInUpdater = setMinimapZoom.mock.calls[0][0] as (prev: number) => number;
    const fromHigh = zoomInUpdater(1e9);
    expect(Number.isFinite(fromHigh)).toBe(true);

    // Zoom out repeatedly from an already-low value — must clamp at the lower bound.
    setMinimapZoom.mockClear();
    handler(makeWheel({ altKey: false, deltaY: 1 }).event);
    const zoomOutUpdater = setMinimapZoom.mock.calls[0][0] as (prev: number) => number;
    const fromLow = zoomOutUpdater(-1e9);
    expect(Number.isFinite(fromLow)).toBe(true);

    expect(fromLow).toBeLessThan(fromHigh);
  });
});

describe('minimapCssScale', () => {
  // The canvas fills the aperture, so the CSS scale that yields `osrsZoom` px per tile
  // depends on which surround is mounted: 154 resizable, 148 fixed.
  const CANVAS_SIZE = 256;
  const TILE_SCALE = 4;
  const pxPerTile = (osrsZoom: number, clipSize: number) =>
    TILE_SCALE * (clipSize / CANVAS_SIZE) * minimapCssScale(osrsZoom, clipSize);

  it.each([154, 148])('puts exactly osrsZoom px per tile on a %i px aperture', (clipSize) => {
    for (const zoom of [2, 4, 8]) {
      expect(pxPerTile(zoom, clipSize)).toBeCloseTo(zoom, 10);
    }
  });

  it('scales the smaller fixed aperture up, not down', () => {
    expect(minimapCssScale(4, 148)).toBeGreaterThan(minimapCssScale(4, 154));
  });
});

describe('resolveMinimapZoom', () => {
  it("keeps the viewer's own zoom when the recording carries none", () => {
    // A recording without a zoom replays at whatever the viewer has: the optional-field
    // rule in src/core/replayPresentation.ts.
    expect(resolveMinimapZoom(undefined, 6)).toBe(6);
  });

  it("draws the recording's zoom over the viewer's", () => {
    expect(resolveMinimapZoom(6, 3)).toBe(6);
  });

  it('clamps a replay carrying a zoom this build has no transform math for', () => {
    // The format's bound is deliberately loose so raising MAX_MINIMAP_ZOOM cannot invalidate
    // existing recordings, which leaves the clamp as the only thing bounding the render.
    expect([resolveMinimapZoom(64, 4), resolveMinimapZoom(0.5, 4)]).toEqual([8, 2]);
  });
});

// A 1x2 arena: the origin square 35_47 (sim y 0-63) and 35_48 north of it (sim y 64-127).
const NORTH_ARENA = getMapSquareBlock([
  { dx: 0, dy: 0 },
  { dx: 0, dy: 1 },
]);

/**
 * Where a backing pixel of the terrain canvas lands in the aperture, by the CSS the minimap applies:
 * the canvas laid out at `clipSize / 256` CSS px per backing pixel from the aperture's top-left, then
 * `translate scale rotate` about its transform origin.
 */
function applyTerrainCss(
  raster: MinimapRaster,
  css: { transform: string; transformOrigin: string },
  clipSize: number,
  pixel: { x: number; y: number },
): { x: number; y: number } {
  const number = /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g;
  const [tx, ty, scale, yaw] = (css.transform.match(number) ?? []).map(Number);
  const [ox, oy] = (css.transformOrigin.match(number) ?? []).map(Number);
  const cssPerPixel = clipSize / 256;
  const origin = { x: (ox / 100) * raster.width * cssPerPixel, y: (oy / 100) * raster.height * cssPerPixel };
  const dx = pixel.x * cssPerPixel - origin.x;
  const dy = pixel.y * cssPerPixel - origin.y;
  const rad = (yaw * Math.PI) / 180;
  return {
    x: origin.x + tx + scale * (dx * Math.cos(rad) - dy * Math.sin(rad)),
    y: origin.y + ty + scale * (dx * Math.sin(rad) + dy * Math.cos(rad)),
  };
}

describe('minimap raster across map squares', () => {
  const raster = resolveMinimapRaster({ x: 35, y: 47 }, NORTH_ARENA);

  it('composes a 1x2 arena into one 256x512 bitmap, north square on top', () => {
    expect([raster.width, raster.height]).toEqual([256, 512]);
    const [south, north] = NORTH_ARENA;
    expect(minimapSquarePixelOrigin(raster, north)).toEqual({ x: 0, y: 0 });
    expect(minimapSquarePixelOrigin(raster, south)).toEqual({ x: 0, y: 256 });
  });

  it('keeps tiles either side of the seam one tile apart, north above south', () => {
    const below = minimapCanvasPoint(raster, 28, 63);
    const above = minimapCanvasPoint(raster, 28, 64);
    expect(above).toEqual({ x: 114, y: 254 });
    expect(below).toEqual({ x: 114, y: 258 });
  });

  it('keys the raster by footprint', () => {
    expect(raster.key).not.toBe(resolveMinimapRaster({ x: 35, y: 47 }, getMapSquareBlock()).key);
    expect(raster.key).not.toBe(resolveMinimapRaster({ x: 35, y: 48 }, NORTH_ARENA).key);
  });

  it('keeps the single-square layout exactly', () => {
    const single = resolveMinimapRaster({ x: 23, y: 157 }, getMapSquareBlock());
    expect([single.width, single.height]).toEqual([256, 256]);
    expect(minimapCanvasPoint(single, 31.25, 37)).toEqual({ x: 31.25 * 4 + 2, y: (63 - 37) * 4 + 2 });
    // The transform the minimap applied before the raster could hold more than one square.
    const clip = 154;
    const zoom = 4;
    const px = 31.25 * 4 + 2;
    const py = (63 - 37) * 4 + 2;
    expect(minimapTerrainTransform(single, 31.25, 37, 30, zoom, clip)).toEqual({
      transform: `translate(${clip / 2 - (px / 256) * clip}px, ${clip / 2 - (py / 256) * clip}px) scale(${minimapCssScale(zoom, clip)}) rotate(30deg)`,
      transformOrigin: `${(px / 256) * 100}% ${(py / 256) * 100}%`,
    });
  });

  it.each([
    ['resizable', 154, 2],
    ['resizable', 154, 4],
    ['resizable', 154, 8],
    ['fixed', 148, 4],
    ['fixed', 148, 8],
  ])('keeps the player centered and NPC dots over their terrain across the seam (%s, clip %i, zoom %i)', (_layout, clip, zoom) => {
    const npcs = [
      { position: [28, 64] as [number, number], size: 1 },
      { position: [30, 66] as [number, number], size: 2 },
      { position: [26, 60] as [number, number], size: 3 },
    ];
    for (const yaw of [0, 90, 213]) {
      for (const [playerX, playerY] of [
        [28, 63],
        [27.5, 64.25],
      ] as const) {
        const css = minimapTerrainTransform(raster, playerX, playerY, yaw, zoom, clip);
        const player = applyTerrainCss(raster, css, clip, minimapCanvasPoint(raster, playerX, playerY));
        expect(player.x).toBeCloseTo(clip / 2, 9);
        expect(player.y).toBeCloseTo(clip / 2, 9);
        for (const npc of npcs) {
          const dot = minimapNpcDotPosition(npc, playerX, playerY, yaw, zoom, clip);
          if (!dot) throw new Error('NPC dot outside the aperture');
          // The NPC's center, as a tile-center point: its south-west tile plus half its size, less half a tile.
          const center = minimapCanvasPoint(
            raster,
            npc.position[0] + npc.size / 2 - 0.5,
            npc.position[1] + npc.size / 2 - 0.5,
          );
          const terrain = applyTerrainCss(raster, css, clip, center);
          expect(dot.x).toBeCloseTo(terrain.x, 9);
          expect(dot.y).toBeCloseTo(terrain.y, 9);
        }
        // Tiles are `zoom` CSS px apart on every axis, the seam included.
        const below = applyTerrainCss(raster, css, clip, minimapCanvasPoint(raster, 28, 63));
        const above = applyTerrainCss(raster, css, clip, minimapCanvasPoint(raster, 28, 64));
        expect(Math.hypot(above.x - below.x, above.y - below.y)).toBeCloseTo(zoom, 9);
      }
    }
  });

  it('hides a dot outside the circular aperture', () => {
    expect(minimapNpcDotPosition({ position: [28, 120], size: 1 }, 28, 63, 0, 4, 154)).toBeNull();
  });
});
