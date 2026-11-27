import { describe, expect, it, vi } from 'vitest';
import { ObjType } from '../../../rs/config/objtype/ObjType';
import { WIKI_TIERED_PRAYER_ROWS, type WikiTieredPrayer } from '../../../types/__tests__/fixtures/wikiPrayerTable';
import { createEmptyCombatSupplies } from '../../../types/encounterLoadout';
import type { EquipmentStats } from '../../../types/equipmentStats';
import { createEmptyStats, getItemStats } from '../../../types/equipmentStats';
import { createEmptyInventory } from '../../../types/inventory';
import type { PlayerStats } from '../../../types/playerState';
import { PrayerType } from '../../../types/simulation';
import type { NpcFormulaStats } from '../../actors/types';
import { resolveAttackResources } from '../attackResources';
import {
  calculateMaxHit,
  lookupPrayerMultipliersFromState,
  type NpcFormulaActor,
  type PlayerFormulaActor,
} from '../formulas';
import { DEFAULT_PRAYER_MULTIPLIERS } from '../formulaTypes';
import { type PlayerAttackProfile, planPlayerAttack } from '../playerAttackPlanning';
import { resolvePlayerAttack } from '../playerAttackResolution';
import { type PlayerAttackRuntimeInput, planPlayerAttackFromRuntime } from '../playerAttackRuntime';
import type { PlayerAttackPlan, ReadyPlayerAttackPlan } from '../playerAttackTypes';
import { getPoweredStaffBaseMaxHit, getRangedDefenceType } from '../weaponCombatData';

const ORDINARY_PROFILE: PlayerAttackProfile = {
  kind: 'singleHit',
  maxHit: { kind: 'base' },
  hit: {
    accuracy: { kind: 'standard' },
    damage: { kind: 'uniformToMaxHit' },
  },
};

const BASE_STATS: PlayerStats = {
  attack: { current: 99, max: 99 },
  strength: { current: 99, max: 99 },
  defence: { current: 99, max: 99 },
  ranged: { current: 99, max: 99 },
  magic: { current: 99, max: 99 },
  prayer: { current: 99, max: 99 },
  hitpoints: { current: 99, max: 99 },
  agility: { current: 99, max: 99 },
};

const NPC_STATS: NpcFormulaStats = {
  levels: { attack: 90, strength: 91, defence: 80, ranged: 92, magic: 80 },
  offensive: { atk: 12, str: 13, ranged: 14, rangedStr: 15, magic: 16, magicStr: 17 },
  defensive: { stab: 36, slash: 20, crush: 32, rangedLight: 40, rangedStandard: 40, rangedHeavy: 40, magic: 44 },
};

const BASE_TARGET: NpcFormulaActor = {
  kind: 'npc',
  id: 1234,
  levels: { ...NPC_STATS.levels },
  offensive: { ...NPC_STATS.offensive },
  defensive: { ...NPC_STATS.defensive },
};

const APPLICATION = {
  outgoingDamageMultiplier: 1.25,
  specialAttackDamageMultiplier: 0.8,
};

function equipment(overrides: Partial<EquipmentStats> = {}): EquipmentStats {
  return { ...createEmptyStats(), ...overrides };
}

function runtimeInput(overrides: Partial<PlayerAttackRuntimeInput> = {}): PlayerAttackRuntimeInput {
  return {
    player: {
      stats: BASE_STATS,
      equipment: { weapon: 4587 },
      equipmentStats: equipment({ attackSlash: 80, meleeStrength: 120, attackSpeed: 4, attackRange: 1 }),
      activePrayer: null,
      boostPrayers: [],
      selectedAttackStyleIndex: 0,
    },
    target: { npcTypeId: 1234, formulaStats: NPC_STATS },
    formulaStyle: 'melee_slash',
    resources: { kind: 'none', source: 'none' },
    attackSpeedTicks: 4,
    delivery: { style: 'melee', attackKind: 'melee_slash', impactDelayTicks: 0 },
    application: APPLICATION,
    profile: ORDINARY_PROFILE,
    manualCast: false,
    ...overrides,
  };
}

type DirectPlanInput = {
  readonly input: PlayerAttackRuntimeInput;
  readonly attacker: PlayerFormulaActor;
  readonly target: NpcFormulaActor;
  readonly equipmentStats: EquipmentStats;
};

function directPlan({ input, attacker, target, equipmentStats }: DirectPlanInput): PlayerAttackPlan {
  return planPlayerAttack({
    attacker,
    target,
    formulaStyle: input.formulaStyle,
    equipmentStats,
    prayerMultipliers: lookupPrayerMultipliersFromState(input.player.activePrayer, input.player.boostPrayers),
    attackSpeedTicks: input.attackSpeedTicks,
    delivery: input.delivery,
    application: input.application,
    profile: input.profile,
    rangedDefenceType: getRangedDefenceType(input.player.equipment.weapon),
  });
}

function ready(plan: PlayerAttackPlan | null): ReadyPlayerAttackPlan {
  if (plan === null || plan.kind !== 'ready') {
    throw new TypeError('Expected a ready player attack plan');
  }
  return plan;
}

