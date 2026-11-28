import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNE } from '../../../../data/spellRunes';
import { createEmptyCombatSupplies } from '../../../../types/encounterLoadout';
import { createEmptyStats } from '../../../../types/equipmentStats';
import { createEmptyInventory } from '../../../../types/inventory';
import {
  createDefaultPoisonState,
  createDefaultRunEnergy,
  createDefaultSpecialAttack,
  createDefaultStats,
  createDefaultTimers,
} from '../../../../types/playerState';
import { createDefaultPrayerState } from '../../../../types/simulation';
import type { NpcActor } from '../../../actors/NpcActor';
import type { PlayerActor } from '../../../actors/PlayerActor';
import { TickEvents } from '../../../events/TickEvents';
import { WorldState } from '../../../WorldState';
import { CombatSystem } from '../../CombatSystem';
import type { PlayerAutoAttackDeps } from '../PlayerAutoAttackSystem';
import { processPlayerAutoAttack } from '../PlayerAutoAttackSystem';
import { registerPlayerAttackIntent } from '../playerAttackIntent';

vi.mock('../../weaponCombatData', () => ({
  getPlayerEffectiveCombatParams: () => ({ attackSpeed: 4, attackRange: 10 }),
  getHitDelayModel: () => 'magic_spell',
  getProjectileTiming: () => null,
  getFormulaStyle: () => 'magic',
  formulaStyleToDamageType: () => 'magic',
  formulaStyleToAttackKind: () => 'magic',
  getRangedDefenceType: () => 'standard',
}));

vi.mock('../../distance', () => ({
  isInAttackRange: () => true,
  isUnderNpc: () => false,
  chebyshevDistanceToRect: () => 1,
}));

vi.mock('../../hitDelay', () => ({
  calculateHitDelay: () => 0,
  calculateProjectileEndTime: () => 0,
  hitDelayFromEndTime: () => 0,
  PROJ_ANIM_TIMINGS: { magic_spell: { startTime: 51, speed: 5, slope: 15 } },
}));

vi.mock('../../../../types/attackStyles', () => ({
  resolveActiveSpell: () => null,
  getWeaponCategory: () => ({
    name: 'Powered Staff',
    styles: [{ name: 'Accurate', attackType: 'Magic', combatStyle: 'Accurate', icon: '' }],
  }),
}));

function makePlayer(): PlayerActor {
  const inventory = createEmptyInventory();
  for (const [index, runeId] of Object.values(RUNE).entries()) {
    inventory[index] = { id: runeId, quantity: 1_000 };
  }
  return {
    id: 'player',
    kind: 'player',
    alive: true,
    position: [31, 25],
    previousPosition: [31, 25],
    facing: 0,
    size: 1,
    vitals: { hp: 99, maxHp: 99 },
    movementPath: [],
    isMoving: false,
    isRunning: false,
    history: new Map(),
    activePrayer: null,
    boostPrayers: [],
    independentPrayers: [],
    prayerState: createDefaultPrayerState(),
    stats: createDefaultStats(),
    poisonState: createDefaultPoisonState(),
    specialAttack: createDefaultSpecialAttack(),
    combatTimers: createDefaultTimers(),
    inventory,
    combatSupplies: createEmptyCombatSupplies(),
    isRunEnabled: true,
    isSpecialAttackActive: false,
    runEnergy: createDefaultRunEnergy(),
    ctrlClickOverride: false,
    equipment: { hands: 31106 },
    equipmentStats: createEmptyStats(),
    pendingInputOps: [],
    cooldownTracks: { food: 0, potion: 0, combo_food: 0 },
    pendingItemPickup: null,
    quickPrayersActive: false,
    activeEffects: [],
    attackTarget: 'target',
    autoAttackPause: null,
    attackInteractionActive: true,
    manualCastSpell: null,
    selectedAttackStyleIndex: 0,
    pendingConflictionAttack: null,
    xpCounters: {},
  };
}

function makeNpc(): NpcActor {
  return {
    id: 'target',
    kind: 'npc',
    alive: true,
    position: [31, 26],
    previousPosition: [31, 26],
    facing: 0,
    size: 1,
    vitals: { hp: 1_000, maxHp: 1_000 },
    npcTypeId: 3127,
    archetypeId: 'target',
    formulaStats: {
      levels: { attack: 1, strength: 1, defence: 80, ranged: 1, magic: 80 },
      offensive: { atk: 0, str: 0, ranged: 0, rangedStr: 0, magic: 0, magicStr: 0 },
      defensive: { stab: 0, slash: 0, crush: 0, rangedLight: 0, rangedStandard: 0, rangedHeavy: 0, magic: 36 },
    },
    history: new Map(),
    combat: {
      attackSpeed: 4,
      attackRange: 10,
      attackStyle: 'magic',
      nextActionTick: 0,
      lastAttackTick: null,
      targetId: 'player',
      animations: { idle: null, walk: null, run: null, attack: null, death: null },
    },
  };
}

function makeDeps(world: WorldState, random: () => number): PlayerAutoAttackDeps {
  return {
    world,
    tickEvents: new TickEvents(),
    combatSystem: new CombatSystem(),
    infiniteHealth: true,
    onDamageApplied: vi.fn(),
    combatSupplies: createEmptyCombatSupplies(),
    random,
  };
}

/** A fresh spell-on-NPC click: a manual cast ends the interaction, so every cast is its own. */
function cast(player: PlayerActor, world: WorldState, spell: string, random: () => number): void {
  registerPlayerAttackIntent(player, world, { targetId: 'target', manualCastSpell: spell });
  processPlayerAutoAttack(player, makeDeps(world, random));
}

describe('processPlayerAutoAttack Confliction state', () => {
  let player: PlayerActor;
  let world: WorldState;

  beforeEach(() => {
    vi.clearAllMocks();
    player = makePlayer();
    world = new WorldState();
    world.actors.set(player.id, player);
    const npc = makeNpc();
    world.actors.set(npc.id, npc);
  });

  it('arms an Ice Barrage miss from the accuracy result rather than its damage', () => {
    cast(player, world, 'Ice Barrage', () => 0.999);

    expect(player).toMatchObject({
      pendingConflictionAttack: { kind: 'spell', spellId: 'Ice Barrage', targetId: 'target' },
    });
  });

  it('uses double-roll accuracy for the matching spell and clears state on an accurate hit', () => {
    cast(player, world, 'Fire Strike', () => 0.5);

    cast(player, world, 'Fire Strike', () => 0.5);

    expect(player).toMatchObject({ pendingConflictionAttack: null });
  });

  it('preserves a pending spell through an ineligible attack and applies it to the later match', () => {
    cast(player, world, 'Fire Strike', () => 0.5);
    player.equipment.weapon = 20997;

    cast(player, world, 'Ice Barrage', () => 0.5);

    expect(player.pendingConflictionAttack).toEqual({ kind: 'spell', spellId: 'Fire Strike', targetId: 'target' });
    player.equipment.weapon = undefined;

    cast(player, world, 'Fire Strike', () => 0.5);

    expect(player.pendingConflictionAttack).toBeNull();
  });
});
