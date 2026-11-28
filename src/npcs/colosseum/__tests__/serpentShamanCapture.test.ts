import { afterEach, describe, expect, it } from 'vitest';
import type { ArenaConfig } from '../../../core/arena/ArenaConfig';
import { hasLineOfSight } from '../../../core/combat/distance';
import { CollisionFlag } from '../../../rs/collision/CollisionFlag';
import { findProjectCacheZip, loadColosseumWaveArena } from '../../../test/helpers/colosseumCollision';
import { enqueueEnginePendingHit } from '../../../test/helpers/pendingHits';
import { REAL_CACHE_TEST_TIMEOUT_MS, skipWithoutRealCache } from '../../../test/helpers/real-cache';
import { type Coordinate, PrayerType } from '../../../types/simulation';
import { createJaguarWarrior } from '../jaguarWarrior';
import { createSerpentShaman, SERPENT_SHAMAN_REMOVAL_DELAY_TICKS, SERPENT_SHAMAN_SPOTANIMS } from '../serpentShaman';
import {
  COLOSSEUM_PILLAR_SOUTH_WEST_TILES,
  SERPENT_SHAMAN_CAPTURE,
  SERPENT_SHAMAN_KILL_TICK_CAST,
  type ShamanCaptureEpisode,
} from './fixtures/serpentShamanCapture';
import {
  attackStarts,
  clearArena,
  playerHits,
  scriptedRandom,
  standInOccupant,
  startWaveNpcEngine,
  visuals,
} from './jaguarShamanTestEngine';

afterEach(clearArena);

/** Accuracy then damage: an accurate maximum roll, or a miss. */
const ACCURATE_MAX = [0, 0.999999];
const MISS = [0.999999, 0.5];

interface ObservedTick {
  readonly tick: number;
  readonly shaman: Coordinate;
  readonly jaguar?: Coordinate;
  readonly cast?: { readonly endCycles: number; readonly impact: boolean };
}

/**
 * Replays one episode through the production definitions: the capture's start-of-tick player tiles
 * and Protect from Magic, its blockers removed on their `del` tick. The capture's first tick is engine
 * tick 1, so an NPC added earlier carries a negative spawn tick. Each cast is rolled accurate (at the
 * maximum) exactly when the capture sent its impact spotanim.
 */
function replay(episode: ShamanCaptureEpisode, arena?: ArenaConfig) {
  const base = episode.ticks[0]!.tick - 1;
  const spawnTick = episode.spawnTick - base;
  const shaman = createSerpentShaman({
    id: 'shaman',
    position: episode.start,
    spawnTick,
    relentless: episode.relentless,
  });
  shaman.combat.nextActionTick = episode.readyTick - base;
  const jaguar = episode.jaguarStart && createJaguarWarrior({ id: 'jaguar', position: episode.jaguarStart, spawnTick });
  const blockers = episode.blockers.map((blocker, index) =>
    standInOccupant(`blocker-${index}`, blocker.npcId, blocker.position, blocker.size),
  );
  const removals = new Map(episode.blockers.map((blocker, index) => [`blocker-${index}`, blocker.removedTick - base]));
  // Capture order: blockers and the jaguar have the lower NPC indices.
  const { engine, encounter, step } = startWaveNpcEngine([...blockers, ...(jaguar ? [jaguar] : []), shaman], {
    playerStart: episode.ticks[0]!.playerStart,
    removals,
    ...(arena && { arena }),
  });

  const observed: ObservedTick[] = [];
  const hits: { tick: number; damage: number }[] = [];
  let praying = false;
  for (const frame of episode.ticks) {
    if (frame.protectMagic !== praying) {
      engine.queueProtectionPrayer(frame.protectMagic ? PrayerType.ProtectMagic : null);
      praying = frame.protectMagic;
    }
    encounter.random = scriptedRandom([...(frame.cast?.impact === false ? MISS : ACCURATE_MAX)]);
    const events = step(frame.playerStart);
    const cast = visuals(events).find((visual) =>
      visual.animations.some((animation) => animation.actorId === shaman.id && animation.clipId === 'attack'),
    );
    const projectile = cast?.projectiles[0];
    observed.push({
      tick: frame.tick,
      shaman: [...shaman.position],
      ...(jaguar && { jaguar: [...jaguar.position] }),
      ...(projectile && {
        cast: {
          endCycles: projectile.endDelayCycles,
          impact: cast.graphics.some((graphic) => graphic.spotAnimId === SERPENT_SHAMAN_SPOTANIMS.impact),
        },
      }),
    });
    expect(attackStarts(events, shaman.id)).toHaveLength(projectile ? 1 : 0);
    for (const hit of playerHits(events)) hits.push({ tick: frame.tick, damage: hit.damage });
  }
  const expected = episode.ticks.map(({ tick, shaman: tile, jaguar: jaguarTile, cast }) => ({
    tick,
    shaman: tile,
    ...(jaguarTile && { jaguar: jaguarTile }),
    ...(cast && { cast }),
  }));
  return { observed, expected, hits };
}

