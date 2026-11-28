import { z } from 'zod';
import type { EncounterLoadout } from '../types/encounterLoadout';
import { createEmptyCombatSupplies, type RunePouch, type SupplyItem } from '../types/encounterLoadout';
import type { Inventory, StackableLookup } from '../types/inventory';
import { createEmptyInventory, isStackableItem } from '../types/inventory';
import type { SpellbookType } from '../types/spellbook';
import type { CustomizableGearSlot, ImportedPresetVerificationIssue } from './customEquipmentPresets';
import { getGearCatalog, isTwoHandedWeapon } from './customEquipmentPresets';
import { findInventoryItem } from './inventoryItemCatalog';
import { findSupportedRune } from './runePouch';

export type InventorySetupImportResult =
  | {
      readonly kind: 'success';
      readonly name: string;
      readonly loadout: EncounterLoadout;
      readonly unsupportedEquipmentIds: readonly number[];
      readonly verificationIssues: readonly ImportedPresetVerificationIssue[];
    }
  | { readonly kind: 'error'; readonly message: string };

/**
 * A full setup — 28 inventory slots, 14 equipment slots, a pouch, a quiver and a bank-tag layout —
 * serializes to a few kilobytes. This is the ceiling on the string BEFORE `JSON.parse`, because
 * every bound below is enforced by walking a structure that call has already materialized.
 */
const MAX_INPUT_CHARS = 65536;
const INVENTORY_SLOTS = 28;
const EQUIPMENT_SLOTS = 14;
/** Divine pouch, the larger of the two; `qv` shares it rather than pinning the quiver's own 1. */
const MAX_POUCH_SLOTS = 4;
/** Bank-tag layouts are 8 columns deep; this leaves room for one far taller than any real tab. */
const MAX_LAYOUT_ENTRIES = 2048;
const MAX_NAME_CHARS = 255;

/**
 * `hc` is the ONE field RuneLite's `InventorySetupSerializable` does not mark `@Nullable`, so an
 * export that omits it deserializes into a setup with a null highlight color. `#AARRGGBB` is the
 * shape its Gson writes, and opaque red is the plugin's own `InventorySetupsConfig.highlightColor()`
 * default for a new setup — so a Scim export arrives looking like one made in RuneLite.
 */
const RUNELITE_DEFAULT_HIGHLIGHT_COLOR = '#FFFF0000';

// Unknown keys are stripped rather than passed through: nothing here reads a field it does not
// declare, so retaining them only carries a stranger's JSON into our own loadout objects. That is
// also why RuneLite's `f` and `sc` are absent below rather than declared and ignored.
const itemSchema = z.object({
  id: z.number().int().positive(),
  q: z.number().int().positive().optional(),
});
const itemOrNullSchema = itemSchema.nullable();
const setupSchema = z.object({
  inv: z.array(itemOrNullSchema).max(INVENTORY_SLOTS),
  eq: z.array(itemOrNullSchema).max(EQUIPMENT_SLOTS),
  rp: z.array(itemOrNullSchema).max(MAX_POUCH_SLOTS).nullable().optional(),
  qv: z.array(itemOrNullSchema).max(MAX_POUCH_SLOTS).nullable().optional(),
  name: z.string().trim().min(1).max(MAX_NAME_CHARS),
  sb: z.number().int().min(0).max(4).optional(),
});
const portableSchema = z.object({
  setup: setupSchema,
  layout: z.array(z.number().int()).max(MAX_LAYOUT_ENTRIES),
});

const EQUIPMENT_INDEX_BY_SLOT: Record<CustomizableGearSlot, number> = {
  head: 0,
  cape: 1,
  amulet: 2,
  weapon: 3,
  body: 4,
  shield: 5,
  legs: 7,
  hands: 9,
  boots: 10,
  ring: 12,
};

const SPELLBOOK_BY_ID: Record<number, SpellbookType> = {
  0: 'standard',
  1: 'ancient',
  2: 'lunar',
  3: 'arceuus',
  // Inventory Setups' "None" is valid metadata; Scim still needs an active spellbook.
  4: 'standard',
};

const SPELLBOOK_ID: Record<SpellbookType, number> = {
  standard: 0,
  ancient: 1,
  lunar: 2,
  arceuus: 3,
};

type PortableItem = {
  readonly id: number;
  readonly q?: number;
};

/**
 * Stacks never deplete in the sim, so an import drops RuneLite's `q` count. Inventory Setups
 * still expects one on every stack it is given, so an export writes this ample one instead.
 */
const EXPORTED_STACK_QUANTITY = 100_000;

function toInventory(items: readonly (z.infer<typeof itemSchema> | null)[]): Inventory {
  const inventory = createEmptyInventory();
  for (let index = 0; index < inventory.length; index++) {
    const item = items[index];
    inventory[index] = item ? { id: item.id } : null;
  }
  return inventory;
}

function toSupplyItem(item: z.infer<typeof itemSchema> | null | undefined): SupplyItem | null {
  return item ? { id: item.id } : null;
}

/**
 * A rune this build cannot name is KEPT, matching what `RunePouchRow` already draws for one and
 * what the inventory above does with an unsupported id — dropping it here would empty a pouch slot
 * the row is built to show as held. Reported, though: an unnamed rune is one `hasRune` will refuse
 * to cast off, so it is the player's to resolve rather than a silent hole in the setup.
 */
