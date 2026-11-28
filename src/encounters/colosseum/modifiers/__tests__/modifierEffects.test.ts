import { describe, expect, it } from 'vitest';
import type { NpcMovementInfo } from '../../../../core/encounters/types';
import { createNpcStepOccupancyPredicate, TileOccupancy } from '../../../../core/npcOccupancy';
import { WorldState } from '../../../../core/WorldState';
import { COLOSSEUM_SPOTANIMS } from '../../../../npcs/colosseum/constants';
import { findContiguousRegion } from '../../../../rs/collision/WalkabilityAnalyzer';
import { findProjectCacheZip, loadColosseumWaveArena } from '../../../../test/helpers/colosseumCollision';
import { REAL_CACHE_TEST_TIMEOUT_MS, skipWithoutRealCache } from '../../../../test/helpers/real-cache';
import type { Coordinate } from '../../../../types/simulation';
import { ColosseumRouteRunner } from '../routeRunner';
import { createSolarflare, SOLARFLARE_DAMAGE_SOURCE, SOLARFLARE_TIMING, SolarflareDamageState } from '../solarflare';
import {
  VOLATILITY_GIB_LIFETIME_TICKS,
  volatilityExplosionCentre,
  volatilityExplosionDamage,
  volatilityExplosionGraphics,
  volatilityExplosionTiles,
  volatilityGibForNpcType,
  volatilityRingDelay,
} from '../volatility';
import { CAPTURED_VOLATILITY_DEATHS } from './fixtures/volatilityCapture';

const corners = [
  [0, 0],
  [0, 4],
  [4, 4],
  [4, 0],
] as const;

describe('Colosseum corner route runner', () => {
  it.each([
    { tier: 1, interval: 2, nextSide: 13, lap: 52 },
    { tier: 2, interval: 2, nextSide: 8, lap: 32 },
    { tier: 3, interval: 1, nextSide: 5, lap: 20 },
  ] as const)('uses tier $tier step/corner timing without an extra pause', ({ tier, interval, nextSide, lap }) => {
    const route = new ColosseumRouteRunner(corners, SOLARFLARE_TIMING[tier]);
    expect(route.positionAt(-1)).toEqual([0, 0]);
    for (let step = 0; step < 4; step++) {
      expect(route.positionAt(step * interval)).toEqual([0, step + 1]);
    }
    for (let tick = 3 * interval; tick < nextSide; tick++) expect(route.positionAt(tick)).toEqual([0, 4]);
    expect(route.positionAt(nextSide)).toEqual([1, 4]);
    expect(route.lapTicks).toBe(lap);
    expect(route.positionAt(lap - 1)).toEqual([0, 0]);
    for (let tick = 0; tick < lap * 3; tick++) {
      expect(route.positionAt(tick + lap)).toEqual(route.positionAt(tick));
    }
    const exposed = route.positionAt(0);
    exposed[0] = 100;
    expect(route.positionAt(0)).toEqual([0, 1]);
  });

  it('supports unequal sides and rejects empty or diagonal segments', () => {
    const route = new ColosseumRouteRunner(
      [
        [0, 0],
        [0, 2],
        [3, 2],
        [3, 0],
      ],
      { stepInterval: 2, cornerPause: 0 },
    );
    expect(route.lapTicks).toBe(20);
    expect(route.positionAt(2)).toEqual([0, 2]);
    expect(route.positionAt(4)).toEqual([1, 2]);
    expect(
      () =>
        new ColosseumRouteRunner(
          [
            [0, 0],
            [1, 1],
          ],
          SOLARFLARE_TIMING[1],
        ),
    ).toThrow();
    expect(() => new ColosseumRouteRunner([], SOLARFLARE_TIMING[1])).toThrow();
  });

  it('creates inert cache-backed orbs which set no entity collision flags', () => {
    const orb = createSolarflare({ id: 'orb', corners, tier: 1, spawnTick: 3, firstStepTick: 4 });
    expect(orb).toMatchObject({
      npcTypeId: 12826,
      size: 1,
      blocksNpcMovement: false,
      combat: { targetId: null, attackRange: 0 },
    });
    const occupancy = new TileOccupancy();
    const canStep = createNpcStepOccupancyPredicate(occupancy.reconcile([orb]));
    expect(canStep([-1, 0], [0, 0], 1)).toBe(true);
    orb.blocksNpcMovement = true;
    occupancy.reconcile([orb]);
    expect(canStep([-1, 0], [0, 0], 1)).toBe(false);
  });
});

