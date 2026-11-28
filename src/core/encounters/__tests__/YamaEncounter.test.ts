import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encounterRegistry } from '../../../encounters/registry';
import {
  YAMA_SET_OPENING_MAGIC_COMMAND,
  YAMA_SET_OPENING_RANGE_COMMAND,
  YAMA_SPAWN_FIREBALL_COMMAND,
  YAMA_SPAWN_VOID_FLARE_COMMAND,
} from '../../../encounters/yamaP3/commands';
import {
  ARENA_ENTRANCE_Y,
  DEFAULT_YAMA_ATTACK_PATTERN,
  getFireballBurstCycleTicks,
  getYamaBeatInfo,
  isSouthOfArenaEntrance,
  VOID_FLARE_NPC_ID,
  YAMA_VICTORY_COMPLETION_DELAY_TICKS,
} from '../../../encounters/yamaP3/constants';
import {
  FORFEIT_BREATH_CONFIG,
  MELEE_VOID_FLARE_CHARGE_TICKS,
  VOID_FLARE_CHARGE_TICKS,
} from '../../../encounters/yamaP3/contractConfig';
import { buildYamaControls } from '../../../encounters/yamaP3/controls';
import { getFireballPhasesForTick } from '../../../encounters/yamaP3/fireball';
import { isWaveTile } from '../../../encounters/yamaP3/waves';
import { YamaEncounter } from '../../../encounters/yamaP3/YamaEncounter';
import { voidFlareExplosionHeal } from '../../../npcs/yama/voidFlare';
import type { ArenaBounds } from '../../../rs/collision/WalkabilityAnalyzer';
import { createEncounterActorOps } from '../../../test/helpers/encounterActorOps';
import { runEncounterNpcActions } from '../../../test/helpers/encounterNpcBand';
import { enqueueEnginePendingHit } from '../../../test/helpers/pendingHits';
import { createUnusedPlayerControlOps } from '../../../test/helpers/playerControlStubs';
import { createEmptyStats } from '../../../types/equipmentStats';
import { createDefaultStats } from '../../../types/playerState';
import { type Coordinate, EventType, type MechanicsConfig, type TickNumber } from '../../../types/simulation';
import type { PlayerActor } from '../../actors/PlayerActor';
import { isWalkableTile, setArenaConfig, setDefaultArenaConfig } from '../../constants';
import { TickEvents } from '../../events/TickEvents';
import { type GameEvent, isCoreEvent } from '../../events/types';
import { findPath } from '../../pathfinder';
import { SimulationEngine } from '../../SimulationEngine';
import { WorldState } from '../../WorldState';
import { isYamaSnapshot } from '../snapshot';
import type { EncounterContext } from '../types';

const PATTERN = DEFAULT_YAMA_ATTACK_PATTERN;
const BURST_START_TICKS = getFireballBurstCycleTicks(PATTERN);

const TEST_BOUNDS: ArenaBounds = { minX: 28, maxX: 34, minY: 16, maxY: 24, width: 7, height: 9 };

/** Walkable rectangle spanning rows both south (16-19) and north (20-24) of the entrance. */
function walkableRect(): Set<string> {
  const set = new Set<string>();
  for (let x = TEST_BOUNDS.minX; x <= TEST_BOUNDS.maxX; x++) {
    for (let y = TEST_BOUNDS.minY; y <= TEST_BOUNDS.maxY; y++) {
      set.add(`${x},${y}`);
    }
  }
  return set;
}

function seedDefaultArena(walkableTiles: Set<string>): void {
  setDefaultArenaConfig({ bounds: TEST_BOUNDS, walkableTiles, collisionMap: null });
}

describe('YamaEncounter arena entrance sealing', () => {
  // The arena config is module-global. Reset it on the way IN so these tests start
  // clean, and on the way OUT so the small TEST_BOUNDS arena seeded below cannot leak
  // into any suite that runs after this one.
  const clearArenaConfig = () => {
    setDefaultArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null });
    setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
  };
  beforeEach(clearArenaConfig);
  afterEach(clearArenaConfig);

  it('isSouthOfArenaEntrance is true on and south of the entrance line, false north', () => {
    expect(isSouthOfArenaEntrance(ARENA_ENTRANCE_Y + 1)).toBe(false);
    expect(isSouthOfArenaEntrance(ARENA_ENTRANCE_Y)).toBe(true);
    expect(isSouthOfArenaEntrance(ARENA_ENTRANCE_Y - 1)).toBe(true);
  });

  it('removes tiles on or south of the entrance from the walkable set', () => {
    seedDefaultArena(walkableRect());
    const config = new YamaEncounter().getArenaConfig();

    expect(config.walkableTiles).not.toBeNull();
    expect(config.walkableTiles!.has('31,20')).toBe(true);
    expect(config.walkableTiles!.has('31,24')).toBe(true);
    for (let y = TEST_BOUNDS.minY; y <= ARENA_ENTRANCE_Y; y++) {
      expect(config.walkableTiles!.has(`31,${y}`)).toBe(false);
    }
  });

  it('does not mutate the source walkable set', () => {
    const source = walkableRect();
    seedDefaultArena(source);
    new YamaEncounter().getArenaConfig();
    expect(source.has('31,19')).toBe(true);
  });

  it('makes isWalkableTile reject tiles south of the entrance once applied', () => {
    seedDefaultArena(walkableRect());
    setArenaConfig(new YamaEncounter().getArenaConfig());

    expect(isWalkableTile(31, 20)).toBe(true);
    expect(isWalkableTile(31, ARENA_ENTRANCE_Y)).toBe(false);
    expect(isWalkableTile(31, ARENA_ENTRANCE_Y - 1)).toBe(false);
  });

  it('pathfinder will not route onto a tile south of the entrance', () => {
    seedDefaultArena(walkableRect());
    setArenaConfig(new YamaEncounter().getArenaConfig());

    const path = findPath([31, 24], [31, 16]);
    expect(path.length).toBeGreaterThan(0);
    for (const [, y] of path) {
      expect(y).toBeGreaterThan(ARENA_ENTRANCE_Y);
    }

    const inside = findPath([31, 24], [31, 20]);
    expect(inside[inside.length - 1]).toEqual([31, 20]);
  });

  it('memoizes the sealed config but re-derives when the cache supplies a new set', () => {
    seedDefaultArena(walkableRect());
    const encounter = new YamaEncounter();
    const first = encounter.getArenaConfig();
    expect(encounter.getArenaConfig()).toBe(first);

    seedDefaultArena(walkableRect());
    expect(encounter.getArenaConfig()).not.toBe(first);
  });
});

const ADJACENT_NORTH: Coordinate = [31, 33];
const OUTSIDE_MELEE_NORTH: Coordinate = [31, 34];
const FAR_NORTH: Coordinate = [31, 37];
const SECOND_RAW_BEAT = PATTERN.beatStartTick + PATTERN.beatIntervalTicks;

interface DecisionWindowTrace {
  readonly rawBeatPosition: Coordinate;
  readonly rawBeatEvents: readonly GameEvent[];
  readonly queuedTickPosition: Coordinate;
  readonly queuedTickEvents: readonly GameEvent[];
}

function createYamaEngine(startPos: Coordinate, mechanics: Partial<MechanicsConfig> = {}): SimulationEngine {
  const engine = new SimulationEngine({ encounter: new YamaEncounter(undefined, 0), startPos });
  engine.executeEncounterCommand(YAMA_SET_OPENING_MAGIC_COMMAND);
  engine.setMechanicsConfig({
    yamaMageRange: true,
    yamaMelee: true,
    waves: false,
    fireballs: false,
    voidFlares: false,
    infiniteHealth: true,
    ...mechanics,
  });
  return engine;
}

function advanceThroughTick(engine: SimulationEngine, endTick: number, clickTarget: Coordinate): GameEvent[] {
  const events: GameEvent[] = [];
  while (engine.getState().currentTick < endTick) {
    engine.advanceTick(clickTarget);
    events.push(...engine.getLastTickEvents());
  }
  return events;
}

function traceDecisionWindow(
  engine: SimulationEngine,
  rawBeatClickTarget: Coordinate,
  queuedTickClickTarget: Coordinate,
): DecisionWindowTrace {
  engine.advanceTick(rawBeatClickTarget);
  const rawBeatPosition = engine.getState().playerPosition;
  const rawBeatEvents = engine.getLastTickEvents();

  engine.advanceTick(queuedTickClickTarget);
  return {
    rawBeatPosition,
    rawBeatEvents,
    queuedTickPosition: engine.getState().playerPosition,
    queuedTickEvents: engine.getLastTickEvents(),
  };
}

function yamaAttackTrace(events: readonly GameEvent[]) {
  return events.flatMap((event) =>
    isCoreEvent(event, 'attack_started') && event.sourceId === 'yama'
      ? [{ tick: event.tick, style: event.style, attackKind: event.attackKind }]
      : [],
  );
}

