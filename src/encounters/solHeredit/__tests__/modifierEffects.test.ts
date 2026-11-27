import { afterEach, describe, expect, it } from 'vitest';
import { getArenaAllowUnboundedFallback, getArenaConfig, setArenaConfig } from '../../../core/constants';
import type { EncounterModifierSelection } from '../../../core/encounters/encounterFactory';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { SOL_ACTOR_ID } from '../../../npcs/colosseum/constants';
import { interpolateNpcPosition } from '../../../render/npc/npcRenderPosition';
import { type Coordinate, PrayerType } from '../../../types/simulation';
import { SOL_SOLARFLARE_ACTOR_PREFIX } from '../constants';
import { SolHereditEncounter } from '../SolHereditEncounter';
import { M_SOLARFLARE_TICKS, RUN_A_SOLARFLARE_TICKS, VOLATILITY_BLASTS } from './fixtures/solModifierCapture';

const arena = getArenaConfig();
const unbounded = getArenaAllowUnboundedFallback();
afterEach(() => setArenaConfig(arena, unbounded));
const M = 'colosseum-sol-heredit-solar-flare-doom-volatility-packet-data.txt';
const N = 'colosseum-sol-heredit-packet-data-2.txt';

function setup(modifiers: EncounterModifierSelection) {
  const encounter = new SolHereditEncounter(7, modifiers);
  const engine = new SimulationEngine({ encounter, combatRandom: () => 0.5 });
  engine.setMechanicsConfig({
    infiniteHealth: true,
    solHereditAttacks: false,
    solHereditSand: false,
    solHereditBeams: false,
  });
  const world = engine['worldState'];
  const advance = () => engine.advanceTick(engine.getState().playerPosition);
  const snapshot = () => {
    const state = engine.getState().encounter;
    if (state.kind !== 'sol_heredit') throw new Error('Expected Sol snapshot');
    return state.state;
  };
  return { encounter, engine, world, advance, snapshot };
}

