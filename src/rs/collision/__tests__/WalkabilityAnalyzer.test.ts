import { describe, expect, it } from 'vitest';
import { LocModelType } from '../../config/loctype/LocModelType';
import type { MapSquareData } from '../../map/MapLoader';
import { CollisionFlag } from '../CollisionFlag';
import {
  analyzeWalkability,
  applyLocCollision,
  type CollisionMap,
  createCollisionMap,
  findContiguousRegion,
  type LocCollisionLoader,
  overlayCollisionMap,
} from '../WalkabilityAnalyzer';

const SIZE = 64;

function makeOpenMapSquare(): MapSquareData {
  const level = <T>(make: () => T): T[][] => [Array.from({ length: SIZE }, () => make())];
  return {
    mapX: 0,
    mapY: 0,
    tileHeights: level(() => new Int32Array(SIZE)),
    tileUnderlays: level(() => new Uint16Array(SIZE).fill(1)),
    tileOverlays: level(() => new Int16Array(SIZE)),
    tileShapes: level(() => new Uint8Array(SIZE)),
    tileRotations: level(() => new Uint8Array(SIZE)),
    tileRenderFlags: level(() => new Uint8Array(SIZE)),
    tileLightOcclusions: level(() => new Uint8Array(SIZE)),
  };
}

const locLoader: LocCollisionLoader = (id) => {
  if (id === 1) return { clipType: 1, sizeX: 1, sizeY: 1, blocksProjectile: false };
  if (id === 2) return { clipType: 2, sizeX: 3, sizeY: 3, blocksProjectile: true };
  if (id === 3) return { clipType: 0, sizeX: 1, sizeY: 1, blocksProjectile: false };
  if (id === 4) return { clipType: 1, sizeX: 2, sizeY: 3, blocksProjectile: false };
  if (id === 5) return { clipType: 1, sizeX: 2, sizeY: 3, blocksProjectile: true };
  if (id === 6) return { clipType: 1, sizeX: 1, sizeY: 1, blocksProjectile: true };
  return undefined;
};

function expectObjectFlags(
  collisionMap: CollisionMap,
  originX: number,
  originY: number,
  width: number,
  height: number,
): void {
  for (let dx = 0; dx < width; dx++) {
    for (let dy = 0; dy < height; dy++) {
      expect(collisionMap.hasFlag(originX + dx, originY + dy, CollisionFlag.OBJECT)).toBe(true);
    }
  }
}

