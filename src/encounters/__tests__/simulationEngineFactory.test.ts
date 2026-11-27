import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getArenaAllowUnboundedFallback,
  getArenaConfig,
  isInArena,
  isWalkableTile,
  setArenaConfig,
} from '../../core/constants';
import { zukWaveState } from '../../core/encounters/snapshot';
import { ENGINE_RUN_BOOTSTRAP_VERSION, type EngineRunConfig } from '../../core/engineRunConfig';
import { ReplayRecorder } from '../../core/ReplayRecorder';
import { ReplaySafetyError } from '../../core/replaySafety';
import { ReplayTakeoverWork } from '../../core/replayTakeover';
import type { EngineAction } from '../../core/SimulationEngine';
import { diffResumableState } from '../../replay/resumableState';
import { CollisionFlag } from '../../rs/collision/CollisionFlag';
import { analyzeWalkability } from '../../rs/collision/WalkabilityAnalyzer';
import { zukWaveView } from '../../test/helpers/zukWave';
import { createEmptyCombatSupplies } from '../../types/encounterLoadout';
import { createEmptyInventory } from '../../types/inventory';
import { createDefaultStats } from '../../types/playerState';
import { PrayerType } from '../../types/simulation';
import { readActualZukSetCountdown } from '../../types/zukSetTimer';
import { encounterControlsForKind } from '../modules';
import { encounterReplayChapters } from '../practiceChrome';
import { encounterRegistry } from '../registry';
import {
  createSimulationEngineForNewRun,
  createSimulationEngineFromRunConfig,
  reconstructReplayPrefix,
  type SimulationEngineBuildInput,
} from '../simulationEngineFactory';

let arenaConfig = getArenaConfig();
let allowUnboundedFallback = false;
beforeEach(() => {
  arenaConfig = getArenaConfig();
  allowUnboundedFallback = getArenaAllowUnboundedFallback();
});
afterEach(() => {
  setArenaConfig(arenaConfig, allowUnboundedFallback);
  vi.restoreAllMocks();
});

/** TzKal-Zuk is the Inferno's wave 69: a run practicing him starts there. */
const ZUK_START = { infernoStartWave: '69' } as const;

function newRun(overrides: Partial<SimulationEngineBuildInput> = {}) {
  return createSimulationEngineForNewRun({
    encounterConfig: { kind: 'yama_p3', mechanics: { infiniteHealth: true } },
    enableIntro: false,
    stats: createDefaultStats(),
    inventory: createEmptyInventory(),
    equipment: {},
    combatSupplies: createEmptyCombatSupplies(),
    attackStylePerCategory: {},
    combatSeed: 0x1234abcd,
    ...overrides,
  });
}

