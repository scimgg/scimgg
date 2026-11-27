import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollisionFlag } from '../../../rs/collision/CollisionFlag';
import { WIKI_TIERED_PRAYER_ROWS, type WikiTieredPrayer } from '../../../types/__tests__/fixtures/wikiPrayerTable';
import { createEmptyStats } from '../../../types/equipmentStats';
import { PrayerType } from '../../../types/simulation';
import type { NpcActor } from '../../actors/NpcActor';
import type { PlayerActor } from '../../actors/PlayerActor';
import type { NpcFormulaStats } from '../../actors/types';
import { setArenaConfig } from '../../constants';
import { hitChance, playerDefenceRoll } from '../accuracy';
import { isFootprintInAttackRange } from '../distance';
import { DEFAULT_PRAYER_MULTIPLIERS } from '../formulaTypes';
import {
  type AttackPlan,
  canNpcAttack,
  hasNpcAttackReach,
  isNpcInMeleeRange,
  npcFormulaActor,
  playerFormulaActor,
  projectileDistance,
  resolveAttackRequest,
  selectNpcAttack,
} from '../npcAttackRequest';

const FORMULA_STATS: NpcFormulaStats = {
  levels: { attack: 100, strength: 100, defence: 100, ranged: 100, magic: 100 },
  offensive: { atk: 100, str: 100, ranged: 100, rangedStr: 100, magic: 100, magicStr: 100 },
  defensive: { stab: 80, slash: 80, crush: 80, rangedLight: 80, rangedStandard: 80, rangedHeavy: 80, magic: 80 },
};

const MELEE_PLAN = {
  formulaStyle: 'melee_crush',
  damageType: 'melee',
  attackKind: 'melee_crush',
  impactDelayTicks: 0,
  sourceDeathPolicy: 'cancel-before-impact',
} as const satisfies AttackPlan;
const RANGE_PLAN = {
  formulaStyle: 'ranged',
  damageType: 'range',
  attackKind: 'range_arrow',
  impactDelayTicks: 1,
  sourceDeathPolicy: 'cancel-before-impact',
} as const satisfies AttackPlan;

describe('NPC melee reach and weighted selection', () => {
  afterEach(() => setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true));

  it('keeps reach and action readiness while suppressing selection after turn-start overlap', () => {
    const attacker = makeNpc('attacker');
    const target = makeNpc('target');
    target.position = [11, 10];
    attacker.combat.startedTurnOverlappingTarget = true;
    const random = vi.fn(() => 0);

    const selected = selectNpcAttack({
      attacker,
      target,
      choices: [
        { plan: MELEE_PLAN, weight: 1 },
        { plan: RANGE_PLAN, weight: 1 },
      ],
      random,
      tick: 0,
    });

    expect(selected).toBeNull();
    expect(random).not.toHaveBeenCalled();
    expect(hasNpcAttackReach(attacker, target, 1)).toBe(true);
    expect(attacker.combat.nextActionTick).toBe(0);
  });

  it.each([1, 3, 4])('opts a size %s NPC into diagonal melee without changing default reach', (size) => {
    const attacker = makeNpc('attacker');
    attacker.size = size;
    const target = makeNpc('target');
    target.position = [10 + size, 10 + size];
    expect(canNpcAttack(attacker, target, MELEE_PLAN)).toBe(false);
    attacker.combat.meleeReach = 'diagonal';
    expect(canNpcAttack(attacker, target, MELEE_PLAN)).toBe(true);
    target.position = [11 + size, 11 + size];
    expect(canNpcAttack(attacker, target, MELEE_PLAN)).toBe(false);
    target.position = [10, 10];
    expect(canNpcAttack(attacker, target, MELEE_PLAN)).toBe(false);
  });

  it.each([0, 0.249999, 0.25, 0.999999])('selects eligible profiles by their supplied weights at draw %s', (draw) => {
    const attacker = makeNpc('attacker');
    const target = makeNpc('target');
    target.position = [11, 10];
    const choices = [
      { plan: MELEE_PLAN, weight: 1, name: 'punch' },
      { plan: RANGE_PLAN, weight: 3, name: 'shot' },
    ];
    const random = vi.fn(() => draw);
    expect(selectNpcAttack({ attacker, target, choices, random, tick: 0 })?.name).toBe(draw < 0.25 ? 'punch' : 'shot');
    expect(random).toHaveBeenCalledOnce();
  });

  it('does not draw randomness for zero or one eligible profile', () => {
    const attacker = makeNpc('attacker');
    const target = makeNpc('target');
    const choices = [
      { plan: MELEE_PLAN, weight: 1 },
      { plan: RANGE_PLAN, weight: 1 },
    ];
    const random = vi.fn(() => 0);
    target.position = [13, 10];
    expect(selectNpcAttack({ attacker, target, choices, random, tick: 0 })).toBe(choices[1]);
    target.position = [30, 30];
    expect(selectNpcAttack({ attacker, target, choices, random, tick: 0 })).toBeNull();
    target.position = [11, 10];
    target.alive = false;
    expect(selectNpcAttack({ attacker, target, choices, random, tick: 0 })).toBeNull();
    expect(random).not.toHaveBeenCalled();
  });

  it('excludes disabled choices and dead attackers without consuming RNG', () => {
    const attacker = makeNpc('attacker');
    const target = makeNpc('target');
    target.position = [11, 10];
    const choices = [
      { plan: MELEE_PLAN, weight: 0 },
      { plan: RANGE_PLAN, weight: 1 },
    ];
    const random = vi.fn(() => 0);
    expect(selectNpcAttack({ attacker, target, choices, random, tick: 0 })).toBe(choices[1]);
    attacker.alive = false;
    expect(selectNpcAttack({ attacker, target, choices, random, tick: 0 })).toBeNull();
    expect(random).not.toHaveBeenCalled();
  });
});

