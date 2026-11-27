import { afterEach, describe, expect, it } from 'vitest';
import { getArenaAllowUnboundedFallback, getArenaConfig, setArenaConfig } from '../../../core/constants';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { ordinaryPoisonDamage } from '../../../core/timers';
import { SOL_ACTOR_ID } from '../../../npcs/colosseum/constants';
import { PrayerType } from '../../../types/simulation';
import { beesDefinition } from '../../colosseum/modifiers/bees';
import { SOL_BEES_SPAWN_TICK } from '../constants';
import { SolHereditEncounter } from '../SolHereditEncounter';
import { SOL_BEES_CAPTURE_TICKS } from './fixtures/solBeesSpawnCapture';

const arena = getArenaConfig();
const unbounded = getArenaAllowUnboundedFallback();
afterEach(() => setArenaConfig(arena, unbounded));

function setup(tier: 1 | 2 | 3 = 1, withDoom = false) {
  const encounter = new SolHereditEncounter(7, { bees: tier, ...(withDoom ? { doom: 1, blasphemy: 3 } : {}) });
  const engine = new SimulationEngine({ encounter, combatRandom: () => 0.5 });
  engine.setMechanicsConfig({
    infiniteHealth: true,
    solHereditAttacks: false,
    solHereditBeams: false,
    solHereditSand: false,
  });
  const world = engine['worldState'];
  const bees = () => world.getNpcs().filter(beesDefinition.isActor);
  const advance = () => engine.advanceTick(world.getPlayer()!.position);
  const snapshot = () => {
    const state = engine.getState().encounter;
    if (state.kind !== 'sol_heredit') throw new Error('Expected Sol snapshot');
    return state.state;
  };
  const spawn = () => {
    while (engine.getState().currentTick < SOL_BEES_SPAWN_TICK) advance();
  };
  return { encounter, engine, world, bees, advance, snapshot, spawn };
}

