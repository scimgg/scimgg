import { vi } from 'vitest';
import type { EncounterVictoryDescriptor } from '../../core/encounters/encounterFactory';
import { yamaSnapshot } from '../../test/helpers/encounterSnapshot';
import { createEmptyCombatSupplies } from '../../types/encounterLoadout';
import { createEmptyStats } from '../../types/equipmentStats';
import { createEmptyInventory } from '../../types/inventory';
import { createDefaultCombatState, createDefaultRunEnergy } from '../../types/playerState';
import {
  createDefaultPrayerState,
  type DamageHistoryEntry,
  DEFAULT_MECHANICS_CONFIG,
  type SimulationState,
} from '../../types/simulation';
import type { VictoryModalProps } from '../VictoryModal';

export const YAMA_VICTORY_DESCRIPTOR: EncounterVictoryDescriptor = {
  eyebrow: 'Triumphant',
  title: 'VICTORY',
  narrative: 'YAMA DEFEATED',
  accent: 'blood',
};

function makeDamage(overrides: Partial<DamageHistoryEntry>): DamageHistoryEntry {
  return {
    tick: 1,
    source: 'PlayerAttack',
    targetId: 'yama',
    baseDamage: 0,
    attackType: 'melee',
    activePrayer: null,
    prayedCorrectly: null,
    effectiveDamage: 0,
    hpBefore: 100,
    hpAfter: 100,
    ...overrides,
  };
}

export function makeSimulationState(overrides: Partial<SimulationState> = {}): SimulationState {
  const combatState = createDefaultCombatState();
  return {
    currentTick: 130,
    groundItems: [],
    playerPosition: [20, 20],
    playerPreviousPosition: [20, 20],
    playerMovementPath: [],
    playerFacingAngle: 0,
    playerIsMoving: false,
    playerIsRunning: false,
    primaryNpcPosition: [25, 25],
    primaryNpcPreviousPosition: [25, 25],
    primaryNpcFacingAngle: 0,
    primaryNpcSize: 5,
    npcs: [],
    encounter: yamaSnapshot(),
    isAlive: true,
    markOfDarknessActive: false,
    markOfDarknessTicksRemaining: 0,
    activePrayer: null,
    boostPrayers: [],
    independentPrayers: [],
    failedCondition: null,
    playerHistory: new Map(),
    primaryNpcHistory: new Map(),
    playerHP: 42,
    maxHP: 99,
    poisonVarp: 0,
    poisonTickCounter: 0,
    damageHistory: [
      makeDamage({ effectiveDamage: 100, hpBefore: 100, hpAfter: 0 }),
      makeDamage({ source: 'YamaAttack', targetId: 'player', effectiveDamage: 18, hpBefore: 60, hpAfter: 42 }),
    ],
    eventLog: [],
    stats: combatState.stats,
    specialAttack: combatState.specialAttack,
    combatTimers: combatState.timers,
    inventory: createEmptyInventory(),
    isRunEnabled: false,
    isSpecialAttackActive: false,
    pendingSpecialAttackToggles: 0,
    pendingProtectionPrayer: [false, null],
    pendingBoostPrayers: [false, []],
    pendingIndependentPrayers: [false, []],
    quickPrayersActive: false,
    runEnergy: createDefaultRunEnergy(),
    equipmentStats: createEmptyStats(),
    prayerState: { ...createDefaultPrayerState(), points: 17 },
    playerEquipment: {},
    playerCombatSupplies: createEmptyCombatSupplies(),
    cooldownTracks: { food: 0, potion: 0, combo_food: 0 },
    mechanicsConfig: { ...DEFAULT_MECHANICS_CONFIG },
    attackTarget: null,
    lastAttackTarget: null,
    selectedAttackStyleIndex: 0,
    playerAttackCooldown: 0,
    playerNextAttackTick: -1,
    playerAttackSpeed: 4,
    introActive: false,
    ...overrides,
    encounterOutcome: overrides.encounterOutcome ?? {
      phase: 'victory',
      decisiveTick: 125,
      completionTick: 134,
      primaryActorId: 'yama',
      completionActorIds: ['yama'],
    },
  };
}

export function makeProps(overrides: Partial<VictoryModalProps> = {}): VictoryModalProps {
  return {
    victory: YAMA_VICTORY_DESCRIPTOR,
    simulationState: makeSimulationState(),
    onRestart: vi.fn(),
    onEnterReplay: vi.fn(),
    visible: true,
    hasRecording: true,
    ...overrides,
  };
}
