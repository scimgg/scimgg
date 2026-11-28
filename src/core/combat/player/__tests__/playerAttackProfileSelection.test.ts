import { describe, expect, it } from 'vitest';
import { getEquipmentCatalog } from '../../../../data/equipmentCatalog';
import { EQUIPMENT_COMBAT_FAMILIES } from '../../../../data/equipmentCombatFamilies';
import { createEmptyStats } from '../../../../types/equipmentStats';
import { CALC_GAPS } from '../../combatGaps';
import { hitChance, type NpcFormulaActor, type PlayerFormulaActor } from '../../formulas';
import { type PlayerAttackProfile, planPlayerAttack } from '../../playerAttackPlanning';
import type { ReadyPlayerAttackPlan } from '../../playerAttackTypes';
import { getFormulaStyle } from '../../weaponCombatData';
import { selectPlayerAttackProfile } from '../playerAttackProfileSelection';

describe.each(EQUIPMENT_COMBAT_FAMILIES)('profile family $baseId', ({ baseId, variantIds }) => {
  it.each(variantIds)('preserves ordinary and special capability when item %i is cosmetic', (variantId) => {
    for (const isSpecialAttack of [false, true]) {
      const input = { weaponId: baseId, targetSize: 3, isSpecialAttack, formulaStyle: getFormulaStyle(baseId) };
      expect(selectPlayerAttackProfile({ ...input, weaponId: variantId })).toEqual(selectPlayerAttackProfile(input));
    }
  });
});

describe('state-specific equipment bonuses', () => {
  it.each(
    EQUIPMENT_COMBAT_FAMILIES.filter(({ baseId }) => [11864, 11865, 25177, 26674].includes(baseId)),
  )('retains Slayer source $baseId bonuses for every cosmetic', ({ baseId, variantIds }) => {
    const input = { weaponId: 9185, targetSize: 1, isSpecialAttack: false, formulaStyle: 'ranged' as const };
    for (const headId of [baseId, ...variantIds]) {
      const profile = selectPlayerAttackProfile({ ...input, headId });
      expect(profile).toEqual(selectPlayerAttackProfile({ ...input, headId: baseId }));
      expect(profile).toMatchObject({
        maxHit: baseId === 11864 ? { kind: 'base' } : { kind: 'staged', stages: [{ numerator: 23, denominator: 20 }] },
      });
    }
  });

  it.each([
    { headId: 27705, bodyId: 27697, legsId: 27701, accuracy: 130, damage: 230 },
    { headId: 33031, bodyId: 33023, legsId: 33027, accuracy: 130, damage: 230 },
    { headId: 27707, bodyId: 27699, legsId: 27703, accuracy: 100, damage: 200 },
  ])('keeps active and inactive crystal bonuses separate for head $headId', ({
    headId,
    bodyId,
    legsId,
    accuracy,
    damage,
  }) => {
    const profile = selectPlayerAttackProfile({
      weaponId: 25888,
      targetSize: 3,
      isSpecialAttack: false,
      headId,
      bodyId,
      legsId,
    });
    expect(profile).toMatchObject({
      maxHit: { kind: 'staged', stages: [{ numerator: damage, denominator: 200 }] },
      hit: { accuracy: { attackRollStages: [{ numerator: accuracy, denominator: 100 }] } },
    });
  });
});

const SCYTHE_IDS = [22325, 22486, 25736, 25738, 25739, 25741, 28543, 28545] as const;
const DUAL_MACUAHUITL_IDS = [28997, 29850] as const;
const ORDINARY_ATTACK_PROFILE: PlayerAttackProfile = {
  kind: 'singleHit',
  maxHit: { kind: 'base' },
  hit: {
    accuracy: { kind: 'standard' },
    damage: { kind: 'uniformToMaxHit' },
  },
};

const SPECIAL_PROFILE_CASES = [
  {
    weaponIds: [1215, 1231, 5680, 5698],
    profile: {
      kind: 'independentMultiHit',
      maxHit: { kind: 'staged', stages: [{ numerator: 23, denominator: 20 }] },
      accuracy: { kind: 'standard', attackRollStages: [{ numerator: 23, denominator: 20 }] },
      maximumFractions: [
        { numerator: 1, denominator: 1 },
        { numerator: 1, denominator: 1 },
      ],
    },
  },
  {
    weaponIds: [13265, 13267, 13269, 13271],
    profile: {
      kind: 'independentMultiHit',
      maxHit: { kind: 'staged', stages: [{ numerator: 17, denominator: 20 }] },
      accuracy: { kind: 'standard', attackRollStages: [{ numerator: 5, denominator: 4 }] },
      maximumFractions: [
        { numerator: 1, denominator: 1 },
        { numerator: 1, denominator: 1 },
      ],
    },
  },
  {
    // /w/Dragon_warhammer: +50% damage, no accuracy bonus.
    weaponIds: [13576],
    profile: {
      kind: 'singleHit',
      maxHit: { kind: 'staged', stages: [{ numerator: 3, denominator: 2 }] },
      hit: {
        accuracy: { kind: 'standard' },
        damage: { kind: 'uniformToMaxHit' },
      },
    },
  },
  {
    weaponIds: [11804, 20370],
    profile: {
      kind: 'singleHit',
      maxHit: { kind: 'staged', stages: [{ numerator: 121, denominator: 100 }] },
      hit: {
        accuracy: { kind: 'standard', attackRollStages: [{ numerator: 2, denominator: 1 }] },
        damage: { kind: 'uniformToMaxHit' },
      },
    },
  },
  {
    weaponIds: [11802, 20368],
    profile: {
      kind: 'singleHit',
      maxHit: { kind: 'staged', stages: [{ numerator: 11, denominator: 8 }] },
      hit: {
        accuracy: { kind: 'standard', attackRollStages: [{ numerator: 5, denominator: 4 }] },
        damage: { kind: 'uniformToMaxHit' },
      },
    },
  },
  {
    weaponIds: [12926],
    profile: {
      kind: 'singleHit',
      maxHit: { kind: 'staged', stages: [{ numerator: 3, denominator: 2 }] },
      hit: {
        accuracy: { kind: 'standard', attackRollStages: [{ numerator: 2, denominator: 1 }] },
        damage: { kind: 'uniformToMaxHit' },
      },
    },
  },
  {
    weaponIds: [21003, 27100],
    profile: {
      kind: 'singleHit',
      maxHit: { kind: 'base' },
      hit: {
        accuracy: { kind: 'standard', attackRollStages: [{ numerator: 5, denominator: 4 }] },
        damage: { kind: 'uniformToMaxHit' },
      },
    },
  },
  {
    weaponIds: [31113],
    profile: {
      kind: 'singleHit',
      maxHit: { kind: 'staged', stages: [{ numerator: 13, denominator: 10 }] },
      hit: {
        accuracy: { kind: 'standard', attackRollStages: [{ numerator: 2, denominator: 1 }] },
        damage: { kind: 'uniformToMaxHit' },
      },
    },
  },
] as const satisfies readonly {
  readonly weaponIds: readonly number[];
  readonly profile: PlayerAttackProfile;
}[];

