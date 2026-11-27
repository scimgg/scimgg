import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  collectDeclaredNpcSeqIds,
  collectDeclaredSpotAnimIds,
  ENCOUNTER_RENDER_CONFIGS,
} from '../../src/encounters/renderConfigs';
import { COLOSSEUM_SPOTANIMS } from '../../src/npcs/colosseum/constants';
import { type CacheRoots, collectCacheRoots } from '../cacheRoots';
import { discoverCacheUsage } from '../discoverCacheUsage';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

type IdKind = 'spotAnims' | 'seqs' | 'npcs' | 'items' | 'locs' | 'sprites';

/**
 * A field that names a cache id by this codebase's conventions: it ends in Id/Ids/Graphic/
 * Spotanim/Animation/Seq, and its other words say which kind. Anything else (`actorId`,
 * `frameId`, bare `id`) is not classified, so the guard ignores it.
 */
function fieldKind(name: string): IdKind | null {
  if (!/(?:Id|Ids|Graphic|Graphics|Spotanim|SpotAnim|Animation|Seq)$/i.test(name)) return null;
  if (/spot_?anim|graphic|gfx|projectile/i.test(name)) return 'spotAnims';
  if (/seq|anim/i.test(name)) return 'seqs';
  if (/npc/i.test(name)) return 'npcs';
  if (/item/i.test(name)) return 'items';
  if (/loc/i.test(name)) return 'locs';
  if (/sprite/i.test(name)) return 'sprites';
  return null;
}

/** `name: 123` or `name: [1, 2]` with no nested objects. Comments are blanked first. */
const ID_FIELD = /\b([A-Za-z_]\w*)\s*:\s*(\[[^\]\n{]*\]|\d+)(?![\w.])/g;

/**
 * Fields that look like cache ids but are not, as `<src-relative file>:<field>` -> reason. Add an
 * entry only when the value really is not a cache id; a real id belongs in the registry walk.
 */
const NOT_CACHE_IDS: Readonly<Record<string, string>> = {};

function rooted(roots: CacheRoots, kind: IdKind, id: number): boolean {
  return kind === 'items' ? roots.wornItems.has(id) || roots.droppedItems.has(id) : roots[kind].has(id);
}

/** Every id-named field literal in `text` whose id the roots do not reach, as `file:line field=id`. */
function findUnrootedIdFields(file: string, text: string, roots: CacheRoots): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) => comment.replace(/[^\n]/g, ' '));
  const found: string[] = [];
  for (const match of code.matchAll(ID_FIELD)) {
    const [, field, value] = match;
    const kind = fieldKind(field);
    if (!kind || NOT_CACHE_IDS[`${file}:${field}`]) continue;
    for (const digits of value.match(/(?<![\w.-])\d+(?![\w.])/g) ?? []) {
      if (rooted(roots, kind, Number(digits))) continue;
      const line = code.slice(0, match.index).split('\n').length;
      found.push(`${file}:${line} ${field}=${digits} (${kind})`);
    }
  }
  return found;
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== '__mocks__') yield* sourceFiles(full);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(?:test|spec)\.tsx?$|\.d\.ts$/.test(entry.name)) {
      yield full;
    }
  }
}

let roots: CacheRoots;

beforeAll(async () => {
  roots = collectCacheRoots(await discoverCacheUsage(REPO_ROOT));
}, 60000);

