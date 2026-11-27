import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../../../audio/AudioEngine';
import { EventAudioPlayer } from '../../../audio/EventAudioPlayer';
import { zukAudioRules } from '../../../audio/zukAudioRules';
import type { NpcActor } from '../../../core/actors/NpcActor';
import { notifyNpcOfPlayerAttack } from '../../../core/combat/retaliation';
import {
  clearResolvedArenaConfigs,
  getArenaConfig,
  setArenaConfig,
  setDefaultArenaConfig,
  setResolvedArenaConfig,
} from '../../../core/constants';
import { type DecisionKey, type DecisionOption, generatorDecisionRandom } from '../../../core/decisionRandom';
import type { EngineRunConfig } from '../../../core/engineRunConfig';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import { TickEvents } from '../../../core/events/TickEvents';
import { type GameEvent, isCoreEvent } from '../../../core/events/types';
import { recordNpcLethalTransition } from '../../../core/npcDeath';
import { ReplayRecorder } from '../../../core/ReplayRecorder';
import { mulberry32 } from '../../../core/rng';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { isZukAttackEvent } from '../../../npcs/inferno/events';
import { glyphDefinition } from '../../../npcs/inferno/glyph';
import { healerDefinition } from '../../../npcs/inferno/healer';
import { jadDefinition } from '../../../npcs/inferno/jad';
import { jadHealerDefinition } from '../../../npcs/inferno/jadHealer';
import { createRanger, rangerDefinition } from '../../../npcs/inferno/setMonsters';
import { createZuk, zukDefinition } from '../../../npcs/inferno/zuk';
import { EncounterCuePlayer } from '../../../render/effects/EncounterCuePlayer';
import { SpotAnimRenderer } from '../../../render/effects/SpotAnimRenderer';
import { diffResumableState } from '../../../replay/resumableState';
import { CollisionFlag } from '../../../rs/collision/CollisionFlag';
import { ObjType } from '../../../rs/config/objtype/ObjType';
import { DummyTypeLoader } from '../../../rs/config/TypeLoader';
import { enqueueEnginePendingHit } from '../../../test/helpers/pendingHits';
import { createZukWaveEncounter, zukDirector, zukWaveView } from '../../../test/helpers/zukWave';
import { createEmptyCombatSupplies } from '../../../types/encounterLoadout';
import { createDefaultStats } from '../../../types/playerState';
import { type Coordinate, PrayerType } from '../../../types/simulation';
import { InfernoEncounter } from '../../inferno/InfernoEncounter';
import { npcDecisionSeed } from '../../inferno/layout';
import { createSimulationEngineFromRunConfig, reconstructReplayPrefix } from '../../simulationEngineFactory';
import { type ZukSparkVolleyCommand, ZukSparkVolleyCommandSchema } from '../commands';
import { buildZukControls } from '../controls';
import { zukTargetsPlayer } from '../targeting';
import { ZUK_CAPTURE_BLASTS, ZUK_CAPTURE_GLYPH_X, ZUK_CAPTURE_TICKS, ZUK_SPARK_CAPTURE } from './zukCaptureFixtures';

afterEach(() => {
  vi.restoreAllMocks();
  clearResolvedArenaConfigs();
  setDefaultArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null });
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
});

function setup(seed = 7, combatRandom = () => 0.5) {
  const encounter = createZukWaveEncounter(seed);
  const engine = new SimulationEngine({ encounter, combatRandom });
  engine.setMechanicsConfig({ infiniteHealth: true });
  return { encounter, engine, world: engine['worldState'] };
}

function advance(engine: SimulationEngine, until: number) {
  for (let tick = engine.currentTick + 1; tick <= until; tick++) {
    engine.advanceTick(engine.getState().playerPosition);
    expect(engine.currentTick).toBe(tick);
  }
}

/** Capture C's wave-69 Jad healer tiles in spawn order (t877, C:14955-14960). */
const CAPTURED_JAD_HEALER_TILES: readonly Coordinate[] = [
  [30, 41],
  [31, 40],
  [30, 40],
];

/**
 * Forces the director's next Jad-healer draws onto `tiles`, in spawn order, for scenarios built on a
 * captured layout; each tile must be one the director offers. Re-apply after a reset (new director).
 */
function forceJadHealerTiles(encounter: InfernoEncounter, tiles = CAPTURED_JAD_HEALER_TILES): void {
  const queue = [...tiles];
  zukDirector(encounter)['jadHealerDecisions'] = {
    ...generatorDecisionRandom(() => {
      throw new TypeError('Unexpected unlabeled Jad healer draw');
    }),
    choose: <T>(_key: DecisionKey, options: readonly DecisionOption<T>[]): T => {
      const wanted = queue.shift();
      const option = options.find(({ value }) => {
        const [x, y] = value as unknown as Coordinate;
        return wanted?.[0] === x && wanted?.[1] === y;
      });
      if (!option) throw new TypeError(`Jad healer tile ${String(wanted)} was not offered`);
      return option.value;
    },
  };
}

function enableZukMovement(engine: SimulationEngine): void {
  const walkableTiles = new Set<string>();
  for (let tileX = 17; tileX <= 45; tileX++)
    for (let tileY = 17; tileY <= 46; tileY++) walkableTiles.add(`${tileX},${tileY}`);
  setResolvedArenaConfig('inferno', { ...getArenaConfig(), walkableTiles });
  engine.reapplyArenaConfig();
}

describe('Zuk initial shield direction', () => {
  it.each([0, 1])('creates the seeded patrol before configuration for seed %i', (seed) => {
    const encounter = createZukWaveEncounter(seed);

    const glyph = encounter.createNpcs().find(glyphDefinition.isActor);

    expect(glyph?.state.targetEndpoint).toBe(seed);
  });

  it.each([0, 1])("keeps seed %i's shield start through a Retry, whose attempt seed rolls Zuk afresh", (seed) => {
    const draws = (encounter: InfernoEncounter) => [
      zukDirector(encounter)['random'](),
      zukDirector(encounter)['random'](),
    ];
    const firstAttempt = mulberry32(seed);
    const encounter = createZukWaveEncounter(seed);
    expect(draws(encounter)).toEqual([firstAttempt(), firstAttempt()]);

    encounter.reset({ runSeed: seed, attemptSeed: 3 });
    expect(encounter.createNpcs().find(glyphDefinition.isActor)?.state.targetEndpoint).toBe(seed);
    const retried = mulberry32(npcDecisionSeed(seed, 3));
    const retriedDraws = draws(encounter);
    expect(retriedDraws).toEqual([retried(), retried()]);
    const runSeedStream = mulberry32(seed);
    expect(retriedDraws).not.toEqual([runSeedStream(), runSeedStream()]);
  });

  it.each(['left', 'random'])('applies tick-zero %s without consuming the encounter combat stream', (choice) => {
    const { engine, encounter } = setup(1);
    const random = mulberry32(1);

    engine.setMechanicsConfig({ zukShieldStart: choice });
    engine.advanceTick([31, 44]);

    expect(zukWaveView(engine)).toMatchObject({
      state: { shieldX: choice === 'left' ? 29 : 31, shieldMovingEast: choice !== 'left' },
    });
    expect([zukDirector(encounter)['random'](), zukDirector(encounter)['random']()]).toEqual([random(), random()]);
  });

  it.each(['left', 'right'] as const)('keeps active %s patrol when choice changes until the next attempt', (choice) => {
    const { engine } = setup(1);
    const nextChoice = choice === 'left' ? 'right' : 'left';
    engine.setMechanicsConfig({ zukShieldStart: choice });
    advance(engine, 5);

    engine.setMechanicsConfig({ zukShieldStart: nextChoice });
    advance(engine, 6);

    expect(zukWaveView(engine)).toMatchObject({
      state: { shieldX: choice === 'left' ? 24 : 36, shieldMovingEast: choice === 'right' },
    });
  });

  it.each(['left', 'right', 'random'] as const)('applies the latest %s choice on a fresh reset', (choice) => {
    const { engine } = setup(1);
    engine.setMechanicsConfig({ zukShieldStart: 'left' });
    advance(engine, 5);
    engine.setMechanicsConfig({ zukShieldStart: choice });
    vi.spyOn(Math, 'random').mockReturnValue(0);

    engine.reset();

    expect(zukWaveView(engine)).toMatchObject({
      state: { shieldX: 30, shieldNextX: choice === 'right' ? 31 : 29, shieldMovingEast: choice === 'right' },
    });
    engine.advanceTick([31, 44]);
    expect(zukWaveView(engine)).toMatchObject({ state: { shieldX: choice === 'right' ? 31 : 29 } });
  });

  it.each([
    'left',
    'right',
  ] as const)("respawns the glyph using the attempt's initial %s direction, not the changed setting", (choice) => {
    const { engine, world } = setup(1);
    engine.setMechanicsConfig({ zukShieldStart: choice, zukAttacks: false, zukSets: false });
    advance(engine, 20);
    engine.setMechanicsConfig({ zukShieldStart: choice === 'left' ? 'right' : 'left' });

    engine.executeEncounterCommand({ encounter: 'zuk', type: 'respawn-glyph' });
    advance(engine, 21);

    expect(world.getNpcs().find(glyphDefinition.isActor)?.position).toEqual([choice === 'left' ? 29 : 31, 48]);
  });
});

describe('Zuk set melee integration', () => {
  it.each([
    { type: 'spawn-mager', npcId: 7703, opening: 6, maxHit: 52, attackKind: 'melee_stab' },
    { type: 'spawn-ranger', npcId: 7702, opening: 8, maxHit: 19, attackKind: 'melee_crush' },
  ] as const)('resolves diagonal $type melee with protection on its action tick', ({
    type,
    npcId,
    opening,
    maxHit,
    attackKind,
  }) => {
    for (const prayer of [null, PrayerType.ProtectMelee, PrayerType.ProtectRange, PrayerType.ProtectMagic]) {
      const { engine, encounter, world } = setup();
      engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: false });
      engine.executeEncounterCommand({ encounter: 'zuk', type });
      const actor = world.getNpcs().find((npc) => npc.npcTypeId === npcId);
      const player = world.getPlayer();
      if (!actor || !player) throw new TypeError('Missing melee integration actors');
      player.position = [actor.position[0] + actor.size, actor.position[1] + actor.size];
      notifyNpcOfPlayerAttack(actor, {
        sourceId: player.id,
        launchTick: 0,
        impactTick: 1,
        style: 'range',
        accuracySucceeded: true,
      });
      const rolls = [0, 0, 0.999999];
      zukDirector(encounter)['random'] = () => {
        const roll = rolls.shift();
        if (roll === undefined) throw new TypeError('Unexpected set melee RNG draw');
        return roll;
      };
      advance(engine, opening - 1);
      engine.queueProtectionPrayer(prayer);

      const events = collectTickEvents(engine, opening);

      expect(events.filter((event) => event.type === 'attack_started')).toMatchObject([
        { tick: opening, attackKind, style: 'melee', impactDelayTicks: 0 },
      ]);
      expect(engine.getDamageHistory()).toMatchObject([
        {
          tick: opening,
          attackType: 'melee',
          effectiveDamage: prayer === PrayerType.ProtectMelee ? 0 : maxHit,
          prayedCorrectly: prayer === PrayerType.ProtectMelee,
        },
      ]);
      expect(player.vitals.hp).toBe(prayer === PrayerType.ProtectMelee ? 99 : 99 - maxHit);
      expect(rolls).toEqual([]);
    }
  });

  it('reconstructs seeded mixed-style set attacks after replay reset', () => {
    const position: Coordinate = [38, 40];
    const engine = new SimulationEngine({ encounter: createZukWaveEncounter(1), combatSeed: 31, startPos: position });
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: true });
    engine.setEquipment({});
    const config = engine.getRunConfig();
    const recorder = new ReplayRecorder();
    recorder.startRun(config);
    recorder.recordFrame(0, position, engine.getState(), []);
    const spawn = { type: 'encounterCommand', command: { encounter: 'zuk', type: 'spawn-ranger' } } as const;
    const engage = { type: 'attackTarget', targetId: 'zuk_ranger_0' } as const;
    for (const action of [spawn, engage]) {
      recorder.recordAction(action);
      engine.applyAction(action);
    }
    for (let tick = 1; tick <= 40; tick++) {
      if (tick === 2) {
        const stop = { type: 'attackTarget', targetId: null } as const;
        recorder.recordAction(stop);
        engine.applyAction(stop);
      }
      engine.advanceTick(position);
      recorder.recordFrame(tick, position, engine.getState(), engine.getLastTickEvents());
    }
    const recorded = recorder.exportData();
    const kinds = recorded.frames
      .flatMap((frame) => frame.events)
      .filter(isZukAttackEvent)
      .map((event) => event.attack);
    expect(kinds).toContain('ranger_melee');
    expect(kinds).toContain('ranger_range');
    const rebuilt = createSimulationEngineFromRunConfig(config, null);
    if (!rebuilt) throw new TypeError('Missing set melee replay engine');
    engine.reset(undefined, config);

    for (const frame of recorded.frames.slice(1)) {
      const hydrated = recorder.getFrame(frame.tick);
      if (!hydrated) throw new TypeError('Missing set melee replay frame');
      for (const target of [engine, rebuilt]) {
        for (const action of frame.actions) target.applyAction(action);
        target.advanceTick(frame.input);
        expect(diffResumableState(hydrated.state, target.getState())).toEqual([]);
        expect(target.getLastTickEvents().map(({ eventId: _eventId, ...event }) => event)).toEqual(
          frame.events.map(({ eventId: _eventId, ...event }) => event),
        );
      }
    }
  });
});

function setupLiveJad(seed = 0) {
  const scenario = setup(seed);
  scenario.engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: true });
  scenario.engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad' });
  const jad = scenario.world.getNpcs().find(jadDefinition.isActor);
  const player = scenario.world.getPlayer();
  if (!jad || !player) throw new TypeError('Missing live Jad actors');
  notifyNpcOfPlayerAttack(jad, {
    sourceId: player.id,
    launchTick: 0,
    impactTick: 1,
    style: 'range',
    accuracySucceeded: true,
  });
  return { ...scenario, jad, player };
}

function collectTickEvents(engine: SimulationEngine, until: number): GameEvent[] {
  const events: GameEvent[] = [];
  for (let tick = engine.currentTick + 1; tick <= until; tick++) {
    engine.advanceTick(engine.getState().playerPosition);
    expect(engine.currentTick).toBe(tick);
    events.push(...engine.getLastTickEvents());
  }
  return events;
}

function healingEvents(events: readonly GameEvent[]) {
  return events.flatMap((event) =>
    isCoreEvent(event, 'hitsplat_spawned') && event.hitsplatType === 'heal' ? [event] : [],
  );
}

function hit(engine: SimulationEngine, actorId: string, hp: number) {
  const actor = engine['worldState'].getNpc(actorId);
  if (!actor) throw new TypeError(`Missing test actor ${actorId}`);
  const hpBefore = actor.vitals.hp;
  actor.vitals.hp = hp;
  // The combat system's half of a lethal hit, which the engine's damage handler then reacts to.
  if (hpBefore > 0 && hp === 0) recordNpcLethalTransition(actor, engine.currentTick, 'hit-queue');
  engine['onCombatDamageApplied']({
    tick: engine.currentTick,
    sourceId: 'player',
    targetId: actorId,
    attackType: 'range',
    baseDamage: hpBefore - hp,
    effectiveDamage: hpBefore - hp,
    hpBefore,
    hpAfter: hp,
    activePrayer: null,
    prayedCorrectly: null,
  });
}

function launchPlayerHit(engine: SimulationEngine, targetId: string) {
  const world = engine['worldState'];
  const attacker = world.getPlayer();
  const target = world.getNpc(targetId);
  if (!attacker || !target) throw new TypeError('Missing queued player-hit actors');
  engine['combatSystem'].processAttackRequest(
    world,
    {
      attacker,
      target,
      attack: {
        style: 'range',
        attackKind: 'range_arrow',
        rolledDamage: 1,
        accuracySucceeded: true,
        impactDelayTicks: 1,
      },
    },
    engine['buildCombatBridge']({ enablePendingHits: true }),
  );
}

