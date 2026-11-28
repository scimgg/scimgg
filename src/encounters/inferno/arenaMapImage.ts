/**
 * The Inferno arena's terrain as a static top-down image, for the spawn-map editor's faint
 * background. Terrain colors only (no NPCs, LOCs or pillars), colored exactly as the minimap
 * colors it (`src/components/minimapTerrain.ts`), generated offline from the cache by
 * `npx tsx scripts/generate-inferno-arena-map.mts`.
 *
 * North up, `pixelsPerTile` square pixels per tile: local tile (x, y) covers columns
 * `(x - bounds.minX) * pixelsPerTile` and rows `(bounds.maxY - y) * pixelsPerTile`, each
 * `pixelsPerTile` wide. The bounds are the arena's (`INFERNO_ARENA_BOUNDS`, 17-45 x 17-46) and two
 * tiles beyond, so its walls and edges show.
 */
import { fitSpawnMapTileSize, spawnMapTileBox } from '../../components/spawnMapGeometry';

const BOUNDS = { minX: 15, maxX: 47, minY: 15, maxY: 48 } as const;
const PIXELS_PER_TILE = 8;

/** Pixel projection for this image's north-up plane. Positions are southwest tile anchors. */
export function arenaTileBox(position: readonly [number, number], size: number, tileSize: number, height = size) {
  return spawnMapTileBox(BOUNDS, position, size, tileSize, height);
}

/** Fit one square, integer CSS-pixel tile scale; never stretch the two axes independently. */
export function fitArenaTileSize(width: number, height: number) {
  return fitSpawnMapTileSize(BOUNDS, width, height);
}

export const INFERNO_ARENA_MAP_IMAGE = {
  url: '/assets/encounters/inferno-arena-map.webp',
  /** Local tiles covered, inclusive. */
  bounds: BOUNDS,
  pixelsPerTile: PIXELS_PER_TILE,
  width: (BOUNDS.maxX - BOUNDS.minX + 1) * PIXELS_PER_TILE,
  height: (BOUNDS.maxY - BOUNDS.minY + 1) * PIXELS_PER_TILE,
} as const;
