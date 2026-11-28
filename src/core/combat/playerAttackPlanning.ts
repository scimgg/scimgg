import {
  type CombatFormulaStyle,
  calculateMaxHit,
  calculatePlayerNpcRollDetails,
  doubleRollHitChance,
  hitChance,
  steadyStateHitChance,
} from './formulas';
import type {
  AccuracyBranchProfile,
  AllMissOutcomeProfile,
  DamageRollProfile,
  FormulaAccuracyProfile,
  FormulaRatio,
  FractionBound,
  HitProcProfile,
  HitRollProfile,
  MaxHitProfile,
  PlayerAttackDelivery,
  PlayerAttackRequest,
  PriorDamageFollowUpProfile,
  StandardAccuracyMode,
  SupportedPlayerAttackProfile,
} from './playerAttackProfiles';
import type {
  AccuracySpec,
  BranchSelectionSpec,
  DamageSpec,
  HitGate,
  HitProcSpec,
  NonEmptyReadonlyArray,
  PlannedHit,
  PlayerAttackPlan,
} from './playerAttackTypes';

export type {
  DamageRollProfile,
  FormulaAccuracyProfile,
  FormulaRatio,
  FractionBound,
  HitRollProfile,
  MaxHitProfile,
  PlayerAttackDelivery,
  PlayerAttackProfile,
  PlayerAttackRequest,
  PriorDamageFollowUpProfile,
} from './playerAttackProfiles';

type AccuracyRolls = {
  readonly attackRoll: number;
  readonly defenceRoll: number;
};

type PlanningContext = {
  readonly formulaStyle: CombatFormulaStyle;
  readonly delivery: PlayerAttackDelivery;
  readonly maxHit: number;
  readonly accuracyRolls: AccuracyRolls;
  readonly standardAccuracyMode: StandardAccuracyMode;
  readonly elementalWeaknessPercent: number;
};

export function planPlayerAttack(request: PlayerAttackRequest): PlayerAttackPlan {
  switch (request.profile.kind) {
    case 'unsupported':
      return { kind: 'unsupported', gaps: request.profile.gaps };
    case 'singleHit':
    case 'independentMultiHit':
    case 'secondHitIfFirstAccurate':
    case 'priorDamageHits':
    case 'accuracyBranchedSplit':
      return compileReadyPlan(request, request.profile);
    default:
      return request.profile;
  }
}

function compileReadyPlan(request: PlayerAttackRequest, profile: SupportedPlayerAttackProfile): PlayerAttackPlan {
  const accuracyRolls = calculatePlayerNpcRollDetails(
    request.attacker,
    request.target,
    request.formulaStyle,
    request.equipmentStats,
    request.prayerMultipliers,
    request.defenceStyle,
    request.rangedDefenceType,
  );
  const baseMaxHit = calculateMaxHit(
    request.attacker,
    request.formulaStyle,
    request.equipmentStats,
    request.prayerMultipliers,
  );
  // Max hit per https://oldschool.runescape.wiki/w/Maximum_magic_hit; applying it last to accuracy is unconfirmed.
  const elementalWeaknessPercent = request.elementalWeaknessPercent ?? 0;
  const elementalWeaknessDamage = Math.floor(
    (Math.floor(request.attacker.magicBaseMaxHit ?? 0) * elementalWeaknessPercent) / 100,
  );
  const context: PlanningContext = {
    formulaStyle: request.formulaStyle,
    delivery: request.delivery,
    maxHit: applyMaxHitProfile(baseMaxHit, profile.maxHit) + elementalWeaknessDamage,
    accuracyRolls,
    standardAccuracyMode: request.standardAccuracyMode ?? 'single_roll',
    elementalWeaknessPercent,
  };

  return {
    kind: 'ready',
    attackSpeedTicks: request.attackSpeedTicks,
    application: request.application,
    diagnostics: {
      baseAttackRoll: accuracyRolls.attackRoll,
      baseDefenceRoll: accuracyRolls.defenceRoll,
      baseMaxHit,
      profileMaxHit: context.maxHit,
      ...(elementalWeaknessPercent === 0 ? {} : { elementalWeaknessPercent }),
    },
    hits: compileHits(profile, context),
    ...(profile.kind === 'accuracyBranchedSplit'
      ? { branchSelection: compileBranchSelection(profile.branches, profile.allMiss, profile.accuracy, context) }
      : {}),
  };
}

function compileBranchSelection(
  branches: readonly AccuracyBranchProfile[],
  allMiss: NonEmptyReadonlyArray<AllMissOutcomeProfile>,
  accuracy: FormulaAccuracyProfile,
  context: PlanningContext,
): BranchSelectionSpec {
  const chance = accuracySpecChance(compileAccuracy(accuracy, context));
  const [firstBranch, ...remainingBranches] = branches;
  if (firstBranch === undefined) throw new RangeError('Expected at least one accuracy branch');
  const toAttempt = (branch: AccuracyBranchProfile) => ({
    chance,
    total: {
      minimumInclusive: roundFraction(context.maxHit, branch.totalMinimum),
      maximumInclusive: roundFraction(context.maxHit, branch.totalMaximum),
    },
  });
  const [firstMiss, ...remainingMisses] = allMiss;
  return {
    attempts: [toAttempt(firstBranch), ...remainingBranches.map(toAttempt)],
    allMissWeights: [firstMiss.weight, ...remainingMisses.map((outcome) => outcome.weight)],
  };
}

