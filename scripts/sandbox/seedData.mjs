// What a tree needs from the sandbox's seed directory, shared by seed.mjs (which checks and copies
// it, offline) and fetch-seeds.mjs (which downloads what is missing). See ../../sandbox. It reads
// the tree's files only as data, with a regular expression or JSON.parse, never an import.
//
// The seed directory, mounted at /seed:
//   cache/<id>-disk.zip   OpenRS2 game caches, checked against the tree's pin
//   blobs/<sha256>        small pinned files (item icons, healthbars), named by their SHA-256, so
//                         trees that pin different bytes for the same icon never collide
//   test-cache/disk.zip   the golden real-cache test fixture, when fetched with --test-cache
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const SEED = '/seed';
export const BLOBS_DIR = path.join(SEED, 'blobs');
export const TEST_CACHE = path.join(SEED, 'test-cache', 'disk.zip');

/** Healthbars are fetched from this path of RuneLite's repository, at the commit the tree pins. */
export const HEALTHBAR_PATH =
  'runelite-client/src/main/resources/net/runelite/client/plugins/interfacestyles/2010/healthbar';

const SHA256 = /^[0-9a-f]{64}$/;

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(file) {
  return sha256(readFileSync(file));
}

function readIfPresent(work, file) {
  const full = path.join(work, file);
  return existsSync(full) ? readFileSync(full, 'utf-8') : null;
}

export function cacheFile(id) {
  return path.join(SEED, 'cache', `${id}-disk.zip`);
}

export function blobFile(pin) {
  return path.join(BLOBS_DIR, pin);
}

/** The tree's pinned game cache (scripts/pinnedCache.ts), or null if it names none. */
export function pinnedCache(work) {
  const source = readIfPresent(work, 'scripts/pinnedCache.ts');
  const id = source?.match(/PINNED_CACHE\s*=\s*\{\s*id:\s*(\d+)/)?.[1];
  const pin = source?.match(/diskZipSha256:\s*'([0-9a-f]{64})'/)?.[1];
  return id && pin ? { id: Number(id), sha256: pin } : null;
}

/** Item icons the tree mirrors (scripts/item-icon-manifest.json): `[id, sha256]` pairs, and the ids without a pin. */
export function itemIcons(work) {
  const json = readIfPresent(work, 'scripts/item-icon-manifest.json');
  if (!json) return { pinned: [], unpinned: [] };
  const manifest = JSON.parse(json);
  const pins = manifest.sha256 && typeof manifest.sha256 === 'object' ? manifest.sha256 : {};
  const ids = new Set(
    [...(Array.isArray(manifest.mirrored) ? manifest.mirrored : []), ...Object.keys(pins)]
      .map(String)
      .filter((id) => /^\d+$/.test(id)),
  );
  const pinned = [];
  const unpinned = [];
  for (const id of ids) {
    if (SHA256.test(pins[id] ?? '')) pinned.push([id, pins[id]]);
    else unpinned.push(id);
  }
  return { pinned, unpinned };
}

/** RuneLite's healthbars (scripts/assets/runeliteHealthbars.ts): the pinned commit and `[name, sha256]` pairs. */
export function healthbars(work) {
  const source = readIfPresent(work, 'scripts/assets/runeliteHealthbars.ts');
  const commit = source?.match(/RUNELITE_COMMIT\s*=\s*'([0-9a-f]{40})'/)?.[1];
  const block = source?.match(/HEALTHBAR_PINS[^=]*=\s*\{([^}]*)\}/)?.[1] ?? '';
  const files = [...block.matchAll(/'([a-z0-9_]+\.png)':\s*'([0-9a-f]{64})'/g)].map((m) => [m[1], m[2]]);
  return commit && files.length > 0 ? { commit, files } : null;
}

/** The golden real-cache test fixture (src/test/helpers/real-cache.ts) and its pin, if the tree has both. */
export function goldenTestCache(work) {
  const id = readIfPresent(work, 'src/test/helpers/real-cache.ts')?.match(/OPENRS2_CACHE_ID\s*=\s*(\d+)/)?.[1];
  const goldens = readIfPresent(work, 'src/render/environment/__tests__/animatedLocDrawGoldens.json');
  const pin = goldens ? JSON.parse(goldens)?.cache?.sha256 : undefined;
  return id && SHA256.test(pin ?? '') ? { id: Number(id), sha256: pin } : null;
}
