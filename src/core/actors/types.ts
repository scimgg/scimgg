import type { ItemActionOption } from '../../data/itemEffects';
import type { SpellElement } from '../../data/spellCatalog';
import type { PlayerEquipment } from '../../rs/model/PlayerModelLoader';
import type { DamageType, MeleeReach } from '../combat/attackTypes';

export type { DamageType } from '../combat/attackTypes';

export type ActorId = string;
export type ActorKind = 'player' | 'npc';

export interface ActorVitals {
  hp: number;
  maxHp: number;
}

export type EquipmentSlot = keyof PlayerEquipment;

export type QueuedEquipmentAction =
  | { type: 'unequip'; slot: EquipmentSlot }
  | { type: 'equip'; inventoryIndex: number; itemId: number; slot: EquipmentSlot }
  | { type: 'equip_ammo'; inventoryIndex: number; itemId: number }
  | { type: 'unequip_ammo' };

export interface QueuedItemAction {
  type: 'use_item';
  inventoryIndex: number;
  readonly option?: ItemActionOption;
}

export interface QueuedDropAction {
  type: 'drop_item';
  inventoryIndex: number;
}

/**
 * A "Take" the player has clicked but not yet completed. OSRS keeps this
 * interaction alive across ticks while the player walks to the tile, so it lives
 * on the actor rather than being resolved at click time.
 */
export interface PendingItemPickup {
  groundItemId: string;
}

export type NpcBurnImmunity = 'Weak' | 'Normal' | 'Strong';

export interface NpcAnimationSet {
  idle: number | null;
  walk: number | null;
  run: number | null;
  attack: number | null;
  death: number | null;
}

export interface NpcCombatState {
  attackSpeed: number;
  attackRange: number;
  attackStyle: DamageType;
  /** Shared by attack eligibility and pursuit; omitted means cardinal-only melee. */
  meleeReach?: MeleeReach;
  nextActionTick: number;
  /** Engine-refreshed before NPC movement; gates new attacks, not pending releases or pursuit. */
  startedTurnOverlappingTarget?: boolean;
  targetId: ActorId | null;
  animations: NpcAnimationSet;
  /**
   * Only committed outgoing attacks belong here; incoming engagement is tracked in retaliation.
   */
  lastAttackTick: number | null;
  retaliation?: {
    readonly mode: 'standard' | 'retarget' | 'one-tick';
    pending: { readonly tick: number; readonly sourceId: ActorId }[];
    lastIncomingAttackTick: number | null;
  };
}

export interface NpcFormulaStats {
  burnImmunity?: NpcBurnImmunity | null;
  /**
   * Percent of a freeze's duration the target shrugs off; 100 rejects the freeze outright.
   * Straight from the wiki's `freeze_resistance` monster field, so a gap in that field reads as
   * 0 (fully freezable) rather than as an assertion that the monster can be frozen.
   */
  freezeResistance?: number;
  /** Percent poison resistance from the wiki's `poison_resistance` field; 100 rejects poison. */
  poisonResistance?: number;
  /** Whether stat-draining attacks leave this NPC's combat levels intact. */
  statDrainImmune?: boolean;
  attributes?: readonly string[];
  /** Every player magic or arrow hit rolls its maximum (the void flare weakness). */
  alwaysMaximumPlayerHit?: boolean;
  /** Every player hit of these delivery styles rolls its maximum, e.g. a Fremennik warbander's weakness. */
  alwaysMaximumPlayerHitStyles?: readonly Exclude<DamageType, 'typeless'>[];
  /** Every player hit rolls accurate, whatever the style. Separate from {@link alwaysMaximumPlayerHit}, which a contract can switch off on its own. */
  alwaysAccuratePlayerHit?: boolean;
  /** Multiplier on the ACCURACY AND DAMAGE INCREASE a demonbane weapon or spell grants, not on the hit itself. */
  demonbaneVulnerability?: number;
  /** The wiki's `elemental_weakness` fields: a spell of this element gains `percent` accuracy and base damage. */
  elementalWeakness?: { readonly element: SpellElement; readonly percent: number };
  levels: {
    attack: number;
    strength: number;
    defence: number;
    ranged: number;
    magic: number;
  };
  offensive: {
    atk: number;
    ranged: number;
    magic: number;
    str: number;
    rangedStr: number;
    magicStr: number;
  };
  defensive: {
    stab: number;
    slash: number;
    crush: number;
    rangedLight: number;
    rangedStandard: number;
    rangedHeavy: number;
    magic: number;
  };
  maxHit?: number;
}
