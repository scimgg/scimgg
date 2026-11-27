import { describe, expect, it } from 'vitest';
import { projectPlayerAttack } from '../playerAttackProjection';
import type {
  DamageSpec,
  NonEmptyReadonlyArray,
  PlannedHit,
  PlayerDamageApplication,
  ReadyPlayerAttackPlan,
} from '../playerAttackTypes';

const IDENTITY_APPLICATION: PlayerDamageApplication = {
  outgoingDamageMultiplier: 1,
  specialAttackDamageMultiplier: 1,
};

function hit(damage: DamageSpec, overrides: Partial<Omit<PlannedHit, 'damage'>> = {}): PlannedHit {
  return {
    style: 'melee',
    attackKind: 'melee_slash',
    impactDelayTicks: 0,
    gate: { kind: 'always' },
    accuracy: { kind: 'guaranteed' },
    damage,
    ...overrides,
  };
}

function plan(
  hits: NonEmptyReadonlyArray<PlannedHit>,
  application: PlayerDamageApplication = IDENTITY_APPLICATION,
  attackSpeedTicks = 4,
): ReadyPlayerAttackPlan {
  return { kind: 'ready', attackSpeedTicks, application, hits };
}

describe('projectPlayerAttack with a branch selection', () => {
  const SPLIT_IN_HALF = { fraction: { numerator: 1, denominator: 2 }, offset: 0 };

  /**
   * Two attempts at 50%, so the branches land 0.5 / 0.25 / 0.25 (miss). Fixed totals keep the
   * arithmetic hand-checkable: branch 0 splits 8 into 4-4, branch 1 splits 4 into 2-2, and the
   * all-miss case puts 2 on the second splat only.
   */
  const BRANCHED_PLAN: ReadyPlayerAttackPlan = {
    ...plan([
      hit(
        {
          kind: 'bySelectedBranch',
          branches: [SPLIT_IN_HALF, SPLIT_IN_HALF],
          allMiss: [0],
        },
        { accuracy: { kind: 'whenDamagePositive' } },
      ),
      hit(
        {
          kind: 'bySelectedBranch',
          branches: [SPLIT_IN_HALF, SPLIT_IN_HALF],
          allMiss: [2],
        },
        { accuracy: { kind: 'whenDamagePositive' } },
      ),
    ]),
    branchSelection: {
      attempts: [
        { chance: 0.5, total: { minimumInclusive: 8, maximumInclusive: 8 } },
        { chance: 0.5, total: { minimumInclusive: 4, maximumInclusive: 4 } },
      ],
      allMissWeights: [1],
    },
  };

  it('weights each splat by the branch that produced it', () => {
    const projection = projectPlayerAttack(BRANCHED_PLAN);

    expect(projection.hits[0]).toMatchObject({
      accuracyProbability: 0.75,
      expectedRolledDamage: 2.5,
      maximumRolledDamage: 4,
    });
    expect(projection.hits[1]).toMatchObject({
      accuracyProbability: 1,
      expectedRolledDamage: 3,
      maximumRolledDamage: 4,
    });
  });

  it('keeps the two splats of one swing on the same branch rather than combining them', () => {
    const projection = projectPlayerAttack(BRANCHED_PLAN);

    // 0.5x8 + 0.25x4 + 0.25x2. Merging the branches before the second splat would pair branch
    // 0's first splat with branch 1's second and inflate the maximum past any reachable swing.
    expect(projection.expectedRolledDamagePerAttack).toBeCloseTo(5.5, 10);
    expect(projection.maximumRolledDamagePerAttack).toBe(8);
  });
});

