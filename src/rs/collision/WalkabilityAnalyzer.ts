import { LocModelType } from '../config/loctype/LocModelType';
import { MAP_SQUARE_SIZE, type MapSquareData, type MapSquareLocations } from '../map/MapLoader';
import { CollisionFlag } from './CollisionFlag';

export interface LocCollisionInfo {
  clipType: number;
  sizeX: number;
  sizeY: number;
  blocksProjectile: boolean;
}

export type LocCollisionLoader = (locId: number) => LocCollisionInfo | undefined;

/**
 * Applies directional wall collision flags for a wall loc.
 * Walls block movement THROUGH them by setting directional flags on both sides.
 * objectType: 0=straight wall, 1/3=diagonal corner, 2=L-corner
 */
function applyWallCollision(map: CollisionMap, x: number, y: number, objectType: number, rotation: number): void {
  if (objectType === 0) {
    if (rotation === 0) {
      map.flag(x, y, CollisionFlag.WALL_WEST);
      map.flag(x - 1, y, CollisionFlag.WALL_EAST);
    }
    if (rotation === 1) {
      map.flag(x, y, CollisionFlag.WALL_NORTH);
      map.flag(x, y + 1, CollisionFlag.WALL_SOUTH);
    }
    if (rotation === 2) {
      map.flag(x, y, CollisionFlag.WALL_EAST);
      map.flag(x + 1, y, CollisionFlag.WALL_WEST);
    }
    if (rotation === 3) {
      map.flag(x, y, CollisionFlag.WALL_SOUTH);
      map.flag(x, y - 1, CollisionFlag.WALL_NORTH);
    }
  }

  if (objectType === 1 || objectType === 3) {
    if (rotation === 0) {
      map.flag(x, y, CollisionFlag.WALL_NORTH_WEST);
      map.flag(x - 1, y + 1, CollisionFlag.WALL_SOUTH_EAST);
    }
    if (rotation === 1) {
      map.flag(x, y, CollisionFlag.WALL_NORTH_EAST);
      map.flag(x + 1, y + 1, CollisionFlag.WALL_SOUTH_WEST);
    }
    if (rotation === 2) {
      map.flag(x, y, CollisionFlag.WALL_SOUTH_EAST);
      map.flag(x + 1, y - 1, CollisionFlag.WALL_NORTH_WEST);
    }
    if (rotation === 3) {
      map.flag(x, y, CollisionFlag.WALL_SOUTH_WEST);
      map.flag(x - 1, y - 1, CollisionFlag.WALL_NORTH_EAST);
    }
  }

  if (objectType === 2) {
    if (rotation === 0) {
      map.flag(x, y, CollisionFlag.WALL_WEST | CollisionFlag.WALL_NORTH);
      map.flag(x - 1, y, CollisionFlag.WALL_EAST);
      map.flag(x, y + 1, CollisionFlag.WALL_SOUTH);
    }
    if (rotation === 1) {
      map.flag(x, y, CollisionFlag.WALL_NORTH | CollisionFlag.WALL_EAST);
      map.flag(x, y + 1, CollisionFlag.WALL_SOUTH);
      map.flag(x + 1, y, CollisionFlag.WALL_WEST);
    }
    if (rotation === 2) {
      map.flag(x, y, CollisionFlag.WALL_EAST | CollisionFlag.WALL_SOUTH);
      map.flag(x + 1, y, CollisionFlag.WALL_WEST);
      map.flag(x, y - 1, CollisionFlag.WALL_NORTH);
    }
    if (rotation === 3) {
      map.flag(x, y, CollisionFlag.WALL_SOUTH | CollisionFlag.WALL_WEST);
      map.flag(x, y - 1, CollisionFlag.WALL_NORTH);
      map.flag(x - 1, y, CollisionFlag.WALL_EAST);
    }
  }
}

