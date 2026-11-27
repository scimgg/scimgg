/**
 * Regenerates public/assets/encounters/inferno-arena-map.webp: the Inferno arena's level-0 terrain
 * (map square 35,83), top down and north up, colored by the minimap's own rules
 * (src/components/minimapTerrain.ts), over the tiles and scale `INFERNO_ARENA_MAP_IMAGE` declares.
 *
 * `npm run setup` runs it from the pinned full cache. Standalone:
 *   npx tsx scripts/generate-inferno-arena-map.mts [path/to/disk.zip] [--preview out.png]
 * The cache defaults to the pinned one setup downloads (`FULL_CACHE_ZIP`); the trimmed
 * public/osrs-cache mirror lacks the map payloads.
 *
 * Public-asset hardening: a lossless, metadata-free WebP of terrain pixels only (sharp writes no
 * EXIF/XMP/ICC unless asked), copied to dist as-is.
 */
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  blendUnderlays,
  buildOverlayMinimapHsls,
  computeTileLights,
  drawMapSquareTerrain,
} from '../src/components/minimapTerrain';
import { INFERNO_ARENA_MAP_IMAGE } from '../src/encounters/inferno/arenaMapImage';
import { INFERNO_MAP_SQUARE } from '../src/encounters/inferno/constants';
import type { CacheInfo } from '../src/rs/cache/CacheInfo';
import { CacheSystem } from '../src/rs/cache/CacheSystem';
import { IndexType } from '../src/rs/cache/IndexType';
import { Bzip2 } from '../src/rs/compression/Bzip2';
import { ArchiveOverlayTypeLoader, ArchiveUnderlayTypeLoader } from '../src/rs/config/flotype/FloTypeLoader';
import { MAP_SQUARE_SIZE, MapLoader } from '../src/rs/map/MapLoader';
import { SpriteTextureLoader } from '../src/rs/texture/SpriteTextureLoader';
import { readCacheZipFiles } from '../src/test/helpers/cacheZipFiles';
import { FULL_CACHE_ZIP, PINNED_CACHE } from './pinnedCache';

const UNDERLAY_ARCHIVE = 1;
const OVERLAY_ARCHIVE = 4;
const LEVEL = 0;
const CACHE_INFO: CacheInfo = {
  name: 'osrs',
  game: 'oldschool',
  environment: 'live',
  revision: PINNED_CACHE.builds[0].major,
  timestamp: PINNED_CACHE.timestamp,
  size: 0,
};

export const INFERNO_ARENA_MAP_PATH = fileURLToPath(
  new URL(`../public${INFERNO_ARENA_MAP_IMAGE.url}`, import.meta.url),
);

/** The arena's terrain as RGBA pixels, `INFERNO_ARENA_MAP_IMAGE.width` x `height`. */
export async function renderInfernoArenaMap(files: Map<string, ArrayBuffer>): Promise<{ rgba: Buffer; blank: number }> {
  await Bzip2.initWasm();
  const { configs, maps, sprites, textures } = IndexType.DAT2;
  const cache = CacheSystem.fromMap('dat2', files, [configs, maps, sprites, textures]);
  const config = cache.getIndex(configs);
  const underlays = new ArchiveUnderlayTypeLoader(CACHE_INFO, config.getArchive(UNDERLAY_ARCHIVE));
  const overlays = new ArchiveOverlayTypeLoader(CACHE_INFO, config.getArchive(OVERLAY_ARCHIVE));
  const textureLoader = SpriteTextureLoader.load(cache.getIndex(textures), cache.getIndex(sprites));
  const mapData = await new MapLoader(cache.getIndex(maps), CACHE_INFO.revision).loadMapSquare(
    INFERNO_MAP_SQUARE.x,
    INFERNO_MAP_SQUARE.y,
  );
  assert.ok(mapData, `Map square ${INFERNO_MAP_SQUARE.x},${INFERNO_MAP_SQUARE.y} has no terrain in the cache`);

  const { bounds, pixelsPerTile, width, height } = INFERNO_ARENA_MAP_IMAGE;
  const pixels = new Uint32Array(width * height);
  drawMapSquareTerrain(
    {
      pixels,
      width,
      height,
      tileScale: pixelsPerTile,
      // Tile x = minX at column 0; the top of tile y = maxY at row 0.
      originX: -bounds.minX * pixelsPerTile,
      originY: -(MAP_SQUARE_SIZE - 1 - bounds.maxY) * pixelsPerTile,
    },
    mapData,
    blendUnderlays(mapData, underlays, LEVEL),
    computeTileLights(mapData, LEVEL),
    buildOverlayMinimapHsls(overlays, textureLoader),
    LEVEL,
  );
  const blank = pixels.filter((pixel) => pixel >>> 24 === 0).length;
  // ABGR words in little-endian memory are RGBA bytes.
  return { rgba: Buffer.from(pixels.buffer), blank };
}

export async function writeInfernoArenaMap(files: Map<string, ArrayBuffer>, previewPath?: string): Promise<void> {
  const { width, height } = INFERNO_ARENA_MAP_IMAGE;
  const { rgba, blank } = await renderInfernoArenaMap(files);
  const raw = { raw: { width, height, channels: 4 } } as const;
  const webp = await sharp(rgba, raw).webp({ lossless: true, effort: 6 }).toBuffer();
  writeFileSync(INFERNO_ARENA_MAP_PATH, webp);
  console.log(`${INFERNO_ARENA_MAP_PATH}: ${width}x${height}, ${webp.length} bytes, ${blank} transparent pixels`);

  if (previewPath) {
    await sharp(rgba, raw)
      .resize(width * 3, height * 3, { kernel: 'nearest' })
      .png()
      .toFile(previewPath);
    console.log(`preview: ${previewPath}`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  const args = process.argv.slice(2);
  const previewAt = args.indexOf('--preview');
  const previewPath = previewAt >= 0 ? args.splice(previewAt, 2)[1] : undefined;
  const zipPath = args[0] ?? FULL_CACHE_ZIP;
  assert.ok(existsSync(zipPath), `No cache at ${zipPath}: run \`npm run setup\`, or pass a full OSRS disk.zip`);
  await writeInfernoArenaMap(await readCacheZipFiles(zipPath), previewPath);
}
