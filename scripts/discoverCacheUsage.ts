/**
 * Following the `PATTERNS` conventions below when adding a new encounter / brain / controller
 * means the trim script auto-discovers your cache deps with no edits.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serializeRegistryRoots } from './cacheRoots';

export interface CacheUsage {
  npcIds: Set<number>;
  spotAnimIds: Set<number>;
  spriteIds: Set<number>;
  seqIds: Set<number>;
  itemIds: Set<number>;
  locIds: Set<number>;
  mapSquares: Set<string>;
}

export interface DiscoveryReport extends CacheUsage {
  filesScanned: number;
  counts: {
    npcIds: number;
    spotAnimIds: number;
    spriteIds: number;
    seqIds: number;
    itemIds: number;
    locIds: number;
    mapSquares: number;
  };
}

const SCAN_ROOT = 'src';
const SKIP_DIRS = new Set(['__tests__', '__mocks__', 'node_modules', 'generated']);
const SKIP_FILE_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx', '.d.ts'];

const PATTERNS = {
  npcConst: /(?:export\s+)?const\s+[A-Z][A-Z0-9_]*_NPC_ID\s*=\s*(\d+)/g,
  npcTypeIdLit: /\bnpcTypeId\s*:\s*(\d+)/g,
  npcIdLit: /\bnpcId\s*:\s*(\d+)\b/g,
  spotAnimLit: /\b(?:spotAnimId|projectileId|graphicId)\s*:\s*(\d+)/g,
  spotAnimFieldLit: /\b[a-z]\w*SpotanimId\s*:\s*(\d+)/g,
  // `*_GRAPHIC` is the other name this codebase gives a spotanim id (Zuk's projectile
  // and impact VFX). `Z_`-prefixed names are render z-order constants, not ids.
  spotAnimConst: /(?:export\s+)?const\s+(?!Z_)[A-Z][A-Z0-9_]*_(?:SPOTANIM(?:_ID)?|GRAPHIC)\s*=\s*(\d+)/g,
  // The same ids declared as an array (`ZUK_JAD_MAGIC_GRAPHICS = [448, 449, 450]`), which
  // the scalar pattern above cannot see.
  spotAnimArrayConst:
    /(?:export\s+)?const\s+(?!Z_)[A-Z][A-Z0-9_]*_(?:SPOT_?ANIM_IDS?|GRAPHICS)\s*(?::[^=]+)?=\s*\[([^\]]*)\]/g,
  spotAnimObjectConst:
    /(?:export\s+)?const\s+(?!Z_)[A-Z][A-Z0-9_]*_SPOTANIMS\s*(?::[^=]+)?=\s*\{([\s\S]*?)\}\s*(?:as\s+const\s*)?;/g,
  spriteCall: /loadIntoIndexedSprite\s*\(\s*[\w$.]+\s*,\s*(\d+)\s*\)/g,
  spriteConst: /(?:export\s+)?const\s+[A-Z][A-Z0-9_]*_SPRITE_ID\s*=\s*(\d+)/g,
  mapXConst: /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)_MAP_X\s*=\s*(\d+)/g,
  mapYConst: /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)_MAP_Y\s*=\s*(\d+)/g,
  mapSquareLit: /mapSquare\s*:\s*\{\s*x\s*:\s*(\d+)\s*,\s*y\s*:\s*(\d+)/g,
  loadMapSquareLit: /load(?:Additional)?MapSquare\s*\(\s*(\d+)\s*,\s*(\d+)/g,
  // `_ANIM_ID` is the other name this codebase gives a seq id (SELF_IMBUE_CAST_ANIM_ID, the
  // Death Charge / Mark of Darkness cast). `_SPOTANIM(_ID)` is a spotanim and stays out:
  // it has no underscore before ANIM, so the suffixes below cannot reach it.
  seqConst: /(?:export\s+)?const\s+[A-Z][A-Z0-9_]*_(?:SEQ|ANIM|ANIMATION)(?:_ID)?\s*=\s*(\d+)/g,
  seqFieldLit: /\b[a-z]\w*SeqId\s*:\s*(\d+)/g,
  // Without this, the frame archives get trimmed away and the animation silently plays with no
  // frame data (model never deforms) while sound/projectiles still fire.
  seqAnimIdLit: /\b(?:animationId|[a-z]\w*AnimationId|attackAnimation)\s*:\s*(\d+)/g,
  seqAnimationsObjectConst: /(?:export\s+)?const\s+[A-Z][A-Z0-9_]*_ANIMATIONS\s*=\s*\{([^}]*)\}/g,
  // Per-actor animation tables (`ZUK_SEQS = { zuk: { idle: 7564, ... }, ... }`). The
  // fields are plain words like `idle`/`attack`, so no field-name pattern can see them;
  // match the whole nested object up to the closing brace that ends the statement
  // (inner braces are followed by a comma, not a semicolon) and take every number inside.
  seqObjectConst: /(?:export\s+)?const\s+[A-Z][A-Z0-9_]*_SEQS\s*(?::[^=]+)?=\s*\{([\s\S]*?)\}\s*(?:as\s+const\s*)?;/g,
  itemConst: /(?:export\s+)?const\s+[A-Z][A-Z0-9_]*_ITEM_ID\s*=\s*(\d+)/g,
  itemIdLit: /\bitemId\s*:\s*(\d+)/g,
  // Runes are not equippable, so they are absent from equipment.json and reach the trimmer only
  // from here - without this their inventory/rune-pouch icons have no obj definition.
  runeObjectConst:
    /(?:export\s+)?const\s+(?:[A-Z][A-Z0-9_]*_)?RUNES?(?:_SOURCES)?\s*(?::[^=]+)?=\s*\{([\s\S]*?)\}\s*(?:as\s+const\s*)?;/g,
  locConst: /(?:export\s+)?const\s+[A-Z][A-Z0-9_]*_LOC_ID\s*=\s*(\d+)/g,
  locArrayConst: /(?:export\s+)?const\s+[A-Z][A-Z0-9_]*_LOC_IDS\s*=\s*\[([^\]]*)\]/g,
  // Loc ids carried as object fields (Zuk's arena scenery swaps use
  // `sourceLocId` / `targetLocId`), which the const-only patterns above cannot see.
  locFieldLit: /\b\w*[Ll]ocId\s*:\s*(\d+)/g,
} as const;

async function* walkSource(root: string): AsyncIterable<string> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkSource(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    if (SKIP_FILE_SUFFIXES.some((suf) => entry.name.endsWith(suf))) continue;
    yield full;
  }
}

function consume(re: RegExp, text: string, sink: Set<number>): void {
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 0) sink.add(n);
  }
}

function consumeAllNumbers(re: RegExp, text: string, sink: Set<number>): void {
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const group = m[1];
    if (group === undefined) continue;
    for (const digits of group.match(/\d+/g) ?? []) {
      const n = Number(digits);
      if (Number.isFinite(n) && n >= 0) sink.add(n);
    }
  }
}

// An array of enum members (`SpotAnimID.VFX_COLOSSI_STAB_DUST_01`) or spreads carries digits that
// are not ids.
function consumeIntegerLiterals(re: RegExp, text: string, sink: Set<number>): void {
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const group = m[1];
    if (group === undefined) continue;
    for (const digits of group.match(/(?<![\w.])\d+(?![\w.])/g) ?? []) {
      const n = Number(digits);
      if (Number.isFinite(n) && n >= 0) sink.add(n);
    }
  }
}

function consumePair(re: RegExp, text: string, sink: Set<string>): void {
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const x = Number(m[1]);
    const y = Number(m[2]);
    if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0) {
      sink.add(`${x},${y}`);
    }
  }
}

function consumeNamed(re: RegExp, text: string, sink: Record<string, number>): void {
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const name = m[1];
    const n = Number(m[2]);
    if (Number.isFinite(n) && n >= 0) sink[name] = n;
  }
}

export async function discoverCacheUsage(projectRoot: string = process.cwd()): Promise<DiscoveryReport> {
  const usage: CacheUsage = {
    npcIds: new Set<number>(),
    spotAnimIds: new Set<number>(),
    spriteIds: new Set<number>(),
    seqIds: new Set<number>(),
    itemIds: new Set<number>(),
    locIds: new Set<number>(),
    mapSquares: new Set<string>(),
  };

  const mapXByBase: Record<string, number> = {};
  const mapYByBase: Record<string, number> = {};

  const root = join(projectRoot, SCAN_ROOT);
  let filesScanned = 0;

  for await (const path of walkSource(root)) {
    filesScanned++;
    const text = await readFile(path, 'utf8');

    consume(PATTERNS.npcConst, text, usage.npcIds);
    consume(PATTERNS.npcTypeIdLit, text, usage.npcIds);
    consume(PATTERNS.npcIdLit, text, usage.npcIds);

    consume(PATTERNS.spotAnimLit, text, usage.spotAnimIds);
    consume(PATTERNS.spotAnimFieldLit, text, usage.spotAnimIds);
    consume(PATTERNS.spotAnimConst, text, usage.spotAnimIds);
    consumeIntegerLiterals(PATTERNS.spotAnimArrayConst, text, usage.spotAnimIds);
    consumeIntegerLiterals(
      PATTERNS.spotAnimObjectConst,
      text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''),
      usage.spotAnimIds,
    );

    consume(PATTERNS.spriteCall, text, usage.spriteIds);
    consume(PATTERNS.spriteConst, text, usage.spriteIds);

    consumeNamed(PATTERNS.mapXConst, text, mapXByBase);
    consumeNamed(PATTERNS.mapYConst, text, mapYByBase);
    consumePair(PATTERNS.mapSquareLit, text, usage.mapSquares);
    consumePair(PATTERNS.loadMapSquareLit, text, usage.mapSquares);

    consume(PATTERNS.seqConst, text, usage.seqIds);
    consume(PATTERNS.seqFieldLit, text, usage.seqIds);
    consume(PATTERNS.seqAnimIdLit, text, usage.seqIds);
    consumeAllNumbers(PATTERNS.seqAnimationsObjectConst, text, usage.seqIds);
    consumeAllNumbers(PATTERNS.seqObjectConst, text, usage.seqIds);

    consume(PATTERNS.itemConst, text, usage.itemIds);
    consume(PATTERNS.itemIdLit, text, usage.itemIds);
    consumeAllNumbers(PATTERNS.runeObjectConst, text, usage.itemIds);

    consume(PATTERNS.locConst, text, usage.locIds);
    consume(PATTERNS.locFieldLit, text, usage.locIds);
    consumeAllNumbers(PATTERNS.locArrayConst, text, usage.locIds);
  }

  for (const base of Object.keys(mapXByBase)) {
    if (base in mapYByBase) {
      usage.mapSquares.add(`${mapXByBase[base]},${mapYByBase[base]}`);
    }
  }

  return {
    ...usage,
    filesScanned,
    counts: {
      npcIds: usage.npcIds.size,
      spotAnimIds: usage.spotAnimIds.size,
      spriteIds: usage.spriteIds.size,
      seqIds: usage.seqIds.size,
      itemIds: usage.itemIds.size,
      locIds: usage.locIds.size,
      mapSquares: usage.mapSquares.size,
    },
  };
}

export function parseMapSquare(key: string): [number, number] {
  const [xs, ys] = key.split(',');
  return [Number(xs), Number(ys)];
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  discoverCacheUsage()
    .then((report) => {
      const fmt = (s: Set<number>) => [...s].sort((a, b) => a - b);
      console.log(`[discover-cache-usage] scanned ${report.filesScanned} files`);
      console.log(`[discover-cache-usage] npcIds (${report.counts.npcIds}):`, fmt(report.npcIds));
      console.log(`[discover-cache-usage] spotAnimIds (${report.counts.spotAnimIds}):`, fmt(report.spotAnimIds));
      console.log(`[discover-cache-usage] spriteIds (${report.counts.spriteIds}):`, fmt(report.spriteIds));
      console.log(`[discover-cache-usage] seqIds (${report.counts.seqIds}):`, fmt(report.seqIds));
      console.log(`[discover-cache-usage] itemIds (${report.counts.itemIds}):`, fmt(report.itemIds));
      console.log(`[discover-cache-usage] locIds (${report.counts.locIds}):`, fmt(report.locIds));
      console.log(`[discover-cache-usage] mapSquares (${report.counts.mapSquares}):`, [...report.mapSquares]);
    })
    .catch((err) => {
      console.error('[discover-cache-usage] failed:', err);
      process.exit(1);
    });
}

/**
 * Bump when the TRIMMER'S trace LOGIC changes which archives it pulls (a new trace
 * step / input) or how it writes them (v7: bzip2 containers re-encoded as gzip; v8: only the
 * app indices ship; v9: runtime-spawned transform locs keep their targets) without a matching
 * source-id change, so builds still re-trim.
 */