describe('Yama queued combat decisions', () => {
  it('chooses non-melee from the post-move raw-beat position and swings one tick later', () => {
    // Given: the player begins adjacent immediately before a non-fireball raw beat.
    const engine = createYamaEngine(ADJACENT_NORTH);
    advanceThroughTick(engine, SECOND_RAW_BEAT - 1, ADJACENT_NORTH);

    // When: the player exits melee range during the raw beat and stays out.
    const trace = traceDecisionWindow(engine, OUTSIDE_MELEE_NORTH, OUTSIDE_MELEE_NORTH);

    // Then: the raw beat only decides — from the post-move tile — and the swing lands
    // on the next tick. Capture (`yama-packet-data.txt`, P3 control t810): attack
    // animations run at t815, 822, 829 … = control + 5 + 7k, i.e. one tick after the
    // control + 4 + 7k beat grid.
    expect({
      rawBeatPosition: trace.rawBeatPosition,
      rawBeatAttacks: yamaAttackTrace(trace.rawBeatEvents),
      queuedTickAttacks: yamaAttackTrace(trace.queuedTickEvents),
    }).toEqual({
      rawBeatPosition: OUTSIDE_MELEE_NORTH,
      rawBeatAttacks: [],
      queuedTickAttacks: [{ tick: SECOND_RAW_BEAT + 1, style: 'magic', attackKind: 'magic_fire' }],
    });
  });

  it('lets a player who steps into melee range on the beat get meleed for it', () => {
    // Given: the player is outside melee range going into a non-fireball raw beat.
    const engine = createYamaEngine(OUTSIDE_MELEE_NORTH);
    advanceThroughTick(engine, SECOND_RAW_BEAT - 1, OUTSIDE_MELEE_NORTH);

    // When: they step INTO melee range on the beat tick itself, then stay put.
    const trace = traceDecisionWindow(engine, ADJACENT_NORTH, ADJACENT_NORTH);

    // Then: Yama read the tile they moved to — the decision samples the post-move
    // position — so the swing that follows on the next tick is melee.
    expect({
      rawBeatPosition: trace.rawBeatPosition,
      rawBeatAttacks: yamaAttackTrace(trace.rawBeatEvents),
      queuedTickAttacks: yamaAttackTrace(trace.queuedTickEvents),
    }).toEqual({
      rawBeatPosition: ADJACENT_NORTH,
      rawBeatAttacks: [],
      queuedTickAttacks: [{ tick: SECOND_RAW_BEAT + 1, style: 'melee', attackKind: 'melee_crush' }],
    });
  });

  it('emits the first three adjacent combat decisions one tick after each raw beat', () => {
    // Given: the player stays adjacent with only Yama combat enabled.
    const engine = createYamaEngine(ADJACENT_NORTH);

    // When: the simulation advances through the first three queued combat ticks.
    const events = advanceThroughTick(
      engine,
      PATTERN.beatStartTick + PATTERN.beatIntervalTicks * 2 + 1,
      ADJACENT_NORTH,
    );

    // Then: swings land on control + 5 + 7k, matching the capture's animation ticks.
    expect(yamaAttackTrace(events).map((event) => event.tick)).toEqual([
      PATTERN.beatStartTick + 1,
      PATTERN.beatStartTick + PATTERN.beatIntervalTicks + 1,
      PATTERN.beatStartTick + PATTERN.beatIntervalTicks * 2 + 1,
    ]);
  });

  it('keeps the first shared fireball start on its existing raw-beat schedule', () => {
    // Given: the player is outside melee range and shared fireballs are enabled.
    const engine = createYamaEngine(FAR_NORTH, { fireballs: true });
    const firstFireballStartTick = BURST_START_TICKS[0];

    // When: the raw fireball beat, its position-capture tick and the set start tick are processed.
    const events = advanceThroughTick(engine, firstFireballStartTick, FAR_NORTH);

    // Then: queueing actor combat does not move either public fireball start signal off tick 7.
    expect({
      gameEventTicks: events.filter((event) => event.type === 'fireball_spawned').map((event) => event.tick),
      simulationEventTicks: engine
        .getEventLog()
        .filter((event) => event.type === EventType.FIREBALL_SPAWN)
        .map((event) => event.tick),
    }).toEqual({ gameEventTicks: [firstFireballStartTick], simulationEventTicks: [firstFireballStartTick] });
  });

  it('base beat 3 replaces the auto in cycle 0 and casts alongside its fireball from cycle 1', () => {
    const engine = createYamaEngine(FAR_NORTH, { fireballs: true });
    const beatTick = (globalBeat: number) => PATTERN.beatStartTick + globalBeat * PATTERN.beatIntervalTicks;
    const events = advanceThroughTick(engine, beatTick(13) + 3, FAR_NORTH);
    const castTicks = yamaAttackTrace(events).map((event) => event.tick);
    const fireballTicks = events.filter((event) => event.type === 'fireball_spawned').map((event) => event.tick);

    // The swing a beat schedules lands one tick later; the burst's first set three ticks later.
    expect(castTicks).not.toContain(beatTick(3) + 1);
    expect(fireballTicks).toContain(beatTick(3) + 3);
    expect(castTicks).toContain(beatTick(13) + 1);
    expect(fireballTicks).toContain(beatTick(13) + 3);
  });

  it('a melee swing flare explodes on add+17 while a beat-pair flare keeps add+25', () => {
    // Adjacent all fight: every swing is melee and drops one flare, and the void-flare beat's
    // swing drops its pair on the same tick.
    const engine = createYamaEngine(ADJACENT_NORTH, { voidFlares: true });
    const pairTick = PATTERN.beatStartTick + PATTERN.voidFlareBeats[0] * PATTERN.beatIntervalTicks + 1;
    const events = advanceThroughTick(engine, pairTick + VOID_FLARE_CHARGE_TICKS, ADJACENT_NORTH);

    const spawnTicks = new Map<string, number>();
    const fuses: Array<{ spawnTick: number; fuse: number }> = [];
    for (const event of events) {
      if (event.type === 'voidflare_spawned') spawnTicks.set(String(event.flareId), event.tick);
      if (event.type !== 'voidflare_exploded') continue;
      const flareId = String(event.flareId);
      const spawnTick = spawnTicks.get(flareId);
      if (spawnTick === undefined) throw new Error(`no spawn for ${flareId}`);
      fuses.push({ spawnTick, fuse: event.tick - spawnTick });
    }

    const meleeOnly = fuses.filter((flare) => flare.spawnTick !== pairTick);
    expect(meleeOnly.length).toBeGreaterThan(1);
    expect(new Set(meleeOnly.map((flare) => flare.fuse))).toEqual(new Set([MELEE_VOID_FLARE_CHARGE_TICKS]));
    expect(fuses.filter((flare) => flare.spawnTick === pairTick).map((flare) => flare.fuse)).toEqual([
      MELEE_VOID_FLARE_CHARGE_TICKS,
      VOID_FLARE_CHARGE_TICKS,
    ]);
  });

  it('captures one tick before spawn and resolves impact before damage, then explosion', () => {
    // Given: scheduled fireballs are enabled without Yama auto-attacks, and the player moves on
    // the first set's capture tick.
    const engine = createYamaEngine(FAR_NORTH, {
      yamaMageRange: false,
      yamaMelee: false,
      fireballs: true,
    });
    const capturedPosition: Coordinate = [30, 37];
    advanceThroughTick(engine, BURST_START_TICKS[0] - 2, FAR_NORTH);

    // When: tick 6 captures the moved position, tick 7 announces it, and both damage phases pass.
    engine.advanceTick(capturedPosition);
    expect(engine.getState().playerPosition).toEqual(capturedPosition);
    expect(engine.getLastTickEvents().filter((event) => event.type === 'fireball_spawned')).toEqual([]);
    engine.advanceTick(capturedPosition);
    const spawnEvents = engine.getLastTickEvents().filter((event) => event.type === 'fireball_spawned');
    advanceThroughTick(engine, BURST_START_TICKS[0] + 2, capturedPosition);
    engine.advanceTick(capturedPosition);
    const impactOrder = engine
      .getLastTickEvents()
      .map((event) => event.type)
      .filter((type) => type === 'fireball_impact' || type === 'hit_applied' || type === 'hitsplat_spawned');
    engine.advanceTick(capturedPosition);
    const explosionOrder = engine
      .getLastTickEvents()
      .map((event) => event.type)
      .filter((type) => type === 'fireball_impact' || type === 'hit_applied' || type === 'hitsplat_spawned');

    // Then: the public spawn is deferred to its start tick and both damage phases retain order.
    expect(spawnEvents).toMatchObject([
      { tick: BURST_START_TICKS[0], fireballIndex: 0, targetPosition: capturedPosition },
    ]);
    expect(impactOrder).toEqual(['fireball_impact', 'hit_applied', 'hitsplat_spawned']);
    expect(explosionOrder).toEqual(['hit_applied', 'hitsplat_spawned']);
    expect(
      engine
        .getDamageHistory()
        .filter((entry) => entry.source === 'Fireball')
        .map((entry) => entry.tick),
    ).toEqual([BURST_START_TICKS[0] + 3, BURST_START_TICKS[0] + 4]);
  });

  it('drops a fireball spawn captured but not yet announced when the run is reset', () => {
    // Given: the run is sitting on a set's position-capture tick, so its spawn event is queued
    // for the tick after — the one-tick window the reset() clear exists to cover.
    const engine = createYamaEngine(FAR_NORTH, { fireballs: true });
    const firstFireballStartTick = BURST_START_TICKS[0];
    const beforeReset = advanceThroughTick(engine, firstFireballStartTick - 1, FAR_NORTH);
    expect(beforeReset.filter((event) => event.type === 'fireball_spawned')).toEqual([]);

    // When: the run restarts with fireballs off, so any spawn that follows can only be the
    // carried-over one.
    engine.reset(FAR_NORTH);
    engine.setMechanicsConfig({
      yamaMageRange: true,
      yamaMelee: true,
      waves: false,
      fireballs: false,
      voidFlares: false,
      infiniteHealth: true,
    });
    const afterReset = advanceThroughTick(engine, firstFireballStartTick + 8, FAR_NORTH);

    // Then: nothing announces itself over the fresh run.
    expect(afterReset.filter((event) => event.type === 'fireball_spawned')).toEqual([]);
  });

  it('uses a raw-fireball-beat melee decision for suppression and melee side effects', () => {
    // Given: fireballs and void flares are enabled while the player stays adjacent for raw beat 4.
    const engine = createYamaEngine(ADJACENT_NORTH, { fireballs: true, voidFlares: true });
    advanceThroughTick(engine, PATTERN.beatStartTick - 1, ADJACENT_NORTH);

    // When: the melee decision beat, its queued combat tick, and the nominal first fireball start pass.
    const trace = traceDecisionWindow(engine, ADJACENT_NORTH, ADJACENT_NORTH);
    const laterEvents = advanceThroughTick(engine, BURST_START_TICKS[0], ADJACENT_NORTH);
    const allEvents = [...trace.rawBeatEvents, ...trace.queuedTickEvents, ...laterEvents];

    // Then: the melee swing and the flare it spawned share the queued tick — the whole
    // point of this fix — and that beat's fireball stays suppressed.
    expect({
      rawBeatAttacks: yamaAttackTrace(trace.rawBeatEvents),
      queuedTickVoidFlareTicks: trace.queuedTickEvents
        .filter((event) => event.type === 'voidflare_spawned')
        .map((event) => event.tick),
      queuedTickOrder: trace.queuedTickEvents
        .filter((event) => event.type === 'voidflare_spawned' || event.type === 'attack_started')
        .map((event) => event.type),
      queuedTickAttacks: yamaAttackTrace(trace.queuedTickEvents),
      fireballSpawnTicks: allEvents.filter((event) => event.type === 'fireball_spawned').map((event) => event.tick),
      simulationFireballSpawnTicks: engine
        .getEventLog()
        .filter((event) => event.type === 'FIREBALL_SPAWN')
        .map((event) => event.tick),
    }).toEqual({
      rawBeatAttacks: [],
      queuedTickVoidFlareTicks: [PATTERN.beatStartTick + 1],
      // Same tick; the flare follows the swing because it spawns after every flare's hit queue
      // (completeNpcBand), so a flare killed that tick frees its slot first.
      queuedTickOrder: ['attack_started', 'voidflare_spawned'],
      queuedTickAttacks: [{ tick: PATTERN.beatStartTick + 1, style: 'melee', attackKind: 'melee_crush' }],
      fireballSpawnTicks: [],
      simulationFireballSpawnTicks: [],
    });
  });

  it('discards queued combat when Yama attacks are disabled before emission', () => {
    // Given: a non-melee decision is queued on raw beat 11 while Yama attacks are enabled.
    const engine = createYamaEngine(FAR_NORTH);
    advanceThroughTick(engine, SECOND_RAW_BEAT, FAR_NORTH);

    // When: attacks are disabled for tick 12, then re-enabled on tick 13.
    engine.setMechanicsConfig({
      yamaMageRange: false,
      yamaMelee: true,
      waves: false,
      fireballs: false,
      voidFlares: false,
      infiniteHealth: true,
    });
    engine.advanceTick(FAR_NORTH);
    const disabledTickEvents = engine.getLastTickEvents();
    const disabledTickEncounter = engine.getState().encounter;
    engine.setMechanicsConfig({
      yamaMageRange: true,
      yamaMelee: true,
      waves: false,
      fireballs: false,
      voidFlares: false,
      infiniteHealth: true,
    });
    engine.advanceTick(FAR_NORTH);
    const reenabledTickEncounter = engine.getState().encounter;
    if (!isYamaSnapshot(disabledTickEncounter) || !isYamaSnapshot(reenabledTickEncounter)) {
      throw new TypeError('Expected Yama snapshots');
    }

    // Then: tick 12 has no attack/render state, and the consumed intent cannot emit later.
    expect({
      disabledTickAttacks: yamaAttackTrace(disabledTickEvents),
      disabledLastAttackKind: disabledTickEncounter.state.lastAttackKind,
      disabledLastAttackTick: disabledTickEncounter.state.lastAttackTick,
      reenabledTickAttacks: yamaAttackTrace(engine.getLastTickEvents()),
      reenabledLastAttackKind: reenabledTickEncounter.state.lastAttackKind,
      reenabledLastAttackTick: reenabledTickEncounter.state.lastAttackTick,
    }).toEqual({
      disabledTickAttacks: [],
      disabledLastAttackKind: null,
      disabledLastAttackTick: null,
      reenabledTickAttacks: [],
      reenabledLastAttackKind: null,
      reenabledLastAttackTick: null,
    });
  });

  it('discards a deferred void flare when the mechanic is disabled before the attack tick', () => {
    // Given: an adjacent melee beat queues its paired void flare for the next tick.
    const engine = createYamaEngine(ADJACENT_NORTH, { voidFlares: true });
    advanceThroughTick(engine, PATTERN.beatStartTick, ADJACENT_NORTH);

    // When: void flares are disabled between the decision beat and attack tick.
    engine.setMechanicsConfig({
      yamaMageRange: true,
      yamaMelee: true,
      waves: false,
      fireballs: false,
      voidFlares: false,
      infiniteHealth: true,
    });
    engine.advanceTick(ADJACENT_NORTH);

    // Then: the previously queued flare does not spawn under the current toggle.
    expect(engine.getLastTickEvents().filter((event) => event.type === 'voidflare_spawned')).toEqual([]);
  });

  it('still emits a queued melee when only the mage/range toggle is disabled before emission', () => {
    // Given: an adjacent raw beat queues a melee decision with both toggles enabled.
    const engine = createYamaEngine(ADJACENT_NORTH);
    advanceThroughTick(engine, SECOND_RAW_BEAT, ADJACENT_NORTH);

    // When: mage/range is disabled between the decision beat and the attack tick.
    engine.setMechanicsConfig({
      yamaMageRange: false,
      yamaMelee: true,
      waves: false,
      fireballs: false,
      voidFlares: false,
      infiniteHealth: true,
    });
    engine.advanceTick(ADJACENT_NORTH);

    // Then: the emission-time gate reads the queued swing's OWN style, so melee lands.
    expect(yamaAttackTrace(engine.getLastTickEvents())).toEqual([
      { tick: SECOND_RAW_BEAT + 1, style: 'melee', attackKind: 'melee_crush' },
    ]);
  });

  it('discards a queued melee when only the melee toggle is disabled before emission', () => {
    // Given: the same adjacent raw beat queues a melee decision.
    const engine = createYamaEngine(ADJACENT_NORTH);
    advanceThroughTick(engine, SECOND_RAW_BEAT, ADJACENT_NORTH);

    // When: melee is disabled between the decision beat and the attack tick.
    engine.setMechanicsConfig({
      yamaMageRange: true,
      yamaMelee: false,
      waves: false,
      fireballs: false,
      voidFlares: false,
      infiniteHealth: true,
    });
    engine.advanceTick(ADJACENT_NORTH);
    const encounter = engine.getState().encounter;
    if (!isYamaSnapshot(encounter)) {
      throw new TypeError('Expected Yama snapshot');
    }

    // Then: the swing is dropped and leaves no render state behind. Re-enabling mage/range
    // does NOT rescue a melee decision — the queue is consumed either way.
    expect({
      attacks: yamaAttackTrace(engine.getLastTickEvents()),
      lastAttackKind: encounter.state.lastAttackKind,
      lastAttackTick: encounter.state.lastAttackTick,
    }).toEqual({ attacks: [], lastAttackKind: null, lastAttackTick: null });
  });

  it('lets a melee-only configuration suppress the fireball beat and keep its paired flare', () => {
    // Given: mage/range is off but melee is on, with fireballs and flares enabled, on raw beat 4.
    const engine = createYamaEngine(ADJACENT_NORTH, { yamaMageRange: false, fireballs: true, voidFlares: true });
    advanceThroughTick(engine, PATTERN.beatStartTick - 1, ADJACENT_NORTH);

    // When: the melee decision beat, its queued combat tick, and the nominal fireball start pass.
    const trace = traceDecisionWindow(engine, ADJACENT_NORTH, ADJACENT_NORTH);
    const laterEvents = advanceThroughTick(engine, BURST_START_TICKS[0], ADJACENT_NORTH);
    const allEvents = [...trace.rawBeatEvents, ...trace.queuedTickEvents, ...laterEvents];

    // Then: melee still drives the suppression/flare coupling it drives when mage/range is on.
    expect({
      queuedTickAttacks: yamaAttackTrace(trace.queuedTickEvents),
      queuedTickVoidFlareTicks: trace.queuedTickEvents
        .filter((event) => event.type === 'voidflare_spawned')
        .map((event) => event.tick),
      fireballSpawnTicks: allEvents.filter((event) => event.type === 'fireball_spawned').map((event) => event.tick),
    }).toEqual({
      queuedTickAttacks: [{ tick: PATTERN.beatStartTick + 1, style: 'melee', attackKind: 'melee_crush' }],
      queuedTickVoidFlareTicks: [PATTERN.beatStartTick + 1],
      fireballSpawnTicks: [],
    });
  });

  it('lets the fireball beat proceed unsuppressed when both attack toggles are disabled', () => {
    // Given: neither attack toggle is on, so no melee decision can be taken on raw beat 4.
    const engine = createYamaEngine(ADJACENT_NORTH, {
      yamaMageRange: false,
      yamaMelee: false,
      fireballs: true,
      voidFlares: true,
    });
    advanceThroughTick(engine, PATTERN.beatStartTick - 1, ADJACENT_NORTH);

    const trace = traceDecisionWindow(engine, ADJACENT_NORTH, ADJACENT_NORTH);
    const laterEvents = advanceThroughTick(engine, BURST_START_TICKS[0], ADJACENT_NORTH);
    const allEvents = [...trace.rawBeatEvents, ...trace.queuedTickEvents, ...laterEvents];

    // Then: nothing swings, and with no melee to suppress it the burst keeps its schedule
    // and the melee-paired flare is never added.
    expect({
      queuedTickAttacks: yamaAttackTrace(trace.queuedTickEvents),
      queuedTickVoidFlareTicks: trace.queuedTickEvents
        .filter((event) => event.type === 'voidflare_spawned')
        .map((event) => event.tick),
      fireballSpawnTicks: allEvents.filter((event) => event.type === 'fireball_spawned').map((event) => event.tick),
    }).toEqual({
      queuedTickAttacks: [],
      queuedTickVoidFlareTicks: [],
      fireballSpawnTicks: [BURST_START_TICKS[0]],
    });
  });
});