/** Every simulated splat falls on a tick the capture shows a player splat. */
function expectSplatsCaptured(episode: ShamanCaptureEpisode, hits: readonly { tick: number }[]) {
  const captured = new Set(episode.ticks.filter((frame) => frame.playerSplats.length > 0).map((frame) => frame.tick));
  expect(hits.filter((hit) => !captured.has(hit.tick))).toEqual([]);
}

describe('serpent shaman capture replay', () => {
  it('walks in, stalls on a pillar-blocked view and casts every 5 ticks from add+3 (A:1333-1366)', () => {
    const episode = SERPENT_SHAMAN_CAPTURE.pillarCasts;
    const { observed, expected, hits } = replay(episode);

    expect(observed).toEqual(expected);
    // Hit ticks either side of the distance boundary: d 9 lands +4 (1336, 1341, 1351, 1361), d 8 and
    // d 7 land +3 (1346, 1356, 1366 -> 1369, past the episode).
    expect(hits).toEqual([1340, 1345, 1349, 1355, 1359, 1365].map((tick) => ({ tick, damage: 0 })));
    expectSplatsCaptured(episode, hits);
  });

  it('holds behind the pillar and a dying minotaur, then moves and casts on one tick (A:3719)', () => {
    const episode = SERPENT_SHAMAN_CAPTURE.pillarMoveAndCast;
    const { observed, expected, hits } = replay(episode);

    expect(observed).toEqual(expected);
    expect(hits).toEqual([{ tick: 3722, damage: 0 }]);
    expectSplatsCaptured(episode, hits);
    // Why it held: only the ray traced from the player is blocked (by the pillar's (24,43)).
    expect(hasLineOfSight(22, 43, 25, 44)).toBe(false);
    expect(hasLineOfSight(25, 44, 22, 43)).toBe(true);
  });

  it('hits through a prayer raised after the cast (C:1867 -> 1871 = 28)', () => {
    const episode = SERPENT_SHAMAN_CAPTURE.unprayedCastPrayedLanding;
    const { observed, expected, hits } = replay(episode);

    expect(observed).toEqual(expected);
    expect(hits).toEqual([{ tick: 1871, damage: 28 }]);
    expectSplatsCaptured(episode, hits);
  });

  it('does nothing through a prayer dropped after the cast, even under Relentless III (B:2104, B:2109)', () => {
    const episode = SERPENT_SHAMAN_CAPTURE.prayedCastUnprayedLanding;
    const { observed, expected, hits } = replay(episode);

    expect(observed).toEqual(expected);
    expect(hits).toEqual([
      { tick: 2107, damage: 0 },
      { tick: 2112, damage: 0 },
    ]);
    expectSplatsCaptured(episode, hits);
  });

  it('casts on its own killing tick, and the cast lands after it dies (A:1967)', () => {
    const witness = SERPENT_SHAMAN_KILL_TICK_CAST;
    const base = witness.killTick - 1;
    const shaman = createSerpentShaman({ id: 'shaman', position: witness.shaman, spawnTick: -50 });
    shaman.combat.nextActionTick = 1;
    const { engine, step } = startWaveNpcEngine([shaman], { playerStart: witness.playerStart });
    engine.queueProtectionPrayer(PrayerType.ProtectMagic);
    enqueueEnginePendingHit(engine, {
      sourceId: 'player',
      targetId: shaman.id,
      style: 'magic',
      attackKind: 'magic_shadow',
      launchTick: 0,
      impactTick: witness.killTick - base,
      rolledDamage: shaman.vitals.hp,
      accuracySucceeded: true,
    });

    const castTicks: number[] = [];
    const hitTicks: number[] = [];
    for (let tick = witness.killTick; tick <= witness.removedTick; tick++) {
      const events = step(witness.playerStart);
      if (attackStarts(events, shaman.id).length > 0) castTicks.push(tick);
      if (playerHits(events).length > 0) hitTicks.push(tick);
    }

    expect(castTicks).toEqual([witness.killTick]);
    expect(hitTicks).toEqual([witness.castSplatTick]);
    expect(shaman.deathAnimationTick).toBe(witness.deathSequenceTick - base);
    // The wave owner removes it this long after its death sequence.
    expect(witness.removedTick - witness.deathSequenceTick).toBe(SERPENT_SHAMAN_REMOVAL_DELAY_TICKS);
  });

  it('steps off a player standing on it without casting that tick, then casts (B:2254-2255)', () => {
    const shaman = createSerpentShaman({ id: 'shaman', position: [27, 40], spawnTick: -50 });
    shaman.combat.nextActionTick = 1;
    const { step } = startWaveNpcEngine([shaman], { playerStart: [27, 40] });

    const first = step([27, 40]);
    expect(shaman.position).not.toEqual([27, 40]);
    expect(attackStarts(first, shaman.id)).toEqual([]);
    expect(attackStarts(step([27, 40]), shaman.id)).toHaveLength(1);
  });
});

