import type { EquipmentStats } from '../../types/equipmentStats';
import { meleeStrengthEffectiveLevel, rangedStrengthEffectiveLevel } from './effectiveLevels';
import {
  type CombatFormulaStyle,
  DEFAULT_PRAYER_MULTIPLIERS,
  type FormulaAttacker,
  type NpcFormulaActor,
  type PlayerFormulaActor,
  type PrayerMultipliers,
} from './formulaTypes';

export function calculateMaxHit(
  attacker: FormulaAttacker,
  style: CombatFormulaStyle,
  equipmentStats: EquipmentStats,
  prayerMultipliers: PrayerMultipliers = DEFAULT_PRAYER_MULTIPLIERS,
): number {
  switch (attacker.kind) {
    case 'npc':
      return npcMaxHit(attacker, style);
    case 'player':
      return playerMaxHit(attacker, style, equipmentStats, prayerMultipliers);
    default:
      return attacker;
  }
}

function npcMaxHit(attacker: NpcFormulaActor, style: CombatFormulaStyle): number {
  switch (style) {
    case 'melee_stab':
    case 'melee_slash':
    case 'melee_crush':
      return maxHitFromStrength(attacker.levels.strength + 9, attacker.offensive.str);
    case 'ranged':
      return maxHitFromStrength(attacker.levels.ranged + 9, attacker.offensive.rangedStr);
    case 'magic':
      return maxHitFromStrength(attacker.levels.magic + 9, attacker.offensive.magicStr);
    default:
      return style;
  }
}

function playerMaxHit(
  attacker: PlayerFormulaActor,
  style: CombatFormulaStyle,
  equipmentStats: EquipmentStats,
  prayers: PrayerMultipliers,
): number {
  switch (style) {
    case 'melee_stab':
    case 'melee_slash':
    case 'melee_crush':
      return maxHitFromStrength(meleeStrengthEffectiveLevel(attacker, prayers), equipmentStats.meleeStrength);
    case 'ranged':
      return maxHitFromStrength(rangedStrengthEffectiveLevel(attacker, prayers), equipmentStats.rangedStrength);
    case 'magic': {
      const baseMaxHit = Math.floor(attacker.magicBaseMaxHit ?? 0);
      // Summed in tenths of a percent, the finest step gear has (the cache param is in tenths):
      // the floating sum can floor a hit short, e.g. 25 × (1 + 0.15 + 0.01) is 28.999999999999996.
      const equipmentTenths = Math.round(equipmentStats.magicDamage * 10);
      const prayerTenths = Math.round((prayers.magicDamage - 1) * 1000);
      const voidTenths = attacker.voidSet === 'elite_magic' ? 50 : 0;
      return Math.floor((baseMaxHit * (1000 + equipmentTenths + prayerTenths + voidTenths)) / 1000);
    }
    default:
      return style;
  }
}

function maxHitFromStrength(effectiveStrength: number, strengthBonus: number): number {
  return Math.floor((effectiveStrength * (strengthBonus + 64) + 320) / 640);
}
