import type { ArenaConfig } from '../../core/arena/ArenaConfig';
import type { CollisionLocPlacement } from '../../core/arena/collisionSpec';
import { isInsideArena } from '../../npcs/colosseum/solAttacks';
import { CollisionFlag } from '../../rs/collision/CollisionFlag';
import { type CollisionMap, getBoundsFromRegion, overlayCollisionMap } from '../../rs/collision/WalkabilityAnalyzer';
import { SOL_ARENA } from './constants';

// Literal inventory also keeps every cosmetic variant in the production cache trim.
export const SOL_BOUNDARY_LOC_IDS = [50753, 50754, 50755, 50756, 50757, 50758] as const;

/**
 * Packet-spawned shield warriors, not NPC actors. K:3998 records all 48 at player control;
 * M records the same tiles, shape 10 and rotations, with different cosmetic variants.
 * Reproduce K's observed variant arrangement rather than invent a random selection rule.
 * These placements are shared by runtime scene objects and cache collision baking.
 */
export const SOL_BOUNDARY_WARRIORS: readonly CollisionLocPlacement[] = [
  ...[4, 1, 1, 1, 4, 4, 2, 5, 2, 1, 1, 2].map((variant, index) => ({
    locId: SOL_BOUNDARY_LOC_IDS[variant - 1],
    localX: 27 + index,
    localY: 42,
    rotation: 0,
    type: 10,
    level: 0,
  })),
  ...[4, 5, 4, 3, 6, 5, 2, 1, 1, 5, 6, 3].map((variant, index) => ({
    locId: SOL_BOUNDARY_LOC_IDS[variant - 1],
    localX: 40,
    localY: 29 + index,
    rotation: 1,
    type: 10,
    level: 0,
  })),
  ...[6, 1, 1, 4, 1, 6, 1, 1, 1, 4, 4, 1].map((variant, index) => ({
    locId: SOL_BOUNDARY_LOC_IDS[variant - 1],
    localX: 27 + index,
    localY: 27,
    rotation: 2,
    type: 10,
    level: 0,
  })),
  ...[1, 6, 1, 5, 2, 1, 2, 6, 6, 5, 4, 2].map((variant, index) => ({
    locId: SOL_BOUNDARY_LOC_IDS[variant - 1],
    localX: 25,
    localY: 29 + index,
    rotation: 3,
    type: 10,
    level: 0,
  })),
];

/**
 * Wave 12's arena from the open waves arena `base`: Sol's 14x14-minus-corners floor, fenced in by the
 * warriors. Cache loc types 50753-50758 are all 1x1, clipType 1, not projectile-blocking, so each
 * blocks its own tile as `CollisionFlag.OBJECT` (`stageArenaCache.test.ts` checks this against the
 * cache bake with the warriors). A base without a collision map keeps none.
 */
export function composeSolStageArena(base: ArenaConfig): ArenaConfig {
  const walkableTiles = new Set<string>();
  for (let x = SOL_ARENA.minX; x <= SOL_ARENA.maxX; x++) {
    for (let y = SOL_ARENA.minY; y <= SOL_ARENA.maxY; y++) {
      const key = `${x},${y}`;
      if (isInsideArena([x, y], SOL_ARENA) && (base.walkableTiles === null || base.walkableTiles.has(key)))
        walkableTiles.add(key);
    }
  }
  let collisionMap: CollisionMap | null = null;
  if (base.collisionMap) {
    collisionMap = overlayCollisionMap(base.collisionMap);
    for (const warrior of SOL_BOUNDARY_WARRIORS)
      collisionMap.flag(warrior.localX, warrior.localY, CollisionFlag.OBJECT);
  }
  return { bounds: getBoundsFromRegion(walkableTiles), walkableTiles, collisionMap };
}
