/**
 * Artifact-integrity check for the deployable OSRS cache mirror (`disk.zip` + `manifest.json`).
 *
 * Runs at the end of `npm run build` against `dist/osrs-cache`, so it checks the file that ships
 * even when the trim step was skipped because the cache was already trimmed (a stale local
 * mirror). It follows every root in `collectCacheRoots` - the same roots the trimmer
 * retains from - down to the archives the runtime reads, reading each archive RAW: an archive the
 * upstream reference table lists but the artifact serves empty or undecodable fails the build,
 * with the chain of data that needs it.
 *
 * What this catches: a stale or mismatched artifact, a sector rewrite that dropped or corrupted an
 * archive, a manifest whose hash does not match its zip, an upstream cache change that moved a
 * reachable asset to an archive the trim no longer keeps, and any bzip2 container left in the
 * artifact (the production mirror must decode without the bzip2 decoder; see gzipCacheContainers.ts). It does
 * NOT discover new runtime requests: it starts from the same roots as the trimmer, so an id no root names is
 * invisible to both. Keeping the roots complete is `cacheRoots.test.ts`'s job.
 *
 * Findings no trim can fix - an archive the upstream reference table never listed, a config
 * entry that is absent or that our decoder cannot read - are counted but do not fail; `--upstream`
 * lists them.
 *
 * Usage: tsx scripts/check-trimmed-cache.ts [artifact dir, default dist/osrs-cache] [--upstream]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import type { ApiType } from '../src/rs/cache/ApiType';
import type { Archive } from '../src/rs/cache/Archive';
import { CacheIndexDat2 } from '../src/rs/cache/CacheIndex';
import type { CacheInfo } from '../src/rs/cache/CacheInfo';
import { CacheSystem } from '../src/rs/cache/CacheSystem';
import type { CacheStore } from '../src/rs/cache/store/CacheStore';
import { META_INDEX_ID, MemoryStore } from '../src/rs/cache/store/MemoryStore';
import type { CompressionType } from '../src/rs/compression/CompressionType';
import { IdentKit } from '../src/rs/config/identkit/IdentKit';
import { LocType } from '../src/rs/config/loctype/LocType';
import { NpcType } from '../src/rs/config/npctype/NpcType';
import { ObjType } from '../src/rs/config/objtype/ObjType';
import { SeqType } from '../src/rs/config/seqtype/SeqType';
import { SpotAnimType } from '../src/rs/config/spotanimtype/SpotAnimType';
import type { Type } from '../src/rs/config/Type';
import type { TypeConstructor } from '../src/rs/config/TypeLoader';
import { ByteBuffer } from '../src/rs/io/ByteBuffer';
import { MapLoader } from '../src/rs/map/MapLoader';
import { SpriteTextureLoader } from '../src/rs/texture/SpriteTextureLoader';
import { log } from '../src/util/Logger';
import {
  APP_CONFIG_ARCHIVES,
  type CacheRoots,
  collectCacheRoots,
  MIRROR_INDICES,
  SOUND_EFFECT_INDEX,
} from './cacheRoots';
import { discoverCacheUsage, parseMapSquare } from './discoverCacheUsage';
import { COMPRESSION_NAMES } from './gzipCacheContainers';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REVISION = 232;

const FRAMES = 0;
const BASES = 1;
const CONFIG = 2;
const MAPS = 5;
const MODELS = 7;
const SPRITES = 8;
const TEXTURES = 9;
const KEYFRAMES = 22;

const IDK_ARCHIVE = 3;
const LOC_ARCHIVE = 6;
const NPC_ARCHIVE = 9;
const OBJ_ARCHIVE = 10;
const SEQ_ARCHIVE = 12;
const SPOTANIM_ARCHIVE = 13;

export interface ArtifactProblem {
  /** `index:archive`, or `config <archive>/<file>` for a missing config entry. */
  readonly key: string;
  readonly reason: string;
  /** The data that needs it, root first. */
  readonly chain: string;
}

/**
 * Raw archive reads with memoized outcomes. `missing` is trim loss or corruption (fails the
 * build); `upstream` is what no trim can fix - archives the upstream reference table never
 * listed, and config entries that are absent or that our decoder cannot read (reported only).
 */
export class ArtifactChecker {
  readonly missing: ArtifactProblem[] = [];
  readonly upstream: ArtifactProblem[] = [];
  private readonly seen = new Map<string, Archive | null>();

  constructor(
    private readonly cache: CacheSystem,
    private readonly store: CacheStore<ApiType.SYNC>,
  ) {}

