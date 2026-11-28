import { afterEach, describe, expect, it, vi } from 'vitest';
import { canInitiateAttackOnNpc } from '../../../../core/actors/NpcActor';
import {
  getArenaAllowUnboundedFallback,
  getArenaConfig,
  isWalkableTile,
  setArenaConfig,
} from '../../../../core/constants';
import type { EnvironmentalDamage } from '../../../../core/encounters/types';
import { isEncounterVisualEvent } from '../../../../core/events/encounterVisual';
import type { CoreGameEvent, GameEvent } from '../../../../core/events/types';
import { SimulationEngine } from '../../../../core/SimulationEngine';
import { SOL_ACTOR_ID } from '../../../../npcs/colosseum/constants';
import { JAVELIN_COLOSSUS_SPOTANIMS, javelinColossusDefinition } from '../../../../npcs/colosseum/javelinColossus';
import { manticoreDefinition, manticoreHeldOrbs } from '../../../../npcs/colosseum/manticore';
import { MINOTAUR_NPC_ID, MINOTAUR_ROUTEFIND_NPC_ID, minotaurDefinition } from '../../../../npcs/colosseum/minotaur';
import { shockwaveColossusDefinition } from '../../../../npcs/colosseum/shockwaveColossus';
import { enqueueEnginePendingHit } from '../../../../test/helpers/pendingHits';
import type { Coordinate } from '../../../../types/simulation';
import { SOL_PLAYER_START } from '../../../solHeredit/constants';
import {
  buildSolHereditControls,
  COLOSSEUM_SPAWN_LAYOUT_KEY,
  COLOSSEUM_START_TILE_KEY,
  COLOSSEUM_START_WAVE_KEY,
} from '../../../solHeredit/controls';
import { SOL_HEREDIT_RENDER_CONFIG } from '../../../solHeredit/renderConfig';
import { SolHereditEncounter } from '../../../solHeredit/SolHereditEncounter';
import { createBeeSwarms } from '../../modifiers/bees';
import { colosseumDefaultModifiers } from '../../modifiers/defaults';
import type { ColosseumModifierId } from '../../modifiers/definitions';
import {
  COLOSSEUM_FIRST_OFFERS,
  drawColosseumModifierOffers,
  eligibleColosseumModifierPicks,
  SUPPORTED_WAVE_MODIFIERS,
} from '../../modifiers/offers';
import type { ColosseumModifierState } from '../../modifiers/rules';
import { SolarflareDamageState, solarflareDefinition } from '../../modifiers/solarflare';
import { healingTotemDefinition, healingTotemSpawnTile } from '../../modifiers/totemic';
import { waveCompletedMessage } from '../ColosseumWaveRun';
import { colosseumStreams, isSpawnPointClearOfPlayer, planColosseumWave } from '../layout';
import { colosseumRunState, DIRECT_SOL_RUN_STATE } from '../snapshot';
import { COLOSSEUM_MODIFIER_CONFIRMED_EVENT } from '../waveTable';
import { CAPTURED_SOL_HANDOFFS, CAPTURED_WAVE_SOLARFLARE } from './fixtures/waveLayoutCapture';
import {
  advanceTo,
  clearWave,
  confirm,
  confirmAndStart,
  gameMessages,
  kill,
  type Run,
  runState,
  snapshotState,
  startRun,
  step,
  waveFighters,
} from './waveRunHarness';

const VENATOR_BOW = 27610;
const DRAGON_ARROW = 11212;

const originalArena = getArenaConfig();
const originalFallback = getArenaAllowUnboundedFallback();
afterEach(() => setArenaConfig(originalArena, originalFallback));

function player(run: Run) {
  const actor = run.world.getPlayer();
  if (!actor) throw new Error('No player');
  return actor;
}

/** Binds every fighter in place so a test controls when each one dies. */
function bindFighters(run: Run): void {
  for (const npc of waveFighters(run)) npc.debuffs = { ...npc.debuffs, boundFromTick: 0, boundUntilTick: 100_000 };
}

