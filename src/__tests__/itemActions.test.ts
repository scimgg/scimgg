import { describe, expect, it } from 'vitest';
import {
  applyCooldown,
  applyEffectOp,
  applyEffects,
  canUseAction,
  consumeItem,
  type ItemActionState,
  isItemActionRefused,
} from '../core/itemActions';
import { SimulationEngine } from '../core/SimulationEngine';
import type { ConsumePolicy, EffectOp, ItemActionDef } from '../data/itemEffects';
import {
  ATTACK_DELAY_BY_TRACK,
  doseChain,
  doseChainByStep,
  getAttackDelayForTrack,
  getPrepotEffects,
  ITEM_ACTIONS,
} from '../data/itemEffects';
import { prayerRestoreAmount } from '../data/prayerRestoration';
import { YamaEncounter } from '../encounters/yamaP3/YamaEncounter';
import { ITEM_WEAPON_CATEGORY } from '../types/attackStyles';
import type { Inventory } from '../types/inventory';
import type { CooldownTrackState, PlayerBaseStats, PlayerStats } from '../types/playerState';
import { createDefaultPoisonState, createStatsFromBaseLevels } from '../types/playerState';
import type { Coordinate } from '../types/simulation';

const PLAYER_START_POS: Coordinate = [31, 37];

function createTestState(overrides: Partial<ItemActionState> = {}): ItemActionState {
  const defaultStats: PlayerStats = {
    attack: { current: 99, max: 99 },
    strength: { current: 99, max: 99 },
    defence: { current: 99, max: 99 },
    ranged: { current: 99, max: 99 },
    magic: { current: 99, max: 99 },
    prayer: { current: 99, max: 99 },
    hitpoints: { current: 99, max: 99 },
    agility: { current: 99, max: 99 },
  };

  return {
    playerHP: 99,
    maxHP: 99,
    stats: defaultStats,
    poisonState: createDefaultPoisonState(),
    prayerState: {
      points: 99,
      maxPoints: 99,
      drainCounter: 0,
      activePrayers: [],
      prayerActivationTicks: {},
    },
    runEnergy: { energy: 10000 },
    specialAttack: { energy: 100, regenTickCounter: 50, lightbearerEquipped: false },
    combatTimers: {
      markOfDarknessCooldownTicks: 0,
      markOfDarknessActiveTicks: 0,
      deathChargeCooldownTicks: 0,
      deathChargeActiveTicks: 0,
      deathChargeProcsRemaining: 0,
      saturatedHeartCooldownTicks: 0,
      surgePotionCooldownTicks: 0,
      statBoostDecayTick: 100,
      statBoostDecayExtended: false,
      statRecoveryTick: 100,
      statDecayLocks: {},
      hpRegenTick: 101,
    },
    cooldownTracks: { food: 0, potion: 0, combo_food: 0 },
    activeEffects: [],
    currentTick: 10,
    ...overrides,
  };
}

function createTestInventory(slots: (number | null)[]): Inventory {
  return slots.map((id) => (id !== null ? { id } : null));
}

describe('ring of endurance stamina effects', () => {
  it.each([
    [12625, 200, 2000],
    [31638, 400, 4000],
  ])('doubles restore and duration for item %i', (id, duration, restore) => {
    const state = createTestState({ runEnergy: { energy: 1000 } });
    for (const equipped of [false, true]) {
      const result = applyEffects(ITEM_ACTIONS[id].effects, state, { ringOfEnduranceEquipped: equipped });
      const multiplier = equipped ? 2 : 1;
      expect(result.runEnergy.energy).toBe(1000 + restore * multiplier);
      expect(result.activeEffects).toContainEqual(
        expect.objectContaining({
          type: 'stamina',
          tickDuration: duration * multiplier,
          ticksRemaining: duration * multiplier,
        }),
      );
      const stamina = result.activeEffects.find((effect) => effect.type === 'stamina');
      expect(stamina?.type === 'stamina' && stamina.ringExtended === true).toBe(equipped);
      expect(
        applyEffects(
          ITEM_ACTIONS[id].effects,
          { ...state, runEnergy: { energy: 9000 } },
          {
            ringOfEnduranceEquipped: equipped,
          },
        ).runEnergy.energy,
      ).toBe(10000);
    }
  });

  it('does not double energy-only potions or modify Agility with combat potions', () => {
    const state = createTestState({ runEnergy: { energy: 0 } });
    state.stats.agility = { current: 42, max: 80 };
    expect(applyEffects(ITEM_ACTIONS[31614].effects, state, { ringOfEnduranceEquipped: true }).runEnergy.energy).toBe(
      3900,
    );
    for (const id of [6685, 2434, 12695]) {
      expect(applyEffects(ITEM_ACTIONS[id].effects, state).stats.agility).toEqual({ current: 42, max: 80 });
    }
  });

  it('restores every drained stat except Hitpoints, including Agility', () => {
    const state = createTestState({ playerHP: 50 });
    state.stats.agility = { current: 42, max: 80 };
    state.stats.hitpoints = { current: 50, max: 99 };
    // Super restore: 42 + floor(0.25 * 80) + 8 = 70.
    expect(applyEffects(ITEM_ACTIONS[3024].effects, state).stats.agility).toEqual({ current: 70, max: 80 });
    state.stats.agility = { current: 42, max: 70 };
    // Sanfew uses its own formula: 42 + floor(0.30 * 70) + 4 = 67.
    expect(applyEffects(ITEM_ACTIONS[10925].effects, state).stats.agility).toEqual({ current: 67, max: 70 });
    expect(applyEffects(ITEM_ACTIONS[3024].effects, state).stats.hitpoints).toEqual({ current: 50, max: 99 });
  });
});

describe('consumeItem', () => {
  describe('remove policy', () => {
    it('should set slot to null when policy is remove', () => {
      const inventory = createTestInventory([10925, null, 29143]);
      const policy: ConsumePolicy = { type: 'remove' };

      const result = consumeItem(inventory, 0, policy);

      expect(result[0]).toBe(null);
      expect(result[1]).toBe(null);
      expect(result[2]).toEqual({ id: 29143 });
    });

    it('should not mutate original inventory', () => {
      const inventory = createTestInventory([10925, null, null]);
      const policy: ConsumePolicy = { type: 'remove' };

      consumeItem(inventory, 0, policy);

      expect(inventory[0]).toEqual({ id: 10925 });
    });
  });

  describe('replace policy', () => {
    it('should replace item with new ID', () => {
      const sanfew4Dose = 10925;
      const sanfew3Dose = 10927;
      const inventory = createTestInventory([sanfew4Dose, null, null]);
      const policy: ConsumePolicy = { type: 'replace', withId: sanfew3Dose };

      const result = consumeItem(inventory, 0, policy);

      expect(result[0]).toEqual({ id: sanfew3Dose });
    });

    it('should replace empty vial ID (229) at last dose', () => {
      const sanfew1Dose = 10931;
      const emptyVial = 229;
      const inventory = createTestInventory([sanfew1Dose, null, null]);
      const policy: ConsumePolicy = { type: 'replace', withId: emptyVial };

      const result = consumeItem(inventory, 0, policy);

      expect(result[0]).toEqual({ id: 229 });
    });
  });

  describe('none policy', () => {
    it('should leave slot unchanged', () => {
      const emptyVial = 229;
      const inventory = createTestInventory([emptyVial, null, null]);
      const policy: ConsumePolicy = { type: 'none' };

      const result = consumeItem(inventory, 0, policy);

      expect(result[0]).toEqual({ id: 229 });
    });
  });

  describe('decrement policy', () => {
    it('should decrement quantity when quantity > 1', () => {
      const inventory: Inventory = [{ id: 1234, quantity: 5 }, null, null];
      const policy: ConsumePolicy = { type: 'decrement' };

      const result = consumeItem(inventory, 0, policy);

      expect(result[0]).toEqual({ id: 1234, quantity: 4 });
    });

    it('should remove item when quantity is 1', () => {
      const inventory: Inventory = [{ id: 1234, quantity: 1 }, null, null];
      const policy: ConsumePolicy = { type: 'decrement' };

      const result = consumeItem(inventory, 0, policy);

      expect(result[0]).toBe(null);
    });

    it('should treat undefined quantity as 1 and remove item', () => {
      const inventory: Inventory = [{ id: 1234 }, null, null];
      const policy: ConsumePolicy = { type: 'decrement' };

      const result = consumeItem(inventory, 0, policy);

      expect(result[0]).toBe(null);
    });

    it('should handle null slot gracefully', () => {
      const inventory: Inventory = [null, null, null];
      const policy: ConsumePolicy = { type: 'decrement' };

      const result = consumeItem(inventory, 0, policy);

      expect(result[0]).toBe(null);
    });
  });
});

describe('canUseAction', () => {
  it('should return true when own track and all right-side tracks are available', () => {
    const cooldownTracks: CooldownTrackState = { food: 5, potion: 0, combo_food: 0 };

    expect(canUseAction(cooldownTracks, 'food', 5)).toBe(true);
    expect(canUseAction(cooldownTracks, 'food', 10)).toBe(true);
    expect(canUseAction(cooldownTracks, 'combo_food', 0)).toBe(true);
  });

  it('should return false when own track is on cooldown', () => {
    const cooldownTracks: CooldownTrackState = { food: 15, potion: 20, combo_food: 5 };

    expect(canUseAction(cooldownTracks, 'food', 10)).toBe(false);
    expect(canUseAction(cooldownTracks, 'food', 14)).toBe(false);
    expect(canUseAction(cooldownTracks, 'potion', 19)).toBe(false);
  });

  it('should block food when right-side tracks are on cooldown', () => {
    const cooldownTracks: CooldownTrackState = { food: 10, potion: 5, combo_food: 15 };
    const currentTick = 10;

    expect(canUseAction(cooldownTracks, 'food', currentTick)).toBe(false);
    expect(canUseAction(cooldownTracks, 'potion', currentTick)).toBe(false);
    expect(canUseAction(cooldownTracks, 'combo_food', currentTick)).toBe(false);
  });
});

