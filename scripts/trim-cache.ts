/**
 * Build-time cache trimmer.
 *
 * Runs after `scripts/fetch-cache.ts` during `npm run build`. Reads the full
 * OSRS cache from `public/osrs-cache/disk.zip` (~160 MB), follows every root in
 * `collectCacheRoots` (the runtime data registries plus src/ literals) through the
 * production loaders while instrumenting their reads, then rewrites `disk.zip` in
 * place containing only the archives those reads touched.
 *
 * Every kept bzip2 container is re-encoded as gzip (gzipCacheContainers.ts), so production
 * decodes the mirror with pako alone and never loads the bzip2 WebAssembly decoder;
 * `manifest.containerCompressions` records that for the client. Index files the app does not
 * load are left out.
 *
 * The output is still a valid RuneTek-5 cache (dat2 + idxN + idx255). The
 * browser-side cache code is unchanged - it downloads the same file from the
 * same URL and uses the same `MemoryStore`. Untraced archive ids appear as
 * sparse holes (length=0, sector=0) in the trimmed idxN files; `MemoryStore`
 * returns an empty `Int8Array` for those, which is fine only as long as the
 * roots name everything the runtime can request. `cacheRoots.test.ts` holds the
 * roots to the id-bearing data in src/.
 *
 * Failure model:
 *   - The trim step ALWAYS runs in `npm run build`. It is idempotent: when
 *     `manifest.trimmed === true` it short-circuits.
 *   - When `OSRS_CACHE_FORCE_TRIM=1` (or `--force` flag) is set, it re-trims
 *     even if the manifest claims trimmed.
 *   - After trimming, the script self-validates by replaying the same
 *     scenarios against the trimmed cache. Any read that throws fails the
 *     build, because that means the trimmed cache is missing data the live
 *     app would request.
 *   - `check-trimmed-cache.ts` then checks the built artifact itself, on every
 *     build, including one that skipped this step because the cache was already
 *     trimmed (for example a stale local mirror).
 *
 * Idempotency invariant:
 *   - `fetch-cache.ts` overwrites `manifest.json` (and `disk.zip`) whenever
 *     the upstream cache id changes, which clears the `trimmed` flag and
 *     causes us to re-trim against the new cache.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import JSZip from 'jszip';
import type { CacheInfo } from '../src/rs/cache/CacheInfo';
import { CacheSystem } from '../src/rs/cache/CacheSystem';
import { MemoryStore } from '../src/rs/cache/store/MemoryStore';
import { TracingStore } from '../src/rs/cache/store/TracingStore';
import { Bzip2 } from '../src/rs/compression/Bzip2';
import type { CompressionType } from '../src/rs/compression/CompressionType';
import { ArchiveEnumTypeLoader } from '../src/rs/config/enumtype/EnumTypeLoader';
import { ArchiveOverlayTypeLoader, ArchiveUnderlayTypeLoader } from '../src/rs/config/flotype/FloTypeLoader';
import { ArchiveIdentKitLoader } from '../src/rs/config/identkit/IdentKitLoader';
import { LocModelLoader } from '../src/rs/config/loctype/LocModelLoader';
import { LocModelType } from '../src/rs/config/loctype/LocModelType';
import type { LocType } from '../src/rs/config/loctype/LocType';
import { ArchiveLocTypeLoader } from '../src/rs/config/loctype/LocTypeLoader';
import { ArchiveNpcTypeLoader } from '../src/rs/config/npctype/NpcTypeLoader';
import { ArchiveObjTypeLoader } from '../src/rs/config/objtype/ObjTypeLoader';
import { ArchiveSeqTypeLoader } from '../src/rs/config/seqtype/SeqTypeLoader';
import { ArchiveSpotAnimTypeLoader } from '../src/rs/config/spotanimtype/SpotAnimTypeLoader';
import { ArchiveStructTypeLoader } from '../src/rs/config/structtype/StructTypeLoader';
import { MapLoader } from '../src/rs/map/MapLoader';
import { IndexModelLoader } from '../src/rs/model/ModelLoader';
import { NpcModelLoader } from '../src/rs/model/NpcModelLoader';
import { DEFAULT_MALE_APPEARANCE, type PlayerEquipment, PlayerModelLoader } from '../src/rs/model/PlayerModelLoader';
import { SpotAnimModelLoader } from '../src/rs/model/SpotAnimModelLoader';
import { IndexSeqBaseLoader } from '../src/rs/model/seq/SeqBaseLoader';
import { Dat2SeqFrameLoader } from '../src/rs/model/seq/SeqFrameLoader';
import { IndexSkeletalSeqLoader } from '../src/rs/model/skeletal/SkeletalSeqLoader';
import { SpriteLoader } from '../src/rs/sprite/SpriteLoader';
import { SpriteTextureLoader } from '../src/rs/texture/SpriteTextureLoader';
import { APP_CONFIG_ARCHIVES, collectCacheRoots, MIRROR_INDICES, SOUND_EFFECT_INDEX } from './cacheRoots';
import { computeTraceSpecHash, discoverCacheUsage, parseMapSquare } from './discoverCacheUsage';
import { COMPRESSION_NAMES, gzipBzip2Container } from './gzipCacheContainers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(REPO_ROOT, 'public', 'osrs-cache');
const DISK_ZIP_PATH = path.join(CACHE_DIR, 'disk.zip');
const MANIFEST_PATH = path.join(CACHE_DIR, 'manifest.json');
const KEYS_PATH = path.join(CACHE_DIR, 'keys.json');

const FRAMES_INDEX = 0;
const BASES_INDEX = 1;
const CONFIG_INDEX = 2;
const MAP_INDEX = 5;
const MODEL_INDEX = 7;
const SPRITES_INDEX = 8;
const TEXTURES_INDEX = 9;
const ANIM_KEY_FRAMES_INDEX = 22;

const INDICES_TO_LOAD = [...MIRROR_INDICES];

// Archive ids inside CONFIG_INDEX that the trace constructs loaders from.
const UNDERLAY_ARCHIVE = 1;
const IDK_ARCHIVE = 3;
const OVERLAY_ARCHIVE = 4;
const LOC_ARCHIVE = 6;
const ENUM_ARCHIVE = 8;
const NPC_ARCHIVE = 9;
const OBJ_ARCHIVE = 10;
const SEQ_ARCHIVE = 12;
const SPOTANIM_ARCHIVE = 13;
const STRUCT_ARCHIVE = 34;

const DEFAULT_REVISION = 232;

// Sector layout (RuneTek-5 dat2). Mirrors `Sector.ts` constants but lives
// here too because the rewrite logic does raw byte work.
const SECTOR_SIZE = 520;
const HEADER_SIZE = 8;
const EXT_HEADER_SIZE = 10;
const DATA_SIZE = 512;
const EXT_DATA_SIZE = 510;
const IDX_ENTRY_SIZE = 6;

interface Manifest {
  id?: number;
  size?: number;
  fetchedAt?: string;
  diskZipSha256?: string;
  diskZipBytes?: number;
  source?: string;
  builds?: Array<{ major: number; minor: number | null }>;
  trimmed?: boolean;
  trimmedAt?: string;
  trimmedFromSha256?: string;
  trimmedFromBytes?: number;
  trimTraceCount?: number;
  /** Fingerprint of the trace inputs (see computeTraceSpecHash); fetch-cache re-fetches when it changes. */
  traceSpecHash?: string;
  /** Every container compression in the trimmed disk.zip; the client loads bzip2 only if listed. */
  containerCompressions?: string[];
  [key: string]: unknown;
}