describe('opening a wave run', () => {
  it('opens wave 1 on its fixed choice, with no modifiers and no fighters, ignoring the direct-Sol preset', () => {
    const encounter = new SolHereditEncounter(7, { blasphemy: 3 });
    const run = startRun(1);
    const preset = startRun(1);
    expect(encounter.modifiers).toEqual({ blasphemy: 3 });
    for (const candidate of [run, preset]) {
      expect(runState(candidate)).toMatchObject({
        startWave: 1,
        wave: 1,
        stage: 'intermission',
        waveStartTick: null,
        offer: { wave: 1, options: COLOSSEUM_FIRST_OFFERS },
        picks: [],
      });
      expect(snapshotState(candidate).modifiers).toEqual({});
      expect(candidate.world.getNpcs()).toEqual([]);
      // Policy: the west-side start tile, facing east.
      expect(candidate.engine.getState()).toMatchObject({ playerPosition: [23, 38], playerFacingAngle: 1536 });
      expect(candidate.engine.getEncounterSnapshot().visuals).toEqual({ solControlTick: null });
    }
  });

  it('keeps a direct start (missing, invalid or 12) exactly Sol at C = 0 with the preset', () => {
    for (const value of [undefined, 'x', '0', '13', '12']) {
      const run = startRun(12, 7, { [COLOSSEUM_START_WAVE_KEY]: value });
      expect(runState(run)).toEqual(DIRECT_SOL_RUN_STATE);
      expect(run.world.getNpcs().map((npc) => npc.id)).toEqual([SOL_ACTOR_ID]);
      expect(run.engine.getState()).toMatchObject({ playerPosition: [...SOL_PLAYER_START], playerFacingAngle: 1024 });
      expect(run.engine.getEncounterSnapshot().visuals).toEqual({ solControlTick: 0 });
    }
  });

  it('reads a recording without run metadata as a direct Sol start', () => {
    expect(colosseumRunState({})).toBe(DIRECT_SOL_RUN_STATE);
  });

  it.each([1, 2, 5, 9])('opens wave %i on the default set, owned going in and in force from its T0', (wave) => {
    const set = colosseumDefaultModifiers(wave);
    const run = startRun(wave, 3, {}, set);
    expect(runState(run).picks).toEqual(
      Object.entries(set).map(([id, tier]) => ({ origin: 'set', wave: null, id, tier, tick: null })),
    );
    expect(snapshotState(run).modifiers).toEqual({});
    const offer = runState(run).offer!;
    // Offers continue from the set: Blasphemy is offered at the tier above it.
    if (wave === 1) expect(offer.options).toEqual(COLOSSEUM_FIRST_OFFERS);
    for (const option of offer.options) expect(option.tier).toBe((set[option.id] ?? 0) + 1);
    const pick = offer.options[0]!;
    confirmAndStart(run, pick.id);
    expect(snapshotState(run).modifiers).toEqual({ ...set, [pick.id]: (set[pick.id] ?? 0) + 1 });
    expect(runState(run).picks.at(-1)).toMatchObject({ origin: 'live', wave, id: pick.id, tier: pick.tier });
  });

  it.each([2, 5, 9])('plays a custom set on wave %i as given, Blasphemy off included', (wave) => {
    const set = { doom: 2, quartet: 1, volatility: 3, dynamicDuo: 1, redFlag: 1 } as const;
    const run = startRun(wave, 4, {}, set);
    expect(runState(run).picks.map(({ id, tier, origin }) => [id, tier, origin])).toEqual([
      // Catalog (cache key) order.
      ['volatility', 3, 'set'],
      ['quartet', 1, 'set'],
      ['doom', 2, 'set'],
      ['dynamicDuo', 1, 'set'],
      ['redFlag', 1, 'set'],
    ]);
    // Owned singles and maxed tiers are never offered; Blasphemy stays off unless picked.
    for (const option of runState(run).offer!.options) {
      expect(['quartet', 'volatility', 'dynamicDuo', 'redFlag']).not.toContain(option.id);
      if (option.id === 'doom') expect(option.tier).toBe(3);
    }
    const other = runState(run).offer!.options.find((option) => option.id !== 'blasphemy')!;
    confirmAndStart(run, other.id);
    expect(snapshotState(run).modifiers.blasphemy).toBeUndefined();
    expect(snapshotState(run).modifiers).toEqual({ ...set, [other.id]: other.tier });
    // Quartet from the set brings its fourth warbander on the start wave.
    expect(waveFighters(run).filter((npc) => npc.id.includes('_quartet_'))).toHaveLength(1);
  });

  it('opens wave 1 on the first choice above a custom set, without the tiers it has maxed', () => {
    const run = startRun(1, 3, {}, { blasphemy: 3, frailty: 1 });
    expect(runState(run).offer?.options).toEqual([
      { id: 'relentless', tier: 1 },
      { id: 'frailty', tier: 2 },
    ]);
  });

  it('starts the wave on its own when the set leaves nothing to offer', () => {
    const run = startRun(1, 3, {}, { blasphemy: 3, relentless: 3, frailty: 3 });
    expect(runState(run)).toMatchObject({ offer: null, waveStartTick: 5, stage: 'intermission' });
    advanceTo(run, 5);
    expect(runState(run)).toMatchObject({ stage: 'wave', waveStartTick: 5 });
    expect(snapshotState(run).modifiers).toEqual({ blasphemy: 3, relentless: 3, frailty: 3 });
  });

  it('rejects a set with an unsimulated modifier or an impossible tier', () => {
    expect(() => startRun(3, 1, {}, { mantimayhem: 1 })).toThrow(RangeError);
    expect(() => startRun(3, 1, {}, { quartet: 2 })).toThrow(RangeError);
    expect(() => startRun(3, 1, {}, { unknown: 1 })).toThrow(RangeError);
  });

  it('applies Frailty and Relentless from the set at the start wave, from base and without healing', () => {
    const run = startRun(5, 2, {}, { frailty: 2, relentless: 1 });
    expect(player(run).vitals).toEqual({ hp: 99, maxHp: 99 });
    while (runState(run).offer === null) step(run);
    confirm(run, runState(run).offer!.options.find((option) => option.id !== 'frailty')!.id);
    step(run);
    const t0 = runState(run).waveStartTick!;
    advanceTo(run, t0 - 1);
    expect(player(run).vitals).toEqual({ hp: 99, maxHp: 99 });
    step(run);
    // Frailty II: 99 - floor(99 * 20%) = 80, straight from base.
    expect(player(run).vitals).toEqual({ hp: 80, maxHp: 80 });
    const relentless = waveFighters(run).map((npc) => (npc as { state?: { relentless?: number } }).state?.relentless);
    expect(relentless.every((rank) => rank === 1)).toBe(true);
  });

  it('swaps the opening on a tick-zero start-wave edit, keeping the set', () => {
    const run = startRun(2, 5, {}, { frailty: 1 });
    expect(player(run).vitals).toEqual({ hp: 99, maxHp: 99 });
    run.engine.setMechanicsConfig({ ...run.engine.getMechanicsConfig(), [COLOSSEUM_START_WAVE_KEY]: '12' });
    expect(run.world.getNpcs().map((npc) => npc.id)).toEqual([SOL_ACTOR_ID]);
    // A direct start has its set in force from tick 0.
    expect(player(run).vitals).toEqual({ hp: 90, maxHp: 90 });
    expect(runState(run).stage).toBe('sol');
    run.engine.setMechanicsConfig({ ...run.engine.getMechanicsConfig(), [COLOSSEUM_START_WAVE_KEY]: '2' });
    expect(run.world.getNpcs()).toEqual([]);
    expect(player(run).vitals).toEqual({ hp: 99, maxHp: 99 });
    expect(runState(run).picks).toEqual([{ origin: 'set', wave: null, id: 'frailty', tier: 1, tick: null }]);
  });

  it('opens a tick-zero edit between the waves and Sol on the tile a fresh start of it uses', () => {
    const fresh = (wave: number) => [...startRun(wave).engine.getState().playerPosition];
    const facing = (wave: number) => startRun(wave).engine.getState().playerFacingAngle;
    const opening = (run: Run) => ({
      tile: [...run.engine.getState().playerPosition],
      facing: run.engine.getState().playerFacingAngle,
      recorded: run.engine.getRunConfig().bootstrap?.startPosition,
    });
    for (const [from, to] of [
      [11, 12],
      [1, 12],
      [12, 1],
      [12, 11],
      [3, 7],
    ] as const) {
      const run = startRun(from);
      run.engine.setMechanicsConfig({ ...run.engine.getMechanicsConfig(), [COLOSSEUM_START_WAVE_KEY]: String(to) });
      expect(opening(run)).toEqual({ tile: fresh(to), facing: facing(to), recorded: fresh(to) });
    }
    expect([fresh(12), facing(12)]).toEqual([[...SOL_PLAYER_START], 1024]);
    expect([fresh(1), facing(1)]).toEqual([[23, 38], 1536]);
    expect([fresh(11), facing(11)]).toEqual([[23, 38], 1536]);
  });

  it("keeps the tile a run is given when its setup opens another stage, a bootstrap's included", () => {
    const given: Coordinate = [30, 35];
    const encounter = new SolHereditEncounter(7);
    const engine = new SimulationEngine({ encounter, startPos: given, mechanics: { [COLOSSEUM_START_WAVE_KEY]: '3' } });
    expect(engine.getState().playerPosition).toEqual(given);
    // A recording of a direct start on that tile, replayed by an engine whose encounter last opened wave 3.
    engine.setMechanicsConfig({ ...engine.getMechanicsConfig(), [COLOSSEUM_START_WAVE_KEY]: '12' });
    const recorded = engine.getRunConfig();
    const bootstrap = { ...recorded.bootstrap!, startPosition: given };
    const replay = startRun(3);
    replay.engine.advanceTick(replay.engine.getState().playerPosition);
    replay.engine.reset(undefined, { ...recorded, bootstrap });
    expect(runState(replay).stage).toBe('sol');
    expect(replay.engine.getState().playerPosition).toEqual(given);
    expect(replay.engine.getRunConfig().bootstrap?.startPosition).toEqual(given);
  });
});

