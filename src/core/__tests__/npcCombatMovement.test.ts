import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollisionFlag } from '../../rs/collision/CollisionFlag';
import { createEmptyCombatSupplies } from '../../types/encounterLoadout';
import { createEmptyStats } from '../../types/equipmentStats';
import { createEmptyInventory } from '../../types/inventory';
import {
  createDefaultPoisonState,
  createDefaultRunEnergy,
  createDefaultSpecialAttack,
  createDefaultStats,
  createDefaultTimers,
} from '../../types/playerState';
import { type Coordinate, createDefaultPrayerState } from '../../types/simulation';
import type { NpcActor } from '../actors/NpcActor';
import type { PlayerActor } from '../actors/PlayerActor';
import { canNpcAttack } from '../combat/npcAttackRequest';
import { setArenaConfig } from '../constants';
import { TickEvents } from '../events/TickEvents';
import { isNpcMovementSuppressed, standardNpcCombatMove } from '../npcCombatMovement';
import type { NpcDefinitionContext } from '../npcs/types';
import { WorldState } from '../WorldState';

function makeNpc(position: Coordinate = [10, 10], size = 1): NpcActor {
  return {
    id: 'mover',
    kind: 'npc',
    alive: true,
    position,
    previousPosition: position,
    facing: 0,
    size,
    vitals: { hp: 100, maxHp: 100 },
    npcTypeId: 1,
    archetypeId: 'test',
    history: new Map(),
    state: { firstActionTick: 100 },
    combat: {
      attackSpeed: 4,
      attackRange: 1,
      attackStyle: 'melee',
      nextActionTick: 100,
      lastAttackTick: 8,
      targetId: 'target',
      animations: { idle: null, walk: null, run: null, attack: null, death: null },
    },
  };
}

function makePlayer(position: Coordinate): PlayerActor {
  return {
    id: 'player',
    kind: 'player',
    alive: true,
    position,
    previousPosition: position,
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
    inventory: createEmptyInventory(),
    combatSupplies: createEmptyCombatSupplies(),
    isRunEnabled: true,
    isSpecialAttackActive: false,
    runEnergy: createDefaultRunEnergy(),
    ctrlClickOverride: false,
    equipment: {},
    equipmentStats: createEmptyStats(),
    pendingInputOps: [],
    cooldownTracks: { food: 0, potion: 0, combo_food: 0 },
    pendingItemPickup: null,
    activeEffects: [],
    quickPrayersActive: false,
    attackTarget: null,
    autoAttackPause: null,
    attackInteractionActive: false,
    manualCastSpell: null,
    selectedAttackStyleIndex: 0,
    pendingConflictionAttack: null,
    xpCounters: {},
  };
}

function makeContext(actor: NpcActor, target: NpcActor | PlayerActor): NpcDefinitionContext {
  const world = new WorldState();
  world.actors.set(actor.id, actor);
  world.actors.set(target.id, target);
  actor.combat.targetId = target.id;
  return {
    tick: 10,
    world,
    random: vi.fn(() => 0),
    tickEvents: new TickEvents(),
    spawnNpc: vi.fn(),
    despawnNpc: vi.fn(),
    logEvent: vi.fn(),
  };
}

function makeTarget(position: Coordinate = [20, 20], size = 1): NpcActor {
  return { ...makeNpc(position, size), id: 'target' };
}

function installCollision(entries: readonly (readonly [string, number])[]): void {
  const flags = new Map(entries);
  const getFlag = (x: number, y: number) => flags.get(`${x},${y}`) ?? 0;
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
}

afterEach(() => setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true));

/** One mover's turn: the engine reconciles placements before it moves. */
function atTurnStart(actor: NpcActor, context: NpcDefinitionContext) {
  context.world.occupancy.reconcile(context.world.actors.values());
  return standardNpcCombatMove(actor, context);
}

