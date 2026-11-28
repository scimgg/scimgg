import { afterEach, describe, expect, it } from 'vitest';
import type { NpcActor } from '../../../core/actors/NpcActor';
import { setArenaConfig } from '../../../core/constants';
import type { EncounterContext, EncounterTickResult, EnvironmentalDamage } from '../../../core/encounters/types';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import { TickEvents } from '../../../core/events/TickEvents';
import { type GameEvent, isCoreEvent } from '../../../core/events/types';
import { recordNpcLethalTransition } from '../../../core/npcDeath';
import { NpcDefinitionCollection, type NpcDefinitionContext } from '../../../core/npcs';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { WorldState } from '../../../core/WorldState';
import {
  advanceHealingTotem,
  createHealingTotem,
  healingTotemDefinition,
} from '../../../encounters/colosseum/modifiers/totemic';
import { LobbyEncounter } from '../../../encounters/lobby/LobbyEncounter';
import { CollisionFlag } from '../../../rs/collision/CollisionFlag';
import { enqueueEnginePendingHit } from '../../../test/helpers/pendingHits';
import type { Coordinate } from '../../../types/simulation';
import type { ColosseumRelentlessRank } from '../constants';
import { createMinotaur, type MinotaurActor, minotaurDefinition, selectMinotaurHealTarget } from '../minotaur';
import { MINOTAUR_HEAL_WITNESS } from './fixtures/minotaurCapture';

const SPAWN_TICK = 10;
const registration = minotaurDefinition.register(undefined);
const OPEN_ARENA = { bounds: null, walkableTiles: null, collisionMap: null };

afterEach(() => setArenaConfig(OPEN_ARENA, true));

/** A wave NPC the minotaur may heal: only its identity, footprint and HP matter to the scan. */
function ally(id: string, npcTypeId: number, size: number, position: Coordinate, hp: number, maxHp: number): NpcActor {
  return {
    id,
    kind: 'npc',
    npcTypeId,
    archetypeId: 'test_ally',
    size,
    alive: true,
    position: [...position],
    previousPosition: [...position],
    facing: 0,
    vitals: { hp, maxHp },
    history: new Map(),
    combat: {
      attackSpeed: 5,
      attackRange: 1,
      attackStyle: 'melee',
      nextActionTick: 0,
      targetId: null,
      lastAttackTick: null,
      animations: { idle: null, walk: null, run: null, attack: null, death: null },
    },
  };
}

const javelin = (position: Coordinate, hp: number, id = 'javelin') => ally(id, 12817, 3, position, hp, 220);

function fixture(input: { position?: Coordinate; player?: Coordinate; relentless?: ColosseumRelentlessRank } = {}) {
  const world = new SimulationEngine({ encounter: new LobbyEncounter() })['worldState'];
  setArenaConfig(OPEN_ARENA, true);
  const player = world.getPlayer()!;
  world.actors.clear();
  world.actors.set(player.id, player);
  player.position = input.player ?? [20, 20];
  const minotaur = createMinotaur({
    id: 'minotaur',
    position: input.position ?? [20, 21],
    spawnTick: SPAWN_TICK,
    relentless: input.relentless,
  });
  world.registerNpc(minotaur);
  const context = (tick: number, random: () => number = () => 0.5): NpcDefinitionContext => ({
    tick,
    world,
    tickEvents: new TickEvents(),
    random,
    spawnNpc: () => undefined,
    despawnNpc: () => undefined,
    logEvent: () => undefined,
  });
  return { world, player, minotaur, context };
}

type Action = 'melee' | 'heal';
/** Runs its action hook over a span of ticks and lists what it did. */
function actions(minotaur: MinotaurActor, context: (tick: number) => NpcDefinitionContext, from: number, to: number) {
  const done: [number, Action][] = [];
  for (let tick = from; tick <= to; tick++) {
    const tickContext = context(tick);
    if (registration.tick(minotaur, tickContext).npcAttacks?.length) done.push([tick, 'melee']);
    const visuals = tickContext.tickEvents.flush().filter(isEncounterVisualEvent);
    if (visuals.some((event) => event.animations.some((cue) => cue.clipId === 'heal'))) done.push([tick, 'heal']);
  }
  return done;
}