describe('the confirm-modifier command', () => {
  it('starts the wave five ticks after the accepted choice, applying the pick at its start', () => {
    const run = startRun(1);
    step(run);
    confirm(run, 'blasphemy');
    step(run);
    const tk = run.engine.currentTick;
    expect(runState(run)).toMatchObject({
      offer: null,
      waveStartTick: tk + 5,
      picks: [{ origin: 'live', wave: 1, id: 'blasphemy', tier: 1, tick: tk }],
    });
    // Accepted now, in force from the wave's start (as Frailty's maximum shows, B:2975).
    expect(snapshotState(run).modifiers).toEqual({});
    const events = advanceTo(run, tk + 5);
    expect(snapshotState(run).modifiers).toEqual({ blasphemy: 1 });
    expect(gameMessages(events.get(tk + 5))).toEqual(['Wave: 1']);
    expect(gameMessages(events.get(tk + 4))).toEqual([]);
    expect(waveFighters(run).map((npc) => npc.id.replace(/_\d+$/, ''))).toEqual([
      'colosseum_w1_berserker',
      'colosseum_w1_archer',
      'colosseum_w1_seer',
      'colosseum_w1_serpentShaman',
    ]);
    expect(waveFighters(run).every((npc) => npc.spawnTick === tk + 5)).toBe(true);
    expect(runState(run)).toMatchObject({ stage: 'wave', waveStartTick: tk + 5, reinforcementTick: tk + 71 });
  });

  it('emits one confirm event on the accepting tick, and none for a rejected or duplicate choice', () => {
    const confirmed = (events: readonly GameEvent[]) =>
      events
        .filter((event) => event.type === COLOSSEUM_MODIFIER_CONFIRMED_EVENT)
        .map((event) => ({ type: event.type, wave: (event as { wave?: unknown }).wave }));
    const run = startRun(1);
    // Gated to waves 7-11, so no pick before wave 1.
    confirm(run, 'dynamicDuo');
    expect(confirmed(step(run))).toEqual([]);
    confirm(run, 'frailty');
    confirm(run, 'relentless');
    const tk = step(run);
    expect(confirmed(tk)).toEqual([{ type: 'colosseum_modifier_confirmed', wave: 1 }]);
    expect(runState(run).picks.at(-1)).toMatchObject({ id: 'frailty', tick: run.engine.currentTick });
    run.engine.queueEncounterCommand({
      encounter: 'sol_heredit',
      type: 'confirm-modifier',
      wave: 1,
      modifierId: 'frailty',
    });
    expect(confirmed(step(run))).toEqual([]);
  });

  it('rejects stale, duplicate, wrong-stage and ineligible choices when they execute', () => {
    const run = startRun(1);
    confirm(run, 'redFlag');
    confirm(run, 'blasphemy', 2);
    step(run);
    expect(runState(run).offer).not.toBeNull();
    confirm(run, 'frailty');
    confirm(run, 'relentless');
    step(run);
    expect(runState(run).picks.map((pick) => pick.id)).toEqual(['frailty']);
    const t0 = runState(run).waveStartTick!;
    advanceTo(run, t0 + 1);
    run.engine.queueEncounterCommand({
      encounter: 'sol_heredit',
      type: 'confirm-modifier',
      wave: 2,
      modifierId: 'doom',
    });
    step(run);
    expect(runState(run).picks).toHaveLength(1);
    expect(runState(run).stage).toBe('wave');
  });

  describe('a specific pick off the offer (practice)', () => {
    const SET = { doom: 1 } as const;
    /** A seed whose wave-4 offer, owning Doom I, leaves Doom II off it. */
    const seed = Array.from({ length: 100 }, (_, index) => index + 1).find(
      (candidate) => !runState(startRun(4, candidate, {}, SET)).offer!.options.some((option) => option.id === 'doom'),
    )!;
    const spawns = (run: Run) => waveFighters(run).map((npc) => [npc.id, [...npc.position]]);

    it('lists every eligible pick, the options included, and accepts one off the offer at its next tier', () => {
      expect(seed).toBeDefined();
      const run = startRun(4, seed, {}, SET);
      const offer = runState(run).offer!;
      expect(offer.eligible).toEqual(
        eligibleColosseumModifierPicks({
          nextWave: 4,
          owned: new Map([['doom', 1]]),
          supported: SUPPORTED_WAVE_MODIFIERS,
        }),
      );
      for (const option of offer.options) expect(offer.eligible).toContainEqual(option);
      expect(offer.eligible).toContainEqual({ id: 'doom', tier: 2 });
      confirmAndStart(run, 'doom');
      expect(snapshotState(run).modifiers).toEqual({ doom: 2 });
      expect(runState(run).picks.at(-1)).toMatchObject({ origin: 'live', wave: 4, id: 'doom', tier: 2 });
    });

    it('rejects a maxed, wave-gated, withheld or unsupported pick', () => {
      const run = startRun(4, seed, {}, { doom: 3, volatility: 2 });
      const { offer, picks } = runState(run);
      // Doom III is maxed, Dynamic Duo waits for wave 7, Volatility III is withheld, Mantimayhem unsimulated.
      for (const id of ['doom', 'dynamicDuo', 'volatility', 'mantimayhem'] as const) {
        expect(offer!.eligible.some((pick) => pick.id === id)).toBe(false);
        confirm(run, id);
        step(run);
        expect(runState(run)).toMatchObject({ offer, picks });
      }
      confirm(run, offer!.eligible.at(-1)!.id);
      step(run);
      expect(runState(run).offer).toBeNull();
    });

    it('draws nothing: the wave and the next offer are those an on-offer pick meets', () => {
      const on = startRun(4, seed, {}, SET);
      const off = startRun(4, seed, {}, SET);
      // Neither changes the formation (Quartet) or the shockwaves (Dynamic Duo).
      const option = runState(on).offer!.options.find((candidate) => candidate.id !== 'quartet')!;
      expect(confirmAndStart(off, 'doom')).toBe(confirmAndStart(on, option.id));
      expect(spawns(off)).toEqual(spawns(on));
      clearWave(off);
      while (runState(off).offer === null) step(off);
      expect(runState(off).offer!.options).toEqual(
        drawColosseumModifierOffers({
          nextWave: 5,
          owned: new Map([['doom', 2]]),
          random: colosseumStreams.offers(seed, 5),
          supported: SUPPORTED_WAVE_MODIFIERS,
        }),
      );
    });
  });
});