function applyWallProjectileCollision(
  map: CollisionMap,
  x: number,
  y: number,
  objectType: number,
  rotation: number,
): void {
  if (objectType === 0) {
    if (rotation === 0) {
      map.flag(x, y, CollisionFlag.WALL_WEST_PROJECTILE_BLOCKER);
      map.flag(x - 1, y, CollisionFlag.WALL_EAST_PROJECTILE_BLOCKER);
    }
    if (rotation === 1) {
      map.flag(x, y, CollisionFlag.WALL_NORTH_PROJECTILE_BLOCKER);
      map.flag(x, y + 1, CollisionFlag.WALL_SOUTH_PROJECTILE_BLOCKER);
    }
    if (rotation === 2) {
      map.flag(x, y, CollisionFlag.WALL_EAST_PROJECTILE_BLOCKER);
      map.flag(x + 1, y, CollisionFlag.WALL_WEST_PROJECTILE_BLOCKER);
    }
    if (rotation === 3) {
      map.flag(x, y, CollisionFlag.WALL_SOUTH_PROJECTILE_BLOCKER);
      map.flag(x, y - 1, CollisionFlag.WALL_NORTH_PROJECTILE_BLOCKER);
    }
  }

  if (objectType === 1 || objectType === 3) {
    if (rotation === 0) {
      map.flag(x, y, CollisionFlag.WALL_NORTH_WEST_PROJECTILE_BLOCKER);
      map.flag(x - 1, y + 1, CollisionFlag.WALL_SOUTH_EAST_PROJECTILE_BLOCKER);
    }
    if (rotation === 1) {
      map.flag(x, y, CollisionFlag.WALL_NORTH_EAST_PROJECTILE_BLOCKER);
      map.flag(x + 1, y + 1, CollisionFlag.WALL_SOUTH_WEST_PROJECTILE_BLOCKER);
    }
    if (rotation === 2) {
      map.flag(x, y, CollisionFlag.WALL_SOUTH_EAST_PROJECTILE_BLOCKER);
      map.flag(x + 1, y - 1, CollisionFlag.WALL_NORTH_WEST_PROJECTILE_BLOCKER);
    }
    if (rotation === 3) {
      map.flag(x, y, CollisionFlag.WALL_SOUTH_WEST_PROJECTILE_BLOCKER);
      map.flag(x - 1, y - 1, CollisionFlag.WALL_NORTH_EAST_PROJECTILE_BLOCKER);
    }
  }

  if (objectType === 2) {
    if (rotation === 0) {
      map.flag(x, y, CollisionFlag.WALL_WEST_PROJECTILE_BLOCKER | CollisionFlag.WALL_NORTH_PROJECTILE_BLOCKER);
      map.flag(x - 1, y, CollisionFlag.WALL_EAST_PROJECTILE_BLOCKER);
      map.flag(x, y + 1, CollisionFlag.WALL_SOUTH_PROJECTILE_BLOCKER);
    }
    if (rotation === 1) {
      map.flag(x, y, CollisionFlag.WALL_NORTH_PROJECTILE_BLOCKER | CollisionFlag.WALL_EAST_PROJECTILE_BLOCKER);
      map.flag(x, y + 1, CollisionFlag.WALL_SOUTH_PROJECTILE_BLOCKER);
      map.flag(x + 1, y, CollisionFlag.WALL_WEST_PROJECTILE_BLOCKER);
    }
    if (rotation === 2) {
      map.flag(x, y, CollisionFlag.WALL_EAST_PROJECTILE_BLOCKER | CollisionFlag.WALL_SOUTH_PROJECTILE_BLOCKER);
      map.flag(x + 1, y, CollisionFlag.WALL_WEST_PROJECTILE_BLOCKER);
      map.flag(x, y - 1, CollisionFlag.WALL_NORTH_PROJECTILE_BLOCKER);
    }
    if (rotation === 3) {
      map.flag(x, y, CollisionFlag.WALL_SOUTH_PROJECTILE_BLOCKER | CollisionFlag.WALL_WEST_PROJECTILE_BLOCKER);
      map.flag(x, y - 1, CollisionFlag.WALL_NORTH_PROJECTILE_BLOCKER);
      map.flag(x - 1, y, CollisionFlag.WALL_EAST_PROJECTILE_BLOCKER);
    }
  }
}

export interface ArenaBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
}

/**
 * Collision flags addressed by local tile. Coordinates go through the methods only: a map built over
 * neighboring map squares has its own origin (CacheManager's block maps start at -64), so the
 * backing `flags` array is the implementation's business, not a coordinate-free copy source.
 */
export interface CollisionMap {
  sizeX: number;
  sizeY: number;
  /** Backing store in the implementation's own indexing, where it has one. Read through `getFlag`. */
  readonly flags?: Int32Array;
  /** -1 outside the map. */
  getFlag(x: number, y: number): number;
  hasFlag(x: number, y: number, flag: number): boolean;
  flag(x: number, y: number, flag: number): void;
  unflag(x: number, y: number, flag: number): void;
}

/**
 * An editable copy of `base` for runtime collision changes (scenery that appears or collapses): reads
 * fall through to `base` in its own coordinates, and edits stay in the copy. Tiles outside `base`
 * remain outside (-1, edits ignored), as on any map.
 */