describe('Zuk practice HP presets', () => {
  it('offers full health and the exact HP immediately before each strict phase threshold', () => {
    const { world } = setup();

    const presets = buildZukControls().bossHpPresets;

    expect(presets?.map(({ label, hp }) => ({ label, hp }))).toEqual([
      { label: 'Start', hp: world.getNpc('zuk')?.vitals.maxHp },
      { label: 'Pre-Jad', hp: 480 },
      { label: 'Pre-Healers', hp: 240 },
    ]);
  });

  it.each([
    { hp: 1200, jadSpawned: false, enraged: false, setTimer: 72, timerPaused: false },
    { hp: 480, jadSpawned: false, enraged: false, setTimer: 350, timerPaused: true },
    { hp: 240, jadSpawned: true, enraged: false, setTimer: 525, timerPaused: false },
  ])('clears minions and preserves the player when selecting $hp HP', ({ hp, ...state }) => {
    const { engine, world } = setup();
    engine.setEquipment({ weapon: 20997 });
    advance(engine, 20);
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-set' });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad-healers' });
    const player = world.getPlayer();
    const oldGlyph = world.getNpc('zuk_shield');
    if (!player || !oldGlyph) throw new TypeError('Missing practice actors');
    player.position = [25, 44];
    player.vitals.hp = 61;
    oldGlyph.alive = false;
    oldGlyph.vitals.hp = 0;
    const playerBefore = structuredClone(player);
    const mechanicsBefore = engine.getMechanicsConfig();

    engine.applyAction({ type: 'applyBossHpPreset', hp });

    expect(world.getPlayer()).toEqual(playerBefore);
    expect(engine.getMechanicsConfig()).toEqual(mechanicsBefore);
    expect(engine.currentTick).toBe(20);
    expect(world.getNpc('zuk')).toMatchObject({ alive: true, vitals: { hp } });
    expect(zukWaveView(engine)).toMatchObject({
      state: { ...state, shieldX: 30 },
    });
    const glyph = world.getNpcs().find((npc) => npc.npcTypeId === 7707);
    expect(glyph).toMatchObject({ alive: true, vitals: { hp: 600 }, spawnTick: 20, position: [30, 48] });
    expect(glyph?.id).not.toBe(oldGlyph.id);
    const minions = world.getNpcs().filter((npc) => npc.role === 'minion');
    expect(minions).toEqual([]);
  });

  it.each(
    [1200, 480, 240].flatMap((hp) =>
      [10, 15, 20, 45].flatMap((tick) => ['left', 'right'].map((choice) => ({ hp, tick, choice }))),
    ),
  )('heals the living glyph without resetting its $choice patrol at tick $tick for $hp HP', ({ hp, tick, choice }) => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, zukShieldStart: choice });
    advance(engine, tick);
    engine.setMechanicsConfig({ zukAttacks: false, zukShieldStart: choice === 'left' ? 'right' : 'left' });
    const glyph = world.getNpcs().find(glyphDefinition.isActor);
    if (!glyph) throw new TypeError('Missing glyph fixture');
    glyph.vitals.hp = 80;
    const before = structuredClone(glyph);
    const nextPosition = glyph.position[0] + (glyph.state.targetEndpoint === 1 ? 1 : -1);

    engine.applyBossHpPreset(hp);

    expect(world.getNpc(glyph.id)).toBe(glyph);
    expect(glyph).toEqual({ ...before, vitals: { ...before.vitals, hp: before.vitals.maxHp } });
    advance(engine, before.state.nextMoveTick);
    expect(glyph.position).toEqual([nextPosition, 48]);
  });

  it.each(
    (['dead', 'missing'] as const).flatMap((condition) => [16, 25, 46].map((playerX) => ({ condition, playerX }))),
  )('recreates a $condition glyph at the canonical opening position regardless of player X=$playerX', ({
    condition,
    playerX,
  }) => {
    const { engine, world } = setup();
    const player = world.getPlayer();
    const oldGlyph = world.getNpcs().find(glyphDefinition.isActor);
    if (!player || !oldGlyph) throw new TypeError('Missing practice fixture');
    player.position = [playerX, 44];
    if (condition === 'missing') world.actors.delete(oldGlyph.id);
    else {
      oldGlyph.alive = false;
      oldGlyph.vitals.hp = 0;
    }

    engine.applyBossHpPreset(480);

    const glyphs = world.getNpcs().filter(glyphDefinition.isActor);
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0]).toMatchObject({ alive: true, position: [30, 48], vitals: { hp: 600 } });
    expect(glyphs[0].id).not.toBe(oldGlyph.id);
    // A fresh glyph at the canonical opening position re-anchors Zuk's cast clock to the same
    // encounter-open relationship (docs/encounters/zuk-facts-spec.md: first cast = spawn + 13).
    expect(world.getNpc('zuk')).toMatchObject({
      state: { glyphId: glyphs[0].id, lastCastTick: null, firstCastTick: 13 },
    });
    expect(player.position).toEqual([playerX, 44]);
  });

  it.each(
    [1200, 480, 240].flatMap((from) => [1200, 480, 240].map((hp) => ({ from, hp }))),
  )('reconstructs the phase when jumping from $from to $hp including repeated clicks', ({ from, hp }) => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    engine.applyAction({ type: 'applyBossHpPreset', hp: from });
    hit(engine, 'zuk', 239);
    advance(engine, 10);
    const glyph = world.getNpcs().find(glyphDefinition.isActor);
    const oldIds = world
      .getNpcs()
      .filter((npc) => npc.role === 'minion')
      .map((npc) => npc.id);

    engine.applyAction({ type: 'applyBossHpPreset', hp });

    expect(world.getNpcs().some((npc) => oldIds.includes(npc.id))).toBe(false);
    expect(world.getNpcs().filter((npc) => npc.role === 'minion')).toEqual([]);
    expect(world.getNpcs().find(glyphDefinition.isActor)).toBe(glyph);
    expect(zukWaveView(engine)).toMatchObject({
      state: { jadSpawned: hp < 480, enraged: false, setTimer: hp === 1200 ? 72 : hp === 480 ? 350 : 525 },
    });
  });

  it.each([
    { preset: 1200, hp: 480, jads: 0, healers: 0 },
    { preset: 1200, hp: 479, jads: 1, healers: 0 },
    { preset: 1200, hp: 240, jads: 1, healers: 0 },
    { preset: 1200, hp: 239, jads: 1, healers: 4 },
    { preset: 480, hp: 479, jads: 1, healers: 0 },
    { preset: 480, hp: 240, jads: 1, healers: 0 },
    { preset: 480, hp: 239, jads: 1, healers: 4 },
    { preset: 240, hp: 239, jads: 0, healers: 4 },
  ])('keeps natural transitions without duplicates after $preset then a player hit to $hp', ({
    preset,
    hp,
    jads,
    healers,
  }) => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    engine.applyAction({ type: 'applyBossHpPreset', hp: 239 });
    engine.applyAction({ type: 'applyBossHpPreset', hp: preset });
    // Arrange damage without applying the raw slider's threshold-skipping policy.
    world.getNpc('zuk')!.vitals.hp = hp + 1;
    launchPlayerHit(engine, 'zuk');

    advance(engine, 1);

    expect(world.getNpc('zuk')?.vitals.hp).toBe(hp);
    expect(world.getNpcs().filter(jadDefinition.isActor)).toHaveLength(jads);
    expect(world.getNpcs().filter(healerDefinition.isActor)).toHaveLength(healers);
  });

  it.each([
    { hp: 480, jadSpawned: false },
    { hp: 240, jadSpawned: true },
  ])('waits for a damaging hit when the preset action receives exactly $hp HP', ({ hp, jadSpawned }) => {
    const { engine, world } = setup();

    engine.applyAction({ type: 'applyBossHpPreset', hp });

    advance(engine, 5);
    expect(world.getNpcs().filter(jadDefinition.isActor)).toHaveLength(0);
    expect(world.getNpcs().filter(healerDefinition.isActor)).toHaveLength(0);
    expect(zukWaveView(engine)).toMatchObject({ state: { jadSpawned, enraged: false } });
  });

  it.each([
    480, 479, 240, 239,
  ])('marks skipped thresholds after raw slider edits to %i HP without spawns or enrage', (hp) => {
    const { engine, world } = setup();

    engine.applyAction({ type: 'setBossHp', hp });
    advance(engine, 1);

    expect(world.getNpcs().filter((npc) => npc.role === 'minion')).toEqual([]);
    expect(zukWaveView(engine)).toMatchObject({ state: { jadSpawned: hp < 480, enraged: false } });
    expect(zukDefinition.getState(world.getNpc('zuk')!)).toMatchObject({ healersSpawned: hp < 240 });
  });

  it.each([
    { hp: 350, jads: 0, healers: 0 },
    { hp: 200, jads: 0, healers: 0 },
    { hp: 480, jads: 1, healers: 0 },
    { hp: 240, jads: 0, healers: 4 },
  ])('does not replay skipped phases on a hit after a raw edit to $hp HP', ({ hp, jads, healers }) => {
    const { engine, world } = setup();
    engine.applyAction({ type: 'setBossHp', hp });
    launchPlayerHit(engine, 'zuk');

    advance(engine, 1);

    expect(world.getNpc('zuk')?.vitals.hp).toBe(hp - 1);
    expect(world.getNpcs().filter(jadDefinition.isActor)).toHaveLength(jads);
    expect(world.getNpcs().filter(healerDefinition.isActor)).toHaveLength(healers);
    expect(zukWaveView(engine)).toMatchObject({ state: { enraged: healers > 0 } });
  });

  it.each([
    { hp: 480, jads: 1, healers: 0 },
    { hp: 240, jads: 0, healers: 4 },
  ])('re-arms the threshold when the raw slider raises HP back to $hp', ({ hp, jads, healers }) => {
    const { engine, world } = setup();
    engine.setBossHp(200);
    engine.setBossHp(hp);
    launchPlayerHit(engine, 'zuk');

    advance(engine, 1);

    expect(world.getNpcs().filter(jadDefinition.isActor)).toHaveLength(jads);
    expect(world.getNpcs().filter(healerDefinition.isActor)).toHaveLength(healers);
  });

  it('preserves actors and the actual enrage clock when the raw slider moves across thresholds', () => {
    const { engine, world } = setup();
    hit(engine, 'zuk', 239);
    const actors = world.getNpcs();
    const boss = world.getNpc('zuk')!;
    const before = structuredClone(zukDefinition.getState(boss));

    engine.setBossHp(500);
    engine.setBossHp(200);

    expect(world.getNpcs()).toEqual(actors);
    expect(zukDefinition.getState(boss)).toEqual(before);
  });

  it('keeps an enraged cast due on the hit that re-triggers healers after a raw HP raise', () => {
    const { engine, world } = setup();
    advance(engine, 14);
    hit(engine, 'zuk', 239);
    const boss = world.getNpc('zuk')!;
    const state = zukDefinition.getState(boss)!;
    const enragedAt = state.enragedAt;
    expect(enragedAt).toBe(14);
    expect(state.lastCastTick).toBe(13);
    expect(world.getNpcs().filter(healerDefinition.isActor)).toHaveLength(4);
    advance(engine, 19);

    engine.setBossHp(240);
    launchPlayerHit(engine, 'zuk');
    const events = collectTickEvents(engine, 20);

    expect(boss.vitals.hp).toBe(239);
    expect(zukDefinition.getState(boss)).toMatchObject({ enragedAt });
    expect(
      events
        .filter(isZukAttackEvent)
        .filter((event) => event.sourceId === 'zuk')
        .map((event) => event.launchTick),
    ).toEqual([20]);
    const healers = world.getNpcs().filter(healerDefinition.isActor);
    expect(healers).toHaveLength(8);
    expect(healers.filter((healer) => healer.spawnTick === 20)).toHaveLength(4);
  });

  it.each([
    1200, 480, 240,
  ])('recovers an unsupported scheduler and freezes its new baseline while sets are disabled: %i', (hp) => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    engine.setBossHp(599);
    advance(engine, 1);
    engine.setBossHp(601);
    advance(engine, 2);
    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: null } });
    engine.setMechanicsConfig({ zukSets: false, zukAttacks: false, infiniteHealth: true });

    engine.applyAction({ type: 'applyBossHpPreset', hp });
    advance(engine, 5);
    engine.setMechanicsConfig({ zukSets: true, zukAttacks: false, infiniteHealth: true });

    const delay = hp === 1200 ? 72 : 525;
    if (hp === 480) {
      expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: 350, timerPaused: true } });
      hit(engine, 'zuk', 479);
      advance(engine, 6);
    }
    const resumedAt = hp === 480 ? 6 : 5;
    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: delay, timerPaused: false } });
    advance(engine, resumedAt + delay - 1);
    expect(world.getNpcs().filter((npc) => npc.npcTypeId === 7703)).toEqual([]);
    advance(engine, resumedAt + delay);
    expect(
      world
        .getNpcs()
        .filter((npc) => npc.npcTypeId === 7703)
        .map((npc) => npc.spawnTick),
    ).toEqual([resumedAt + delay]);
    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: 350, timerPaused: false } });
  });

  it.each([1200, 480, 240])('clears queued sparks, old healing and NPC hits when entering %i HP', (hp) => {
    const { engine, world } = prepareAutomaticSparks();
    advance(engine, 6);
    enqueueEnginePendingHit(engine, {
      sourceId: 'zuk',
      targetId: 'player',
      style: 'typeless',
      attackKind: 'typeless',
      launchTick: 6,
      impactTick: 7,
      rolledDamage: 10,
      accuracySucceeded: true,
    });

    engine.applyAction({ type: 'applyBossHpPreset', hp });
    advance(engine, 10);

    expect(world.getNpc('zuk')?.vitals.hp).toBe(hp);
    expect(engine.getDamageHistory().filter((entry) => entry.targetId === 'player')).toEqual([]);
  });

  // inferno-waves-tbow-69-zuk 590 -> 591, the one captured kill: no Zuk shot is in flight to the player
  // and none lands after it. Zuk and its scripted-dead minions keep their pre-commitment outcome.
  it('lands no Zuk or minion shot on the player after Zuk dies, even one due on the kill tick', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: false });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-set' });
    advance(engine, 1);
    const minion = world.getNpcs().find((npc) => npc.role === 'minion' && npc.npcTypeId === 7703);
    const zuk = world.getNpc('zuk');
    if (!minion || !zuk) throw new TypeError('Missing Zuk fixtures');
    const shot = (sourceId: string, impactTick: number) =>
      enqueueEnginePendingHit(engine, {
        sourceId,
        targetId: 'player',
        style: 'typeless',
        attackKind: 'typeless',
        launchTick: 1,
        impactTick,
        rolledDamage: 10,
        accuracySucceeded: true,
        sourceDeathPolicy: 'persist',
      });
    shot('zuk', 3);
    shot('zuk', 4);
    shot(minion.id, 4);
    zuk.vitals.hp = 1;
    enqueueEnginePendingHit(engine, {
      sourceId: 'player',
      targetId: 'zuk',
      style: 'range',
      attackKind: 'range_arrow',
      launchTick: 1,
      impactTick: 3,
      rolledDamage: 5,
      accuracySucceeded: true,
    });

    advance(engine, 5);

    expect(zuk.alive).toBe(false);
    expect(minion.alive).toBe(false);
    expect(engine.getState().playerHP).toBe(99);
    expect(engine.getDamageHistory().filter((entry) => entry.targetId === 'player')).toEqual([]);
  });

  it.each([1200, 480, 240])('does not revive an adjudicated Zuk defeat through preset %i', (hp) => {
    const { engine, world } = setup();
    engine.setBossHp(0);
    advance(engine, 1);
    const before = engine.getState();

    engine.applyAction({ type: 'applyBossHpPreset', hp });

    expect(engine.getState()).toEqual(before);
    expect(world.getNpc('zuk')).toMatchObject({ alive: false, vitals: { hp: 0 } });
  });

  it.each([1200, 480, 240])('reconciles the cast cadence to the living glyph after a preset %i', (hp) => {
    const { engine, world } = setup();
    advance(engine, 20);
    const boss = world.getNpc('zuk');
    if (!boss) throw new TypeError('Missing boss fixture');

    engine.applyAction({ type: 'applyBossHpPreset', hp });

    // The glyph is healed in place (never respawned), but Zuk's clock is still rebuilt from its
    // spawn tick (0) every time - this reproduces the same result an untouched clock would have
    // had here, and also self-heals a clock that had drifted (enrage, zukAttacks disable/re-enable,
    // or a prior manual shield reset that only touched the glyph).
    expect(zukDefinition.getState(boss)).toMatchObject({ lastCastTick: null, firstCastTick: 23 });
    const events = collectTickEvents(engine, 43);

    expect(
      events
        .filter(isZukAttackEvent)
        .filter((event) => event.sourceId === 'zuk')
        .map((event) => event.launchTick),
    ).toEqual([23, 33, 43]);
  });

  it.each([
    'left',
    'right',
  ] as const)('recreates a dead glyph at the remembered %s direction, not a mid-fight mechanics override', (choice) => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ infiniteHealth: true, zukShieldStart: choice });
    advance(engine, 20);
    const oldGlyph = world.getNpcs().find(glyphDefinition.isActor);
    if (!oldGlyph) throw new TypeError('Missing glyph fixture');
    oldGlyph.alive = false;
    oldGlyph.vitals.hp = 0;
    // A mid-fight config change must not reverse the attempt's remembered direction.
    engine.setMechanicsConfig({ infiniteHealth: true, zukShieldStart: choice === 'left' ? 'right' : 'left' });

    engine.applyAction({ type: 'applyBossHpPreset', hp: 480 });

    const glyph = world.getNpcs().find(glyphDefinition.isActor);
    const boss = world.getNpc('zuk');
    if (!boss) throw new TypeError('Missing boss fixture');
    expect(glyph).toMatchObject({
      alive: true,
      position: [30, 48],
      spawnTick: 20,
      state: { targetEndpoint: choice === 'left' ? 0 : 1, nextMoveTick: 21 },
    });
    expect(zukDefinition.getState(boss)).toMatchObject({ lastCastTick: null, firstCastTick: 33 });

    advance(engine, 21);
    expect(glyph?.position).toEqual([choice === 'left' ? 29 : 31, 48]);
    const events = collectTickEvents(engine, 43);
    expect(
      events
        .filter(isZukAttackEvent)
        .filter((event) => event.sourceId === 'zuk')
        .map((event) => event.launchTick),
    ).toEqual([33, 43]);
  });

  it('keeps the cast cadence anchored to a shield recreation through a later living-glyph preset', () => {
    const { engine, world } = setup();
    advance(engine, 20);
    const glyph = world.getNpcs().find(glyphDefinition.isActor);
    if (!glyph) throw new TypeError('Missing glyph fixture');
    glyph.alive = false;
    glyph.vitals.hp = 0;

    engine.applyAction({ type: 'applyBossHpPreset', hp: 480 });
    advance(engine, 25);
    engine.applyAction({ type: 'applyBossHpPreset', hp: 240 });

    const boss = world.getNpc('zuk');
    if (!boss) throw new TypeError('Missing boss fixture');
    expect(zukDefinition.getState(boss)).toMatchObject({ lastCastTick: null, firstCastTick: 33 });
    const events = collectTickEvents(engine, 43);
    expect(
      events
        .filter(isZukAttackEvent)
        .filter((event) => event.sourceId === 'zuk')
        .map((event) => event.launchTick),
    ).toEqual([33, 43]);
  });

  it('reconciles a living-glyph preset to the pre-enrage cadence, discarding a real enraged cast', () => {
    const { engine, world } = setup();
    advance(engine, 14);
    hit(engine, 'zuk', 239);
    advance(engine, 21);
    const boss = world.getNpc('zuk');
    if (!boss) throw new TypeError('Missing boss fixture');
    // A real enraged (7-tick) cast launched at 20. Retaining that as lastCastTick while merely
    // clearing enragedAt would schedule the next cast at 30 (20 + the now-10-tick interval) -
    // off the glyph's canonical 13/23/33/... cadence. Reconciling from the glyph's spawn tick
    // instead always lands back on that cadence, discarding the enrage-compressed history.
    expect(zukDefinition.getState(boss)).toMatchObject({ lastCastTick: 20, enragedAt: 14 });

    engine.applyAction({ type: 'applyBossHpPreset', hp: 1200 });

    expect(zukDefinition.getState(boss)).toMatchObject({ lastCastTick: null, firstCastTick: 23, enragedAt: null });
    const events = collectTickEvents(engine, 33);
    expect(
      events
        .filter(isZukAttackEvent)
        .filter((event) => event.sourceId === 'zuk')
        .map((event) => event.launchTick),
    ).toEqual([23, 33]);
  });

  it('reconciles a living-glyph preset after zukAttacks was disabled through the opening', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, infiniteHealth: true });
    advance(engine, 20);
    const boss = world.getNpc('zuk');
    if (!boss) throw new TypeError('Missing boss fixture');
    // Attacks were disabled the whole time, so Zuk's own clock never advanced past its initial
    // value - a stale clock that a naive re-enable would use as-is.
    expect(zukDefinition.getState(boss)).toMatchObject({ lastCastTick: null, firstCastTick: 13 });

    engine.applyAction({ type: 'applyBossHpPreset', hp: 1200 });
    engine.setMechanicsConfig({ zukAttacks: true, infiniteHealth: true });

    const events = collectTickEvents(engine, 33);
    expect(
      events
        .filter(isZukAttackEvent)
        .filter((event) => event.sourceId === 'zuk')
        .map((event) => event.launchTick),
    ).toEqual([23, 33]);
  });

  it('preserves an in-flight player hit when rebuilding the phase before impact', () => {
    const { engine, world } = setup();
    launchPlayerHit(engine, 'zuk');

    engine.applyAction({ type: 'applyBossHpPreset', hp: 480 });
    advance(engine, 1);

    expect(world.getNpc('zuk')?.vitals.hp).toBe(479);
    expect(world.getNpcs().filter(jadDefinition.isActor)).toHaveLength(1);
  });

  it('permits a phase jump before a slider death is adjudicated', () => {
    const { engine, world } = setup();
    engine.setBossHp(0);

    engine.applyAction({ type: 'applyBossHpPreset', hp: 240 });
    advance(engine, 1);

    expect(engine.getEncounterOutcome()).toEqual({ phase: 'active' });
    expect(world.getNpc('zuk')).toMatchObject({ alive: true, vitals: { hp: 240 } });
    expect(world.getNpcs().filter(healerDefinition.isActor)).toHaveLength(0);
  });

  it('replays repeated and backward preset actions with the same live combat and scheduler', () => {
    const engine = new SimulationEngine({ encounter: createZukWaveEncounter(7), combatSeed: 31 });
    engine.setMechanicsConfig({ infiniteHealth: true });
    const config = engine.getRunConfig();
    const recorder = new ReplayRecorder();
    recorder.startRun(config);
    recorder.recordFrame(0, engine.getState().playerPosition, engine.getState(), []);
    const jumps = new Map([
      [1, 480],
      [12, 240],
      [24, 240],
      [35, 1200],
      [40, 480],
    ]);
    const zukCastTicks: number[] = [];
    for (let tick = 1; tick <= 60; tick++) {
      const hp = jumps.get(tick);
      if (hp !== undefined) {
        const action = { type: 'applyBossHpPreset', hp } as const;
        recorder.recordAction(action);
        engine.applyAction(action);
      }
      engine.advanceTick(engine.getState().playerPosition);
      recorder.recordFrame(tick, engine.getState().playerPosition, engine.getState(), engine.getLastTickEvents());
      zukCastTicks.push(
        ...engine
          .getLastTickEvents()
          .filter(isZukAttackEvent)
          .filter((event) => event.sourceId === 'zuk')
          .map((event) => event.launchTick),
      );
    }
    // Rebuilding from the unchanged shield epoch must preserve the 13/23/33/... cadence.
    expect(zukCastTicks).toEqual([13, 23, 33, 43, 53]);
    const recorded = recorder.exportData();
    const rebuilt = createSimulationEngineFromRunConfig(config, null);
    if (!rebuilt) throw new TypeError('Missing practice replay engine');

    engine.reset(undefined, config);

    for (const frame of recorded.frames.slice(1)) {
      const hydrated = recorder.getFrame(frame.tick);
      if (!hydrated) throw new TypeError('Missing practice replay frame');
      for (const target of [engine, rebuilt]) {
        for (const action of frame.actions) target.applyAction(action);
        target.advanceTick(frame.input);
        expect(diffResumableState(hydrated.state, target.getState())).toEqual([]);
        expect(target.getLastTickEvents().map(({ eventId: _eventId, ...event }) => event)).toEqual(
          frame.events.map(({ eventId: _eventId, ...event }) => event),
        );
      }
    }
  });
});

function prepareAutomaticSparks(scenario = setup()) {
  const { engine, world } = scenario;
  engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: true });
  engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-healers' });
  const tagged = world.getNpcs().find((actor) => healerDefinition.isActor(actor) && actor.position[0] === 26);
  const player = world.getPlayer();
  if (!tagged || !player) throw new TypeError('Missing automatic spark actors');
  player.position = [26, 44];
  engine.setBossHp(500);
  advance(engine, 4);
  launchPlayerHit(engine, tagged.id);
  advance(engine, 5);
  expect(tagged.combat.targetId).toBe(player.id);
  return { ...scenario, tagged, player };
}

describe('Zuk victory lifecycle', () => {
  it.each([
    { elapsedTicks: 0, phase: 'resolving', canAdvance: true },
    { elapsedTicks: 5, phase: 'resolving', canAdvance: true },
    { elapsedTicks: 6, phase: 'victory', canAdvance: false },
  ] as const)('retains the death actor and reaches $phase when $elapsedTicks ticks follow a lethal hit', ({
    elapsedTicks,
    phase,
    canAdvance,
  }) => {
    const { engine } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    advance(engine, 2);
    engine.setBossHp(1);
    launchPlayerHit(engine, 'zuk');
    expect(engine.getEncounterOutcome()).toEqual({ phase: 'active' });

    const events = collectTickEvents(engine, 3 + elapsedTicks);

    expect(engine.getEncounterOutcome()).toEqual({
      phase,
      decisiveTick: 3,
      completionTick: 9,
      primaryActorId: 'zuk',
      completionActorIds: ['zuk'],
    });
    expect(engine.canAdvance()).toBe(canAdvance);
    expect(engine.getState().npcs.find((npc) => npc.id === 'zuk')).toMatchObject({
      alive: false,
      hp: 0,
      despawnTick: 3,
    });
    expect(events.filter((event) => isCoreEvent(event, 'actor_died') && event.actorId === 'zuk')).toEqual([
      expect.objectContaining({ tick: 3, actorId: 'zuk' }),
    ]);
    expect(engine.getDamageHistory()).toContainEqual(expect.objectContaining({ targetId: 'zuk', tick: 3, hpAfter: 0 }));
  });

  it('stops advancing when the delayed victory boundary has been reached', () => {
    const { engine } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    engine.setBossHp(1);
    launchPlayerHit(engine, 'zuk');
    advance(engine, 7);

    engine.advanceTick(engine.getState().playerPosition);

    expect(engine.currentTick).toBe(7);
    expect(engine.getEncounterOutcome()).toMatchObject({ phase: 'victory', decisiveTick: 1, completionTick: 7 });
  });

  it.each([4, 9])('clears the completion deadline when resetting at tick %i', (resetTick) => {
    const { engine } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    const config = engine.getRunConfig();
    advance(engine, 2);
    engine.setBossHp(1);
    launchPlayerHit(engine, 'zuk');
    advance(engine, resetTick);

    engine.reset(undefined, config);
    const events = collectTickEvents(engine, 10);

    expect(engine.getEncounterOutcome()).toEqual({ phase: 'active' });
    expect(engine.canAdvance()).toBe(true);
    expect(engine.getState().npcs.find((npc) => npc.id === 'zuk')).toMatchObject({ alive: true, hp: 1200 });
    expect(events.filter((event) => isCoreEvent(event, 'actor_died') && event.actorId === 'zuk')).toEqual([]);
    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: 62, timerPaused: false } });
  });

  it('keeps external completion active with cleanup when a lethal hit passes the victory deadline', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    engine.setCompletionOwnership('external-owned');
    advance(engine, 2);
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-set' });
    const minions = world.getNpcs().filter((npc) => npc.role === 'minion');
    engine.executeEncounterCommand({
      encounter: 'zuk',
      type: 'emit-spark-volley',
      sparks: [
        { position: [31, 44], amount: 5 },
        { position: [31, 44], amount: 5 },
        { position: [31, 44], amount: 5 },
      ],
    });
    engine.setBossHp(1);
    launchPlayerHit(engine, 'zuk');

    const events = collectTickEvents(engine, 80);

    expect(engine.getEncounterOutcome()).toEqual({ phase: 'active' });
    expect(engine.canAdvance()).toBe(true);
    expect(
      events.filter((event) => isCoreEvent(event, 'actor_died')).map((event) => [event.actorId, event.tick]),
    ).toEqual([['zuk', 3], ...minions.map((npc) => [npc.id, 3])]);
    expect(world.getNpcs().filter((npc) => npc.role === 'minion')).toEqual([]);
    expect(world.getNpc('zuk_shield')?.alive).toBe(true);
    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: null, timerPaused: false } });
    expect(engine.getDamageHistory().filter((entry) => entry.source === 'ZukSpark')).toEqual([]);
    expect(
      events.filter(isEncounterVisualEvent).flatMap((event) => event.graphics.filter((cue) => cue.spotAnimId === 659)),
    ).toEqual([]);
  });
});

describe('Zuk healer incoming lockout integration', () => {
  it.each([
    false,
    true,
  ])('refuses the tagged healer on its first-impact tick but permits zig-zag clicks queued during cooldown: %s', (alternate) => {
    const { engine, world } = setup(7, () => 0.05);
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-healers' });
    const [first, second] = world.getNpcs().filter(healerDefinition.isActor);
    const player = world.getPlayer();
    if (!first || !second || !player) throw new TypeError('Missing lockout actors');
    first.position = [30, 45];
    second.position = [32, 45];
    engine.setEquipment({ weapon: 12926 });
    engine.setSelectedAttackStyleIndex(1);
    engine.setCombatSupplies({ ...createEmptyCombatSupplies(), blowpipe: { id: 11230 } });
    player.equipmentStats = {
      ...player.equipmentStats,
      attackSpeed: 3,
      attackRange: 5,
      attackRanged: 70,
      rangedStrength: 80,
    };
    advance(engine, 15);
    engine.applyAction({ type: 'attackTarget', targetId: first.id });

    // Each follow-up click is processed one tick before the weapon is ready, as a player clicking
    // straight after seeing the previous launch would.
    const events = collectTickEvents(engine, 16);
    engine.applyAction({ type: 'attackTarget', targetId: alternate ? second.id : first.id });
    events.push(...collectTickEvents(engine, 18));
    if (alternate) engine.applyAction({ type: 'attackTarget', targetId: first.id });
    events.push(...collectTickEvents(engine, 20));
    if (alternate) {
      engine.applyAction({ type: 'attackTarget', targetId: second.id });
      events.push(...collectTickEvents(engine, 22));
    }

    expect(
      events
        .filter((event) => isCoreEvent(event, 'attack_started'))
        .filter((event) => event.sourceId === player.id)
        .map((event) => [event.tick, event.targetId]),
    ).toEqual(
      alternate
        ? [
            [16, first.id],
            [18, second.id],
            [20, first.id],
            [22, second.id],
          ]
        : [[16, first.id]],
    );
    expect(engine.getDamageHistory()).toContainEqual(expect.objectContaining({ targetId: first.id, tick: 18 }));
    expect(first.state.firstEngagementTick).toBe(18);
    expect(first.attackBlockedUntilTick).toBe(19);
    expect(second.state.firstEngagementTick).toBe(alternate ? 20 : null);
    expect(player.attackInteractionActive).toBe(alternate);
  });

  it('cancels a first-tag target before pursuing it and requires a fresh unlocked click', () => {
    const { engine, world } = setup(7, () => 0.05);
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-healers' });
    const first = world.getNpcs().find(healerDefinition.isActor);
    const player = world.getPlayer();
    if (!first || !player) throw new TypeError('Missing lockout actors');
    first.position = [30, 45];
    engine.setEquipment({ weapon: 12926 });
    engine.setSelectedAttackStyleIndex(1);
    engine.setCombatSupplies({ ...createEmptyCombatSupplies(), blowpipe: { id: 11230 } });
    player.equipmentStats = {
      ...player.equipmentStats,
      attackSpeed: 3,
      attackRange: 5,
      attackRanged: 70,
      rangedStrength: 80,
    };
    advance(engine, 15);
    engine.applyAction({ type: 'attackTarget', targetId: first.id });
    collectTickEvents(engine, 17);
    player.position = [31, 40];

    const events = collectTickEvents(engine, 22);

    expect(first.state.firstEngagementTick).toBe(18);
    expect(player.position).toEqual([31, 40]);
    expect(player).toMatchObject({ attackTarget: null, attackInteractionActive: false, manualCastSpell: null });
    expect(
      events.filter((event) => isCoreEvent(event, 'attack_started')).filter((event) => event.sourceId === player.id),
    ).toEqual([]);
    engine.applyAction({ type: 'attackTarget', targetId: first.id });
    const resumed = collectTickEvents(engine, 23);
    expect(resumed).toContainEqual(
      expect.objectContaining({ type: 'attack_started', sourceId: player.id, targetId: first.id }),
    );
  });

  it('spawns fresh unlocked healers after resetting during the first-tag window', () => {
    const { engine, world, tagged } = prepareAutomaticSparks();
    expect(tagged.attackBlockedUntilTick).toBe(6);
    const config = engine.getRunConfig();

    engine.reset(undefined, config);
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-healers' });

    const healers = world.getNpcs().filter(healerDefinition.isActor);
    expect(healers).toHaveLength(4);
    for (const healer of healers) {
      expect(healer.attackBlockedUntilTick).toBeUndefined();
      expect(healer.state.firstEngagementTick).toBeNull();
      expect(healer.combat.retaliation).toMatchObject({ pending: [], lastIncomingAttackTick: null });
    }
  });
});

