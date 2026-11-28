import { expect, it } from 'vitest';
import { toCollisionLocInput } from '../../../core/arena/collisionSpec';
import { CacheSystem } from '../../../rs/cache/CacheSystem';
import {
  analyzeWalkability,
  findContiguousRegion,
  getBoundsFromRegion,
} from '../../../rs/collision/WalkabilityAnalyzer';
import { Bzip2 } from '../../../rs/compression/Bzip2';
import { ArchiveLocTypeLoader } from '../../../rs/config/loctype/LocTypeLoader';
import { MapLoader } from '../../../rs/map/MapLoader';
import { readCacheZipFiles } from '../../../test/helpers/cacheZipFiles';
import { findProjectCacheZip, skipWithoutRealCache } from '../../../test/helpers/real-cache';
import { colosseumWaveFloorTiles } from '../../colosseum/waves/arena';
import { composeSolStageArena, SOL_BOUNDARY_WARRIORS } from '../arenaBoundary';
import { SOL_PLAYER_START } from '../constants';

it.skipIf(skipWithoutRealCache())(
  'encloses the baked waves arena exactly as baking the warriors in would, and the floor placeholder is the bake',
  async () => {
    await Bzip2.initWasm();
    const cache = CacheSystem.fromMap('dat2', await readCacheZipFiles(findProjectCacheZip() ?? ''), [2, 5]);
    const locs = new ArchiveLocTypeLoader(
      { name: 'osrs-test', game: 'oldschool', environment: 'live', revision: 232, timestamp: '2024-01-01', size: 0 },
      cache.getIndex(2).getArchive(6),
    );
    const loader = new MapLoader(cache.getIndex(5));
    const terrain = await loader.loadMapSquare(28, 48);
    // Public map archive key: archive.openrs2.org/caches/2437/keys.json, mapsquare 7216.
    const locations = await loader.loadLocations(28, 48, [-614154723, 1856813096, 1740380664, -1655073354]);
    if (!terrain || !locations) throw new Error('Expected cached Colosseum map square');
    const [seedX, seedY] = SOL_PLAYER_START;
    // As `CacheManager.buildArenaConfig` bakes the descriptor's collision: the region from the seed.
    const bake = (extra = false) => {
      const analysis = analyzeWalkability(
        terrain,
        locations,
        (id) => locs.load(id),
        0,
        extra ? SOL_BOUNDARY_WARRIORS.map(toCollisionLocInput) : undefined,
      );
      const region = findContiguousRegion(analysis.walkableTiles, seedX, seedY, analysis.collisionMap);
      return { bounds: getBoundsFromRegion(region), walkableTiles: region, collisionMap: analysis.collisionMap };
    };
    const open = bake();
    expect(open.walkableTiles).toEqual(colosseumWaveFloorTiles());
    const fenced = bake(true);
    const staged = composeSolStageArena(open);
    expect(staged.walkableTiles).toEqual(fenced.walkableTiles);
    expect(staged.bounds).toEqual(fenced.bounds);
    for (let x = 0; x < 64; x++) {
      for (let y = 0; y < 64; y++) {
        expect([x, y, staged.collisionMap?.getFlag(x, y)]).toEqual([x, y, fenced.collisionMap.getFlag(x, y)]);
      }
    }
  },
  60_000,
);
