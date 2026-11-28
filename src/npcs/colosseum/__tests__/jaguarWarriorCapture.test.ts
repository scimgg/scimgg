import { afterEach, describe, expect, it } from 'vitest';
import type { ArenaConfig } from '../../../core/arena/ArenaConfig';
import { loadColosseumWaveArena } from '../../../test/helpers/colosseumCollision';
import { enqueueEnginePendingHit } from '../../../test/helpers/pendingHits';
import {
  findProjectCacheZip,
  REAL_CACHE_TEST_TIMEOUT_MS,
  skipWithoutRealCache,
} from '../../../test/helpers/real-cache';
import { type Coordinate, PrayerType } from '../../../types/simulation';
import { createJaguarWarrior, JAGUAR_WARRIOR_REMOVAL_DELAY_TICKS } from '../jaguarWarrior';
import {
  JAGUAR_WARRIOR_CAPTURE,
  JAGUAR_WARRIOR_KILL_TICK_SWING,
  type JaguarCaptureEpisode,
} from './fixtures/jaguarWarriorCapture';
import {
  attackStarts,
  clearArena,
  playerHits,
  standInOccupant,
  startWaveNpcEngine,
  visuals,
} from './jaguarShamanTestEngine';

afterEach(clearArena);

interface ObservedTick {
  readonly tick: number;
  readonly jaguar: Coordinate;
  readonly attack: boolean;
  /** Its splats on the player this tick. */
  readonly splats: number;
}

/**
 * Replays one episode through the production definition: the capture's start-of-tick player tiles and
 * Protect from Melee, its blockers standing still. The capture's first tick is engine tick 1.
 */
function replay(episode: JaguarCaptureEpisode, arena?: ArenaConfig) {
  const base = episode.ticks[0]!.tick - 1;
  const jaguar = createJaguarWarrior({ id: 'jaguar', position: episode.start, spawnTick: episode.spawnTick - base });
  const blockers = episode.blockers.map((blocker, index) =>
    standInOccupant(`blocker-${index}`, blocker.npcId, blocker.position, blocker.size),
  );
  const { engine, step } = startWaveNpcEngine([...blockers, jaguar], {
    playerStart: episode.ticks[0]!.playerStart,
    ...(arena && { arena }),
  });
  const observed: ObservedTick[] = [];
  let praying = false;
  for (const frame of episode.ticks) {
    if (frame.protectMelee !== praying) {
      engine.queueProtectionPrayer(frame.protectMelee ? PrayerType.ProtectMelee : null);
      praying = frame.protectMelee;
    }
    const events = step(frame.playerStart);
    const swung = visuals(events).some((visual) =>
      visual.animations.some((animation) => animation.actorId === jaguar.id && animation.clipId === 'attack'),
    );
    expect(attackStarts(events, jaguar.id)).toHaveLength(swung ? 1 : 0);
    observed.push({ tick: frame.tick, jaguar: [...jaguar.position], attack: swung, splats: playerHits(events).length });
  }
  return observed;
}

/** What the capture shows, with the three claw splats on each attack tick. */
function expected(episode: JaguarCaptureEpisode): ObservedTick[] {
  return episode.ticks.map(({ tick, jaguar, attack, playerSplats }) => {
    // Any captured splat beyond the claws' three is another source's (C:1732's fourth).
    if (attack) expect(playerSplats.length).toBeGreaterThanOrEqual(3);
    return { tick, jaguar, attack, splats: attack ? 3 : 0 };
  });
}

describe('jaguar warrior capture replay', () => {
  it.each(Object.entries(JAGUAR_WARRIOR_CAPTURE))('%s', (_name, episode) => {
    expect(replay(episode)).toEqual(expected(episode));
  });

  it('swings on its killing tick without a splat and dies the next tick (A:1443)', () => {
    const witness = JAGUAR_WARRIOR_KILL_TICK_SWING;
    const base = witness.killTick - 1;
    const jaguar = createJaguarWarrior({ id: 'jaguar', position: witness.jaguar, spawnTick: -100 });
    jaguar.combat.nextActionTick = witness.previousAttackTick + 5 - base;
    const { engine, step } = startWaveNpcEngine([jaguar], { playerStart: witness.playerStart });
    engine.queueProtectionPrayer(PrayerType.ProtectMelee);
    enqueueEnginePendingHit(engine, {
      sourceId: 'player',
      targetId: jaguar.id,
      style: 'range',
      attackKind: 'range_arrow',
      launchTick: 0,
      impactTick: witness.killTick - base,
      rolledDamage: jaguar.vitals.hp,
      accuracySucceeded: true,
    });

    const swings: number[] = [];
    const splats: number[] = [];
    for (let tick = witness.killTick; tick <= witness.removedTick; tick++) {
      const events = step(witness.playerStart);
      if (attackStarts(events, jaguar.id).length > 0) swings.push(tick);
      splats.push(...playerHits(events).map(() => tick));
    }

    expect(swings).toEqual([witness.killTick]);
    expect(splats).toEqual([]);
    expect(jaguar.deathAnimationTick).toBe(witness.deathSequenceTick - base);
    // The wave owner removes it this long after its death sequence.
    expect(witness.removedTick - witness.deathSequenceTick).toBe(JAGUAR_WARRIOR_REMOVAL_DELAY_TICKS);
  });

  it.skipIf(skipWithoutRealCache())(
    'replays every episode the same over the cached wave arena',
    async () => {
      const cachePath = findProjectCacheZip();
      if (!cachePath) throw new Error('Expected a real cache zip');
      const arena = await loadColosseumWaveArena(cachePath);
      for (const episode of Object.values(JAGUAR_WARRIOR_CAPTURE)) {
        expect(replay(episode, arena)).toEqual(expected(episode));
      }
    },
    REAL_CACHE_TEST_TIMEOUT_MS,
  );
});
