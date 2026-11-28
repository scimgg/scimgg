import { getEquipmentCombatBaseId } from '../../data/equipmentCombatFamilies';
import spells from '../../data/osrs/spells.json';
import { SEEKING_ARROWS } from '../../data/seekingArrows';
import type { PlayerEquipment } from '../../rs/model/PlayerModelLoader';
import type { EquipmentStats } from '../../types/equipmentStats';
import type { NpcActor } from '../actors/NpcActor';
import type { PlayerActor } from '../actors/PlayerActor';
import { isAmmoCompatible, isQuiverStorableAmmo } from './ammoCompatibility';
import type { ResolvedAttackResources } from './attackResources';
import {
  type CombatFormulaStyle,
  lookupPrayerMultipliersFromState,
  type NpcFormulaActor,
  type PlayerFormulaActor,
  type PlayerVoidSet,
} from './formulas';
import { type PlayerAttackDelivery, type PlayerAttackProfile, planPlayerAttack } from './playerAttackPlanning';
import { transformPlayerAttackPlan } from './playerAttackPlanTransforms';
import type { StandardAccuracyMode } from './playerAttackProfiles';
import type { PlayerAttackPlan, PlayerDamageApplication } from './playerAttackTypes';
import { selectedCombatStance } from './playerStance';
import { getPoweredStaffBaseMaxHit, getRangedDefenceType } from './weaponCombatData';

const VOID_TOP_IDS: ReadonlySet<number> = new Set([
  8839, 20465, 24177, 33476, 33478, 26463, 27000, 13072, 20467, 24178, 33480, 33482, 26469, 27003,
]);
const ELITE_VOID_TOP_IDS: ReadonlySet<number> = new Set([13072, 20467, 24178, 33480, 33482, 26469, 27003]);
const VOID_ROBE_IDS: ReadonlySet<number> = new Set([
  8840, 20469, 24179, 33484, 33486, 26465, 27001, 13073, 20471, 24180, 33488, 33490, 26471, 27004,
]);
const ELITE_VOID_ROBE_IDS: ReadonlySet<number> = new Set([13073, 20471, 24180, 33488, 33490, 26471, 27004]);
const VOID_GLOVE_IDS: ReadonlySet<number> = new Set([8842, 20475, 24182, 33492, 33494, 26467, 27002]);
const VOID_MAGE_HELM_IDS: ReadonlySet<number> = new Set([11663, 20477, 24183, 33468, 33470, 26473, 27005]);
const VOID_RANGER_HELM_IDS: ReadonlySet<number> = new Set([11664, 20479, 24184, 33472, 33474, 26475, 27006]);
const VOID_MELEE_HELM_IDS: ReadonlySet<number> = new Set([11665, 20481, 24185, 33464, 33466, 26477, 27007]);
const ECLIPSE_ATLATL_IDS: ReadonlySet<number> = new Set([29000, 29851]);
// Charged quiver, blessed quiver and Dizana's max cape, each with its (l) copy.
const CHARGED_DIZANA_QUIVER_IDS: ReadonlySet<number> = new Set([28951, 28953, 28955, 28957, 28902, 28906]);

export type PlayerAttackRuntimeInput = {
  readonly player: Readonly<
    Pick<
      PlayerActor,
      'stats' | 'equipment' | 'equipmentStats' | 'activePrayer' | 'offensivePrayer' | 'selectedAttackStyleIndex'
    >
  >;
  readonly target: Readonly<Pick<NpcActor, 'npcTypeId' | 'formulaStats' | 'debuffs'>>;
  readonly formulaStyle: CombatFormulaStyle;
  readonly magicBaseMaxHitOverride?: number;
  /** Whole percent added to the prayer Strength multiplier; see `PlayerFormulaActor`. */
  readonly meleeStrengthBonusPercent?: number;
  readonly resources: ResolvedAttackResources;
  readonly attackSpeedTicks: number;
  readonly delivery: PlayerAttackDelivery;
  readonly application: PlayerDamageApplication;
  readonly profile: PlayerAttackProfile;
  readonly standardAccuracyMode?: StandardAccuracyMode;
  readonly defenceStyle?: CombatFormulaStyle;
  readonly manualCast: boolean;
  readonly lookupItemStats?: (itemId: number) => EquipmentStats | null;
};