const SPECIAL_PROFILE_ID_CASES = SPECIAL_PROFILE_CASES.flatMap(({ weaponIds, profile }) =>
  weaponIds.map((weaponId) => ({ weaponId, profile })),
);

const ATTACKER: PlayerFormulaActor = {
  kind: 'player',
  levels: { attack: 99, strength: 99, defence: 99, ranged: 99, magic: 99 },
  stance: 'Controlled',
};

const TARGET: NpcFormulaActor = {
  kind: 'npc',
  levels: { attack: 1, strength: 1, defence: 80, ranged: 1, magic: 80 },
  offensive: { atk: 0, str: 0, ranged: 0, rangedStr: 0, magic: 0, magicStr: 0 },
  defensive: { stab: 36, slash: 20, crush: 36, rangedLight: 36, rangedStandard: 36, rangedHeavy: 36, magic: 36 },
};

function selectedProfile(weaponId: number | undefined, targetSize: number): PlayerAttackProfile {
  const profile = selectPlayerAttackProfile({ weaponId, targetSize, isSpecialAttack: false });
  if (profile === null) throw new TypeError('Expected a selected player attack profile');
  return profile;
}

function selectedSpecialProfile(weaponId: number): PlayerAttackProfile {
  const profile = selectPlayerAttackProfile({ weaponId, targetSize: 5, isSpecialAttack: true });
  if (profile === null) throw new TypeError('Expected a selected special attack profile');
  return profile;
}

function compile(profile: PlayerAttackProfile): ReadyPlayerAttackPlan {
  const plan = planPlayerAttack({
    attacker: ATTACKER,
    target: TARGET,
    formulaStyle: 'melee_slash',
    equipmentStats: { ...createEmptyStats(), attackSlash: 100, meleeStrength: 176 },
    prayerMultipliers: {
      attack: 1,
      strength: 1,
      defence: 1,
      ranged: 1,
      rangedStrength: 1,
      magic: 1,
      magicDamage: 1,
    },
    attackSpeedTicks: 5,
    delivery: { style: 'melee', attackKind: 'melee_slash', impactDelayTicks: 3 },
    application: { outgoingDamageMultiplier: 1, specialAttackDamageMultiplier: 1 },
    profile,
    rangedDefenceType: 'standard',
  });
  if (plan.kind !== 'ready') throw new TypeError('Expected a ready player attack plan');
  return plan;
}

