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
  const tileY = Math.max(0, Math.min((terrainHeights[0]?.length ?? 0) - 2, Math.floor(y)));
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

/** One square's level-0 heights and where its tile (0, 0) sits in simulation coordinates. */
export interface TerrainHeightSquare {
  readonly tileOffsetX: number;
  readonly tileOffsetY: number;
  readonly heights: Int32Array[];
}

/**
 * One height grid from simulation tile (0, 0) for squares laid out by their tile offsets: an
 * encounter's arena, whose south-west square is the origin, so no offset is negative. A lone
 * square at (0, 0) is returned as it is, so a one-square arena keeps its own grid.
 *
 * A square's grid is one wider than its 64 tiles: its last column and row are the edge it shares
 * with the next square, and the map data leaves them 0. Each vertex is taken from the square
 * whose tile it is the south-west corner of, so a neighbor's first column or row (real terrain)
 * wins over that edge wherever the neighbor is composed, in any order.
 */
export function composeTerrainHeights(squares: readonly TerrainHeightSquare[]): Int32Array[] | null {
  const [first] = squares;
  if (!first) return null;
  if (squares.length === 1 && first.tileOffsetX === 0 && first.tileOffsetY === 0) return first.heights;
  if (squares.some(({ tileOffsetX, tileOffsetY }) => tileOffsetX < 0 || tileOffsetY < 0)) {
    throw new Error('composeTerrainHeights: a square lies south or west of tile (0, 0)');
  }
  const width = Math.max(...squares.map((square) => square.tileOffsetX + square.heights.length));
  const height = Math.max(...squares.map((square) => square.tileOffsetY + (square.heights[0]?.length ?? 0)));
  const columns = Array.from({ length: width }, () => new Int32Array(height));
  // Edges first, then every square's own tile corners over them.
  for (const ownCornersOnly of [false, true]) {
    for (const { tileOffsetX, tileOffsetY, heights } of squares) {
      for (let x = 0; x < heights.length; x++) {
        const column = heights[x];
        const target = columns[tileOffsetX + x];
        if (!column || !target || (ownCornersOnly && x === heights.length - 1)) continue;
        const rows = ownCornersOnly ? column.length - 1 : column.length;
        for (let y = 0; y < rows; y++) target[tileOffsetY + y] = column[y] ?? 0;
      }
    }
  }
  return columns;
}