/** Whether it has melee reach of the player's tile from where it stands. */
function canNpcAttackFrom(minotaur: MinotaurActor, playerTile: Coordinate): boolean {
  const [x, y] = minotaur.position;
  const gapX = Math.max(x - playerTile[0], 0, playerTile[0] - (x + minotaur.size - 1));
  const gapY = Math.max(y - playerTile[1], 0, playerTile[1] - (y + minotaur.size - 1));
  return gapX + gapY === 1;
}

/** One OBJECT_PROJECTILE_BLOCKER pillar in an otherwise open 64x64 arena. */
function pillar(tiles: readonly Coordinate[]) {
  const flags = new Int32Array(64 * 64);
  for (const [x, y] of tiles) flags[x + y * 64] = CollisionFlag.OBJECT | CollisionFlag.OBJECT_PROJECTILE_BLOCKER;
  setArenaConfig(
    {
      bounds: null,
      walkableTiles: null,
      collisionMap: {
        sizeX: 64,
        sizeY: 64,
        flags,
        getFlag: (x, y) => flags[x + y * 64]!,
        hasFlag: (x, y, flag) => (flags[x + y * 64]! & flag) !== 0,
        flag: (x, y, flag) => {
          flags[x + y * 64]! |= flag;
        },
        unflag: (x, y, flag) => {
          flags[x + y * 64]! &= ~flag;
        },
      },
    },
    true,
  );
}