describe('Zuk automatic spark integration', () => {
  it.each([
    false,
    true,
  ])('resolves independent generated 3x3 amounts before movement through prayer, early evasion: %s', (evade) => {
    const { engine, encounter, player } = prepareAutomaticSparks();
    const draws = [0, 0.25, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.999, 0.25, 0.999, 0.5, 0.5];
    const random = vi.fn(zukDirector(encounter)['random']);
    for (const draw of draws) random.mockReturnValueOnce(draw);
    zukDirector(encounter)['random'] = random;
    setArenaConfig({ ...getArenaConfig(), walkableTiles: new Set(['26,44', '26,43', '26,42']) });
    engine.queueProtectionPrayer(PrayerType.ProtectMagic);
    advance(engine, 6);
    const launched = engine
      .getLastTickEvents()
      .filter(isEncounterVisualEvent)
      .flatMap((event) => event.projectiles);
    expect(launched.map((cue) => cue.target.position)).toEqual([
      [27, 44],
      [26, 44],
      [25, 44],
    ]);
    expect(launched).toEqual(
      Array.from({ length: 3 }, () =>
        expect.objectContaining({
          spotAnimId: 660,
          sourcePosition: [26.5, 51.5],
          startDelayCycles: 0,
          endDelayCycles: 90,
          startOffset: 0,
          startHeight: 70,
          endHeight: 0,
        }),
      ),
    );
    expect(random).toHaveBeenCalledTimes(13);
    engine.advanceTick(evade ? [26, 42] : [26, 44]);
    advance(engine, 8);
    const hp = player.vitals.hp;

    engine.advanceTick([26, 42]);

    const damage = engine.getDamageHistory().filter((entry) => entry.source === 'ZukSpark');
    expect(damage.map((entry) => entry.effectiveDamage)).toEqual(evade ? [] : [5, 8, 10]);
    expect(player.position).toEqual([26, 42]);
    expect(player.vitals.hp).toBe(hp);
    for (const entry of damage)
      expect(entry).toMatchObject({
        tick: 9,
        playerPosition: [26, 44],
        activePrayer: PrayerType.ProtectMagic,
        attackType: 'typeless',
        prayedCorrectly: null,
      });
    expect(
      engine
        .getLastTickEvents()
        .filter(isEncounterVisualEvent)
        .flatMap((event) =>
          event.graphics
            .filter((cue) => cue.spotAnimId === 659)
            .map((cue) => cue.target.kind !== 'attached' && cue.target.position),
        ),
    ).toEqual([
      [27, 44],
      [26, 44],
      [25, 44],
    ]);
  });

  it('captures the pre-movement player tile when the automatic volley is launched', () => {
    const { engine, player } = prepareAutomaticSparks();
    setArenaConfig({ ...getArenaConfig(), walkableTiles: new Set(['26,44', '26,43', '26,42']) });

    engine.advanceTick([26, 42]);

    expect(player.position).toEqual([26, 42]);
    const targets = engine
      .getLastTickEvents()
      .filter(isEncounterVisualEvent)
      .flatMap((event) => event.projectiles.map((cue) => cue.target.position));
    expect(targets).toContainEqual([26, 44]);
    expect(targets).not.toContainEqual([26, 42]);
  });

  it.each([
    'death',
    'despawn',
    'clear-spawns',
  ] as const)('retains automatically launched sparks after source %s', (removal) => {
    const { engine, tagged } = prepareAutomaticSparks();
    advance(engine, 6);
    const launched = engine
      .getLastTickEvents()
      .filter(isEncounterVisualEvent)
      .flatMap((event) => event.projectiles);
    expect(launched).toHaveLength(3);

    switch (removal) {
      case 'death':
        hit(engine, tagged.id, 0);
        break;
      case 'despawn':
        engine['despawnEncounterNpc'](tagged.id);
        break;
      case 'clear-spawns':
        engine.executeEncounterCommand({ encounter: 'zuk', type: 'clear-spawns' });
        break;
      default:
        throw new TypeError(`Unhandled spark removal: ${removal satisfies never}`);
    }
    const events = collectTickEvents(engine, 12);

    expect(
      events
        .filter(isEncounterVisualEvent)
        .flatMap((event) =>
          event.graphics
            .filter((cue) => cue.spotAnimId === 659)
            .map((cue) => [event.tick, cue.target.kind !== 'attached' && cue.target.position]),
        ),
    ).toEqual(launched.map((cue) => [9, cue.target.position]));
    const damage = engine.getDamageHistory().filter((entry) => entry.source === 'ZukSpark');
    expect(damage.length).toBeGreaterThan(0);
    expect(damage.every((entry) => entry.tick === 9 && entry.effectiveDamage >= 5 && entry.effectiveDamage <= 10)).toBe(
      true,
    );
    expect(
      events.flatMap((event) => (event.type === 'zuk_healer_cast' && event.sourceId === tagged.id ? [event] : [])),
    ).toEqual([]);
  });

  it.each([
    'reset',
    'encounter-owned',
    'external-owned',
  ] as const)('cancels automatic landings on %s', (termination) => {
    const { engine, encounter } = prepareAutomaticSparks();
    const config = engine.getRunConfig();
    advance(engine, 6);
    expect(
      engine
        .getLastTickEvents()
        .filter(isEncounterVisualEvent)
        .flatMap((event) => event.projectiles),
    ).toHaveLength(3);

    switch (termination) {
      case 'reset':
        engine.reset(undefined, config);
        break;
      case 'encounter-owned':
      case 'external-owned':
        engine.setCompletionOwnership(termination);
        engine.setBossHp(0);
        break;
      default:
        throw new TypeError(`Unhandled spark termination: ${termination satisfies never}`);
    }
    for (let tick = 0; tick < 12; tick++) {
      engine.advanceTick(engine.getState().playerPosition);
      expect(
        engine
          .getLastTickEvents()
          .filter(isEncounterVisualEvent)
          .flatMap((event) => event.graphics.filter((cue) => cue.spotAnimId === 659)),
      ).toEqual([]);
    }

    expect(engine.getDamageHistory().filter((entry) => entry.source === 'ZukSpark')).toEqual([]);
    expect(zukDirector(encounter)['sparks']['pending']).toEqual([]);
  });

  it('plays one 155 cast and three 156 landings for a single live volley without a second cast sound', () => {
    const { engine, tagged, world } = prepareAutomaticSparks();
    for (const npc of world.getNpcs().filter(healerDefinition.isActor))
      if (npc.id !== tagged.id) engine['despawnEncounterNpc'](npc.id);
    const audio = new AudioEngine();
    const played = vi.spyOn(audio, 'play').mockImplementation(() => undefined);
    const audioPlayer = new EventAudioPlayer(audio, { name: 'zuk', rules: zukAudioRules });
    const events = collectTickEvents(engine, 6);
    engine['despawnEncounterNpc'](tagged.id);
    events.push(...collectTickEvents(engine, 9));

    audioPlayer.onEvents(events, [26, 46]);

    expect(events.flatMap((event) => (event.type === 'zuk_healer_cast' ? [event] : []))).toHaveLength(1);
    expect(played.mock.calls.map(([id]) => id)).toEqual([155, 156, 156, 156]);
  });

  it('launches three automatic sparks one tick after a real queued player hit and repeats every three ticks', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-healers' });
    const tagged = world.getNpcs().find((actor) => healerDefinition.isActor(actor) && actor.position[0] === 26);
    if (!tagged) throw new TypeError('Missing spark source');
    advance(engine, 4);
    launchPlayerHit(engine, tagged.id);
    expect(world.pendingHits).toContainEqual(expect.objectContaining({ targetId: tagged.id, impactTick: 5 }));

    const events = collectTickEvents(engine, 12);

    expect(engine.getDamageHistory()).toContainEqual(
      expect.objectContaining({ targetId: tagged.id, tick: 5, effectiveDamage: 1 }),
    );
    expect(
      events.flatMap((event) => (event.type === 'zuk_healer_cast' && event.sourceId === tagged.id ? [event.tick] : [])),
    ).toEqual([6, 9, 12]);
    const volleys = events
      .filter(isEncounterVisualEvent)
      .flatMap((event) =>
        event.projectiles.filter((cue) => cue.target.kind === 'tile').map((cue) => ({ tick: event.tick, ...cue })),
      );
    expect(volleys.map((cue) => cue.tick)).toEqual([6, 6, 6, 9, 9, 9, 12, 12, 12]);
    expect(volleys.every((cue) => cue.spotAnimId === 660)).toBe(true);
    expect(
      events
        .filter(isEncounterVisualEvent)
        .flatMap((event) => event.graphics.filter((cue) => cue.spotAnimId === 659).map(() => event.tick)),
    ).toEqual([9, 9, 9, 12, 12, 12]);
  });
});

describe('Zuk ordinary automatic sets', () => {
  it('admits the default opening at 72 and uncapped repeats every 350 without replacing living actors', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, infiniteHealth: true });
    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: 72, timerPaused: false } });
    advance(engine, 71);
    expect(world.getNpcs().filter((actor) => actor.role === 'minion')).toEqual([]);

    advance(engine, 3222);

    const sets = world.getNpcs().filter((actor) => actor.npcTypeId === 7703 || actor.npcTypeId === 7702);
    expect(sets.map((actor) => actor.spawnTick)).toEqual(
      Array.from({ length: 10 }, (_, index) => [72 + 350 * index, 72 + 350 * index]).flat(),
    );
    expect(sets.every((actor) => actor.alive)).toBe(true);
    expect(new Set(sets.map((actor) => actor.id)).size).toBe(20);
    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: 350, timerPaused: false } });
  });

  it('matches raw 98/448/539/795/1229 anchors with an exact-600 recovery and only one Jad bonus', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, infiniteHealth: true });
    engine.setBossHp(600);
    advance(engine, 512);
    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: 260, timerPaused: false } });
    engine.setBossHp(599);
    advance(engine, 513);
    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: 259, timerPaused: true } });
    engine.setBossHp(600);
    advance(engine, 768);
    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: 259, timerPaused: true } });
    hit(engine, 'zuk', 479);

    advance(engine, 769);

    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: 434, timerPaused: false } });
    const jad = world.getNpcs().find((actor) => actor.npcTypeId === 7704);
    if (!jad) throw new TypeError('Missing automatic Jad');
    hit(engine, jad.id, 0);
    engine.setBossHp(700);
    advance(engine, 800);
    hit(engine, 'zuk', 479);
    advance(engine, 1202);
    expect(
      world
        .getNpcs()
        .filter((actor) => actor.npcTypeId === 7703)
        .map((actor) => actor.spawnTick),
    ).toEqual([72, 422]);
    advance(engine, 1203);
    expect(
      world
        .getNpcs()
        .filter((actor) => actor.npcTypeId === 7703)
        .map((actor) => actor.spawnTick),
    ).toEqual([72, 422, 1203]);
    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: 350, timerPaused: false } });
  });

  it('pauses and resumes once when one post-opening hit crosses both thresholds', () => {
    const { engine } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    advance(engine, 100);
    hit(engine, 'zuk', 479);

    advance(engine, 101);

    expect(zukWaveView(engine)).toMatchObject({
      state: { setTimer: 496, timerPaused: false, jadSpawned: true },
    });
    hit(engine, 'zuk', 478);
    advance(engine, 102);
    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: 495, timerPaused: false } });
  });

  it.each([
    { tick: 1, remaining: 349, afterJad: 524, firstSet: 724 },
    { tick: 3, remaining: 347, afterJad: 522, firstSet: 722 },
    { tick: 20, remaining: 330, afterJad: 505, firstSet: 705 },
    { tick: 60, remaining: 290, afterJad: 465, firstSet: 665 },
    { tick: 72, remaining: 278, afterJad: 453, firstSet: 653 },
  ])('freezes repeat-based remaining when the opening is skipped at tick $tick', ({
    tick,
    remaining,
    afterJad,
    firstSet,
  }) => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, infiniteHealth: true });
    advance(engine, tick - 1);
    engine.setBossHp(599);

    advance(engine, tick);

    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: remaining, timerPaused: true } });
    expect(world.getNpcs().filter((actor) => actor.role === 'minion')).toEqual([]);
    advance(engine, 100);
    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: remaining, timerPaused: true } });
    engine.setBossHp(600);
    advance(engine, 199);
    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: remaining, timerPaused: true } });
    expect(world.getNpcs().filter((actor) => actor.role === 'minion')).toEqual([]);
    hit(engine, 'zuk', 479);
    advance(engine, 200);
    expect(zukWaveView(engine)).toMatchObject({
      state: { setTimer: afterJad, timerPaused: false, jadSpawned: true },
    });
    hit(engine, 'zuk', 478);
    advance(engine, 201);
    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: afterJad - 1, timerPaused: false } });
    advance(engine, firstSet - 1);
    expect(world.getNpcs().filter((actor) => actor.npcTypeId === 7703)).toEqual([]);
    advance(engine, firstSet + 350);
    expect(
      world
        .getNpcs()
        .filter((actor) => actor.npcTypeId === 7703)
        .map((actor) => actor.spawnTick),
    ).toEqual([firstSet, firstSet + 350]);
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-set' });
    expect(world.getNpcs().filter((actor) => actor.npcTypeId === 7703)).toHaveLength(3);
  });

  it.each([
    { tick: 1, remaining: 524, priorSets: [], firstSet: 525 },
    { tick: 60, remaining: 465, priorSets: [], firstSet: 525 },
    { tick: 72, remaining: 453, priorSets: [], firstSet: 525 },
    { tick: 422, remaining: 175, priorSets: [72], firstSet: 597 },
  ])('resolves a real player hit crossing both thresholds before set admission at tick $tick', ({
    tick,
    remaining,
    priorSets,
    firstSet,
  }) => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, infiniteHealth: true });
    advance(engine, tick - 1);
    engine.setBossHp(601);
    enqueueEnginePendingHit(engine, {
      sourceId: 'player',
      targetId: 'zuk',
      style: 'range',
      attackKind: 'range_arrow',
      launchTick: tick - 1,
      impactTick: tick,
      rolledDamage: 122,
      accuracySucceeded: true,
    });

    advance(engine, tick);

    expect(world.getNpc('zuk')?.vitals.hp).toBe(479);
    expect(engine.getDamageHistory()).toContainEqual(expect.objectContaining({ tick, targetId: 'zuk', hpAfter: 479 }));
    expect(
      world
        .getNpcs()
        .filter((actor) => actor.npcTypeId === 7703)
        .map((actor) => actor.spawnTick),
    ).toEqual(priorSets);
    expect(zukWaveView(engine)).toMatchObject({
      state: { setTimer: remaining, timerPaused: false, jadSpawned: true },
    });
    advance(engine, firstSet - 1);
    expect(
      world
        .getNpcs()
        .filter((actor) => actor.npcTypeId === 7703)
        .map((actor) => actor.spawnTick),
    ).toEqual(priorSets);
    advance(engine, firstSet);
    expect(
      world
        .getNpcs()
        .filter((actor) => actor.npcTypeId === 7703)
        .map((actor) => actor.spawnTick),
    ).toEqual([...priorSets, firstSet]);
  });

  it.each([
    false,
    true,
  ])('observes an early Jad while sets are disabled and resumes on enable, paused first: %s', (pausedFirst) => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    advance(engine, 20);
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: true });
    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: null, timerPaused: false } });
    if (pausedFirst) {
      engine.setBossHp(599);
      advance(engine, 30);
    }
    hit(engine, 'zuk', 479);
    advance(engine, 72);
    expect(zukWaveView(engine)).toMatchObject({
      state: { setTimer: null, timerPaused: false, jadSpawned: true },
    });
    expect(world.getNpcs().filter((actor) => actor.npcTypeId === 7703)).toEqual([]);

    engine.setMechanicsConfig({ zukAttacks: false, infiniteHealth: true });
    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: 505, timerPaused: false } });
    advance(engine, 576);
    expect(world.getNpcs().filter((actor) => actor.npcTypeId === 7703)).toEqual([]);
    advance(engine, 927);

    expect(
      world
        .getNpcs()
        .filter((actor) => actor.npcTypeId === 7703)
        .map((actor) => actor.spawnTick),
    ).toEqual([577, 927]);
  });

  it('retains the opening pause when re-enabled before Jad after observing low HP while disabled', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    advance(engine, 20);
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false });
    engine.setBossHp(599);
    advance(engine, 100);
    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: null, timerPaused: false } });

    engine.setMechanicsConfig({ zukAttacks: false });
    advance(engine, 200);

    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: 330, timerPaused: true } });
    expect(world.getNpcs().filter((actor) => actor.npcTypeId === 7703)).toEqual([]);
  });

  it('observes actual sampled healing across 600 before resolving the paused clock', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    advance(engine, 72);
    engine.setBossHp(590);
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-healers' });
    advance(engine, 79);
    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: 349, timerPaused: true } });

    advance(engine, 80);

    expect(world.getNpc('zuk')?.vitals.hp).toBeGreaterThan(600);
    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: null, timerPaused: false } });
  });

  it.each([20, 72])('marks pre-Jad healing above 600 unsupported when the clock pauses after tick %i', (tick) => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, infiniteHealth: true });
    advance(engine, tick);
    engine.setBossHp(599);
    advance(engine, tick + 1);
    engine.setBossHp(601);

    advance(engine, tick + 2);

    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: null, timerPaused: false } });
    hit(engine, 'zuk', 479);
    advance(engine, 1000);
    expect(world.getNpcs().filter((actor) => actor.npcTypeId === 7703)).toHaveLength(tick === 72 ? 1 : 0);
  });

  it.each([
    20, 72,
  ])('observes slider HP without inventing an automatic Jad phase from a manual Jad after tick %i', (tick) => {
    const { engine } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, infiniteHealth: true });
    advance(engine, tick);
    engine.setBossHp(480);
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad' });

    advance(engine, 500);

    expect(zukWaveView(engine)).toMatchObject({
      state: { setTimer: tick === 20 ? 329 : 349, timerPaused: true, jadSpawned: false },
    });
  });

  it('freezes disabled time and keeps all manual layout tools independent of the opening', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    advance(engine, 20);
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: true });
    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: null, timerPaused: false } });
    for (const type of ['spawn-set', 'replace-set', 'clear-spawns', 'respawn-glyph', 'spawn-jad'] as const)
      engine.executeEncounterCommand({ encounter: 'zuk', type });
    advance(engine, 1000);
    engine.setMechanicsConfig({ zukAttacks: false, infiniteHealth: true });
    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: 52, timerPaused: false } });

    advance(engine, 1052);

    expect(
      world
        .getNpcs()
        .filter((actor) => actor.npcTypeId === 7703)
        .map((actor) => actor.spawnTick),
    ).toEqual([1052]);
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: true });
    advance(engine, 2000);
    engine.setMechanicsConfig({ zukAttacks: false, infiniteHealth: true });
    advance(engine, 2350);
    expect(
      world
        .getNpcs()
        .filter((actor) => actor.npcTypeId === 7703)
        .map((actor) => actor.spawnTick),
    ).toEqual([1052, 2350]);
  });

  it('clears a due scheduler on boss death and restores the opening on a seeded reset', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    engine.setCompletionOwnership('external-owned');
    const config = engine.getRunConfig();
    advance(engine, 71);
    engine.setBossHp(0);
    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: null, timerPaused: false } });

    advance(engine, 500);

    expect(world.getNpcs().filter((actor) => actor.role === 'minion')).toEqual([]);
    engine.reset(undefined, config);
    expect(zukWaveView(engine)).toMatchObject({ state: { setTimer: 72, timerPaused: false } });
    advance(engine, 72);
    expect(
      world
        .getNpcs()
        .filter((actor) => actor.npcTypeId === 7703)
        .map((actor) => actor.spawnTick),
    ).toEqual([72]);
  });
});

describe('Zuk seeded healer amounts', () => {
  it('emits one parent 444 per application tick across concurrent casters, including full HP', () => {
    const { engine, world, encounter } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false });
    forceJadHealerTiles(encounter);
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-healers' });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad-healers' });
    const jad = world.getNpcs().find(jadDefinition.isActor);
    if (!jad) throw new TypeError('Missing Jad');

    const events = collectTickEvents(engine, 12);

    const graphics = events
      .filter(isEncounterVisualEvent)
      .flatMap((event) => event.graphics.map((cue) => ({ tick: event.tick, ...cue })));
    expect(graphics.filter((cue) => cue.spotAnimId === 444)).toEqual(
      [
        ...[1, 5, 9].map((tick) => ({
          tick,
          spotAnimId: 444,
          height: 256,
          delayCycles: 0,
          target: { kind: 'actor', actorId: jad.id, size: jad.size, position: jad.position },
        })),
        ...[8, 11].map((tick) => ({
          tick,
          spotAnimId: 444,
          height: 256,
          delayCycles: 0,
          target: { kind: 'actor', actorId: 'zuk', size: 7, position: [28, 52] },
        })),
      ].sort((left, right) => left.tick - right.tick),
    );
    expect(healingEvents(events)).toEqual([]);
    expect(events.filter((event) => event.type === 'zuk_hit')).toEqual([]);
  });

  it('delivers the live parent graphic to the renderer on the application cycle at height 256', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-healers' });
    const renderer = new SpotAnimRenderer();
    vi.spyOn(renderer, 'isLoaded').mockReturnValue(true);
    vi.spyOn(renderer, 'getFrameLengths').mockReturnValue([30]);
    const upsert = vi.spyOn(renderer, 'upsert');
    const controller = new EncounterCuePlayer(renderer);
    const events = collectTickEvents(engine, 8);

    controller.consumeEvents(events, engine.getState());
    controller.update({
      cycle: 240,
      resolveActor: (id) => world.getNpc(id)?.position ?? null,
      resolveAttachment: () => null,
      terrainHeights: null,
    });

    const parents = upsert.mock.calls.map(([effect]) => effect).filter((effect) => effect.spotAnimId === 444);
    expect(parents).toHaveLength(1);
    const graphic = parents[0];
    if (!graphic || graphic.transform.kind !== 'dynamic') throw new TypeError('Missing dynamic parent graphic');
    expect(graphic.transform.resolve(8, 8, null)).toEqual({ position: [31.5, 55.5, 2] });
    expect(graphic.lifecycle).toEqual({ kind: 'oneShot', startTick: 8, durationTicks: 1 });
  });

  it('plays the identified melee sound when the live Jad policy actually chooses melee', () => {
    const { engine, player, encounter } = setupLiveJad();
    player.position = [30, 34];
    zukDirector(encounter)['random'] = () => 0.9;
    const audio = new AudioEngine();
    const played = vi.spyOn(audio, 'play').mockImplementation(() => undefined);
    const audioPlayer = new EventAudioPlayer(audio, { name: 'zuk', rules: zukAudioRules });

    const events = collectTickEvents(engine, 8);
    audioPlayer.onEvents(events, player.position);

    expect(events.filter(isZukAttackEvent)).toMatchObject([{ attack: 'jad_melee', tick: 8 }]);
    expect(played).toHaveBeenCalledExactlyOnceWith(408, { channel: 'sfx', volume: 1 }, 'event:zuk_attack');
  });

  it('keeps separate parents on the same tick and resets parent graphic ownership with the encounter', () => {
    const { engine, world, encounter } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false });
    const config = engine.getRunConfig();
    for (let run = 0; run < 2; run++) {
      forceJadHealerTiles(encounter);
      engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad-healers' });
      engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad' });
      const parents = world.getNpcs().filter(jadDefinition.isActor);
      const children = world.getNpcs().filter(jadHealerDefinition.isActor);
      const secondParent = parents[1];
      const secondChild = children[2];
      if (!secondParent || !secondChild) throw new TypeError('Missing second parent');
      secondChild.state.supportTargetId = secondParent.id;

      engine.advanceTick(engine.getState().playerPosition);

      const graphics = engine
        .getLastTickEvents()
        .filter(isEncounterVisualEvent)
        .flatMap((event) => event.graphics);
      expect(graphics.filter((cue) => cue.spotAnimId === 444).map((cue) => cue.target)).toEqual(
        parents.map((parent) => ({ kind: 'actor', actorId: parent.id, size: parent.size, position: parent.position })),
      );
      engine.reset(undefined, config);
    }
  });

  it.each([
    'dead',
    'missing',
  ] as const)('emits no parent graphic when pending healing targets a %s parent', (condition) => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-healers' });
    advance(engine, 4);
    const boss = world.getNpc('zuk');
    if (!boss) throw new TypeError('Missing Zuk');
    if (condition === 'dead') boss.alive = false;
    else world.actors.delete(boss.id);

    const events = collectTickEvents(engine, 8);

    expect(
      events
        .filter(isEncounterVisualEvent)
        .flatMap((event) => event.graphics)
        .filter((cue) => cue.spotAnimId === 444),
    ).toEqual([]);
  });

  it('plays exactly one existing delayed area cast for each tagged and supporting healer action', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-healers' });
    const [tagged, ...supporting] = world.getNpcs().filter(healerDefinition.isActor);
    if (!tagged) throw new TypeError('Missing healer');
    tagged.position = [31, 51];
    for (const actor of supporting) actor.position = [32, 51];
    advance(engine, 4);
    notifyNpcOfPlayerAttack(tagged, {
      sourceId: 'player',
      launchTick: 4,
      impactTick: 5,
      style: 'range',
      accuracySucceeded: true,
    });
    const audio = new AudioEngine();
    const played = vi.spyOn(audio, 'play').mockImplementation(() => undefined);
    const audioPlayer = new EventAudioPlayer(audio, { name: 'zuk', rules: zukAudioRules });

    const events = collectTickEvents(engine, 9);
    audioPlayer.onEvents(events, [31, 51]);

    const casts = events.flatMap((event) =>
      event.type === 'zuk_healer_cast' ? [{ sourceId: event.sourceId, tick: event.tick }] : [],
    );
    expect(casts.map((event) => [event.sourceId, event.tick])).toEqual([
      [tagged.id, 6],
      ...supporting.map((actor) => [actor.id, 7]),
      [tagged.id, 9],
    ]);
    const castSounds = played.mock.calls.filter(([id]) => id === 155);
    expect(castSounds).toHaveLength(5);
    expect(
      castSounds.every(
        ([id, options, source]) =>
          id === 155 && options?.channel === 'area' && options.delayMs === 1020 && source === 'event:zuk_healer_cast',
      ),
    ).toBe(true);
  });

  it.each([
    0, 0.999999,
  ])('keeps Jad healing at 10 while sampling enrage healing at %s with distinct application clocks', (roll) => {
    const { engine, world, encounter } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false });
    zukDirector(encounter)['random'] = () => roll;
    forceJadHealerTiles(encounter);
    engine.setBossHp(500);
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-healers' });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad-healers' });
    const jad = world.getNpcs().find((actor) => actor.npcTypeId === 7704);
    if (!jad) throw new TypeError('Missing support target');
    jad.vitals.hp = 100;
    const amount = roll === 0 ? 15 : 24;

    const events = collectTickEvents(engine, 8);

    const heals = healingEvents(events);
    expect(heals.map((event) => [event.tick, event.targetId, event.amount])).toEqual([
      [1, jad.id, 10],
      [1, jad.id, 10],
      [5, jad.id, 10],
      [5, jad.id, 10],
      ...Array.from({ length: 4 }, () => [8, 'zuk', amount]),
    ]);
    expect(jad.vitals.hp).toBe(140);
    expect(world.getNpc('zuk')?.vitals.hp).toBe(500 + amount * 4);
    expect(events.filter((event) => event.type === 'zuk_hit')).toEqual([]);
    expect(events.filter((event) => event.type === 'zuk_healer_cast').map((event) => event.tick)).toEqual([
      4, 4, 4, 4, 7, 7, 7, 7,
    ]);
  });

  it('caps both real support policies at full HP', () => {
    const { engine, world, encounter } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false });
    forceJadHealerTiles(encounter);
    engine.setBossHp(1199);
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-healers' });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad-healers' });
    const jad = world.getNpcs().find((actor) => actor.npcTypeId === 7704);
    if (!jad) throw new TypeError('Missing support target');
    jad.vitals.hp = 349;

    const events = collectTickEvents(engine, 20);

    expect(healingEvents(events)).toEqual([
      expect.objectContaining({ tick: 1, targetId: jad.id, amount: 1 }),
      expect.objectContaining({ tick: 8, targetId: 'zuk', amount: 1 }),
    ]);
    expect(jad.vitals.hp).toBe(350);
    expect(world.getNpc('zuk')?.vitals.hp).toBe(1200);
  });

  it('stops Jad healing while an adjacent healer fights the player and stays stopped on source death', () => {
    const { engine, world, encounter } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: true });
    forceJadHealerTiles(encounter);
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad-healers' });
    const jad = world.getNpcs().find((actor) => actor.npcTypeId === 7704);
    const healer = world
      .getNpcs()
      .filter(jadHealerDefinition.isActor)
      .find((actor) => actor.position[0] === 31);
    const player = world.getPlayer();
    if (!jad || !healer || !player) throw new TypeError('Missing concurrent support actors');
    for (const actor of world.getNpcs().filter(jadHealerDefinition.isActor))
      if (actor !== healer) world.actors.delete(actor.id);
    jad.vitals.hp = 100;
    player.position = [31, 41];
    notifyNpcOfPlayerAttack(healer, {
      sourceId: 'player',
      launchTick: 0,
      impactTick: 1,
      style: 'range',
      accuracySucceeded: false,
    });

    const events = collectTickEvents(engine, 5);

    const heals = healingEvents(events);
    expect(heals).toEqual([]);
    expect(jad.vitals.hp).toBe(100);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'attack_started', sourceId: healer.id, style: 'melee' }),
    );
    hit(engine, healer.id, 0);
    expect(healingEvents(collectTickEvents(engine, 10))).toEqual([]);
  });

  it('keeps already-cast healing after retarget but cancels a dead source and schedules no new tagged heals', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false });
    engine.setBossHp(500);
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-healers' });
    const [tagged, dead, ...siblings] = world.getNpcs().filter(healerDefinition.isActor);
    if (!tagged || !dead) throw new TypeError('Missing healing actors');
    advance(engine, 4);
    const taggedAmount = tagged.state.pendingHeals[0]?.amount;
    const siblingAmounts = siblings.flatMap((actor) => actor.state.pendingHeals.map((heal) => heal.amount));
    notifyNpcOfPlayerAttack(tagged, {
      sourceId: 'player',
      launchTick: 4,
      impactTick: 5,
      style: 'range',
      accuracySucceeded: true,
    });
    hit(engine, dead.id, 0);

    const events = collectTickEvents(engine, 11);

    const heals = healingEvents(events);
    expect(heals.filter((event) => event.tick === 8).map((event) => event.amount)).toEqual([
      taggedAmount,
      ...siblingAmounts,
    ]);
    expect(heals.filter((event) => event.tick === 11)).toHaveLength(2);
    expect(
      events
        .flatMap((event) => (event.type === 'zuk_healer_cast' ? [event.sourceId] : []))
        .every((sourceId) => sourceId === tagged.id || siblings.some((actor) => actor.id === sourceId)),
    ).toBe(true);
  });
});

