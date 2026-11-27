// Its own file: CacheManager.test.ts mocks the map loader module for the whole suite, and this bake
// needs the real collision rules over synthetic map squares.
import { afterEach, describe, expect, it } from 'vitest';
import { setArenaConfig } from '../../core/constants';
import { canMoveInDirection } from '../../core/pathfinder';
import { CollisionFlag } from '../../rs/collision/CollisionFlag';
import type { CollisionLocInput, LocCollisionInfo } from '../../rs/collision/WalkabilityAnalyzer';
import { LocModelType } from '../../rs/config/loctype/LocModelType';
import type { MapSquareData, MapSquareLocations } from '../../rs/map/MapLoader';
import { CacheManager } from '../CacheManager';

afterEach(() => setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true));

const ORIGIN = { x: 40, y: 50 };
const TALL_OBJECT = 1;
const WALL = 2;
const LOC_TYPES: Record<number, LocCollisionInfo> = {
  [TALL_OBJECT]: { clipType: 1, sizeX: 1, sizeY: 2, blocksProjectile: true },
  [WALL]: { clipType: 1, sizeX: 1, sizeY: 1, blocksProjectile: true },
};

function openSquare(mapX: number, mapY: number): MapSquareData {
  const level = <T>(make: () => T): T[][] => [Array.from({ length: 64 }, () => make())];
  return {
    mapX,
    mapY,
    tileHeights: level(() => new Int32Array(65)),
    tileUnderlays: level(() => new Uint16Array(64).fill(1)),
    tileOverlays: level(() => new Int16Array(64)),
    tileShapes: level(() => new Uint8Array(64)),
    tileRotations: level(() => new Uint8Array(64)),
    tileRenderFlags: level(() => new Uint8Array(64)),
    tileLightOcclusions: level(() => new Uint8Array(64)),
  };
}

const loc = (id: number, localX: number, localY: number, type: number, rotation = 0): CollisionLocInput => ({
  id,
  localX,
  localY,
  type,
  rotation,
  level: 0,
});

// Square-local placements. Each straddles the seam between the origin (y 0-63) and the square
// north of it (y 64-127), so half of its collision is the other square's.
const ORIGIN_LOCS = [
  // A 1x2 object anchored on the origin's top row: its second tile is the north square's (10, 0).
  loc(TALL_OBJECT, 10, 63, LocModelType.NORMAL),
  // A wall on the north edge of (20, 63): WALL_NORTH there, WALL_SOUTH on (20, 64).
  loc(WALL, 20, 63, LocModelType.WALL, 1),
];
// A wall on the south edge of the north square's (30, 0): WALL_SOUTH there, WALL_NORTH on (30, 63).
const NORTH_LOCS = [loc(WALL, 30, 0, LocModelType.WALL, 3)];

/** The production multi-square bake over a synthetic 1x2 arena of open floor. */
async function bakeTwoSquareArena(extraLocs?: readonly CollisionLocInput[]) {
  const manager = new CacheManager();
  Reflect.set(manager, 'mapLoader', {
    loadMapSquare: async (mapX: number, mapY: number) => openSquare(mapX, mapY),
    loadLocations: async (mapX: number, mapY: number): Promise<MapSquareLocations> => ({
      mapX,
      mapY,
      locations: mapX === ORIGIN.x && mapY === ORIGIN.y ? ORIGIN_LOCS : mapY === ORIGIN.y + 1 ? NORTH_LOCS : [],
    }),
  });
  Reflect.set(manager, 'locTypeLoader', { load: (id: number) => LOC_TYPES[id] ?? { clipType: 0, sizeX: 1, sizeY: 1 } });
  return manager.buildArenaConfig({
    mapX: ORIGIN.x,
    mapY: ORIGIN.y,
    seedX: 5,
    seedY: 5,
    mapSquareOffsets: [
      { dx: 0, dy: 0 },
      { dx: 0, dy: 1 },
    ],
    extraLocs,
  });
}

describe('the multi-square collision bake across a playable seam', () => {
  it('blocks both tiles of an object that straddles the seam', async () => {
    const arena = await bakeTwoSquareArena();
    for (const [x, y] of [
      [10, 63],
      [10, 64],
    ] as const) {
      expect(arena.collisionMap?.hasFlag(x, y, CollisionFlag.OBJECT), `${x},${y}`).toBe(true);
      expect(arena.walkableTiles?.has(`${x},${y}`), `${x},${y}`).toBe(false);
    }
    setArenaConfig(arena);
    expect(canMoveInDirection(10, 65, 10, 64)).toBe(false);
    expect(canMoveInDirection(10, 62, 10, 63)).toBe(false);
  });

  it('blocks a wall on the seam in both directions, whichever square holds the wall', async () => {
    const arena = await bakeTwoSquareArena();
    expect(arena.collisionMap?.hasFlag(20, 64, CollisionFlag.WALL_SOUTH)).toBe(true);
    expect(arena.collisionMap?.hasFlag(30, 63, CollisionFlag.WALL_NORTH)).toBe(true);
    setArenaConfig(arena);
    for (const x of [20, 30]) {
      expect(canMoveInDirection(x, 63, x, 64), `north across x ${x}`).toBe(false);
      expect(canMoveInDirection(x, 64, x, 63), `south across x ${x}`).toBe(false);
    }
  });

  it('keeps an ordinary seam walkable, and the region reaches the north square through it', async () => {
    const arena = await bakeTwoSquareArena();
    expect(arena.collisionMap?.getFlag(40, 63)).toBe(0);
    expect(arena.collisionMap?.getFlag(40, 64)).toBe(0);
    expect(arena.walkableTiles?.has('40,64')).toBe(true);
    expect(arena.bounds).toMatchObject({ minX: 0, maxX: 63, minY: 0, maxY: 127 });
    setArenaConfig(arena);
    expect(canMoveInDirection(40, 63, 40, 64)).toBe(true);
    expect(canMoveInDirection(40, 64, 40, 63)).toBe(true);
  });

  it("applies an encounter's extra locs across the seam like the cache's own", async () => {
    // Extra locs are origin-local, which is the block's coordinates, so one on the seam blocks both tiles.
    const arena = await bakeTwoSquareArena([loc(TALL_OBJECT, 50, 63, LocModelType.NORMAL)]);
    expect(arena.collisionMap?.hasFlag(50, 64, CollisionFlag.OBJECT)).toBe(true);
    expect(arena.walkableTiles?.has('50,64')).toBe(false);
  });
});