describe('Minotaur', () => {
  it('builds from its Wiki stats with only its own regeneration', () => {
    const { minotaur } = fixture();
    expect(minotaur).toMatchObject({
      npcTypeId: 12812,
      size: 3,
      vitals: { hp: 225, maxHp: 225 },
      deathPolicy: 'queued',
      combat: { attackSpeed: 5, attackRange: 1, attackStyle: 'melee', animations: { attack: 10843, death: 10846 } },
      formulaStats: { levels: { attack: 300, strength: 360, defence: 190, magic: 250, ranged: 120 } },
    });
    // The engine's generic 1-per-100-ticks clock is opt-in; it must stay off so the +5 pulse is the only one.
    expect(minotaur.hitpointRegenNextTick).toBeUndefined();
    expect(structuredClone(minotaur.state)).toEqual(minotaur.state);
  });

  it('rolls a crush melee up to the Wiki 74 that lands the next tick and outlives its source (A:4485)', () => {
    const { minotaur, player, context } = fixture();
    const [attack] =
      registration.tick(
        minotaur,
        context(SPAWN_TICK + 3, () => 0.999999),
      ).npcAttacks ?? [];
    expect(attack).toEqual({
      attackerId: minotaur.id,
      targetId: player.id,
      style: 'melee',
      attackKind: 'melee_crush',
      rolledDamage: 74,
      accuracySucceeded: false,
      impactDelayTicks: 1,
      sourceDeathPolicy: 'persist',
    });
  });

  it.each([
    { rank: 1, maxHit: 75 },
    { rank: 2, maxHit: 77 },
    { rank: 3, maxHit: 80 },
  ] as const)('raises its max hit by the Relentless rank $rank bonus', ({ rank, maxHit }) => {
    const { minotaur, context } = fixture({ relentless: rank });
    const [attack] =
      registration.tick(
        minotaur,
        context(SPAWN_TICK + 3, () => 0.999999),
      ).npcAttacks ?? [];
    expect(attack?.rolledDamage).toBe(maxHit);
    expect(attack?.accuracySucceeded).toBe(rank === 3);
  });

  it('first acts at spawn+3, then swings every 5 ticks while cardinally adjacent', () => {
    const { minotaur, context } = fixture();
    expect(actions(minotaur, context, SPAWN_TICK, SPAWN_TICK + 13)).toEqual([
      [13, 'melee'],
      [18, 'melee'],
      [23, 'melee'],
    ]);
  });

  it('never swings diagonally or from under the player, and waits ready until it has reach', () => {
    const { minotaur, player, context } = fixture({ position: [21, 21] });
    expect(actions(minotaur, context, SPAWN_TICK, SPAWN_TICK + 8)).toEqual([]);
    player.position = [21, 21];
    minotaur.combat.startedTurnOverlappingTarget = true;
    expect(actions(minotaur, context, SPAWN_TICK + 9, SPAWN_TICK + 9)).toEqual([]);
    player.position = [22, 20];
    minotaur.combat.startedTurnOverlappingTarget = false;
    expect(actions(minotaur, context, SPAWN_TICK + 10, SPAWN_TICK + 15)).toEqual([
      [20, 'melee'],
      [25, 'melee'],
    ]);
  });

  it('heals, then waits 10 ticks before it swings (C:2478 -> 2488)', () => {
    const { world, minotaur, player, context } = fixture({ position: [30, 30], player: [10, 10] });
    world.registerNpc(javelin([25, 30], 10));
    expect(actions(minotaur, context, SPAWN_TICK, SPAWN_TICK + 3)).toEqual([[13, 'heal']]);
    // The player steps up beside it right away; the next action is still heal+10.
    player.position = [31, 29];
    expect(actions(minotaur, context, SPAWN_TICK + 4, SPAWN_TICK + 18)).toEqual([
      [23, 'melee'],
      [28, 'melee'],
    ]);
  });

  it('heals its target to full with a heal splat, the tzhaar_heal graphic and no projectile', () => {
    const { world, minotaur, context } = fixture({ position: [30, 30], player: [10, 10] });
    const target = javelin([25, 30], 3);
    world.registerNpc(target);
    const tickContext = context(SPAWN_TICK + 3);
    registration.tick(minotaur, tickContext);
    const events = tickContext.tickEvents.flush();
    expect(target.vitals.hp).toBe(220);
    expect(events.filter((event) => isCoreEvent(event, 'hitsplat_spawned'))).toMatchObject([
      { targetId: target.id, amount: 217, hitsplatType: 'heal' },
    ]);
    expect(events.filter(isEncounterVisualEvent)).toMatchObject([
      {
        animations: [{ actorId: minotaur.id, clipId: 'heal', delayCycles: 0 }],
        graphics: [{ spotAnimId: 444, height: 128, target: { kind: 'attached', actorId: target.id }, delayCycles: 0 }],
      },
    ]);
    expect(events.filter(isEncounterVisualEvent)[0]?.projectiles).toEqual([]);
  });

  it('swings at an adjacent player rather than heal a wounded ally', () => {
    const { world, minotaur, context } = fixture();
    world.registerNpc(javelin([16, 21], 3));
    expect(actions(minotaur, context, SPAWN_TICK + 3, SPAWN_TICK + 3)).toEqual([[13, 'melee']]);
  });

  it('keeps regenerating 5 HP every 20 ticks from its spawn, capped and without a splat', () => {
    // Two spawn ticks 7 apart: the pulse follows the spawn, not a global tick modulus.
    for (const spawnTick of [10, 17]) {
      const { context } = fixture({ player: [0, 0] });
      const shifted = createMinotaur({ id: 'shifted', position: [20, 21], spawnTick });
      shifted.vitals.hp = 212;
      const seen: [number, number][] = [];
      let splats = 0;
      for (let tick = spawnTick + 1; tick <= spawnTick + 80; tick++) {
        const before = shifted.vitals.hp;
        const tickContext = context(tick);
        registration.tick(shifted, tickContext);
        splats += tickContext.tickEvents.flush().filter((event) => isCoreEvent(event, 'hitsplat_spawned')).length;
        if (shifted.vitals.hp !== before) seen.push([tick - spawnTick, shifted.vitals.hp]);
      }
      expect(seen).toEqual([
        [20, 217],
        [40, 222],
        [60, 225],
      ]);
      expect(splats).toBe(0);
    }
  });

  it('stops regenerating once dying', () => {
    const { minotaur, context } = fixture({ player: [0, 0] });
    minotaur.vitals.hp = 0;
    recordNpcLethalTransition(minotaur, SPAWN_TICK + 19, 'hit-queue');
    registration.tick(minotaur, context(SPAWN_TICK + 20));
    expect(minotaur.vitals.hp).toBe(0);
  });

  it('holds still on its spawn tick and steps greedily from the next', () => {
    const { minotaur, context } = fixture({ position: [20, 30], player: [20, 20] });
    expect(registration.move(minotaur, context(SPAWN_TICK))).toEqual([]);
    expect(registration.move(minotaur, context(SPAWN_TICK + 1))).toEqual([{ npcId: minotaur.id, path: [[20, 29]] }]);
  });
});