function makeNpc(id: string): NpcActor {
  return {
    id,
    kind: 'npc',
    alive: true,
    position: [10, 10],
    previousPosition: [10, 10],
    facing: 0,
    size: 1,
    vitals: { hp: 100, maxHp: 100 },
    npcTypeId: 1,
    archetypeId: 'test',
    history: new Map(),
    combat: {
      attackSpeed: 4,
      attackRange: 6,
      attackStyle: 'range',
      nextActionTick: 0,
      lastAttackTick: null,
      targetId: null,
      animations: { idle: null, walk: null, run: null, attack: null, death: null },
    },
    formulaStats: FORMULA_STATS,
  };
}

const TWISTED_BOW = 20997; // bow: Accurate / Rapid / Longrange
const ZAMORAKIAN_SPEAR = 11824; // spear: Lunge / Swipe / Pound (Controlled) then Block (Defensive)

function makeStancePlayer(
  weapon: number,
  selectedAttackStyleIndex: number,
): Pick<PlayerActor, 'stats' | 'equipment' | 'selectedAttackStyleIndex'> {
  const level99 = { current: 99, max: 99 };
  return {
    stats: {
      attack: { ...level99 },
      strength: { ...level99 },
      defence: { ...level99 },
      ranged: { ...level99 },
      magic: { ...level99 },
      prayer: { ...level99 },
      hitpoints: { ...level99 },
      agility: { ...level99 },
    },
    equipment: { weapon },
    selectedAttackStyleIndex,
  };
}