function toRunePouch(
  items: readonly (z.infer<typeof itemSchema> | null)[] | null | undefined,
  addIssue: (issue: ImportedPresetVerificationIssue) => void,
): RunePouch | null {
  if (items?.length !== 3 && items?.length !== 4) return null;
  const slots = items.map((item) => {
    if (!item) return null;
    if (!findSupportedRune(item.id)) {
      addIssue({ id: item.id, name: `Item ${item.id}`, reason: 'unsupported', omitted: false });
    }
    return { id: item.id };
  });
  return items.length === 3
    ? { kind: 'standard', slots: [slots[0], slots[1], slots[2]] }
    : { kind: 'divine', slots: [slots[0], slots[1], slots[2], slots[3]] };
}

function toPortableItem(item: { readonly id: number } | null, stackable: boolean): PortableItem | null {
  if (!item) return null;
  return stackable ? { id: item.id, q: EXPORTED_STACK_QUANTITY } : { id: item.id };
}

export function importInventorySetup(input: string): InventorySetupImportResult {
  if (input.length > MAX_INPUT_CHARS) {
    return { kind: 'error', message: 'That is far larger than an Inventory Setup export.' };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(input);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { kind: 'error', message: 'Paste a valid Inventory Setup export string.' };
    }
    throw error;
  }

  const parsed = portableSchema.safeParse(decoded);
  if (!parsed.success) {
    return { kind: 'error', message: 'Paste a valid Inventory Setup export string.' };
  }
  if (parsed.data.setup.inv.length !== INVENTORY_SLOTS || parsed.data.setup.eq.length !== EQUIPMENT_SLOTS) {
    return { kind: 'error', message: 'The export must contain 28 inventory slots and 14 equipment slots.' };
  }

  const equipment: EncounterLoadout['equipment'] = {};
  const unsupportedEquipmentIds: number[] = [];
  const issuesById = new Map<number, ImportedPresetVerificationIssue>();
  const addIssue = (issue: ImportedPresetVerificationIssue) => {
    const existing = issuesById.get(issue.id);
    if (!existing || issue.omitted) {
      issuesById.set(issue.id, issue);
    }
  };
  for (const item of parsed.data.setup.inv) {
    if (!item) continue;
    const catalogItem = findInventoryItem(item.id);
    if (!catalogItem) {
      addIssue({ id: item.id, name: `Item ${item.id}`, reason: 'unsupported', omitted: false });
    } else if (!catalogItem.verified) {
      addIssue({ id: item.id, name: catalogItem.name, reason: 'unverified', omitted: false });
    }
  }
  for (const [slot, index] of Object.entries(EQUIPMENT_INDEX_BY_SLOT) as [CustomizableGearSlot, number][]) {
    const item = parsed.data.setup.eq[index];
    if (!item) continue;
    const catalogItem = getGearCatalog(slot).find((candidate) => candidate.id === item.id);
    if (catalogItem) {
      equipment[slot] = item.id;
      if (!catalogItem.verified) {
        addIssue({ id: item.id, name: catalogItem.name, reason: 'unverified', omitted: false });
      }
    } else {
      unsupportedEquipmentIds.push(item.id);
      addIssue({ id: item.id, name: `Item ${item.id}`, reason: 'unsupported', omitted: true });
    }
  }
  if (isTwoHandedWeapon(equipment.weapon)) {
    delete equipment.shield;
  }

  const supplies = createEmptyCombatSupplies();
  const spellbook = SPELLBOOK_BY_ID[parsed.data.setup.sb ?? 0] ?? 'standard';
  // Ahead of the result, not inline in it: this is the last thing that can raise an issue, and
  // the literal below snapshots `issuesById` before it reaches the supplies that would call it.
  const runePouch = toRunePouch(parsed.data.setup.rp, addIssue);
  return {
    kind: 'success',
    name: parsed.data.setup.name,
    unsupportedEquipmentIds,
    verificationIssues: [...issuesById.values()],
    loadout: {
      equipment,
      inventory: toInventory(parsed.data.setup.inv),
      supplies: {
        ...supplies,
        equippedAmmo: toSupplyItem(parsed.data.setup.eq[13]),
        quiverAmmo: toSupplyItem(parsed.data.setup.qv?.[0]),
        runePouch,
        spellbook,
      },
    },
  };
}

/**
 * `objTypeLoader` decides which inventory items and worn items (chinchompas, darts) are stacks.
 * Without it only the slot's own quantity can say, which a loadout never carries, so those go out
 * uncounted. Ammunition, quiver and rune pouch contents are always stacks.
 */
export function exportInventorySetup(
  name: string,
  loadout: EncounterLoadout,
  objTypeLoader?: StackableLookup | null,
): string {
  const equipment: (PortableItem | null)[] = new Array(EQUIPMENT_SLOTS).fill(null);
  for (const [slot, index] of Object.entries(EQUIPMENT_INDEX_BY_SLOT) as [CustomizableGearSlot, number][]) {
    const itemId = loadout.equipment[slot];
    equipment[index] =
      itemId === undefined ? null : toPortableItem({ id: itemId }, isStackableItem(itemId, undefined, objTypeLoader));
  }
  equipment[13] = toPortableItem(loadout.supplies.equippedAmmo, true);

  return JSON.stringify({
    setup: {
      inv: loadout.inventory.map((item) =>
        toPortableItem(item, item !== null && isStackableItem(item.id, item.quantity, objTypeLoader)),
      ),
      eq: equipment,
      ...(loadout.supplies.runePouch
        ? { rp: loadout.supplies.runePouch.slots.map((item) => toPortableItem(item, true)) }
        : {}),
      ...(loadout.supplies.quiverAmmo ? { qv: [toPortableItem(loadout.supplies.quiverAmmo, true)] } : {}),
      name: name.trim(),
      hc: RUNELITE_DEFAULT_HIGHLIGHT_COLOR,
      ...(loadout.supplies.spellbook === 'standard' ? {} : { sb: SPELLBOOK_ID[loadout.supplies.spellbook] }),
    },
    layout: [],
  });
}