export const TRACE_SPEC_VERSION = 9;

/**
 * Files the trimmer traces directly whose cache-relevant content is NOT captured by the
 * src/ id-pattern scan above: the weapon-animation tables, the equippable-item catalog,
 * the SpotAnimID table (trim-cache traces every `Object.values(SpotAnimID)`, but those
 * `NAME: id` object entries match no id pattern), the item catalogs behind the ground-item
 * model trace (`collectItemIconIds` and its sources, which all carry their ids as bare
 * object keys or `{ id: N }` slots), the item-action and special-attack registries
 * (`playerGraphic`, `targetGraphicBySize`) and the encounter render configs (whose
 * `attackClips` are keyed on plain words like `default`/`melee`). The ids the registry walk
 * (`collectCacheRoots`) resolves from them are hashed as well; these file hashes also catch a
 * content change that moves no root.
 */
const EXTRA_TRACE_INPUT_FILES = [
  'src/data/weaponCombatVisuals.ts',
  'src/data/equipmentCombatFamilies.ts',
  'src/data/weaponCombatVisuals.generated.ts',
  'src/data/weaponAnimations.ts',
  'src/rs/model/PlayerModelLoader.ts',
  'src/data/spellVisuals.ts',
  'src/data/osrs/equipment.json',
  'src/data/osrs/itemAliases.json',
  'src/data/osrs/manualEquipment.json',
  'src/data/itemIconIds.ts',
  'src/data/inventoryItemCatalog.ts',
  'src/data/itemEffects.ts',
  'src/data/customEquipmentPresets.ts',
  'src/data/playerPresets.ts',
  'src/data/infoboxItemIds.ts',
  'src/core/combat/player/specialAttacks/registry.ts',
  'src/rs/config/spotanimtype/SpotAnimID.ts',
  'src/encounters/renderConfigs.ts',
  'src/encounters/yamaP3/renderConfig.ts',
  'src/encounters/zuk/renderConfig.ts',
] as const;