describe('Solarflare capture conformance', () => {
  it.each([1, 2, 3] as const)('presents tier %i through the engine without changing the route clock', (tier) => {
    const { engine, advance } = setup({ solarflare: tier });
    const orb = () => engine.getState().npcs.find((npc) => npc.id === `${SOL_SOLARFLARE_ACTOR_PREFIX}_0`)!;
    for (let tick = 0; tick < 3; tick++) advance();
    expect(orb().crawlMovement).toBeUndefined();
    const from = [...orb().position] as Coordinate;
    advance();
    const first = orb();
    const to = [...first.position] as Coordinate;
    expect(to).not.toEqual(from);
    if (tier === 3) {
      expect(first.crawlMovement).toBeUndefined();
      expect(interpolateNpcPosition(first, 0.5, 4)).toEqual([(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]);
      advance();
      expect(orb().position).not.toEqual(to);
      expect(orb().crawlMovement).toBeUndefined();
      return;
    }
    expect(first.crawlMovement).toEqual({ from, to, startTick: 4 });
    expect(interpolateNpcPosition(first, 0.5, 4)).toEqual([
      from[0] + (to[0] - from[0]) / 4,
      from[1] + (to[1] - from[1]) / 4,
    ]);
    advance();
    const second = orb();
    expect(second.previousPosition).toEqual(to);
    expect(second.position).toEqual(to);
    expect(interpolateNpcPosition(second, 0, 5)).toEqual([(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]);
    expect(interpolateNpcPosition(second, 0.5, 5)).toEqual([
      from[0] + (to[0] - from[0]) * 0.75,
      from[1] + (to[1] - from[1]) * 0.75,
    ]);
    let previous = second;
    let sawTurn = false;
    let heldTicks = 0;
    let priorAxis = to[0] === from[0] ? 'y' : 'x';
    for (let tick = 6; tick <= 40; tick++) {
      advance();
      const current = orb();
      if (current.crawlMovement?.startTick === tick) {
        const segment = current.crawlMovement;
        const axis = segment.to[0] === segment.from[0] ? 'y' : 'x';
        if (axis !== priorAxis) {
          expect(interpolateNpcPosition(current, 0, tick)).toEqual(previous.position);
          expect(segment.from).toEqual(previous.position);
          sawTurn = true;
        }
        priorAxis = axis;
      } else if (!current.crawlMovement) {
        expect(interpolateNpcPosition(current, 0.5, tick)).toEqual(current.position);
        heldTicks++;
      }
      previous = current;
    }
    expect(sawTurn).toBe(true);
    if (tier === 1) expect(heldTicks).toBeGreaterThan(0);
    else expect(heldTicks).toBe(0);
    engine.reset();
    expect(engine.getState().npcs.some((npc) => npc.crawlMovement !== undefined)).toBe(false);
  });

  it('matches Run A tier-III Sol positions from control through the last pre-teleport tick (A:4976–5307)', () => {
    const { engine, advance, snapshot } = setup({ solarflare: 3 });
    const expected = new Map<number, Coordinate>();
    const indices = [63318, 63319, 63317, 63320];
    let walks = 0;
    let compared = 0;
    for (const { tick, updates } of RUN_A_SOLARFLARE_TICKS) {
      while (engine.getState().currentTick < tick - 4976) advance();
      for (const [op, index, x, y] of updates) {
        expected.set(index, [x, y]);
        if (op === 'walk') walks++;
      }
      expect(snapshot().solarflareTiles, `A:${tick}`).toEqual(
        indices.flatMap((index) => {
          const tile = expected.get(index);
          return tile ? [tile] : [];
        }),
      );
      compared++;
    }
    expect(compared).toBe(332);
    expect(walks).toBe(1052);
  });

  it('matches all four spawns, 304 crawls, held tiles and D+11 removals without damage', () => {
    const { engine, world, advance, snapshot } = setup({ solarflare: 1 });
    // The live victory boundary is D+9. External ownership allows this conformance driver
    // to exercise the recorded D+11 cleanup without changing that boundary.
    engine.setCompletionOwnership('external-owned');
    const expected = new Map<number, Coordinate>();
    const indices = [45944, 45945, 45943, 45946];
    let crawls = 0;
    let compared = 0;
    for (const { tick, updates } of M_SOLARFLARE_TICKS) {
      while (engine.getState().currentTick < tick - 8273) advance();
      for (const [op, index, x, y] of updates) {
        if (op === 'del') expected.delete(index);
        else {
          expected.set(index, [x, y]);
          if (op === 'crawl') crawls++;
        }
      }
      expect(snapshot().solarflareTiles, `M${tick}`).toEqual(
        indices.flatMap((index) => {
          const tile = expected.get(index);
          return tile ? [tile] : [];
        }),
      );
      if (tick === 8512) engine.setBossHp(0);
      compared++;
    }
    expect(compared).toBe(251);
    expect(crawls).toBe(304);
    expect(world.getNpcs().some((npc) => npc.npcTypeId === 12826)).toBe(false);
    expect(engine['damageHistory']).toEqual([]);
    expect(engine.getLastTickEvents().filter((event) => event.type === 'actor_despawned')).toHaveLength(4);
  });

  it.each([1, 2, 3] as const)('publishes clone-safe deterministic tier %i state and rejects attacks', (solarflare) => {
    const { engine, encounter, world, advance, snapshot } = setup({ solarflare });
    const states = [];
    for (let tick = 0; tick < 64; tick++) {
      advance();
      states.push(structuredClone(snapshot()));
    }
    const rule = encounter.getEngineRules().validateAttack!;
    expect(
      rule('melee_crush', `${SOL_SOLARFLARE_ACTOR_PREFIX}_0`, { tick: 64, world, player: world.getPlayer()! }),
    ).toBe(false);
    const config = engine.getRunConfig();
    engine.reset(undefined, config);
    expect(snapshot().solarflareTiles).toEqual([]);
    for (let tick = 0; tick < 64; tick++) {
      advance();
      expect(snapshot()).toEqual(states[tick]);
    }
    expect(engine['damageHistory']).toEqual([]);
  });
});

describe('modifier damage in the engine', () => {
  it.each([
    1, 2, 3,
  ] as const)('Solarflare tier %i selects departure before movement, hits at T+1 and excludes Blasphemy', (tier) => {
    const { engine, world, advance, snapshot } = setup({ solarflare: tier, doom: 1, blasphemy: 3 });
    engine.setMechanicsConfig({ infiniteHealth: false });
    for (let tick = 0; tick < 3; tick++) advance();
    const player = world.getPlayer()!;
    player.position = [34, 36]; // Orb zero's spawn tile, vacated at T=4.
    engine.queueProtectionPrayer(PrayerType.ProtectMelee);
    engine.queueOffensivePrayer(PrayerType.Piety);
    engine.queueIndependentPrayer(PrayerType.Preserve);
    engine.advanceTick([33, 36]); // Leaving during T does not escape the exposure.
    expect(player.position).toEqual([33, 36]);
    expect(engine.getDamageHistory()).toEqual([]);
    expect(player.activePrayer).toBe(tier === 3 ? null : PrayerType.ProtectMelee);
    expect(player.offensivePrayer).toBe(PrayerType.Piety);
    expect(player.independentPrayers).toEqual([PrayerType.Preserve]);
    if (tier === 3) engine.queueProtectionPrayer(PrayerType.ProtectMelee);
    advance();
    expect(player.activePrayer).toBe(PrayerType.ProtectMelee); // A:2290->2291: no lockout.
    expect(engine.getLastTickEvents().some((event) => event.type === 'prayer_activation_failed')).toBe(false);
    expect(engine.getDamageHistory()).toEqual([
      expect.objectContaining({ tick: 5, source: 'Solarflare', baseDamage: 15, effectiveDamage: 15 }),
    ]);
    expect(player.vitals.hp).toBe(84);
    expect(snapshot().doomStacks).toBe(1);
    expect(player.prayerState.points).toBe(99);
  });

  it('skips arrival-only overlap and clears a pending Solarflare hit on reset', () => {
    const { engine, world, advance } = setup({ solarflare: 1 });
    for (let tick = 0; tick < 3; tick++) advance();
    const player = world.getPlayer()!;
    player.position = [34, 37];
    advance(); // Orb arrives at player's tile on T=4, no departure exposure.
    engine.advanceTick([33, 37]); // Leave on T=5, before the orb departs on T=6.
    advance();
    advance();
    expect(engine.getDamageHistory()).toEqual([]);
    engine.reset(undefined, engine.getRunConfig());
    for (let tick = 0; tick < 3; tick++) advance();
    world.getPlayer()!.position = [34, 36];
    advance(); // Queue a hit at T=5.
    engine.reset(undefined, engine.getRunConfig());
    for (let tick = 0; tick < 6; tick++) advance();
    expect(engine.getDamageHistory()).toEqual([]);
  });

  it.each([true, false])('Volatility checks the start tile, not the destination (start inside=%s)', (inside) => {
    const { engine, world, advance, snapshot } = setup({ volatility: 2, doom: 1, blasphemy: 3 });
    engine.setMechanicsConfig({ infiniteHealth: false });
    world.getNpc(SOL_ACTOR_ID)!.position = [31, 32];
    engine.setBossHp(0);
    for (let tick = 0; tick < 8; tick++) advance();
    const player = world.getPlayer()!;
    player.position = inside ? [37, 34] : [38, 34];
    engine.queueProtectionPrayer(PrayerType.ProtectMagic);
    engine.advanceTick(inside ? [39, 34] : [37, 34]);
    expect(player.position).toEqual(inside ? [39, 34] : [37, 34]);
    expect(engine.getDamageHistory()).toHaveLength(inside ? 1 : 0);
    expect(player.vitals.hp).toBe(inside ? 79 : 99);
    expect(snapshot().doomStacks).toBe(inside ? 1 : 0);
    expect(player.prayerState.points).toBe(99);
  });

  it.each([
    'lethal blast',
    'Doom threshold',
    'survives',
  ] as const)('resolves D+9 damage before victory: %s', (scenario) => {
    const { engine, encounter, world, advance } = setup({ volatility: 1, doom: 3, blasphemy: 3 });
    engine.setMechanicsConfig({ infiniteHealth: false });
    world.getNpc(SOL_ACTOR_ID)!.position = [31, 32];
    engine.setBossHp(0);
    for (let tick = 0; tick < 8; tick++) advance();
    const player = world.getPlayer()!;
    player.position = [33, 34];
    if (scenario === 'Doom threshold') {
      for (let hit = 0; hit < 4; hit++) engine['applyDamage'](1, 'typeless', 'TestHazard', 8);
    }
    if (scenario === 'lethal blast') player.stats.hitpoints.current = player.vitals.hp = 10;
    advance();
    expect(engine.getState().currentTick).toBe(9);
    expect(engine.getDamageHistory().at(-1)).toMatchObject({ tick: 9, source: 'Volatility', baseDamage: 20 });
    expect(player.alive).toBe(scenario === 'survives');
    expect(encounter.getOutcome().phase).toBe(scenario === 'survives' ? 'victory' : 'resolving');
    expect(engine.getState().failedCondition).toBe(
      scenario === 'survives' ? null : scenario === 'Doom threshold' ? 'Doom' : 'Death',
    );
    expect(
      engine
        .getLastTickEvents()
        .filter(isEncounterVisualEvent)
        .flatMap((event) => event.graphics),
    ).toHaveLength(50);
  });
});

describe('Volatility capture conformance and lifecycle', () => {
  it.each([
    { filename: M, tier: 2, death: 8512, blast: 8521, count: 81, centre: [33, 34] },
    { filename: N, tier: 1, death: 7781, blast: 7790, count: 49, centre: [32, 34] },
  ] as const)('emits capture $filename geometry/ripple at death+9, on the victory tick', ({
    filename,
    tier,
    death,
    blast,
    count,
    centre,
  }) => {
    const { deathTick, solAtDeath, blastTick, graphics } = VOLATILITY_BLASTS[filename]!;
    expect(deathTick).toBe(death);
    expect(blastTick).toBe(blast);
    expect(blast - death).toBe(9);
    expect(graphics.filter((cue) => cue.spotAnimId === 131)).toHaveLength(count);
    expect(graphics.find((cue) => cue.spotAnimId === 2724)?.position).toEqual(centre);

    const { engine, world, encounter, advance } = setup({ volatility: tier });
    const sol = world.getNpc(SOL_ACTOR_ID)!;
    sol.position = [...solAtDeath];
    engine.setBossHp(0); // D=0 in the sim; retain the capture's death footprint.
    for (let tick = 1; tick <= 9; tick++) {
      advance();
      const emitted = engine
        .getLastTickEvents()
        .filter(isEncounterVisualEvent)
        .flatMap((event) => event.graphics)
        .map(({ spotAnimId, target, delayCycles }) => ({
          spotAnimId,
          position: target.kind === 'tile' ? target.position : undefined,
          delayCycles,
        }));
      if (tick < 9) expect(emitted).toEqual([]);
      else {
        const sorted = (cues: readonly unknown[]) =>
          cues.map((cue) => JSON.stringify(cue, ['spotAnimId', 'position', 'delayCycles'])).sort();
        expect(sorted(emitted)).toEqual(sorted(graphics));
      }
    }
    expect(encounter.getOutcome()).toMatchObject({ phase: 'victory', completionTick: 9 });
    expect(engine.getState().currentTick).toBe(9);
    expect(engine.getDamageHistory()).toEqual([
      expect.objectContaining({ tick: 9, source: 'Volatility', baseDamage: 20, effectiveDamage: 20 }),
    ]);
    advance();
    expect(engine.getState().currentTick).toBe(9);
  });

  it('keeps D+9 completion with orbs, reports their later cleanup boundary, and clears pending effects on reset', () => {
    const { engine, encounter, advance, snapshot } = setup({ solarflare: 1, volatility: 3 });
    for (let tick = 0; tick < 6; tick++) advance();
    engine.setBossHp(0);
    for (let tick = 0; tick < 9; tick++) advance();
    expect(encounter.getOutcome()).toMatchObject({ phase: 'victory', completionTick: 15 });
    expect(snapshot().solarflareTiles).toHaveLength(4); // D+11 is deliberately not pulled forward.
    const blast = engine
      .getLastTickEvents()
      .filter(isEncounterVisualEvent)
      .flatMap((event) => event.graphics);
    expect(blast.filter((cue) => cue.spotAnimId === 131)).toHaveLength(81);
    expect(snapshot().sandTiles).toEqual([]); // No tier-III pool.
    advance();
    expect(engine.getState().currentTick).toBe(15);
    engine.reset(undefined, engine.getRunConfig());
    expect(snapshot().solarflareTiles).toEqual([]);
    for (let tick = 0; tick < 6; tick++) advance();
    engine.setBossHp(0);
    advance(); // Queue the new pending explosion, then reset before it fires.
    engine.reset(undefined, engine.getRunConfig());
    for (let tick = 0; tick < 18; tick++) {
      advance();
      expect(engine.getLastTickEvents().filter(isEncounterVisualEvent)).toEqual([]);
    }
    expect(snapshot().solarflareTiles).toHaveLength(4);
  });
});

describe('Myopia halberd reach in the engine', () => {
  // Sol holds still until SOL_OPENING_HOLD_UNTIL_TICK; its 5x5 footprint's south-west tile is [31,36].
  const DIAGONAL_ADJACENT: Coordinate = [30, 35];
  const DIAGONAL_TWO: Coordinate = [29, 34];
  const NOXIOUS_HALBERD = 29796;
  const ABYSSAL_WHIP = 4151;

  function firstTick(modifiers: EncounterModifierSelection, weapon: number, attackRange: number, start: Coordinate) {
    const { engine, world, advance } = setup(modifiers);
    const player = world.getPlayer()!;
    player.equipment = { weapon };
    player.equipmentStats = { ...player.equipmentStats, attackSpeed: 4, attackRange };
    player.position = [...start];
    player.previousPosition = [...start];
    player.isRunEnabled = false;
    engine.setAttackTarget(SOL_ACTOR_ID);
    expect(world.getNpcs().find((npc) => npc.id === SOL_ACTOR_ID)?.position).toEqual([31, 36]);
    advance();
    const attacked = engine
      .getLastTickEvents()
      .some((event) => event.type === 'attack_started' && event.sourceId === 'player');
    return { attacked, position: player.position };
  }

  it.each([1, 2, 3] as const)('Myopia %i halberd attacks from the diagonally adjacent tile', (myopia) => {
    expect(firstTick({ myopia }, NOXIOUS_HALBERD, 2, DIAGONAL_ADJACENT)).toEqual({
      attacked: true,
      position: DIAGONAL_ADJACENT,
    });
  });

  it.each([1, 2, 3] as const)('Myopia %i halberd walks in from a two-tile diagonal instead of attacking', (myopia) => {
    const { attacked, position } = firstTick({ myopia }, NOXIOUS_HALBERD, 2, DIAGONAL_TWO);
    expect(attacked).toBe(false);
    expect(position).not.toEqual(DIAGONAL_TWO);
  });

  it('halberd without Myopia attacks from the two-tile diagonal', () => {
    expect(firstTick({}, NOXIOUS_HALBERD, 2, DIAGONAL_TWO)).toEqual({ attacked: true, position: DIAGONAL_TWO });
  });

  it('non-polearm melee under Myopia still steps off the diagonal before attacking', () => {
    const { position } = firstTick({ myopia: 3 }, ABYSSAL_WHIP, 1, DIAGONAL_ADJACENT);
    expect(position).not.toEqual(DIAGONAL_ADJACENT);
  });
});
