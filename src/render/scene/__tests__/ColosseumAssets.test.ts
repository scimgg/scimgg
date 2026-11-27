import { afterEach, expect, it } from 'vitest';
import type { LocWithType } from '../../../cache/CacheManager';
import { SOL_MAP_X, SOL_MAP_Y } from '../../../encounters/solHeredit/constants';
import { SOL_HEREDIT_RENDER_CONFIG } from '../../../encounters/solHeredit/renderConfig';
import {
  BEAM_CRYSTAL_NPC_ID,
  COLOSSEUM_SPOTANIMS,
  HEALING_TOTEM_NPC_ID,
  SOL_NPC_ID,
  SOLARFLARE_NPC_ID,
} from '../../../npcs/colosseum/constants';
import { COLOSSEUM_SPOT_ANIM_IDS } from '../../../npcs/colosseum/visualEvents';
import type { CacheInfo } from '../../../rs/cache/CacheInfo';
import { CacheSystem } from '../../../rs/cache/CacheSystem';
import { Bzip2 } from '../../../rs/compression/Bzip2';
import { ArchiveOverlayTypeLoader, ArchiveUnderlayTypeLoader } from '../../../rs/config/flotype/FloTypeLoader';
import { LocModelLoader } from '../../../rs/config/loctype/LocModelLoader';
import type { LocModelType } from '../../../rs/config/loctype/LocModelType';
import { ArchiveNpcTypeLoader } from '../../../rs/config/npctype/NpcTypeLoader';
import { ArchiveSeqTypeLoader } from '../../../rs/config/seqtype/SeqTypeLoader';
import { ArchiveSpotAnimTypeLoader } from '../../../rs/config/spotanimtype/SpotAnimTypeLoader';
import { MAP_SQUARE_SIZE, MapLoader, type MapSquareData } from '../../../rs/map/MapLoader';
import { createTerrainContext } from '../../../rs/map/mapSquareBlock';
import { IndexModelLoader } from '../../../rs/model/ModelLoader';
import { NpcModelLoader } from '../../../rs/model/NpcModelLoader';
import { SpotAnimModelLoader } from '../../../rs/model/SpotAnimModelLoader';
import { readCacheZipFiles } from '../../../test/helpers/cacheZipFiles';
import {
  findProjectCacheZip,
  REAL_CACHE_TEST_TIMEOUT_MS,
  skipWithoutRealCache,
} from '../../../test/helpers/real-cache';
import { ResidentMeshEmbedder } from '../../../test/helpers/residentMeshDraws';
import { COLOSSEUM_PILLAR_LOC_IDS } from '../../../types/pillarAdditions';
import { AnimationSystem } from '../../backends/picogl/AnimationSystem';
import { resolveEffectiveLocs } from '../../environment/locRenderFilter';
import { FULL_MAP_SQUARE_GROUND_LEVEL } from '../../environment/locRenderOptions';
import { ColosseumSceneCompositor } from '../ColosseumSceneCompositor';
import { getEncounterRenderConfig } from '../encounterRenderConfig';

const cachePath = findProjectCacheZip() ?? '';
// What the app hands the compositor: the presentation module's config with the descriptor's map squares.
const SOL_RESOLVED_RENDER_CONFIG = getEncounterRenderConfig('sol_heredit');
if (!SOL_RESOLVED_RENDER_CONFIG) throw new Error('no Sol Heredit render config');
const scene = new ColosseumSceneCompositor();
const scenes: ColosseumSceneCompositor[] = [scene];
afterEach(() => {
  for (const disposed of scenes.splice(0)) disposed.dispose();
});
const info: CacheInfo = {
  name: 'osrs-test',
  game: 'oldschool',
  environment: 'live',
  revision: 232,
  timestamp: '',
  size: 0,
};

let cacheFiles: Promise<Map<string, ArrayBuffer>> | undefined;
function openCache(indices: number[]): Promise<CacheSystem> {
  cacheFiles ??= (async () => {
    const files = await readCacheZipFiles(cachePath);
    await Bzip2.initWasm();
    return files;
  })();
  return cacheFiles.then((files) => CacheSystem.fromMap('dat2', files, indices));
}

