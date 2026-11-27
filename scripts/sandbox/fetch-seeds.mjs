// `./sandbox seed`: the trusted downloads a fresh machine needs before a tree can run offline (see
// ../../sandbox). It runs in a sandbox container that has network, with the target tree mounted
// read-only as data: nothing from the tree is executed or imported. It fetches only what the tree
// pins, only from archive.openrs2.org, static.runelite.net and RuneLite's repository on
// raw.githubusercontent.com, checks every file against its pin before saving it, and writes only
// into the seed directory mounted read-write at /seed (layout in seedData.mjs).
//
//   node fetch-seeds.mjs [--test-cache]
//
// It fetches the pinned game cache, the item icons and the RuneLite healthbars; --test-cache also
// fetches the golden real-cache test fixture, which some suites need and skip without.
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import {
  BLOBS_DIR,
  blobFile,
  cacheFile,
  goldenTestCache,
  HEALTHBAR_PATH,
  healthbars,
  itemIcons,
  pinnedCache,
  sha256,
  sha256File,
  TEST_CACHE,
} from './seedData.mjs';

const WORK = '/work';
const OPENRS2 = 'https://archive.openrs2.org';
const ICONS = 'https://static.runelite.net/cache/item/icon';
const RUNELITE_RAW = 'https://raw.githubusercontent.com/runelite/runelite';
const ALLOWED = [
  { host: 'archive.openrs2.org', path: '/' },
  { host: 'static.runelite.net', path: '/cache/item/icon/' },
  { host: 'raw.githubusercontent.com', path: '/runelite/runelite/' },
];
const ATTEMPTS = 3;
const TIMEOUT_MS = 60_000;
/** The tree mirrors about 5,300; a list far longer is not a real manifest. */
const MAX_ICONS = 50_000;

const log = (message) => console.log(`[sandbox-seed] ${message}`);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

/** GETs `url` into memory, following redirects only within the allowed hosts and paths. */
function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const { hostname, pathname, protocol } = new URL(url);
    if (protocol !== 'https:' || !ALLOWED.some((a) => a.host === hostname && pathname.startsWith(a.path))) {
      reject(new Error(`refusing to fetch ${url}`));
      return;
    }
    const req = https.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        resolve(get(new URL(res.headers.location, url).href, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`timed out fetching ${url}`)));
    req.on('error', reject);
  });
}

async function getPinned(url, pin) {
  for (let attempt = 1; ; attempt++) {
    try {
      const bytes = await get(url);
      if (sha256(bytes) !== pin) throw new Error(`${url} does not match its pin ${pin}`);
      return bytes;
    } catch (err) {
      if (attempt >= ATTEMPTS) throw err;
    }
  }
}

function writeAtomically(file, bytes) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.partial-${process.pid}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, file);
}

/** Downloads a game cache archive unless a copy matching its pin is already there. */
async function fetchCache(url, file, pin, what) {
  if (existsSync(file) && sha256File(file) === pin) return log(`${what}: already saved`);
  log(`${what}: downloading ${url} (about 200 MB)`);
  const bytes = await getPinned(url, pin);
  writeAtomically(file, bytes);
  log(`${what}: saved ${mb(bytes.length)}, matching its pin`);
}

/** Downloads each `[url, pin]` whose blob is missing, eight at a time. */
async function fetchBlobs(what, entries) {
  const todo = entries.filter(([, pin]) => !existsSync(blobFile(pin)));
  if (todo.length === 0) return log(`${what}: all ${entries.length} present`);
  log(`${what}: downloading ${todo.length} of ${entries.length}`);
  mkdirSync(BLOBS_DIR, { recursive: true });
  const failed = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < todo.length) {
      const [url, pin] = todo[next++];
      try {
        writeAtomically(blobFile(pin), await getPinned(url, pin));
      } catch (err) {
        failed.push(err instanceof Error ? err.message : String(err));
      }
      if (++done % 500 === 0) log(`${what}: ${done}/${todo.length}`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  if (failed.length > 0) {
    throw new Error(`${failed.length} of the ${what} not fetched:\n  ${failed.slice(0, 10).join('\n  ')}`);
  }
  log(`${what}: ${todo.length} saved`);
}

async function main(flags) {
  const pinned = pinnedCache(WORK);
  if (!pinned) throw new Error('scripts/pinnedCache.ts names no pinned cache this script can read');
  const url = `${OPENRS2}/caches/runescape/${pinned.id}/disk.zip`;
  await fetchCache(url, cacheFile(pinned.id), pinned.sha256, `pinned game cache ${pinned.id}`);

  const icons = itemIcons(WORK);
  if (icons.pinned.length > MAX_ICONS) {
    throw new Error(`the tree lists ${icons.pinned.length} item icons; refusing more than ${MAX_ICONS}`);
  }
  await fetchBlobs(
    'item icons',
    icons.pinned.map(([id, pin]) => [`${ICONS}/${id}.png`, pin]),
  );
  if (icons.unpinned.length > 0) log(`item icons: ${icons.unpinned.length} have no pin and were skipped`);

  const bars = healthbars(WORK);
  if (bars) {
    await fetchBlobs(
      'healthbars',
      bars.files.map(([name, pin]) => [`${RUNELITE_RAW}/${bars.commit}/${HEALTHBAR_PATH}/${name}`, pin]),
    );
  }

  if (flags.includes('--test-cache')) {
    const golden = goldenTestCache(WORK);
    if (!golden) log('test cache: the tree names no pinned golden cache; skipped');
    else {
      const testUrl = `${OPENRS2}/caches/runescape/${golden.id}/disk.zip`;
      await fetchCache(testUrl, TEST_CACHE, golden.sha256, `golden test cache ${golden.id}`);
    }
  }
}

try {
  await main(process.argv.slice(2));
  log('done');
} catch (err) {
  console.error(`[sandbox-seed] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
