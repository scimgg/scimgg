import { describe, expect, it, vi } from 'vitest';
import type { EncounterContext } from '../../../core/encounters/types';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import { TickEvents } from '../../../core/events/TickEvents';
import { mulberry32 } from '../../../core/rng';
import { WorldState } from '../../../core/WorldState';
import type { Coordinate } from '../../../types/simulation';
import { ZukSparkVolleyCommandSchema } from '../commands';
import { generateSparkVolley, ZukSparkLandings } from '../sparks';

const MAX_DRAW = 1 - Number.EPSILON;

function sequence(values: readonly number[]) {
  let index = 0;
  return vi.fn(() => {
    const value = values[index++];
    if (value === undefined) throw new RangeError('Unexpected spark random draw');
    return value;
  });
}

describe('generateSparkVolley', () => {
  it.each([
    [-3, -2],
    [-2, 0],
    [2, 0],
    [3, 2],
  ])('shifts strips at player delta %s by %s when sampling off-row', (delta, shift) => {
    const source: Coordinate = [10, 20];

    const sparks = generateSparkVolley({ source, player: [10 + delta, 20], random: () => 0 });

    expect(sparks.map((spark) => spark.position)).toEqual([
      [11 + shift, 12],
      [9 + shift, 12],
      [7 + shift, 12],
    ]);
  });

  it.each([0, MAX_DRAW])('includes every draw boundary when random returns %s', (draw) => {
    const random = vi.fn(() => draw);

    const sparks = generateSparkVolley({ source: [10, 20], player: [10, 20], random });

    expect(sparks.map((spark) => spark.position)).toEqual(
      draw === 0
        ? [
            [11, 12],
            [9, 12],
            [7, 12],
          ]
        : [
            [13, 15],
            [11, 15],
            [9, 15],
          ],
    );
    for (const spark of sparks) {
      expect(spark.amount).toBe(draw === 0 ? 5 : 10);
      expect(spark.projectile).toEqual({
        sourcePosition: [10.5, 20.5],
        startDelayCycles: 0,
        endDelayCycles: 90,
        slope: draw === 0 ? 40 : 50,
        startOffset: 0,
        startHeight: 70,
        endHeight: 0,
      });
      expect(spark.landing).toEqual({ height: 0, delayCycles: draw === 0 ? 0 : 5 });
    }
    expect(random).toHaveBeenCalledTimes(15);
    expect(ZukSparkVolleyCommandSchema.safeParse({ encounter: 'zuk', type: 'emit-spark-volley', sparks }).success).toBe(
      true,
    );
  });

  it.each([
    { playerX: 11, forcedIndex: 0 },
    { playerX: 9, forcedIndex: 1 },
    { playerX: 8, forcedIndex: 2 },
  ])('forces only the first containing strip when the player is at X $playerX', ({ playerX, forcedIndex }) => {
    const player: Coordinate = [playerX, 14];
    const random = vi.fn(() => 0);

    const sparks = generateSparkVolley({ source: [10, 20], player, random });

    expect(sparks[forcedIndex]?.position).toEqual(player);
    expect(sparks.filter((spark) => spark.position[0] === playerX && spark.position[1] === 14)).toHaveLength(1);
    expect(random).toHaveBeenCalledTimes(13);
  });

  it.each([12, 15])('includes footprint row %s when deciding eligibility', (playerY) => {
    const random = vi.fn(() => 0.5);

    const sparks = generateSparkVolley({ source: [10, 20], player: [10, playerY], random });

    expect(sparks[1].position).toEqual([10, playerY]);
    expect(random).toHaveBeenCalledTimes(13);
  });

  it.each<Coordinate>([
    [10, 11],
    [10, 16],
    [10, 20],
    [30, 14],
    [-10, 14],
  ])('samples all strips without forcing an out-of-area player at (%s, %s)', (playerX, playerY) => {
    const random = vi.fn(() => 0);

    const sparks = generateSparkVolley({ source: [10, 20], player: [playerX, playerY], random });

    expect(sparks.every((spark) => spark.position[1] === 12)).toBe(true);
    expect(sparks.some((spark) => spark.position[0] === playerX && spark.position[1] === playerY)).toBe(false);
    expect(random).toHaveBeenCalledTimes(15);
  });

  it('draws X, Y, damage, slope, delay independently for each unforced spark', () => {
    const random = sequence([0, 0.25, 0, 0.1, 0.4, 0.5, 0.5, MAX_DRAW, 0.9, MAX_DRAW, MAX_DRAW, 0, 0.5, 0.5, 0]);

    const sparks = generateSparkVolley({ source: [10, 20], player: [10, 20], random });

    expect(
      sparks.map((spark) => [spark.position, spark.amount, spark.projectile?.slope, spark.landing?.delayCycles]),
    ).toEqual([
      [[11, 13], 5, 41, 2],
      [[10, 14], 10, 49, 5],
      [[9, 12], 8, 45, 0],
    ]);
    expect(random).toHaveBeenCalledTimes(15);
  });

  it('skips only the forced coordinates in the random draw sequence', () => {
    const random = sequence([0, 0.1, 0.4, 0.5, 0.5, MAX_DRAW, 0.9, MAX_DRAW, MAX_DRAW, 0, 0.5, 0.5, 0]);

    const sparks = generateSparkVolley({ source: [10, 20], player: [11, 14], random });

    expect(
      sparks.map((spark) => [spark.position, spark.amount, spark.projectile?.slope, spark.landing?.delayCycles]),
    ).toEqual([
      [[11, 14], 5, 41, 2],
      [[10, 14], 10, 49, 5],
      [[9, 12], 8, 45, 0],
    ]);
    expect(random).toHaveBeenCalledTimes(13);
  });

  it('preserves coincident destinations with separate samples and detached immutable coordinates', () => {
    const source: Coordinate = [10, 20];
    const player: Coordinate = [11, 14];
    const random = sequence([0, 0, 0, MAX_DRAW, 0.5, MAX_DRAW, MAX_DRAW, MAX_DRAW, 0, 0, 0.5, 0.5, 0.5]);

    const sparks = generateSparkVolley({ source, player, random });
    source[0] = 100;
    player[0] = 100;

    expect(sparks.map((spark) => [spark.position, spark.amount])).toEqual([
      [[11, 14], 5],
      [[11, 14], 10],
      [[7, 12], 8],
    ]);
    expect(sparks[0].position).not.toBe(sparks[1].position);
    expect(sparks[0].projectile?.sourcePosition).not.toBe(sparks[1].projectile?.sourcePosition);
    for (const spark of sparks) {
      expect(spark.projectile?.sourcePosition).toEqual([10.5, 20.5]);
      expect(Object.isFrozen(spark.position)).toBe(true);
      expect(Object.isFrozen(spark.projectile?.sourcePosition)).toBe(true);
    }
  });

  it('reproduces seeded volleys within each ordered strip and the command schema', () => {
    const random = mulberry32(12345);
    const replayRandom = mulberry32(12345);

    const volleys = Array.from({ length: 200 }, () =>
      generateSparkVolley({ source: [10, 20], player: [13, 20], random }),
    );

    expect(volleys).toEqual(
      Array.from({ length: 200 }, () =>
        generateSparkVolley({ source: [10, 20], player: [13, 20], random: replayRandom }),
      ),
    );
    expect(new Set(volleys.map((volley) => JSON.stringify(volley))).size).toBeGreaterThan(1);
    for (const sparks of volleys) {
      expect(
        ZukSparkVolleyCommandSchema.safeParse({ encounter: 'zuk', type: 'emit-spark-volley', sparks }).success,
      ).toBe(true);
      sparks.forEach((spark, index) => {
        expect(spark.position[0]).toBeGreaterThanOrEqual(13 - index * 2);
        expect(spark.position[0]).toBeLessThanOrEqual(15 - index * 2);
        expect(spark.position[1]).toBeGreaterThanOrEqual(12);
        expect(spark.position[1]).toBeLessThanOrEqual(15);
      });
    }
  });
});