describe('selectPlayerAttackProfile', () => {
  it('compiles Voidwaker from the ordinary melee maximum with guaranteed accuracy', () => {
    const plan = compile(selectedSpecialProfile(27690));
    expect(plan.hits[0].damage).toEqual({ kind: 'uniform', minimumInclusive: 20, maximumInclusive: 61 });
    expect(plan.hits[0].accuracy).toMatchObject({ kind: 'guaranteed' });
  });
  it('returns null when a special attack has no registered weapon', () => {
    expect(selectPlayerAttackProfile({ weaponId: undefined, targetSize: 3, isSpecialAttack: true })).toBeNull();
  });

  it.each([
    { weaponId: 4153, gap: CALC_GAPS.ANIMATION_ONLY_SPECIAL },
    { weaponId: 29000, gap: CALC_GAPS.ECLIPSE_SPECIAL_FORMULA },
  ])('returns an explicit unsupported plan profile for registered special $weaponId', ({ weaponId, gap }) => {
    expect(selectPlayerAttackProfile({ weaponId, targetSize: 3, isSpecialAttack: true })).toEqual({
      kind: 'unsupported',
      gaps: [gap],
    });
  });

  describe("Osmumten's fang — Eviscerate", () => {
    it.each([26219, 27246])('plans item %i as a double-rolled +50% accuracy stab', (weaponId) => {
      const plan = compile(selectedSpecialProfile(weaponId));
      const ordinary = compile(ORDINARY_ATTACK_PROFILE);
      expect(plan.hits).toHaveLength(1);
      // The 41 ordinary max hit stays the top; the floor is 15% of it, floored.
      expect(plan.hits[0].damage).toEqual({ kind: 'uniform', minimumInclusive: 6, maximumInclusive: 41 });
      const chance = (p: ReadyPlayerAttackPlan) => (p.hits[0].accuracy.kind === 'roll' ? p.hits[0].accuracy.chance : 0);
      expect(chance(plan)).toBeGreaterThan(chance(ordinary));
      expect(selectedSpecialProfile(weaponId)).toMatchObject({
        hit: { accuracy: { kind: 'doubleRoll', attackRollStages: [{ numerator: 3, denominator: 2 }] } },
      });
    });
  });

  describe("Osmumten's fang — passive", () => {
    const fang = (weaponId: number, formulaStyle: 'melee_stab' | 'melee_slash' | 'melee_crush') => {
      const profile = selectPlayerAttackProfile({ weaponId, targetSize: 1, isSpecialAttack: false, formulaStyle });
      if (profile === null) throw new TypeError('Expected a fang profile');
      return profile;
    };

    it.each([26219, 27246])('rolls item %i from floor(15%) of the max hit to the max less that', (weaponId) => {
      // 41 max: floor(6.15) = 6 to 41 - 6 = 35.
      expect(compile(fang(weaponId, 'melee_stab')).hits[0].damage).toEqual({
        kind: 'uniform',
        minimumInclusive: 6,
        maximumInclusive: 35,
      });
      expect(compile(fang(weaponId, 'melee_slash')).hits[0].damage).toEqual({
        kind: 'uniform',
        minimumInclusive: 6,
        maximumInclusive: 35,
      });
    });

    // capture weapon-soulreaper-fang-dragonwarhammer-zombieaxe-noxhalberd-tridentoftheswamps-tridentoftheseas-packet-data.txt,
    // ticks 497-522: Eviscerate's 100% splat shows a true max of 28 and the ordinary swings top out
    // at 28 - floor(4.2) = 24, not /w/Maximum_melee_hit's floor(0.85 x 28) = 23.
    it('caps a true max of 28 at 24, as captured, while Eviscerate reaches 28', () => {
      const planAt28 = (profile: PlayerAttackProfile) => {
        const plan = planPlayerAttack({
          attacker: ATTACKER,
          target: TARGET,
          formulaStyle: 'melee_stab',
          equipmentStats: { ...createEmptyStats(), attackStab: 100, meleeStrength: 100 },
          prayerMultipliers: {
            attack: 1,
            strength: 1,
            defence: 1,
            ranged: 1,
            rangedStrength: 1,
            magic: 1,
            magicDamage: 1,
          },
          attackSpeedTicks: 4,
          delivery: { style: 'melee', attackKind: 'melee_stab', impactDelayTicks: 1 },
          application: { outgoingDamageMultiplier: 1, specialAttackDamageMultiplier: 1 },
          profile,
          rangedDefenceType: 'standard',
        });
        if (plan.kind !== 'ready') throw new TypeError('Expected a ready plan');
        expect(plan.diagnostics?.baseMaxHit).toBe(28);
        return plan.hits[0].damage;
      };
      expect(planAt28(fang(26219, 'melee_stab'))).toEqual({
        kind: 'uniform',
        minimumInclusive: 4,
        maximumInclusive: 24,
      });
      expect(planAt28(selectedSpecialProfile(26219))).toEqual({
        kind: 'uniform',
        minimumInclusive: 4,
        maximumInclusive: 28,
      });
    });

    it("matches the article's 60 max hit rolling 9 to 51", () => {
      const plan = planPlayerAttack({
        attacker: { ...ATTACKER, levels: { ...ATTACKER.levels, strength: 118 }, stance: 'Aggressive' },
        target: TARGET,
        formulaStyle: 'melee_stab',
        equipmentStats: { ...createEmptyStats(), attackStab: 100, meleeStrength: 181 },
        prayerMultipliers: {
          attack: 1,
          strength: 1.23,
          defence: 1,
          ranged: 1,
          rangedStrength: 1,
          magic: 1,
          magicDamage: 1,
        },
        attackSpeedTicks: 5,
        delivery: { style: 'melee', attackKind: 'melee_stab', impactDelayTicks: 1 },
        application: { outgoingDamageMultiplier: 1, specialAttackDamageMultiplier: 1 },
        profile: fang(26219, 'melee_stab'),
        rangedDefenceType: 'standard',
      });
      if (plan.kind !== 'ready') throw new TypeError('Expected a ready plan');
      expect(plan.diagnostics?.baseMaxHit).toBe(60);
      expect(plan.hits[0].damage).toEqual({ kind: 'uniform', minimumInclusive: 9, maximumInclusive: 51 });
    });

    it('rolls accuracy twice on a stab only', () => {
      const plan = compile(fang(26219, 'melee_stab'));
      const a = plan.diagnostics?.baseAttackRoll ?? 0;
      const d = plan.diagnostics?.baseDefenceRoll ?? 0;
      // The article's closed form for either of two rolls beating one defence roll.
      const wiki =
        a >= d ? 1 - ((d + 2) * (2 * d + 3)) / (6 * (a + 1) ** 2) : (a * (4 * a + 5)) / (6 * (a + 1) * (d + 1));
      expect(plan.hits[0].accuracy).toEqual({ kind: 'roll', chance: wiki });
      expect(fang(26219, 'melee_stab')).toMatchObject({ hit: { accuracy: { kind: 'doubleRoll' } } });
      expect(fang(26219, 'melee_slash')).toMatchObject({ hit: { accuracy: { kind: 'standard' } } });
      expect(fang(26219, 'melee_crush')).toMatchObject({ hit: { accuracy: { kind: 'standard' } } });
    });
  });

  describe('Soulreaper axe — Behead', () => {
    const behead = (soulreaperStacks: number) =>
      selectPlayerAttackProfile({ weaponId: 28338, targetSize: 1, isSpecialAttack: true, soulreaperStacks });

    it('adds 12% accuracy, 6% max hit and a 6%-of-max minimum per stack consumed', () => {
      expect(behead(5)).toEqual({
        kind: 'singleHit',
        maxHit: { kind: 'staged', stages: [{ numerator: 130, denominator: 100 }] },
        hit: {
          accuracy: { kind: 'standard', attackRollStages: [{ numerator: 160, denominator: 100 }] },
          damage: {
            kind: 'uniformMaxHitFractionBounds',
            minimum: { ratio: { numerator: 30, denominator: 100 }, rounding: 'floor' },
            maximum: { ratio: { numerator: 1, denominator: 1 }, rounding: 'floor' },
          },
        },
      });
      // 41 -> floor(41 x 1.30) = 53, minimum floor(53 x 0.30) = 15.
      expect(compile(behead(5)!).hits[0].damage).toEqual({
        kind: 'uniform',
        minimumInclusive: 15,
        maximumInclusive: 53,
      });
      expect(compile(behead(2)!).hits[0].damage).toEqual({
        kind: 'uniform',
        minimumInclusive: 5,
        maximumInclusive: 45,
      });
    });

    it('is an ordinary hit with no bonus at zero stacks', () => {
      expect(behead(0)).toEqual(ORDINARY_ATTACK_PROFILE);
    });

    it('shares Behead with the (o) variant', () => {
      expect(
        selectPlayerAttackProfile({ weaponId: 33335, targetSize: 1, isSpecialAttack: true, soulreaperStacks: 3 }),
      ).toEqual(behead(3));
    });
  });

  it.each(SPECIAL_PROFILE_ID_CASES)('selects the exact special profile for item $weaponId', ({ weaponId, profile }) => {
    expect(selectPlayerAttackProfile({ weaponId, targetSize: 5, isSpecialAttack: true })).toEqual(profile);
  });

  describe('burning claws — Burning barrage', () => {
    const burningBarrage = (
      overrides: Partial<Parameters<typeof selectPlayerAttackProfile>[0]> = {},
    ): PlayerAttackProfile | null =>
      selectPlayerAttackProfile({
        weaponId: 29577,
        targetSize: 5,
        isSpecialAttack: true,
        resources: { kind: 'none', source: 'none' },
        ...overrides,
      });

    it('splits the swing across three hitsplats instead of failing closed as unsupported', () => {
      expect(burningBarrage()).toMatchObject({
        kind: 'accuracyBranchedSplit',
        maxHit: { kind: 'base' },
        accuracy: { kind: 'standard' },
      });
    });

    it('carries the 5% demonbane bonus into the special on both accuracy and max hit', () => {
      expect(burningBarrage({ targetAttributes: ['demon'] })).toMatchObject({
        maxHit: { kind: 'staged', stages: [{ numerator: 105, denominator: 100 }] },
        accuracy: { kind: 'standard', attackRollStages: [{ numerator: 105, denominator: 100 }] },
      });
    });

    it('doubles that bonus against a 200% demonbane vulnerability void flare', () => {
      expect(burningBarrage({ targetAttributes: ['demon'], demonbaneVulnerability: 2 })).toMatchObject({
        maxHit: { kind: 'staged', stages: [{ numerator: 110, denominator: 100 }] },
        accuracy: { kind: 'standard', attackRollStages: [{ numerator: 110, denominator: 100 }] },
      });
    });

    it('compiles three splats whose branch totals bracket the 41 max hit at 75/50/25% to 175/150/125%', () => {
      const profile = burningBarrage();
      if (profile === null) throw new TypeError('Expected a Burning barrage profile');
      const plan = compile(profile);

      expect(plan.hits).toHaveLength(3);
      expect(plan.hits.map((hit) => hit.accuracy.kind)).toEqual([
        'whenDamagePositive',
        'whenDamagePositive',
        'whenDamagePositive',
      ]);
      expect(plan.branchSelection?.attempts.map((attempt) => attempt.total)).toEqual([
        { minimumInclusive: 30, maximumInclusive: 71 },
        { minimumInclusive: 20, maximumInclusive: 61 },
        { minimumInclusive: 10, maximumInclusive: 51 },
      ]);
    });

    it('rolls the same accuracy chance for all three attempts', () => {
      const profile = burningBarrage();
      if (profile === null) throw new TypeError('Expected a Burning barrage profile');
      const chances = compile(profile).branchSelection?.attempts.map((attempt) => attempt.chance) ?? [];

      expect(chances).toHaveLength(3);
      expect(new Set(chances).size).toBe(1);
      expect(chances[0]).toBeGreaterThan(0);
    });
  });

  it.each([
    { weaponId: 1215, maximumInclusive: [47, 47] },
    { weaponId: 13265, maximumInclusive: [34, 34] },
    { weaponId: 13576, maximumInclusive: [61] },
    { weaponId: 11804, maximumInclusive: [49] },
    { weaponId: 11802, maximumInclusive: [56] },
    { weaponId: 12926, maximumInclusive: [61] },
    { weaponId: 21003, maximumInclusive: [41] },
    { weaponId: 31113, maximumInclusive: [53] },
    { weaponId: 27665, maximumInclusive: [61] },
    { weaponId: 27679, maximumInclusive: [61] },
    { weaponId: 11808, maximumInclusive: [45] },
    { weaponId: 4151, maximumInclusive: [41] },
    { weaponId: 4587, maximumInclusive: [41] },
    { weaponId: 12006, maximumInclusive: [41] },
  ])('compiles item $weaponId with one sequentially floored maximum per hit', ({ weaponId, maximumInclusive }) => {
    const plan = compile(selectedSpecialProfile(weaponId));

    expect(plan.hits.map((hit) => hit.damage)).toEqual(
      maximumInclusive.map((maximum) => ({ kind: 'uniform', minimumInclusive: 0, maximumInclusive: maximum })),
    );
  });

  it('selects the ordinary profile for documented special weapons outside their special attack', () => {
    for (const { weaponId } of SPECIAL_PROFILE_ID_CASES) {
      expect(selectPlayerAttackProfile({ weaponId, targetSize: 3, isSpecialAttack: false })).toEqual(
        ORDINARY_ATTACK_PROFILE,
      );
    }
  });

  it('selects the ordinary single-hit profile when no weapon is equipped', () => {
    expect(selectedProfile(undefined, 1)).toEqual({
      kind: 'singleHit',
      maxHit: { kind: 'base' },
      hit: {
        accuracy: { kind: 'standard' },
        damage: { kind: 'uniformToMaxHit' },
      },
    });
  });

  it.each([
    { targetSize: 1, maximumFractions: [{ numerator: 1, denominator: 1 }] },
    {
      targetSize: 2,
      maximumFractions: [
        { numerator: 1, denominator: 1 },
        { numerator: 1, denominator: 2 },
      ],
    },
    {
      targetSize: 3,
      maximumFractions: [
        { numerator: 1, denominator: 1 },
        { numerator: 1, denominator: 2 },
        { numerator: 1, denominator: 4 },
      ],
    },
    {
      targetSize: 5,
      maximumFractions: [
        { numerator: 1, denominator: 1 },
        { numerator: 1, denominator: 2 },
        { numerator: 1, denominator: 4 },
      ],
    },
  ])('selects Scythe maxima for a $targetSize x $targetSize target', ({ targetSize, maximumFractions }) => {
    expect(selectedProfile(SCYTHE_IDS[0], targetSize)).toEqual({
      kind: 'independentMultiHit',
      maxHit: { kind: 'base' },
      accuracy: { kind: 'standard' },
      maximumFractions,
    });
  });

  it.each(SCYTHE_IDS)('selects the Scythe profile for item %i', (weaponId) => {
    expect(selectedProfile(weaponId, 3)).toEqual({
      kind: 'independentMultiHit',
      maxHit: { kind: 'base' },
      accuracy: { kind: 'standard' },
      maximumFractions: [
        { numerator: 1, denominator: 1 },
        { numerator: 1, denominator: 2 },
        { numerator: 1, denominator: 4 },
      ],
    });
  });

  it.each([
    ...SCYTHE_IDS,
    ...DUAL_MACUAHUITL_IDS,
  ])('keeps a spell cast single-hit while holding item %i', (weaponId) => {
    expect(
      selectPlayerAttackProfile({
        weaponId,
        targetSize: 5,
        isSpecialAttack: false,
        resources: { kind: 'spell', source: 'none', spellId: 'Ice Barrage' },
      }),
    ).toEqual(ORDINARY_ATTACK_PROFILE);
  });

  it('does not apply held Twisted bow modifiers to a spell cast', () => {
    expect(
      selectPlayerAttackProfile({
        weaponId: 20997,
        targetSize: 5,
        isSpecialAttack: false,
        resources: { kind: 'spell', source: 'none', spellId: 'Ice Barrage' },
        targetMagicLevel: 250,
        targetMagicAttackBonus: 100,
      }),
    ).toEqual(ORDINARY_ATTACK_PROFILE);
  });

  it.each(DUAL_MACUAHUITL_IDS)('selects the gated Dual macuahuitl profile for item %i', (weaponId) => {
    expect(selectedProfile(weaponId, 5)).toEqual({
      kind: 'secondHitIfFirstAccurate',
      maxHit: { kind: 'base' },
      first: {
        accuracy: { kind: 'standard' },
        damage: {
          kind: 'uniformMaxHitFractionBounds',
          minimum: { ratio: { numerator: 0, denominator: 1 }, rounding: 'floor' },
          maximum: { ratio: { numerator: 1, denominator: 2 }, rounding: 'floor' },
        },
      },
      second: {
        impactDelayOffsetTicks: 1,
        accuracy: { kind: 'standard' },
        damage: {
          kind: 'uniformMaxHitFractionBounds',
          minimum: { ratio: { numerator: 0, denominator: 1 }, rounding: 'ceiling' },
          maximum: { ratio: { numerator: 1, denominator: 2 }, rounding: 'ceiling' },
        },
      },
    });
  });

  it('compiles an odd Dual macuahuitl maximum into floor and ceiling halves one tick apart', () => {
    const plan = compile(selectedProfile(DUAL_MACUAHUITL_IDS[0], 1));

    expect(plan.hits.map(({ impactDelayTicks, gate, damage }) => ({ impactDelayTicks, gate, damage }))).toEqual([
      {
        impactDelayTicks: 3,
        gate: { kind: 'always' },
        damage: { kind: 'uniform', minimumInclusive: 0, maximumInclusive: 20 },
      },
      {
        impactDelayTicks: 4,
        gate: { kind: 'ifPriorAccurate', priorHitIndex: 0 },
        damage: { kind: 'uniform', minimumInclusive: 0, maximumInclusive: 21 },
      },
    ]);
  });

  it('selects the ordinary profile for every other equipped weapon', () => {
    expect(selectPlayerAttackProfile({ weaponId: 4587, targetSize: 3, isSpecialAttack: false })).toEqual(
      ORDINARY_ATTACK_PROFILE,
    );
  });

  it('applies dragonbane bonuses for Dragon hunter lance and Dragon hunter crossbow, and fails closed only for unmodeled wand', () => {
    expect(
      selectPlayerAttackProfile({
        weaponId: 22978,
        targetSize: 5,
        isSpecialAttack: false,
        targetAttributes: ['dragon'],
      }),
    ).toEqual({
      kind: 'singleHit',
      maxHit: { kind: 'staged', stages: [{ numerator: 120, denominator: 100 }] },
      hit: {
        accuracy: { kind: 'standard', attackRollStages: [{ numerator: 120, denominator: 100 }] },
        damage: { kind: 'uniformToMaxHit' },
      },
    });
    expect(
      selectPlayerAttackProfile({
        weaponId: 21012,
        targetSize: 5,
        isSpecialAttack: false,
        resources: { kind: 'ammo', source: 'equipped', ammoId: 9242 },
        targetAttributes: ['dragon'],
      }),
    ).toEqual({
      kind: 'singleHit',
      maxHit: { kind: 'staged', stages: [{ numerator: 125, denominator: 100 }] },
      hit: {
        accuracy: { kind: 'standard', attackRollStages: [{ numerator: 130, denominator: 100 }] },
        damage: { kind: 'uniformToMaxHit' },
      },
    });
    expect(
      selectPlayerAttackProfile({
        weaponId: 30070,
        targetSize: 3,
        isSpecialAttack: false,
        targetAttributes: ['dragon'],
      }),
    ).toBeNull();
  });

  it('supports the Chambers of Xeric 350 Magic scaling cap for Twisted bow when specified', () => {
    const cap350 = selectPlayerAttackProfile({
      weaponId: 20997,
      targetSize: 5,
      isSpecialAttack: false,
      resources: { kind: 'ammo', source: 'equipped', ammoId: 11212 },
      targetMagicLevel: 350,
      targetMagicAttackBonus: 60,
      twistedBowMagicCap: 350,
    });
    // 350 Magic -> 3*350/10 = 105 -> accuracy 140% (capped), damage 250 - floor((105-140)^2/100) + floor(1036/100) = 250 + 10 - 12 = 248%.
    expect(cap350).toEqual({
      kind: 'singleHit',
      maxHit: { kind: 'staged', stages: [{ numerator: 248, denominator: 100 }] },
      hit: {
        accuracy: { kind: 'standard', attackRollStages: [{ numerator: 140, denominator: 100 }] },
        damage: { kind: 'uniformToMaxHit' },
      },
    });
  });

  it('scales the Twisted bow from the higher of the target Magic level and Magic attack bonus', () => {
    const fromLevel = selectPlayerAttackProfile({
      weaponId: 20997,
      targetSize: 5,
      isSpecialAttack: false,
      resources: { kind: 'ammo', source: 'equipped', ammoId: 11212 },
      targetMagicLevel: 250,
      targetMagicAttackBonus: 100,
    });

    // 250 Magic -> floor(3*250/10) = 75 -> accuracy 140% (capped), damage 215%.
    expect(fromLevel).toEqual({
      kind: 'singleHit',
      maxHit: { kind: 'staged', stages: [{ numerator: 215, denominator: 100 }] },
      hit: {
        accuracy: { kind: 'standard', attackRollStages: [{ numerator: 140, denominator: 100 }] },
        damage: { kind: 'uniformToMaxHit' },
      },
    });
    expect(
      selectPlayerAttackProfile({
        weaponId: 20997,
        targetSize: 5,
        isSpecialAttack: false,
        resources: { kind: 'ammo', source: 'equipped', ammoId: 11212 },
        targetMagicLevel: 150,
        targetMagicAttackBonus: 550,
      }),
    ).toEqual(fromLevel);
  });

  it.each(
    getEquipmentCatalog()
      .filter((item) => /slayer helmet/i.test(item.name))
      .map((item) => ({ headId: item.id, imbued: item.name.includes('(i)'), name: item.name })),
  )('always applies the on-task bonuses for $name', ({ headId, imbued }) => {
    const melee = selectPlayerAttackProfile({
      weaponId: 4587,
      headId,
      formulaStyle: 'melee_slash',
      targetSize: 1,
      isSpecialAttack: false,
    });
    const ranged = selectPlayerAttackProfile({
      weaponId: 9185,
      headId,
      formulaStyle: 'ranged',
      targetSize: 1,
      isSpecialAttack: false,
      resources: { kind: 'ammo', source: 'equipped', ammoId: 9242 },
    });

    expect(melee).toMatchObject({
      maxHit: { kind: 'staged', stages: [{ numerator: 7, denominator: 6 }] },
      hit: {
        accuracy: { kind: 'standard', attackRollStages: [{ numerator: 7, denominator: 6 }] },
      },
    });
    expect(ranged).toEqual(
      imbued
        ? {
            kind: 'singleHit',
            maxHit: { kind: 'staged', stages: [{ numerator: 23, denominator: 20 }] },
            hit: {
              accuracy: { kind: 'standard', attackRollStages: [{ numerator: 23, denominator: 20 }] },
              damage: { kind: 'uniformToMaxHit' },
            },
          }
        : ORDINARY_ATTACK_PROFILE,
    );
  });

  it('applies the slayer helmet gear bonus before the Twisted bow target modifier', () => {
    expect(
      selectPlayerAttackProfile({
        weaponId: 20997,
        headId: 25912,
        formulaStyle: 'ranged',
        targetSize: 7,
        isSpecialAttack: false,
        resources: { kind: 'ammo', source: 'quiver', ammoId: 11212 },
        targetMagicLevel: 150,
        targetMagicAttackBonus: 550,
      }),
    ).toEqual({
      kind: 'singleHit',
      maxHit: {
        kind: 'staged',
        stages: [
          { numerator: 23, denominator: 20 },
          { numerator: 215, denominator: 100 },
        ],
      },
      hit: {
        accuracy: {
          kind: 'standard',
          attackRollStages: [
            { numerator: 23, denominator: 20 },
            { numerator: 140, denominator: 100 },
          ],
        },
        damage: { kind: 'uniformToMaxHit' },
      },
    });
  });

  it.each([
    { magic: 34, accuracy: 59, damage: 81 },
    { magic: 47, accuracy: 68, damage: 93 },
    { magic: 90, accuracy: 89, damage: 125 },
    { magic: 100, accuracy: 93, damage: 131 },
    { magic: 140, accuracy: 111, damage: 158 },
    { magic: 240, accuracy: 140, damage: 211 },
  ])('truncates each Twisted bow curve term at $magic Magic', ({ magic, accuracy, damage }) => {
    expect(
      selectPlayerAttackProfile({
        weaponId: 20997,
        targetSize: 3,
        isSpecialAttack: false,
        resources: { kind: 'ammo', source: 'equipped', ammoId: 11212 },
        targetMagicLevel: magic,
        targetMagicAttackBonus: 0,
      }),
    ).toMatchObject({
      maxHit: { kind: 'staged', stages: [{ numerator: damage, denominator: 100 }] },
      hit: {
        accuracy: { kind: 'standard', attackRollStages: [{ numerator: accuracy, denominator: 100 }] },
      },
    });
  });

  it.each([
    [25865, 'Bow of Faerdhinen'],
    [23983, 'Crystal bow'],
    [24123, 'Crystal bow (new)'],
  ])('applies every equipped crystal armour bonus to %i (%s)', (weaponId) => {
    expect(
      selectPlayerAttackProfile({
        weaponId,
        headId: 23971,
        bodyId: 23975,
        legsId: 23979,
        formulaStyle: 'ranged',
        targetSize: 7,
        isSpecialAttack: false,
        resources: { kind: 'none', source: 'none' },
      }),
    ).toEqual({
      kind: 'singleHit',
      maxHit: { kind: 'staged', stages: [{ numerator: 230, denominator: 200 }] },
      hit: {
        accuracy: { kind: 'standard', attackRollStages: [{ numerator: 130, denominator: 100 }] },
        damage: { kind: 'uniformToMaxHit' },
      },
    });
  });

  it.each([
    [25865, 'Bow of Faerdhinen'],
    [25888, 'Bow of Faerdhinen (c), Trahaearn'],
    [23983, 'Crystal bow'],
  ])('applies the Slayer helmet bonus after the crystal-armour bonus for %i (%s)', (weaponId) => {
    expect(
      selectPlayerAttackProfile({
        weaponId,
        headId: 25912,
        bodyId: 23975,
        legsId: 23979,
        formulaStyle: 'ranged',
        targetSize: 7,
        isSpecialAttack: false,
        resources: { kind: 'none', source: 'none' },
      }),
    ).toMatchObject({
      maxHit: {
        kind: 'staged',
        stages: [
          { numerator: 225, denominator: 200 },
          { numerator: 23, denominator: 20 },
        ],
      },
      hit: {
        accuracy: {
          kind: 'standard',
          attackRollStages: [
            { numerator: 125, denominator: 100 },
            { numerator: 23, denominator: 20 },
          ],
        },
      },
    });
  });

  it('applies each crystal armour piece to the crystal bow on its own', () => {
    const select = (piece: { headId?: number; bodyId?: number; legsId?: number }) =>
      selectPlayerAttackProfile({
        weaponId: 23983,
        ...piece,
        formulaStyle: 'ranged',
        targetSize: 1,
        isSpecialAttack: false,
        resources: { kind: 'none', source: 'none' },
      });
    expect(select({ headId: 23971 })).toMatchObject({
      maxHit: { stages: [{ numerator: 205, denominator: 200 }] },
      hit: { accuracy: { attackRollStages: [{ numerator: 105, denominator: 100 }] } },
    });
    expect(select({ bodyId: 23975 })).toMatchObject({
      maxHit: { stages: [{ numerator: 215, denominator: 200 }] },
      hit: { accuracy: { attackRollStages: [{ numerator: 115, denominator: 100 }] } },
    });
    expect(select({ legsId: 23979 })).toMatchObject({
      maxHit: { stages: [{ numerator: 210, denominator: 200 }] },
      hit: { accuracy: { attackRollStages: [{ numerator: 110, denominator: 100 }] } },
    });
  });

  it('uses the melee on-task bonus for the Eclipse atlatl', () => {
    expect(
      selectPlayerAttackProfile({
        weaponId: 29000,
        headId: 11864,
        formulaStyle: 'ranged',
        targetSize: 1,
        isSpecialAttack: false,
        resources: { kind: 'ammo', source: 'equipped', ammoId: 28991 },
      }),
    ).toMatchObject({
      maxHit: { kind: 'staged', stages: [{ numerator: 7, denominator: 6 }] },
      hit: {
        accuracy: { kind: 'standard', attackRollStages: [{ numerator: 7, denominator: 6 }] },
      },
    });
  });

  it.each([
    { ammoId: 9242, kind: 'rubyBolt', chance: 6, targetCurrentHp: 1_200 },
    { ammoId: 21944, kind: 'rubyBolt', chance: 6, targetCurrentHp: 1_200 },
    { ammoId: 9243, kind: 'diamondBolt', chance: 10, targetCurrentHp: undefined },
    { ammoId: 21946, kind: 'diamondBolt', chance: 10, targetCurrentHp: undefined },
  ])('models the enchanted bolt proc for ammo $ammoId', ({ ammoId, kind, chance, targetCurrentHp }) => {
    expect(
      selectPlayerAttackProfile({
        weaponId: ammoId >= 20_000 ? 11785 : 9185,
        formulaStyle: 'ranged',
        targetSize: 7,
        targetCurrentHp: 1_200,
        playerCurrentHp: 99,
        isSpecialAttack: false,
        resources: { kind: 'ammo', source: 'equipped', ammoId },
      }),
    ).toMatchObject({
      hit: {
        proc: kind === 'rubyBolt' ? { kind, chancePercent: chance, targetCurrentHp } : { kind, chancePercent: chance },
      },
    });
  });

  it.each([1, 2, 9])('does not activate Ruby bolts at %i HP', (playerCurrentHp) => {
    expect(
      selectPlayerAttackProfile({
        weaponId: 9185,
        formulaStyle: 'ranged',
        targetSize: 7,
        targetCurrentHp: 1_200,
        playerCurrentHp,
        isSpecialAttack: false,
        resources: { kind: 'ammo', source: 'equipped', ammoId: 9242 },
      }),
    ).toEqual(ORDINARY_ATTACK_PROFILE);
  });

  it('adds the Slayer helmet bonus to the Scorching bow demonbane bonus', () => {
    expect(
      selectPlayerAttackProfile({
        weaponId: 29591,
        headId: 25912,
        formulaStyle: 'ranged',
        targetSize: 5,
        isSpecialAttack: false,
        resources: { kind: 'ammo', source: 'equipped', ammoId: 11212 },
        targetAttributes: ['demon'],
      }),
    ).toEqual({
      kind: 'singleHit',
      maxHit: { kind: 'staged', stages: [{ numerator: 29, denominator: 20 }] },
      hit: {
        accuracy: {
          kind: 'standard',
          attackRollStages: [
            { numerator: 23, denominator: 20 },
            { numerator: 130, denominator: 100 },
          ],
        },
        damage: { kind: 'uniformToMaxHit' },
      },
    });
  });

  it.each([
    { markOfDarknessActive: false, weaponId: 4675, accuracy: 120, maxHit: undefined },
    { markOfDarknessActive: true, weaponId: 4675, accuracy: 140, maxHit: 125 },
    { markOfDarknessActive: true, weaponId: 29594, accuracy: 180, maxHit: 150 },
  ])('boosts a demonbane cast by $accuracy% accuracy against a demon', ({
    markOfDarknessActive,
    weaponId,
    accuracy,
    maxHit,
  }) => {
    expect(
      selectPlayerAttackProfile({
        weaponId,
        targetSize: 5,
        isSpecialAttack: false,
        resources: { kind: 'spell', source: 'none', spellId: 'Dark Demonbane' },
        targetAttributes: ['demon'],
        markOfDarknessActive,
      }),
    ).toEqual({
      kind: 'singleHit',
      maxHit:
        maxHit === undefined ? { kind: 'base' } : { kind: 'staged', stages: [{ numerator: maxHit, denominator: 100 }] },
      hit: {
        accuracy: { kind: 'standard', attackRollStages: [{ numerator: accuracy, denominator: 100 }] },
        damage: { kind: 'uniformToMaxHit' },
      },
    });
  });

  it('casts the demonbane spell for the purging staff special rather than refusing it', () => {
    const spec = selectPlayerAttackProfile({
      weaponId: 29594,
      targetSize: 2,
      isSpecialAttack: true,
      resources: { kind: 'spell', source: 'none', spellId: 'Dark Demonbane' },
      targetAttributes: ['demon'],
      markOfDarknessActive: true,
      demonbaneVulnerability: 2,
    });

    expect(spec).toEqual(
      selectPlayerAttackProfile({
        weaponId: 29594,
        targetSize: 2,
        isSpecialAttack: false,
        resources: { kind: 'spell', source: 'none', spellId: 'Dark Demonbane' },
        targetAttributes: ['demon'],
        markOfDarknessActive: true,
        demonbaneVulnerability: 2,
      }),
    );
  });

  it('compiles the Saradomin godsword special with doubled accuracy and a 10% higher max', () => {
    expect(selectPlayerAttackProfile({ weaponId: 11806, targetSize: 5, isSpecialAttack: true })).toEqual({
      kind: 'singleHit',
      maxHit: { kind: 'staged', stages: [{ numerator: 11, denominator: 10 }] },
      hit: {
        accuracy: { kind: 'standard', attackRollStages: [{ numerator: 2, denominator: 1 }] },
        damage: { kind: 'uniformToMaxHit' },
      },
    });
  });

  it('doubles the demonbane bonus, not the hit, against a 200%-vulnerable void flare', () => {
    expect(
      selectPlayerAttackProfile({
        weaponId: 29594,
        targetSize: 2,
        isSpecialAttack: false,
        resources: { kind: 'spell', source: 'none', spellId: 'Dark Demonbane' },
        targetAttributes: ['demon'],
        markOfDarknessActive: true,
        demonbaneVulnerability: 2,
      }),
    ).toEqual({
      kind: 'singleHit',
      // +80% accuracy and +50% damage both double to +160% and +100%.
      maxHit: { kind: 'staged', stages: [{ numerator: 200, denominator: 100 }] },
      hit: {
        accuracy: { kind: 'standard', attackRollStages: [{ numerator: 260, denominator: 100 }] },
        damage: { kind: 'uniformToMaxHit' },
      },
    });
  });

  it('doubles a demonbane sword bonus against a 200%-vulnerable void flare', () => {
    expect(
      selectPlayerAttackProfile({
        weaponId: 29589,
        targetSize: 2,
        isSpecialAttack: false,
        resources: { kind: 'none', source: 'none' },
        targetAttributes: ['demon'],
        demonbaneVulnerability: 2,
      }),
    ).toEqual({
      kind: 'singleHit',
      maxHit: { kind: 'staged', stages: [{ numerator: 240, denominator: 100 }] },
      hit: {
        accuracy: { kind: 'standard', attackRollStages: [{ numerator: 240, denominator: 100 }] },
        damage: { kind: 'uniformToMaxHit' },
      },
    });
  });

  it('boosts a demonbane sword by 70% accuracy and damage against a demon', () => {
    expect(
      selectPlayerAttackProfile({
        weaponId: 29589,
        targetSize: 5,
        isSpecialAttack: false,
        resources: { kind: 'none', source: 'none' },
        targetAttributes: ['demon'],
      }),
    ).toEqual({
      kind: 'singleHit',
      maxHit: { kind: 'staged', stages: [{ numerator: 170, denominator: 100 }] },
      hit: {
        accuracy: { kind: 'standard', attackRollStages: [{ numerator: 170, denominator: 100 }] },
        damage: { kind: 'uniformToMaxHit' },
      },
    });
  });

  it.each([
    { weaponId: 2402, bonus: 160 },
    { weaponId: 6745, bonus: 160 },
    { weaponId: 6746, bonus: 160 },
    { weaponId: 29577, bonus: 105 },
    { weaponId: 29591, bonus: 130 },
  ])('applies the complete demonbane bonus for weapon $weaponId', ({ weaponId, bonus }) => {
    expect(
      selectPlayerAttackProfile({
        weaponId,
        targetSize: 5,
        isSpecialAttack: false,
        resources:
          weaponId === 29591 ? { kind: 'ammo', source: 'equipped', ammoId: 11212 } : { kind: 'none', source: 'none' },
        targetAttributes: ['demon'],
      }),
    ).toMatchObject({
      maxHit: { kind: 'staged', stages: [{ numerator: bonus, denominator: 100 }] },
      hit: {
        accuracy: { kind: 'standard', attackRollStages: [{ numerator: bonus, denominator: 100 }] },
      },
    });
  });

  it('scales Emberlight to Yama 120% demonbane vulnerability', () => {
    expect(
      selectPlayerAttackProfile({
        weaponId: 29589,
        targetSize: 5,
        isSpecialAttack: false,
        resources: { kind: 'none', source: 'none' },
        targetAttributes: ['demon'],
        demonbaneVulnerability: 1.2,
      }),
    ).toMatchObject({
      maxHit: { kind: 'staged', stages: [{ numerator: 184, denominator: 100 }] },
      hit: {
        accuracy: { kind: 'standard', attackRollStages: [{ numerator: 184, denominator: 100 }] },
      },
    });
  });

  it('keeps enchanted bolts supported when target HP is unavailable', () => {
    expect(
      selectPlayerAttackProfile({
        weaponId: 9185,
        targetSize: 3,
        isSpecialAttack: false,
        resources: { kind: 'ammo', source: 'equipped', ammoId: 9242 },
      }),
    ).toEqual(ORDINARY_ATTACK_PROFILE);
  });

  it('retains the base profile when dragonbane and demonbane target attributes do not match', () => {
    expect(
      selectPlayerAttackProfile({
        weaponId: 21012,
        targetSize: 3,
        isSpecialAttack: false,
        resources: { kind: 'ammo', source: 'equipped', ammoId: 11212 },
        targetAttributes: ['demon'],
      }),
    ).toEqual(ORDINARY_ATTACK_PROFILE);
    expect(
      selectPlayerAttackProfile({
        weaponId: 4675,
        targetSize: 3,
        isSpecialAttack: false,
        resources: { kind: 'spell', source: 'none', spellId: 'Dark Demonbane' },
        targetAttributes: ['dragon'],
      }),
    ).toEqual(ORDINARY_ATTACK_PROFILE);
  });
});