function accuracySpecChance(spec: AccuracySpec): number {
  switch (spec.kind) {
    case 'roll':
      return spec.chance;
    case 'guaranteed':
      return 1;
    default:
      throw new TypeError(`Accuracy ${spec.kind} cannot select a damage branch`);
  }
}

function compileHits(
  profile: SupportedPlayerAttackProfile,
  context: PlanningContext,
): readonly [PlannedHit, ...PlannedHit[]] {
  switch (profile.kind) {
    case 'singleHit':
      return [compileHit(profile.hit, { kind: 'always' }, context)];
    case 'independentMultiHit': {
      const [firstFraction, ...remainingFractions] = profile.maximumFractions;
      return [
        compileIndependentHit(firstFraction, profile.accuracy, context),
        ...remainingFractions.map((fraction) => compileIndependentHit(fraction, profile.accuracy, context)),
      ];
    }
    case 'secondHitIfFirstAccurate':
      return [
        compileHit(profile.first, { kind: 'always' }, context),
        compileHit(profile.second, { kind: 'ifPriorAccurate', priorHitIndex: 0 }, context),
      ];
    case 'priorDamageHits': {
      const [firstFollowUp, ...remainingFollowUps] = profile.followUps;
      return [
        compileHit(profile.first, { kind: 'always' }, context),
        compilePriorDamageHit(firstFollowUp, context),
        ...remainingFollowUps.map((followUp) => compilePriorDamageHit(followUp, context)),
      ];
    }
    case 'accuracyBranchedSplit': {
      const [firstBranch, ...remainingBranches] = profile.branches;
      const splatCount = firstBranch.shares.length;
      for (const branch of remainingBranches) {
        if (branch.shares.length !== splatCount) {
          throw new RangeError('Every accuracy branch must split the total across the same number of hitsplats');
        }
      }
      if (profile.allMiss.some((outcome) => outcome.damages.length !== splatCount)) {
        throw new RangeError('Every all-miss outcome must cover the same number of hitsplats as each accuracy branch');
      }
      return [
        compileSplitHit(profile, 0, context),
        ...firstBranch.shares.slice(1).map((_, index) => compileSplitHit(profile, index + 1, context)),
      ];
    }
    default:
      return profile;
  }
}

function compileSplitHit(
  profile: Extract<SupportedPlayerAttackProfile, { readonly kind: 'accuracyBranchedSplit' }>,
  splatIndex: number,
  context: PlanningContext,
): PlannedHit {
  const [firstBranch, ...remainingBranches] = profile.branches;
  const shareAt = (branch: AccuracyBranchProfile) => {
    const share = branch.shares[splatIndex];
    if (share === undefined) throw new RangeError(`Missing branch share for hitsplat ${splatIndex}`);
    return { fraction: share.fraction, offset: share.offset };
  };
  const missAt = (outcome: AllMissOutcomeProfile) => {
    const damage = outcome.damages[splatIndex];
    if (damage === undefined) throw new RangeError(`Missing all-miss damage for hitsplat ${splatIndex}`);
    return damage;
  };
  const [firstMiss, ...remainingMisses] = profile.allMiss;
  return {
    ...context.delivery,
    gate: { kind: 'always' },
    accuracy: { kind: 'whenDamagePositive' },
    damage: {
      kind: 'bySelectedBranch',
      branches: [shareAt(firstBranch), ...remainingBranches.map(shareAt)],
      allMiss: [missAt(firstMiss), ...remainingMisses.map(missAt)],
    },
  };
}

function compileHit(profile: HitRollProfile, gate: HitGate, context: PlanningContext): PlannedHit {
  return {
    ...compileDelivery(context.delivery, profile.impactDelayOffsetTicks),
    gate,
    accuracy: compileAccuracy(profile.accuracy, context),
    damage: compileDamage(profile.damage, context),
    ...(profile.proc === undefined ? {} : { proc: compileProc(profile.proc, context.maxHit) }),
  };
}

function compileProc(profile: HitProcProfile, maxHit: number): HitProcSpec {
  switch (profile.kind) {
    case 'rubyBolt':
      return {
        kind: 'fixedDamage',
        chance: profile.chancePercent / 100,
        damage: Math.min(100, Math.floor(profile.targetCurrentHp / 5)),
        selfDamageRatio: { numerator: 1, denominator: 10 },
      };
    case 'diamondBolt':
      return {
        kind: 'uniformDamage',
        chance: profile.chancePercent / 100,
        minimumInclusive: 0,
        maximumInclusive: Math.floor((maxHit * 115) / 100),
      };
    default:
      return profile;
  }
}