describe('Zuk evidence-bounded encounter', () => {
  it('resolves supplied spark contributions once at cast+3 before movement through protection prayer', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    setArenaConfig({ ...getArenaConfig(), walkableTiles: new Set(['31,44', '32,44', '33,44']) });
    engine.queueProtectionPrayer(PrayerType.ProtectMagic);
    engine.executeEncounterCommand({
      encounter: 'zuk',
      type: 'emit-spark-volley',
      sparks: [
        { position: [32, 45], amount: 9 },
        { position: [32, 45], amount: 6 },
        { position: [34, 44], amount: 10 },
      ],
    });
    advance(engine, 2);
    expect(engine.getDamageHistory()).toEqual([]);

    engine.advanceTick([33, 44]);

    expect(world.getPlayer()?.position).toEqual([33, 44]);
    expect(engine.getDamageHistory()).toEqual(
      [9, 6].map((amount) =>
        expect.objectContaining({
          tick: 3,
          source: 'ZukSpark',
          baseDamage: amount,
          effectiveDamage: amount,
          attackType: 'typeless',
          activePrayer: PrayerType.ProtectMagic,
          prayedCorrectly: null,
          playerPosition: [31, 44],
        }),
      ),
    );
    expect(collectTickEvents(engine, 6).filter((event) => event.type === 'hit_applied')).toEqual([]);
    expect(engine.getLastTickEvents().filter(isEncounterVisualEvent)).toEqual([]);
  });

  it.each([true, false])('ignores Yama default arena data with bounds present: %s', (hasBounds) => {
    setDefaultArenaConfig({
      bounds: hasBounds ? { minX: 17, maxX: 44, minY: 0, maxY: 45, width: 28, height: 46 } : null,
      walkableTiles: new Set(['29,35']),
      collisionMap: null,
    });

    const { encounter } = setup();

    const expected = {
      bounds: { minX: 17, maxX: 45, minY: 17, maxY: 46, width: 29, height: 30 },
      walkableTiles: null,
      collisionMap: null,
    };
    expect(encounter.getArenaConfig()).toEqual(expected);
    expect(getArenaConfig()).toEqual(expected);
  });

  it('applies the resolved Zuk arena after startup rather than the global Yama default', () => {
    const { engine } = setup();
    setDefaultArenaConfig({
      bounds: { minX: 17, maxX: 44, minY: 0, maxY: 45, width: 28, height: 46 },
      walkableTiles: new Set(['29,35']),
      collisionMap: null,
    });
    const resolved = {
      bounds: { minX: 18, maxX: 44, minY: 18, maxY: 46, width: 27, height: 29 },
      walkableTiles: new Set(['31,44', '32,44']),
      collisionMap: null,
    };
    setResolvedArenaConfig('inferno', resolved);

    engine.reapplyArenaConfig();

    expect(getArenaConfig()).toEqual(resolved);
  });

  it.each([true, false])('uses the configured exposure predicate when it returns %s', (exposed) => {
    const { world } = setup();
    const targetsPlayer = vi.fn((_glyphX: number, _player: Readonly<Coordinate>) => exposed);
    const definition = zukDefinition.register({
      attacksEnabled: () => true,
      targetsPlayer,
      spawnJad: () => undefined,
      spawnHealers: () => undefined,
    });
    const tickEvents = new TickEvents();

    const result = definition.tick(
      createZuk({
        id: 'zuk',
        position: [28, 52],
        spawnTick: 0,
        openingDelayTicks: 13,
        glyphId: 'zuk_shield',
      }),
      {
        tick: 13,
        world,
        tickEvents,
        random: () => 0.5,
        spawnNpc: () => undefined,
        despawnNpc: () => undefined,
        logEvent: () => undefined,
      },
    );

    expect(targetsPlayer).toHaveBeenCalledExactlyOnceWith(30, [31, 44]);
    expect(result.npcAttacks ?? []).toHaveLength(exposed ? 1 : 0);
    expect(tickEvents.flush().find(isEncounterVisualEvent)?.projectiles).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ actorId: exposed ? 'player' : 'zuk_shield' }),
        startOffset: exposed ? 128 : 64,
      }),
    ]);
  });

  it('reproduces the complete glyph capture when advanced by the real engine', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, zukShieldStart: 'right' });
    const positions = [world.getNpc('zuk_shield')?.position[0]];
    for (let tick = 1; tick < ZUK_CAPTURE_GLYPH_X.length; tick++) {
      engine.advanceTick([31, 44]);
      positions.push(world.getNpc('zuk_shield')?.position[0]);
    }
    expect(positions).toEqual(ZUK_CAPTURE_GLYPH_X);
    expect(world.getNpc('zuk_shield')).toMatchObject({ size: 3, facing: 0, position: [positions.at(-1), 48] });
  });

  it('restarts the replacement glyph patrol on the next tick after respawn-glyph', () => {
    const { engine, world } = setup();
    advance(engine, 20);

    engine.executeEncounterCommand({ encounter: 'zuk', type: 'respawn-glyph' });
    const glyphs = world.getNpcs().filter((npc) => npc.npcTypeId === 7707);
    expect(glyphs).toHaveLength(1);
    expect(world.getNpc('zuk_shield')).toBeNull();
    expect(glyphs[0]).toMatchObject({ position: [30, 48], alive: true });
    // The manual reset also re-anchors Zuk's cast clock to the new shield (opening = spawn + 13),
    // so a reset that only moved the glyph can never desync the two clocks.
    expect(zukDefinition.getState(world.getNpc('zuk')!)).toMatchObject({ lastCastTick: null, firstCastTick: 33 });
    engine.advanceTick([31, 44]);

    expect(glyphs[0]).toMatchObject({ position: [31, 48], previousPosition: [30, 48], facing: 0 });
    expect(zukWaveView(engine)).toMatchObject({ state: { shieldX: 31, shieldMovingEast: true } });
  });

  it('preserves the existing enraged clock through respawn-glyph, never reconciling it', () => {
    const { engine, world } = setup();
    advance(engine, 14);
    hit(engine, 'zuk', 239);
    advance(engine, 21);
    const boss = world.getNpc('zuk');
    if (!boss) throw new TypeError('Missing boss fixture');
    expect(zukDefinition.getState(boss)).toMatchObject({ lastCastTick: 20, enragedAt: 14 });

    engine.executeEncounterCommand({ encounter: 'zuk', type: 'respawn-glyph' });

    // Only reconciled pre-enrage - an enraged clock keeps its own faster cadence untouched
    // rather than being silently reset to the slower pre-enrage schedule this command was
    // never meant to change.
    expect(zukDefinition.getState(boss)).toMatchObject({ lastCastTick: 20, enragedAt: 14 });
    const glyphs = world.getNpcs().filter((npc) => npc.npcTypeId === 7707);
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0]).toMatchObject({ position: [30, 48], alive: true, spawnTick: 21 });
  });

  it('creates the canonical boss with the existing opening and shield association', () => {
    const { world } = setup();
    const boss = world.getNpc('zuk');
    if (!boss) throw new TypeError('Missing canonical Zuk');

    expect(boss).toMatchObject({ id: 'zuk', position: [28, 52], spawnTick: 0 });
    expect(zukDefinition.getState(boss)).toMatchObject({ firstCastTick: 13, glyphId: 'zuk_shield' });
  });

  it('updates only the encounter boss when replacing its glyph', () => {
    const { encounter, engine, world } = setup();
    const boss = world.getNpc('zuk');
    if (!boss) throw new TypeError('Missing canonical Zuk');
    const other = createZuk({
      id: 'other-zuk',
      position: [18, 52],
      spawnTick: 0,
      openingDelayTicks: 13,
      glyphId: 'other-glyph',
    });
    world.actors.set(other.id, other);

    engine.executeEncounterCommand({ encounter: 'zuk', type: 'respawn-glyph' });

    expect(zukDefinition.getState(boss)?.glyphId).toBe('zuk_shield_0');
    expect(zukDefinition.getState(other)?.glyphId).toBe('other-glyph');
    expect(zukDirector(encounter)['glyph']?.id).toBe('zuk_shield_0');
  });

  it('reproduces all 135 cast ticks, targets and raw packet horizons', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ infiniteHealth: true, zukSets: false, zukShieldStart: 'right' });
    let player: Coordinate = [31, 44];
    const expected: object[] = [];
    const actual: object[] = [];
    for (const { tick: captureTick, blast, playerTo } of ZUK_CAPTURE_TICKS) {
      const actor = world.getPlayer();
      if (!actor) throw new TypeError('Missing test player');
      actor.position = [...player];
      if (captureTick === 1066) hit(engine, 'zuk', 239);
      if (captureTick === 1066) engine.executeEncounterCommand({ encounter: 'zuk', type: 'clear-spawns' });
      engine.advanceTick(player);
      if (blast) expected.push({ tick: captureTick - 26, ...blast });
      for (const event of engine.getLastTickEvents().filter(isEncounterVisualEvent)) {
        for (const projectile of event.projectiles.filter((cue) => cue.spotAnimId === 1375)) {
          actual.push({
            tick: event.tick,
            target: projectile.target.kind === 'actor' ? projectile.target.actorId : 'tile',
            start: projectile.startDelayCycles,
            end: projectile.endDelayCycles,
            offset: projectile.startOffset,
          });
        }
      }
      if (playerTo) player = [...playerTo];
    }
    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(135);
    expect(actual.map((row) => Reflect.get(row, 'tick'))).toEqual(ZUK_CAPTURE_BLASTS.map((row) => row.encounterTick));
  });

  it.each([
    { hp: 481, jads: 0, healers: 0 },
    { hp: 480, jads: 0, healers: 0 },
    { hp: 479, jads: 1, healers: 0 },
    { hp: 241, jads: 1, healers: 0 },
    { hp: 240, jads: 1, healers: 0 },
    { hp: 239, jads: 1, healers: 4 },
  ])('uses strict phase boundaries on a positive player hit ending at $hp HP', ({ hp, jads, healers }) => {
    const { engine, world } = setup();
    world.getNpc('zuk')!.vitals.hp = hp + 1;
    launchPlayerHit(engine, 'zuk');

    advance(engine, 1);

    expect(world.getNpc('zuk')?.vitals.hp).toBe(hp);
    expect(world.getNpcs().filter(jadDefinition.isActor)).toHaveLength(jads);
    expect(world.getNpcs().filter(healerDefinition.isActor)).toHaveLength(healers);
    expect(zukWaveView(engine)).toMatchObject({
      state: { jadSpawned: jads > 0, enraged: healers > 0 },
    });
  });

  it.each([
    480, 240,
  ])('preserves latched actors after healing and re-crossing the strict %i HP boundary', (threshold) => {
    const { engine, world } = setup();
    hit(engine, 'zuk', threshold - 1);
    const phaseActors = world.getNpcs().filter((npc) => npc.role === 'minion');
    // Natural healing does not re-arm phases (unlike the practice slider).
    world.getNpc('zuk')!.vitals.hp = threshold + 1;

    hit(engine, 'zuk', threshold);
    hit(engine, 'zuk', threshold - 1);

    expect(world.getNpcs().filter((npc) => npc.role === 'minion')).toEqual(phaseActors);
    expect(zukWaveView(engine)).toMatchObject({
      state: { jadSpawned: true, enraged: threshold === 240 },
    });
  });

  it('keeps phase latches after healing and changes cadence only on the following tick', () => {
    const { engine, encounter, world } = setup();
    engine.setMechanicsConfig({ infiniteHealth: true, zukSets: false });
    advance(engine, 1039);
    hit(engine, 'zuk', 239);
    hit(engine, 'zuk', 500);
    hit(engine, 'zuk', 200);
    advance(engine, 1040);
    expect(
      engine
        .getLastTickEvents()
        .filter(isEncounterVisualEvent)
        .flatMap((event) => event.projectiles),
    ).toHaveLength(1);
    expect(world.getNpcs().filter((npc) => npc.npcTypeId === 7708)).toHaveLength(4);
    expect(
      encounter.getSnapshot({ tick: engine.currentTick, mechanics: engine.getMechanicsConfig(), world }).state.zuk
        ?.enraged,
    ).toBe(true);
  });

  it('keeps in-range recorded layouts static without regeneration while their attacks destroy the glyph', () => {
    const { engine, world, encounter } = setup();
    enableZukMovement(engine);
    engine.setMechanicsConfig({ infiniteHealth: true, zukSets: false });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-set' });
    const glyph = world.getNpc('zuk_shield');
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing in-range layout player');
    player.position = [31, 44];
    hit(engine, 'zuk', 479);
    const initial = world
      .getNpcs()
      .filter((npc) => npc.id !== 'zuk_shield')
      .map((npc) => [npc.id, npc.position, npc.vitals.hp]);
    advance(engine, 1300);
    expect(
      world
        .getNpcs()
        .filter((npc) => npc.id !== 'zuk_shield')
        .map((npc) => [npc.id, npc.position, npc.vitals.hp]),
    ).toEqual(initial);
    expect(glyph).toMatchObject({ alive: false, vitals: { hp: 0 } });
    expect(
      encounter.getSnapshot({ tick: engine.currentTick, mechanics: engine.getMechanicsConfig(), world }).state.zuk
        ?.setTimer,
    ).toBeNull();
    expect(
      engine
        .getDamageHistory()
        .every(
          (damage) =>
            damage.targetId === 'player' || damage.targetId === 'zuk_shield' || damage.source === 'PlayerAttack',
        ),
    ).toBe(true);
  });

  it('allocates unique IDs across replacement and repeated manual layouts', () => {
    const { engine, world } = setup();
    const ids: string[] = [];
    for (let repeat = 0; repeat < 3; repeat++) {
      engine.executeEncounterCommand({ encounter: 'zuk', type: 'replace-set' });
      ids.push(
        ...world
          .getNpcs()
          .filter((npc) => npc.role === 'minion')
          .map((npc) => npc.id),
      );
    }
    expect(new Set(ids).size).toBe(6);
    expect(
      world
        .getNpcs()
        .filter((npc) => npc.role === 'minion')
        .map((npc) => npc.position),
    ).toEqual([
      [26, 39],
      [35, 39],
    ]);
  });

  it.each([0, 123, 0xffffffff])('reconstructs unsigned seed %i without compatibility metadata', (encounterSeed) => {
    const encounter = createZukWaveEncounter(encounterSeed);
    const seeds = { runSeed: encounterSeed };
    encounter.reset(seeds);
    expect(encounter.getSeeds()).toEqual(seeds);
    const engine = new SimulationEngine({ encounter });
    expect(structuredClone(engine.getEncounterSnapshot())).toEqual(engine.getEncounterSnapshot());
  });

  it.each([
    -1,
    0x100000000,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects invalid constructor seed %s', (seed) => {
    expect(() => createZukWaveEncounter(seed)).toThrow();
  });

  it.each(
    [undefined, null, '9', -1, 0x100000000, 1.5, Number.NaN, Number.POSITIVE_INFINITY].flatMap((encounterSeed) =>
      [true, false].map((withBootstrap) => ({ encounterSeed, withBootstrap })),
    ),
  )('preserves the live engine on invalid seed $encounterSeed (bootstrap: $withBootstrap)', (options) => {
    const encounter = createZukWaveEncounter(9);
    const controlEncounter = createZukWaveEncounter(9);
    const engine = new SimulationEngine({ encounter, combatSeed: 4321 });
    const control = new SimulationEngine({ encounter: controlEncounter, combatSeed: 4321 });
    for (const current of [engine, control]) {
      current.setMechanicsConfig({ infiniteHealth: true });
      current.applyPrepotEffects();
      current.rollCombat();
      current.rollCombat();
      advance(current, 17);
      current.setBossHp(0);
      current['applyFailCondition']('Death', current.currentTick);
    }
    const runConfig = structuredClone(engine.getRunConfig());
    const bootstrap = runConfig.bootstrap;
    if (!bootstrap) throw new TypeError('Missing run bootstrap');
    const rejected: EngineRunConfig = {
      completionOwnership: 'external-owned',
      encounter: {
        kind: 'inferno',
        seeds: options.encounterSeed === undefined ? {} : { runSeed: options.encounterSeed },
      },
      ...(options.withBootstrap
        ? {
            bootstrap: {
              ...bootstrap,
              startPosition: [34, 45] satisfies Coordinate,
              baseStats: { ...bootstrap.baseStats, hitpoints: { current: 60, max: 60 } },
              startHp: 25,
              enableIntro: true,
              mechanicsConfig: { infiniteHealth: false, zukAttacks: false },
              attackStylePerCategory: { bow: 2 },
              combatSeed: 9876,
              prepotApplied: false,
            },
          }
        : {}),
    };
    const before = structuredClone({
      state: engine.getState(),
      encounter: engine.getEncounterSnapshot(),
      damage: engine.getDamageHistory(),
      events: engine.getEventLog(),
      tickEvents: engine.getLastTickEvents(),
      pendingDefeats: engine['pendingNpcDefeats'],
    });
    expect(before.damage.length).toBeGreaterThan(0);
    expect(before.events.length).toBeGreaterThan(0);
    expect(before.tickEvents.length).toBeGreaterThan(0);
    expect(before.pendingDefeats).toHaveLength(1);

    expect(() => engine.reset([35, 45], rejected)).toThrow();

    expect.soft(engine.getRunConfig()).toEqual(runConfig);
    expect.soft(engine.getFailedCondition()).toBe('Death');
    expect.soft(engine.getState()).toEqual(before.state);
    expect.soft(engine.getEncounterSnapshot()).toEqual(before.encounter);
    expect.soft(engine.getDamageHistory()).toEqual(before.damage);
    expect.soft(engine.getEventLog()).toEqual(before.events);
    expect.soft(engine.getLastTickEvents()).toEqual(before.tickEvents);
    expect.soft(engine['pendingNpcDefeats']).toEqual(before.pendingDefeats);
    for (let draw = 0; draw < 3; draw++) {
      expect.soft(engine.rollCombat()).toBe(control.rollCombat());
      expect.soft(zukDirector(encounter)['random']()).toBe(zukDirector(controlEncounter)['random']());
    }
  });

  it('blocks glyph attacks and boss melee without blocking supported player ranged attacks', () => {
    const { encounter, engine, world } = setup();
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing player');
    const context = { tick: 0, world, player };
    expect(encounter.getEngineRules().validateAttack?.('range_arrow', 'zuk_shield', context)).toBe(false);
    expect(encounter.getEngineRules().validateAttack?.('melee_slash', 'zuk', context)).toBe(false);
    expect(encounter.getEngineRules().validateAttack?.('range_arrow', 'zuk', context)).toBeNull();
    engine.queueProtectionPrayer(PrayerType.ProtectMagic);
  });

  it.each([
    null,
    PrayerType.ProtectMagic,
    PrayerType.ProtectRange,
    PrayerType.ProtectMelee,
  ])('applies an uncapped hybrid blast through %s on the packet-derived impact tick', (prayer) => {
    const { engine, world } = setup(9);
    engine.queueProtectionPrayer(prayer);
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing player');
    player.vitals.hp = 1;
    advance(engine, 13);
    expect(engine.getLastTickEvents()).toContainEqual(
      expect.objectContaining({ type: 'attack_started', attackKind: 'typeless', impactDelayTicks: 4 }),
    );
    advance(engine, 17);
    expect(engine.getDamageHistory().filter((damage) => damage.targetId === 'player')).toEqual([
      expect.objectContaining({
        tick: 17,
        baseDamage: 126,
        effectiveDamage: 126,
        attackType: 'typeless',
        prayedCorrectly: null,
      }),
    ]);
  });

  it('creates no combat hit at all when covered at the NPC phase even if the player then leaves', () => {
    const { engine, world } = setup();
    advance(engine, 12);
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing player');
    player.position = [42, 46];
    engine.advanceTick([40, 44]);
    advance(engine, 22);
    expect(engine.getDamageHistory()).toEqual([]);
    expect(world.getNpc('zuk_shield')?.vitals.hp).toBe(600);
  });

  it('targets the player on the unchanged Zuk cadence when the glyph is absent', () => {
    const { engine, world } = setup();
    world.actors.delete('zuk_shield');
    const events = collectTickEvents(engine, 50);
    expect(
      events.flatMap((event) => (isCoreEvent(event, 'attack_started') ? [[event.tick, event.targetId]] : [])),
    ).toEqual([13, 23, 33, 43].map((tick) => [tick, 'player']));
    expect(engine.getDamageHistory().map((damage) => damage.tick)).toEqual([17, 27, 37, 47]);
    expect(engine.getDamageHistory().some((damage) => damage.effectiveDamage > 0)).toBe(true);
  });

  it('spawns the captured Jad healer layout once at exactly half health, not by elapsed lifetime', () => {
    const { engine, world, encounter } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, infiniteHealth: true });
    forceJadHealerTiles(encounter);
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad' });
    const jad = world.getNpcs().find((npc) => npc.npcTypeId === 7704);
    if (!jad) throw new TypeError('Missing Jad');
    hit(engine, jad.id, 175);
    hit(engine, jad.id, 200);
    hit(engine, jad.id, 174);
    advance(engine, 200);
    expect(
      world
        .getNpcs()
        .filter((npc) => npc.npcTypeId === 7705)
        .map((npc) => [npc.position, npc.vitals.hp]),
    ).toEqual([
      [[30, 41], 90],
      [[31, 40], 90],
      [[30, 40], 90],
    ]);
  });

  it('draws Jad healers onto three distinct open tiles north of Jad, never the player, from their own stream', () => {
    const walkableTiles = new Set<string>();
    for (let tileX = 17; tileX <= 45; tileX++)
      for (let tileY = 17; tileY <= 46; tileY++)
        if (tileX !== 30 || tileY !== 40) walkableTiles.add(`${tileX},${tileY}`);
    const layouts = new Set<string>();
    for (let seed = 0; seed < 40; seed++) {
      const { engine, world, encounter } = setup(seed);
      setArenaConfig({
        bounds: { minX: 17, maxX: 45, minY: 17, maxY: 46, width: 29, height: 30 },
        walkableTiles,
        collisionMap: null,
      });
      engine.setMechanicsConfig({ zukAttacks: false, zukSets: false });
      const player = world.getPlayer();
      if (!player) throw new TypeError('Missing player');
      player.position = [31, 41];
      const control = mulberry32(seed);
      engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad-healers' });
      const jad = world.getNpcs().find(jadDefinition.isActor);
      const tiles = world
        .getNpcs()
        .filter(jadHealerDefinition.isActor)
        .map((healer) => `${healer.position[0]},${healer.position[1]}`);
      expect(jad?.position).toEqual([30, 35]);
      expect(tiles).toHaveLength(3);
      expect(new Set(tiles).size).toBe(3);
      for (const tile of tiles) {
        const [x, y] = tile.split(',').map(Number) as [number, number];
        expect(x >= 30 && x <= 32 && y >= 40 && y <= 43, tile).toBe(true);
        expect(tile).not.toBe('31,41');
        expect(tile).not.toBe('30,40');
      }
      layouts.add(tiles.join(' '));
      // Wave 69's shared stream is untouched by the placement.
      expect(zukDirector(encounter)['random']()).toBe(control());
    }
    expect(layouts.size).toBeGreaterThan(10);
  });

  // W69: zero headbar t983, death sequence t984, Jad and his healers removed t990 — six ticks after
  // the death sequence, which Jad's queued death now places a tick after the killing hit.
  it('removes Jad and its children six ticks from his death sequence rather than six ticks from spawn', () => {
    const { engine, world } = setup();
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad-healers' });
    const jad = world.getNpcs().find((npc) => npc.npcTypeId === 7704);
    if (!jad) throw new TypeError('Missing Jad');
    advance(engine, 10);
    hit(engine, jad.id, 0);
    advance(engine, 16);
    expect(jad.deathAnimationTick).toBe(11);
    expect(world.getNpcs().filter((npc) => npc.npcTypeId === 7705)).toHaveLength(3);
    advance(engine, 17);
    expect(world.getNpcs().filter((npc) => npc.npcTypeId === 7705 || npc.npcTypeId === 7704)).toEqual([]);
  });

  // W69: Jal-Xil death sequence t156, removed t158; Jal-Zek t242 -> t244; healers t1139 -> t1141.
  // Until then the corpse keeps blocking movement, so it must not wait for the engine's pruning.
  it('removes a dead set monster or healer two ticks after its death sequence', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: true });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-set' });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-healers' });
    advance(engine, 10);
    const killed = [7702, 7703, 7708].map((typeId) => {
      const npc = world.getNpcs().find((candidate) => candidate.npcTypeId === typeId);
      if (!npc) throw new TypeError(`Missing ${typeId}`);
      hit(engine, npc.id, 0);
      return npc;
    });
    advance(engine, 11);
    expect(killed.map((npc) => npc.deathAnimationTick)).toEqual([11, 11, 11]);
    advance(engine, 12);
    expect(killed.map((npc) => world.getNpc(npc.id) === npc)).toEqual([true, true, true]);
    advance(engine, 13);
    expect(killed.map((npc) => world.getNpc(npc.id))).toEqual([null, null, null]);
  });

  it.each([
    'encounter-owned',
    'external-owned',
  ] as const)('kills minions while retaining the glyph on boss defeat with %s completion', (ownership) => {
    const { engine, encounter, world } = setup();
    engine.setCompletionOwnership(ownership);
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad-healers' });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-healers' });
    const minions = world.getNpcs().filter((npc) => npc.role === 'minion');
    const jad = minions.find(jadDefinition.isActor);
    if (!jad) throw new TypeError('Missing Jad');
    jad.state.pendingAttack = { style: 'magic', targetId: 'player', releaseTick: 4 };
    const healers = minions.filter(healerDefinition.isActor);
    for (const healer of healers) {
      healer.state.pendingHeals.push({ targetId: 'zuk', amount: 15, applyTick: 4 });
    }
    const notifyDefeated = vi.spyOn(encounter.getNpcDefinitions(), 'notifyDefeated');
    engine.setBossHp(0);

    advance(engine, 1);

    expect(jad.state.pendingAttack).toBeNull();
    expect(jad.state.removeAt).toBe(6);
    expect(healers.map((healer) => healer.state.pendingHeals)).toEqual([[], [], [], []]);
    expect(notifyDefeated).toHaveBeenCalledTimes(9);
    for (const minion of minions) {
      expect(notifyDefeated).toHaveBeenCalledWith(
        minion,
        { npcId: minion.id, tick: 0 },
        ownership,
        expect.objectContaining({ tick: 1, world, random: zukDirector(encounter)['random'] }),
      );
      expect(minion.despawnTick).toBe(0);
    }
    expect(engine.getEncounterOutcome().phase).toBe(ownership === 'encounter-owned' ? 'resolving' : 'active');
    expect(
      world
        .getNpcs()
        .filter((npc) => npc.role === 'minion')
        .every((npc) => !npc.alive && npc.vitals.hp === 0),
    ).toBe(true);
    expect(world.getNpc('zuk_shield')?.alive).toBe(true);
    expect(engine.getLastTickEvents().filter((event) => event.type === 'actor_died')).toHaveLength(8);
    expect(engine.getLastTickEvents().filter((event) => event.type === 'zuk_death')).toMatchObject(
      [jad, ...healers].map((actor) => ({ actorId: actor.id, tick: 1 })),
    );
    expect(world.getNpc('zuk_shield')?.position).toEqual([30, 48]);
    const laterEvents = collectTickEvents(engine, 5);
    expect(world.getNpc(jad.id)).toBe(jad);
    expect(world.getNpcs().filter(jadHealerDefinition.isActor)).toHaveLength(3);
    expect(engine.getEncounterOutcome()).toEqual(
      ownership === 'encounter-owned'
        ? {
            phase: 'resolving',
            decisiveTick: 0,
            completionTick: 6,
            primaryActorId: 'zuk',
            completionActorIds: ['zuk', ...minions.map((minion) => minion.id)],
          }
        : { phase: 'active' },
    );
    laterEvents.push(...collectTickEvents(engine, 6));
    expect(world.getNpc(jad.id)).toBeNull();
    expect(world.getNpcs().filter(jadHealerDefinition.isActor)).toEqual([]);
    expect(world.getNpc('zuk_shield')?.alive).toBe(true);
    expect(engine.getEncounterOutcome().phase).toBe(ownership === 'encounter-owned' ? 'victory' : 'active');
    expect(engine.canAdvance()).toBe(ownership === 'external-owned');
    expect(notifyDefeated).toHaveBeenCalledTimes(9);
    expect(laterEvents.filter((event) => event.type === 'actor_died' || event.type === 'zuk_death')).toEqual([]);
    expect(engine.getDamageHistory()).toEqual([]);
  });

  it('resets and reconstructs an identical real-engine damage trace with the same seed', () => {
    const { engine } = setup(9);
    const runConfig = engine.getRunConfig();
    advance(engine, 75);
    const damage = structuredClone(engine.getDamageHistory());
    const snapshot = structuredClone(engine.getEncounterSnapshot());
    engine.reset(undefined, runConfig);
    advance(engine, 75);
    expect(engine.getDamageHistory()).toEqual(damage);
    expect(engine.getEncounterSnapshot()).toEqual(snapshot);
  });

  it.each([481, 241])('supports actual player bow attacks and triggers a phase from the landing hit at %i HP', (hp) => {
    const { engine, world } = setup(7, () => 0.05);
    engine.setObjTypeLoader(
      new DummyTypeLoader(
        {
          name: 'test',
          game: 'oldschool',
          environment: 'live',
          revision: 232,
          timestamp: '2024-01-01T00:00:00.000Z',
          size: 0,
        },
        ObjType,
      ),
    );
    engine.setMechanicsConfig({ zukAttacks: false });
    engine.setEquipment({ weapon: 20997 });
    engine.setCombatSupplies({ ...createEmptyCombatSupplies(), equippedAmmo: { id: 11212 } });
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing player');
    player.equipmentStats = {
      ...player.equipmentStats,
      attackRange: 10,
      attackSpeed: 6,
      attackRanged: 70,
      rangedStrength: 80,
    };
    engine.setBossHp(hp);
    engine.setAttackTarget('zuk');
    const events = collectTickEvents(engine, 25);
    const bossDamage = engine.getDamageHistory().filter((damage) => damage.targetId === 'zuk');
    expect(bossDamage[0]?.hpAfter).toBeLessThan(hp);
    const healing = healingEvents(events).filter((event) => event.targetId === 'zuk');
    expect(world.getNpc('zuk')?.vitals.hp).toBe(
      hp -
        bossDamage.reduce((total, damage) => total + damage.effectiveDamage, 0) +
        healing.reduce((total, event) => total + event.amount, 0),
    );
    expect(world.getNpcs().filter((npc) => npc.npcTypeId === 7704)).toHaveLength(hp === 481 ? 1 : 0);
    expect(engine.getDamageHistory()).toContainEqual(
      expect.objectContaining({ source: 'PlayerAttack', targetId: 'zuk' }),
    );
    // The renderer plays each healer's spawn clip from its snapshot spawn tick (render config
    // `spawnSeqId`), so the phase hit's tick is the whole contract - and no cue duplicates it.
    const phaseHit = engine.getDamageHistory().find((damage) => damage.targetId === 'zuk' && damage.hpAfter < 240);
    const healers = world.getNpcs().filter(healerDefinition.isActor);
    expect(healers.map((actor) => actor.spawnTick)).toEqual(hp === 241 ? Array(4).fill(phaseHit?.tick) : []);
    expect(
      events
        .filter(isEncounterVisualEvent)
        .flatMap((event) => event.animations.filter((cue) => cue.clipId === 'spawn')),
    ).toEqual([]);
  });

  it('spawns the four manual healers on the current command tick without a spawn cue', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    advance(engine, 5);

    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-healers' });

    const healers = world.getNpcs().filter(healerDefinition.isActor);
    expect(healers.map((actor) => actor.spawnTick)).toEqual([5, 5, 5, 5]);
    expect(engine.getLastTickEvents().filter(isEncounterVisualEvent)).toEqual([]);
    expect(collectTickEvents(engine, 8).filter(isEncounterVisualEvent)).toEqual([]);
  });

  it('keeps visual-only command batches detached and leaves all healing and AI unscheduled', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'demonstrate-heal' });
    const event = engine.getLastTickEvents().find(isEncounterVisualEvent);
    expect(event?.projectiles).toHaveLength(4);
    expect(event?.graphics).toEqual([
      {
        spotAnimId: 444,
        target: { kind: 'actor', actorId: 'zuk', size: 7, position: [28, 52] },
        delayCycles: 120,
        height: 256,
      },
    ]);
    const boss = world.getNpc('zuk');
    if (!boss) throw new TypeError('Missing boss');
    boss.position[0] = 29;
    boss.vitals.hp = 500;
    advance(engine, 150);
    expect(event?.graphics[0].target).toMatchObject({ position: [28, 52] });
    expect(boss.vitals.hp).toBe(500);
    expect(engine.getDamageHistory()).toEqual([]);
    expect(engine.getLastTickEvents().filter(isEncounterVisualEvent)).toEqual([]);
  });

  it('allows a hybrid accuracy miss rather than forcing every exposed blast to hit', () => {
    const { engine, encounter } = setup();
    zukDirector(encounter)['random'] = () => 0.999999999;
    advance(engine, 17);
    expect(engine.getDamageHistory()).toEqual([
      expect.objectContaining({ targetId: 'player', baseDamage: 0, effectiveDamage: 0 }),
    ]);
  });

  it('reproduces the t1066-to-t1069 player hit delay and damage when given the observed roll', () => {
    const { engine, world } = setup(1063);
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false });
    advance(engine, 1039);
    hit(engine, 'zuk', 239);
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing player');
    player.position = [38, 46];
    engine.setMechanicsConfig({ zukAttacks: true });
    engine.advanceTick([36, 46]);
    const event = engine
      .getLastTickEvents()
      .filter(isEncounterVisualEvent)
      .find((cue) => cue.projectiles.some((projectile) => projectile.spotAnimId === 1375));
    expect(event?.projectiles[0]).toMatchObject({
      endDelayCycles: 106,
      startOffset: 128,
      sourcePosition: [31.5, 55.5],
    });
    advance(engine, 1043);
    expect(engine.getDamageHistory().filter((damage) => damage.targetId === 'player')).toEqual([
      expect.objectContaining({ tick: 1043, baseDamage: 84, effectiveDamage: 84 }),
    ]);
  });
});

