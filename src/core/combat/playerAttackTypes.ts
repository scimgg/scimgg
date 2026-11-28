import type { DamageType } from '../actors/types';
import type { AttackKind } from '../events/types';
import type { CalcGap } from './combatGaps';

export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

export type FloorRatio = {
  readonly numerator: number;
  readonly denominator: number;
};

export type AccuracySpec =
  | {
      readonly kind: 'roll';
      readonly chance: number;
    }
  | {
      readonly kind: 'guaranteed';
    }
  | {
      readonly kind: 'rollUnlessAnyPriorAccurate';
      readonly chance: number;
      readonly priorHitIndices: NonEmptyReadonlyArray<number>;
    }
  | {
      /**
       * The hitsplat counts as a hit exactly when it deals damage, because the swing's accuracy
       * was already rolled once by {@link BranchSelectionSpec}. Giving these splats a roll of
       * their own instead re-rolls accuracy the game rolled once, and feeds a share that floors
       * to 0 into the player min-1 rule in `CombatSystem.applyResolvedHit` — which is what turns
       * Burning barrage's 0-0-0 miss into 1-1-1.
       */
      readonly kind: 'whenDamagePositive';
    };

export type DamageSpec =
  | {
      readonly kind: 'uniform';
      readonly minimumInclusive: number;
      readonly maximumInclusive: number;
    }
  | {
      readonly kind: 'fixed';
      readonly damage: number;
    }
  | {
      readonly kind: 'floorFractionOfPriorHit';
      readonly priorHitIndex: number;
      readonly numerator: number;
      readonly denominator: number;
    }
  | {
      readonly kind: 'minimum';
      readonly base: DamageSpec;
      readonly minimumDamage: number;
    }
  | {
      readonly kind: 'floorScale';
      readonly base: DamageSpec;
      readonly ratio: FloorRatio;
    }
  | {
      readonly kind: 'floorScaleOnProc';
      readonly base: DamageSpec;
      readonly chance: number;
      readonly ratio: FloorRatio;
    }
  | {
      readonly kind: 'addFloorScaledCopy';
      readonly base: DamageSpec;
      readonly stages: NonEmptyReadonlyArray<FloorRatio>;
    }
  | {
      readonly kind: 'weighted';
      readonly outcomes: NonEmptyReadonlyArray<WeightedDamageOutcome>;
    }
  | {
      readonly kind: 'bySelectedBranch';
      readonly branches: NonEmptyReadonlyArray<BranchSplitSpec>;
      /** This splat's damage in each of the swing's all-miss outcomes. */
      readonly allMiss: NonEmptyReadonlyArray<number>;
      /**
       * Floor applied ONLY when an accuracy attempt succeeded. An encounter minimum-hit rule
       * (Bloodied Blows' Wretched Strength) raises a hit that LANDED; wrapping the whole spec in
       * `minimum` instead raises the all-miss fallback too, and since these splats are accurate
       * exactly when they deal damage, that turns a swing which missed all three rolls into three
       * full-size accurate hits.
       */
      readonly minimumWhenSelected?: number;
    };

export type WeightedDamageOutcome = {
  readonly damage: number;
  readonly weight: number;
};

/** This hitsplat's share of the swing's total roll: `floor(total * n / d) + offset`, floored at 0. */
export type BranchSplitSpec = {
  readonly fraction: FloorRatio;
  readonly offset: number;
};

export type AttackBranchSpec = {
  readonly chance: number;
  readonly total: {
    readonly minimumInclusive: number;
    readonly maximumInclusive: number;
  };
};

/**
 * One accuracy roll per attempt, in order, stopping at the first success; that attempt's index
 * picks every `bySelectedBranch` splat's share and its `total` range is rolled once for the whole
 * swing. Burning barrage is why the total is rolled here rather than on the first hitsplat: its
 * shares are 25%/25%/50% of one roll, and no later splat can recover that roll from an earlier
 * splat's floored share. When every attempt misses, one all-miss outcome is picked by weight for
 * the whole swing, for the same reason: Slice and Dice's misses land as 1-1-0-0 or 0-1-0-1, never
 * as independent per-splat rolls.
 */