describe('a practice wave start', () => {
  const WARBAND = /_(berserker|archer|seer|quartet)_/;
  const initial = (run: Run) =>
    waveFighters(run)
      .filter((npc) => !WARBAND.test(npc.id))
      .map((npc) => [npc.id.replace(/^colosseum_w\d+_|_\d+$/g, ''), [...npc.position]]);

  it("opens a wave start on its chosen floor tile, facing east, and a direct start on Sol's", () => {
    const tile = { [COLOSSEUM_START_TILE_KEY]: '30,40' };
    const run = startRun(3, 7, tile);
    expect(run.engine.getState()).toMatchObject({ playerPosition: [30, 40], playerFacingAngle: 1536 });
    const recorded = run.engine.getRunConfig().bootstrap;
    expect(recorded?.startPosition).toEqual([30, 40]);
    expect(recorded?.mechanicsConfig[COLOSSEUM_START_TILE_KEY]).toBe('30,40');
    // Off the floor (a pillar): the default.
    expect(startRun(3, 7, { [COLOSSEUM_START_TILE_KEY]: '40,27' }).engine.getState().playerPosition).toEqual([23, 38]);
    expect(startRun(12, 7, tile).engine.getState().playerPosition).toEqual([...SOL_PLAYER_START]);
    expect(new SolHereditEncounter(1).runStartMechanicsKeys).toEqual(
      expect.arrayContaining([COLOSSEUM_START_WAVE_KEY, COLOSSEUM_SPAWN_LAYOUT_KEY, COLOSSEUM_START_TILE_KEY]),
    );
    // Drawn by the setup control alone, never as a generic row.
    const toggles = buildSolHereditControls().mechanicsToggles.map(({ key }) => key);
    expect(toggles).not.toContain(COLOSSEUM_SPAWN_LAYOUT_KEY);
    expect(toggles).not.toContain(COLOSSEUM_START_TILE_KEY);
    expect(buildSolHereditControls().defaultMechanicsConfig).toMatchObject({
      [COLOSSEUM_SPAWN_LAYOUT_KEY]: '',
      [COLOSSEUM_START_TILE_KEY]: '',
    });
  });

  it('places the start wave from its layout, a too-close point included, and later waves at random', () => {
    // Wave 4: the shaman on (44,32), the manticore on (19,37), 4 from the start tile.
    const layout = { [COLOSSEUM_SPAWN_LAYOUT_KEY]: '4:s----------m' };
    const custom = startRun(4, 9, layout);
    const random = startRun(4, 9);
    confirmAndStart(custom);
    confirmAndStart(random);
    expect(initial(custom)).toEqual([
      ['serpentShaman', [44, 32]],
      ['manticore', [19, 37]],
    ]);
    expect(initial(random)).not.toEqual(initial(custom));
    for (const run of [custom, random]) {
      clearWave(run);
      confirmAndStart(run);
    }
    expect(initial(custom)).toEqual(initial(random));
  });

  it('ignores a layout for another wave, and takes one set on tick zero', () => {
    const plain = startRun(4, 9);
    const other = startRun(4, 9, { [COLOSSEUM_SPAWN_LAYOUT_KEY]: '5:s----------m' });
    const edited = startRun(4, 9);
    edited.engine.setMechanicsConfig({
      ...edited.engine.getMechanicsConfig(),
      [COLOSSEUM_SPAWN_LAYOUT_KEY]: '4:-m-s--------',
    });
    for (const run of [plain, other, edited]) confirmAndStart(run);
    expect(initial(other)).toEqual(initial(plain));
    expect(initial(edited)).toEqual([
      ['serpentShaman', [32, 27]],
      ['manticore', [29, 37]],
    ]);
  });

  it('publishes the setup it started with and the points each wave spawned on, which repeat it', () => {
    const custom = startRun(4, 9, {
      [COLOSSEUM_SPAWN_LAYOUT_KEY]: '4:s----------m',
      [COLOSSEUM_START_TILE_KEY]: '30,40',
    });
    expect(snapshotState(custom).runSetup).toEqual({
      startSpawnLayout: '4:s----------m',
      startPlayerTile: '30,40',
      // Nothing has spawned through the opening choice.
      waveSpawnLayout: '',
      waveStartPlayerTile: null,
    });
    confirmAndStart(custom);
    expect(snapshotState(custom).runSetup).toMatchObject({
      waveSpawnLayout: '4:s----------m',
      waveStartPlayerTile: [30, 40],
    });

    // A random wave publishes the points it drew, from the tile they were drawn clear of.
    const random = startRun(4, 9);
    expect(snapshotState(random).runSetup).toMatchObject({ startSpawnLayout: '', startPlayerTile: '23,38' });
    confirmAndStart(random);
    const spawned = snapshotState(random).runSetup!;
    expect(spawned.waveStartPlayerTile).toEqual([23, 38]);
    // Taken as a layout, it spawns that wave alike under any other seed.
    const repeated = startRun(4, 1234, { [COLOSSEUM_SPAWN_LAYOUT_KEY]: spawned.waveSpawnLayout });
    confirmAndStart(repeated);
    expect(initial(repeated)).toEqual(initial(random));

    // Cleared, the next wave has spawned nothing yet; then it publishes its own.
    clearWave(random);
    expect(snapshotState(random).runSetup).toMatchObject({ waveSpawnLayout: '', waveStartPlayerTile: null });
    confirmAndStart(random);
    expect(snapshotState(random).runSetup?.waveSpawnLayout).toMatch(/^5:/);
    expect(snapshotState(random).runSetup?.startSpawnLayout).toBe('');

    // A direct Sol start has no wave layout to publish.
    expect(snapshotState(startRun(12, 9)).runSetup).toBeUndefined();
  });
});

describe('where a wave starts its NPCs', () => {
  const WARBAND = /_(berserker|archer|seer|quartet)_/;
  /**
   * Wave 6 from seed `seed`, walking toward `before` until T0 and toward `onT0` on it: the tile the
   * player starts T0 on and the initial NPCs' SW tiles, in spawn order.
   */
  const startFor = (seed: number, before?: Coordinate, onT0?: Coordinate) => {
    const run = startRun(6, seed);
    while (runState(run).offer === null) step(run, before);
    confirm(run);
    step(run, before);
    const t0 = runState(run).waveStartTick!;
    while (run.engine.currentTick < t0 - 1) step(run, before);
    const tile = [...run.engine.getState().playerPosition] as Coordinate;
    step(run, onT0);
    const initial = waveFighters(run)
      .filter((npc) => npc.spawnTick === t0 && !WARBAND.test(npc.id))
      .map((npc) => [...npc.position]);
    const quartet = Boolean(snapshotState(run).modifiers.quartet);
    return { tile, initial, quartet };
  };

  it("draws the points clear of the player's tile at the start of T0, whatever they click on it", () => {
    for (let seed = 0; seed < 4; seed++) {
      for (const before of [undefined, [32, 34] as Coordinate]) {
        const still = startFor(seed, before);
        const plan = planColosseumWave({
          wave: 6,
          quartet: still.quartet,
          dynamicDuo: false,
          player: still.tile,
          random: colosseumStreams.layout(seed, 6),
        });
        expect(still.initial).toEqual(plan.initial.map((spawn) => spawn.position));
        expect(still.initial.every((point) => isSpawnPointClearOfPlayer(point as Coordinate, still.tile))).toBe(true);
        // Waiting, then moving on T0 itself, changes nothing.
        expect(startFor(seed, before, [44, 22]).initial).toEqual(still.initial);
      }
    }
    expect(startFor(0, [32, 34]).tile).toEqual([32, 34]);
  });
});

