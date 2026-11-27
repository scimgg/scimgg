import { type CombatStyle, getWeaponCategory } from '../../../types/attackStyles';
import type { EquipmentStats } from '../../../types/equipmentStats';
import type { NpcActor } from '../../actors/NpcActor';
import type { PlayerActor } from '../../actors/PlayerActor';
import type { EncounterEngineContext, EncounterEngineRules } from '../../encounters/types';
import type { ResolvedAttackResources } from '../attackResources';
import type { CombatFormulaStyle } from '../formulas';
import type { PlayerAttackDelivery } from '../playerAttackPlanning';
import { scalePlayerAttackMaximum, transformPlayerAttackPlan } from '../playerAttackPlanTransforms';
import type { StandardAccuracyMode } from '../playerAttackProfiles';
import { projectPlayerAttack } from '../playerAttackProjection';
import { resolvePlayerAttack } from '../playerAttackResolution';
import { planPlayerAttackFromRuntime } from '../playerAttackRuntime';
import type {
  FloorRatio,
  PlayerAttackPlan,
  PlayerDamageApplication,
  ReadyPlayerAttackPlan,
} from '../playerAttackTypes';
import { getPoweredStaffBaseMaxHit } from '../poweredStaffData';
import { selectPlayerAttackProfile } from './playerAttackProfileSelection';
import { soulreaperStackCount, soulreaperStrengthBonusPercent } from './soulreaper';
import { getSpecialAttackDef } from './specialAttacks/registry';

export type FirstPartyPlayerAttackInput = {
  readonly player: Readonly<
    Pick<
      PlayerActor,
      | 'stats'
      | 'equipment'
      | 'equipmentStats'
      | 'activePrayer'
      | 'offensivePrayer'
      | 'selectedAttackStyleIndex'
      | 'combatTimers'
    >
  > &
    Readonly<Partial<Pick<PlayerActor, 'vitals' | 'soulreaper'>>>;
  readonly target: Readonly<Pick<NpcActor, 'size' | 'npcTypeId' | 'formulaStats' | 'debuffs'>> &
    Readonly<Partial<Pick<NpcActor, 'vitals' | 'incomingHitCap'>>>;
  readonly formulaStyle: CombatFormulaStyle;
  readonly resources: ResolvedAttackResources;
  readonly attackSpeedTicks: number;
  readonly delivery: PlayerAttackDelivery;
  readonly application: PlayerDamageApplication;
  readonly manualCast: boolean;
  readonly isSpecialAttack: boolean;
  readonly standardAccuracyMode: StandardAccuracyMode;
  readonly encounterRules?: EncounterEngineRules;
  readonly encounterContext?: EncounterEngineContext;
  readonly lookupItemStats?: (itemId: number) => EquipmentStats | null;
  /** Chebyshev tiles from the player to the target's nearest tile, for distance-scaled accuracy. */
  readonly targetDistance?: number;
};

export type FirstPartyPlayerAttackResult = {
  readonly hits: readonly {
    readonly damage: number;
    readonly accurate: boolean;
    readonly style: PlayerAttackDelivery['style'];
    readonly attackKind: PlayerAttackDelivery['attackKind'];
    readonly impactDelayTicks: number;
    readonly procActivated?: true;
    readonly procSelfDamageRatio?: {
      readonly numerator: number;
      readonly denominator: number;
    };
  }[];
  readonly maximumRolledDamages: readonly number[];
  readonly expectedHit: number;
  readonly selectedBranchIndex: number | null;
};

export interface FirstPartyPlayerAttackOptions {
  readonly consumeGuaranteedMaximum?: boolean;
  readonly guaranteedMaximum?: boolean;
  /** Lowers the max hit before any guaranteed-maximum or minimum-hit rule applies to it. */
  readonly maximumHitScale?: FloorRatio;
}

