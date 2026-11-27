import { MAP_SQUARE_SIZE } from '../../rs/map/MapLoader';
import type { LocRenderOptions } from '../environment/locRenderOptions';
import type { EncounterRenderConfig } from './encounterRenderConfig';

/**
 * Expands loc-render bounds across every loaded map square so rendering and
 * viewport interaction agree on which scenery exists. A scene of the origin
 * square alone keeps the encounter's own filter, or the default arena clip.
 */
export function resolveEncounterLocRenderOptions(
  config: EncounterRenderConfig | undefined,
): LocRenderOptions | undefined {
  const options = config?.locRender;
  const offsets = config?.mapSquareOffsets;
  if (!offsets || offsets.length <= 1) return options;
  const minX = Math.min(...offsets.map(({ dx }) => dx)) * MAP_SQUARE_SIZE;
  const maxX = (Math.max(...offsets.map(({ dx }) => dx)) + 1) * MAP_SQUARE_SIZE - 1;
  const minY = Math.min(...offsets.map(({ dy }) => dy)) * MAP_SQUARE_SIZE;
  const maxY = (Math.max(...offsets.map(({ dy }) => dy)) + 1) * MAP_SQUARE_SIZE - 1;
  return { ...options, bounds: { minX, maxX, minY, maxY }, marginTiles: 0 };
}
