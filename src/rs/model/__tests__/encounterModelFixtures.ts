/**
 * The real models Sol Heredit, Yama and the Inferno build, for the equivalence tests that pin model
 * conversion and lighting to their reference implementations: the encounters' NPC types, their
 * spotanims (static, frame-animated and every skeletal pose) and their map LOCs.
 */
import type { LocWithType } from '../../../cache/CacheManager';
import { SOL_MAP_X, SOL_MAP_Y } from '../../../encounters/solHeredit/constants';
import {
  FIREBALL_PRELOAD_IDS,
  VOID_FLARE_PRELOAD_IDS,
  WAVE_PRELOAD_IDS,
  YAMA_ATTACK_PRELOAD_IDS,
} from '../../../encounters/yamaP3/spotAnims';
import { COLOSSEUM_SPOT_ANIM_IDS } from '../../../npcs/colosseum/visualEvents';
import { INFERNO_SPOT_ANIM_IDS } from '../../../npcs/inferno/constants';
import { AnimationSystem } from '../../../render/backends/picogl/AnimationSystem';
import { PLAYER_GRAPHIC_PRELOAD_IDS } from '../../../render/effects/controllers/PlayerGraphicController';
import type { LocRenderOptions } from '../../../render/environment/locRenderOptions';
import { resolveEncounterLocRenderOptions } from '../../../render/scene/encounterLocRenderOptions';
import { getEncounterRenderConfig } from '../../../render/scene/encounterRenderConfig';
import { openRealCache, type RealCacheKind } from '../../../test/helpers/real-cache';
import { LocModelLoader } from '../../config/loctype/LocModelLoader';
import type { LocModelType } from '../../config/loctype/LocModelType';
import { ArchiveNpcTypeLoader } from '../../config/npctype/NpcTypeLoader';
import { ArchiveSeqTypeLoader } from '../../config/seqtype/SeqTypeLoader';
import { ArchiveSpotAnimTypeLoader } from '../../config/spotanimtype/SpotAnimTypeLoader';
import { MapLoader, type MapSquareData } from '../../map/MapLoader';
import { createTerrainContext } from '../../map/mapSquareBlock';
import { IndexModelLoader } from '../ModelLoader';
import { NpcModelLoader } from '../NpcModelLoader';
import { SpotAnimModelLoader } from '../SpotAnimModelLoader';

export const TEST_CACHE_INFO = {
  name: 'osrs-test',
  game: 'oldschool',
  environment: 'live',
  revision: 232,
  timestamp: '',
  size: 0,
} as const;

export const ENCOUNTER_KINDS = ['sol_heredit', 'yama_p3', 'inferno'] as const;

/**
 * Each encounter's core map square with its public archive key for the test cache
 * (archive.openrs2.org/caches/2437/keys.json), in {@link ENCOUNTER_KINDS} order.
 */
export const ENCOUNTER_MAP_SQUARES: readonly { x: number; y: number; key: number[] }[] = [
  { x: SOL_MAP_X, y: SOL_MAP_Y, key: [-614154723, 1856813096, 1740380664, -1655073354] },
  { x: 23, y: 157, key: [-1808710597, 1603394469, 488134396, -1772243966] },
  { x: 35, y: 83, key: [1790859086, -129964091, 1829839961, -469727662] },
];

export function encounterNpcIds(): Set<number> {
  const ids = new Set<number>();
  for (const kind of ENCOUNTER_KINDS) {
    const config = getEncounterRenderConfig(kind);
    if (config?.primaryNpc) ids.add(config.primaryNpc.npcTypeId);
    for (const preload of config?.preloadNpcTypes ?? []) ids.add(preload.npcTypeId);
  }
  return ids;
}

export function encounterSpotAnimIds(): Set<number> {
  const ids = new Set<number>([
    ...COLOSSEUM_SPOT_ANIM_IDS,
    ...INFERNO_SPOT_ANIM_IDS,
    ...WAVE_PRELOAD_IDS,
    ...FIREBALL_PRELOAD_IDS,
    ...VOID_FLARE_PRELOAD_IDS,
    ...YAMA_ATTACK_PRELOAD_IDS,
    ...PLAYER_GRAPHIC_PRELOAD_IDS,
  ]);
  for (const kind of ENCOUNTER_KINDS) {
    const deathSpotAnimId = getEncounterRenderConfig(kind)?.primaryNpc?.deathSpotAnimId;
    if (deathSpotAnimId !== undefined) ids.add(deathSpotAnimId);
  }
  return ids;
}

/**
 * The NPC and spotanim loaders read `kind`'s cache with that cache's revision (`openRealCache`'s
 * info), which the type decoders branch on.
 */
export async function openNpcModelLoader(kind: RealCacheKind = 'golden'): Promise<NpcModelLoader> {
  const { cache, info } = await openRealCache([2, 7], kind);
  return new NpcModelLoader(
    new ArchiveNpcTypeLoader(info, cache.getIndex(2).getArchive(9)),
    new IndexModelLoader(cache.getIndex(7)),
  );
}

