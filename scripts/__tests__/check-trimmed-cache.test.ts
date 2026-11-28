import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { Archive } from '../../src/rs/cache/Archive';
import { ArchiveFile } from '../../src/rs/cache/ArchiveFile';
import { CacheIndexDat2 } from '../../src/rs/cache/CacheIndex';
import { CacheSystem } from '../../src/rs/cache/CacheSystem';
import { ReferenceTable } from '../../src/rs/cache/ref/ReferenceTable';
import { MemoryStore } from '../../src/rs/cache/store/MemoryStore';
import { ByteBuffer } from '../../src/rs/io/ByteBuffer';
import { StringUtil } from '../../src/rs/util/StringUtil';
import { type CacheRoots, collectCacheRoots } from '../cacheRoots';
import { ArtifactChecker, checkArtifact, checkRoots, readArtifact } from '../check-trimmed-cache';
import { computeTraceSpecHash, discoverCacheUsage } from '../discoverCacheUsage';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCAL_MIRROR = path.join(REPO_ROOT, 'public', 'osrs-cache');
const hasLocalMirror = existsSync(path.join(LOCAL_MIRROR, 'disk.zip'));

let tempDir: string | undefined;
afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

/**
 * Model index 7 whose reference table lists archives 0 and 1. Archive 0 is stored; archive 1 has
 * the zeroed idx entry the trim leaves for an archive it dropped.
 */
function trimmedModelIndex(): { cache: CacheSystem; store: MemoryStore } {
  const payload = Buffer.from([1, 2, 3]);
  const container = Buffer.alloc(5 + payload.length);
  container.writeInt32BE(payload.length, 1);
  payload.copy(container, 5);

  const dataFile = new ArrayBuffer(528 + container.length);
  new DataView(dataFile).setUint8(527, 7);
  new Uint8Array(dataFile, 528).set(container);
  const indexFile = new ArrayBuffer(12);
  const entry = new DataView(indexFile);
  entry.setUint16(1, container.length);
  entry.setUint8(5, 1);
  const indexFiles: (ArrayBuffer | undefined)[] = [];
  indexFiles[7] = indexFile;
  const store = new MemoryStore(dataFile, indexFiles, new ArrayBuffer(0));

  const table = Buffer.alloc(32);
  table[0] = 5;
  table.writeUInt16BE(2, 2);
  table.writeUInt16BE(1, 6);
  table.writeUInt16BE(1, 24);
  table.writeUInt16BE(1, 26);
  const indices: (CacheIndexDat2 | undefined)[] = [];
  indices[7] = new CacheIndexDat2(7, ReferenceTable.decode(new ByteBuffer(Int8Array.from(table))), store);
  return { cache: new CacheSystem(indices), store };
}

function onlySpotAnim(id: number, label: string): CacheRoots {
  return { ...noRoots(), spotAnims: new Map([[id, label]]) };
}

function noRoots(): CacheRoots {
  return {
    spotAnims: new Map(),
    seqs: new Map(),
    npcs: new Map(),
    models: new Map(),
    wornItems: new Map(),
    droppedItems: new Map(),
    identKits: new Map(),
    locs: new Map(),
    sprites: new Map(),
    soundEffects: new Map(),
    mapSquares: new Map(),
  };
}

describe('ArtifactChecker', () => {
  it('passes a stored archive', () => {
    const { cache, store } = trimmedModelIndex();
    const checker = new ArtifactChecker(cache, store);

    expect(checker.archive(7, 0, 'root -> model 0')?.getFile(0)?.data).toEqual(Int8Array.from([1, 2, 3]));
    expect(checker.missing).toEqual([]);
  });

  it('fails an archive the reference table lists but the artifact serves empty, naming what needs it', () => {
    const { cache, store } = trimmedModelIndex();
    const checker = new ArtifactChecker(cache, store);
    const chain = 'ITEM_ACTIONS[30875].playerGraphic -> spotanim 3232 -> model 1';

    expect(checker.archive(7, 1, chain)).toBeUndefined();
    expect(checker.missing).toEqual([{ key: '7:1', reason: 'empty (dropped by the trim)', chain }]);
    expect(checker.upstream).toEqual([]);
  });

  it('reports, without failing, an archive upstream never listed', () => {
    const { cache, store } = trimmedModelIndex();
    const checker = new ArtifactChecker(cache, store);

    expect(checker.archive(7, 5, 'npc 1 -> model 5')).toBeUndefined();
    expect(checker.missing).toEqual([]);
    expect(checker.upstream).toEqual([
      { key: '7:5', reason: 'not in the upstream reference table', chain: 'npc 1 -> model 5' },
    ]);
  });
});

