import { afterEach, describe, expect, it } from 'vitest';
import type { NpcActor } from '../../../core/actors/NpcActor';
import { promoteHitQueueDeath, recordNpcLethalTransition } from '../../../core/npcDeath';
import type { NpcDefinitionContext, NpcDefinitionRegistration } from '../../../core/npcs';
import type { Coordinate } from '../../../types/simulation';
import { COLOSSUS_ATTACK_PERIOD_TICKS, COLOSSUS_FIRST_ATTACK_TICKS, hasColossusReach } from '../colossusReach';
import { createJavelinColossus, javelinColossusDefinition } from '../javelinColossus';
import { createShockwaveColossus, shockwaveColossusDefinition } from '../shockwaveColossus';
import { colossusWorld, definitionContext, resetArena } from './colossusReachHarness';

afterEach(resetArena);

const SPAWN_TICK = 100;
const SPECIES = [
  { name: 'javelin', create: createJavelinColossus, registration: javelinColossusDefinition.register(undefined) },
  { name: 'shockwave', create: createShockwaveColossus, registration: shockwaveColossusDefinition.register(undefined) },
] as const;

/** West of the pillar (24..26, 41..43): a colossus east of it at (28, 41) is hidden from (22, 42), seen from (22, 38). */
const HIDDEN_PLAYER: Coordinate = [22, 42];
const SEEN_PLAYER: Coordinate = [22, 38];
const EAST_OF_PILLAR: Coordinate = [28, 41];

/** Whether the turn launched: a hit request, or the javelin's artillery cast (a visual with no request). */
function launches(registration: NpcDefinitionRegistration, actor: NpcActor, context: NpcDefinitionContext): boolean {
  return (registration.tick(actor, context).npcAttacks?.length ?? 0) > 0 || context.tickEvents.flush().length > 0;
}

describe.each(SPECIES)('$name colossus shared turn', ({ create, registration }) => {
  function setup(position: Coordinate, playerTile: Coordinate) {
    const { world, player } = colossusWorld(playerTile);
    const colossus = create({ id: 'colossus', position, spawnTick: SPAWN_TICK });
    world.actors.set(colossus.id, colossus);
    return { world, player, colossus };
  }

  it('takes one approach step on add+1 although it can already attack, then stands (A:838, 42/42)', () => {
    const { world, colossus } = setup(EAST_OF_PILLAR, SEEN_PLAYER);
    expect(hasColossusReach(colossus, world.getPlayer()!)).toBe(true);
    expect(registration.move(colossus, definitionContext(world, SPAWN_TICK))).toEqual([]);
    expect(registration.move(colossus, definitionContext(world, SPAWN_TICK + 1))).toEqual([
      { npcId: colossus.id, path: [[27, 40]] },
    ]);
    expect(registration.move(colossus, definitionContext(world, SPAWN_TICK + 2))).toEqual([]);
  });

  it('launches no earlier than add+3, then every five ticks while it has reach', () => {
    const { world, colossus } = setup(EAST_OF_PILLAR, SEEN_PLAYER);
    const launched: number[] = [];
    for (let tick = SPAWN_TICK + 1; tick <= SPAWN_TICK + 14; tick++) {
      if (launches(registration, colossus, definitionContext(world, tick))) launched.push(tick - SPAWN_TICK);
    }
    expect(launched).toEqual([
      COLOSSUS_FIRST_ATTACK_TICKS,
      COLOSSUS_FIRST_ATTACK_TICKS + COLOSSUS_ATTACK_PERIOD_TICKS,
      COLOSSUS_FIRST_ATTACK_TICKS + 2 * COLOSSUS_ATTACK_PERIOD_TICKS,
    ]);
  });

  it('holds while a pillar blocks the ray from the player, and launches the tick it is seen', () => {
    const { world, player, colossus } = setup(EAST_OF_PILLAR, HIDDEN_PLAYER);
    for (let tick = SPAWN_TICK + 3; tick < SPAWN_TICK + 9; tick++) {
      expect(launches(registration, colossus, definitionContext(world, tick)), `tick ${tick}`).toBe(false);
    }
    player.position = [...SEEN_PLAYER];
    expect(launches(registration, colossus, definitionContext(world, SPAWN_TICK + 9))).toBe(true);
  });

  it('walks toward a player it cannot reach, and stops once it can', () => {
    const { world, colossus } = setup([45, 41], [22, 38]);
    // Box distance 20 > 15: the standard combat step west.
    expect(registration.move(colossus, definitionContext(world, SPAWN_TICK + 2))).toEqual([
      { npcId: colossus.id, path: [[44, 40]] },
    ]);
    colossus.position = [37, 38];
    expect(registration.move(colossus, definitionContext(world, SPAWN_TICK + 3))).toEqual([]);
  });

  it.each([
    { tile: [37, 38] as Coordinate, distance: 15, attacks: true },
    { tile: [38, 38] as Coordinate, distance: 16, attacks: false },
  ])('attacks at box distance $distance: $attacks', ({ tile, attacks }) => {
    const { world, colossus } = setup(tile, [22, 38]);
    expect(launches(registration, colossus, definitionContext(world, SPAWN_TICK + 3))).toBe(attacks);
  });

  it('never attacks a player under it', () => {
    const { world, colossus } = setup(EAST_OF_PILLAR, [29, 42]);
    expect(launches(registration, colossus, definitionContext(world, SPAWN_TICK + 3))).toBe(false);
  });

  it.each([
    { promoted: false, why: 'its turn still runs (A:2249, death sequence A:2250)' },
    { promoted: true, why: 'its death is processed at once (A:918)' },
  ])('launches nothing on its killing tick: $why', ({ promoted }) => {
    const { world, colossus } = setup(EAST_OF_PILLAR, SEEN_PLAYER);
    const tick = SPAWN_TICK + 3;
    recordNpcLethalTransition(colossus, tick, 'hit-queue');
    if (promoted) promoteHitQueueDeath(colossus, tick);
    expect(launches(registration, colossus, definitionContext(world, tick))).toBe(false);
  });
});
