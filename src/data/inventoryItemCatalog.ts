import { ARDER_MUSCA_POISON_ITEM_ID } from '../types/inventory';
import { getCanonicalEquipmentItemId, getEquipmentCatalog } from './equipmentCatalog';
import { isVerifiedEquipmentPiece } from './equipmentSupport';
import { ITEM_ACTIONS } from './itemEffects';
import { HALIBUT_ITEM_ID } from './itemIds';
import { RUNE_POUCH_ITEMS, SUPPORTED_RUNES } from './runePouch';

export type InventoryItemCategory = 'food' | 'potions' | 'runes' | 'gear' | 'other';

export interface InventoryCatalogItem {
  readonly id: number;
  readonly name: string;
  readonly category: InventoryItemCategory;
  /**
   * False for gear the simulator does not run correctly. Consumables are always true:
   * {@link ITEM_ACTIONS} membership is what makes one simulated in the first place.
   */
  readonly verified: boolean;
  /**
   * What tells this item apart from another of the same name, e.g. "Enchanted", "Minigame".
   * Carried through from the equipment row because it is the only thing that can: without it
   * the picker cannot tell a real variant from a cosmetic duplicate, and collapses both.
   */
  readonly version?: string;
  /** Set when `itemAliases.json` makes this a variant of another piece. See its use in the picker. */
  readonly canonicalId?: number;
}

/**
 * Display names for the consumables {@link ITEM_ACTIONS} simulates.
 *
 * The app's runtime name source is the cache's ObjType loader, which is only wired up
 * once an encounter is running — the pre-fight loadout panel has no access to it. Names
 * here are the OSRS wiki names, with every id cross-checked against RuneLite's
 * `net.runelite.api.gameval.ItemID` table, so a sprite and its label
 * always name the same item.
 */
const CONSUMABLE_ITEM_NAMES: Readonly<Record<number, string>> = {
  139: 'Prayer potion(3)',
  141: 'Prayer potion(2)',
  143: 'Prayer potion(1)',
  169: 'Ranging potion(3)',
  171: 'Ranging potion(2)',
  173: 'Ranging potion(1)',
  229: 'Vial',
  2434: 'Prayer potion(4)',
  2444: 'Ranging potion(4)',
  3024: 'Super restore(4)',
  3026: 'Super restore(3)',
  3028: 'Super restore(2)',
  3030: 'Super restore(1)',
  3144: 'Cooked karambwan',
  4417: 'Guthix rest(4)',
  4419: 'Guthix rest(3)',
  4421: 'Guthix rest(2)',
  4423: 'Guthix rest(1)',
  5952: 'Antidote++(4)',
  5954: 'Antidote++(3)',
  5956: 'Antidote++(2)',
  5958: 'Antidote++(1)',
  6685: 'Saradomin brew(4)',
  6687: 'Saradomin brew(3)',
  6689: 'Saradomin brew(2)',
  6691: 'Saradomin brew(1)',
  7510: 'Dwarven rock cake',
  10925: 'Sanfew serum(4)',
  10927: 'Sanfew serum(3)',
  10929: 'Sanfew serum(2)',
  10931: 'Sanfew serum(1)',
  12625: 'Stamina potion(4)',
  12627: 'Stamina potion(3)',
  12629: 'Stamina potion(2)',
  12631: 'Stamina potion(1)',
  12695: 'Super combat potion(4)',
  12697: 'Super combat potion(3)',
  12699: 'Super combat potion(2)',
  12701: 'Super combat potion(1)',
  13441: 'Anglerfish',
  22081: 'Locator orb',
  22461: 'Bastion potion(4)',
  22464: 'Bastion potion(3)',
  22467: 'Bastion potion(2)',
  22470: 'Bastion potion(1)',
  23685: 'Divine super combat potion(4)',
  23688: 'Divine super combat potion(3)',
  23691: 'Divine super combat potion(2)',
  23694: 'Divine super combat potion(1)',
  23733: 'Divine ranging potion(4)',
  23736: 'Divine ranging potion(3)',
  23739: 'Divine ranging potion(2)',
  23742: 'Divine ranging potion(1)',
  27629: 'Forgotten brew(4)',
  27632: 'Forgotten brew(3)',
  27635: 'Forgotten brew(2)',
  27638: 'Forgotten brew(1)',
  27641: 'Saturated heart',
  29143: 'Cooked moonlight antelope',
  29183: 'Snowy knight mix(2)',
  29186: 'Ruby harvest mix(2)',
  29201: 'Snowy knight mix(1)',
  30125: 'Prayer regeneration potion(4)',
  30128: 'Prayer regeneration potion(3)',
  30131: 'Prayer regeneration potion(2)',
  30134: 'Prayer regeneration potion(1)',
  30875: 'Surge potion(4)',
  30878: 'Surge potion(3)',
  30881: 'Surge potion(2)',
  30884: 'Surge potion(1)',
  31614: 'Extreme energy potion(4)',
  31617: 'Extreme energy potion(3)',
  31620: 'Extreme energy potion(2)',
  31623: 'Extreme energy potion(1)',
  31638: 'Extended stamina potion(4)',
  31641: 'Extended stamina potion(3)',
  31644: 'Extended stamina potion(2)',
  31647: 'Extended stamina potion(1)',
  31650: 'Armadyl brew(4)',
  31653: 'Armadyl brew(3)',
  31656: 'Armadyl brew(2)',
  31659: 'Armadyl brew(1)',
  [HALIBUT_ITEM_ID]: 'Halibut',
};

