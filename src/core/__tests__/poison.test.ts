import { describe, expect, it } from 'vitest';
import { type EffectOp, getPrepotEffects, ITEM_ACTIONS, isPrepottable } from '../../data/itemEffects';
import type { PoisonState } from '../../types/playerState';
import { createDefaultPoisonState, createDefaultStats, POISON_TICK_INTERVAL } from '../../types/playerState';
import { createDefaultPrayerState } from '../../types/simulation';
import { applyEffectOp, applyEffects, type ItemActionState } from '../itemActions';
import { applyPlayerPoison, VENOM_IMMUNITY_CUTOFF, VENOM_THRESHOLD } from '../poison';
import { tickPoisonState } from '../timers';

function createPoisonState(overrides: Partial<PoisonState> = {}): PoisonState {
  return { ...createDefaultPoisonState(), ...overrides };
}

function createTestState(overrides: Partial<ItemActionState> = {}): ItemActionState {
  return {
    playerHP: 99,
    maxHP: 99,
    stats: createDefaultStats(),
    poisonState: createDefaultPoisonState(),
    prayerState: createDefaultPrayerState(),
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
    currentTick: 0,
    ...overrides,
  };
}

describe('Poison/Venom System', () => {
  describe('tickPoisonState', () => {
    it('returns zero damage and unchanged state when not poisoned', () => {
      const state = createPoisonState({ poisonVarp: 0, poisonTickCounter: 17 });

      const result = tickPoisonState(state);

      expect(result.damage).toBe(0);
      expect(result.state).toEqual(state);
      expect(result.state).not.toBe(state);
    });

    it('uses the correct poison damage formula across boundaries', () => {
      expect(tickPoisonState(createPoisonState({ poisonVarp: 1 })).damage).toBe(1);
      expect(tickPoisonState(createPoisonState({ poisonVarp: 5 })).damage).toBe(1);
      expect(tickPoisonState(createPoisonState({ poisonVarp: 6 })).damage).toBe(2);
      expect(tickPoisonState(createPoisonState({ poisonVarp: 20 })).damage).toBe(4);
      expect(tickPoisonState(createPoisonState({ poisonVarp: 30 })).damage).toBe(6);
      expect(tickPoisonState(createPoisonState({ poisonVarp: 100 })).damage).toBe(20);
    });

    it('decrements poison by one varp each tick', () => {
      expect(tickPoisonState(createPoisonState({ poisonVarp: 10 })).state.poisonVarp).toBe(9);
      expect(tickPoisonState(createPoisonState({ poisonVarp: 1 })).state.poisonVarp).toBe(0);
    });

    it('naturally cures poison at varp 1 after dealing 1 damage', () => {
      const result = tickPoisonState(createPoisonState({ poisonVarp: 1 }));

      expect(result.damage).toBe(1);
      expect(result.state.poisonVarp).toBe(0);
    });

    it('uses the correct venom damage formula including cap', () => {
      expect(tickPoisonState(createPoisonState({ poisonVarp: 1_000_000 })).damage).toBe(6);
      expect(tickPoisonState(createPoisonState({ poisonVarp: 1_000_001 })).damage).toBe(8);
      expect(tickPoisonState(createPoisonState({ poisonVarp: 1_000_004 })).damage).toBe(14);
      expect(tickPoisonState(createPoisonState({ poisonVarp: 1_000_007 })).damage).toBe(20);
      expect(tickPoisonState(createPoisonState({ poisonVarp: 1_000_010 })).damage).toBe(20);
    });

    it('increments venom severity by one varp each tick', () => {
      const result = tickPoisonState(createPoisonState({ poisonVarp: 1_000_000 }));

      expect(result.damage).toBe(6);
      expect(result.state.poisonVarp).toBe(1_000_001);
    });

    it('never lets venom self-cure even after many ticks', () => {
      let state = createPoisonState({ poisonVarp: 1_000_000 });

      for (let i = 0; i < 50; i += 1) {
        state = tickPoisonState(state).state;
      }

      expect(state.poisonVarp).toBeGreaterThanOrEqual(1_000_000);
    });

    it('counts immunity down toward zero', () => {
      const result = tickPoisonState(createPoisonState({ poisonVarp: -20 }));

      expect(result.damage).toBe(0);
      expect(result.state.poisonVarp).toBe(-19);
    });

    it('expires immunity from -1 to 0', () => {
      const result = tickPoisonState(createPoisonState({ poisonVarp: -1 }));

      expect(result.damage).toBe(0);
      expect(result.state.poisonVarp).toBe(0);
    });

    it('never lets immunity go positive', () => {
      const result = tickPoisonState(createPoisonState({ poisonVarp: -1 }));

      expect(result.state.poisonVarp).toBe(0);
      expect(result.state.poisonVarp).toBe(Math.min(0, -1 + 1));
    });
  });

  describe('cure_poison effect', () => {
    it('cures active poison and grants immunity', () => {
      const state = createTestState({ poisonState: createPoisonState({ poisonVarp: 50 }) });
      const op: EffectOp = { op: 'cure_poison', immunitySteps: 20 };

      const result = applyEffectOp(op, state);

      expect(result.poisonState.poisonVarp).toBe(-20);
    });

    it('grants immunity when not poisoned', () => {
      const state = createTestState({ poisonState: createPoisonState({ poisonVarp: 0 }) });
      const op: EffectOp = { op: 'cure_poison', immunitySteps: 20 };

      const result = applyEffectOp(op, state);

      expect(result.poisonState.poisonVarp).toBe(-20);
    });

    it('replaces shorter immunity with the cure immunity duration', () => {
      const state = createTestState({ poisonState: createPoisonState({ poisonVarp: -5 }) });
      const op: EffectOp = { op: 'cure_poison', immunitySteps: 20 };

      const result = applyEffectOp(op, state);

      expect(result.poisonState.poisonVarp).toBe(-20);
    });

    it('only converts venom to poison at the same damage, and a second dose cures it', () => {
      const state = createTestState({
        poisonState: createPoisonState({ poisonVarp: 1_000_004, poisonTickCounter: 7 }),
        currentTick: 50,
      });
      const op: EffectOp = { op: 'cure_poison', immunitySteps: 20 };

      const first = applyEffectOp(op, state);

      expect(first.poisonState).toEqual({ poisonVarp: 70, poisonTickCounter: 7, startedTick: null });
      expect(Math.ceil(first.poisonState.poisonVarp / 5)).toBe(14);
      expect(applyEffectOp(op, first).poisonState.poisonVarp).toBe(-20);
    });

    it('creates an immune state that blocks future poison application attempts', () => {
      const state = createTestState();
      const result = applyEffectOp({ op: 'cure_poison', immunitySteps: 20 }, state);

      expect(result.poisonState.poisonVarp).toBeLessThan(0);
      expect(applyPlayerPoison(result.poisonState, 5, undefined, 1)).toBe(result.poisonState);
    });
  });

  describe('each poison cure on a clean, a poisoned and an envenomed player', () => {
    // Venom 1_000_004 hits 14 next, so an antipoison leaves poison 70 (ceil(70 / 5) = 14).
    it.each([
      ['Sanfew serum', 10925, -20, -20, 70],
      ['Antidote++', 5952, -40, -40, 70],
      ['Anti-venom', 12905, -41, -41, -41],
      ['Anti-venom+', 12913, -50, -50, -50],
      ['Extended anti-venom+', 29824, -59, -59, -59],
    ])('%s (%i): clean -> %i, poisoned -> %i, envenomed -> %i', (_name, itemId, clean, poisoned, envenomed) => {
      const drink = (poisonVarp: number) =>
        applyEffects(ITEM_ACTIONS[itemId].effects, createTestState({ poisonState: createPoisonState({ poisonVarp }) }))
          .poisonState.poisonVarp;

      expect([drink(0), drink(50), drink(1_000_004)]).toEqual([clean, poisoned, envenomed]);
    });

    it('leaves the wiki venom immunities as steps below the cutoff', () => {
      const venomImmuneSteps = (itemId: number) =>
        Math.max(
          0,
          VENOM_IMMUNITY_CUTOFF - applyEffects(ITEM_ACTIONS[itemId].effects, createTestState()).poisonState.poisonVarp,
        );

      // 18 s each: Sanfew none, Antidote++ 36 s, anti-venom 54 s, anti-venom+ 216 s, extended 378 s.
      expect([10925, 5952, 12905, 12913, 29824].map(venomImmuneSteps)).toEqual([0, 2, 3, 12, 21]);
    });
  });

  describe('a cure under a stronger immunity', () => {
    it.each([
      ['Sanfew serum at anti-venom+ immunity', { op: 'cure_poison', immunitySteps: 20 }, -50],
      ['Antidote++ at anti-venom+ immunity', { op: 'cure_poison', immunitySteps: 40 }, -50],
      ['anti-venom at extended anti-venom+ immunity', { op: 'cure_venom', immunitySteps: 41 }, -59],
      // Owner-approved policy: a weaker potion leaves a longer running immunity alone.
      ['anti-venom+ at a running extended anti-venom+ immunity', { op: 'cure_venom', immunitySteps: 50 }, -55],
    ] as const)('%s keeps it, and its countdown', (_name, op, poisonVarp) => {
      const state = createTestState({
        poisonState: createPoisonState({ poisonVarp, poisonTickCounter: 7, startedTick: 3 }),
        currentTick: 50,
      });

      const result = applyEffectOp(op, state);

      expect(result).toBe(state);
      expect(result.poisonState.poisonVarp < VENOM_IMMUNITY_CUTOFF).toBe(true);
    });

    it('keeps the running step clock when the immunity changes', () => {
      const state = createTestState({
        poisonState: createPoisonState({ poisonVarp: -39, poisonTickCounter: 7, startedTick: 3 }),
        currentTick: 50,
      });

      const result = applyEffectOp({ op: 'cure_venom', immunitySteps: 50 }, state);

      expect(result.poisonState).toEqual({ poisonVarp: -50, poisonTickCounter: 7, startedTick: 3 });
    });

    it('resets a running extended anti-venom+ immunity to full on a re-sip, keeping the step clock', () => {
      // Reported by the project owner from play: a re-sip resets to -59. The clock's phase holds across
      // a drink (private gameplay capture zulrah-packet-data-2.txt, sip t3222, next step t3232).
      const state = createTestState({
        poisonState: createPoisonState({ poisonVarp: -45, poisonTickCounter: 7, startedTick: 3 }),
        currentTick: 50,
      });

      const result = applyEffects(ITEM_ACTIONS[29824].effects, state);

      expect(result.poisonState).toEqual({ poisonVarp: -59, poisonTickCounter: 7, startedTick: 3 });
    });

    it('starts the step clock with a full cycle only from a clean counter', () => {
      const state = createTestState({
        poisonState: createPoisonState({ poisonVarp: 0, poisonTickCounter: 7, startedTick: 3 }),
        currentTick: 50,
      });

      const result = applyEffectOp({ op: 'cure_venom', immunitySteps: 50 }, state);

      expect(result.poisonState).toEqual({ poisonVarp: -50, poisonTickCounter: POISON_TICK_INTERVAL, startedTick: 50 });
    });
  });

  describe('applyPlayerPoison', () => {
    const TICK = 40;
    const fresh = { poisonTickCounter: POISON_TICK_INTERVAL, startedTick: TICK };
    const at = (poisonVarp: number) => createPoisonState({ poisonVarp, poisonTickCounter: 7, startedTick: 3 });

    it('refuses venom below the venom cutoff of -38', () => {
      const state = at(-39);

      expect(applyPlayerPoison(state, VENOM_THRESHOLD, undefined, TICK)).toBe(state);
    });

    it.each([-38, -1])('envenoms at %i, through poison-only immunity, on the running step clock', (poisonVarp) => {
      expect(applyPlayerPoison(at(poisonVarp), VENOM_THRESHOLD, undefined, TICK)).toEqual(at(VENOM_THRESHOLD));
    });

    it('envenoms from 0 with a full first cycle', () => {
      expect(applyPlayerPoison(at(0), VENOM_THRESHOLD, undefined, TICK)).toEqual({
        poisonVarp: VENOM_THRESHOLD,
        ...fresh,
      });
    });

    it('refuses poison under any immunity, and poisons from 0 with a full first cycle', () => {
      const state = at(-1);

      expect(applyPlayerPoison(state, 30, undefined, TICK)).toBe(state);
      expect(applyPlayerPoison(at(0), 30, undefined, TICK)).toEqual({ poisonVarp: 30, ...fresh });
    });

    it('upgrades a poison to venom without restarting its cycle, and keeps the greater poison', () => {
      expect(applyPlayerPoison(at(30), VENOM_THRESHOLD, undefined, TICK)).toEqual(at(VENOM_THRESHOLD));
      expect(applyPlayerPoison(at(30), 5, undefined, TICK)).toEqual(at(30));
    });

    it('leaves an existing venom alone', () => {
      const state = at(VENOM_THRESHOLD + 4);

      expect(applyPlayerPoison(state, VENOM_THRESHOLD, undefined, TICK)).toBe(state);
      expect(applyPlayerPoison(state, 30, undefined, TICK)).toBe(state);
    });

    it.each([12931, 13197, 13199])('blocks venom and poison while head %i is worn, without curing', (head) => {
      for (const poisonVarp of [0, -1, 30]) {
        const state = at(poisonVarp);
        expect(applyPlayerPoison(state, VENOM_THRESHOLD, head, TICK)).toBe(state);
        expect(applyPlayerPoison(state, 30, head, TICK)).toBe(state);
      }
    });

    it('lets poison and venom through an uncharged serpentine helm (12929)', () => {
      expect(applyPlayerPoison(at(0), VENOM_THRESHOLD, 12929, TICK).poisonVarp).toBe(VENOM_THRESHOLD);
      expect(applyPlayerPoison(at(0), 30, 12929, TICK).poisonVarp).toBe(30);
    });
  });

  describe('reduce_poison effect', () => {
    it('reduces poison severity by the requested amount', () => {
      const state = createTestState({ poisonState: createPoisonState({ poisonVarp: 50 }) });
      const op: EffectOp = { op: 'reduce_poison', amount: 1 };

      const result = applyEffectOp(op, state);

      expect(result.poisonState.poisonVarp).toBe(49);
    });

    it('reduces poison to zero when the amount exactly matches severity', () => {
      const state = createTestState({ poisonState: createPoisonState({ poisonVarp: 1 }) });

      const result = applyEffectOp({ op: 'reduce_poison', amount: 1 }, state);

      expect(result.poisonState.poisonVarp).toBe(0);
    });

    it('never reduces poison below zero', () => {
      const state = createTestState({ poisonState: createPoisonState({ poisonVarp: 1 }) });

      const result = applyEffectOp({ op: 'reduce_poison', amount: 5 }, state);

      expect(result.poisonState.poisonVarp).toBe(0);
    });

    it('is a no-op with the same reference when already cured', () => {
      const state = createTestState({ poisonState: createPoisonState({ poisonVarp: 0 }) });

      const result = applyEffectOp({ op: 'reduce_poison', amount: 1 }, state);

      expect(result).toBe(state);
    });

    it('is a no-op with the same reference when immune', () => {
      const state = createTestState({ poisonState: createPoisonState({ poisonVarp: -10 }) });

      const result = applyEffectOp({ op: 'reduce_poison', amount: 1 }, state);

      expect(result).toBe(state);
    });

    it('downgrades venom to poison before reducing', () => {
      const state = createTestState({ poisonState: createPoisonState({ poisonVarp: 1_000_000 }) });

      const result = applyEffectOp({ op: 'reduce_poison', amount: 1 }, state);

      expect(result.poisonState.poisonVarp).toBe(29);
      expect(Math.ceil(result.poisonState.poisonVarp / 5)).toBe(6);
    });
  });

  describe('venom-to-poison downgrade', () => {
    it('converts 1000000 venom to poison varp 30 with identical damage', () => {
      const state = createTestState({ poisonState: createPoisonState({ poisonVarp: 1_000_000 }) });

      const result = applyEffectOp({ op: 'reduce_poison', amount: 0 }, state);

      expect(result.poisonState.poisonVarp).toBe(30);
      expect(Math.ceil(result.poisonState.poisonVarp / 5)).toBe(6);
    });

    it('converts 1000003 venom to poison varp 60 with identical damage', () => {
      const state = createTestState({ poisonState: createPoisonState({ poisonVarp: 1_000_003 }) });

      const result = applyEffectOp({ op: 'reduce_poison', amount: 0 }, state);

      expect(result.poisonState.poisonVarp).toBe(60);
      expect(Math.ceil(result.poisonState.poisonVarp / 5)).toBe(12);
    });

    it('converts 1000007 venom to poison varp 100 with capped damage preserved', () => {
      const state = createTestState({ poisonState: createPoisonState({ poisonVarp: 1_000_007 }) });

      const result = applyEffectOp({ op: 'reduce_poison', amount: 0 }, state);

      expect(result.poisonState.poisonVarp).toBe(100);
      expect(Math.ceil(result.poisonState.poisonVarp / 5)).toBe(20);
    });

    it('keeps venom cap when converting values above the cap threshold', () => {
      const state = createTestState({ poisonState: createPoisonState({ poisonVarp: 1_000_010 }) });

      const result = applyEffectOp({ op: 'reduce_poison', amount: 0 }, state);

      expect(result.poisonState.poisonVarp).toBe(100);
      expect(Math.ceil(result.poisonState.poisonVarp / 5)).toBe(20);
    });
  });

  describe('PoisonState defaults', () => {
    it('creates the default poison state', () => {
      expect(createDefaultPoisonState()).toEqual({ poisonVarp: 0, poisonTickCounter: 30, startedTick: null });
      expect(createDefaultPoisonState().poisonTickCounter).toBe(POISON_TICK_INTERVAL);
    });
  });

  describe('prepot integration', () => {
    it('treats sanfew serum as prepottable because of cure_poison', () => {
      expect(isPrepottable(ITEM_ACTIONS[10925])).toBe(true);
      expect(getPrepotEffects(ITEM_ACTIONS[10925].effects)).toEqual([{ op: 'cure_poison', immunitySteps: 20 }]);
    });

    it('treats antidote++ as prepottable because of cure_poison', () => {
      expect(isPrepottable(ITEM_ACTIONS[5952])).toBe(true);
      expect(getPrepotEffects(ITEM_ACTIONS[5952].effects)).toEqual([{ op: 'cure_poison', immunitySteps: 40 }]);
    });

    it('treats the anti-venoms as prepottable because of cure_venom', () => {
      for (const itemId of [12905, 12913, 29824]) {
        expect(isPrepottable(ITEM_ACTIONS[itemId])).toBe(true);
        expect(getPrepotEffects(ITEM_ACTIONS[itemId].effects).map((effect) => effect.op)).toEqual(['cure_venom']);
      }
    });

    it('does not treat guthix rest as prepottable because reduce_poison is excluded', () => {
      expect(isPrepottable(ITEM_ACTIONS[4417])).toBe(false);
      expect(getPrepotEffects(ITEM_ACTIONS[4417].effects)).toEqual([]);
    });
  });
});