it.skipIf(skipWithoutRealCache())(
  'loads every configured Sol and crystal animation from the real cache',
  async () => {
    const cache = await openCache([0, 1, 2, 7, 22]);
    const config = cache.getIndex(2);
    const loader = new NpcModelLoader(
      new ArchiveNpcTypeLoader(info, config.getArchive(9)),
      new IndexModelLoader(cache.getIndex(7)),
    );
    const animation = new AnimationSystem();
    animation.initialize(info, cache.getIndex(0), cache.getIndex(1), config.getArchive(12), cache.getIndex(22));
    scene.setEncounterRenderConfig(SOL_RESOLVED_RENDER_CONFIG);

    await scene['loadEncounterNpc'](loader, animation);
    const frameLoader = animation.getSeqFrameLoader();
    if (!frameLoader) throw new Error('missing frame loader');
    scene['spotAnimRenderer'].setAnimationSystem(animation);
    await scene['loadEncounterSpotAnims'](
      new SpotAnimModelLoader(
        new ArchiveSpotAnimTypeLoader(info, config.getArchive(13)),
        new IndexModelLoader(cache.getIndex(7)),
        new ArchiveSeqTypeLoader(info, config.getArchive(12)),
        frameLoader,
      ),
    );

    const registry = scene['npcInstanceManager']['typeRegistry'];
    expect([...registry.keys()]).toEqual(expect.arrayContaining([SOL_NPC_ID, BEAM_CRYSTAL_NPC_ID]));
    for (const configured of SOL_HEREDIT_RENDER_CONFIG.preloadNpcTypes ?? []) {
      const loaded = registry.get(configured.npcTypeId);
      expect(loaded?.modelData?.mergedModel?.verticesCount).toBeGreaterThan(0);
      expect(loaded?.animationSet?.idle?.seqId).toBe(configured.idleSeqId);
      expect(loaded?.animationSet?.death?.seqId).toBe(configured.deathSeqId);
      expect(Object.keys(loaded?.animationSet?.attackClips ?? {}).sort()).toEqual(
        Object.keys(configured.attackClips ?? {}).sort(),
      );
      for (const [name, seqId] of Object.entries(configured.attackClips ?? {})) {
        const clip = loaded?.animationSet?.attackClips?.[name];
        expect(clip?.seqId).toBe(seqId);
        expect(
          clip?.kind === 'frame' ? clip.frameIds.length : clip ? clip.skeletalEnd - clip.skeletalStart : 0,
        ).toBeGreaterThan(0);
      }
    }
    expect(registry.get(SOL_NPC_ID)?.bossDeathAnimationEnabled).toBe(true);
    // The flare's cache walk seq is its stand seq, whose one-time flare-up must not restart.
    const flare = registry.get(SOLARFLARE_NPC_ID)?.animationSet;
    expect(flare?.walk).toBeUndefined();
    expect(flare?.idlePlayMode).toBe('loopFrameStep');
    expect(flare?.idle?.seqType.frameStep).toBe(21);
    expect(flare?.idle?.seqType.frameSounds?.get(1)?.map((sound) => sound.id)).toEqual([7980]);
    // The totem's idle replays only its tail, frames 15-50.
    const totem = registry.get(HEALING_TOTEM_NPC_ID)?.animationSet;
    expect(totem?.idlePlayMode).toBe('loopFrameStep');
    expect(totem?.idle?.kind === 'frame' ? totem.idle.frameIds.length : 0).toBe(51);
    expect(totem?.idle?.seqType.frameStep).toBe(36);
    const attacks = Object.values(registry.get(SOL_NPC_ID)?.animationSet?.attackClips ?? {});
    expect(attacks.some((clip) => (clip.seqType.frameSounds?.size ?? 0) > 0)).toBe(true);
    for (const id of COLOSSEUM_SPOT_ANIM_IDS) {
      expect(scene['spotAnimRenderer'].isLoaded(id)).toBe(true);
      // The archer's iron arrow is a static model; every other effect animates.
      if (id === COLOSSEUM_SPOTANIMS.warbandArrow) expect(scene['spotAnimRenderer'].getFrameLengths(id)).toEqual([]);
      else expect(scene['spotAnimRenderer'].getFrameLengths(id)?.length).toBeGreaterThan(0);
    }
  },
  30_000,
);

