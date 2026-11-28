import { z } from 'zod';
import { EQUIPMENT_PRESETS } from '../data/playerPresets';
import { canonicalEncounterKind, consolidateRetiredEncounterKinds } from '../encounters/catalog';
import type { PlayerEquipment } from '../rs/model/PlayerModelLoader';
import {
  cloneCombatSupplies,
  createEmptyCombatSupplies,
  type EncounterLoadout,
  normalizeCombatSupplies,
} from '../types/encounterLoadout';
import type { Inventory, InventorySlot } from '../types/inventory';
import { createEmptyInventory, INVENTORY_SIZE } from '../types/inventory';
import { cloneEquipment, cloneInventory } from '../util/loadoutUtils';

const recordSchema = z.record(z.string(), z.unknown());
const equipmentSchema = z.object({
  head: z.number().finite().optional(),
  cape: z.number().finite().optional(),
  amulet: z.number().finite().optional(),
  weapon: z.number().finite().optional(),
  body: z.number().finite().optional(),
  shield: z.number().finite().optional(),
  legs: z.number().finite().optional(),
  hands: z.number().finite().optional(),
  boots: z.number().finite().optional(),
  ring: z.number().finite().optional(),
});

export type EncounterLoadoutMap = Record<string, EncounterLoadout>;

export type NormalizedLoadoutMap = {
  readonly map: EncounterLoadoutMap;
  readonly repaired: boolean;
};

function normalizeEquipment(raw: unknown): PlayerEquipment {
  const parsed = equipmentSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/** A slot's runtime stack `quantity` is accepted but dropped, as loadout stacks model presence only. */
function normalizeInventorySlot(raw: unknown): InventorySlot {
  const parsed = z.object({ id: z.number().finite(), quantity: z.number().finite().optional() }).safeParse(raw);
  return parsed.success ? { id: parsed.data.id } : null;
}

function normalizeInventory(raw: unknown): Inventory {
  const normalized = createEmptyInventory();
  if (!Array.isArray(raw)) return normalized;
  const limit = Math.min(raw.length, INVENTORY_SIZE);
  for (let index = 0; index < limit; index++) normalized[index] = normalizeInventorySlot(raw[index]);
  return normalized;
}

export function cloneEncounterLoadout(loadout: EncounterLoadout): EncounterLoadout {
  return {
    equipment: cloneEquipment(loadout.equipment),
    inventory: cloneInventory(loadout.inventory),
    supplies: cloneCombatSupplies(loadout.supplies),
  };
}

export function getDefaultLoadout(encounterKind: string): EncounterLoadout {
  const encounterPresets = EQUIPMENT_PRESETS[canonicalEncounterKind(encounterKind)];
  const fallbackPreset = encounterPresets ? Object.values(encounterPresets)[0] : undefined;
  return {
    equipment: cloneEquipment(fallbackPreset?.equipment ?? {}),
    inventory: fallbackPreset ? cloneInventory(fallbackPreset.inventory) : createEmptyInventory(),
    supplies: fallbackPreset?.supplies ? cloneCombatSupplies(fallbackPreset.supplies) : createEmptyCombatSupplies(),
  };
}

export function normalizeEncounterLoadout(raw: unknown): EncounterLoadout {
  const parsed = recordSchema.safeParse(raw);
  const value = parsed.success ? parsed.data : {};
  return {
    equipment: normalizeEquipment(value.equipment),
    inventory: normalizeInventory(value.inventory),
    supplies: normalizeCombatSupplies(value.supplies),
  };
}

export function normalizeLoadoutMap(rawMap: unknown): NormalizedLoadoutMap {
  const parsedMap = recordSchema.safeParse(rawMap);
  if (!parsedMap.success) return { map: {}, repaired: false };

  const map: EncounterLoadoutMap = {};
  for (const [encounterKind, rawValue] of Object.entries(parsedMap.data)) {
    const parsedValue = recordSchema.safeParse(rawValue);
    if (!parsedValue.success) continue;
    map[encounterKind] = normalizeEncounterLoadout(parsedValue.data);
  }
  return consolidateRetiredLoadouts(map);
}

/**
 * Moves each retired kind's saved loadout onto the kind that owns it (`zuk` → `inferno`),
 * so the two stages share one loadout. When both were saved, the retired kind's wins: a player who
 * set up Zuk had made the more deliberate choice of the two (there are no timestamps to compare).
 * Idempotent: a consolidated map has no retired keys left, so the second pass reports no repair.
 */
export function consolidateRetiredLoadouts(map: EncounterLoadoutMap): NormalizedLoadoutMap {
  const consolidated = consolidateRetiredEncounterKinds(map, (_owned, retired) => cloneEncounterLoadout(retired));
  return { map: consolidated.map, repaired: consolidated.consolidated };
}