describe('applyCooldown', () => {
  it('should set absolute tick value for cooldown', () => {
    const cooldownTracks: CooldownTrackState = { food: 0, potion: 0, combo_food: 0 };

    const result = applyCooldown(cooldownTracks, 'food', 10, 3);

    expect(result.food).toBe(13);
  });

  it('should not mutate original cooldown state', () => {
    const cooldownTracks: CooldownTrackState = { food: 0, potion: 0, combo_food: 0 };

    applyCooldown(cooldownTracks, 'food', 10, 3);

    expect(cooldownTracks.food).toBe(0);
  });

  it('should preserve other track values', () => {
    const cooldownTracks: CooldownTrackState = { food: 5, potion: 10, combo_food: 15 };

    const result = applyCooldown(cooldownTracks, 'potion', 20, 3);

    expect(result.food).toBe(5);
    expect(result.potion).toBe(23);
    expect(result.combo_food).toBe(15);
  });

  it('should handle zero delay', () => {
    const cooldownTracks: CooldownTrackState = { food: 0, potion: 0, combo_food: 0 };

    const result = applyCooldown(cooldownTracks, 'combo_food', 50, 0);

    expect(result.combo_food).toBe(50);
  });
});

describe('applyEffectOp', () => {
  describe('heal operation', () => {
    it('should increase playerHP by amount', () => {
      const state = createTestState({ playerHP: 50 });
      const op: EffectOp = { op: 'heal', amount: 20 };

      const result = applyEffectOp(op, state);

      expect(result.playerHP).toBe(70);
    });

    it('should cap heal at maxHP', () => {
      const state = createTestState({ playerHP: 90, maxHP: 99 });
      const op: EffectOp = { op: 'heal', amount: 20 };

      const result = applyEffectOp(op, state);

      expect(result.playerHP).toBe(99);
    });

    it('should not drop overhealed HP back to maxHP', () => {
      const state = createTestState({ playerHP: 121, maxHP: 99 });
      const op: EffectOp = { op: 'heal', amount: 14 };

      const result = applyEffectOp(op, state);

      expect(result.playerHP).toBe(121);
    });

    it('should not mutate original state', () => {
      const state = createTestState({ playerHP: 50 });
      const op: EffectOp = { op: 'heal', amount: 20 };

      applyEffectOp(op, state);

      expect(state.playerHP).toBe(50);
    });
  });

  describe('heal_formula operation (anglerfish)', () => {
    it('should heal 22 at 99 HP level and allow overheal to 121', () => {
      const state = createTestState({ playerHP: 99, maxHP: 99 });
      const op: EffectOp = { op: 'heal_formula', baseAmount: 3, scaleStat: 'hitpoints' };

      const result = applyEffectOp(op, state);

      expect(result.playerHP).toBe(121);
    });

    it('should apply healing multiplier to full computed heal, not just baseAmount', () => {
      const state = createTestState({ playerHP: 80, maxHP: 99 });
      const op: EffectOp = { op: 'heal_formula', baseAmount: 3, scaleStat: 'hitpoints' };

      // Without multiplier: heal 22, so 80 + 22 = 102
      const normal = applyEffectOp(op, state);
      expect(normal.playerHP).toBe(102);

      // With 0.5x multiplier: heal floor(22 * 0.5) = 11, so 80 + 11 = 91
      const halved = applyEffectOp(op, state, { healing: 0.5 });
      expect(halved.playerHP).toBe(91);
    });

    it('should scale overheal cap with healing multiplier', () => {
      const state = createTestState({ playerHP: 99, maxHP: 99 });
      const op: EffectOp = { op: 'heal_formula', baseAmount: 3, scaleStat: 'hitpoints' };

      // Without multiplier: overheal cap = 99 + 22 = 121
      const normal = applyEffectOp(op, state);
      expect(normal.playerHP).toBe(121);

      // With 0.5x multiplier: heal = 11, overheal cap = 99 + 11 = 110
      const halved = applyEffectOp(op, state, { healing: 0.5 });
      expect(halved.playerHP).toBe(110);
    });

    it('should still overheal with healing multiplier when at full HP', () => {
      const state = createTestState({ playerHP: 99, maxHP: 99 });
      const op: EffectOp = { op: 'heal_formula', baseAmount: 3, scaleStat: 'hitpoints' };

      const result = applyEffectOp(op, state, { healing: 0.5 });
      expect(result.playerHP).toBeGreaterThan(99);
    });

    it('caps heals at maxHP when blockOverheal is set (Frailty)', () => {
      const full = createTestState({ playerHP: 99, maxHP: 99 });
      const healFormula: EffectOp = { op: 'heal_formula', baseAmount: 3, scaleStat: 'hitpoints' };
      const overheal: EffectOp = { op: 'overheal', amount: 16 };

      // Anglerfish (would overheal to 121) and a brew-style overheal are both capped at maxHP.
      expect(applyEffectOp(healFormula, full, { blockOverheal: true }).playerHP).toBe(99);
      expect(applyEffectOp(overheal, full, { blockOverheal: true }).playerHP).toBe(99);

      // A below-max heal still lands (up to maxHP) under the block.
      const wounded = createTestState({ playerHP: 90, maxHP: 99 });
      expect(applyEffectOp(overheal, wounded, { blockOverheal: true }).playerHP).toBe(99);
    });
  });

  describe('boost operation', () => {
    it('should increase stat above base', () => {
      const state = createTestState();
      // floor(99 * 0.15) + 5 = 19
      const op: EffectOp = { op: 'boost_formula', stat: 'attack', scaleStat: 'attack', percent: 0.15, flat: 5 };

      const result = applyEffectOp(op, state);

      expect(result.stats.attack.current).toBe(118);
      expect(result.stats.attack.max).toBe(99);
    });

    it.each([
      [55, 68], // a drained level rises by the full amount
      [99, 112],
      [105, 112], // a smaller existing boost is topped up to base + amount, not stacked
      [112, 112],
      [120, 120], // a larger existing boost is never lowered
    ])('lifts Ranged %i to %i with a 13-level boost from base 99', (current, expected) => {
      const state = createTestState();
      state.stats.ranged.current = current;
      const op: EffectOp = { op: 'boost_formula', stat: 'ranged', scaleStat: 'ranged', percent: 0.1, flat: 4 };

      expect(applyEffectOp(op, state).stats.ranged.current).toBe(expected);
    });
  });

  describe('drain operation', () => {
    it('should reduce stat current level', () => {
      const state = createTestState();
      // floor(99 * 0.1) + 4 = 13
      const op: EffectOp = { op: 'drain_formula', stat: 'attack', percent: 0.1, flat: 4 };

      const result = applyEffectOp(op, state);

      expect(result.stats.attack.current).toBe(86);
    });

    it('should not reduce below 0', () => {
      const state = createTestState();
      state.stats.magic.current = 5;
      // floor(5 * 0.1) + 13 = 13, from the CURRENT level
      const op: EffectOp = { op: 'drain_formula', stat: 'magic', percent: 0.1, flat: 13 };

      const result = applyEffectOp(op, state);

      expect(result.stats.magic.current).toBe(0);
    });
  });

  describe('restore_all_stats operation', () => {
    it('raises only drained combat skills, capped at base, and leaves boosts, Hitpoints and Prayer alone', () => {
      const state = createTestState({ playerHP: 40 });
      state.stats.attack.current = 50;
      state.stats.strength.current = 90;
      state.stats.defence.current = 118;
      state.stats.hitpoints.current = 40;
      state.stats.prayer.current = 10;

      const result = applyEffectOp({ op: 'restore_all_stats', formula: 'super_restore' }, state);

      expect(result.stats.attack.current).toBe(82); // 50 + floor(99 * 0.25) + 8
      expect(result.stats.strength.current).toBe(99);
      expect(result.stats.defence.current).toBe(118);
      expect(result.stats.ranged.current).toBe(99);
      expect(result.stats.hitpoints.current).toBe(40);
      // Prayer points are the potion's separate restore_prayer_formula; the engine derives the level.
      expect(result.stats.prayer.current).toBe(10);
    });
  });

  describe('restore_prayer_formula operation', () => {
    it('should increase prayer points', () => {
      const state = createTestState({
        prayerState: { points: 50, maxPoints: 99, drainCounter: 0, activePrayers: [], prayerActivationTicks: {} },
      });
      // floor(99 * 0.25) + 8 = 32
      const op: EffectOp = { op: 'restore_prayer_formula', formula: 'super_restore' };

      const result = applyEffectOp(op, state);

      expect(result.prayerState.points).toBe(82);
    });

    it('should cap at maxPoints', () => {
      const state = createTestState({
        prayerState: { points: 90, maxPoints: 99, drainCounter: 0, activePrayers: [], prayerActivationTicks: {} },
      });
      const op: EffectOp = { op: 'restore_prayer_formula', formula: 'super_restore' };

      const result = applyEffectOp(op, state);

      expect(result.prayerState.points).toBe(99);
    });

    it('should ignore enhancement context for a formula the enhancement does not cover', () => {
      const state = createTestState({
        prayerState: { points: 50, maxPoints: 99, drainCounter: 0, activePrayers: [], prayerActivationTicks: {} },
      });
      // Forgotten brew: floor(99 * 0.10) + 2 = 11 with or without a holy wrench.
      const op: EffectOp = { op: 'restore_prayer_formula', formula: 'forgotten_brew' };

      const result = applyEffectOp(op, state, { enhancedPrayerRestoration: true });

      expect(result.prayerState.points).toBe(61);
    });
  });

  describe('restore_run operation', () => {
    it('should increase run energy', () => {
      const state = createTestState({ runEnergy: { energy: 5000 } });
      const op: EffectOp = { op: 'restore_run', amount: 2000 };

      const result = applyEffectOp(op, state);

      expect(result.runEnergy.energy).toBe(7000);
    });

    it('should cap at 10000', () => {
      const state = createTestState({ runEnergy: { energy: 9000 } });
      const op: EffectOp = { op: 'restore_run', amount: 3000 };

      const result = applyEffectOp(op, state);

      expect(result.runEnergy.energy).toBe(10000);
    });
  });

  describe('apply_timed_effect operation', () => {
    it('should add effect to activeEffects', () => {
      const state = createTestState({ currentTick: 50 });
      const op: EffectOp = { op: 'apply_timed_effect', effectType: 'stamina', durationTicks: 200 };

      const result = applyEffectOp(op, state);

      expect(result.activeEffects).toHaveLength(1);
      expect(result.activeEffects[0].type).toBe('stamina');
      expect(result.activeEffects[0].ticksRemaining).toBe(200);
    });
  });

  describe('self_damage operation', () => {
    it('should reduce playerHP by amount', () => {
      const state = createTestState({ playerHP: 99 });
      const op: EffectOp = { op: 'self_damage', amount: 10 };

      const result = applyEffectOp(op, state);

      expect(result.playerHP).toBe(89);
    });

    it('should floor HP at 1 (never kill)', () => {
      const state = createTestState({ playerHP: 5 });
      const op: EffectOp = { op: 'self_damage', amount: 10 };

      const result = applyEffectOp(op, state);

      expect(result.playerHP).toBe(1);
    });

    it('should floor HP at 1 when exactly 1 HP', () => {
      const state = createTestState({ playerHP: 1 });
      const op: EffectOp = { op: 'self_damage', amount: 1 };

      const result = applyEffectOp(op, state);

      expect(result.playerHP).toBe(1);
    });

    it('should not mutate original state', () => {
      const state = createTestState({ playerHP: 99 });
      const op: EffectOp = { op: 'self_damage', amount: 10 };

      applyEffectOp(op, state);

      expect(state.playerHP).toBe(99);
    });
  });
});

