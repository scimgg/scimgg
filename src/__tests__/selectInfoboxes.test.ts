import { describe, expect, it } from 'vitest';
import { selectInfoboxes } from '../components/InfoBox/selectInfoboxes';
import { yamaSnapshot } from '../test/helpers/encounterSnapshot';
import { createEmptyCombatSupplies } from '../types/encounterLoadout';
import { createEmptyStats as createEmptyEquipmentStats } from '../types/equipmentStats';
import { createEmptyInventory } from '../types/inventory';
import {
  type CombatTimers,
  createDefaultRunEnergy,
  createDefaultSpecialAttack,
  createDefaultStats,
  createDefaultTimers,
  POISON_TICK_INTERVAL,
  SURGE_POTION_COOLDOWN_TICKS,
} from '../types/playerState';
import type { SimulationState } from '../types/simulation';
import { createDefaultPrayerState } from '../types/simulation';

const NO_TICK_COUNTER = { showTickCounterInfobox: false } as const;

function heartTimers(ticksRemaining: number): CombatTimers {
  return { ...createDefaultTimers(), statDecayLocks: { magic: { ticksRemaining, source: 'saturated_heart' } } };
}

function createMinimalState(overrides: Partial<SimulationState> = {}): SimulationState {
  return {
    currentTick: 10,
    groundItems: [],
    playerPosition: [31, 25],
    playerPreviousPosition: [31, 25],
    playerMovementPath: [],
    playerFacingAngle: 0,
    playerIsMoving: false,
    playerIsRunning: false,
    primaryNpcPosition: [29, 28],
    primaryNpcPreviousPosition: [29, 28],
    primaryNpcFacingAngle: 0,
    primaryNpcSize: 5,
    npcs: [],
    encounter: yamaSnapshot({ state: { firstRangeMageType: 'magic' } }),
    isAlive: true,
    markOfDarknessActive: false,
    markOfDarknessTicksRemaining: 0,
    activePrayer: null,
    boostPrayers: [],
    independentPrayers: [],
    failedCondition: null,
    playerHistory: new Map(),
    primaryNpcHistory: new Map(),
    playerHP: 99,
    maxHP: 99,
    damageHistory: [],
    eventLog: [],
    stats: createDefaultStats(),
    specialAttack: createDefaultSpecialAttack(),
    combatTimers: createDefaultTimers(),
    inventory: createEmptyInventory(),
    isRunEnabled: true,
    isSpecialAttackActive: false,
    pendingSpecialAttackToggles: 0,
    pendingProtectionPrayer: [false, null],
    pendingBoostPrayers: [false, []],
    pendingIndependentPrayers: [false, []],
    quickPrayersActive: false,
    runEnergy: createDefaultRunEnergy(),
    equipmentStats: createEmptyEquipmentStats(),
    prayerState: createDefaultPrayerState(),
    playerEquipment: {},
    playerCombatSupplies: createEmptyCombatSupplies(),
    cooldownTracks: { food: 0, potion: 0, combo_food: 0 },
    mechanicsConfig: { yamaMageRange: true, waves: true, fireballs: true, infiniteHealth: true },
    attackTarget: null,
    lastAttackTarget: null,
    selectedAttackStyleIndex: 0,
    playerAttackCooldown: 0,
    playerNextAttackTick: -1,
    playerAttackSpeed: 4,
    introActive: false,
    poisonVarp: 0,
    poisonTickCounter: POISON_TICK_INTERVAL,
    ...overrides,
    encounterOutcome: overrides.encounterOutcome ?? { phase: 'active' },
  };
}

