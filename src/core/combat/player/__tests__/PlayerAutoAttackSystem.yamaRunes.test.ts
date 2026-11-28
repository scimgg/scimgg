import { describe, expect, it, vi } from 'vitest';
import { getMonsterFormulaStats } from '../../../../data/monsterData';
import { EQUIPMENT_PRESETS } from '../../../../data/playerPresets';
import { RUNE } from '../../../../data/spellRunes';
import { getDefaultAttackStyleIndex } from '../../../../types/attackStyles';
import type { CombatSupplies } from '../../../../types/encounterLoadout';
import { createEmptyStats } from '../../../../types/equipmentStats';
import { createEmptyInventory } from '../../../../types/inventory';
import {
  createDefaultPoisonState,
  createDefaultRunEnergy,
  createDefaultSpecialAttack,
  createDefaultStats,
  createDefaultTimers,
} from '../../../../types/playerState';
import { type Coordinate, createDefaultPrayerState, type TickNumber } from '../../../../types/simulation';
import type { NpcActor } from '../../../actors/NpcActor';
import type { PlayerActor } from '../../../actors/PlayerActor';
import { TickEvents } from '../../../events/TickEvents';
import { isCoreEvent } from '../../../events/types';
import { WorldState } from '../../../WorldState';
import { CombatSystem } from '../../CombatSystem';
import type { PlayerAutoAttackDeps } from '../PlayerAutoAttackSystem';
import { processPlayerAutoAttack } from '../PlayerAutoAttackSystem';

const preset = EQUIPMENT_PRESETS.yama_p3?.['max-mage'];
if (!preset) {
  throw new TypeError('Expected the Yama Max Mage preset');
}

const weaponId = preset.equipment.weapon;
const combatSupplies = preset.supplies;
if (weaponId === undefined || combatSupplies === undefined) {
  throw new TypeError('Expected the Yama Max Mage preset to define a weapon and supplies');
}

const runePouch = combatSupplies.runePouch;
if (runePouch?.kind !== 'divine') {
  throw new TypeError('Expected the Yama Max Mage preset to carry a divine rune pouch');
}

function makePlayer(supplies: CombatSupplies): PlayerActor {
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
    history: new Map<TickNumber, Coordinate>(),
    activePrayer: null,
    boostPrayers: [],
    independentPrayers: [],
    prayerState: createDefaultPrayerState(),
    stats: createDefaultStats(),
    poisonState: createDefaultPoisonState(),
    specialAttack: createDefaultSpecialAttack(),
    combatTimers: createDefaultTimers(),
    inventory: preset.inventory,
    combatSupplies: supplies,
    isRunEnabled: true,
    isSpecialAttackActive: false,
    runEnergy: createDefaultRunEnergy(),
    ctrlClickOverride: false,
    equipment: preset.equipment,
    equipmentStats: createEmptyStats(),
    pendingInputOps: [],
    cooldownTracks: { food: 0, potion: 0, combo_food: 0 },
    pendingItemPickup: null,
    quickPrayersActive: false,
    activeEffects: [],
    attackTarget: 'yama',
    autoAttackPause: null,
    attackInteractionActive: true,
    manualCastSpell: null,
    selectedAttackStyleIndex: getDefaultAttackStyleIndex(weaponId),
    pendingConflictionAttack: null,
    xpCounters: {},
  };
}

function makeNpc(): NpcActor {
  return {
    id: 'yama',
    kind: 'npc',
    alive: true,
    position: [29, 28],
    previousPosition: [29, 28],
    facing: 0,
    size: 5,
    vitals: { hp: 1000, maxHp: 1000 },
    npcTypeId: 14176,
    archetypeId: 'yama',
    formulaStats: getMonsterFormulaStats(14176),
    history: new Map<TickNumber, Coordinate>(),
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

function makeDeps(supplies: CombatSupplies) {
  const world = new WorldState();
  const player = makePlayer(supplies);
  const npc = makeNpc();
  world.actors.set(player.id, player);
  world.actors.set(npc.id, npc);

  const deps: PlayerAutoAttackDeps = {
    world,
    tickEvents: new TickEvents(),
    combatSystem: new CombatSystem(),
    infiniteHealth: true,
    onDamageApplied: vi.fn(),
    combatSupplies: supplies,
  };
  return { player, deps };
}

/** The attack this tick emitted, if any. Drains the tick's event queue. */
function launchedAttack(deps: PlayerAutoAttackDeps) {
  return deps.tickEvents.flush().find((event) => isCoreEvent(event, 'attack_started'));
}

describe('Yama Max Mage auto-attack rune wiring', () => {
  it('launches the Purging staff default Dark Demonbane from the pouch runes', () => {
    const { player, deps } = makeDeps(combatSupplies);

    processPlayerAutoAttack(player, deps);

    expect(launchedAttack(deps)).toMatchObject({ spellId: 'Dark Demonbane' });
  });

  it('blocks the Purging staff default Dark Demonbane when required soul runes are missing', () => {
    const suppliesWithoutSoulRunes: CombatSupplies = {
      ...combatSupplies,
      runePouch: {
        kind: 'divine',
        slots: [runePouch.slots[0], runePouch.slots[1], runePouch.slots[2], null],
      },
    };
    const { player, deps } = makeDeps(suppliesWithoutSoulRunes);

    processPlayerAutoAttack(player, deps);

    expect(launchedAttack(deps)).toBeUndefined();
  });

  it.each([
    { styleIndex: 0, stance: 'Accurate' },
    { styleIndex: 1, stance: 'Longrange' },
  ])("keeps Tumeken's shadow $stance attacks powered when Dark Demonbane is stored", ({ styleIndex }) => {
    const shadowSupplies: CombatSupplies = { ...combatSupplies, selectedSpell: 'Dark Demonbane' };
    const { player, deps } = makeDeps(shadowSupplies);
    player.equipment = { ...player.equipment, weapon: 27275 };
    player.selectedAttackStyleIndex = styleIndex;
    player.position = [31, 27];
    player.previousPosition = [31, 27];
    player.inventory = createEmptyInventory();
    player.inventory[0] = { id: RUNE.fire, quantity: 70 };
    player.inventory[1] = { id: RUNE.soul, quantity: 20 };

    processPlayerAutoAttack(player, deps);

    const attackEvent = deps.tickEvents.flush().find((event) => isCoreEvent(event, 'attack_started'));
    expect(attackEvent).toMatchObject({ ammoSource: 'none' });
    expect(attackEvent?.spellId).toBeUndefined();
    expect(attackEvent?.impactDelayTicks).toBe(3);
    expect(deps.combatSystem.getNextAttackTick(player.id)).toBe(4);
    expect(player.inventory[0]).toEqual({ id: RUNE.fire, quantity: 70 });
    expect(player.inventory[1]).toEqual({ id: RUNE.soul, quantity: 20 });
    expect(deps.world.pendingHits[0]?.expectedHit).toBeGreaterThan(0);
  });
});