describe('applyEffects', () => {
  it('should apply multiple effects in sequence', () => {
    const state = createTestState({ playerHP: 50 });
    const effects: EffectOp[] = [
      { op: 'heal', amount: 20 },
      { op: 'boost_formula', stat: 'defence', scaleStat: 'defence', percent: 0.2, flat: 2 }, // +21
    ];

    const result = applyEffects(effects, state);

    expect(result.playerHP).toBe(70);
    expect(result.stats.defence.current).toBe(120);
  });

  it('should sync playerHP to stats.hitpoints.current', () => {
    const state = createTestState({ playerHP: 50 });
    state.stats.hitpoints.current = 50;
    const effects: EffectOp[] = [{ op: 'heal', amount: 20 }];

    const result = applyEffects(effects, state);

    expect(result.playerHP).toBe(70);
    expect(result.stats.hitpoints.current).toBe(70);
  });

  it('should handle empty effects array', () => {
    const state = createTestState({ playerHP: 75 });

    const result = applyEffects([], state);

    expect(result.playerHP).toBe(75);
  });

  it('should handle mixed effects (heal + boost + drain)', () => {
    const state = createTestState({ playerHP: 50 });
    const effects: EffectOp[] = [
      { op: 'heal', amount: 16 },
      { op: 'boost_formula', stat: 'defence', scaleStat: 'defence', percent: 0.2, flat: 2 }, // +21
      { op: 'drain_formula', stat: 'attack', percent: 0.1, flat: 4 }, // -13
      { op: 'drain_formula', stat: 'strength', percent: 0.1, flat: 4 }, // -13
    ];

    const result = applyEffects(effects, state);

    expect(result.playerHP).toBe(66);
    expect(result.stats.defence.current).toBe(120);
    expect(result.stats.attack.current).toBe(86);
    expect(result.stats.strength.current).toBe(86);
  });
});

describe('doseChain helper', () => {
  it('should generate 4 entries with correct IDs', () => {
    const ids: [number, number, number, number] = [1000, 1001, 1002, 1003];
    const emptyId = 229;

    const result = doseChain(ids, emptyId, 'potion', 3, () => []);

    expect(Object.keys(result)).toHaveLength(4);
    expect(result[1000]).toBeDefined();
    expect(result[1001]).toBeDefined();
    expect(result[1002]).toBeDefined();
    expect(result[1003]).toBeDefined();
  });

  it('should chain dose replacements correctly', () => {
    const ids: [number, number, number, number] = [1000, 1001, 1002, 1003];
    const emptyId = 229;

    const result = doseChain(ids, emptyId, 'potion', 3, () => []);

    expect(result[1000].consume).toEqual({ type: 'replace', withId: 1001 });
    expect(result[1001].consume).toEqual({ type: 'replace', withId: 1002 });
    expect(result[1002].consume).toEqual({ type: 'replace', withId: 1003 });
    expect(result[1003].consume).toEqual({ type: 'replace', withId: 229 });
  });

  it('should use provided track and delayTicks', () => {
    const ids: [number, number, number, number] = [1000, 1001, 1002, 1003];

    const result = doseChain(ids, 229, 'combo_food', 5, () => []);

    expect(result[1000].track).toBe('combo_food');
    expect(result[1000].delayTicks).toBe(5);
  });

  it('should call effectsFn for each dose entry', () => {
    const ids: [number, number, number, number] = [1000, 1001, 1002, 1003];
    const effects: EffectOp[] = [{ op: 'heal', amount: 10 }];

    const result = doseChain(ids, 229, 'potion', 3, () => effects);

    expect(result[1000].effects).toEqual(effects);
    expect(result[1003].effects).toEqual(effects);
  });

  it('should generate noteable potion chains from step IDs', () => {
    const result = doseChainByStep(10925, 2, 229, 'potion', 3, () => []);

    expect(result[10925].consume).toEqual({ type: 'replace', withId: 10927 });
    expect(result[10927].consume).toEqual({ type: 'replace', withId: 10929 });
    expect(result[10929].consume).toEqual({ type: 'replace', withId: 10931 });
    expect(result[10931].consume).toEqual({ type: 'replace', withId: 229 });
  });
});

describe("potion amounts come from the drinker's own levels", () => {
  function stateAt(levels: Partial<PlayerBaseStats>, overrides: Partial<ItemActionState> = {}): ItemActionState {
    const stats = createStatsFromBaseLevels({
      attack: 99,
      strength: 99,
      defence: 99,
      ranged: 99,
      magic: 99,
      prayer: 99,
      hitpoints: 99,
      agility: 99,
      ...levels,
    });
    const hp = stats.hitpoints.max;
    return createTestState({ stats, playerHP: hp, maxHP: hp, ...overrides });
  }

  const SUPER_COMBAT = 12695;
  const DIVINE_SUPER_COMBAT = 23685;
  const SARADOMIN_BREW = 6685;
  const FORGOTTEN_BREW = 27629;
  const SUPER_RESTORE = 3024;
  const SANFEW = 10925;

  it.each([
    [99, 118], // floor(99 * 0.15) + 5 = 19
    [90, 108], // 13 + 5 = 18
    [70, 85], // 10 + 5 = 15
    [1, 6], // 0 + 5 = 5
  ])('boosts super combat skills from base %i to %i', (base, expected) => {
    const state = stateAt({ attack: base, strength: base, defence: base });

    const result = applyEffects(ITEM_ACTIONS[SUPER_COMBAT].effects, state);

    expect(result.stats.attack.current).toBe(expected);
    expect(result.stats.strength.current).toBe(expected);
    expect(result.stats.defence.current).toBe(expected);
  });

  it('boosts divine super combat from base 70 and locks all three skills for 500 ticks', () => {
    const state = stateAt({ attack: 70, strength: 70, defence: 70 });

    const result = applyEffects(ITEM_ACTIONS[DIVINE_SUPER_COMBAT].effects, state);

    expect(result.stats.attack.current).toBe(85);
    expect(result.combatTimers.statDecayLocks).toEqual({
      attack: { ticksRemaining: 500, source: 'divine' },
      strength: { ticksRemaining: 500, source: 'divine' },
      defence: { ticksRemaining: 500, source: 'divine' },
    });
  });

  it('refreshes an existing divine lock on a re-drink without touching other locks', () => {
    const state = stateAt({});
    state.combatTimers = {
      ...state.combatTimers,
      statDecayLocks: {
        attack: { ticksRemaining: 3, source: 'divine' },
        magic: { ticksRemaining: 40, source: 'saturated_heart' },
      },
    };

    const result = applyEffects(ITEM_ACTIONS[DIVINE_SUPER_COMBAT].effects, state);

    expect(result.combatTimers.statDecayLocks.attack?.ticksRemaining).toBe(500);
    expect(result.combatTimers.statDecayLocks.magic).toEqual({ ticksRemaining: 40, source: 'saturated_heart' });
  });

  it('keeps the divine lock through the prepot whitelist, and drops the Hitpoints cost', () => {
    const prepot = getPrepotEffects(ITEM_ACTIONS[DIVINE_SUPER_COMBAT].effects);

    expect(prepot.map((effect) => effect.op)).toEqual([
      'boost_formula',
      'boost_formula',
      'boost_formula',
      'divine_decay_lock',
    ]);
  });

  it('heals, boosts Defence and drains from a non-99 account (Saradomin brew, base 70)', () => {
    const result = applyEffects(
      ITEM_ACTIONS[SARADOMIN_BREW].effects,
      stateAt({ attack: 70, strength: 70, defence: 70, ranged: 70, magic: 70, hitpoints: 70 }, { playerHP: 60 }),
    );

    expect(result.playerHP).toBe(72); // + floor(70 * 0.15) + 2 = 12
    expect(result.stats.defence.current).toBe(86); // + floor(70 * 0.20) + 2 = 16
    expect(result.stats.attack.current).toBe(61); // - (floor(70 * 0.10) + 2) = 9
    expect(result.stats.strength.current).toBe(61);
    expect(result.stats.ranged.current).toBe(61);
    expect(result.stats.magic.current).toBe(61);
  });

  it('overheals a Saradomin brew to base Hitpoints plus the heal', () => {
    const state = stateAt({ hitpoints: 70 }, { playerHP: 80 });

    expect(applyEffects(ITEM_ACTIONS[SARADOMIN_BREW].effects, state).playerHP).toBe(82);
  });

  it('drains each repeated brew from the CURRENT level, so later doses take less', () => {
    let state = stateAt({});
    const ranged: number[] = [];
    for (let dose = 0; dose < 5; dose++) {
      state = applyEffects(ITEM_ACTIONS[SARADOMIN_BREW].effects, state);
      ranged.push(state.stats.ranged.current);
    }

    // 99 -11 -> 88 -10 -> 78 -9 -> 69 -8 -> 61 -8 -> 53
    expect(ranged).toEqual([88, 78, 69, 61, 53]);
  });

  it('never drains below 0', () => {
    const state = stateAt({});
    state.stats.magic.current = 1;

    expect(applyEffects(ITEM_ACTIONS[SARADOMIN_BREW].effects, state).stats.magic.current).toBe(0);
  });

  it('boosts Magic, restores Prayer and drains melee from a non-99 account (Forgotten brew, base 70)', () => {
    const state = stateAt(
      { attack: 70, strength: 70, defence: 70, magic: 70, prayer: 70 },
      { prayerState: { points: 20, maxPoints: 70, drainCounter: 0, activePrayers: [], prayerActivationTicks: {} } },
    );

    const result = applyEffects(ITEM_ACTIONS[FORGOTTEN_BREW].effects, state);

    expect(result.stats.magic.current).toBe(78); // + floor(70 * 0.08) + 3 = 8
    expect(result.prayerState.points).toBe(29); // + floor(70 * 0.10) + 2 = 9
    expect(result.stats.attack.current).toBe(61); // - (floor(70 * 0.10) + 2) = 9
    expect(result.stats.strength.current).toBe(61);
    expect(result.stats.defence.current).toBe(61);
  });

  it('caps the Forgotten brew Prayer restore at max points', () => {
    const prayerState = { points: 95, maxPoints: 99, drainCounter: 0, activePrayers: [], prayerActivationTicks: {} };
    const state = stateAt({}, { prayerState });

    expect(applyEffects(ITEM_ACTIONS[FORGOTTEN_BREW].effects, state).prayerState.points).toBe(99);
  });

  it.each([
    // [base, Super restore amount, Sanfew amount]
    [99, 32, 33], // floor(24.75) + 8 vs floor(29.7) + 4
    [60, 23, 22], // floor(15) + 8 vs floor(18) + 4
  ])('restores from base %i: Super restore +%i, Sanfew +%i', (base, superRestore, sanfew) => {
    const drained = (): ItemActionState => {
      const state = stateAt({ attack: base, ranged: base });
      state.stats.attack.current = 1;
      state.stats.ranged.current = base - 3;
      return state;
    };

    const afterSuper = applyEffects(ITEM_ACTIONS[SUPER_RESTORE].effects, drained());
    const afterSanfew = applyEffects(ITEM_ACTIONS[SANFEW].effects, drained());

    expect(afterSuper.stats.attack.current).toBe(1 + superRestore);
    expect(afterSanfew.stats.attack.current).toBe(1 + sanfew);
    expect(afterSuper.stats.ranged.current).toBe(base);
    expect(afterSanfew.stats.ranged.current).toBe(base);
  });

  describe('prayerRestoreAmount', () => {
    it('should calculate super restore as floor(level * 0.25) + 8', () => {
      expect(prayerRestoreAmount('super_restore', 99, false)).toBe(32); // floor(99 * 0.25) + 8 = 24 + 8 = 32
    });

    it('should calculate Sanfew as floor(level * 0.30) + 4', () => {
      expect(prayerRestoreAmount('sanfew', 99, false)).toBe(33);
    });

    it('should calculate prayer potion as floor(level * 0.25) + 7, one short of super restore', () => {
      // /w/Prayer_potion: 7 + 25%, or 7 + 27% with a holy wrench, prayer cape or ring of the gods (i).
      expect(prayerRestoreAmount('prayer_potion', 99, false)).toBe(31);
      expect(prayerRestoreAmount('prayer_potion', 99, true)).toBe(33);
      expect(prayerRestoreAmount('prayer_potion', 70, false)).toBe(24);
    });
  });

  it('should calculate the Forgotten brew Prayer restore as floor(level * 0.10) + 2, never enhanced', () => {
    expect(prayerRestoreAmount('forgotten_brew', 99, false)).toBe(11);
    expect(prayerRestoreAmount('forgotten_brew', 99, true)).toBe(11);
    expect(prayerRestoreAmount('forgotten_brew', 75, false)).toBe(9);
  });
});