function compileIndependentHit(
  fraction: FormulaRatio,
  accuracy: FormulaAccuracyProfile,
  context: PlanningContext,
): PlannedHit {
  return {
    ...context.delivery,
    gate: { kind: 'always' },
    accuracy: compileAccuracy(accuracy, context),
    damage: {
      kind: 'uniform',
      minimumInclusive: 0,
      maximumInclusive: applyRatio(context.maxHit, fraction),
    },
  };
}

function compilePriorDamageHit(followUp: PriorDamageFollowUpProfile, context: PlanningContext): PlannedHit {
  return {
    ...compileDelivery(context.delivery, followUp.impactDelayOffsetTicks),
    gate: { kind: 'ifPriorAccurate', priorHitIndex: followUp.referenceHitIndex },
    accuracy: { kind: 'guaranteed' },
    damage: {
      kind: 'floorFractionOfPriorHit',
      priorHitIndex: followUp.referenceHitIndex,
      numerator: followUp.fraction.numerator,
      denominator: followUp.fraction.denominator,
    },
  };
}

function compileDelivery(delivery: PlayerAttackDelivery, impactDelayOffsetTicks = 0): PlayerAttackDelivery {
  if (!Number.isInteger(impactDelayOffsetTicks) || impactDelayOffsetTicks < 0) {
    throw new RangeError('impactDelayOffsetTicks must be a non-negative integer');
  }
  return {
    ...delivery,
    impactDelayTicks: delivery.impactDelayTicks + impactDelayOffsetTicks,
  };
}

function compileAccuracy(profile: FormulaAccuracyProfile, context: PlanningContext): AccuracySpec {
  const { accuracyRolls: rolls, standardAccuracyMode, elementalWeaknessPercent } = context;
  const attackRoll = (stages: readonly FormulaRatio[] | undefined) =>
    applyRatio(applyStages(rolls.attackRoll, stages ?? []), {
      numerator: 100 + elementalWeaknessPercent,
      denominator: 100,
    });
  switch (profile.kind) {
    case 'standard':
      return {
        kind: 'roll',
        chance: standardAccuracyChance(attackRoll(profile.attackRollStages), rolls.defenceRoll, standardAccuracyMode),
      };
    case 'doubleRoll':
      return {
        kind: 'roll',
        chance: doubleRollHitChance(attackRoll(profile.attackRollStages), rolls.defenceRoll),
      };
    case 'guaranteed':
      return { kind: 'guaranteed' };
    default:
      return profile;
  }
}

function standardAccuracyChance(attackRoll: number, defenceRoll: number, mode: StandardAccuracyMode): number {
  const singleRoll = hitChance(attackRoll, defenceRoll);
  switch (mode) {
    case 'single_roll':
      return singleRoll;
    case 'double_roll':
      return doubleRollHitChance(attackRoll, defenceRoll);
    case 'steady_state':
      return steadyStateHitChance(singleRoll, doubleRollHitChance(attackRoll, defenceRoll));
    default:
      return mode;
  }
}

function compileDamage(profile: DamageRollProfile, context: PlanningContext): DamageSpec {
  switch (profile.kind) {
    case 'uniformToMaxHit': {
      const uniform: DamageSpec = {
        kind: 'uniform',
        minimumInclusive: 0,
        maximumInclusive: context.maxHit,
      };
      return context.formulaStyle === 'magic' ? { kind: 'minimum', base: uniform, minimumDamage: 1 } : uniform;
    }
    case 'uniformMaxHitFractionBounds':
      return {
        kind: 'uniform',
        minimumInclusive: roundFraction(context.maxHit, profile.minimum),
        maximumInclusive: roundFraction(context.maxHit, profile.maximum),
      };
    case 'uniformTrimmedMaxHit': {
      const trimmed = applyRatio(context.maxHit, profile.trim);
      return { kind: 'uniform', minimumInclusive: trimmed, maximumInclusive: context.maxHit - trimmed };
    }
    default:
      return profile;
  }
}

function applyMaxHitProfile(baseMaxHit: number, profile: MaxHitProfile): number {
  switch (profile.kind) {
    case 'base':
      return baseMaxHit;
    case 'staged':
      return applyStages(baseMaxHit, profile.stages);
    default:
      return profile;
  }
}

function applyStages(value: number, stages: readonly FormulaRatio[]): number {
  return stages.reduce((current, stage) => applyRatio(current, stage), value);
}

function applyRatio(value: number, ratio: FormulaRatio): number {
  return Math.floor((value * ratio.numerator) / ratio.denominator);
}

function roundFraction(maxHit: number, bound: FractionBound): number {
  const value = (maxHit * bound.ratio.numerator) / bound.ratio.denominator;
  return Math.max(0, roundBound(value, bound.rounding) + (bound.offset ?? 0));
}

function roundBound(value: number, rounding: FractionBound['rounding']): number {
  switch (rounding) {
    case 'floor':
      return Math.floor(value);
    case 'ceiling':
      return Math.ceil(value);
    default:
      return rounding;
  }
}