/**
 * A pouch is not gear and a rune is not an {@link ITEM_ACTIONS} consumable, so neither
 * reaches the two catalogs below: without this list a default Yama set reads its own rune
 * pouch back as an unsupported item.
 */
const RUNE_POUCH_CATALOG_ITEMS: readonly InventoryCatalogItem[] = [
  ...RUNE_POUCH_ITEMS.map(({ id, name }) => ({ id, name, verified: true, category: 'runes' as const })),
  ...SUPPORTED_RUNES.map(({ id, name, verified }) => ({ id, name, verified, category: 'runes' as const })),
];

interface InventoryCatalog {
  readonly items: readonly InventoryCatalogItem[];
  readonly byId: ReadonlyMap<number, InventoryCatalogItem>;
}

let catalog: InventoryCatalog | null = null;

/**
 * What an inventory slot may hold: the consumables the engine actually simulates, the
 * rune pouches and their runes, plus the whole equipment catalog, because a real loadout
 * carries all three — food, potions and runes alongside the gear switches a preset brings.
 * Consumables are added first so a shared id keeps the consumable's name.
 */
function buildCatalog(): InventoryCatalog {
  const byId = new Map<number, InventoryCatalogItem>();
  for (const rawId of Object.keys(ITEM_ACTIONS)) {
    const id = Number(rawId);
    const name = CONSUMABLE_ITEM_NAMES[id];
    if (name !== undefined) {
      const track = ITEM_ACTIONS[id].track;
      const category =
        /\(\d+\)$/.test(name) || track === 'potion'
          ? 'potions'
          : track === 'food' || track === 'combo_food'
            ? 'food'
            : 'other';
      byId.set(id, { id, name, verified: true, category });
    }
  }
  for (const item of RUNE_POUCH_CATALOG_ITEMS) {
    if (!byId.has(item.id)) {
      byId.set(item.id, item);
    }
  }
  byId.set(ARDER_MUSCA_POISON_ITEM_ID, {
    id: ARDER_MUSCA_POISON_ITEM_ID,
    name: 'Arder-musca poison',
    category: 'other',
    verified: true,
  });
  for (const piece of getEquipmentCatalog()) {
    if (!byId.has(piece.id)) {
      const canonicalId = getCanonicalEquipmentItemId(piece.id);
      byId.set(piece.id, {
        id: piece.id,
        name: piece.name,
        category: 'gear',
        verified: isVerifiedEquipmentPiece(piece),
        ...(piece.version === undefined ? {} : { version: piece.version }),
        ...(canonicalId === piece.id ? {} : { canonicalId }),
      });
    }
  }
  const items = [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
  return { items, byId };
}

function getCatalog(): InventoryCatalog {
  catalog ??= buildCatalog();
  return catalog;
}

/** Every item an inventory slot can be set to, verified or not, in name order. */
export function getInventoryCatalog(): readonly InventoryCatalogItem[] {
  return getCatalog().items;
}

/**
 * The catalog entry for an id, or undefined for anything the picker cannot name.
 *
 * Never filtered by `verified` — a slot already holding an unverified item still has to be
 * able to say what it is, or the loadout would show an anonymous sprite.
 */
export function findInventoryItem(itemId: number): InventoryCatalogItem | undefined {
  return getCatalog().byId.get(itemId);
}