describe('Sol Bees! integration', () => {
  it('uses A:4976 -> A:4984 = control+8, not the wave-message +5 anchor', () => {
    const { solAdded, beesAdded } = SOL_BEES_CAPTURE_TICKS;
    expect(solAdded).toBe(4976);
    expect(beesAdded).toBe(4984);
    expect(beesAdded - solAdded).toBe(SOL_BEES_SPAWN_TICK);
    const { engine, bees, advance, snapshot } = setup(3);
    for (let tick = 1; tick < 8; tick++) {
      advance();
      expect(bees()).toEqual([]);
    }
    advance();
    expect(bees()).toHaveLength(3);
    expect(snapshot().beeTiles).toEqual(bees().map((actor) => actor.position));
    expect(
      engine
        .getLastTickEvents()
        .filter(isEncounterVisualEvent)
        .flatMap((event) => event.animations),
    ).toEqual(bees().map((actor) => ({ actorId: actor.id, clipId: 'spawn', delayCycles: 0 })));
  });

  it.each([
    { kind: 'melee_slash', style: 'melee' },
    { kind: 'range_arrow', style: 'range' },
    { kind: 'magic_fire', style: 'magic' },
  ] as const)('allows a $style killing hit and retains the corpse through teleport and revival', ({ kind, style }) => {
    const { engine, encounter, world, bees, spawn, advance } = setup();
    spawn();
    const player = world.getPlayer()!;
    const bee = bees()[0]!;
    const home = [...bee.state.spawnPosition];
    bee.position = [36, 36];
    const ctx = { tick: 8, player, world };
    const validate = encounter.getEngineRules().validateAttack!;
    expect(validate(kind, bee.id, ctx)).not.toBe(false);
    expect(validate(kind, 'sol_crystal_0', ctx)).toBe(false);
    expect(validate(kind, 'sol_solarflare_0', ctx)).toBe(false);
    engine['combatSystem'].processAttackRequest(
      world,
      {
        attacker: player,
        target: bee,
        attack: { style, attackKind: kind, rolledDamage: 1, accuracySucceeded: true, impactDelayTicks: 0 },
      },
      engine['buildCombatBridge'](),
    );
    expect(bee.alive).toBe(false);
    expect(bee.combat.animations.death).toBe(10824);
    for (let tick = 9; tick < 68; tick++) {
      advance();
      expect(world.getNpc(bee.id)).toBe(bee);
      expect(bee.alive).toBe(false);
      expect(bee.position).toEqual(tick < 13 ? [36, 36] : home);
    }
    advance(); // Death 8 -> teleport 13 -> first resumed move 68.
    expect(bee.alive).toBe(true);
    expect(bee.vitals.hp).toBe(1);
    expect(bee.position).not.toEqual(home);
  });

  it.each([0, 0.999])('always lands a player hit on a swarm and kills it in one (combat roll %f)', (roll) => {
    // B and A: 17/17 first player hits on a swarm dealt its 1 HP (bow, Venator, SGS spec, scythe);
    // /w/Bee_Swarm: "only having 1 hitpoint and players are guaranteed a max hit".
    const encounter = new SolHereditEncounter(7, { bees: 1 });
    const engine = new SimulationEngine({ encounter, combatRandom: () => roll });
    engine.setMechanicsConfig({
      infiniteHealth: true,
      solHereditAttacks: false,
      solHereditBeams: false,
      solHereditSand: false,
    });
    const world = engine['worldState'];
    const advance = () => engine.advanceTick(world.getPlayer()!.position);
    while (engine.getState().currentTick < SOL_BEES_SPAWN_TICK) advance();
    const bee = world.getNpcs().filter(beesDefinition.isActor)[0]!;
    const player = world.getPlayer()!;
    player.position = [bee.position[0] - 1, bee.position[1]];
    engine.applyAction({ type: 'attackTarget', targetId: bee.id });
    for (let tick = 0; tick < 6 && bee.alive; tick++) advance();
    expect(bee.alive).toBe(false);
    const hits = engine.getDamageHistory().filter((hit) => hit.targetId === bee.id);
    expect(hits).toEqual([
      expect.objectContaining({ source: 'PlayerAttack', effectiveDamage: 1, hpBefore: 1, hpAfter: 0 }),
    ]);
    expect(engine.getLastTickEvents()).toContainEqual(
      expect.objectContaining({ type: 'hitsplat_spawned', targetId: bee.id, amount: 1 }),
    );
  });

  it.each([
    -20, 0, 25,
  ])('uses poison state %i, counts Doom, skips Blasphemy, and uses the damage hitsplat', (poisonVarp) => {
    const { engine, world, bees, spawn, advance, snapshot } = setup(1, true);
    spawn();
    const player = world.getPlayer()!;
    const bee = bees()[0]!;
    player.poisonState.poisonVarp = poisonVarp;
    player.position = [...bee.position];
    engine.queueProtectionPrayer(PrayerType.ProtectMelee);
    advance();
    const expected = poisonVarp < 0 ? 8 : 15;
    expect(engine.getDamageHistory()).toEqual([
      expect.objectContaining({ tick: 9, source: 'Bees', baseDamage: expected, effectiveDamage: expected }),
    ]);
    expect(snapshot().doomStacks).toBe(1);
    expect(player.prayerState.points).toBe(99);
    expect(player.activePrayer).toBe(PrayerType.ProtectMelee);
    expect(player.poisonState.poisonVarp).toBe(poisonVarp === 0 ? 5 : poisonVarp);
    if (poisonVarp === 0) {
      expect(ordinaryPoisonDamage(player.poisonState.poisonVarp)).toBe(1);
      expect(player.poisonState.poisonTickCounter).toBe(30);
      expect(player.poisonState.startedTick).toBe(9);
    }
    expect(engine.getLastTickEvents()).toContainEqual(
      expect.objectContaining({
        type: 'hitsplat_spawned',
        hitsplatType: 'damage',
        amount: expected,
      }),
    );
  });

  it('removes live and inactive bees with the crystals at Sol death+1', () => {
    const { engine, world, bees, spawn, advance, snapshot } = setup(3);
    spawn();
    engine.executeEncounterCommand({ encounter: 'sol_heredit', type: 'spawn-crystal' });
    const player = world.getPlayer()!;
    engine['combatSystem'].processAttackRequest(
      world,
      {
        attacker: player,
        target: bees()[0]!,
        attack: {
          style: 'melee',
          attackKind: 'melee_slash',
          rolledDamage: 1,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        },
      },
      engine['buildCombatBridge'](),
    );
    engine['combatSystem'].processAttackRequest(
      world,
      {
        attacker: player,
        target: world.getNpc(SOL_ACTOR_ID)!,
        attack: {
          style: 'melee',
          attackKind: 'melee_slash',
          rolledDamage: 1500,
          accuracySucceeded: true,
          impactDelayTicks: 1,
        },
      },
      engine['buildCombatBridge']({ enablePendingHits: true }),
    );
    advance(); // Sol dies during tick 9, adjudicated at its end.
    expect(snapshot().beeTiles).toHaveLength(3);
    expect(snapshot().crystalCount).toBe(1);
    advance();
    expect(snapshot().beeTiles).toEqual([]);
    expect(snapshot().crystalCount).toBe(0);
    expect(engine.getLastTickEvents().filter((event) => event.type === 'actor_despawned')).toHaveLength(4);
  });

  it('uses the bee start footprint: moving to cover the player cannot sting until the next tick', () => {
    const { engine, world, bees, spawn, advance } = setup();
    spawn();
    const bee = bees()[0]!;
    bee.position = [30, 32];
    bee.state.destination = [31, 32];
    bee.state.nextWindowTick = 21; // A planned first window, independent of its random draw.
    world.getPlayer()!.position = [32, 32];
    world.getPlayer()!.poisonState.poisonVarp = -20;
    advance();
    expect(bee.previousPosition).toEqual([30, 32]);
    expect(bee.position).toEqual([31, 32]);
    expect(engine.getDamageHistory()).toEqual([]);
    advance();
    expect(engine.getDamageHistory()).toEqual([expect.objectContaining({ tick: 10, source: 'Bees' })]);
  });

  it('does not sting when killed by a due hit before the NPC action phase', () => {
    const { engine, world, bees, spawn, advance } = setup();
    spawn();
    const bee = bees()[0]!;
    const player = world.getPlayer()!;
    player.position = [...bee.position];
    engine['combatSystem'].processAttackRequest(
      world,
      {
        attacker: player,
        target: bee,
        attack: {
          style: 'magic',
          attackKind: 'magic_fire',
          rolledDamage: 1,
          accuracySucceeded: true,
          impactDelayTicks: 1,
        },
      },
      engine['buildCombatBridge']({ enablePendingHits: true }),
    );
    advance();
    expect(bee.alive).toBe(false);
    expect(engine.getDamageHistory().filter((hit) => hit.source === 'Bees')).toEqual([]);
  });

  it('resets seeded spawns, movement and dead-bee timers deterministically', () => {
    const { engine, world, bees, advance, snapshot } = setup(3);
    const config = engine.getRunConfig();
    const states = [];
    for (let tick = 1; tick <= 40; tick++) {
      advance();
      states.push(structuredClone(snapshot()));
    }
    const corpse = bees()[0]!;
    engine['combatSystem'].processAttackRequest(
      world,
      {
        attacker: world.getPlayer()!,
        target: corpse,
        attack: {
          style: 'melee',
          attackKind: 'melee_slash',
          rolledDamage: 1,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        },
      },
      engine['buildCombatBridge'](),
    );
    advance();
    expect(corpse.state.teleportAt).toBe(45);
    engine.reset(undefined, config);
    expect(snapshot().beeTiles).toEqual([]);
    for (let tick = 1; tick <= 40; tick++) {
      advance();
      expect(snapshot()).toEqual(states[tick - 1]);
    }
    expect(bees()).toHaveLength(3);
  });
});