function makePlayer(pos: Coordinate = [31, 37]): PlayerActor {
  return {
    id: 'player',
    kind: 'player',
    alive: true,
    position: pos,
    previousPosition: pos,
    facing: 0,
    size: 1,
    vitals: { hp: 99, maxHp: 99 },
    movementPath: [],
    isMoving: false,
    isRunning: false,
    activePrayer: null,
    boostPrayers: [],
    independentPrayers: [],
    isRunEnabled: false,
    isSpecialAttackActive: false,
    pendingInputOps: [],
    quickPrayersActive: false,
    runEnergy: { current: 10000, regenCounter: 0 },
    history: new Map<TickNumber, Coordinate>(),
    // Real values, not `{}`: Yama rolls accuracy against the player's levels and defensive
    // bonuses every swing, and a stubbed player throws inside the formula.
    stats: createDefaultStats(),
    equipmentStats: createEmptyStats(),
    specialAttack: {} as any,
    combatTimers: {} as any,
    potionBoosts: [],
    inventory: {} as any,
    prayerState: {} as any,
    equipment: {} as any,
    cooldownTracks: {} as any,
    attackTarget: null,
    autoAttackPause: null,
    attackInteractionActive: true,
    pendingConflictionAttack: null,
  } as any;
}

function makeEncounterContext(world: WorldState, tick: number, playerPos: Coordinate = [31, 37]): EncounterContext {
  const tickEvents = new TickEvents();
  tickEvents.setTick(tick);
  return {
    tick,
    playerPos,
    world,
    tickEvents,
    logEvent: () => {},
    grantNextAttackSpeedup: () => {},
    ...createEncounterActorOps(world),
    ...createUnusedPlayerControlOps(),
  };
}