describe('Red Flag minotaur (12813)', () => {
  // A 3x3 pillar straight between a minotaur to its south and the player to its north.
  const PILLAR: Coordinate[] = [24, 25, 26].flatMap((x) => [30, 31, 32].map((y): Coordinate => [x, y]));

  function walk(routefinding: boolean) {
    const { world, minotaur: ordinary, player, context } = fixture({ position: [24, 26], player: [25, 35] });
    world.removeActor(ordinary.id);
    const minotaur = createMinotaur({ id: 'minotaur', position: [24, 26], spawnTick: SPAWN_TICK, routefinding });
    world.registerNpc(minotaur);
    pillar(PILLAR);
    for (let tick = SPAWN_TICK + 1; tick <= SPAWN_TICK + 20; tick++) {
      minotaur.previousPosition = minotaur.position;
      world.occupancy.reconcile(world.getNpcs());
      const path = registration.move(minotaur, context(tick))[0]?.path ?? [];
      expect(path.length).toBeLessThanOrEqual(1);
      minotaur.position = [...(path.at(-1) ?? minotaur.position)];
    }
    return { minotaur, player, context };
  }

  it('routes around the pillar to the player, where 12812 stalls against it', () => {
    const stalled = walk(false);
    expect(stalled.minotaur.position).toEqual([25, 27]);
    expect(canNpcAttackFrom(stalled.minotaur, stalled.player.position)).toBe(false);
    const { minotaur, player, context } = walk(true);
    expect(canNpcAttackFrom(minotaur, player.position)).toBe(true);
    // Once there it swings like 12812.
    minotaur.combat.nextActionTick = SPAWN_TICK + 21;
    expect(registration.tick(minotaur, context(SPAWN_TICK + 21)).npcAttacks).toHaveLength(1);
  });

  it('is 12813 that other NPCs walk into, and otherwise the same minotaur', () => {
    const ordinary = createMinotaur({ id: 'minotaur', position: [20, 21], spawnTick: SPAWN_TICK, relentless: 2 });
    const redFlag = createMinotaur({
      id: 'minotaur',
      position: [20, 21],
      spawnTick: SPAWN_TICK,
      relentless: 2,
      routefinding: true,
    });
    expect(redFlag.npcTypeId).toBe(12813);
    expect(redFlag.blocksNpcMovement).toBe(false);
    expect(ordinary.npcTypeId).toBe(12812);
    expect(ordinary.blocksNpcMovement).toBeUndefined();
    const { npcTypeId: _a, blocksNpcMovement: _b, ...redFlagRest } = redFlag;
    const { npcTypeId: _c, ...ordinaryRest } = ordinary;
    expect(redFlagRest).toEqual(ordinaryRest);
  });

  it.each([false, true])('melees, heals and regenerates the same way (routefinding: %s)', (routefinding) => {
    const { world, minotaur: ordinary, player, context } = fixture({ position: [30, 30], player: [10, 10] });
    world.removeActor(ordinary.id);
    const minotaur = createMinotaur({ id: 'minotaur', position: [30, 30], spawnTick: SPAWN_TICK, routefinding });
    world.registerNpc(minotaur);
    world.registerNpc(javelin([25, 30], 10));
    minotaur.vitals.hp = 200;
    const first = actions(minotaur, context, SPAWN_TICK, SPAWN_TICK + 3);
    // The heal holds the combat clock for 10 ticks, which the attack timer then shows.
    expect(minotaur.combat.nextActionTick).toBe(SPAWN_TICK + 3 + 10);
    player.position = [31, 29];
    const rest = actions(minotaur, context, SPAWN_TICK + 4, SPAWN_TICK + 30);
    expect([...first, ...rest]).toEqual([
      [13, 'heal'],
      [23, 'melee'],
      [28, 'melee'],
      [33, 'melee'],
      [38, 'melee'],
    ]);
    expect(minotaur.vitals.hp).toBe(205);
  });
});

