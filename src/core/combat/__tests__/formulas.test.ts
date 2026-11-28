import { describe, expect, it } from 'vitest';
import { createEmptyStats, type EquipmentStats } from '../../../types/equipmentStats';
import {
  calculateAccuracy,
  calculateMaxHit,
  calculatePlayerNpcRollDetails,
  doubleRollHitChance,
  hitChance,
  type NpcFormulaActor,
  type PlayerFormulaActor,
  type PrayerMultipliers,
  steadyStateHitChance,
} from '../formulas';

const NO_PRAYERS: PrayerMultipliers = {
  attack: 1,
  strength: 1,
  defence: 1,
  ranged: 1,
  rangedStrength: 1,
  magic: 1,
  magicDamage: 1,
};

const OFFENSIVE_PRAYERS: PrayerMultipliers = {
  attack: 1.2,
  strength: 1.23,
  defence: 1.25,
  ranged: 1.2,
  rangedStrength: 1.23,
  magic: 1.25,
  magicDamage: 1.04,
};

const PLAYER_LEVELS = {
  attack: 99,
  strength: 99,
  defence: 99,
  ranged: 99,
  magic: 99,
};

const NPC_DEFENDER: NpcFormulaActor = {
  kind: 'npc',
  levels: { attack: 1, strength: 1, defence: 80, ranged: 1, magic: 80 },
  offensive: { atk: 0, str: 0, ranged: 0, rangedStr: 0, magic: 0, magicStr: 0 },
  defensive: { stab: 36, slash: 20, crush: 36, rangedLight: 36, rangedStandard: 36, rangedHeavy: 36, magic: 36 },
};

function equipment(overrides: Partial<EquipmentStats>): EquipmentStats {
  return { ...createEmptyStats(), ...overrides };
}

describe('hit chance', () => {
  it('uses the A greater than D branch only when attack is strictly greater', () => {
    expect(hitChance(100, 50)).toBe(1 - 52 / (2 * 101));
    expect(hitChance(50, 50)).toBe(50 / (2 * 51));
  });

  it('uses the shared-defence double-roll formula on both branches', () => {
    expect(doubleRollHitChance(100, 50)).toBe(1 - (52 * 103) / (6 * 101 * 101));
    expect(doubleRollHitChance(20, 50)).toBe((20 * 85) / (6 * 21 * 51));
  });

  it.each([
    { singleRoll: 0, doubleRoll: 0, expected: 0 },
    { singleRoll: 1, doubleRoll: 1, expected: 1 },
    { singleRoll: 1, doubleRoll: 0, expected: 1 },
  ])('returns $expected steady-state accuracy at single=$singleRoll and double=$doubleRoll', ({
    singleRoll,
    doubleRoll,
    expected,
  }) => {
    expect(steadyStateHitChance(singleRoll, doubleRoll)).toBe(expected);
  });

  it('weights single and double rolls by the Confliction pending-state equilibrium', () => {
    const singleRoll = 0.4;
    const doubleRoll = 0.7;
    const pendingProbability = (1 - singleRoll) / (doubleRoll + 1 - singleRoll);

    expect(steadyStateHitChance(singleRoll, doubleRoll)).toBe(
      (1 - pendingProbability) * singleRoll + pendingProbability * doubleRoll,
    );
  });
});

