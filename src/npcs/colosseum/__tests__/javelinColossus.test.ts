import { afterEach, describe, expect, it } from 'vitest';
import { type EncounterVisualEvent, isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import { recordNpcLethalTransition, startNpcDeath } from '../../../core/npcDeath';
import { type Coordinate, PrayerType } from '../../../types/simulation';
import { COLOSSUS_FIRST_ATTACK_TICKS } from '../colossusReach';
import type { ColosseumRelentlessRank } from '../constants';
import {
  ARTILLERY_MAX_HIT,
  createJavelinColossus,
  JAVELIN_ARTILLERY_SOURCE,
  JAVELIN_COLOSSUS_SPOTANIMS,
  JAVELIN_PROJECTILE,
  javelinColossusDefinition,
  landJavelinArtillery,
} from '../javelinColossus';
import { colossusEngine, colossusWorld, definitionContext, resetArena, runEngineTo } from './colossusReachHarness';

afterEach(resetArena);

const registration = javelinColossusDefinition.register(undefined);
const SPAWN_TICK = 100;
const FIRST = SPAWN_TICK + COLOSSUS_FIRST_ATTACK_TICKS;
/** Clear of the pillar: the colossus sees (22, 38) from (28, 41). */
const COLOSSUS_TILE: Coordinate = [28, 41];
const PLAYER_TILE: Coordinate = [22, 38];
/** Line of sight blocked by the pillar (24..26, 41..43). */
const HIDDEN_TILE: Coordinate = [22, 42];

function setup(relentless?: ColosseumRelentlessRank) {
  const { world, player } = colossusWorld(PLAYER_TILE);
  const javelin = createJavelinColossus({ id: 'javelin', position: COLOSSUS_TILE, spawnTick: SPAWN_TICK, relentless });
  world.actors.set(javelin.id, javelin);
  const turn = (tick: number, random?: () => number) => {
    const context = definitionContext(world, tick, random);
    const result = registration.tick(javelin, context);
    return { result, visuals: context.tickEvents.flush().filter(isEncounterVisualEvent) };
  };
  const land = (tick: number, random?: () => number) => {
    const context = definitionContext(world, tick, random);
    const damages = landJavelinArtillery(javelin, context);
    return { damages, visuals: context.tickEvents.flush().filter(isEncounterVisualEvent) };
  };
  return { world, player, javelin, turn, land };
}

const clipsOf = (visuals: readonly EncounterVisualEvent[]) =>
  visuals.flatMap((visual) => visual.animations.map((cue) => cue.clipId));
const groundOf = (visuals: readonly EncounterVisualEvent[]) =>
  visuals.flatMap((visual) => visual.graphics.flatMap((cue) => (cue.target.kind === 'tile' ? [cue] : [])));

/** Five launches in reach take 20 ticks; the slack only bounds a regression. */
const ARTILLERY_DEADLINE = FIRST + 30;

/** Runs turns from `FIRST` to the fifth (artillery) launch and returns its tick. */
function castArtillery(turn: ReturnType<typeof setup>['turn']): number {
  let launches = 0;
  for (let tick = FIRST; tick <= ARTILLERY_DEADLINE; tick++) {
    const { visuals } = turn(tick);
    const clips = clipsOf(visuals);
    if (clips.includes('attack') || clips.includes('artillery')) launches++;
    if (launches === 5) {
      expect(clips).toEqual(['artillery']);
      return tick;
    }
  }
  throw new Error(`Only ${launches} of 5 launches by tick ${ARTILLERY_DEADLINE}`);
}

describe('Javelin Colossus attack cycle', () => {
  it('throws four javelins, then the artillery, keeping the count across a line-of-sight gap (A:842 → A:1029)', () => {
    const { player, turn } = setup();
    const kinds: string[] = [];
    let tick = FIRST;
    const step = () => {
      const { visuals } = turn(tick++);
      kinds.push(...clipsOf(visuals));
    };
    for (let i = 0; i < 6; i++) step(); // R at FIRST, R at FIRST+5
    player.position = [...HIDDEN_TILE];
    for (let i = 0; i < 40; i++) step();
    player.position = [...PLAYER_TILE];
    // Back in reach it is ready at once, then the five remaining launches are 5 ticks apart (21 turns).
    for (let i = 0; i < 30 && kinds.length < 7; i++) step();
    expect(kinds).toEqual(['attack', 'attack', 'attack', 'attack', 'artillery', 'attack', 'attack']);
  });

  it('throws a ranged javelin that hits launch+3 at any distance, with the captured projectile fields', () => {
    const { javelin, turn } = setup();
    const { result, visuals } = turn(FIRST);
    expect(result.npcAttacks).toEqual([
      expect.objectContaining({ style: 'range', impactDelayTicks: 3, sourceDeathPolicy: 'persist' }),
    ]);
    expect(visuals[0]?.projectiles).toEqual([
      {
        ...JAVELIN_PROJECTILE,
        sourcePosition: [javelin.position[0] + 1.5, javelin.position[1] + 1.5],
        target: { kind: 'actor', actorId: 'player', size: 1, position: PLAYER_TILE },
      },
    ]);
  });

  it.each([
    { rank: 0, maxHit: 48 },
    { rank: 3, maxHit: 54 },
  ] as const)('rolls up to $maxHit at Relentless $rank (Wiki 48; 49/51/54)', ({ rank, maxHit }) => {
    const { turn } = setup(rank);
    expect(turn(FIRST, () => 0.999999).result.npcAttacks?.[0]?.rolledDamage).toBe(maxHit);
  });
});

describe('Javelin Colossus artillery', () => {
  it('aims at the player’s tile at the start of T+2, warns from T+3 and blasts the one tile at T+6 (A:1811)', () => {
    const TARGET = { kind: 'tile', position: [21, 38] };
    const { javelin, player, turn, land } = setup();
    const cast = castArtillery(turn);
    expect(groundOf(turn(cast + 1).visuals)).toEqual([]);
    player.position = [21, 38];
    // The capture's T+3 map_anims with delay 30, emitted 60 cycles out from T+2.
    expect(groundOf(turn(cast + 2).visuals)).toEqual([
      { spotAnimId: JAVELIN_COLOSSUS_SPOTANIMS.artilleryShadow, target: TARGET, delayCycles: 60, height: 0 },
      { spotAnimId: JAVELIN_COLOSSUS_SPOTANIMS.artillerySlow, target: TARGET, delayCycles: 60, height: 0 },
    ]);
    player.position = [20, 38];
    for (let tick = cast + 3; tick < cast + 6; tick++) {
      turn(tick);
      expect(land(tick).visuals).toEqual([]);
    }
    const landing = land(cast + 6);
    expect(groundOf(landing.visuals)).toEqual([
      { spotAnimId: JAVELIN_COLOSSUS_SPOTANIMS.artilleryBlast, target: TARGET, delayCycles: 0, height: 0 },
    ]);
    // The player stepped off the tile before T+6: no hit.
    expect(landing.damages).toEqual([]);
    expect(javelin.state.artillery).toBeNull();
  });

  it('hits the player standing on the tile at the start of T+6 for up to 40 typeless', () => {
    const { turn, land } = setup();
    const cast = castArtillery(turn);
    for (let tick = cast + 1; tick < cast + 6; tick++) turn(tick);
    expect(land(cast + 6, () => 0.999999).damages).toEqual([
      {
        baseDamage: ARTILLERY_MAX_HIT,
        attackType: 'typeless',
        source: JAVELIN_ARTILLERY_SOURCE,
        playerPosition: PLAYER_TILE,
      },
    ]);
  });

  it.each([
    { processedAt: 2, warned: false, blast: false, witness: 'B:2559, killed T+1 and processed T+2' },
    { processedAt: 3, warned: true, blast: false, witness: 'A:915, killed and processed T+3' },
    { processedAt: 5, warned: true, blast: true, witness: 'A:2124 and C:3359, killed and processed T+5' },
  ])('cancels the landing only when its death comes before its T+3 turn ($witness)', ({
    processedAt,
    warned,
    blast,
  }) => {
    const { world, javelin, turn, land } = setup();
    const cast = castArtillery(turn);
    let warnings = 0;
    let blasts = 0;
    for (let tick = cast + 1; tick <= cast + 6; tick++) {
      // The wave owner's hazards run first; the death is processed in the colossus's turn, before its action.
      blasts += groundOf(land(tick).visuals).length;
      if (tick === cast + processedAt) {
        recordNpcLethalTransition(javelin, tick, 'scripted');
        startNpcDeath(javelin);
        registration.notifyDeathStarted(javelin, definitionContext(world, tick));
      }
      if (javelin.death === undefined) warnings += groundOf(turn(tick).visuals).length;
    }
    expect(warnings > 0).toBe(warned);
    expect(blasts > 0).toBe(blast);
  });
});

describe('Javelin Colossus through the engine', () => {
  // A:2651 → 2654: off at launch, on at landing, 35 damage; A:1014 → 1017: the reverse, 0.
  it.each([
    { atLaunch: PrayerType.ProtectRange, atLanding: null, damage: 0 },
    { atLaunch: null, atLanding: PrayerType.ProtectRange, damage: 54 },
  ])('decides Protect from Missiles at launch ($atLaunch → $atLanding)', ({ atLaunch, atLanding, damage }) => {
    const javelin = createJavelinColossus({ id: 'javelin', position: COLOSSUS_TILE, spawnTick: 0, relentless: 3 });
    const engine = colossusEngine(javelin, PLAYER_TILE, () => 0.999999);
    runEngineTo(engine, COLOSSUS_FIRST_ATTACK_TICKS - 1, PLAYER_TILE);
    engine.queueProtectionPrayer(atLaunch);
    runEngineTo(engine, COLOSSUS_FIRST_ATTACK_TICKS + 1, PLAYER_TILE);
    engine.queueProtectionPrayer(atLanding);
    runEngineTo(engine, COLOSSUS_FIRST_ATTACK_TICKS + 3, PLAYER_TILE);
    expect(
      engine
        .getDamageHistory()
        .filter((entry) => entry.targetId === 'player')
        .map((entry) => [entry.tick, entry.effectiveDamage]),
    ).toEqual([[COLOSSUS_FIRST_ATTACK_TICKS + 3, damage]]);
  });

  it('lands its artillery through the wave owner’s hazards, ignoring Protect from Missiles', () => {
    const javelin = createJavelinColossus({ id: 'javelin', position: COLOSSUS_TILE, spawnTick: 0 });
    const engine = colossusEngine(javelin, PLAYER_TILE, () => 0.999999);
    engine.queueProtectionPrayer(PrayerType.ProtectRange);
    const cast = COLOSSUS_FIRST_ATTACK_TICKS + 4 * 5;
    runEngineTo(engine, cast + 6, PLAYER_TILE);
    expect(
      engine
        .getDamageHistory()
        .filter((entry) => entry.source === JAVELIN_ARTILLERY_SOURCE)
        .map(({ tick, attackType, effectiveDamage }) => ({ tick, attackType, effectiveDamage })),
    ).toEqual([{ tick: cast + 6, attackType: 'typeless', effectiveDamage: ARTILLERY_MAX_HIT }]);
  });
});