describe('generated spark landings', () => {
  function fixture() {
    const context: EncounterContext = {
      tick: 10,
      playerPos: [11, 14],
      world: new WorldState(),
      tickEvents: new TickEvents(),
      logEvent: () => undefined,
      grantNextAttackSpeedup: () => undefined,
      spawnNpc: () => undefined,
      despawnNpc: () => undefined,
    };
    const sparks = generateSparkVolley({ source: [10, 20], player: [11, 14], random: () => 0.5 });
    const landings = new ZukSparkLandings();
    return { context, sparks, landings };
  }

  it('emits three flights and lands source-independent typeless contributions once at cast plus three', () => {
    const { context, sparks, landings } = fixture();

    const cue = landings.emit({ sparks }, 10);
    const before = landings.resolve({ ...context, tick: 12 });
    const damage = landings.resolve({ ...context, tick: 13 });
    const after = landings.resolve({ ...context, tick: 14 });

    expect(cue?.projectiles).toHaveLength(3);
    expect(cue?.projectiles.every((projectile) => projectile.spotAnimId === 660)).toBe(true);
    expect(before).toEqual([]);
    expect(damage).toEqual(
      Array.from({ length: 2 }, () => ({
        baseDamage: 8,
        attackType: 'typeless',
        source: 'ZukSpark',
        playerPosition: [11, 14],
      })),
    );
    expect(after).toEqual([]);
    expect(
      context.tickEvents
        .flush()
        .filter(isEncounterVisualEvent)
        .flatMap((event) => event.graphics),
    ).toHaveLength(3);
  });

  it('drops generated landings when cleared before impact', () => {
    const { context, sparks, landings } = fixture();
    landings.emit({ sparks }, 10);

    landings.clear();

    expect(landings.resolve({ ...context, tick: 13 })).toEqual([]);
    expect(context.tickEvents.flush()).toEqual([]);
  });
});