describe('planPlayerAttackFromRuntime', () => {
  it.each([
    { head: 26475, body: 26463, legs: 26465, hands: 26467, elite: false },
    { head: 26475, body: 26469, legs: 26471, hands: 26467, elite: true },
    { head: 27006, body: 27000, legs: 27001, hands: 27002, elite: false },
    { head: 27006, body: 27003, legs: 27004, hands: 27002, elite: true },
    { head: 27006, body: 27003, legs: 27001, hands: 27002, elite: false },
  ])('retains Void set effects for body $body and legs $legs', ({ head, body, legs, hands, elite }) => {
    const rangedStats = equipment({ attackRanged: 60, rangedStrength: 100, attackSpeed: 4, attackRange: 10 });
    const input = runtimeInput({
      player: {
        ...runtimeInput().player,
        equipment: { weapon: 25888, head, body, legs, hands },
        equipmentStats: rangedStats,
      },
      formulaStyle: 'ranged',
      delivery: { style: 'range', attackKind: 'range_arrow', impactDelayTicks: 3 },
    });
    const attacker: PlayerFormulaActor = {
      kind: 'player',
      levels: { attack: 99, strength: 99, defence: 99, ranged: 99, magic: 99 },
      stance: 'Accurate',
      voidSet: elite ? 'elite_ranged' : 'ranged',
    };

    const plan = ready(planPlayerAttackFromRuntime(input));

    expect(plan).toEqual(directPlan({ input, attacker, target: BASE_TARGET, equipmentStats: rangedStats }));
    expect(input.player.equipment).toEqual({ weapon: 25888, head, body, legs, hands });
  });

  it.each([
    'equipped',
    'quiver',
  ] as const)('floors successful seeking arrow rolls without shifting the distribution from %s', (source) => {
    const input = runtimeInput({
      player: { ...runtimeInput().player, equipment: { weapon: 20997 }, equipmentStats: equipment() },
      formulaStyle: 'ranged',
      resources: { kind: 'ammo', source, ammoId: 33595 },
      lookupItemStats: () => equipment({ attackRanged: 20, rangedStrength: 60 }),
      application: { outgoingDamageMultiplier: 1, specialAttackDamageMultiplier: 1 },
      delivery: { style: 'range', attackKind: 'range_arrow', impactDelayTicks: 3 },
    });
    const plan = ready(planPlayerAttackFromRuntime(input));
    const ordinary = ready(
      planPlayerAttackFromRuntime({ ...input, resources: { kind: 'ammo', source, ammoId: 11212 } }),
    );
    const ordinaryDamage = ordinary.hits[0].damage;
    if (ordinaryDamage.kind !== 'uniform') throw new TypeError('Expected uniform arrow damage');
    const width = ordinaryDamage.maximumInclusive + 1;

    const hits = [0, 1, 2, 3, 4].map(
      (damage) =>
        resolvePlayerAttack(
          plan,
          vi
            .fn<() => number>()
            .mockReturnValueOnce(0)
            .mockReturnValue((damage + 0.1) / width),
        ).hits[0].rolledDamage,
    );

    expect(hits).toEqual([3, 3, 3, 3, 4]);
    expect(resolvePlayerAttack(plan, () => 0.999999).hits[0]).toMatchObject({
      accuracySucceeded: false,
      rolledDamage: 0,
    });
  });

  it.each([
    { equippedId: 33595, quiverId: 11212, expectedRoll: 9240, expectedSource: 'equipped', expectedMinimum: 3 },
    { equippedId: 11212, quiverId: 33595, expectedRoll: 7040, expectedSource: 'equipped', expectedMinimum: 0 },
    { equippedId: 22947, quiverId: 33595, expectedRoll: 10340, expectedSource: 'quiver', expectedMinimum: 3 },
  ])('uses only fired ammo bonuses with equipped $equippedId and quiver $quiverId', ({
    equippedId,
    quiverId,
    expectedRoll,
    expectedSource,
    expectedMinimum,
  }) => {
    const resources = resolveAttackResources({
      weaponId: 20997,
      equipment: { weapon: 20997, cape: 28951 },
      inventory: createEmptyInventory(),
      formulaStyle: 'ranged',
      supplies: { ...createEmptyCombatSupplies(), equippedAmmo: { id: equippedId }, quiverAmmo: { id: quiverId } },
    });
    const input = runtimeInput({
      player: { ...runtimeInput().player, equipment: { weapon: 20997, cape: 28951 }, equipmentStats: equipment() },
      formulaStyle: 'ranged',
      resources,
      lookupItemStats: (itemId) =>
        getItemStats(
          new ObjType(itemId, {
            name: 'test',
            game: 'oldschool',
            environment: 'live',
            revision: 232,
            timestamp: '',
            size: 0,
          }),
        ),
    });

    const plan = ready(planPlayerAttackFromRuntime(input));

    expect(resources.source).toBe(expectedSource);
    expect(plan.diagnostics?.baseAttackRoll).toBe(expectedRoll);
    expect(resolvePlayerAttack(plan, () => 0).hits[0].rolledDamage).toBe(expectedMinimum);
  });

  it.each([
    { weaponId: 12926, formulaStyle: 'ranged' },
    { weaponId: 9185, formulaStyle: 'ranged' },
    { weaponId: 25865, formulaStyle: 'ranged' },
    { weaponId: 4587, formulaStyle: 'melee_slash' },
    { weaponId: 27275, formulaStyle: 'magic' },
  ] as const)('ignores stored seeking arrows for weapon $weaponId', ({ weaponId, formulaStyle }) => {
    const context = {
      weaponId,
      equipment: { weapon: weaponId, cape: 28951 },
      inventory: createEmptyInventory(),
      formulaStyle,
      supplies: {
        ...createEmptyCombatSupplies(),
        equippedAmmo: { id: 33595 },
        quiverAmmo: { id: 33595 },
        blowpipe: { id: 11230 },
      },
    };
    const resources = resolveAttackResources(context);
    const baselineResources = resolveAttackResources({
      ...context,
      supplies: { ...context.supplies, equippedAmmo: null, quiverAmmo: null },
    });
    const lookupItemStats = vi.fn((itemId: number) =>
      equipment({ attackRanged: itemId === 33595 ? 20 : 0, rangedStrength: 60 }),
    );
    const input = runtimeInput({
      player: { ...runtimeInput().player, equipment: context.equipment },
      formulaStyle,
      resources,
      lookupItemStats,
    });

    const plan = planPlayerAttackFromRuntime(input);

    expect(plan).toEqual(planPlayerAttackFromRuntime({ ...input, resources: baselineResources }));
    expect(lookupItemStats).not.toHaveBeenCalledWith(33595);
  });

  it('compiles the required semantic profile instead of an internal ordinary default', () => {
    const input = runtimeInput({
      profile: {
        kind: 'secondHitIfFirstAccurate',
        maxHit: { kind: 'base' },
        first: {
          accuracy: { kind: 'standard' },
          damage: { kind: 'uniformToMaxHit' },
        },
        second: {
          impactDelayOffsetTicks: 1,
          accuracy: { kind: 'standard' },
          damage: { kind: 'uniformToMaxHit' },
        },
      },
      delivery: { style: 'melee', attackKind: 'melee_slash', impactDelayTicks: 3 },
    });

    const plan = ready(planPlayerAttackFromRuntime(input));

    expect(plan).toEqual(
      directPlan({
        input,
        attacker: {
          kind: 'player',
          levels: { attack: 99, strength: 99, defence: 99, ranged: 99, magic: 99 },
          stance: 'Accurate',
          voidSet: 'none',
        },
        target: BASE_TARGET,
        equipmentStats: input.player.equipmentStats,
      }),
    );
    expect(plan.hits.map((hit) => hit.impactDelayTicks)).toEqual([3, 4]);
  });

  it('uses boosted combat levels, the selected stance, prayers, and runtime metadata', () => {
    const boostedStats: PlayerStats = {
      ...BASE_STATS,
      attack: { current: 112, max: 99 },
      strength: { current: 118, max: 99 },
      defence: { current: 105, max: 99 },
    };
    const input = runtimeInput({
      player: {
        ...runtimeInput().player,
        stats: boostedStats,
        selectedAttackStyleIndex: 1,
        boostPrayers: [PrayerType.Piety],
      },
      attackSpeedTicks: 7,
      delivery: { style: 'melee', attackKind: 'melee_slash', impactDelayTicks: 3 },
    });

    const plan = planPlayerAttackFromRuntime(input);

    expect(plan).toEqual(
      directPlan({
        input,
        attacker: {
          kind: 'player',
          levels: { attack: 112, strength: 118, defence: 105, ranged: 99, magic: 99 },
          stance: 'Aggressive',
          voidSet: 'none',
        },
        target: BASE_TARGET,
        equipmentStats: input.player.equipmentStats,
      }),
    );
  });

  it('applies the current NPC defence drain without mutating formula stats', () => {
    const input = runtimeInput({
      target: { npcTypeId: 1234, formulaStats: NPC_STATS, debuffs: { defenceDrain: 17, magicDrain: 13 } },
    });
    const drainedTarget: NpcFormulaActor = {
      ...BASE_TARGET,
      levels: { ...BASE_TARGET.levels, defence: 63, magic: 67 },
    };

    const plan = planPlayerAttackFromRuntime(input);

    expect(plan).toEqual(
      directPlan({
        input,
        attacker: {
          kind: 'player',
          levels: { attack: 99, strength: 99, defence: 99, ranged: 99, magic: 99 },
          stance: 'Accurate',
          voidSet: 'none',
        },
        target: drainedTarget,
        equipmentStats: input.player.equipmentStats,
      }),
    );
    expect(plan).not.toEqual(
      directPlan({
        input,
        attacker: {
          kind: 'player',
          levels: { attack: 99, strength: 99, defence: 99, ranged: 99, magic: 99 },
          stance: 'Accurate',
          voidSet: 'none',
        },
        target: BASE_TARGET,
        equipmentStats: input.player.equipmentStats,
      }),
    );
    expect(NPC_STATS.levels).toEqual({ attack: 90, strength: 91, defence: 80, ranged: 92, magic: 80 });
  });

  it('applies the current NPC Magic drain to spell accuracy without mutating formula stats', () => {
    const input = runtimeInput({
      player: {
        ...runtimeInput().player,
        equipment: { weapon: 4675 },
        equipmentStats: equipment({ attackMagic: 70, magicDamage: 10, attackSpeed: 5, attackRange: 10 }),
        selectedAttackStyleIndex: 3,
      },
      target: { npcTypeId: 1234, formulaStats: NPC_STATS, debuffs: { magicDrain: 19 } },
      formulaStyle: 'magic',
      resources: { kind: 'spell', source: 'none', spellId: 'Ice Barrage' },
      delivery: { style: 'magic', attackKind: 'magic_fire', impactDelayTicks: 4 },
    });

    const plan = planPlayerAttackFromRuntime(input);

    expect(plan).toEqual(
      directPlan({
        input,
        attacker: {
          kind: 'player',
          levels: { attack: 99, strength: 99, defence: 99, ranged: 99, magic: 99 },
          stance: 'Casting',
          magicBaseMaxHit: 30,
          voidSet: 'none',
        },
        target: { ...BASE_TARGET, levels: { ...BASE_TARGET.levels, magic: 61 } },
        equipmentStats: input.player.equipmentStats,
      }),
    );
    expect(plan).not.toEqual(
      directPlan({
        input,
        attacker: {
          kind: 'player',
          levels: { attack: 99, strength: 99, defence: 99, ranged: 99, magic: 99 },
          stance: 'Casting',
          magicBaseMaxHit: 30,
          voidSet: 'none',
        },
        target: BASE_TARGET,
        equipmentStats: input.player.equipmentStats,
      }),
    );
    expect(NPC_STATS.levels.magic).toBe(80);
  });

  it('adds resolved ammo stats exactly once while retaining weapon speed and range', () => {
    const ammoSpeed = vi.fn(() => 2);
    const ammoRange = vi.fn(() => 4);
    const ammoStats: EquipmentStats = {
      attackStab: 1,
      attackSlash: 2,
      attackCrush: 3,
      attackMagic: 4,
      attackRanged: 30,
      defenceStab: 5,
      defenceSlash: 6,
      defenceCrush: 7,
      defenceMagic: 8,
      defenceRanged: 9,
      meleeStrength: 10,
      rangedStrength: 40,
      magicDamage: 11,
      prayer: 12,
      get attackSpeed() {
        return ammoSpeed();
      },
      get attackRange() {
        return ammoRange();
      },
    };
    const lookupItemStats = vi.fn((itemId: number) => (itemId === 9244 ? ammoStats : null));
    const weaponStats = equipment({ attackRanged: 20, rangedStrength: 50, attackSpeed: 5, attackRange: 7 });
    const input = runtimeInput({
      player: {
        ...runtimeInput().player,
        equipment: { weapon: 9185 },
        equipmentStats: weaponStats,
        selectedAttackStyleIndex: 1,
      },
      formulaStyle: 'ranged',
      resources: { kind: 'ammo', source: 'equipped', ammoId: 9244 },
      delivery: { style: 'range', attackKind: 'range_arrow', impactDelayTicks: 2 },
      lookupItemStats,
    });
    const combinedStats: EquipmentStats = {
      attackStab: 1,
      attackSlash: 2,
      attackCrush: 3,
      attackMagic: 4,
      attackRanged: 50,
      defenceStab: 5,
      defenceSlash: 6,
      defenceCrush: 7,
      defenceMagic: 8,
      defenceRanged: 9,
      meleeStrength: 10,
      rangedStrength: 90,
      magicDamage: 11,
      prayer: 12,
      attackSpeed: 5,
      attackRange: 7,
    };

    const plan = planPlayerAttackFromRuntime(input);

    expect(plan).toEqual(
      directPlan({
        input,
        attacker: {
          kind: 'player',
          levels: { attack: 99, strength: 99, defence: 99, ranged: 99, magic: 99 },
          stance: 'Other',
          voidSet: 'none',
        },
        target: BASE_TARGET,
        equipmentStats: combinedStats,
      }),
    );
    expect(lookupItemStats).toHaveBeenCalledTimes(1);
    expect(lookupItemStats).toHaveBeenCalledWith(9244);
    expect(ammoSpeed).not.toHaveBeenCalled();
    expect(ammoRange).not.toHaveBeenCalled();
  });

  it.each([
    { weapon: 'Toxic blowpipe', weaponId: 12926, source: 'blowpipe', ammoId: 11230, bonus: 10 },
    { weapon: 'Rune crossbow', weaponId: 9185, source: 'equipped', ammoId: 9244, bonus: 30 },
    { weapon: 'Armadyl crossbow', weaponId: 11785, source: 'equipped', ammoId: 9244, bonus: 30 },
    { weapon: 'Twisted bow', weaponId: 20997, source: 'equipped', ammoId: 11212, bonus: 20 },
    { weapon: 'Eclipse atlatl', weaponId: 29000, source: 'equipped', ammoId: 28991, bonus: 20 },
  ] as const)('rolls $weapon against the ranged defence its weapon type selects', ({
    weaponId,
    source,
    ammoId,
    bonus,
  }) => {
    const input = runtimeInput({
      player: {
        ...runtimeInput().player,
        equipment: { weapon: weaponId },
        equipmentStats: equipment({ attackRanged: 20, rangedStrength: 50 }),
      },
      target: {
        npcTypeId: 1234,
        formulaStats: {
          ...NPC_STATS,
          defensive: { ...NPC_STATS.defensive, rangedLight: 10, rangedStandard: 20, rangedHeavy: 30 },
        },
      },
      formulaStyle: 'ranged',
      resources: { kind: 'ammo', source, ammoId },
      delivery: { style: 'range', attackKind: 'range_arrow', impactDelayTicks: 2 },
      lookupItemStats: () => equipment(),
    });

    const plan = ready(planPlayerAttackFromRuntime(input));

    expect(plan.diagnostics?.baseDefenceRoll).toBe((80 + 9) * (bonus + 64));
  });

  it('fails closed when resolved ammo has no stat lookup', () => {
    const input = runtimeInput({
      formulaStyle: 'ranged',
      resources: { kind: 'ammo', source: 'quiver', ammoId: 9244 },
      delivery: { style: 'range', attackKind: 'range_arrow', impactDelayTicks: 2 },
    });

    const plan = planPlayerAttackFromRuntime(input);

    expect(plan).toBeNull();
  });

  it('uses Ice Barrage base max, Manual Cast stance, and the Magic landed minimum', () => {
    const input = runtimeInput({
      player: {
        ...runtimeInput().player,
        stats: { ...BASE_STATS, magic: { current: 106, max: 99 } },
        equipmentStats: equipment({ attackMagic: 65, magicDamage: 15, attackSpeed: 4, attackRange: 1 }),
        selectedAttackStyleIndex: 2,
      },
      formulaStyle: 'magic',
      resources: { kind: 'spell', source: 'none', spellId: 'Ice Barrage' },
      attackSpeedTicks: 5,
      delivery: { style: 'magic', attackKind: 'magic_fire', impactDelayTicks: 6 },
      manualCast: true,
    });

    const plan = ready(planPlayerAttackFromRuntime(input));

    expect(plan).toEqual(
      directPlan({
        input,
        attacker: {
          kind: 'player',
          levels: { attack: 99, strength: 99, defence: 99, ranged: 99, magic: 106 },
          stance: 'Manual Cast',
          magicBaseMaxHit: 30,
          voidSet: 'none',
        },
        target: BASE_TARGET,
        equipmentStats: input.player.equipmentStats,
      }),
    );
    expect(plan.hits[0]?.damage).toEqual({
      kind: 'minimum',
      minimumDamage: 1,
      base: { kind: 'uniform', minimumInclusive: 0, maximumInclusive: 34 },
    });
  });

  it('scales autocast Magic Dart from the current boosted Magic level', () => {
    const input = runtimeInput({
      player: {
        ...runtimeInput().player,
        stats: { ...BASE_STATS, magic: { current: 87, max: 80 } },
        equipment: { weapon: 4675 },
        equipmentStats: equipment({ attackMagic: 45, attackSpeed: 5, attackRange: 10 }),
        selectedAttackStyleIndex: 3,
      },
      formulaStyle: 'magic',
      resources: { kind: 'spell', source: 'none', spellId: 'Magic Dart' },
      delivery: { style: 'magic', attackKind: 'magic_fire', impactDelayTicks: 4 },
    });

    const plan = planPlayerAttackFromRuntime(input);

    expect(plan).toEqual(
      directPlan({
        input,
        attacker: {
          kind: 'player',
          levels: { attack: 99, strength: 99, defence: 99, ranged: 99, magic: 87 },
          stance: 'Casting',
          magicBaseMaxHit: 18,
          voidSet: 'none',
        },
        target: BASE_TARGET,
        equipmentStats: input.player.equipmentStats,
      }),
    );
  });

  it('uses the first-party powered-staff base max hit', () => {
    const currentMagic = 96;
    const poweredMaxHit = getPoweredStaffBaseMaxHit(11907, currentMagic);
    if (poweredMaxHit === undefined) throw new TypeError('Expected a powered-staff max hit');
    const input = runtimeInput({
      player: {
        ...runtimeInput().player,
        stats: { ...BASE_STATS, magic: { current: currentMagic, max: 92 } },
        equipment: { weapon: 11907 },
        equipmentStats: equipment({ attackMagic: 25, magicDamage: 10, attackSpeed: 4, attackRange: 7 }),
        selectedAttackStyleIndex: 0,
      },
      formulaStyle: 'magic',
      delivery: { style: 'magic', attackKind: 'magic_fire', impactDelayTicks: 3 },
    });

    const plan = planPlayerAttackFromRuntime(input);

    expect(plan).toEqual(
      directPlan({
        input,
        attacker: {
          kind: 'player',
          levels: { attack: 99, strength: 99, defence: 99, ranged: 99, magic: currentMagic },
          stance: 'Accurate',
          magicBaseMaxHit: poweredMaxHit,
          voidSet: 'none',
        },
        target: BASE_TARGET,
        equipmentStats: input.player.equipmentStats,
      }),
    );
  });

  it('does not apply Tumeken shadow stats to the Holy sanguinesti staff', () => {
    const magicStats = equipment({ attackMagic: 25, magicDamage: 10, attackSpeed: 4, attackRange: 7 });
    const input = runtimeInput({
      player: {
        ...runtimeInput().player,
        equipment: { weapon: 25731 },
        equipmentStats: magicStats,
      },
      formulaStyle: 'magic',
      delivery: { style: 'magic', attackKind: 'magic_fire', impactDelayTicks: 3 },
    });

    const plan = planPlayerAttackFromRuntime(input);

    expect(plan).toEqual(
      directPlan({
        input,
        attacker: {
          kind: 'player',
          levels: { attack: 99, strength: 99, defence: 99, ranged: 99, magic: 99 },
          stance: 'Accurate',
          magicBaseMaxHit: 33,
          voidSet: 'none',
        },
        target: BASE_TARGET,
        equipmentStats: magicStats,
      }),
    );
  });

  it('distinguishes regular and elite ranged Void only when both elite pieces are equipped', () => {
    const rangedStats = equipment({ attackRanged: 60, rangedStrength: 100, attackSpeed: 4, attackRange: 10 });
    const regularInput = runtimeInput({
      player: {
        ...runtimeInput().player,
        equipment: { weapon: 20997, head: 11664, body: 8839, legs: 8840, hands: 8842 },
        equipmentStats: rangedStats,
        selectedAttackStyleIndex: 0,
      },
      formulaStyle: 'ranged',
      resources: { kind: 'ammo', source: 'equipped', ammoId: 11212 },
      delivery: { style: 'range', attackKind: 'range_arrow', impactDelayTicks: 2 },
      lookupItemStats: () => createEmptyStats(),
    });
    const eliteInput: PlayerAttackRuntimeInput = {
      ...regularInput,
      player: { ...regularInput.player, equipment: { ...regularInput.player.equipment, body: 13072, legs: 13073 } },
    };
    const mixedInput: PlayerAttackRuntimeInput = {
      ...regularInput,
      player: { ...regularInput.player, equipment: { ...regularInput.player.equipment, body: 13072 } },
    };
    const regularActor: PlayerFormulaActor = {
      kind: 'player',
      levels: { attack: 99, strength: 99, defence: 99, ranged: 99, magic: 99 },
      stance: 'Accurate',
      voidSet: 'ranged',
    };
    const eliteActor: PlayerFormulaActor = { ...regularActor, voidSet: 'elite_ranged' };

    const regular = ready(planPlayerAttackFromRuntime(regularInput));
    const elite = ready(planPlayerAttackFromRuntime(eliteInput));
    const mixed = ready(planPlayerAttackFromRuntime(mixedInput));

    expect(regular).toEqual(
      directPlan({ input: regularInput, attacker: regularActor, target: BASE_TARGET, equipmentStats: rangedStats }),
    );
    expect(elite).toEqual(
      directPlan({ input: eliteInput, attacker: eliteActor, target: BASE_TARGET, equipmentStats: rangedStats }),
    );
    expect(mixed).toEqual(
      directPlan({ input: mixedInput, attacker: regularActor, target: BASE_TARGET, equipmentStats: rangedStats }),
    );
    expect(calculateMaxHit(eliteActor, 'ranged', rangedStats)).toBeGreaterThan(
      calculateMaxHit(regularActor, 'ranged', rangedStats),
    );
  });

  it('distinguishes regular and elite magic Void damage', () => {
    const magicStats = equipment({ attackMagic: 60, attackSpeed: 5, attackRange: 10 });
    const regularInput = runtimeInput({
      player: {
        ...runtimeInput().player,
        equipment: { weapon: 4675, head: 11663, body: 8839, legs: 8840, hands: 8842 },
        equipmentStats: magicStats,
        selectedAttackStyleIndex: 3,
      },
      formulaStyle: 'magic',
      resources: { kind: 'spell', source: 'none', spellId: 'Ice Barrage' },
      delivery: { style: 'magic', attackKind: 'magic_fire', impactDelayTicks: 4 },
    });
    const eliteInput: PlayerAttackRuntimeInput = {
      ...regularInput,
      player: { ...regularInput.player, equipment: { ...regularInput.player.equipment, body: 13072, legs: 13073 } },
    };
    const regularActor: PlayerFormulaActor = {
      kind: 'player',
      levels: { attack: 99, strength: 99, defence: 99, ranged: 99, magic: 99 },
      stance: 'Casting',
      magicBaseMaxHit: 30,
      voidSet: 'magic',
    };
    const eliteActor: PlayerFormulaActor = { ...regularActor, voidSet: 'elite_magic' };

    const regular = ready(planPlayerAttackFromRuntime(regularInput));
    const elite = ready(planPlayerAttackFromRuntime(eliteInput));

    expect(regular).toEqual(
      directPlan({ input: regularInput, attacker: regularActor, target: BASE_TARGET, equipmentStats: magicStats }),
    );
    expect(elite).toEqual(
      directPlan({ input: eliteInput, attacker: eliteActor, target: BASE_TARGET, equipmentStats: magicStats }),
    );
    expect(calculateMaxHit(eliteActor, 'magic', magicStats)).toBeGreaterThan(
      calculateMaxHit(regularActor, 'magic', magicStats),
    );
  });

  it('uses Strength and melee Strength for Eclipse atlatl damage while retaining ranged prayer', () => {
    const input = runtimeInput({
      player: {
        ...runtimeInput().player,
        stats: {
          ...BASE_STATS,
          strength: { current: 112, max: 99 },
          ranged: { current: 105, max: 99 },
        },
        equipment: { weapon: 29000 },
        equipmentStats: equipment({ attackRanged: 120, meleeStrength: 80, rangedStrength: 0 }),
        boostPrayers: [PrayerType.Rigour],
        selectedAttackStyleIndex: 1,
      },
      formulaStyle: 'ranged',
      resources: { kind: 'ammo', source: 'equipped', ammoId: 28991 },
      lookupItemStats: () => equipment({ rangedStrength: 0 }),
      delivery: { style: 'range', attackKind: 'range_arrow', impactDelayTicks: 2 },
      application: { outgoingDamageMultiplier: 1, specialAttackDamageMultiplier: 1 },
    });

    const plan = ready(planPlayerAttackFromRuntime(input));

    expect(plan.hits[0].damage).toEqual({ kind: 'uniform', minimumInclusive: 0, maximumInclusive: 33 });
  });

  it('adds charged Dizana quiver stats only to arrows and bolts', () => {
    const base = equipment({ attackRanged: 100, rangedStrength: 100 });
    const arrowInput = runtimeInput({
      player: {
        ...runtimeInput().player,
        equipment: { weapon: 20997, cape: 28951 },
        equipmentStats: base,
      },
      formulaStyle: 'ranged',
      resources: { kind: 'ammo', source: 'quiver', ammoId: 11212 },
      lookupItemStats: () => createEmptyStats(),
      delivery: { style: 'range', attackKind: 'range_arrow', impactDelayTicks: 2 },
    });
    const dartInput: PlayerAttackRuntimeInput = {
      ...arrowInput,
      player: { ...arrowInput.player, equipment: { weapon: 12926, cape: 28951 } },
      resources: { kind: 'ammo', source: 'equipped', ammoId: 28991 },
    };
    const equippedArrowInput: PlayerAttackRuntimeInput = {
      ...arrowInput,
      resources: { kind: 'ammo', source: 'equipped', ammoId: 11212 },
    };

    const arrow = ready(planPlayerAttackFromRuntime(arrowInput));
    const dart = ready(planPlayerAttackFromRuntime(dartInput));
    const equippedArrow = ready(planPlayerAttackFromRuntime(equippedArrowInput));

    expect(arrow.hits[0].damage).toEqual({ kind: 'uniform', minimumInclusive: 0, maximumInclusive: 28 });
    expect(dart.hits[0].damage).toEqual({ kind: 'uniform', minimumInclusive: 0, maximumInclusive: 28 });
    expect(equippedArrow.hits[0].damage).toEqual({ kind: 'uniform', minimumInclusive: 0, maximumInclusive: 28 });
    expect(arrow.hits[0].accuracy).not.toEqual(dart.hits[0].accuracy);
    expect(equippedArrow.hits[0].accuracy).toEqual(dart.hits[0].accuracy);
  });

  it.each([28951, 28953, 28955, 28957, 28902, 28906])('gives cape %i the charged quiver bonus', (cape) => {
    const withCape = (id: number | undefined): PlayerAttackRuntimeInput =>
      runtimeInput({
        player: {
          ...runtimeInput().player,
          equipment: { weapon: 20997, ...(id === undefined ? {} : { cape: id }) },
          equipmentStats: equipment({ attackRanged: 100, rangedStrength: 100 }),
        },
        formulaStyle: 'ranged',
        resources: { kind: 'ammo', source: 'quiver', ammoId: 11212 },
        lookupItemStats: () => createEmptyStats(),
        delivery: { style: 'range', attackKind: 'range_arrow', impactDelayTicks: 2 },
      });

    const charged = ready(planPlayerAttackFromRuntime(withCape(cape)));
    const uncharged = ready(planPlayerAttackFromRuntime(withCape(28947)));

    expect(charged.hits[0].accuracy).not.toEqual(uncharged.hits[0].accuracy);
    expect(uncharged.hits[0].accuracy).toEqual(
      ready(planPlayerAttackFromRuntime(withCape(undefined))).hits[0].accuracy,
    );
  });

  it('requires a complete matching Void set', () => {
    const input = runtimeInput({
      player: {
        ...runtimeInput().player,
        equipment: { weapon: 20997, head: 11664, body: 8839, legs: 8840 },
        equipmentStats: equipment({ attackRanged: 60, rangedStrength: 100 }),
        selectedAttackStyleIndex: 0,
      },
      formulaStyle: 'ranged',
      resources: { kind: 'ammo', source: 'equipped', ammoId: 11212 },
      delivery: { style: 'range', attackKind: 'range_arrow', impactDelayTicks: 2 },
      lookupItemStats: () => createEmptyStats(),
    });

    const plan = planPlayerAttackFromRuntime(input);

    expect(plan).toEqual(
      directPlan({
        input,
        attacker: {
          kind: 'player',
          levels: { attack: 99, strength: 99, defence: 99, ranged: 99, magic: 99 },
          stance: 'Accurate',
          voidSet: 'none',
        },
        target: BASE_TARGET,
        equipmentStats: input.player.equipmentStats,
      }),
    );
  });

  it('fails closed without NPC formula stats', () => {
    const input = runtimeInput({ target: { npcTypeId: 1234 } });

    const plan = planPlayerAttackFromRuntime(input);

    expect(plan).toBeNull();
  });

  it('fails closed for an unknown fixed spell', () => {
    const input = runtimeInput({
      formulaStyle: 'magic',
      resources: { kind: 'spell', source: 'none', spellId: 'Unknown Spell' },
      delivery: { style: 'magic', attackKind: 'magic_fire', impactDelayTicks: 4 },
    });

    const plan = planPlayerAttackFromRuntime(input);

    expect(plan).toBeNull();
  });

  it('fails closed for an unrecognized powered staff', () => {
    const input = runtimeInput({
      formulaStyle: 'magic',
      delivery: { style: 'magic', attackKind: 'magic_fire', impactDelayTicks: 4 },
    });

    const plan = planPlayerAttackFromRuntime(input);

    expect(plan).toBeNull();
  });
});

