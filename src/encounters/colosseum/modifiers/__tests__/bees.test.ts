import { afterEach, describe, expect, it } from 'vitest';
import { getArenaAllowUnboundedFallback, getArenaConfig, setArenaConfig } from '../../../../core/constants';
import { TickEvents } from '../../../../core/events/TickEvents';
import { markNpcDead } from '../../../../core/npcDeath';
import { isCoordinateInsideFootprint } from '../../../../core/npcRouteFinding';
import { SimulationEngine } from '../../../../core/SimulationEngine';
import { isColosseumVisualEvent } from '../../../../npcs/colosseum/visualEvents';
import { createEncounterActorOps } from '../../../../test/helpers/encounterActorOps';
import type { Coordinate } from '../../../../types/simulation';
import { LobbyEncounter } from '../../../lobby/LobbyEncounter';
import {
  advanceBeeRespawn,
  BEE_DEATH_TELEPORT_TICKS,
  BEE_DESTINATION_RADIUS,
  BEE_RESPAWN_PAUSE_TICKS,
  BEE_WINDOW_TICKS,
  beesDefinition,
  COLOSSEUM_BEE_SPAWN_TILES,
  createBeeSwarms,
} from '../bees';
import { BEES_CAPTURE_A, BEES_CAPTURE_B, beeWindows, readBeeFrames } from './beesCapture';
import { BEE_CAPTURE_B_LIFECYCLE, BEE_CAPTURE_B_SPAWNS, BEE_CAPTURE_B_WAVE_MESSAGE_TICKS } from './fixtures/beeCapture';

const arena = getArenaConfig();
const unbounded = getArenaAllowUnboundedFallback();
afterEach(() => setArenaConfig(arena, unbounded));

function fixture(count: 1 | 2 | 3 = 1, random: () => number = () => 0.5) {
  const engine = new SimulationEngine({ encounter: new LobbyEncounter() });
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
  const world = engine['worldState'];
  const player = world.getPlayer()!;
  player.poisonState.poisonVarp = -20;
  const bees = createBeeSwarms({ tier: count, tick: 0, idPrefix: 'bee', random: () => 0 });
  for (const bee of bees) world.actors.set(bee.id, bee);
  const rules = beesDefinition.register(undefined);
  const events = new TickEvents();
  const ctx = (tick: number) => ({
    tick,
    world,
    tickEvents: events,
    random,
    logEvent: () => {},
    ...createEncounterActorOps(world),
  });
  const step = (tick: number, start: Coordinate, end: Coordinate = start) => {
    events.setTick(tick);
    player.position = [...start];
    for (const bee of bees) {
      advanceBeeRespawn(bee, tick);
      bee.previousPosition = [...bee.position];
      for (const move of rules.move(bee, ctx(tick))) bee.position = [...move.path.at(-1)!];
    }
    const damages = bees.flatMap((bee) => rules.resolveLocalEffects(bee, ctx(tick)));
    player.position = [...end];
    return damages;
  };
  return { engine, world, player, bees, rules, events, ctx, step };
}