export function overlayCollisionMap(base: CollisionMap): CollisionMap {
  const edits = new Map<string, number>();
  const getFlag = (x: number, y: number): number => edits.get(`${x},${y}`) ?? base.getFlag(x, y);
  const edit = (x: number, y: number, change: (current: number) => number): void => {
    const current = getFlag(x, y);
    if (current !== -1) edits.set(`${x},${y}`, change(current));
  };
  return {
    sizeX: base.sizeX,
    sizeY: base.sizeY,
    getFlag,
    hasFlag: (x, y, flag) => {
      const current = getFlag(x, y);
      return current !== -1 && (current & flag) !== 0;
    },
    flag: (x, y, flag) => edit(x, y, (current) => current | flag),
    unflag: (x, y, flag) => edit(x, y, (current) => current & ~flag),
  };
}

/** An empty map over local tiles `[0, sizeX) x [0, sizeY)`. */
export function createCollisionMap(sizeX: number, sizeY: number): CollisionMap & { readonly flags: Int32Array } {
  const flags = new Int32Array(sizeX * sizeY);
  return {
    sizeX,
    sizeY,
    flags,
    getFlag(x: number, y: number): number {
      if (x < 0 || x >= sizeX || y < 0 || y >= sizeY) return -1;
      return flags[x + y * sizeX];
    },
    hasFlag(x: number, y: number, flag: number): boolean {
      const f = this.getFlag(x, y);
      return f !== -1 && (f & flag) !== 0;
    },
    flag(x: number, y: number, flag: number): void {
      if (x >= 0 && x < sizeX && y >= 0 && y < sizeY) {
        flags[x + y * sizeX] |= flag;
      }
    },
    unflag(x: number, y: number, flag: number): void {
      if (x >= 0 && x < sizeX && y >= 0 && y < sizeY) {
        flags[x + y * sizeX] &= ~flag;
      }
    },
  };
}

function isObjectCollisionLocType(locType: number): boolean {
  return (
    locType === LocModelType.NORMAL ||
    locType === LocModelType.NORMAL_DIAGONAL ||
    locType === LocModelType.WALL_DIAGONAL ||
    (locType >= LocModelType.ROOF_SLOPED && locType < LocModelType.FLOOR_DECORATION)
  );
}

function canMoveInRegionFill(
  collisionMap: CollisionMap,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): boolean {
  const dx = toX - fromX;
  const dy = toY - fromY;

  if (dy === 0) {
    if (dx === -1) return !collisionMap.hasFlag(toX, toY, CollisionFlag.BLOCK_WEST);
    if (dx === 1) return !collisionMap.hasFlag(toX, toY, CollisionFlag.BLOCK_EAST);
  }
  if (dx === 0) {
    if (dy === -1) return !collisionMap.hasFlag(toX, toY, CollisionFlag.BLOCK_SOUTH);
    if (dy === 1) return !collisionMap.hasFlag(toX, toY, CollisionFlag.BLOCK_NORTH);
  }

  if (dx === -1 && dy === -1) {
    return (
      !collisionMap.hasFlag(toX, toY, CollisionFlag.BLOCK_SOUTH_WEST) &&
      !collisionMap.hasFlag(fromX - 1, fromY, CollisionFlag.BLOCK_WEST) &&
      !collisionMap.hasFlag(fromX, fromY - 1, CollisionFlag.BLOCK_SOUTH)
    );
  }
  if (dx === 1 && dy === -1) {
    return (
      !collisionMap.hasFlag(toX, toY, CollisionFlag.BLOCK_SOUTH_EAST) &&
      !collisionMap.hasFlag(fromX + 1, fromY, CollisionFlag.BLOCK_EAST) &&
      !collisionMap.hasFlag(fromX, fromY - 1, CollisionFlag.BLOCK_SOUTH)
    );
  }
  if (dx === -1 && dy === 1) {
    return (
      !collisionMap.hasFlag(toX, toY, CollisionFlag.BLOCK_NORTH_WEST) &&
      !collisionMap.hasFlag(fromX - 1, fromY, CollisionFlag.BLOCK_WEST) &&
      !collisionMap.hasFlag(fromX, fromY + 1, CollisionFlag.BLOCK_NORTH)
    );
  }
  if (dx === 1 && dy === 1) {
    return (
      !collisionMap.hasFlag(toX, toY, CollisionFlag.BLOCK_NORTH_EAST) &&
      !collisionMap.hasFlag(fromX + 1, fromY, CollisionFlag.BLOCK_EAST) &&
      !collisionMap.hasFlag(fromX, fromY + 1, CollisionFlag.BLOCK_NORTH)
    );
  }

  return false;
}

