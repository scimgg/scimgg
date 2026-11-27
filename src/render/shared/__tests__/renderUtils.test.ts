import { describe, expect, it } from 'vitest';
import {
  composeTerrainHeights,
  getLocCenterHeight,
  getTerrainHeight,
  getTerrainHeightInterpolated,
} from '../renderUtils';

/** One map square's 65x65 corner heights: `value` on every tile corner, 0 on the shared far edge as the map data leaves it. */
function square(value: number): Int32Array[] {
  return Array.from({ length: 65 }, (_, x) =>
    Int32Array.from({ length: 65 }, (_, y) => (x === 64 || y === 64 ? 0 : value)),
  );
}

describe('composeTerrainHeights', () => {
  it('keeps a lone origin square as its own grid', () => {
    const core = square(-100);
    expect(composeTerrainHeights([{ tileOffsetX: 0, tileOffsetY: 0, heights: core }])).toBe(core);
  });

  it('returns null with no squares', () => {
    expect(composeTerrainHeights([])).toBeNull();
  });

  it('puts a north square above the origin, its first row replacing the shared edge', () => {
    const grid = composeTerrainHeights([
      { tileOffsetX: 0, tileOffsetY: 0, heights: square(-100) },
      { tileOffsetX: 0, tileOffsetY: 64, heights: square(-120) },
    ]);
    if (!grid) throw new Error('no grid');
    expect([grid.length, grid[10]?.length]).toEqual([65, 129]);
    // Both sides of the seam between tile rows 63 and 64.
    expect(getTerrainHeight(grid, 28, 63)).toBe(-100);
    expect(getTerrainHeight(grid, 28, 64)).toBe(-120);
    expect(getTerrainHeightInterpolated(grid, 28.5, 62.5)).toBe(-100);
    expect(getTerrainHeightInterpolated(grid, 28.5, 64.5)).toBe(-120);
  });

  it.each([
    ['neighbors listed first', true],
    ['origin listed first', false],
  ])('lets the neighbor win the shared edge in either order (%s)', (_label, northFirst) => {
    const origin = { tileOffsetX: 0, tileOffsetY: 0, heights: square(-100) };
    const north = { tileOffsetX: 0, tileOffsetY: 64, heights: square(-120) };
    const east = { tileOffsetX: 64, tileOffsetY: 0, heights: square(-70) };
    const grid = composeTerrainHeights(northFirst ? [north, east, origin] : [origin, north, east]);
    // The origin's top row and east column are its shared edges; the neighbors' first ones win.
    expect(grid?.[28]?.[64]).toBe(-120);
    expect(grid?.[64]?.[28]).toBe(-70);
  });

  it('composes an L-shaped arena from tile (0, 0), its empty origin corner left at 0', () => {
    // The origin square is scenery only: the arena is the squares east, north and north-east of it.
    const grid = composeTerrainHeights([
      { tileOffsetX: 64, tileOffsetY: 0, heights: square(-70) },
      { tileOffsetX: 0, tileOffsetY: 64, heights: square(-120) },
      { tileOffsetX: 64, tileOffsetY: 64, heights: square(-50) },
    ]);
    if (!grid) throw new Error('no grid');
    expect([grid.length, grid[0]?.length]).toEqual([129, 129]);
    // The west seam between the east square and the empty corner.
    expect(getTerrainHeight(grid, 63, 28)).toBe(0);
    expect(getTerrainHeight(grid, 64, 28)).toBe(-70);
    expect(getTerrainHeightInterpolated(grid, 64.5, 28.5)).toBe(-70);
    // The east seam between the north and north-east squares.
    expect(getTerrainHeightInterpolated(grid, 62.5, 100.5)).toBe(-120);
    expect(getTerrainHeightInterpolated(grid, 64.5, 100.5)).toBe(-50);
    expect(getLocCenterHeight(grid, 100, 100, 1, 1)).toBe(50 / 128);
  });

  it('rejects a square south or west of tile (0, 0)', () => {
    expect(() =>
      composeTerrainHeights([
        { tileOffsetX: 0, tileOffsetY: 0, heights: square(-100) },
        { tileOffsetX: 0, tileOffsetY: -64, heights: square(-50) },
      ]),
    ).toThrow('south or west');
  });
});

describe('getTerrainHeightInterpolated', () => {
  it('still clamps a one-square grid to tile 63', () => {
    expect(getTerrainHeightInterpolated(square(-100), 70, 70)).toBe(0);
    expect(getTerrainHeightInterpolated(square(-100), 62.5, 62.5)).toBe(-100);
    expect(getTerrainHeightInterpolated(square(-100), -5, 10)).toBe(-100);
  });
});
