import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CacheManager } from '../../../cache/CacheManager';
import { OpenRS2Client } from '../../../cache/OpenRS2Client';
import type { ArenaConfig } from '../../../core/arena/ArenaConfig';
import { isInAttackRange } from '../../../core/combat/distance';
import { hasNpcAttackReach } from '../../../core/combat/npcAttackRequest';
import { getArenaAllowUnboundedFallback, getArenaConfig, setArenaConfig } from '../../../core/constants';
import { ZULRAH_SIZE } from '../../../npcs/zulrah/constants';
import { createZulrahActor } from '../../../npcs/zulrah/zulrah';
import { ArchiveLocTypeLoader } from '../../../rs/config/loctype/LocTypeLoader';
import { MapLoader } from '../../../rs/map/MapLoader';
import { openRealCache, skipWithoutRealCache } from '../../../test/helpers/real-cache';
import { ZULRAH_MAP_SQUARE, ZULRAH_MAP_SQUARE_OFFSETS, zulrahIslandTiles } from '../constants';
import { ZULRAH_SPOTS } from '../rotation';
import { ZULRAH_PLAYER_START } from '../ZulrahEncounter';
import { ZULRAH_CAPTURE_SIGHT } from './fixtures/zulrahCapture';

const CONFIG_INDEX = 2;
const LOC_ARCHIVE = 6;
const MAP_INDEX = 5;

/** The production bake (`useEncounterManager` -> `CacheManager.buildArenaConfig`), from the pinned cache. */
async function bakeZulrahArena(): Promise<ArenaConfig> {
  const { cache, info } = await openRealCache([CONFIG_INDEX, MAP_INDEX], 'pinned');
  const manager = new CacheManager(undefined, new OpenRS2Client());
  Reflect.set(manager, 'mapLoader', new MapLoader(cache.getIndex(MAP_INDEX)));
  Reflect.set(
    manager,
    'locTypeLoader',
    new ArchiveLocTypeLoader(info, cache.getIndex(CONFIG_INDEX).getArchive(LOC_ARCHIVE)),
  );
  return manager.buildArenaConfig({
    mapX: ZULRAH_MAP_SQUARE.x,
    mapY: ZULRAH_MAP_SQUARE.y,
    seedX: ZULRAH_PLAYER_START[0],
    seedY: ZULRAH_PLAYER_START[1],
    mapSquareOffsets: ZULRAH_MAP_SQUARE_OFFSETS,
  });
}

describe.skipIf(skipWithoutRealCache('pinned'))("Zulrah's island and line of sight on the pinned cache's arena", () => {
  const originalArena = getArenaConfig();
  const originalFallback = getArenaAllowUnboundedFallback();
  let arena: ArenaConfig | null = null;
  beforeAll(async () => {
    arena = await bakeZulrahArena();
  }, 120_000);
  afterEach(() => setArenaConfig(originalArena, originalFallback));

  it("matches the encounter's pre-cache island tile for tile", () => {
    expect(arena?.walkableTiles).toEqual(zulrahIslandTiles());
  });

  it("lets a halberd reach the middle form only from the arms' inner columns, none from the base", () => {
    if (!arena?.collisionMap || !arena.walkableTiles) throw new Error('The bake produced no collision map');
    setArenaConfig(arena, false);
    const walkable = arena.walkableTiles;
    const tiles = [...walkable].map((key): [number, number] => {
      const [x, y] = key.split(',').map(Number);
      return [x ?? 0, y ?? 0];
    });
    // The reach and line-of-sight check the player's attacks use, at a halberd's range of 2.
    const reaches = (range: number) =>
      tiles
        .filter((tile) => isInAttackRange(tile, ZULRAH_SPOTS.middle, ZULRAH_SIZE, range, true))
        .map(([x, y]) => `${x},${y}`)
        .sort();
    const armColumns = [63, 64, 65, 66, 67, 68, 69, 70].flatMap((y) => [`24,${y}`, `32,${y}`]).sort();
    expect(reaches(2)).toEqual(armColumns);
    expect(reaches(1)).toEqual([]);
    // Between the pillars the base ends at y 62, 3 tiles from the footprint's south edge.
    for (let x = 25; x <= 31; x++) expect(walkable.has(`${x},63`), `${x},63`).toBe(false);
  });

  it.each(
    ZULRAH_CAPTURE_SIGHT.map((c) => [c.spot, `${c.tile}`, c.visible ? 'visible' : 'hidden', c] as const),
  )('at the %s spot, (%s) is %s, as in the private gameplay captures', (_spot, _tile, _label, {
    spot,
    tile,
    visible,
  }) => {
    if (!arena?.collisionMap) throw new Error('The bake produced no collision map');
    setArenaConfig(arena, false);
    const zulrah = createZulrahActor({
      id: 'zulrah',
      form: 'serpentine',
      mode: 'ranged',
      actions: ['attack'],
      position: [...ZULRAH_SPOTS[spot]],
      hp: 500,
      maxHp: 500,
      spawnTick: 0,
      emergeTicks: 0,
    });
    // The engine's NPC reach, as Zulrah's attack turn asks it (`canNpcAttack` in zulrah.ts).
    expect(hasNpcAttackReach(zulrah, { position: [...tile], size: 1 }, zulrah.combat.attackRange)).toBe(visible);
  });
});
