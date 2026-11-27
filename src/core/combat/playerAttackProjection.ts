import type { IncomingHitCap } from '../actors/NpcActor';
import { visitDamageSpecOutcomes } from './damageSpecMass';
import { collectFutureDependencies, dependencyKey } from './playerAttackProjectionDependencies';
import type {
  AccuracySpec,
  AttackProjection,
  BranchSelectionSpec,
  HitGate,
  HitProcSpec,
  PlannedHit,
  PlayerDamageApplication,
  ProjectedHit,
  ReadyPlayerAttackPlan,
  SelectedBranch,
} from './playerAttackTypes';

type Branch = {
  readonly probability: number;
  readonly priorAccuracy: readonly boolean[];
  readonly priorDamage: readonly number[];
  readonly maximumRolledTotal: number;
  readonly maximumAppliedTotal: number;
  readonly selectedBranch: SelectedBranch | null;
};

type ProjectionStep = {
  readonly planIndex: number;
  readonly hit: PlannedHit;
  readonly branches: readonly Branch[];
  readonly application: PlayerDamageApplication;
  readonly futureDependencies: ReturnType<typeof collectFutureDependencies>;
};

type ProjectionStepResult = {
  readonly hit: ProjectedHit;
  readonly branches: readonly Branch[];
};

type HitOutcome = {
  readonly accuracySucceeded: boolean;
  readonly rolledDamage: number;
  readonly probability: number;
};

export function projectPlayerAttack(plan: ReadyPlayerAttackPlan): AttackProjection {
  const [firstHit, ...remainingHits] = plan.hits;
  let branches: readonly Branch[] = seedBranches(plan.branchSelection);

  const firstResult = projectHit({
    planIndex: 0,
    hit: firstHit,
    branches,
    application: plan.application,
    futureDependencies: collectFutureDependencies(plan.hits, 1),
  });
  const projectedHits: [ProjectedHit, ...ProjectedHit[]] = [firstResult.hit];
  branches = firstResult.branches;

  let planIndex = 1;
  for (const hit of remainingHits) {
    const result = projectHit({
      planIndex,
      hit,
      branches,
      application: plan.application,
      futureDependencies: collectFutureDependencies(plan.hits, planIndex + 1),
    });
    projectedHits.push(result.hit);
    branches = result.branches;
    planIndex += 1;
  }

  const expectedRolledDamagePerAttack = projectedHits.reduce((total, hit) => total + hit.expectedRolledDamage, 0);
  const expectedAppliedDamagePerAttack = projectedHits.reduce((total, hit) => total + hit.expectedAppliedDamage, 0);
  const maximumRolledDamagePerAttack = branches.reduce(
    (maximum, branch) => Math.max(maximum, branch.maximumRolledTotal),
    0,
  );
  const maximumAppliedDamagePerAttack = branches.reduce(
    (maximum, branch) => Math.max(maximum, branch.maximumAppliedTotal),
    0,
  );

  return {
    hits: projectedHits,
    expectedRolledDamagePerAttack,
    expectedAppliedDamagePerAttack,
    maximumRolledDamagePerAttack,
    maximumAppliedDamagePerAttack,
    appliedDamagePerSecond: expectedAppliedDamagePerAttack / (plan.attackSpeedTicks * 0.6),
  };
}