/**
 * Deterministic fingerprint of everything that decides which cache archives the
 * trimmer keeps: the source-declared ids ({@link discoverCacheUsage}), the ids the
 * repository's runtime registries declare ({@link serializeRegistryRoots}, always read
 * from this checkout's src/), the direct data-file inputs and a logic-version tag.
 *
 * `fetch-cache` stores this in `manifest.json` and treats a mismatch as an invalid
 * mirror — it re-downloads the full cache so `trim-cache` re-runs and picks up the
 * newly-declared deps.
 *
 * Changes to how trim-cache follows a root are covered by TRACE_SPEC_VERSION; bump it
 * when you change them.
 */
export async function computeTraceSpecHash(projectRoot: string = process.cwd()): Promise<string> {
  const usage = await discoverCacheUsage(projectRoot);
  const hash = createHash('sha256');
  hash.update(`trace-spec v${TRACE_SPEC_VERSION}\n`);

  const nums = (s: Set<number>): string => [...s].sort((a, b) => a - b).join(',');
  hash.update(`npcIds=${nums(usage.npcIds)}\n`);
  hash.update(`spotAnimIds=${nums(usage.spotAnimIds)}\n`);
  hash.update(`spriteIds=${nums(usage.spriteIds)}\n`);
  hash.update(`seqIds=${nums(usage.seqIds)}\n`);
  hash.update(`itemIds=${nums(usage.itemIds)}\n`);
  hash.update(`locIds=${nums(usage.locIds)}\n`);
  hash.update(`mapSquares=${[...usage.mapSquares].sort().join(',')}\n`);
  hash.update(`registryRoots:\n${serializeRegistryRoots()}\n`);

  for (const rel of EXTRA_TRACE_INPUT_FILES) {
    try {
      const content = await readFile(join(projectRoot, rel));
      hash.update(`file:${rel}=${createHash('sha256').update(content).digest('hex')}\n`);
    } catch {
      hash.update(`file:${rel}=<absent>\n`);
    }
  }

  return hash.digest('hex');
}