describe('NPC attack request assembly', () => {
  it('adapts NPC and player actor stats for combat formulas', () => {
    const npc = makeNpc('attacker');
    npc.npcTypeId = 42;
    const player: Pick<PlayerActor, 'stats' | 'equipment' | 'selectedAttackStyleIndex'> = {
      stats: {
        attack: { current: 91, max: 99 },
        strength: { current: 92, max: 99 },
        defence: { current: 93, max: 99 },
        ranged: { current: 94, max: 99 },
        magic: { current: 95, max: 99 },
        prayer: { current: 96, max: 99 },
        hitpoints: { current: 97, max: 99 },
        agility: { current: 99, max: 99 },
      },
      equipment: { weapon: TWISTED_BOW },
      selectedAttackStyleIndex: 1,
    };

    const formulaNpc = npcFormulaActor(npc);
    const formulaPlayer = playerFormulaActor(player);

    expect(formulaNpc).toEqual({ kind: 'npc', id: 42, ...FORMULA_STATS });
    expect(formulaPlayer).toEqual({
      kind: 'player',
      levels: { attack: 91, strength: 92, defence: 93, ranged: 94, magic: 95 },
      stance: 'Other',
    });
  });

  // OSRS Wiki, Damage per second/Melee § Steps five and six: a player's defence roll is
  // effective Defence × (style defence bonus + 64), with effective Defence = floor(level × prayer)
  // + 3 Defensive / + 1 Controlled, + 8; Longrange also gives +3 Defence (/w/Combat_Options). With
  // 99 Defence and no worn defence: (99 + 0 + 8) × 64 = 6848 on Rapid, (99 + 3 + 8) × 64 = 7040
  // on Longrange.
  it.each([
    { label: 'Rapid', weapon: TWISTED_BOW, index: 1, stance: 'Other', styleBonus: 0 },
    { label: 'Longrange', weapon: TWISTED_BOW, index: 2, stance: 'Longrange', styleBonus: 3 },
    { label: 'Controlled', weapon: ZAMORAKIAN_SPEAR, index: 0, stance: 'Controlled', styleBonus: 1 },
    { label: 'Defensive', weapon: ZAMORAKIAN_SPEAR, index: 3, stance: 'Defensive', styleBonus: 3 },
  ])('takes the defence style bonus from the selected combat option ($label)', (testCase) => {
    const formulaPlayer = playerFormulaActor(makeStancePlayer(testCase.weapon, testCase.index));

    expect(formulaPlayer.stance).toBe(testCase.stance);
    expect(playerDefenceRoll(formulaPlayer, 'ranged', createEmptyStats(), DEFAULT_PRAYER_MULTIPLIERS)).toBe(
      (99 + testCase.styleBonus + 8) * 64,
    );
  });

  it('clamps an out-of-range style index instead of losing the defence bonus', () => {
    // Longrange is the last bow option, so an index past the end must still land on it.
    expect(playerFormulaActor(makeStancePlayer(TWISTED_BOW, 9)).stance).toBe('Longrange');
  });

  // Shadow spells drain the stat the NPC ATTACKS with, so the drain has to reach the projection
  // the NPC's own accuracy roll is built from. Storing it on `debuffs` alone would leave the
  // drain as bookkeeping that never changes a hit.
  it('subtracts an Attack drain from the stats an NPC attacks with, flooring at zero', () => {
    const drainedAttack = (attackDrain: number): number | undefined => {
      const npc = makeNpc('attacker');
      npc.debuffs = { attackDrain };
      return npcFormulaActor(npc)?.levels.attack;
    };

    expect(drainedAttack(0)).toBe(100);
    expect(drainedAttack(15)).toBe(85);
    expect(drainedAttack(250)).toBe(0);
  });

  it('measures projectile distance from the attacker center to the target base tile', () => {
    const attacker = makeNpc('attacker');
    attacker.position = [10, 10];
    attacker.size = 3;
    const target = makeNpc('target');
    target.position = [15, 14];
    target.size = 2;

    // The attacker contributes its center (11, 11) and the target its BASE tile,
    // so the Chebyshev distance is max(|11-15|, |11-14|) = 4, not the 5 a center-to-center
    // reading gives. Packet-proven by Jal-Zek's 16 glyph casts — see `projectileDistance`.
    expect(projectileDistance(attacker, target)).toBe(4);
  });

  it('assembles an NPC request with the encounter-supplied attack kind and projectile delay', () => {
    const attacker = makeNpc('attacker');
    attacker.position = [10, 10];
    attacker.size = 3;
    const target = makeNpc('target');
    target.position = [15, 14];
    target.size = 2;
    const plan: AttackPlan = {
      formulaStyle: 'ranged',
      damageType: 'range',
      attackKind: 'range_shadow',
      impactDelayTicks: 99,
      sourceDeathPolicy: 'cancel-before-impact',
      projectile: { delay: 28, lengthAdjustment: 0, stepMultiplier: 8, progress: 32 },
      maxHit: 10,
    };
    const samples = [0, 0.999999];
    let sampleIndex = 0;

    const request = resolveAttackRequest({
      attacker,
      target,
      plan,
      random: () => samples[sampleIndex++] ?? 0,
    });

    expect(request).toEqual({
      attackerId: 'attacker',
      targetId: 'target',
      style: 'range',
      attackKind: 'range_shadow',
      rolledDamage: 10,
      accuracySucceeded: true,
      impactDelayTicks: 2,
      sourceDeathPolicy: 'cancel-before-impact',
    });
    expect(sampleIndex).toBe(2);
  });

  it('does not consume RNG when the attacker lacks formula stats', () => {
    const attacker = makeNpc('attacker');
    attacker.formulaStats = undefined;
    const random = vi.fn(() => 0);
    const plan: AttackPlan = {
      formulaStyle: 'melee_crush',
      damageType: 'melee',
      attackKind: 'melee_crush',
      impactDelayTicks: 0,
      sourceDeathPolicy: 'cancel-before-impact',
    };

    const request = resolveAttackRequest({ attacker, target: makeNpc('target'), plan, random });

    expect(request).toBeNull();
    expect(random).not.toHaveBeenCalled();
  });

  it('uses plan range for attacks and fixed one-tile reach for melee proximity', () => {
    const attacker = makeNpc('attacker');
    const target = makeNpc('target');
    target.position = [13, 10];
    const plan: AttackPlan = {
      formulaStyle: 'ranged',
      damageType: 'range',
      attackKind: 'range_arrow',
      impactDelayTicks: 3,
      sourceDeathPolicy: 'cancel-before-impact',
    };

    expect(canNpcAttack(attacker, target, plan)).toBe(true);
    expect(isNpcInMeleeRange(attacker, target)).toBe(false);
  });
});

