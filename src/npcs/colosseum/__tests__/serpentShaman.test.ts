import { afterEach, describe, expect, it } from 'vitest';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import { TickEvents } from '../../../core/events/TickEvents';
import type { NpcDefinitionContext } from '../../../core/npcs';
import type { Coordinate } from '../../../types/simulation';
import type { ColosseumRelentlessRank } from '../constants';
import {
  createSerpentShaman,
  SERPENT_SHAMAN_ATTACK_SPEED_TICKS,
  serpentShamanDefinition,
  serpentShamanHitDelayTicks,
  serpentShamanProjectileEndCycles,
} from '../serpentShaman';
import { attackStarts, clearArena, startWaveNpcEngine } from './jaguarShamanTestEngine';

const SPAWN_TICK = 10;
const registration = serpentShamanDefinition.register(undefined);

afterEach(clearArena);

/** One shaman beside the player in the engine's world, driven through its definition directly. */
function fixture(position: Coordinate, playerTile: Coordinate = [20, 20], relentless?: ColosseumRelentlessRank) {
  const { engine, player } = startWaveNpcEngine([], { playerStart: playerTile });
  const world = engine['worldState'];
  const shaman = createSerpentShaman({ id: 'shaman', position, spawnTick: SPAWN_TICK, relentless });
  world.actors.set(shaman.id, shaman);
  const context = (tick: number, random: () => number = () => 0.5): NpcDefinitionContext => ({
    tick,
    world,
    tickEvents: new TickEvents(),
    random,
    spawnNpc: () => undefined,
    despawnNpc: () => undefined,
    logEvent: () => undefined,
  });
  return { player, shaman, context };
}

describe('serpent shaman', () => {
  it('builds from its Wiki stats', () => {
    const { shaman } = fixture([20, 25]);
    expect(shaman).toMatchObject({
      npcTypeId: 12811,
      size: 1,
      vitals: { hp: 125, maxHp: 125 },
      combat: { attackSpeed: 5, attackRange: 10, attackStyle: 'magic', animations: { attack: 10859, death: 10860 } },
      formulaStats: { levels: { attack: 100, strength: 90, defence: 90, magic: 220, ranged: 160 } },
    });
    expect(shaman.deathPolicy).toBe('queued');
  });

  it.each([
    { distance: 1, end: 80, delay: 3 },
    { distance: 3, end: 80, delay: 3 },
    { distance: 4, end: 83, delay: 3 },
    { distance: 8, end: 99, delay: 3 },
    { distance: 9, end: 103, delay: 4 },
    { distance: 10, end: 107, delay: 4 },
  ])('flies to cycle $end and lands +$delay at distance $distance', ({ distance, end, delay }) => {
    expect(serpentShamanProjectileEndCycles(distance)).toBe(end);
    expect(serpentShamanHitDelayTicks(distance)).toBe(delay);
  });

  it.each([
    { distance: 8, delay: 3 },
    { distance: 9, delay: 4 },
  ])('queues its cast to land +$delay at distance $distance, rolled up to 28 magic', ({ distance, delay }) => {
    const { shaman, player, context } = fixture([20, 20 + distance]);
    const tickContext = context(SPAWN_TICK + 3, () => 0.999999);

    const [attack] = registration.tick(shaman, tickContext).npcAttacks ?? [];

    expect(attack).toEqual({
      attackerId: shaman.id,
      targetId: player.id,
      style: 'magic',
      attackKind: 'magic_water',
      rolledDamage: 28,
      accuracySucceeded: false,
      impactDelayTicks: delay,
      sourceDeathPolicy: 'persist',
    });
  });

  it('casts the captured Water Surge cue: casting graphic, projectile and, when accurate, the impact', () => {
    const { shaman, player, context } = fixture([22, 24]);
    const tickContext = context(SPAWN_TICK + 3, () => 0);

    registration.tick(shaman, tickContext);
    const [visual] = tickContext.tickEvents.flush().filter(isEncounterVisualEvent);

    expect(visual).toMatchObject({
      animations: [{ actorId: shaman.id, clipId: 'attack', delayCycles: 0 }],
      graphics: [
        { spotAnimId: 1458, target: { kind: 'attached', actorId: shaman.id }, delayCycles: 0, height: 92 },
        { spotAnimId: 1460, target: { kind: 'attached', actorId: player.id }, delayCycles: 83, height: 124 },
      ],
      projectiles: [
        {
          spotAnimId: 1459,
          sourcePosition: [22.5, 24.5],
          target: { kind: 'actor', actorId: player.id, size: 1, position: [20, 20] },
          startDelayCycles: 67,
          endDelayCycles: 83,
          slope: 14,
          startOffset: 32,
          startHeight: 172,
          endHeight: 146,
        },
      ],
    });
  });

  it('shows no impact graphic for an inaccurate cast', () => {
    const { shaman, context } = fixture([20, 22]);
    const tickContext = context(SPAWN_TICK + 3, () => 0.999999);

    registration.tick(shaman, tickContext);
    const [visual] = tickContext.tickEvents.flush().filter(isEncounterVisualEvent);

    expect(visual?.graphics.map((graphic) => graphic.spotAnimId)).toEqual([1458]);
  });

  it('casts first at add+3 and then every 5 ticks while it has reach', () => {
    const { shaman, context } = fixture([20, 25]);
    const castTicks: number[] = [];
    for (let tick = SPAWN_TICK; tick <= SPAWN_TICK + 14; tick++) {
      if (registration.tick(shaman, context(tick)).npcAttacks?.length) castTicks.push(tick);
    }
    expect(castTicks).toEqual([13, 18, 23]);
    expect(shaman.combat.nextActionTick).toBe(23 + SERPENT_SHAMAN_ATTACK_SPEED_TICKS);
  });

  it('reaches 10 tiles and not 11', () => {
    const near = fixture([20, 30]);
    expect(registration.tick(near.shaman, near.context(13)).npcAttacks).toHaveLength(1);
    const far = fixture([20, 31]);
    expect(registration.tick(far.shaman, far.context(13)).npcAttacks).toBeUndefined();
  });

  it.each([
    { rank: 1, maxHit: 29 },
    { rank: 2, maxHit: 31 },
    { rank: 3, maxHit: 34 },
  ] as const)('raises its max hit by the Relentless rank $rank bonus', ({ rank, maxHit }) => {
    const { shaman, context } = fixture([20, 22], [20, 20], rank);
    const [attack] =
      registration.tick(
        shaman,
        context(13, () => 0.999999),
      ).npcAttacks ?? [];
    expect(attack?.rolledDamage).toBe(maxHit);
    expect(attack?.accuracySucceeded).toBe(rank === 3);
  });

  it('holds on its add tick, then walks in on add+1 although it already has reach', () => {
    const shaman = createSerpentShaman({ id: 'shaman', position: [25, 25], spawnTick: 1 });
    const { step } = startWaveNpcEngine([shaman], { playerStart: [20, 20] });

    step([20, 20]);
    expect(shaman.position).toEqual([25, 25]);
    step([20, 20]);
    expect(shaman.position).toEqual([24, 24]);
    // Reach from there: it stays put and casts at add+3.
    expect(attackStarts(step([20, 20]), shaman.id)).toEqual([]);
    expect(shaman.position).toEqual([24, 24]);
    expect(attackStarts(step([20, 20]), shaman.id)).toHaveLength(1);
  });
});