describe('collectCacheRoots', () => {
  it('roots every render config spot animation without source discovery', () => {
    const registryRoots = collectCacheRoots();
    for (const [kind, config] of ENCOUNTER_RENDER_CONFIGS) {
      for (const id of config.spotAnimIds ?? []) {
        expect(registryRoots.spotAnims.has(id), `${kind} render config spotAnimIds: ${id}`).toBe(true);
      }
    }
    // The primary NPCs' death effects too, and each config's effects, Sol's included, which are no
    // `SpotAnimID` members: the same list the scene preloads and frame-sound extraction walks.
    const declared = collectDeclaredSpotAnimIds();
    expect(declared.size).toBeGreaterThan(0);
    for (const [id, label] of declared) expect(registryRoots.spotAnims.has(id), label).toBe(true);
    expect(declared.get(COLOSSEUM_SPOTANIMS.totemImpact)).toBe('sol_heredit render config spotAnimIds');
  });

  it('roots every NPC type and NPC sequence the render configs make the scene load', () => {
    const registryRoots = collectCacheRoots();
    for (const [kind, config] of ENCOUNTER_RENDER_CONFIGS) {
      const npcTypeIds = [
        config.primaryNpc?.npcTypeId,
        ...(config.preloadNpcTypes ?? []).map((type) => type.npcTypeId),
      ];
      for (const id of npcTypeIds.filter((id) => id !== undefined))
        expect(registryRoots.npcs.has(id), `${kind} npc ${id}`).toBe(true);
    }
    for (const [seqId, label] of collectDeclaredNpcSeqIds()) expect(registryRoots.seqs.has(seqId), label).toBe(true);
  });

  it('roots the Surge potion drink graphic in its item action (the 3232 production gap)', () => {
    // Surge declares its graphic through withPlayerGraphic(chain, 3232), which no source pattern sees.
    expect(roots.spotAnims.get(3232)).toMatch(/^ITEM_ACTIONS\[\d+\]\.playerGraphic$/);
  });

  it('roots the lobby bosses and the lobby map square with its terrain ring', () => {
    for (const npcTypeId of [7706, 14176, 12821]) expect(roots.npcs.has(npcTypeId)).toBe(true);
    expect(roots.mapSquares.has('25,73')).toBe(true);
    expect(roots.mapSquares.has('24,72')).toBe(true);
  });

  it('roots every wearable catalog item, including a variant whose models come from its base', () => {
    expect(roots.wornItems.get(25736)).toBe('equipment catalog 25736');
  });
});

/**
 * A maintenance guard, not a proof of coverage: an id-named field literal anywhere in src/ must be
 * an id the roots reach, so new id-bearing data has to be walked by collectCacheRoots (or exempted).
 * It cannot see ids passed as call arguments (`withPlayerGraphic(chain, 3232)`), positional tuples,
 * bare `id:` fields, computed ids, JSON, object keys, or fields named outside its vocabulary, and an
 * unrooted id that happens to equal a rooted one of the same kind passes.
 */
describe('id-bearing fields in src/ are reached by the cache roots', () => {
  it('flags an id field the roots do not reach', () => {
    const fixture = `export const NEW_REGISTRY = { 1: { castGraphic: 999999, idleSeqId: 999998, npcTypeIds: [999997] } };`;

    expect(findUnrootedIdFields('src/data/newRegistry.ts', fixture, roots)).toEqual([
      'src/data/newRegistry.ts:1 castGraphic=999999 (spotAnims)',
      'src/data/newRegistry.ts:1 idleSeqId=999998 (seqs)',
      'src/data/newRegistry.ts:1 npcTypeIds=999997 (npcs)',
    ]);
  });

  it('ignores heights, delays, comments and non-id fields', () => {
    const fixture = `const X = { castSpotanimHeight: 92, delayCycles: 999999, actorId: 5 }; // hitSpotanimId: 999999`;

    expect(findUnrootedIdFields('src/data/x.ts', fixture, roots)).toEqual([]);
  });

  it('finds none in the current source tree', () => {
    const unrooted: string[] = [];
    for (const file of sourceFiles(path.join(REPO_ROOT, 'src'))) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
      unrooted.push(...findUnrootedIdFields(rel, readFileSync(file, 'utf8'), roots));
    }

    // Each entry is a cache id production would not ship. Read it in scripts/cacheRoots.ts from the
    // registry that declares it, or, if it is not a cache id, add it to NOT_CACHE_IDS with a reason.
    expect(unrooted).toEqual([]);
  });

  it('keeps every NOT_CACHE_IDS entry pointing at a file that exists', () => {
    for (const key of Object.keys(NOT_CACHE_IDS)) {
      expect(() => readFileSync(path.join(REPO_ROOT, key.slice(0, key.lastIndexOf(':'))))).not.toThrow();
    }
  });
});
