import type { ArenaConfig } from '../../../core/arena/ArenaConfig';
import { getBoundsFromRegion } from '../../../rs/collision/WalkabilityAnalyzer';

/**
 * The waves arena floor by row (y, then inclusive x spans): the 870 tiles the cache bake of map
 * square 28_48 flood-fills from (33, 31) without Sol's warriors, the four 3x3 pillars excluded
 * (OpenRS2 cache 2437; `stageArenaCache.test.ts` checks it against the bake). Only the pre-cache
 * placeholder: once the cache loads, the bake itself is installed, with pillar collision.
 */
const WAVE_FLOOR_ROWS: readonly (readonly [y: number, spans: readonly (readonly [number, number])[]])[] = [
  [
    18,
    [
      [29, 30],
      [35, 36],
    ],
  ],
  [19, [[25, 40]]],
  [20, [[23, 42]]],
  [21, [[21, 44]]],
  [22, [[20, 45]]],
  [23, [[19, 46]]],
  [24, [[19, 46]]],
  [25, [[18, 47]]],
  [
    26,
    [
      [18, 23],
      [27, 38],
      [42, 47],
    ],
  ],
  [
    27,
    [
      [17, 23],
      [27, 38],
      [42, 48],
    ],
  ],
  [
    28,
    [
      [17, 23],
      [27, 38],
      [42, 48],
    ],
  ],
  [29, [[17, 47]]],
  [30, [[17, 46]]],
  [31, [[16, 46]]],
  [32, [[16, 46]]],
  [33, [[17, 46]]],
  [34, [[17, 46]]],
  [35, [[17, 46]]],
  [36, [[17, 46]]],
  [37, [[16, 46]]],
  [38, [[16, 46]]],
  [39, [[17, 46]]],
  [40, [[17, 47]]],
  [
    41,
    [
      [17, 23],
      [27, 38],
      [42, 48],
    ],
  ],
  [
    42,
    [
      [17, 23],
      [27, 38],
      [42, 48],
    ],
  ],
  [
    43,
    [
      [18, 23],
      [27, 38],
      [42, 47],
    ],
  ],
  [44, [[18, 47]]],
  [45, [[19, 46]]],
  [46, [[19, 46]]],
  [47, [[20, 45]]],
  [48, [[21, 44]]],
  [49, [[23, 42]]],
  [50, [[25, 40]]],
  [
    51,
    [
      [29, 30],
      [35, 36],
    ],
  ],
];

export function colosseumWaveFloorTiles(): Set<string> {
  const tiles = new Set<string>();
  for (const [y, spans] of WAVE_FLOOR_ROWS) {
    for (const [from, to] of spans) for (let x = from; x <= to; x++) tiles.add(`${x},${y}`);
  }
  return tiles;
}

/** The pre-cache arena for waves 1-11: the floor, without collision flags. */
export function colosseumWaveArenaPlaceholder(): ArenaConfig {
  const walkableTiles = colosseumWaveFloorTiles();
  return { bounds: getBoundsFromRegion(walkableTiles), walkableTiles, collisionMap: null };
}