/** Serves only the loc config archive (2:6) from `locs` and records the chain of every model read. */
class LocOnlyChecker extends ArtifactChecker {
  readonly modelChains: string[] = [];

  constructor(private readonly locArchive: Archive) {
    super({} as CacheSystem, {} as MemoryStore);
  }

  override archive(indexId: number, archiveId: number, chain: string): Archive | undefined {
    if (indexId === 2 && archiveId === 6) return this.locArchive;
    if (indexId === 7) this.modelChains.push(chain);
    return undefined;
  }
}

function locArchive(locs: Record<number, readonly number[]>): Archive {
  const ids = Object.keys(locs).map(Number);
  const files = new Map(ids.map((id) => [id, new ArchiveFile(id, 6, Int8Array.from(locs[id]))]));
  return new Archive(
    StringUtil.hashDjb2,
    6,
    Math.max(...ids),
    ids.length,
    Int32Array.from(ids),
    new Int32Array(ids.length),
    files,
  );
}

describe('checkRoots', () => {
  it('follows a runtime-spawned transform loc to the models of every loc its varbit can draw', async () => {
    const locs = locArchive({
      // Opcode 77: varbit 5, no varp, transforms [2, 3] then the -1 default.
      1: [77, 0, 5, 0xff, 0xff, 1, 0, 2, 0, 3, 0],
      // Opcode 5: one model each.
      2: [5, 1, 0, 20, 0],
      3: [5, 1, 0, 30, 0],
    });
    const checker = new LocOnlyChecker(locs);
    const cache = { getIndex: () => ({ table: { named: false } }) } as unknown as CacheSystem;

    await checkRoots(checker, cache, { ...noRoots(), locs: new Map([[1, 'pillar']]) }, 241);

    expect(checker.modelChains).toEqual([
      'pillar -> loc 1 transform -> loc 2 -> model 20',
      'pillar -> loc 1 transform -> loc 3 -> model 30',
    ]);
  });
});

/** An artifact whose only container is the reference table 255:0, compressed as `compression`. */
function artifactWithOneContainer(compression: number, containerCompressions: unknown) {
  const container = Uint8Array.from([compression, 0, 0, 0, 1, 0, 0, 0, 1, 0x5a]);
  const dat2 = new ArrayBuffer(528 + container.length);
  new DataView(dat2).setUint8(527, 255);
  new Uint8Array(dat2, 528).set(container);
  const idx255 = new ArrayBuffer(6);
  new DataView(idx255).setUint16(1, container.length);
  new DataView(idx255).setUint8(5, 1);
  const files = new Map([
    ['main_file_cache.dat2', dat2],
    ['main_file_cache.idx255', idx255],
  ]);
  return { files, revision: 241, containerCompressions };
}

describe('checkArtifact compression', () => {
  it('fails a bzip2 container, which production has no decoder for', async () => {
    const report = await checkArtifact(artifactWithOneContainer(1, ['bzip2']), onlySpotAnim(1, 'root'));

    expect(report.compression).toEqual([
      {
        key: '255:0',
        reason: 'bzip2 container; production decodes only stored and gzip containers',
        chain: 'artifact container scan',
      },
    ]);
  });

  it.each([
    ['is missing', undefined],
    ['omits a compression the artifact holds', ['none']],
  ])('fails a manifest whose containerCompressions %s', async (_name, declared) => {
    const report = await checkArtifact(artifactWithOneContainer(2, declared), onlySpotAnim(1, 'root'));

    expect(report.compression).toEqual([
      expect.objectContaining({ key: 'manifest.containerCompressions', reason: expect.stringContaining('["gzip"]') }),
    ]);
  });
});