describe('INTEGRATION: New potion registrations', () => {
  it('super restore (3024) should have correct registration, chain, and effects', () => {
    const def4 = ITEM_ACTIONS[3024];
    const def3 = ITEM_ACTIONS[3026];
    const def2 = ITEM_ACTIONS[3028];
    const def1 = ITEM_ACTIONS[3030];

    expect(def4).toBeDefined();
    expect(def4.track).toBe('potion');
    expect(def4.delayTicks).toBe(3);
    expect(def4.consume).toEqual({ type: 'replace', withId: 3026 });
    expect(def3.consume).toEqual({ type: 'replace', withId: 3028 });
    expect(def2.consume).toEqual({ type: 'replace', withId: 3030 });
    expect(def1.consume).toEqual({ type: 'replace', withId: 229 });
    expect(def4.effects).toEqual([
      { op: 'restore_all_stats', formula: 'super_restore' },
      { op: 'restore_prayer_formula', formula: 'super_restore' },
    ]);
  });

  it('saradomin brew (6685) should have correct registration, chain, and effects behavior', () => {
    const def4 = ITEM_ACTIONS[6685];
    const def3 = ITEM_ACTIONS[6687];
    const def2 = ITEM_ACTIONS[6689];
    const def1 = ITEM_ACTIONS[6691];

    expect(def4).toBeDefined();
    expect(def4.track).toBe('potion');
    expect(def4.delayTicks).toBe(3);
    expect(def4.consume).toEqual({ type: 'replace', withId: 6687 });
    expect(def3.consume).toEqual({ type: 'replace', withId: 6689 });
    expect(def2.consume).toEqual({ type: 'replace', withId: 6691 });
    expect(def1.consume).toEqual({ type: 'replace', withId: 229 });
    expect(def4.effects).toEqual([
      { op: 'overheal_formula', scaleStat: 'hitpoints', percent: 0.15, flat: 2 },
      { op: 'boost_formula', stat: 'defence', scaleStat: 'defence', percent: 0.2, flat: 2 },
      { op: 'drain_formula', stat: 'attack', percent: 0.1, flat: 2 },
      { op: 'drain_formula', stat: 'strength', percent: 0.1, flat: 2 },
      { op: 'drain_formula', stat: 'magic', percent: 0.1, flat: 2 },
      { op: 'drain_formula', stat: 'ranged', percent: 0.1, flat: 2 },
    ]);

    const state = createTestState({ playerHP: 50, maxHP: 99 });
    const result = applyEffects(def4.effects, state);

    expect(result.playerHP).toBe(66);
    expect(result.stats.defence.current).toBe(120);
    expect(result.stats.attack.current).toBe(88);
    expect(result.stats.strength.current).toBe(88);
    expect(result.stats.magic.current).toBe(88);
    expect(result.stats.ranged.current).toBe(88);
  });

  it('super combat (12695) should have correct registration, chain, and effects', () => {
    const def4 = ITEM_ACTIONS[12695];
    const def3 = ITEM_ACTIONS[12697];
    const def2 = ITEM_ACTIONS[12699];
    const def1 = ITEM_ACTIONS[12701];

    expect(def4).toBeDefined();
    expect(def4.track).toBe('potion');
    expect(def4.delayTicks).toBe(3);
    expect(def4.consume).toEqual({ type: 'replace', withId: 12697 });
    expect(def3.consume).toEqual({ type: 'replace', withId: 12699 });
    expect(def2.consume).toEqual({ type: 'replace', withId: 12701 });
    expect(def1.consume).toEqual({ type: 'replace', withId: 229 });
    expect(def4.effects).toEqual([
      { op: 'boost_formula', stat: 'attack', scaleStat: 'attack', percent: 0.15, flat: 5 },
      { op: 'boost_formula', stat: 'strength', scaleStat: 'strength', percent: 0.15, flat: 5 },
      { op: 'boost_formula', stat: 'defence', scaleStat: 'defence', percent: 0.15, flat: 5 },
    ]);
  });

  it('ranging potion (2444) should have correct registration and chain, with no HP cost or decay lock', () => {
    expect(ITEM_ACTIONS[2444].consume).toEqual({ type: 'replace', withId: 169 });
    expect(ITEM_ACTIONS[169].consume).toEqual({ type: 'replace', withId: 171 });
    expect(ITEM_ACTIONS[171].consume).toEqual({ type: 'replace', withId: 173 });
    expect(ITEM_ACTIONS[173].consume).toEqual({ type: 'replace', withId: 229 });
    for (const id of [2444, 169, 171, 173]) {
      const def = ITEM_ACTIONS[id];
      expect(def.track).toBe('potion');
      expect(def.delayTicks).toBe(3);
      expect(def.minHpToUse).toBeUndefined();
      const result = applyEffects(def.effects, createTestState({ playerHP: 99 }));
      expect(result.playerHP).toBe(99);
      expect(result.combatTimers.statDecayLocks).toEqual({});
    }
  });

  it.each([
    [99, 112], // floor(99 * 0.1) + 4 = 13
    [90, 103], // 9 + 4 = 13
    [75, 86], // 7 + 4 = 11
    [1, 5], // 0 + 4 = 4
  ])('ranging potion boosts Ranged from base %i to %i', (base, expected) => {
    const stats = createTestState().stats;
    stats.ranged = { current: base, max: base };

    const result = applyEffects(ITEM_ACTIONS[2444].effects, createTestState({ stats }));

    expect(result.stats.ranged.current).toBe(expected);
  });

  it('divine ranging potion boosts Ranged, costs 10 HP, needs 11 HP, and locks only Ranged for 500 ticks', () => {
    expect(ITEM_ACTIONS[23733].consume).toEqual({ type: 'replace', withId: 23736 });
    expect(ITEM_ACTIONS[23736].consume).toEqual({ type: 'replace', withId: 23739 });
    expect(ITEM_ACTIONS[23739].consume).toEqual({ type: 'replace', withId: 23742 });
    expect(ITEM_ACTIONS[23742].consume).toEqual({ type: 'replace', withId: 229 });
    for (const id of [23733, 23736, 23739, 23742]) {
      const def = ITEM_ACTIONS[id];
      expect(def.track).toBe('potion');
      expect(def.delayTicks).toBe(3);
      expect(def.minHpToUse).toBe(11);
      const result = applyEffects(def.effects, createTestState({ playerHP: 99 }));
      expect(result.playerHP).toBe(89);
      expect(result.stats.ranged.current).toBe(112);
      expect(result.stats.attack.current).toBe(result.stats.attack.max);
      expect(result.combatTimers.statDecayLocks).toEqual({ ranged: { ticksRemaining: 500, source: 'divine' } });
    }
  });

  it('divine super combat (23685) should have correct registration, chain, effects, and minHpToUse guard', () => {
    const def4 = ITEM_ACTIONS[23685];
    const def3 = ITEM_ACTIONS[23688];
    const def2 = ITEM_ACTIONS[23691];
    const def1 = ITEM_ACTIONS[23694];

    expect(def4).toBeDefined();
    expect(def4.track).toBe('potion');
    expect(def4.delayTicks).toBe(3);
    expect(def4.minHpToUse).toBe(11);
    expect(def4.consume).toEqual({ type: 'replace', withId: 23688 });
    expect(def3.consume).toEqual({ type: 'replace', withId: 23691 });
    expect(def2.consume).toEqual({ type: 'replace', withId: 23694 });
    expect(def1.consume).toEqual({ type: 'replace', withId: 229 });
    expect(def4.effects).toContainEqual({ op: 'self_damage', amount: 10 });
    expect(def4.effects).toContainEqual({
      op: 'divine_decay_lock',
      stats: ['attack', 'strength', 'defence'],
      durationTicks: 500,
    });

    const result = applyEffects(def4.effects, createTestState({ playerHP: 99 }));
    expect(result.playerHP).toBe(89);
    expect(result.stats.attack.current).toBe(118);
    expect(result.stats.strength.current).toBe(118);
    expect(result.stats.defence.current).toBe(118);
    expect(result.activeEffects).toEqual([]);
    expect(result.combatTimers.statDecayLocks.attack).toEqual({ ticksRemaining: 500, source: 'divine' });

    for (const dose of [def3, def2, def1]) expect(dose.minHpToUse).toBe(11);
  });

  it('forgotten brew (27629) should have correct registration, chain, and effects', () => {
    const def4 = ITEM_ACTIONS[27629];
    const def3 = ITEM_ACTIONS[27632];
    const def2 = ITEM_ACTIONS[27635];
    const def1 = ITEM_ACTIONS[27638];

    expect(def4).toBeDefined();
    expect(def4.track).toBe('potion');
    expect(def4.delayTicks).toBe(3);
    expect(def4.consume).toEqual({ type: 'replace', withId: 27632 });
    expect(def3.consume).toEqual({ type: 'replace', withId: 27635 });
    expect(def2.consume).toEqual({ type: 'replace', withId: 27638 });
    expect(def1.consume).toEqual({ type: 'replace', withId: 229 });
    expect(def4.effects).toEqual([
      { op: 'boost_formula', stat: 'magic', scaleStat: 'magic', percent: 0.08, flat: 3 },
      { op: 'restore_prayer_formula', formula: 'forgotten_brew' },
      { op: 'drain_formula', stat: 'attack', percent: 0.1, flat: 2 },
      { op: 'drain_formula', stat: 'strength', percent: 0.1, flat: 2 },
      { op: 'drain_formula', stat: 'defence', percent: 0.1, flat: 2 },
    ]);
  });

  it('guthix rest (4417) should be potion track, have cup chain, and overheal + run restore + poison reduction effects', () => {
    const def4 = ITEM_ACTIONS[4417];
    const def3 = ITEM_ACTIONS[4419];
    const def2 = ITEM_ACTIONS[4421];
    const def1 = ITEM_ACTIONS[4423];

    expect(def4).toBeDefined();
    expect(def4.track).toBe('potion');
    expect(def4.delayTicks).toBe(3);
    expect(def4.consume).toEqual({ type: 'replace', withId: 4419 });
    expect(def3.consume).toEqual({ type: 'replace', withId: 4421 });
    expect(def2.consume).toEqual({ type: 'replace', withId: 4423 });
    expect(def1.consume).toEqual({ type: 'replace', withId: 1980 });
    expect(def4.effects).toEqual([
      { op: 'overheal', amount: 5 },
      { op: 'restore_run', amount: 500 },
      { op: 'reduce_poison', amount: 1 },
    ]);

    const result = applyEffects(def4.effects, createTestState({ playerHP: 99, maxHP: 99 }));
    expect(result.playerHP).toBe(104);
  });

  it('antidote++ (5952) should cure poison and have proper dose chain', () => {
    const def4 = ITEM_ACTIONS[5952];
    const def3 = ITEM_ACTIONS[5954];
    const def2 = ITEM_ACTIONS[5956];
    const def1 = ITEM_ACTIONS[5958];

    expect(def4).toBeDefined();
    expect(def4.track).toBe('potion');
    expect(def4.delayTicks).toBe(3);
    expect(def4.consume).toEqual({ type: 'replace', withId: 5954 });
    expect(def3.consume).toEqual({ type: 'replace', withId: 5956 });
    expect(def2.consume).toEqual({ type: 'replace', withId: 5958 });
    expect(def1.consume).toEqual({ type: 'replace', withId: 229 });
    expect(def4.effects).toEqual([{ op: 'cure_poison', immunitySteps: 40 }]);
  });

  it('extended stamina (31638) should have correct chain and effects', () => {
    const def4 = ITEM_ACTIONS[31638];
    const def3 = ITEM_ACTIONS[31641];
    const def2 = ITEM_ACTIONS[31644];
    const def1 = ITEM_ACTIONS[31647];

    expect(def4).toBeDefined();
    expect(def4.track).toBe('potion');
    expect(def4.delayTicks).toBe(3);
    expect(def4.consume).toEqual({ type: 'replace', withId: 31641 });
    expect(def3.consume).toEqual({ type: 'replace', withId: 31644 });
    expect(def2.consume).toEqual({ type: 'replace', withId: 31647 });
    expect(def1.consume).toEqual({ type: 'replace', withId: 229 });
    expect(def4.effects).toEqual([
      { op: 'restore_run', amount: 4000 },
      { op: 'apply_timed_effect', effectType: 'stamina', durationTicks: 400 },
    ]);
  });

  it('extreme energy (31614) should have correct chain and restore_run effect', () => {
    const def4 = ITEM_ACTIONS[31614];
    const def3 = ITEM_ACTIONS[31617];
    const def2 = ITEM_ACTIONS[31620];
    const def1 = ITEM_ACTIONS[31623];

    expect(def4).toBeDefined();
    expect(def4.track).toBe('potion');
    expect(def4.delayTicks).toBe(3);
    expect(def4.consume).toEqual({ type: 'replace', withId: 31617 });
    expect(def3.consume).toEqual({ type: 'replace', withId: 31620 });
    expect(def2.consume).toEqual({ type: 'replace', withId: 31623 });
    expect(def1.consume).toEqual({ type: 'replace', withId: 229 });
    expect(def4.effects).toEqual([{ op: 'restore_run', amount: 3900 }]);
  });

  it('surge potion (30875) walks its unnoted doses and restores special attack energy', () => {
    // RuneLite gameval ItemID _4DOSESURGE..._1DOSESURGE; 30888 after them is the Yama pet.
    expect(ITEM_ACTIONS[30875]).toMatchObject({ track: 'potion', delayTicks: 3, consume: { withId: 30878 } });
    expect(ITEM_ACTIONS[30878].consume).toEqual({ type: 'replace', withId: 30881 });
    expect(ITEM_ACTIONS[30881].consume).toEqual({ type: 'replace', withId: 30884 });
    expect(ITEM_ACTIONS[30884].consume).toEqual({ type: 'replace', withId: 229 });
    expect(ITEM_ACTIONS[30875].effects).toEqual([{ op: 'surge', percent: 25 }]);
    expect(ITEM_ACTIONS[30888]).toBeUndefined();
  });

  describe('surge potion dose', () => {
    const surge = ITEM_ACTIONS[30875].effects;
    const withEnergy = (energy: number, surgePotionCooldownTicks = 0) => {
      const base = createTestState();
      return createTestState({
        specialAttack: { ...base.specialAttack, energy },
        combatTimers: { ...base.combatTimers, surgePotionCooldownTicks },
      });
    };

    it('restores 25% special attack energy, capped at 100, and starts the five-minute cooldown', () => {
      expect(applyEffects(surge, withEnergy(40)).specialAttack.energy).toBe(65);
      const topped = applyEffects(surge, withEnergy(90));
      expect(topped.specialAttack.energy).toBe(100);
      expect(topped.combatTimers.surgePotionCooldownTicks).toBe(500);
    });

    it.each([
      ['inside its cooldown', withEnergy(40, 1)],
      ['at full special attack energy', withEnergy(100)],
    ])('is refused %s', (_when, state) => {
      expect(isItemActionRefused(surge, state)).toBe(true);
    });

    it('is not refused once the cooldown has run out below full energy', () => {
      expect(isItemActionRefused(surge, withEnergy(99))).toBe(false);
      // Nothing else refuses: a super restore is always drunk.
      expect(isItemActionRefused(ITEM_ACTIONS[3024].effects, withEnergy(100, 1))).toBe(false);
    });
  });

  it('prayer potion (2434) walks its four doses and restores prayer by its own formula', () => {
    expect(ITEM_ACTIONS[2434]).toMatchObject({ track: 'potion', delayTicks: 3, consume: { withId: 139 } });
    expect(ITEM_ACTIONS[139].consume).toEqual({ type: 'replace', withId: 141 });
    expect(ITEM_ACTIONS[141].consume).toEqual({ type: 'replace', withId: 143 });
    expect(ITEM_ACTIONS[143].consume).toEqual({ type: 'replace', withId: 229 });
    const drained = createTestState({ prayerState: { ...createTestState().prayerState, points: 10 } });
    expect(applyEffects(ITEM_ACTIONS[2434].effects, drained).prayerState.points).toBe(10 + 31);
  });

  it('snowy knight mix heals 8 a dose down its own two-dose chain', () => {
    // Heals 8 per dose, hotfixed down from 15 on 21 March 2024. 29186 is a RUBY
    // HARVEST mix, not the 1-dose snowy knight — pointing the chain there swaps
    // the potion mid-sip.
    const def2 = ITEM_ACTIONS[29183];
    const def1 = ITEM_ACTIONS[29201];

    expect(def2).toBeDefined();
    expect(def2.track).toBe('potion');
    expect(def2.delayTicks).toBe(3);
    expect(getAttackDelayForTrack('potion')).toBe(0);
    expect(def2.consume).toEqual({ type: 'replace', withId: 29201 });
    expect(def1.track).toBe('potion');
    expect(def1.delayTicks).toBe(3);
    expect(def1.consume).toEqual({ type: 'remove' });
    expect(def2.effects).toEqual([{ op: 'heal', amount: 8 }]);
    expect(def1.effects).toEqual([{ op: 'heal', amount: 8 }]);
  });
});

