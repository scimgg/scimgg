import { describe, expect, it } from 'vitest';
import { createEmptyCombatSupplies, type EncounterLoadout } from '../../types/encounterLoadout';
import { createEmptyInventory } from '../../types/inventory';
import { getGearCatalog } from '../customEquipmentPresets';
import { exportInventorySetup, importInventorySetup } from '../inventorySetupIO';
import { ARDER_MUSCA_POISON_ITEM_ID } from '../itemIds';

describe('RuneLite Inventory Setups interchange', () => {
  it('imports equipment, inventory, ammunition, rune pouch, quiver, and spellbook', () => {
    const inventory = new Array(28).fill(null);
    inventory[0] = { id: 6685 };
    inventory[1] = { id: 560, q: 250, f: true };
    inventory[27] = { id: 27281 };
    const equipment = new Array(14).fill(null);
    equipment[0] = { id: 21018 };
    equipment[3] = { id: 29594 };
    equipment[13] = { id: 11212, q: 4000 };

    const result = importInventorySetup(
      JSON.stringify({
        setup: {
          inv: inventory,
          eq: equipment,
          rp: [{ id: 560 }, { id: 565 }, { id: 566 }, { id: 4699 }],
          qv: [{ id: 9242, q: 1000 }],
          name: 'Imported Yama',
          sb: 3,
        },
        layout: [],
      }),
    );

    expect(result).toMatchObject({
      kind: 'success',
      name: 'Imported Yama',
      unsupportedEquipmentIds: [],
      loadout: {
        equipment: { head: 21018, weapon: 29594 },
        supplies: {
          equippedAmmo: { id: 11212 },
          quiverAmmo: { id: 9242 },
          runePouch: {
            kind: 'divine',
            slots: [{ id: 560 }, { id: 565 }, { id: 566 }, { id: 4699 }],
          },
          spellbook: 'arceuus',
        },
      },
    });
    expect(result.kind === 'success' ? result.loadout.inventory[0] : null).toEqual({ id: 6685 });
    // Stacks never deplete in the sim, so RuneLite's count is dropped rather than carried.
    expect(result.kind === 'success' ? result.loadout.inventory[1] : null).toEqual({ id: 560 });
  });

  it.each([
    { sb: undefined, spellbook: 'standard' },
    { sb: 0, spellbook: 'standard' },
    { sb: 1, spellbook: 'ancient' },
    { sb: 2, spellbook: 'lunar' },
    { sb: 3, spellbook: 'arceuus' },
    { sb: 4, spellbook: 'standard' },
  ])('imports spellbook $sb as $spellbook without discarding the loadout', ({ sb, spellbook }) => {
    const inventory = new Array(28).fill(null);
    inventory[0] = { id: 560, q: 250 };
    const equipment = new Array(14).fill(null);
    equipment[0] = { id: 21018 };
    const input = JSON.stringify({
      setup: { name: 'Portable setup', inv: inventory, eq: equipment, hc: '#FFFF0000', sb },
      layout: [],
    });

    const result = importInventorySetup(input);

    expect(result).toMatchObject({
      kind: 'success',
      loadout: { equipment: { head: 21018 }, supplies: { spellbook } },
    });
    expect(result.kind === 'success' ? result.loadout.inventory[0] : null).toEqual({ id: 560 });
  });

  it.each([-1, 5, 1.5, '4', null])('rejects invalid spellbook %s without creating a partial loadout', (sb) => {
    const input = JSON.stringify({
      setup: { name: 'Invalid spellbook', inv: new Array(28).fill(null), eq: new Array(14).fill(null), sb },
      layout: [],
    });

    const result = importInventorySetup(input);

    expect(result.kind).toBe('error');
  });

  it('rejects malformed exports without creating a partial loadout', () => {
    expect(importInventorySetup('not json')).toEqual({
      kind: 'error',
      message: 'Paste a valid Inventory Setup export string.',
    });
    expect(importInventorySetup(JSON.stringify({ setup: { name: 'Short', inv: [], eq: [] }, layout: [] }))).toEqual({
      kind: 'error',
      message: 'The export must contain 28 inventory slots and 14 equipment slots.',
    });
  });

  it('reports known-unverified and unsupported imported items once per item id', () => {
    const unverifiedWeapon = getGearCatalog('weapon').find((item) => !item.verified);
    if (!unverifiedWeapon) {
      throw new Error('expected the equipment catalog to contain an unverified weapon');
    }
    const inventory = new Array(28).fill(null);
    inventory[0] = { id: unverifiedWeapon.id };
    inventory[1] = { id: unverifiedWeapon.id };
    inventory[2] = { id: 999_999 };
    const equipment = new Array(14).fill(null);
    equipment[3] = { id: unverifiedWeapon.id };
    equipment[4] = { id: 999_998 };

    const result = importInventorySetup(
      JSON.stringify({ setup: { name: 'Needs review', inv: inventory, eq: equipment }, layout: [] }),
    );

    expect(result).toMatchObject({
      kind: 'success',
      verificationIssues: [
        { id: unverifiedWeapon.id, name: unverifiedWeapon.name, reason: 'unverified' },
        { id: 999_999, name: 'Item 999999', reason: 'unsupported' },
        { id: 999_998, name: 'Item 999998', reason: 'unsupported' },
      ],
    });
  });

  it('refuses a payload far larger than any setup before parsing it', () => {
    // The bounds inside the schema are all enforced by walking a structure `JSON.parse` has
    // already built, so the only one that can protect that call is a check on the raw string.
    const oversized = `{"setup":{"name":"Huge","inv":[],"eq":[]},"layout":[${'0,'.repeat(40_000)}0]}`;

    expect(importInventorySetup(oversized)).toEqual({
      kind: 'error',
      message: 'That is far larger than an Inventory Setup export.',
    });
  });

  it('keeps a rune it cannot name in the pouch, and says so', () => {
    const result = importInventorySetup(
      JSON.stringify({
        setup: {
          name: 'Odd pouch',
          inv: new Array(28).fill(null),
          eq: new Array(14).fill(null),
          rp: [{ id: 560 }, { id: 999_997 }, null],
        },
        layout: [],
      }),
    );

    // Held rather than dropped, matching what `RunePouchRow` draws for one: emptying the slot
    // would lose the only record that the setup ever carried it.
    expect(result).toMatchObject({
      kind: 'success',
      verificationIssues: [{ id: 999_997, name: 'Item 999997', reason: 'unsupported', omitted: false }],
      loadout: { supplies: { runePouch: { kind: 'standard', slots: [{ id: 560 }, { id: 999_997 }, null] } } },
    });
  });

  it('exports a RuneLite-compatible portable setup and round-trips its loadout', () => {
    const inventory = createEmptyInventory();
    inventory[0] = { id: 6685 };
    inventory[1] = { id: 560 };
    const loadout: EncounterLoadout = {
      equipment: { head: 21018, weapon: 29594, ring: 28313 },
      inventory,
      supplies: {
        ...createEmptyCombatSupplies(),
        equippedAmmo: { id: 11212 },
        quiverAmmo: { id: 9242 },
        runePouch: {
          kind: 'standard',
          slots: [{ id: 560 }, { id: 565 }, { id: 566 }],
        },
        spellbook: 'ancient',
      },
    };

    const text = exportInventorySetup('Scim.GG Yama', loadout);
    const portable = JSON.parse(text);

    expect(portable).toMatchObject({
      setup: {
        name: 'Scim.GG Yama',
        sb: 1,
        // The one field RuneLite's `InventorySetupSerializable` does not mark `@Nullable`. Drop it
        // and the plugin deserializes a setup whose highlight color is null.
        hc: '#FFFF0000',
      },
      layout: [],
    });
    // Without a cache only the always-stacked supplies can be counted.
    expect(portable.setup.inv.slice(0, 2)).toEqual([{ id: 6685 }, { id: 560 }]);
    expect(portable.setup.rp).toEqual([
      { id: 560, q: 100000 },
      { id: 565, q: 100000 },
      { id: 566, q: 100000 },
    ]);
    expect(portable.setup.qv).toEqual([{ id: 9242, q: 100000 }]);
    expect(portable.setup.eq.slice(0, 4)).toEqual([{ id: 21018 }, null, null, { id: 29594 }]);
    expect(portable.setup.eq).toHaveLength(14);
    expect(portable.setup.eq[12]).toEqual({ id: 28313 });
    expect(portable.setup.eq[13]).toEqual({ id: 11212, q: 100000 });
    expect(portable.setup.inv).toHaveLength(28);

    const imported = importInventorySetup(text);
    expect(imported.kind === 'success' ? imported.loadout : null).toEqual(loadout);
  });

  describe('stack counts on export', () => {
    const DEATH_RUNE = 560;
    const BLACK_CHINCHOMPA = 11959;
    const SHARK = 385;
    const STACKABLE = new Set([DEATH_RUNE, BLACK_CHINCHOMPA]);
    const loader = { load: (id: number) => ({ stackable: STACKABLE.has(id) }) };

    function exported(loadout: Partial<EncounterLoadout>, objTypeLoader?: typeof loader) {
      const full: EncounterLoadout = {
        equipment: {},
        inventory: createEmptyInventory(),
        supplies: createEmptyCombatSupplies(),
        ...loadout,
      };
      return JSON.parse(exportInventorySetup('Counted', full, objTypeLoader)).setup;
    }

    it('writes an ample count on every cache-stackable inventory item and none on the rest', () => {
      const inventory = createEmptyInventory();
      inventory[0] = { id: DEATH_RUNE };
      inventory[1] = { id: SHARK };
      inventory[2] = { id: BLACK_CHINCHOMPA };

      const setup = exported({ inventory }, loader);

      expect(setup.inv.slice(0, 3)).toEqual([
        { id: DEATH_RUNE, q: 100000 },
        { id: SHARK },
        { id: BLACK_CHINCHOMPA, q: 100000 },
      ]);
    });

    it('counts a stackable worn weapon, but not an ordinary one', () => {
      expect(exported({ equipment: { weapon: BLACK_CHINCHOMPA } }, loader).eq[3]).toEqual({
        id: BLACK_CHINCHOMPA,
        q: 100000,
      });
      expect(exported({ equipment: { weapon: 4151 } }, loader).eq[3]).toEqual({ id: 4151 });
    });

    it('replaces a runtime count rather than exporting it', () => {
      const inventory = createEmptyInventory();
      inventory[0] = { id: DEATH_RUNE, quantity: 250 };

      expect(exported({ inventory }, loader).inv[0]).toEqual({ id: DEATH_RUNE, q: 100000 });
    });

    it('imports an exported count back as presence only', () => {
      const inventory = createEmptyInventory();
      inventory[0] = { id: DEATH_RUNE };
      const loadout: EncounterLoadout = { equipment: {}, inventory, supplies: createEmptyCombatSupplies() };

      const imported = importInventorySetup(exportInventorySetup('Counted', loadout, loader));

      expect(imported.kind === 'success' ? imported.loadout.inventory[0] : null).toEqual({ id: DEATH_RUNE });
    });

    it('round-trips poison as an unlimited loadout stack', () => {
      const inventory = createEmptyInventory();
      const poison = { id: ARDER_MUSCA_POISON_ITEM_ID };
      inventory[27] = { ...poison, quantity: 3 };
      const loadout: EncounterLoadout = { equipment: {}, inventory, supplies: createEmptyCombatSupplies() };

      const text = exportInventorySetup('Duke opener', loadout);
      expect(JSON.parse(text).setup.inv[27]).toEqual({ id: poison.id, q: 100000 });
      const imported = importInventorySetup(text);
      expect(imported.kind === 'success' ? imported.loadout.inventory[27] : null).toEqual(poison);
    });
  });
});
