import { describe, expect, it } from 'vitest';
import type { EncounterContext } from '../../../core/encounters/types';
import { TickEvents } from '../../../core/events/TickEvents';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { WorldState } from '../../../core/WorldState';
import {
  clearSolAttacks,
  cooldownAfter,
  createSolAttackState,
  grappleUnlocked,
  launchSolAttack,
  type SolAttackPhase,
  type SolAttackState,
  takeSolGroundLanding,
  takeSolTripleHit,
  tripleIsLong,
  tripleUnlocked,
} from '../../../npcs/colosseum/attackScheduler';
import {
  BEAM_LINE_LENGTH,
  GRAPPLE_FAIL_MAX_HIT,
  GRAPPLE_WINDOW_TICKS,
  SOL_ACTOR_ID,
  SPECIAL_REFRACTORY_REGULARS,
  TRIPLE_DAMAGE_LONG,
  TRIPLE_DAMAGE_SHORT,
  TRIPLE_HIT_OFFSETS_LONG,
  TRIPLE_HIT_OFFSETS_SHORT,
} from '../../../npcs/colosseum/constants';
import {
  BEAM_CRYSTAL_EDGES,
  beamLineTiles,
  createCrystal,
  crystalDefinition,
  crystalTile,
} from '../../../npcs/colosseum/crystal';
import {
  acceptsSolParry,
  registerSolParry,
  resolveSolGrapple,
  type SolGrappleState,
  startSolGrapple,
} from '../../../npcs/colosseum/grapple';
import { solDefinition } from '../../../npcs/colosseum/sol';
import { INITIAL_SOL_VARIANT_MEMORY, selectSolVariant } from '../../../npcs/colosseum/solAttacks';
import { createEncounterActorOps } from '../../../test/helpers/encounterActorOps';
import { runEncounterNpcActions } from '../../../test/helpers/encounterNpcBand';
import { createUnusedPlayerControlOps } from '../../../test/helpers/playerControlStubs';
import type { Coordinate } from '../../../types/simulation';
import { SolBeamRounds } from '../beams';
import {
  BEAM_PREPARATION_LEAD_TICKS,
  SAND_DAMAGE_ONSET_TICKS,
  SAND_MAX_DAMAGE,
  SAND_MIN_DAMAGE,
  SAND_PLACEMENT_RADIUS,
  SAND_POOL_DELAY_TICKS,
  SOL_ARENA,
  SOL_BEAM_PREPARED_EVENT,
} from '../constants';
import { MoltenSand } from '../moltenSand';
import { isEnraged, phaseForHp } from '../phases';
import { SolHereditEncounter } from '../SolHereditEncounter';

const MAX_HP = 1500;
/** Beam damage inputs for cases where no hit lands, so nothing is rolled. */
const NO_ROLL = { random: () => 0, relentless: 0 } as const;