function setupEncounterWithPlayer(encounter: YamaEncounter, playerPos: Coordinate = [31, 37]): WorldState {
  const world = new WorldState();
  const player = makePlayer(playerPos);
  world.actors.set('player', player);

  const npcs = encounter.createNpcs(playerPos);
  for (const npc of npcs) {
    world.actors.set(npc.id, npc);
  }

  return world;
}

describe('YamaEncounter interface methods', () => {
  const encounter = new YamaEncounter();

  it('getDefaultPlayerStart returns a position within the landing zone', () => {
    const pos = encounter.getDefaultPlayerStart();
    expect(pos[0]).toBeGreaterThanOrEqual(29);
    expect(pos[0]).toBeLessThanOrEqual(33);
    expect(pos[1]).toBeGreaterThanOrEqual(35);
    expect(pos[1]).toBeLessThanOrEqual(39);
  });

  it('getIntroConfig returns non-null config with facingAngle and animationSeqId', () => {
    const config = encounter.getIntroConfig();
    expect(config).not.toBeNull();
    expect(config!.facingAngle).toBe(0);
    expect(config!.animationSeqId).toBe(12152);
  });

  it('names the Yama debug flag descriptors in its controls', () => {
    const flags = buildYamaControls().debugFlags ?? [];
    expect(flags.length).toBe(3);
    expect(flags.map((f) => f.key)).toEqual(['damageTiles', 'waveTiles', 'fireballDangerTiles']);
  });
});

describe('contract mechanics config', () => {
  it('pins infiniteStamina off for FORFEIT_BREATH_CONFIG, whose whole fight is run energy', () => {
    const encounter = new YamaEncounter(FORFEIT_BREATH_CONFIG);
    const defaults = encounter.getDefaultMechanicsConfig();

    expect(defaults).toHaveProperty('infiniteStamina', false);
  });

  it('includes the Infinite Stamina toggle for FORFEIT_BREATH_CONFIG', () => {
    const toggles = buildYamaControls(FORFEIT_BREATH_CONFIG).mechanicsToggles;
    const toggle = toggles.find((entry) => entry.key === 'infiniteStamina');

    expect(toggle?.label).toBe('Infinite Stamina');
  });

  it('does not include infiniteStamina in base defaults', () => {
    const encounter = new YamaEncounter();
    const defaults = encounter.getDefaultMechanicsConfig();

    expect(defaults).not.toHaveProperty('infiniteStamina');
  });

  it('does not include the Infinite Stamina toggle in base encounter', () => {
    const toggles = buildYamaControls().mechanicsToggles;

    expect(toggles.some((entry) => entry.key === 'infiniteStamina')).toBe(false);
  });

  it('offers Practice As ahead of Fireball Orientation', () => {
    const keys = buildYamaControls().mechanicsToggles.map((entry) => entry.key);

    // The settings UI renders the pickers in the order they are authored here, so this array IS
    // the display order. Every other assertion in this file tests membership, which a re-sort or
    // an append would leave green while silently moving the pickers apart.
    expect(keys.indexOf('duoSide')).toBeLessThan(keys.indexOf('fireballStart'));
  });
});

describe('YamaEncounter — Fireball snap animation', () => {
  let encounter: YamaEncounter;

  beforeEach(() => {
    encounter = new YamaEncounter();
    encounter.reset({ fireballSeed: 0, firstRangeMageType: 'magic' });
  });

  it('sets lastAttackKind to "fireball" on fireball beat when fireballs enabled', () => {
    const world = setupEncounterWithPlayer(encounter);

    const fireballBeatTick = PATTERN.beatStartTick + 0 * PATTERN.beatIntervalTicks;
    const beatInfo = getYamaBeatInfo(fireballBeatTick, PATTERN);
    expect(beatInfo.isBeat).toBe(true);
    expect(beatInfo.isFireballBeat).toBe(true);

    world.tick = fireballBeatTick;
    const ctx = makeEncounterContext(world, fireballBeatTick);

    runEncounterNpcActions(encounter, ctx, encounter.getDefaultMechanicsConfig());

    encounter.processPostTick(ctx, encounter.getDefaultMechanicsConfig());

    const state = encounter.getSnapshot({
      tick: fireballBeatTick,
      mechanics: encounter.getDefaultMechanicsConfig(),
    }).state;
    expect(state.lastAttackKind).toBe('fireball');
  });

  it('does NOT set lastAttackKind to "fireball" on non-fireball beat', () => {
    const world = setupEncounterWithPlayer(encounter);

    const nonFireballBeatTick = PATTERN.beatStartTick + 1 * PATTERN.beatIntervalTicks;
    const beatInfo = getYamaBeatInfo(nonFireballBeatTick, PATTERN);
    expect(beatInfo.isBeat).toBe(true);
    expect(beatInfo.isFireballBeat).toBe(false);

    world.tick = nonFireballBeatTick;
    const ctx = makeEncounterContext(world, nonFireballBeatTick);

    runEncounterNpcActions(encounter, ctx, encounter.getDefaultMechanicsConfig());
    encounter.processPostTick(ctx, encounter.getDefaultMechanicsConfig());

    const state = encounter.getSnapshot({
      tick: nonFireballBeatTick,
      mechanics: encounter.getDefaultMechanicsConfig(),
    }).state;
    expect(state.lastAttackKind).not.toBe('fireball');
  });

  it('does NOT set lastAttackKind to "fireball" when fireballs disabled', () => {
    const world = setupEncounterWithPlayer(encounter);

    const fireballBeatTick = PATTERN.beatStartTick + 0 * PATTERN.beatIntervalTicks;
    world.tick = fireballBeatTick;
    const ctx = makeEncounterContext(world, fireballBeatTick);

    const mechanicsConfig = { ...encounter.getDefaultMechanicsConfig(), fireballs: false };

    runEncounterNpcActions(encounter, ctx, mechanicsConfig);
    encounter.processPostTick(ctx, mechanicsConfig);

    const state = encounter.getSnapshot({ tick: fireballBeatTick, mechanics: mechanicsConfig }).state;
    expect(state.lastAttackKind).not.toBe('fireball');
  });
});

describe('YamaEncounter — npcAttacks impact delay', () => {
  it('commits melee for the next tick and resolves non-melee after its three-tick windup', () => {
    const attackBeatTick = PATTERN.beatStartTick + PATTERN.beatIntervalTicks;

    const meleeEncounter = new YamaEncounter();
    meleeEncounter.reset({ fireballSeed: 0, firstRangeMageType: 'magic' });
    const meleeWorld = setupEncounterWithPlayer(meleeEncounter, [34, 33]);
    meleeWorld.tick = attackBeatTick;
    const meleeCtx = makeEncounterContext(meleeWorld, attackBeatTick, [34, 33]);
    const meleeMechanics = meleeEncounter.getDefaultMechanicsConfig();
    // The beat decides; the next tick swings.
    meleeEncounter.processPostTick(meleeCtx, meleeMechanics);
    meleeWorld.tick = attackBeatTick + 1;
    const meleeAttacks = runEncounterNpcActions(
      meleeEncounter,
      makeEncounterContext(meleeWorld, attackBeatTick + 1, [34, 33]),
      meleeMechanics,
    ).npcAttacks;

    expect(meleeAttacks?.[0]?.style).toBe('melee');
    expect(meleeAttacks?.[0]?.impactDelayTicks).toBe(1);

    const nonMeleeEncounter = new YamaEncounter();
    nonMeleeEncounter.reset({ fireballSeed: 0, firstRangeMageType: 'magic' });
    const nonMeleeWorld = setupEncounterWithPlayer(nonMeleeEncounter, [31, 37]);
    nonMeleeWorld.tick = attackBeatTick;
    const nonMeleeCtx = makeEncounterContext(nonMeleeWorld, attackBeatTick, [31, 37]);
    const nonMeleeMechanics = nonMeleeEncounter.getDefaultMechanicsConfig();
    nonMeleeEncounter.processPostTick(nonMeleeCtx, nonMeleeMechanics);
    nonMeleeWorld.tick = attackBeatTick + 1;
    const windupContext = makeEncounterContext(nonMeleeWorld, attackBeatTick + 1, [31, 37]);
    const nonMeleeAttacks = runEncounterNpcActions(nonMeleeEncounter, windupContext, nonMeleeMechanics).npcAttacks;

    expect(nonMeleeAttacks).toHaveLength(0);
    expect(windupContext.tickEvents.flush()).toContainEqual(
      expect.objectContaining({
        type: 'attack_started',
        style: 'magic',
        impactDelayTicks: 3,
      }),
    );
    for (const tick of [attackBeatTick + 2, attackBeatTick + 3]) {
      nonMeleeWorld.tick = tick;
      expect(
        runEncounterNpcActions(
          nonMeleeEncounter,
          makeEncounterContext(nonMeleeWorld, tick, [31, 37]),
          nonMeleeMechanics,
        ).npcAttacks,
      ).toHaveLength(0);
    }
    nonMeleeWorld.tick = attackBeatTick + 4;
    const released = runEncounterNpcActions(
      nonMeleeEncounter,
      makeEncounterContext(nonMeleeWorld, attackBeatTick + 4, [31, 37]),
      nonMeleeMechanics,
    ).npcAttacks;
    expect(released).toMatchObject([{ style: 'magic', impactDelayTicks: 0, isContinuation: true }]);
  });

  it('judges range/mage at impact but melee when he swings', () => {
    // Given: the same two auto-attack beats as the impact-delay test above. The tile
    // the player stands on decides which style Yama uses.
    const attackBeatTick = PATTERN.beatStartTick + PATTERN.beatIntervalTicks;

    function emitAttackFrom(position: Coordinate, releaseDelay: number) {
      const encounter = new YamaEncounter();
      encounter.reset({ fireballSeed: 0, firstRangeMageType: 'magic' });
      const world = setupEncounterWithPlayer(encounter, position);
      world.tick = attackBeatTick;
      const mechanics = encounter.getDefaultMechanicsConfig();
      encounter.processPostTick(makeEncounterContext(world, attackBeatTick, position), mechanics);
      world.tick = attackBeatTick + 1;
      const firstTick = runEncounterNpcActions(encounter, makeEncounterContext(world, world.tick, position), mechanics);
      if (releaseDelay === 0) return firstTick.npcAttacks?.[0];
      world.tick += releaseDelay;
      return runEncounterNpcActions(encounter, makeEncounterContext(world, world.tick, position), mechanics)
        .npcAttacks?.[0];
    }

    const melee = emitAttackFrom([34, 33], 0);
    const rangeMage = emitAttackFrom([31, 37], 3);

    expect(rangeMage?.style).toBe('magic');
    expect(rangeMage?.prayerCheckAt).toBe('impact');
    expect(rangeMage?.impactDelayTicks).toBe(0);

    expect(melee?.style).toBe('melee');
    expect(melee?.prayerCheckAt).toBe('launch');
  });
});

