import { beforeAll, describe, expect, it } from 'vitest';
import {
  COLOSSEUM_MODIFIER_CACHE_KEYS,
  COLOSSEUM_MODIFIER_IDS,
  COLOSSEUM_MODIFIERS,
  type ColosseumModifierId,
} from '../../src/encounters/colosseum/modifiers/definitions';
import type { CacheInfo } from '../../src/rs/cache/CacheInfo';
import { CacheSystem } from '../../src/rs/cache/CacheSystem';
import { Bzip2 } from '../../src/rs/compression/Bzip2';
import { ArchiveEnumTypeLoader } from '../../src/rs/config/enumtype/EnumTypeLoader';
import { ArchiveStructTypeLoader } from '../../src/rs/config/structtype/StructTypeLoader';
import { readCacheZipFiles } from '../../src/test/helpers/cacheZipFiles';
import { setupOutputPath, skipWithoutSetup } from '../../src/test/helpers/setupAssets';
import { readSpriteManifest } from '../assets/generateSprites';
import { SpriteSource } from '../assets/spriteRecipes';

/** The intermission's modifier list: one struct per modifier, keyed as `COLOSSEUM_MODIFIER_CACHE_KEYS`. */
const MODIFIER_ENUM = 5312;
/** Tier I's icons. The intermission picks enum 5364's entry for the owned tier, keyed by param 1914. */
const TIER_ONE_ICON_ENUM = 5360;
const ICON_PARAM = 1914;

const iconPath = (id: ColosseumModifierId) => `modifier-${id.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}.png`;

describe.skipIf(skipWithoutSetup('fullCache'))('Colosseum modifier icons, on the pinned cache', () => {
  let enums: ArchiveEnumTypeLoader;
  let structs: ArchiveStructTypeLoader;
  let sprites: SpriteSource;

  beforeAll(async () => {
    await Bzip2.initWasm();
    const cache = CacheSystem.fromMap('dat2', await readCacheZipFiles(setupOutputPath('fullCache')), [2, 8]);
    const info: CacheInfo = {
      name: 'osrs',
      game: 'oldschool',
      environment: 'live',
      revision: 242,
      timestamp: '',
      size: 0,
    };
    enums = new ArchiveEnumTypeLoader(info, cache.getIndex(2).getArchive(8));
    structs = new ArchiveStructTypeLoader(info, cache.getIndex(2).getArchive(34));
    sprites = new SpriteSource(cache.getIndex(8));
  }, 120_000);

  it("draws every modifier's tier I icon from the sprite the intermission shows, cropped to its pixels", () => {
    const modifiers = enums.load(MODIFIER_ENUM);
    const icons = enums.load(TIER_ONE_ICON_ENUM);
    const recipes = new Map(readSpriteManifest().sprites.map((recipe) => [recipe.path, recipe]));

    for (const id of COLOSSEUM_MODIFIER_IDS) {
      const struct = structs.load(modifiers.intValues[modifiers.keys.indexOf(COLOSSEUM_MODIFIER_CACHE_KEYS[id])]!);
      const iconKey = struct.params.get(ICON_PARAM) as number;
      const sprite = icons.intValues[icons.keys.indexOf(iconKey)]!;
      const frame = sprites.frame(sprite, 0);
      const recipe = recipes.get(`public/assets/encounters/${iconPath(id)}`);
      expect(recipe, id).toEqual({
        path: `public/assets/encounters/${iconPath(id)}`,
        // Every one of these frames is opaque to its canvas edges, so the canvas is the crop.
        size: [frame.width, frame.height],
        layers: [{ sprite, frame: 0, at: [0, 0] }],
      });
      for (const edge of [0, frame.width - 1]) {
        expect([...Array(frame.height).keys()].some((y) => frame.rgba[(y * frame.width + edge) * 4 + 3] !== 0)).toBe(
          true,
        );
      }
      for (const edge of [0, frame.height - 1]) {
        expect([...Array(frame.width).keys()].some((x) => frame.rgba[(edge * frame.width + x) * 4 + 3] !== 0)).toBe(
          true,
        );
      }
    }
  });

  it('names those files from the modifier definitions that show an icon', () => {
    for (const modifier of COLOSSEUM_MODIFIERS) {
      if (modifier.icon !== undefined) expect(modifier.icon).toBe(`/assets/encounters/${iconPath(modifier.id)}`);
    }
  });
});