describe('standardNpcCombatMove', () => {
  it.each([false, true])('uses the same diagonal melee reach for pursuit and attacks when enabled: %s', (enabled) => {
    const actor = makeNpc([10, 10], 3);
    const target = makeTarget([13, 13]);
    if (enabled) actor.combat.meleeReach = 'diagonal';
    const requests = atTurnStart(actor, makeContext(actor, target));
    expect(requests).toHaveLength(enabled ? 0 : 1);
    expect(
      canNpcAttack(actor, target, {
        formulaStyle: 'melee_crush',
        damageType: 'melee',
        attackKind: 'melee_crush',
        impactDelayTicks: 0,
      }),
    ).toBe(enabled);
  });

  it.each([
    { source: [14, 17], size: 1, target: [20, 20], targetSize: 1, next: [15, 18] },
    { source: [26, 17], size: 1, target: [20, 20], targetSize: 1, next: [25, 18] },
    { source: [26, 23], size: 1, target: [20, 20], targetSize: 1, next: [25, 22] },
    { source: [14, 23], size: 1, target: [20, 20], targetSize: 1, next: [15, 22] },
    { source: [24, 24], size: 3, target: [20, 20], targetSize: 1, next: [23, 23] },
    { source: [16, 16], size: 3, target: [20, 20], targetSize: 1, next: [17, 17] },
    { source: [14, 25], size: 4, target: [20, 20], targetSize: 3, next: [15, 24] },
    { source: [25, 14], size: 4, target: [20, 20], targetSize: 3, next: [24, 15] },
    { source: [14, 24], size: 4, target: [20, 20], targetSize: 3, next: [15, 23] },
    { source: [26, 14], size: 4, target: [20, 20], targetSize: 3, next: [25, 15] },
    { source: [25, 22], size: 3, target: [20, 20], targetSize: 3, next: [24, 21] },
    { source: [20, 27], size: 4, target: [20, 20], targetSize: 1, next: [20, 26] },
  ] satisfies readonly {
    source: Coordinate;
    size: number;
    target: Coordinate;
    targetSize: number;
    next: Coordinate;
  }[])('matches RSMod square-footprint step from $source/$size to $target/$targetSize', ({
    source,
    size,
    target,
    targetSize,
    next,
  }) => {
    const actor = makeNpc(source, size);
    const context = makeContext(actor, makeTarget(target, targetSize));
    const before = structuredClone(actor);

    const requests = atTurnStart(actor, context);

    expect(requests).toEqual([{ npcId: actor.id, path: [next] }]);
    expect(actor).toEqual(before);
    expect(context.random).not.toHaveBeenCalled();
  });

  it.each([1, 3])('tries X before Y when size-%s diagonal is blocked', (size) => {
    const actor = makeNpc([10, 10], size);
    const context = makeContext(actor, makeTarget());
    installCollision([[`${10 + size},${10 + size}`, CollisionFlag.OBJECT]]);

    const requests = atTurnStart(actor, context);

    expect(requests).toEqual([{ npcId: actor.id, path: [[11, 10]] }]);
  });

  it.each([1, 3])('tries Y when size-%s diagonal and X are blocked', (size) => {
    const actor = makeNpc([10, 10], size);
    const context = makeContext(actor, makeTarget());
    installCollision([
      [`${10 + size},${10 + size}`, CollisionFlag.OBJECT],
      [`${10 + size},10`, CollisionFlag.OBJECT],
    ]);

    const requests = atTurnStart(actor, context);

    expect(requests).toEqual([{ npcId: actor.id, path: [[10, 11]] }]);
  });

  it('stays rather than taking a BFS detour around a blocked direct step', () => {
    const actor = makeNpc();
    const context = makeContext(actor, makeTarget([20, 10]));
    installCollision([['11,10', CollisionFlag.OBJECT]]);

    const requests = atTurnStart(actor, context);

    expect(requests).toEqual([]);
  });

  it.each([0, -1])('stays when configured range is %s', (range) => {
    const actor = makeNpc();
    const context = makeContext(actor, makeTarget());
    actor.combat.attackRange = range;

    const requests = atTurnStart(actor, context);

    expect(requests).toEqual([]);
    expect(context.random).not.toHaveBeenCalled();
  });

  it.each([
    'dead mover',
    'future spawn',
    'missing target',
    'dead target',
    'no target',
  ] as const)('preserves actor state when there is a %s', (condition) => {
    const actor = makeNpc();
    const target = makeTarget();
    const context = makeContext(actor, target);
    const player = makePlayer([30, 30]);
    context.world.actors.set(player.id, player);
    switch (condition) {
      case 'dead mover':
        actor.alive = false;
        break;
      case 'future spawn':
        actor.spawnTick = 11;
        break;
      case 'missing target':
        context.world.actors.delete(target.id);
        break;
      case 'dead target':
        target.alive = false;
        break;
      case 'no target':
        actor.combat.targetId = null;
        break;
      default: {
        const exhaustive: never = condition;
        throw new TypeError(`Unknown movement fixture condition: ${exhaustive}`);
      }
    }
    const before = structuredClone(actor);

    const requests = atTurnStart(actor, context);

    expect(requests).toEqual([]);
    expect(actor).toEqual(before);
    expect(context.random).not.toHaveBeenCalled();
  });

  it('stops at configured range despite the previous melee style and future action clocks', () => {
    const actor = makeNpc();
    actor.combat.attackRange = 6;
    const context = makeContext(actor, makeTarget([16, 10], 3));

    const requests = atTurnStart(actor, context);

    expect(requests).toEqual([]);
  });

  it.each([true, false])('agrees with incoming attack reach when reverse LOS is blocked: %s', (blocked) => {
    const actor = makeNpc();
    actor.combat.attackRange = 6;
    const target = makeTarget([13, 10]);
    const context = makeContext(actor, target);
    installCollision([[blocked ? '10,10' : '13,10', CollisionFlag.OBJECT_PROJECTILE_BLOCKER]]);

    const requests = atTurnStart(actor, context);

    expect(requests).toEqual(blocked ? [{ npcId: actor.id, path: [[11, 10]] }] : []);
    expect(
      canNpcAttack(actor, target, {
        formulaStyle: 'ranged',
        damageType: 'range',
        attackKind: 'range_arrow',
        impactDelayTicks: 0,
      }),
    ).toBe(!blocked);
  });

  it.each([
    { random: 0, next: [10, 9] },
    { random: 0.25, next: [10, 11] },
    { random: 0.5, next: [9, 10] },
    { random: 0.99999, next: [11, 10] },
  ] satisfies readonly { random: number; next: Coordinate }[])('attempts one overlap escape at random $random', ({
    random,
    next,
  }) => {
    const actor = makeNpc([10, 10], 3);
    const context = { ...makeContext(actor, makeTarget([11, 11])), random: vi.fn(() => random) };

    const requests = atTurnStart(actor, context);

    expect(requests).toEqual([{ npcId: actor.id, path: [next] }]);
    expect(context.random).toHaveBeenCalledTimes(1);
  });

  it('stays after the single selected overlap escape is blocked', () => {
    const actor = makeNpc();
    const context = makeContext(actor, makeTarget([10, 10]));
    installCollision([['10,9', CollisionFlag.OBJECT]]);

    const requests = atTurnStart(actor, context);

    expect(requests).toEqual([]);
    expect(context.random).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('blocks a live player on a new cell unless pass-through is %s', (passThrough) => {
    const actor = makeNpc();
    actor.passThruNpcs = passThrough;
    const context = makeContext(actor, makeTarget([20, 10]));
    const player = makePlayer([11, 10]);
    context.world.actors.set(player.id, player);

    const requests = atTurnStart(actor, context);

    expect(requests).toEqual(passThrough ? [{ npcId: actor.id, path: [[11, 10]] }] : []);
  });

  it('blocks other movers even when the blocker itself passes through actors', () => {
    const actor = makeNpc();
    const context = makeContext(actor, makeTarget([20, 10]));
    const blocker = { ...makeNpc([11, 10]), id: 'blocker', passThruNpcs: true };
    context.world.actors.set(blocker.id, blocker);

    const requests = atTurnStart(actor, context);

    expect(requests).toEqual([]);
  });

  it('leaves an existing NPC stack without entering a new occupied cell', () => {
    const actor = makeNpc([10, 10], 3);
    const context = makeContext(actor, makeTarget([20, 10]));
    const blocker = { ...makeNpc([10, 10], 3), id: 'blocker' };
    context.world.actors.set(blocker.id, blocker);

    const requests = atTurnStart(actor, context);

    expect(requests).toEqual([{ npcId: actor.id, path: [[11, 10]] }]);
  });

  it.each(['terrain', 'bounds'] as const)('still enforces %s for pass-through movers', (restriction) => {
    const actor = makeNpc([10, 10], 3);
    actor.passThruNpcs = true;
    const context = makeContext(actor, makeTarget([20, 10]));
    if (restriction === 'terrain') installCollision([['13,12', CollisionFlag.OBJECT]]);
    else
      setArenaConfig(
        {
          bounds: { minX: 0, minY: 0, maxX: 12, maxY: 30, width: 13, height: 31 },
          walkableTiles: null,
          collisionMap: null,
        },
        true,
      );

    const requests = atTurnStart(actor, context);

    expect(requests).toEqual([]);
  });
});

describe('isNpcMovementSuppressed', () => {
  it.each([
    { tick: 9, suppressed: false },
    { tick: 10, suppressed: true },
    { tick: 11, suppressed: true },
    { tick: 12, suppressed: false },
  ])('honors the half-open bind window at tick $tick', ({ tick, suppressed }) => {
    const actor = makeNpc();
    actor.debuffs = { boundFromTick: 10, boundUntilTick: 12 };

    const result = isNpcMovementSuppressed(actor, null, tick);

    expect(result).toBe(suppressed);
  });

  it.each(['bound', 'red-x'] as const)('suppresses %s before overlap consumes RNG', (reason) => {
    const actor = makeNpc([10, 10], 3);
    const player = makePlayer([11, 11]);
    const context = makeContext(actor, player);
    if (reason === 'bound') actor.debuffs = { boundUntilTick: 12 };
    else {
      player.attackTarget = actor.id;
      player.attackInteractionActive = true;
    }

    const requests = atTurnStart(actor, context);

    expect(requests).toEqual([]);
    expect(context.random).not.toHaveBeenCalled();
  });

  it('lets an opted-in NPC leave its attacker standing underneath, but not a bind', () => {
    const actor = makeNpc([10, 10], 1);
    const player = makePlayer([10, 10]);
    actor.combat.targetId = player.id;
    player.attackTarget = actor.id;
    player.attackInteractionActive = true;
    expect(isNpcMovementSuppressed(actor, player, 10)).toBe(true);

    actor.movesWithAttackerUnder = true;
    expect(isNpcMovementSuppressed(actor, player, 10)).toBe(false);
    actor.debuffs = { boundUntilTick: 12 };
    expect(isNpcMovementSuppressed(actor, player, 10)).toBe(true);
  });

  it('holds an NPC targeting the player while a pending Take is the red-X action, before RNG', () => {
    const actor = makeNpc([10, 10], 3);
    const player = makePlayer([11, 11]);
    const context = makeContext(actor, player);
    player.pendingItemPickup = { groundItemId: 'item' };

    const requests = standardNpcCombatMove(actor, context);

    expect(requests).toEqual([]);
    expect(context.random).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'attacking a different NPC while under one that targets the player',
      position: [11, 11],
      attackTarget: 'other',
      active: true,
      pickup: false,
      npcTargetsPlayer: true,
      suppressed: true,
    },
    {
      name: 'under an NPC that targets the player with no interaction',
      position: [11, 11],
      attackTarget: null,
      active: false,
      pickup: false,
      npcTargetsPlayer: true,
      suppressed: false,
    },
    {
      name: 'a canceled attack on the NPC with no pickup',
      position: [11, 11],
      attackTarget: 'mover',
      active: false,
      pickup: false,
      npcTargetsPlayer: true,
      suppressed: false,
    },
    {
      name: 'a pending Take while not under the NPC',
      position: [13, 11],
      attackTarget: null,
      active: false,
      pickup: true,
      npcTargetsPlayer: true,
      suppressed: false,
    },
    {
      name: 'a pending Take under an NPC that is not targeting the player',
      position: [11, 11],
      attackTarget: 'other',
      active: true,
      pickup: true,
      npcTargetsPlayer: false,
      suppressed: false,
    },
    {
      name: 'attacking the NPC from under it while it is not targeting the player',
      position: [11, 11],
      attackTarget: 'mover',
      active: true,
      pickup: false,
      npcTargetsPlayer: false,
      suppressed: false,
    },
  ] satisfies readonly {
    name: string;
    position: Coordinate;
    attackTarget: string | null;
    active: boolean;
    pickup: boolean;
    npcTargetsPlayer: boolean;
    suppressed: boolean;
  }[])('red-X hold: $name', ({ position, attackTarget, active, pickup, npcTargetsPlayer, suppressed }) => {
    const actor = makeNpc([10, 10], 3);
    const player = makePlayer(position);
    actor.combat.targetId = npcTargetsPlayer ? player.id : 'someone-else';
    player.attackTarget = attackTarget;
    player.attackInteractionActive = active;
    player.pendingItemPickup = pickup ? { groundItemId: 'item' } : null;

    const result = isNpcMovementSuppressed(actor, player, 10);

    expect(result).toBe(suppressed);
  });

  it('lets an opted-in NPC leave a player taking an item underneath, but not a bind', () => {
    const actor = makeNpc([10, 10], 1);
    const player = makePlayer([10, 10]);
    actor.combat.targetId = player.id;
    player.pendingItemPickup = { groundItemId: 'item' };
    expect(isNpcMovementSuppressed(actor, player, 10)).toBe(true);

    actor.movesWithAttackerUnder = true;
    expect(isNpcMovementSuppressed(actor, player, 10)).toBe(false);
    actor.debuffs = { boundUntilTick: 12 };
    expect(isNpcMovementSuppressed(actor, player, 10)).toBe(true);
  });
});