describe('player melee formulas', () => {
  it('exposes the exact player attack roll, NPC defence roll, and chance', () => {
    const equipmentStats = equipment({ attackSlash: 100 });
    const attacker: PlayerFormulaActor = {
      kind: 'player',
      levels: PLAYER_LEVELS,
      stance: 'Controlled',
      voidSet: 'melee',
    };
    const details = calculatePlayerNpcRollDetails(
      attacker,
      NPC_DEFENDER,
      'melee_slash',
      equipmentStats,
      OFFENSIVE_PRAYERS,
    );

    expect(details).toEqual({
      attackRoll: 139 * 164,
      defenceRoll: 89 * 84,
      chance: hitChance(139 * 164, 89 * 84),
    });
  });

  it('floors prayer before stance and applies melee Void after the plus eight', () => {
    const equipmentStats = equipment({ attackSlash: 100, meleeStrength: 100 });
    const attacker: PlayerFormulaActor = {
      kind: 'player',
      levels: PLAYER_LEVELS,
      stance: 'Controlled',
      voidSet: 'melee',
    };

    expect(
      calculatePlayerNpcRollDetails(attacker, NPC_DEFENDER, 'melee_slash', equipmentStats, OFFENSIVE_PRAYERS).chance,
    ).toBe(hitChance(139 * 164, 89 * 84));
    expect(calculateMaxHit(attacker, 'melee_slash', equipmentStats, OFFENSIVE_PRAYERS)).toBe(37);
  });

  // floor(level × prayer) where the product is a whole number: in floating point 100 × 1.15 is
  // 114.99999999999999, one level short of the wiki's 115. Same for 180 and 200.
  it.each([100, 180, 200])('floors a 15 percent prayer at level %i to the exact whole level', (level) => {
    const levels = { attack: level, strength: level, defence: level, ranged: level, magic: level };
    const attacker: PlayerFormulaActor = { kind: 'player', levels, stance: 'Other', voidSet: 'none' };
    const fifteen: PrayerMultipliers = {
      attack: 1.15,
      strength: 1.15,
      defence: 1.15,
      ranged: 1.15,
      rangedStrength: 1.15,
      magic: 1.15,
      magicDamage: 1,
    };
    const prayed = (level * 115) / 100;
    const none = equipment({});

    expect(calculatePlayerNpcRollDetails(attacker, NPC_DEFENDER, 'melee_slash', none, fifteen).attackRoll).toBe(
      (prayed + 8) * 64,
    );
    expect(calculatePlayerNpcRollDetails(attacker, NPC_DEFENDER, 'ranged', none, fifteen).attackRoll).toBe(
      (prayed + 8) * 64,
    );
    expect(calculatePlayerNpcRollDetails(attacker, NPC_DEFENDER, 'magic', none, fifteen).attackRoll).toBe(
      (prayed + 8) * 64,
    );
    expect(calculateMaxHit(attacker, 'melee_slash', none, fifteen)).toBe(Math.floor(((prayed + 8) * 64 + 320) / 640));
    expect(calculateMaxHit(attacker, 'ranged', none, fifteen)).toBe(Math.floor(((prayed + 8) * 64 + 320) / 640));
    const npcAttacker: NpcFormulaActor = { ...NPC_DEFENDER, levels: { ...NPC_DEFENDER.levels, attack: 300 } };
    expect(calculateAccuracy(npcAttacker, attacker, 'melee_slash', none, fifteen)).toBe(
      hitChance(309 * 64, (prayed + 8) * 64),
    );
  });

  it('keeps an explicit non-Void actor on the ordinary melee stages', () => {
    const attacker: PlayerFormulaActor = {
      kind: 'player',
      levels: PLAYER_LEVELS,
      stance: 'Controlled',
      voidSet: 'none',
    };

    expect(calculateMaxHit(attacker, 'melee_stab', equipment({ meleeStrength: 100 }), OFFENSIVE_PRAYERS)).toBe(33);
  });
});

