/**
 * State Machine:
 * UNLOADED → DOWNLOADING → EXTRACTING → LOADED
 *         ↘ ERROR ↗
 */

import JSZip from 'jszip';
import type { ArenaConfig } from '../core/arena/ArenaConfig';
import { setDefaultArenaConfig } from '../core/constants';
import { type AnimationSystem, createAnimationSystem } from '../render/backends/picogl/AnimationSystem';
import type { CacheIndex } from '../rs/cache/CacheIndex';
import type { CacheInfo as RsCacheInfo } from '../rs/cache/CacheInfo';
import { CacheSystem } from '../rs/cache/CacheSystem';
import {
  analyzeWalkability,
  applyMapSquareCollision,
  type CollisionLocInput,
  type CollisionMap,
  collectWalkableTiles,
  type ExcludedStaticLocIds,
  findContiguousRegion,
  getBoundsFromRegion,
  type LocCollisionLoader,
  type MapSquareCollisionSource,
} from '../rs/collision/WalkabilityAnalyzer';
import { Bzip2 } from '../rs/compression/Bzip2';
import { ArchiveEnumTypeLoader, type EnumTypeLoader } from '../rs/config/enumtype/EnumTypeLoader';
import {
  ArchiveOverlayTypeLoader,
  ArchiveUnderlayTypeLoader,
  type OverlayTypeLoader,
  type UnderlayTypeLoader,
} from '../rs/config/flotype/FloTypeLoader';
import { ArchiveIdentKitLoader, type IdentKitLoader } from '../rs/config/identkit/IdentKitLoader';
import { LocModelLoader } from '../rs/config/loctype/LocModelLoader';
import type { LocModelType } from '../rs/config/loctype/LocModelType';
import type { LocType } from '../rs/config/loctype/LocType';
import { ArchiveLocTypeLoader, type LocTypeLoader } from '../rs/config/loctype/LocTypeLoader';
import type { NpcType } from '../rs/config/npctype/NpcType';
import { ArchiveNpcTypeLoader, type NpcTypeLoader } from '../rs/config/npctype/NpcTypeLoader';
import { ArchiveObjTypeLoader, type ObjTypeLoader } from '../rs/config/objtype/ObjTypeLoader';
import { ArchiveSpotAnimTypeLoader, type SpotAnimTypeLoader } from '../rs/config/spotanimtype/SpotAnimTypeLoader';
import { ArchiveStructTypeLoader, type StructTypeLoader } from '../rs/config/structtype/StructTypeLoader';
import type { LocationData, MapSquareData, NpcSpawnData } from '../rs/map/MapLoader';
import { MAP_SQUARE_SIZE, MapLoader } from '../rs/map/MapLoader';
import {
  createTerrainContext,
  getMapSquareBlock,
  getTerrainContextLoadOffsets,
  type MapSquareOffsets,
} from '../rs/map/mapSquareBlock';
import { IndexModelLoader, type ModelLoader } from '../rs/model/ModelLoader';
import { NpcModelLoader } from '../rs/model/NpcModelLoader';
import { PlayerModelLoader } from '../rs/model/PlayerModelLoader';
import { SpotAnimModelLoader } from '../rs/model/SpotAnimModelLoader';
import { indexedSpriteToDataUrl } from '../rs/sprite/IndexedSprite';
import { SpriteLoader } from '../rs/sprite/SpriteLoader';
import { SpriteTextureLoader } from '../rs/texture/SpriteTextureLoader';
import type { TextureLoader } from '../rs/texture/TextureLoader';
import { LogLevel, log } from '../util/Logger';
import { profiler } from '../util/Profiler';
import { type CacheMeta, CacheStorage } from './CacheStorage';
import { type CacheInfo, cacheNeedsBzip2, OpenRS2Client } from './OpenRS2Client';

export type { ArenaBounds } from '../rs/collision/WalkabilityAnalyzer';
export type CacheState = 'UNLOADED' | 'DOWNLOADING' | 'EXTRACTING' | 'LOADED' | 'ERROR';

export type LoadingStage = 'downloading' | 'extracting' | 'storing' | 'initializing' | 'loading-from-storage';

/** What the loading screen shows: `getDownloadState()`. */
export type CacheDownloadState =
  | { status: 'idle' }
  | { status: 'loading'; stage: LoadingStage; percent: number; detail: string }
  | { status: 'success' }
  | { status: 'error'; message: string };

/**
 * With a deployed hash, a missing or unequal stored hash is stale. With no deployed hash in the
 * manifest this returns false and only the cacheId decides.
 */
export function isStoredCacheStale(meta: CacheMeta | null, deployedHash: string | undefined): boolean {
  if (!meta || !deployedHash) return false;
  return meta.manifestHash !== deployedHash || !meta.sourceUrl.includes(`?v=${deployedHash}`);
}

const FRAMES_INDEX = 0;
const BASES_INDEX = 1;
const CONFIG_INDEX = 2;
/** Sound-effect synth patches, one group per sound id; rendered by `src/audio/synth`. */
const SOUND_EFFECT_INDEX = 4;
const MAP_INDEX = 5;
const MODEL_INDEX = 7;
const SPRITES_INDEX = 8;
const TEXTURES_INDEX = 9;
const ANIM_KEY_FRAMES_INDEX = 22;
/** The indices initializeCacheSystem() loads; a copy missing any of them cannot initialize. */
const LOADED_INDICES = [
  FRAMES_INDEX,
  BASES_INDEX,
  CONFIG_INDEX,
  SOUND_EFFECT_INDEX,
  MAP_INDEX,
  MODEL_INDEX,
  SPRITES_INDEX,
  TEXTURES_INDEX,
  ANIM_KEY_FRAMES_INDEX,
];

/** `.dat` is accepted as an alias of `.dat2`, as the cache store itself does. */
function hasRequiredCacheFiles(files: ReadonlyMap<string, ArrayBuffer>): boolean {
  return (
    (files.has('main_file_cache.dat2') || files.has('main_file_cache.dat')) &&
    files.has('main_file_cache.idx255') &&
    LOADED_INDICES.every((index) => files.has(`main_file_cache.idx${index}`))
  );
}

export interface LocWithType {
  location: LocationData;
  locType: LocType;
  modelType: LocModelType;
  mapSquareOffset: { readonly x: number; readonly y: number };
  terrainHeightPlanes: Int32Array[][];
  terrainContextOrigin: { readonly x: number; readonly y: number };
}