describe('generic Bees!', () => {
  it('cuts off a six-step window and samples a fresh destination only at the next boundary', () => {
    let rolls = 0;
    const {
      bees: [bee],
      step,
    } = fixture(1, () => {
      rolls++;
      return 0.5;
    });
    bee!.position = [0, 0];
    step(1, [20, 20]);
    expect(bee!.state.destination).toEqual([20, 20]);
    for (let tick = 2; tick <= 12; tick++) step(tick, [-20, -20]);
    expect(rolls).toBe(1);
    expect(bee!.position).toEqual([6, 6]);
    expect(bee!.state.destination).toEqual([20, 20]);
    step(13, [-20, -20]);
    expect(rolls).toBe(2);
    expect(bee!.state.destination).toEqual([-20, -20]);
    expect(bee!.position).toEqual([5, 5]);
  });

  it('does not special-case standing under the player when a window destination takes it away', () => {
    const {
      bees: [bee],
      step,
    } = fixture(1, () => 0);
    bee!.position = [10, 10];
    expect(step(1, [10, 10])).toHaveLength(1);
    expect(bee!.position).toEqual([9, 9]);
    step(2, [10, 10]);
    step(3, [10, 10]);
    expect(bee!.position).toEqual([8, 8]);
  });

  it('samples the SW-centered radius-six square uniformly before conditioning on valid footprints', () => {
    const {
      player,
      rules,
      ctx,
      bees: [bee],
    } = fixture();
    player.position = [20, 20];
    const destinations = new Set<string>();
    for (let draw = 0; draw < 169; draw++) {
      bee!.state.nextWindowTick = 1;
      rules.move(bee!, { ...ctx(1), random: () => (draw + 0.5) / 169 });
      destinations.add(String(bee!.state.destination));
    }
    expect(BEE_DESTINATION_RADIUS).toBe(6);
    expect(destinations.size).toBe(169);
    expect(destinations.has('14,14')).toBe(true);
    expect(destinations.has('26,26')).toBe(true);
  });

  it('filters the whole footprint and holds the window without reroll loops when nothing fits', () => {
    let rolls = 0;
    const {
      player,
      rules,
      ctx,
      bees: [bee],
    } = fixture(1, () => {
      rolls++;
      return 0;
    });
    player.position = [20, 20];
    setArenaConfig({ bounds: null, collisionMap: null, walkableTiles: new Set(['20,20']) }, true);
    expect(rules.move(bee!, ctx(1))).toEqual([]);
    expect(rolls).toBe(0);
    expect(bee!.state.destination).toBeNull();
    expect(bee!.state.nextWindowTick).toBe(13);
    setArenaConfig(
      { bounds: null, collisionMap: null, walkableTiles: new Set(['20,20', '21,20', '20,21', '21,21']) },
      true,
    );
    rules.move(bee!, ctx(13));
    expect(bee!.state.destination).toEqual([20, 20]);
    expect(rolls).toBe(1);
  });
  it.each([1, 2, 3] as const)('creates %i distinct swarms with immutable per-swarm home tiles', (tier) => {
    const bees = createBeeSwarms({ tier, tick: 8, idPrefix: 'bee', random: () => 0.5 });
    expect(bees).toHaveLength(tier);
    expect(new Set(bees.map((bee) => String(bee.position))).size).toBe(tier);
    for (const bee of bees) {
      expect(COLOSSEUM_BEE_SPAWN_TILES).toContainEqual(bee.position);
      expect(bee.state.spawnPosition).not.toBe(bee.position);
      expect(bee).toMatchObject({
        npcTypeId: 12823,
        size: 2,
        vitals: { hp: 1, maxHp: 1 },
        blocksNpcMovement: false,
        passThruNpcs: true,
        formulaStats: { levels: { defence: 0 } },
      });
      expect(bee.state.nextStepTick).toBe(9);
    }
  });

  it('steps at spawn+1 on the two-tick grid and holds at the fixed destination until the next window', () => {
    const {
      bees: [bee],
      step,
    } = fixture();
    bee!.position = [10, 10];
    expect(step(0, [13, 13])).toEqual([]);
    expect(bee!.position).toEqual([10, 10]);
    step(1, [13, 13]);
    expect(bee!.position).toEqual([11, 11]);
    step(2, [13, 13]);
    expect(bee!.position).toEqual([11, 11]);
    expect(step(3, [13, 13])).toEqual([]); // The moved footprint is not the start footprint.
    expect(bee!.position).toEqual([12, 12]);
    expect(step(4, [13, 13])).toHaveLength(1);
    expect(step(5, [13, 13])).toHaveLength(1);
    expect(bee!.position).toEqual([13, 13]);
    for (let tick = 6; tick <= 12; tick++) {
      step(tick, [40, 40]); // Moving the player does not change the destination inside a window.
      expect(bee!.position).toEqual([13, 13]);
    }
    step(13, [40, 40]);
    expect(bee!.position).toEqual([14, 14]);
  });

  it('matches NPC37847 at B:3105–3109, including hitting as the player leaves', () => {
    const {
      bees: [bee],
      step,
    } = fixture();
    bee!.position = [21, 42]; // B:1813,3114. Seed the recorded movement clock.
    bee!.state.nextStepTick = 3106;
    bee!.state.nextWindowTick = 3113;
    bee!.state.destination = [21, 42];
    expect(step(3105, [20, 42], [21, 42])).toEqual([]);
    for (const tick of [3106, 3107, 3108]) expect(step(tick, [21, 42])).toHaveLength(1);
    expect(step(3109, [21, 42], [19, 42])).toHaveLength(1);
    expect(step(3110, [19, 42])).toEqual([]);
  });

  it('names no attacker on a sting, so a recoil ring reflects nothing (bees are immune to recoil)', () => {
    const {
      bees: [bee],
      step,
    } = fixture();
    bee!.position = [21, 42];
    const [sting] = step(1, [21, 42]);
    expect(sting).toBeDefined();
    expect(sting).not.toHaveProperty('attackerId');
  });

  it('matches B:3125–3133: moved coverage waits a tick, then only the 2x2 footprint stings', () => {
    const {
      bees: [bee],
      step,
    } = fixture();
    bee!.position = [19, 43];
    bee!.state.nextStepTick = 3125;
    bee!.state.nextWindowTick = 3137;
    bee!.state.destination = [19, 42];
    expect(step(3125, [19, 42])).toEqual([]);
    expect(bee!.position).toEqual([19, 42]);
    expect(step(3126, [19, 42], [20, 42])).toHaveLength(1);
    for (let tick = 3127; tick <= 3131; tick++) {
      expect(step(tick, [20, 42])).toHaveLength(1);
      expect(bee!.position).toEqual([19, 42]);
    }
    expect(step(3132, [20, 42], [22, 42])).toHaveLength(1);
    expect(step(3133, [22, 42])).toEqual([]);
  });

  it('needs no prior overlap: any of the four footprint tiles stings, including two swarms at once', () => {
    const { bees, player, rules, ctx, events } = fixture(2);
    player.position = [20, 20];
    for (const bee of bees) {
      bee.position = [21, 20];
      bee.previousPosition = [...bee.position];
      expect(rules.resolveLocalEffects(bee, ctx(1))).toEqual([]);
      bee.position = [19, 19];
      bee.previousPosition = [...bee.position]; // Player is on the NE tile, not the SW anchor.
    }
    expect(bees.flatMap((bee) => rules.resolveLocalEffects(bee, ctx(2)))).toHaveLength(2);
    expect(
      events
        .flush()
        .filter(isColosseumVisualEvent)
        .flatMap((event) => event.animations),
    ).toEqual(bees.map((bee) => ({ actorId: bee.id, clipId: 'attack', delayCycles: 0 })));
  });

  it.each([-20, 0, 20])('uses antipoison state %i to choose the range and poison application', (poisonVarp) => {
    const {
      bees: [bee],
      player,
      rules,
      ctx,
    } = fixture();
    player.position = [...bee!.position];
    player.poisonState.poisonVarp = poisonVarp;
    const [hit] = rules.resolveLocalEffects(bee!, ctx(1));
    expect(hit).toMatchObject({
      source: 'Bees',
      attackType: 'typeless',
      baseDamage: poisonVarp < 0 ? [5, 10] : [10, 20],
    });
    expect(hit?.applyPoison).toBe(poisonVarp < 0 ? undefined : 5);
  });

  it('retains the killed swarm, teleports to its own home at +5, and resumes at teleport+55', () => {
    const { bees, rules, ctx, world, step } = fixture(2);
    for (const bee of bees) {
      bee.position = [20, 20];
      bee.vitals.hp = 0;
      markNpcDead(bee, 100);
      rules.notifyDefeated(bee, { npcId: bee.id, tick: 100 }, 'external-owned', ctx(100));
    }
    for (let tick = 101; tick < 160; tick++) {
      expect(step(tick, [40, 40])).toEqual([]);
      for (const bee of bees) {
        expect(world.getNpc(bee.id)).toBe(bee);
        expect(bee.alive).toBe(false);
        expect(bee.position).toEqual(tick < 105 ? [20, 20] : bee.state.spawnPosition);
      }
    }
    expect(BEE_DEATH_TELEPORT_TICKS).toBe(5);
    expect(BEE_RESPAWN_PAUSE_TICKS).toBe(55);
    step(160, [40, 40]);
    for (const bee of bees) {
      expect(bee.alive).toBe(true);
      expect(bee.vitals.hp).toBe(1);
      expect(bee.despawnTick).toBeUndefined();
      expect(bee.position).toEqual([bee.state.spawnPosition[0] + 1, bee.state.spawnPosition[1] + 1]);
    }
  });
});