describe("Inquisitor's armour", () => {
  // /w/Inquisitor's_armour: helm +0.5%, hauberk +1%, plateskirt +1% crush accuracy and damage.
  const crush = { weaponId: 24417, targetSize: 1, isSpecialAttack: false, formulaStyle: 'melee_crush' as const };

  it.each([
    ['the full set', { headId: 24419, bodyId: 24420, legsId: 24421 }, 1025],
    ['the hauberk and plateskirt', { bodyId: 24420, legsId: 24421 }, 1020],
    ['the helm alone', { headId: 24419 }, 1005],
  ])('adds its crush bonus for %s', (_what, pieces, numerator) => {
    const bonus = { numerator, denominator: 1000 };
    expect(selectPlayerAttackProfile({ ...crush, ...pieces })).toMatchObject({
      maxHit: { kind: 'staged', stages: [bonus] },
      hit: { accuracy: { attackRollStages: [bonus] } },
    });
  });

  it('adds nothing to a stab attack', () => {
    const pieces = { headId: 24419, bodyId: 24420, legsId: 24421 };
    expect(selectPlayerAttackProfile({ ...crush, ...pieces, formulaStyle: 'melee_stab' })).toEqual(
      selectPlayerAttackProfile({ ...crush, formulaStyle: 'melee_stab' }),
    );
  });

  it('applies after a Slayer helm, as the Maximum melee hit passives are ordered', () => {
    const profile = selectPlayerAttackProfile({ ...crush, headId: 11865, bodyId: 24420, legsId: 24421 });
    expect(profile).toMatchObject({
      maxHit: {
        kind: 'staged',
        stages: [
          { numerator: 7, denominator: 6 },
          { numerator: 1020, denominator: 1000 },
        ],
      },
    });
  });
});

