import { beforeAll, describe, expect, it } from 'vitest';
import { isInAttackRange } from '../../core/combat/distance';
import { zulrahIslandTiles } from '../../encounters/zulrah/constants';
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

/** The island's walkable tiles, checked against the pinned cache's bake (`zulrahArenaSight.test.ts`). */
const ISLAND: readonly Coordinate[] = [...zulrahIslandTiles()].map((key) => {
  const [x, y] = key.split(',').map(Number);
  return [x ?? 0, y ?? 0];
});

/** Whether a player on some island tile reaches Zulrah at `position`, by the check combat uses. */
function reachesFromIsland(position: Coordinate, range: number, meleeReach: 'cardinal' | 'diagonal'): boolean {
  return ISLAND.some((tile) => isInAttackRange(tile, position, ZULRAH_SIZE, range, true, meleeReach));
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

  // The project owner: "only range 2 reaches zulrah not range 1". Without the cache's collision the
  // reach check is distance only; the water between the island and Zulrah blocks no projectile.
  it.each(
    Object.entries(ZULRAH_SPOTS),
  )('is reached at the %s spot from the island at range 2, never at range 1', (_spot, position) => {
    expect(ISLAND).toHaveLength(69);
    expect(reachesFromIsland([...position], 2, 'cardinal')).toBe(true);
    expect(reachesFromIsland([...position], 1, 'cardinal')).toBe(false);
    expect(reachesFromIsland([...position], 1, 'diagonal')).toBe(false);
  });

  describe.skipIf(skipWithoutRealCache('pinned'))('against the pinned cache', () => {
    let range = 0;
    beforeAll(async () => {
      range = loadItemStats(NOXIOUS_HALBERD, (await loadCacheLoaders('pinned')).objTypeLoader).attackRange;
    }, 120_000);

    it('gives the halberd the range that reaches Zulrah', () => {
      expect(range).toBe(2);
    });
  });
});