function seedBranches(selection: BranchSelectionSpec | undefined): readonly Branch[] {
  const empty = {
    priorAccuracy: [],
    priorDamage: [],
    maximumRolledTotal: 0,
    maximumAppliedTotal: 0,
  } as const;
  if (selection === undefined) return [{ ...empty, probability: 1, selectedBranch: null }];

  // Unreachable branches are DROPPED, not seeded at probability zero. A guaranteed swing forces
  // the first attempt to chance 1, and a zero-probability later branch left in the list still
  // contributes its damage to the per-hit maxima — which `guaranteedMaximum` then pins as fixed
  // damage, combining splats from branches that cannot both happen.
  const seeded: Branch[] = [];
  let reachedProbability = 1;
  for (const [index, attempt] of selection.attempts.entries()) {
    const { minimumInclusive, maximumInclusive } = attempt.total;
    const totalCount = maximumInclusive - minimumInclusive + 1;
    const perTotal = (reachedProbability * attempt.chance) / totalCount;
    if (perTotal > 0) {
      for (let total = minimumInclusive; total <= maximumInclusive; total += 1) {
        seeded.push({ ...empty, probability: perTotal, selectedBranch: { kind: 'landed', index, total } });
      }
    }
    reachedProbability *= 1 - attempt.chance;
  }
  if (reachedProbability > 0 || seeded.length === 0) {
    const totalWeight = selection.allMissWeights.reduce((total, weight) => total + weight, 0);
    for (const [outcome, weight] of selection.allMissWeights.entries()) {
      if (weight > 0 || seeded.length === 0) {
        seeded.push({
          ...empty,
          probability: (reachedProbability * weight) / totalWeight,
          selectedBranch: { kind: 'allMiss', outcome },
        });
      }
    }
  }
  return seeded;
}

function projectHit(step: ProjectionStep): ProjectionStepResult {
  const nextBranches = new Map<string, Branch>();
  let gateProbability = 0;
  let accuracyProbability = 0;
  let expectedRolledDamage = 0;
  let expectedAppliedDamage = 0;
  let maximumRolledDamage = 0;
  let maximumAppliedDamage = 0;

  const recordOutcome = (branch: Branch, outcome: HitOutcome): void => {
    const applicationBaseDamage = outcome.accuracySucceeded ? Math.max(1, outcome.rolledDamage) : 0;
    const applied = capTargetHit(applyDamage(applicationBaseDamage, step.application), step.application.targetHitCap);
    if (outcome.accuracySucceeded) {
      accuracyProbability += outcome.probability;
    }
    expectedRolledDamage += outcome.probability * outcome.rolledDamage;
    expectedAppliedDamage += outcome.probability * applied.expected;
    maximumRolledDamage = Math.max(maximumRolledDamage, outcome.rolledDamage);
    maximumAppliedDamage = Math.max(maximumAppliedDamage, applied.maximum);

    const nextBranch: Branch = {
      probability: outcome.probability,
      priorAccuracy: [...branch.priorAccuracy, outcome.accuracySucceeded],
      priorDamage: [...branch.priorDamage, outcome.rolledDamage],
      maximumRolledTotal: branch.maximumRolledTotal + outcome.rolledDamage,
      maximumAppliedTotal: branch.maximumAppliedTotal + applied.maximum,
      selectedBranch: branch.selectedBranch,
    };
    const key = dependencyKey(
      nextBranch.priorAccuracy,
      nextBranch.priorDamage,
      nextBranch.selectedBranch,
      step.futureDependencies,
    );
    const existing = nextBranches.get(key);
    nextBranches.set(
      key,
      existing === undefined
        ? nextBranch
        : {
            ...existing,
            probability: existing.probability + nextBranch.probability,
            maximumRolledTotal: Math.max(existing.maximumRolledTotal, nextBranch.maximumRolledTotal),
            maximumAppliedTotal: Math.max(existing.maximumAppliedTotal, nextBranch.maximumAppliedTotal),
          },
    );
  };

  for (const branch of step.branches) {
    if (!gatePasses(step.hit.gate, branch.priorAccuracy)) {
      recordOutcome(branch, { accuracySucceeded: false, rolledDamage: 0, probability: branch.probability });
      continue;
    }

    gateProbability += branch.probability;
    if (step.hit.accuracy.kind === 'whenDamagePositive') {
      visitDamageSpecOutcomes(step.hit.damage, branch.priorDamage, branch.selectedBranch, (rolledDamage, chance) => {
        recordOutcome(branch, {
          accuracySucceeded: rolledDamage > 0,
          rolledDamage,
          probability: branch.probability * chance,
        });
      });
      continue;
    }

    const procChance = step.hit.proc?.chance ?? 0;
    if (step.hit.proc !== undefined && procChance > 0) {
      visitProcDamageOutcomes(step.hit.proc, (rolledDamage, damageProbability) => {
        recordOutcome(branch, {
          accuracySucceeded: true,
          rolledDamage,
          probability: branch.probability * procChance * damageProbability,
        });
      });
    }

    const successChance = accuracySuccessChance(step.hit.accuracy, branch.priorAccuracy);
    if (successChance < 1) {
      recordOutcome(branch, {
        accuracySucceeded: false,
        rolledDamage: 0,
        probability: branch.probability * (1 - procChance) * (1 - successChance),
      });
    }
    if (successChance > 0) {
      visitDamageSpecOutcomes(
        step.hit.damage,
        branch.priorDamage,
        branch.selectedBranch,
        (rolledDamage, damageProbability) => {
          recordOutcome(branch, {
            accuracySucceeded: true,
            rolledDamage,
            probability: branch.probability * (1 - procChance) * successChance * damageProbability,
          });
        },
      );
    }
  }

  return {
    hit: {
      planIndex: step.planIndex,
      gateProbability,
      accuracyProbability,
      expectedRolledDamage,
      expectedAppliedDamage,
      maximumRolledDamage,
      maximumAppliedDamage,
    },
    branches: [...nextBranches.values()],
  };
}