export type FirstPartyPlayerAttackProjectionSummary = {
  readonly dps: number;
  readonly maxHit: number;
  readonly accuracy: number;
  readonly style: CombatFormulaStyle;
  readonly attackSpeedTicks: number;
  readonly attackIntervalSeconds: number;
  readonly expectedRolledDamagePerAttack: number;
  readonly expectedAppliedDamagePerAttack: number;
  readonly maximumRolledDamagePerAttack: number;
  readonly maximumAppliedDamagePerAttack: number;
  readonly outgoingDamageMultiplier: number;
  readonly specialAttackDamageMultiplier: number;
  readonly baseAttackRoll: number | null;
  readonly baseDefenceRoll: number | null;
  readonly baseMaxHit: number | null;
  readonly profileMaxHit: number | null;
  readonly hits: readonly {
    readonly planIndex: number;
    readonly accuracyProbability: number;
    readonly gateProbability: number;
    readonly expectedRolledDamage: number;
    readonly expectedAppliedDamage: number;
    readonly maximumRolledDamage: number;
    readonly maximumAppliedDamage: number;
    readonly procChance: number;
  }[];
};

export function planFirstPartyPlayerAttack(
  input: FirstPartyPlayerAttackInput,
  options: FirstPartyPlayerAttackOptions = {},
): PlayerAttackPlan | null {
  return planFirstPartyPlayerAttackInternal(
    input,
    options.consumeGuaranteedMaximum ?? true,
    options.guaranteedMaximum ?? false,
    options.maximumHitScale,
  );
}

export function projectFirstPartyPlayerAttack(
  input: FirstPartyPlayerAttackInput,
): FirstPartyPlayerAttackProjectionSummary | null {
  const plan = planFirstPartyPlayerAttackInternal(input, false, false);
  if (plan === null || plan.kind === 'unsupported') return null;
  const projection = projectPlayerAttack(plan);
  return {
    dps: projection.appliedDamagePerSecond,
    maxHit: projection.maximumAppliedDamagePerAttack,
    accuracy: projection.hits[0].accuracyProbability,
    style: input.formulaStyle,
    attackSpeedTicks: plan.attackSpeedTicks,
    attackIntervalSeconds: plan.attackSpeedTicks * 0.6,
    expectedRolledDamagePerAttack: projection.expectedRolledDamagePerAttack,
    expectedAppliedDamagePerAttack: projection.expectedAppliedDamagePerAttack,
    maximumRolledDamagePerAttack: projection.maximumRolledDamagePerAttack,
    maximumAppliedDamagePerAttack: projection.maximumAppliedDamagePerAttack,
    outgoingDamageMultiplier: plan.application.outgoingDamageMultiplier,
    specialAttackDamageMultiplier: plan.application.specialAttackDamageMultiplier,
    baseAttackRoll: plan.diagnostics?.baseAttackRoll ?? null,
    baseDefenceRoll: plan.diagnostics?.baseDefenceRoll ?? null,
    baseMaxHit: plan.diagnostics?.baseMaxHit ?? null,
    profileMaxHit: plan.diagnostics?.profileMaxHit ?? null,
    hits: projection.hits.map((hit, index) => ({
      planIndex: hit.planIndex,
      accuracyProbability: hit.accuracyProbability,
      gateProbability: hit.gateProbability,
      expectedRolledDamage: hit.expectedRolledDamage,
      expectedAppliedDamage: hit.expectedAppliedDamage,
      maximumRolledDamage: hit.maximumRolledDamage,
      maximumAppliedDamage: hit.maximumAppliedDamage,
      procChance: plan.hits[index]?.proc?.chance ?? 0,
    })),
  };
}