export function planPlayerAttackFromRuntime(input: PlayerAttackRuntimeInput): PlayerAttackPlan | null {
  if (input.profile.kind === 'unsupported') {
    return { kind: 'unsupported', gaps: input.profile.gaps };
  }
  const target = resolveTarget(input.target);
  if (target === null) return null;

  const equipmentStats = resolveEquipmentStats(input);
  if (equipmentStats === null) return null;

  const magicBase = input.magicBaseMaxHitOverride === undefined ? resolveMagicBase(input) : undefined;
  if (magicBase === null) return null;
  const magicBaseMaxHit = input.magicBaseMaxHitOverride ?? magicBase?.maxHit;
  const weakness = input.target.formulaStats?.elementalWeakness;
  const elementalWeaknessPercent =
    weakness !== undefined && magicBase?.element === weakness.element ? weakness.percent : 0;

  const attacker: PlayerFormulaActor = {
    kind: 'player',
    levels: {
      attack: input.player.stats.attack.current,
      strength: input.player.stats.strength.current,
      defence: input.player.stats.defence.current,
      ranged: input.player.stats.ranged.current,
      magic: input.player.stats.magic.current,
    },
    stance: input.manualCast ? 'Manual Cast' : selectedCombatStance(input.player),
    voidSet: resolveVoidSet(input.player.equipment),
    ...(isEclipseAtlatl(input.player.equipment.weapon)
      ? { rangedStrengthLevel: input.player.stats.strength.current }
      : {}),
    ...(magicBaseMaxHit === undefined ? {} : { magicBaseMaxHit }),
    ...(input.meleeStrengthBonusPercent ? { meleeStrengthBonusPercent: input.meleeStrengthBonusPercent } : {}),
  };

  const plan = planPlayerAttack({
    attacker,
    target,
    formulaStyle: input.formulaStyle,
    equipmentStats,
    prayerMultipliers: lookupPrayerMultipliersFromState(input.player.activePrayer, input.player.offensivePrayer),
    attackSpeedTicks: input.attackSpeedTicks,
    delivery: input.delivery,
    application: input.application,
    profile: input.profile,
    ...(input.standardAccuracyMode === undefined ? {} : { standardAccuracyMode: input.standardAccuracyMode }),
    ...(input.defenceStyle === undefined ? {} : { defenceStyle: input.defenceStyle }),
    rangedDefenceType: getRangedDefenceType(input.player.equipment.weapon),
    ...(elementalWeaknessPercent === 0 ? {} : { elementalWeaknessPercent }),
  });
  if (
    plan.kind === 'ready' &&
    input.formulaStyle === 'ranged' &&
    input.resources.kind === 'ammo' &&
    input.resources.source !== 'blowpipe' &&
    SEEKING_ARROWS[input.resources.ammoId] !== undefined &&
    input.player.equipment.weapon !== undefined &&
    isAmmoCompatible(input.player.equipment.weapon, input.resources.ammoId)
  ) {
    return transformPlayerAttackPlan(plan, {
      guaranteedAccuracy: false,
      guaranteedMaximum: false,
      minimumDamage: () => 3,
    });
  }
  return plan;
}

function resolveTarget(target: PlayerAttackRuntimeInput['target']): NpcFormulaActor | null {
  const stats = target.formulaStats;
  if (stats === undefined) return null;

  return {
    kind: 'npc',
    id: target.npcTypeId,
    levels: {
      ...stats.levels,
      defence: Math.max(0, stats.levels.defence - (target.debuffs?.defenceDrain ?? 0)),
      magic: Math.max(0, stats.levels.magic - (target.debuffs?.magicDrain ?? 0)),
    },
    offensive: { ...stats.offensive },
    defensive: { ...stats.defensive },
    ...(stats.maxHit === undefined ? {} : { maxHit: stats.maxHit }),
  };
}

function resolveEquipmentStats(input: PlayerAttackRuntimeInput): Readonly<EquipmentStats> | null {
  switch (input.resources.kind) {
    case 'ammo': {
      const ammoStats = input.lookupItemStats?.(input.resources.ammoId) ?? null;
      return ammoStats === null
        ? null
        : applyWeaponStatEffects(input, addAmmoStats(input.player.equipmentStats, ammoStats));
    }
    case 'spell':
    case 'none':
      return applyWeaponStatEffects(input, input.player.equipmentStats);
    case 'unavailable':
      return null;
    default:
      return assertNever(input.resources);
  }
}