export interface CollisionLocInput {
  id: number;
  localX: number;
  localY: number;
  type: number;
  rotation: number;
  level: number;
}

/**
 * Reserved for locs the encounter itself replaces at runtime — e.g. the Inferno's
 * static "Ancestral Glyph" scenery copy, which the Zuk wave respawns as a moving
 * NPC. Never use it to carve out terrain: a loc that legitimately blocks is part of
 * the arena and removing it changes the fight.
 */
export type ExcludedStaticLocIds = ReadonlySet<number>;

/** Writes one loc's collision into `map` by its cache clip rules, with `loc`'s tile in the map's coordinates. */
export function applyLocCollision(
  map: CollisionMap,
  loc: { id: number; localX: number; localY: number; type: number; rotation: number },
  locLoader: LocCollisionLoader,
): void {
  const locInfo = locLoader(loc.id);
  if (!locInfo) return;

  const locType = loc.type;

  if (locType === LocModelType.FLOOR_DECORATION) {
    if (locInfo.clipType === 1) {
      map.flag(loc.localX, loc.localY, CollisionFlag.FLOOR_DECORATION);
    }
  } else if (isObjectCollisionLocType(locType)) {
    if (locInfo.clipType !== 0) {
      const sizeX = (loc.rotation & 1) === 0 ? locInfo.sizeX : locInfo.sizeY;
      const sizeY = (loc.rotation & 1) === 0 ? locInfo.sizeY : locInfo.sizeX;
      const flag = locInfo.blocksProjectile
        ? CollisionFlag.OBJECT | CollisionFlag.OBJECT_PROJECTILE_BLOCKER
        : CollisionFlag.OBJECT;
      for (let dx = 0; dx < sizeX; dx++) {
        for (let dy = 0; dy < sizeY; dy++) {
          map.flag(loc.localX + dx, loc.localY + dy, flag);
        }
      }
    }
  } else if (
    locType === LocModelType.WALL ||
    locType === LocModelType.WALL_TRI_CORNER ||
    locType === LocModelType.WALL_CORNER ||
    locType === LocModelType.WALL_RECT_CORNER
  ) {
    if (locInfo.clipType !== 0) {
      applyWallCollision(map, loc.localX, loc.localY, locType, loc.rotation);
      if (locInfo.blocksProjectile) {
        applyWallProjectileCollision(map, loc.localX, loc.localY, locType, loc.rotation);
      }
    }
  }
}

/** One map square's collision inputs, and where its tile (0, 0) sits in the collision map they go into. */
export interface MapSquareCollisionSource {
  readonly mapData: MapSquareData;
  readonly locations?: MapSquareLocations;
  /** Encounter-declared placements absent from the cache's loc list, in the square's local tiles. */
  readonly extraLocs?: readonly CollisionLocInput[];
  readonly tileOffsetX: number;
  readonly tileOffsetY: number;
}

/**
 * Writes one map square's static collision into `collisionMap`: its blocked floor, then its locs and
 * `extraLocs` by their cache clip rules. A loc's flags past the square's edge (a large object's far
 * tiles, the far side of a wall on the edge) land in the neighboring square wherever `collisionMap`
 * covers it, so a bake over several squares applies every square before reading any walkable tiles.
 */
export function applyMapSquareCollision(
  collisionMap: CollisionMap,
  source: MapSquareCollisionSource,
  locLoader?: LocCollisionLoader,
  level: number = 0,
  excludedStaticLocIds?: ExcludedStaticLocIds,
): void {
  const { mapData, locations, extraLocs, tileOffsetX, tileOffsetY } = source;
  const { tileRenderFlags } = mapData;
  for (let x = 0; x < MAP_SQUARE_SIZE; x++) {
    for (let y = 0; y < MAP_SQUARE_SIZE; y++) {
      const renderFlag = tileRenderFlags[level]?.[x]?.[y] ?? 0;

      if ((renderFlag & 0x1) === 1) {
        let realLevel = level;
        if (level > 0 && (tileRenderFlags[1]?.[x]?.[y] & 0x2) === 2) {
          realLevel = level - 1;
        }
        if (realLevel >= 0 && realLevel === level) {
          collisionMap.flag(x + tileOffsetX, y + tileOffsetY, CollisionFlag.FLOOR);
        }
      }
    }
  }

  if (!locLoader) return;
  const applyLoc = (loc: CollisionLocInput): void => {
    if (loc.level !== level) return;
    applyLocCollision(
      collisionMap,
      tileOffsetX === 0 && tileOffsetY === 0
        ? loc
        : { ...loc, localX: loc.localX + tileOffsetX, localY: loc.localY + tileOffsetY },
      locLoader,
    );
  };
  if (locations) {
    for (const loc of locations.locations) {
      if (excludedStaticLocIds?.has(loc.id)) continue;
      applyLoc(loc);
    }
  }
  // Encounter-declared dynamic loc placements (e.g. packet-spawned locs absent from the static map
  // data) follow the same cache clipType rules, so they block and leave the walkable tiles too.
  for (const loc of extraLocs ?? []) applyLoc(loc);
}

