import { describe, expect, it } from 'vitest';
import { createProjectionAdapter } from '../../render/adapters/projectionAdapter';
import { getMapSquareBlock } from '../../rs/map/mapSquareBlock';
import { type ArenaTileExtent, getArenaTileExtent } from '../encounters/mapFootprint';
import { createProjection } from '../projection';

const TILE_SIZE = 32;

/** The Debug view's projection over an arena rectangle from tile (0, 0), built the way RenderViewport builds it. */
function debugAdapter({ width, height }: ArenaTileExtent, rotation = 0) {
  const projection = createProjection('top-down', {
    gridWidth: width,
    gridHeight: height,
    tileSize: TILE_SIZE,
    rotation,
  });
  return { projection, adapter: createProjectionAdapter(projection) };
}

// A 1x2 arena: the origin square (y 0-63) and the square north of it (y 64-127).
const NORTH_ARENA = getArenaTileExtent(
  getMapSquareBlock([
    { dx: 0, dy: 0 },
    { dx: 0, dy: 1 },
  ]),
);

describe('TopDownProjection over a multi-square arena', () => {
  it('spans the arena rectangle', () => {
    expect(NORTH_ARENA).toEqual({ width: 64, height: 128 });
  });

  it.each([0, 90, 180, 270])('round-trips tile centers on both sides of the seam (rotated %i degrees)', (rotation) => {
    const { adapter } = debugAdapter(NORTH_ARENA, rotation);
    const [south, north] = [
      [28, 63],
      [28, 64],
    ].map(([x, y]) => {
      const screen = adapter.tileToScreen({ x, y });
      if (!screen) throw new Error('tile center off the projection');
      expect(adapter.screenToTile(screen)).toEqual({ x, y });
      return screen;
    });
    // Adjacent centers are one tile apart on screen, whichever way the view is turned.
    expect(Math.hypot(north.x - south.x, north.y - south.y)).toBeCloseTo(TILE_SIZE, 9);
  });

  it('puts north up without flipping an axis: the tile north of the seam is drawn above it', () => {
    const { adapter } = debugAdapter(NORTH_ARENA);
    const south = adapter.tileToScreen({ x: 28, y: 63 });
    const north = adapter.tileToScreen({ x: 28, y: 64 });
    const east = adapter.tileToScreen({ x: 29, y: 63 });
    expect(north?.y).toBe((south?.y ?? 0) - TILE_SIZE);
    expect(east?.x).toBe((south?.x ?? 0) + TILE_SIZE);
  });

  it('rejects a point beyond the arena', () => {
    const { projection } = debugAdapter(NORTH_ARENA);
    // Above the north square's top row, left of x 0, and below row 0.
    expect(projection.screenToGrid(10, -1)).toBeNull();
    expect(projection.screenToGrid(-1, 10)).toBeNull();
    expect(projection.screenToGrid(10, projection.canvasHeight)).toBeNull();
  });

  it('sizes the canvas to the arena rectangle, swapped by a quarter turn', () => {
    expect(debugAdapter(NORTH_ARENA).projection).toMatchObject({ canvasWidth: 64 * 32, canvasHeight: 128 * 32 });
    expect(debugAdapter(NORTH_ARENA, 90).projection).toMatchObject({ canvasWidth: 128 * 32, canvasHeight: 64 * 32 });
  });

  it('draws corners around the same tile it reports for their center, across a quarter turn', () => {
    const { projection } = debugAdapter(NORTH_ARENA, 90);
    const corners = projection.getTileCorners(28, 64);
    const centerX = corners.reduce((sum, c) => sum + c.x, 0) / 4;
    const centerY = corners.reduce((sum, c) => sum + c.y, 0) / 4;
    expect(projection.screenToGrid(centerX, centerY)).toEqual([28, 64]);
    expect(projection.gridToScreen(28, 64)).toEqual({ x: centerX, y: centerY });
  });
});