describe('Minotaur heal scan', () => {
  const minotaur = createMinotaur({ id: 'minotaur', position: [30, 30], spawnTick: 0 });
  // The minotaur's center is (31, 31); a 3x3 javelin at (x, 30) has its center on (x + 1, 31).

  it.each([
    { case: 'just below 75%', hp: 164, healed: true },
    { case: 'at 75%', hp: 165, healed: false },
  ])('needs the target $case HP', ({ hp, healed }) => {
    expect(selectMinotaurHealTarget(minotaur, [javelin([23, 30], hp)]) !== null).toBe(healed);
  });

  it.each([
    { centeredistance: 7, position: [23, 30] as Coordinate, healed: true },
    { centeredistance: 8, position: [22, 30] as Coordinate, healed: false },
  ])('reaches $centeredistance tiles center to center: $healed', ({ position, healed }) => {
    expect(selectMinotaurHealTarget(minotaur, [javelin(position, 3)]) !== null).toBe(healed);
  });

  it('needs line of sight between the centers, not just any footprint tile', () => {
    // A pillar on the center row between them; the footprints' other rows still see each other.
    pillar([[28, 31]]);
    expect(selectMinotaurHealTarget(minotaur, [javelin([24, 30], 3)])).toBeNull();
    setArenaConfig(OPEN_ARENA, true);
    expect(selectMinotaurHealTarget(minotaur, [javelin([24, 30], 3)])?.id).toBe('javelin');
  });

  it('skips other minotaurs, either variant, and the dying', () => {
    const other = createMinotaur({ id: 'other', position: [26, 30], spawnTick: 0 });
    other.vitals.hp = 10;
    const redFlag = { ...other, id: 'red_flag', npcTypeId: 12813 };
    const dying = javelin([24, 30], 0, 'dying');
    dying.alive = false;
    recordNpcLethalTransition(dying, 5, 'hit-queue');
    expect(selectMinotaurHealTarget(minotaur, [other, redFlag, dying])).toBeNull();
  });

  it('takes the first eligible NPC in processing order', () => {
    const world = new WorldState();
    const first = javelin([25, 30], 3, 'first');
    const second = javelin([33, 30], 3, 'second');
    world.registerNpc(first);
    world.registerNpc(second);
    expect(selectMinotaurHealTarget(minotaur, [second, first])?.id).toBe('first');
  });
});

/**
 * C:2478 through the engine: the wounded NPC's own turn (earlier in processing order) takes its hit,
 * then the minotaur's heals it to full; a totem heal due later that tick and the minotaur's own
 * regeneration pulse on the same tick change nothing about it.
 */
class MinotaurHealEncounter extends LobbyEncounter {
  private readonly definitions = new NpcDefinitionCollection([
    minotaurDefinition.register(undefined),
    healingTotemDefinition.register(undefined),
  ]);

  constructor(private readonly npcs: NpcActor[]) {
    super();
  }

  override createNpcs(): NpcActor[] {
    return this.npcs;
  }

  getNpcDefinitions(): NpcDefinitionCollection {
    return this.definitions;
  }

  processNpcTick(actor: NpcActor, ctx: EncounterContext): EncounterTickResult {
    return this.definitions.tick(actor, { ...ctx, random: () => 0.5 });
  }

  completeNpcBand(ctx: EncounterContext): EnvironmentalDamage[] {
    for (const totem of ctx.world.getNpcs().filter(healingTotemDefinition.isActor)) advanceHealingTotem(totem, ctx);
    return [];
  }
}