describe('wave completion and the intermission', () => {
  it('completes on the last fighter removal, clears temporary actors, then offers at Tc+3 without redrawing', () => {
    const run = startRun(1);
    const t0 = confirmAndStart(run);
    bindFighters(run);
    const [bee] = createBeeSwarms({ tier: 1, tick: t0, idPrefix: 'test_bees', random: () => 0 });
    Reflect.get(run.engine, 'spawnEncounterNpc').call(run.engine, bee);
    for (const npc of waveFighters(run)) kill(run, npc);
    step(run);
    const shaman = waveFighters(run).find((npc) => npc.id.includes('serpentShaman'))!;
    const removal = (shaman.deathAnimationTick ?? 0) + 3;
    expect(shaman.alive).toBe(false);
    const events = advanceTo(run, removal);
    const tc = runState(run).waveCompletedTick;
    expect(tc).toBe(Math.max(...[...events.keys()].filter((tick) => gameMessages(events.get(tick)).length > 0)));
    expect(gameMessages(events.get(tc!))).toEqual([
      waveCompletedMessage(1, tc! - t0)
        .map((segment) => segment.text)
        .join(''),
    ]);
    expect(run.world.getNpcs().filter((npc) => npc.id.startsWith('test_bees'))).toEqual([]);
    expect(runState(run)).toMatchObject({ stage: 'intermission', wave: 2, offer: null, waveStartTick: null });
    advanceTo(run, tc! + 2);
    expect(runState(run).offer).toBeNull();
    step(run);
    const offer = runState(run).offer;
    expect(offer?.wave).toBe(2);
    expect(offer?.options).toEqual(
      drawColosseumModifierOffers({
        nextWave: 2,
        owned: new Map([[runState(run).picks[0]!.id, 1]]),
        random: colosseumStreams.offers(7, 2),
        supported: SUPPORTED_WAVE_MODIFIERS,
      }),
    );
    advanceTo(run, tc! + 40);
    expect(runState(run).offer).toEqual(offer);
  });

  it('formats the completion line as m:ss.cc', () => {
    const text = (ticks: number) =>
      waveCompletedMessage(1, ticks)
        .map((segment) => segment.text)
        .join('');
    expect(text(28)).toBe('Wave 1 completed! Wave duration: 0:16.80');
    expect(text(267)).toBe('Wave 1 completed! Wave duration: 2:40.20');
  });

  it('reinforces at T0+66 unless the wave clears on that tick', () => {
    /** Kills the whole bound wave at `killTick` and reports the completion tick and any reinforcement. */
    const play = (killAt: (t0: number) => number) => {
      const run = startRun(1);
      const t0 = confirmAndStart(run);
      bindFighters(run);
      advanceTo(run, killAt(t0));
      for (const npc of waveFighters(run)) kill(run, npc);
      let tc: number | null = null;
      while (tc === null) {
        step(run);
        tc = runState(run).stage === 'intermission' ? runState(run).waveCompletedTick : null;
        if (run.engine.currentTick > t0 + 200) {
          for (const npc of waveFighters(run)) if (npc.alive) kill(run, npc);
        }
      }
      const jaguars = run.world.getNpcs().filter((npc) => npc.id.includes('jaguarWarrior'));
      return { t0, tc, jaguarAdded: jaguars.length > 0 || tc > t0 + 66 };
    };
    const probe = play((t0) => t0 + 10);
    const lag = probe.tc - (probe.t0 + 10);
    const tie = play((t0) => t0 + 66 - lag);
    expect(tie.tc).toBe(tie.t0 + 66);
    expect(tie.jaguarAdded).toBe(false);
    const late = play((t0) => t0 + 67 - lag);
    expect(late.tc).toBeGreaterThan(late.t0 + 66);
    expect(late.jaguarAdded).toBe(true);
  });

  it("adds the slow wave 1 its jaguar on T0+66 at the gate nearer the player's tile at the tick's start", () => {
    const isJaguar = (npc: { id: string }) => npc.id.includes('jaguarWarrior');
    /** Walks toward `target` until T0+66 and toward `onTick` on it; the tile it starts on and the jaguar. */
    const jaguarFor = (target?: Coordinate, onTick?: Coordinate) => {
      const run = startRun(1);
      const t0 = confirmAndStart(run);
      while (run.engine.currentTick < t0 + 65) step(run, target);
      expect(run.world.getNpcs().some(isJaguar)).toBe(false);
      const tile = [...run.engine.getState().playerPosition];
      step(run, onTick);
      expect(runState(run).reinforcementTick).toBeNull();
      return { tile, jaguar: run.world.getNpcs().find(isJaguar)?.position };
    };
    // Standing on the opening tile (23,38), nearer the north gate: the captured row, 48.
    const north = jaguarFor();
    expect(north.tile).toEqual([23, 38]);
    expect(north.jaguar?.[1]).toBe(48);
    expect([31, 32, 33]).toContain(north.jaguar?.[0]);
    // Walking south on T0+66 itself is too late to change the gate.
    expect(jaguarFor(undefined, [32, 22]).jaguar).toEqual(north.jaguar);
    // Standing nearer the south gate: the 2x2 jaguar's SW tile is row 20, in the column drawn at T0.
    const south = jaguarFor([32, 30]);
    expect(south.tile).toEqual([32, 30]);
    expect(south.jaguar).toEqual([north.jaguar?.[0], 20]);
  });
});

describe('modifiers across waves', () => {
  it('lowers max HP 99 -> 90 -> 80 from base at each wave start, without healing or touching supplies', () => {
    const seed = Array.from({ length: 300 }, (_, index) => index).find((candidate) =>
      drawColosseumModifierOffers({
        nextWave: 2,
        owned: new Map([['frailty', 1]]),
        random: colosseumStreams.offers(candidate, 2),
        supported: SUPPORTED_WAVE_MODIFIERS,
      }).some((offer) => offer.id === 'frailty'),
    );
    if (seed === undefined) throw new Error('No seed re-offers Frailty');
    const run = startRun(1, seed);
    const inventory = structuredClone(player(run).inventory);
    while (runState(run).offer === null) step(run);
    confirm(run, 'frailty');
    step(run);
    const t0 = runState(run).waveStartTick!;
    advanceTo(run, t0 - 1);
    expect(player(run).vitals).toEqual({ hp: 99, maxHp: 99 });
    step(run);
    expect(player(run).vitals).toEqual({ hp: 90, maxHp: 90 });
    clearWave(run);
    player(run).vitals.hp = 85;
    while (runState(run).offer === null) step(run);
    confirm(run, 'frailty');
    step(run);
    advanceTo(run, runState(run).waveStartTick!);
    expect(player(run).vitals).toEqual({ hp: 80, maxHp: 80 });
    expect(snapshotState(run).modifiers).toMatchObject({ frailty: 2 });
    expect(player(run).inventory).toEqual(inventory);
  });

  it('resets Doom points, not the tier, at the next wave start', () => {
    const run = startRun(3, 1, {}, { doom: 1 });
    Reflect.get(run.encounter, 'modifierState').doomStacks = 4;
    const t0 = confirmAndStart(run, runState(run).offer!.options.find((option) => option.id !== 'doom')!.id);
    expect(snapshotState(run).doomStacks).toBe(0);
    expect(snapshotState(run).modifiers.doom).toBe(1);
    expect(gameMessages(run.engine.getLastTickEvents())).toEqual(['Wave: 3', 'Your Doom points have reset to 0.']);
    expect(run.engine.currentTick).toBe(t0);
  });
});

describe('wave-stage modifier effects', () => {
  /** A wave run owning `forced` before its first wave starts. */
  function owning(forced: Record<string, number>, startWave = 2) {
    const run = startRun(startWave, 21);
    const modifiers = Reflect.get(run.encounter, 'modifierState') as ColosseumModifierState;
    for (const [id, tier] of Object.entries(forced)) {
      for (let next = (modifiers.selection[id] ?? 0) + 1; next <= tier; next++)
        modifiers.acceptModifier(id as ColosseumModifierId, next);
    }
    return run;
  }

  it('adds Bees five ticks into the wave and removes them, alive or not, on completion', () => {
    const run = owning({ bees: 2 });
    const t0 = confirmAndStart(run, runState(run).offer!.options.find((option) => option.id !== 'bees')!.id);
    const bees = () => run.world.getNpcs().filter((npc) => npc.id.startsWith(`colosseum_w2_bees`));
    advanceTo(run, t0 + 4);
    expect(bees()).toEqual([]);
    step(run);
    expect(bees().map((bee) => bee.spawnTick)).toEqual([t0 + 5, t0 + 5]);
    expect(snapshotState(run).beeTiles).toHaveLength(2);
    const tc = clearWave(run);
    expect(run.engine.currentTick).toBe(tc);
    expect(bees()).toEqual([]);
  });

  it('explodes a Volatility fighter on its removal tick and leaves its gib for three ticks', () => {
    const run = owning({ volatility: 2 });
    confirmAndStart(run, runState(run).offer!.options.find((option) => option.id !== 'volatility')!.id);
    bindFighters(run);
    const shaman = waveFighters(run).find((npc) => npc.id.includes('serpentShaman'))!;
    const tile: [number, number] = [shaman.position[0] + 1, shaman.position[1]];
    player(run).position = tile;
    run.world.occupancy.reconcile(run.world.actors.values());
    kill(run, shaman);
    step(run);
    const removal = (shaman.deathAnimationTick ?? 0) + 3;
    advanceTo(run, removal - 1);
    expect(run.world.getNpc(shaman.id)).toBe(shaman);
    const hpBefore = player(run).vitals.hp;
    const events = step(run, tile);
    expect(run.world.getNpc(shaman.id)).toBeFalsy();
    const gib = run.world.getNpcs().find((npc) => npc.npcTypeId === 12828);
    expect(gib?.position).toEqual(shaman.position);
    expect(
      events.some(
        (event) => isEncounterVisualEvent(event) && event.graphics.some((graphic) => graphic.spotAnimId === 2713),
      ),
    ).toBe(true);
    expect(
      events.some((event) => event.type === 'hitsplat_spawned' && event.targetId === 'player') ||
        player(run).vitals.hp < hpBefore,
    ).toBe(true);
    advanceTo(run, removal + 2);
    expect(run.world.getNpc(gib!.id)).toBe(gib);
    step(run);
    expect(run.world.getNpc(gib!.id)).toBeFalsy();
  });
});