function parseFlags(argv: string[]): { force: boolean } {
  return {
    force:
      argv.includes('--force') || process.env.OSRS_CACHE_FORCE_TRIM === '1' || process.env.OSRS_CACHE_FORCE === '1',
  };
}

async function main(): Promise<void> {
  const { force } = parseFlags(process.argv.slice(2));

  if (!existsSync(DISK_ZIP_PATH) || !existsSync(MANIFEST_PATH)) {
    throw new Error(
      `[trim-cache] Expected ${DISK_ZIP_PATH} and ${MANIFEST_PATH} to exist. Run 'tsx scripts/fetch-cache.ts' first.`,
    );
  }

  const manifest = readManifest();
  const traceSpecHash = await computeTraceSpecHash(REPO_ROOT);
  if (manifest.trimmed && !force) {
    if (manifest.traceSpecHash === traceSpecHash) {
      console.log(
        `[trim-cache] Already trimmed and up to date (cache ${manifest.id ?? '?'}, ${formatBytes(
          statSync(DISK_ZIP_PATH).size,
        )}). Skipping.`,
      );
      return;
    }
    // Trimmed, but the trace spec no longer matches the source — and disk.zip is already
    // trimmed, so we cannot re-trim it in place. A normal online build re-fetches the full
    // cache in fetch-cache on this mismatch before reaching here; hitting this means the full
    // cache is unavailable (e.g. --offline, or a hand-run trim on an already-trimmed mirror).
    throw new Error(
      `[trim-cache] Trimmed cache is stale: its trace spec (${manifest.traceSpecHash ?? 'none'}) no ` +
        `longer matches the source (${traceSpecHash}), but disk.zip is already trimmed so it cannot ` +
        `be re-trimmed in place. Re-fetch the full cache first — delete public/osrs-cache/ (or run ` +
        `'OSRS_CACHE_FORCE=1 tsx scripts/fetch-cache.ts') — then re-run the trim.`,
    );
  }

  const upstreamSha = manifest.diskZipSha256;
  const upstreamBytes = manifest.diskZipBytes;
  const fullZipSize = statSync(DISK_ZIP_PATH).size;
  console.log(`[trim-cache] Trimming ${DISK_ZIP_PATH} (cache ${manifest.id ?? '?'}, ${formatBytes(fullZipSize)})`);

  const fullZipBytes = readFileSync(DISK_ZIP_PATH);
  const files = await extractCacheFiles(fullZipBytes);
  console.log(`[trim-cache] Loaded ${files.size} cache file(s) from zip.`);

  const revision = pickRevision(manifest);
  const xteas = readXteaKeys();

  await Bzip2.initWasm();

  const { trace, requiredNonEmpty } = await runTrace(files, revision, xteas);
  console.log(
    `[trim-cache] Trace recorded ${trace.length} unique (indexId, archiveId) reads ` +
      `(${requiredNonEmpty.size} non-empty in upstream, must survive trim).`,
  );

  const { newDat2, newIdxFiles, perIndexCounts, compressions } = buildTrimmedFiles(files, trace);

  const trimmedFiles = composeTrimmedFiles(newDat2, newIdxFiles);
  await validateAgainstTrimmed(trimmedFiles, revision, xteas, requiredNonEmpty);
  console.log('[trim-cache] Self-validation pass: trimmed cache satisfies all traced reads.');

  const trimmedZipBytes = await rezipCacheFiles(trimmedFiles);

  writeFileSync(DISK_ZIP_PATH, trimmedZipBytes);

  const trimmedSha = createHash('sha256').update(trimmedZipBytes).digest('hex');
  const updatedManifest: Manifest = {
    ...manifest,
    diskZipSha256: trimmedSha,
    diskZipBytes: trimmedZipBytes.length,
    size: trimmedZipBytes.length,
    trimmed: true,
    trimmedAt: new Date().toISOString(),
    trimmedFromSha256: upstreamSha,
    trimmedFromBytes: upstreamBytes,
    trimTraceCount: trace.length,
    traceSpecHash,
    containerCompressions: [...compressions].sort((a, b) => a - b).map((type) => COMPRESSION_NAMES[type]),
  };
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(updatedManifest, null, 2)}\n`);

  printSizeReport(fullZipSize, trimmedZipBytes.length, perIndexCounts, files);
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as Manifest;
}

function pickRevision(manifest: Manifest): number {
  const major = manifest.builds?.[0]?.major;
  return typeof major === 'number' && Number.isFinite(major) && major > 0 ? major : DEFAULT_REVISION;
}

interface XteaEntry {
  mapsquare?: number;
  key?: number[];
}

function readXteaKeys(): Map<number, number[]> {
  const out = new Map<number, number[]>();
  if (!existsSync(KEYS_PATH)) return out;
  const raw = JSON.parse(readFileSync(KEYS_PATH, 'utf-8')) as unknown;
  if (!Array.isArray(raw)) return out;
  for (const entry of raw as XteaEntry[]) {
    if (
      entry &&
      typeof entry.mapsquare === 'number' &&
      Array.isArray(entry.key) &&
      entry.key.length === 4 &&
      entry.key.every((n) => typeof n === 'number')
    ) {
      out.set(entry.mapsquare, entry.key as number[]);
    }
  }
  return out;
}

async function extractCacheFiles(zipBytes: Buffer): Promise<Map<string, ArrayBuffer>> {
  const zip = await JSZip.loadAsync(zipBytes);
  const out = new Map<string, ArrayBuffer>();
  for (const [relativePath, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const fileName = path.basename(relativePath);
    if (!fileName.startsWith('main_file_cache.')) continue;
    out.set(fileName, await entry.async('arraybuffer'));
  }
  if (!out.has('main_file_cache.dat2')) {
    throw new Error('[trim-cache] disk.zip missing main_file_cache.dat2');
  }
  return out;
}

interface TraceEntry {
  indexId: number;
  archiveId: number;
}

interface TraceResult {
  trace: TraceEntry[];
  /**
   * Subset of `trace` whose archive returned non-empty data when read from the
   * full upstream cache. These are the archives the trimmed cache MUST also
   * serve - any of them coming back as a sparse hole during self-validation is
   * a hard failure.
   */
  requiredNonEmpty: Set<string>;
}

async function runTrace(
  files: Map<string, ArrayBuffer>,
  revision: number,
  xteas: Map<number, number[]>,
): Promise<TraceResult> {
  const baseStore = MemoryStore.fromFiles(files, INDICES_TO_LOAD);
  const tracingStore = new TracingStore(baseStore);
  await traceScenarios(tracingStore, revision, xteas);
  const trace = tracingStore.getTrace();
  const missing = new Set(tracingStore.getMissingArchives().map((m) => `${m.indexId}:${m.archiveId}`));
  const requiredNonEmpty = new Set<string>();
  for (const { indexId, archiveId } of trace) {
    const key = `${indexId}:${archiveId}`;
    if (!missing.has(key)) requiredNonEmpty.add(key);
  }
  return { trace, requiredNonEmpty };
}

async function traceScenarios(store: MemoryStore, revision: number, xteas: Map<number, number[]>): Promise<void> {
  const usage = await discoverCacheUsage(REPO_ROOT);
  console.log(
    `[trim-cache] Discovered from src/: ${usage.counts.npcIds} npcIds, ` +
      `${usage.counts.spotAnimIds} spotAnimIds, ${usage.counts.spriteIds} spriteIds, ` +
      `${usage.counts.seqIds} seqIds, ${usage.counts.itemIds} itemIds, ` +
      `${usage.counts.mapSquares} mapSquares (scanned ${usage.filesScanned} files)`,
  );
  const roots = collectCacheRoots(usage);
  console.log(
    `[trim-cache] Roots (registries + src literals): ${roots.npcs.size} npcs, ${roots.spotAnims.size} spotanims, ` +
      `${roots.seqs.size} seqs, ${roots.wornItems.size} worn items, ${roots.droppedItems.size} droppable items, ` +
      `${roots.locs.size} locs, ${roots.sprites.size} sprites, ${roots.soundEffects.size} sound effects, ` +
      `${roots.mapSquares.size} map squares`,
  );

  const cacheSystem = new CacheSystem(CacheSystem.loadIndicesFromStore('dat2', store));

  const cacheInfo: CacheInfo = {
    name: 'osrs',
    game: 'oldschool',
    environment: 'live',
    revision,
    timestamp: new Date().toISOString(),
    size: 0,
  };

  const configIndex = cacheSystem.getIndex(CONFIG_INDEX);
  const archives = new Map<number, ReturnType<typeof configIndex.getArchive>>();
  for (const archiveId of APP_CONFIG_ARCHIVES) {
    archives.set(archiveId, configIndex.getArchive(archiveId));
  }

  const modelIndex = cacheSystem.getIndex(MODEL_INDEX);
  const framesIndex = cacheSystem.getIndex(FRAMES_INDEX);
  const basesIndex = cacheSystem.getIndex(BASES_INDEX);
  const animKeyFramesIndex = cacheSystem.getIndex(ANIM_KEY_FRAMES_INDEX);
  const spritesIndex = cacheSystem.getIndex(SPRITES_INDEX);
  const texturesIndex = cacheSystem.getIndex(TEXTURES_INDEX);
  const mapIndex = cacheSystem.getIndex(MAP_INDEX);

  const underlayLoader = new ArchiveUnderlayTypeLoader(cacheInfo, archives.get(UNDERLAY_ARCHIVE)!);
  const overlayLoader = new ArchiveOverlayTypeLoader(cacheInfo, archives.get(OVERLAY_ARCHIVE)!);
  const locTypeLoader = new ArchiveLocTypeLoader(cacheInfo, archives.get(LOC_ARCHIVE)!);
  const npcTypeLoader = new ArchiveNpcTypeLoader(cacheInfo, archives.get(NPC_ARCHIVE)!);
  const objTypeLoader = new ArchiveObjTypeLoader(cacheInfo, archives.get(OBJ_ARCHIVE)!);
  const seqTypeLoader = new ArchiveSeqTypeLoader(cacheInfo, archives.get(SEQ_ARCHIVE)!);
  const spotAnimTypeLoader = new ArchiveSpotAnimTypeLoader(cacheInfo, archives.get(SPOTANIM_ARCHIVE)!);
  const identKitLoader = new ArchiveIdentKitLoader(cacheInfo, archives.get(IDK_ARCHIVE)!);
  // These two are constructed for parity with `CacheManager` even though they
  // currently do no extra reads — keeping them ensures any future cache work
  // they touch gets traced for free.
  void new ArchiveEnumTypeLoader(cacheInfo, archives.get(ENUM_ARCHIVE)!);
  void new ArchiveStructTypeLoader(cacheInfo, archives.get(STRUCT_ARCHIVE)!);

  const modelLoader = new IndexModelLoader(modelIndex);
  const seqBaseLoader = new IndexSeqBaseLoader(cacheInfo, basesIndex);
  const seqFrameLoader = new Dat2SeqFrameLoader(cacheInfo, framesIndex, seqBaseLoader);
  const skeletalSeqLoader = new IndexSkeletalSeqLoader(animKeyFramesIndex, seqBaseLoader);

  const npcModelLoader = new NpcModelLoader(npcTypeLoader, modelLoader);
  const spotAnimModelLoader = new SpotAnimModelLoader(spotAnimTypeLoader, modelLoader, seqTypeLoader, seqFrameLoader);
  const playerModelLoader = new PlayerModelLoader(objTypeLoader, identKitLoader, modelLoader);
  const locModelLoader = new LocModelLoader(
    cacheInfo,
    archives.get(LOC_ARCHIVE)!,
    modelIndex,
    archives.get(SEQ_ARCHIVE)!,
    framesIndex,
    basesIndex,
  );

  const warmupSeq = (seqId: number): void => {
    if (seqId < 0) return;
    safe(() => {
      const seqType = seqTypeLoader.load(seqId);
      if (seqType.isSkeletalSeq()) {
        safe(() => skeletalSeqLoader.load(seqType.skeletalId));
      } else if (seqType.frameIds) {
        for (const frameId of seqType.frameIds) {
          if (frameId >= 0) safe(() => seqFrameLoader.load(frameId));
        }
      }
    });
  };

  console.log('[trim-cache] Tracing textures + minimap sprites...');
  const textureLoader = SpriteTextureLoader.load(texturesIndex, spritesIndex);
  for (const textureId of textureLoader.getTextureIds()) {
    safe(() => textureLoader.loadTextureSprite(textureId));
  }
  for (const spriteId of roots.sprites.keys()) {
    safe(() => SpriteLoader.loadIntoIndexedSprite(spritesIndex, spriteId));
  }

  console.log(`[trim-cache] Tracing ${roots.soundEffects.size} sound effect(s)...`);
  const soundEffectIndex = cacheSystem.getIndex(SOUND_EFFECT_INDEX);
  for (const soundId of roots.soundEffects.keys()) {
    safe(() => soundEffectIndex.getFile(soundId, 0));
  }

  console.log('[trim-cache] Tracing default identkits...');
  for (const kitId of roots.identKits.keys()) {
    safe(() => identKitLoader.load(kitId));
  }

  console.log('[trim-cache] Tracing maps + locs + NPC spawns...');
  const mapLoader = new MapLoader(mapIndex, revision);
  // roots.mapSquares already carries the +/-1 terrain-context ring the renderer reads around
  // every square it draws (see collectCacheRoots).
  const mapSquareTuples = [...roots.mapSquares.keys()].map(parseMapSquare);
  for (const [mapX, mapY] of mapSquareTuples) {
    const mapsquare = (mapX << 8) | mapY;
    const xtea = xteas.get(mapsquare);
    await safeAsync(() => mapLoader.loadMapSquare(mapX, mapY, xtea));
    const locs = await safeAsync(() => mapLoader.loadLocations(mapX, mapY, xtea));
    if (locs?.locations) {
      const locIds = new Set(locs.locations.map((l) => l.id));
      for (const locId of locIds) {
        await safeAsync(async () => {
          await locModelLoader.loadLocMesh(locId, LocModelType.NORMAL, 0, 0, 0, 0);
        });
        safe(() => {
          const locType = locTypeLoader.load(locId);
          if (locType.models) {
            for (const group of locType.models) {
              for (const modelId of group) {
                safe(() => modelLoader.getModel(modelId));
              }
            }
          }
          if (locType.seqId !== undefined && locType.seqId >= 0) {
            warmupSeq(locType.seqId);
          }
          if (locType.randomSeqIds) {
            for (const sid of locType.randomSeqIds) warmupSeq(sid);
          }
        });
      }
    }
    const npcSpawns = await safeAsync(() => mapLoader.loadNpcSpawns(mapX, mapY, xtea));
    if (npcSpawns?.spawns) {
      for (const spawn of npcSpawns.spawns) {
        traceNpc(spawn.id, npcTypeLoader, npcModelLoader, modelLoader, warmupSeq);
      }
    }
  }

  // Locs spawned at runtime rather than read from a map square (scene objects via
  // SceneObjectController, lobby portals). Mirrors the SceneObjectRenderer paths: animated locs
  // (locType.seqId >= 0) bake via loadAnimatedLocMeshFrames, static ones via loadLocMesh. A
  // transform loc (LocType.transforms) draws one of its targets, chosen by its varbit at runtime,
  // so every target is traced the same way; SceneObjectRenderer resolves one level, so do we.
  const traceRuntimeLoc = (locId: number): LocType | undefined => {
    let locType: LocType;
    try {
      locType = locTypeLoader.load(locId);
    } catch {
      return undefined;
    }
    const { seqId, models, randomSeqIds } = locType;
    safe(() => {
      safe(() => locModelLoader.loadLocMesh(locId, LocModelType.NORMAL, 0, 0, 0, 0));
      if (seqId !== undefined && seqId >= 0) {
        safe(() => locModelLoader.loadAnimatedLocMeshFrames(locId, LocModelType.NORMAL, 0, seqId));
        warmupSeq(seqId);
      }
      for (const group of models ?? []) {
        for (const modelId of group) {
          safe(() => modelLoader.getModel(modelId));
        }
      }
      for (const sid of randomSeqIds ?? []) warmupSeq(sid);
    });
    return locType;
  };
  console.log(`[trim-cache] Tracing ${roots.locs.size} runtime-spawned loc id(s)...`);
  for (const locId of roots.locs.keys()) {
    const locType = traceRuntimeLoc(locId);
    for (const targetId of new Set(locType?.transforms ?? [])) {
      if (targetId >= 0) traceRuntimeLoc(targetId);
    }
  }
  // Underlay/overlay are referenced through the terrain decoder. Touching every
  // overlay/underlay id seen in the loaded map squares pulls in the FloType
  // archive entries the renderer ultimately reads.
  void underlayLoader;
  void overlayLoader;

  console.log('[trim-cache] Tracing NPC types...');
  for (const npcId of roots.npcs.keys()) {
    traceNpc(npcId, npcTypeLoader, npcModelLoader, modelLoader, warmupSeq);
  }

  console.log('[trim-cache] Tracing spotanims...');
  for (const spotAnimId of roots.spotAnims.keys()) {
    traceSpotAnim(spotAnimId, spotAnimModelLoader, modelLoader, warmupSeq);
  }
  for (const modelId of roots.models.keys()) safe(() => modelLoader.getModel(modelId));

  console.log('[trim-cache] Tracing sequences...');
  for (const seqId of roots.seqs.keys()) {
    warmupSeq(seqId);
  }

  console.log(`[trim-cache] Tracing ${roots.wornItems.size} wearable item(s)...`);
  for (const itemId of roots.wornItems.keys()) {
    // PlayerModelLoader pulls model ids straight from ObjType and places them by wear position,
    // so the weapon slot traces every item's reads whatever slot it really occupies.
    for (const gender of [0, 1] as const) {
      safe(() => {
        const equipment: PlayerEquipment = { weapon: itemId };
        playerModelLoader.loadPlayerModel({ ...DEFAULT_MALE_APPEARANCE, gender }, equipment);
      });
    }
    safe(() => {
      const obj = objTypeLoader.load(itemId);
      // ObjType params can carry seq ids (wear/attack anim). We don't have a
      // sealed schema for what fields the simulator reads, so warm anything
      // that looks like a seq id - cheap insurance.
      if (obj.params) {
        for (const v of obj.params.values()) {
          if (typeof v === 'number' && v >= 0) warmupSeq(v);
        }
      }
    });
  }

  // `inventoryModel` is read only by GroundItemRenderer: item icons are mirrored PNGs under
  // public/assets/items/, and worn models come from ObjType's separate male/female fields.
  console.log(`[trim-cache] Tracing ground-item models for ${roots.droppedItems.size} droppable item(s)...`);
  for (const itemId of roots.droppedItems.keys()) {
    safe(() => {
      const obj = objTypeLoader.load(itemId);
      if (obj.inventoryModel >= 0) {
        safe(() => modelLoader.getModel(obj.inventoryModel));
      }
    });
  }
}

function traceNpc(
  npcId: number,
  npcTypeLoader: ArchiveNpcTypeLoader,
  npcModelLoader: NpcModelLoader,
  modelLoader: IndexModelLoader,
  warmupSeq: (seqId: number) => void,
): void {
  safe(() => {
    const npcType = npcTypeLoader.load(npcId);
    if (npcType.modelIds) {
      for (const id of npcType.modelIds) {
        safe(() => modelLoader.getModel(id));
      }
    }
    for (const seqId of [
      npcType.idleSeqId,
      npcType.walkSeqId,
      npcType.walkBackSeqId,
      npcType.walkLeftSeqId,
      npcType.walkRightSeqId,
      npcType.turnLeftSeqId,
      npcType.turnRightSeqId,
      npcType.runSeqId,
      npcType.runBackSeqId,
      npcType.runLeftSeqId,
      npcType.runRightSeqId,
      npcType.crawlSeqId,
      npcType.crawlBackSeqId,
      npcType.crawlLeftSeqId,
      npcType.crawlRightSeqId,
    ]) {
      warmupSeq(seqId);
    }
  });
  safe(() => npcModelLoader.loadNpcType(npcId));
}

function traceSpotAnim(
  spotAnimId: number,
  spotAnimModelLoader: SpotAnimModelLoader,
  modelLoader: IndexModelLoader,
  warmupSeq: (seqId: number) => void,
): void {
  safe(() => {
    const spotAnimType = spotAnimModelLoader.loadSpotAnimType(spotAnimId);
    if (!spotAnimType) return;
    if (spotAnimType.modelId !== undefined && spotAnimType.modelId >= 0) {
      safe(() => modelLoader.getModel(spotAnimType.modelId));
    }
    if (typeof spotAnimType.sequenceId === 'number') warmupSeq(spotAnimType.sequenceId);
  });
  safe(() => spotAnimModelLoader.loadSpotAnimModelData(spotAnimId));
  safe(() => spotAnimModelLoader.loadAnimatedSpotAnim(spotAnimId));
}

interface TrimResult {
  newDat2: Buffer;
  newIdxFiles: Map<number, Buffer>;
  perIndexCounts: Map<number, { traced: number; written: number; total: number }>;
  /** Compression byte of every container written; bzip2 never appears (see gzipBzip2Container). */
  compressions: Set<CompressionType>;
}

function buildTrimmedFiles(files: Map<string, ArrayBuffer>, trace: TraceEntry[]): TrimResult {
  const origDat2 = files.get('main_file_cache.dat2');
  if (!origDat2) {
    throw new Error('[trim-cache] disk.zip missing main_file_cache.dat2');
  }
  const origDat2Bytes = new Uint8Array(origDat2);
  const tracesByIndex = groupTraceByIndex(trace);
  const indexIdsToProcess = Array.from(tracesByIndex.keys()).sort((a, b) => {
    if (a === 255) return -1;
    if (b === 255) return 1;
    return a - b;
  });

  // Sector 0 is reserved; leave a 520-byte zero block at the start so that
  // unwritten idx entries (size=0, sector=0) cannot accidentally be valid.
  const chunks: Buffer[] = [Buffer.alloc(SECTOR_SIZE)];
  let nextSectorPos = 1;

  const newIdxFiles = new Map<number, Buffer>();
  const perIndexCounts = new Map<number, { traced: number; written: number; total: number }>();
  const compressions = new Set<CompressionType>();

  for (const indexId of indexIdsToProcess) {
    const archiveIds = tracesByIndex.get(indexId) ?? [];
    if (archiveIds.length === 0) continue;

    const idxFileName = idxFileFor(indexId);
    const origIdx = files.get(idxFileName);
    if (!origIdx) {
      console.warn(`[trim-cache] Missing ${idxFileName}; skipping index ${indexId}`);
      continue;
    }
    const origIdxBytes = new Uint8Array(origIdx);
    const totalArchives = Math.floor(origIdxBytes.byteLength / IDX_ENTRY_SIZE);
    // Match original idx size so untraced reads hit sparse holes (size=0,sector=0)
    // instead of throwing `Invalid ptr` from MemoryStore. Compresses to ~nothing.
    const newIdx = Buffer.alloc(origIdxBytes.byteLength);

    let writtenCount = 0;
    const sectorIndexId = indexId;

    for (const archiveId of archiveIds) {
      try {
        const idxOffset = archiveId * IDX_ENTRY_SIZE;
        if (idxOffset + IDX_ENTRY_SIZE > origIdxBytes.byteLength) {
          continue;
        }

        const origSize = readMedium(origIdxBytes, idxOffset);
        const origStartSector = readMedium(origIdxBytes, idxOffset + 3);
        if (origSize === 0 || origStartSector === 0) {
          continue;
        }

        const extended = archiveId > 65535;
        const headerSize = extended ? EXT_HEADER_SIZE : HEADER_SIZE;
        const dataSize = extended ? EXT_DATA_SIZE : DATA_SIZE;

        // Read the whole container out of its source sector chain, checking every header.
        const source = new Uint8Array(origSize);
        let copied = 0;
        let sourceSector = origStartSector;
        for (let chunkId = 0; copied < origSize; chunkId++) {
          if (sourceSector <= 0) {
            throw new Error(`Invalid sector chain for ${indexId}:${archiveId} at chunk ${chunkId}`);
          }
          const sourceOffset = sourceSector * SECTOR_SIZE;
          if (sourceOffset + SECTOR_SIZE > origDat2Bytes.byteLength) {
            throw new Error(`Sector out of bounds for ${indexId}:${archiveId} (sector=${sourceSector})`);
          }

          const sourceArchiveId = extended
            ? readUint32BE(origDat2Bytes, sourceOffset)
            : (origDat2Bytes[sourceOffset] << 8) | origDat2Bytes[sourceOffset + 1];
          const sourceChunk = extended
            ? (origDat2Bytes[sourceOffset + 4] << 8) | origDat2Bytes[sourceOffset + 5]
            : (origDat2Bytes[sourceOffset + 2] << 8) | origDat2Bytes[sourceOffset + 3];
          const sourceIndexId = origDat2Bytes[sourceOffset + (extended ? 9 : 7)];

          if (sourceArchiveId !== archiveId) {
            throw new Error(`Archive mismatch for ${indexId}:${archiveId}; header has ${sourceArchiveId}`);
          }
          if (sourceChunk !== chunkId) {
            throw new Error(`Chunk mismatch for ${indexId}:${archiveId}; expected ${chunkId} got ${sourceChunk}`);
          }
          if (sourceIndexId !== sectorIndexId && sourceIndexId !== sectorIndexId + 1) {
            throw new Error(
              `Index mismatch for ${indexId}:${archiveId}; expected ${sectorIndexId} got ${sourceIndexId}`,
            );
          }

          const length = Math.min(dataSize, origSize - copied);
          const dataStart = sourceOffset + headerSize;
          source.set(origDat2Bytes.subarray(dataStart, dataStart + length), copied);
          copied += length;
          sourceSector = readMedium(origDat2Bytes, sourceOffset + (extended ? 6 : 4));
        }

        const container = gzipBzip2Container(source, `${indexId}:${archiveId}`);
        compressions.add(container[0]);
        const newStartSector = nextSectorPos;
        let written = 0;
        for (let chunkId = 0; written < container.length; chunkId++) {
          const length = Math.min(dataSize, container.length - written);
          const hasMore = written + length < container.length;
          const newSector = Buffer.alloc(SECTOR_SIZE);
          if (extended) {
            newSector.writeUInt32BE(archiveId, 0);
            newSector.writeUInt16BE(chunkId, 4);
            writeMedium(newSector, 6, hasMore ? nextSectorPos + 1 : 0);
            newSector[9] = sectorIndexId;
          } else {
            newSector.writeUInt16BE(archiveId, 0);
            newSector.writeUInt16BE(chunkId, 2);
            writeMedium(newSector, 4, hasMore ? nextSectorPos + 1 : 0);
            newSector[7] = sectorIndexId;
          }
          newSector.set(container.subarray(written, written + length), headerSize);
          chunks.push(newSector);
          nextSectorPos++;
          written += length;
        }

        writeMedium(newIdx, idxOffset, container.length);
        writeMedium(newIdx, idxOffset + 3, newStartSector);
        writtenCount++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `[trim-cache] Failed rebuilding traced archive ${indexId}:${archiveId}: ${message}. ` +
            `A traced archive that cannot be rewritten would become a sparse hole in the trimmed cache, ` +
            `causing runtime failures. Aborting the trim.`,
        );
      }
    }

    newIdxFiles.set(indexId, newIdx);
    perIndexCounts.set(indexId, {
      traced: archiveIds.length,
      written: writtenCount,
      total: totalArchives,
    });
  }

  return { newDat2: Buffer.concat(chunks), newIdxFiles, perIndexCounts, compressions };
}

/** The trimmed cache ships only dat2 and the index files it rewrote: idx255 and the app indices. */
function composeTrimmedFiles(newDat2: Buffer, newIdxFiles: Map<number, Buffer>): Map<string, ArrayBuffer> {
  const out = new Map<string, ArrayBuffer>();
  out.set('main_file_cache.dat2', toArrayBuffer(newDat2));
  for (const [indexId, buf] of newIdxFiles.entries()) {
    out.set(idxFileFor(indexId), toArrayBuffer(buf));
  }
  return out;
}

async function rezipCacheFiles(files: Map<string, ArrayBuffer>): Promise<Buffer> {
  const zip = new JSZip();
  // Fixed entry date so the generated zip is byte-deterministic: identical cache
  // content yields an identical disk.zip (and thus diskZipSha256). Without this
  // JSZip stamps each entry with `new Date()`, which would change the content
  // hash on every rebuild and force all clients to re-download even when nothing
  // actually changed. (DOS zip dates floor at 1980.)
  const FIXED_ZIP_DATE = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));
  for (const [name, data] of [...files.entries()].sort()) {
    zip.file(name, data, { date: FIXED_ZIP_DATE });
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

async function validateAgainstTrimmed(
  trimmedFiles: Map<string, ArrayBuffer>,
  revision: number,
  xteas: Map<number, number[]>,
  requiredNonEmpty: Set<string>,
): Promise<void> {
  const baseStore = MemoryStore.fromFiles(trimmedFiles, INDICES_TO_LOAD);
  const verifyStore = new TracingStore(baseStore);
  await traceScenarios(verifyStore, revision, xteas);

  // For every archive that returned non-empty data from the upstream cache, the
  // trimmed cache must also serve it. A sparse-hole read here means the trim
  // dropped data that production needs - hard fail.
  const dropped: string[] = [];
  for (const { indexId, archiveId } of verifyStore.getMissingArchives()) {
    const key = `${indexId}:${archiveId}`;
    if (requiredNonEmpty.has(key)) dropped.push(key);
  }
  if (dropped.length > 0) {
    const preview = dropped.slice(0, 20).join(', ');
    const more = dropped.length > 20 ? ` (+${dropped.length - 20} more)` : '';
    throw new Error(
      `[trim-cache] Self-validation FAILED: ${dropped.length} archive(s) the upstream ` +
        `cache served non-empty are sparse holes in the trimmed cache: ${preview}${more}. ` +
        `This means the trimmed cache will fail at runtime. The trace recorded these reads ` +
        `but buildTrimmedFiles did not preserve them - investigate before shipping.`,
    );
  }
}

function printSizeReport(
  fullZipSize: number,
  trimmedZipSize: number,
  perIndexCounts: Map<number, { traced: number; written: number; total: number }>,
  files: Map<string, ArrayBuffer>,
): void {
  const rows = Array.from(perIndexCounts.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([indexId, { traced, written, total }]) => ({
      indexId,
      traced,
      written,
      total,
      coverage: total > 0 ? `${((traced / total) * 100).toFixed(1)}%` : 'n/a',
    }));
  console.log('\n[trim-cache] Per-index trace coverage:');
  console.table(rows);

  const origDat2 = files.get('main_file_cache.dat2')!;
  console.log('\n[trim-cache] Size comparison:');
  console.table([
    {
      artifact: 'disk.zip',
      original: formatBytes(fullZipSize),
      trimmed: formatBytes(trimmedZipSize),
      retained: formatRatio(trimmedZipSize, fullZipSize),
    },
    {
      artifact: 'main_file_cache.dat2 (uncompressed)',
      original: formatBytes(origDat2.byteLength),
      trimmed: formatBytes(perIndexCountsToDat2Size(perIndexCounts)),
      retained: formatRatio(perIndexCountsToDat2Size(perIndexCounts), origDat2.byteLength),
    },
  ]);
}

function perIndexCountsToDat2Size(counts: Map<number, { traced: number; written: number; total: number }>): number {
  let writtenSectors = 1;
  for (const c of counts.values()) {
    writtenSectors += c.written;
  }
  return writtenSectors * SECTOR_SIZE;
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    /* expected for items that don't have models, etc. */
  }
}

async function safeAsync<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

function idxFileFor(indexId: number): string {
  return indexId === 255 ? 'main_file_cache.idx255' : `main_file_cache.idx${indexId}`;
}

function readMedium(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
}

function writeMedium(target: Buffer, offset: number, value: number): void {
  target[offset] = (value >> 16) & 0xff;
  target[offset + 1] = (value >> 8) & 0xff;
  target[offset + 2] = value & 0xff;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) >>> 0) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
}

function groupTraceByIndex(trace: TraceEntry[]): Map<number, number[]> {
  const grouped = new Map<number, Set<number>>();
  for (const { indexId, archiveId } of trace) {
    let bucket = grouped.get(indexId);
    if (!bucket) {
      bucket = new Set<number>();
      grouped.set(indexId, bucket);
    }
    bucket.add(archiveId);
  }
  const out = new Map<number, number[]>();
  for (const [indexId, set] of grouped.entries()) {
    out.set(
      indexId,
      Array.from(set).sort((a, b) => a - b),
    );
  }
  return out;
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'n/a';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(2)} ${units[i]}`;
}

function formatRatio(part: number, whole: number): string {
  if (whole <= 0) return 'n/a';
  return `${((part / whole) * 100).toFixed(2)}%`;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isEntrypoint = !!invokedPath && fileURLToPath(import.meta.url) === invokedPath;

if (isEntrypoint) {
  main().catch((err) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error('[trim-cache] Failed:', message);
    process.exit(1);
  });
}