function planFirstPartyPlayerAttackInternal(
  input: FirstPartyPlayerAttackInput,
  consumeGuaranteedMaximum: boolean,
  guaranteedMaximumForCast: boolean,
  maximumHitScale?: FloorRatio,
): PlayerAttackPlan | null {
  const profile = selectPlayerAttackProfile({
    weaponId: input.player.equipment.weapon,
    headId: input.player.equipment.head,
    bodyId: input.player.equipment.body,
    legsId: input.player.equipment.legs,
    formulaStyle: input.formulaStyle,
    targetSize: input.target.size,
    isSpecialAttack: input.isSpecialAttack,
    resources: input.resources,
    targetAttributes: input.target.formulaStats?.attributes,
    targetMagicLevel: input.target.formulaStats?.levels.magic,
    targetMagicAttackBonus: input.target.formulaStats?.offensive.magic,
    targetCurrentHp: input.target.vitals?.hp,
    playerCurrentHp: input.player.vitals?.hp ?? input.player.stats.hitpoints.current,
    playerMissingPrayerPoints: input.player.stats.prayer.max - input.player.stats.prayer.current,
    markOfDarknessActive: input.player.combatTimers.markOfDarknessActiveTicks > 0,
    demonbaneVulnerability: input.target.formulaStats?.demonbaneVulnerability,
    soulreaperStacks: soulreaperStackCount(input.player.soulreaper),
    combatStyle: selectedCombatStyle(input.player),
    targetDistance: input.targetDistance,
  });
  if (profile === null) return null;

  const meleeStrengthBonusPercent = soulreaperStrengthBonusPercent(
    input.player.equipment.weapon,
    input.player.soulreaper,
    input.isSpecialAttack,
  );
  const runtimePlan = planPlayerAttackFromRuntime({
    player: input.player,
    ...(meleeStrengthBonusPercent === 0 ? {} : { meleeStrengthBonusPercent }),
    target: input.target,
    formulaStyle: input.formulaStyle,
    resources: input.resources,
    attackSpeedTicks: input.attackSpeedTicks,
    delivery: input.delivery,
    // The projection's expected and maximum applied damage follow the target's hit cap.
    application:
      input.target.incomingHitCap === undefined
        ? input.application
        : { ...input.application, targetHitCap: input.target.incomingHitCap },
    profile,
    manualCast: input.manualCast,
    standardAccuracyMode: input.standardAccuracyMode,
    ...specialDefenceStyle(input),
    ...(input.isSpecialAttack &&
    input.player.equipment.weapon !== undefined &&
    getSpecialAttackDef(input.player.equipment.weapon)?.poweredSpellWeaponId !== undefined
      ? { magicBaseMaxHitOverride: getPoweredStaffBaseMaxHit(27665, input.player.stats.magic.current) }
      : {}),
    ...(input.lookupItemStats === undefined ? {} : { lookupItemStats: input.lookupItemStats }),
  });
  if (runtimePlan === null || runtimePlan.kind === 'unsupported') return runtimePlan;
  const plan = maximumHitScale === undefined ? runtimePlan : scalePlayerAttackMaximum(runtimePlan, maximumHitScale);

  const encounterContext = input.encounterContext;
  const minimumDamageRule = input.encounterRules?.playerMinimumHit;
  const targetStats = input.target.formulaStats;
  const deliveryStyle = input.delivery.style;
  const targetForcesMaximum =
    (targetStats?.alwaysMaximumPlayerHit === true &&
      (deliveryStyle === 'magic' || input.delivery.attackKind === 'range_arrow')) ||
    (deliveryStyle !== 'typeless' && targetStats?.alwaysMaximumPlayerHitStyles?.includes(deliveryStyle) === true);
  const guaranteedMaximum =
    targetForcesMaximum ||
    guaranteedMaximumForCast ||
    (consumeGuaranteedMaximum &&
      encounterContext !== undefined &&
      (input.encounterRules?.consumePlayerGuaranteedMaxHit?.(encounterContext) ?? false));
  return transformPlayerAttackPlan(plan, {
    guaranteedAccuracy: input.target.formulaStats?.alwaysAccuratePlayerHit === true,
    guaranteedMaximum,
    ...(minimumDamageRule === undefined || encounterContext === undefined
      ? {}
      : { minimumDamage: (maximumRolledDamage: number) => minimumDamageRule(maximumRolledDamage, encounterContext) }),
  });
}

/**
 * One accuracy roll that decides an attack for every target it hits: the primary target's, for a
 * chinchompa. `chance` is that roll's probability, which a secondary's expected damage carries.
 */