describe('INTEGRATION: Self-damage tool registrations', () => {
  it('locator orb (22081) should self-damage 10 and floor at 1 HP', () => {
    const def = ITEM_ACTIONS[22081];
    expect(def).toBeDefined();
    expect(def.track).toBeUndefined();
    expect(def.delayTicks).toBeUndefined();
    expect(def.consume).toEqual({ type: 'none' });
    expect(def.effects).toEqual([{ op: 'self_damage', amount: 10 }]);

    const at99 = applyEffects(def.effects, createTestState({ playerHP: 99 }));
    const at5 = applyEffects(def.effects, createTestState({ playerHP: 5 }));
    expect(at99.playerHP).toBe(89);
    expect(at5.playerHP).toBe(1);
  });

  it('dwarven rock cake (7510) should self-damage 1 and floor at 1 HP', () => {
    const def = ITEM_ACTIONS[7510];
    expect(def).toBeDefined();
    expect(def.track).toBeUndefined();
    expect(def.delayTicks).toBeUndefined();
    expect(def.consume).toEqual({ type: 'none' });
    expect(def.effects).toEqual([{ op: 'self_damage', amount: 1 }]);

    const at99 = applyEffects(def.effects, createTestState({ playerHP: 99 }));
    const at1 = applyEffects(def.effects, createTestState({ playerHP: 1 }));
    expect(at99.playerHP).toBe(98);
    expect(at1.playerHP).toBe(1);
  });
});