describe('player ranged formulas', () => {
  const equipmentStats = equipment({ attackRanged: 36, rangedStrength: 100 });

  it('applies regular Void to ranged accuracy and strength', () => {
    const attacker: PlayerFormulaActor = {
      kind: 'player',
      levels: PLAYER_LEVELS,
      stance: 'Accurate',
      voidSet: 'ranged',
    };

    expect(
      calculatePlayerNpcRollDetails(attacker, NPC_DEFENDER, 'ranged', equipmentStats, OFFENSIVE_PRAYERS).chance,
    ).toBe(hitChance(141 * 100, 89 * 100));
    expect(calculateMaxHit(attacker, 'ranged', equipmentStats, OFFENSIVE_PRAYERS)).toBe(37);
  });

  it('improves only ranged strength for elite Void', () => {
    const regular: PlayerFormulaActor = {
      kind: 'player',
      levels: PLAYER_LEVELS,
      stance: 'Accurate',
      voidSet: 'ranged',
    };
    const elite: PlayerFormulaActor = { ...regular, voidSet: 'elite_ranged' };

    expect(calculatePlayerNpcRollDetails(elite, NPC_DEFENDER, 'ranged', equipmentStats, OFFENSIVE_PRAYERS).chance).toBe(
      calculatePlayerNpcRollDetails(regular, NPC_DEFENDER, 'ranged', equipmentStats, OFFENSIVE_PRAYERS).chance,
    );
    expect(calculateMaxHit(elite, 'ranged', equipmentStats, OFFENSIVE_PRAYERS)).toBe(38);
  });

  it('rolls NPC defence against the requested ranged defence bonus, standard by default', () => {
    const attacker: PlayerFormulaActor = { kind: 'player', levels: PLAYER_LEVELS, stance: 'Accurate' };
    const target: NpcFormulaActor = {
      ...NPC_DEFENDER,
      defensive: { ...NPC_DEFENDER.defensive, rangedLight: 10, rangedStandard: 25, rangedHeavy: 30 },
    };
    const defenceRoll = (type?: 'light' | 'standard' | 'heavy') =>
      calculatePlayerNpcRollDetails(attacker, target, 'ranged', equipmentStats, NO_PRAYERS, 'ranged', type).defenceRoll;

    expect(defenceRoll('light')).toBe(89 * (10 + 64));
    expect(defenceRoll('standard')).toBe(89 * (25 + 64));
    expect(defenceRoll('heavy')).toBe(89 * (30 + 64));
    expect(defenceRoll()).toBe(89 * (25 + 64));
    // A fixed melee defence style (slash 20) ignores the ranged type entirely.
    expect(
      calculatePlayerNpcRollDetails(attacker, target, 'ranged', equipmentStats, NO_PRAYERS, 'melee_slash', 'heavy')
        .defenceRoll,
    ).toBe(89 * (20 + 64));
  });
});