describe('Solarflare and Totemic in the waves', () => {
  /** A run opening on wave 2 (wave 1's skipped pick is never either), owning `forced`. */
  function owning(forced: Record<string, number>) {
    const run = startRun(2, 21);
    const modifiers = Reflect.get(run.encounter, 'modifierState') as ColosseumModifierState;
    for (const [id, tier] of Object.entries(forced)) modifiers.acceptModifier(id as ColosseumModifierId, tier);
    const other = runState(run).offer!.options.find((option) => !(option.id in forced))!.id;
    return { run, t0: confirmAndStart(run, other) };
  }
  const orbs = (run: Run) => run.world.getNpcs().filter(solarflareDefinition.isActor);
  const totems = (run: Run) => run.world.getNpcs().filter(healingTotemDefinition.isActor);

  it('are offered going into waves 2-11', () => {
    const offered = new Set<string>();
    for (let seed = 0; seed < 40; seed++) {
      for (const wave of [2, 6, 11])
        for (const option of runState(startRun(wave, seed)).offer!.options) offered.add(option.id);
    }
    expect(offered).toContain('solarflare');
    expect(offered).toContain('totemic');
  });

  it('adds the four orbs at T0 on their captured corners and runs the captured tier-I lap', () => {
    const { run, t0 } = owning({ solarflare: 1 });
    expect(orbs(run).map((orb) => [(orb.spawnTick ?? -1) - t0, ...orb.position])).toEqual(
      CAPTURED_WAVE_SOLARFLARE.spawns.map(([x, y]) => [0, x, y]),
    );
    expect(snapshotState(run).solarflareTiles).toHaveLength(4);
    bindFighters(run);
    const track = new Map<number, readonly number[]>();
    while (run.engine.currentTick < t0 + 53) {
      step(run);
      track.set(run.engine.currentTick - t0, [...orbs(run)[0]!.position]);
    }
    expect(CAPTURED_WAVE_SOLARFLARE.firstOrbTrack.map(([offset]) => [offset, track.get(offset)])).toEqual(
      CAPTURED_WAVE_SOLARFLARE.firstOrbTrack,
    );
    clearWave(run);
    expect(orbs(run)).toEqual([]);
  });

  it('hits the player who starts a tick on the tile an orb leaves, a tick later', () => {
    const { run, t0 } = owning({ solarflare: 1 });
    bindFighters(run);
    const resolve = vi.spyOn(SolarflareDamageState.prototype, 'resolveTick');
    player(run).position = [38, 40];
    run.world.occupancy.reconcile(run.world.actors.values());
    step(run, [38, 40]);
    step(run, [38, 40]);
    const results = resolve.mock.results.map((result) => result.value as EnvironmentalDamage[]);
    resolve.mockRestore();
    expect(run.engine.currentTick).toBe(t0 + 2);
    expect(results.map((damages) => damages.map((damage) => damage.source))).toEqual([[], ['Solarflare']]);
  });

  it('refuses an orb as a target and as a ricochet hop, so it stays alive on its route', () => {
    const { run, t0 } = owning({ solarflare: 1 });
    bindFighters(run);
    const [orb] = orbs(run);
    expect(canInitiateAttackOnNpc(orb!, run.engine.currentTick)).toBe(false);
    // Venator shots at a fighter beside the orb: no hop may bounce to it.
    const shaman = waveFighters(run).find((npc) => npc.id.includes('serpentShaman'))!;
    shaman.position = [orb!.position[0] + 1, orb!.position[1]];
    player(run).position = [orb!.position[0] + 1, orb!.position[1] - 4];
    run.world.occupancy.reconcile(run.world.actors.values());
    run.engine.setEquipment({ weapon: VENATOR_BOW });
    run.engine.setCombatSupplies({ ...run.engine.getCombatSupplies(), equippedAmmo: { id: DRAGON_ARROW } });
    const stand = [...player(run).position] as Coordinate;
    // Clicking the orb sets no target at all.
    run.engine.setAttackTarget(orb!.id);
    expect(run.engine.getAttackTarget()).toBeNull();
    run.engine.setAttackTarget(shaman.id);
    const events: GameEvent[] = [];
    while (run.engine.currentTick < t0 + 12) events.push(...step(run, stand));
    const shots = events.filter(
      (event): event is Extract<CoreGameEvent, { type: 'attack_started' }> =>
        event.type === 'attack_started' && event.sourceId === 'player',
    );
    expect(shots.length).toBeGreaterThan(0);
    const targets = shots.flatMap((shot) => [shot.targetId, ...(shot.ricochets ?? []).map((hop) => hop.targetId)]);
    expect(targets).toContain(shaman.id);
    expect(targets).not.toContain(orb!.id);
    expect(events.some((event) => event.type === 'hitsplat_spawned' && event.targetId === orb!.id)).toBe(false);
    expect(orb!.alive).toBe(true);
    expect(orb!.vitals.hp).toBe(orb!.vitals.maxHp);
    expect(run.world.getNpc(orb!.id)).toBe(orb);
    expect(orb!.position).not.toEqual([...CAPTURED_WAVE_SOLARFLARE.spawns[0]!]);
  });

  it("leaves direct Sol's orbs as they were: refused by his rule, not flagged", () => {
    const run = startRun(12, 7, {}, { solarflare: 1 });
    while (orbs(run).length === 0) step(run);
    const validate = run.encounter.getEngineRules().validateAttack!;
    for (const orb of orbs(run)) {
      expect(orb.untargetable).toBeUndefined();
      expect(
        validate('range_arrow', orb.id, { tick: run.engine.currentTick, world: run.world, player: player(run) }),
      ).toBe(false);
    }
  });

  it('gives a fighter one totem on its half-HP tick, healing 30% of its max, gone when it dies', () => {
    const { run } = owning({ totemic: 1 });
    bindFighters(run);
    const javelin = waveFighters(run).find(javelinColossusDefinition.isActor)!;
    javelin.vitals.hp = javelin.vitals.maxHp / 2 + 1;
    step(run);
    expect(totems(run)).toEqual([]);
    javelin.vitals.hp = javelin.vitals.maxHp / 2;
    step(run);
    const [totem] = totems(run);
    expect(totem?.spawnTick).toBe(run.engine.currentTick);
    expect(totem?.state).toMatchObject({ targetId: javelin.id, healAmount: Math.floor(220 * 0.3) });
    expect(totem?.position).toEqual(healingTotemSpawnTile(javelin, () => true));
    // Healed back over half and hurt again: never a second totem (Run A, 54/54).
    javelin.vitals.hp = javelin.vitals.maxHp;
    step(run);
    javelin.vitals.hp = 10;
    step(run);
    expect(totems(run)).toEqual([totem]);
    kill(run, javelin);
    while (javelin.alive) step(run);
    expect(totems(run)).toEqual([]);
  });
});