describe('bee capture footprint conformance', () => {
  const captured = readBeeFrames(BEES_CAPTURE_B);

  function predictor() {
    // Tick of each swarm's most recent killing hit, as the engine's onDefeated would record it.
    const killTicks = new Map<string, number>();
    const { player, rules, ctx } = fixture();
    return (frame: (typeof captured)[number]) => {
      for (const id of frame.killed) killTicks.set(String(id), frame.tick);
      player.position = [...frame.playerStart];
      return frame.bees.flatMap((record) => {
        const bee = createBeeSwarms({ tier: 1, tick: 0, idPrefix: String(record.id), random: () => 0 })[0]!;
        bee.previousPosition = [...record.position];
        bee.position = [...(frame.moves.find((move) => move.id === record.id)?.to ?? record.position)];
        bee.alive = record.alive && !frame.killed.includes(record.id);
        bee.state.defeatedTick = bee.alive ? null : (killTicks.get(String(record.id)) ?? null);
        return rules.resolveLocalEffects(bee, ctx(frame.tick));
      });
    };
  }

  it('matches every tick of B:3098–3132, including the two swarms stinging at B:3109', () => {
    const predict = predictor();
    for (const frame of captured.filter((frame) => frame.tick >= 3098 && frame.tick <= 3132)) {
      expect(predict(frame), `B:${frame.tick}`).toHaveLength(frame.stings);
    }
    expect(predict(captured.find((frame) => frame.tick === 3109)!)).toHaveLength(2);
    expect(predict(captured.find((frame) => frame.tick === 3105)!)).toEqual([]);
    expect(predict(captured.find((frame) => frame.tick === 3125)!)).toEqual([]);
  });

  it('scripts B:3398–3404: the swarm killed at B:3402 still stings once at B:3403', () => {
    const predict = predictor();
    const frames = captured.filter((frame) => frame.tick >= 3398 && frame.tick <= 3404);
    expect(frames.map((frame) => frame.stings)).toEqual([0, 0, 1, 0, 0, 1, 0]);
    expect(frames.find((frame) => frame.tick === 3402)!.killed).toContain(42191);
    expect(frames.map((frame) => predict(frame).length)).toEqual([0, 0, 1, 0, 0, 1, 0]);
  });

  it('suppresses killed swarms at B:2694 and B:3404 before their later despawn sequences', () => {
    const predict = predictor();
    for (const tick of [2694, 3404]) {
      const frame = captured.find((frame) => frame.tick === tick)!;
      expect(
        frame.bees.some((bee) => !bee.alive && isCoordinateInsideFootprint(bee.position, 2, frame.playerStart)),
      ).toBe(true);
      expect(predict(frame)).toEqual([]);
      expect(frame.stings).toBe(0);
    }
  });

  it('reproduces all 15 stings on 14 ticks in B', () => {
    const predict = predictor();
    expect(captured.reduce((sum, frame) => sum + frame.stings, 0)).toBe(15);
    expect(captured.filter((frame) => frame.stings > 0)).toHaveLength(14);
    let total = 0;
    const mismatches: number[] = [];
    for (const frame of captured) {
      const hits = predict(frame).length;
      total += hits;
      if (hits !== frame.stings) mismatches.push(frame.tick);
    }
    expect(total).toBe(15);
    expect(mismatches).toEqual([]);
  });
});