/** Static scenery arrays, built once per resident source. */
const locMeshes = new ResidentMeshEmbedder(true);

/** Highest world-space Z among loc vertices inside a tile column. */
function topOfColumn(target: ColosseumSceneCompositor, x: number, y: number): number {
  let top = Number.NEGATIVE_INFINITY;
  for (const command of target['locRenderer']['cachedLocMeshes']) {
    const { positions } = locMeshes.embedResident(command);
    for (let index = 0; index < positions.length; index += 3) {
      const [vx, vy, vz] = [positions[index]!, positions[index + 1]!, positions[index + 2]!];
      if (vx >= x && vx <= x + 1 && vy >= y && vy <= y + 1) top = Math.max(top, vz);
    }
  }
  return top;
}

it.skipIf(skipWithoutRealCache())(
  'renders the amphitheater seating and awnings on cache levels 1 and 2 at their own heights',
  async () => {
    const cache = await openCache([0, 1, 2, 5, 7]);
    const config = cache.getIndex(2);
    const maps = new MapLoader(cache.getIndex(5));
    const squares = new Map<string, MapSquareData>();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const square = await maps.loadMapSquare(SOL_MAP_X + dx, SOL_MAP_Y + dy);
        if (square) squares.set(`${SOL_MAP_X + dx},${SOL_MAP_Y + dy}`, square);
      }
    }
    const terrain = squares.get(`${SOL_MAP_X},${SOL_MAP_Y}`);
    // Public map archive key: archive.openrs2.org/caches/2437/keys.json, mapsquare 7216.
    const placed = await maps.loadLocations(SOL_MAP_X, SOL_MAP_Y, [-614154723, 1856813096, 1740380664, -1655073354]);
    if (!terrain || !placed) throw new Error('Expected cached Colosseum map square');

    // The client draws a plane-0 player's upper levels where level 1 is a bridge (0x2, shifted to
    // the player's plane) or a tile is visible-below (0x8): RuneLite SceneUploader.uploadZoneLevelRoof
    // (BSD-2, `runelite-client/.../gpu/SceneUploader.java`). No level-0 tile is under a
    // roof (0x4), so nothing here is hidden as a roof either.
    const flags = terrain.tileRenderFlags;
    const contentTiles = new Map<number, Set<string>>([0, 1, 2, 3].map((level) => [level, new Set<string>()]));
    for (const location of placed.locations)
      contentTiles.get(location.level)?.add(`${location.localX},${location.localY}`);
    for (let level = 0; level < 4; level++) {
      for (let x = 0; x < MAP_SQUARE_SIZE; x++) {
        for (let y = 0; y < MAP_SQUARE_SIZE; y++) {
          if (terrain.tileUnderlays[level]![x]![y] || terrain.tileOverlays[level]![x]![y])
            contentTiles.get(level)?.add(`${x},${y}`);
        }
      }
    }
    const drawnFromPlaneZero = (level: number) =>
      [...contentTiles.get(level)!].every((tile) => {
        const [x, y] = tile.split(',').map(Number) as [number, number];
        return (flags[1]![x]![y]! & 0x2) !== 0 || (flags[level]![x]![y]! & 0x8) !== 0;
      });
    expect([0, 1, 2, 3].map((level) => contentTiles.get(level)!.size)).toEqual([4096, 2023, 576, 0]);
    expect([drawnFromPlaneZero(1), drawnFromPlaneZero(2)]).toEqual([true, true]);
    expect(flags[0]!.some((column) => column.some((flag) => (flag & 0x4) !== 0))).toBe(false);

    const locTypes = new LocModelLoader(
      info,
      config.getArchive(6),
      cache.getIndex(7),
      config.getArchive(12),
      cache.getIndex(0),
      cache.getIndex(1),
    );
    const context = createTerrainContext(terrain, (mapX, mapY) => squares.get(`${mapX},${mapY}`));
    const entries: LocWithType[] = placed.locations.map((location) => ({
      location,
      locType: locTypes.loadLocType(location.id)!,
      modelType: location.type as LocModelType,
      mapSquareOffset: { x: 0, y: 0 },
      terrainHeightPlanes: context.tileHeights,
      terrainContextOrigin: { x: context.coreOriginX, y: context.coreOriginY },
    }));
    const rendered = resolveEffectiveLocs(entries, SOL_HEREDIT_RENDER_CONFIG.locRender, locTypes);
    expect([0, 1, 2].map((level) => rendered.filter(({ location }) => location.level === level).length)).toEqual([
      1054, 1564, 576,
    ]);

    const allLevels = new ColosseumSceneCompositor();
    scenes.push(allLevels);
    allLevels.setEncounterRenderConfig(SOL_RESOLVED_RENDER_CONFIG);
    const meshes = await allLevels.buildTerrainMeshes3D(
      maps,
      new ArchiveUnderlayTypeLoader(info, config.getArchive(1)),
      new ArchiveOverlayTypeLoader(info, config.getArchive(4)),
    );
    const positions = new Map(
      meshes.map((mesh) => {
        const [first] = mesh.meshSource.materialize();
        // A rebuild, as after an eviction or a lost context, is the first build byte for byte.
        const [rebuilt] = mesh.meshSource.materialize();
        expect(Buffer.from(rebuilt!.positions.buffer).equals(Buffer.from(first!.positions.buffer))).toBe(true);
        return [mesh.meshId, first!.positions] as const;
      }),
    );
    const heights = (level: number) => {
      const mesh = [...positions].find(([meshId]) => meshId.includes(`-level-${level}-`))?.[1];
      const values = [];
      for (let index = 1; index < (mesh?.length ?? 0); index += 3) values.push(mesh![index]!);
      return values;
    };
    // Level 1's floor is drawn from level 1's own heights; level 2 is roofs only, with no floor.
    const levelOne = heights(1);
    expect(levelOne.length).toBeGreaterThan(0);
    expect(Math.min(...levelOne)).toBe(Math.min(...terrain.tileHeights[1]!.flatMap((column) => [...column])));
    expect(Math.min(...levelOne)).toBeLessThan(Math.min(...heights(0)));
    expect(heights(2)).toEqual([]);

    // A level-1 statue stands on the level-1 floor, not the arena floor 5+ tiles below it. The
    // level-0 structure in that column reaches only up to the seating floor it supports.
    const statue = rendered.find(({ location, locType }) => location.level === 1 && locType.name.startsWith('Statue'));
    if (!statue) throw new Error('Expected a level-1 statue');
    const { localX, localY } = statue.location;
    const groundOnly = new ColosseumSceneCompositor();
    scenes.push(groundOnly);
    groundOnly.setEncounterRenderConfig({ ...SOL_RESOLVED_RENDER_CONFIG, locRender: FULL_MAP_SQUARE_GROUND_LEVEL });
    await Promise.all([allLevels.loadLocs(locTypes, entries), groundOnly.loadLocs(locTypes, entries)]);
    // Colosseum Additions' pillars: four 3x3 Pillars (52490), which it can hide and mark.
    expect(allLevels['locRenderer'].getLocFootprints(COLOSSEUM_PILLAR_LOC_IDS)).toEqual(
      [
        [24, 26],
        [24, 41],
        [39, 26],
        [39, 41],
      ].map(([x, y]) => ({ locId: 52490, level: 0, x, y, sizeX: 3, sizeY: 3 })),
    );
    const floor = -terrain.tileHeights[1]![localX]![localY]! / 128;
    const supports = topOfColumn(groundOnly, localX, localY);
    expect(supports).toBeCloseTo(floor, 1);
    expect(topOfColumn(allLevels, localX, localY)).toBeGreaterThan(supports + 1);
  },
  REAL_CACHE_TEST_TIMEOUT_MS,
);