describe('selectInfoboxes', () => {
  it('should return empty array when no effects are active and tick counter disabled', () => {
    const state = createMinimalState();
    const result = selectInfoboxes(state, { showTickCounterInfobox: false });
    expect(result).toEqual([]);
  });

  it('should show saturated heart infobox when active ticks > 0', () => {
    const state = createMinimalState({
      combatTimers: heartTimers(500),
    });

    const result = selectInfoboxes(state, NO_TICK_COUNTER);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('saturated-heart');
    expect(result[0].itemId).toBe(27641);
  });

  it('should format timer as M:SS', () => {
    const state = createMinimalState({
      combatTimers: heartTimers(500),
    });

    const result = selectInfoboxes(state, NO_TICK_COUNTER);
    // 500 ticks * 0.6 = 300 seconds = 5:00
    expect(result[0].text).toBe('5:00');
  });

  it('should format partial time correctly', () => {
    const state = createMinimalState({
      combatTimers: heartTimers(250),
    });

    const result = selectInfoboxes(state, NO_TICK_COUNTER);
    // 250 ticks * 0.6 = 150 seconds = 2:30
    expect(result[0].text).toBe('2:30');
  });

  it('leaves a countdown uncolored, for the tile to paint in the shared timer color', () => {
    // Every urgency level the heart timer spans: none of them colors the timer.
    for (const ticksRemaining of [300, 75, 49, 1]) {
      const state = createMinimalState({ combatTimers: heartTimers(ticksRemaining) });
      const [heart] = selectInfoboxes(state, NO_TICK_COUNTER);
      expect(heart.ticksRemaining).toBe(ticksRemaining);
      expect(heart.textColor).toBeUndefined();
    }
  });

  it('shows the live Magic boost in the tooltip, not the heart formula', () => {
    const state = createMinimalState({ combatTimers: heartTimers(300) });
    state.stats.magic.current = 108;

    const result = selectInfoboxes(state, NO_TICK_COUNTER);
    expect(result[0].tooltipTitle).toBe('Saturated heart');
    expect(result[0].tooltipDetail).toBe('Magic +9 (3:00 remaining)');
  });

  it('omits the amount once Magic has been drained to or below base', () => {
    const state = createMinimalState({ combatTimers: heartTimers(300) });
    state.stats.magic.current = 90;

    expect(selectInfoboxes(state, NO_TICK_COUNTER)[0].tooltipDetail).toBe('3:00 remaining');
  });

  it('shows no heart timer for a divine lock', () => {
    const state = createMinimalState({
      combatTimers: {
        ...createDefaultTimers(),
        statDecayLocks: { attack: { ticksRemaining: 300, source: 'divine' } },
      },
    });

    expect(selectInfoboxes(state, NO_TICK_COUNTER)).toEqual([]);
  });

  it('should not show infobox without a heart lock', () => {
    const state = createMinimalState({ combatTimers: createDefaultTimers() });

    const result = selectInfoboxes(state, NO_TICK_COUNTER);
    expect(result).toEqual([]);
  });

  it('should handle 1 tick remaining', () => {
    const state = createMinimalState({
      combatTimers: heartTimers(1),
    });

    const result = selectInfoboxes(state, NO_TICK_COUNTER);
    expect(result).toHaveLength(1);
    // 1 tick = 0.6s left, and a timer with time on it must not read 0:00. Ceil
    // matches OSRS timers, which count 0:01 right up to expiry and then
    // disappear.
    expect(result[0].text).toBe('0:01');
    expect(result[0].ticksRemaining).toBe(1);
  });

  it('should show stat boost infobox when magic is boosted', () => {
    const state = createMinimalState();
    state.stats.magic.current = 112; // 99 + 13

    const result = selectInfoboxes(state, NO_TICK_COUNTER);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('stat-magic');
    expect(result[0].text).toBe('112');
    expect(result[0].tone).toBe('boost');
    expect(result[0].textColor).toBeUndefined();
    expect(result[0].tooltipDetail).toBe('Magic: 112/99 (+13)');
  });

  it('should show stat drain infobox when defence is drained', () => {
    const state = createMinimalState();
    state.stats.defence.current = 90; // 99 - 9

    const result = selectInfoboxes(state, NO_TICK_COUNTER);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('stat-defence');
    expect(result[0].text).toBe('90');
    expect(result[0].tone).toBe('drain');
    expect(result[0].textColor).toBeUndefined();
    expect(result[0].tooltipDetail).toBe('Defence: 90/99 (-9)');
  });

  it('should show multiple stat infoboxes for super combat potion', () => {
    const state = createMinimalState();
    state.stats.attack.current = 118;
    state.stats.strength.current = 118;
    state.stats.defence.current = 118;

    const result = selectInfoboxes(state, NO_TICK_COUNTER);

    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('stat-attack');
    expect(result[1].id).toBe('stat-strength');
    expect(result[2].id).toBe('stat-defence');
  });

  it('should show both saturated heart timer and magic boost infobox', () => {
    const state = createMinimalState({
      combatTimers: heartTimers(500),
    });
    state.stats.magic.current = 112;

    const result = selectInfoboxes(state, NO_TICK_COUNTER);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('saturated-heart');
    expect(result[1].id).toBe('stat-magic');
    expect(result[1].text).toBe('112');
  });

  describe('tick counter infobox', () => {
    it('should show tick counter when enabled (default)', () => {
      const state = createMinimalState({ currentTick: 1 });
      const result = selectInfoboxes(state, { showTickCounterInfobox: true, tickCounterMax: 4 });
      const tc = result.find((r) => r.id === 'tick-counter');
      expect(tc).toBeDefined();
      expect(tc!.text).toBe('1');
      expect(tc!.tooltipDetail).toBe('Tick 1 of 4');
    });

    it('should cycle 1 → 2 → 3 → 4 → 1', () => {
      const values = [1, 2, 3, 4, 5, 6, 7, 8].map((tick) => {
        const state = createMinimalState({ currentTick: tick });
        const result = selectInfoboxes(state, { showTickCounterInfobox: true, tickCounterMax: 4 });
        return result.find((r) => r.id === 'tick-counter')!.text;
      });
      expect(values).toEqual(['1', '2', '3', '4', '1', '2', '3', '4']);
    });

    it('should respect custom tickCounterMax', () => {
      const values = [1, 2, 3, 4, 5, 6].map((tick) => {
        const state = createMinimalState({ currentTick: tick });
        const result = selectInfoboxes(state, { showTickCounterInfobox: true, tickCounterMax: 3 });
        return result.find((r) => r.id === 'tick-counter')!.text;
      });
      expect(values).toEqual(['1', '2', '3', '1', '2', '3']);
    });

    it('should not show tick counter when disabled', () => {
      const state = createMinimalState({ currentTick: 5 });
      const result = selectInfoboxes(state, { showTickCounterInfobox: false, tickCounterMax: 4 });
      const tc = result.find((r) => r.id === 'tick-counter');
      expect(tc).toBeUndefined();
    });

    it('should default to showing tick counter with max 4 when no settings provided', () => {
      const state = createMinimalState({ currentTick: 3 });
      const result = selectInfoboxes(state);
      const tc = result.find((r) => r.id === 'tick-counter');
      expect(tc).toBeDefined();
      expect(tc!.text).toBe('3');
      expect(tc!.tooltipDetail).toBe('Tick 3 of 4');
    });
  });

  it('should NOT show infobox for hitpoints or prayer changes', () => {
    const state = createMinimalState();
    state.playerHP = 50;
    state.stats.hitpoints.current = 50;
    state.stats.prayer.current = 10;

    const result = selectInfoboxes(state, NO_TICK_COUNTER);

    expect(result).toHaveLength(0);
  });

  it('should show antipoison infobox when poison immunity is active', () => {
    const state = createMinimalState({ poisonVarp: -20, poisonTickCounter: 15 });

    const result = selectInfoboxes(state, NO_TICK_COUNTER);

    const antipoison = result.find((r) => r.id === 'antipoison');
    expect(antipoison).toBeDefined();
    expect(antipoison!.tooltipTitle).toBe('Antipoison');
    // Remaining = (20-1) * 30 + 15 = 585 ticks = 351 seconds = 5:51
    expect(antipoison!.text).toBe('5:51');
  });

  describe('surge potion cooldown', () => {
    const withSurgeCooldown = (surgePotionCooldownTicks: number) =>
      selectInfoboxes(
        createMinimalState({ combatTimers: { ...createDefaultTimers(), surgePotionCooldownTicks } }),
        NO_TICK_COUNTER,
      );

    it('shows the full five minutes the moment a dose is drunk', () => {
      const [surge] = withSurgeCooldown(SURGE_POTION_COOLDOWN_TICKS);

      expect(surge).toMatchObject({
        id: 'surge-potion-cooldown',
        itemId: 30875, // Surge potion(4)
        text: '5:00', // 500 ticks * 0.6s
        ticksRemaining: SURGE_POTION_COOLDOWN_TICKS,
        sampledAtTick: 10,
        tooltipTitle: 'Surge potion',
        tooltipDetail: 'Cooldown (5:00 remaining)',
      });
      expect(surge.textColor).toBeUndefined();
    });

    it('counts the engine cooldown down to its last tick, then goes', () => {
      expect(withSurgeCooldown(250)[0].text).toBe('2:30');
      expect(withSurgeCooldown(1)[0].text).toBe('0:01');
      expect(withSurgeCooldown(0)).toEqual([]);
    });
  });

  it('should NOT show antipoison infobox when not immune', () => {
    const state = createMinimalState({ poisonVarp: 0 });

    const result = selectInfoboxes(state, NO_TICK_COUNTER);

    expect(result.find((r) => r.id === 'antipoison')).toBeUndefined();
  });

  it('should NOT show antipoison infobox when actively poisoned', () => {
    const state = createMinimalState({ poisonVarp: 50 });

    const result = selectInfoboxes(state, NO_TICK_COUNTER);

    expect(result.find((r) => r.id === 'antipoison')).toBeUndefined();
  });
});
