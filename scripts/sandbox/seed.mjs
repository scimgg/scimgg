// Checks the sandbox's seed data and copies it into a snapshot, so `npm run setup -- --offline`, the
// tests and the build run with no network (see ../../sandbox). It runs in a no-network container
// from a read-only mount, before any of the snapshot's code in that container, and reads the
// snapshot's files only as data. The seed directory is described in seedData.mjs.
//
//   node seed.mjs check     reports what the tree needs and the seeds lack; exits 3 if anything is
//                           missing (`./sandbox seed` fetches it)
//   node seed.mjs assets    copies the item icons and healthbars into the tree and links its pinned
//                           cache into .setup-cache/, where setup looks before downloading
import { copyFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { blobFile, cacheFile, healthbars, itemIcons, pinnedCache, sha256File } from './seedData.mjs';

const WORK = '/work';

const log = (message) => console.log(`[sandbox-seed] ${message}`);

function check() {
  const missing = [];
  const pinned = pinnedCache(WORK);
  if (!pinned) {
    missing.push('scripts/pinnedCache.ts names no pinned cache this script can read');
  } else if (!existsSync(cacheFile(pinned.id))) {
    missing.push(`the pinned game cache ${pinned.id} (about 200 MB)`);
  } else if (sha256File(cacheFile(pinned.id)) !== pinned.sha256) {
    missing.push(`the pinned game cache ${pinned.id}: the saved copy does not match its pin`);
  }
  const icons = itemIcons(WORK);
  const absent = icons.pinned.filter(([, pin]) => !existsSync(blobFile(pin))).length;
  if (absent > 0) missing.push(`${absent} item icon(s) matching the tree's pins (about 4 KB each)`);
  if (icons.unpinned.length > 0) log(`note: ${icons.unpinned.length} item icon(s) have no pin; setup decides`);
  const bars = healthbars(WORK);
  const barsAbsent = bars ? bars.files.filter(([, pin]) => !existsSync(blobFile(pin))).length : 0;
  if (barsAbsent > 0) missing.push(`${barsAbsent} RuneLite healthbar(s)`);
  for (const item of missing) console.error(`[sandbox-seed] missing: ${item}`);
  process.exit(missing.length > 0 ? 3 : 0);
}

/** Copies pinned blobs to `dir/<name>` for each `[name, pin]`. Returns how many were copied. */
function copyBlobs(entries, dir) {
  mkdirSync(dir, { recursive: true });
  let copied = 0;
  for (const [name, pin] of entries) {
    if (!existsSync(blobFile(pin))) continue;
    copyFileSync(blobFile(pin), path.join(dir, name));
    copied++;
  }
  return copied;
}

function assets() {
  const icons = itemIcons(WORK).pinned.map(([id, pin]) => [`${id}.png`, pin]);
  log(`item icons: ${copyBlobs(icons, path.join(WORK, 'public/assets/items'))} copied into public/assets/items/`);
  const bars = healthbars(WORK);
  if (bars) {
    const copied = copyBlobs(bars.files, path.join(WORK, 'public/assets/ui/healthbar'));
    log(`healthbars: ${copied} copied into public/assets/ui/healthbar/`);
  }
  const pinned = pinnedCache(WORK);
  if (!pinned || !existsSync(cacheFile(pinned.id))) {
    throw new Error('[sandbox-seed] the pinned cache is missing; run ./sandbox seed');
  }
  // A link into the read-only seed, so the 200 MB cache is not copied into every snapshot. Setup
  // checks its size and SHA-256 against the pin before using it.
  const dest = path.join(WORK, '.setup-cache', `openrs2-${pinned.id}-disk.zip`);
  mkdirSync(path.dirname(dest), { recursive: true });
  if (!existsSync(dest)) symlinkSync(cacheFile(pinned.id), dest);
  log(`pinned cache ${pinned.id}: .setup-cache/ links the read-only seed`);
}

const [command] = process.argv.slice(2);
if (command === 'check') check();
else if (command === 'assets') assets();
else {
  console.error('Usage: node seed.mjs check | assets');
  process.exit(64);
}