describe('unified encounter setup', () => {
  it.each(
    [0, 1].flatMap((seed) =>
      [undefined, 'random', 'unknown', true, 'left', 'right'].flatMap((choice) =>
        [0, 1].map((tick) => ({ seed, choice, tick })),
      ),
    ),
  )('starts Zuk seed $seed with choice $choice at tick $tick', ({ seed, choice, tick }) => {
    vi.spyOn(Math, 'random').mockReturnValue(seed / 0x100000000);
    const movingEast = choice === 'right' || (choice !== 'left' && seed === 1);

    const engine = newRun({
      encounterConfig: {
        kind: 'inferno',
        mechanics: choice === undefined ? ZUK_START : { ...ZUK_START, zukShieldStart: choice },
      },
    });
    if (tick === 1) engine.advanceTick(engine.getState().playerPosition);

    expect(zukWaveView(engine)).toMatchObject({
      state: { shieldX: 30 + tick * (movingEast ? 1 : -1), shieldMovingEast: movingEast },
    });
    expect(engine.getState().npcs.find((npc) => npc.id === 'zuk_shield')?.position).toEqual([
      30 + tick * (movingEast ? 1 : -1),
      48,
    ]);
    expect(engine.getRunConfig().encounter.seeds).toEqual({ runSeed: seed });
  });

  it.each(
    [0, 1].flatMap((seed) => ['random', 'left', 'right'].map((choice) => ({ seed, choice }))),
  )('reconstructs Zuk seed $seed choice $choice from tick zero through a mid-fight choice change', ({
    seed,
    choice,
  }) => {
    vi.spyOn(Math, 'random').mockReturnValue(seed / 0x100000000);
    const original = newRun({
      encounterConfig: {
        kind: 'inferno',
        mechanics: { ...ZUK_START, zukShieldStart: choice, infiniteHealth: true, zukAttacks: false, zukSets: false },
      },
    });
    const config = original.getRunConfig();
    const initial = original.getState();
    const recorder = new ReplayRecorder();
    recorder.startRun(config);
    recorder.recordFrame(0, initial.playerPosition, initial, []);
    for (let tick = 1; tick <= 20; tick++) {
      if (tick === 5) original.setMechanicsConfig({ ...original.getMechanicsConfig(), zukShieldStart: 'right' });
      original.advanceTick(initial.playerPosition);
      recorder.recordFrame(tick, initial.playerPosition, original.getState(), original.getLastTickEvents());
    }
    const expected = original.getState();
    const frames = recorder.exportData().frames;

    const opening = reconstructReplayPrefix(config, frames, 0, null);
    const replayed = reconstructReplayPrefix(config, frames, 20, null);
    original.reset(undefined, config);

    if (!opening || !replayed) throw new TypeError('Missing Zuk direction reconstruction');
    expect(diffResumableState(initial, opening.getState())).toEqual([]);
    expect(diffResumableState(initial, original.getState())).toEqual([]);
    expect(diffResumableState(expected, replayed.getState())).toEqual([]);
    for (const frame of frames.slice(1)) {
      if (frame.state.mechanicsConfig) original.setMechanicsConfig(frame.state.mechanicsConfig);
      original.advanceTick(frame.input);
      const hydrated = recorder.getFrame(frame.tick);
      if (!hydrated) throw new TypeError('Missing direction replay frame');
      expect(diffResumableState(hydrated.state, original.getState())).toEqual([]);
    }
  });

  it('continues event IDs past the recorded prefix so a taken-over branch never repeats one', () => {
    const original = newRun();
    // The recorded engine can be far ahead of a rebuild, e.g. after earlier attempts on the same engine.
    original.continueEventIdsAfter(1000);
    const config = original.getRunConfig();
    const recorder = new ReplayRecorder();
    recorder.startRun(config);
    const initial = original.getState();
    recorder.recordFrame(0, initial.playerPosition, initial, []);
    for (let tick = 1; tick <= 20; tick++) {
      original.advanceTick(initial.playerPosition);
      recorder.recordFrame(tick, initial.playerPosition, original.getState(), original.getLastTickEvents());
    }
    const frames = recorder.exportData().frames;
    const recordedIds = frames.slice(0, 11).flatMap((frame) => frame.events.map((event) => event.eventId));
    expect(recordedIds.length).toBeGreaterThan(0);

    const resumed = reconstructReplayPrefix(config, frames, 10, null);
    if (!resumed) throw new TypeError('Missing reconstruction');
    resumed.advanceTick(initial.playerPosition);

    const resumedIds = resumed.getLastTickEvents().map((event) => event.eventId);
    expect(resumedIds.length).toBeGreaterThan(0);
    expect(Math.min(...resumedIds)).toBe(Math.max(...recordedIds) + 1);
  });

  it.each(
    encounterRegistry.getRegisteredKinds(),
  )('starts %s with its own defaults when mechanics are empty', (kind) => {
    const engine = newRun({ encounterConfig: { kind, mechanics: {} } });

    expect(engine.getMechanicsConfig()).toMatchObject(encounterControlsForKind(kind)?.defaultMechanicsConfig ?? {});
    expect(engine.getRunConfig().encounter.kind).toBe(kind);
  });

  it.each(encounterRegistry.getRegisteredKinds())('preserves %s defaults and recorded runs', (kind) => {
    const original = newRun({ encounterConfig: { kind, mechanics: { infiniteHealth: true } } });
    const recorded = structuredClone(original.getRunConfig());
    expect(recorded.encounter.kind).toBe(kind);
    expect(original.getMechanicsConfig()).toMatchObject({
      ...encounterControlsForKind(kind)?.defaultMechanicsConfig,
      infiniteHealth: true,
    });
    expect(recorded.bootstrap?.encounterConfig).toBeUndefined();

    const rebuilt = createSimulationEngineFromRunConfig(recorded, null);

    if (!rebuilt) throw new TypeError('Expected a rebuilt engine');
    expect(rebuilt.getRunConfig()).toEqual(recorded);
    expect(diffResumableState(original.getState(), rebuilt.getState())).toEqual([]);
    for (let tick = 0; tick < 100; tick++) {
      original.advanceTick(original.getState().playerPosition);
      rebuilt.advanceTick(rebuilt.getState().playerPosition);
      expect(diffResumableState(original.getState(), rebuilt.getState())).toEqual([]);
    }
  });

  it.each([
    'east',
    'west',
    'random',
  ] as const)('refuses new Zuk runs carrying the unsupported %s option', (shieldDirection) => {
    const encounterConfig = { kind: 'inferno', options: { shieldDirection }, mechanics: ZUK_START };

    // By name: the kind is registered, so this must not read as an unknown encounter.
    expect(() => newRun({ encounterConfig })).toThrow(/accepts no constructor options; got: shieldDirection/);
  });

  it('records only the Zuk encounter seed for reconstruction', () => {
    expect(encounterRegistry.getRegisteredKinds()).toContain('inferno');
    const recorded = newRun({ encounterConfig: { kind: 'inferno', mechanics: ZUK_START } }).getRunConfig();
    expect(recorded.encounter.seeds).toEqual({ runSeed: expect.any(Number) });
    expect(recorded.bootstrap?.encounterConfig).toBeUndefined();
  });

  it.each([
    {},
    { runSeed: null },
    { runSeed: '7' },
    { runSeed: -1 },
    { runSeed: 0x100000000 },
    { runSeed: 1.5 },
    { runSeed: Number.NaN },
    { runSeed: Number.POSITIVE_INFINITY },
    { runSeed: 7, shieldDirection: 'west' },
  ])('preserves the active arena and engine when rejecting invalid Zuk seeds %j', (seeds) => {
    const original = newRun({ startPosition: [29, 35] });
    original.advanceTick(original.getState().playerPosition);
    const originalState = structuredClone(original.getState());
    const originalRunConfig = structuredClone(original.getRunConfig());
    const { collisionMap } = analyzeWalkability({
      mapX: 0,
      mapY: 0,
      tileHeights: [],
      tileUnderlays: [],
      tileOverlays: [],
      tileShapes: [],
      tileRotations: [],
      tileRenderFlags: [],
      tileLightOcclusions: [],
    });
    collisionMap.flag(29, 36, CollisionFlag.OBJECT);
    const activeArena = {
      bounds: { minX: 28, maxX: 34, minY: 34, maxY: 40, width: 7, height: 7 },
      walkableTiles: new Set(['29,35']),
      collisionMap,
    };
    setArenaConfig(activeArena);
    const recorded: EngineRunConfig = {
      ...originalRunConfig,
      encounter: { kind: 'inferno', seeds },
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const rebuilt = createSimulationEngineFromRunConfig(recorded, null);

    expect(rebuilt).toBeNull();
    expect(original.getState()).toEqual(originalState);
    expect(original.getRunConfig()).toEqual(originalRunConfig);
    expect(getArenaConfig()).toEqual(activeArena);
    expect(getArenaConfig().bounds).toBe(activeArena.bounds);
    expect(getArenaConfig().walkableTiles).toBe(activeArena.walkableTiles);
    expect(getArenaConfig().collisionMap).toBe(collisionMap);
    expect(collisionMap.hasFlag(29, 36, CollisionFlag.OBJECT)).toBe(true);
    expect(isInArena(28, 34)).toBe(true);
    expect(isInArena(35, 34)).toBe(false);
    expect(isWalkableTile(29, 35)).toBe(true);
    expect(isWalkableTile(29, 36)).toBe(false);
  });

  it.each([
    {},
    { encounterSeed: 'x' },
    { encounterSeed: -1 },
    { encounterSeed: 7, extra: 1 },
  ])('cannot rebuild a recorded Zulrah run whose seed record is malformed %j', (seeds) => {
    const recorded = newRun({
      encounterConfig: { kind: 'zulrah', mechanics: { infiniteHealth: true } },
    }).getRunConfig();
    expect(recorded.encounter.seeds).toEqual({ encounterSeed: expect.any(Number) });
    expect(createSimulationEngineFromRunConfig(recorded, null)?.getRunConfig().encounter.seeds).toEqual(
      recorded.encounter.seeds,
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(createSimulationEngineFromRunConfig({ ...recorded, encounter: { kind: 'zulrah', seeds } }, null)).toBeNull();
  });

  it('refuses a recorded Zuk run whose bootstrap carries unsupported constructor options', () => {
    const source = newRun().getRunConfig();
    if (!source.bootstrap) throw new TypeError('Expected a recorded bootstrap');
    const recorded: EngineRunConfig = {
      ...source,
      encounter: { kind: 'inferno', seeds: { runSeed: 7 } },
      bootstrap: { ...source.bootstrap, encounterConfig: { shieldDirection: 'west' } },
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(createSimulationEngineFromRunConfig(recorded, null)).toBeNull();
  });

  it('preserves opaque constructor options through supported encounter reconstruction', () => {
    const options = { fixtureOption: 'recorded' };
    const original = newRun({ encounterConfig: { kind: 'yama_p3', options, mechanics: { infiniteHealth: true } } });
    const recorded = original.getRunConfig();

    const rebuilt = createSimulationEngineFromRunConfig(recorded, null);

    expect(rebuilt?.getRunConfig().bootstrap?.encounterConfig).toEqual(options);
    expect(rebuilt?.getRunConfig().encounter.seeds).toEqual(recorded.encounter.seeds);
  });

  it('updates live mechanics without resetting ticks, actors or constructor options', () => {
    const engine = newRun({
      encounterConfig: { kind: 'yama_p3', options: { fixtureOption: 'recorded' }, mechanics: { infiniteHealth: true } },
    });
    for (let tick = 0; tick < 10; tick++) engine.advanceTick(engine.getState().playerPosition);
    const before = structuredClone(engine.getState());
    const recorded = engine.getRunConfig();

    engine.setMechanicsConfig({ infiniteHealth: true, fireballs: false });

    expect(engine.getState()).toMatchObject({
      currentTick: before.currentTick,
      npcs: before.npcs,
      playerPosition: before.playerPosition,
      encounter: { kind: before.encounter.kind, state: before.encounter.state },
    });
    expect(engine.getMechanicsConfig().fireballs).toBe(false);
    expect(engine.getRunConfig().encounter.seeds).toEqual(recorded.encounter.seeds);
    expect(engine.getRunConfig().bootstrap?.encounterConfig).toEqual({ fixtureOption: 'recorded' });
    engine.advanceTick(engine.getState().playerPosition);
    expect(engine.getState().currentTick).toBe(11);
  });
});

describe('createSimulationEngineFromRunConfig', () => {
  it.each([
    { fallback: true, fails: false },
    { fallback: true, fails: true },
    { fallback: false, fails: false },
    { fallback: false, fails: true },
  ])('restores the exact viewer fallback $fallback after reconstruction (fails: $fails)', ({ fallback, fails }) => {
    const original = newRun({
      encounterConfig: {
        kind: 'inferno',
        mechanics: { ...ZUK_START, infiniteHealth: true, zukAttacks: false, zukSets: false },
      },
    });
    const recorder = new ReplayRecorder();
    const state = original.getState();
    const config = original.getRunConfig();
    recorder.startRun(config);
    recorder.recordFrame(0, state.playerPosition, state, []);
    const baseline = recorder.exportData().frames[0];
    const frames = [
      baseline,
      {
        ...baseline,
        actions: [{ type: 'encounterCommand', command: { encounter: 'zuk', type: 'spawn-healers' } } as const],
      },
    ];
    const viewerArena = { bounds: null, walkableTiles: new Set(['0,0']), collisionMap: null };
    if (fallback) setArenaConfig(viewerArena, true);
    else setArenaConfig(viewerArena);

    const reconstruct = () =>
      reconstructReplayPrefix(config, frames, 1, null, new ReplayTakeoverWork({ maxNpcs: fails ? 3 : 10 }));
    if (fails) expect(reconstruct).toThrow(ReplaySafetyError);
    else expect(reconstruct()?.currentTick).toBe(1);

    expect(getArenaConfig()).toEqual(viewerArena);
    expect(getArenaConfig().walkableTiles).toBe(viewerArena.walkableTiles);
    expect(isWalkableTile(0, 0)).toBe(true);
    expect(isWalkableTile(999, 999)).toBe(false);
    expect(isInArena(999, 999)).toBe(fallback);
  });

  it('keeps policy exceptions typed through the factory catch', () => {
    const original = newRun({ encounterConfig: { kind: 'inferno', mechanics: ZUK_START } });
    expect(() =>
      createSimulationEngineFromRunConfig(original.getRunConfig(), null, new ReplayTakeoverWork({ maxNpcs: 1 })),
    ).toThrow(ReplaySafetyError);
  });

  it.each(['inventory', 'attackStylePerCategory'])('bounds bootstrap %s before creating an encounter', (field) => {
    const config = newRun().getRunConfig();
    if (!config.bootstrap) throw new Error('Missing bootstrap');
    const hostile = {
      ...config,
      bootstrap: {
        ...config.bootstrap,
        [field]:
          field === 'inventory'
            ? Array.from({ length: 29 }, () => null)
            : Object.fromEntries(Array.from({ length: 257 }, (_, index) => [String(index), 0])),
      },
    };
    const create = vi.spyOn(encounterRegistry, 'create');
    expect(() => createSimulationEngineFromRunConfig(hostile, null)).toThrow(ReplaySafetyError);
    expect(create).not.toHaveBeenCalled();
  });

  it('restores the viewer arena after a bounded mid-prefix failure', () => {
    const original = newRun({
      encounterConfig: {
        kind: 'inferno',
        mechanics: { ...ZUK_START, infiniteHealth: true, zukAttacks: false, zukSets: false },
      },
    });
    const recorder = new ReplayRecorder();
    const state = original.getState();
    const config = original.getRunConfig();
    recorder.startRun(config);
    recorder.recordFrame(0, state.playerPosition, state, []);
    const baseline = recorder.exportData().frames[0];
    const frames = [
      baseline,
      {
        ...baseline,
        actions: [{ type: 'encounterCommand', command: { encounter: 'zuk', type: 'spawn-healers' } } as const],
      },
    ];
    const viewerArena = { bounds: null, walkableTiles: new Set(['1,1']), collisionMap: null };
    setArenaConfig(viewerArena);

    expect(() => reconstructReplayPrefix(config, frames, 1, null, new ReplayTakeoverWork({ maxNpcs: 3 }))).toThrow(
      ReplaySafetyError,
    );
    expect(getArenaConfig()).toEqual(viewerArena);
    expect(original.getState()).toEqual(state);
  });

  it('validates a real prefix and permits unrestricted live continuation after releasing limits', () => {
    const original = newRun({
      encounterConfig: {
        kind: 'inferno',
        mechanics: { ...ZUK_START, infiniteHealth: true, zukAttacks: false, zukSets: false },
      },
    });
    const config = original.getRunConfig();
    const recorder = new ReplayRecorder();
    const position = original.getState().playerPosition;
    recorder.startRun(config);
    recorder.recordFrame(0, position, original.getState(), []);
    const action = { type: 'runToggle' } as const;
    recorder.recordAction(action);
    original.applyAction(action);
    original.advanceTick(position);
    recorder.recordFrame(1, position, original.getState(), original.getLastTickEvents());
    const work = new ReplayTakeoverWork({ maxActions: 1, maxTicks: 1, maxNpcs: 2, maxSpawns: 2, maxNpcTicks: 2 });

    const rebuilt = reconstructReplayPrefix(config, recorder.exportData().frames, 1, null, work);

    if (!rebuilt) throw new Error('Expected reconstructed prefix');
    expect(diffResumableState(original.getState(), rebuilt.getState())).toEqual([]);
    expect(work.getStats()).toEqual({ actions: 1, ticks: 1, npcTicks: 2, spawns: 2 });
    rebuilt.releaseReplayTakeoverLimits();
    for (const engine of [original, rebuilt]) {
      engine.applyAction({ type: 'encounterCommand', command: { encounter: 'zuk', type: 'spawn-healers' } });
      engine.advanceTick(position);
    }
    expect(diffResumableState(original.getState(), rebuilt.getState())).toEqual([]);
    expect(work.getStats()).toEqual({ actions: 1, ticks: 1, npcTicks: 2, spawns: 2 });
  });

  it('keeps a version-14 recording (before next-tick recoil and the one poison counter) playable but refuses its takeover', () => {
    const original = newRun({ equipment: { ring: 20657 } }); // Ring of suffering (ri).
    const config = original.getRunConfig();
    expect(config.bootstrap?.version).toBe(15);
    const recorder = new ReplayRecorder();
    const position = original.getState().playerPosition;
    recorder.startRun(config);
    recorder.recordFrame(0, position, original.getState(), []);
    for (let tick = 1; tick <= 6; tick++) {
      original.advanceTick(position);
      recorder.recordFrame(tick, position, original.getState(), original.getLastTickEvents());
    }
    const { frames } = recorder.exportData();
    expect(reconstructReplayPrefix(config, frames, 6, null)).not.toBeNull();
    if (!config.bootstrap) throw new Error('Missing bootstrap');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const recorded14: EngineRunConfig = { ...config, bootstrap: { ...config.bootstrap, version: 14 } };

    // Playback needs only the frames, which are untouched; takeover is refused.
    expect(frames).toHaveLength(7);
    expect(createSimulationEngineFromRunConfig(recorded14, null)).toBeNull();
    expect(reconstructReplayPrefix(recorded14, frames, 6, null)).toBeNull();
  });

  it('lands a live encounter command on the same tick when the replay rebuilds it', () => {
    const original = newRun();
    const config = original.getRunConfig();
    const recorder = new ReplayRecorder();
    const position = original.getState().playerPosition;
    recorder.startRun(config);
    recorder.recordFrame(0, position, original.getState(), []);
    const command = { encounter: 'yama_p3', type: 'spawn-void-flare' } as const;
    for (let tick = 1; tick <= 8; tick++) {
      // What the debug button does: queue it and record it, between two ticks.
      if (tick === 4) {
        expect(original.queueEncounterCommand(command)).toBe(true);
        recorder.recordAction({ type: 'encounterCommand', command });
      }
      original.advanceTick(position);
      recorder.recordFrame(tick, position, original.getState(), original.getLastTickEvents());
    }
    const frames = recorder.exportData().frames;
    expect(frames[4]?.actions).toEqual([{ type: 'encounterCommand', command }]);

    const rebuilt = reconstructReplayPrefix(config, frames, 8, null);

    if (!rebuilt) throw new Error('Expected reconstructed prefix');
    // The practice tag is part of the recorded state, so the rebuild has to reproduce it too.
    const flareSpawns = (state: ReturnType<typeof original.getState>) =>
      state.npcs.filter((npc) => npc.archetypeId === 'voidflare').map((npc) => [npc.spawnTick, npc.spawnOrigin]);
    expect(flareSpawns(original.getState())).toEqual([[4, 'practice']]);
    expect(flareSpawns(rebuilt.getState())).toEqual([[4, 'practice']]);
    expect(diffResumableState(original.getState(), rebuilt.getState())).toEqual([]);
  });

  it('imposes no frame cap on a long local prefix', () => {
    const original = newRun();
    const recorder = new ReplayRecorder();
    const position = original.getState().playerPosition;
    recorder.startRun(original.getRunConfig());
    recorder.recordFrame(0, position, original.getState(), []);
    const frame = recorder.exportData().frames[0];
    const work = new ReplayTakeoverWork();
    const rebuilt = reconstructReplayPrefix(
      original.getRunConfig(),
      Array.from({ length: 1502 }, () => frame),
      1501,
      null,
      work,
    );
    expect(rebuilt?.currentTick).toBe(1501);
    expect(work.getStats().ticks).toBe(1501);
  });
  it('rejects the 65536-command prefix before constructing any encounter', () => {
    const original = newRun({ encounterConfig: { kind: 'inferno', mechanics: ZUK_START } });
    const recorder = new ReplayRecorder();
    const state = original.getState();
    const runConfig = original.getRunConfig();
    recorder.startRun(runConfig);
    recorder.recordFrame(0, state.playerPosition, state, []);
    const baseline = recorder.exportData().frames[0];
    const action = { type: 'encounterCommand', command: { encounter: 'zuk', type: 'spawn-healers' } } as const;
    const frames = [
      baseline,
      ...Array.from({ length: 256 }, () => ({
        ...baseline,
        actions: Array.from({ length: 256 }, () => action),
      })),
    ];
    const create = vi.spyOn(encounterRegistry, 'create').mockImplementation(() => {
      throw new Error('Guard: engine construction reached');
    });

    expect(() => reconstructReplayPrefix(runConfig, frames, 256, null)).toThrow(
      expect.objectContaining({
        reason: 'takeover-work-limit',
      }),
    );
    expect(create).not.toHaveBeenCalled();
  });
  it('rebuilds an engine that matches the run it was captured from', () => {
    const original = newRun();
    const runConfig = original.getRunConfig();

    const rebuilt = createSimulationEngineFromRunConfig(runConfig, null);

    // Then: same landing tile and same encounter, before a single tick is replayed.
    expect(rebuilt).not.toBeNull();
    expect(diffResumableState(original.getState(), (rebuilt as NonNullable<typeof rebuilt>).getState())).toEqual([]);
  });

  it('carries the variant starting hitpoints through the rebuild', () => {
    const original = newRun({ startHp: 15 });

    const rebuilt = createSimulationEngineFromRunConfig(original.getRunConfig(), null);

    expect(rebuilt?.getState().playerHP).toBe(15);
  });

  it('reproduces the run seeds so the rebuilt fight is the same fight', () => {
    const original = newRun();
    const runConfig = original.getRunConfig();

    const first = createSimulationEngineFromRunConfig(runConfig, null);
    const second = createSimulationEngineFromRunConfig(runConfig, null);
    for (const engine of [first, second]) {
      for (let tick = 0; tick < 25; tick++) engine?.advanceTick(engine.getState().playerPosition);
    }

    // Then: identical, which is what makes replaying a recorded prefix sound.
    expect(diffResumableState(first?.getState() as never, second?.getState() as never)).toEqual([]);
  });

  it('stays in step with the original across a void flare detonation and its delayed hit', () => {
    const original = newRun();
    const rebuilt = createSimulationEngineFromRunConfig(original.getRunConfig(), null);
    if (!rebuilt) throw new TypeError('Expected a rebuilt engine');

    // A flare's damage lands the tick AFTER it detonates, and that queue is deliberately absent
    // from the seed payload — a takeover that rebuilt the prefix wrongly would match on the
    // detonation tick and diverge only on the impact one, so compare every tick, not just the last.
    let sawFlareHit = false;
    for (let tick = 0; tick < 95; tick++) {
      original.advanceTick(original.getState().playerPosition);
      rebuilt.advanceTick(rebuilt.getState().playerPosition);
      expect(diffResumableState(original.getState(), rebuilt.getState())).toEqual([]);
      sawFlareHit ||= original.getState().damageHistory.some((hit) => hit.source === 'VoidFlare');
    }

    // Without this the loop above passes just as happily on a window where nothing ever detonated.
    expect(sawFlareHit).toBe(true);
  });

  it('takes over a fresh run across drains, decay locks, recovery and Rapid Restore', () => {
    // A current-version bootstrap: every level change is re-simulated from the inputs, and the new
    // cycles and locks sit inside the strict takeover comparison.
    const DIVINE_SUPER_COMBAT = 23685;
    const SARADOMIN_BREW = 6685;
    const SATURATED_HEART = 27641;
    const inventory = createEmptyInventory();
    inventory[0] = { id: DIVINE_SUPER_COMBAT };
    inventory[1] = { id: SARADOMIN_BREW };
    inventory[2] = { id: SATURATED_HEART };
    const original = newRun({
      encounterConfig: {
        kind: 'inferno',
        mechanics: { ...ZUK_START, infiniteHealth: true, zukAttacks: false, zukSets: false, autoPrepot: true },
      },
      inventory,
    });
    // The live wiring applies Auto-Prepot at run start; the bootstrap records that it did.
    original.applyPrepotEffects();
    const config = original.getRunConfig();
    expect(config.bootstrap?.version).toBe(ENGINE_RUN_BOOTSTRAP_VERSION);
    expect(config.bootstrap?.prepotApplied).toBe(true);
    const recorder = new ReplayRecorder();
    const position = original.getState().playerPosition;
    recorder.startRun(config);
    recorder.recordFrame(0, position, original.getState(), []);
    const inputs = new Map<number, EngineAction>([
      [3, { type: 'independentPrayer', prayer: PrayerType.RapidRestore }],
      [5, { type: 'itemAction', inventoryIndex: 1 }],
      [9, { type: 'itemAction', inventoryIndex: 1 }],
    ]);
    const TICKS = 140;
    for (let tick = 1; tick <= TICKS; tick++) {
      const action = inputs.get(tick);
      if (action) {
        recorder.recordAction(action);
        original.applyAction(action);
      }
      original.advanceTick(position);
      recorder.recordFrame(tick, position, original.getState(), original.getLastTickEvents());
    }
    const state = original.getState();
    expect(state.combatTimers.statDecayLocks.attack?.source).toBe('divine');
    expect(state.combatTimers.statDecayLocks.magic?.source).toBe('saturated_heart');
    expect(state.stats.ranged.current).toBeLessThan(state.stats.ranged.max);

    const rebuilt = reconstructReplayPrefix(
      config,
      recorder.exportData().frames,
      TICKS,
      null,
      new ReplayTakeoverWork(),
    );

    if (!rebuilt) throw new Error('Expected reconstructed prefix');
    expect(diffResumableState(state, rebuilt.getState())).toEqual([]);
  });

  it('takes over a fresh run across Rapid Heal toggles, regeneration and overheal loss', () => {
    const ANGLERFISH = 13441;
    const inventory = createEmptyInventory();
    inventory[0] = { id: ANGLERFISH };
    const original = newRun({
      encounterConfig: {
        kind: 'inferno',
        mechanics: { ...ZUK_START, infiniteHealth: false, zukAttacks: false, zukSets: false },
      },
      inventory,
    });
    const config = original.getRunConfig();
    expect(config.bootstrap?.version).toBe(ENGINE_RUN_BOOTSTRAP_VERSION);
    const recorder = new ReplayRecorder();
    const position = original.getState().playerPosition;
    recorder.startRun(config);
    recorder.recordFrame(0, position, original.getState(), []);
    const rapidHeal: EngineAction = { type: 'independentPrayer', prayer: PrayerType.RapidHeal };
    const inputs = new Map<number, EngineAction[]>([
      [2, [{ type: 'itemAction', inventoryIndex: 0 }]], // overheal to 121
      [20, [rapidHeal]], // on
      [90, [rapidHeal]], // off
      [140, [rapidHeal, rapidHeal]], // same-tick flick from off: on, then off again
      [150, [rapidHeal]], // on
    ]);
    const TICKS = 260;
    for (let tick = 1; tick <= TICKS; tick++) {
      for (const action of inputs.get(tick) ?? []) {
        recorder.recordAction(action);
        original.applyAction(action);
      }
      original.advanceTick(position);
      recorder.recordFrame(tick, position, original.getState(), original.getLastTickEvents());
    }
    const state = original.getState();
    expect(state.playerHP).toBeGreaterThan(state.maxHP);
    expect(state.playerHP).toBeLessThan(121);
    expect(state.independentPrayers).toEqual([PrayerType.RapidHeal]);

    const rebuilt = reconstructReplayPrefix(
      config,
      recorder.exportData().frames,
      TICKS,
      null,
      new ReplayTakeoverWork(),
    );

    if (!rebuilt) throw new Error('Expected reconstructed prefix');
    expect(diffResumableState(state, rebuilt.getState())).toEqual([]);
  });

  it('refuses a recording without a bootstrap', () => {
    const bootstrapless: EngineRunConfig = {
      completionOwnership: 'encounter-owned',
      encounter: { kind: 'yama_p3', seeds: {} },
    };

    // Then: null, never a hand-built approximation, which would produce wrong-state takeovers.
    expect(createSimulationEngineFromRunConfig(bootstrapless, null)).toBeNull();
  });

  it('refuses a corrupt bootstrap instead of throwing', () => {
    // Given: a loaded recording's bootstrap is untrusted input. The schema can only
    // check that `baseStats` is an object, and a hollow one throws deep inside construction.
    const runConfig = newRun().getRunConfig();
    const corrupt = {
      ...runConfig,
      bootstrap: { ...runConfig.bootstrap, baseStats: {} },
    } as EngineRunConfig;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    // When / Then: the caller's contract is "null means it cannot be rebuilt", not a crash.
    expect(() => createSimulationEngineFromRunConfig(corrupt, null)).not.toThrow();
    expect(createSimulationEngineFromRunConfig(corrupt, null)).toBeNull();
    logged.mockRestore();
  });
});

describe('recordings of the retired zuk encounter kind', () => {
  function zukKindRunConfig(version: number): EngineRunConfig {
    const source = newRun({ encounterConfig: { kind: 'inferno', mechanics: ZUK_START } }).getRunConfig();
    if (!source.bootstrap) throw new TypeError('Expected a recorded bootstrap');
    return {
      ...source,
      encounter: { kind: 'zuk', seeds: { encounterSeed: 7 } },
      bootstrap: { ...source.bootstrap, version },
    };
  }

  it.each([
    11,
    ENGINE_RUN_BOOTSTRAP_VERSION,
  ])('plays back only, never rebuilt as an Inferno run (bootstrap version %i)', (version) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(createSimulationEngineFromRunConfig(zukKindRunConfig(version), null)).toBeNull();
  });

  it('reads their recorded Zuk state for the overlays that follow wave 69', () => {
    const zukSnapshot = {
      kind: 'zuk',
      state: {
        setTimer: 50,
        timerPaused: true,
        enraged: false,
        jadSpawned: false,
        shieldX: 30,
        shieldMovingEast: true,
        shieldNextX: 31,
      },
      visuals: {},
    } as const;
    expect(zukWaveState(zukSnapshot)).toBe(zukSnapshot.state);
    expect(readActualZukSetCountdown(zukSnapshot, true)).toEqual({ ticksRemaining: 50, frozen: true });
    const frames = [{ state: { currentTick: 0, encounter: zukSnapshot } }] as unknown as Parameters<
      typeof encounterReplayChapters
    >[1];
    expect(encounterReplayChapters('zuk', frames)).toBeNull();
  });
});