  /**
   * A `mandatory` archive is one the app cannot do without - a startup config archive, or a sound
   * effect the app names - so even upstream absence fails.
   */
  archive(indexId: number, archiveId: number, chain: string, mandatory = false): Archive | undefined {
    const key = `${indexId}:${archiveId}`;
    const known = this.seen.get(key);
    if (known !== undefined) return known ?? undefined;

    let result: Archive | null = null;
    const index = this.cache.getIndex(indexId);
    if (!index.getArchiveReference(archiveId)) {
      if (mandatory) {
        this.missing.push({ key, reason: 'mandatory archive is not in the reference table', chain });
      } else {
        this.upstream.push({ key, reason: 'not in the upstream reference table', chain });
      }
    } else {
      let raw: Int8Array | undefined;
      try {
        raw = this.store.read(indexId, archiveId);
      } catch (e) {
        this.missing.push({ key, reason: `unreadable: ${message(e)}`, chain });
      }
      if (raw && raw.length === 0) {
        this.missing.push({ key, reason: 'empty (dropped by the trim)', chain });
      } else if (raw) {
        try {
          result = index.getArchive(archiveId);
        } catch (e) {
          this.missing.push({ key, reason: `corrupt: ${message(e)}`, chain });
        }
      }
    }
    this.seen.set(key, result);
    return result ?? undefined;
  }

  /** Records a config entry the upstream config archive does not hold. */
  absentConfig(archiveId: number, fileId: number, chain: string): void {
    this.upstream.push({ key: `config ${archiveId}/${fileId}`, reason: 'no such config entry', chain });
  }