describe('projectPlayerAttack', () => {
  it('projects inclusive uniform damage with unconditional accuracy', () => {
    const attack = plan([
      hit({ kind: 'uniform', minimumInclusive: 4, maximumInclusive: 8 }, { accuracy: { kind: 'roll', chance: 0.25 } }),
    ]);

    const projection = projectPlayerAttack(attack);

    expect(projection.hits[0]).toEqual({
      planIndex: 0,
      gateProbability: 1,
      accuracyProbability: 0.25,
      expectedRolledDamage: 1.5,
      expectedAppliedDamage: 1.5,
      maximumRolledDamage: 8,
      maximumAppliedDamage: 8,
    });
  });

  it('preserves the doubled probability mass at one for magic damage', () => {
    const magic: DamageSpec = {
      kind: 'minimum',
      minimumDamage: 1,
      base: { kind: 'uniform', minimumInclusive: 0, maximumInclusive: 4 },
    };

    const projection = projectPlayerAttack(plan([hit(magic)]));

    expect(projection.hits[0].expectedRolledDamage).toBe(2.2);
    expect(projection.hits[0].maximumRolledDamage).toBe(4);
  });

  it('includes an accuracy gate in a second hit probability', () => {
    const projection = projectPlayerAttack(
      plan([
        hit({ kind: 'fixed', damage: 1 }, { accuracy: { kind: 'roll', chance: 0.5 } }),
        hit(
          { kind: 'fixed', damage: 8 },
          {
            gate: { kind: 'ifPriorAccurate', priorHitIndex: 0 },
            accuracy: { kind: 'roll', chance: 0.5 },
          },
        ),
      ]),
    );

    expect(projection.hits[1].gateProbability).toBe(0.5);
    expect(projection.hits[1].accuracyProbability).toBe(0.25);
    expect(projection.hits[1].expectedRolledDamage).toBe(2);
  });

  it('gates on prior accuracy even when the prior hit deals zero', () => {
    const projection = projectPlayerAttack(
      plan([
        hit({ kind: 'fixed', damage: 0 }),
        hit({ kind: 'fixed', damage: 7 }, { gate: { kind: 'ifPriorAccurate', priorHitIndex: 0 } }),
        hit({ kind: 'fixed', damage: 9 }, { gate: { kind: 'ifPriorInaccurate', priorHitIndex: 0 } }),
      ]),
    );

    expect(projection.hits[1].gateProbability).toBe(1);
    expect(projection.hits[1].expectedRolledDamage).toBe(7);
    expect(projection.hits[2].gateProbability).toBe(0);
    expect(projection.hits[2].maximumRolledDamage).toBe(0);
  });

  it('projects a floored fraction of correlated prior damage', () => {
    const projection = projectPlayerAttack(
      plan([
        hit({ kind: 'uniform', minimumInclusive: 0, maximumInclusive: 3 }),
        hit({ kind: 'floorFractionOfPriorHit', priorHitIndex: 0, numerator: 1, denominator: 2 }),
      ]),
    );

    expect(projection.hits[1].expectedRolledDamage).toBe(0.5);
    expect(projection.hits[1].maximumRolledDamage).toBe(1);
    expect(projection.expectedRolledDamagePerAttack).toBe(2);
    expect(projection.maximumRolledDamagePerAttack).toBe(4);
  });

  it('applies proc probability to the same sampled base damage', () => {
    const proc: DamageSpec = {
      kind: 'floorScaleOnProc',
      chance: 0.25,
      ratio: { numerator: 3, denominator: 2 },
      base: { kind: 'uniform', minimumInclusive: 0, maximumInclusive: 3 },
    };

    const projection = projectPlayerAttack(plan([hit(proc)]));

    expect(projection.hits[0].expectedRolledDamage).toBe(1.625);
    expect(projection.hits[0].maximumRolledDamage).toBe(4);
  });

  it('projects a ruby bolt proc as guaranteed fixed damage replacing the ordinary roll', () => {
    const projection = projectPlayerAttack(
      plan([
        hit(
          { kind: 'uniform', minimumInclusive: 0, maximumInclusive: 8 },
          {
            accuracy: { kind: 'roll', chance: 0.25 },
            proc: {
              kind: 'fixedDamage',
              chance: 0.06,
              damage: 100,
              selfDamageRatio: { numerator: 1, denominator: 10 },
            },
          },
        ),
      ]),
    );

    expect(projection.hits[0].accuracyProbability).toBeCloseTo(0.295);
    expect(projection.hits[0].expectedRolledDamage).toBeCloseTo(6.94);
    expect(projection.hits[0].maximumRolledDamage).toBe(100);
  });

  it('projects a diamond bolt proc as guaranteed damage with a higher maximum', () => {
    const projection = projectPlayerAttack(
      plan([
        hit(
          { kind: 'uniform', minimumInclusive: 0, maximumInclusive: 30 },
          {
            accuracy: { kind: 'roll', chance: 0.25 },
            proc: { kind: 'uniformDamage', chance: 0.1, minimumInclusive: 0, maximumInclusive: 34 },
          },
        ),
      ]),
    );

    expect(projection.hits[0].accuracyProbability).toBeCloseTo(0.325);
    expect(projection.hits[0].expectedRolledDamage).toBeCloseTo(5.075);
    expect(projection.hits[0].maximumRolledDamage).toBe(34);
  });

  it('floors every nested scale stage', () => {
    const nested: DamageSpec = {
      kind: 'floorScale',
      ratio: { numerator: 3, denominator: 2 },
      base: {
        kind: 'floorScale',
        ratio: { numerator: 7, denominator: 6 },
        base: { kind: 'fixed', damage: 41 },
      },
    };

    const projection = projectPlayerAttack(plan([hit(nested)]));

    expect(projection.hits[0].expectedRolledDamage).toBe(70);
    expect(projection.hits[0].maximumRolledDamage).toBe(70);
  });

  it('keeps an added floor-scaled copy correlated with its base sample', () => {
    const correlated: DamageSpec = {
      kind: 'floorScale',
      ratio: { numerator: 1, denominator: 2 },
      base: {
        kind: 'addFloorScaledCopy',
        stages: [{ numerator: 1, denominator: 2 }],
        base: { kind: 'uniform', minimumInclusive: 0, maximumInclusive: 3 },
      },
    };

    const projection = projectPlayerAttack(plan([hit(correlated)]));

    expect(projection.hits[0].expectedRolledDamage).toBe(0.75);
    expect(projection.hits[0].maximumRolledDamage).toBe(2);
  });

  it('floors each player damage application stage', () => {
    const application: PlayerDamageApplication = {
      outgoingDamageMultiplier: 1.5,
      specialAttackDamageMultiplier: 0.8,
    };

    const projection = projectPlayerAttack(plan([hit({ kind: 'fixed', damage: 11 })], application));

    expect(projection.hits[0].expectedRolledDamage).toBe(11);
    expect(projection.hits[0].expectedAppliedDamage).toBe(12);
    expect(projection.hits[0].maximumAppliedDamage).toBe(12);
    expect(projection.appliedDamagePerSecond).toBe(5);
  });

  it('applies the player minimum only to accurate zero-damage outcomes', () => {
    const projection = projectPlayerAttack(
      plan([
        hit({ kind: 'fixed', damage: 0 }),
        hit({ kind: 'fixed', damage: 9 }, { accuracy: { kind: 'roll', chance: 0 } }),
      ]),
    );

    expect(projection.hits[0].expectedRolledDamage).toBe(0);
    expect(projection.hits[0].expectedAppliedDamage).toBe(1);
    expect(projection.hits[0].maximumRolledDamage).toBe(0);
    expect(projection.hits[0].maximumAppliedDamage).toBe(1);
    expect(projection.hits[1].expectedAppliedDamage).toBe(0);
    expect(projection.hits[1].maximumAppliedDamage).toBe(0);
  });

  it('rolls accuracy only when every referenced prior hit was inaccurate', () => {
    const projection = projectPlayerAttack(
      plan([
        hit({ kind: 'fixed', damage: 0 }, { accuracy: { kind: 'roll', chance: 0.5 } }),
        hit({ kind: 'fixed', damage: 0 }, { accuracy: { kind: 'roll', chance: 0.5 } }),
        hit(
          { kind: 'fixed', damage: 10 },
          {
            accuracy: {
              kind: 'rollUnlessAnyPriorAccurate',
              chance: 0.2,
              priorHitIndices: [0, 1],
            },
          },
        ),
      ]),
    );

    expect(projection.hits[2].accuracyProbability).toBeCloseTo(0.8);
    expect(projection.hits[2].expectedRolledDamage).toBeCloseTo(8);
  });

  it('finds reachable attack maxima across mutually exclusive gates', () => {
    const projection = projectPlayerAttack(
      plan([
        hit({ kind: 'fixed', damage: 1 }, { accuracy: { kind: 'roll', chance: 0.5 } }),
        hit({ kind: 'fixed', damage: 10 }, { gate: { kind: 'ifPriorAccurate', priorHitIndex: 0 } }),
        hit({ kind: 'fixed', damage: 20 }, { gate: { kind: 'ifPriorInaccurate', priorHitIndex: 0 } }),
      ]),
    );

    expect(projection.expectedRolledDamagePerAttack).toBe(15.5);
    expect(projection.maximumRolledDamagePerAttack).toBe(20);
    expect(projection.maximumAppliedDamagePerAttack).toBe(20);
  });

  describe("with the target's hit cap (Zulrah's: over 50 becomes 45-50)", () => {
    const capped: PlayerDamageApplication = { ...IDENTITY_APPLICATION, targetHitCap: { above: 50, min: 45, max: 50 } };
    const roll48To53 = hit({ kind: 'uniform', minimumInclusive: 48, maximumInclusive: 53 });

    it('counts each capped hit at the replacement mean, 47.5, and its maximum at 50', () => {
      const uncappedProjection = projectPlayerAttack(plan([roll48To53]));
      const cappedProjection = projectPlayerAttack(plan([roll48To53], capped));

      // 48..53 uncapped: mean 50.5, max 53. Capped: (48 + 49 + 50 + 3 x 47.5) / 6 = 48.25, max 50.
      expect(uncappedProjection.expectedAppliedDamagePerAttack).toBe(50.5);
      expect(uncappedProjection.maximumAppliedDamagePerAttack).toBe(53);
      expect(cappedProjection.hits[0]).toMatchObject({
        expectedRolledDamage: 50.5,
        maximumRolledDamage: 53,
        maximumAppliedDamage: 50,
      });
      expect(cappedProjection.hits[0].expectedAppliedDamage).toBeCloseTo(48.25, 10);
      expect(cappedProjection.expectedAppliedDamagePerAttack).toBeCloseTo(48.25, 10);
      expect(cappedProjection.maximumAppliedDamagePerAttack).toBe(50);
      expect(cappedProjection.appliedDamagePerSecond).toBeCloseTo(48.25 / 2.4, 10);
    });

    it('caps the damage after the application multipliers, as the impact does', () => {
      const doubled: PlayerDamageApplication = { ...capped, outgoingDamageMultiplier: 2 };
      const at = (damage: number) => projectPlayerAttack(plan([hit({ kind: 'fixed', damage })], doubled)).hits[0];

      expect(at(25)).toMatchObject({ expectedAppliedDamage: 50, maximumAppliedDamage: 50 });
      expect(at(26)).toMatchObject({ expectedAppliedDamage: 47.5, maximumAppliedDamage: 50 });
    });

    it('caps each hit of a multi-hit attack on its own', () => {
      const projection = projectPlayerAttack(
        plan([hit({ kind: 'fixed', damage: 60 }), hit({ kind: 'fixed', damage: 30 })], capped),
      );

      expect(projection.expectedAppliedDamagePerAttack).toBe(77.5);
      expect(projection.maximumAppliedDamagePerAttack).toBe(80);
    });
  });

  it('merges independent hit states while projecting totals and DPS', () => {
    const wideUniform: DamageSpec = { kind: 'uniform', minimumInclusive: 0, maximumInclusive: 1_000 };

    const projection = projectPlayerAttack(
      plan([hit(wideUniform), hit(wideUniform), hit(wideUniform)], IDENTITY_APPLICATION, 5),
    );

    expect(projection.expectedRolledDamagePerAttack).toBeCloseTo(1_500);
    expect(projection.expectedAppliedDamagePerAttack).toBeCloseTo(1_500);
    expect(projection.maximumRolledDamagePerAttack).toBe(3_000);
    expect(projection.maximumAppliedDamagePerAttack).toBe(3_000);
    expect(projection.appliedDamagePerSecond).toBeCloseTo(500);
  });
});