describe('offensive prayer multipliers', () => {
  const boostFor = (prayer: PrayerType) => lookupPrayerMultipliersFromState(null, [prayer]);

  it('boosts attack by 25%, strength by 28% and defence by 25% under Zeal', () => {
    expect(boostFor(PrayerType.Zeal)).toEqual({
      ...DEFAULT_PRAYER_MULTIPLIERS,
      attack: 1.25,
      strength: 1.28,
      defence: 1.25,
    });
  });

  it('boosts ranged attack and strength by 15% under Eagle Eye', () => {
    expect(boostFor(PrayerType.EagleEye)).toEqual({
      ...DEFAULT_PRAYER_MULTIPLIERS,
      ranged: 1.15,
      rangedStrength: 1.15,
    });
  });

  it('boosts magic by 15% and magic damage by 2% under Mystic Might', () => {
    expect(boostFor(PrayerType.MysticMight)).toEqual({
      ...DEFAULT_PRAYER_MULTIPLIERS,
      magic: 1.15,
      magicDamage: 1.02,
    });
  });

  it('boosts ranged by 18% and defence by 5% under Deadeye', () => {
    expect(boostFor(PrayerType.Deadeye)).toEqual({
      ...DEFAULT_PRAYER_MULTIPLIERS,
      ranged: 1.18,
      rangedStrength: 1.18,
      defence: 1.05,
    });
  });

  it('boosts magic by 18%, magic damage by 3% and defence by 5% under Mystic Vigour', () => {
    expect(boostFor(PrayerType.MysticVigour)).toEqual({
      ...DEFAULT_PRAYER_MULTIPLIERS,
      magic: 1.18,
      magicDamage: 1.03,
      defence: 1.05,
    });
  });

  it.each(WIKI_TIERED_PRAYER_ROWS)('applies the wiki boost of $prayer and nothing else', ({ prayer, boost }) => {
    expect(boostFor(prayer)).toEqual({ ...DEFAULT_PRAYER_MULTIPLIERS, ...boost });
  });

  it('combines the three single-stat rows, each on its own stat', () => {
    expect(
      lookupPrayerMultipliersFromState(null, [
        PrayerType.SteelSkin,
        PrayerType.UltimateStrength,
        PrayerType.IncredibleReflexes,
      ]),
    ).toEqual({ ...DEFAULT_PRAYER_MULTIPLIERS, attack: 1.15, strength: 1.15, defence: 1.15 });
  });

  // "The defence boost with multiple prayers is additive" (https://oldschool.runescape.wiki/w/Deadeye?oldid=15222979).
  it.each([
    [PrayerType.Deadeye, PrayerType.ThickSkin, 1.1],
    [PrayerType.Deadeye, PrayerType.SteelSkin, 1.2],
    [PrayerType.MysticVigour, PrayerType.RockSkin, 1.15],
  ])('adds the Defence boosts of %s and %s to %d', (upgrade, skin, defence) => {
    const multipliers = lookupPrayerMultipliersFromState(PrayerType.ProtectMelee, [skin, upgrade]);
    // toBe, not toBeCloseTo: the formulas floor `level * multiplier`, so the sum must be the very
    // double the literal is.
    expect(multipliers.defence).toBe(defence);
  });
});

