import { describe, expect, it } from 'vitest';
import { composeTerrainHeights, getTerrainHeightInterpolated } from '../renderUtils';

/** A 65x65 square grid filled with `value`, its far edge row and column 0 as the map data leaves them. */
function square(value: number): Int32Array[] {
  return Array.from({ length: 65 }, (_, x) =>
    Int32Array.from({ length: 65 }, (_, y) => (x === 64 || y === 64 ? 0 : value)),
  );
}

describe('composeTerrainHeights', () => {
  it('returns the core grid itself when the scene is one square', () => {
    const core = square(-100);
    expect(composeTerrainHeights([{ tileOffsetX: 0, tileOffsetY: 0, heights: core }])).toBe(core);
  });

  it('puts a northern square above the core, its first row replacing the core edge', () => {
    const grid = composeTerrainHeights([
      { tileOffsetX: 0, tileOffsetY: 0, heights: square(-100) },
      { tileOffsetX: 0, tileOffsetY: 64, heights: square(-120) },
    ]);
    if (!grid) throw new Error('No grid');
    expect(grid).toHaveLength(65);
    expect(grid[10]).toHaveLength(129);
    expect(grid[10]?.[63]).toBe(-100);
    expect(grid[10]?.[64]).toBe(-120); // The north square's own row 0, not the core's empty edge.
    expect(grid[10]?.[100]).toBe(-120);
    // An actor on the north square samples its terrain, not the clamped core edge.
    expect(getTerrainHeightInterpolated(grid, 23.5, 68.5)).toBe(-120);
  });

  it('leaves out squares south or west of the core, as before', () => {
    const core = square(-100);
    expect(
      composeTerrainHeights([
        { tileOffsetX: 0, tileOffsetY: 0, heights: core },
        { tileOffsetX: 0, tileOffsetY: -64, heights: square(-50) },
      ]),
    ).toBe(core);
  });
});

describe('getTerrainHeightInterpolated', () => {
  it('still clamps a one-square grid to tile 63', () => {
    expect(getTerrainHeightInterpolated(square(-100), 70, 70)).toBe(0);
    expect(getTerrainHeightInterpolated(square(-100), 62.5, 62.5)).toBe(-100);
  });
});
