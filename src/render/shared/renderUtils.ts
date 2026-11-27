export function getAnimFrameIndex(progress: number, frameLengths: number[] | undefined, totalDuration: number): number {
  if (!frameLengths || frameLengths.length === 0 || totalDuration === 0) return 0;

  const animProgress = progress * totalDuration;
  let accumulated = 0;

  for (let i = 0; i < frameLengths.length; i++) {
    accumulated += frameLengths[i];
    if (animProgress < accumulated) {
      return i;
    }
  }
  return frameLengths.length - 1;
}

export function getTerrainHeight(terrainHeights: Int32Array[] | null, x: number, y: number): number {
  if (!terrainHeights) return 0;
  const clampedX = Math.max(0, Math.min(terrainHeights.length - 1, Math.floor(x)));
  const column = terrainHeights[clampedX];
  if (!column) return 0;
  const clampedY = Math.max(0, Math.min(column.length - 1, Math.floor(y)));
  return column[clampedY] ?? 0;
}

/**
 * This interpolation keeps elevation smooth between tiles instead of snapping to a corner.
 */
export function getTerrainHeightInterpolated(terrainHeights: Int32Array[] | null, x: number, y: number): number {
  if (!terrainHeights) return 0;

  // The last tile whose north-east corner is in the grid: 63 for one map square's 65x65 heights.
  const tileX = Math.max(0, Math.min(terrainHeights.length - 2, Math.floor(x)));
  const tileY = Math.max(0, Math.min((terrainHeights[0]?.length ?? 65) - 2, Math.floor(y)));
  const fracX = Math.max(0, Math.min(1, x - tileX));
  const fracY = Math.max(0, Math.min(1, y - tileY));

  const hSW = terrainHeights[tileX]?.[tileY] ?? 0;
  const hSE = terrainHeights[tileX + 1]?.[tileY] ?? 0;
  const hNW = terrainHeights[tileX]?.[tileY + 1] ?? 0;
  const hNE = terrainHeights[tileX + 1]?.[tileY + 1] ?? 0;

  const hS = hSW + (hSE - hSW) * fracX;
  const hN = hNW + (hNE - hNW) * fracX;
  return hS + (hN - hS) * fracY;
}

export function getLocCenterHeight(
  terrainHeights: Int32Array[] | null,
  localX: number,
  localY: number,
  sizeX: number,
  sizeY: number,
): number {
  if (!terrainHeights) return 0;

  const h1 = getTerrainHeight(terrainHeights, localX, localY);
  const h2 = getTerrainHeight(terrainHeights, localX + sizeX, localY);
  const h3 = getTerrainHeight(terrainHeights, localX + sizeX, localY + sizeY);
  const h4 = getTerrainHeight(terrainHeights, localX, localY + sizeY);

  const avgHeight = (h1 + h2 + h3 + h4) / 4;
  return -avgHeight / 128;
}

/**
 * One height grid for a scene built from several map squares: the core square's heights at the grid
 * origin, and each square north or east of it (`tileOffsetX/Y` >= 0) at its tile offset, so actors on
 * those squares stand on their own terrain (Zulrah's island runs into the square north of its core).
 * Squares south or west of the core cannot extend a grid that starts at 0, and are left out, as
 * before. With only the core square this returns its own grid unchanged.
 *
 * A square's grid is one wider than its 64 tiles: its last column and row are the shared edge, and
 * the map data leaves them 0. Where a neighbour lies beyond that edge, the neighbour's first column or
 * row (real terrain) fills it instead.
 */
export function composeTerrainHeights(
  squares: readonly { readonly tileOffsetX: number; readonly tileOffsetY: number; readonly heights: Int32Array[] }[],
): Int32Array[] | null {
  const usable = squares.filter((square) => square.tileOffsetX >= 0 && square.tileOffsetY >= 0);
  const core = usable.find((square) => square.tileOffsetX === 0 && square.tileOffsetY === 0);
  if (!core) return null;
  if (usable.length === 1) return core.heights;
  const occupied = new Set(usable.map((square) => `${square.tileOffsetX},${square.tileOffsetY}`));
  const width = Math.max(...usable.map((square) => square.tileOffsetX + square.heights.length));
  const height = Math.max(...usable.map((square) => square.tileOffsetY + (square.heights[0]?.length ?? 0)));
  const grid = Array.from({ length: width }, () => new Int32Array(height));
  for (const { tileOffsetX, tileOffsetY, heights } of usable) {
    const lastX = heights.length - 1;
    const eastTaken = occupied.has(`${tileOffsetX + lastX},${tileOffsetY}`);
    for (let x = 0; x < heights.length; x++) {
      const column = heights[x];
      const target = grid[tileOffsetX + x];
      if (!column || !target || (x === lastX && eastTaken)) continue;
      const lastY = column.length - 1;
      const northTaken = occupied.has(`${tileOffsetX},${tileOffsetY + lastY}`);
      for (let y = 0; y < column.length; y++) {
        if (y === lastY && northTaken) continue;
        target[tileOffsetY + y] = column[y] ?? 0;
      }
    }
  }
  return grid;
}
