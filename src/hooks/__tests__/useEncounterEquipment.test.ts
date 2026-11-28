// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react';
import { EQUIPMENT_PRESETS } from '../../data/playerPresets';
import { createEmptyCombatSupplies } from '../../types/encounterLoadout';
import { createEmptyInventory } from '../../types/inventory';
import { useEncounterEquipment } from '../useEncounterEquipment';

declare const vi: typeof import('vitest')['vi'];
declare const describe: typeof import('vitest')['describe'];
declare const it: typeof import('vitest')['it'];
declare const expect: typeof import('vitest')['expect'];
declare const beforeEach: typeof import('vitest')['beforeEach'];
declare const afterEach: typeof import('vitest')['afterEach'];

const storageMocks = vi.hoisted(() => ({
  loadSetting: vi.fn(),
  saveSetting: vi.fn(),
}));

vi.mock('../../util/storage', () => ({
  loadSetting: storageMocks.loadSetting,
  saveSetting: storageMocks.saveSetting,
}));

afterEach(() => {
  storageMocks.loadSetting.mockReset();
  storageMocks.saveSetting.mockReset();
});

describe('useEncounterEquipment combat supplies', () => {
  beforeEach(() => {
    storageMocks.loadSetting.mockReset();
    storageMocks.saveSetting.mockReset();
    storageMocks.loadSetting.mockReturnValue({});
  });

  it('normalizes malformed persisted supply fields independently to safe empty values', () => {
    storageMocks.loadSetting.mockReturnValue({
      custom: {
        equipment: { weapon: 20997 },
        inventory: [],
        supplies: {
          equippedAmmo: { id: '11212' },
          quiverAmmo: { id: Number.POSITIVE_INFINITY },
          runePouch: {
            kind: 'standard',
            slots: [{ id: 555, quantity: 9662 }, { id: -1 }, { id: 560 }],
          },
          blowpipe: { id: 'dart' },
          selectedSpell: 123,
        },
      },
    });

    const { result } = renderHook(() => useEncounterEquipment());

    expect(result.current.getSupplies('custom')).toEqual({
      equippedAmmo: null,
      quiverAmmo: null,
      runePouch: {
        kind: 'standard',
        slots: [{ id: 555 }, null, { id: 560 }],
      },
      blowpipe: null,
      selectedSpell: null,
      spellbook: 'arceuus' as const,
    });
  });

  it('clones supplies on set and get and persists the cloned value', async () => {
    const supplies = {
      equippedAmmo: { id: 11212 },
      quiverAmmo: null,
      runePouch: null,
      blowpipe: { id: 11230 },
      selectedSpell: null,
      spellbook: 'arceuus' as const,
    } as const;

    const { result } = renderHook(() => useEncounterEquipment());

    act(() => result.current.setSupplies('zuk', supplies));
    const firstRead = result.current.getSupplies('zuk');
    const secondRead = result.current.getSupplies('zuk');

    expect(firstRead).toEqual(supplies);
    expect(firstRead).not.toBe(supplies);
    expect(firstRead.equippedAmmo).not.toBe(supplies.equippedAmmo);
    expect(firstRead.blowpipe).not.toBe(supplies.blowpipe);
    expect(firstRead).not.toBe(secondRead);
    await waitFor(() => {
      expect(storageMocks.saveSetting).toHaveBeenLastCalledWith(
        'osrs-encounter-equipment',
        expect.objectContaining({ inferno: expect.objectContaining({ supplies }) }),
      );
    });
  });

  it('sets and returns a complete cloned encounter loadout', () => {
    const preset = EQUIPMENT_PRESETS.zuk.atlatl_eclipse;
    const supplies = preset.supplies;
    if (!supplies) throw new Error('Expected Zuk preset supplies');
    const loadout = {
      equipment: preset.equipment,
      inventory: preset.inventory,
      supplies,
    };
    const { result } = renderHook(() => useEncounterEquipment());

    act(() => result.current.setLoadout('zuk', loadout));

    expect(result.current.getLoadout('zuk')).toEqual(loadout);
    expect(result.current.getLoadout('zuk')).not.toBe(loadout);
    expect(result.current.getLoadout('zuk').supplies).not.toBe(loadout.supplies);
  });

  it('keeps the saved Duke loadout after the rename', async () => {
    const { equipment, inventory } = EQUIPMENT_PRESETS.duke.burning_claws;
    const savedInventory = inventory.map((slot, index) => (index === 27 && slot ? { ...slot, quantity: 3 } : slot));
    storageMocks.loadSetting.mockReturnValue({ duke_practice: { equipment, inventory: savedInventory } });

    const { result } = renderHook(() => useEncounterEquipment());

    expect(result.current.getEquipment('duke')).toEqual(equipment);
    expect(result.current.getInventory('duke')).toEqual(inventory);
    await waitFor(() => {
      expect(storageMocks.saveSetting).toHaveBeenLastCalledWith('osrs-encounter-equipment', {
        duke: expect.objectContaining({ equipment, inventory }),
      });
    });
  });

  it('shares one saved loadout between the Inferno and its retired Zuk kind', async () => {
    const preset = EQUIPMENT_PRESETS.inferno.atlatl_eclipse;
    storageMocks.loadSetting.mockReturnValue({
      zuk: { equipment: preset.equipment, inventory: preset.inventory, supplies: preset.supplies },
    });
    const { result } = renderHook(() => useEncounterEquipment());

    expect(result.current.getLoadout('inferno')).toEqual(result.current.getLoadout('zuk'));
    expect(result.current.getEquipment('inferno')).toEqual(preset.equipment);
    // Rewritten once, under the canonical key only.
    await waitFor(() =>
      expect(storageMocks.saveSetting).toHaveBeenLastCalledWith(
        'osrs-encounter-equipment',
        expect.not.objectContaining({ zuk: expect.anything() }),
      ),
    );
    const inventory = createEmptyInventory();
    inventory[0] = { id: 6685 };
    act(() => result.current.setInventory('zuk', inventory));
    expect(result.current.getInventory('inferno')).toEqual(inventory);
  });
});