describe('Minotaur heal through the engine (C:2478)', () => {
  const HEAL_TICK = 20;

  function run(targetFirst: boolean) {
    const target = javelin([24, 30], 220);
    // Spawned at 0, so its regeneration pulse is due on the heal tick too.
    const minotaur = createMinotaur({ id: 'minotaur', position: [29, 34], spawnTick: 0 });
    minotaur.vitals.hp = 200;
    minotaur.combat.nextActionTick = HEAL_TICK;
    const totem = createHealingTotem({ id: 'totem', position: [23, 29], target, healAmount: 66, tick: 0 });
    totem.state.nextLaunchTick = Number.POSITIVE_INFINITY;
    totem.state.arrivals.push(HEAL_TICK);
    const engine = new SimulationEngine({
      encounter: new MinotaurHealEncounter(targetFirst ? [target, minotaur, totem] : [minotaur, target, totem]),
      startPos: [5, 5],
    });
    setArenaConfig(OPEN_ARENA, true);
    engine.setMechanicsConfig({ infiniteHealth: true });
    // Pinned, so it never reaches the player; the target is first wounded one tick before the heal.
    minotaur.debuffs = { boundUntilTick: 1000 };
    enqueueEnginePendingHit(engine, {
      sourceId: 'player',
      targetId: target.id,
      style: 'magic',
      attackKind: 'magic_shadow',
      launchTick: 0,
      impactTick: HEAL_TICK - 1,
      rolledDamage: 210,
      accuracySucceeded: true,
    });
    enqueueEnginePendingHit(engine, {
      sourceId: 'player',
      targetId: target.id,
      style: 'magic',
      attackKind: 'magic_shadow',
      launchTick: 0,
      impactTick: HEAL_TICK,
      rolledDamage: 7,
      accuracySucceeded: true,
    });
    let healTickEvents: GameEvent[] = [];
    let earlier: number | null = null;
    while (engine.currentTick < HEAL_TICK) {
      engine.advanceTick([5, 5]);
      if (engine.currentTick === HEAL_TICK - 1) earlier = target.vitals.hp;
      healTickEvents = engine.getLastTickEvents();
    }
    const splats = healTickEvents
      .filter((event) => isCoreEvent(event, 'hitsplat_spawned') && event.targetId === target.id)
      .map((event) => (isCoreEvent(event, 'hitsplat_spawned') ? [event.hitsplatType, event.amount] : null));
    return { target, minotaur, splats, earlier, healTickEvents };
  }

  it('lands the hit first, then heals the remainder to full, as the capture does', () => {
    const { target, minotaur, splats, earlier, healTickEvents } = run(true);
    expect(earlier).toBe(MINOTAUR_HEAL_WITNESS.targetMaxHp - 210);
    expect(target.vitals.hp).toBe(MINOTAUR_HEAL_WITNESS.targetMaxHp);
    // C:2478: 7, then the heal of 217; the totem's heal finds it full and adds nothing.
    expect(splats.filter((splat) => splat?.[1] !== 0)).toEqual([
      ['damage', 7],
      ['heal', 217],
    ]);
    expect(
      healTickEvents.some(
        (event) => isEncounterVisualEvent(event) && event.graphics.some((graphic) => graphic.spotAnimId === 444),
      ),
    ).toBe(true);
    // Its own pulse lands that tick without a splat of its own.
    expect(minotaur.vitals.hp).toBe(205);
    expect(
      healTickEvents.some((event) => isCoreEvent(event, 'hitsplat_spawned') && event.targetId === minotaur.id),
    ).toBe(false);
  });

  // MODEL consequence, uncaptured: a target processed after the minotaur takes this tick's hit after the
  // heal, and the band's later totem heal then tops it up.
  it('heals before the hit of a target later in processing order', () => {
    const { target, splats } = run(false);
    expect(splats.filter((splat) => splat?.[1] !== 0)).toEqual([
      ['heal', 210],
      ['damage', 7],
      ['heal', 7],
    ]);
    expect(target.vitals.hp).toBe(220);
  });
});
