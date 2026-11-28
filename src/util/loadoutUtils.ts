import type { PlayerEquipment } from '../rs/model/PlayerModelLoader';
import { combatSuppliesEqual, type EncounterLoadout } from '../types/encounterLoadout';
import type { Inventory } from '../types/inventory';

const EQUIPMENT_SLOTS: (keyof PlayerEquipment)[] = [
  'head',
  'cape',
  'amulet',
  'weapon',
  'body',
  'shield',
  'legs',
  'hands',
  'boots',
  'ring',
];

export function cloneInventory(inventory: Inventory): Inventory {
  return inventory.map((slot) => (slot ? { ...slot } : null));
}

export function cloneEquipment(equipment: PlayerEquipment): PlayerEquipment {
  return { ...equipment };
}

export function equipmentEqual(a: PlayerEquipment, b: PlayerEquipment): boolean {
  for (const slot of EQUIPMENT_SLOTS) {
    if (a[slot] !== b[slot]) return false;
  }
  return true;
}

/** Compares item ids only: loadout stacks never deplete, so a count is not part of a loadout. */
export function inventoryEqual(a: Inventory, b: Inventory): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if ((a[i]?.id ?? null) !== (b[i]?.id ?? null)) return false;
  }
  return true;
}

export function loadoutsEqual(a: EncounterLoadout, b: EncounterLoadout): boolean {
  return (
    equipmentEqual(a.equipment, b.equipment) &&
    inventoryEqual(a.inventory, b.inventory) &&
    combatSuppliesEqual(a.supplies, b.supplies)
  );
}

/** Worn gear and the inventory it moves through; supplies are not part of it. */
export type WornLoadout = Pick<EncounterLoadout, 'equipment' | 'inventory'>;

/**
 * Slots whose changes are carried or refused together. A two-handed weapon empties the shield slot,
 * so carrying one of the pair without the other could leave a shield beside a two-hander.
 */
const CARRY_SLOT_GROUPS: readonly (readonly (keyof PlayerEquipment)[])[] = [
  ['head'],
  ['cape'],
  ['amulet'],
  ['weapon', 'shield'],
  ['body'],
  ['legs'],
  ['hands'],
  ['boots'],
  ['ring'],
];

interface CarryPlan {
  readonly changed: readonly (keyof PlayerEquipment)[];
  /** Inventory slots the worn items come out of, by the equipment slot they go to. */
  readonly takes: ReadonlyMap<keyof PlayerEquipment, number>;
  /** The configured items that go back into the inventory, by the equipment slot they leave. */
  readonly puts: readonly { readonly slot: keyof PlayerEquipment; readonly id: number }[];
}

/**
 * The configured loadout with `worn` carried over, as if the player had made the same swaps from it:
 * a worn item taken from the configured inventory leaves its slot, and the configured item it
 * displaced goes into that same slot (else the first free one), so nothing is duplicated or lost.
 * A worn item the configured inventory lacks stays worn without being taken from anywhere. A slot
 * group whose displaced items do not fit keeps its configured items instead. Pure; the inputs are
 * not modified. See docs/encounters/inferno-policy.md (restarts keep worn equipment).
 */
export function carryWornEquipment(configured: WornLoadout, worn: PlayerEquipment): WornLoadout {
  const configuredEquipment = configured.equipment;
  const claimed = new Set<number>();
  const plans: CarryPlan[] = [];
  for (const group of CARRY_SLOT_GROUPS) {
    const changed = group.filter((slot) => worn[slot] !== configuredEquipment[slot]);
    if (changed.length === 0) continue;
    const takes = new Map<keyof PlayerEquipment, number>();
    for (const slot of changed) {
      const id = worn[slot];
      if (id === undefined) continue;
      const index = configured.inventory.findIndex((item, i) => item?.id === id && !claimed.has(i));
      if (index === -1) continue;
      claimed.add(index);
      takes.set(slot, index);
    }
    const puts = changed.flatMap((slot) => {
      const id = configuredEquipment[slot];
      return id === undefined ? [] : [{ slot, id }];
    });
    plans.push({ changed, takes, puts });
  }

  // Groups that free at least as many slots as they fill always fit; the rest, in slot order, while
  // free slots remain.
  let free = configured.inventory.filter((item) => item === null).length;
  const growth = (plan: CarryPlan) => plan.puts.length - plan.takes.size;
  const accepted = plans.filter((plan) => growth(plan) <= 0);
  for (const plan of accepted) free -= growth(plan);
  for (const plan of plans) {
    if (growth(plan) <= 0 || growth(plan) > free) continue;
    accepted.push(plan);
    free -= growth(plan);
  }

  const equipment: PlayerEquipment = { ...configuredEquipment };
  const inventory = cloneInventory(configured.inventory);
  for (const plan of accepted) {
    for (const slot of plan.changed) {
      const id = worn[slot];
      if (id === undefined) delete equipment[slot];
      else equipment[slot] = id;
    }
    for (const index of plan.takes.values()) inventory[index] = null;
  }
  // Each displaced item first into a slot its own group emptied (its own slot's, else the group's
  // other one), then the remainder into the first free slots.
  const unplaced: number[] = [];
  for (const plan of accepted) {
    const emptied = plan.changed.flatMap((slot) => {
      const index = plan.takes.get(slot);
      return index === undefined ? [] : [index];
    });
    const ordered = [...plan.puts].sort((a, b) => Number(plan.takes.has(b.slot)) - Number(plan.takes.has(a.slot)));
    for (const { slot, id } of ordered) {
      const own = plan.takes.get(slot);
      const index = own !== undefined && emptied.includes(own) ? own : emptied[0];
      if (index === undefined) {
        unplaced.push(id);
        continue;
      }
      emptied.splice(emptied.indexOf(index), 1);
      inventory[index] = { id };
    }
  }
  for (const id of unplaced) {
    const index = inventory.indexOf(null);
    // Unreachable (a group is accepted only while its displaced items fit), but a restart must
    // never fail halfway: carry nothing rather than throw after the engine has reset.
    if (index === -1) return configured;
    inventory[index] = { id };
  }
  return { equipment, inventory };
}