type DecodedLocWithType = Omit<LocWithType, 'mapSquareOffset' | 'terrainHeightPlanes' | 'terrainContextOrigin'>;

export interface NpcWithType {
  spawn: NpcSpawnData;
  npcType: NpcType;
}

export interface AdditionalMapSquareData {
  mapX: number;
  mapY: number;
  terrain: MapSquareData | null;
  locations: LocWithType[] | null;
  npcs: NpcWithType[] | null;
}

export interface CacheManagerState {
  state: CacheState;
  error?: string;
  downloadProgress?: {
    percent: number;
    downloadedMB: number;
    totalMB: number;
  };
  cacheInfo?: CacheInfo;
}

function createBlockCollisionMap(radius: number): CollisionMap {
  const origin = -radius * MAP_SQUARE_SIZE;
  const size = (radius * 2 + 1) * MAP_SQUARE_SIZE;
  const flags = new Int32Array(size * size);
  const index = (x: number, y: number): number | null => {
    const localX = x - origin;
    const localY = y - origin;
    return localX >= 0 && localX < size && localY >= 0 && localY < size ? localX + localY * size : null;
  };
  return {
    sizeX: size,
    sizeY: size,
    flags,
    getFlag(x, y) {
      const offset = index(x, y);
      return offset === null ? -1 : flags[offset];
    },
    hasFlag(x, y, flag) {
      const value = this.getFlag(x, y);
      return value !== -1 && (value & flag) !== 0;
    },
    flag(x, y, flag) {
      const offset = index(x, y);
      if (offset !== null) flags[offset] |= flag;
    },
    unflag(x, y, flag) {
      const offset = index(x, y);
      if (offset !== null) flags[offset] &= ~flag;
    },
  };
}

export class CacheManager {
  private storage: CacheStorage;
  private client: OpenRS2Client;
  private state: CacheState = 'UNLOADED';
  private error?: string;
  private downloadProgress?: {
    percent: number;
    downloadedMB: number;
    totalMB: number;
  };
  private cacheInfo?: CacheInfo;
  private listeners: Set<(state: CacheManagerState) => void> = new Set();
  private loadingState: CacheDownloadState = { status: 'idle' };

  private cacheSystem: CacheSystem | null = null;
  private mapLoader: MapLoader | null = null;
  private underlayLoader: UnderlayTypeLoader | null = null;
  private overlayLoader: OverlayTypeLoader | null = null;
  private locTypeLoader: LocTypeLoader | null = null;
  private npcTypeLoader: NpcTypeLoader | null = null;
  private objTypeLoader: ObjTypeLoader | null = null;
  private enumTypeLoader: EnumTypeLoader | null = null;
  private structTypeLoader: StructTypeLoader | null = null;
  private identKitLoader: IdentKitLoader | null = null;
  private spotAnimTypeLoader: SpotAnimTypeLoader | null = null;
  private locModelLoader: LocModelLoader | null = null;
  private npcModelLoader: NpcModelLoader | null = null;
  private playerModelLoader: PlayerModelLoader | null = null;
  private spotAnimModelLoader: SpotAnimModelLoader | null = null;
  private modelLoader: ModelLoader | null = null;
  private animationSystem: AnimationSystem | null = null;
  private textureLoader: TextureLoader | null = null;
  private minimapNpcDotUrl: string | null = null;
  private rsCacheInfo: RsCacheInfo | null = null;
  private xteaKeys: Map<number, number[]> = new Map();
  private additionalMapSquares: Map<string, AdditionalMapSquareData> = new Map();

  constructor(storage?: CacheStorage, client?: OpenRS2Client) {
    this.storage = storage || new CacheStorage();
    this.client = client || new OpenRS2Client();
  }