describe('Volatility footprint and ring delay', () => {
  it.each([1, 2, 3] as const)('hits every inside start tile and no outside tile at tier %i', (tier) => {
    const tiles = volatilityExplosionTiles([10, 20], 5, tier);
    for (const tile of tiles) {
      expect(volatilityExplosionDamage([10, 20], 5, tier, tile)).toEqual([
        { baseDamage: [16, 24], attackType: 'typeless', source: 'Volatility', playerPosition: tile },
      ]);
    }
    for (const tile of [
      [7, 20],
      [10, 17],
      [17, 20],
      [10, 27],
    ] as Coordinate[]) {
      expect(volatilityExplosionDamage([10, 20], 5, tier, tile)).toEqual([]);
    }
  });
  it.each([3, 5])('expands a size-%i footprint at all three tiers', (size) => {
    const position: Coordinate = [10, 20];
    const centre = volatilityExplosionCentre(position, size);
    expect(centre).toEqual([10 + Math.floor(size / 2), 20 + Math.floor(size / 2)]);
    for (const tier of [1, 2, 3] as const) {
      const radius = Math.min(tier, 2);
      const side = size + 2 * radius;
      const tiles = volatilityExplosionTiles(position, size, tier);
      expect(tiles).toHaveLength(side * side);
      expect(new Set(tiles.map(String)).size).toBe(side * side);
      expect(tiles[0]).toEqual([10 - radius, 20 - radius]);
      expect(tiles.at(-1)).toEqual([10 + size - 1 + radius, 20 + size - 1 + radius]);
      expect(volatilityRingDelay(centre, centre)).toBe(0);
      expect(volatilityRingDelay(tiles[0]!, centre)).toBe(side - 1);
      expect(volatilityRingDelay([centre[0] + 1, centre[1] - 2], centre)).toBe(4);
    }
    expect(volatilityExplosionTiles(position, size, 3)).toEqual(volatilityExplosionTiles(position, size, 2));
  });
});

describe('Volatility wave deaths (Run A)', () => {
  const omittedTiles = (death: (typeof CAPTURED_VOLATILITY_DEATHS)[number]) =>
    new Set(death.omitted.map(([dx, dy]) => `${death.position[0] + dx},${death.position[1] + dy}`));

  it('covers every captured size and gib, including all four minotaur gibs', () => {
    expect(CAPTURED_VOLATILITY_DEATHS).toHaveLength(33);
    expect(new Set(CAPTURED_VOLATILITY_DEATHS.map(({ size }) => size))).toEqual(new Set([1, 3]));
    expect(CAPTURED_VOLATILITY_DEATHS.filter(({ gibNpcTypeId }) => gibNpcTypeId === 12830)).toHaveLength(4);
  });

  it.each(
    CAPTURED_VOLATILITY_DEATHS,
  )('A:$tick: npc $npcTypeId leaves gib $gibNpcTypeId with spotanim $explosionSpotAnimId', (death) => {
    const gib = volatilityGibForNpcType(death.npcTypeId);
    expect(gib).toMatchObject({ npcTypeId: death.gibNpcTypeId, explosionSpotAnimId: death.explosionSpotAnimId });
    expect(VOLATILITY_GIB_LIFETIME_TICKS).toBe(death.gibTicks);

    const omitted = omittedTiles(death);
    const graphics = volatilityExplosionGraphics({
      npcPosition: death.position,
      npcSize: death.size,
      tier: death.tier,
      explosionSpotAnimId: gib!.explosionSpotAnimId,
      isWalkable: ([x, y]) => !omitted.has(`${x},${y}`),
    });
    const center = volatilityExplosionCentre(death.position, death.size);
    expect(graphics[0]).toEqual({
      spotAnimId: death.explosionSpotAnimId,
      target: { kind: 'tile', position: center },
      delayCycles: 0,
      height: 0,
    });
    const impacts = graphics.slice(1);
    const side = death.size + 2 * Math.min(death.tier, 2);
    expect(impacts).toHaveLength(side * side - death.omitted.length);
    for (const impact of impacts) {
      expect(impact.spotAnimId).toBe(COLOSSEUM_SPOTANIMS.fireblastImpact);
      if (impact.target.kind !== 'tile') throw new Error('an impact off its tile');
      expect(omitted.has(String(impact.target.position))).toBe(false);
      expect(impact.delayCycles).toBe(volatilityRingDelay(impact.target.position, center));
    }

    const damage = volatilityExplosionDamage(death.position, death.size, death.tier, death.playerStart);
    expect(damage).toHaveLength(death.damage === null ? 0 : 1);
    if (death.damage !== null) {
      const [min, max] = damage[0]!.baseDamage as [number, number];
      expect(death.damage).toBeGreaterThanOrEqual(min);
      expect(death.damage).toBeLessThanOrEqual(max);
    }
  });

  it('maps every wave species, leaving Sol and modifier actors to their own rules', () => {
    for (const id of [12810, 12811, 12814, 12815, 12816]) expect(volatilityGibForNpcType(id)?.npcTypeId).toBe(12828);
    expect(volatilityGibForNpcType(12818)?.npcTypeId).toBe(12829);
    for (const id of [12812, 12813]) expect(volatilityGibForNpcType(id)?.npcTypeId).toBe(12830);
    for (const id of [12817, 12819]) expect(volatilityGibForNpcType(id)?.npcTypeId).toBe(12831);
    for (const id of [12821, 12823, 12825, 12826]) expect(volatilityGibForNpcType(id)).toBeNull();
  });

  it('centers a size-2 jaguar explosion on its north-east footprint tile', () => {
    const graphics = volatilityExplosionGraphics({
      npcPosition: [30, 30],
      npcSize: 2,
      tier: 1,
      explosionSpotAnimId: 2713,
      isWalkable: () => true,
    });
    expect(graphics[0]!.target).toEqual({ kind: 'tile', position: [31, 31] });
    expect(graphics).toHaveLength(1 + 16);
    expect(volatilityExplosionDamage([30, 30], 2, 1, [29, 32])).toHaveLength(1);
    expect(volatilityExplosionDamage([30, 30], 2, 1, [33, 30])).toEqual([]);
  });

  it.skipIf(skipWithoutRealCache())(
    'omits exactly the explosion tiles outside the cached wave arena floor',
    async () => {
      const analysis = await loadColosseumWaveArena(findProjectCacheZip()!);
      const floor = findContiguousRegion(analysis.walkableTiles, 33, 31, analysis.collisionMap);
      for (const death of CAPTURED_VOLATILITY_DEATHS) {
        const blocked = volatilityExplosionTiles(death.position, death.size, death.tier)
          .map(String)
          .filter((tile) => !floor.has(tile));
        expect(new Set(blocked), `A:${death.tick}`).toEqual(omittedTiles(death));
      }
    },
    REAL_CACHE_TEST_TIMEOUT_MS,
  );
});