describe('INTEGRATION: Weapon category mappings', () => {
  it('maps weapon categories and leaves the wrong elder maul id unmapped', () => {
    expect(ITEM_WEAPON_CATEGORY[27676]).toBe('staff');
    expect(ITEM_WEAPON_CATEGORY[27679]).toBe('staff');
    expect(ITEM_WEAPON_CATEGORY[29577]).toBe('claw');
    expect(ITEM_WEAPON_CATEGORY[21003]).toBe('blunt');
    expect(ITEM_WEAPON_CATEGORY[24617]).toBeUndefined();
    expect(ITEM_WEAPON_CATEGORY[30759]).toBe('spiked');
    expect(ITEM_WEAPON_CATEGORY[29591]).toBe('bow');
    expect(ITEM_WEAPON_CATEGORY[27690]).toBe('slash_sword');
    expect(ITEM_WEAPON_CATEGORY[28810]).toBe('axe');
  });
});

describe('edge cases', () => {
  it('should handle empty inventory slot access', () => {
    const inventory: Inventory = [null, null, null];
    const policy: ConsumePolicy = { type: 'remove' };

    const result = consumeItem(inventory, 0, policy);

    expect(result[0]).toBe(null);
  });

  it('should handle consecutive cooldown applications', () => {
    let tracks: CooldownTrackState = { food: 0, potion: 0, combo_food: 0 };

    tracks = applyCooldown(tracks, 'food', 10, 3);
    tracks = applyCooldown(tracks, 'potion', 10, 3);

    expect(tracks.food).toBe(13);
    expect(tracks.potion).toBe(13);
  });

  it('should handle healing at full HP (no change)', () => {
    const state = createTestState({ playerHP: 99, maxHP: 99 });
    const effects: EffectOp[] = [{ op: 'heal', amount: 20 }];

    const result = applyEffects(effects, state);

    expect(result.playerHP).toBe(99);
  });
});

describe('INTEGRATION: Food consumption bugs', () => {
  it('moonlight antelope should remove item from inventory, not create noted item', () => {
    const inventory = createTestInventory([29143, null, null]);
    const policy: ConsumePolicy = { type: 'remove' };

    const result = consumeItem(inventory, 0, policy);

    expect(result[0]).toBe(null);
  });

  it('moonlight antelope should heal immediate portion on same tick', () => {
    const state = createTestState({ playerHP: 50, maxHP: 99 });

    const effects = ITEM_ACTIONS[29143]?.effects;
    expect(effects).toBeDefined();

    // Eat moonlight antelope: 14 immediate + delayed 12 after 7 ticks
    const result = applyEffects(effects ?? [], state);

    expect(result.playerHP).toBe(64);
    expect(result.activeEffects).toHaveLength(1);
    expect(result.activeEffects[0].type).toBe('delayed_heal');
    expect(result.activeEffects[0].ticksRemaining).toBe(7);
  });

  it('moonlight antelope should cap immediate heal at maxHP', () => {
    const state = createTestState({ playerHP: 90, maxHP: 99 });

    const effects = ITEM_ACTIONS[29143]?.effects;
    expect(effects).toBeDefined();

    const result = applyEffects(effects, state);

    expect(result.playerHP).toBe(99);
  });

  it('anglerfish should overheal above maxHP', () => {
    const state = createTestState({ playerHP: 99, maxHP: 99 });

    // Eat anglerfish (OSRS wiki formula: floor(x/10) + 2*floor(x/25) + 5*floor(x/93) + 2)
    // At level 99: floor(9.9) + 2*floor(3.96) + 5*floor(1.064) + 2 = 9 + 6 + 5 + 2 = 22
    // Overheal cap = maxHP + heal = 99 + 22 = 121
    const effects: EffectOp[] = [{ op: 'heal_formula', baseAmount: 3, scaleStat: 'hitpoints' }];
    const result = applyEffects(effects, state);

    expect(result.playerHP).toBe(121);
  });
});

describe('INTEGRATION: Potion dose bugs', () => {
  it('sanfew serum (4) should become (3) after drinking, not fully consumed', () => {
    const sanfew4Dose = 10925;
    const sanfew3Dose = 10927;
    const inventory = createTestInventory([sanfew4Dose, null, null]);
    const policy: ConsumePolicy = { type: 'replace', withId: sanfew3Dose };

    const result = consumeItem(inventory, 0, policy);

    expect(result[0]).toEqual({ id: sanfew3Dose });
  });

  it('sanfew serum dose chain should reach vial at final dose', () => {
    const sanfew1Dose = 10931;
    const emptyVial = 229;
    const inventory = createTestInventory([sanfew1Dose, null, null]);
    const policy: ConsumePolicy = { type: 'replace', withId: emptyVial };

    const result = consumeItem(inventory, 0, policy);

    expect(result[0]).toEqual({ id: emptyVial });
  });
});

describe('applyEffectOp - saturated_heart operation', () => {
  it('should boost magic by 4 + floor(max * 0.1) at level 99', () => {
    const state = createTestState();
    const op: EffectOp = { op: 'saturated_heart' };

    const result = applyEffectOp(op, state);

    // At 99 magic: 4 + floor(99 * 0.1) = 4 + 9 = 13
    expect(result.stats.magic.current).toBe(112);
    expect(result.stats.magic.max).toBe(99);
  });

  it('should lock Magic decay for 500 ticks under its own source', () => {
    const state = createTestState();
    const op: EffectOp = { op: 'saturated_heart' };

    const result = applyEffectOp(op, state);

    expect(result.combatTimers.statDecayLocks).toEqual({ magic: { ticksRemaining: 500, source: 'saturated_heart' } });
  });

  it('should set saturatedHeartCooldownTicks to 500', () => {
    const state = createTestState();
    const op: EffectOp = { op: 'saturated_heart' };

    const result = applyEffectOp(op, state);

    expect(result.combatTimers.saturatedHeartCooldownTicks).toBe(500);
  });

  it('should return state unchanged when heart is on cooldown', () => {
    const state = createTestState({
      combatTimers: {
        ...createTestState().combatTimers,
        saturatedHeartCooldownTicks: 100,
      },
    });
    const op: EffectOp = { op: 'saturated_heart' };

    const result = applyEffectOp(op, state);

    expect(result).toBe(state);
    expect(result.stats.magic.current).toBe(99);
    expect(result.combatTimers.statDecayLocks).toEqual({});
  });

  it.each([
    [50, 63], // a drained Magic rises by the full 13
    [105, 112],
    [120, 120], // a bigger boost is kept
  ])('should lift Magic %i to %i like any other boost', (current, expected) => {
    const state = createTestState();
    state.stats.magic.current = current;

    const result = applyEffectOp({ op: 'saturated_heart' }, state);

    expect(result.stats.magic.current).toBe(expected);
    expect(result.combatTimers.statDecayLocks.magic?.source).toBe('saturated_heart');
  });

  it('should calculate correct boost at lower magic levels', () => {
    const stats = createTestState().stats;
    stats.magic = { current: 75, max: 75 };
    const state = createTestState({ stats });
    const op: EffectOp = { op: 'saturated_heart' };

    const result = applyEffectOp(op, state);

    // At 75 magic: 4 + floor(75 * 0.1) = 4 + 7 = 11
    expect(result.stats.magic.current).toBe(86);
  });

  it('should not mutate original state', () => {
    const state = createTestState();
    const op: EffectOp = { op: 'saturated_heart' };

    applyEffectOp(op, state);

    expect(state.stats.magic.current).toBe(99);
    expect(state.combatTimers.saturatedHeartCooldownTicks).toBe(0);
    expect(state.combatTimers.statDecayLocks).toEqual({});
  });
});

describe('INTEGRATION: Saturated Heart item action', () => {
  it('should be registered in ITEM_ACTIONS with ID 27641', () => {
    const def = ITEM_ACTIONS[27641];
    expect(def).toBeDefined();
    expect(def.track).toBe('potion');
    expect(def.consume.type).toBe('none');
    expect(def.effects).toEqual([{ op: 'saturated_heart' }]);
  });

  it('should have delayTicks 0 (bypasses track cooldown system)', () => {
    const def = ITEM_ACTIONS[27641];
    expect(def.delayTicks).toBe(0);
  });

  it('should have playerGraphic set to 2287 (Invigorate spotanim)', () => {
    const def = ITEM_ACTIONS[27641];
    expect(def.playerGraphic).toBe(2287);
  });

  it('should apply full heart effect via applyEffects', () => {
    const state = createTestState();
    const def = ITEM_ACTIONS[27641];

    const result = applyEffects(def.effects, state);

    expect(result.stats.magic.current).toBe(112);
    expect(result.combatTimers.statDecayLocks.magic).toEqual({ ticksRemaining: 500, source: 'saturated_heart' });
    expect(result.combatTimers.saturatedHeartCooldownTicks).toBe(500);
  });

  it('should not consume the item (type: none)', () => {
    const inventory = createTestInventory([27641, null, null]);

    const result = consumeItem(inventory, 0, ITEM_ACTIONS[27641].consume);

    expect(result[0]).toEqual({ id: 27641 });
  });
});

