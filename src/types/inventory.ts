/**
 * `quantity` is runtime-only: ground-item pickups and consumable decrements use it.
 * Loadouts never carry one, because ammunition, runes and other stacks never deplete
 * (see SupplyItem), so a loadout stack models only the item's presence.
 */
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
  const fallback = (quantity ?? 1) > 1;
  if (!objTypeLoader) return fallback;
  try {
    return objTypeLoader.load(itemId).stackable;
  } catch {
    return fallback;
  }
}

/** Accepts a `q` count in a setup but drops it: loadout stacks model presence only. */
export function parseInventoryFromSetup(inv: ({ id: number; q?: number } | null)[]): Inventory {
  const inventory = createEmptyInventory();
  for (let i = 0; i < Math.min(inv.length, INVENTORY_SIZE); i++) {
    const item = inv[i];
    if (item) {
      inventory[i] = { id: item.id };
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