describe('Solarflare departure damage', () => {
  const movement = (from: Coordinate, to: Coordinate): NpcMovementInfo => ({
    npcId: 'orb',
    from,
    to,
    moved: from[0] !== to[0] || from[1] !== to[1],
    path: [to],
  });
  const context = (tick: number, playerPos: Coordinate) => ({ tick, playerPos, world: new WorldState() });

  it.each([
    1, 2, 3,
  ] as const)('lands a qualifying departure one tick later at tier %i, regardless of later movement', (tier) => {
    const state = new SolarflareDamageState();
    expect(state.resolveTick(context(4, [0, 0]), [movement([0, 0], [0, 1])], tier)).toEqual([]);
    expect(state.resolveTick(context(5, [9, 9]), [], tier)).toEqual([
      { baseDamage: [10, 20], attackType: 'typeless', source: SOLARFLARE_DAMAGE_SOURCE, playerPosition: [9, 9] },
    ]);
    expect(state.resolveTick(context(6, [0, 0]), [], tier)).toEqual([]);
  });

  it('does not hit arrival-only overlap, corner holds, or a player who left before departure', () => {
    const state = new SolarflareDamageState();
    expect(state.resolveTick(context(4, [0, 1]), [movement([0, 0], [0, 1])], 3)).toEqual([]);
    expect(state.resolveTick(context(5, [0, 1]), [movement([0, 1], [0, 1])], 3)).toEqual([]);
    expect(state.resolveTick(context(6, [9, 9]), [movement([0, 1], [0, 2])], 3)).toEqual([]);
    expect(state.resolveTick(context(7, [9, 9]), [], 3)).toEqual([]);
  });

  it('keeps distinct same-tick departures and clears queued hits on reset', () => {
    const state = new SolarflareDamageState();
    state.resolveTick(context(4, [0, 0]), [movement([0, 0], [0, 1]), movement([0, 0], [1, 0])], 1);
    expect(state.resolveTick(context(5, [9, 9]), [], 1)).toHaveLength(2);
    state.resolveTick(context(6, [0, 0]), [movement([0, 0], [0, 1])], 1);
    state.reset();
    expect(state.resolveTick(context(7, [9, 9]), [], 1)).toEqual([]);
  });
});