describe('YamaEncounter debug fireball', () => {
  it('spawns an ad-hoc burst at the current tick WITHOUT rewinding the clock', () => {
    const encounter = new YamaEncounter();
    encounter.reset({ fireballSeed: 0, firstRangeMageType: 'magic' });
    const startPos: Coordinate = [31, 37];
    const world = setupEncounterWithPlayer(encounter, startPos);

    const result = encounter.executeCommand(
      YAMA_SPAWN_FIREBALL_COMMAND,
      makeEncounterContext(world, 100, startPos),
      {},
    );

    expect(result).toEqual({});

    const manualFireballs = encounter['state'].fireballs.manual;
    const registeredFireballIds = encounter['state'].fireballs.registeredIds;

    // 3 sets, negative ids so they never collide with scheduled (>= 0) instance ids.
    expect(manualFireballs.size).toBe(3);
    expect([...manualFireballs.keys()]).toEqual([-1, -2, -3]);
    for (const id of manualFireballs.keys()) {
      expect(registeredFireballIds.has(id)).toBe(true);
    }

    // Each set starts lead (2) + its set offset [0, 3, 6] ticks after the click (100).
    const startTicks = [...manualFireballs.values()].map((fb) => fb.startTick).sort((a, b) => a - b);
    expect(startTicks).toEqual([102, 105, 108]);
  });

  it('clears ad-hoc fireballs on reset', () => {
    const encounter = new YamaEncounter();
    const startPos: Coordinate = [31, 37];
    const world = setupEncounterWithPlayer(encounter, startPos);

    encounter.executeCommand(YAMA_SPAWN_FIREBALL_COMMAND, makeEncounterContext(world, 50, startPos), {});
    expect(encounter['state'].fireballs.manual.size).toBe(3);

    encounter.reset({ fireballSeed: 0, firstRangeMageType: 'magic' });
    expect(encounter['state'].fireballs.manual.size).toBe(0);
  });

  it('captures each moving-player manual set independently at +2, +5, and +8', () => {
    // Given: a manual burst starts while scheduled fireballs and Yama attacks are disabled.
    const engine = createYamaEngine(FAR_NORTH, {
      yamaMageRange: false,
      yamaMelee: false,
      fireballs: false,
    });
    expect(engine.executeEncounterCommand(YAMA_SPAWN_FIREBALL_COMMAND)).toBe(true);
    const clickTargets: readonly Coordinate[] = [
      [30, 37],
      [30, 37],
      [31, 37],
      [31, 38],
      [31, 39],
      [30, 39],
      [30, 39],
      [30, 39],
    ];
    const spawned = [];

    // When: the player takes a different path through all three capture ticks.
    for (const clickTarget of clickTargets) {
      engine.advanceTick(clickTarget);
      spawned.push(...engine.getLastTickEvents().filter((event) => event.type === 'fireball_spawned'));
    }

    // Then: negative IDs announce at the independent lead/offset ticks with each prior-tick tile.
    expect(spawned).toMatchObject([
      { tick: 2, fireballIndex: -1, targetPosition: [30, 37] },
      { tick: 5, fireballIndex: -2, targetPosition: [31, 38] },
      { tick: 8, fireballIndex: -3, targetPosition: [30, 39] },
    ]);
    expect(
      engine
        .getEventLog()
        .flatMap((event) =>
          event.type === EventType.FIREBALL_SPAWN
            ? [{ tick: event.tick, phaseIndex: event.phaseIndex, centerPosition: event.centerPosition }]
            : [],
        ),
    ).toEqual([
      { tick: 2, phaseIndex: -1, centerPosition: [30, 37] },
      { tick: 5, phaseIndex: -2, centerPosition: [31, 38] },
      { tick: 8, phaseIndex: -3, centerPosition: [30, 39] },
    ]);
  });
});

