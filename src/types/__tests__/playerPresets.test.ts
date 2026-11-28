import { describe, expect, it } from 'vitest';
import { findEquipmentCatalogItem, getCanonicalEquipmentItemId } from '../../data/equipmentCatalog';
import { findInventoryItem } from '../../data/inventoryItemCatalog';
import { EQUIPMENT_PRESETS } from '../../data/playerPresets';
import { getDefaultLoadout, normalizeEncounterLoadout } from '../../hooks/encounterLoadoutStorage';
import { ARDER_MUSCA_POISON_ITEM_ID } from '../inventory';

describe('shipped preset equipment coverage', () => {
  it.each(['yama_p3_sensory', 'yama_p3_divine'] as const)('packs the powered sceptre switch for %s', (encounter) => {
    const preset = EQUIPMENT_PRESETS[encounter].mage;
    expect(preset.inventory).toContainEqual({ id: 27665 });
    expect(preset.inventory.some((item) => item?.id === 27679 || item?.id === 27676)).toBe(false);
    expect(preset.supplies?.selectedSpell).toBeNull();
    expect(preset.equipment.weapon).toBe(29594); // Keep the opening Purging staff and its supplies.
    expect(preset.supplies?.spellbook).toBe('arceuus');
  });

  it('equips rupture and stores seeking dragon arrows for Max Tbow', () => {
    const preset = EQUIPMENT_PRESETS.zuk.max_tbow;

    expect(preset.equipment.amulet).toBe(33639);
    expect(preset.supplies?.quiverAmmo).toEqual({ id: 33595 });
  });

  it('shares the Inferno presets with waves, defaulting to Max Tbow', () => {
    expect(EQUIPMENT_PRESETS.inferno).toBe(EQUIPMENT_PRESETS.zuk);
    expect(Object.keys(EQUIPMENT_PRESETS.inferno)[0]).toBe('max_tbow');
  });

  it('opens Duke practice with Burning claws and all 28 inventory slots filled', () => {
    const { equipment, inventory } = getDefaultLoadout('duke_practice');

    expect(equipment.weapon).toBe(29577);
    expect(equipment.head).toBe(30750); // Oathplate helm
    expect(equipment.shield).toBeUndefined();
    expect(inventory).toHaveLength(28);
    const names = inventory.map(
      (item) => item && (findInventoryItem(item.id) ?? findEquipmentCatalogItem(item.id))?.name,
    );
    expect(names[0]).toBe('Emberlight');
    expect(names[3]).toBe('Scythe of Vitur');
    expect(names[4]).toBe('Avernic defender');
    expect(names).not.toContain('Saradomin godsword');
    expect(names.filter((name) => name === 'Super combat potion(4)')).toHaveLength(2);
    expect(names.filter((name) => name === 'Super restore(4)')).toHaveLength(5);
    expect(names.filter((name) => name === 'Saradomin brew(4)')).toHaveLength(5);
    expect(names.filter((name) => name === 'Halibut')).toHaveLength(3);
    expect(names.filter((name) => name === 'Anglerfish')).toHaveLength(9);
    expect(names.filter((name) => name === 'Arder-musca poison')).toHaveLength(1);
    const poison = { id: ARDER_MUSCA_POISON_ITEM_ID, quantity: 3 };
    expect(inventory[27]).toEqual(poison);
    expect(normalizeEncounterLoadout({ equipment, inventory }).inventory[27]).toEqual(poison);
  });

  it('can open Duke from every shipped loadout', () => {
    const presets = EQUIPMENT_PRESETS.duke_practice;
    for (const preset of Object.values(presets)) {
      expect(preset.inventory[27], preset.name).toEqual({ id: ARDER_MUSCA_POISON_ITEM_ID, quantity: 3 });
    }
    expect(presets.emberlight.equipment).toMatchObject({ weapon: 29589, shield: 22322 });
    expect(presets.emberlight.inventory).toContainEqual({ id: 29577 });
    expect(presets.scythe.equipment.weapon).toBe(22325);
    expect(presets.scythe.inventory).toContainEqual({ id: 29577 });
  });

  it('resolves every initially equipped slot in all 34 real encounter presets', () => {
    const unresolved: string[] = [];
    let realPresetCount = 0;

    for (const [encounterKey, presets] of Object.entries(EQUIPMENT_PRESETS)) {
      for (const [presetKey, preset] of Object.entries(presets)) {
        if (preset.isFallback) continue;
        realPresetCount += 1;
        for (const [slot, itemId] of Object.entries(preset.equipment)) {
          if (itemId !== undefined && findEquipmentCatalogItem(itemId) === undefined) {
            unresolved.push(`${encounterKey}.${presetKey}.${slot}:${itemId}`);
          }
        }
      }
    }

    expect(realPresetCount).toBe(34);
    expect(unresolved).toEqual([]);
  });

  it('omits stack counts for unlimited supplies', () => {
    const counted: string[] = [];
    for (const [encounterKey, presets] of Object.entries(EQUIPMENT_PRESETS)) {
      for (const [presetKey, preset] of Object.entries(presets)) {
        preset.inventory.forEach((slot, index) => {
          if (slot?.quantity !== undefined && slot.id !== ARDER_MUSCA_POISON_ITEM_ID) {
            counted.push(`${encounterKey}.${presetKey}[${index}]:${slot.id}`);
          }
        });
      }
    }

    expect(counted).toEqual([]);
  });

  it.each([
    {
      label: 'Atlatl',
      itemId: 29000,
      expectedItemId: 29000,
    },
    {
      label: 'Eclipse body',
      itemId: 29031,
      expectedItemId: 29004,
    },
    {
      label: 'Rune crossbow',
      itemId: 9185,
      expectedItemId: 9185,
    },
    {
      label: 'Crystal shield',
      itemId: 23991,
      expectedItemId: 23991,
    },
    {
      label: 'Blowpipe',
      itemId: 12926,
      expectedItemId: 12926,
    },
  ] as const)('resolves the sanctioned Zuk $label switch', ({ itemId, expectedItemId }) => {
    expect(findEquipmentCatalogItem(itemId)).toBeDefined();
    expect(getCanonicalEquipmentItemId(itemId)).toBe(expectedItemId);
  });
});
