import type { ArenaConfig } from '../../core/arena/ArenaConfig';
import { CollisionFlag } from '../../rs/collision/CollisionFlag';
import { createCollisionMap } from '../../rs/collision/WalkabilityAnalyzer';
import type { Coordinate } from '../../types/simulation';

// Practice walk bounds along the cache room's inside walls. Coordinates are local to (47, 100).
export const BOUNDS = { minX: 26, maxX: 36, minY: 39, maxY: 58, width: 11, height: 20 };
export const START_TILE: Coordinate = [31, 50];
// Place the footprint between the front pillars, around the Wiki's local pin [31, 54].
export const WARDEN_TILE: Coordinate = [28, 52];
// Both Awakened Duke cache types (12166 and 12191) occupy a 7×7 footprint.
export const WARDEN_SIZE = 7;
export const DUKE_CENTER_TILE: Coordinate = [
  WARDEN_TILE[0] + (WARDEN_SIZE - 1) / 2,
  WARDEN_TILE[1] + (WARDEN_SIZE - 1) / 2,
];
// Cache LOCs 47513 and 47523 span three tiles from their west/east anchors 25 and 35.
const PILLAR_ROWS = [40, 44, 48, 52];
export const PILLARS = PILLAR_ROWS.flatMap((y): Coordinate[] => [
  [25, y],
  [26, y],
  [27, y],
  [35, y],
  [36, y],
  [37, y],
]);
// Cache LOC 47555.
export const VENTS = [42, 46, 50].flatMap((y) => [28, 31, 34].map((x): Coordinate => [x, y]));
export const ORB_LANE = { west: BOUNDS.minX, east: BOUNDS.maxX, y: WARDEN_TILE[1] - 1 };

export function sameTile([x, y]: Coordinate, [otherX, otherY]: Coordinate): boolean {
  return x === otherX && y === otherY;
}

export function square([x, y]: Coordinate, radius: number): Coordinate[] {
  const tiles: Coordinate[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) tiles.push([x + dx, y + dy]);
  }
  return tiles;
}

export const COVER_TILES = PILLAR_ROWS.flatMap((y) =>
  [27, 35].flatMap((x): Coordinate[] => [
    [x, y - 1],
    [x, y - 2],
    [x, y - 3],
  ]),
);
export function isInMeleeLane([x, y]: Coordinate): boolean {
  return x >= WARDEN_TILE[0] - 1 && x <= WARDEN_TILE[0] + WARDEN_SIZE && y === WARDEN_TILE[1] - 1;
}

// The drill uses the row directly in front of Duke. The pillar diagonals can still bait melee.
export const SLAM_TILES = Array.from({ length: WARDEN_SIZE }, (_, x): Coordinate => [WARDEN_TILE[0] + x, ORB_LANE.y]);

export function buildArena(): ArenaConfig {
  const collisionMap = createCollisionMap(64, 64);
  const walkableTiles = new Set<string>();
  for (let y = 0; y < collisionMap.sizeY; y++) {
    for (let x = 0; x < collisionMap.sizeX; x++) {
      if (x < BOUNDS.minX || x > BOUNDS.maxX || y < BOUNDS.minY || y > BOUNDS.maxY) {
        collisionMap.flag(x, y, CollisionFlag.FLOOR);
      } else if (PILLARS.some((tile) => sameTile(tile, [x, y]))) {
        collisionMap.flag(x, y, CollisionFlag.OBJECT | CollisionFlag.OBJECT_PROJECTILE_BLOCKER);
      } else if (y >= WARDEN_TILE[1]) {
        // Cache 2772, square (47, 100): floor clipping across y=52–53 seals off the north side.
        collisionMap.flag(x, y, CollisionFlag.FLOOR);
      } else {
        walkableTiles.add(`${x},${y}`);
      }
    }
  }
  return { bounds: { ...BOUNDS }, collisionMap, walkableTiles };
}
