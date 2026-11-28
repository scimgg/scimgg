import { afterEach, describe, expect, it } from 'vitest';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import { type Coordinate, PrayerType } from '../../../types/simulation';
import { COLOSSUS_FIRST_ATTACK_TICKS } from '../colossusReach';
import type { ColosseumRelentlessRank } from '../constants';
import {
  createShockwaveColossus,
  SHOCKWAVE_COLOSSUS_SPOTANIMS,
  shockwaveColossusDefinition,
} from '../shockwaveColossus';
import { colossusEngine, colossusWorld, definitionContext, resetArena, runEngineTo } from './colossusReachHarness';

afterEach(resetArena);

const registration = shockwaveColossusDefinition.register(undefined);
const SPAWN_TICK = 100;
const FIRST = SPAWN_TICK + COLOSSUS_FIRST_ATTACK_TICKS;
const PLAYER_TILE: Coordinate = [22, 38];

function cast(colossusTile: Coordinate, relentless?: ColosseumRelentlessRank, random?: () => number) {
  const { world } = colossusWorld(PLAYER_TILE);
  const shockwave = createShockwaveColossus({
    id: 'shockwave',
    position: colossusTile,
    spawnTick: SPAWN_TICK,
    relentless,
  });
  world.actors.set(shockwave.id, shockwave);
  const context = definitionContext(world, FIRST, random);
  const { npcAttacks } = registration.tick(shockwave, context);
  const [visual] = context.tickEvents.flush().filter(isEncounterVisualEvent);
  return { attack: npcAttacks?.[0], visual, shockwave };
}

describe('Shockwave Colossus cast', () => {
  // d is from the colossus's center (SW + 1) to the player's tile; end = 76 + 8d, hit at floor(end / 30).
  it.each([
    { d: 5, end: 116, hit: 3 },
    { d: 6, end: 124, hit: 4 },
    { d: 9, end: 148, hit: 4 },
    { d: 10, end: 156, hit: 5 },
    { d: 13, end: 180, hit: 6 },
    { d: 16, end: 204, hit: 6 },
  ])('flies 76 + 8d cycles and hits at floor(end / 30): d $d → +$hit', ({ d, end, hit }) => {
    const { attack, visual } = cast([PLAYER_TILE[0] + d - 1, PLAYER_TILE[1] - 1]);
    expect(attack).toMatchObject({ style: 'magic', impactDelayTicks: hit, sourceDeathPolicy: 'persist' });
    expect(visual?.projectiles[0]).toMatchObject({
      spotAnimId: SHOCKWAVE_COLOSSUS_SPOTANIMS.projectile,
      startDelayCycles: 50,
      endDelayCycles: end,
      slope: 0,
      startOffset: 40,
      startHeight: 158,
      endHeight: 100,
      target: { kind: 'actor', actorId: 'player', position: PLAYER_TILE },
    });
    // No ground cue: the only graphic is the impact on the player as the projectile arrives.
    expect(visual?.graphics).toEqual([
      {
        spotAnimId: SHOCKWAVE_COLOSSUS_SPOTANIMS.impact,
        target: { kind: 'attached', actorId: 'player' },
        delayCycles: end,
        height: 64,
      },
    ]);
    expect(visual?.animations).toEqual([{ actorId: 'shockwave', clipId: 'attack', delayCycles: 0 }]);
  });

  it.each([
    { rank: 0, maxHit: 56 },
    { rank: 2, maxHit: 59 },
  ] as const)('rolls up to $maxHit at Relentless $rank (Wiki 56)', ({ rank, maxHit }) => {
    expect(cast([26, 37], rank, () => 0.999999).attack?.rolledDamage).toBe(maxHit);
  });
});

describe('Shockwave Colossus through the engine', () => {
  it.each([
    { atLaunch: PrayerType.ProtectMagic, atLanding: null, damage: 0 },
    { atLaunch: null, atLanding: PrayerType.ProtectMagic, damage: 62 },
  ])('decides Protect from Magic at launch ($atLaunch → $atLanding)', ({ atLaunch, atLanding, damage }) => {
    // Its add+1 step takes it to (27, 38): d 6 from its center, so the hit lands launch+4.
    const shockwave = createShockwaveColossus({ id: 'shockwave', position: [28, 38], spawnTick: 0, relentless: 3 });
    const engine = colossusEngine(shockwave, PLAYER_TILE, () => 0.999999);
    runEngineTo(engine, COLOSSUS_FIRST_ATTACK_TICKS - 1, PLAYER_TILE);
    engine.queueProtectionPrayer(atLaunch);
    runEngineTo(engine, COLOSSUS_FIRST_ATTACK_TICKS + 1, PLAYER_TILE);
    engine.queueProtectionPrayer(atLanding);
    runEngineTo(engine, COLOSSUS_FIRST_ATTACK_TICKS + 4, PLAYER_TILE);
    expect(
      engine
        .getDamageHistory()
        .filter((entry) => entry.targetId === 'player')
        .map((entry) => [entry.tick, entry.effectiveDamage]),
    ).toEqual([[COLOSSUS_FIRST_ATTACK_TICKS + 4, damage]]);
  });
});
