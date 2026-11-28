/**
 * Every ratio here is a percentage the engine floors once per stage, matching how OSRS folds
 * equipment bonuses into the attack roll and max hit.
 */
import { getEquipmentCombatBaseId } from '../../../data/equipmentCombatFamilies';
import type { ResolvedAttackResources } from '../attackResources';
import type { FormulaRatio } from '../playerAttackProfiles';

export type OrdinaryModifierInput = {
  readonly weaponId: number | undefined;
  readonly headId: number | undefined;
  readonly bodyId: number | undefined;
  readonly legsId: number | undefined;
  readonly resources: ResolvedAttackResources | undefined;
  readonly targetAttributes: readonly string[];
  readonly targetMagicLevel: number;
  readonly targetMagicAttackBonus: number;
  readonly markOfDarknessActive: boolean;
  readonly demonbaneVulnerability: number;
  readonly twistedBowMagicCap?: number | undefined;
};

export type OrdinaryModifierStages = {
  readonly attackRollStages: readonly FormulaRatio[];
  readonly maxHitStages: readonly FormulaRatio[];
};

const NO_STAGES: OrdinaryModifierStages = { attackRollStages: [], maxHitStages: [] };

const TWISTED_BOW_IDS: ReadonlySet<number> = new Set([20997, 28540]);
/** The crystal bow and the Bow of Faerdhinen; /w/Crystal_equipment § Crystal armour. */
export const CRYSTAL_ARMOUR_BOW_IDS: ReadonlySet<number> = new Set([23983, 24123, 25865, 25867, 27187]);
const CRYSTAL_HELM_ID = 23971;
const CRYSTAL_BODY_ID = 23975;
const CRYSTAL_LEGS_ID = 23979;

/**
 * Outside the Chambers of Xeric the scaling input stops at 250, so a 550 Magic-attack boss like
 * TzKal-Zuk scales identically to a 250 one. Raising this to the raid's 350 would overstate every
 * encounter this simulator ships. /w/Twisted_bow § Passive effect
 */
const TWISTED_BOW_MAGIC_CAP = 250;

const DEMONBANE_SPELLS: ReadonlySet<string> = new Set(['Inferior Demonbane', 'Superior Demonbane', 'Dark Demonbane']);
const PURGING_STAFF_IDS: ReadonlySet<number> = new Set([29594, 33184]);

const DEMONBANE_WEAPON_BONUS_PERCENT: ReadonlyMap<number, number> = new Map([
  [2402, 60],
  [6745, 60],
  [6746, 60],
  [19675, 70],
  [29577, 5],
  [29589, 70],
  [29591, 30],
]);

const DEMON_ATTRIBUTE = 'demon';
const DRAGON_ATTRIBUTE = 'dragon';

/**
 * Dragonbane melee and ranged weapons (/w/Dragon_hunter_lance, /w/Dragon_hunter_crossbow):
 * - Dragon hunter lance (22978): +20% accuracy and +20% damage vs draconic targets.
 * - Dragon hunter crossbow (21012, base of 25916/25918): +30% accuracy and +25% damage vs draconic targets.
 */
const DRAGONBANE_WEAPON_BONUS: ReadonlyMap<
  number,
  { readonly accuracyPercent: number; readonly damagePercent: number }
> = new Map([
  [22978, { accuracyPercent: 120, damagePercent: 120 }],
  [21012, { accuracyPercent: 130, damagePercent: 125 }],
]);

function percent(value: number): FormulaRatio {
  return { numerator: value, denominator: 100 };
}

/**
 * A target's demonbane vulnerability scales the INCREASE a demonbane bonus grants, so a 200%
 * vulnerability turns +50% damage into +100% rather than into 100% of the max hit.
 */
function demonbanePercent(bonusPercent: number, vulnerability: number): FormulaRatio {
  return percent(100 + (bonusPercent - 100) * vulnerability);
}

export function ordinaryModifierStages(input: OrdinaryModifierInput): OrdinaryModifierStages {
  const demonbaneSpell = input.targetAttributes.includes(DEMON_ATTRIBUTE) ? demonbaneSpellStages(input) : null;
  if (demonbaneSpell !== null) return demonbaneSpell;
  if (input.resources?.kind === 'spell') return NO_STAGES;

  const twistedBow = twistedBowStages(input);
  if (twistedBow !== null) return twistedBow;
  const crystalArmour = crystalArmourStages(input);
  if (crystalArmour !== null) return crystalArmour;
  const dragonbane = input.targetAttributes.includes(DRAGON_ATTRIBUTE) ? dragonbaneWeaponStages(input) : null;
  if (dragonbane !== null) return dragonbane;
  if (!input.targetAttributes.includes(DEMON_ATTRIBUTE)) return NO_STAGES;
  return demonbaneWeaponStages(input);
}