function visitProcDamageOutcomes(proc: HitProcSpec, visit: (damage: number, probability: number) => void): void {
  switch (proc.kind) {
    case 'fixedDamage':
      visit(proc.damage, 1);
      return;
    case 'uniformDamage': {
      const probability = 1 / (proc.maximumInclusive - proc.minimumInclusive + 1);
      for (let damage = proc.minimumInclusive; damage <= proc.maximumInclusive; damage += 1) {
        visit(damage, probability);
      }
      return;
    }
    default:
      assertNever(proc);
  }
}

function gatePasses(gate: HitGate, priorAccuracy: readonly boolean[]): boolean {
  switch (gate.kind) {
    case 'always':
      return true;
    case 'ifPriorAccurate':
      return getPriorAccuracy(priorAccuracy, gate.priorHitIndex);
    case 'ifPriorInaccurate':
      return !getPriorAccuracy(priorAccuracy, gate.priorHitIndex);
    default:
      return assertNever(gate);
  }
}

function accuracySuccessChance(spec: AccuracySpec, priorAccuracy: readonly boolean[]): number {
  switch (spec.kind) {
    case 'roll':
      return spec.chance;
    case 'guaranteed':
      return 1;
    case 'rollUnlessAnyPriorAccurate':
      return spec.priorHitIndices.some((index) => getPriorAccuracy(priorAccuracy, index)) ? 1 : spec.chance;
    case 'whenDamagePositive':
      throw new TypeError('whenDamagePositive accuracy is projected from the damage mass, not from a chance');
    default:
      return assertNever(spec);
  }
}

function applyDamage(damage: number, application: PlayerDamageApplication): number {
  return Math.floor(
    Math.floor(damage * application.outgoingDamageMultiplier) * application.specialAttackDamageMultiplier,
  );
}

/**
 * The target's hit cap, in `CombatSystem.applyDamage`'s order for a player's hit on an NPC: after the
 * application multipliers and before the remaining-HP clamp, which the projection does not model
 * (nor an NPC's protection prayer between them; Elysian mitigation is for player targets only). A
 * capped hit is a uniform draw in `[min, max]` there, so here it contributes that draw's mean, and
 * `max` at most, without reading any RNG.
 */
function capTargetHit(damage: number, cap: IncomingHitCap | undefined): { expected: number; maximum: number } {
  if (cap === undefined || damage <= cap.above) return { expected: damage, maximum: damage };
  return { expected: (cap.min + cap.max) / 2, maximum: cap.max };
}

function getPriorAccuracy(priorAccuracy: readonly boolean[], index: number): boolean {
  const accuracy = priorAccuracy[index];
  if (accuracy === undefined) {
    throw new RangeError(`Missing accuracy result for prior hit ${index}`);
  }
  return accuracy;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled player attack projection value: ${JSON.stringify(value)}`);
}