/**
 * Each tiered prayer and Chivalry through the whole player-attack path, with 99s everywhere.
 *
 * Wiki formulas (https://oldschool.runescape.wiki/w/Damage_per_second/Melee, /Ranged, /Magic):
 * effective level = floor(99 × prayer) + stance + 8; attack roll = effective × (bonus + 64);
 * melee and ranged max hit = floor((effective strength × (strength bonus + 64) + 320) / 640);
 * magic max hit = floor(base × (1 + magic damage)).
 * - melee: scimitar Accurate (+3 Attack, +0 Strength), slash +80, strength +120
 * - ranged: Accurate (+3 both), ranged attack +60, ranged strength +100
 * - magic: Casting (+0), magic attack +70, a 100 base max hit and no gear damage
 *
 * Unprayed: melee 110 × 144 = 15840 and floor((107 × 184 + 320) / 640) = 31; ranged 110 × 124 =
 * 13640 and floor((110 × 164 + 320) / 640) = 28; magic 107 × 134 = 14338 and 100.
 */
const UNPRAYED_ATTACKS = {
  meleeRoll: 15840,
  meleeMax: 31,
  rangedRoll: 13640,
  rangedMax: 28,
  magicRoll: 14338,
  magicMax: 100,
} as const;

const PRAYED_ATTACKS: Record<WikiTieredPrayer, Partial<Record<keyof typeof UNPRAYED_ATTACKS, number>>> = {
  [PrayerType.ThickSkin]: {},
  [PrayerType.RockSkin]: {},
  [PrayerType.SteelSkin]: {},
  // floor(99 × 1.05) = 103, floor(99 × 1.1) = 108, floor(99 × 1.15) = 113: max hits from 111, 116, 121.
  [PrayerType.BurstOfStrength]: { meleeMax: 32 },
  [PrayerType.SuperhumanStrength]: { meleeMax: 33 },
  [PrayerType.UltimateStrength]: { meleeMax: 35 },
  // (103 + 11) × 144, (108 + 11) × 144, (113 + 11) × 144
  [PrayerType.ClarityOfThought]: { meleeRoll: 16416 },
  [PrayerType.ImprovedReflexes]: { meleeRoll: 17136 },
  [PrayerType.IncredibleReflexes]: { meleeRoll: 17856 },
  // (103 + 11) × 124 = 14136, floor((114 × 164 + 320) / 640) = 29; (108 + 11) × 124 = 14756, 30
  [PrayerType.SharpEye]: { rangedRoll: 14136, rangedMax: 29 },
  [PrayerType.HawkEye]: { rangedRoll: 14756, rangedMax: 30 },
  // (103 + 8) × 134 = 14874; (108 + 8) × 134 = 15544 and floor(100 × 1.01) = 101
  [PrayerType.MysticWill]: { magicRoll: 14874 },
  [PrayerType.MysticLore]: { magicRoll: 15544, magicMax: 101 },
  // Attack (113 + 11) × 144 = 17856; Strength floor(99 × 1.18) = 116, floor((124 × 184 + 320) / 640) = 36
  [PrayerType.Chivalry]: { meleeRoll: 17856, meleeMax: 36 },
};

