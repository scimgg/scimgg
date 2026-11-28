import { describe, expect, it } from 'vitest';
import { createEmptyStats } from '../../../../types/equipmentStats';
import { createDefaultTimers } from '../../../../types/playerState';
import { PrayerType } from '../../../../types/simulation';
import { type FirstPartyPlayerAttackInput, planFirstPartyPlayerAttack } from '../firstPartyPlayerAttack';
import {
  afterSoulreaperAttack,
  type SoulreaperState,
  soulreaperDisplayedStacks,
  soulreaperStrengthBonusPercent,
  tickSoulreaperDecay,
} from '../soulreaper';

describe('Soulreaper axe soul stacks', () => {
  it('adds one stack per attack up to five and re-arms the 50-tick decay', () => {
    let state: SoulreaperState | undefined;
    for (let i = 0; i < 7; i++) state = afterSoulreaperAttack(state, 100 + i, false);
    expect(state).toEqual({ stacks: 5, decayTick: 156 });
  });

  it('lets Behead spend every stack without earning one back', () => {
    expect(afterSoulreaperAttack({ stacks: 4, decayTick: 150 }, 120, true)).toBeUndefined();
    expect(afterSoulreaperAttack(undefined, 120, true)).toBeUndefined();
  });

  it('sheds one stack every 50 ticks without an axe attack', () => {
    let state: SoulreaperState | undefined = { stacks: 2, decayTick: 150 };
    state = tickSoulreaperDecay(state, 149);
    expect(state).toEqual({ stacks: 2, decayTick: 150 });
    state = tickSoulreaperDecay(state, 150);
    expect(state).toEqual({ stacks: 1, decayTick: 200 });
    expect(tickSoulreaperDecay(state, 200)).toBeUndefined();
  });

  it('boosts only an ordinary attack with the axe or its (o) variant', () => {
    const state = { stacks: 3, decayTick: 0 };
    expect(soulreaperStrengthBonusPercent(28338, state, false)).toBe(18);
    expect(soulreaperStrengthBonusPercent(33335, state, false)).toBe(18);
    expect(soulreaperStrengthBonusPercent(28338, state, true)).toBe(0);
    expect(soulreaperStrengthBonusPercent(13576, state, false)).toBe(0);
  });

  it('shows the stacks in place of energy only while the axe is worn', () => {
    expect(soulreaperDisplayedStacks(28338, 3)).toBe(3);
    expect(soulreaperDisplayedStacks(28338, undefined)).toBe(0);
    expect(soulreaperDisplayedStacks(13576, 3)).toBeUndefined();
    expect(soulreaperDisplayedStacks(undefined, 3)).toBeUndefined();
  });
});

describe('Soulreaper axe max hit', () => {
  function input(
    soulreaper: SoulreaperState | undefined,
    isSpecialAttack: boolean,
    // Hack: aggressive slash, +3 Strength.
    selectedAttackStyleIndex = 1,
    meleeStrength = 100,
  ): FirstPartyPlayerAttackInput {
    const level = { current: 99, max: 99 };
    return {
      player: {
        stats: {
          attack: level,
          strength: level,
          defence: level,
          ranged: level,
          magic: level,
          prayer: level,
          hitpoints: level,
          agility: level,
        },
        equipment: { weapon: 28338 },
        equipmentStats: { ...createEmptyStats(), attackSlash: 100, meleeStrength },
        activePrayer: null,
        boostPrayers: [PrayerType.Piety],
        selectedAttackStyleIndex,
        combatTimers: createDefaultTimers(),
        ...(soulreaper === undefined ? {} : { soulreaper }),
      },
      target: {
        size: 1,
        npcTypeId: 1,
        formulaStats: {
          levels: { attack: 1, strength: 1, defence: 1, ranged: 1, magic: 1 },
          offensive: { atk: 0, ranged: 0, magic: 0, str: 0, rangedStr: 0, magicStr: 0 },
          defensive: { stab: 0, slash: 0, crush: 0, rangedLight: 0, rangedStandard: 0, rangedHeavy: 0, magic: 0 },
        },
      },
      formulaStyle: 'melee_slash',
      resources: { kind: 'none', source: 'none' },
      attackSpeedTicks: 5,
      delivery: { style: 'melee', attackKind: 'melee_slash', impactDelayTicks: 1 },
      application: { outgoingDamageMultiplier: 1, specialAttackDamageMultiplier: 1 },
      manualCast: false,
      isSpecialAttack,
      standardAccuracyMode: 'single_roll',
    };
  }

  function damage(
    soulreaper: SoulreaperState | undefined,
    isSpecialAttack: boolean,
    selectedAttackStyleIndex?: number,
    meleeStrength?: number,
  ) {
    const plan = planFirstPartyPlayerAttack(
      input(soulreaper, isSpecialAttack, selectedAttackStyleIndex, meleeStrength),
    );
    if (plan?.kind !== 'ready') throw new TypeError('Expected a ready plan');
    return plan.hits[0].damage;
  }

  it('adds each stack to the Piety percentage rather than multiplying it', () => {
    // floor(99 x 1.23) = 121 -> 132 effective -> 34; floor(99 x (123 + 30) / 100) = 151 -> 162 -> 42.
    expect(damage(undefined, false)).toEqual({ kind: 'uniform', minimumInclusive: 0, maximumInclusive: 34 });
    expect(damage({ stacks: 5, decayTick: 0 }, false)).toEqual({
      kind: 'uniform',
      minimumInclusive: 0,
      maximumInclusive: 42,
    });
  });

  it('builds Behead on the un-stacked max hit', () => {
    // floor(34 x 1.30) = 44, minimum floor(44 x 0.30) = 13.
    expect(damage({ stacks: 5, decayTick: 0 }, true)).toEqual({
      kind: 'uniform',
      minimumInclusive: 13,
      maximumInclusive: 44,
    });
  });

  // capture weapon-soulreaper-fang-dragonwarhammer-zombieaxe-noxhalberd-tridentoftheswamps-tridentoftheseas-packet-data.txt,
  // ticks 440-473: one swing per stack count, on Chop, Hack, Smash, Block, Block, then Behead on Block,
  // splatting 32, 34, 36, 37, 38 and 41. The account's own levels are not in the capture; 99 Strength,
  // Piety and +95 strength is one setup that reproduces every splat.
  it('reproduces the captured stack sequence and Behead', () => {
    const swings: readonly [stacks: number, styleIndex: number, captured: number][] = [
      [0, 0, 32],
      [1, 1, 34],
      [2, 2, 36],
      [3, 3, 37],
      [4, 3, 38],
    ];
    for (const [stacks, styleIndex, captured] of swings) {
      const state = stacks === 0 ? undefined : { stacks, decayTick: 0 };
      expect(damage(state, false, styleIndex, 95), `${stacks} stacks`).toMatchObject({ maximumInclusive: captured });
    }
    // 32 x 1.30, floored: the un-stacked Block max, then Behead's bonus.
    expect(damage({ stacks: 5, decayTick: 0 }, true, 3, 95)).toMatchObject({ maximumInclusive: 41 });
  });
});