describe('capture decision windows', () => {
  it.each([
    { file: BEES_CAPTURE_A, crawls: 31 },
    { file: BEES_CAPTURE_B, crawls: 289 },
  ])('puts every $crawls crawl in $file on its spawn/respawn-anchored window grid', ({ file, crawls }) => {
    const frames = readBeeFrames(file);
    let checked = 0;
    for (const frame of frames) {
      for (const move of frame.moves) {
        const bee = frame.bees.find((actor) => actor.id === move.id)!;
        const elapsed = frame.tick - bee.firstCrawlTick;
        expect(elapsed).toBeGreaterThanOrEqual(0);
        expect([0, 2, 4, 6, 8, 10]).toContain(elapsed % BEE_WINDOW_TICKS);
        checked++;
      }
    }
    expect(checked).toBe(crawls);
    for (const window of beeWindows(frames)) {
      expect(window.steps.length).toBeLessThanOrEqual(6);
      expect(isCoordinateInsideFootprint(window.start, 2, window.player)).toBe(false);
    }
  });

  it('chooses the smallest SW square consistent with every observed reached-window destination', () => {
    const windows = [BEES_CAPTURE_A, BEES_CAPTURE_B].flatMap((file) => beeWindows(readBeeFrames(file)));
    const reached = windows.filter((window) => window.complete && window.steps.length > 0 && window.steps.length < 6);
    const offsets = reached.map((window) =>
      window.steps.at(-1)!.position.map((value, axis) => value - window.player[axis]!),
    );
    expect(reached).toHaveLength(30);
    expect(
      [3, 4, 5, 6].map(
        (radius) => offsets.filter((offset) => offset.every((value) => Math.abs(value) <= radius)).length,
      ),
    ).toEqual([15, 26, 26, 30]);
    expect(
      [3, 4, 5, 6].map(
        (radius) => offsets.filter((offset) => offset.every((value) => Math.abs(value + 0.5) <= radius)).length,
      ),
    ).toEqual([10, 18, 26, 26]);
    expect([Math.min(...offsets.map(([x]) => x!)), Math.max(...offsets.map(([x]) => x!))]).toEqual([-2, 6]);
    expect([Math.min(...offsets.map(([, y]) => y!)), Math.max(...offsets.map(([, y]) => y!))]).toEqual([-4, 4]);
  });
});