/** Feeds `launch` an exact sequence of rolls so a specific branch is taken. */
function rolls(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

/** Sol at his spawn tile aiming at the player's start tile, south of him. */
const AIM = { position: [31, 36], target: [33, 31], arena: SOL_ARENA } as const;

/** Production launch with the chosen rolls. */
function launch(state: SolAttackState, tick: number, phase: SolAttackPhase, random: () => number) {
  return launchSolAttack(state, {
    tick,
    phase,
    random,
    grappleAvailable: false,
  });
}

describe('phase thresholds', () => {
  it('counts a phase for each Wiki threshold Sol has dropped past', () => {
    expect(phaseForHp(MAX_HP, MAX_HP)).toBe(0);
    expect(phaseForHp(1351, MAX_HP)).toBe(0);
    expect(phaseForHp(1350, MAX_HP)).toBe(1); // 90%
    expect(phaseForHp(1125, MAX_HP)).toBe(2); // 75%
    expect(phaseForHp(750, MAX_HP)).toBe(3); // 50%
    expect(phaseForHp(375, MAX_HP)).toBe(4); // 25%
    expect(phaseForHp(150, MAX_HP)).toBe(5); // 10%
    expect(phaseForHp(0, MAX_HP)).toBe(5);
  });

  it('unlocks the triple at 90%, the grapple at 75%, the long triple at 50% and enrage at 10%', () => {
    const unlocked = ([0, 1, 2, 3, 4, 5] as const).map((phase) => ({
      triple: tripleUnlocked(phase),
      grapple: grappleUnlocked(phase),
      long: tripleIsLong(phase),
      enraged: isEnraged(phase),
    }));
    expect(unlocked.map((u) => u.triple)).toEqual([false, true, true, true, true, true]);
    expect(unlocked.map((u) => u.grapple)).toEqual([false, false, true, true, true, true]);
    expect(unlocked.map((u) => u.long)).toEqual([false, false, false, true, true, true]);
    expect(unlocked.map((u) => u.enraged)).toEqual([false, false, false, false, false, true]);
  });
});

describe('attack cadence', () => {
  it.each([
    { phase: 0, values: [0.99] },
    { phase: 2, values: [0] },
    { phase: 2, values: [0.5, 0] },
  ] as const)('forces a spear opener instead of random selection in phase $phase ($values)', ({ phase, values }) => {
    const state = createSolAttackState(0);
    // An opener after an earlier special: the forced spear still counts towards the spacing.
    state.regularsSinceSpecial = 9;
    const before = state.regularsSinceSpecial;
    expect(launchSolAttack(state, { tick: 0, phase, random: rolls(...values), grappleAvailable: true })).toMatchObject({
      kind: 'regular',
      style: 'spear',
      variant: 1,
    });
    expect(state.forceSpearNext).toBe(false);
    expect(state.regularsSinceSpecial).toBe(before + 1);
    expect(state.pendingTriple).toEqual([]);
  });

  it('drops spear 7->6 and shield 6->5 at the 75% transition', () => {
    expect(cooldownAfter('spear', 0)).toBe(7);
    expect(cooldownAfter('shield', 0)).toBe(6);
    expect(cooldownAfter('spear', 1)).toBe(7);
    expect(cooldownAfter('shield', 1)).toBe(6);
    expect(cooldownAfter('spear', 2)).toBe(6);
    expect(cooldownAfter('shield', 2)).toBe(5);
    expect(cooldownAfter('spear', 5)).toBe(6);
    expect(cooldownAfter('shield', 5)).toBe(5);
  });

  it('schedules the next regular attack one cooldown after the telegraph', () => {
    const state = createSolAttackState(0);
    expect(launch(state, 10, 0, rolls(0.1)).kind).toBe('regular');
    expect(state.nextAttackTick).toBe(10 + cooldownAfter('spear', 0));
  });

  it('lands a regular attack exactly three ticks after its telegraph', () => {
    const state = createSolAttackState(0);
    const regular = launch(state, 10, 0, rolls(0.1));
    if (regular.kind !== 'regular') throw new Error('expected a regular attack');
    expect(regular.groundTick).toBe(13);
    expect(takeSolGroundLanding(state, 12, AIM)).toBeNull();
    const landing = takeSolGroundLanding(state, 13, AIM);
    expect(landing?.tiles.length).toBeGreaterThan(0);
    // A landing is consumed once, so it cannot damage the player twice.
    expect(takeSolGroundLanding(state, 13, AIM)).toBeNull();
  });
});

describe('variant alternation', () => {
  it('alternates within a run of one style and resets when the style changes', () => {
    let memory = INITIAL_SOL_VARIANT_MEMORY;
    const observed: number[] = [];
    const sequence = ['spear', 'spear', 'spear', 'shield', 'shield', 'spear'] as const;
    for (const style of sequence) {
      const variant = selectSolVariant(memory, style);
      observed.push(variant);
      memory = { lastAction: style, lastVariant: variant };
    }
    expect(observed).toEqual([1, 2, 1, 1, 2, 1]);
  });

  it('treats a special as a style change, so the next regular restarts at variant 1', () => {
    const state = createSolAttackState(0);
    // Spear, spear -> variant 1 then 2.
    const first = launch(state, 0, 0, rolls(0.1));
    takeSolGroundLanding(state, 3, AIM);
    const second = launch(state, 10, 0, rolls(0.1));
    takeSolGroundLanding(state, 13, AIM);
    expect(first.kind === 'regular' && first.variant).toBe(1);
    expect(second.kind === 'regular' && second.variant).toBe(2);
    // A triple takes the next slot, then the following spear is back to variant 1.
    expect(launch(state, 20, 3, rolls(0.01)).kind).toBe('triple');
    clearSolAttacks(state);
    const third = launch(state, 40, 3, rolls(0.5, 0.5, 0.1));
    expect(third.kind === 'regular' && third.variant).toBe(1);
  });
});

describe('triple attack', () => {
  it('uses the short offsets and damage above 50% HP', () => {
    const state = createSolAttackState(0);
    state.forceSpearNext = false; // Exercise a non-opener attack.
    const triple = launch(state, 100, 2, rolls(0.01));
    if (triple.kind !== 'triple') throw new Error('expected a triple');
    expect(triple.long).toBe(false);
    expect(triple.hitTicks).toEqual(TRIPLE_HIT_OFFSETS_SHORT.map((offset) => 100 + offset));
    expect(TRIPLE_HIT_OFFSETS_SHORT.map((offset) => takeSolTripleHit(state, 100 + offset)?.damage)).toEqual([
      ...TRIPLE_DAMAGE_SHORT,
    ]);
  });

  it('slips the third hit a tick and hits harder at and below 50% HP', () => {
    const state = createSolAttackState(0);
    state.forceSpearNext = false;
    const triple = launch(state, 100, 3, rolls(0.01));
    if (triple.kind !== 'triple') throw new Error('expected a triple');
    expect(triple.long).toBe(true);
    expect(triple.hitTicks).toEqual(TRIPLE_HIT_OFFSETS_LONG.map((offset) => 100 + offset));
    expect(TRIPLE_HIT_OFFSETS_LONG.map((offset) => takeSolTripleHit(state, 100 + offset)?.damage)).toEqual([
      ...TRIPLE_DAMAGE_LONG,
    ]);
    // The long third hit is a tick later and harder than the short one.
    expect(TRIPLE_HIT_OFFSETS_LONG[2]).toBe(TRIPLE_HIT_OFFSETS_SHORT[2] + 1);
    expect(TRIPLE_DAMAGE_LONG[2]).toBeGreaterThan(TRIPLE_DAMAGE_SHORT[2]);
  });

  it('never fires a triple before the 90% transition', () => {
    const state = createSolAttackState(0);
    state.forceSpearNext = false;
    expect(launch(state, 10, 0, rolls(0)).kind).toBe('regular');
  });
});

describe('attack style practice pin', () => {
  /** Counts the rolls a launch draws, so a pin can be shown not to shift the seeded stream. */
  function launchPinned(
    stylePin: 'spear' | 'shield' | undefined,
    roll: number,
    { forceSpear = false, regularsSinceSpecial = 0 }: { forceSpear?: boolean; regularsSinceSpecial?: number } = {},
  ) {
    const state = createSolAttackState(0);
    state.forceSpearNext = forceSpear;
    state.regularsSinceSpecial = regularsSinceSpecial;
    let draws = 0;
    const launch = launchSolAttack(state, {
      tick: 10,
      phase: 2,
      random: () => {
        draws++;
        return roll;
      },
      grappleAvailable: true,
      stylePin,
    });
    return { launch, draws };
  }

  it.each([
    { pin: undefined, roll: 0.1, style: 'spear' },
    { pin: undefined, roll: 0.9, style: 'shield' },
    { pin: 'spear', roll: 0.9, style: 'spear' },
    { pin: 'shield', roll: 0.1, style: 'shield' },
  ] as const)('pin $pin with style roll $roll launches a $style', ({ pin, roll, style }) => {
    const { launch, draws } = launchPinned(pin, roll);
    expect(launch).toMatchObject({ kind: 'regular', style });
    // The style roll is drawn, pinned or not; no special is possible straight after one.
    expect(draws).toBe(launchPinned(undefined, roll).draws);
    expect(draws).toBe(1);
  });

  it('draws the special roll too whenever a special is possible, pinned or not', () => {
    const pinned = launchPinned('spear', 0.9, { regularsSinceSpecial: 9 });
    expect(pinned.launch).toMatchObject({ kind: 'regular', style: 'spear' });
    expect(pinned.draws).toBe(launchPinned(undefined, 0.9, { regularsSinceSpecial: 9 }).draws);
    expect(pinned.draws).toBe(2);
  });

  it('pins the forced opener too, so a shield pin never launches a spear', () => {
    expect(launchPinned('shield', 0.1, { forceSpear: true }).launch).toMatchObject({
      kind: 'regular',
      style: 'shield',
    });
    expect(launchPinned(undefined, 0.9, { forceSpear: true }).launch).toMatchObject({
      kind: 'regular',
      style: 'spear',
    });
  });

  it('leaves the special rolls in charge of whether a regular attack happens at all', () => {
    expect(launchPinned('shield', 0, { regularsSinceSpecial: 9 }).launch.kind).toBe('grapple');
  });
});

describe('forced practice specials', () => {
  it.each([
    'triple',
    'grapple',
  ] as const)('launch a queued %s at any HP with the shared special bookkeeping, after any forced spear', (kind) => {
    const state = createSolAttackState(0);
    state.forcedSpecial = kind;
    const input = { phase: 0, random: rolls(0.9), grappleAvailable: true } as const;
    expect(launchSolAttack(state, { ...input, tick: 0 })).toMatchObject({ kind: 'regular', style: 'spear' });
    expect(state.forcedSpecial).toBe(kind);
    clearSolAttacks(state);
    expect(launchSolAttack(state, { ...input, tick: 10 }).kind).toBe(kind);
    expect(state).toMatchObject({
      forcedSpecial: null,
      regularsSinceSpecial: 0,
      memory: { lastAction: 'special' },
      nextAttackTick: 10 + (kind === 'triple' ? 12 : 7),
    });
  });
});

describe('special attack spacing', () => {
  const launchWithGrapple = (state: SolAttackState, tick: number) =>
    launchSolAttack(state, { tick, phase: 3, random: rolls(0), grappleAvailable: true }).kind;

  it('allows the first special as soon as it is unlocked after the spear opener', () => {
    const state = createSolAttackState(0);
    expect(launchWithGrapple(state, 0)).toBe('regular');
    clearSolAttacks(state);
    expect(launchWithGrapple(state, 10)).toBe('grapple');
  });

  it(`uses ${SPECIAL_REFRACTORY_REGULARS} regular attacks between specials even when every roll picks one`, () => {
    const state = createSolAttackState(0);
    state.forceSpearNext = false;
    const kinds: string[] = [];
    for (let slot = 0; slot < 2 + 2 * SPECIAL_REFRACTORY_REGULARS; slot++) {
      kinds.push(launchSolAttack(state, { tick: slot * 20, phase: 1, random: rolls(0), grappleAvailable: true }).kind);
      clearSolAttacks(state);
    }
    const regulars = Array.from({ length: SPECIAL_REFRACTORY_REGULARS }, () => 'regular');
    expect(kinds).toEqual(['triple', ...regulars, 'triple', ...regulars]);
  });

  it('counts a grapple as a special for the spacing', () => {
    const state = createSolAttackState(0);
    state.forceSpearNext = false;
    // Special roll hits, then the type roll picks the grapple.
    expect(launchWithGrapple(state, 0)).toBe('grapple');
    expect(launchWithGrapple(state, 20)).toBe('regular');
  });
});

describe('grapple', () => {
  it('opens a four-tick window and rewards only a defense on its last tick', () => {
    const grapple: SolGrappleState = { pending: null };
    const target = startSolGrapple(grapple, 10, () => 0);
    expect(acceptsSolParry(grapple)).toBe(true);
    expect(registerSolParry(grapple, target.slot, 10 + GRAPPLE_WINDOW_TICKS)).toBe(true);
    expect(resolveSolGrapple(grapple, 10 + GRAPPLE_WINDOW_TICKS - 1, true, () => 0.5)).toBeNull();
    expect(resolveSolGrapple(grapple, 10 + GRAPPLE_WINDOW_TICKS, true, () => 0.5)?.outcome).toBe('perfect-parry');
  });

  it.each([1, 2, 3, 4])('resolves a correct defense at T+%i on its own tick', (offset) => {
    const grapple: SolGrappleState = { pending: null };
    const target = startSolGrapple(grapple, 10, () => 0);
    for (let tick = 11; tick < 10 + offset; tick++)
      expect(resolveSolGrapple(grapple, tick, true, () => 0.5)).toBeNull();
    expect(registerSolParry(grapple, target.slot, 10 + offset)).toBe(true);
    // Repeat and wrong clicks the same tick change nothing (L:4701 also logged a wrong click).
    expect(registerSolParry(grapple, 'weapon', 10 + offset)).toBe(true);
    expect(registerSolParry(grapple, target.slot, 10 + offset)).toBe(true);
    const resolution = resolveSolGrapple(grapple, 10 + offset, true, () => 0.5);
    expect(resolution?.outcome).toBe(offset === 4 ? 'perfect-parry' : 'parry');
    expect(resolution?.damages).toEqual([]);
    expect(acceptsSolParry(grapple)).toBe(false);
  });

  it.each([
    { wrongSlot: 'cape', wrongTick: 12, correctTick: 12 },
    { wrongSlot: 'ammo', wrongTick: 11, correctTick: 13 },
    { wrongSlot: 'quiver-ammo', wrongTick: 11, correctTick: 14 },
    { wrongSlot: 'weapon', wrongTick: 14, correctTick: 14 },
  ] as const)('lets a correct click at $correctTick recover a wrong $wrongSlot click at $wrongTick', (click) => {
    const grapple: SolGrappleState = { pending: null };
    const target = startSolGrapple(grapple, 10, () => 0);
    let resolution: ReturnType<typeof resolveSolGrapple> = null;
    for (let tick = 11; tick <= 14 && !resolution; tick++) {
      if (tick === click.wrongTick) expect(registerSolParry(grapple, click.wrongSlot, tick)).toBe(true);
      if (tick === click.correctTick) expect(registerSolParry(grapple, target.slot, tick)).toBe(true);
      resolution = resolveSolGrapple(grapple, tick, true, () => 0.5);
      if (tick < click.correctTick) expect(resolution).toBeNull();
    }
    expect(resolution?.outcome).toBe(click.correctTick === 14 ? 'perfect-parry' : 'parry');
    expect(resolution?.damages).toEqual([]);
  });

  it('fails a grapple defended only with wrong slots', () => {
    const grapple: SolGrappleState = { pending: null };
    startSolGrapple(grapple, 10, () => 0);
    for (let tick = 11; tick <= 13; tick++) {
      expect(registerSolParry(grapple, 'weapon', tick)).toBe(true);
      expect(resolveSolGrapple(grapple, tick, true, () => 0.5)).toBeNull();
    }
    // Two rolls: 0.1 -> 4 and 0.99 -> 44; the hit is the higher one.
    const rolls = [0.1, 0.99];
    const resolution = resolveSolGrapple(grapple, 14, true, () => rolls.shift()!);
    expect(resolution?.outcome).toBe('fail');
    expect(resolution?.damages[0]?.baseDamage).toBe(GRAPPLE_FAIL_MAX_HIT);
    expect(rolls).toEqual([]);
  });

  it('ignores clicks processed outside the window, including accepted input delayed past resolution', () => {
    const grapple: SolGrappleState = { pending: null };
    const target = startSolGrapple(grapple, 10, () => 0);
    expect(registerSolParry(grapple, target.slot, 9)).toBe(false);
    expect(registerSolParry(grapple, target.slot, 15)).toBe(false);
    expect(resolveSolGrapple(grapple, 14, true, () => 0.5)?.outcome).toBe('fail');
    expect(registerSolParry(grapple, target.slot, 15)).toBe(false);
  });

  it('stops damaging once Sol is out of HP', () => {
    const grapple: SolGrappleState = { pending: null };
    startSolGrapple(grapple, 10, () => 0);
    const resolution = resolveSolGrapple(grapple, 14, false, () => 0.5);
    expect(resolution?.outcome).toBe('fail');
    expect(resolution?.damages).toEqual([]);
  });
});

describe('molten sand', () => {
  const sandContext = (playerPos: Coordinate) => ({ playerPos });

  it('always strikes the tile underfoot and keeps every strike within the 9x9', () => {
    const sand = new MoltenSand();
    const player: Coordinate = [33, 35];
    const strike = sand.strike(player, 6, 0, rolls(0.5));
    expect(strike.tiles.some(([x, y]) => x === player[0] && y === player[1])).toBe(true);
    for (const [x, y] of strike.tiles) {
      expect(Math.abs(x - player[0])).toBeLessThanOrEqual(SAND_PLACEMENT_RADIUS);
      expect(Math.abs(y - player[1])).toBeLessThanOrEqual(SAND_PLACEMENT_RADIUS);
    }
  });

  it('activates pools after the delay and never returns a duplicate tile', () => {
    const sand = new MoltenSand();
    const player: Coordinate = [33, 35];
    sand.strike(player, 6, 0, rolls(0.5));
    sand.advance(SAND_POOL_DELAY_TICKS - 1);
    expect(sand.isCovered(player)).toBe(false);
    sand.advance(SAND_POOL_DELAY_TICKS);
    expect(sand.isCovered(player)).toBe(true);
    const pools = sand.getActivePools().map(([x, y]) => `${x},${y}`);
    expect(pools.length).toBe(new Set(pools).size);
  });

  it('yields fewer tiles as the floor fills, because covered tiles are discarded', () => {
    const sand = new MoltenSand();
    const player: Coordinate = [33, 35];
    sand.strike(player, 6, 0, rolls(0.5));
    sand.advance(SAND_POOL_DELAY_TICKS);
    const second = sand.strike(player, 6, 10, rolls(0.5));
    expect(second.tiles.some(([x, y]) => x === player[0] && y === player[1])).toBe(false);
  });

  it.each([
    SAND_DAMAGE_ONSET_TICKS,
    SAND_DAMAGE_ONSET_TICKS + 1,
  ])('yields nothing for a tile already burning at E+%i, before its pool shows', (tick) => {
    const sand = new MoltenSand();
    const player: Coordinate = [33, 35];
    sand.strike(player, 1, 0, rolls(0.5));
    sand.advance(tick);
    expect(sand.getActivePools()).toEqual([]);
    expect(sand.strike(player, 1, tick, rolls(0.5)).tiles).toEqual([]);
  });

  it('burns only a player standing in a pool, for the Wiki damage range', () => {
    const sand = new MoltenSand();
    const player: Coordinate = [33, 35];
    sand.strike(player, 1, 0, rolls(0.5));
    sand.advance(SAND_POOL_DELAY_TICKS);
    expect(sand.resolve(sandContext([20, 20]))).toEqual([]);
    expect(sand.resolve(sandContext(player))[0]?.baseDamage).toEqual([SAND_MIN_DAMAGE, SAND_MAX_DAMAGE]);
  });

  it('burns from E+3 while the pool is still forming, before its LOC shows at E+5', () => {
    const sand = new MoltenSand();
    const player: Coordinate = [33, 35];
    sand.strike(player, 1, 0, rolls(0.5));
    sand.advance(SAND_DAMAGE_ONSET_TICKS - 1);
    expect(sand.resolve(sandContext(player))).toEqual([]);
    sand.advance(SAND_DAMAGE_ONSET_TICKS);
    expect(sand.resolve(sandContext(player))).toHaveLength(1);
    expect(sand.getActivePools()).toEqual([]);
    sand.advance(SAND_POOL_DELAY_TICKS);
    expect(sand.getActivePools()).toEqual([player]);
    expect(sand.resolve(sandContext(player))).toHaveLength(1);
  });

  describe('in the engine, against the tile the player starts the tick on', () => {
    function strikeUnderfoot() {
      const engine = new SimulationEngine({ encounter: new SolHereditEncounter(7), combatRandom: () => 0.5 });
      engine.setMechanicsConfig({ solHereditAttacks: false, solHereditBeams: false });
      const start = engine.getState().playerPosition;
      const strikeTick = engine.getState().currentTick;
      engine.executeEncounterCommand({ encounter: 'sol_heredit', type: 'strike-sand' });
      const sandHits = () => engine.getDamageHistory().filter((hit) => hit.source === 'SolMoltenSand');
      return { engine, start, strikeTick, sandHits };
    }
    const offTile = ([x, y]: Coordinate): Coordinate => [x + 5, y];

    it('lets a player moved off during E+2 escape (A:5222, K:4023, M:8460)', () => {
      const { engine, start, sandHits } = strikeUnderfoot();
      engine.advanceTick(start); // E+1: the white pool appears; the click lands this tick
      engine.advanceTick(offTile(start)); // E+2: moved off
      for (let tick = 0; tick < 4; tick++) engine.advanceTick(engine.getState().playerPosition);
      expect(sandHits()).toEqual([]);
    });

    it('hits a player still on the tile at the end of E+2 on E+3, even as they step off (K:4064)', () => {
      const { engine, start, strikeTick, sandHits } = strikeUnderfoot();
      engine.advanceTick(start); // E+1
      engine.advanceTick(start); // E+2: still standing on it
      engine.advanceTick(offTile(start)); // E+3: steps off, too late
      expect(sandHits()).toEqual([expect.objectContaining({ tick: strikeTick + SAND_DAMAGE_ONSET_TICKS })]);
    });
  });

  it('keeps every pool inside the arena', () => {
    const sand = new MoltenSand();
    sand.strike([SOL_ARENA.minX, SOL_ARENA.minY], 6, 0, rolls(0.01, 0.01, 0.2, 0.2, 0.9, 0.9));
    sand.advance(SAND_POOL_DELAY_TICKS);
    for (const [x, y] of sand.getActivePools()) {
      expect(x).toBeGreaterThanOrEqual(SOL_ARENA.minX);
      expect(x).toBeLessThanOrEqual(SOL_ARENA.maxX);
      expect(y).toBeGreaterThanOrEqual(SOL_ARENA.minY);
      expect(y).toBeLessThanOrEqual(SOL_ARENA.maxY);
    }
  });
});

/** Sol's first telegraph after the crystal appears; the round warns there and charges as it lands. */
const WARNING = 5;
const FIRST_CHARGE = WARNING + BEAM_PREPARATION_LEAD_TICKS;

describe('beam crystals', () => {
  function setupBeam() {
    const beams = new SolBeamRounds();
    const crystals = [createCrystal({ id: 'crystal_0', index: 0, tick: 0, charging: false })];
    beams.enroll(0);
    const definition = crystalDefinition.register(undefined);
    const context = {
      tick: 0,
      world: new WorldState(),
      tickEvents: new TickEvents(),
      random: () => 0,
      spawnNpc: () => {},
      despawnNpc: () => {},
      logEvent: () => {},
    };
    return { beams, crystals, definition, context };
  }

  /** Warns and then charges the first round, as the encounter does. */
  function chargeFirstRound({ beams, crystals }: ReturnType<typeof setupBeam>, enraged = false) {
    beams.prepare(crystals, WARNING, enraged);
    return beams.startChargeIfDue(crystals, FIRST_CHARGE);
  }

  it('places each crystal on its own edge and fires thirteen tiles inward', () => {
    for (let index = 0; index < BEAM_CRYSTAL_EDGES.length; index++) {
      const edge = BEAM_CRYSTAL_EDGES[index];
      const along = edge.from + 2;
      const origin = crystalTile(index, along);
      const line = beamLineTiles(index, origin);
      expect(line).toHaveLength(BEAM_LINE_LENGTH);
      // The beam starts one tile in from the crystal and runs straight across the arena.
      expect(line[0]).toEqual([origin[0] + edge.step[0], origin[1] + edge.step[1]]);
      expect(line).not.toContainEqual(origin);
      const lastStep = line[line.length - 1];
      expect(lastStep[0]).toBe(origin[0] + edge.step[0] * BEAM_LINE_LENGTH);
      expect(lastStep[1]).toBe(origin[1] + edge.step[1] * BEAM_LINE_LENGTH);
    }
  });

  it('patrols along its edge and reverses at the recorded endpoints', () => {
    const { crystals, definition, context } = setupBeam();
    const crystal = crystals[0];
    const seen: number[] = [];
    for (let tick = 0; tick <= 70; tick++) {
      for (const move of definition.move(crystal, { ...context, tick })) crystal.position = move.path[0];
      seen.push(crystal.position[0]);
    }
    const edge = BEAM_CRYSTAL_EDGES[0];
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(edge.from);
    expect(Math.max(...seen)).toBeLessThanOrEqual(edge.to);
    // It actually reverses rather than sticking at the endpoint.
    expect(new Set(seen).size).toBeGreaterThan(2);
    expect(seen).toContain(edge.from);
    expect(seen).toContain(edge.to);
    expect(crystal.state.direction).toBe(-1);
  });

  it.each(
    BEAM_CRYSTAL_EDGES.flatMap((edge, index) =>
      [...new Set<number>([edge.from, edge.from + 1, edge.spawn])].map((spawnAlong) => ({
        index,
        edge: edge.edge,
        spawnAlong,
        firstStep: spawnAlong === edge.from ? 4 : 3,
      })),
    ),
  )('first steps $firstStep ticks after spawning at $spawnAlong on the $edge edge', ({
    index,
    spawnAlong,
    firstStep,
  }) => {
    // Low-end spawns L:3978->3982, A:5133->5137, N:7570->7574; every other spawn +3 (15/15).
    const { definition, context } = setupBeam();
    const crystal = createCrystal({ id: 'crystal', index, tick: 10, charging: false, spawnAlong });
    expect(crystal.position).toEqual(crystalTile(index, spawnAlong));
    const moves: number[] = [];
    for (let tick = 10; tick <= 10 + firstStep; tick++) {
      for (const move of definition.move(crystal, { ...context, tick })) {
        crystal.position = move.path[0];
        moves.push(tick);
      }
    }
    expect(moves).toEqual([10 + firstStep]);
    // The first step always heads for the low end, reversing at once when spawned on it.
    const edge = BEAM_CRYSTAL_EDGES[index];
    const along = edge.edge === 'north' || edge.edge === 'south' ? crystal.position[0] : crystal.position[1];
    expect(along).toBe(spawnAlong === edge.from ? spawnAlong + 1 : spawnAlong - 1);
  });

  it('refuses a spawn tile off its edge', () => {
    const edge = BEAM_CRYSTAL_EDGES[0];
    expect(() => createCrystal({ id: 'c', index: 0, tick: 0, charging: false, spawnAlong: edge.from - 1 })).toThrow(
      RangeError,
    );
  });

  it('charges for four ticks, or three once enraged', () => {
    expect(chargeFirstRound(setupBeam())?.fireTick).toBe(FIRST_CHARGE + 4);
    expect(chargeFirstRound(setupBeam(), true)?.fireTick).toBe(FIRST_CHARGE + 3);
  });

  it('warns on the tick Sol attacks once ready, and reports the ticks until it fires', () => {
    const { beams, crystals } = setupBeam();
    expect(beams.prepare([], WARNING, false)).toBeNull();
    expect(beams.isReady(crystals, WARNING)).toBe(true);
    expect(beams.prepare(crystals, WARNING, false)).toBe(7);
    // One round at a time: no second warning until this one has fired.
    expect(beams.isReady(crystals, WARNING + 1)).toBe(false);
    expect(beams.prepare(crystals, WARNING + 1, false)).toBeNull();

    const enraged = setupBeam();
    expect(enraged.beams.prepare(enraged.crystals, WARNING, true)).toBe(6);
  });

  it.each([
    { phase: 0, roll: 0, delay: 22 },
    { phase: 1, roll: 0.999, delay: 29 },
    { phase: 3, roll: 0.5, delay: 26 },
    { phase: 4, roll: 0, delay: 22 },
    { phase: 4, roll: 0.999, delay: 29 },
    { phase: 5, roll: 0.999, delay: 5 },
  ] as const)('is ready again $delay ticks after a phase-$phase fire (roll $roll)', ({ phase, roll, delay }) => {
    const setup = setupBeam();
    const round = chargeFirstRound(setup);
    if (!round) throw new Error('expected a charged round');
    // One 22-29 range in phases 0-4 (L refutes per-phase ranges), 5 once enraged.
    let draws = 0;
    setup.beams.fireIfDue(setup.crystals, {
      tick: round.fireTick,
      playerPos: [0, 0],
      phase,
      random: () => {
        draws++;
        return roll;
      },
    });
    expect(draws).toBe(1);
    expect(setup.beams.isReady(setup.crystals, round.fireTick + delay - 1)).toBe(false);
    expect(setup.beams.isReady(setup.crystals, round.fireTick + delay)).toBe(true);
  });

  describe('on entering enrage', () => {
    /** Fires the first round in phase 4 with the longest roll, leaving the clock idle until fire+29. */
    function idleAfterPhase4Fire() {
      const setup = setupBeam();
      const round = chargeFirstRound(setup);
      if (!round) throw new Error('expected a charged round');
      setup.beams.fireIfDue(setup.crystals, { tick: round.fireTick, playerPos: [0, 0], phase: 4, random: () => 0.999 });
      return { ...setup, fireTick: round.fireTick };
    }

    it('makes an idle clock ready at once, so his next attack warns (K 4206, N 7731, L 5755)', () => {
      const { beams, crystals, fireTick } = idleAfterPhase4Fire();
      // L: fire 5744, taunt 5748, warning on the attack at 5755.
      const taunt = fireTick + 4;
      expect(beams.isReady(crystals, taunt)).toBe(false);
      beams.enrage(taunt);
      expect(beams.isReady(crystals, taunt)).toBe(true);
      expect(beams.prepare(crystals, taunt + 7, true)).toBe(6);
    });

    it('never delays a clock that is already ready', () => {
      const { beams, crystals } = setupBeam();
      beams.enrage(WARNING + 10);
      expect(beams.isReady(crystals, WARNING)).toBe(true);
    });

    it('leaves a warned or charging round alone, and its fire rolls the enraged delay', () => {
      const setup = setupBeam();
      const { beams, crystals } = setup;
      beams.prepare(crystals, WARNING, false);
      beams.enrage(WARNING + 1);
      const round = beams.startChargeIfDue(crystals, FIRST_CHARGE);
      expect(round?.fireTick).toBe(FIRST_CHARGE + 4);
      beams.enrage(FIRST_CHARGE + 1);
      expect(beams.isHolding()).toBe(true);
      expect(crystals[0].state.charging).toBe(true);
      if (!round) throw new Error('expected a charged round');
      beams.fireIfDue(crystals, { tick: round.fireTick, playerPos: [0, 0], phase: 5, random: () => 0.999 });
      expect(beams.isReady(crystals, round.fireTick + 4)).toBe(false);
      expect(beams.isReady(crystals, round.fireTick + 5)).toBe(true);
    });

    it('is applied by the 10% transition itself, before the taunt slot passes', () => {
      const encounter = new SolHereditEncounter(7);
      const engine = new SimulationEngine({ encounter, combatRandom: () => 0.5 });
      const world = engine['worldState'];
      engine.applyBossHpPreset(375);
      const sol = world.getNpcs().find((npc) => npc.id === SOL_ACTOR_ID);
      if (!sol || !solDefinition.isActor(sol)) throw new Error('Sol did not spawn');
      const player = world.getPlayer();
      if (!player) throw new Error('no player');
      player.position = [sol.position[0] + 2, sol.position[1] - 1];
      const beams: SolBeamRounds = encounter['beams'];
      const crystals = world.getNpcs().filter(crystalDefinition.isActor);
      expect(crystals).toHaveLength(4);
      const taunt = engine.getState().currentTick + 10;
      // As if the last phase-4 fire rolled long: idle until well after the taunt's resume slot.
      beams['readyTick'] = taunt + 20;
      sol.state.scheduler.nextAttackTick = taunt;
      sol.vitals.hp = 140;
      const context: EncounterContext = {
        tick: taunt,
        playerPos: player.position,
        world,
        tickEvents: new TickEvents(),
        logEvent: () => {},
        grantNextAttackSpeedup: () => {},
        ...createEncounterActorOps(world),
        ...createUnusedPlayerControlOps(),
      };
      const mechanics = { solHereditSand: false };
      runEncounterNpcActions(encounter, context, mechanics);
      expect(sol.state.scheduler.nextAttackTick).toBe(taunt + 7);
      expect(beams.isReady(crystals, taunt)).toBe(true);
      const resume = { ...context, tick: taunt + 7, tickEvents: new TickEvents() };
      runEncounterNpcActions(encounter, resume, mechanics);
      expect(sol.state.scheduler.pendingGround).not.toBeNull();
      expect(resume.tickEvents.flush().filter((event) => event.type === SOL_BEAM_PREPARED_EVENT)).toEqual([
        expect.objectContaining({ fireInTicks: 6 }),
      ]);
    });
  });

  it('keeps the charge length the warning announced, even if enrage starts in between', () => {
    const { beams, crystals } = setupBeam();
    const fireInTicks = beams.prepare(crystals, WARNING, false);
    const round = beams.startChargeIfDue(crystals, FIRST_CHARGE);
    expect(round?.fireTick).toBe(WARNING + (fireInTicks ?? 0));
    expect(round?.fireTick).toBe(FIRST_CHARGE + 4);
  });

  it('never charges without a warning, and stays ready for the next attack after being switched off', () => {
    const { beams, crystals } = setupBeam();
    beams.prepare(crystals, WARNING, false);
    beams.cancelRound(crystals);
    expect(crystals[0].state.charging).toBe(false);
    expect(beams.startChargeIfDue(crystals, FIRST_CHARGE)).toBeNull();
    // Switched back on: Sol's next attack, here at tick 20, sends a fresh, full warning.
    expect(beams.prepare(crystals, 20, true)).toBe(6);
    expect(beams.startChargeIfDue(crystals, 22)).toBeNull();
    expect(beams.startChargeIfDue(crystals, 23)?.fireTick).toBe(26);
  });

  it('tests the tile the player starts the fire tick on and lands the hit one tick later (L:5583->5584)', () => {
    const { beams, crystals } = setupBeam();
    const round = chargeFirstRound({ ...setupBeam(), beams, crystals });
    if (!round) throw new Error('expected a charged round');
    const onBeam = round.lines[0].tiles[0];
    expect(
      beams.fireIfDue(crystals, { tick: round.fireTick - 1, playerPos: onBeam, phase: 0, random: () => 0 }),
    ).toBeNull();
    expect(beams.takeHitIfDue(round.fireTick, onBeam, NO_ROLL)).toEqual([]);

    const safe = setupBeam();
    const safeRound = chargeFirstRound(safe);
    if (!safeRound) throw new Error('expected a charged round');
    const offBeam: Coordinate = [safeRound.lines[0].tiles[0][0] + 1, safeRound.lines[0].tiles[0][1]];
    safe.beams.fireIfDue(safe.crystals, { tick: safeRound.fireTick, playerPos: offBeam, phase: 0, random: () => 0 });
    expect(safe.beams.takeHitIfDue(safeRound.fireTick + 1, safeRound.lines[0].tiles[0], NO_ROLL)).toEqual([]);

    const hit = setupBeam();
    const hitRound = chargeFirstRound(hit);
    if (!hitRound) throw new Error('expected a charged round');
    const struck = hit.beams.fireIfDue(hit.crystals, {
      tick: hitRound.fireTick,
      playerPos: hitRound.lines[0].tiles[0],
      phase: 0,
      random: () => 0,
    });
    expect(struck?.round).toBe(hitRound);
    expect(hit.beams.takeHitIfDue(hitRound.fireTick, hitRound.lines[0].tiles[0], NO_ROLL)).toEqual([]);
    // It lands even though the player is moving off by then, once.
    // Two rolls over 40..75: 0.1 -> 43 and 0.9 -> 72; the hit is the higher one.
    const rolls = [0.1, 0.9];
    expect(
      hit.beams.takeHitIfDue(hitRound.fireTick + 1, offBeam, { random: () => rolls.shift()!, relentless: 0 }),
    ).toEqual([{ baseDamage: 72, attackType: 'typeless', source: 'SolLightBeam', playerPosition: offBeam }]);
    expect(rolls).toEqual([]);
    expect(hit.beams.takeHitIfDue(hitRound.fireTick + 2, offBeam, NO_ROLL)).toEqual([]);
  });

  it('adds the Relentless max-hit bonus to the beam roll (40..75+bonus, unverified model)', () => {
    for (const [relentless, max] of [
      [0, 75],
      [2, 78],
      [3, 81],
    ] as const) {
      const setup = setupBeam();
      const round = chargeFirstRound(setup);
      if (!round) throw new Error('expected a charged round');
      const onBeam = round.lines[0].tiles[0];
      setup.beams.fireIfDue(setup.crystals, { tick: round.fireTick, playerPos: onBeam, phase: 0, random: () => 0 });
      const top = setup.beams.takeHitIfDue(round.fireTick + 1, onBeam, { random: () => 0.9999, relentless });
      expect(top[0]?.baseDamage).toBe(max);
    }
    const setup = setupBeam();
    const round = chargeFirstRound(setup);
    if (!round) throw new Error('expected a charged round');
    const onBeam = round.lines[0].tiles[0];
    setup.beams.fireIfDue(setup.crystals, { tick: round.fireTick, playerPos: onBeam, phase: 0, random: () => 0 });
    expect(
      setup.beams.takeHitIfDue(round.fireTick + 1, onBeam, { random: () => 0, relentless: 3 })[0]?.baseDamage,
    ).toBe(40);
  });

  it('drops a hit still owed when beams are switched off or the clock resets', () => {
    for (const drop of ['cancel', 'reset'] as const) {
      const setup = setupBeam();
      const round = chargeFirstRound(setup);
      if (!round) throw new Error('expected a charged round');
      const onBeam = round.lines[0].tiles[0];
      setup.beams.fireIfDue(setup.crystals, { tick: round.fireTick, playerPos: onBeam, phase: 0, random: () => 0 });
      if (drop === 'cancel') setup.beams.cancelRound(setup.crystals);
      else setup.beams.reset();
      expect(setup.beams.takeHitIfDue(round.fireTick + 1, onBeam, NO_ROLL)).toEqual([]);
    }
  });

  describe('in the engine, against the tile the player starts the fire tick on', () => {
    /** Plays a lone crystal's first round to `ticksBefore` ticks before it fires, the player beside its line. */
    function beforeFire(ticksBefore = 1) {
      const engine = new SimulationEngine({ encounter: new SolHereditEncounter(7), combatRandom: () => 0.5 });
      engine.setMechanicsConfig({ infiniteHealth: true, solHereditAttacks: false, solHereditSand: false });
      engine.executeEncounterCommand({ encounter: 'sol_heredit', type: 'spawn-crystal' });
      const player = engine['worldState'].getPlayer();
      if (!player) throw new Error('no player');
      const snapshot = () => {
        const encounter = engine.getState().encounter;
        if (encounter.kind !== 'sol_heredit') throw new Error('wrong snapshot');
        return encounter.state;
      };
      // Far from Sol's footprint, so only the beam can reach these tiles.
      const off: Coordinate = [28, 30];
      player.position = [...off];
      while (snapshot().beamTiles.length === 0) engine.advanceTick(off);
      const fireTick = engine.getState().currentTick + 4;
      const onBeam = snapshot().beamTiles.find(([, y]) => y === off[1]);
      if (!onBeam || onBeam[0] !== off[0] + 1) throw new Error(`expected the line beside ${off}`);
      while (engine.getState().currentTick < fireTick - ticksBefore) engine.advanceTick(off);
      const beamHits = () => engine.getDamageHistory().filter((hit) => hit.source === 'SolLightBeam');
      return { engine, player, snapshot, fireTick, onBeam, off, beamHits };
    }

    it('hits a player on the line when the fire tick starts at F+1, even as they step off (L:5583->5584)', () => {
      const { engine, player, snapshot, fireTick, onBeam, off, beamHits } = beforeFire();
      player.position = [...onBeam];
      engine.advanceTick(onBeam); // F: starts on the line
      expect(snapshot().beamFiredTiles).toContainEqual(onBeam);
      expect(beamHits()).toEqual([]);
      engine.advanceTick(off); // F+1: moving off
      expect(beamHits()).toEqual([expect.objectContaining({ tick: fireTick + 1 })]);
    });

    it('spares a player who steps onto the line during F and stays there (L:5409/5446/5744)', () => {
      const { engine, fireTick, onBeam, beamHits } = beforeFire();
      engine.advanceTick(onBeam); // F: starts beside the line, ends on it
      expect(engine.getState().currentTick).toBe(fireTick);
      expect(engine.getState().playerPosition).toEqual(onBeam);
      for (let tick = 0; tick < 3; tick++) engine.advanceTick(onBeam);
      expect(beamHits()).toEqual([]);
    });

    it('lands the HP loss and the hit event together on F+1, not on F (L:5584)', () => {
      const { engine, player, fireTick, onBeam, beamHits } = beforeFire();
      engine.setMechanicsConfig({ infiniteHealth: false });
      player.position = [...onBeam];
      const hp = player.vitals.hp;
      const playerHits = () =>
        engine.getLastTickEvents().filter((event) => event.type === 'hit_applied' && event.targetId === 'player');
      engine.advanceTick(onBeam); // F
      expect(player.vitals.hp).toBe(hp);
      expect(playerHits()).toEqual([]);
      engine.advanceTick(onBeam); // F+1
      const [hit] = beamHits();
      expect(hit).toMatchObject({ tick: fireTick + 1, attackType: 'typeless' });
      expect(player.vitals.hp).toBe(hp - hit.effectiveDamage);
      expect(playerHits()).toEqual([expect.objectContaining({ tick: fireTick + 1, damage: hit.effectiveDamage })]);
    });

    it('spares a player who runs across the line during F (N:7715, L:5066)', () => {
      const { engine, player, onBeam, beamHits } = beforeFire();
      player.isRunEnabled = true;
      const across: Coordinate = [onBeam[0] + 1, onBeam[1]];
      engine.advanceTick(across); // F: through the line tile, two steps
      expect(player.movementPath).toEqual([onBeam, across]);
      for (let tick = 0; tick < 3; tick++) engine.advanceTick(across);
      expect(beamHits()).toEqual([]);
    });

    it('spares a player who leaves the line during F-1 (K:4077, N:7761/7772, L:5761)', () => {
      const { engine, player, fireTick, onBeam, off, beamHits } = beforeFire(2);
      player.position = [...onBeam];
      engine.advanceTick(off); // F-1: starts on the line, leaves
      expect(engine.getState().currentTick).toBe(fireTick - 1);
      for (let tick = 0; tick < 3; tick++) engine.advanceTick(off);
      expect(beamHits()).toEqual([]);
    });
  });

  it('freezes the crystals while a round is charging, so the beam lands where it was telegraphed', () => {
    const setup = setupBeam();
    const { beams, crystals, definition, context } = setup;
    const round = chargeFirstRound(setup);
    if (!round) throw new Error('expected a charged round');
    const before = [...crystals[0].position];
    for (let tick = FIRST_CHARGE; tick <= round.fireTick; tick++) {
      expect(definition.move(crystals[0], { ...context, tick })).toEqual([]);
    }
    expect(crystals[0].position).toEqual(before);
    expect(beams.getChargingLines()).toContainEqual(round.lines[0].tiles[0]);
  });

  it('adds at most one crystal per edge', () => {
    const engine = new SimulationEngine({ encounter: new SolHereditEncounter(7) });
    for (let index = 0; index < BEAM_CRYSTAL_EDGES.length; index++) {
      engine.executeEncounterCommand({ encounter: 'sol_heredit', type: 'spawn-crystal' });
      expect(engine['worldState'].getNpcs().filter(crystalDefinition.isActor)).toHaveLength(index + 1);
    }
    engine.executeEncounterCommand({ encounter: 'sol_heredit', type: 'spawn-crystal' });
    const crystals = engine['worldState'].getNpcs().filter(crystalDefinition.isActor);
    expect(crystals).toHaveLength(BEAM_CRYSTAL_EDGES.length);
    expect(crystals.map((crystal) => crystal.state.index)).toEqual([0, 1, 2, 3]);
  });
});