describe('serpent shaman on the cached wave arena', () => {
  it.skipIf(skipWithoutRealCache())(
    'replays every episode the same over the cache collision as over the pillar fixture',
    async () => {
      const cachePath = findProjectCacheZip();
      if (!cachePath) throw new Error('Expected a real cache zip');
      const arena = await loadColosseumWaveArena(cachePath);
      for (const episode of Object.values(SERPENT_SHAMAN_CAPTURE)) {
        const { observed, expected, hits } = replay(episode, arena);
        expect(observed).toEqual(expected);
        expect(hits).toEqual(replay(episode).hits);
      }
    },
    REAL_CACHE_TEST_TIMEOUT_MS,
  );

  it.skipIf(skipWithoutRealCache())(
    'has the four 3x3 pillars of the fixture as the only blocked tiles inside the floor the replays use',
    async () => {
      const cachePath = findProjectCacheZip();
      if (!cachePath) throw new Error('Expected a real cache zip');
      const arena = await loadColosseumWaveArena(cachePath);
      const blocking = CollisionFlag.OBJECT | CollisionFlag.OBJECT_PROJECTILE_BLOCKER;
      const pillarTiles = new Set(
        COLOSSEUM_PILLAR_SOUTH_WEST_TILES.flatMap(([sx, sy]) =>
          [0, 1, 2].flatMap((dx) => [0, 1, 2].map((dy) => `${sx + dx},${sy + dy}`)),
        ),
      );
      const blocked = new Set<string>();
      // Inside the arena's edge decorations (x 17-18 and 47, y 20).
      for (let x = 19; x <= 46; x++) {
        for (let y = 21; y <= 48; y++) {
          if (arena.collisionMap.hasFlag(x, y, blocking)) blocked.add(`${x},${y}`);
        }
      }
      expect(blocked).toEqual(pillarTiles);
    },
    REAL_CACHE_TEST_TIMEOUT_MS,
  );
});