describe('COMBO EATING: priority-ordered cooldown tracks', () => {
  function tryConsume(current: ItemActionState, def: ItemActionDef): { state: ItemActionState; applied: boolean } {
    const { track, delayTicks } = def;
    if (track === undefined) {
      // Trackless items (locator orb, rock cake) never block and never set a cooldown.
      return { state: applyEffects(def.effects, current), applied: true };
    }
    if (!canUseAction(current.cooldownTracks, track, current.currentTick)) {
      return { state: current, applied: false };
    }
    let next = applyEffects(def.effects, current);
    next = {
      ...next,
      cooldownTracks: applyCooldown(next.cooldownTracks, track, next.currentTick, delayTicks),
    };
    return { state: next, applied: true };
  }

  describe('applyCooldown monotonic behavior', () => {
    it('should not shorten an existing longer cooldown', () => {
      const tracks: CooldownTrackState = { food: 20, potion: 0, combo_food: 0 };
      const result = applyCooldown(tracks, 'food', 10, 3);
      expect(result.food).toBe(20);
    });

    it('should extend cooldown when new value is larger', () => {
      const tracks: CooldownTrackState = { food: 5, potion: 0, combo_food: 0 };
      const result = applyCooldown(tracks, 'food', 10, 3);
      expect(result.food).toBe(13);
    });
  });

  describe('canUseAction right-side blocking', () => {
    it('food is blocked when potion track is on cooldown', () => {
      const tracks: CooldownTrackState = { food: 0, potion: 13, combo_food: 0 };
      expect(canUseAction(tracks, 'food', 10)).toBe(false);
    });

    it('food is blocked when combo_food track is on cooldown', () => {
      const tracks: CooldownTrackState = { food: 0, potion: 0, combo_food: 13 };
      expect(canUseAction(tracks, 'food', 10)).toBe(false);
    });

    it('potion is blocked when combo_food track is on cooldown', () => {
      const tracks: CooldownTrackState = { food: 0, potion: 0, combo_food: 13 };
      expect(canUseAction(tracks, 'potion', 10)).toBe(false);
    });

    it('combo_food is NOT blocked by food or potion cooldowns', () => {
      const tracks: CooldownTrackState = { food: 13, potion: 13, combo_food: 0 };
      expect(canUseAction(tracks, 'combo_food', 10)).toBe(true);
    });

    it('potion is NOT blocked by food cooldown', () => {
      const tracks: CooldownTrackState = { food: 13, potion: 0, combo_food: 0 };
      expect(canUseAction(tracks, 'potion', 10)).toBe(true);
    });

    it('all tracks available when no cooldowns', () => {
      const tracks: CooldownTrackState = { food: 0, potion: 0, combo_food: 0 };
      expect(canUseAction(tracks, 'food', 10)).toBe(true);
      expect(canUseAction(tracks, 'potion', 10)).toBe(true);
      expect(canUseAction(tracks, 'combo_food', 10)).toBe(true);
    });

    it('all tracks available when cooldowns have expired', () => {
      const tracks: CooldownTrackState = { food: 10, potion: 10, combo_food: 10 };
      expect(canUseAction(tracks, 'food', 10)).toBe(true);
      expect(canUseAction(tracks, 'potion', 10)).toBe(true);
      expect(canUseAction(tracks, 'combo_food', 10)).toBe(true);
    });
  });

  describe('item registration', () => {
    it('karambwan should be on combo_food track', () => {
      const def = ITEM_ACTIONS[3144];
      expect(def).toBeDefined();
      expect(def.track).toBe('combo_food');
      expect(def.delayTicks).toBe(3);
      expect(def.effects).toEqual([{ op: 'heal', amount: 18 }]);
    });

    it('sanfew serum effects include poison cure', () => {
      const sanfew = ITEM_ACTIONS[10925];
      const ops = sanfew.effects.map((e) => e.op);
      expect(ops).toEqual(['restore_all_stats', 'restore_prayer_formula', 'cure_poison']);
    });

    it('saturated heart effects are saturated_heart only', () => {
      const heart = ITEM_ACTIONS[27641];
      const ops = heart.effects.map((e) => e.op);
      expect(ops).toEqual(['saturated_heart']);
    });
  });

  describe('combo eating order simulation', () => {
    it('food → potion → combo_food: all three apply same tick', () => {
      const state = createTestState({ playerHP: 50, currentTick: 10 });
      const foodDef = ITEM_ACTIONS[29143]; // moonlight antelope
      const potionDef = ITEM_ACTIONS[10925]; // sanfew serum
      const comboDef = ITEM_ACTIONS[3144]; // karambwan

      const r1 = tryConsume(state, foodDef);
      expect(r1.applied).toBe(true);

      const r2 = tryConsume(r1.state, potionDef);
      expect(r2.applied).toBe(true);

      const r3 = tryConsume(r2.state, comboDef);
      expect(r3.applied).toBe(true);

      // HP: 50 + 14 (antelope) + 18 (karambwan) = 82
      expect(r3.state.playerHP).toBe(82);
      expect(r3.state.cooldownTracks.food).toBe(13);
      expect(r3.state.cooldownTracks.potion).toBe(13);
      expect(r3.state.cooldownTracks.combo_food).toBe(13);
    });

    it('food → potion: both apply', () => {
      const state = createTestState({ playerHP: 50, currentTick: 10 });
      const foodDef = ITEM_ACTIONS[29143];
      const potionDef = ITEM_ACTIONS[10925];

      const r1 = tryConsume(state, foodDef);
      expect(r1.applied).toBe(true);

      const r2 = tryConsume(r1.state, potionDef);
      expect(r2.applied).toBe(true);

      expect(r2.state.playerHP).toBe(64);
      expect(r2.state.cooldownTracks.food).toBe(13);
      expect(r2.state.cooldownTracks.potion).toBe(13);
    });

    it('food → combo_food: both apply (no potion needed)', () => {
      const state = createTestState({ playerHP: 50, currentTick: 10 });
      const foodDef = ITEM_ACTIONS[29143];
      const comboDef = ITEM_ACTIONS[3144];

      const r1 = tryConsume(state, foodDef);
      expect(r1.applied).toBe(true);

      const r2 = tryConsume(r1.state, comboDef);
      expect(r2.applied).toBe(true);

      expect(r2.state.playerHP).toBe(82);
    });

    it('potion → food: food is BLOCKED (potion to the right is on cooldown)', () => {
      const state = createTestState({ playerHP: 50, currentTick: 10 });
      const foodDef = ITEM_ACTIONS[29143];
      const potionDef = ITEM_ACTIONS[10925];

      const r1 = tryConsume(state, potionDef);
      expect(r1.applied).toBe(true);

      const r2 = tryConsume(r1.state, foodDef);
      expect(r2.applied).toBe(false);
      expect(r2.state.playerHP).toBe(50);
    });

    it('combo_food → food: food is BLOCKED', () => {
      const state = createTestState({ playerHP: 50, currentTick: 10 });
      const foodDef = ITEM_ACTIONS[29143];
      const comboDef = ITEM_ACTIONS[3144];

      const r1 = tryConsume(state, comboDef);
      expect(r1.applied).toBe(true);

      const r2 = tryConsume(r1.state, foodDef);
      expect(r2.applied).toBe(false);
    });

    it('combo_food → potion: potion is BLOCKED', () => {
      const state = createTestState({ currentTick: 10 });
      const potionDef = ITEM_ACTIONS[10925];
      const comboDef = ITEM_ACTIONS[3144];

      const r1 = tryConsume(state, comboDef);
      expect(r1.applied).toBe(true);

      const r2 = tryConsume(r1.state, potionDef);
      expect(r2.applied).toBe(false);
    });

    it('two foods same tick: second is BLOCKED by own track', () => {
      const state = createTestState({ playerHP: 50, currentTick: 10 });
      const foodDef = ITEM_ACTIONS[29143];

      const r1 = tryConsume(state, foodDef);
      expect(r1.applied).toBe(true);

      const r2 = tryConsume(r1.state, foodDef);
      expect(r2.applied).toBe(false);
    });

    it('two potions same tick: second is BLOCKED by own track', () => {
      const state = createTestState({ currentTick: 10 });
      const potionDef = ITEM_ACTIONS[10925];

      const r1 = tryConsume(state, potionDef);
      expect(r1.applied).toBe(true);

      const r2 = tryConsume(r1.state, potionDef);
      expect(r2.applied).toBe(false);
    });

    it('two combo foods same tick: second is BLOCKED by own track', () => {
      const state = createTestState({ playerHP: 50, currentTick: 10 });
      const comboDef = ITEM_ACTIONS[3144];

      const r1 = tryConsume(state, comboDef);
      expect(r1.applied).toBe(true);

      const r2 = tryConsume(r1.state, comboDef);
      expect(r2.applied).toBe(false);
    });

    it('potion → combo_food: combo_food applies (potion is to the left)', () => {
      const state = createTestState({ playerHP: 50, currentTick: 10 });
      const potionDef = ITEM_ACTIONS[10925];
      const comboDef = ITEM_ACTIONS[3144];

      const r1 = tryConsume(state, potionDef);
      expect(r1.applied).toBe(true);

      const r2 = tryConsume(r1.state, comboDef);
      expect(r2.applied).toBe(true);
      expect(r2.state.playerHP).toBe(68);
    });
  });
});