export type SharedAccuracy = { readonly accurate: boolean; readonly chance: number };

/** The primary target's roll, to share with the secondaries. A primary with no plan never lands. */
export function sharedAccuracyOf(
  primaryPlan: ReadyPlayerAttackPlan | null,
  primaryResult: FirstPartyPlayerAttackResult,
): SharedAccuracy {
  const [firstHit] = primaryResult.hits;
  return {
    accurate: firstHit?.accurate ?? false,
    chance: primaryPlan === null ? 0 : (projectPlayerAttack(primaryPlan).hits[0]?.accuracyProbability ?? 0),
  };
}

/**
 * Without `sharedAccuracy`, each hit rolls its own accuracy against this plan's target. With it, the
 * shared roll decides every hit and only damage is rolled here: an accurate attack rolls this plan's
 * damage as if guaranteed to land, and an inaccurate one misses without drawing from `random`.
 */
export function resolveFirstPartyPlayerAttack(
  plan: ReadyPlayerAttackPlan,
  random: () => number,
  sharedAccuracy?: SharedAccuracy,
): FirstPartyPlayerAttackResult {
  if (sharedAccuracy !== undefined) return resolveWithSharedAccuracy(plan, random, sharedAccuracy);
  const resolved = resolvePlayerAttack(plan, random);
  const projection = projectPlayerAttack(plan);
  return {
    hits: resolved.hits.map((hit) => ({
      damage: hit.rolledDamage,
      accurate: hit.gatePassed && hit.accuracySucceeded,
      style: hit.style,
      attackKind: hit.attackKind,
      impactDelayTicks: hit.impactDelayTicks,
      ...(hit.procActivated === true ? { procActivated: true } : {}),
      ...(hit.procSelfDamageRatio === undefined ? {} : { procSelfDamageRatio: hit.procSelfDamageRatio }),
    })),
    maximumRolledDamages: projection.hits.map((hit) => hit.maximumRolledDamage),
    expectedHit: projection.expectedAppliedDamagePerAttack,
    selectedBranchIndex: resolved.selectedBranch?.kind === 'landed' ? resolved.selectedBranch.index : null,
  };
}

function resolveWithSharedAccuracy(
  plan: ReadyPlayerAttackPlan,
  random: () => number,
  sharedAccuracy: SharedAccuracy,
): FirstPartyPlayerAttackResult {
  const landing = transformPlayerAttackPlan(plan, { guaranteedAccuracy: true, guaranteedMaximum: false });
  const projection = projectPlayerAttack(landing);
  const landed = sharedAccuracy.accurate ? resolveFirstPartyPlayerAttack(landing, random) : null;
  return {
    hits:
      landed?.hits ??
      landing.hits.map((hit) => ({
        damage: 0,
        accurate: false,
        style: hit.style,
        attackKind: hit.attackKind,
        impactDelayTicks: hit.impactDelayTicks,
      })),
    maximumRolledDamages: projection.hits.map((hit) => hit.maximumRolledDamage),
    expectedHit: sharedAccuracy.chance * projection.expectedAppliedDamagePerAttack,
    selectedBranchIndex: landed?.selectedBranchIndex ?? null,
  };
}

/** The stance the player's selected style button sets, as `getFormulaStyle` reads the button. */
function selectedCombatStyle(player: FirstPartyPlayerAttackInput['player']): CombatStyle | undefined {
  const styles = getWeaponCategory(player.equipment.weapon).styles;
  return (styles[player.selectedAttackStyleIndex] ?? styles[0])?.combatStyle;
}

/** A special that always rolls against one melee defence, whatever style is selected. */
function specialDefenceStyle(input: FirstPartyPlayerAttackInput): { defenceStyle?: CombatFormulaStyle } {
  const weapon = input.player.equipment.weapon;
  if (!input.isSpecialAttack || weapon === undefined) return {};
  const defenceStyle = getSpecialAttackDef(weapon)?.defenceStyle;
  return defenceStyle === undefined ? {} : { defenceStyle };
}