  subscribe(listener: (state: CacheManagerState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): CacheManagerState {
    return {
      state: this.state,
      error: this.error,
      downloadProgress: this.downloadProgress,
      cacheInfo: this.cacheInfo,
    };
  }

  getDownloadState(): CacheDownloadState {
    // Always report active loading progress, even before state transitions to DOWNLOADING.
    // This ensures early progress (connecting, checking storage) reaches the UI.
    if (this.loadingState.status === 'loading') {
      return this.loadingState;
    }
    switch (this.state) {
      case 'UNLOADED':
        return { status: 'idle' };
      case 'DOWNLOADING':
      case 'EXTRACTING':
        return this.loadingState ?? { status: 'idle' };
      case 'LOADED':
        return { status: 'success' };
      case 'ERROR':
        return { status: 'error', message: this.error || 'Unknown error' };
    }
  }

  async ensureCache(cacheId?: number): Promise<void> {
    profiler.start('CacheManager.ensureCache');

    if (this.state === 'LOADED') {
      profiler.end('CacheManager.ensureCache');
      return;
    }

    if (this.state === 'DOWNLOADING' || this.state === 'EXTRACTING') {
      profiler.end('CacheManager.ensureCache');
      return this.waitForState('LOADED');
    }

    try {
      let targetCacheId = cacheId;
      if (!targetCacheId) {
        profiler.start('CacheManager.getManifest');
        const manifest = await this.client.getManifest();
        targetCacheId = manifest.id;
        this.cacheInfo = manifest;
        profiler.end('CacheManager.getManifest');
      }

      profiler.start('CacheManager.checkIndexedDB');
      const meta = await this.readStoredMeta(targetCacheId);
      profiler.end('CacheManager.checkIndexedDB');

      const deployedHash = this.cacheInfo?.diskZipSha256;
      const contentChanged = isStoredCacheStale(meta, deployedHash);

      if (meta && !contentChanged) {
        log.info(
          'Cache',
          `Cache ${targetCacheId} found in IndexedDB (fetched at ${new Date(meta.fetchedAt).toISOString()})`,
        );
        this.setLoadingProgress('loading-from-storage', 0, 'Reading from browser storage...');
        this.setState('DOWNLOADING');
        const storedFiles = await this.readStoredFiles(targetCacheId);
        if (storedFiles) {
          this.setLoadingProgress('initializing', 8, 'Initializing cache system...');
          await this.initializeCacheSystem(storedFiles);
          this.setState('LOADED');
          profiler.end('CacheManager.ensureCache');
          return;
        }
        // Unreadable or incomplete stored copy: fetch a fresh one below.
      } else if (meta && contentChanged) {
        log.info(
          'Cache',
          `Cache ${targetCacheId} content changed (stored "${meta.manifestHash}" != deployed "${deployedHash}"), re-downloading`,
        );
      } else {
        log.info('Cache', `Cache ${targetCacheId} not found in IndexedDB, downloading...`);
      }
      await this.downloadCache(targetCacheId);
      profiler.end('CacheManager.ensureCache');
    } catch (error) {
      profiler.end('CacheManager.ensureCache');
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.setState('ERROR', message);
      throw error;
    }
  }

  private async downloadCache(cacheId: number): Promise<void> {
    profiler.start('CacheManager.downloadCache');
    this.setLoadingProgress('downloading', 0, 'Loading the game cache...');
    this.setState('DOWNLOADING');

    try {
      const estimatedTotalBytes = this.cacheInfo?.size;
      const estimatedTotalMB = estimatedTotalBytes ? Math.round(estimatedTotalBytes / (1024 * 1024)) : 160;
      profiler.start('CacheManager.downloadZip');
      const { data: zipData, matchesManifest } = await this.client.downloadCache(
        cacheId,
        (percent, receivedBytes) => {
          const downloadedMB = receivedBytes / (1024 * 1024);
          this.downloadProgress = { percent, downloadedMB, totalMB: estimatedTotalMB };
          const dlStr = downloadedMB.toFixed(0);
          this.setLoadingProgress('downloading', percent, `${dlStr} MB / ${estimatedTotalMB} MB`);
        },
        {
          ...(estimatedTotalBytes ? { estimatedTotalBytes } : {}),
          ...(this.cacheInfo?.diskZipSha256 ? { diskZipSha256: this.cacheInfo.diskZipSha256 } : {}),
        },
      );
      profiler.end('CacheManager.downloadZip');

      const actualMB = (zipData.byteLength / 1024 / 1024).toFixed(1);
      log.info('Cache', `Downloaded cache ${cacheId} (${actualMB} MB)`);

      this.setLoadingProgress('extracting', 0, 'Unpacking cache archive...');
      this.setState('EXTRACTING');
      profiler.start('CacheManager.extractZip');
      const files = await this.extractZip(zipData);
      profiler.end('CacheManager.extractZip');

      // A copy that could not be confirmed against the manifest is used for this session only,
      // so the next visit downloads again instead of keeping it as the published cache.
      let filesStored = false;
      if (matchesManifest) {
        this.setLoadingProgress('storing', 0, 'Saving to browser storage...');
        profiler.start('CacheManager.storeToIndexedDB');
        filesStored = await this.storeFiles(cacheId, files);
        profiler.end('CacheManager.storeToIndexedDB');
      }

      await this.initializeCacheSystem(files);

      // The meta record is the completion marker that lets a later load skip the
      // download, so it is written last: only once every file is stored and the set
      // has initialized.
      if (filesStored && (await this.storeMeta(cacheId))) {
        await this.pruneOlderCaches(cacheId);
      }
      this.setState('LOADED');
      const persisted = filesStored
        ? ' and stored in IndexedDB'
        : matchesManifest
          ? ' (not persisted)'
          : ' (unverified, for this session only)';
      log.info('Cache', `Cache ${cacheId} extracted${persisted}`);
      profiler.end('CacheManager.downloadCache');
    } catch (error) {
      profiler.end('CacheManager.downloadCache');
      throw error;
    }
  }

  /**
   * Browser storage only spares the next visit a download, so its failures (WebKit's
   * "Internal error.", "Database deleted by request of the user", quota) are logged
   * and the session continues from the in-memory files.
   */
  private async readStoredMeta(cacheId: number): Promise<CacheMeta | null> {
    try {
      return await this.storage.getCacheMeta(cacheId);
    } catch (error) {
      log.warn('Cache', 'Could not read cache metadata from browser storage; downloading instead:', error);
      return null;
    }
  }

  /** @returns false when nothing was persisted, in which case no completion marker may be written. */
  private async storeFiles(cacheId: number, files: Map<string, ArrayBuffer>): Promise<boolean> {
    try {
      // Drop the completion marker before overwriting anything, so files left by an
      // interrupted write are never treated as complete.
      await this.storage.deleteCacheMeta(cacheId);
      const fileEntries = [...files.entries()];
      for (let i = 0; i < fileEntries.length; i++) {
        const [name, data] = fileEntries[i];
        await this.storage.storeCacheFile(name, data, cacheId);
        const pct = Math.round(((i + 1) / fileEntries.length) * 100);
        this.setLoadingProgress('storing', pct, `Saving ${name} (${i + 1}/${fileEntries.length})`);
      }
      return true;
    } catch (error) {
      log.warn('Cache', 'Could not save the cache to browser storage; using it for this session only:', error);
      return false;
    }
  }

  /** @returns whether the completion marker was written. */
  private async storeMeta(cacheId: number): Promise<boolean> {
    const diskZipSha256 = this.cacheInfo?.diskZipSha256;
    const meta: CacheMeta = {
      cacheId,
      buildMajor: this.cacheInfo?.builds[0]?.major || 0,
      buildMinor: this.cacheInfo?.builds[0]?.minor || 0,
      fetchedAt: Date.now(),
      sourceUrl: this.client.getDiskZipUrl(diskZipSha256 ? { diskZipSha256 } : {}),
      manifestHash: diskZipSha256 ?? '',
    };
    try {
      await this.storage.storeCacheMeta(meta);
      return true;
    } catch (error) {
      log.warn('Cache', 'Could not mark the stored cache complete; it will be downloaded again next visit:', error);
      return false;
    }
  }

  /**
   * Older cache ids are never loaded again once a newer install is complete, but
   * would otherwise keep their full copy in browser storage indefinitely.
   */
  private async pruneOlderCaches(cacheId: number): Promise<void> {
    try {
      await this.storage.deleteOlderCaches(cacheId);
    } catch (error) {
      log.warn('Cache', 'Could not remove older caches from browser storage:', error);
    }
  }

  private async extractZip(zipData: ArrayBuffer): Promise<Map<string, ArrayBuffer>> {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(zipData);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Cache archive is corrupt or incomplete: ${message}`);
    }
    const files = new Map<string, ArrayBuffer>();

    for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
      if (zipEntry.dir) continue;

      const fileName = relativePath.split('/').pop() || relativePath;
      if (!this.isCacheFile(fileName)) continue;

      const data = await zipEntry.async('arraybuffer');
      files.set(fileName, data);
    }

    if (!hasRequiredCacheFiles(files)) {
      throw new Error('Invalid cache zip: missing required cache files');
    }

    return files;
  }

  private isCacheFile(name: string): boolean {
    return name === 'main_file_cache.dat2' || name === 'main_file_cache.dat' || name.startsWith('main_file_cache.idx');
  }

  private async initializeCacheSystem(files: Map<string, ArrayBuffer>): Promise<void> {
    profiler.start('CacheManager.initializeCacheSystem');

    const revision = this.cacheInfo?.builds[0]?.major || 232;
    this.minimapNpcDotUrl = null;

    // The mirror is re-encoded to gzip at trim time, so a normal load never fetches the bzip2
    // WebAssembly decoder. It is still shipped and loaded here, before the first container decode,
    // whenever bzip2 cannot be ruled out: a manifest without `containerCompressions`.
    if (cacheNeedsBzip2(this.cacheInfo)) {
      this.setLoadingProgress('initializing', 10, 'Starting Bzip2 decompressor...');
      profiler.start('CacheManager.Bzip2.initWasm');
      await Bzip2.initWasm();
      profiler.end('CacheManager.Bzip2.initWasm');
    }

    this.setLoadingProgress('initializing', 18, 'Reading cache index files...');
    profiler.start('CacheManager.CacheSystem.fromMap');
    this.cacheSystem = CacheSystem.fromMap('dat2', files, LOADED_INDICES);
    profiler.end('CacheManager.CacheSystem.fromMap');

    profiler.start('CacheManager.MapLoader.init');
    const mapIndex = this.cacheSystem.getIndex(MAP_INDEX);
    this.mapLoader = new MapLoader(mapIndex, revision);
    profiler.end('CacheManager.MapLoader.init');

    this.rsCacheInfo = {
      name: 'osrs',
      game: 'oldschool',
      environment: 'live',
      revision,
      timestamp: new Date().toISOString(),
      size: 0,
    };

    try {
      this.setLoadingProgress('initializing', 25, 'Loading items, NPCs, and objects...');
      profiler.start('CacheManager.initConfigLoaders');
      const configIndex = this.cacheSystem.getIndex(CONFIG_INDEX);

      const UNDERLAY_ARCHIVE = 1;
      const IDK_ARCHIVE = 3;
      const OVERLAY_ARCHIVE = 4;
      const LOC_ARCHIVE = 6;
      const NPC_ARCHIVE = 9;
      const OBJ_ARCHIVE = 10;
      const SPOTANIM_ARCHIVE = 13;
      const ENUM_ARCHIVE = 8;
      const STRUCT_ARCHIVE = 34;
      const underlayArchive = configIndex.getArchive(UNDERLAY_ARCHIVE);
      const overlayArchive = configIndex.getArchive(OVERLAY_ARCHIVE);
      const locArchive = configIndex.getArchive(LOC_ARCHIVE);
      const npcArchive = configIndex.getArchive(NPC_ARCHIVE);
      const objArchive = configIndex.getArchive(OBJ_ARCHIVE);
      const idkArchive = configIndex.getArchive(IDK_ARCHIVE);
      const spotAnimArchive = configIndex.getArchive(SPOTANIM_ARCHIVE);
      const enumArchive = configIndex.getArchive(ENUM_ARCHIVE);
      const structArchive = configIndex.getArchive(STRUCT_ARCHIVE);

      this.underlayLoader = new ArchiveUnderlayTypeLoader(this.rsCacheInfo, underlayArchive);
      this.overlayLoader = new ArchiveOverlayTypeLoader(this.rsCacheInfo, overlayArchive);
      this.locTypeLoader = new ArchiveLocTypeLoader(this.rsCacheInfo, locArchive);
      this.npcTypeLoader = new ArchiveNpcTypeLoader(this.rsCacheInfo, npcArchive);
      this.objTypeLoader = new ArchiveObjTypeLoader(this.rsCacheInfo, objArchive);
      this.enumTypeLoader = new ArchiveEnumTypeLoader(this.rsCacheInfo, enumArchive);
      this.structTypeLoader = new ArchiveStructTypeLoader(this.rsCacheInfo, structArchive);
      this.identKitLoader = new ArchiveIdentKitLoader(this.rsCacheInfo, idkArchive);
      this.spotAnimTypeLoader = new ArchiveSpotAnimTypeLoader(this.rsCacheInfo, spotAnimArchive);

      const modelIndex = this.cacheSystem.getIndex(MODEL_INDEX);
      const framesIndex = this.cacheSystem.getIndex(FRAMES_INDEX);
      const basesIndex = this.cacheSystem.getIndex(BASES_INDEX);

      const SEQ_ARCHIVE = 12;
      const seqArchive = configIndex.getArchive(SEQ_ARCHIVE);
      log.debug('Cache', `seqArchive loaded, fileCount=${seqArchive.fileCount}, lastFileId=${seqArchive.lastFileId}`);

      this.setLoadingProgress('initializing', 38, 'Preparing 3D model loaders...');
      this.locModelLoader = new LocModelLoader(
        this.rsCacheInfo,
        locArchive,
        modelIndex,
        seqArchive,
        framesIndex,
        basesIndex,
      );

      this.modelLoader = new IndexModelLoader(modelIndex);
      this.npcModelLoader = new NpcModelLoader(this.npcTypeLoader, this.modelLoader);
      this.spotAnimModelLoader = new SpotAnimModelLoader(
        this.spotAnimTypeLoader,
        this.modelLoader,
        this.locModelLoader.getSeqTypeLoader() ?? undefined,
        this.locModelLoader.getSeqFrameLoader() ?? undefined,
      );
      this.playerModelLoader = new PlayerModelLoader(this.objTypeLoader, this.identKitLoader, this.modelLoader);

      this.setLoadingProgress('initializing', 50, 'Loading animation sequences...');
      this.animationSystem = createAnimationSystem();
      const animKeyFramesIndex = this.cacheSystem.getIndex(ANIM_KEY_FRAMES_INDEX);
      this.animationSystem.initialize(this.rsCacheInfo, framesIndex, basesIndex, seqArchive, animKeyFramesIndex);

      profiler.end('CacheManager.initConfigLoaders');

      log.info('Cache', 'Underlay/overlay/loc/npc/model loaders initialized successfully');
    } catch (e) {
      profiler.end('CacheManager.initConfigLoaders');
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(`Failed to load CONFIG index: ${message}`);
    }

    try {
      this.setLoadingProgress('initializing', 60, 'Loading sprites and textures...');
      profiler.start('CacheManager.initTextureLoader');
      const texturesIndex = this.cacheSystem.getIndex(TEXTURES_INDEX);
      const spritesIndex = this.cacheSystem.getIndex(SPRITES_INDEX);
      this.textureLoader = SpriteTextureLoader.load(texturesIndex, spritesIndex);

      try {
        const npcDotSprite = SpriteLoader.loadIntoIndexedSprite(spritesIndex, 511);
        if (npcDotSprite) {
          this.minimapNpcDotUrl = indexedSpriteToDataUrl(npcDotSprite);
        }
      } catch (e) {
        log.warn('Cache', 'Failed to load minimap NPC dot sprite:', e);
      }

      profiler.end('CacheManager.initTextureLoader');
      log.debug('Cache', `TextureLoader initialized with ${this.textureLoader.getTextureIds().length} textures`);
    } catch (e) {
      profiler.end('CacheManager.initTextureLoader');
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(`Failed to load TEXTURES index: ${message}`);
    }

    this.setLoadingProgress('initializing', 68, 'Fetching map encryption keys...');
    await this.loadXteaKeys();
    this.setLoadingProgress('initializing', 76, 'Computing walkable tiles...');
    await this.analyzeArenaBounds();
    this.setLoadingProgress('initializing', 84, 'Loading arena objects and NPCs...');
    if (log.isEnabled(LogLevel.DEBUG, 'Cache')) {
      await this.logYamaArenaContents();
    }
    profiler.end('CacheManager.initializeCacheSystem');
  }

  async loadMapLocs(mapX: number, mapY: number, offsets?: MapSquareOffsets): Promise<LocWithType[] | null> {
    if (!this.mapLoader) return null;
    const renderedOffsets = offsets ?? [{ dx: 0, dy: 0 }];
    const mapSquareBlock = getMapSquareBlock(renderedOffsets);
    const terrainEntries = await Promise.all(
      getTerrainContextLoadOffsets(renderedOffsets).map(async ({ dx, dy }) => {
        const squareX = mapX + dx;
        const squareY = mapY + dy;
        return { squareX, squareY, terrain: await this.mapLoader?.loadMapSquare(squareX, squareY) };
      }),
    );
    const terrainLookup = new Map<string, MapSquareData>();
    for (const { squareX, squareY, terrain } of terrainEntries) {
      if (terrain) terrainLookup.set(`${squareX},${squareY}`, terrain);
    }
    const squareLocs = await Promise.all(
      mapSquareBlock.map(async ({ dx, dy, tileOffsetX, tileOffsetY }) => {
        const squareX = mapX + dx;
        const squareY = mapY + dy;
        const terrain = terrainLookup.get(`${squareX},${squareY}`);
        if (!terrain) return [];
        const context = createTerrainContext(terrain, (neighborX, neighborY) =>
          terrainLookup.get(`${neighborX},${neighborY}`),
        );
        const locs = await this.loadLocationsWithTypes(squareX, squareY, this.getXteaKey(squareX, squareY));
        return (locs ?? []).map(
          (entry): LocWithType => ({
            ...entry,
            location: {
              ...entry.location,
              localX: entry.location.localX + tileOffsetX,
              localY: entry.location.localY + tileOffsetY,
            },
            mapSquareOffset: { x: tileOffsetX, y: tileOffsetY },
            terrainHeightPlanes: context.tileHeights,
            terrainContextOrigin: { x: context.coreOriginX, y: context.coreOriginY },
          }),
        );
      }),
    );
    return squareLocs.flat();
  }

  private async loadXteaKeys(): Promise<void> {
    profiler.start('CacheManager.loadXteaKeys');
    if (!this.cacheInfo) {
      profiler.end('CacheManager.loadXteaKeys');
      return;
    }

    const cacheId = this.cacheInfo.id;
    const xteaStorageKey = `xtea_keys_${cacheId}.json`;

    try {
      profiler.start('CacheManager.loadXteaKeys.checkCache');
      let cachedKeys: ArrayBuffer | null = null;
      try {
        cachedKeys = await this.storage.getCacheFile(xteaStorageKey, cacheId);
      } catch (error) {
        log.warn('Cache', 'Could not read stored XTEA keys; fetching them instead:', error);
      }
      profiler.end('CacheManager.loadXteaKeys.checkCache');

      let keysArray: any[];
      let needsRefetch = false;

      if (cachedKeys) {
        profiler.start('CacheManager.loadXteaKeys.parseCache');
        const decoder = new TextDecoder();
        const parsed = JSON.parse(decoder.decode(cachedKeys));
        profiler.end('CacheManager.loadXteaKeys.parseCache');

        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'keys' in parsed) {
          keysArray = parsed.keys;
          log.info('Cache', 'Loaded XTEA keys from IndexedDB cache');
        } else {
          // Not a `{ keys, fetchedAt }` envelope: parse nothing and fetch the keys again.
          keysArray = [];
          needsRefetch = true;
        }
      } else {
        keysArray = await this.fetchAndCacheXteaKeys(cacheId, xteaStorageKey);
      }

      this.parseXteaKeysArray(keysArray);

      if (this.xteaKeys.size === 0 && needsRefetch) {
        log.warn('Cache', 'Cached XTEA data is not a key envelope, re-fetching from network...');
        profiler.start('CacheManager.loadXteaKeys.refetch');
        try {
          keysArray = await this.fetchAndCacheXteaKeys(cacheId, xteaStorageKey);
          this.parseXteaKeysArray(keysArray);
          log.info('Cache', `Re-fetched ${this.xteaKeys.size} XTEA keys, cache updated`);
        } catch (refetchError) {
          log.warn('Cache', 'XTEA re-fetch failed:', refetchError);
        }
        profiler.end('CacheManager.loadXteaKeys.refetch');
      }

      log.info('Cache', `Loaded ${this.xteaKeys.size} XTEA keys`);

      const yamaKey = this.getXteaKey(23, 157);
      if (yamaKey) {
        log.trace('Cache', `Found XTEA key for Yama map (23, 157): [${yamaKey.join(', ')}]`);
      }
      profiler.end('CacheManager.loadXteaKeys');
    } catch (e) {
      profiler.end('CacheManager.loadXteaKeys');
      log.warn('Cache', 'Failed to load XTEA keys:', e);
    }
  }

  private async fetchAndCacheXteaKeys(cacheId: number, storageKey: string): Promise<any[]> {
    profiler.start('CacheManager.loadXteaKeys.fetch');
    let keysArray: any[];
    try {
      keysArray = await this.client.downloadKeys(cacheId);
    } finally {
      profiler.end('CacheManager.loadXteaKeys.fetch');
    }

    profiler.start('CacheManager.loadXteaKeys.storeCache');
    const envelope = { keys: Array.isArray(keysArray) ? keysArray : [], fetchedAt: Date.now() };
    const encoder = new TextEncoder();
    const keysBuffer = encoder.encode(JSON.stringify(envelope)).buffer;
    try {
      await this.storage.storeCacheFile(storageKey, keysBuffer, cacheId);
      log.info('Cache', 'Fetched and cached XTEA keys to IndexedDB');
    } catch (error) {
      log.warn('Cache', 'Could not save XTEA keys to browser storage; using them for this session only:', error);
    }
    profiler.end('CacheManager.loadXteaKeys.storeCache');

    return Array.isArray(keysArray) ? keysArray : [];
  }

  private parseXteaKeysArray(keysArray: any[]): void {
    this.xteaKeys.clear();
    if (!Array.isArray(keysArray)) return;
    for (const entry of keysArray) {
      if (entry.mapsquare !== undefined && Array.isArray(entry.key) && entry.key.length === 4) {
        this.xteaKeys.set(entry.mapsquare, entry.key);
      }
    }
  }

  getXteaKey(mapX: number, mapY: number): number[] | undefined {
    const mapsquare = (mapX << 8) | mapY;
    return this.xteaKeys.get(mapsquare);
  }

  private async logYamaArenaContents(): Promise<void> {
    const YAMA_MAP_X = 23;
    const YAMA_MAP_Y = 157;
    const xteas = this.getXteaKey(YAMA_MAP_X, YAMA_MAP_Y);

    log.info('Cache', `Loading Yama Arena contents from map ${YAMA_MAP_X}_${YAMA_MAP_Y}...`);
    if (xteas) {
      log.debug('Cache', `Using XTEA key for map ${YAMA_MAP_X}_${YAMA_MAP_Y}`);
    } else {
      log.warn('Cache', `No XTEA key found for map ${YAMA_MAP_X}_${YAMA_MAP_Y}`);
    }

    try {
      const locs = await this.loadLocationsWithTypes(YAMA_MAP_X, YAMA_MAP_Y, xteas);
      if (locs && locs.length > 0) {
        log.info('Cache', `Yama Arena Locations: ${locs.length} objects loaded`);
      } else {
        log.warn('Cache', 'Yama Arena: No locations found (locs file may need XTEA keys or does not exist)');
      }

      const npcs = await this.loadNpcSpawnsWithTypes(YAMA_MAP_X, YAMA_MAP_Y, xteas);
      if (npcs && npcs.length > 0) {
        log.info('Cache', `Yama Arena NPC Spawns: ${npcs.length} NPCs loaded`);
        for (const npc of npcs) {
          log.trace(
            'Cache',
            `${npc.npcType.name} (ID: ${npc.spawn.id}) at (${npc.spawn.x}, ${npc.spawn.y}) level ${npc.spawn.level}`,
          );
        }
      } else {
        log.warn('Cache', 'Yama Arena: No NPC spawns found (file may need XTEA keys or does not exist)');
      }
    } catch (e) {
      log.error('Cache', 'Failed to log Yama arena contents:', e);
    }
  }

  /** @returns null when the stored copy cannot be read or is incomplete, so the caller downloads instead. */
  private async readStoredFiles(cacheId: number): Promise<Map<string, ArrayBuffer> | null> {
    this.setLoadingProgress('loading-from-storage', 2, 'Reading cache files...');
    profiler.start('CacheManager.readStoredFiles');

    const filesToRead = ['main_file_cache.dat2', 'main_file_cache.dat', 'main_file_cache.idx255'];
    for (const index of LOADED_INDICES) {
      filesToRead.push(`main_file_cache.idx${index}`);
    }

    let files: Map<string, ArrayBuffer>;
    try {
      // Progress mapped to percent 2→7 (file reading phase)
      files = await this.storage.getCacheFilesParallel(
        filesToRead,
        (completed, total) => {
          const pct = 2 + Math.round((completed / total) * 5);
          this.setLoadingProgress('loading-from-storage', pct, `Reading cache files (${completed}/${total})...`);
        },
        cacheId,
      );
    } catch (error) {
      profiler.end('CacheManager.readStoredFiles');
      log.warn('Cache', 'Could not read the stored cache from browser storage; downloading instead:', error);
      return null;
    }
    profiler.end('CacheManager.readStoredFiles');

    if (!hasRequiredCacheFiles(files)) {
      log.warn('Cache', `Stored cache ${cacheId} is incomplete; downloading instead`);
      return null;
    }
    return files;
  }

  getMapLoader(): MapLoader | null {
    return this.mapLoader;
  }

  /** The sound-effect index (one group per sound id), or `null` until the cache is loaded. */
  getSoundEffectIndex(): CacheIndex | null {
    const system = this.cacheSystem;
    return system?.indexExists(SOUND_EFFECT_INDEX) ? system.getIndex(SOUND_EFFECT_INDEX) : null;
  }

  getUnderlayLoader(): UnderlayTypeLoader | null {
    return this.underlayLoader;
  }

  getOverlayLoader(): OverlayTypeLoader | null {
    return this.overlayLoader;
  }

  getTextureLoader(): TextureLoader | null {
    return this.textureLoader;
  }

  getMinimapNpcDotUrl(): string | null {
    return this.minimapNpcDotUrl;
  }

  getLocTypeLoader(): LocTypeLoader | null {
    return this.locTypeLoader;
  }

  getNpcTypeLoader(): NpcTypeLoader | null {
    return this.npcTypeLoader;
  }

  getSpotAnimTypeLoader(): SpotAnimTypeLoader | null {
    return this.spotAnimTypeLoader;
  }

  getLocModelLoader(): LocModelLoader | null {
    return this.locModelLoader;
  }

  getNpcModelLoader(): NpcModelLoader | null {
    return this.npcModelLoader;
  }

  getPlayerModelLoader(): PlayerModelLoader | null {
    return this.playerModelLoader;
  }

  getSpotAnimModelLoader(): SpotAnimModelLoader | null {
    return this.spotAnimModelLoader;
  }

  getAnimationSystem(): AnimationSystem | null {
    return this.animationSystem;
  }

  async loadAdditionalMapSquare(mapX: number, mapY: number): Promise<AdditionalMapSquareData> {
    const key = `${mapX}_${mapY}`;
    const cached = this.additionalMapSquares.get(key);
    if (cached) return cached;

    const xteas = this.getXteaKey(mapX, mapY);
    const [terrain, locations, npcs] = await Promise.all([
      this.mapLoader ? this.mapLoader.loadMapSquare(mapX, mapY) : null,
      this.loadMapLocs(mapX, mapY),
      this.loadNpcSpawnsWithTypes(mapX, mapY, xteas),
    ]);

    const data: AdditionalMapSquareData = { mapX, mapY, terrain, locations, npcs };
    this.additionalMapSquares.set(key, data);
    return data;
  }

  getAdditionalMapSquareData(mapX: number, mapY: number): AdditionalMapSquareData | undefined {
    return this.additionalMapSquares.get(`${mapX}_${mapY}`);
  }

  getModelLoader(): ModelLoader | null {
    return this.modelLoader;
  }

  getObjTypeLoader(): ObjTypeLoader | null {
    return this.objTypeLoader;
  }

  getEnumTypeLoader(): EnumTypeLoader | null {
    return this.enumTypeLoader;
  }

  getStructTypeLoader(): StructTypeLoader | null {
    return this.structTypeLoader;
  }

  async loadLocationsWithTypes(mapX: number, mapY: number, xteas?: number[]): Promise<DecodedLocWithType[] | null> {
    if (!this.mapLoader || !this.locTypeLoader) {
      log.warn('Cache', 'MapLoader or LocTypeLoader not available');
      return null;
    }

    const locArchiveId = this.mapLoader.getLocArchiveId(mapX, mapY);
    log.trace('Cache', `Loc archive ID for ${mapX}_${mapY}: ${locArchiveId}`);

    const mapSquareLocations = await this.mapLoader.loadLocations(mapX, mapY, xteas);
    if (!mapSquareLocations) {
      log.warn(
        'Cache',
        `Failed to load locations for map ${mapX}_${mapY} (archive ${locArchiveId}). May need XTEA keys.`,
      );
      return null;
    }

    log.debug('Cache', `Loaded ${mapSquareLocations.locations.length} raw locations from l${mapX}_${mapY}`);

    const locsWithTypes: DecodedLocWithType[] = [];
    for (const location of mapSquareLocations.locations) {
      try {
        const locType = this.locTypeLoader.load(location.id);
        locsWithTypes.push({
          location,
          locType,
          modelType: location.type as LocModelType,
        });
      } catch (e) {
        log.warn('Cache', `Failed to load LocType ${location.id}:`, e);
      }
    }

    return locsWithTypes;
  }

  async loadNpcSpawnsWithTypes(mapX: number, mapY: number, xteas?: number[]): Promise<NpcWithType[] | null> {
    if (!this.mapLoader || !this.npcTypeLoader) {
      log.warn('Cache', 'MapLoader or NpcTypeLoader not available');
      return null;
    }

    const npcArchiveId = this.mapLoader.getNpcSpawnArchiveId(mapX, mapY);
    log.trace('Cache', `NPC spawn archive ID for ${mapX}_${mapY}: ${npcArchiveId}`);

    const mapSquareNpcSpawns = await this.mapLoader.loadNpcSpawns(mapX, mapY, xteas);
    if (!mapSquareNpcSpawns) {
      log.debug(
        'Cache',
        `Failed to load NPC spawns for map ${mapX}_${mapY} (archive ${npcArchiveId}). May need XTEA keys.`,
      );
      return null;
    }

    log.debug('Cache', `Loaded ${mapSquareNpcSpawns.spawns.length} raw NPC spawns from n${mapX}_${mapY}`);

    const npcsWithTypes: NpcWithType[] = [];
    for (const spawn of mapSquareNpcSpawns.spawns) {
      try {
        const npcType = this.npcTypeLoader.load(spawn.id);
        npcsWithTypes.push({
          spawn,
          npcType,
        });
      } catch (e) {
        log.warn('Cache', `Failed to load NpcType ${spawn.id}:`, e);
      }
    }

    return npcsWithTypes;
  }

  private getLocCollisionLoader(): LocCollisionLoader | undefined {
    if (!this.locTypeLoader) return undefined;
    return (locId: number) => {
      try {
        const locType = this.locTypeLoader!.load(locId);
        return {
          clipType: locType.clipType,
          sizeX: locType.sizeX,
          sizeY: locType.sizeY,
          blocksProjectile: locType.blocksProjectile,
        };
      } catch {
        return undefined;
      }
    };
  }

  /**
   * Build a cache-derived {@link ArenaConfig} for a map square and its declared neighbors: real loc
   * collision (walls, pillars, any clipping loc) baked from the cache via each
   * loc's `clipType`, plus any encounter-declared `extraLocs` (dynamic /
   * packet-spawned locs absent from the static map data), with the walkable
   * region flood-filled from `seed`. Pure — does not mutate global arena state.
   */
  async buildArenaConfig(request: {
    mapX: number;
    mapY: number;
    seedX: number;
    seedY: number;
    mapSquareOffsets?: MapSquareOffsets;
    extraLocs?: readonly CollisionLocInput[];
    excludedStaticLocIds?: ExcludedStaticLocIds;
  }): Promise<ArenaConfig> {
    const { mapX, mapY, seedX, seedY, extraLocs, excludedStaticLocIds, mapSquareOffsets } = request;
    profiler.start('CacheManager.buildArenaConfig');
    const emptyConfig: ArenaConfig = { bounds: null, walkableTiles: null, collisionMap: null };
    if (!this.mapLoader) {
      log.warn('Cache', 'MapLoader not available for arena config build');
      profiler.end('CacheManager.buildArenaConfig');
      return emptyConfig;
    }

    try {
      const mapData = await this.mapLoader.loadMapSquare(mapX, mapY);
      if (!mapData) {
        log.warn('Cache', `Failed to load map square ${mapX}_${mapY} for arena config build`);
        profiler.end('CacheManager.buildArenaConfig');
        return emptyConfig;
      }

      const locCollisionLoader = this.getLocCollisionLoader();
      let collisionMap: CollisionMap;
      let walkableTiles: Set<string>;

      const mapSquareBlock = getMapSquareBlock(mapSquareOffsets);
      if (mapSquareBlock.length === 1 && mapSquareBlock[0]?.dx === 0 && mapSquareBlock[0].dy === 0) {
        const xteas = this.getXteaKey(mapX, mapY);
        const locations = await this.mapLoader.loadLocations(mapX, mapY, xteas);
        const analysis = analyzeWalkability(
          mapData,
          locations ?? undefined,
          locCollisionLoader,
          0,
          extraLocs,
          excludedStaticLocIds,
        );
        collisionMap = analysis.collisionMap;
        walkableTiles = analysis.walkableTiles;
      } else {
        const radius = Math.max(...mapSquareBlock.flatMap(({ dx, dy }) => [Math.abs(dx), Math.abs(dy)]));
        const blockMap = createBlockCollisionMap(radius);
        const loaded = await Promise.all(
          mapSquareBlock.map(async ({ dx, dy, tileOffsetX, tileOffsetY }): Promise<MapSquareCollisionSource | null> => {
            const squareX = mapX + dx;
            const squareY = mapY + dy;
            const squareData = dx === 0 && dy === 0 ? mapData : await this.mapLoader?.loadMapSquare(squareX, squareY);
            if (!squareData) return null;
            const locations = await this.mapLoader?.loadLocations(squareX, squareY, this.getXteaKey(squareX, squareY));
            return {
              mapData: squareData,
              locations: locations ?? undefined,
              // In origin-local tiles, which are the block's, so a placement lands in whichever square holds it.
              extraLocs: dx === 0 && dy === 0 ? extraLocs : undefined,
              tileOffsetX,
              tileOffsetY,
            };
          }),
        );
        const squares = loaded.filter((square) => square !== null);
        // Every square's collision goes into the block before any walkable tile is read, so a loc on
        // a seam blocks on both sides of it: a large object's far tiles, a wall's reciprocal flag.
        for (const square of squares) {
          applyMapSquareCollision(blockMap, square, locCollisionLoader, 0, excludedStaticLocIds);
        }
        walkableTiles = new Set<string>();
        for (const square of squares) collectWalkableTiles(blockMap, square, 0, walkableTiles);
        collisionMap = blockMap;
      }

      const arenaRegion = findContiguousRegion(walkableTiles, seedX, seedY, collisionMap);
      if (arenaRegion.size === 0) {
        log.warn('Cache', `No walkable region found around seed (${seedX}, ${seedY}) in ${mapX}_${mapY}`);
        profiler.end('CacheManager.buildArenaConfig');
        return emptyConfig;
      }

      const bounds = getBoundsFromRegion(arenaRegion);
      profiler.end('CacheManager.buildArenaConfig');
      return { bounds, walkableTiles: arenaRegion, collisionMap };
    } catch (e) {
      profiler.end('CacheManager.buildArenaConfig');
      log.warn('Cache', 'Failed to build arena config:', e);
      return emptyConfig;
    }
  }

  /**
   * Builds the Yama arena config (map square 23_157) during cache initialization and installs it
   * as the default arena config. `YamaEncounter.getArenaConfig` seals that config at the entrance
   * and serves it until the per-encounter config from {@link buildArenaConfig} reaches the
   * resolved-config store.
   */
  async analyzeArenaBounds(
    mapX: number = 23,
    mapY: number = 157,
    seedX: number = 32,
    seedY: number = 30,
  ): Promise<ArenaConfig> {
    const arenaConfig = await this.buildArenaConfig({ mapX, mapY, seedX, seedY });
    if (arenaConfig.bounds) {
      setDefaultArenaConfig(arenaConfig);
      log.info(
        'Cache',
        `Arena bounds extracted: ${arenaConfig.bounds.width}x${arenaConfig.bounds.height} ` +
          `(${arenaConfig.bounds.minX},${arenaConfig.bounds.minY}) to (${arenaConfig.bounds.maxX},${arenaConfig.bounds.maxY}), ` +
          `${arenaConfig.walkableTiles?.size ?? 0} walkable tiles`,
      );
    }
    return arenaConfig;
  }

  async retry(): Promise<void> {
    if (this.state !== 'ERROR') {
      throw new Error('Cannot retry: not in ERROR state');
    }

    this.error = undefined;
    this.setState('UNLOADED');

    return this.ensureCache();
  }

  async getBlob(path: string): Promise<ArrayBuffer | null> {
    if (this.state !== 'LOADED') {
      throw new Error('Cache not loaded');
    }
    return this.storage.getCacheFile(path, this.cacheInfo?.id || 0);
  }

  async getParsed(kind: string, id: number): Promise<any> {
    if (this.state !== 'LOADED') {
      throw new Error('Cache not loaded');
    }
    const cacheId = this.cacheInfo?.id || 0;
    return this.storage.getParsed(cacheId, kind, id);
  }

  async setParsed(kind: string, id: number, data: any): Promise<void> {
    if (this.state !== 'LOADED') {
      throw new Error('Cache not loaded');
    }
    const cacheId = this.cacheInfo?.id || 0;
    return this.storage.storeParsed(cacheId, kind, id, data);
  }

  async getCacheMeta(cacheId: number): Promise<CacheMeta | null> {
    return this.storage.getCacheMeta(cacheId);
  }

  async deleteCache(cacheId: number): Promise<void> {
    await this.storage.deleteCache(cacheId);
    if (this.state === 'LOADED') {
      this.setState('UNLOADED');
    }
  }

  private setLoadingProgress(stage: LoadingStage, percent: number, detail: string): void {
    this.loadingState = { status: 'loading', stage, percent, detail };
    this.notifyListeners();
  }

  private setState(state: CacheState, error?: string): void {
    this.state = state;
    this.error = error;
    if (state !== 'DOWNLOADING') {
      this.downloadProgress = undefined;
    }
    if (state === 'LOADED' || state === 'ERROR') {
      this.loadingState = { status: 'idle' };
    }

    this.notifyListeners();
  }

  private notifyListeners(): void {
    const state = this.getState();
    this.listeners.forEach((listener) => {
      listener(state);
    });
  }

  /** @param timeout - Timeout in milliseconds (default: 5 minutes) */
  private async waitForState(targetState: CacheState, timeout = 300000): Promise<void> {
    if (this.state === targetState) {
      return;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timeout waiting for state ${targetState}`));
      }, timeout);

      const unsubscribe = this.subscribe((state) => {
        if (state.state === targetState) {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        } else if (state.state === 'ERROR') {
          clearTimeout(timer);
          unsubscribe();
          reject(new Error(state.error || 'Unknown error'));
        }
      });
    });
  }
}