describe('hasNpcAttackReach', () => {
  afterEach(() => setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true));

  it.each([1, 6])('rejects overlap at range %s without changing custom melee proximity', (range) => {
    const attacker = makeNpc('attacker');
    attacker.size = 3;
    const target = makeNpc('target');
    target.position = [12, 12];

    const reachable = hasNpcAttackReach(attacker, target, range);

    expect(reachable).toBe(false);
    expect(isNpcInMeleeRange(attacker, target)).toBe(true);
  });

  it.each([true, false])('casts target-to-attacker LOS when the incoming ray is blocked: %s', (blocked) => {
    const attacker = makeNpc('attacker');
    const target = makeNpc('target');
    target.position = [13, 10];
    const blockerX = blocked ? 10 : 13;
    const getFlag = (x: number, y: number) =>
      x === blockerX && y === 10 ? CollisionFlag.OBJECT_PROJECTILE_BLOCKER : 0;
    setArenaConfig(
      {
        bounds: null,
        walkableTiles: null,
        collisionMap: {
          sizeX: 64,
          sizeY: 64,
          flags: new Int32Array(4096),
          getFlag,
          hasFlag: (x, y, mask) => (getFlag(x, y) & mask) !== 0,
          flag: () => undefined,
          unflag: () => undefined,
        },
      },
      true,
    );
    const plan: AttackPlan = {
      formulaStyle: 'ranged',
      damageType: 'range',
      attackKind: 'range_arrow',
      impactDelayTicks: 0,
      sourceDeathPolicy: 'cancel-before-impact',
    };

    const reachable = hasNpcAttackReach(attacker, target, 6);

    expect(reachable).toBe(!blocked);
    expect(canNpcAttack(attacker, target, plan)).toBe(!blocked);
    expect(
      isFootprintInAttackRange(
        { southWest: attacker.position, width: 1, height: 1 },
        { southWest: target.position, width: 1, height: 1 },
        { attackRange: 6, checkCollision: true },
      ),
    ).toBe(blocked);
  });

  it('keeps plan-derived melee range when configured range is longer', () => {
    const attacker = makeNpc('attacker');
    const target = makeNpc('target');
    target.position = [13, 10];

    const reachable = canNpcAttack(attacker, target, {
      formulaStyle: 'melee_crush',
      damageType: 'melee',
      attackKind: 'melee_crush',
      impactDelayTicks: 0,
    });

    expect(reachable).toBe(false);
  });
});

/**
 * Each tiered prayer and Chivalry on the player's side of an NPC attack, read through the player's
 * lit `boostPrayers` exactly as the engine's NPC attacks read them.
 *
 * Wiki (https://oldschool.runescape.wiki/w/Damage_per_second/Melee, /Magic): defence roll =
 * effective × (defence bonus + 64), no worn defence here. Melee and ranged: effective =
 * floor(99 × prayer Defence) + 8. Magic: floor(floor(99 × prayer Magic) × 0.7) +
 * floor(floor(99 × prayer Defence) × 0.3) + 8. The NPC's roll is (100 + 9) × (100 + 64) = 17876
 * for both styles. Unprayed: 107 × 64 = 6848 and (69 + 29 + 8) × 64 = 6784.
 */
