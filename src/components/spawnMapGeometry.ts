/**
 * The spawn layout map's plane: a north-up grid of square tiles over inclusive local bounds, at one
 * integer CSS-pixel tile size. Kept apart from `SpawnLayoutMap.tsx` so scripts and data modules can
 * project tiles without loading the component and its stylesheet.
 */
import type { Coordinate } from '../types/simulation';

/** Local tiles a map plane covers, inclusive, north up. */
export interface SpawnMapBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface SpawnMapBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Pixel projection for a north-up plane over `bounds`. Positions are southwest tile anchors. */
export function spawnMapTileBox(
  bounds: SpawnMapBounds,
  [x, y]: Readonly<Coordinate>,
  size: number,
  tileSize: number,
  height = size,
): SpawnMapBox {
  return {
    left: (x - bounds.minX) * tileSize,
    top: (bounds.maxY + 1 - y - height) * tileSize,
    width: size * tileSize,
    height: height * tileSize,
  };
}

/** Fit one square, integer CSS-pixel tile scale; never stretch the two axes independently. */
export function fitSpawnMapTileSize(bounds: SpawnMapBounds, width: number, height: number): number {
  return Math.max(
    1,
    Math.floor(Math.min(width / (bounds.maxX - bounds.minX + 1), height / (bounds.maxY - bounds.minY + 1))),
  );
}