export async function openSpotAnimModelLoader(
  kind: RealCacheKind = 'golden',
): Promise<{ loader: SpotAnimModelLoader; animation: AnimationSystem }> {
  const { cache, info } = await openRealCache([0, 1, 2, 7, 22], kind);
  const config = cache.getIndex(2);
  const animation = new AnimationSystem();
  animation.initialize(info, cache.getIndex(0), cache.getIndex(1), config.getArchive(12), cache.getIndex(22));
  const frameLoader = animation.getSeqFrameLoader();
  if (!frameLoader) throw new Error('missing frame loader');
  const loader = new SpotAnimModelLoader(
    new ArchiveSpotAnimTypeLoader(info, config.getArchive(13)),
    new IndexModelLoader(cache.getIndex(7)),
    new ArchiveSeqTypeLoader(info, config.getArchive(12)),
    frameLoader,
  );
  return { loader, animation };
}

/**
 * Loads every way a spotanim's models are lit and converted: its static model, its animation
 * frames and each skeletal pose. `visit` runs after each step, before the next can reuse the
 * model a skeletal pose was built on. Returns how many skeletal poses it visited.
 */
export function visitSpotAnimModels(
  loader: SpotAnimModelLoader,
  animation: AnimationSystem,
  ids: Iterable<number>,
  visit: (label: string) => void,
): number {
  let skeletalPoses = 0;
  for (const id of ids) {
    loader.loadSpotAnimModelData(id);
    visit(`spotanim ${id}`);
    loader.loadAnimatedSpotAnim(id);
    visit(`spotanim ${id} frames`);
    const skeletal = loader.loadSkeletalSpotAnimModel(id);
    const skeletalSeq = skeletal ? animation.loadSkeletalSeq(skeletal.seqType.skeletalId) : undefined;
    if (!skeletal || !skeletalSeq) continue;
    for (let frame = skeletal.seqType.skeletalStart; frame < skeletal.seqType.skeletalEnd; frame++) {
      loader.poseSkeletalSpotAnimMesh(skeletal, skeletalSeq, frame);
      visit(`spotanim ${id} skeletal frame ${frame}`);
      skeletalPoses++;
    }
  }
  return skeletalPoses;
}

export async function openLocModelLoader(): Promise<{ loader: LocModelLoader; maps: MapLoader }> {
  const { cache } = await openRealCache([0, 1, 2, 5, 7]);
  const config = cache.getIndex(2);
  const loader = new LocModelLoader(
    TEST_CACHE_INFO,
    config.getArchive(6),
    cache.getIndex(7),
    config.getArchive(12),
    cache.getIndex(0),
    cache.getIndex(1),
  );
  return { loader, maps: new MapLoader(cache.getIndex(5), TEST_CACHE_INFO.revision) };
}

export interface EncounterLocs {
  readonly kind: (typeof ENCOUNTER_KINDS)[number];
  readonly locs: LocWithType[];
  readonly options: LocRenderOptions | undefined;
}

/**
 * Each encounter's core map square LOCs as `CacheManager.loadMapLocs` assembles them, with the
 * surrounding squares the test cache has as terrain context, and the encounter's LOC render options.
 */
export async function loadEncounterLocs(loader: LocModelLoader, maps: MapLoader): Promise<EncounterLocs[]> {
  const encounters: EncounterLocs[] = [];
  for (const [index, kind] of ENCOUNTER_KINDS.entries()) {
    const square = ENCOUNTER_MAP_SQUARES[index];
    if (!square) throw new Error(`No map square for ${kind}`);
    const terrain = new Map<string, MapSquareData>();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const loaded = await maps.loadMapSquare(square.x + dx, square.y + dy);
        if (loaded) terrain.set(`${square.x + dx},${square.y + dy}`, loaded);
      }
    }
    const core = terrain.get(`${square.x},${square.y}`);
    const placed = await maps.loadLocations(square.x, square.y, square.key);
    if (!core || !placed) throw new Error(`Expected map square ${square.x}_${square.y}`);
    const context = createTerrainContext(core, (x, y) => terrain.get(`${x},${y}`));
    const locs: LocWithType[] = [];
    for (const location of placed.locations) {
      const locType = loader.loadLocType(location.id);
      if (!locType) continue;
      locs.push({
        location,
        locType,
        modelType: location.type as LocModelType,
        mapSquareOffset: { x: 0, y: 0 },
        terrainHeightPlanes: context.tileHeights,
        terrainContextOrigin: { x: context.coreOriginX, y: context.coreOriginY },
      });
    }
    encounters.push({ kind, locs, options: resolveEncounterLocRenderOptions(getEncounterRenderConfig(kind)) });
  }
  return encounters;
}