function crystalArmourStages(input: OrdinaryModifierInput): OrdinaryModifierStages | null {
  if (input.weaponId === undefined || !CRYSTAL_ARMOUR_BOW_IDS.has(getEquipmentCombatBaseId(input.weaponId))) {
    return null;
  }
  const equipped = [input.headId, input.bodyId, input.legsId].map((id) =>
    id === undefined ? undefined : getEquipmentCombatBaseId(id),
  );
  const accuracyPercent =
    (equipped.includes(CRYSTAL_HELM_ID) ? 5 : 0) +
    (equipped.includes(CRYSTAL_BODY_ID) ? 15 : 0) +
    (equipped.includes(CRYSTAL_LEGS_ID) ? 10 : 0);
  const damageHalfPercent =
    (equipped.includes(CRYSTAL_HELM_ID) ? 5 : 0) +
    (equipped.includes(CRYSTAL_BODY_ID) ? 15 : 0) +
    (equipped.includes(CRYSTAL_LEGS_ID) ? 10 : 0);
  return {
    attackRollStages: [percent(100 + accuracyPercent)],
    maxHitStages: [{ numerator: 200 + damageHalfPercent, denominator: 200 }],
  };
}

/**
 * Both curves are quadratics in `3 * magic / 10` that peak and then fall away, so they are clamped
 * at both ends: without the floor a high-Magic target would produce a negative multiplier.
 * /w/Twisted_bow § Passive effect
 */
function twistedBowStages(input: OrdinaryModifierInput): OrdinaryModifierStages | null {
  if (input.weaponId === undefined || !TWISTED_BOW_IDS.has(input.weaponId)) return null;

  const magicCap = input.twistedBowMagicCap ?? TWISTED_BOW_MAGIC_CAP;
  const magic = Math.min(Math.max(input.targetMagicLevel, input.targetMagicAttackBonus), magicCap);
  const accuracy = twistedBowBonusPercent(magic, true);
  const damage = twistedBowBonusPercent(magic, false);

  return {
    attackRollStages: [percent(accuracy)],
    maxHitStages: [percent(damage)],
  };
}

function dragonbaneWeaponStages(input: OrdinaryModifierInput): OrdinaryModifierStages | null {
  if (input.weaponId === undefined) return null;
  const bonus = DRAGONBANE_WEAPON_BONUS.get(getEquipmentCombatBaseId(input.weaponId));
  if (bonus === undefined) return null;
  return {
    attackRollStages: [percent(bonus.accuracyPercent)],
    maxHitStages: [percent(bonus.damagePercent)],
  };
}

function twistedBowBonusPercent(magic: number, accuracy: boolean): number {
  const factor = accuracy ? 10 : 14;
  const base = accuracy ? 140 : 250;
  const linear = Math.trunc((3 * magic - factor) / 100);
  const quadratic = Math.trunc((Math.trunc((3 * magic) / 10) - 10 * factor) ** 2 / 100);
  return clamp(base + linear - quadratic, 0, base);
}

/**
 * Mark of Darkness doubles the accuracy bonus and adds a damage bonus, and a purging staff doubles
 * that boosted pair again. /w/Demonbane_spells
 */
function demonbaneSpellStages(input: OrdinaryModifierInput): OrdinaryModifierStages | null {
  const resources = input.resources;
  if (resources?.kind !== 'spell' || !DEMONBANE_SPELLS.has(resources.spellId)) return null;

  const vulnerability = input.demonbaneVulnerability;
  const scaled = (bonusPercent: number): FormulaRatio => demonbanePercent(bonusPercent, vulnerability);
  if (!input.markOfDarknessActive) return { attackRollStages: [scaled(120)], maxHitStages: [] };

  const purgingStaff = input.weaponId !== undefined && PURGING_STAFF_IDS.has(input.weaponId);
  return purgingStaff
    ? { attackRollStages: [scaled(180)], maxHitStages: [scaled(150)] }
    : { attackRollStages: [scaled(140)], maxHitStages: [scaled(125)] };
}

function demonbaneWeaponStages(input: OrdinaryModifierInput): OrdinaryModifierStages {
  const weaponId = input.weaponId;
  if (weaponId === undefined) return NO_STAGES;

  const scaled = (bonusPercent: number): FormulaRatio => demonbanePercent(bonusPercent, input.demonbaneVulnerability);
  const bonus = DEMONBANE_WEAPON_BONUS_PERCENT.get(getEquipmentCombatBaseId(weaponId));
  return bonus === undefined
    ? NO_STAGES
    : { attackRollStages: [scaled(100 + bonus)], maxHitStages: [scaled(100 + bonus)] };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