describe('YamaEncounter — Fireball perfect dodge (Mark of Darkness)', () => {
  let encounter: YamaEncounter;

  beforeEach(() => {
    encounter = new YamaEncounter();
    // fireballSeed=0 → burst 0 starts vertical; first set angle='vertical'.
    encounter.reset({ fireballSeed: 0, firstRangeMageType: 'magic' });
  });

  // Beat 0 is at tick 4; first fireball set starts 3 ticks later at tick 7.
  // Phase timeline for instanceId 0 (the first vertical set) at startTick=7:
  //   tick 7,8,9  → falling
  //   tick 10     → impact
  //   tick 11     → explosion  ← perfect-dodge check fires here
  //   tick 12+    → done
  const FIRST_SET_INSTANCE_ID = 0;
  const FIRST_SET_START_TICK = 7;
  const FIRST_SET_EXPLOSION_TICK = FIRST_SET_START_TICK + 4;

  function primeFireball(enc: YamaEncounter, world: WorldState, centerPos: Coordinate): void {
    // Bypass the usual captureFireballPositions() flow by seeding the internal
    // start-position map directly. This lets us stage an exploding fireball at a
    // known center without running ticks 4–10.
    enc['state'].fireballs.startPositions.set(FIRST_SET_INSTANCE_ID, centerPos);
    world.tick = FIRST_SET_EXPLOSION_TICK;
  }

  function givePlayerMarkOfDarkness(world: WorldState, activeTicks = 100): void {
    const player = world.actors.get('player') as PlayerActor;
    player.combatTimers = {
      saturatedHeartCooldownTicks: 0,
      markOfDarknessCooldownTicks: 0,
      markOfDarknessActiveTicks: activeTicks,
      statBoostDecayTick: 100,
    } as any;
  }

  function clearPlayerMarkOfDarkness(world: WorldState): void {
    const player = world.actors.get('player') as PlayerActor;
    player.combatTimers = {
      saturatedHeartCooldownTicks: 0,
      markOfDarknessCooldownTicks: 0,
      markOfDarknessActiveTicks: 0,
      statBoostDecayTick: 100,
    } as any;
  }

  function makeCtx(
    world: WorldState,
    playerPos: Coordinate,
  ): { ctx: EncounterContext; grantNextAttackSpeedup: ReturnType<typeof vi.fn> } {
    const grantNextAttackSpeedup = vi.fn();
    const ctx: EncounterContext = {
      ...makeEncounterContext(world, FIRST_SET_EXPLOSION_TICK, playerPos),
      grantNextAttackSpeedup,
    };
    return { ctx, grantNextAttackSpeedup };
  }

  // The first vertical fireball set draws a N-S line at the centerPos. The safe
  // perpendicular 1-tile neighbors are (cx±1, cy). We put the center on a fixed
  // arena tile so the arithmetic is obvious.
  const fireballCenter: Coordinate = [31, 33];
  const perpendicularEast: Coordinate = [32, 33];
  const perpendicularWest: Coordinate = [30, 33];
  const inLineNorth: Coordinate = [31, 34];
  const twoTilesEast: Coordinate = [33, 33];

  it('reduces attack delay by 1 tick when player stands 1 tile perpendicular and Mark of Darkness is active', () => {
    const world = setupEncounterWithPlayer(encounter, perpendicularEast);
    givePlayerMarkOfDarkness(world);
    primeFireball(encounter, world, fireballCenter);

    const { ctx, grantNextAttackSpeedup } = makeCtx(world, perpendicularEast);
    const damages = encounter.resolveHazards(ctx, encounter.getDefaultMechanicsConfig());

    expect(damages).toHaveLength(0);
    expect(grantNextAttackSpeedup).toHaveBeenCalledTimes(1);
    expect(grantNextAttackSpeedup).toHaveBeenCalledWith('player', 1);
  });

  it('triggers on the opposite perpendicular tile as well', () => {
    const world = setupEncounterWithPlayer(encounter, perpendicularWest);
    givePlayerMarkOfDarkness(world);
    primeFireball(encounter, world, fireballCenter);

    const { ctx, grantNextAttackSpeedup } = makeCtx(world, perpendicularWest);
    encounter.resolveHazards(ctx, encounter.getDefaultMechanicsConfig());

    expect(grantNextAttackSpeedup).toHaveBeenCalledWith('player', 1);
  });

  it('does NOT reduce attack delay when Mark of Darkness is inactive', () => {
    const world = setupEncounterWithPlayer(encounter, perpendicularEast);
    clearPlayerMarkOfDarkness(world);
    primeFireball(encounter, world, fireballCenter);

    const { ctx, grantNextAttackSpeedup } = makeCtx(world, perpendicularEast);
    const damages = encounter.resolveHazards(ctx, encounter.getDefaultMechanicsConfig());

    expect(damages).toHaveLength(0);
    expect(grantNextAttackSpeedup).not.toHaveBeenCalled();
  });

  it('does NOT reduce attack delay when player is 2 tiles away (outside perfect-dodge range)', () => {
    const world = setupEncounterWithPlayer(encounter, twoTilesEast);
    givePlayerMarkOfDarkness(world);
    primeFireball(encounter, world, fireballCenter);

    const { ctx, grantNextAttackSpeedup } = makeCtx(world, twoTilesEast);
    encounter.resolveHazards(ctx, encounter.getDefaultMechanicsConfig());

    expect(grantNextAttackSpeedup).not.toHaveBeenCalled();
  });

  it('applies fireball damage (no perfect dodge) when player stands on a damage tile', () => {
    // For the vertical line, (cx, cy+1) is an inner explosion tile and deals damage.
    const world = setupEncounterWithPlayer(encounter, inLineNorth);
    givePlayerMarkOfDarkness(world);
    primeFireball(encounter, world, fireballCenter);

    const { ctx, grantNextAttackSpeedup } = makeCtx(world, inLineNorth);
    const damages = encounter.resolveHazards(ctx, encounter.getDefaultMechanicsConfig());

    expect(damages.length).toBeGreaterThan(0);
    expect(damages.some((d) => d.source === 'Fireball')).toBe(true);
    expect(grantNextAttackSpeedup).not.toHaveBeenCalled();
  });

  it('only triggers once per fireball instance (no double proc)', () => {
    const world = setupEncounterWithPlayer(encounter, perpendicularEast);
    givePlayerMarkOfDarkness(world);
    primeFireball(encounter, world, fireballCenter);

    const { ctx, grantNextAttackSpeedup } = makeCtx(world, perpendicularEast);
    encounter.resolveHazards(ctx, encounter.getDefaultMechanicsConfig());
    encounter.resolveHazards(ctx, encounter.getDefaultMechanicsConfig());

    expect(grantNextAttackSpeedup).toHaveBeenCalledTimes(1);
  });

  it('emits a yama_perfect_dodge game event with fireball metadata', () => {
    const world = setupEncounterWithPlayer(encounter, perpendicularEast);
    givePlayerMarkOfDarkness(world);
    primeFireball(encounter, world, fireballCenter);

    const { ctx } = makeCtx(world, perpendicularEast);
    encounter.resolveHazards(ctx, encounter.getDefaultMechanicsConfig());

    const events = ctx.tickEvents.flush();
    const dodgeEvent = events.find((e) => e.type === 'yama_perfect_dodge');
    expect(dodgeEvent).toBeDefined();
    expect(dodgeEvent).toMatchObject({
      type: 'yama_perfect_dodge',
      fireballIndex: FIRST_SET_INSTANCE_ID,
      playerPosition: perpendicularEast,
      fireballCenter,
      angle: 'vertical',
    });
  });

  it('reset() clears perfect-dodge tracking so a new encounter can proc again', () => {
    const world = setupEncounterWithPlayer(encounter, perpendicularEast);
    givePlayerMarkOfDarkness(world);
    primeFireball(encounter, world, fireballCenter);

    const first = makeCtx(world, perpendicularEast);
    encounter.resolveHazards(first.ctx, encounter.getDefaultMechanicsConfig());
    expect(first.grantNextAttackSpeedup).toHaveBeenCalledTimes(1);

    encounter.reset({ fireballSeed: 0, firstRangeMageType: 'magic' });
    primeFireball(encounter, world, fireballCenter);

    const second = makeCtx(world, perpendicularEast);
    encounter.resolveHazards(second.ctx, encounter.getDefaultMechanicsConfig());
    expect(second.grantNextAttackSpeedup).toHaveBeenCalledTimes(1);
  });

  it('makes the tick after a perfect dodge the shadow-wave immunity tick', () => {
    const world = setupEncounterWithPlayer(encounter, perpendicularEast);
    givePlayerMarkOfDarkness(world);
    primeFireball(encounter, world, fireballCenter);

    encounter.resolveHazards(makeCtx(world, perpendicularEast).ctx, encounter.getDefaultMechanicsConfig());

    expect(encounter['state'].fireballs.shadowWaveImmunityTick).toBe(FIRST_SET_EXPLOSION_TICK + 1);
  });

  it('drops shadow-wave damage entirely on the immunity tick and only that tick', () => {
    const waveConfig = encounter['state'].run.waveConfig;
    let waveHit: { tick: number; tile: Coordinate } | null = null;
    for (let tick = FIRST_SET_EXPLOSION_TICK; tick < 200 && !waveHit; tick++) {
      for (let x = 20; x <= 40 && !waveHit; x++) {
        for (let y = 20; y <= 45 && !waveHit; y++) {
          if (isWaveTile(x, y, tick, waveConfig)) waveHit = { tick, tile: [x, y] };
        }
      }
    }
    if (!waveHit) throw new Error('Expected a shadow-wave tile');
    const { tick, tile } = waveHit;
    const world = setupEncounterWithPlayer(encounter, tile);
    const mechanics = { ...encounter.getDefaultMechanicsConfig(), waves: true };
    const waveDamageWithImmunityAt = (immunityTick: number | null) => {
      encounter['state'].fireballs.shadowWaveImmunityTick = immunityTick;
      const ctx = makeEncounterContext(world, tick, tile);
      return encounter.resolveHazards(ctx, mechanics).filter((damage) => damage.source === 'Waves');
    };

    expect(waveDamageWithImmunityAt(tick)).toHaveLength(0);
    expect(waveDamageWithImmunityAt(tick - 1)).toHaveLength(1);
    expect(waveDamageWithImmunityAt(tick + 1)).toHaveLength(1);
    expect(waveDamageWithImmunityAt(null)).toHaveLength(1);
  });

  it('fires the speedup callback even before the player has ever attacked', () => {
    // The encounter must not short-circuit on the player's attack state — it
    // always signals the dodge. Whether the bonus has any effect is decided by
    // CombatSystem.speedUpNextAttack(), which is a no-op when no attack cooldown
    // is active (OSRS-correct: with no pending cooldown there is no delay to
    // bring forward).
    const world = setupEncounterWithPlayer(encounter, perpendicularEast);
    givePlayerMarkOfDarkness(world);
    primeFireball(encounter, world, fireballCenter);

    const { ctx, grantNextAttackSpeedup } = makeCtx(world, perpendicularEast);
    encounter.resolveHazards(ctx, encounter.getDefaultMechanicsConfig());

    expect(grantNextAttackSpeedup).toHaveBeenCalledWith('player', 1);
  });

  it('skips the proc (no callback, no event) if same-tick hazard damage would kill the player', () => {
    const world = setupEncounterWithPlayer(encounter, perpendicularEast);
    givePlayerMarkOfDarkness(world);
    primeFireball(encounter, world, fireballCenter);

    const player = world.actors.get('player') as PlayerActor;
    player.vitals = { ...player.vitals, hp: 1 };
    player.vitals = { ...player.vitals, hp: 0 };

    const { ctx, grantNextAttackSpeedup } = makeCtx(world, perpendicularEast);
    encounter.resolveHazards(ctx, encounter.getDefaultMechanicsConfig());

    // Player is at 0 HP, so `player.vitals.hp > pendingMinDamage (>= 0)` is
    // false even with no other hazards. Dodge must NOT proc.
    expect(grantNextAttackSpeedup).not.toHaveBeenCalled();
    const events = ctx.tickEvents.flush();
    expect(events.find((e) => e.type === 'yama_perfect_dodge')).toBeUndefined();
  });

  it('does not stack: multiple dodges on the same fireball instance only grant one speedup', () => {
    // The per-instance `fireballPerfectDodgeTriggered` guard ensures only one
    // grant per fireball. CombatSystem also caps pending grants, but this
    // test exercises the encounter-level guard.
    const world = setupEncounterWithPlayer(encounter, perpendicularEast);
    givePlayerMarkOfDarkness(world);
    primeFireball(encounter, world, fireballCenter);

    const { ctx, grantNextAttackSpeedup } = makeCtx(world, perpendicularEast);
    encounter.resolveHazards(ctx, encounter.getDefaultMechanicsConfig());
    encounter.resolveHazards(ctx, encounter.getDefaultMechanicsConfig());
    encounter.resolveHazards(ctx, encounter.getDefaultMechanicsConfig());

    expect(grantNextAttackSpeedup).toHaveBeenCalledTimes(1);
  });
});

describe('YamaEncounter — fireball seed survives the replay round-trip', () => {
  // The replay system captures encounter seeds via getRunConfig()/getSeeds()
  // and restores them via reset(seeds) on playback. Fireball angles are a pure
  // function of fireballSeed, so a restored seed must reproduce the exact same
  // fireball timeline. Guards the seed plumbing against silently dropping
  // fireballSeed, which would desync replays from the original run.
  const fireballTimeline = (seed: number): string =>
    Array.from({ length: 160 }, (_, tick) =>
      getFireballPhasesForTick(tick, seed, PATTERN)
        .map((p) => `${p.instanceId}:${p.angle}`)
        .join('|'),
    ).join(';');

  it('reproduces the identical fireball timeline after reset(getSeeds())', () => {
    const fresh = new YamaEncounter(undefined, 0x1234abcd);
    const captured = fresh.getSeeds();

    // A new encounter restored from the captured seeds is exactly what replay does.
    const replay = new YamaEncounter();
    replay.reset(captured);

    expect(replay.getSeeds().fireballSeed).toBe(captured.fireballSeed);
    expect(fireballTimeline(replay.getSeeds().fireballSeed as number)).toBe(
      fireballTimeline(captured.fireballSeed as number),
    );
  });

  it('gives distinct (random) fireball timelines for distinct encounter seeds', () => {
    const a = new YamaEncounter(undefined, 1).getSeeds().fireballSeed as number;
    const b = new YamaEncounter(undefined, 2).getSeeds().fireballSeed as number;
    expect(a).not.toBe(b);
    expect(fireballTimeline(a)).not.toBe(fireballTimeline(b));
  });
});

describe('YamaEncounter state initialization', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([0, 0xffffffff])('constructor preserves encounter seed %s without consuming Math.random', (seed) => {
    const random = vi.spyOn(Math, 'random');

    const encounter = new YamaEncounter(undefined, seed);

    expect(encounter.getSeeds().encounterSeed).toBe(seed);
    expect(random).not.toHaveBeenCalled();
  });

  it('constructor fallback is exactly floor(Math.random() * 0xffffffff)', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const encounter = new YamaEncounter();

    expect(encounter.getSeeds().encounterSeed).toBe(Math.floor(0.5 * 0xffffffff));
    expect(random).toHaveBeenCalledTimes(1);
  });

  it.each([0, 0xffffffff])('reset accepts a complete uint32 seed payload at boundary %s', (seed) => {
    const encounter = new YamaEncounter(undefined, 17);

    encounter.reset({
      encounterSeed: seed,
      fireballSeed: seed,
      voidFlareSeed: seed,
      firstRangeMageType: 'range',
    });

    const serialized = encounter.getSeeds();
    expect(encounter.getSeeds()).not.toBe(serialized);
    expect(serialized).toEqual({
      encounterSeed: seed,
      fireballSeed: seed,
      voidFlareSeed: seed,
      firstRangeMageType: 'range',
    });
  });

  it.each([
    -1,
    0x1_0000_0000,
    1.5,
    Number.NaN,
    '7',
  ])('invalid reset seed %s and opener fall back identically to omitted values', (invalidSeed) => {
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    const invalid = new YamaEncounter(undefined, 17);
    const omitted = new YamaEncounter(undefined, 17);

    invalid.reset({
      encounterSeed: invalidSeed,
      fireballSeed: invalidSeed,
      voidFlareSeed: invalidSeed,
      firstRangeMageType: 'invalid',
    });
    omitted.reset({});

    expect(invalid.getSeeds()).toEqual(omitted.getSeeds());
  });

  it('derives the wave seed only from encounterSeed', () => {
    const first = new YamaEncounter(undefined, 17);
    const second = new YamaEncounter(undefined, 17);
    first.reset({ encounterSeed: 123, fireballSeed: 0, voidFlareSeed: 0, firstRangeMageType: 'magic' });
    second.reset({
      encounterSeed: 123,
      fireballSeed: 0xffffffff,
      voidFlareSeed: 0xffffffff,
      firstRangeMageType: 'range',
    });

    const firstWaveConfig = first.getSnapshot({ tick: 0, mechanics: {} }).state.waveConfig;
    const secondWaveConfig = second.getSnapshot({ tick: 0, mechanics: {} }).state.waveConfig;

    expect(firstWaveConfig.seed).toBe(secondWaveConfig.seed);
    expect(firstWaveConfig.seed).not.toBe(0);
  });

  it('serializes a command-updated opener and reset restores the captured opener', () => {
    const encounter = new YamaEncounter(undefined, 17);
    encounter.reset({
      encounterSeed: 17,
      fireballSeed: 23,
      voidFlareSeed: 29,
      firstRangeMageType: 'magic',
    });
    const captured = encounter.getSeeds();
    const world = setupEncounterWithPlayer(encounter);

    encounter.executeCommand(YAMA_SET_OPENING_RANGE_COMMAND, makeEncounterContext(world, 0), {});
    expect(encounter.getSeeds().firstRangeMageType).toBe('range');

    encounter.reset(captured);
    expect(encounter.getSeeds().firstRangeMageType).toBe('magic');
  });
});