describe('Zuk NPC activation through the real engine', () => {
  it('activates live Jad at spawn+8 and releases at cue+3 after retargeting to the player', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad' });
    const jad = world.getNpcs().find((actor) => actor.npcTypeId === 7704);
    if (!jad) throw new TypeError('Missing live Jad');
    notifyNpcOfPlayerAttack(jad, {
      sourceId: 'player',
      launchTick: 0,
      impactTick: 1,
      style: 'range',
      accuracySucceeded: true,
    });

    const events = collectTickEvents(engine, 11);

    expect(jad.combat.targetId).toBe('player');
    expect(events.filter((event) => event.type === 'zuk_jad_cue')).toEqual([
      expect.objectContaining({ tick: 8, sourceId: jad.id }),
    ]);
    expect(events.filter((event) => event.type === 'attack_started')).toEqual([
      expect.objectContaining({ tick: 11, sourceId: jad.id, targetId: 'player' }),
    ]);
  });

  it('heals Jad by 10 per adjacent healer on the actual half-health landing tick and again at T+4', () => {
    const { engine, world, encounter } = setup(7, () => 0.05);
    forceJadHealerTiles(encounter);
    engine.setObjTypeLoader(
      new DummyTypeLoader(
        {
          name: 'test',
          game: 'oldschool',
          environment: 'live',
          revision: 232,
          timestamp: '2024-01-01T00:00:00.000Z',
          size: 0,
        },
        ObjType,
      ),
    );
    engine.setMechanicsConfig({ zukAttacks: false });
    engine.setEquipment({ weapon: 20997 });
    engine.setCombatSupplies({ ...createEmptyCombatSupplies(), equippedAmmo: { id: 11212 } });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad' });
    const jad = world.getNpcs().find((npc) => npc.npcTypeId === 7704);
    const player = world.getPlayer();
    if (!jad || !player) throw new TypeError('Missing half-health actors');
    player.equipmentStats = {
      ...player.equipmentStats,
      attackRange: 10,
      attackSpeed: 6,
      attackRanged: 70,
      rangedStrength: 80,
    };
    jad.vitals.hp = 176;
    const dispatch = vi.spyOn(encounter.getNpcDefinitions(), 'tick');
    engine.setAttackTarget(jad.id);

    while (engine.currentTick < 10 && !world.getNpcs().some(jadHealerDefinition.isActor))
      engine.advanceTick(player.position);
    const spawnTick = engine.currentTick;
    const spawnEvents = engine.getLastTickEvents();
    engine.setAttackTarget(null);
    const hpAfterHit = engine
      .getDamageHistory()
      .filter((damage) => damage.targetId === jad.id)
      .at(-1)?.hpAfter;
    if (hpAfterHit === undefined) throw new TypeError('Missing half-health hit');
    const events = [...spawnEvents, ...collectTickEvents(engine, spawnTick + 4)];

    const healers = world.getNpcs().filter(jadHealerDefinition.isActor);
    expect(healers).toHaveLength(3);
    expect(healers.map((actor) => actor.spawnTick)).toEqual([spawnTick, spawnTick, spawnTick]);
    expect(healers.map((actor) => actor.combat.targetId)).toEqual([null, null, null]);
    expect(engine.getDamageHistory()).toContainEqual(
      expect.objectContaining({ source: 'PlayerAttack', targetId: jad.id, tick: spawnTick }),
    );
    expect(hpAfterHit).toBeLessThanOrEqual(175);
    const healing = healingEvents(events);
    expect(healing.map((event) => [event.tick, event.targetId, event.amount])).toEqual([
      [spawnTick, jad.id, 10],
      [spawnTick, jad.id, 10],
      [spawnTick + 4, jad.id, 10],
      [spawnTick + 4, jad.id, 10],
    ]);
    expect(jad.vitals.hp).toBe(hpAfterHit + 40);
    for (const healer of healers) {
      const actions = events
        .filter(isEncounterVisualEvent)
        .flatMap((event) => event.animations.map((cue) => ({ ...cue, tick: event.tick })))
        .filter((cue) => cue.actorId === healer.id);
      expect(actions).toEqual(
        healer.position[1] === 41
          ? []
          : [spawnTick, spawnTick + 4].map((tick) => ({
              actorId: healer.id,
              clipId: 'heal',
              delayCycles: 0,
              tick,
            })),
      );
      expect(
        dispatch.mock.calls.filter(([actor, context]) => actor === healer && context.tick === spawnTick),
      ).toHaveLength(1);
    }
  });

  it('does not dispatch support or melee for action-ready children removed by an earlier Jad tick', () => {
    const { engine, world, encounter } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad-healers' });
    const jad = world.getNpcs().find((npc) => npc.npcTypeId === 7704);
    const healer = world.getNpcs().find(jadHealerDefinition.isActor);
    const player = world.getPlayer();
    if (!jad || !healer || !player) throw new TypeError('Missing removal actors');
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad' });
    const support = world.getNpcs().find((npc) => npc.npcTypeId === 7704 && npc.id !== jad.id);
    if (!support) throw new TypeError('Missing surviving support target');
    hit(engine, jad.id, 0);
    // Death sequence at 1, so Jad and his children go at 7.
    advance(engine, 6);
    healer.position = [31, 40];
    player.position = [31, 41];
    healer.combat.targetId = player.id;
    healer.combat.nextActionTick = 0;
    healer.state.supportTargetId = support.id;
    healer.state.nextHealTick = 6;
    const dispatch = vi.spyOn(encounter.getNpcDefinitions(), 'tick');

    engine.advanceTick(player.position);

    const events = engine.getLastTickEvents();
    expect(events.filter(isEncounterVisualEvent).flatMap((event) => event.animations)).toEqual([]);
    expect(events.filter((event) => event.type === 'attack_started')).toEqual([]);
    expect(dispatch.mock.calls.some(([actor]) => actor === healer)).toBe(false);
  });

  it('tagged Jad healers skip healing while adjacent and resume once untagged', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad-healers' });
    const jad = world.getNpcs().find((npc) => npc.npcTypeId === 7704);
    const healers = world.getNpcs().filter(jadHealerDefinition.isActor);
    const player = world.getPlayer();
    if (!jad || healers.length !== 3 || !player) throw new TypeError('Missing tagged-heal actors');
    // Inferno JalTok-Jad rule: healers must be untagged and adjacent to heal.
    jad.vitals.hp = 100;
    const [tagged, ...untagged] = healers;
    if (!tagged || untagged.length !== 2) throw new TypeError('Missing tagged healer');
    const pin = (actor: (typeof healers)[number], position: Coordinate) => {
      actor.position = [...position];
      actor.previousPosition = [...position];
    };
    pin(tagged, [jad.position[0], jad.position[1] - 1]);
    pin(untagged[0]!, [jad.position[0] + jad.size, jad.position[1]]);
    pin(untagged[1]!, [jad.position[0] + jad.size, jad.position[1] + 1]);
    player.position = [tagged.position[0], tagged.position[1] - 1];
    tagged.combat.targetId = player.id;
    const healCues = (events: GameEvent[]) =>
      events
        .filter(isEncounterVisualEvent)
        .flatMap((event) => event.animations)
        .filter((cue) => cue.clipId === 'heal');

    const taggedEvents: GameEvent[] = [];
    for (let i = 0; i < 8; i++) {
      pin(tagged, [jad.position[0], jad.position[1] - 1]);
      engine.advanceTick(player.position);
      taggedEvents.push(...engine.getLastTickEvents());
    }
    expect(tagged.combat.targetId).toBe(player.id);
    const taggedPhase = healCues(taggedEvents);
    expect(taggedPhase.length).toBeGreaterThan(0);
    expect(taggedPhase.filter((cue) => cue.actorId === tagged.id)).toEqual([]);
    const hpAfterTagged = jad.vitals.hp;

    tagged.combat.targetId = null;
    const resumedEvents: GameEvent[] = [];
    for (let i = 0; i < 5; i++) {
      engine.advanceTick(player.position);
      resumedEvents.push(...engine.getLastTickEvents());
    }
    expect(healCues(resumedEvents).filter((cue) => cue.actorId === tagged.id).length).toBeGreaterThan(0);
    expect(jad.vitals.hp).toBeGreaterThan(hpAfterTagged);
  });

  it('reproduces ordered W69 healer pursuit from t882 through blocked t887 without resetting NPC tiles', () => {
    const { engine, world, encounter } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    forceJadHealerTiles(encounter);
    const walkableTiles = new Set<string>();
    for (let tileX = 17; tileX <= 45; tileX++)
      for (let tileY = 17; tileY <= 46; tileY++) walkableTiles.add(`${tileX},${tileY}`);
    setArenaConfig({ ...getArenaConfig(), walkableTiles });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad-healers' });
    const healers = world.getNpcs().filter(jadHealerDefinition.isActor);
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing capture player');
    player.position = [42, 46];
    advance(engine, 3);
    engine.advanceTick([40, 46]);
    expect(player.position).toEqual([40, 46]);
    for (const healer of healers)
      notifyNpcOfPlayerAttack(healer, {
        sourceId: player.id,
        launchTick: 4,
        impactTick: 7,
        style: 'magic',
        accuracySucceeded: false,
      });
    const positions: Coordinate[][] = [];
    const events: GameEvent[] = [];

    for (let tick = 5; tick <= 10; tick++) {
      engine.advanceTick(tick === 5 ? [38, 46] : [36, 44]);
      positions.push(healers.map((actor) => [...actor.position]));
      events.push(...engine.getLastTickEvents());
    }

    expect(positions).toEqual([
      [
        [31, 42],
        [32, 41],
        [31, 41],
      ],
      [
        [32, 43],
        [33, 42],
        [32, 42],
      ],
      [
        [33, 44],
        [34, 43],
        [33, 43],
      ],
      [
        [34, 44],
        [35, 43],
        [34, 43],
      ],
      [
        [35, 44],
        [36, 43],
        [35, 43],
      ],
      [
        [35, 44],
        [36, 43],
        [35, 43],
      ],
    ]);
    expect(events.filter((event) => event.type === 'attack_started')).toEqual(
      healers
        .slice(0, 2)
        .map((actor) => expect.objectContaining({ tick: 9, sourceId: actor.id, targetId: player.id, style: 'melee' })),
    );
  });

  it('reconstructs activated actors and subsequent combat from the same seed on reset', () => {
    const { engine } = setup(19);
    engine.setMechanicsConfig({ zukAttacks: false, infiniteHealth: true });
    const config = engine.getRunConfig();
    const run = () => {
      engine.setBossHp(500);
      engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-set' });
      engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad-healers' });
      engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-healers' });
      const world = engine['worldState'];
      const jad = world.getNpcs().find((actor) => actor.npcTypeId === 7704);
      if (!jad) throw new TypeError('Missing seeded support target');
      jad.vitals.hp = 100;
      for (const actor of world.getNpcs().filter((npc) => npc.npcTypeId === 7703 || npc.npcTypeId === 7702)) {
        notifyNpcOfPlayerAttack(actor, {
          sourceId: 'player',
          launchTick: 0,
          impactTick: 1,
          style: 'range',
          accuracySucceeded: true,
        });
      }
      const events = collectTickEvents(engine, 30);
      return structuredClone({
        events: events.map(({ eventId: _eventId, ...event }) => event),
        snapshot: engine.getState(),
        actors: world
          .getNpcs()
          .map((actor) => ({ id: actor.id, hp: actor.vitals.hp, combat: actor.combat, state: actor.state })),
      });
    };
    const original = run();
    expect(original.events.some((event) => event.type === 'attack_started')).toBe(true);
    expect(
      original.events.some(
        (event) => event.type === 'hitsplat_spawned' && event.hitsplatType === 'heal' && event.targetId === 'zuk',
      ),
    ).toBe(true);
    expect(
      original.events.some(
        (event) => event.type === 'hitsplat_spawned' && event.hitsplatType === 'heal' && event.targetId !== 'zuk',
      ),
    ).toBe(true);
    expect(original.snapshot.damageHistory.some((damage) => damage.effectiveDamage > 0)).toBe(true);

    engine.reset(undefined, config);
    const rebuilt = run();

    expect(config.encounter.seeds).toEqual({ runSeed: 19 });
    expect(rebuilt).toEqual(original);
  });

  it('retargets only old-glyph combat targets when the manual reset tool replaces the glyph', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-set' });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad' });
    const mager = world.getNpcs().find((npc) => npc.npcTypeId === 7703);
    const ranger = world.getNpcs().find((npc) => npc.npcTypeId === 7702);
    const jad = world.getNpcs().find((npc) => npc.npcTypeId === 7704);
    if (!mager || !ranger || !jad) throw new TypeError('Missing reset-tool actors');
    notifyNpcOfPlayerAttack(mager, {
      sourceId: 'player',
      launchTick: 0,
      impactTick: 1,
      style: 'range',
      accuracySucceeded: true,
    });
    advance(engine, 1);

    engine.executeEncounterCommand({ encounter: 'zuk', type: 'respawn-glyph' });

    const replacement = world.getNpcs().find((npc) => npc.npcTypeId === 7707);
    if (!replacement) throw new TypeError('Missing replacement glyph');
    expect(mager.combat.targetId).toBe('player');
    expect(ranger.combat.targetId).toBe(replacement.id);
    expect(jad.combat.targetId).toBe(replacement.id);
  });

  // Zuk's death kills his minions as scripted deaths, which animate at once: a Jal-Xil that stepped the
  // tick before gets no movement floor, and its death sound (zuk_death) fires exactly once, on Zuk's kill.
  it('presents a recently moved minion killed by Zuk cleanup at once, with one death notification', () => {
    const { engine, world } = setup();
    enableZukMovement(engine);
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: true });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-set' });
    const ranger = world.getNpcs().find(rangerDefinition.isActor);
    const zuk = world.getNpc('zuk');
    if (!ranger || !zuk) throw new TypeError('Missing Zuk or Jal-Xil');
    ranger.position = [17, 17];
    advance(engine, 10);
    expect(ranger.lastStepTick).toBe(10);
    enqueueEnginePendingHit(engine, {
      sourceId: 'player',
      targetId: zuk.id,
      style: 'range',
      attackKind: 'range_arrow',
      launchTick: 10,
      impactTick: 11,
      rolledDamage: zuk.vitals.hp,
      accuracySucceeded: true,
    });

    const events = collectTickEvents(engine, 16);

    expect(ranger).toMatchObject({
      alive: false,
      death: { causeStage: 'scripted', killTick: 11 },
      deathAnimationTick: 11,
    });
    expect(
      events.filter((event) => event.type === 'zuk_death' && event.actorId === ranger.id).map((event) => event.tick),
    ).toEqual([11]);
  });

  // An action belongs to the instance that took the turn. A Jal-Xil replaced by a same-id successor during
  // its own action hook loses the shot it returned: it is neither committed as the successor nor stamped
  // on it, and the successor takes only its own turn.
  it.each([
    true,
    false,
  ])('drops a Jal-Xil shot whose shooter was replaced in its action hook (replaced: %s)', (replaced) => {
    const { encounter, engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: true });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-set' });
    const ranger = world.getNpcs().find(rangerDefinition.isActor);
    if (!ranger) throw new TypeError('Missing Jal-Xil');
    let successor: NpcActor | null = null;
    const processNpcTick = encounter.processNpcTick.bind(encounter);
    vi.spyOn(encounter, 'processNpcTick').mockImplementation((actor, ctx) => {
      const result = processNpcTick(actor, ctx);
      if (replaced && actor === ranger && successor === null && (result.npcAttacks?.length ?? 0) > 0) {
        successor = createRanger({
          variant: 'zuk',
          id: ranger.id,
          position: [...ranger.position],
          spawnTick: ctx.tick,
          initialTargetId: 'player',
          initialDelayTicks: 20,
        });
        ctx.despawnNpc(ranger.id);
        ctx.spawnNpc(successor);
      }
      return result;
    });

    let shotTick = -1;
    while (shotTick < 0 && engine.currentTick < 40) {
      engine.advanceTick(engine.getState().playerPosition);
      if (engine.getLastTickEvents().some((event) => isZukAttackEvent(event) && event.sourceId === ranger.id)) {
        shotTick = engine.currentTick;
      }
    }

    expect(shotTick).toBeGreaterThan(0);
    const shots = world.pendingHits.filter((hit) => hit.sourceId === ranger.id);
    expect(shots).toHaveLength(replaced ? 0 : 1);
    if (!replaced) return;
    expect(world.getNpc(ranger.id)).toBe(successor);
    expect(successor).toMatchObject({ combat: { lastAttackTick: null } });
  });

  // A queued death keeps its killing tick's movement: a Yt-HurKot walking back to Jad still takes that
  // step, and its death animation is floored from it (lastStep + 3), not from the kill.
  it.each([true, false])('walks a Yt-HurKot back towards Jad on its killing tick (killed: %s)', (killed) => {
    const { engine, world } = setup();
    enableZukMovement(engine);
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: true });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad-healers' });
    const healers = world.getNpcs().filter(jadHealerDefinition.isActor);
    const healer = healers[0];
    if (!healer) throw new TypeError('Missing Jad healer');
    for (const sibling of healers) if (sibling !== healer) sibling.combat.targetId = 'player';
    advance(engine, 11);
    healer.position = [24, 44];
    healer.previousPosition = [24, 44];
    if (killed)
      enqueueEnginePendingHit(engine, {
        sourceId: 'player',
        targetId: healer.id,
        style: 'range',
        attackKind: 'range_arrow',
        launchTick: 11,
        impactTick: 12,
        rolledDamage: healer.vitals.hp,
        accuracySucceeded: true,
      });

    engine.advanceTick(engine.getState().playerPosition);

    expect(healer.position).not.toEqual([24, 44]);
    expect(healer.lastStepTick).toBe(12);
    if (killed) expect(healer).toMatchObject({ alive: false, death: { processTick: 13 }, deathAnimationTick: 15 });
  });

  // A pending-death NPC keeps its permitted turn but heals nothing (spec section 3: no healing from or
  // to it). Both Inferno healer families, killed on the tick a heal of theirs would land.
  it.each([
    { kind: 'Jal-MejJak pending heal', killed: true },
    { kind: 'Jal-MejJak pending heal', killed: false },
    { kind: 'Yt-HurKot adjacent heal', killed: true },
    { kind: 'Yt-HurKot adjacent heal', killed: false },
  ] as const)('lands a $kind only from a living healer (killed that tick: $killed)', ({ kind, killed }) => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false });
    let healer: NpcActor;
    let parent: NpcActor;
    if (kind === 'Jal-MejJak pending heal') {
      engine.setBossHp(500);
      engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-healers' });
      const found = world.getNpcs().find(healerDefinition.isActor);
      const zuk = world.getNpc('zuk');
      if (!found || !zuk) throw new TypeError('Missing enrage healer');
      for (const actor of world.getNpcs().filter(healerDefinition.isActor)) actor.combat.targetId = 'player';
      found.state.pendingHeals.push({ targetId: 'zuk', amount: 17, applyTick: 13 });
      [healer, parent] = [found, zuk];
    } else {
      engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad-healers' });
      const jad = world.getNpcs().find(jadDefinition.isActor);
      const found = world.getNpcs().find(jadHealerDefinition.isActor);
      if (!jad || !found) throw new TypeError('Missing Jad healer');
      found.position = [jad.position[0], jad.position[1] + jad.size];
      found.state.supportTargetId = jad.id;
      // Its siblings are tagged, so they fight rather than heal.
      for (const sibling of world.getNpcs().filter(jadHealerDefinition.isActor)) {
        if (sibling !== found) sibling.combat.targetId = 'player';
      }
      [healer, parent] = [found, jad];
    }
    advance(engine, 12);
    parent.vitals.hp = 100;
    const jadHealer = jadHealerDefinition.getState(healer);
    if (jadHealer) jadHealer.nextHealTick = 13;
    if (killed)
      enqueueEnginePendingHit(engine, {
        sourceId: 'player',
        targetId: healer.id,
        style: 'range',
        attackKind: 'range_arrow',
        launchTick: 12,
        impactTick: 13,
        rolledDamage: healer.vitals.hp,
        accuracySucceeded: true,
      });

    engine.advanceTick(engine.getState().playerPosition);

    if (killed) {
      expect(healer).toMatchObject({ alive: false, death: { status: 'pending', killTick: 13, processTick: 14 } });
    }
    expect(parent.vitals.hp > 100).toBe(!killed);
    expect(healingEvents(engine.getLastTickEvents()).length > 0).toBe(!killed);
  });

  // Local effects run in each NPC's own turn, before its action (npc-hit-queue-and-death.md section 2);
  // the facts spec leaves the intra-tick heal/hit order unobserved, so the turn order is the model.
  it('applies a pending local heal in the turn of the healer holding it, before that healer acts', () => {
    const { engine, world } = setup();
    engine.setBossHp(500);
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-healers' });
    const healer = world.getNpcs().find(healerDefinition.isActor);
    if (!healer) throw new TypeError('Missing active healer');
    for (const actor of world.getNpcs().filter(healerDefinition.isActor)) actor.combat.targetId = 'player';
    healer.state.pendingHeals.push({ targetId: 'zuk', amount: 17, applyTick: 13 });
    advance(engine, 12);
    expect(world.getNpc('zuk')?.vitals.hp).toBe(500);

    const events = collectTickEvents(engine, 13);

    expect(world.getNpc('zuk')?.vitals.hp).toBe(517);
    const healIndex = events.findIndex(
      (event) => event.type === 'hitsplat_spawned' && event.targetId === 'zuk' && event.hitsplatType === 'heal',
    );
    expect(healIndex).toBeGreaterThanOrEqual(0);
    const healerActionIndex = events.findIndex(
      (event) =>
        isEncounterVisualEvent(event) &&
        event.animations.some((cue) => cue.clipId === 'attack' && cue.actorId === healer.id),
    );
    expect(healerActionIndex).toBeGreaterThan(healIndex);
    expect(healer.state.pendingHeals).toEqual([]);
  });

  it('lets later Jad healers plan through the tile actually vacated by an earlier peer', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad-healers' });
    const [first, second, third] = world.getNpcs().filter((npc) => npc.npcTypeId === 7705);
    const player = world.getPlayer();
    if (!first || !second || !third || !player) throw new TypeError('Missing pursuit actors');
    first.position = [30, 42];
    second.position = [30, 41];
    third.position = [40, 40];
    player.position = [30, 45];
    for (const healer of [first, second]) healer.combat.targetId = player.id;
    setArenaConfig({
      bounds: null,
      walkableTiles: new Set(['30,41', '30,42', '30,43', '30,44', '30,45', '29,42', '29,43', '29,44', '29,45']),
      collisionMap: null,
    });

    engine.advanceTick(player.position);

    expect(first.position).toEqual([30, 43]);
    expect(second.position).toEqual([30, 42]);
  });

  it.each([44, 20])('keeps opening delays 6/8 and period 4 after both actors are tagged at player Y=%i', (playerY) => {
    const { engine, world } = setup();
    enableZukMovement(engine);
    engine.setMechanicsConfig({ zukAttacks: false, infiniteHealth: true });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-set' });
    const mager = world.getNpcs().find((npc) => npc.npcTypeId === 7703);
    const ranger = world.getNpcs().find((npc) => npc.npcTypeId === 7702);
    const player = world.getPlayer();
    if (!mager || !ranger || !player) throw new TypeError('Missing recorded set');
    player.position = [31, playerY];
    expect(mager.combat.attackRange).toBe(15);
    expect(ranger.combat.attackRange).toBe(16);
    for (const actor of [mager, ranger]) {
      expect.soft(actor.definition).toBeDefined();
      expect.soft(actor.combat).toMatchObject({ attackSpeed: 4, targetId: 'zuk_shield' });
      notifyNpcOfPlayerAttack(actor, {
        sourceId: 'player',
        launchTick: 0,
        impactTick: 1,
        style: 'range',
        accuracySucceeded: true,
      });
    }

    const events = collectTickEvents(engine, 20);

    for (const [actor, style, openingTick] of [
      [mager, 'magic', 6],
      [ranger, 'range', 8],
    ] as const) {
      expect.soft(actor.combat.targetId).toBe('player');
      expect(events.some((event) => event.type === 'movement' && event.actorId === actor.id)).toBe(playerY === 20);
      expect(actor.position).toEqual(actor.history.get(openingTick));
      const attacks = events.filter((event) => event.type === 'attack_started' && event.sourceId === actor.id);
      expect
        .soft(attacks.slice(0, 2))
        .toEqual([
          expect.objectContaining({ tick: openingTick, targetId: 'player', style }),
          expect.objectContaining({ tick: openingTick + 4, targetId: 'player', style }),
        ]);
      const damagedPlayer = engine
        .getDamageHistory()
        .some((damage) => damage.targetId === 'player' && damage.attackType === style && damage.effectiveDamage > 0);
      expect.soft(damagedPlayer).toBe(true);
    }
    expect(world.getNpc('zuk_shield')?.vitals.hp).toBe(600);
  });

  it('reconstructs and takes over seeded set pursuit across the first movement tick after glyph destruction', () => {
    const engine = new SimulationEngine({ encounter: createZukWaveEncounter(19), combatSeed: 31, startPos: [31, 20] });
    enableZukMovement(engine);
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: true });
    engine.setEquipment({});
    const config = engine.getRunConfig();
    const recorder = new ReplayRecorder();
    recorder.startRun(config);
    recorder.recordFrame(0, [31, 20], engine.getState(), []);
    const spawn = { type: 'encounterCommand', command: { encounter: 'zuk', type: 'spawn-set' } } as const;
    recorder.recordAction(spawn);
    engine.applyAction(spawn);
    for (let tick = 1; tick <= 180; tick++) {
      engine.advanceTick([31, 20]);
      recorder.recordFrame(tick, [31, 20], engine.getState(), engine.getLastTickEvents());
    }
    const recorded = recorder.exportData();
    const pursuit = recorded.frames.find((frame) =>
      frame.events.some(
        (event) =>
          isCoreEvent(event, 'movement') &&
          (event.actorId.startsWith('zuk_mager_') || event.actorId.startsWith('zuk_ranger_')),
      ),
    );
    if (!pursuit) throw new TypeError('Expected a recorded live set movement tick');
    const expected = structuredClone(engine.getState());
    const rebuilt = createSimulationEngineFromRunConfig(config, null);
    if (!rebuilt) throw new TypeError('Missing set movement replay engine');
    engine.reset(undefined, config);

    for (const frame of recorded.frames.slice(1, pursuit.tick + 1)) {
      const hydrated = recorder.getFrame(frame.tick);
      if (!hydrated) throw new TypeError('Missing hydrated movement frame');
      for (const target of [engine, rebuilt]) {
        for (const action of frame.actions) target.applyAction(action);
        target.advanceTick(frame.input);
        expect(diffResumableState(hydrated.state, target.getState())).toEqual([]);
      }
    }
    for (const target of [engine, rebuilt]) {
      advance(target, 180);
      expect(diffResumableState(expected, target.getState())).toEqual([]);
      expect(target.getDamageHistory()).toEqual(recorded.damageHistory);
    }
  });

  it('lets the ranger attack the glyph at the western endpoint without moving', () => {
    const { engine, world } = setup();
    enableZukMovement(engine);
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false });
    advance(engine, 36);
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-ranger' });
    const ranger = world.getNpcs().find((npc) => npc.npcTypeId === 7702);
    if (!ranger) throw new TypeError('Missing Zuk ranger');

    const events = collectTickEvents(engine, 44);

    expect(world.getNpc('zuk_shield')?.position).toEqual([17, 48]);
    expect(ranger.position).toEqual([35, 39]);
    expect(events.filter((event) => event.type === 'attack_started' && event.sourceId === ranger.id)).toEqual([
      expect.objectContaining({ tick: 44, targetId: 'zuk_shield', style: 'range' }),
    ]);
  });

  it('casts default enrage support at spawn+4 and +7 and applies sampled amounts four ticks later', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    hit(engine, 'zuk', 239);
    const initialDamage = structuredClone(engine.getDamageHistory());
    const healers = world.getNpcs().filter((npc) => npc.npcTypeId === 7708);
    expect(healers).toHaveLength(4);

    const allEvents = collectTickEvents(engine, 12);
    const events = allEvents.filter(isEncounterVisualEvent);

    for (const tick of [4, 7]) {
      const volley = events.filter((event) => event.tick === tick);
      const castingIds = volley
        .flatMap((event) => event.animations)
        .filter((cue) => cue.clipId === 'heal')
        .map((cue) => cue.actorId)
        .sort();
      expect.soft(castingIds).toEqual(healers.map((actor) => actor.id).sort());
      expect.soft(volley.flatMap((event) => event.projectiles)).toEqual(
        Array.from({ length: 4 }, () =>
          expect.objectContaining({
            spotAnimId: 660,
            target: expect.objectContaining({ kind: 'actor', actorId: 'zuk' }),
          }),
        ),
      );
    }
    const heals = healingEvents(allEvents);
    expect(heals.map((event) => event.tick)).toEqual([8, 8, 8, 8, 11, 11, 11, 11]);
    expect(heals.every((event) => event.amount >= 15 && event.amount <= 24)).toBe(true);
    expect(world.getNpc('zuk')?.vitals.hp).toBe(239 + heals.reduce((total, event) => total + event.amount, 0));
    expect(engine.getDamageHistory()).toEqual(initialDamage);
  });

  it('retargets only the enrage healer hit at tick 5 while three siblings keep their tick 7 support casts', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    hit(engine, 'zuk', 239);
    const initialDamage = structuredClone(engine.getDamageHistory());
    const healers = world.getNpcs().filter((npc) => npc.npcTypeId === 7708);
    const [tagged, ...untouched] = healers;
    if (!tagged) throw new TypeError('Missing enrage healer');
    expect(untouched).toHaveLength(3);
    advance(engine, 4);
    notifyNpcOfPlayerAttack(tagged, {
      sourceId: 'player',
      launchTick: 4,
      impactTick: 5,
      style: 'range',
      accuracySucceeded: true,
    });
    expect.soft(tagged.combat.targetId).toBeNull();
    expect(tagged.state).toMatchObject({ supportTargetId: 'zuk' });

    const reactionEvents = collectTickEvents(engine, 5);

    expect.soft(tagged.combat.targetId).toBe('player');
    expect.soft(untouched.map((actor) => actor.combat.targetId)).toEqual([null, null, null]);
    for (const actor of healers) expect(actor.state).toMatchObject({ supportTargetId: 'zuk' });
    const laterEvents = [...reactionEvents, ...collectTickEvents(engine, 7)];
    const castingIds = laterEvents
      .filter(isEncounterVisualEvent)
      .filter((event) => event.tick === 7)
      .flatMap((event) => event.animations)
      .filter((cue) => cue.clipId === 'heal')
      .map((cue) => cue.actorId)
      .sort();
    expect.soft(castingIds).toEqual(untouched.map((actor) => actor.id).sort());
    expect(laterEvents.filter((event) => event.type === 'attack_started')).toEqual([]);
    expect(
      laterEvents
        .filter(isEncounterVisualEvent)
        .flatMap((event) => event.projectiles)
        .every((cue) => cue.spotAnimId === 660 && (cue.target.kind === 'tile' || cue.target.actorId === 'zuk')),
    ).toBe(true);
    expect(world.getNpc('zuk')?.vitals.hp).toBe(239);
    expect(engine.getDamageHistory()).toEqual(initialDamage);
  });

  it('engages a Jad healer on a splash and pursues into real melee without changing its parent identity', () => {
    const { engine, world, encounter } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, infiniteHealth: true });
    forceJadHealerTiles(encounter);
    setArenaConfig({
      ...getArenaConfig(),
      // The corridor, plus the captured healer tiles beside Jad ([31,40], [30,40]), where they stay healing.
      walkableTiles: new Set([
        '27,43',
        '28,43',
        '29,43',
        '30,43',
        '30,42',
        '29,42',
        '28,42',
        '27,42',
        '30,41',
        '31,40',
        '30,40',
      ]),
    });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad-healers' });
    const jad = world.getNpcs().find((npc) => npc.npcTypeId === 7704);
    const healer = world.getNpcs().find((npc) => npc.npcTypeId === 7705 && npc.position[1] === 41);
    const player = world.getPlayer();
    if (!jad || !healer || !player) throw new TypeError('Missing Jad healer scenario actors');
    player.position = [27, 43];
    const healerHp = healer.vitals.hp;
    expect(healer.state).toMatchObject({ parentId: jad.id, supportTargetId: jad.id });
    expect.soft(healer.combat.targetId).toBeNull();

    notifyNpcOfPlayerAttack(healer, {
      sourceId: player.id,
      launchTick: 0,
      impactTick: 10,
      style: 'magic',
      accuracySucceeded: false,
    });

    // Standard retaliation: a splash reacts on the tick after the cast.
    expect.soft(healer.combat.retaliation?.pending).toEqual([{ tick: 1, sourceId: player.id }]);
    const events = collectTickEvents(engine, 20);
    expect.soft(healer.combat.targetId).toBe(player.id);
    expect.soft(events.some((event) => event.type === 'movement' && event.actorId === healer.id)).toBe(true);
    expect
      .soft(events.filter((event) => event.type === 'attack_started'))
      .toContainEqual(expect.objectContaining({ sourceId: healer.id, targetId: player.id, style: 'melee' }));
    const damagedPlayer = engine
      .getDamageHistory()
      .some((damage) => damage.targetId === player.id && damage.attackType === 'melee' && damage.effectiveDamage > 0);
    expect.soft(damagedPlayer).toBe(true);
    expect(healer.vitals.hp).toBe(healerHp);
    expect(healer.state).toMatchObject({ parentId: jad.id, supportTargetId: jad.id });
  });
});