describe('Dynamic Duo and Red Flag in the waves', () => {
  /** A run opening on wave 7 (no earlier offer can carry either), owning `forced`. */
  function owning(forced: readonly ColosseumModifierId[], seed = 5) {
    const run = startRun(7, seed);
    const modifiers = Reflect.get(run.encounter, 'modifierState') as ColosseumModifierState;
    for (const id of forced) modifiers.acceptModifier(id, 1);
    const other = runState(run).offer!.options.find((option) => !forced.includes(option.id))!.id;
    return { run, t0: confirmAndStart(run, other) };
  }
  const shockwaves = (run: Run) => run.world.getNpcs().filter(shockwaveColossusDefinition.isActor);
  const minotaurs = (run: Run) => run.world.getNpcs().filter(minotaurDefinition.isActor);

  it('pairs every shockwave with a partner on the layout tile, added right after it at T0', () => {
    for (let seed = 0; seed < 6; seed++) {
      const { run, t0 } = owning(['dynamicDuo'], seed);
      const layout = planColosseumWave({
        wave: 7,
        quartet: Boolean(snapshotState(run).modifiers.quartet),
        dynamicDuo: true,
        // The player stood still on the run's opening tile through T0.
        player: run.engine.getState().playerPosition,
        random: colosseumStreams.layout(seed, 7),
      });
      const pair = shockwaves(run);
      expect(pair.map((npc) => [npc.spawnTick, ...npc.position])).toEqual(
        layout.initial.filter((spawn) => spawn.species === 'shockwaveColossus').map((spawn) => [t0, ...spawn.position]),
      );
      const ids = waveFighters(run).map((npc) => npc.id);
      expect(ids.indexOf(pair[1]!.id)).toBe(ids.indexOf(pair[0]!.id) + 1);
    }
    expect(shockwaves(owning([]).run)).toHaveLength(1);
  });

  it('adds the wave minotaur as the routefinding 12813 with Red Flag, else 12812', () => {
    for (const [forced, npcTypeId] of [
      [['redFlag'], MINOTAUR_ROUTEFIND_NPC_ID],
      [[], MINOTAUR_NPC_ID],
    ] as const) {
      const { run, t0 } = owning(forced);
      bindFighters(run);
      advanceTo(run, t0 + 66);
      expect(minotaurs(run).map((npc) => [npc.spawnTick, npc.npcTypeId])).toEqual([[t0 + 66, npcTypeId]]);
    }
  });
});

describe('spawning', () => {
  const WAVE_WARBAND = /_(berserker|archer|seer|quartet)_/;
  /**
   * The spawn sequence each NPC added on the last tick plays from its `spawnTick`, by species: its render
   * config's `spawnSeqId` (facts spec NPC table), the presentation the renderer replays from the snapshot.
   */
  const spawnSequences = (run: Run) => {
    const tick = run.engine.currentTick;
    return run.world
      .getNpcs()
      .filter((npc) => npc.spawnTick === tick && !WAVE_WARBAND.test(npc.id))
      .map((npc) => [
        npc.id.replace(/^colosseum_w\d+_|_\d+$/g, ''),
        SOL_HEREDIT_RENDER_CONFIG.preloadNpcTypes?.find((type) => type.npcTypeId === npc.npcTypeId)?.spawnSeqId,
      ]);
  };

  it('plays each species its spawn sequence from the add tick, and adds the jaguar ahead of the shaman', () => {
    const run = startRun(6, 4);
    const t0 = confirmAndStart(run);
    // Wave 6: a shaman, a manticore and two javelin colossi, which have none.
    expect(spawnSequences(run).sort()).toEqual([
      ['javelinColossus', undefined],
      ['javelinColossus', undefined],
      ['manticore', 10871],
      ['serpentShaman', 10861],
    ]);
    // No cue stands in for it: the clip comes from the spawn tick alone.
    expect(
      run.engine
        .getLastTickEvents()
        .filter(isEncounterVisualEvent)
        .flatMap((event) => event.animations),
    ).toEqual([]);
    bindFighters(run);
    advanceTo(run, t0 + 66);
    // Processing order is registration order: the jaguar acts first (C:1864).
    expect(spawnSequences(run)).toEqual([
      ['jaguarWarrior', 10862],
      ['serpentShaman', 10861],
    ]);
  });
});

describe('javelin artillery', () => {
  it('lands a released javelin on T+6 after its colossus has died', () => {
    const run = startRun(2, 4);
    confirmAndStart(run);
    bindFighters(run);
    const javelin = waveFighters(run).find(javelinColossusDefinition.isActor)!;
    const target: [number, number] = [...run.engine.getState().playerPosition] as [number, number];
    // Released on T+3 (the colossus' own turn), then killed: A:2124, C:3359.
    javelin.state.artillery = { phase: 'released', castTick: run.engine.currentTick - 3, target };
    kill(run, javelin);
    const landing = run.engine.currentTick + 3;
    const blasts = (events: readonly GameEvent[] | undefined) =>
      (events ?? [])
        .filter(isEncounterVisualEvent)
        .flatMap((event) => event.graphics)
        .filter((graphic) => graphic.spotAnimId === JAVELIN_COLOSSUS_SPOTANIMS.artilleryBlast);
    const events = advanceTo(run, landing);
    expect(javelin.alive).toBe(false);
    expect(run.world.getNpc(javelin.id)).toBe(javelin);
    expect([...events].filter(([, tickEvents]) => blasts(tickEvents).length > 0).map(([tick]) => tick)).toEqual([
      landing,
    ]);
    expect(events.get(landing)?.some((event) => event.type === 'hitsplat_spawned' && event.targetId === 'player')).toBe(
      true,
    );
  });
});

describe('manticore order', () => {
  it('gives every manticore of a wave the one first style drawn for it', () => {
    const styles = new Set<string>();
    for (let seed = 0; seed < 12; seed++) {
      const run = startRun(9, seed);
      confirmAndStart(run);
      const manticores = run.world.getNpcs().filter((npc) => npc.archetypeId === 'colosseum_manticore');
      expect(manticores).toHaveLength(2);
      const firsts = new Set(manticores.map((npc) => npc.combat.attackStyle));
      expect(firsts.size).toBe(1);
      styles.add([...firsts][0]!);
    }
    expect(styles.size).toBe(2);
  });
});