  /** Records a config entry our decoder cannot fully read; config archives ship whole, so not trim loss. */
  undecodableConfig(archiveId: number, fileId: number, reason: string, chain: string): void {
    this.upstream.push({ key: `config ${archiveId}/${fileId}`, reason: `decode error: ${reason}`, chain });
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Follows every root to the archives it needs. Resolution order does not matter. */
export async function checkRoots(
  checker: ArtifactChecker,
  cache: CacheSystem,
  roots: CacheRoots,
  revision: number,
): Promise<void> {
  const info: CacheInfo = {
    name: 'osrs',
    game: 'oldschool',
    environment: 'live',
    revision,
    timestamp: '',
    size: 0,
  };
  const configs = new Map<number, Archive | undefined>();
  for (const archiveId of APP_CONFIG_ARCHIVES) {
    configs.set(archiveId, checker.archive(CONFIG, archiveId, `app config archive ${archiveId}`, true));
  }

  const decoded = new Map<string, Type | null>();
  function decode<T extends Type>(
    ctor: TypeConstructor<T>,
    archiveId: number,
    id: number,
    chain: string,
  ): T | undefined {
    const key = `${archiveId}/${id}`;
    if (decoded.has(key)) return (decoded.get(key) as T | null) ?? undefined;
    const archive = configs.get(archiveId);
    const file = archive?.getFile(id);
    let type: T | null = null;
    if (archive && !file) {
      checker.absentConfig(archiveId, id, chain);
    } else if (file) {
      // Like BaseTypeLoader, keep what decoded before a failure: the runtime renders that.
      type = new ctor(id, info);
      try {
        type.decode(file.getDataAsBuffer());
        type.post();
      } catch (e) {
        checker.undecodableConfig(archiveId, id, message(e), chain);
      }
    }
    decoded.set(key, type);
    return type ?? undefined;
  }

  const done = new Set<string>();
  const once = (key: string): boolean => {
    if (done.has(key)) return false;
    done.add(key);
    return true;
  };

  const model = (id: number, chain: string): void => {
    if (id >= 0) checker.archive(MODELS, id, `${chain} -> model ${id}`);
  };

  const base = (fileData: Int8Array, offset: number, chain: string): void => {
    const buffer = new ByteBuffer(fileData);
    buffer.offset = offset;
    const baseId = buffer.readUnsignedShort();
    checker.archive(BASES, baseId, `${chain} -> base ${baseId}`);
  };

  const seq = (id: number, chain: string): void => {
    if (id < 0 || !once(`seq:${id}`)) return;
    const at = `${chain} -> seq ${id}`;
    const type = decode(SeqType, SEQ_ARCHIVE, id, at);
    if (!type) return;
    if (type.isSkeletalSeq()) {
      const group = type.skeletalId >> 16;
      const archive = checker.archive(KEYFRAMES, group, `${at} -> skeletal ${type.skeletalId}`);
      const file = archive?.getFile(type.skeletalId & 0xffff);
      // A keyframe file opens with a version byte, then its base id (SkeletalSeq.load).
      if (file) base(file.data, 1, `${at} -> skeletal ${type.skeletalId}`);
      return;
    }
    for (const group of new Set((type.frameIds ?? []).filter((f) => f >= 0).map((f) => f >> 16))) {
      if (!once(`frames:${group}`)) continue;
      const archive = checker.archive(FRAMES, group, `${at} -> frames ${group}`);
      // The runtime decodes every frame in the group, and each names its base first (Dat2SeqFrame.load).
      for (const file of archive?.files ?? []) base(file.data, 0, `${at} -> frames ${group}`);
    }
  };

  const spotAnim = (id: number, chain: string): void => {
    if (!once(`spotanim:${id}`)) return;
    const at = `${chain} -> spotanim ${id}`;
    const type = decode(SpotAnimType, SPOTANIM_ARCHIVE, id, at);
    if (!type) return;
    model(type.modelId, at);
    if (typeof type.sequenceId === 'number') seq(type.sequenceId, at);
  };

  const npc = (id: number, chain: string): void => {
    if (!once(`npc:${id}`)) return;
    const at = `${chain} -> npc ${id}`;
    const type = decode(NpcType, NPC_ARCHIVE, id, at);
    if (!type) return;
    for (const m of type.modelIds ?? []) model(m, at);
    for (const s of [
      type.idleSeqId,
      type.walkSeqId,
      type.walkBackSeqId,
      type.walkLeftSeqId,
      type.walkRightSeqId,
      type.turnLeftSeqId,
      type.turnRightSeqId,
      type.runSeqId,
      type.runBackSeqId,
      type.runLeftSeqId,
      type.runRightSeqId,
      type.crawlSeqId,
      type.crawlBackSeqId,
      type.crawlLeftSeqId,
      type.crawlRightSeqId,
    ]) {
      seq(s, at);
    }
  };

  const loc = (id: number, chain: string): void => {
    if (!once(`loc:${id}`)) return;
    const at = `${chain} -> loc ${id}`;
    const type = decode(LocType, LOC_ARCHIVE, id, at);
    if (!type) return;
    for (const group of type.models ?? []) for (const m of group) model(m, at);
    seq(type.seqId, at);
    for (const s of type.randomSeqIds ?? []) seq(s, at);
  };

  for (const [id, label] of roots.spotAnims) spotAnim(id, label);
  for (const [id, label] of roots.models) model(id, label);
  for (const [id, label] of roots.seqs) seq(id, label);
  for (const [id, label] of roots.npcs) npc(id, label);
  // A runtime-spawned transform loc draws whichever target its varbit picks (SceneObjectRenderer
  // resolves `LocType.transforms` one level), so each target needs its assets. Map-square locs
  // render as themselves.
  for (const [id, label] of roots.locs) {
    loc(id, label);
    const at = `${label} -> loc ${id} transform`;
    const transforms = decode(LocType, LOC_ARCHIVE, id, at)?.transforms ?? [];
    for (const target of new Set(transforms)) if (target >= 0) loc(target, at);
  }

  for (const [id, label] of roots.wornItems) {
    const at = `${label} -> item ${id}`;
    const obj = decode(ObjType, OBJ_ARCHIVE, id, at);
    if (!obj) continue;
    // PlayerModelLoader renders part 0 in the item's primary slot and parts 1/2 only in the extra
    // slots its wear positions name.
    const wearPositions = [0, obj.wearPos2, obj.wearPos3];
    for (const gender of [0, 1] as const) {
      for (const part of [0, 1, 2] as const) {
        if (wearPositions[part] >= 0) model(obj.getWornModelId(gender, part), `${at} worn (gender ${gender})`);
      }
    }
  }
  for (const [id, label] of roots.droppedItems) {
    const at = `${label} -> item ${id}`;
    const obj = decode(ObjType, OBJ_ARCHIVE, id, at);
    if (obj) model(obj.inventoryModel, `${at} ground`);
  }
  for (const [id, label] of roots.identKits) {
    const at = `${label} -> identkit ${id}`;
    const kit = decode(IdentKit, IDK_ARCHIVE, id, at);
    for (const m of kit?.models ?? []) model(m, at);
  }

  for (const [id, label] of roots.sprites) checker.archive(SPRITES, id, `${label} -> sprite ${id}`);
  // Every id here is one the app plays (ALL_SOUND_IDS), so a sound the cache lacks fails like trim loss.
  for (const [id, label] of roots.soundEffects) {
    checker.archive(SOUND_EFFECT_INDEX, id, `${label} -> sound effect ${id}`, true);
  }
  if (checker.archive(TEXTURES, 0, 'texture definitions', true)) {
    const textures = SpriteTextureLoader.load(cache.getIndex(TEXTURES), cache.getIndex(SPRITES));
    for (const [textureId, definition] of textures.definitions) {
      for (const spriteId of definition.spriteIds) {
        checker.archive(SPRITES, spriteId, `texture ${textureId} -> sprite ${spriteId}`);
      }
    }
  }

  const mapIndex = cache.getIndex(MAPS);
  const mapLoader = new MapLoader(mapIndex, revision);
  for (const [key, label] of roots.mapSquares) {
    const [x, y] = parseMapSquare(key);
    const at = `${label} -> map square ${key}`;
    const terrain = mapLoader.getTerrainArchiveId(x, y);
    if (terrain >= 0) checker.archive(MAPS, terrain, `${at} terrain`);
    const locArchive = mapLoader.getLocArchiveId(x, y);
    if (locArchive >= 0 && checker.archive(MAPS, locArchive, `${at} locs`)) {
      const locations = await mapLoader.loadLocations(x, y);
      for (const id of new Set((locations?.locations ?? []).map((l) => l.id))) loc(id, `${at} locs`);
    }
    const npcArchive = mapLoader.getNpcSpawnArchiveId(x, y);
    if (npcArchive >= 0 && checker.archive(MAPS, npcArchive, `${at} npc spawns`)) {
      const spawns = await mapLoader.loadNpcSpawns(x, y);
      for (const id of new Set((spawns?.spawns ?? []).map((s) => s.id))) npc(id, `${at} npc spawns`);
    }
  }
}

interface Manifest {
  diskZipSha256?: string;
  builds?: Array<{ major?: number }>;
  containerCompressions?: unknown;
}

export interface ArtifactReport {
  readonly missing: readonly ArtifactProblem[];
  /** Containers production cannot decode, and a manifest that misdescribes the compressions. */
  readonly compression: readonly ArtifactProblem[];
  readonly upstream: readonly ArtifactProblem[];
}

export interface Artifact {
  /** The `main_file_cache.*` files inside `disk.zip`, by file name. */
  readonly files: Map<string, ArrayBuffer>;
  readonly revision: number;
  /** `manifest.containerCompressions`, which tells the client whether it must load bzip2. */
  readonly containerCompressions: unknown;
}

/** Reads `<dir>/disk.zip`, refusing one whose sha256 is not the one `<dir>/manifest.json` names. */
export async function readArtifact(dir: string): Promise<Artifact> {
  const zipPath = path.join(dir, 'disk.zip');
  const manifestPath = path.join(dir, 'manifest.json');
  if (!existsSync(zipPath) || !existsSync(manifestPath)) {
    throw new Error(`[check-trimmed-cache] ${zipPath} and ${manifestPath} must both exist.`);
  }
  const zipBytes = readFileSync(zipPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest;
  const sha = createHash('sha256').update(zipBytes).digest('hex');
  if (manifest.diskZipSha256 !== sha) {
    // Clients key their stored copy on this hash, so a mismatch ships content under the wrong name.
    throw new Error(
      `[check-trimmed-cache] manifest diskZipSha256 ${manifest.diskZipSha256 ?? '(none)'} does not match ` +
        `disk.zip (${sha}).`,
    );
  }
  const major = manifest.builds?.[0]?.major;
  const revision = typeof major === 'number' && major > 0 ? major : DEFAULT_REVISION;

  const zip = await JSZip.loadAsync(zipBytes);
  const files = new Map<string, ArrayBuffer>();
  for (const [name, entry] of Object.entries(zip.files)) {
    const base = path.basename(name);
    if (!entry.dir && base.startsWith('main_file_cache.')) files.set(base, await entry.async('arraybuffer'));
  }
  return { files, revision, containerCompressions: manifest.containerCompressions };
}

/**
 * The production mirror must decode without the bzip2 decoder, so every container it can load must
 * be gzip or stored, and the manifest must say so: the client loads the decoder only when
 * `containerCompressions` lists bzip2 or is absent.
 */
function checkCompressions(artifact: Artifact, store: MemoryStore): ArtifactProblem[] {
  const problems: ArtifactProblem[] = [];
  const found = new Set<string>();
  for (const indexId of [...MIRROR_INDICES, META_INDEX_ID]) {
    const indexFile = store.getIndexFile(indexId);
    if (!indexFile) continue;
    for (let archiveId = 0; archiveId < indexFile.byteLength / 6; archiveId++) {
      const container = store.read(indexId, archiveId);
      if (container.length === 0) continue;
      const name = COMPRESSION_NAMES[container[0] as CompressionType] ?? `unknown (${container[0]})`;
      found.add(name);
      if (name !== 'none' && name !== 'gzip') {
        problems.push({
          key: `${indexId}:${archiveId}`,
          reason: `${name} container; production decodes only stored and gzip containers`,
          chain: 'artifact container scan',
        });
      }
    }
  }
  const declared = artifact.containerCompressions;
  const foundList = [...found].sort();
  if (
    !Array.isArray(declared) ||
    declared.length !== foundList.length ||
    [...declared].sort().some((name, i) => name !== foundList[i])
  ) {
    problems.push({
      key: 'manifest.containerCompressions',
      reason: `declares ${JSON.stringify(declared)} but the artifact holds ${JSON.stringify(foundList)}`,
      chain: 'manifest.json',
    });
  }
  return problems;
}

/**
 * Every app index needs its file and a decodable 255:<index> reference table. The loader would
 * turn an empty table into an empty index, and every archive in it would then look like an
 * upstream omission instead of a failure.
 */
function loadAppIndices(store: MemoryStore): { indices: CacheIndexDat2[]; problems: ArtifactProblem[] } {
  const indices: CacheIndexDat2[] = [];
  const problems: ArtifactProblem[] = [];
  for (const indexId of MIRROR_INDICES) {
    const fail = (reason: string) =>
      problems.push({ key: `${META_INDEX_ID}:${indexId}`, reason, chain: `app index ${indexId}` });
    if (!store.getIndexFile(indexId)) {
      fail(`index file main_file_cache.idx${indexId} is missing`);
      continue;
    }
    try {
      if (store.read(META_INDEX_ID, indexId).length === 0) {
        fail('reference table is empty');
        continue;
      }
      indices[indexId] = CacheIndexDat2.fromStore(indexId, store);
    } catch (e) {
      fail(`reference table is unreadable: ${message(e)}`);
    }
  }
  return { indices, problems };
}

/**
 * Decodes like production, which never initializes bzip2. An artifact with a compression or
 * reference-table problem is not followed further.
 */
export async function checkArtifact(artifact: Artifact, roots: CacheRoots): Promise<ArtifactReport> {
  const store = MemoryStore.fromFiles(artifact.files, [...MIRROR_INDICES]);
  const compression = checkCompressions(artifact, store);
  if (compression.length > 0) return { missing: [], compression, upstream: [] };
  const { indices, problems } = loadAppIndices(store);
  if (problems.length > 0) return { missing: problems, compression, upstream: [] };
  const cache = new CacheSystem(indices);
  const checker = new ArtifactChecker(cache, store);
  await checkRoots(checker, cache, roots, artifact.revision);
  return { missing: checker.missing, compression, upstream: checker.upstream };
}

export function formatProblem(problem: ArtifactProblem): string {
  return `${problem.key} ${problem.reason} <- ${problem.chain}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const listUpstream = args.includes('--upstream');
  const dirArg = args.find((arg) => !arg.startsWith('--'));
  const dir = path.resolve(dirArg ?? path.join(REPO_ROOT, 'dist', 'osrs-cache'));
  log.setLevel('none');
  const roots = collectCacheRoots(await discoverCacheUsage(REPO_ROOT));
  const report = await checkArtifact(await readArtifact(dir), roots);
  console.log(
    `[check-trimmed-cache] ${dir}: ${report.missing.length} missing, ${report.compression.length} compression ` +
      `problem(s), ${report.upstream.length} upstream finding(s) no trim can fix (not failures` +
      `${report.upstream.length > 0 && !listUpstream ? '; --upstream lists them' : ''}).`,
  );
  if (listUpstream) for (const problem of report.upstream) console.log(`  upstream: ${formatProblem(problem)}`);
  for (const problem of report.compression.slice(0, 20)) console.error(`  COMPRESSION ${formatProblem(problem)}`);
  if (report.compression.length > 0) {
    throw new Error(
      `[check-trimmed-cache] the artifact holds bzip2 containers, which the production mirror must not, or its manifest ` +
        `misdescribes its compressions. Re-trim from the full cache (delete public/osrs-cache/ and run the build).`,
    );
  }
  if (report.missing.length > 0) {
    for (const problem of report.missing) console.error(`  MISSING ${formatProblem(problem)}`);
    throw new Error(
      `[check-trimmed-cache] ${report.missing.length} archive(s) the app can request are missing from the ` +
        `artifact. Re-trim from the full cache (delete public/osrs-cache/ and run the build), and if the ` +
        `archive is still missing, the trim's tracing of that root is broken.`,
    );
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((err) => {
    // Our own findings are self-describing; anything else is a checker or decoder bug that needs its stack.
    const ours = err instanceof Error && err.message.startsWith('[check-trimmed-cache]');
    console.error(ours ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