describe('Zuk live Jad combat policy', () => {
  it.each([35, 37])('does not initiate on an overlap escape turn when the player ends at Y=%s', (playerY) => {
    const { engine, encounter, player, jad } = setupLiveJad();
    enableZukMovement(engine);
    advance(engine, 15);
    player.position = [30, 35];
    const random = vi.fn(() => 0.25);
    zukDirector(encounter)['random'] = random;
    const readyTick = jad.combat.nextActionTick;

    engine.advanceTick([30, playerY]);

    expect(jad.position).toEqual([30, 36]);
    expect(player.position).toEqual([30, playerY]);
    expect(engine.getLastTickEvents().filter((event) => event.type === 'zuk_jad_cue')).toEqual([]);
    expect(jad.state.pendingAttack).toBeNull();
    expect(jad.combat.nextActionTick).toBe(readyTick);
    expect(random).toHaveBeenCalledTimes(1);
  });

  it('initiates next turn before the exposed player moves back under', () => {
    const { engine, encounter, player, jad } = setupLiveJad();
    enableZukMovement(engine);
    advance(engine, 15);
    player.position = [30, 35];
    zukDirector(encounter)['random'] = () => 0.25;
    engine.advanceTick([30, 35]);

    engine.advanceTick([30, 37]);

    const events = engine.getLastTickEvents();
    const cueIndex = events.findIndex((event) => event.type === 'zuk_jad_cue');
    const moveIndex = events.findIndex((event) => event.type === 'movement' && event.actorId === player.id);
    expect(cueIndex).toBeGreaterThanOrEqual(0);
    expect(moveIndex).toBeGreaterThan(cueIndex);
    expect(jad.state.pendingAttack).toMatchObject({ releaseTick: 20 });
    expect(jad.combat.nextActionTick).toBe(25);
    expect(player.position).toEqual([30, 37]);
  });

  // NPC actions resolve before player movement, so a target the player exposes by its own step is
  // first attackable on the following NPC phase. No per-cause rule is needed for LOS or overlap.
  it.each([
    { exposure: 'steps out of a LOS shadow', start: [31, 25], destination: [30, 25] },
    { exposure: 'walks out from under Jad', start: [31, 35], destination: [31, 34] },
  ] as const)('initiates the tick after the player $exposure', ({ start, destination }) => {
    const { engine, encounter, player, jad } = setupLiveJad();
    enableZukMovement(engine);
    const flags = new Int32Array(64 * 64);
    flags[31 + 27 * 64] = CollisionFlag.OBJECT_PROJECTILE_BLOCKER;
    setResolvedArenaConfig('inferno', {
      ...getArenaConfig(),
      collisionMap: {
        sizeX: 64,
        sizeY: 64,
        flags,
        getFlag: (tileX, tileY) => flags[tileX + tileY * 64],
        hasFlag: (tileX, tileY, flag) => (flags[tileX + tileY * 64] & flag) !== 0,
        flag: (tileX, tileY, flag) => {
          flags[tileX + tileY * 64] |= flag;
        },
        unflag: (tileX, tileY, flag) => {
          flags[tileX + tileY * 64] &= ~flag;
        },
      },
    });
    engine.reapplyArenaConfig();
    jad.debuffs = { boundFromTick: 0, boundUntilTick: 100 };
    zukDirector(encounter)['random'] = () => 0.25;
    player.position = [...start];
    expect(collectTickEvents(engine, 15).filter((event) => event.type === 'zuk_jad_cue')).toEqual([]);
    expect(jad.combat.nextActionTick).toBeLessThanOrEqual(16);

    engine.advanceTick([...destination]);

    expect(player.position).toEqual(destination);
    expect(engine.getLastTickEvents().filter((event) => event.type === 'zuk_jad_cue')).toEqual([]);
    engine.advanceTick([...destination]);
    expect(engine.getLastTickEvents().filter((event) => event.type === 'zuk_jad_cue')).toMatchObject([{ tick: 17 }]);
  });

  it.each(['interior', 'blocked'] as const)('keeps readiness after an %s overlap escape', (condition) => {
    const { engine, encounter, player, jad } = setupLiveJad();
    enableZukMovement(engine);
    advance(engine, 15);
    player.position = condition === 'interior' ? [32, 37] : [30, 35];
    if (condition === 'blocked') jad.debuffs = { boundFromTick: 16, boundUntilTick: 17 };
    zukDirector(encounter)['random'] = () => 0.25;

    engine.advanceTick(player.position);

    expect(jad.position).toEqual(condition === 'interior' ? [30, 36] : [30, 35]);
    expect(jad.combat.nextActionTick).toBe(16);
    expect(engine.getLastTickEvents().filter((event) => event.type === 'zuk_jad_cue')).toEqual([]);
  });

  it('releases an existing windup while escaping overlap and delivers its queued hit', () => {
    const { engine, encounter, player, jad } = setupLiveJad(1);
    enableZukMovement(engine);
    advance(engine, 10);
    player.position = [30, 35];
    zukDirector(encounter)['random'] = () => 0.25;

    const events = collectTickEvents(engine, 13);

    expect(events.filter(isZukAttackEvent)).toMatchObject([{ attack: 'jad_range', launchTick: 11, impactTick: 13 }]);
    expect(engine.getDamageHistory()).toContainEqual(expect.objectContaining({ tick: 13, attackType: 'range' }));
    expect(jad.combat.nextActionTick).toBe(16);
  });

  it.each([
    { type: 'spawn-mager', npcTypeId: 7703 },
    { type: 'spawn-ranger', npcTypeId: 7702 },
    { type: 'spawn-jad-healers', npcTypeId: 7705 },
  ] as const)('suppresses only initiation for an escaping $type', ({ type, npcTypeId }) => {
    const { engine, encounter, world } = setup();
    enableZukMovement(engine);
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false });
    engine.executeEncounterCommand({ encounter: 'zuk', type });
    advance(engine, 15);
    const actor = world.getNpcs().find((npc) => npc.npcTypeId === npcTypeId);
    const player = world.getPlayer();
    if (!actor || !player) throw new TypeError('Missing overlap actors');
    actor.position = [25, 30];
    actor.combat.targetId = player.id;
    actor.combat.nextActionTick = 16;
    player.position = [25, 30];
    const random = vi.fn(() => 0.25);
    zukDirector(encounter)['random'] = random;

    engine.advanceTick(player.position);

    expect(actor.position).toEqual([25, 31]);
    expect(
      engine.getLastTickEvents().filter((event) => isZukAttackEvent(event) && event.sourceId === actor.id),
    ).toEqual([]);
    expect(actor.combat.nextActionTick).toBe(16);
    const events = collectTickEvents(engine, 17);
    expect(events.filter((event) => isZukAttackEvent(event) && event.sourceId === actor.id)).toHaveLength(1);
  });

  it.each([
    [0, 'magic'],
    [1, 'range'],
  ] as const)('uses seeded opening %s for %s and keeps ranged/magic cues eight ticks apart', (seed, style) => {
    const { engine, jad } = setupLiveJad(seed);

    const events = collectTickEvents(engine, 40);

    const cues = events.flatMap((event) =>
      event.type === 'zuk_jad_cue' ? [{ style: event.style, tick: event.tick }] : [],
    );
    expect(cues[0]).toMatchObject({ tick: 8, style });
    expect(cues.map((event) => event.tick)).toEqual([8, 16, 24, 32, 40]);
    expect(cues.every((event) => event.style === 'magic' || event.style === 'range')).toBe(true);
    expect(events.filter(isZukAttackEvent).map((event) => event.launchTick)).toEqual([11, 19, 27, 35]);
    expect(events.filter((event) => event.type === 'attack_started').map((event) => event.tick)).toEqual([
      11, 19, 27, 35,
    ]);
    expect(events.filter(isEncounterVisualEvent).flatMap((event) => event.animations)).toEqual(
      cues.map((event) => ({ actorId: jad.id, clipId: event.style, delayCycles: 0 })),
    );
    expect(jad.position).toEqual([30, 35]);
  });

  it('recovers four ticks after seeded melee without imposing melee priority on the next adjacent attack', () => {
    const { engine, player } = setupLiveJad(2);
    player.position = [31, 40];

    const events = collectTickEvents(engine, 15);

    expect(events.filter((event) => event.type === 'zuk_jad_cue')).toMatchObject([
      { tick: 8, style: 'melee' },
      { tick: 12, style: 'range' },
    ]);
    expect(events.filter((event) => event.type === 'attack_started')).toMatchObject([
      { tick: 8, attackKind: 'melee_stab', impactDelayTicks: 0 },
      { tick: 15, attackKind: 'range_arrow', impactDelayTicks: 2 },
    ]);
  });

  it.each([
    ['magic', 0.1, 11, 12, 'magic_fire'],
    ['range', 0.75, 11, 13, 'range_arrow'],
    ['melee', 0.9, 8, 8, 'melee_stab'],
  ] as const)('applies the real %s maximum and permits accuracy misses without forced hits', (style, selection, release, impact, attackKind) => {
    for (const accuracy of [0, 0.999999999]) {
      const { engine, encounter, player } = setupLiveJad();
      engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: false });
      player.vitals = { hp: 200, maxHp: 200 };
      if (style === 'melee') player.position = [31, 40];
      const rolls = [selection, accuracy, 0.999999999];
      zukDirector(encounter)['random'] = () => {
        const roll = rolls.shift();
        if (roll === undefined) throw new TypeError('Unexpected Jad random draw');
        return roll;
      };

      const events = collectTickEvents(engine, impact);

      expect(events.filter((event) => event.type === 'attack_started')).toMatchObject([
        { tick: release, style, attackKind },
      ]);
      expect(engine.getDamageHistory()).toMatchObject([
        { tick: impact, attackType: style, effectiveDamage: accuracy === 0 ? 113 : 0, prayedCorrectly: false },
      ]);
      expect(player.vitals.hp).toBe(accuracy === 0 ? 87 : 200);
      expect(rolls).toEqual([]);
    }
  });

  it.each([
    [0, PrayerType.ProtectMagic, 12],
    [1, PrayerType.ProtectRange, 13],
  ] as const)('judges seed %s protection on cue+3 rather than cue or impact', (seed, prayer, impact) => {
    for (const timing of ['cue-only', 'release-only', 'late'] as const) {
      const { engine } = setupLiveJad(seed);
      advance(engine, 7);
      if (timing === 'cue-only') engine.queueProtectionPrayer(prayer);
      advance(engine, 8);
      if (timing === 'cue-only') engine.queueProtectionPrayer(null);
      advance(engine, 10);
      if (timing === 'release-only') engine.queueProtectionPrayer(prayer);
      advance(engine, 11);
      engine.queueProtectionPrayer(timing === 'late' ? prayer : null);

      advance(engine, impact);

      const damage = engine.getDamageHistory();
      expect(damage).toHaveLength(1);
      expect(damage[0]).toMatchObject({ tick: impact, prayedCorrectly: timing === 'release-only' });
      if (timing === 'release-only') expect(damage[0].effectiveDamage).toBe(0);
      else expect(damage[0].effectiveDamage).toBeGreaterThan(0);
    }
  });

  it('places ranged rock 451 at release on the pre-movement tile without a traveling projectile', () => {
    const { engine, player } = setupLiveJad(1);
    setArenaConfig({ ...getArenaConfig(), walkableTiles: new Set(['31,44', '32,44', '33,44']) });
    const beforeRelease = collectTickEvents(engine, 10);

    engine.advanceTick([33, 44]);

    const release = engine.getLastTickEvents();
    expect(beforeRelease.filter(isEncounterVisualEvent).flatMap((event) => event.graphics)).toEqual([]);
    expect(player.position).toEqual([33, 44]);
    expect(release.filter(isEncounterVisualEvent)).toMatchObject([
      {
        tick: 11,
        animations: [],
        projectiles: [],
        graphics: [{ spotAnimId: 451, target: { kind: 'tile', position: [31, 44] }, delayCycles: 0, height: 92 }],
      },
    ]);
    expect(release.filter(isZukAttackEvent)).toMatchObject([
      { attack: 'jad_range', targetPosition: [31, 44], launchTick: 11, impactTick: 13 },
    ]);
    advance(engine, 13);
    expect(engine.getDamageHistory()).toMatchObject([{ tick: 13, attackType: 'range' }]);
  });

  it.each([
    [[32, 40], 26, 11],
    [[31, 44], 58, 12],
    [[31, 20], 138, 15],
  ] as const)('uses release-relative magic windows and hit delay at target %s', (position, endCycles, impact) => {
    const { engine, player } = setupLiveJad(0);
    player.position = [...position];

    const events = collectTickEvents(engine, impact);

    const volley = events.filter(isEncounterVisualEvent).flatMap((event) => event.projectiles);
    expect(volley).toMatchObject([
      { spotAnimId: 448, startDelayCycles: 2, endDelayCycles: endCycles },
      { spotAnimId: 449, startDelayCycles: 6, endDelayCycles: endCycles + 4 },
      { spotAnimId: 450, startDelayCycles: 10, endDelayCycles: endCycles + 10 },
    ]);
    for (const projectile of volley) {
      expect(projectile).toMatchObject({
        sourcePosition: [32.5, 37.5],
        target: { actorId: 'player', position },
        slope: 16,
        startOffset: 32,
        startHeight: 512,
        endHeight: 124,
      });
    }
    expect(events.filter(isZukAttackEvent)).toMatchObject([
      { attack: 'jad_magic', launchTick: 11, impactTick: impact, projectileArrivalCycles: endCycles },
    ]);
    expect(events.filter(isEncounterVisualEvent).flatMap((event) => event.graphics)).toEqual([]);
    expect(engine.getDamageHistory()).toMatchObject([{ tick: impact, attackType: 'magic' }]);
  });

  it('steps off an overlapping player during cooldown and resumes attacking', () => {
    const { engine, encounter, player, jad } = setupLiveJad();
    enableZukMovement(engine);
    advance(engine, 11);
    player.position = [30, 35];
    zukDirector(encounter)['random'] = () => 0.25;

    advance(engine, 12);

    expect(jad.position).toEqual([30, 36]);
    expect(jad.combat.targetId).toBe(player.id);
    expect(collectTickEvents(engine, 19).filter(isZukAttackEvent)).toMatchObject([
      { sourceId: jad.id, targetId: player.id, launchTick: 19 },
    ]);
  });

  it('pursues an out-of-range player and stops as soon as it can attack', () => {
    const { engine, player, jad } = setupLiveJad();
    enableZukMovement(engine);
    player.position = [31, 19];

    const events = collectTickEvents(engine, 20);

    expect(jad.position).toEqual([31, 34]);
    expect(events.filter((event) => event.type === 'zuk_jad_cue')).toMatchObject([{ tick: 9 }, { tick: 17 }]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'movement', actorId: jad.id, tick: 9 }));
  });

  it('does not choose styles while bound out of reach and attacks at the edge of range 15', () => {
    const { engine, encounter, player, jad } = setupLiveJad();
    jad.debuffs = { boundFromTick: 0, boundUntilTick: 21 };
    const random = vi.fn(zukDirector(encounter)['random']);
    zukDirector(encounter)['random'] = random;
    player.position = [31, 19];
    const unreachable = collectTickEvents(engine, 20);
    expect(unreachable.filter((event) => event.type === 'zuk_jad_cue')).toEqual([]);
    expect(random).not.toHaveBeenCalled();
    player.position = [31, 20];

    const eligible = collectTickEvents(engine, 21);

    expect(eligible.filter((event) => event.type === 'zuk_jad_cue')).toMatchObject([{ tick: 21, style: 'magic' }]);
    expect(random).toHaveBeenCalledTimes(1);
    expect(jad.position).toEqual([30, 35]);
  });

  it.each([0, 1])('damages the glyph for seed %s and preserves a pending glyph target through retaliation', (seed) => {
    const { engine, encounter, world } = setup(seed);
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: true });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad' });
    const jad = world.getNpcs().find(jadDefinition.isActor);
    if (!jad) throw new TypeError('Missing glyph-targeting Jad');
    const random = vi.fn(zukDirector(encounter)['random']);
    zukDirector(encounter)['random'] = random;
    advance(engine, 8);
    notifyNpcOfPlayerAttack(jad, {
      sourceId: 'player',
      launchTick: 8,
      impactTick: 9,
      style: 'range',
      accuracySucceeded: true,
    });

    const events = collectTickEvents(engine, 14);

    expect(jad.combat.targetId).toBe('player');
    expect(events.filter(isZukAttackEvent)).toMatchObject([{ targetId: 'zuk_shield', launchTick: 11 }]);
    expect(events.filter((event) => event.type === 'attack_started')).toMatchObject([
      { sourceId: jad.id, targetId: 'zuk_shield', tick: 11 },
    ]);
    expect(world.pendingHits).toEqual([]);
    const glyphDamage = engine.getDamageHistory();
    expect(glyphDamage).toHaveLength(1);
    expect(glyphDamage[0]).toMatchObject({ targetId: 'zuk_shield', hpBefore: 600 });
    expect(glyphDamage[0].effectiveDamage).toBeGreaterThan(0);
    expect(world.getNpc('zuk_shield')?.vitals.hp).toBe(600 - glyphDamage[0].effectiveDamage);
    expect(world.getNpc('zuk_shield')?.formulaStats).toEqual({
      levels: { attack: 1, strength: 1, defence: 1, ranged: 1, magic: 1 },
      offensive: { atk: 0, ranged: 0, magic: 0, str: 0, rangedStr: 0, magicStr: 0 },
      defensive: { stab: 0, slash: 0, crush: 0, rangedLight: 0, rangedStandard: 0, rangedHeavy: 0, magic: 0 },
      attributes: [],
    });
    expect(random).toHaveBeenCalledTimes(3);
    const playerAttacks = collectTickEvents(engine, 21).filter(isZukAttackEvent);
    expect(playerAttacks).toMatchObject([{ targetId: 'player', launchTick: 19 }]);
  });

  it.each(['missing', 'dead'] as const)('cancels the live pending release when the glyph target is %s', (condition) => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad' });
    const glyph = world.getNpc('zuk_shield');
    const jad = world.getNpcs().find(jadDefinition.isActor);
    if (!glyph || !jad) throw new TypeError('Missing cancellation actors');
    advance(engine, 8);
    expect(jad.state.pendingAttack).not.toBeNull();
    if (condition === 'missing') world.actors.delete(glyph.id);
    else glyph.alive = false;

    const events = collectTickEvents(engine, 15);

    expect(events.filter(isZukAttackEvent)).toEqual([]);
    expect(events.filter(isEncounterVisualEvent)).toEqual([]);
    expect(jad.state.pendingAttack).toBeNull();
    expect(engine.getDamageHistory()).toEqual([]);
    const recovery = collectTickEvents(engine, 20);
    expect(jad.combat.targetId).toBe('player');
    expect(recovery.filter(isZukAttackEvent)).toMatchObject([{ targetId: 'player', launchTick: 19 }]);
  });

  it('keeps independently spawned live Jad opening clocks and pending attacks separate', () => {
    const { engine, world, jad } = setupLiveJad();
    advance(engine, 3);
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad' });
    const other = world.getNpcs().find((actor) => jadDefinition.isActor(actor) && actor.id !== jad.id);
    if (!other) throw new TypeError('Missing second Jad');

    const events = collectTickEvents(engine, 22);

    expect(
      events.filter((event) => event.type === 'zuk_jad_cue' && event.sourceId === jad.id).map((event) => event.tick),
    ).toEqual([8, 16]);
    expect(
      events.filter((event) => event.type === 'zuk_jad_cue' && event.sourceId === other.id).map((event) => event.tick),
    ).toEqual([11, 19]);
    expect(events.filter(isZukAttackEvent).map((event) => [event.sourceId, event.targetId, event.launchTick])).toEqual([
      [jad.id, 'player', 11],
      [other.id, 'zuk_shield', 14],
      [jad.id, 'player', 19],
      [other.id, 'zuk_shield', 22],
    ]);
    expect(jad.state).not.toBe(other.state);
  });

  it.each(['death', 'despawn'] as const)('cancels an unreleased live attack on Jad %s', (condition) => {
    const { engine, jad } = setupLiveJad();
    advance(engine, 10);
    expect(jad.state.pendingAttack).toMatchObject({ releaseTick: 11 });
    if (condition === 'death') hit(engine, jad.id, 0);
    else engine['despawnEncounterNpc'](jad.id);

    const events = collectTickEvents(engine, 20);

    expect(events.filter(isZukAttackEvent)).toEqual([]);
    expect(events.filter(isEncounterVisualEvent)).toEqual([]);
    expect(jad.state.pendingAttack).toBeNull();
    expect(engine.getDamageHistory().filter((damage) => damage.targetId === 'player')).toEqual([]);
  });

  // The windup above dies with Jad because his death is processed before the release tick (Jad
  // 5173 -> 5174). Killed ON the release tick, he still takes that turn: the attack is released and,
  // released, persists. His death sequence and sound 409 follow a tick later (W69 t983 -> t984).
  it('releases a windup due on his killing tick, and that hit still lands after he dies', () => {
    const { engine, jad } = setupLiveJad();
    advance(engine, 10);
    expect(jad.state.pendingAttack).toMatchObject({ releaseTick: 11 });
    enqueueEnginePendingHit(engine, {
      sourceId: 'player',
      targetId: jad.id,
      style: 'range',
      attackKind: 'range_arrow',
      launchTick: 10,
      impactTick: 11,
      rolledDamage: jad.vitals.hp,
      accuracySucceeded: true,
    });

    const events = collectTickEvents(engine, 20);

    const [release] = events.filter(isZukAttackEvent);
    expect(release).toMatchObject({ sourceId: jad.id, targetId: 'player', launchTick: 11 });
    expect(jad).toMatchObject({ death: { killTick: 11, processTick: 12 }, deathAnimationTick: 12 });
    expect(events.filter((event) => event.type === 'zuk_death')).toMatchObject([{ actorId: jad.id, tick: 12 }]);
    expect(
      engine
        .getDamageHistory()
        .filter((damage) => damage.targetId === 'player')
        .map((damage) => [damage.tick, damage.sourceNpcTypeId]),
    ).toEqual([[release?.impactTick, 7704]]);
  });

  // Takeover re-simulates the recorded prefix, so the death state the engine keeps off the snapshot
  // (processing order, the death record, the life generation) must come back exactly — here with a
  // queued Jad death still pending on the frame taken over.
  it('takes over mid-way through a queued death with the same hidden death state', () => {
    const engine = new SimulationEngine({ encounter: createZukWaveEncounter(3), combatSeed: 5, startPos: [31, 40] });
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: true });
    engine.setEquipment({});
    // A recorded, reproducible way for an unarmed player to kill Jad in a few swings.
    const stats = createDefaultStats();
    engine.setPlayerStats({ ...stats, attack: { current: 5000, max: 5000 }, strength: { current: 5000, max: 5000 } });
    const config = engine.getRunConfig();
    const recorder = new ReplayRecorder();
    recorder.startRun(config);
    recorder.recordFrame(0, [31, 40], engine.getState(), []);
    const spawn = { type: 'encounterCommand', command: { encounter: 'zuk', type: 'spawn-jad' } } as const;
    const engage = { type: 'attackTarget', targetId: 'zuk_jad_0' } as const;
    for (const action of [spawn, engage]) {
      recorder.recordAction(action);
      engine.applyAction(action);
    }
    const world = engine['worldState'];
    let killFrame = -1;
    for (let tick = 1; tick <= 600 && killFrame < 0; tick++) {
      engine.advanceTick([31, 40]);
      recorder.recordFrame(tick, [31, 40], engine.getState(), engine.getLastTickEvents());
      if (world.getNpcs().some((npc) => jadDefinition.isActor(npc) && npc.death?.status === 'pending')) {
        killFrame = tick;
      }
    }
    expect(killFrame).toBeGreaterThan(0);
    const hiddenState = (target: SimulationEngine) =>
      target['worldState']
        .getNpcs()
        .map(({ id, processingOrder, death, lifeGeneration, lastStepTick, deathAnimationTick }) => ({
          id,
          processingOrder,
          death,
          lifeGeneration,
          lastStepTick,
          deathAnimationTick,
        }));

    const rebuilt = reconstructReplayPrefix(config, recorder.getReconstructionFrames(), killFrame, null);
    if (!rebuilt) throw new TypeError('Missing rebuilt engine');

    expect(diffResumableState(engine.getState(), rebuilt.getState())).toEqual([]);
    expect(hiddenState(rebuilt)).toEqual(hiddenState(engine));
    expect(hiddenState(engine)).toContainEqual(
      expect.objectContaining({ death: expect.objectContaining({ status: 'pending', killTick: killFrame }) }),
    );
    for (const target of [engine, rebuilt]) target.advanceTick([31, 40]);
    expect(hiddenState(rebuilt)).toEqual(hiddenState(engine));
  });

  it('rebuilds seeded live Jad windup for replay takeover and repeats the same post-release combat after reset', () => {
    const engine = new SimulationEngine({ encounter: createZukWaveEncounter(1), combatSeed: 31, startPos: [31, 40] });
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: true });
    engine.setEquipment({});
    const config = engine.getRunConfig();
    const recorder = new ReplayRecorder();
    recorder.startRun(config);
    recorder.recordFrame(0, [31, 40], engine.getState(), []);
    const spawn = { type: 'encounterCommand', command: { encounter: 'zuk', type: 'spawn-jad' } } as const;
    const engage = { type: 'attackTarget', targetId: 'zuk_jad_0' } as const;
    for (const action of [spawn, engage]) {
      recorder.recordAction(action);
      engine.applyAction(action);
    }
    for (let tick = 1; tick <= 24; tick++) {
      if (tick === 2) {
        const stop = { type: 'attackTarget', targetId: null } as const;
        recorder.recordAction(stop);
        engine.applyAction(stop);
      }
      engine.advanceTick([31, 40]);
      recorder.recordFrame(tick, [31, 40], engine.getState(), engine.getLastTickEvents());
    }
    const recorded = recorder.exportData();
    expect(
      recorded.frames.flatMap((frame) => frame.events).filter((event) => event.type === 'attack_started'),
    ).toContainEqual(expect.objectContaining({ sourceId: 'player', targetId: 'zuk_jad_0' }));
    expect(recorded.frames.flatMap((frame) => frame.events).filter(isZukAttackEvent)).toContainEqual(
      // The spawn command lands at the start of tick 1, so Jad's first windup releases on 12.
      expect.objectContaining({ sourceId: 'zuk_jad_0', targetId: 'player', launchTick: 12 }),
    );
    const expectedState = structuredClone(engine.getState());
    const rebuilt = createSimulationEngineFromRunConfig(config, null);
    if (!rebuilt) throw new TypeError('Missing Jad replay engine');
    engine.reset(undefined, config);

    for (const frame of recorded.frames.slice(1, 10)) {
      const hydrated = recorder.getFrame(frame.tick);
      if (!hydrated) throw new TypeError('Missing hydrated replay frame');
      for (const target of [engine, rebuilt]) {
        for (const action of frame.actions) target.applyAction(action);
        target.advanceTick(frame.input);
        expect(diffResumableState(hydrated.state, target.getState())).toEqual([]);
      }
    }
    for (const target of [engine, rebuilt]) {
      const jad = target['worldState'].getNpcs().find(jadDefinition.isActor);
      expect(jad?.state.pendingAttack).toMatchObject({ targetId: 'player', releaseTick: 12 });
      advance(target, 24);
      expect(diffResumableState(expectedState, target.getState())).toEqual([]);
      expect(target.getDamageHistory()).toEqual(recorded.damageHistory);
    }
  });
});