describe('a manticore killed mid-throw', () => {
  /**
   * Wave 4 with its other fighters killed at T0, so only the manticore draws from the wave stream. Kills it on
   * K = its throw + 1 with a lethal hit, plus a trailing one when `promoted` (the hit queue then processes its
   * death on K and it loses its turn); counts each stream's draws on K-1..K+1.
   */
  function killMidThrow(promoted: boolean) {
    let tick = 0;
    const engineDraws = new Map<number, number>();
    const encounter = new SolHereditEncounter(7);
    const engine = new SimulationEngine({
      encounter,
      combatRandom: () => {
        engineDraws.set(tick, (engineDraws.get(tick) ?? 0) + 1);
        return 0.5;
      },
      mechanics: { infiniteHealth: true, [COLOSSEUM_START_WAVE_KEY]: '4' },
    });
    const run: Run = { encounter, engine, world: Reflect.get(engine, 'worldState') };
    confirmAndStart(run);
    const [manticore, ...others] = [...waveFighters(run)].sort(
      (a, b) => Number(manticoreDefinition.isActor(b)) - Number(manticoreDefinition.isActor(a)),
    );
    if (!manticore || !manticoreDefinition.isActor(manticore)) throw new Error('Wave 4 has no manticore');
    for (const npc of others) kill(run, npc);
    const waveRun = Reflect.get(encounter, 'run') as object;
    const stream = Reflect.get(waveRun, 'npcRandom') as () => number;
    const waveDraws = new Map<number, number>();
    Reflect.set(waveRun, 'npcRandom', () => {
      waveDraws.set(tick, (waveDraws.get(tick) ?? 0) + 1);
      return stream();
    });
    const events = new Map<number, readonly GameEvent[]>();
    const advance = () => {
      tick = engine.currentTick + 1;
      events.set(tick, step(run));
    };
    while (manticore.state.cycle.phase !== 'throwing') advance();
    const throwTick = engine.currentTick;
    const killTick = throwTick + 1;
    for (const rolledDamage of promoted ? [manticore.vitals.hp, 1] : [manticore.vitals.hp]) {
      enqueueEnginePendingHit(engine, {
        sourceId: 'player',
        targetId: manticore.id,
        style: 'typeless',
        attackKind: 'typeless',
        launchTick: throwTick,
        impactTick: killTick,
        rolledDamage,
        accuracySucceeded: true,
      });
    }
    while (engine.currentTick < killTick + 4) advance();
    const visuals = (at: number) => (events.get(at) ?? []).filter(isEncounterVisualEvent);
    const window = [killTick - 1, killTick, killTick + 1];
    return {
      manticore,
      killTick,
      launches: window.map((at) => visuals(at).flatMap((event) => event.projectiles).length),
      throwsAfter: [killTick, killTick + 1, killTick + 2].flatMap((at) =>
        visuals(at).flatMap((event) => event.animations.filter((cue) => cue.clipId === 'throw')),
      ),
      // The only manticore of the wave: neither the orb landing on K nor the one released on K lands.
      manticoreHits: engine.getDamageHistory().filter((hit) => hit.sourceNpcTypeId === manticore.npcTypeId),
      waveDraws: window.map((at) => waveDraws.get(at) ?? 0),
      engineDraws: window.map((at) => engineDraws.get(at) ?? 0),
    };
  }

  it('launches the orb due on its promoted kill turn from the wave stream, as the ordinary turn would', () => {
    const pending = killMidThrow(false);
    const promoted = killMidThrow(true);
    expect(pending.manticore.death).toMatchObject({ killTick: pending.killTick, processTick: pending.killTick + 1 });
    expect(promoted.manticore.death).toMatchObject({ killTick: promoted.killTick, processTick: promoted.killTick });
    for (const outcome of [pending, promoted]) {
      // The throw's first orb on K-1, the second (due on K) on K, and nothing after: no third orb, no new throw.
      expect(outcome.launches).toEqual([1, 1, 0]);
      expect(outcome.throwsAfter).toEqual([]);
      expect(outcome.manticoreHits).toEqual([]);
      expect(outcome.waveDraws).toEqual([2, 2, 0]);
      expect(outcome.engineDraws).toEqual([0, 0, 0]);
    }
  });
});

describe('a run from wave 1 into Sol', () => {
  it('plays 1 -> 12, keeping the player tile and state, then hands off at the captured offsets', () => {
    const run = startRun(1, 11);
    for (let wave = 1; wave <= 11; wave++) {
      while (runState(run).offer === null) step(run);
      // Walk somewhere new during the intermission; nothing moves the player at the wave start.
      const target: [number, number] = wave % 2 === 0 ? [23, 36] : [30, 40];
      confirm(run);
      while (runState(run).stage === 'intermission') step(run, target);
      const tile = [...run.engine.getState().playerPosition];
      expect(runState(run)).toMatchObject({ wave, stage: 'wave' });
      expect(tile).toEqual(target);
      expect(isWalkableTile(24, 36)).toBe(true);
      clearWave(run);
      expect(run.engine.getState().playerPosition).toEqual(tile);
    }
    while (runState(run).offer === null) step(run);
    expect(runState(run).offer?.wave).toBe(12);
    confirm(run);
    step(run);
    const t0 = runState(run).waveStartTick!;
    const events = advanceTo(run, t0);
    expect(gameMessages(events.get(t0)).some((text) => text.startsWith('Wave'))).toBe(false);
    const [handoff] = CAPTURED_SOL_HANDOFFS;
    const control = t0 + handoff.control;
    expect(runState(run)).toMatchObject({ wave: 12, stage: 'sol', solControlTick: control });
    const before = [...run.engine.getState().playerPosition];
    const jump = advanceTo(run, control);
    expect(gameMessages(jump.get(t0 + handoff.jumpMessage))).toEqual(['Sol Heredit jumps down from his seat...']);
    expect(run.engine.getState().playerPosition).toEqual([...handoff.playerTile]);
    expect(before).not.toEqual([...handoff.playerTile]);
    // Busy through the jump: a click on the jump ticks goes nowhere.
    expect(run.engine.didLastTickDiscardWalkTarget()).toBe(true);
    expect(run.world.getNpc(SOL_ACTOR_ID)?.spawnTick ?? run.world.getNpc(SOL_ACTOR_ID)?.position).toBeTruthy();
    expect(run.engine.getEncounterSnapshot().visuals).toEqual({ solControlTick: control });
    // The fence closes at C: the waves floor outside Sol's arena is no longer walkable.
    expect(isWalkableTile(24, 36)).toBe(false);
    expect(isWalkableTile(33, 31)).toBe(true);
    // No repeat of the jump message at C+1; the opening taunt follows at C+3.
    const opening = advanceTo(run, control + 3);
    expect(gameMessages(opening.get(control + 1))).toEqual([]);
    expect((opening.get(control + 3) ?? []).some((event) => event.type === 'overhead_text')).toBe(true);
    step(run, [30, 40]);
    expect(run.engine.didLastTickDiscardWalkTarget()).toBe(false);
  });

  it('wins on Sol death + 9 after the waves', () => {
    const run = startRun(11, 5);
    confirmAndStart(run);
    clearWave(run);
    confirmAndStart(run);
    const control = runState(run).solControlTick!;
    advanceTo(run, control + 2);
    const sol = run.world.getNpc(SOL_ACTOR_ID)!;
    kill(run, sol);
    step(run);
    const death = run.engine.currentTick;
    expect(run.engine.getEncounterOutcome()).toMatchObject({ phase: 'resolving', completionTick: death + 9 });
    advanceTo(run, death + 9);
    expect(run.engine.getEncounterOutcome().phase).toBe('victory');
  });
});

describe('snapshots', () => {
  it("carry the manticores' held orbs, and nothing while none is held", () => {
    const run = startRun(4, 2);
    confirmAndStart(run);
    expect(run.engine.getEncounterSnapshot().visuals).toEqual({ solControlTick: null });
    const manticore = run.world.getNpcs().find(manticoreDefinition.isActor)!;
    manticore.state.cycle = { phase: 'charged', chargeTick: run.engine.currentTick - 2 };
    const visuals = run.engine.getEncounterSnapshot().visuals as { heldOrbs?: readonly { actorId: string }[] };
    expect(visuals.heldOrbs).toEqual(manticoreHeldOrbs(manticore, run.engine.currentTick));
    expect(visuals.heldOrbs?.map((orb) => orb.actorId)).toEqual([manticore.id, manticore.id]);
  });

  it('stay plain, cloneable data through every stage', () => {
    const run = startRun(11, 3);
    const check = () => {
      const snapshot = run.engine.getEncounterSnapshot();
      expect(structuredClone(snapshot)).toEqual(snapshot);
      expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    };
    check();
    confirmAndStart(run);
    check();
    clearWave(run);
    check();
    confirmAndStart(run);
    advanceTo(run, runState(run).solControlTick! + 4);
    check();
  });
});