describe('tiered prayers and Chivalry in player attacks', () => {
  const NO_GEAR_DAMAGE = { outgoingDamageMultiplier: 1, specialAttackDamageMultiplier: 1 };

  function attacksWith(boostPrayers: PrayerType[]): Record<keyof typeof UNPRAYED_ATTACKS, number> {
    const base = runtimeInput({ application: NO_GEAR_DAMAGE });
    const diagnostics = (input: PlayerAttackRuntimeInput) => {
      const plan = ready(planPlayerAttackFromRuntime(input));
      if (plan.diagnostics === undefined) throw new TypeError('Expected plan diagnostics');
      return plan.diagnostics;
    };
    const melee = diagnostics({ ...base, player: { ...base.player, boostPrayers } });
    const ranged = diagnostics({
      ...base,
      player: {
        ...base.player,
        equipment: { weapon: 25888 },
        equipmentStats: equipment({ attackRanged: 60, rangedStrength: 100, attackSpeed: 4, attackRange: 10 }),
        boostPrayers,
      },
      formulaStyle: 'ranged',
      delivery: { style: 'range', attackKind: 'range_arrow', impactDelayTicks: 3 },
    });
    const magic = diagnostics({
      ...base,
      player: {
        ...base.player,
        equipment: { weapon: 4675 },
        equipmentStats: equipment({ attackMagic: 70, attackSpeed: 5, attackRange: 10 }),
        selectedAttackStyleIndex: 3,
        boostPrayers,
      },
      formulaStyle: 'magic',
      resources: { kind: 'spell', source: 'none', spellId: 'Ice Barrage' },
      magicBaseMaxHitOverride: 100,
      delivery: { style: 'magic', attackKind: 'magic_fire', impactDelayTicks: 4 },
    });
    return {
      meleeRoll: melee.baseAttackRoll,
      meleeMax: melee.baseMaxHit,
      rangedRoll: ranged.baseAttackRoll,
      rangedMax: ranged.baseMaxHit,
      magicRoll: magic.baseAttackRoll,
      magicMax: magic.baseMaxHit,
    };
  }

  it('starts from the unprayed numbers the wiki formulas give', () => {
    expect(attacksWith([])).toEqual(UNPRAYED_ATTACKS);
  });

  it.each(WIKI_TIERED_PRAYER_ROWS)('changes exactly the attack numbers $prayer boosts', ({ prayer }) => {
    expect(attacksWith([prayer])).toEqual({ ...UNPRAYED_ATTACKS, ...PRAYED_ATTACKS[prayer] });
  });
});