const PLAYER_START: Coordinate = [31, 37];
const YAMA_ACTOR_ID = 'yama';
const YAMA_KINDS = [
  'yama_p3',
  'yama_p3_divine',
  'yama_p3_forfeit_breath',
  'yama_p3_sensory',
  'yama_p3_bloodied',
  'yama_p3_glyphic',
] as const;

function requireWorld(engine: SimulationEngine): WorldState {
  const candidate: unknown = Reflect.get(engine, 'worldState');
  if (!(candidate instanceof WorldState)) {
    throw new Error('Expected SimulationEngine world state');
  }
  return candidate;
}

function createEngine(encounter: YamaEncounter): SimulationEngine {
  const engine = new SimulationEngine({ encounter, startPos: PLAYER_START });
  engine.setMechanicsConfig({
    yamaMageRange: false,
    yamaMelee: false,
    waves: false,
    fireballs: false,
    voidFlares: false,
    infiniteHealth: false,
  });
  return engine;
}

function queueLethalHit(engine: SimulationEngine, targetId: string, impactTick: number): void {
  const target = requireWorld(engine).getNpc(targetId);
  if (!target) {
    throw new Error(`Expected NPC actor ${targetId}`);
  }
  target.vitals.hp = 1;
  enqueueEnginePendingHit(engine, {
    sourceId: 'player',
    targetId,
    style: 'melee',
    attackKind: 'melee_slash',
    launchTick: impactTick - 1,
    impactTick,
    // Overkill, not the 1 that matches the hitpoint set above: hazards resolve before pending
    // hits, so a void flare detonating on the impact tick heals Yama first and a 1 stops killing.
    rolledDamage: 999,
    accuracySucceeded: true,
  });
}

describe('YamaEncounter victory lifecycle', () => {
  it.each(YAMA_KINDS)('%s resolves only Yama defeat and completes at D+7', (kind) => {
    const encounterCandidate = encounterRegistry.create(kind);
    expect(encounterCandidate).toBeInstanceOf(YamaEncounter);
    const encounter = encounterCandidate as YamaEncounter;
    const engine = createEngine(encounter);
    queueLethalHit(engine, YAMA_ACTOR_ID, 1);

    engine.advanceTick(PLAYER_START);

    expect(engine.getEncounterOutcome()).toEqual({
      phase: 'resolving',
      decisiveTick: 1,
      completionTick: 1 + YAMA_VICTORY_COMPLETION_DELAY_TICKS,
      primaryActorId: YAMA_ACTOR_ID,
      completionActorIds: [YAMA_ACTOR_ID],
    });
    for (let offset = 1; offset < YAMA_VICTORY_COMPLETION_DELAY_TICKS; offset++) {
      engine.advanceTick(PLAYER_START);
      expect(engine.getEncounterOutcome().phase).toBe('resolving');
    }
    engine.advanceTick(PLAYER_START);
    expect(engine.getEncounterOutcome().phase).toBe('victory');
    expect(engine.currentTick).toBe(1 + YAMA_VICTORY_COMPLETION_DELAY_TICKS);
    expect(engine.canAdvance()).toBe(false);
  });

  it('cleans post-defeat hazards and future Yama hits while external ownership keeps the outcome active', () => {
    // Given: manual fireballs, a live void flare, and a future Yama hit exist before defeat.
    const encounter = new YamaEncounter(undefined, 0);
    const engine = createEngine(encounter);
    engine.setCompletionOwnership('external-owned');
    const world = requireWorld(engine);
    encounter.executeCommand(
      YAMA_SPAWN_FIREBALL_COMMAND,
      {
        playerPos: PLAYER_START,
        tick: 0,
        world,
        ...createEncounterActorOps(world),
      },
      {},
    );
    encounter.executeCommand(
      YAMA_SPAWN_VOID_FLARE_COMMAND,
      {
        playerPos: PLAYER_START,
        tick: 0,
        world,
        ...createEncounterActorOps(world),
      },
      {},
    );
    enqueueEnginePendingHit(engine, {
      sourceId: YAMA_ACTOR_ID,
      targetId: 'player',
      style: 'magic',
      attackKind: 'magic_fire',
      launchTick: 0,
      impactTick: 5,
      rolledDamage: 99,
      accuracySucceeded: true,
    });
    queueLethalHit(engine, YAMA_ACTOR_ID, 1);

    // When: Yama dies and ticks continue beyond every staged attack.
    engine.advanceTick(PLAYER_START);
    const eventsFromDefeat = [...engine.getLastTickEvents()];
    for (let tick = 2; tick <= 30; tick++) {
      engine.advanceTick(PLAYER_START);
      eventsFromDefeat.push(...engine.getLastTickEvents());
    }

    // Then: external control retains an active outcome, but no Yama-owned work survives or damages the player.
    expect(engine.getEncounterOutcome()).toEqual({ phase: 'active' });
    expect(engine.canAdvance()).toBe(true);
    expect(world.pendingHits.some((hit) => hit.sourceId === YAMA_ACTOR_ID)).toBe(false);
    // A set whose position was captured on the tick before the kill must not announce itself on the
    // tick after it: the sound rides this event, and clearing the pending queue on defeat is the
    // only thing stopping a barrage from starting up over the corpse.
    expect(eventsFromDefeat.some((event) => event.type === 'fireball_spawned')).toBe(false);
    expect(world.getNpcs().some((npc) => npc.npcTypeId === VOID_FLARE_NPC_ID && npc.alive)).toBe(false);
    expect(
      encounter.getSnapshot({ tick: engine.currentTick, mechanics: { fireballs: true } }).visuals.fireballStates,
    ).toEqual([]);
    expect(engine.getDamageHistory().filter((entry) => entry.targetId === 'player')).toEqual([]);
  });

  it('drops a flare explosion queued onto the tick that defeats Yama', () => {
    const encounter = new YamaEncounter(undefined, 0);
    const engine = createEngine(encounter);
    const world = requireWorld(engine);
    encounter.executeCommand(
      YAMA_SPAWN_VOID_FLARE_COMMAND,
      {
        playerPos: PLAYER_START,
        // Spawn far enough back that the fuse lands exactly on tick 1.
        tick: 1 - VOID_FLARE_CHARGE_TICKS,
        world,
        ...createEncounterActorOps(world),
      },
      {},
    );
    queueLethalHit(engine, YAMA_ACTOR_ID, 1);

    engine.advanceTick(PLAYER_START);
    const phaseOnDefeatTick = engine.getEncounterOutcome().phase;
    engine.advanceTick(PLAYER_START);

    expect(engine.getDamageHistory().some((entry) => entry.source === 'VoidFlare')).toBe(false);
    expect(phaseOnDefeatTick).toBe('resolving');
  });

  it('applies a flare heal before the same tick pending player hit, rescuing Yama from a kill', () => {
    const encounter = new YamaEncounter(undefined, 0);
    const engine = createEngine(encounter);
    const world = requireWorld(engine);
    encounter.executeCommand(
      YAMA_SPAWN_VOID_FLARE_COMMAND,
      {
        playerPos: PLAYER_START,
        tick: 1 - VOID_FLARE_CHARGE_TICKS,
        world,
        ...createEncounterActorOps(world),
      },
      {},
    );
    const yama = world.getNpc(YAMA_ACTOR_ID);
    if (!yama) throw new TypeError('Expected Yama actor');
    yama.vitals.hp = 1;
    enqueueEnginePendingHit(engine, {
      sourceId: 'player',
      targetId: YAMA_ACTOR_ID,
      style: 'melee',
      attackKind: 'melee_slash',
      launchTick: 0,
      impactTick: 1,
      rolledDamage: 5,
      accuracySucceeded: true,
    });

    engine.advanceTick(PLAYER_START);

    // Hazards resolve before pending hits, so the heal is applied first.
    const [rolled] = engine
      .getLastTickEvents()
      .flatMap((event) =>
        event.type === 'voidflare_exploded' && typeof event.damage === 'number' ? [event.damage] : [],
      );
    if (typeof rolled !== 'number') throw new TypeError('Expected the flare to detonate on tick 1');
    expect(yama.vitals.hp).toBe(1 + voidFlareExplosionHeal(rolled) - 5);
    expect(yama.alive).toBe(true);
    expect(engine.getEncounterOutcome().phase).toBe('active');
  });

  it('does not complete when a void-flare add dies', () => {
    // Given: a live Yama and a debug-spawned void flare with a lethal hit due on tick 1.
    const encounter = new YamaEncounter(undefined, 0);
    const engine = createEngine(encounter);
    const world = requireWorld(engine);
    encounter.executeCommand(
      YAMA_SPAWN_VOID_FLARE_COMMAND,
      {
        playerPos: PLAYER_START,
        tick: 0,
        world,
        ...createEncounterActorOps(world),
      },
      {},
    );
    const flare = world.getNpcs().find((npc) => npc.npcTypeId === VOID_FLARE_NPC_ID);
    if (!flare) {
      throw new Error('Expected debug-spawned void flare');
    }
    queueLethalHit(engine, flare.id, 1);

    // When: the add death is adjudicated.
    engine.advanceTick(PLAYER_START);

    // Then: the shared encounter outcome remains active and Yama remains alive.
    expect(engine.getEncounterOutcome()).toEqual({ phase: 'active' });
    expect(world.getNpc(YAMA_ACTOR_ID)?.alive).toBe(true);
    expect(engine.canAdvance()).toBe(true);
  });

  it('reset clears resolving state and restores hazard production', () => {
    // Given: encounter-owned Yama has entered the resolving phase.
    const encounter = new YamaEncounter(undefined, 0);
    const engine = createEngine(encounter);
    queueLethalHit(engine, YAMA_ACTOR_ID, 1);
    engine.advanceTick(PLAYER_START);
    expect(engine.getEncounterOutcome().phase).toBe('resolving');

    // When: the engine resets the run.
    engine.reset(PLAYER_START);

    // Then: all lifecycle state is active again and debug hazards can be produced in the fresh world.
    const resetWorld = requireWorld(engine);
    encounter.executeCommand(
      YAMA_SPAWN_VOID_FLARE_COMMAND,
      {
        playerPos: PLAYER_START,
        tick: 0,
        world: resetWorld,
        ...createEncounterActorOps(resetWorld),
      },
      {},
    );
    expect(engine.getEncounterOutcome()).toEqual({ phase: 'active' });
    expect(resetWorld.getNpcs().some((npc) => npc.npcTypeId === VOID_FLARE_NPC_ID)).toBe(true);
    expect(engine.canAdvance()).toBe(true);
  });
});