const NPC_ROLL = 17876;
const UNPRAYED_DEFENCE = { melee: 6848, magic: 6784 } as const;
const PRAYED_DEFENCE: Record<WikiTieredPrayer, Partial<Record<keyof typeof UNPRAYED_DEFENCE, number>>> = {
  // floor(99 × 1.05) = 103: (103 + 8) × 64 = 7104; magic (69 + 30 + 8) × 64 = 6848
  [PrayerType.ThickSkin]: { melee: 7104, magic: 6848 },
  // 108: 116 × 64 = 7424; magic (69 + 32 + 8) × 64 = 6976
  [PrayerType.RockSkin]: { melee: 7424, magic: 6976 },
  // 113: 121 × 64 = 7744; magic (69 + 33 + 8) × 64 = 7040
  [PrayerType.SteelSkin]: { melee: 7744, magic: 7040 },
  [PrayerType.BurstOfStrength]: {},
  [PrayerType.SuperhumanStrength]: {},
  [PrayerType.UltimateStrength]: {},
  [PrayerType.ClarityOfThought]: {},
  [PrayerType.ImprovedReflexes]: {},
  [PrayerType.IncredibleReflexes]: {},
  [PrayerType.SharpEye]: {},
  [PrayerType.HawkEye]: {},
  // Magic 103: (72 + 29 + 8) × 64 = 6976
  [PrayerType.MysticWill]: { magic: 6976 },
  // Magic 108: (75 + 29 + 8) × 64 = 7168
  [PrayerType.MysticLore]: { magic: 7168 },
  // Defence floor(99 × 1.2) = 118: 126 × 64 = 8064; magic (69 + 35 + 8) × 64 = 7168
  [PrayerType.Chivalry]: { melee: 8064, magic: 7168 },
};

describe('tiered prayers and Chivalry against NPC attacks', () => {
  const MAGIC_PLAN = {
    formulaStyle: 'magic',
    damageType: 'magic',
    attackKind: 'magic_fire',
    impactDelayTicks: 1,
    sourceDeathPolicy: 'cancel-before-impact',
  } as const satisfies AttackPlan;

  function player(boostPrayers: PrayerType[]): PlayerActor {
    return {
      ...makeStancePlayer(TWISTED_BOW, 1),
      id: 'player',
      kind: 'player',
      position: [11, 10],
      size: 1,
      equipmentStats: createEmptyStats(),
      activePrayer: null,
      boostPrayers,
    } as unknown as PlayerActor;
  }

  /** Whether one draw of `draw` passes the NPC's accuracy roll against this player. */
  function lands(boostPrayers: PrayerType[], plan: AttackPlan, draw: number): boolean {
    const request = resolveAttackRequest({
      attacker: makeNpc('attacker'),
      target: player(boostPrayers),
      plan,
      random: () => draw,
    });
    if (request === null) throw new TypeError('Expected an attack request');
    return request.accuracySucceeded;
  }

  /** Pins the NPC's hit chance to the one this defence roll gives, to well under one roll's worth. */
  function expectDefenceRoll(boostPrayers: PrayerType[], plan: AttackPlan, defenceRoll: number): void {
    const chance = hitChance(NPC_ROLL, defenceRoll);
    expect(lands(boostPrayers, plan, chance - 1e-9)).toBe(true);
    expect(lands(boostPrayers, plan, chance + 1e-9)).toBe(false);
  }

  it('starts from the unprayed defence rolls the wiki formulas give', () => {
    expectDefenceRoll([], MELEE_PLAN, UNPRAYED_DEFENCE.melee);
    expectDefenceRoll([], RANGE_PLAN, UNPRAYED_DEFENCE.melee);
    expectDefenceRoll([], MAGIC_PLAN, UNPRAYED_DEFENCE.magic);
  });

  it.each(WIKI_TIERED_PRAYER_ROWS)('changes exactly the defence rolls $prayer boosts', ({ prayer }) => {
    const expected = { ...UNPRAYED_DEFENCE, ...PRAYED_DEFENCE[prayer] };
    expectDefenceRoll([prayer], MELEE_PLAN, expected.melee);
    expectDefenceRoll([prayer], RANGE_PLAN, expected.melee);
    expectDefenceRoll([prayer], MAGIC_PLAN, expected.magic);
  });
});