vi.mock('../../util/storage', () => ({
  loadSetting: storageMocks.loadSetting,
  saveSetting: storageMocks.saveSetting,
}));

describe('useEncounterEquipment', () => {
  const firstYamaPreset = EQUIPMENT_PRESETS.yama_p3['max-mage'];
  const secondYamaPreset = EQUIPMENT_PRESETS.yama_p3.melee;

  beforeEach(() => {
    storageMocks.loadSetting.mockReset();
    storageMocks.saveSetting.mockReset();
    storageMocks.loadSetting.mockReturnValue({});
  });

  it('defaults the Inferno to the first shared preset when nothing is saved', () => {
    const preset = EQUIPMENT_PRESETS.inferno.max_tbow;
    const { result } = renderHook(() => useEncounterEquipment());

    const loadout = result.current.getLoadout('inferno');
    expect(loadout).toEqual({
      equipment: preset.equipment,
      inventory: preset.inventory,
      supplies: preset.supplies,
    });
    expect(loadout.equipment).not.toBe(preset.equipment);
    expect(loadout.inventory).not.toBe(preset.inventory);
    expect(loadout.supplies).not.toBe(preset.supplies);
  });

  it('getEquipment returns stored equipment when it matches a known preset', () => {
    storageMocks.loadSetting.mockReturnValue({
      yama_p3: {
        equipment: secondYamaPreset.equipment,
        inventory: secondYamaPreset.inventory,
      },
    });

    const { result } = renderHook(() => useEncounterEquipment());

    expect(result.current.getEquipment('yama_p3')).toEqual(secondYamaPreset.equipment);
  });

  it('getEquipment preserves custom equipment that does not match any preset', () => {
    const customEquipment = {
      ...secondYamaPreset.equipment,
      weapon: 4151, // Abyssal whip
    };
    storageMocks.loadSetting.mockReturnValue({
      yama_p3: {
        equipment: customEquipment,
        inventory: secondYamaPreset.inventory,
      },
    });

    const { result } = renderHook(() => useEncounterEquipment());

    // Must NOT snap to the first preset (max-mage) — the saved loadout survives.
    expect(result.current.getEquipment('yama_p3')).toEqual(customEquipment);
  });

  it('filters equipment for play without rewriting it on reads, rerenders or remounts', () => {
    const saved = {
      yama_p3: {
        equipment: { ...secondYamaPreset.equipment, weapon: 25633, cape: 4151 },
        inventory: secondYamaPreset.inventory,
        supplies: createEmptyCombatSupplies(),
      },
    };
    storageMocks.loadSetting.mockReturnValue(saved);
    const { result, rerender, unmount } = renderHook(() => useEncounterEquipment());

    expect(result.current.getLoadout('yama_p3').equipment.weapon).toBeUndefined();
    expect(result.current.getEquipment('yama_p3').cape).toBeUndefined();
    expect(result.current.getEquipment('yama_p3').head).toBe(secondYamaPreset.equipment.head);
    result.current.getInventory('yama_p3');
    result.current.getSupplies('yama_p3');
    rerender();
    unmount();
    const remounted = renderHook(() => useEncounterEquipment());

    expect(remounted.result.current.getEquipment('yama_p3').weapon).toBeUndefined();
    expect(saved.yama_p3.equipment).toMatchObject({ weapon: 25633, cape: 4151 });
    expect(storageMocks.saveSetting).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { weapon: EQUIPMENT_PRESETS.sol_heredit.max.equipment.weapon },
  ])('keeps explicit sparse gear %j with preset inventory across remounts', (equipment) => {
    const preset = Object.values(EQUIPMENT_PRESETS.sol_heredit)[0];
    const loadout = { equipment, inventory: preset.inventory, supplies: preset.supplies };
    storageMocks.loadSetting.mockReturnValue({ sol_heredit: loadout });
    const { result, unmount } = renderHook(() => useEncounterEquipment());

    expect(result.current.getLoadout('sol_heredit')).toEqual(loadout);
    unmount();
    const remounted = renderHook(() => useEncounterEquipment());

    expect(remounted.result.current.getLoadout('sol_heredit')).toEqual(loadout);
    expect(storageMocks.saveSetting).not.toHaveBeenCalled();
  });

  it('preserves omitted items when a retired-kind repair saves another encounter', async () => {
    const zukPreset = EQUIPMENT_PRESETS.zuk.max_tbow;
    storageMocks.loadSetting.mockReturnValue({
      yama_p3: { equipment: { weapon: 25633 }, inventory: [], supplies: createEmptyCombatSupplies() },
      zuk: { equipment: zukPreset.equipment, inventory: zukPreset.inventory, supplies: zukPreset.supplies },
    });

    const { result } = renderHook(() => useEncounterEquipment());

    expect(result.current.getEquipment('yama_p3').weapon).toBeUndefined();
    await waitFor(() =>
      expect(storageMocks.saveSetting).toHaveBeenLastCalledWith(
        'osrs-encounter-equipment',
        expect.objectContaining({
          yama_p3: expect.objectContaining({ equipment: { weapon: 25633 } }),
          inferno: expect.objectContaining({ supplies: zukPreset.supplies }),
        }),
      ),
    );
  });

  it('saves user edits to another encounter without erasing omitted saved items', async () => {
    storageMocks.loadSetting.mockReturnValue({
      yama_p3: { equipment: { weapon: 25633 }, inventory: [], supplies: createEmptyCombatSupplies() },
    });
    const { result } = renderHook(() => useEncounterEquipment());
    const inventory = createEmptyInventory();
    inventory[0] = { id: 6685 };

    act(() => result.current.setInventory('zuk', inventory));

    await waitFor(() =>
      expect(storageMocks.saveSetting).toHaveBeenLastCalledWith(
        'osrs-encounter-equipment',
        expect.objectContaining({
          yama_p3: expect.objectContaining({ equipment: { weapon: 25633 } }),
          inferno: expect.objectContaining({ inventory }),
        }),
      ),
    );
    expect(result.current.getEquipment('yama_p3').weapon).toBeUndefined();
  });

  it.each([
    'loadout',
    'equipment',
    'inventory',
    'supplies',
  ] as const)('persists the visible equipment when the user edits that loadout via %s', async (edit) => {
    storageMocks.loadSetting.mockReturnValue({
      yama_p3: { equipment: { weapon: 25633, cape: 4151 }, inventory: [] },
    });
    const { result } = renderHook(() => useEncounterEquipment());
    const visible = result.current.getLoadout('yama_p3');

    act(() => {
      if (edit === 'loadout') result.current.setLoadout('yama_p3', visible);
      else if (edit === 'equipment') result.current.setEquipment('yama_p3', visible.equipment);
      else if (edit === 'inventory') result.current.setInventory('yama_p3', visible.inventory);
      else result.current.setSupplies('yama_p3', visible.supplies);
    });

    await waitFor(() =>
      expect(storageMocks.saveSetting).toHaveBeenLastCalledWith('osrs-encounter-equipment', { yama_p3: visible }),
    );
    expect(visible.equipment).toEqual({});
  });

  it('getInventory returns stored inventory when stored equipment matches a preset', () => {
    const { result } = renderHook(() => useEncounterEquipment());

    act(() => {
      result.current.setEquipment('yama_p3', secondYamaPreset.equipment);
      result.current.setInventory('yama_p3', secondYamaPreset.inventory);
    });

    expect(result.current.getInventory('yama_p3')).toEqual(secondYamaPreset.inventory);
  });

  it('keeps custom inventory when stored equipment matches a preset', () => {
    const customInventory = secondYamaPreset.inventory.map((slot, index) => {
      if (index === 0) {
        return { id: 12695 };
      }
      return slot ? { ...slot } : null;
    });
    storageMocks.loadSetting.mockReturnValue({
      yama_p3: {
        equipment: secondYamaPreset.equipment,
        inventory: customInventory,
      },
    });

    const { result } = renderHook(() => useEncounterEquipment());

    expect(result.current.getEquipment('yama_p3')).toEqual(secondYamaPreset.equipment);
    expect(result.current.getInventory('yama_p3')).toEqual(customInventory);
    expect(storageMocks.saveSetting).not.toHaveBeenCalled();
  });

  it('getInventory preserves custom inventory when stored equipment does not match a preset', () => {
    const customInventory = secondYamaPreset.inventory.map((slot, index) => {
      if (index === 1) {
        return { id: 12695, quantity: 1 };
      }
      return slot;
    });
    const customEquipment = {
      ...secondYamaPreset.equipment,
      body: 123456,
    };

    const { result } = renderHook(() => useEncounterEquipment());

    act(() => {
      result.current.setEquipment('yama_p3', customEquipment);
      result.current.setInventory('yama_p3', customInventory);
    });

    // Must NOT snap to the first preset inventory — the saved inventory survives.
    expect(result.current.getInventory('yama_p3')).toEqual(customInventory);
  });

  it('keeps a diverged learner-mage loadout on Try Again instead of snapping to Max Mage', () => {
    const learner = EQUIPMENT_PRESETS.yama_p3['learner-mage'];
    const divergedEquipment = { ...learner.equipment, weapon: 11806 }; // swapped to a Saradomin godsword mid-fight
    delete divergedEquipment.shield; // A two-handed swap also unequips the Mage's book.
    storageMocks.loadSetting.mockReturnValue({
      yama_p3: {
        equipment: divergedEquipment,
        inventory: learner.inventory,
      },
    });

    const { result } = renderHook(() => useEncounterEquipment());

    expect(result.current.getEquipment('yama_p3')).toEqual(divergedEquipment);
    expect(result.current.getEquipment('yama_p3')).not.toEqual(firstYamaPreset.equipment);
    expect(result.current.getInventory('yama_p3')).toEqual(learner.inventory);
  });

  it('default loadout uses the first preset in the list', () => {
    const { result } = renderHook(() => useEncounterEquipment());

    expect(result.current.getEquipment('yama_p3')).toEqual(firstYamaPreset.equipment);
  });

  it('returns empty/default loadout for unknown encounter kinds', () => {
    const { result } = renderHook(() => useEncounterEquipment());

    expect(result.current.getEquipment('unknown_encounter')).toEqual({});
    expect(result.current.getInventory('unknown_encounter')).toEqual(createEmptyInventory());
  });
});
