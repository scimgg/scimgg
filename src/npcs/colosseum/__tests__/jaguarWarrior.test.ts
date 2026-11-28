import { afterEach, describe, expect, it } from 'vitest';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import { TickEvents } from '../../../core/events/TickEvents';
import type { NpcDefinitionContext } from '../../../core/npcs';
import { type Coordinate, PrayerType } from '../../../types/simulation';
import type { ColosseumRelentlessRank } from '../constants';
import { createJaguarWarrior, JAGUAR_WARRIOR_ATTACK_SPEED_TICKS, jaguarWarriorDefinition } from '../jaguarWarrior';
import { attackStarts, clearArena, playerHits, scriptedRandom, startWaveNpcEngine } from './jaguarShamanTestEngine';

const SPAWN_TICK = 10;
const registration = jaguarWarriorDefinition.register(undefined);

afterEach(clearArena);

/** One jaguar near the player in the engine's world, driven through its definition directly. */
function fixture(position: Coordinate, relentless?: ColosseumRelentlessRank) {
  const { engine, player } = startWaveNpcEngine([], { playerStart: [20, 20] });
  const world = engine['worldState'];
  const jaguar = createJaguarWarrior({ id: 'jaguar', position, spawnTick: SPAWN_TICK, relentless });
  world.actors.set(jaguar.id, jaguar);
  const context = (tick: number, random: () => number = () => 0.5): NpcDefinitionContext => ({
    tick,
    world,
    tickEvents: new TickEvents(),
    random,
    spawnNpc: () => undefined,
    despawnNpc: () => undefined,
    logEvent: () => undefined,
  });
  return { player, jaguar, context };
}

describe('jaguar warrior', () => {
  it('builds from its Wiki stats', () => {
    const { jaguar } = fixture([20, 21]);
    expect(jaguar).toMatchObject({
      npcTypeId: 12810,
      size: 2,
      vitals: { hp: 125, maxHp: 125 },
      combat: { attackSpeed: 5, attackRange: 1, attackStyle: 'melee', animations: { attack: 10847, death: 10849 } },
      formulaStats: { levels: { attack: 200, strength: 330, defence: 125, magic: 100, ranged: 160 } },
    });
    expect(jaguar.deathPolicy).toBe('queued');
  });

  it('claws three times in one attack, each with its own accuracy and damage roll, all landing at once', () => {
    const { jaguar, player, context } = fixture([20, 21]);
    // Accuracy then damage per hit: hit at the maximum, miss, hit for 0.
    const draws = [0, 0.999999, 0.999999, 0.5, 0, 0];
    const tickContext = context(SPAWN_TICK + 3, scriptedRandom(draws));

    const attacks = registration.tick(jaguar, tickContext).npcAttacks ?? [];

    expect(draws).toEqual([]);
    const shared = {
      attackerId: jaguar.id,
      targetId: player.id,
      style: 'melee',
      attackKind: 'melee_slash',
      impactDelayTicks: 0,
      sourceDeathPolicy: 'cancel-before-impact',
    };
    expect(attacks).toEqual([
      { ...shared, rolledDamage: 47, accuracySucceeded: true },
      { ...shared, rolledDamage: 24, accuracySucceeded: false, isContinuation: true },
      { ...shared, rolledDamage: 0, accuracySucceeded: true, isContinuation: true },
    ]);
    expect(tickContext.tickEvents.flush().filter(isEncounterVisualEvent)).toMatchObject([
      { animations: [{ actorId: jaguar.id, clipId: 'attack', delayCycles: 0 }], graphics: [] },
    ]);
  });

  it('lands all three splats on the attack tick, through the engine', () => {
    const jaguar = createJaguarWarrior({ id: 'jaguar', position: [20, 21], spawnTick: 0 });
    const { engine, encounter, step } = startWaveNpcEngine([jaguar], { playerStart: [20, 20] });
    engine.queueProtectionPrayer(PrayerType.ProtectMelee);
    encounter.random = () => 0;
    const ticks: { tick: number; swings: number; splats: number }[] = [];
    for (let tick = 1; tick <= 13; tick++) {
      const events = step([20, 20]);
      const swings = attackStarts(events, jaguar.id).length;
      const splats = playerHits(events).length;
      if (swings || splats) ticks.push({ tick, swings, splats });
    }
    // The spawn lockout to add+3, then the 5-tick cycle.
    expect(ticks).toEqual([3, 8, 13].map((tick) => ({ tick, swings: 1, splats: 3 })));
  });

  it.each([
    { case: 'diagonal', position: [21, 21] as Coordinate },
    { case: 'two tiles off', position: [20, 22] as Coordinate },
    { case: 'over the player', position: [19, 19] as Coordinate },
  ])('does not attack from $case', ({ position }) => {
    const { jaguar, context } = fixture(position);
    expect(registration.tick(jaguar, context(SPAWN_TICK + 3)).npcAttacks).toBeUndefined();
  });

  it.each([
    { side: 'north', position: [19, 21] as Coordinate },
    { side: 'east', position: [21, 19] as Coordinate },
    { side: 'south', position: [20, 18] as Coordinate },
    { side: 'west', position: [18, 20] as Coordinate },
  ])('attacks from any cardinal side of its 2x2 footprint ($side)', ({ position }) => {
    const { jaguar, context } = fixture(position);
    expect(registration.tick(jaguar, context(SPAWN_TICK + 3)).npcAttacks).toHaveLength(3);
    expect(jaguar.combat.nextActionTick).toBe(SPAWN_TICK + 3 + JAGUAR_WARRIOR_ATTACK_SPEED_TICKS);
  });

  it.each([
    { rank: 1, maxHit: 48 },
    { rank: 3, maxHit: 53 },
  ] as const)('raises each claw by the Relentless rank $rank bonus', ({ rank, maxHit }) => {
    const { jaguar, context } = fixture([20, 21], rank);
    const attacks =
      registration.tick(
        jaguar,
        context(SPAWN_TICK + 3, () => 0.999999),
      ).npcAttacks ?? [];
    expect(attacks.map((attack) => [attack.rolledDamage, attack.accuracySucceeded])).toEqual(
      Array(3).fill([maxHit, rank === 3]),
    );
  });
});
