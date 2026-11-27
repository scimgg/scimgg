import { beforeAll, describe, expect, it } from 'vitest';
import { hasAttackReach } from '../../core/combat/distance';
import { ZULRAH_SPOTS } from '../../encounters/zulrah/rotation';
import { getDefaultLoadout } from '../../hooks/encounterLoadoutStorage';
import { ZULRAH_SIZE } from '../../npcs/zulrah/constants';
import { loadCacheLoaders, skipWithoutRealCache } from '../../test/helpers/real-cache';
import { loadItemStats } from '../../types/equipmentStats';
import type { Coordinate } from '../../types/simulation';
import { findEquipmentCatalogItem } from '../equipmentCatalog';
import { describeWeaponVerificationGaps } from '../equipmentSupport';
import { findInventoryItem } from '../inventoryItemCatalog';
import { EQUIPMENT_PRESETS } from '../playerPresets';

const NOXIOUS_HALBERD = 29796;
const RING_OF_SUFFERING_RI = 20657;

/** Island tiles from the cache geometry (`rotation.ts`): base y 60-63, arms x 22-24 and 32-34 up to y 70. */
function islandTiles(): Coordinate[] {
  const tiles: Coordinate[] = [];
  for (let x = 22; x <= 34; x++) for (let y = 60; y <= 63; y++) tiles.push([x, y]);
  for (const [minX, maxX] of [
    [22, 24],
    [32, 34],
  ])
    for (let x = minX; x <= maxX; x++) for (let y = 64; y <= 70; y++) tiles.push([x, y]);
  return tiles;
}

describe('Zulrah loadouts', () => {
  const presets = EQUIPMENT_PRESETS.zulrah;

  const REAL_KEYS = ['max_noxious', 'max_hybrid', 'void_hybrid', 'magic_only', 'ranged_bowfa', 'ranged_tbow'] as const;

  it('offers the wiki loadouts, the noxious halberd set first so it is the default, then the fallback', () => {
    expect(Object.keys(presets)).toEqual([...REAL_KEYS, 'naked']);
    expect(getDefaultLoadout('zulrah').equipment.weapon).toBe(NOXIOUS_HALBERD);
  });

  it.each(REAL_KEYS)('%s has cataloged gear, inventory and supplies, a verified weapon, and fits 28 slots', (key) => {
    const preset = presets[key];
    expect(preset.inventory).toHaveLength(28);
    const weapon = preset.equipment.weapon;
    if (weapon === undefined) throw new Error('No weapon');
    expect(describeWeaponVerificationGaps(weapon).filter((gap) => /unarmed|Not checked/.test(gap))).toEqual([]);
    for (const [slot, id] of Object.entries(preset.equipment)) {
      expect(findEquipmentCatalogItem(id as number), `equipment ${slot} (${id})`).toBeDefined();
    }
    for (const item of preset.inventory) {
      if (item) expect(findInventoryItem(item.id) ?? findEquipmentCatalogItem(item.id), `${item.id}`).toBeDefined();
    }
    for (const supply of [
      preset.supplies?.equippedAmmo,
      preset.supplies?.quiverAmmo,
      preset.supplies?.blowpipe,
      ...(preset.supplies?.runePouch?.slots ?? []),
    ]) {
      if (supply) expect(findInventoryItem(supply.id) ?? findEquipmentCatalogItem(supply.id)).toBeDefined();
    }
    for (const [stat, required] of Object.entries(preset.requirements ?? {})) {
      expect(required, `requires ${required} ${stat}`).toBeLessThanOrEqual(99);
    }
  });

  it('wears the ring of suffering in the melee set, with the Bellator ring carried', () => {
    expect(presets.max_noxious.equipment.ring).toBe(RING_OF_SUFFERING_RI);
    expect(presets.max_noxious.inventory.some((slot) => slot?.id === 28316)).toBe(true);
  });

  describe.skipIf(skipWithoutRealCache('pinned'))('against the pinned cache', () => {
    let range = 0;
    beforeAll(async () => {
      range = loadItemStats(NOXIOUS_HALBERD, (await loadCacheLoaders('pinned')).objTypeLoader).attackRange;
    }, 120_000);

    it('reaches Zulrah at every spot from the island with the halberd', () => {
      expect(range).toBe(2);
      // Line of sight ignores floor-blocked water, so reach over it is pure distance.
      for (const [spot, position] of Object.entries(ZULRAH_SPOTS)) {
        const reachable = islandTiles().some(([x, y]) =>
          hasAttackReach(x, y, position[0], position[1], ZULRAH_SIZE, range),
        );
        expect(reachable, spot).toBe(true);
      }
    });
  });
});