function applyWeaponStatEffects(
  input: PlayerAttackRuntimeInput,
  stats: Readonly<EquipmentStats>,
): Readonly<EquipmentStats> {
  const weaponId = input.player.equipment.weapon;
  const quiverStats =
    input.resources.kind === 'ammo' &&
    input.resources.source === 'quiver' &&
    input.player.equipment.cape !== undefined &&
    CHARGED_DIZANA_QUIVER_IDS.has(input.player.equipment.cape) &&
    isQuiverStorableAmmo(input.resources.ammoId)
      ? { ...stats, attackRanged: stats.attackRanged + 10, rangedStrength: stats.rangedStrength + 1 }
      : stats;
  if (isEclipseAtlatl(weaponId)) return { ...quiverStats, rangedStrength: quiverStats.meleeStrength };
  if (weaponId !== 27275) return quiverStats;
  return {
    ...quiverStats,
    attackMagic: quiverStats.attackMagic * 3,
    magicDamage: Math.min(100, quiverStats.magicDamage * 3),
  };
}

function isEclipseAtlatl(weaponId: number | undefined): boolean {
  return weaponId !== undefined && ECLIPSE_ATLATL_IDS.has(weaponId);
}

function addAmmoStats(base: Readonly<EquipmentStats>, ammo: Readonly<EquipmentStats>): EquipmentStats {
  return {
    attackStab: base.attackStab + ammo.attackStab,
    attackSlash: base.attackSlash + ammo.attackSlash,
    attackCrush: base.attackCrush + ammo.attackCrush,
    attackMagic: base.attackMagic + ammo.attackMagic,
    attackRanged: base.attackRanged + ammo.attackRanged,
    defenceStab: base.defenceStab + ammo.defenceStab,
    defenceSlash: base.defenceSlash + ammo.defenceSlash,
    defenceCrush: base.defenceCrush + ammo.defenceCrush,
    defenceMagic: base.defenceMagic + ammo.defenceMagic,
    defenceRanged: base.defenceRanged + ammo.defenceRanged,
    meleeStrength: base.meleeStrength + ammo.meleeStrength,
    rangedStrength: base.rangedStrength + ammo.rangedStrength,
    magicDamage: base.magicDamage + ammo.magicDamage,
    prayer: base.prayer + ammo.prayer,
    attackSpeed: base.attackSpeed,
    attackRange: base.attackRange,
  };
}

/** A magic attack's base damage, and the element of the spell that deals it (none for a powered staff). */
type MagicBase = { readonly maxHit: number; readonly element: string | null };

function resolveMagicBase(input: PlayerAttackRuntimeInput): MagicBase | null | undefined {
  if (input.formulaStyle !== 'magic') return undefined;

  switch (input.resources.kind) {
    case 'spell': {
      const spellId = input.resources.spellId;
      const spell = spells.find((candidate) => candidate.name === spellId);
      if (spell === undefined) return null;
      return {
        maxHit: spell.name === 'Magic Dart' ? Math.floor(input.player.stats.magic.current / 10) + 10 : spell.maxHit,
        element: spell.element,
      };
    }
    case 'none': {
      const maxHit = getPoweredStaffBaseMaxHit(input.player.equipment.weapon, input.player.stats.magic.current);
      return maxHit === undefined ? null : { maxHit, element: null };
    }
    case 'ammo':
    case 'unavailable':
      return null;
    default:
      return assertNever(input.resources);
  }
}

function resolveVoidSet(equipment: Readonly<PlayerEquipment>): PlayerVoidSet {
  const [head, body, legs, hands] = [equipment.head, equipment.body, equipment.legs, equipment.hands].map((itemId) =>
    itemId === undefined ? undefined : getEquipmentCombatBaseId(itemId),
  );
  if (
    body === undefined ||
    legs === undefined ||
    hands === undefined ||
    !VOID_TOP_IDS.has(body) ||
    !VOID_ROBE_IDS.has(legs) ||
    !VOID_GLOVE_IDS.has(hands)
  ) {
    return 'none';
  }

  const elite = ELITE_VOID_TOP_IDS.has(body) && ELITE_VOID_ROBE_IDS.has(legs);
  if (head !== undefined && VOID_MAGE_HELM_IDS.has(head)) return elite ? 'elite_magic' : 'magic';
  if (head !== undefined && VOID_RANGER_HELM_IDS.has(head)) return elite ? 'elite_ranged' : 'ranged';
  if (head !== undefined && VOID_MELEE_HELM_IDS.has(head)) return 'melee';
  return 'none';
}

function assertNever(value: never): never {
  throw new TypeError(`Unhandled attack runtime value: ${JSON.stringify(value)}`);
}