describe('analyzeWalkability extraLocs (dynamic loc baking)', () => {
  it('bakes a clipping dynamic loc as OBJECT and removes it from the walkable set', () => {
    const { collisionMap, walkableTiles } = analyzeWalkability(makeOpenMapSquare(), undefined, locLoader, 0, [
      { id: 1, localX: 10, localY: 10, type: LocModelType.NORMAL, rotation: 0, level: 0 },
    ]);

    expect(collisionMap.hasFlag(10, 10, CollisionFlag.OBJECT)).toBe(true);
    expect(walkableTiles.has('10,10')).toBe(false);
    expect(walkableTiles.has('11,10')).toBe(true);
    expect(collisionMap.hasFlag(11, 10, CollisionFlag.OBJECT)).toBe(false);
  });

  it('bakes a 3x3 clipping loc across its whole footprint', () => {
    const { collisionMap, walkableTiles } = analyzeWalkability(makeOpenMapSquare(), undefined, locLoader, 0, [
      { id: 2, localX: 20, localY: 20, type: LocModelType.NORMAL, rotation: 0, level: 0 },
    ]);
    for (let dx = 0; dx < 3; dx++) {
      for (let dy = 0; dy < 3; dy++) {
        expect(collisionMap.hasFlag(20 + dx, 20 + dy, CollisionFlag.OBJECT)).toBe(true);
        expect(walkableTiles.has(`${20 + dx},${20 + dy}`)).toBe(false);
      }
    }
  });

  it('rotates non-square clipping loc footprints before baking object collision', () => {
    const { collisionMap, walkableTiles } = analyzeWalkability(makeOpenMapSquare(), undefined, locLoader, 0, [
      { id: 4, localX: 30, localY: 30, type: LocModelType.NORMAL, rotation: 1, level: 0 },
    ]);

    expectObjectFlags(collisionMap, 30, 30, 3, 2);
    expect(walkableTiles.has('32,31')).toBe(false);
    expect(collisionMap.hasFlag(31, 32, CollisionFlag.OBJECT)).toBe(false);
  });

  it('clips object footprints at the map edge without wrapping flags', () => {
    const { collisionMap } = analyzeWalkability(makeOpenMapSquare(), undefined, locLoader, 0, [
      { id: 4, localX: 62, localY: 62, type: LocModelType.NORMAL, rotation: 0, level: 0 },
    ]);

    expectObjectFlags(collisionMap, 62, 62, 2, 2);
    expect(collisionMap.getFlag(0, 0)).toBe(0);
    expect(collisionMap.getFlag(63, 61)).toBe(0);
  });

  it('sets projectile blocker flags on clipping object footprints when the loc blocks projectiles', () => {
    const { collisionMap } = analyzeWalkability(makeOpenMapSquare(), undefined, locLoader, 0, [
      { id: 2, localX: 20, localY: 20, type: LocModelType.NORMAL, rotation: 0, level: 0 },
    ]);

    expect(collisionMap.hasFlag(21, 21, CollisionFlag.OBJECT_PROJECTILE_BLOCKER)).toBe(true);
  });

  it('bakes type 12-21 clipping locs as object collision', () => {
    const { collisionMap, walkableTiles } = analyzeWalkability(makeOpenMapSquare(), undefined, locLoader, 0, [
      { id: 4, localX: 40, localY: 40, type: LocModelType.ROOF_FLAT, rotation: 0, level: 0 },
    ]);

    expectObjectFlags(collisionMap, 40, 40, 2, 3);
    expect(walkableTiles.has('41,42')).toBe(false);
  });

  it('does not block a non-clipping (clipType 0) dynamic loc', () => {
    const { collisionMap, walkableTiles } = analyzeWalkability(makeOpenMapSquare(), undefined, locLoader, 0, [
      { id: 3, localX: 12, localY: 12, type: LocModelType.NORMAL, rotation: 0, level: 0 },
    ]);
    expect(collisionMap.hasFlag(12, 12, CollisionFlag.OBJECT)).toBe(false);
    expect(walkableTiles.has('12,12')).toBe(true);
  });

  it('ignores dynamic locs on a different level', () => {
    const { collisionMap, walkableTiles } = analyzeWalkability(makeOpenMapSquare(), undefined, locLoader, 0, [
      { id: 1, localX: 14, localY: 14, type: LocModelType.NORMAL, rotation: 0, level: 1 },
    ]);
    expect(collisionMap.hasFlag(14, 14, CollisionFlag.OBJECT)).toBe(false);
    expect(walkableTiles.has('14,14')).toBe(true);
  });
});

describe('analyzeWalkability static loc exclusions', () => {
  it('omits every flag of an excluded loc id across its whole rotated footprint', () => {
    const locations = {
      mapX: 0,
      mapY: 0,
      locations: [
        { id: 5, localX: 20, localY: 20, type: LocModelType.NORMAL, rotation: 1, level: 0 },
        { id: 1, localX: 24, localY: 20, type: LocModelType.NORMAL, rotation: 0, level: 0 },
      ],
    };

    const { collisionMap, walkableTiles } = analyzeWalkability(
      makeOpenMapSquare(),
      locations,
      locLoader,
      0,
      undefined,
      new Set([5]),
    );

    expect(collisionMap.hasFlag(20, 20, CollisionFlag.OBJECT)).toBe(false);
    expect(collisionMap.hasFlag(22, 21, CollisionFlag.OBJECT)).toBe(false);
    expect(collisionMap.hasFlag(22, 21, CollisionFlag.OBJECT_PROJECTILE_BLOCKER)).toBe(false);
    expect(walkableTiles.has('20,20')).toBe(true);
    expect(collisionMap.hasFlag(24, 20, CollisionFlag.OBJECT)).toBe(true);
  });

  it('leaves every loc id that was not excluded fully baked', () => {
    const locations = {
      mapX: 0,
      mapY: 0,
      locations: [{ id: 6, localX: 19, localY: 20, type: LocModelType.WALL, rotation: 2, level: 0 }],
    };

    const { collisionMap } = analyzeWalkability(makeOpenMapSquare(), locations, locLoader, 0, undefined, new Set([5]));

    expect(collisionMap.hasFlag(19, 20, CollisionFlag.WALL_EAST_PROJECTILE_BLOCKER)).toBe(true);
    expect(collisionMap.hasFlag(20, 20, CollisionFlag.WALL_WEST_PROJECTILE_BLOCKER)).toBe(true);
  });
});

