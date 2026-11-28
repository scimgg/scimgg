import type { EquipmentStats } from '../../types/equipmentStats';
import type { DamageType } from '../actors/types';
import type { AttackKind } from '../events/types';
import type { CalcGap } from './combatGaps';
import type {
  CombatFormulaStyle,
  NpcFormulaActor,
  PlayerFormulaActor,
  PrayerMultipliers,
  RangedDefenceType,
} from './formulas';
import type { NonEmptyReadonlyArray, PlayerDamageApplication } from './playerAttackTypes';

export type FormulaRatio = {
  readonly numerator: number;
  readonly denominator: number;
};

export type StandardAccuracyMode = 'single_roll' | 'double_roll' | 'steady_state';

export type FormulaAccuracyProfile =
  | {
      readonly kind: 'standard';
      readonly attackRollStages?: readonly FormulaRatio[];
    }
  | {
      readonly kind: 'doubleRoll';
      readonly attackRollStages?: readonly FormulaRatio[];
    }
  | {
      readonly kind: 'guaranteed';
    };

export type MaxHitProfile =
  | {
      readonly kind: 'base';
    }
  | {
      readonly kind: 'staged';
      readonly stages: readonly [FormulaRatio, ...FormulaRatio[]];
    };

export type FractionBound = {
  readonly ratio: FormulaRatio;
  readonly rounding: 'floor' | 'ceiling';
  /** Added after rounding, e.g. Slice and Dice's "1 point less than the max hit". */
  readonly offset?: number;
};

/** One way a swing whose every accuracy roll missed can land, with a damage per hitsplat. */
export type AllMissOutcomeProfile = {
  readonly weight: number;
  readonly damages: NonEmptyReadonlyArray<number>;
};

export type DamageRollProfile =
  | {
      readonly kind: 'uniformToMaxHit';
    }
  | {
      readonly kind: 'uniformMaxHitFractionBounds';
      readonly minimum: FractionBound;
      readonly maximum: FractionBound;
    }
  | {
      /** From `floor(max * trim)` to `max - floor(max * trim)`: the same amount trimmed off each end. */
      readonly kind: 'uniformTrimmedMaxHit';
      readonly trim: FormulaRatio;
    };

export type HitProcProfile =
  | {
      readonly kind: 'rubyBolt';
      readonly chancePercent: number;
      readonly targetCurrentHp: number;
    }
  | {
      readonly kind: 'diamondBolt';
      readonly chancePercent: number;
    };

export type HitRollProfile = {
  readonly impactDelayOffsetTicks?: number;
  readonly accuracy: FormulaAccuracyProfile;
  readonly damage: DamageRollProfile;
  readonly proc?: HitProcProfile;
};

export type PriorDamageFollowUpProfile = {
  readonly referenceHitIndex: number;
  readonly fraction: FormulaRatio;
  readonly impactDelayOffsetTicks?: number;
};

export type SplitShareProfile = {
  readonly fraction: FormulaRatio;
  readonly offset: number;
};

export type AccuracyBranchProfile = {
  readonly totalMinimum: FractionBound;
  readonly totalMaximum: FractionBound;
  readonly shares: NonEmptyReadonlyArray<SplitShareProfile>;
};

export type PlayerAttackProfile =
  | {
      readonly kind: 'singleHit';
      readonly maxHit: MaxHitProfile;
      readonly hit: HitRollProfile;
    }
  | {
      readonly kind: 'independentMultiHit';
      readonly maxHit: MaxHitProfile;
      readonly accuracy: FormulaAccuracyProfile;
      readonly maximumFractions: readonly [FormulaRatio, ...FormulaRatio[]];
    }
  | {
      readonly kind: 'secondHitIfFirstAccurate';
      readonly maxHit: MaxHitProfile;
      readonly first: HitRollProfile;
      readonly second: HitRollProfile;
    }
  | {
      readonly kind: 'priorDamageHits';
      readonly maxHit: MaxHitProfile;
      readonly first: HitRollProfile;
      readonly followUps: readonly [PriorDamageFollowUpProfile, ...PriorDamageFollowUpProfile[]];
    }
  | {
      readonly kind: 'accuracyBranchedSplit';
      readonly maxHit: MaxHitProfile;
      readonly accuracy: FormulaAccuracyProfile;
      readonly branches: NonEmptyReadonlyArray<AccuracyBranchProfile>;
      /** Whole-swing outcomes, so a miss can spread damage across splats (Slice and Dice's 1-1-0-0). */
      readonly allMiss: NonEmptyReadonlyArray<AllMissOutcomeProfile>;
    }
  | {
      readonly kind: 'unsupported';
      readonly gaps: readonly [CalcGap, ...CalcGap[]];
    };

export type PlayerAttackDelivery = {
  readonly style: DamageType;
  readonly attackKind: AttackKind;
  readonly impactDelayTicks: number;
};

export type PlayerAttackRequest = {
  readonly attacker: PlayerFormulaActor;
  readonly target: NpcFormulaActor;
  readonly formulaStyle: CombatFormulaStyle;
  readonly equipmentStats: Readonly<EquipmentStats>;
  readonly prayerMultipliers: PrayerMultipliers;
  readonly attackSpeedTicks: number;
  readonly delivery: PlayerAttackDelivery;
  readonly application: PlayerDamageApplication;
  readonly profile: PlayerAttackProfile;
  readonly standardAccuracyMode?: StandardAccuracyMode;
  /** Target defence to roll against when it differs from `formulaStyle` (a fixed special). */
  readonly defenceStyle?: CombatFormulaStyle;
  /** The attacking weapon's ranged type; only consulted when the defence roll is ranged. */
  readonly rangedDefenceType: RangedDefenceType;
  /** The target's elemental weakness percent when the cast spell matches its element; absent otherwise. */
  readonly elementalWeaknessPercent?: number;
};

export type SupportedPlayerAttackProfile = Exclude<PlayerAttackProfile, { readonly kind: 'unsupported' }>;