describe('Zuk practice commands on the tick boundary', () => {
  // The engine, not the encounter, defers them: the same queue serves every encounter's buttons,
  // the tutorial director and replay reconstruction.
  it.each([
    { type: 'spawn-healers', via: 'button' },
    { type: 'spawn-healers', via: 'replay' },
    { type: 'spawn-jad', via: 'button' },
    { type: 'spawn-set', via: 'button' },
  ] as const)('$type via $via spawns on the next tick, not mid-tick', ({ type, via }) => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ infiniteHealth: true, zukAttacks: false, zukSets: false });
    advance(engine, 5);
    const before = new Set(world.getNpcs().map((npc) => npc.id));
    const command = { encounter: 'zuk', type } as const;

    if (via === 'button') expect(engine.queueEncounterCommand(command)).toBe(true);
    else engine.applyAction({ type: 'encounterCommand', command });

    expect(engine.currentTick).toBe(5);
    expect(world.getNpcs().filter((npc) => !before.has(npc.id))).toEqual([]);

    advance(engine, 6);
    const spawned = engine.getState().npcs.filter((npc) => !before.has(npc.id));
    expect(spawned.length).toBeGreaterThan(0);
    for (const npc of spawned) expect(npc.spawnTick).toBe(6);
  });
});

describe('Zuk practice spawns with their mechanic toggles off', () => {
  function practiceEngine() {
    const scenario = setup();
    scenario.engine.setMechanicsConfig({ infiniteHealth: true, zukAttacks: false, zukSets: false });
    return scenario;
  }
  function run(engine: SimulationEngine, until: number): GameEvent[] {
    const events: GameEvent[] = [];
    for (let tick = engine.currentTick + 1; tick <= until; tick++) {
      engine.advanceTick(engine.getState().playerPosition);
      events.push(...engine.getLastTickEvents());
    }
    return events;
  }

  it('spawns a fighting set while automatic sets are off, and no automatic set follows', () => {
    const { engine } = practiceEngine();
    engine.queueEncounterCommand({ encounter: 'zuk', type: 'spawn-set' });
    // Past the opening set's 72-tick admission, which the off toggle must still suppress.
    const events = run(engine, 90);

    const minions = engine.getState().npcs.filter((npc) => npc.npcTypeId === 7703 || npc.npcTypeId === 7702);
    expect(minions.map((npc) => [npc.npcTypeId, npc.spawnTick, npc.spawnOrigin])).toEqual([
      [7703, 1, 'practice'],
      [7702, 1, 'practice'],
    ]);
    const attackers = new Set(events.filter(isZukAttackEvent).map((event) => event.sourceId));
    for (const minion of minions) expect(attackers).toContain(minion.id);
  });

  it('spawns a Jad that fights while Zuk Attacks is off', () => {
    const { engine } = practiceEngine();
    engine.queueEncounterCommand({ encounter: 'zuk', type: 'spawn-jad' });
    const events = run(engine, 30);

    const jad = engine.getState().npcs.find((npc) => npc.npcTypeId === 7704);
    expect(jad).toMatchObject({ spawnTick: 1, spawnOrigin: 'practice' });
    // Jad opens on the glyph, as in a real fight; what matters is that he fights at all.
    expect(events.filter(isZukAttackEvent)).toContainEqual(expect.objectContaining({ sourceId: jad?.id }));
    // Zuk himself stays silent: the toggle still governs the fight's own attacker.
    expect(events.filter(isZukAttackEvent).some((event) => event.sourceId === 'zuk')).toBe(false);
  });

  it('spawns healers that heal Zuk while Zuk Attacks and sets are off', () => {
    const { engine } = practiceEngine();
    engine.applyAction({ type: 'setBossHp', hp: 900 });
    engine.queueEncounterCommand({ encounter: 'zuk', type: 'spawn-healers' });
    const events = run(engine, 20);

    const healers = engine.getState().npcs.filter((npc) => npc.npcTypeId === 7708);
    expect(healers).toHaveLength(4);
    for (const healer of healers) expect(healer.spawnOrigin).toBe('practice');
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'hitsplat_spawned', targetId: 'zuk', hitsplatType: 'heal' }),
    );
  });

  it('leaves the fight’s own spawns untagged', () => {
    const { engine } = setup();
    engine.setMechanicsConfig({ infiniteHealth: true, zukAttacks: false, zukSets: true });
    run(engine, 73);
    const setMembers = engine.getState().npcs.filter((npc) => npc.npcTypeId === 7703 || npc.npcTypeId === 7702);
    expect(setMembers.length).toBeGreaterThan(0);
    for (const npc of setMembers) expect(npc).not.toHaveProperty('spawnOrigin');
  });
});

describe('Zuk demonstration actor isolation', () => {
  it.each([
    { encounter: 'zuk', type: 'demonstrate-jad', style: 'magic' },
    { encounter: 'zuk', type: 'demonstrate-jad', style: 'range' },
    { encounter: 'zuk', type: 'demonstrate-set' },
    { encounter: 'zuk', type: 'demonstrate-heal' },
  ] as const)('keeps $type $style visual-only over later engine ticks', (command) => {
    const { engine, world, encounter } = setup();
    const random = vi.fn(zukDirector(encounter)['random']);
    zukDirector(encounter)['random'] = random;
    engine.setMechanicsConfig({ zukAttacks: false });
    engine.setBossHp(500);

    engine.executeEncounterCommand(command);

    expect(engine.getLastTickEvents().filter(isEncounterVisualEvent)).toHaveLength(1);
    const actors = world.getNpcs().filter((actor) => actor.role === 'minion');
    expect(actors.length).toBeGreaterThan(0);
    for (const actor of actors) {
      expect(actor.definition).toBeUndefined();
      expect(actor.combat.retaliation).toBeUndefined();
    }
    const events = collectTickEvents(engine, 150);
    expect(events.filter(isEncounterVisualEvent)).toEqual([]);
    expect(events.filter((event) => event.type === 'attack_started')).toEqual([]);
    expect(engine.getDamageHistory()).toEqual([]);
    expect(world.getNpc('zuk')?.vitals.hp).toBe(500);
    expect(world.getNpc('zuk_shield')?.vitals.hp).toBe(600);
    expect(random).not.toHaveBeenCalled();
  });
});

