// Stackable in pinned cache 2772 (https://oldschool.runescape.wiki/w/Arder-musca_poison).
export const ARDER_MUSCA_POISON_ITEM_ID = 28351;

/** Runtime stacks and finite loadout stacks can carry counts. Ammo and rune supplies model presence. */
export interface InventoryItem {
  id: number;
  quantity?: number;
}

export type InventorySlot = InventoryItem | null;

export type Inventory = InventorySlot[];

export const INVENTORY_SIZE = 28;

export function createEmptyInventory(): Inventory {
  return new Array(INVENTORY_SIZE).fill(null);
}

/** Most stackable supplies are unlimited. The poison loadout records a finite number of items. */
export function getFiniteStackQuantity(item: InventorySlot | undefined): number | undefined {
  if (item?.id !== ARDER_MUSCA_POISON_ITEM_ID) return undefined;
  const quantity = item.quantity ?? 1;
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 1;
}

export function toLoadoutInventoryItem(item: InventoryItem): InventoryItem {
  const quantity = getFiniteStackQuantity(item);
  return quantity !== undefined && quantity > 1 ? { id: item.id, quantity } : { id: item.id };
}

/**
 * The one cache field `isStackableItem` reads. An `ObjTypeLoader` satisfies it; naming it
 * structurally keeps the cache loader out of the server build, which shares this module.
 */
export interface StackableLookup {
  load(itemId: number): { readonly stackable: boolean };
}

/**
 * Whether an item stacks: the cache's flag when one is loaded, else the slot's own
 * quantity, which is the only stacking signal without a cache (unit tests, the UI
 * harness) or for an id the cache cannot load.
 */
export function isStackableItem(
  itemId: number,
  quantity: number | undefined,
  objTypeLoader: StackableLookup | null | undefined,
): boolean {
  const fallback = itemId === ARDER_MUSCA_POISON_ITEM_ID || (quantity ?? 1) > 1;
  if (!objTypeLoader) return fallback;
  try {
    return objTypeLoader.load(itemId).stackable;
  } catch {
    return fallback;
  }
}

/** Retains `q` for finite stacks when parsing a preset or Inventory Setup. */
export function parseInventoryFromSetup(inv: readonly ({ id: number; q?: number } | null)[]): Inventory {
  const inventory = createEmptyInventory();
  for (let i = 0; i < Math.min(inv.length, INVENTORY_SIZE); i++) {
    const item = inv[i];
    if (item) {
      inventory[i] = toLoadoutInventoryItem({ id: item.id, quantity: item.q });
    }
  }
  return inventory;
}

/** Returning null for a full inventory makes a "Take" fail rather than silently drop an item. */
export function addItemToInventory(
  inventory: Inventory,
  itemId: number,
  quantity: number,
  stackable: boolean,
): Inventory | null {
  const next: Inventory = inventory.map((slot) => (slot ? { ...slot } : null));

  if (stackable) {
    const existingIndex = next.findIndex((slot) => slot !== null && slot.id === itemId);
    const existing = existingIndex === -1 ? null : next[existingIndex];
    if (existing) {
      next[existingIndex] = { id: itemId, quantity: (existing.quantity ?? 1) + quantity };
      return next;
    }
  }

  const freeIndex = next.indexOf(null);
  if (freeIndex === -1) return null;
  next[freeIndex] = stackable || quantity > 1 ? { id: itemId, quantity } : { id: itemId };
  return next;
}

/** Returns the unchanged array when the slot was already empty. */
export function removeInventorySlot(inventory: Inventory, index: number): Inventory {
  if (!inventory[index]) return inventory;
  const next: Inventory = inventory.map((slot) => (slot ? { ...slot } : null));
  next[index] = null;
  return next;
}