describe('player magic formulas', () => {
  const accuracyEquipment = equipment({ attackMagic: 36 });

  it('gives ordinary spellcasting no style bonus and adds eight', () => {
    const attacker: PlayerFormulaActor = {
      kind: 'player',
      levels: PLAYER_LEVELS,
      stance: 'Casting',
    };

    expect(
      calculatePlayerNpcRollDetails(attacker, NPC_DEFENDER, 'magic', accuracyEquipment, OFFENSIVE_PRAYERS).chance,
    ).toBe(hitChance(131 * 100, 89 * 100));
  });

  it('applies powered-staff Accurate and Longrange style bonuses', () => {
    const accurate: PlayerFormulaActor = {
      kind: 'player',
      levels: PLAYER_LEVELS,
      stance: 'Accurate',
    };
    const longrange: PlayerFormulaActor = { ...accurate, stance: 'Longrange' };

    expect(
      calculatePlayerNpcRollDetails(accurate, NPC_DEFENDER, 'magic', accuracyEquipment, OFFENSIVE_PRAYERS).chance,
    ).toBe(hitChance(134 * 100, 89 * 100));
    expect(
      calculatePlayerNpcRollDetails(longrange, NPC_DEFENDER, 'magic', accuracyEquipment, OFFENSIVE_PRAYERS).chance,
    ).toBe(hitChance(132 * 100, 89 * 100));
  });

  it('applies the same magic accuracy multiplier to regular and elite magic Void', () => {
    const regular: PlayerFormulaActor = {
      kind: 'player',
      levels: PLAYER_LEVELS,
      stance: 'Casting',
      voidSet: 'magic',
    };
    const elite: PlayerFormulaActor = { ...regular, voidSet: 'elite_magic' };
    const expected = hitChance(186 * 100, 89 * 100);

    expect(
      calculatePlayerNpcRollDetails(regular, NPC_DEFENDER, 'magic', accuracyEquipment, OFFENSIVE_PRAYERS).chance,
    ).toBe(expected);
    expect(
      calculatePlayerNpcRollDetails(elite, NPC_DEFENDER, 'magic', accuracyEquipment, OFFENSIVE_PRAYERS).chance,
    ).toBe(expected);
  });

  it('combines equipment, prayer, and elite magic Void damage before one final floor', () => {
    const regular: PlayerFormulaActor = {
      kind: 'player',
      levels: PLAYER_LEVELS,
      stance: 'Casting',
      voidSet: 'magic',
      magicBaseMaxHit: 29,
    };
    const elite: PlayerFormulaActor = { ...regular, voidSet: 'elite_magic' };
    const equipmentStats = equipment({ magicDamage: 20 });

    expect(calculateMaxHit(regular, 'magic', equipmentStats, OFFENSIVE_PRAYERS)).toBe(35);
    expect(calculateMaxHit(elite, 'magic', equipmentStats, OFFENSIVE_PRAYERS)).toBe(37);
  });

  // floor(base × (1 + gear + prayer)) (https://oldschool.runescape.wiki/w/Damage_per_second/Magic):
  // each of these sums to a whole hit that the floating product lands just under.
  it.each([
    { base: 25, gearPercent: 15, prayerDamage: 1.01, maxHit: 29 },
    { base: 25, gearPercent: 16, prayerDamage: 1, maxHit: 29 },
    { base: 50, gearPercent: 13, prayerDamage: 1.01, maxHit: 57 },
    { base: 45, gearPercent: 38, prayerDamage: 1.02, maxHit: 63 },
  ])('floors base $base with $gearPercent% gear and prayer damage $prayerDamage to exactly $maxHit', ({
    base,
    gearPercent,
    prayerDamage,
    maxHit,
  }) => {
    const caster: PlayerFormulaActor = {
      kind: 'player',
      levels: PLAYER_LEVELS,
      stance: 'Casting',
      magicBaseMaxHit: base,
    };
    const prayers = { ...NO_PRAYERS, magicDamage: prayerDamage };

    expect(calculateMaxHit(caster, 'magic', equipment({ magicDamage: gearPercent }), prayers)).toBe(maxHit);
  });
});

describe('NPC formulas', () => {
  const attacker: NpcFormulaActor = {
    kind: 'npc',
    id: 931,
    levels: { attack: 100, strength: 100, defence: 70, ranged: 90, magic: 100 },
    offensive: { atk: 36, str: 36, ranged: 100, rangedStr: 40, magic: 60, magicStr: 44 },
    defensive: { stab: 0, slash: 0, crush: 0, rangedLight: 0, rangedStandard: 0, rangedHeavy: 0, magic: 0 },
    maxHit: 999,
  };

  it('resolves NPC-vs-player accuracy without ID-based guaranteed hits', () => {
    const target: PlayerFormulaActor = {
      kind: 'player',
      levels: PLAYER_LEVELS,
      stance: 'Defensive',
    };

    expect(calculateAccuracy(attacker, target, 'ranged', equipment({ defenceRanged: 36 }), OFFENSIVE_PRAYERS)).toBe(
      hitChance(99 * 164, 134 * 100),
    );
  });

  it('uses the target Magic level for NPC-vs-NPC magic defence', () => {
    expect(calculateAccuracy(attacker, NPC_DEFENDER, 'magic', createEmptyStats(), NO_PRAYERS)).toBe(
      hitChance(109 * 124, 89 * 100),
    );
  });

  it('derives NPC max hits from levels and offensive strength bonuses', () => {
    expect(calculateMaxHit(attacker, 'melee_crush', createEmptyStats(), NO_PRAYERS)).toBe(17);
    expect(calculateMaxHit(attacker, 'ranged', createEmptyStats(), NO_PRAYERS)).toBe(16);
    expect(calculateMaxHit(attacker, 'magic', createEmptyStats(), NO_PRAYERS)).toBe(18);
  });
});
