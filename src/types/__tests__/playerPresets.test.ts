import { describe, expect, it } from 'vitest';
import { findEquipmentCatalogItem, getCanonicalEquipmentItemId } from '../../data/equipmentCatalog';
import { EQUIPMENT_PRESETS } from '../../data/playerPresets';

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

  it('resolves every initially equipped slot in all 37 real encounter presets', () => {
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

    expect(realPresetCount).toBe(37);
    expect(unresolved).toEqual([]);
  });

  it('carries no inventory stack counts, since stacks never deplete', () => {
    const counted: string[] = [];
    for (const [encounterKey, presets] of Object.entries(EQUIPMENT_PRESETS)) {
      for (const [presetKey, preset] of Object.entries(presets)) {
        preset.inventory.forEach((slot, index) => {
          if (slot && slot.quantity !== undefined) counted.push(`${encounterKey}.${presetKey}[${index}]:${slot.id}`);
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