/**
 * Adds to `into` the tiles of one map square, in `collisionMap`'s coordinates, that have an underlay
 * and no floor or object block there.
 */
export function collectWalkableTiles(
  collisionMap: CollisionMap,
  source: Pick<MapSquareCollisionSource, 'mapData' | 'tileOffsetX' | 'tileOffsetY'>,
  level: number = 0,
  into: Set<string> = new Set<string>(),
): Set<string> {
  const { mapData, tileOffsetX, tileOffsetY } = source;
  for (let x = 0; x < MAP_SQUARE_SIZE; x++) {
    for (let y = 0; y < MAP_SQUARE_SIZE; y++) {
      const hasUnderlay = (mapData.tileUnderlays[level]?.[x]?.[y] ?? 0) > 0;
      const mapX = x + tileOffsetX;
      const mapY = y + tileOffsetY;
      if (hasUnderlay && !collisionMap.hasFlag(mapX, mapY, CollisionFlag.FLOOR_BLOCKED | CollisionFlag.OBJECT)) {
        into.add(`${mapX},${mapY}`);
      }
    }
  }
  return into;
}

/** One map square's collision and walkable tiles on its own, in its local tiles. */
export function analyzeWalkability(
  mapData: MapSquareData,
  locations?: MapSquareLocations,
  locLoader?: LocCollisionLoader,
  level: number = 0,
  extraLocs?: readonly CollisionLocInput[],
  excludedStaticLocIds?: ExcludedStaticLocIds,
): { collisionMap: CollisionMap; bounds: ArenaBounds; walkableTiles: Set<string> } {
  const collisionMap = createCollisionMap(MAP_SQUARE_SIZE, MAP_SQUARE_SIZE);
  const source = { mapData, locations, extraLocs, tileOffsetX: 0, tileOffsetY: 0 };
  applyMapSquareCollision(collisionMap, source, locLoader, level, excludedStaticLocIds);
  const walkableTiles = collectWalkableTiles(collisionMap, source, level);
  const bounds: ArenaBounds =
    walkableTiles.size > 0
      ? getBoundsFromRegion(walkableTiles)
      : {
          minX: 0,
          maxX: MAP_SQUARE_SIZE - 1,
          minY: 0,
          maxY: MAP_SQUARE_SIZE - 1,
          width: MAP_SQUARE_SIZE,
          height: MAP_SQUARE_SIZE,
        };
  return { collisionMap, bounds, walkableTiles };
}

export function findContiguousRegion(
  walkableTiles: Set<string>,
  startX: number,
  startY: number,
  collisionMap?: CollisionMap,
): Set<string> {
  const region = new Set<string>();
  const key = `${startX},${startY}`;

  if (!walkableTiles.has(key)) {
    return region;
  }

  const queue: [number, number][] = [[startX, startY]];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const [x, y] = queue.shift()!;
    const k = `${x},${y}`;

    if (visited.has(k)) continue;
    visited.add(k);

    if (!walkableTiles.has(k)) continue;

    region.add(k);

    const neighbors: [number, number][] = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
      [x - 1, y - 1],
      [x + 1, y - 1],
      [x - 1, y + 1],
      [x + 1, y + 1],
    ];

    for (const [nx, ny] of neighbors) {
      const nk = `${nx},${ny}`;
      const canCross = collisionMap ? canMoveInRegionFill(collisionMap, x, y, nx, ny) : true;
      if (!visited.has(nk) && walkableTiles.has(nk) && canCross) {
        queue.push([nx, ny]);
      }
    }
  }

  return region;
}

export function getBoundsFromRegion(region: Set<string>): ArenaBounds {
  let minX = Infinity,
    maxX = -Infinity;
  let minY = Infinity,
    maxY = -Infinity;

  for (const key of region) {
    const [x, y] = key.split(',').map(Number);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  if (minX === Infinity) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 1, height: 1 };
  }

  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}