function spawnedFireballAngles(engine: SimulationEngine): { tick: number; angle: string }[] {
  return engine
    .getEventLog()
    .filter((event) => event.type === 'FIREBALL_SPAWN')
    .map((event) => ({ tick: event.tick, angle: String((event as { angle?: unknown }).angle) }));
}

describe('fireball start practice setting', () => {
  // Burst 0's three sets start on these ticks (BURST_START_TICKS[0] + FIREBALL_SET_OFFSETS).
  const BURST0 = [7, 10, 13];
  const BURST1_OPENER = BURST_START_TICKS[1];

  it('opens every burst on the pinned axis, still rotating start → diagonal → opposite', () => {
    for (const [start, opener, closer] of [
      ['vertical', 'vertical', 'horizontal'],
      ['horizontal', 'horizontal', 'vertical'],
    ] as const) {
      const engine = createYamaEngine(FAR_NORTH, { fireballs: true, fireballStart: start });
      advanceThroughTick(engine, BURST1_OPENER, FAR_NORTH);

      const angles = spawnedFireballAngles(engine);
      expect(angles.filter((a) => BURST0.includes(a.tick)).map((a) => a.angle)).toEqual([opener, 'diagonal', closer]);
      expect(angles.find((a) => a.tick === BURST1_OPENER)?.angle).toBe(opener);
    }
  });

  it("'random' leaves the seeded per-burst coin flip untouched", () => {
    const pinned = createYamaEngine(FAR_NORTH, { fireballs: true, fireballStart: 'random' });
    const unset = createYamaEngine(FAR_NORTH, { fireballs: true });
    advanceThroughTick(pinned, BURST1_OPENER, FAR_NORTH);
    advanceThroughTick(unset, BURST1_OPENER, FAR_NORTH);
    expect(spawnedFireballAngles(pinned)).toEqual(spawnedFireballAngles(unset));
  });

  it('lets a mid-burst change finish the burst in flight and applies it to the next one', () => {
    const engine = createYamaEngine(FAR_NORTH, { fireballs: true, fireballStart: 'vertical' });
    // Past set 1 (tick 7) and set 2 (tick 10), with set 3 (tick 13) still to come.
    advanceThroughTick(engine, 11, FAR_NORTH);

    engine.setMechanicsConfig({
      yamaMageRange: true,
      yamaMelee: true,
      waves: false,
      fireballs: true,
      voidFlares: false,
      infiniteHealth: true,
      fireballStart: 'horizontal',
    });
    advanceThroughTick(engine, BURST1_OPENER, FAR_NORTH);

    const angles = spawnedFireballAngles(engine);
    // The in-flight burst keeps the axis it latched: NOT vertical → diagonal → vertical.
    expect(angles.filter((a) => BURST0.includes(a.tick)).map((a) => a.angle)).toEqual([
      'vertical',
      'diagonal',
      'horizontal',
    ]);
    // The next burst, which had not registered yet, honors the new setting.
    expect(angles.find((a) => a.tick === BURST1_OPENER)?.angle).toBe('horizontal');
  });

  it('keeps pinning every burst across many cycles', () => {
    // Drives past the latch retention window so the expiry path runs. It cannot detect
    // over-pruning — a pruned latch falls back to the live setting, which agrees with it unless
    // the setting changed mid-burst — so that case stays covered by the mid-burst test above.
    // What this does guard is the whole multi-cycle run resolving from the pin rather than
    // drifting once cycle 1 rolls over.
    const engine = createYamaEngine(FAR_NORTH, { fireballs: true, fireballStart: 'vertical' });
    advanceThroughTick(engine, 290, FAR_NORTH);

    // Sets spawn in order, three per burst, so every third event is a burst opener.
    const angles = spawnedFireballAngles(engine);
    const burstStarts = angles.filter((_, i) => i % 3 === 0).map((a) => a.angle);
    expect(burstStarts.length).toBeGreaterThan(8);
    expect(burstStarts.every((angle) => angle === 'vertical')).toBe(true);
  });

  it('honors the pinned orientation for a debug-spawned burst', () => {
    // The debug spawn reaches the encounter through executeCommand, which only learned about
    // the mechanics config so this path could obey it. Asserts BOTH pins from one seed: a fallback
    // that ignored the config would have to match whichever single axis the seed hashes to.
    for (const [start, opener, closer] of [
      ['vertical', 'vertical', 'horizontal'],
      ['horizontal', 'horizontal', 'vertical'],
    ] as const) {
      const engine = createYamaEngine(FAR_NORTH, { fireballs: false, fireballStart: start });
      advanceThroughTick(engine, 2, FAR_NORTH);
      engine.executeEncounterCommand(YAMA_SPAWN_FIREBALL_COMMAND);
      advanceThroughTick(engine, 20, FAR_NORTH);

      const angles = spawnedFireballAngles(engine).map((a) => a.angle);
      expect(angles.length).toBeGreaterThanOrEqual(3);
      expect(angles.slice(0, 3)).toEqual([opener, 'diagonal', closer]);
    }
  });

  it('does not rotate an already-falling burst in the snapshot when the setting changes', () => {
    const engine = createYamaEngine(FAR_NORTH, { fireballs: true, fireballStart: 'vertical' });
    // Tick 8: set 1 spawned on tick 7 and is still falling.
    advanceThroughTick(engine, 8, FAR_NORTH);

    const before = engine.getState().encounter;
    const activeBefore = isYamaSnapshot(before) ? before.visuals.fireballStates.map((f) => f.angle) : [];
    expect(activeBefore).toContain('vertical');

    engine.setMechanicsConfig({
      yamaMageRange: true,
      yamaMelee: true,
      waves: false,
      fireballs: true,
      voidFlares: false,
      infiniteHealth: true,
      fireballStart: 'horizontal',
    });

    // Re-read WITHOUT advancing: a between-tick redraw must not re-derive live lines.
    const after = engine.getState().encounter;
    const activeAfter = isYamaSnapshot(after) ? after.visuals.fireballStates.map((f) => f.angle) : [];
    expect(activeAfter).toEqual(activeBefore);
  });
});

describe('duo side setting', () => {
  const BURST0 = [7, 10, 13];
  const BURST1_OPENER = BURST_START_TICKS[1];

  it('mirrors the diagonal for player 2, leaving opener and closer alone', () => {
    const engine = createYamaEngine(FAR_NORTH, { fireballs: true, fireballStart: 'vertical', duoSide: 'player2' });
    advanceThroughTick(engine, BURST1_OPENER, FAR_NORTH);

    const angles = spawnedFireballAngles(engine);
    expect(angles.filter((a) => BURST0.includes(a.tick)).map((a) => a.angle)).toEqual([
      'vertical',
      'diagonal-alt',
      'horizontal',
    ]);
  });

  it("'player1' spawns the same angles as leaving the setting unset", () => {
    const explicit = createYamaEngine(FAR_NORTH, { fireballs: true, duoSide: 'player1' });
    const unset = createYamaEngine(FAR_NORTH, { fireballs: true });
    advanceThroughTick(explicit, BURST1_OPENER, FAR_NORTH);
    advanceThroughTick(unset, BURST1_OPENER, FAR_NORTH);
    expect(spawnedFireballAngles(explicit)).toEqual(spawnedFireballAngles(unset));
  });

  it('lets a mid-burst change finish the burst in flight and applies it to the next one', () => {
    const engine = createYamaEngine(FAR_NORTH, { fireballs: true, fireballStart: 'vertical', duoSide: 'player1' });
    // Past set 1 (tick 7) and set 2 (tick 10), with set 3 (tick 13) still to come.
    advanceThroughTick(engine, 11, FAR_NORTH);

    engine.setMechanicsConfig({
      yamaMageRange: true,
      yamaMelee: true,
      waves: false,
      fireballs: true,
      voidFlares: false,
      infiniteHealth: true,
      fireballStart: 'vertical',
      duoSide: 'player2',
    });
    advanceThroughTick(engine, BURST1_OPENER + 3, FAR_NORTH);

    const angles = spawnedFireballAngles(engine);
    expect(angles.filter((a) => BURST0.includes(a.tick)).map((a) => a.angle)).toEqual([
      'vertical',
      'diagonal',
      'horizontal',
    ]);
    expect(angles.find((a) => a.tick === BURST1_OPENER + 3)?.angle).toBe('diagonal-alt');
  });

  it('honors the duo side for a debug-spawned burst', () => {
    const engine = createYamaEngine(FAR_NORTH, { fireballs: false, fireballStart: 'vertical', duoSide: 'player2' });
    advanceThroughTick(engine, 2, FAR_NORTH);
    engine.executeEncounterCommand(YAMA_SPAWN_FIREBALL_COMMAND);
    advanceThroughTick(engine, 20, FAR_NORTH);

    expect(
      spawnedFireballAngles(engine)
        .map((a) => a.angle)
        .slice(0, 3),
    ).toEqual(['vertical', 'diagonal-alt', 'horizontal']);
  });
});
