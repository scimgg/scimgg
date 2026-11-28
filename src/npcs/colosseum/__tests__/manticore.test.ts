import { afterEach, describe, expect, it } from 'vitest';
import type { NpcActor } from '../../../core/actors/NpcActor';
import { setArenaConfig } from '../../../core/constants';
import type { EncounterContext, EncounterTickResult, NpcAttackRequest } from '../../../core/encounters/types';
import { type EncounterVisualEvent, isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import { TickEvents } from '../../../core/events/TickEvents';
import type { GameEvent } from '../../../core/events/types';
import { NpcDefinitionCollection, type NpcDefinitionContext } from '../../../core/npcs';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { LobbyEncounter } from '../../../encounters/lobby/LobbyEncounter';
import { enqueueEnginePendingHit } from '../../../test/helpers/pendingHits';
import { type Coordinate, PrayerType } from '../../../types/simulation';
import type { ColosseumRelentlessRank } from '../constants';
import {
  createManticore,
  MANTICORE_ATTACK_RANGE,
  MANTICORE_ORB_SPOTANIMS,
  MANTICORE_SEQS,
  type ManticoreActor,
  type ManticoreFirstStyle,
  manticoreDefinition,
  manticoreHeldOrbs,
  manticoreOrbSequence,
  releaseManticoreKillTurn,
} from '../manticore';
import { MANTICORE_KILLED_MID_THROW, MANTICORE_PRAYER_CAPTURE } from './fixtures/manticoreCapture';

const registration = manticoreDefinition.register(undefined);
const OPEN_ARENA = { bounds: null, walkableTiles: null, collisionMap: null };

afterEach(() => setArenaConfig(OPEN_ARENA, true));

/** Manticores ticked directly, in the given order, against a player standing where each tick says. */
function directFixture(manticores: readonly ManticoreActor[], random: () => number = () => 0.5) {
  const world = new SimulationEngine({ encounter: new LobbyEncounter() })['worldState'];
  setArenaConfig(OPEN_ARENA, true);
  const player = world.getPlayer()!;
  world.actors.clear();
  world.actors.set(player.id, player);
  for (const manticore of manticores) world.actors.set(manticore.id, manticore);
  const visuals: EncounterVisualEvent[] = [];
  const attacks: { tick: number; attack: NpcAttackRequest }[] = [];
  const contextAt = (tick: number): NpcDefinitionContext => {
    const tickEvents = new TickEvents();
    tickEvents.setTick(tick);
    return {
      tick,
      world,
      tickEvents,
      random,
      spawnNpc: () => undefined,
      despawnNpc: () => undefined,
      logEvent: () => undefined,
    };
  };
  const run = (tick: number) => {
    const context = contextAt(tick);
    const { tickEvents } = context;
    for (const manticore of manticores) {
      for (const attack of registration.tick(manticore, context).npcAttacks ?? []) attacks.push({ tick, attack });
    }
    visuals.push(...tickEvents.flush().filter(isEncounterVisualEvent));
  };
  const runTo = (last: number, from = 0) => {
    for (let tick = from; tick <= last; tick++) run(tick);
  };
  const clipTicks = (actorId: string, clipId: string) =>
    visuals.flatMap((event) =>
      event.animations.some((cue) => cue.actorId === actorId && cue.clipId === clipId) ? [event.tick] : [],
    );
  const throwTicks = (actorId: string) => clipTicks(actorId, 'throw');
  const timer = (manticore: ManticoreActor, tick: number) => registration.attackTimer(manticore, contextAt(tick));
  return { world, player, visuals, attacks, run, runTo, clipTicks, throwTicks, timer };
}

const manticore = (
  id: string,
  position: Coordinate,
  firstStyle: ManticoreFirstStyle = 'magic',
  relentless?: ColosseumRelentlessRank,
) => createManticore({ id, position, spawnTick: 0, firstStyle, ...(relentless === undefined ? {} : { relentless }) });

describe('createManticore', () => {
  it('builds a 3x3, 250 HP range-15 Manticore from the Wiki row with its fixed orb order', () => {
    const actor = manticore('m', [10, 10], 'ranged');
    expect(actor).toMatchObject({ npcTypeId: 12818, size: 3, vitals: { hp: 250, maxHp: 250 }, spawnTick: 0 });
    expect(actor.combat).toMatchObject({ attackRange: MANTICORE_ATTACK_RANGE, attackSpeed: 10 });
    expect(actor.combat.animations).toMatchObject({ idle: 10863, walk: 10864, death: MANTICORE_SEQS.death });
    expect(manticoreOrbSequence('ranged')).toEqual(['ranged', 'magic', 'melee']);
    expect(manticoreOrbSequence('magic')).toEqual(['magic', 'ranged', 'melee']);
  });
});

describe('Manticore cycle', () => {
  it('spots at spawn+3, charges 4 later, throws at charge+6 and recharges 4 after', () => {
    const actor = manticore('m', [10, 10], 'magic');
    const { player, visuals, attacks, runTo, clipTicks } = directFixture([actor]);
    player.position = [10, 18]; // box distance 6, in the open
    runTo(30);

    expect(clipTicks('m', 'charge')).toEqual([7, 17, 27]);
    expect(clipTicks('m', 'throw')).toEqual([13, 23]);
    // Orbs are presented from state (`manticoreHeldOrbs`), never as one-shot graphics.
    expect(visuals.flatMap((event) => event.graphics)).toEqual([]);
    expect(attacks.map(({ tick, attack }) => [tick, attack.style, attack.impactDelayTicks])).toEqual([
      [13, 'magic', 1],
      [14, 'range', 1],
      [15, 'melee', 1],
      [23, 'magic', 1],
      [24, 'range', 1],
      [25, 'melee', 1],
    ]);
    const projectiles = visuals.flatMap((event) => event.projectiles.map((cue) => ({ tick: event.tick, ...cue })));
    expect(projectiles.slice(0, 3)).toMatchObject([
      {
        tick: 13,
        spotAnimId: 2681,
        startOffset: 50,
        startHeight: 300,
        endHeight: 50,
        startDelayCycles: 0,
        endDelayCycles: 30,
        slope: 127,
      },
      { tick: 14, spotAnimId: 2683, startOffset: 0, startHeight: 400 },
      { tick: 15, spotAnimId: 2685, startOffset: 0, startHeight: 500 },
    ]);
    expect(projectiles[0]).toMatchObject({
      sourcePosition: [11.5, 11.5],
      target: { kind: 'actor', actorId: 'player' },
    });
  });

  it('holds one more orb each tick from charge+1 and clears each slot on its launch tick', () => {
    const actor = manticore('m', [10, 10], 'ranged');
    const { player, run } = directFixture([actor]);
    player.position = [10, 18];
    const held: [number, [number, number][]][] = [];
    for (let tick = 0; tick <= 17; tick++) {
      run(tick);
      held.push([tick, manticoreHeldOrbs(actor, tick).map((orb) => [orb.spotAnimId, orb.height])]);
    }
    const ranged = [MANTICORE_ORB_SPOTANIMS.ranged, 300];
    const magic = [MANTICORE_ORB_SPOTANIMS.magic, 400];
    const melee = [MANTICORE_ORB_SPOTANIMS.melee, 500];
    expect(held.slice(7)).toEqual([
      [7, []], // charge
      [8, [ranged]],
      [9, [ranged, magic]],
      [10, [ranged, magic, melee]],
      [11, [ranged, magic, melee]],
      [12, [ranged, magic, melee]],
      [13, [magic, melee]], // throw: the first slot clears with its launch
      [14, [melee]],
      [15, []],
      [16, []],
      [17, []], // the next charge; its orbs follow from 18
    ]);
    expect(manticoreHeldOrbs(actor, 18).map(({ actorId }) => actorId)).toEqual(['m']);
  });

  it('holds its charged orbs without reach, neither throwing nor recharging, and throws once it has reach', () => {
    const actor = manticore('m', [10, 10]);
    const { player, run, clipTicks, throwTicks } = directFixture([actor]);
    player.position = [10, 18];
    for (let tick = 0; tick <= 12; tick++) run(tick);
    player.position = [10, 40]; // box distance 28
    for (let tick = 13; tick <= 60; tick++) {
      run(tick);
      expect(manticoreHeldOrbs(actor, tick), `tick ${tick}`).toHaveLength(3);
    }
    expect(throwTicks('m')).toEqual([]);
    expect(clipTicks('m', 'charge')).toEqual([7]);
    player.position = [10, 18];
    for (let tick = 61; tick <= 75; tick++) run(tick);
    expect(throwTicks('m')).toEqual([61, 71]);
    expect(clipTicks('m', 'charge')).toEqual([7, 65, 75]);
  });

  it('throws from beside the player but not from under it, and has no separate melee attack', () => {
    const adjacent = manticore('m', [10, 10], 'ranged');
    const beside = directFixture([adjacent]);
    beside.player.position = [13, 11];
    beside.runTo(13);
    expect(beside.attacks.map(({ tick, attack }) => [tick, attack.style])).toEqual([[13, 'range']]);

    const overlapping = manticore('m', [10, 10]);
    const under = directFixture([overlapping]);
    under.player.position = [11, 11];
    under.runTo(30);
    expect(under.attacks).toEqual([]);
  });

  it('finishes a started throw even after the player leaves its reach (A:2864)', () => {
    const actor = manticore('m', [10, 10]);
    const { player, run, attacks } = directFixture([actor]);
    player.position = [10, 18];
    for (let tick = 0; tick <= 13; tick++) run(tick);
    player.position = [10, 40];
    run(14);
    run(15);
    expect(attacks.map(({ tick }) => tick)).toEqual([13, 14, 15]);
  });
});

describe('Manticore pair delay', () => {
  it('lets the earlier in processing order throw first on a tie, then alternates five apart (A:3428, C:3636)', () => {
    const first = manticore('first', [10, 10]);
    const second = manticore('second', [16, 10]);
    const { player, runTo, throwTicks, timer } = directFixture([first, second]);
    player.position = [14, 18];
    runTo(13);
    // Both were ready on 13; the delayed one's timer already counts to its throw.
    expect(timer(second, 13)).toEqual({ nextAttackTick: 18, attackSpeed: 10 });
    runTo(45, 14);
    expect(throwTicks('first')).toEqual([13, 23, 33, 43]);
    expect(throwTicks('second')).toEqual([18, 28, 38]);
  });

  it('does not delay one that was not yet ready when the other threw (Wiki overlap)', () => {
    const early = manticore('early', [10, 10]);
    const late = createManticore({ id: 'late', position: [16, 10], spawnTick: 2, firstStyle: 'magic' });
    const { player, runTo, throwTicks } = directFixture([early, late]);
    player.position = [14, 18];
    runTo(16);
    // `late` charges at 9 and is ready at 15, two ticks after `early` threw.
    expect(throwTicks('early')).toEqual([13]);
    expect(throwTicks('late')).toEqual([15]);
  });
});

describe('Manticore Relentless', () => {
  it.each([
    [0, 31, false],
    [3, 37, true],
  ] as const)('rank %i: melee orb max %i, always hits %s', (rank, maxHit, alwaysHits) => {
    const actor = manticore('m', [10, 10], 'magic', rank);
    const { player, runTo, attacks } = directFixture([actor], () => 0.999999);
    player.position = [10, 18];
    runTo(15);
    const melee = attacks.find(({ attack }) => attack.style === 'melee')!.attack;
    expect(melee.rolledDamage).toBe(maxHit);
    if (alwaysHits) expect(melee.accuracySucceeded).toBe(true);
  });
});

/** Manticores through the real engine, each in its own turn; the player stands still. */
class ManticoreEngineEncounter extends LobbyEncounter {
  private readonly definitions = new NpcDefinitionCollection([manticoreDefinition.register(undefined)]);

  constructor(
    private readonly manticores: readonly NpcActor[],
    private readonly random: () => number,
  ) {
    super();
  }

  override createNpcs(): NpcActor[] {
    return [...this.manticores];
  }

  getNpcDefinitions(): NpcDefinitionCollection {
    return this.definitions;
  }

  processNpcTick(actor: NpcActor, ctx: EncounterContext): EncounterTickResult {
    return this.definitions.tick(actor, { ...ctx, random: this.random });
  }

  /** As the wave owner routes it: the encounter's own stream, never the engine's. */
  releaseNpcKillTurn(actor: NpcActor, ctx: EncounterContext): readonly NpcAttackRequest[] {
    return manticoreDefinition.isActor(actor) ? releaseManticoreKillTurn(actor, { ...ctx, random: this.random }) : [];
  }
}

function engineFixture(actor: ManticoreActor, startPos: Coordinate, random: () => number = () => 0.99) {
  const engine = new SimulationEngine({ encounter: new ManticoreEngineEncounter([actor], random), startPos });
  engine.setMechanicsConfig({ infiniteHealth: true });
  // After the engine and its mechanics, which both install the encounter's arena.
  setArenaConfig(OPEN_ARENA, true);
  const player = engine['worldState'].getPlayer()!;
  const events: GameEvent[] = [];
  const advanceTo = (tick: number, beforeTick?: (next: number) => void) => {
    while (engine.currentTick < tick) {
      beforeTick?.(engine.currentTick + 1);
      engine.advanceTick([...startPos]);
      events.push(...engine.getLastTickEvents());
    }
  };
  return { engine, player, events, advanceTo };
}

const PRAYERS = {
  magic: PrayerType.ProtectMagic,
  missiles: PrayerType.ProtectRange,
  melee: PrayerType.ProtectMelee,
} as const;

/** The first tick it can throw: spawn 0, spotted on 3, charged on 7, ready on 13. */
const FIRST_THROW = 13;

describe('Manticore through the engine', () => {
  it('walks one step on spawn+1 even with reach, then stands while it has reach (A:1128, C:1799)', () => {
    const actor = manticore('m', [10, 10]);
    const { advanceTo } = engineFixture(actor, [10, 20]);
    // The engine's first processed tick is 1, the add tick's successor.
    advanceTo(1);
    expect(actor.position).toEqual([10, 11]);
    advanceTo(10);
    expect(actor.position).toEqual([10, 11]);
  });

  // Each captured throw (`MANTICORE_PRAYER_CAPTURE`): the prayer on after the launch tick's input decides
  // the orb, whatever is on when it lands.
  it.each([
    ['A:1591-1593', 'waves', 1591, 'ranged'],
    ['A:2863-2865', 'waves', 2863, 'magic'],
  ] as const)('checks protection at each orb launch, not landing (%s)', (_, capture, launchTick, first) => {
    const cases = MANTICORE_PRAYER_CAPTURE.filter(
      (entry) => entry.capture === capture && entry.launchTick >= launchTick && entry.launchTick < launchTick + 3,
    );
    expect(cases.map((entry) => entry.style)).toEqual(manticoreOrbSequence(first));
    // Relentless III skips the accuracy roll, so only the prayer can make an orb deal 0.
    const actor = manticore('m', [10, 10], first, 3);
    const { engine, player, advanceTo } = engineFixture(actor, [10, 18]);
    advanceTo(FIRST_THROW + 3, (next) => {
      const orb = cases[next - FIRST_THROW];
      if (orb) player.activePrayer = orb.prayerAtLaunch === null ? null : PRAYERS[orb.prayerAtLaunch];
      if (next === FIRST_THROW + 3) {
        const last = cases.at(-1)!;
        player.activePrayer = last.prayerAtLanding === null ? null : PRAYERS[last.prayerAtLanding];
      }
    });
    const hits = engine.getDamageHistory().filter((hit) => hit.sourceNpcTypeId === 12818);
    expect(hits.map((hit) => [hit.tick, hit.effectiveDamage])).toEqual([
      [FIRST_THROW + 1, 0],
      [FIRST_THROW + 2, 0],
      [FIRST_THROW + 3, 0],
    ]);
  });

  it('lets an orb launched without its prayer through, though the prayer is on when it lands (A:1702 -> 1703)', () => {
    const [orb] = MANTICORE_PRAYER_CAPTURE.filter((entry) => entry.capture === 'waves' && entry.launchTick === 1702);
    expect(orb).toMatchObject({ style: 'magic', prayerAtLaunch: 'missiles', splats: [[16, 13]] });
    // Relentless III skips the accuracy roll, so the unprotected orb always deals its rolled damage.
    const actor = manticore('m', [10, 10], 'magic', 3);
    const { engine, player, advanceTo } = engineFixture(actor, [10, 18]);
    advanceTo(FIRST_THROW + 1, (next) => {
      player.activePrayer = next === FIRST_THROW ? PRAYERS.missiles : PRAYERS.magic;
    });
    const [hit] = engine.getDamageHistory().filter((entry) => entry.sourceNpcTypeId === 12818);
    expect(hit).toMatchObject({ tick: FIRST_THROW + 1, attackType: 'magic' });
    expect(hit!.effectiveDamage).toBeGreaterThan(0);
  });

  const kill = (engine: SimulationEngine, actor: ManticoreActor, impactTick: number) =>
    enqueueEnginePendingHit(engine, {
      sourceId: 'player',
      targetId: actor.id,
      style: 'magic',
      attackKind: 'magic_shadow',
      launchTick: 0,
      impactTick,
      rolledDamage: actor.vitals.hp,
      accuracySucceeded: true,
    });
  const launchTicks = (events: readonly GameEvent[]) =>
    events.filter(isEncounterVisualEvent).flatMap((event) => event.projectiles.map(() => event.tick));

  it.each(
    MANTICORE_KILLED_MID_THROW.map((entry) => [`${entry.capture}:${entry.killTick}`, entry] as const),
  )('launches the orb due on its kill tick, never later ones, and lands none from then on (%s)', (_, entry) => {
    const actor = manticore('m', [10, 10]);
    const { engine, events, advanceTo } = engineFixture(actor, [10, 18]);
    const killOffset = entry.killTick - entry.throwTick;
    kill(engine, actor, FIRST_THROW + killOffset);
    advanceTo(FIRST_THROW + 6);
    const hits = engine.getDamageHistory().filter((hit) => hit.sourceNpcTypeId === 12818);
    expect(hits.map((hit) => hit.tick - FIRST_THROW)).toEqual(entry.splatTicks.map((tick) => tick - entry.throwTick));
    expect(launchTicks(events).map((tick) => tick - FIRST_THROW)).toEqual([0, 1, 2].filter((orb) => orb <= killOffset));
  });

  it('holds no orbs once dying, though its killing-tick turn still launches one (A:1218: none re-sent)', () => {
    const actor = manticore('m', [10, 10]);
    const { engine, advanceTo } = engineFixture(actor, [10, 18]);
    kill(engine, actor, FIRST_THROW + 1);
    advanceTo(FIRST_THROW);
    expect(manticoreHeldOrbs(actor, FIRST_THROW)).toHaveLength(2);
    advanceTo(FIRST_THROW + 1);
    expect(actor.death?.status).toBe('pending');
    expect(manticoreHeldOrbs(actor, FIRST_THROW + 1)).toEqual([]);
  });

  it('starts no throw on its kill tick, ready with reach (A:1218, C:3047, C:3716)', () => {
    const actor = manticore('m', [10, 10]);
    const { engine, events, advanceTo } = engineFixture(actor, [10, 18]);
    kill(engine, actor, FIRST_THROW);
    advanceTo(FIRST_THROW + 6);
    expect(launchTicks(events)).toEqual([]);
  });
});

/**
 * A promoted kill (a lethal hit then a trailing one on its kill tick K) mid-throw: death processing starts before
 * its turn on K, so the orb due on K launches through the kill-turn release and, like every orb then, never lands.
 * Each stream is counted per tick: the Manticore's own (the wave owner's) and the engine's combat stream.
 */
describe('Manticore killed mid-throw with its death promoted to the kill tick', () => {
  function promotedKillFixture(stepOnThrow: boolean) {
    const counts = { wave: new Map<number, number>(), engine: new Map<number, number>() };
    let tick = 0;
    const counted = (stream: Map<number, number>, value: number) => () => {
      stream.set(tick, (stream.get(tick) ?? 0) + 1);
      return value;
    };
    const actor = manticore('m', [10, 10], 'magic');
    const startPos: Coordinate = [10, 18];
    const engine = new SimulationEngine({
      encounter: new ManticoreEngineEncounter([actor], counted(counts.wave, 0.99)),
      startPos,
      combatRandom: counted(counts.engine, 0.5),
    });
    engine.setMechanicsConfig({ infiniteHealth: true });
    setArenaConfig(OPEN_ARENA, true);
    const player = engine['worldState'].getPlayer()!;
    const events: GameEvent[] = [];
    const killTick = FIRST_THROW + 1;
    for (const rolledDamage of [actor.vitals.hp, 1]) {
      enqueueEnginePendingHit(engine, {
        sourceId: 'player',
        targetId: actor.id,
        style: 'magic',
        attackKind: 'magic_shadow',
        launchTick: 0,
        impactTick: killTick,
        rolledDamage,
        accuracySucceeded: true,
      });
    }
    while (engine.currentTick < killTick + 4) {
      tick = engine.currentTick + 1;
      // Out of reach just before the throw, so it steps on the throw tick to regain it.
      if (stepOnThrow && tick === FIRST_THROW - 1) player.position = [10, 30];
      engine.advanceTick([...player.position]);
      events.push(...engine.getLastTickEvents());
    }
    const launches = events.filter(isEncounterVisualEvent).flatMap((event) => event.projectiles.map(() => event.tick));
    const throws = events
      .filter(isEncounterVisualEvent)
      .flatMap((event) => (event.animations.some((cue) => cue.clipId === 'throw') ? [event.tick] : []));
    const hits = engine.getDamageHistory().filter((hit) => hit.sourceNpcTypeId === 12818);
    const draws = (stream: Map<number, number>) =>
      [killTick - 1, killTick, killTick + 1].map((at) => stream.get(at) ?? 0);
    return { actor, killTick, launches, throws, hits, wave: draws(counts.wave), engine: draws(counts.engine) };
  }

  it.each([
    ['stepped on the throw tick, so its death animation waits for the last step', true],
    ['standing still, so its death animation starts on the kill tick', false],
  ] as const)('launches exactly the orb due on K from its own stream (%s)', (_, stepOnThrow) => {
    const { actor, killTick, launches, throws, hits, wave, engine } = promotedKillFixture(stepOnThrow);
    expect(actor.death).toMatchObject({ killTick, processTick: killTick, status: 'started' });
    expect(actor.lastStepTick === FIRST_THROW).toBe(stepOnThrow);
    expect(actor.deathAnimationTick).toBe(stepOnThrow ? FIRST_THROW + 3 : killTick);
    expect(throws).toEqual([FIRST_THROW]);
    expect(launches).toEqual([FIRST_THROW, killTick]);
    // Accuracy and damage for the orb launched on T, then for the one released on K; nothing after.
    expect(wave).toEqual([2, 2, 0]);
    expect(engine).toEqual([0, 0, 0]);
    expect(hits).toEqual([]);
  });
});