export type BranchSelectionSpec = {
  readonly attempts: NonEmptyReadonlyArray<AttackBranchSpec>;
  readonly allMissWeights: NonEmptyReadonlyArray<number>;
};

export type SelectedBranch =
  | {
      readonly kind: 'landed';
      /** The accuracy attempt that succeeded. */
      readonly index: number;
      readonly total: number;
    }
  | {
      readonly kind: 'allMiss';
      /** Index into the swing's all-miss outcomes. */
      readonly outcome: number;
    };

export type HitGate =
  | {
      readonly kind: 'always';
    }
  | {
      readonly kind: 'ifPriorAccurate';
      readonly priorHitIndex: number;
    }
  | {
      readonly kind: 'ifPriorInaccurate';
      readonly priorHitIndex: number;
    };

export type HitProcSpec =
  | {
      readonly kind: 'fixedDamage';
      readonly chance: number;
      readonly damage: number;
      readonly selfDamageRatio?: FloorRatio;
    }
  | {
      readonly kind: 'uniformDamage';
      readonly chance: number;
      readonly minimumInclusive: number;
      readonly maximumInclusive: number;
    };

export type PlannedHit = {
  readonly style: DamageType;
  readonly attackKind: AttackKind;
  /** Absolute from swing launch, not relative to the previous hit. */
  readonly impactDelayTicks: number;
  readonly gate: HitGate;
  readonly accuracy: AccuracySpec;
  readonly damage: DamageSpec;
  readonly proc?: HitProcSpec;
};

export type PlayerDamageApplication = {
  readonly outgoingDamageMultiplier: number;
  readonly specialAttackDamageMultiplier: number;
};

export type PlayerAttackCalculationDiagnostics = {
  readonly baseAttackRoll: number;
  readonly baseDefenceRoll: number;
  readonly baseMaxHit: number;
  readonly profileMaxHit: number;
  /** The target's elemental weakness percent this attack applies; absent when it applies none. */
  readonly elementalWeaknessPercent?: number;
};

export type PlayerAttackPlan =
  | {
      readonly kind: 'ready';
      readonly attackSpeedTicks: number;
      readonly application: PlayerDamageApplication;
      readonly hits: NonEmptyReadonlyArray<PlannedHit>;
      readonly branchSelection?: BranchSelectionSpec;
      readonly diagnostics?: PlayerAttackCalculationDiagnostics;
    }
  | {
      readonly kind: 'unsupported';
      readonly gaps: NonEmptyReadonlyArray<CalcGap>;
    };

export type ReadyPlayerAttackPlan = Extract<PlayerAttackPlan, { readonly kind: 'ready' }>;

export type ResolvedHit = {
  readonly planIndex: number;
  readonly style: DamageType;
  readonly attackKind: AttackKind;
  readonly impactDelayTicks: number;
  readonly gatePassed: boolean;
  readonly accuracySucceeded: boolean;
  /** Damage before application multiplier stages. */
  readonly rolledDamage: number;
  readonly procActivated?: true;
  readonly procSelfDamageRatio?: FloorRatio;
};

export type ResolvedAttack = {
  readonly attackSpeedTicks: number;
  readonly application: PlayerDamageApplication;
  /** One stable entry per planned hit, including gate-suppressed hits. */
  readonly hits: NonEmptyReadonlyArray<ResolvedHit>;
  readonly selectedBranch: SelectedBranch | null;
};

export type ProjectedHit = {
  readonly planIndex: number;
  readonly gateProbability: number;
  readonly accuracyProbability: number;
  readonly expectedRolledDamage: number;
  readonly expectedAppliedDamage: number;
  readonly maximumRolledDamage: number;
  readonly maximumAppliedDamage: number;
};

export type AttackProjection = {
  readonly hits: NonEmptyReadonlyArray<ProjectedHit>;
  readonly expectedRolledDamagePerAttack: number;
  readonly expectedAppliedDamagePerAttack: number;
  readonly maximumRolledDamagePerAttack: number;
  readonly maximumAppliedDamagePerAttack: number;
  readonly appliedDamagePerSecond: number;
};