describe('ATTACK_DELAY_BY_TRACK / getAttackDelayForTrack', () => {
  // OSRS Wiki (https://oldschool.runescape.wiki/w/Food/Fast_foods):
  //   - Standard food adds 3 ticks of attack delay
  //   - Fast / combo food (karambwan, halibut, gnome foods) adds 2 ticks
  //   - Potions do not incur the standard 3 tick attack or eat delay (0)

  it('exposes 3 ticks for the food track', () => {
    expect(ATTACK_DELAY_BY_TRACK.food).toBe(3);
    expect(getAttackDelayForTrack('food')).toBe(3);
  });

  it('exposes 2 ticks for the combo_food track (karambwan / halibut / gnome)', () => {
    expect(ATTACK_DELAY_BY_TRACK.combo_food).toBe(2);
    expect(getAttackDelayForTrack('combo_food')).toBe(2);
  });

  it('exposes 0 ticks for the potion track', () => {
    expect(ATTACK_DELAY_BY_TRACK.potion).toBe(0);
    expect(getAttackDelayForTrack('potion')).toBe(0);
  });

  it('returns the same value for every item on a track (universal-per-track)', () => {
    // The architectural guarantee: adding a new food never requires tagging it
    // with an attack delay — just pick a track.
    const knownIds = {
      // The locator orb and rock cake are deliberately absent: they are inventory options,
      // not food, and carry no track at all.
      food: [13441, 29143], // anglerfish, antelope
      combo_food: [3144], // cooked karambwan
      potion: [10925, 27641, 6685, 12695, 27629], // sanfew, sat heart, sara brew, super combat, forgotten brew
    } as const;

    for (const id of knownIds.food) {
      const track = ITEM_ACTIONS[id]?.track;
      expect(track).toBe('food');
      expect(getAttackDelayForTrack('food')).toBe(3);
    }
    for (const id of knownIds.combo_food) {
      const track = ITEM_ACTIONS[id]?.track;
      expect(track).toBe('combo_food');
      expect(getAttackDelayForTrack('combo_food')).toBe(2);
    }
    for (const id of knownIds.potion) {
      const track = ITEM_ACTIONS[id]?.track;
      expect(track).toBe('potion');
      expect(getAttackDelayForTrack('potion')).toBe(0);
    }
  });
});

describe('SimulationEngine vial smasher', () => {
  it('removes an empty vial replacement when enabled', () => {
    const engine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: PLAYER_START_POS });
    engine.setMechanicsConfig({
      yamaMageRange: false,
      yamaMelee: false,
      waves: false,
      fireballs: false,
      infiniteHealth: true,
      vialSmasher: true,
    });
    engine.setInventory([{ id: 10931 }]);

    engine.applyAction({ type: 'itemAction', inventoryIndex: 0 });
    engine.advanceTick(PLAYER_START_POS);

    expect(engine.getState().inventory[0]).toBeNull();
  });

  it('keeps an empty vial replacement when disabled', () => {
    const engine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: PLAYER_START_POS });
    engine.setMechanicsConfig({
      yamaMageRange: false,
      yamaMelee: false,
      waves: false,
      fireballs: false,
      infiniteHealth: true,
      vialSmasher: false,
    });
    engine.setInventory([{ id: 10931 }]);

    engine.applyAction({ type: 'itemAction', inventoryIndex: 0 });
    engine.advanceTick(PLAYER_START_POS);

    expect(engine.getState().inventory[0]).toEqual({ id: 229 });
  });
});

describe('SimulationEngine surge potion', () => {
  const startEngine = (energy: number) => {
    const engine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: PLAYER_START_POS });
    engine.setMechanicsConfig({
      yamaMageRange: false,
      yamaMelee: false,
      waves: false,
      fireballs: false,
      infiniteHealth: true,
    });
    engine.setInventory([{ id: 30875 }]);
    engine['worldState'].getPlayer()!.specialAttack = { energy, regenTickCounter: 50, lightbearerEquipped: false };
    return engine;
  };
  const drink = (engine: SimulationEngine) => {
    engine.applyAction({ type: 'itemAction', inventoryIndex: 0 });
    engine.advanceTick(PLAYER_START_POS);
  };

  it('drinks a dose for 25% energy, then refuses the next without using it', () => {
    const engine = startEngine(40);
    drink(engine);
    expect(engine.getState().specialAttack.energy).toBe(65);
    expect(engine.getState().inventory[0]).toEqual({ id: 30878 });

    // Past the 3-tick potion delay, still inside the surge potion's own five minutes.
    for (let i = 0; i < 5; i++) engine.advanceTick(PLAYER_START_POS);
    drink(engine);
    expect(engine.getState().specialAttack.energy).toBe(65);
    expect(engine.getState().inventory[0]).toEqual({ id: 30878 });
  });

  it('keeps the dose at full special attack energy', () => {
    const engine = startEngine(100);
    drink(engine);
    expect(engine.getState().inventory[0]).toEqual({ id: 30875 });
  });
});

describe('SimulationEngine locator orb and rock cake', () => {
  const startEngine = (itemId: number) => {
    const engine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: PLAYER_START_POS });
    engine.setMechanicsConfig({
      yamaMageRange: false,
      yamaMelee: false,
      waves: false,
      fireballs: false,
      voidFlares: false,
    });
    engine.setInventory([{ id: itemId }]);
    return engine;
  };

  it.each([
    [99, 89],
    [20, 17],
    [19, 17],
    [3, 2],
    [2, 1],
    [1, 1],
  ])('guzzles rock cake at %i HP to leave %i HP', (hp, expectedHp) => {
    const engine = startEngine(7510);
    const player = engine['worldState'].getPlayer();
    if (!player) throw new TypeError('Missing player actor');
    player.vitals.hp = hp;

    engine.applyAction({ type: 'itemAction', inventoryIndex: 0, option: 'guzzle' });
    engine.advanceTick(PLAYER_START_POS);

    expect(engine.getState().playerHP).toBe(expectedHp);
    expect(engine.getState().inventory[0]).toEqual({ id: 7510 });
    expect(engine.getLastTickEvents()).toContainEqual(
      expect.objectContaining({
        type: 'hitsplat_spawned',
        targetId: 'player',
        amount: hp - expectedHp,
        hitsplatType: hp === expectedHp ? 'block' : 'damage',
      }),
    );
  });

  it.each([1, 2])('does not eat rock cake or emit a hit at %i HP', (hp) => {
    const engine = startEngine(7510);
    const player = engine['worldState'].getPlayer();
    if (!player) throw new TypeError('Missing player actor');
    player.vitals.hp = hp;

    engine.applyAction({ type: 'itemAction', inventoryIndex: 0 });
    engine.advanceTick(PLAYER_START_POS);

    expect(engine.getState().playerHP).toBe(hp);
    expect(engine.getLastTickEvents().filter((event) => event.type === 'hitsplat_spawned')).toEqual([]);
  });

  it('limits guzzling to one use per tick and permits another on the next tick', () => {
    const engine = startEngine(7510);

    engine.applyAction({ type: 'itemAction', inventoryIndex: 0, option: 'guzzle' });
    engine.applyAction({ type: 'itemAction', inventoryIndex: 0, option: 'guzzle' });
    engine.advanceTick(PLAYER_START_POS);

    expect(engine.getState().playerHP).toBe(89);
    engine.applyAction({ type: 'itemAction', inventoryIndex: 0, option: 'guzzle' });
    engine.advanceTick(PLAYER_START_POS);
    expect(engine.getState().playerHP).toBe(80);
  });

  /**
   * These are inventory options, not food: no cooldown, so they are usable EVERY tick, but the
   * client sends one inventory option per tick and the capture agrees — nine orb uses, five of
   * them on consecutive ticks, never two on one.
   */
  it.each([
    [22081, 10],
    [7510, 1],
  ])('item %i self-damages %i once per tick, on consecutive ticks', (itemId, perUse) => {
    const engine = startEngine(itemId);
    const before = engine.getState().playerHP;

    for (let tick = 0; tick < 3; tick++) {
      engine.applyAction({ type: 'itemAction', inventoryIndex: 0 });
      engine.advanceTick(PLAYER_START_POS);
    }

    expect(engine.getState().playerHP).toBe(before - 3 * perUse);
    // "Feel" / "Guzzle" do not consume the item.
    expect(engine.getState().inventory[0]).toEqual({ id: itemId });
  });

  it('applies only ONE use when clicked several times in the same tick', () => {
    const engine = startEngine(22081);
    const before = engine.getState().playerHP;

    for (let i = 0; i < 4; i++) engine.applyAction({ type: 'itemAction', inventoryIndex: 0 });
    engine.advanceTick(PLAYER_START_POS);

    expect(engine.getState().playerHP).toBe(before - 10);
  });

  it('floors at 1 hitpoint and cannot kill', () => {
    const engine = startEngine(22081);
    for (let tick = 0; tick < 40; tick++) {
      engine.applyAction({ type: 'itemAction', inventoryIndex: 0 });
      engine.advanceTick(PLAYER_START_POS);
    }

    expect(engine.getState().playerHP).toBe(1);
  });

  it('takes no cooldown track and adds no attack delay', () => {
    for (const id of [22081, 7510]) {
      expect(ITEM_ACTIONS[id].track).toBeUndefined();
      expect(ITEM_ACTIONS[id].delayTicks).toBeUndefined();
      // The capture shows nine orb uses with a hitsplat and the spam message, nothing else.
      expect(ITEM_ACTIONS[id].playerGraphic).toBeUndefined();
    }
  });
});

describe('SimulationEngine divine potion self-damage hitsplat', () => {
  it('emits a damage hitsplat when drinking a divine potion (shows overhead hp bar)', () => {
    const engine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: PLAYER_START_POS });
    engine.setMechanicsConfig({ yamaMageRange: false, yamaMelee: false, waves: false, fireballs: false });
    engine.setInventory([{ id: 23685 }]); // Divine super combat (4)

    const hpBefore = engine.getState().playerHP;
    engine.applyAction({ type: 'itemAction', inventoryIndex: 0 });
    engine.advanceTick(PLAYER_START_POS);

    const hitsplats = engine.getLastTickEvents().filter((event) => event.type === 'hitsplat_spawned');
    expect(hitsplats).toContainEqual(
      expect.objectContaining({
        type: 'hitsplat_spawned',
        targetId: 'player',
        amount: 10,
        hitsplatType: 'damage',
      }),
    );
    expect(engine.getState().playerHP).toBe(hpBefore - 10);
  });

  it('does not emit a hitsplat for non-self-damage consumables', () => {
    const engine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: PLAYER_START_POS });
    engine.setMechanicsConfig({ yamaMageRange: false, yamaMelee: false, waves: false, fireballs: false });
    engine.setInventory([{ id: 2434 }]); // Prayer potion (4)

    engine.applyAction({ type: 'itemAction', inventoryIndex: 0 });
    engine.advanceTick(PLAYER_START_POS);

    const hitsplats = engine.getLastTickEvents().filter((event) => event.type === 'hitsplat_spawned');
    expect(hitsplats).toEqual([]);
  });
});