/** The app's indices, then sound effects (4): every index the trimmed mirror carries, in its order. */
const APP_INDEX_IDS = [0, 1, 2, 5, 7, 8, 9, 22, 4];
/** A stored container holding a reference table that lists no archives. */
const EMPTY_TABLE = [0, 0, 0, 0, 4, 5, 0, 0, 0];

/**
 * An artifact whose app indices hold no archives. `tables[i]` is the 255:i container (omitted: an
 * empty idx255 entry); `withoutIndexFile` drops that index's idx file.
 */
function artifactWithTables(tables: Record<number, readonly number[]>, withoutIndexFile?: number) {
  const entries = Object.entries(tables);
  const dat2 = new Uint8Array((entries.length + 1) * 520);
  const idx255 = new Uint8Array(23 * 6);
  entries.forEach(([indexId, container], i) => {
    const sector = (i + 1) * 520;
    dat2[sector + 1] = Number(indexId);
    dat2[sector + 7] = 255;
    dat2.set(container, sector + 8);
    idx255[Number(indexId) * 6 + 2] = container.length;
    idx255[Number(indexId) * 6 + 5] = i + 1;
  });
  const files = new Map<string, ArrayBuffer>([
    ['main_file_cache.dat2', dat2.buffer],
    ['main_file_cache.idx255', idx255.buffer],
  ]);
  for (const indexId of APP_INDEX_IDS) {
    if (indexId !== withoutIndexFile) files.set(`main_file_cache.idx${indexId}`, new ArrayBuffer(6));
  }
  return { files, revision: 241, containerCompressions: entries.length > 0 ? ['none'] : [] };
}

const validTables = (): Record<number, readonly number[]> =>
  Object.fromEntries(APP_INDEX_IDS.map((indexId) => [indexId, EMPTY_TABLE]));

const keys = (problems: readonly { key: string }[]) => problems.map((problem) => problem.key);

describe('checkArtifact reference tables', () => {
  it('fails an all-zero idx255 instead of reading every archive as an upstream omission', async () => {
    const report = await checkArtifact(artifactWithTables({}), onlySpotAnim(1, 'root'));

    expect(keys(report.missing)).toEqual(APP_INDEX_IDS.map((indexId) => `255:${indexId}`));
    expect(report.missing[0].reason).toBe('reference table is empty');
    expect(report.upstream).toEqual([]);
  });

  it('fails one undecodable reference table', async () => {
    const tables = { ...validTables(), 7: [0, 0, 0, 0, 4, 99, 0, 0, 0] };

    const report = await checkArtifact(artifactWithTables(tables), onlySpotAnim(1, 'root'));

    expect(report.missing).toEqual([
      { key: '255:7', reason: expect.stringContaining('reference table is unreadable'), chain: 'app index 7' },
    ]);
  });

  it('fails an app index whose idx file is missing', async () => {
    const report = await checkArtifact(artifactWithTables(validTables(), 22), onlySpotAnim(1, 'root'));

    expect(report.missing).toEqual([
      { key: '255:22', reason: 'index file main_file_cache.idx22 is missing', chain: 'app index 22' },
    ]);
  });

  it('fails startup archives the reference table omits, but not an optional root it omits', async () => {
    const roots = { ...onlySpotAnim(1, 'root'), sprites: new Map([[5, 'optional sprite']]) };

    const report = await checkArtifact(artifactWithTables(validTables()), roots);

    expect(keys(report.missing)).toEqual([...[1, 3, 4, 6, 8, 9, 10, 12, 13, 34].map((a) => `2:${a}`), '9:0']);
    expect(report.missing[0].reason).toBe('mandatory archive is not in the reference table');
    expect(report.upstream).toEqual([
      { key: '8:5', reason: 'not in the upstream reference table', chain: 'optional sprite -> sprite 5' },
    ]);
  });

  it('fails an app sound effect the reference table omits', async () => {
    const roots = { ...onlySpotAnim(1, 'root'), soundEffects: new Map([[11414, 'ALL_SOUND_IDS']]) };

    const report = await checkArtifact(artifactWithTables(validTables()), roots);

    expect(report.missing).toContainEqual({
      key: '4:11414',
      reason: 'mandatory archive is not in the reference table',
      chain: 'ALL_SOUND_IDS -> sound effect 11414',
    });
    expect(keys(report.upstream)).not.toContain('4:11414');
  });
});