describe('Zuk supplied spark emissions', () => {
  const capture = ZUK_SPARK_CAPTURE;
  const command: ZukSparkVolleyCommand = {
    encounter: 'zuk',
    type: 'emit-spark-volley',
    sparks: [
      { position: [31, 44], amount: 9 },
      { position: [32, 45], amount: 6 },
      { position: [40, 44], amount: 10 },
    ],
  };

  it.each([
    { type: 'clear-spawns', npcTypeIds: [7703, 7702, 7704, 7705, 7708] },
    { type: 'replace-set', npcTypeIds: [7703, 7702] },
  ] as const)('publishes $type species removal with no remaining NPCs and retains supplied sparks', ({
    type,
    npcTypeIds,
  }) => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    engine.executeEncounterCommand(command);
    for (const npc of world.getNpcs()) engine['despawnEncounterNpc'](npc.id);
    advance(engine, 1);
    expect(world.getNpcs()).toEqual([]);

    engine.executeEncounterCommand({ encounter: 'zuk', type });

    expect(engine.getLastTickEvents().filter((event) => event.type === 'actor_presentations_removed')).toEqual([
      expect.objectContaining({ type: 'actor_presentations_removed', npcTypeIds, tick: 1 }),
    ]);
    expect(world.getNpcs().map((npc) => npc.npcTypeId)).toEqual(type === 'replace-set' ? [7703, 7702] : []);
    advance(engine, 4);
    expect(engine.getDamageHistory().map((damage) => [damage.tick, damage.effectiveDamage])).toEqual([
      [3, 9],
      [3, 6],
    ]);
  });

  it('replaces only set actors while publishing presentation removal for their species', () => {
    const { engine, world } = setup();
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-set' });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad-healers' });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-healers' });
    const oldSetIds = world
      .getNpcs()
      .filter((npc) => npc.npcTypeId === 7703 || npc.npcTypeId === 7702)
      .map((npc) => npc.id);
    const retainedIds = world
      .getNpcs()
      .filter((npc) => !oldSetIds.includes(npc.id))
      .map((npc) => npc.id);

    engine.executeEncounterCommand({ encounter: 'zuk', type: 'replace-set' });

    expect(engine.getLastTickEvents().filter((event) => event.type === 'actor_presentations_removed')).toEqual([
      expect.objectContaining({ npcTypeIds: [7703, 7702] }),
    ]);
    expect(
      world
        .getNpcs()
        .filter((npc) => retainedIds.includes(npc.id))
        .map((npc) => npc.id),
    ).toEqual(retainedIds);
    const newSet = world.getNpcs().filter((npc) => !retainedIds.includes(npc.id));
    expect(newSet.map((npc) => npc.npcTypeId)).toEqual([7703, 7702]);
    expect(newSet.every((npc) => !oldSetIds.includes(npc.id))).toBe(true);
  });

  it.each(
    capture.landings,
  )('resolves the captured landing at $tick:$position once with explicit test amounts', (landing) => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing landing-test player');
    player.position = [...landing.position];
    const shots = capture.shots.filter((shot) => shot.tick === landing.tick - 3);
    for (let offset = 0; offset < shots.length; offset += 3)
      engine.executeEncounterCommand(
        ZukSparkVolleyCommandSchema.parse({
          encounter: 'zuk',
          type: 'emit-spark-volley',
          sparks: shots.slice(offset, offset + 3).map((shot) => ({ position: shot.position, amount: 5 })),
        }),
      );
    advance(engine, 2);
    expect(engine.getDamageHistory()).toEqual([]);

    advance(engine, 4);

    const exposed = capture.landings.filter(
      (other) =>
        other.tick === landing.tick &&
        Math.max(
          Math.abs(other.position[0] - landing.position[0]),
          Math.abs(other.position[1] - landing.position[1]),
        ) <= 1,
    );
    expect(engine.getDamageHistory().map((damage) => [damage.tick, damage.effectiveDamage])).toEqual(
      exposed.map(() => [3, 5]),
    );
  });

  it.each(['death', 'despawn', 'clear-spawns'] as const)('retains an emitted volley through source %s', (removal) => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-healers' });
    const healer = world.getNpcs().find(healerDefinition.isActor);
    if (!healer) throw new TypeError('Missing spark source');
    // The replay path queues the volley; it is emitted at the start of tick 1 and lands on 4.
    engine.applyAction({ type: 'encounterCommand', command });
    advance(engine, 1);
    switch (removal) {
      case 'death':
        hit(engine, healer.id, 0);
        break;
      case 'despawn':
        engine['despawnEncounterNpc'](healer.id);
        break;
      case 'clear-spawns':
        engine.executeEncounterCommand({ encounter: 'zuk', type: 'clear-spawns' });
        break;
      default:
        throw new TypeError(`Unhandled removal: ${removal satisfies never}`);
    }

    const events = collectTickEvents(engine, 6);

    expect(
      engine
        .getDamageHistory()
        .filter((damage) => damage.source === 'ZukSpark')
        .map((damage) => [damage.tick, damage.effectiveDamage]),
    ).toEqual([
      [4, 9],
      [4, 6],
    ]);
    expect(events.filter((event) => event.type === 'attack_started')).toEqual([]);
    expect(
      events
        .filter(isEncounterVisualEvent)
        .flatMap((event) => event.animations)
        .filter((cue) => cue.actorId === healer.id),
    ).toEqual([]);
  });

  it.each([
    'encounter-owned',
    'external-owned',
  ] as const)('drops pending sparks on Zuk defeat with %s completion', (ownership) => {
    const { engine, encounter } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    engine.setCompletionOwnership(ownership);
    engine.executeEncounterCommand(command);
    engine.setBossHp(0);

    for (let tick = 1; tick <= 6; tick++) engine.advanceTick([31, 44]);

    expect(engine.getDamageHistory()).toEqual([]);
    expect(zukDirector(encounter)['sparks']['pending']).toEqual([]);
    engine.executeEncounterCommand(command);
    expect(zukDirector(encounter)['sparks']['pending']).toEqual([]);
  });

  it('drops pending sparks on reset and preserves them when incompatible seeds are rejected', () => {
    const { engine } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    const config = engine.getRunConfig();
    engine.executeEncounterCommand(command);
    expect(() =>
      engine.reset(undefined, {
        ...config,
        encounter: { kind: 'inferno', seeds: { runSeed: -1 } },
      }),
    ).toThrow();
    advance(engine, 3);
    expect(engine.getDamageHistory().map((damage) => damage.effectiveDamage)).toEqual([9, 6]);
    engine.executeEncounterCommand(command);

    engine.reset(undefined, config);
    advance(engine, 6);

    expect(engine.getDamageHistory()).toEqual([]);
  });

  it('emits only explicitly supplied visual geometry and detaches destinations from mutable input', () => {
    const { engine } = setup();
    engine.setMechanicsConfig({ zukAttacks: false });
    const supplied = ZukSparkVolleyCommandSchema.parse({
      ...command,
      sparks: command.sparks.map((spark) => ({
        ...spark,
        projectile: {
          sourcePosition: [22, 51],
          startDelayCycles: 0,
          endDelayCycles: 90,
          slope: 47,
          startOffset: 0,
          startHeight: 70,
          endHeight: 0,
        },
        landing: { height: 17, delayCycles: 4 },
      })),
    });
    engine.executeEncounterCommand(supplied);
    supplied.sparks[0].position[0] = 40;
    const launched = engine.getLastTickEvents().filter(isEncounterVisualEvent);

    const events = collectTickEvents(engine, 4).filter(isEncounterVisualEvent);

    expect(launched.flatMap((event) => event.projectiles).map((cue) => cue.target.position)).toEqual(
      command.sparks.map((spark) => spark.position),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tick: 3,
      animations: [],
      projectiles: [],
      graphics: command.sparks.map((spark) => ({
        spotAnimId: 659,
        target: { kind: 'tile', position: spark.position },
        height: 17,
        delayCycles: 4,
      })),
    });
    expect(engine.getDamageHistory().map((damage) => damage.effectiveDamage)).toEqual([9, 6]);
  });

  it('reconstructs supplied inputs through a saved recording, seeded reset and takeover before impact', () => {
    const { engine } = setup(19);
    engine.setMechanicsConfig({ zukAttacks: false });
    const recorder = new ReplayRecorder();
    const config = engine.getRunConfig();
    recorder.startRun(config);
    recorder.recordPresentationState(1, 0, {
      clientLayoutMode: 'modern',
      frame: { width: 1280, height: 720 },
      insets: { left: 0, right: 0 },
      uiScale: 1,
      panels: {
        gamePanel: { x: 0, y: 0, anchorX: 'right', anchorY: 'bottom' },
        minimap: { x: 0, y: 0, anchorX: 'right', anchorY: 'top' },
        compactOrbs: { x: 0, y: 60, anchorX: 'right', anchorY: 'top' },
        infobox: null,
        zukSetTimer: null,
      },
      variants: {
        activeGamePanelTab: 'inventory',
        compactOrbsEnabled: false,
        compactOrbsLayout: 'vertical',
        compactOrbsOrder: ['hitpoints', 'prayer', 'run', 'special'],
        infoboxPinTarget: 'hud',
        showCoordinates: false,
      },
    });
    recorder.recordFrame(0, [31, 44], engine.getState(), []);
    const action = { type: 'encounterCommand', command } as const;
    recorder.recordAction(action);
    engine.applyAction(action);
    for (let tick = 1; tick <= 4; tick++) {
      engine.advanceTick([31, 44]);
      recorder.recordFrame(tick, [31, 44], engine.getState(), engine.getLastTickEvents());
    }
    const decoded = recorder.exportData();
    const rebuilt = createSimulationEngineFromRunConfig(config, null);
    if (!rebuilt) throw new TypeError('Missing replay engine');
    engine.reset(undefined, config);

    for (const frame of decoded.frames.slice(1, 3)) {
      for (const target of [rebuilt, engine]) {
        for (const input of frame.actions) target.applyAction(input);
        target.advanceTick(frame.input);
        expect(diffResumableState(frame.state, target.getState())).toEqual([]);
      }
    }
    expect(rebuilt.getDamageHistory()).toEqual([]);
    for (const target of [rebuilt, engine]) advance(target, 4);

    expect(decoded.frames[1]?.actions).toEqual([action]);
    expect(rebuilt.getDamageHistory()).toEqual(decoded.damageHistory);
    expect(engine.getDamageHistory()).toEqual(decoded.damageHistory);
    expect(decoded.damageHistory.map((damage) => damage.effectiveDamage)).toEqual([9, 6]);
  });

  it('repeats generated sparks and concurrent seeded support after reset and replay takeover before impact', () => {
    const encounter = createZukWaveEncounter(7);
    const engine = new SimulationEngine({ encounter, combatSeed: 31 });
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: true });
    const config = engine.getRunConfig();
    const scenario = { engine, encounter, world: engine['worldState'] };
    const { tagged, player } = prepareAutomaticSparks(scenario);
    const healerIds = scenario.world
      .getNpcs()
      .filter(healerDefinition.isActor)
      .map((actor) => actor.id);
    const siblingIds = healerIds.filter((id) => id !== tagged.id);
    expect(siblingIds).toHaveLength(3);
    const startTick = engine.currentTick;
    const boundaryTick = 8;
    const endTick = 24;
    const recorder = new ReplayRecorder();
    recorder.startRun(config);
    recorder.recordFrame(startTick, player.position, engine.getState(), engine.getLastTickEvents());
    const observe = (target: SimulationEngine) => {
      const targetEncounter = target['encounter'];
      if (!(targetEncounter instanceof InfernoEncounter)) throw new TypeError('Missing generated-spark encounter');
      const events = target.getLastTickEvents().map(({ eventId: _eventId, ...event }) => event);
      return {
        tick: target.currentTick,
        sparks: structuredClone(
          zukDirector(targetEncounter)['sparks']['pending'].filter(
            (landing) => landing.tick === target.currentTick + 3,
          ),
        ),
        events,
        casts: events.flatMap((event) => (event.type === 'zuk_healer_cast' ? [event] : [])),
        heals: healingEvents(target.getLastTickEvents()).map(({ eventId: _eventId, ...event }) => event),
        graphics: target
          .getLastTickEvents()
          .filter(isEncounterVisualEvent)
          .flatMap((event) => event.graphics.map((cue) => ({ tick: event.tick, ...cue }))),
      };
    };
    const original = Array.from({ length: endTick - startTick }, () => {
      engine.advanceTick(player.position);
      recorder.recordFrame(engine.currentTick, player.position, engine.getState(), engine.getLastTickEvents());
      return observe(engine);
    });
    const recorded = recorder.exportData();
    const expected = original.filter((sample) => sample.tick > boundaryTick);
    const expectedDamage = recorded.damageHistory.filter((entry) => entry.tick > boundaryTick);
    const expectedSparks = expected.flatMap((sample) => sample.sparks);
    const expectedCasts = expected.flatMap((sample) => sample.casts);
    expect(expectedSparks).toHaveLength(18);
    expect(new Set(expectedSparks.map(({ spark }) => spark.amount)).size).toBeGreaterThan(1);
    expect(new Set(expectedSparks.map(({ spark }) => spark.position.join(','))).size).toBeGreaterThan(1);
    expect(
      expectedCasts.filter((event) => event.sourceId === tagged.id).map((event) => [event.tick, event.targetId]),
    ).toEqual([9, 12, 15, 18, 21, 24].map((tick) => [tick, player.id]));
    for (const siblingId of siblingIds) {
      expect(
        expectedCasts.filter((event) => event.sourceId === siblingId).map((event) => [event.tick, event.targetId]),
      ).toEqual([10, 13, 16, 19, 22].map((tick) => [tick, 'zuk']));
    }
    expect(expected.flatMap((sample) => sample.heals)).toHaveLength(15);
    expect(expected.flatMap((sample) => sample.graphics).filter((cue) => cue.spotAnimId === 659)).toHaveLength(18);
    expect(expected.flatMap((sample) => sample.graphics).filter((cue) => cue.spotAnimId === 444)).toHaveLength(5);
    expect(expectedDamage.length).toBeGreaterThanOrEqual(6);
    expect(
      expectedDamage.every(
        (entry) => entry.source === 'ZukSpark' && entry.effectiveDamage >= 5 && entry.effectiveDamage <= 10,
      ),
    ).toBe(true);
    const rebuilt = createSimulationEngineFromRunConfig(config, null);
    if (!rebuilt) throw new TypeError('Missing generated-spark replay engine');
    // As reconstruction does: the recorded start wave (69) survives the tick-zero mechanics below.
    rebuilt.keepRunStartSetup();

    engine.reset(undefined, config);
    for (const target of [engine, rebuilt]) {
      const targetEncounter = target['encounter'];
      if (!(targetEncounter instanceof InfernoEncounter))
        throw new TypeError('Missing generated-spark replay encounter');
      prepareAutomaticSparks({ engine: target, encounter: targetEncounter, world: target['worldState'] });
      for (const [index, frame] of recorded.frames.entries()) {
        if (frame.tick > boundaryTick) break;
        const hydrated = recorder.getFrame(index);
        if (!hydrated) throw new TypeError('Missing generated-spark replay frame');
        if (frame.tick > startTick) {
          for (const action of frame.actions) target.applyAction(action);
          target.advanceTick(frame.input);
        }
        expect(diffResumableState(hydrated.state, target.getState())).toEqual([]);
      }
      expect(zukDirector(targetEncounter)['sparks']['pending']).toEqual(original[0]?.sparks);
      const healers = target['worldState'].getNpcs().filter(healerDefinition.isActor);
      expect(healers.map((actor) => actor.id)).toEqual(healerIds);
      expect(healers.find((actor) => actor.id === tagged.id)?.combat.targetId).toBe(player.id);
      for (const siblingId of siblingIds) {
        expect(healers.find((actor) => actor.id === siblingId)).toMatchObject({
          combat: { targetId: null },
          state: { supportTargetId: 'zuk', pendingHeals: [expect.objectContaining({ applyTick: 11 })] },
        });
      }
      const continued = Array.from({ length: endTick - boundaryTick }, () => {
        target.advanceTick(player.position);
        return observe(target);
      });

      expect(continued.flatMap((sample) => sample.sparks)).toEqual(expectedSparks);
      expect(continued.flatMap((sample) => sample.casts)).toEqual(expectedCasts);
      expect(continued.flatMap((sample) => sample.heals)).toEqual(expected.flatMap((sample) => sample.heals));
      expect(continued.flatMap((sample) => sample.graphics)).toEqual(expected.flatMap((sample) => sample.graphics));
      expect(continued.flatMap((sample) => sample.events)).toEqual(expected.flatMap((sample) => sample.events));
      expect(target.getDamageHistory().filter((entry) => entry.tick > boundaryTick)).toEqual(expectedDamage);
    }
  });

  it('matches all 270 landings and all 83 capture ticks including 19 supplied observed hits and terminal damage', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: true, infiniteStamina: true });
    setArenaConfig({
      ...getArenaConfig(),
      walkableTiles: new Set(Array.from({ length: 29 }, (_, index) => `${index + 17},46`)),
    });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-healers' });
    const player = world.getPlayer();
    const first = capture.ticks[0];
    if (!player || !first) throw new TypeError('Missing capture start');
    player.position = [...first.before];
    const availableHitAmounts = new Map(capture.ticks.map((row) => [row.tick, [...row.hits]]));
    const emitted: { tick: number; position: Coordinate }[] = [];
    const damage: number[][] = [];
    for (const row of capture.ticks) {
      expect(player.position).toEqual(row.before);
      const parentHealDue = world
        .getNpcs()
        .filter(healerDefinition.isActor)
        .some(
          (actor) => actor.alive && actor.state.pendingHeals.some((heal) => heal.applyTick === engine.currentTick + 1),
        );
      const prayer = row.magicPrayer ? PrayerType.ProtectMagic : null;
      if (player.activePrayer !== prayer) engine.queueProtectionPrayer(prayer);
      engine.advanceTick([...row.after]);
      expect(player.position, `Capture tick ${row.tick}`).toEqual(row.after);
      const hits = engine
        .getDamageHistory()
        .filter((entry) => entry.tick === engine.currentTick && entry.source === 'ZukSpark');
      expect(hits.map((entry) => entry.effectiveDamage).sort()).toEqual([...row.hits].sort());
      damage.push(hits.map((entry) => entry.effectiveDamage));
      const shots = capture.shots.filter((shot) => shot.tick === row.tick);
      for (let offset = 0; offset < shots.length; offset += 3) {
        const volley = ZukSparkVolleyCommandSchema.parse({
          encounter: 'zuk',
          type: 'emit-spark-volley',
          sparks: shots.slice(offset, offset + 3).map((shot) => {
            const landingFrame = capture.ticks.find((frame) => frame.tick === shot.tick + 3);
            if (!landingFrame) throw new TypeError('Missing landing frame');
            const exposed =
              Math.max(
                Math.abs(landingFrame.before[0] - shot.position[0]),
                Math.abs(landingFrame.before[1] - shot.position[1]),
              ) <= 1;
            const unobservedMissTestAmount = 5;
            const amount = exposed ? availableHitAmounts.get(shot.tick + 3)?.shift() : unobservedMissTestAmount;
            if (amount === undefined) throw new TypeError('Capture exposure has no observed amount');
            return {
              position: shot.position,
              amount,
              projectile: {
                sourcePosition: shot.source,
                startDelayCycles: 0,
                endDelayCycles: 90,
                slope: shot.slope,
                startOffset: 0,
                startHeight: 70,
                endHeight: 0,
              },
            };
          }),
        });
        engine.executeEncounterCommand(volley);
      }
      const visualEvents = engine.getLastTickEvents().filter(isEncounterVisualEvent);
      expect(visualEvents.flatMap((event) => event.graphics)).toEqual(
        parentHealDue
          ? [
              {
                spotAnimId: 444,
                target: { kind: 'actor', actorId: 'zuk', size: 7, position: [28, 52] },
                height: 256,
                delayCycles: 0,
              },
            ]
          : [],
      );
      for (const event of visualEvents) {
        for (const cue of event.projectiles.filter((projectile) => projectile.target.kind === 'tile'))
          emitted.push({ tick: row.tick + 3, position: cue.target.position });
      }
      const deathSourceXs = new Map([
        [1139, [36, 40]],
        [1144, [26]],
        [1152, [22]],
      ]);
      for (const healer of world.getNpcs().filter(healerDefinition.isActor))
        if (deathSourceXs.get(row.tick)?.includes(healer.position[0])) hit(engine, healer.id, 0);
      if (row.tick === 1154) engine.executeEncounterCommand({ encounter: 'zuk', type: 'clear-spawns' });
    }
    const landingKeys = (rows: readonly { tick: number; position: Coordinate }[]) =>
      rows.map((row) => `${row.tick}:${row.position}`).sort();
    expect(emitted).toHaveLength(270);
    expect(landingKeys(emitted)).toEqual(landingKeys(capture.landings));
    expect(capture.landings.filter((landing) => landing.delayCycles === undefined)).toHaveLength(41);
    expect(damage).toHaveLength(83);
    expect(damage.filter((hits) => hits.length === 0)).toHaveLength(68);
    expect(damage.flat()).toHaveLength(19);
    expect(damage.flat().reduce((total, amount) => total + amount, 0)).toBe(152);
    expect(
      engine
        .getDamageHistory()
        .filter((entry) => entry.activePrayer === PrayerType.ProtectMagic)
        .map((entry) => entry.effectiveDamage),
    ).toEqual([9, 6, 10, 5, 8, 8]);
    expect(damage.at(-1)).toEqual([9]);
    expect(world.getNpcs().filter(healerDefinition.isActor)).toEqual([]);
    expect(collectTickEvents(engine, 86).filter((event) => event.type === 'hit_applied')).toEqual([]);
  });
});

describe('Zuk published next-tick shield projection', () => {
  it('publishes the glyph x the real engine reaches on the next tick, including holds and reversals at both endpoints', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false });
    const glyph = world.getNpcs().find(glyphDefinition.isActor);
    if (!glyph) throw new TypeError('Missing glyph fixture');
    const observed: { tick: number; x: number; nextX: number | null; endpoint: 0 | 1 }[] = [];
    for (let tick = 0; tick < 100; tick++) {
      const snapshot = zukWaveView(engine);
      if (snapshot.state === null) throw new TypeError('Expected Zuk snapshot');
      observed.push({
        tick,
        x: glyph.position[0],
        nextX: snapshot.state.shieldNextX,
        endpoint: glyph.state.targetEndpoint,
      });
      expect(snapshot.state.shieldX).toBe(glyph.position[0]);
      engine.advanceTick([31, 44]);
      expect(snapshot.state.shieldNextX).toBe(glyph.position[0]);
    }
    expect(observed[0]).toEqual({ tick: 0, x: 30, nextX: 31, endpoint: 1 });
    expect(observed.filter((row) => row.x === 43).map((row) => row.nextX)).toEqual([
      43, 43, 43, 43, 42, 43, 43, 43, 43, 42,
    ]);
    expect(observed.filter((row) => row.x === 17).map((row) => row.nextX)).toEqual([17, 17, 17, 17, 18]);
    expect(observed.find((row) => row.x === 30 && row.endpoint === 0)?.nextX).toBe(29);
  });

  it.each([
    { direction: 'east', endpoint: 1, nextX: 31, playerX: 34, exposed: false },
    { direction: 'east', endpoint: 1, nextX: 31, playerX: 29, exposed: true },
    { direction: 'west', endpoint: 0, nextX: 29, playerX: 28, exposed: false },
    { direction: 'west', endpoint: 0, nextX: 29, playerX: 33, exposed: true },
  ] as const)('matches the next $direction Zuk cast for true tile x=$playerX', ({
    endpoint,
    nextX,
    playerX,
    exposed,
  }) => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukSets: false });
    const glyph = world.getNpcs().find(glyphDefinition.isActor);
    const boss = world.getNpcs().find(zukDefinition.isActor);
    const player = world.getPlayer();
    if (!glyph || !boss || !player) throw new TypeError('Missing shield protection actors');
    glyph.state.targetEndpoint = endpoint;
    boss.state.firstCastTick = 1;
    player.position = [playerX, 44];
    const snapshot = zukWaveView(engine);
    if (snapshot.state === null || snapshot.state.shieldNextX === null) throw new TypeError('Missing projection');

    engine.advanceTick(player.position);

    expect(snapshot.state.shieldNextX).toBe(nextX);
    expect(zukTargetsPlayer(snapshot.state.shieldNextX, [playerX, 44])).toBe(exposed);
    expect(zukTargetsPlayer(snapshot.state.shieldX, [playerX, 44])).toBe(!exposed);
    expect(engine.getLastTickEvents().filter(isZukAttackEvent)).toMatchObject([
      { attack: 'zuk_blast', targetId: exposed ? player.id : glyph.id, launchTick: 1 },
    ]);
    expect(world.pendingHits).toHaveLength(exposed ? 1 : 0);
  });

  it.each([
    { direction: 'east', endpoint: 1, playerX: 29 },
    { direction: 'west', endpoint: 0, playerX: 33 },
  ] as const)('keeps the incoming Zuk hit when running into green after the $direction protection check', ({
    endpoint,
    playerX,
  }) => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukSets: false });
    enableZukMovement(engine);
    const glyph = world.getNpcs().find(glyphDefinition.isActor);
    const boss = world.getNpcs().find(zukDefinition.isActor);
    const player = world.getPlayer();
    if (!glyph || !boss || !player) throw new TypeError('Missing shield protection actors');
    glyph.state.targetEndpoint = endpoint;
    boss.state.firstCastTick = 1;
    player.position = [playerX, 44];
    player.isRunEnabled = true;

    engine.advanceTick([31, 44]);

    const snapshot = zukWaveView(engine);
    if (snapshot.state === null || snapshot.state.shieldNextX === null) throw new TypeError('Missing projection');
    expect(player.position).toEqual([31, 44]);
    expect(zukTargetsPlayer(snapshot.state.shieldNextX, player.position)).toBe(false);
    expect(engine.getLastTickEvents().filter(isZukAttackEvent)).toMatchObject([
      { attack: 'zuk_blast', targetId: player.id, targetPosition: [playerX, 44], launchTick: 1 },
    ]);
    const pendingHit = world.pendingHits.find((hit) => hit.sourceId === boss.id && hit.targetId === player.id);
    if (!pendingHit) throw new TypeError('Expected committed incoming Zuk hit');
    advance(engine, pendingHit.impactTick);
    expect(engine.getDamageHistory()).toContainEqual(
      expect.objectContaining({ tick: pendingHit.impactTick, targetId: player.id, attackType: 'typeless' }),
    );
  });

  it.each([
    'dead glyph',
    'missing glyph',
    'dead boss',
    'missing boss',
  ] as const)('publishes no projection with a %s while keeping the current shield fields', (condition) => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false });
    advance(engine, 3);
    const glyph = world.getNpc('zuk_shield');
    const boss = world.getNpc('zuk');
    if (!glyph || !boss) throw new TypeError('Missing actors');
    switch (condition) {
      case 'dead glyph':
        glyph.alive = false;
        break;
      case 'missing glyph':
        world.actors.delete(glyph.id);
        break;
      case 'dead boss':
        boss.alive = false;
        break;
      case 'missing boss':
        world.actors.delete(boss.id);
        break;
      default: {
        const exhaustive: never = condition;
        throw exhaustive;
      }
    }

    const snapshot = zukWaveView(engine);

    if (snapshot.state === null) throw new TypeError('Expected Zuk snapshot');
    expect(snapshot.state).toMatchObject({ shieldX: 33, shieldMovingEast: true, shieldNextX: null });
  });

  it.each([
    0, 12, 13, 16, 17, 30, 43, 46, 47,
  ])('reads the projection without mutating patrol state at tick %s', (tick) => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false });
    const glyph = world.getNpcs().find(glyphDefinition.isActor);
    if (!glyph) throw new TypeError('Missing glyph fixture');
    advance(engine, tick);
    const before = structuredClone(glyph);

    const first = engine.getEncounterSnapshot();
    const second = engine.getEncounterSnapshot();

    expect(second).toEqual(first);
    expect(glyph).toEqual(before);
  });
});