describe('applyLocCollision', () => {
  it('sets OBJECT on a clipping NORMAL loc footprint', () => {
    const map = createCollisionMap(SIZE, SIZE);
    applyLocCollision(map, { id: 1, localX: 5, localY: 5, type: LocModelType.NORMAL, rotation: 0 }, locLoader);
    expect(map.hasFlag(5, 5, CollisionFlag.OBJECT)).toBe(true);
  });

  it('is a no-op for an unknown loc id', () => {
    const map = createCollisionMap(SIZE, SIZE);
    applyLocCollision(map, { id: 999, localX: 5, localY: 5, type: LocModelType.NORMAL, rotation: 0 }, locLoader);
    expect(map.getFlag(5, 5)).toBe(0);
  });

  it.each([
    { rotation: 0, self: CollisionFlag.WALL_WEST, adjacent: [4, 5], adjacentFlag: CollisionFlag.WALL_EAST },
    { rotation: 1, self: CollisionFlag.WALL_NORTH, adjacent: [5, 6], adjacentFlag: CollisionFlag.WALL_SOUTH },
    { rotation: 2, self: CollisionFlag.WALL_EAST, adjacent: [6, 5], adjacentFlag: CollisionFlag.WALL_WEST },
    { rotation: 3, self: CollisionFlag.WALL_SOUTH, adjacent: [5, 4], adjacentFlag: CollisionFlag.WALL_NORTH },
  ])('sets straight wall flags for rotation $rotation', ({ rotation, self, adjacent, adjacentFlag }) => {
    const map = createCollisionMap(SIZE, SIZE);
    applyLocCollision(map, { id: 1, localX: 5, localY: 5, type: LocModelType.WALL, rotation }, locLoader);

    const [adjacentX, adjacentY] = adjacent;
    expect(map.hasFlag(5, 5, self)).toBe(true);
    expect(map.hasFlag(adjacentX, adjacentY, adjacentFlag)).toBe(true);
  });
});

describe('findContiguousRegion', () => {
  it('does not flood-fill through directional wall flags', () => {
    const { collisionMap } = analyzeWalkability(makeOpenMapSquare(), undefined, locLoader, 0, [
      { id: 1, localX: 10, localY: 10, type: LocModelType.WALL, rotation: 2, level: 0 },
    ]);
    const walkableTiles = new Set(['10,10', '11,10']);

    const region = findContiguousRegion(walkableTiles, 10, 10, collisionMap);

    expect(region.has('10,10')).toBe(true);
    expect(region.has('11,10')).toBe(false);
  });
});

describe('overlayCollisionMap', () => {
  /** A map whose local tiles start at -64, like CacheManager's three-square block map. */
  function blockMap(): CollisionMap {
    const inner = createCollisionMap(192, 192);
    return {
      sizeX: 192,
      sizeY: 192,
      getFlag: (x, y) => inner.getFlag(x + 64, y + 64),
      hasFlag: (x, y, flag) => inner.hasFlag(x + 64, y + 64, flag),
      flag: (x, y, flag) => inner.flag(x + 64, y + 64, flag),
      unflag: (x, y, flag) => inner.unflag(x + 64, y + 64, flag),
    };
  }

  it("keeps the base's coordinates, including a negative origin", () => {
    const base = blockMap();
    base.flag(30, 32, CollisionFlag.WALL_EAST);
    base.flag(-10, 70, CollisionFlag.OBJECT);
    const overlay = overlayCollisionMap(base);

    expect(overlay.getFlag(30, 32)).toBe(CollisionFlag.WALL_EAST);
    expect(overlay.hasFlag(-10, 70, CollisionFlag.OBJECT)).toBe(true);
    expect(overlay.getFlag(-65, 0)).toBe(-1);
  });

  it('edits only itself, and ignores tiles outside the base', () => {
    const base = blockMap();
    base.flag(30, 32, CollisionFlag.WALL_EAST);
    const overlay = overlayCollisionMap(base);

    overlay.flag(30, 32, CollisionFlag.OBJECT);
    overlay.unflag(30, 32, CollisionFlag.WALL_EAST);
    overlay.flag(-65, 0, CollisionFlag.OBJECT);

    expect(overlay.getFlag(30, 32)).toBe(CollisionFlag.OBJECT);
    expect(base.getFlag(30, 32)).toBe(CollisionFlag.WALL_EAST);
    expect(overlay.getFlag(-65, 0)).toBe(-1);
  });
});