describe('chinchompa fuse accuracy', () => {
  const BLACK_CHINCHOMPA = 11959;
  const throwAt = (combatStyle: 'Accurate' | 'Rapid' | 'Longrange', targetDistance: number | undefined) =>
    selectPlayerAttackProfile({
      weaponId: BLACK_CHINCHOMPA,
      targetSize: 1,
      isSpecialAttack: false,
      formulaStyle: 'ranged',
      combatStyle,
      targetDistance,
    });
  const accuracyPercent = (profile: PlayerAttackProfile | null): number => {
    if (profile?.kind !== 'singleHit' || profile.hit.accuracy.kind !== 'standard')
      throw new TypeError('Expected a throw');
    const [stage, ...rest] = profile.hit.accuracy.attackRollStages ?? [];
    expect(rest).toEqual([]);
    return stage === undefined ? 100 : (100 * stage.numerator) / stage.denominator;
  };

  it.each([
    { fuse: 'Short', combatStyle: 'Accurate', bands: [100, 75, 50] },
    { fuse: 'Medium', combatStyle: 'Rapid', bands: [75, 100, 75] },
    { fuse: 'Long', combatStyle: 'Longrange', bands: [50, 75, 100] },
  ] as const)('$fuse fuse scales the attack roll by $bands % at 0-3, 4-6 and 7+ tiles', ({ combatStyle, bands }) => {
    const [near, middle, far] = bands;
    expect([0, 1, 3, 4, 6, 7, 9, 10].map((distance) => accuracyPercent(throwAt(combatStyle, distance)))).toEqual([
      near,
      near,
      near,
      middle,
      middle,
      far,
      far,
      far,
    ]);
  });

  it('scales only the attack roll, never the max hit', () => {
    expect(throwAt('Longrange', 1)).toMatchObject({ maxHit: { kind: 'base' } });
  });

  it('rolls accuracy from the floored, scaled attack roll', () => {
    const profile = throwAt('Accurate', 4);
    if (profile === null) throw new TypeError('Expected a throw');
    const plan = planPlayerAttack({
      attacker: ATTACKER,
      target: TARGET,
      formulaStyle: 'ranged',
      equipmentStats: { ...createEmptyStats(), attackRanged: 81, rangedStrength: 30 },
      prayerMultipliers: {
        attack: 1,
        strength: 1,
        defence: 1,
        ranged: 1,
        rangedStrength: 1,
        magic: 1,
        magicDamage: 1,
      },
      attackSpeedTicks: 4,
      delivery: { style: 'range', attackKind: 'range_arrow', impactDelayTicks: 2 },
      application: { outgoingDamageMultiplier: 1, specialAttackDamageMultiplier: 1 },
      profile,
      rangedDefenceType: 'heavy',
    });
    if (plan.kind !== 'ready') throw new TypeError('Expected a ready player attack plan');
    const attackRoll = plan.diagnostics?.baseAttackRoll ?? Number.NaN;
    const defenceRoll = plan.diagnostics?.baseDefenceRoll ?? Number.NaN;
    expect(attackRoll % 4).not.toBe(0); // so the floor matters
    expect(plan.hits[0].accuracy).toEqual({
      kind: 'roll',
      chance: hitChance(Math.floor((attackRoll * 75) / 100), defenceRoll),
    });
  });

  it('applies after the imbued Slayer helmet', () => {
    const profile = selectPlayerAttackProfile({
      weaponId: BLACK_CHINCHOMPA,
      headId: 11865,
      targetSize: 1,
      isSpecialAttack: false,
      formulaStyle: 'ranged',
      combatStyle: 'Accurate',
      targetDistance: 8,
    });
    expect(profile).toMatchObject({
      hit: {
        accuracy: {
          attackRollStages: [
            { numerator: 23, denominator: 20 },
            { numerator: 50, denominator: 100 },
          ],
        },
      },
    });
  });

  it('leaves the roll alone without a known distance, off a ranged throw, and on other weapons', () => {
    expect(accuracyPercent(throwAt('Accurate', undefined))).toBe(100);
    expect(
      selectPlayerAttackProfile({
        weaponId: BLACK_CHINCHOMPA,
        targetSize: 1,
        isSpecialAttack: false,
        formulaStyle: 'magic',
        combatStyle: 'Accurate',
        targetDistance: 9,
        resources: { kind: 'spell', source: 'none', spellId: 'Ice Barrage' },
      }),
    ).toEqual(ORDINARY_ATTACK_PROFILE);
    expect(
      selectPlayerAttackProfile({
        weaponId: 12926,
        targetSize: 1,
        isSpecialAttack: false,
        formulaStyle: 'ranged',
        combatStyle: 'Accurate',
        targetDistance: 9,
      }),
    ).toEqual(ORDINARY_ATTACK_PROFILE);
  });
});
