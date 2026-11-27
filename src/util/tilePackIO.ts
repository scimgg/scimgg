/**
 * RuneLite marker coordinates are region-local: `regionId` is a map square (`x << 8 | y`) and
 * `regionX`/`regionY` the tile within it (0-63). Simulation (0, 0) is the south-west tile of the
 * encounter's origin square, so a marker in an arena square `(dx, dy)` from the origin sits at
 * simulation `(dx * 64 + regionX, dy * 64 + regionY)`. Only the encounter footprint's arena
 * squares are interchanged. RuneLite colors use alpha-first `#AARRGGBB`; local markers use
 * `#RRGGBB` and separate opacity.
 */

import { type EncounterMapFootprint, resolveEncounterMapFootprint } from '../core/encounters/mapFootprint';
import { encounterRegistry } from '../encounters/registry';
import { normalizeMarkerArray } from '../hooks/tileMarkerState';
import { MAP_SQUARE_SIZE } from '../rs/map/MapLoader';
import { getMapSquareOffsetOfTile } from '../rs/map/mapSquareBlock';
import type { RuneLiteGroundMarkerPoint, TileMarker } from '../types/tileMarkers';
import { DEFAULT_MARKER_COLOR, DEFAULT_MARKER_OPACITY } from '../types/tileMarkers';

export { copyToClipboard } from './clipboard';

function parseRuneLiteColor(rlColor: string): { color: string; opacity: number } {
  const hex = rlColor.startsWith('#') ? rlColor.slice(1) : rlColor;

  if (hex.length === 8) {
    // #AARRGGBB
    const alpha = parseInt(hex.slice(0, 2), 16);
    const rgb = hex.slice(2);
    return {
      color: `#${rgb.toUpperCase()}`,
      opacity: Math.round((alpha / 255) * 100) / 100,
    };
  }

  if (hex.length === 6) {
    // #RRGGBB (no alpha)
    return { color: `#${hex.toUpperCase()}`, opacity: 1.0 };
  }

  return { color: DEFAULT_MARKER_COLOR, opacity: DEFAULT_MARKER_OPACITY };
}

function toRuneLiteColor(color: string, opacity: number): string {
  const hex = color.startsWith('#') ? color.slice(1) : color;
  const alpha = Math.round(Math.max(0, Math.min(1, opacity)) * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();
  return `#${alpha}${hex.toUpperCase().padEnd(6, '0')}`;
}

// Resolve contract variants through their parent arena descriptor, the way tile packs and
// loadouts already do; a variant kind carries no map square of its own.
function getEncounterFootprint(encounterKind: string): EncounterMapFootprint | null {
  const desc = encounterRegistry.getDescriptorForKind(encounterKind);
  return desc ? resolveEncounterMapFootprint(desc) : null;
}

function regionIdOf(mapX: number, mapY: number): number {
  return (mapX << 8) | mapY;
}

export function importRuneLiteMarkers(jsonString: string, encounterKind: string): TileMarker[] | null {
  const footprint = getEncounterFootprint(encounterKind);
  if (footprint === null) return null;
  const { origin } = footprint;
  // Each arena square's region id, mapped to where its tile (0, 0) sits in simulation coordinates.
  const arenaRegions = new Map(
    footprint.arenaBlock.map(({ dx, dy, tileOffsetX, tileOffsetY }) => [
      regionIdOf(origin.x + dx, origin.y + dy),
      { tileOffsetX, tileOffsetY },
    ]),
  );

  let parsed: RuneLiteGroundMarkerPoint[];
  try {
    parsed = JSON.parse(jsonString);
    if (!Array.isArray(parsed)) return null;
  } catch {
    return null;
  }

  const markers: Partial<TileMarker>[] = [];
  for (const point of parsed) {
    const region = arenaRegions.get(Math.round(point.regionId));
    if (!region) continue;

    // The JSON is whatever was on the clipboard, so `color` is only trusted to be a
    // string once checked; `parseRuneLiteColor` calls string methods on it.
    const { color, opacity } =
      typeof point.color === 'string'
        ? parseRuneLiteColor(point.color)
        : { color: DEFAULT_MARKER_COLOR, opacity: DEFAULT_MARKER_OPACITY };

    markers.push({
      x: region.tileOffsetX + Math.round(point.regionX),
      y: region.tileOffsetY + Math.round(point.regionY),
      color,
      opacity,
      ...(typeof point.label === 'string' ? { label: point.label } : {}),
    });
  }

  // Through the same gate as stored markers: a pasted point with a missing or
  // non-numeric coordinate becomes NaN above, which no renderer and no recording accepts.
  return normalizeMarkerArray(markers);
}

export function exportRuneLiteMarkers(markers: TileMarker[], encounterKind: string): string | null {
  const footprint = getEncounterFootprint(encounterKind);
  if (footprint === null) return null;
  const { origin } = footprint;

  const points: RuneLiteGroundMarkerPoint[] = markers.map((marker) => {
    // Floored, so a marker south or west of the origin square lands in the region at -1 with a
    // local coordinate in 0-63, never a negative remainder.
    const { dx, dy } = getMapSquareOffsetOfTile(marker.x, marker.y);
    return {
      regionId: regionIdOf(origin.x + dx, origin.y + dy),
      regionX: marker.x - dx * MAP_SQUARE_SIZE,
      regionY: marker.y - dy * MAP_SQUARE_SIZE,
      z: 0,
      color: toRuneLiteColor(marker.color, marker.opacity),
      ...(marker.label ? { label: marker.label } : {}),
    };
  });

  return JSON.stringify(points);
}

export async function readFromClipboard(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}