it('matches the B simultaneous spawn counts at wave-message+5 and retains the observed tiles', () => {
  const observed: Coordinate[] = [];
  for (const [messageTick, spawnTick, count] of [
    [2361, 2366, 1],
    [2630, 2635, 2],
    [2975, 2980, 2],
    [3347, 3352, 3],
  ]) {
    expect(BEE_CAPTURE_B_WAVE_MESSAGE_TICKS).toContain(messageTick);
    expect(spawnTick! - messageTick!).toBe(5);
    const added = BEE_CAPTURE_B_SPAWNS.filter((spawn) => spawn.tick === spawnTick);
    expect(added).toHaveLength(count!);
    for (const { position } of added) observed.push([...position]);
  }
  expect(observed).toHaveLength(8);
  for (const position of observed) expect(COLOSSEUM_BEE_SPAWN_TILES).toContainEqual(position);
  expect(COLOSSEUM_BEE_SPAWN_TILES).toContainEqual([1828 - 1792, 3110 - 3072]); // A:4984.
});

it('keeps the full B death/teleport spread explicit rather than claiming universal +5 conformance', () => {
  const rows: { kill: number; sequence: number; teleport: number; firstCrawl?: number }[] = [];
  const actors = new Map<number, { kill?: number; sequence?: number; row?: (typeof rows)[number] }>();
  for (const [tick, bee, kind] of BEE_CAPTURE_B_LIFECYCLE) {
    const state = kind === 'add' ? {} : (actors.get(bee) ?? {});
    actors.set(bee, state);
    if (kind === 'teleport') {
      expect(state.kill).toBeDefined();
      expect(state.sequence).toBeDefined();
      const row = { kill: state.kill!, sequence: state.sequence!, teleport: tick };
      rows.push(row);
      state.row = row;
    }
    if (kind === 'crawl' && state.row && state.row.firstCrawl === undefined) state.row.firstCrawl = tick;
    if (kind === 'damaged') state.kill = tick;
    if (kind === 'death_sequence') state.sequence = tick;
  }
  expect(rows).toHaveLength(16);
  expect(
    rows.reduce<Record<number, number>>((counts, row) => {
      const gap = row.teleport - row.kill;
      counts[gap] = (counts[gap] ?? 0) + 1;
      return counts;
    }, {}),
  ).toEqual({ 3: 1, 4: 5, 5: 5, 6: 5 });
  expect(rows.every((row) => row.teleport - row.sequence === 3)).toBe(true);
  const complete = rows.filter((row) => row.firstCrawl !== undefined);
  expect(complete).toHaveLength(10);
  expect(complete.every((row) => row.firstCrawl! - row.teleport === 55)).toBe(true);
});