describe('readArtifact', () => {
  it('refuses a disk.zip whose sha256 is not the one the manifest names', async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'check-trimmed-cache-'));
    const zip = await new JSZip()
      .file('main_file_cache.dat2', new Uint8Array(520))
      .generateAsync({ type: 'nodebuffer' });
    writeFileSync(path.join(tempDir, 'disk.zip'), zip);
    writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify({ diskZipSha256: 'stale' }));

    await expect(readArtifact(tempDir)).rejects.toThrow('does not match disk.zip');

    const sha = createHash('sha256').update(zip).digest('hex');
    writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify({ diskZipSha256: sha }));
    await expect(readArtifact(tempDir)).resolves.toMatchObject({ revision: 232 });
  });
});

it('runs on every production build, after the build has copied the mirror into dist', () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
    scripts: { build: string };
  };
  const steps = pkg.scripts.build.split('&&').map((step) => step.trim());

  expect(steps.indexOf('tsx scripts/check-trimmed-cache.ts')).toBeGreaterThan(steps.indexOf('vite build'));
  expect(steps.indexOf('vite build')).toBeGreaterThan(steps.indexOf('tsx scripts/trim-cache.ts'));
});

// The real cache is not in the repository; without a local mirror the guarantee is the build step
// above, which never skips.
// Both need a mirror trimmed since bzip2 was re-encoded: the check decodes like production, without bzip2.
const localMirrorIsGzip =
  hasLocalMirror &&
  Array.isArray(JSON.parse(readFileSync(path.join(LOCAL_MIRROR, 'manifest.json'), 'utf-8')).containerCompressions);

describe.skipIf(!localMirrorIsGzip)('the local trimmed mirror (public/osrs-cache)', () => {
  it('fails with the full chain when an archive a root needs is zeroed', async () => {
    const artifact = await readArtifact(LOCAL_MIRROR);
    const idx7 = artifact.files.get('main_file_cache.idx7')!.slice(0);
    new Uint8Array(idx7, 48339 * 6, 6).fill(0);
    const files = new Map(artifact.files).set('main_file_cache.idx7', idx7);

    const report = await checkArtifact({ ...artifact, files }, onlySpotAnim(3232, 'ITEM_ACTIONS[30875].playerGraphic'));

    expect(report.missing).toEqual([
      {
        key: '7:48339',
        reason: 'empty (dropped by the trim)',
        chain: 'ITEM_ACTIONS[30875].playerGraphic -> spotanim 3232 -> model 48339',
      },
    ]);
  }, 60000);

  it('serves every root when it was trimmed from the current trace spec', async (ctx) => {
    const manifest = JSON.parse(readFileSync(path.join(LOCAL_MIRROR, 'manifest.json'), 'utf-8')) as {
      traceSpecHash?: string;
    };
    if (manifest.traceSpecHash !== (await computeTraceSpecHash(REPO_ROOT))) ctx.skip();

    const report = await checkArtifact(
      await readArtifact(LOCAL_MIRROR),
      collectCacheRoots(await discoverCacheUsage(REPO_ROOT)),
    );

    expect(report.missing).toEqual([]);
    expect(report.compression).toEqual([]);
  }, 120000);
});
