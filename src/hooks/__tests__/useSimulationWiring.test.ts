// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react';
import { type SetStateAction, StrictMode, useState } from 'react';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine, EventAudioPlayer, FrameSoundTracker } from '../../audio';
import { visibleInPractice } from '../../components/MechanicsSettings';
import { prayerFlickTimeline } from '../../components/prayerFlickTimeline';
import {
  clearResolvedArenaConfigs,
  getArenaAllowUnboundedFallback,
  getArenaConfig,
  setArenaConfig,
  setResolvedArenaConfig,
} from '../../core/constants';
import type { InfernoSnapshot } from '../../core/encounters/snapshot';
import type { EquipmentClickSlot } from '../../core/encounters/types';
import { ReplayRecorder } from '../../core/ReplayRecorder';
import { SimulationEngine } from '../../core/SimulationEngine';
import type { WorldState } from '../../core/WorldState';
import { loadInfernoArena } from '../../encounters/inferno/__tests__/infernoArenaFixture';
import { INFERNO_SPAWN_LAYOUT_KEY } from '../../encounters/inferno/controls';
import { buildInfernoControls, InfernoEncounter } from '../../encounters/inferno/InfernoEncounter';
import { planWaveSpawns } from '../../encounters/inferno/layout';
import { layoutFromPlacements, parseSpawnLayout, serializeSpawnLayout } from '../../encounters/inferno/spawnLayout';
import { LobbyEncounter } from '../../encounters/lobby/LobbyEncounter';
import { encounterModuleForKind } from '../../encounters/modules';
import { encounterSetupStage } from '../../encounters/practiceChrome';
import * as engineFactory from '../../encounters/simulationEngineFactory';
import { SolHereditEncounter } from '../../encounters/solHeredit/SolHereditEncounter';
import { YamaEncounter } from '../../encounters/yamaP3/YamaEncounter';
import { runSyntheticInput } from '../../input/inputProvenance';
import { diffResumableState } from '../../replay/resumableState';
import { enqueueEnginePendingHit } from '../../test/helpers/pendingHits';
import { skipWithoutSetup } from '../../test/helpers/setupAssets';
import { tickBus } from '../../tutorial/runtime/tickBus';
import { getWeaponCategoryKey } from '../../types/attackStyles';
import { createEmptyCombatSupplies } from '../../types/encounterLoadout';
import { createEmptyInventory } from '../../types/inventory';
import { DEFAULT_PLAYER_CONFIG, type PlayerConfig } from '../../types/player';
import { type Coordinate, DEFAULT_MECHANICS_CONFIG, type MechanicsConfig, PrayerType } from '../../types/simulation';
import { cloneInventory, type WornLoadout } from '../../util/loadoutUtils';
import { resetPageActivityForTests } from '../pageActivity';
import { type UseAudioManagerReturn, useAudioManager } from '../useAudioManager';
import { committedPrayerPresentation, type SceneState, useSimulationWiring } from '../useSimulationWiring';
import { useViewportInteraction } from '../useViewportInteraction';

/** The Inferno start-position cases bake the arena; `npm run setup` writes its fixture. */
const itWithArena = it.skipIf(skipWithoutSetup('infernoArena'));

type WiringParams = Parameters<typeof useSimulationWiring>[0];

function createParams(overrides: Partial<WiringParams> = {}): WiringParams {
  const audioEngine = new AudioEngine();
  return {
    activeMechanicsConfig: DEFAULT_MECHANICS_CONFIG,
    attackStylePerCategory: {},
    autoAdvance: false,
    pauseWhenUnfocused: false,
    modalPaused: false,
    fightStartCountdownTicks: null,
    audioEngine,
    eventAudioPlayerRef: { current: new EventAudioPlayer(audioEngine) },
    frameSoundTrackerRef: { current: new FrameSoundTracker(audioEngine) },
    getEncounterEquipment: () => ({}),
    getEncounterInventory: createEmptyInventory,
    getEncounterSupplies: createEmptyCombatSupplies,
    setEncounterSupplies: vi.fn(),
    isFullyLoaded: false,
    instantInventoryEnabled: false,
    instantPrayerEnabled: false,
    objTypeLoader: null,
    persistEquipmentEncounterKind: null,
    playerConfig: DEFAULT_PLAYER_CONFIG,
    getReplayUiState: () => ({ activeGamePanelTab: 'inventory' }),
    onReplayUiStateChange: vi.fn(),
    rendererType: 'canvas2d',
    sceneState: { kind: 'lobby' },
    setPlayerConfig: vi.fn(),
    setSceneState: vi.fn(),
    speedMultiplier: 1,
    inputLagMs: 0,
    updateAttackStylePerCategory: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  prayerFlickTimeline.reset();
  delete window.dumpInventory;
  vi.restoreAllMocks();
});

describe('committedPrayerPresentation', () => {
  it('reports no lit prayer for empty slots', () => {
    const presentation = committedPrayerPresentation({ activePrayer: null, offensivePrayer: null });

    expect(presentation).toEqual({
      protection: null,
      offensive: null,
      independent: [],
      visualOverrides: {},
      anyLit: false,
    });
  });

  it('reports committed protection and offensive slots as lit', () => {
    const presentation = committedPrayerPresentation({
      activePrayer: PrayerType.ProtectMagic,
      offensivePrayer: PrayerType.Piety,
    });

    expect(presentation).toEqual({
      protection: PrayerType.ProtectMagic,
      offensive: PrayerType.Piety,
      independent: [],
      visualOverrides: {},
      anyLit: true,
    });
  });
});

describe('useSimulationWiring recorded attack style ownership', () => {
  const weapon = 4151;
  const bow = 20997;
  const weaponCategory = getWeaponCategoryKey(weapon);
  const bowCategory = getWeaponCategoryKey(bow);
  const openingStyles = { [weaponCategory]: 0, [bowCategory]: 0 };
  const savedStyles = { [weaponCategory]: 1, [bowCategory]: 2 };
  const audio: AudioEngine[] = [];
  let arena: ReturnType<typeof getArenaConfig>;
  let allowUnbounded: boolean;

  beforeEach(() => {
    arena = getArenaConfig();
    allowUnbounded = getArenaAllowUnboundedFallback();
  });
  afterEach(() => {
    for (const engine of audio) engine.dispose();
    audio.length = 0;
    setArenaConfig(arena, allowUnbounded);
  });

  async function restoreEarlierStyle() {
    // Supply only cache equip-slot metadata; actual gear queues, recording and rebuilds stay real.
    vi.spyOn(SimulationEngine.prototype, 'getItemEquipSlot').mockImplementation((id) =>
      id === weapon || id === bow ? 'weapon' : null,
    );
    const inventory = createEmptyInventory();
    inventory[0] = { id: bow };
    const params = createParams({
      isFullyLoaded: true,
      rendererType: 'none',
      sceneState: { kind: 'encounter', encounterKind: 'yama_p3' },
      activeMechanicsConfig: { ...DEFAULT_MECHANICS_CONFIG, infiniteHealth: true },
      getEncounterEquipment: () => ({ weapon }),
      getEncounterInventory: () => inventory,
    });
    audio.push(params.audioEngine);
    const persist = vi.fn();
    const view = renderHook(() => {
      const [styles, setStyles] = useState<Record<string, number>>({ ...openingStyles });
      const [player, setPlayer] = useState<PlayerConfig>({ ...DEFAULT_PLAYER_CONFIG, equipment: { weapon } });
      const [speed, setSpeed] = useState(1);
      const wiring = useSimulationWiring({
        ...params,
        playerConfig: player,
        setPlayerConfig: setPlayer,
        attackStylePerCategory: styles,
        speedMultiplier: speed,
        updateAttackStylePerCategory: (next) => {
          persist(next);
          setStyles(next);
        },
      });
      return { ...wiring, styles, setSpeed };
    });
    act(() =>
      view.result.current.setEngine(
        new SimulationEngine({
          encounter: new YamaEncounter(undefined, 1234),
          combatSeed: 5678,
          enableIntro: false,
          stats: DEFAULT_PLAYER_CONFIG.stats,
        }),
      ),
    );
    act(() => view.result.current.handleReset());
    act(() => view.result.current.fastForwardTicks(2));
    act(() => view.result.current.handleAttackStyleChange(1));
    act(() => view.result.current.handleEquipFromInventory(0));
    act(() => view.result.current.fastForwardTicks(3));
    expect(view.result.current.simulationState.playerEquipment.weapon).toBe(bow);
    act(() => view.result.current.handleAttackStyleChange(2));
    act(() => view.result.current.handleEquipFromInventory(0));
    act(() => view.result.current.fastForwardTicks(4));
    expect(view.result.current.simulationState.playerEquipment.weapon).toBe(weapon);
    expect(view.result.current.styles).toEqual(savedStyles);
    act(() => view.result.current.replay.controlProps.onEnterReplay());
    act(() => view.result.current.replay.controlProps.onSeek(2));
    expect(view.result.current.replay.displayState.selectedAttackStyleIndex).toBe(0);
    const previousEngine = view.result.current.engine;
    persist.mockClear();
    await act(async () => {
      await view.result.current.replay.controlProps.onTakeOver();
    });
    expect(view.result.current.engine).not.toBe(previousEngine);
    expect(view.result.current.replay.replayMode).toBe(false);
    // Taking over tick 2 restores tick 1; tick 2 is the first one played.
    expect(view.result.current.simulationState.currentTick).toBe(1);
    return { ...view, persist };
  }

  function expectExactBranch(result: { current: ReturnType<typeof useSimulationWiring> }) {
    const data = result.current.replay.exportReplayData();
    if (!data.runConfig) throw new Error('Missing real branch bootstrap');
    const recorder = new ReplayRecorder();
    recorder.load(data);
    const rebuilt = engineFactory.reconstructReplayPrefix(
      data.runConfig,
      recorder.getReconstructionFrames(),
      recorder.getFrameCount() - 1,
      null,
    );
    if (!rebuilt) throw new Error('Real branch reconstruction was refused');
    expect.soft(diffResumableState(result.current.engine.getState(), rebuilt.getState())).toEqual([]);
    expect.soft(rebuilt.getAttackStylePerCategory()).toEqual(result.current.engine.getAttackStylePerCategory());
    return data;
  }

  it('preserves reconstructed category preferences through adoption, speed effects and the next frame, but seeds fresh runs from saved preferences', async () => {
    const { result, persist } = await restoreEarlierStyle();
    expect.soft(result.current.simulationState.selectedAttackStyleIndex).toBe(0);
    expect.soft(result.current.engine.getAttackStylePerCategory()).toEqual(openingStyles);
    expect(result.current.styles).toEqual(savedStyles);
    expect(persist).not.toHaveBeenCalled();
    act(() => result.current.setSpeed(2));
    expect.soft(result.current.engine.getState().selectedAttackStyleIndex).toBe(0);
    act(() => result.current.fastForwardTicks(3));
    const branch = expectExactBranch(result);
    expect(branch.frames.at(-1)?.actions).toEqual([]);
    expect(branch.runConfig?.bootstrap?.attackStylePerCategory).toEqual(openingStyles);
    act(() => result.current.handleReset());
    expect(result.current.simulationState.selectedAttackStyleIndex).toBe(1);
    expect(result.current.engine.getAttackStylePerCategory()).toEqual(savedStyles);
    expect(result.current.replay.exportReplayData().runConfig?.bootstrap?.attackStylePerCategory).toEqual(savedStyles);
    expect(result.current.styles).toEqual(savedStyles);
    act(() =>
      result.current.setEngine(
        new SimulationEngine({ encounter: new YamaEncounter(undefined, 4321), enableIntro: false }),
      ),
    );
    expect(result.current.simulationState.selectedAttackStyleIndex).toBe(1);
    expect(result.current.engine.getAttackStylePerCategory()).toEqual(savedStyles);
    expect(branch.runConfig?.bootstrap?.attackStylePerCategory).toEqual(openingStyles);
  });

  it('records an intentional post-takeover style change and preserves other reconstructed categories across gear swaps', async () => {
    const { result, persist } = await restoreEarlierStyle();
    act(() => result.current.handleAttackStyleChange(1));
    // The first executed tick is the selected tick 2, which carries the new input.
    act(() => result.current.fastForwardTicks(2));
    expect(result.current.simulationState.selectedAttackStyleIndex).toBe(1);
    expect(result.current.replay.exportReplayData().frames.at(-1)?.actions).toContainEqual({
      type: 'attackStyleChange',
      index: 1,
    });
    expect(persist).toHaveBeenCalledExactlyOnceWith(savedStyles);
    expectExactBranch(result);
    act(() => result.current.handleEquipFromInventory(0));
    act(() => result.current.fastForwardTicks(4));
    expect(result.current.simulationState.playerEquipment.weapon).toBe(bow);
    expect.soft(result.current.simulationState.selectedAttackStyleIndex).toBe(0);
    expectExactBranch(result);
    act(() => result.current.handleEquipFromInventory(0));
    act(() => result.current.fastForwardTicks(5));
    expect(result.current.simulationState.playerEquipment.weapon).toBe(weapon);
    expect(result.current.simulationState.selectedAttackStyleIndex).toBe(1);
    expectExactBranch(result);
    expect(result.current.styles).toEqual(savedStyles);
  });
});

describe('useSimulationWiring replay delayed cues', () => {
  let params: WiringParams;

  beforeEach(() => {
    params = createParams();
    params.eventAudioPlayerRef.current = new EventAudioPlayer(params.audioEngine, {
      name: 'delayed',
      rules: { actor_died: { resolve: { id: 10313, delayCycles: 21 } } },
    });
    vi.spyOn(params.audioEngine, 'play').mockImplementation(() => {});
  });

  afterEach(() => params.audioEngine.dispose());

  function queueCue(): void {
    params.eventAudioPlayerRef.current.updateReplayClock(0);
    params.eventAudioPlayerRef.current.onEvents(
      [{ type: 'actor_died', eventId: 1, tick: 0, actorId: 'player' }],
      [31, 37],
    );
  }

  it('clears pending cues when entering replay', () => {
    const { result } = renderHook(() => useSimulationWiring(params));
    act(() => result.current.fastForwardTicks(2));
    queueCue();
    const stopAll = vi.spyOn(params.audioEngine, 'stopAll');

    act(() => result.current.replay.controlProps.onEnterReplay());
    params.eventAudioPlayerRef.current.updateReplayClock(420);

    expect(params.audioEngine.play).not.toHaveBeenCalled();
    expect(stopAll).toHaveBeenCalledOnce();
  });

  it('clears pending cues when another recording replaces the current replay', () => {
    const { result } = renderHook(() => useSimulationWiring(params));
    act(() => result.current.fastForwardTicks(2));
    const data = result.current.replay.exportReplayData();
    act(() => result.current.replay.controlProps.onEnterReplay());
    queueCue();
    const stopAll = vi.spyOn(params.audioEngine, 'stopAll');

    act(() => result.current.replay.loadExternalReplay(data));
    params.eventAudioPlayerRef.current.updateReplayClock(420);

    expect(params.audioEngine.play).not.toHaveBeenCalled();
    expect(stopAll).toHaveBeenCalledOnce();
  });

  it('retains future cue onsets when the pause control stops active audio', () => {
    const { result } = renderHook(() => useSimulationWiring(params));
    act(() => result.current.fastForwardTicks(2));
    act(() => result.current.replay.controlProps.onEnterReplay());
    act(() => result.current.replay.controlProps.onPlayPause());
    queueCue();
    const stopAll = vi.spyOn(params.audioEngine, 'stopAll');
    const pausePlayback = vi.spyOn(params.audioEngine, 'pausePlayback');
    const resumePlayback = vi.spyOn(params.audioEngine, 'resumePlayback');

    act(() => result.current.replay.controlProps.onPlayPause());
    params.eventAudioPlayerRef.current.updateReplayClock(100, true);
    act(() => result.current.replay.controlProps.onPlayPause());
    params.eventAudioPlayerRef.current.updateReplayClock(420);

    expect(stopAll).not.toHaveBeenCalled();
    expect(pausePlayback).toHaveBeenCalledOnce();
    expect(resumePlayback).toHaveBeenCalledOnce();
    expect(params.audioEngine.play).toHaveBeenCalledExactlyOnceWith(
      10313,
      { channel: 'sfx', volume: 1 },
      'event:actor_died',
    );
  });

  it.each([0.5, 1, 2])('hands off pending final-frame cues when playback completes at %sx', (speedMultiplier) => {
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { result } = renderHook(() => useSimulationWiring({ ...params, speedMultiplier }));
    act(() => result.current.fastForwardTicks(2));
    act(() => result.current.replay.controlProps.onEnterReplay());
    act(() => result.current.replay.controlProps.onPlayPause());
    const advance = (timeMs: number): void => {
      const callback = callbacks.at(-1);
      if (!callback) expect.fail('Expected a scheduled replay frame');
      act(() => callback(timeMs));
    };
    advance(1000 + 600 / speedMultiplier);
    params.eventAudioPlayerRef.current.updateReplayClock(1200);
    params.eventAudioPlayerRef.current.onEvents(
      [{ type: 'actor_died', eventId: 1, tick: 2, actorId: 'player' }],
      [31, 37],
    );
    const stopAll = vi.spyOn(params.audioEngine, 'stopAll');

    advance(1000 + 1200 / speedMultiplier);

    expect(result.current.replay.controlProps.isPlaying).toBe(false);
    expect(params.audioEngine.play).toHaveBeenCalledExactlyOnceWith(
      10313,
      { channel: 'sfx', volume: 1, delayMs: 420 / speedMultiplier },
      'event:actor_died',
    );
    expect(stopAll).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'seek',
      apply: (replay: ReturnType<typeof useSimulationWiring>['replay']) => replay.controlProps.onSeek(1),
    },
    {
      name: 'exit',
      apply: (replay: ReturnType<typeof useSimulationWiring>['replay']) => replay.controlProps.onExitReplay(),
    },
  ])('clears pending cues when the replay control performs $name', ({ apply }) => {
    const { result } = renderHook(() => useSimulationWiring(params));
    act(() => result.current.fastForwardTicks(2));
    act(() => result.current.replay.controlProps.onEnterReplay());
    queueCue();
    const stopAll = vi.spyOn(params.audioEngine, 'stopAll');

    act(() => apply(result.current.replay));
    params.eventAudioPlayerRef.current.updateReplayClock(420);

    expect(params.audioEngine.play).not.toHaveBeenCalled();
    expect(stopAll).toHaveBeenCalledOnce();
  });

  it('clears audio continuation and pending cues when resetting a paused replay', () => {
    const { result } = renderHook(() => useSimulationWiring(params));
    act(() => result.current.fastForwardTicks(2));
    act(() => result.current.replay.controlProps.onEnterReplay());
    act(() => result.current.replay.controlProps.onPlayPause());
    act(() => result.current.replay.controlProps.onPlayPause());
    queueCue();
    const stopAll = vi.spyOn(params.audioEngine, 'stopAll');

    act(() => result.current.handleReset());
    params.eventAudioPlayerRef.current.updateReplayClock(420);

    expect(stopAll).toHaveBeenCalledOnce();
    expect(params.audioEngine.play).not.toHaveBeenCalled();
    expect(result.current.replay.replayMode).toBe(false);
  });
});

describe('useSimulationWiring grapple input lag', () => {
  let nowMs: number;
  let frames: Map<number, FrameRequestCallback>;
  let params: WiringParams;

  beforeEach(() => {
    nowMs = 0;
    frames = new Map();
    let nextId = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(++nextId, callback);
      return nextId;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    params = createParams({
      autoAdvance: true,
      isFullyLoaded: true,
      activeMechanicsConfig: { ...DEFAULT_MECHANICS_CONFIG, infiniteHealth: true, solHereditAttacks: false },
    });
  });

  afterEach(() => params.audioEngine.dispose());

  function advanceFrame(timeMs: number): void {
    nowMs = timeMs;
    const queued = [...frames.values()];
    frames.clear();
    act(() => {
      for (const callback of queued) callback(timeMs);
    });
  }

  it.each([
    { inputLagMs: 50, processingOffset: 4 },
    { inputLagMs: 200, processingOffset: 5 },
  ])('records and consumes an accepted click at T+$processingOffset with $inputLagMs ms lag, never unequipping', ({
    inputLagMs,
    processingOffset,
  }) => {
    params = { ...params, inputLagMs };
    const { result } = renderHook(() => useSimulationWiring(params));
    const createEngine = () => {
      const engine = new SimulationEngine({ encounter: new SolHereditEncounter(7), combatSeed: 123 });
      engine.setMechanicsConfig(params.activeMechanicsConfig);
      return engine;
    };
    const engine = createEngine();
    const equipment = { body: 11832, cape: 6570, hands: 7462, legs: 11834, boots: 11840 };
    act(() => {
      result.current.playerEquipmentRef.current = equipment;
      result.current.setEngine(engine);
    });
    act(() => result.current.handleExecuteEncounterCommand({ encounter: 'sol_heredit', type: 'trigger-grapple' }));
    // The command queues the grapple for Sol's next ready, in-reach slot; T is the tick it starts.
    const grapple = () => {
      const snapshot = engine.getState().encounter;
      return snapshot.kind === 'sol_heredit' ? snapshot.state.grapple : null;
    };
    let frameTick = 0;
    while (!grapple() && frameTick < 30) advanceFrame(++frameTick * 600);
    const started = grapple();
    if (!started) throw new Error('no grapple');
    const start = started.resolveTick - 4;
    expect(engine.getState().currentTick).toBe(start);
    const slot = started.slot as EquipmentClickSlot;
    const unequip = vi.spyOn(engine, 'queueUnequip');
    for (let tick = start + 1; tick <= start + 3; tick++) advanceFrame(tick * 600);
    // 100 ms before the T+4 tick: 50 ms of lag still lands on T+4, 200 ms slips to T+5.
    advanceFrame((start + 3) * 600 + 500);
    act(() => expect(result.current.handleEquipmentSlotClick(slot)).toBe(true));
    advanceFrame((start + 4) * 600);
    expect(engine.getState().currentTick).toBe(start + 4);
    expect(engine.acceptsEncounterInput({ kind: 'equipmentSlotClick', slot })).toBe(false);
    advanceFrame((start + 5) * 600);

    expect(unequip).not.toHaveBeenCalled();
    expect(engine.getState().playerEquipment).toEqual(equipment);
    expect(engine.getDamageHistory().filter((hit) => hit.source === 'SolGrapple')).toHaveLength(
      processingOffset === 4 ? 0 : 1,
    );
    const recording = result.current.replay.exportReplayData();
    const clickFrames = recording.frames.filter((frame) =>
      frame.actions.some((action) => action.type === 'equipmentSlotClick'),
    );
    expect(clickFrames.map((frame) => frame.state.currentTick)).toEqual([start + processingOffset]);
    expect(clickFrames[0]?.actions).toContainEqual({ type: 'equipmentSlotClick', slot });

    // Replay the recorded processing-tick actions without re-running UI acceptance or latency.
    const replayEngine = createEngine();
    replayEngine.setEquipment(equipment);
    for (const frame of recording.frames.slice(1)) {
      for (const action of frame.actions) replayEngine.applyAction(action);
      replayEngine.advanceTick(frame.state.playerPosition);
    }
    expect(replayEngine.getDamageHistory()).toEqual(engine.getDamageHistory());
    expect(replayEngine.getState().encounter).toEqual(engine.getState().encounter);
    expect(replayEngine.getState().playerEquipment).toEqual(equipment);
  });
});

describe('useSimulationWiring focus suspension', () => {
  let nowMs: number;
  let focused: boolean;
  let visibility: DocumentVisibilityState;
  let frames: Map<number, FrameRequestCallback>;
  let params: WiringParams;

  beforeEach(() => {
    resetPageActivityForTests();
    nowMs = 0;
    focused = true;
    visibility = 'visible';
    frames = new Map();
    let nextId = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(++nextId, callback);
      return nextId;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    params = createParams({ autoAdvance: true, isFullyLoaded: true, pauseWhenUnfocused: true });
  });

  afterEach(() => params.audioEngine.dispose());

  function advanceFrame(timeMs: number): void {
    nowMs = timeMs;
    const queued = [...frames.values()];
    frames.clear();
    act(() => {
      for (const callback of queued) callback(timeMs);
    });
  }

  function changeFocus(value: boolean): void {
    focused = value;
    act(() => window.dispatchEvent(new Event(value ? 'focus' : 'blur')));
  }

  it('suspends actual live ticks and audio while blurred and preserves the remaining tick time', () => {
    const pause = vi.spyOn(params.audioEngine, 'pausePlayback');
    const resume = vi.spyOn(params.audioEngine, 'resumePlayback');
    const mute = vi.spyOn(params.audioEngine, 'setFocusSuspended');
    const { result } = renderHook(() => useSimulationWiring(params));
    advanceFrame(600);
    expect(result.current.simulationState.currentTick).toBe(1);
    const queued = [...frames.values()];

    nowMs = 1050;
    changeFocus(false);
    advanceFrame(10000);
    act(() => {
      for (const callback of queued) callback(nowMs);
    });

    expect(result.current.focusPaused).toBe(true);
    expect(result.current.simulationState.currentTick).toBe(1);
    expect(frames.size).toBe(0);
    expect(pause).toHaveBeenCalledOnce();
    changeFocus(true);
    advanceFrame(10149);
    expect(result.current.simulationState.currentTick).toBe(1);
    advanceFrame(10150);
    expect(result.current.simulationState.currentTick).toBe(2);
    expect(result.current.focusPaused).toBe(false);
    expect(resume).toHaveBeenCalledOnce();
    expect(mute).not.toHaveBeenCalled();
  });

  it.each(
    [0.5, 1, 2].flatMap((speedMultiplier) => [0, 300].map((inputLagMs) => ({ speedMultiplier, inputLagMs }))),
  )('matches uninterrupted engine state, actions and events per tick at $speedMultiplier x with $inputLagMs ms lag', ({
    speedMultiplier,
    inputLagMs,
  }) => {
    params = {
      ...params,
      speedMultiplier,
      inputLagMs,
      activeMechanicsConfig: { ...DEFAULT_MECHANICS_CONFIG, infiniteHealth: true },
    };
    const run = (pauseDurations: readonly number[]) => {
      const start = nowMs;
      const { result, unmount } = renderHook(() => useSimulationWiring(params));
      const engine = new SimulationEngine({
        encounter: new YamaEncounter(undefined, 1234),
        combatSeed: 5678,
        startPos: [31, 37],
      });
      act(() => result.current.setEngine(engine));
      let suspendedMs = 0;
      const frame = (activeMs: number) => advanceFrame(start + suspendedMs + activeMs / speedMultiplier);
      frame(400);
      act(() => {
        result.current.handlePrayerChange(PrayerType.ProtectMagic);
        result.current.handleRunToggle();
      });
      const suspend = (duration: number) => {
        changeFocus(false);
        advanceFrame(nowMs + duration);
        suspendedMs += duration;
        changeFocus(true);
      };
      frame(450);
      if (pauseDurations[0] !== undefined) suspend(pauseDurations[0]);
      frame(599);
      expect(engine.getState().currentTick).toBe(0);
      frame(600);
      expect(engine.getState().currentTick).toBe(1);
      const firstTick = result.current.replay.exportReplayData().frames[1];
      expect(firstTick?.state.activePrayer).toBe(inputLagMs === 0 ? PrayerType.ProtectMagic : null);
      frame(1050);
      if (pauseDurations[1] !== undefined) suspend(pauseDurations[1]);
      frame(1199);
      expect(engine.getState().currentTick).toBe(1);
      frame(1200);
      expect(engine.getState().activePrayer).toBe(PrayerType.ProtectMagic);
      for (let tick = 3; tick <= 12; tick++) frame(tick * 600);
      const recording = result.current.replay.exportReplayData();
      unmount();
      return recording;
    };

    const reference = run([]);
    for (const pauses of [[60_000], [60_000, 125_000]]) {
      const interrupted = run(pauses);
      expect(interrupted.runConfig).toEqual(reference.runConfig);
      // Slow-tick timing is presentation-only diagnostics, never part of the deterministic run.
      const withoutTiming = (frames: typeof reference.frames) => frames.map(({ timing: _timing, ...frame }) => frame);
      expect(withoutTiming(interrupted.frames)).toEqual(withoutTiming(reference.frames));
      expect(interrupted.frames.some((frame) => frame.events.length > 0)).toBe(true);
      expect(interrupted.frames.flatMap((frame) => frame.actions)).toEqual(
        reference.frames.flatMap((frame) => frame.actions),
      );
    }
  });

  // A late frame makes a late, longer tick, and an input from the late stretch arrived before the
  // tick ran, so it is that tick's. (This replaced holding it for the tick after.)
  it('gives an input made after a tick boundary, but before the late frame that runs it, to that tick', () => {
    params = { ...params, activeMechanicsConfig: { ...DEFAULT_MECHANICS_CONFIG, infiniteHealth: true } };
    const { result } = renderHook(() => useSimulationWiring(params));
    const engine = new SimulationEngine({
      encounter: new YamaEncounter(undefined, 1234),
      combatSeed: 5678,
      startPos: [31, 37],
    });
    act(() => result.current.setEngine(engine));
    advanceFrame(590);

    // The 600ms boundary has passed; the next animation frame has not run yet.
    nowMs = 605;
    act(() => result.current.handlePrayerChange(PrayerType.ProtectMagic));
    advanceFrame(612);
    expect(engine.getState().currentTick).toBe(1);
    expect(engine.getState().activePrayer).toBe(PrayerType.ProtectMagic);
    expect(result.current.replay.exportReplayData().frames[1]?.actions.map((action) => action.type)).toEqual([
      'protectionPrayer',
    ]);

    // The next tick is a full interval after the late one actually ran, not on the old grid.
    nowMs = 700;
    act(() => result.current.handleRunToggle());
    advanceFrame(1200);
    expect(engine.getState().currentTick).toBe(1);
    advanceFrame(1212);
    expect(engine.getState().currentTick).toBe(2);
    expect(result.current.replay.exportReplayData().frames[2]?.actions.map((action) => action.type)).toEqual([
      'runToggle',
    ]);
  });

  function renderWithYama() {
    params = { ...params, activeMechanicsConfig: { ...DEFAULT_MECHANICS_CONFIG, infiniteHealth: true } };
    const view = renderHook(useSimulationWiring, { initialProps: params });
    const engine = new SimulationEngine({
      encounter: new YamaEncounter(undefined, 1234),
      combatSeed: 5678,
      startPos: [31, 37],
    });
    act(() => view.result.current.setEngine(engine));
    return { ...view, engine };
  }

  const actionTypes = (result: { current: ReturnType<typeof useSimulationWiring> }, tick: number) =>
    result.current.replay.exportReplayData().frames[tick]?.actions.map((action) => action.type);

  it('freezes the tick during a tutorial hold and finishes it, with inputs from the resume, afterwards', () => {
    const { result, engine } = renderWithYama();
    advanceFrame(580);
    // Held at 590, with 10 ms of the tick left.
    nowMs = 590;
    act(() => result.current.setTutorialPaused(true));
    advanceFrame(5000);
    expect(engine.getState().currentTick).toBe(0);

    nowMs = 5005;
    act(() => result.current.setTutorialPaused(false));
    act(() => result.current.handlePrayerChange(PrayerType.ProtectMagic));
    // The held time is not counted, so the tick still has its 10 ms to run from the resume.
    advanceFrame(5014);
    expect(engine.getState().currentTick).toBe(0);
    advanceFrame(5015);
    expect(engine.getState().currentTick).toBe(1);
    expect(actionTypes(result, 1)).toEqual(['protectionPrayer']);
    expect(result.current.replay.exportReplayData().frames[1]?.timing).toBeUndefined();

    advanceFrame(5615);
    expect(actionTypes(result, 2)).toEqual([]);
  });

  it('applies held inputs in order when auto-advance turns off', () => {
    // Lag keeps the prayer in flight past the tick that runs at 612.
    params = { ...params, inputLagMs: 100 };
    const { result, rerender, engine } = renderWithYama();
    advanceFrame(590);
    nowMs = 605;
    act(() => result.current.handlePrayerChange(PrayerType.ProtectMagic));
    advanceFrame(612);
    expect(actionTypes(result, 1)).toEqual([]);

    rerender({ ...params, autoAdvance: false });
    act(() => result.current.handleRunToggle());
    act(() => result.current.fastForwardTicks(2));

    expect(engine.getState().activePrayer).toBe(PrayerType.ProtectMagic);
    expect(actionTypes(result, 2)).toEqual(['protectionPrayer', 'runToggle']);
  });

  it('keeps a held synthetic input out of the replay recording', () => {
    params = { ...params, inputLagMs: 100 };
    const { result, engine } = renderWithYama();
    advanceFrame(590);
    nowMs = 605;
    act(() => runSyntheticInput(() => result.current.handlePrayerChange(PrayerType.ProtectMagic)));
    advanceFrame(612);
    expect(engine.getState().activePrayer).toBeNull();
    advanceFrame(1212);

    expect(engine.getState().activePrayer).toBe(PrayerType.ProtectMagic);
    expect(actionTypes(result, 1)).toEqual([]);
    expect(actionTypes(result, 2)).toEqual([]);
  });

  it('keeps running when the page has never had focus, as when opened from the address bar', () => {
    focused = false;
    const { result } = renderHook(() => useSimulationWiring(params));
    advanceFrame(600);

    expect(result.current.focusPaused).toBe(false);
    expect(result.current.simulationState.currentTick).toBe(1);
  });

  it('starts suspended when the window was left before mount and responds to setting changes while blurred', () => {
    changeFocus(false);
    const { result, rerender } = renderHook(useSimulationWiring, { initialProps: params });
    advanceFrame(10000);
    expect(result.current.simulationState.currentTick).toBe(0);
    expect(result.current.focusPaused).toBe(true);

    rerender({ ...params, pauseWhenUnfocused: false });
    advanceFrame(10600);
    expect(result.current.simulationState.currentTick).toBe(1);
    expect(result.current.focusPaused).toBe(false);
    rerender(params);
    advanceFrame(20000);
    expect(result.current.simulationState.currentTick).toBe(1);
    expect(result.current.focusPaused).toBe(true);
  });

  it('preserves a manual pause made during focus suspension, including paused audio', () => {
    const resume = vi.spyOn(params.audioEngine, 'resumePlayback');
    const { result, rerender } = renderHook(useSimulationWiring, { initialProps: params });
    advanceFrame(600);
    changeFocus(false);
    rerender({ ...params, autoAdvance: false });

    changeFocus(true);
    advanceFrame(10000);

    expect(result.current.simulationState.currentTick).toBe(1);
    expect(resume).not.toHaveBeenCalled();
    rerender(params);
    advanceFrame(10600);
    expect(result.current.simulationState.currentTick).toBe(2);
    expect(resume).toHaveBeenCalledOnce();
  });

  it('preserves tutorial pause when focus returns', () => {
    const resume = vi.spyOn(params.audioEngine, 'resumePlayback');
    const { result } = renderHook(() => useSimulationWiring(params));
    changeFocus(false);
    result.current.engine.setTutorialPaused(true);

    changeFocus(true);
    advanceFrame(600);

    expect(result.current.engine.isTutorialPaused()).toBe(true);
    expect(result.current.simulationState.currentTick).toBe(0);
    expect(resume).not.toHaveBeenCalled();
    result.current.engine.setTutorialPaused(false);
    advanceFrame(1200);
    expect(result.current.simulationState.currentTick).toBe(1);
    expect(resume).toHaveBeenCalledOnce();
  });

  it('does not touch manually paused live audio on blur and focus', () => {
    params = { ...params, autoAdvance: false };
    const pause = vi.spyOn(params.audioEngine, 'pausePlayback');
    const resume = vi.spyOn(params.audioEngine, 'resumePlayback');
    const { result } = renderHook(() => useSimulationWiring(params));

    changeFocus(false);
    changeFocus(true);
    advanceFrame(600);

    expect(result.current.simulationState.currentTick).toBe(0);
    expect(pause).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it.each([false, true])('wires the focus policy into replay playback when enabled=%s', (pauseWhenUnfocused) => {
    params = { ...params, pauseWhenUnfocused };
    const { result } = renderHook(() => useSimulationWiring(params));
    act(() => result.current.fastForwardTicks(3));
    act(() => result.current.replay.controlProps.onEnterReplay());
    act(() => result.current.replay.controlProps.onPlayPause());
    advanceFrame(300);
    const pause = vi.spyOn(params.audioEngine, 'pausePlayback');
    const resume = vi.spyOn(params.audioEngine, 'resumePlayback');

    changeFocus(false);
    advanceFrame(600);

    expect(result.current.replay.replayFrameStore.getSnapshot().playheadMs).toBe(pauseWhenUnfocused ? 300 : 600);
    expect(result.current.replay.controlProps.isPlaying).toBe(true);
    expect(pause).toHaveBeenCalledTimes(pauseWhenUnfocused ? 1 : 0);
    changeFocus(true);
    advanceFrame(900);
    expect(result.current.replay.replayFrameStore.getSnapshot().playheadMs).toBe(pauseWhenUnfocused ? 600 : 900);
    expect(resume).toHaveBeenCalledTimes(pauseWhenUnfocused ? 1 : 0);
  });

  it('continues visible background ticks when opted out', () => {
    params = { ...params, pauseWhenUnfocused: false };
    const pause = vi.spyOn(params.audioEngine, 'pausePlayback');
    const { result } = renderHook(() => useSimulationWiring(params));

    changeFocus(false);
    advanceFrame(600);

    expect(result.current.simulationState.currentTick).toBe(1);
    expect(result.current.focusPaused).toBe(false);
    expect(pause).not.toHaveBeenCalled();
  });

  it('does not treat focus changes between input elements as window blur', () => {
    const { result } = renderHook(() => useSimulationWiring(params));
    const input = document.createElement('input');
    document.body.append(input);

    act(() => {
      input.focus();
      input.blur();
    });
    advanceFrame(600);

    expect(result.current.focusPaused).toBe(false);
    expect(result.current.simulationState.currentTick).toBe(1);
    input.remove();
  });

  it('suspends hidden live tabs even when opted out and preserves the baseline on visibility return', () => {
    params = { ...params, pauseWhenUnfocused: false };
    const { result } = renderHook(() => useSimulationWiring(params));
    advanceFrame(600);
    visibility = 'hidden';

    act(() => document.dispatchEvent(new Event('visibilitychange')));
    advanceFrame(10000);

    expect(result.current.focusPaused).toBe(true);
    expect(result.current.simulationState.currentTick).toBe(1);
    visibility = 'visible';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    advanceFrame(10001);
    expect(result.current.focusPaused).toBe(false);
    expect(result.current.simulationState.currentTick).toBe(1);
    advanceFrame(10600);
    expect(result.current.simulationState.currentTick).toBe(2);
  });

  it('keeps a pending tick when a hidden frame arrives before the visibility notification', () => {
    const { result } = renderHook(() => useSimulationWiring(params));
    advanceFrame(400);
    visibility = 'hidden';
    advanceFrame(450);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    advanceFrame(60_450);
    visibility = 'visible';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    advanceFrame(60_600);
    expect(result.current.simulationState.currentTick).toBe(1);
  });

  it('removes focus listeners and scheduled ticks on unmount', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { result, unmount } = renderHook(() => useSimulationWiring(params));
    const engine = result.current.engine;
    const queued = [...frames.values()];

    unmount();
    changeFocus(false);
    changeFocus(true);
    act(() => {
      for (const callback of queued) callback(10000);
    });

    expect(frames.size).toBe(0);
    expect(engine.getState().currentTick).toBe(0);
    for (const event of ['focus', 'blur']) {
      const registration = add.mock.calls.find(([name]) => name === event);
      expect(registration).toBeDefined();
      expect(remove).toHaveBeenCalledWith(event, registration?.[1]);
    }
  });
});

describe('useSimulationWiring modal hold', () => {
  let nowMs: number;
  let focused: boolean;
  let frames: Map<number, FrameRequestCallback>;
  let params: WiringParams;

  beforeEach(() => {
    resetPageActivityForTests();
    nowMs = 0;
    focused = true;
    frames = new Map();
    let nextId = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(++nextId, callback);
      return nextId;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    params = createParams({
      autoAdvance: true,
      isFullyLoaded: true,
      pauseWhenUnfocused: true,
      activeMechanicsConfig: { ...DEFAULT_MECHANICS_CONFIG, infiniteHealth: true },
    });
  });

  afterEach(() => {
    params.audioEngine.dispose();
    resetPageActivityForTests();
  });

  function advanceFrame(timeMs: number): void {
    nowMs = timeMs;
    const queued = [...frames.values()];
    frames.clear();
    act(() => {
      for (const callback of queued) callback(timeMs);
    });
  }

  function changeFocus(value: boolean): void {
    focused = value;
    act(() => window.dispatchEvent(new Event(value ? 'focus' : 'blur')));
  }

  function createYama(): SimulationEngine {
    return new SimulationEngine({
      encounter: new YamaEncounter(undefined, 1234),
      combatSeed: 5678,
      startPos: [31, 37],
    });
  }

  function renderWithYama(overrides: Partial<WiringParams> = {}) {
    params = { ...params, ...overrides };
    const view = renderHook(useSimulationWiring, { initialProps: params });
    const engine = createYama();
    act(() => view.result.current.setEngine(engine));
    return { ...view, engine };
  }

  const recording = (result: { current: ReturnType<typeof useSimulationWiring> }) =>
    result.current.replay.exportReplayData();
  const frameTimeline = (result: { current: ReturnType<typeof useSimulationWiring> }) =>
    recording(result).frames.map((frame) => [frame.startMs, frame.timing]);

  it('keeps a manual pause made before or under the modal once it closes', () => {
    const { rerender, engine } = renderWithYama();
    advanceFrame(600);
    nowMs = 900;
    rerender({ ...params, modalPaused: true });
    rerender({ ...params, modalPaused: true, autoAdvance: false });
    nowMs = 5000;
    rerender({ ...params, autoAdvance: false });
    advanceFrame(10_000);
    expect(engine.getState().currentTick).toBe(1);

    // The tick still has the 300 ms it had when the modal opened.
    nowMs = 20_000;
    rerender(params);
    advanceFrame(20_299);
    expect(engine.getState().currentTick).toBe(1);
    advanceFrame(20_300);
    expect(engine.getState().currentTick).toBe(2);
  });

  it('keeps a tutorial hold when the modal closes', () => {
    const { result, rerender, engine } = renderWithYama();
    advanceFrame(600);
    nowMs = 700;
    act(() => result.current.setTutorialPaused(true));
    rerender({ ...params, modalPaused: true });
    nowMs = 5000;
    rerender(params);
    advanceFrame(10_000);

    expect(engine.isTutorialPaused()).toBe(true);
    expect(engine.getState().currentTick).toBe(1);
    nowMs = 20_000;
    act(() => result.current.setTutorialPaused(false));
    advanceFrame(20_499);
    expect(engine.getState().currentTick).toBe(1);
    advanceFrame(20_500);
    expect(engine.getState().currentTick).toBe(2);
    expect(frameTimeline(result)).toEqual([
      [0, undefined],
      [600, undefined],
      [1200, undefined],
    ]);
  });

  it('lets no tick slip through a modal that closes and reopens between frames, even an overdue one', () => {
    const { result, rerender, engine } = renderWithYama();
    advanceFrame(600);
    // Tick 2 was due at 1200; no frame has run it yet when the modal opens.
    nowMs = 1250;
    rerender({ ...params, modalPaused: true });
    nowMs = 5000;
    rerender(params);
    rerender({ ...params, modalPaused: true });
    advanceFrame(6000);
    expect(engine.getState().currentTick).toBe(1);

    // Still exactly as overdue on release, so the first frame runs it and counts it as late.
    nowMs = 20_000;
    rerender(params);
    advanceFrame(20_010);
    expect(engine.getState().currentTick).toBe(2);
    expect(recording(result).frames[2]?.timing?.lateByMs).toBe(60);
    expect(recording(result).frames[2]?.startMs).toBe(1260);
  });

  it('starts a fight that entered under the modal with a full tick once it closes', () => {
    const { result, rerender, engine } = renderWithYama();
    advanceFrame(600);
    nowMs = 900;
    rerender({ ...params, modalPaused: true });
    const next = createYama();
    act(() => result.current.setEngine(next));
    nowMs = 5000;
    rerender(params);

    advanceFrame(5599);
    expect(next.getState().currentTick).toBe(0);
    advanceFrame(5600);
    expect(next.getState().currentTick).toBe(1);
    expect(engine.getState().currentTick).toBe(1);
    expect(frameTimeline(result)).toEqual([
      [0, undefined],
      [600, undefined],
    ]);
  });

  it.each([0, 100])('gives an input made under the modal to the tick that resumes with %i ms lag', (inputLagMs) => {
    const { result, rerender, engine } = renderWithYama({ inputLagMs });
    advanceFrame(600);
    nowMs = 900;
    rerender({ ...params, modalPaused: true });
    nowMs = 3000;
    act(() => result.current.handlePrayerChange(PrayerType.ProtectMagic));
    advanceFrame(4000);
    expect(engine.getState().currentTick).toBe(1);

    nowMs = 10_000;
    rerender(params);
    advanceFrame(10_300);
    expect(engine.getState().currentTick).toBe(2);
    expect(engine.getState().activePrayer).toBe(PrayerType.ProtectMagic);
    expect(recording(result).frames[2]?.actions.map((action) => action.type)).toEqual(['protectionPrayer']);
  });

  it('pauses live audio for the modal and resumes it once when the modal closes', () => {
    const pause = vi.spyOn(params.audioEngine, 'pausePlayback');
    const resume = vi.spyOn(params.audioEngine, 'resumePlayback');
    const { rerender } = renderHook(useSimulationWiring, { initialProps: params });
    advanceFrame(600);

    rerender({ ...params, modalPaused: true });
    rerender({ ...params, modalPaused: true });
    expect(pause).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
    rerender(params);
    expect(resume).toHaveBeenCalledOnce();
    advanceFrame(1200);
    expect(pause).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
  });

  it.each([
    { order: 'focus returns first', releaseFocusFirst: true },
    { order: 'the modal closes first', releaseFocusFirst: false },
  ])('resumes audio held by both the modal and focus suspension only once neither holds, when $order', ({
    releaseFocusFirst,
  }) => {
    const pause = vi.spyOn(params.audioEngine, 'pausePlayback');
    const resume = vi.spyOn(params.audioEngine, 'resumePlayback');
    const { result, rerender } = renderHook(useSimulationWiring, { initialProps: params });
    advanceFrame(600);
    rerender({ ...params, modalPaused: true });
    changeFocus(false);

    if (releaseFocusFirst) changeFocus(true);
    else rerender(params);
    expect(resume).not.toHaveBeenCalled();
    advanceFrame(5000);
    expect(result.current.simulationState.currentTick).toBe(1);

    if (releaseFocusFirst) rerender(params);
    else changeFocus(true);
    expect(pause).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
  });

  it('leaves the audio of a manually paused fight alone', () => {
    params = { ...params, autoAdvance: false };
    const pause = vi.spyOn(params.audioEngine, 'pausePlayback');
    const resume = vi.spyOn(params.audioEngine, 'resumePlayback');
    const { rerender } = renderHook(useSimulationWiring, { initialProps: params });

    rerender({ ...params, modalPaused: true });
    rerender(params);

    expect(pause).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('keeps audio paused through a manual pause made under the modal until play resumes', () => {
    const resume = vi.spyOn(params.audioEngine, 'resumePlayback');
    const { result, rerender } = renderHook(useSimulationWiring, { initialProps: params });
    advanceFrame(600);
    rerender({ ...params, modalPaused: true });
    rerender({ ...params, modalPaused: true, autoAdvance: false });
    rerender({ ...params, autoAdvance: false });
    advanceFrame(5000);

    expect(result.current.simulationState.currentTick).toBe(1);
    expect(resume).not.toHaveBeenCalled();
    rerender(params);
    expect(resume).toHaveBeenCalledOnce();
  });

  it('holds replay playback and its audio under the modal without changing playback intent', () => {
    const { result, rerender } = renderHook(useSimulationWiring, { initialProps: params });
    act(() => result.current.fastForwardTicks(3));
    act(() => result.current.replay.controlProps.onEnterReplay());
    act(() => result.current.replay.controlProps.onPlayPause());
    advanceFrame(300);
    const pause = vi.spyOn(params.audioEngine, 'pausePlayback');
    const resume = vi.spyOn(params.audioEngine, 'resumePlayback');

    rerender({ ...params, modalPaused: true });
    advanceFrame(600);
    changeFocus(false);
    changeFocus(true);
    advanceFrame(900);

    expect(result.current.replay.replayFrameStore.getSnapshot().playheadMs).toBe(300);
    expect(result.current.replay.controlProps.isPlaying).toBe(true);
    expect(pause).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
    rerender(params);
    advanceFrame(1200);
    expect(result.current.replay.replayFrameStore.getSnapshot().playheadMs).toBe(600);
    expect(resume).toHaveBeenCalledOnce();
  });

  /** Whether the audio engine is actually paused, which is what keeps sounds from playing under a hold. */
  const playbackPaused = (audio: AudioEngine): boolean => audio['playbackPaused'];

  it('holds audio for an intro that completes under the modal, and resumes it once when the modal closes', () => {
    const pause = vi.spyOn(params.audioEngine, 'pausePlayback');
    const resume = vi.spyOn(params.audioEngine, 'resumePlayback');
    const { result, rerender } = renderHook(useSimulationWiring, { initialProps: params });
    const engine = new SimulationEngine({
      encounter: new YamaEncounter(undefined, 1234),
      combatSeed: 5678,
      startPos: [31, 37],
      enableIntro: true,
    });
    act(() => result.current.setEngine(engine));
    rerender({ ...params, modalPaused: true });
    expect(pause).not.toHaveBeenCalled();

    act(() => result.current.handleIntroComplete());
    expect(pause).toHaveBeenCalledOnce();
    expect(playbackPaused(params.audioEngine)).toBe(true);
    advanceFrame(5000);
    expect(engine.getState().currentTick).toBe(0);

    nowMs = 6000;
    rerender(params);
    advanceFrame(6600);
    expect(engine.getState().currentTick).toBe(1);
    expect(resume).toHaveBeenCalledOnce();
    expect(playbackPaused(params.audioEngine)).toBe(false);
  });

  it('holds audio for a fight a tutorial hold releases under the modal', () => {
    const pause = vi.spyOn(params.audioEngine, 'pausePlayback');
    const resume = vi.spyOn(params.audioEngine, 'resumePlayback');
    const { result, rerender, engine } = renderWithYama();
    advanceFrame(600);
    act(() => result.current.setTutorialPaused(true));
    rerender({ ...params, modalPaused: true });
    expect(pause).not.toHaveBeenCalled();

    act(() => result.current.setTutorialPaused(false));
    expect(pause).toHaveBeenCalledOnce();
    advanceFrame(5000);
    expect(engine.getState().currentTick).toBe(1);
    rerender(params);
    expect(resume).toHaveBeenCalledOnce();
  });

  it('re-applies the audio hold to a fight reset under the modal', () => {
    const resume = vi.spyOn(params.audioEngine, 'resumePlayback');
    const { result, rerender } = renderWithYama();
    advanceFrame(600);
    rerender({ ...params, modalPaused: true });
    expect(playbackPaused(params.audioEngine)).toBe(true);

    act(() => result.current.handleReset());
    expect(playbackPaused(params.audioEngine)).toBe(true);
    rerender(params);
    expect(resume).toHaveBeenCalledOnce();
    expect(playbackPaused(params.audioEngine)).toBe(false);
  });

  describe('for a 3D view that cannot draw', () => {
    type HoldView = {
      result: { current: ReturnType<typeof useSimulationWiring> };
      set: (patch: Partial<WiringParams>) => void;
    };

    /** The wiring with a prop setter that keeps earlier changes, so holds can overlap. */
    function renderComposable(overrides: Partial<WiringParams> = {}) {
      const view = renderWithYama(overrides);
      let props = params;
      const set = (patch: Partial<WiringParams>) => {
        props = { ...props, ...patch };
        view.rerender(props);
      };
      return { ...view, set };
    }

    it.each(
      [
        {
          hold: 'a covering modal',
          on: ({ set }: HoldView) => set({ modalPaused: true }),
          off: ({ set }: HoldView) => set({ modalPaused: false }),
        },
        { hold: 'focus suspension', on: () => changeFocus(false), off: () => changeFocus(true) },
        {
          hold: 'a tutorial hold',
          on: ({ result }: HoldView) => act(() => result.current.setTutorialPaused(true)),
          off: ({ result }: HoldView) => act(() => result.current.setTutorialPaused(false)),
        },
        {
          hold: 'a manual pause',
          on: ({ set }: HoldView) => set({ autoAdvance: false }),
          off: ({ set }: HoldView) => set({ autoAdvance: true }),
        },
      ].flatMap((other) => [true, false].map((releaseGraphicsFirst) => ({ ...other, releaseGraphicsFirst }))),
    )('keeps the fight held until $hold also lifts (graphics released first: $releaseGraphicsFirst)', ({
      on,
      off,
      releaseGraphicsFirst,
    }) => {
      const pause = vi.spyOn(params.audioEngine, 'pausePlayback');
      const resume = vi.spyOn(params.audioEngine, 'resumePlayback');
      const view = renderComposable();
      const { result, engine, set } = view;
      advanceFrame(600);
      expect(engine.getState().currentTick).toBe(1);

      nowMs = 900;
      set({ graphicsHeld: true });
      expect(pause).toHaveBeenCalledOnce();
      nowMs = 1000;
      on(view);
      advanceFrame(3000);
      expect(engine.getState().currentTick).toBe(1);

      nowMs = 5000;
      if (releaseGraphicsFirst) set({ graphicsHeld: false });
      else off(view);
      advanceFrame(10_000);
      expect(engine.getState().currentTick).toBe(1);
      expect(resume).not.toHaveBeenCalled();

      // The tick still has the 300 ms it had when the view went.
      nowMs = 20_000;
      if (releaseGraphicsFirst) off(view);
      else set({ graphicsHeld: false });
      advanceFrame(20_299);
      expect(engine.getState().currentTick).toBe(1);
      advanceFrame(20_300);
      expect(engine.getState().currentTick).toBe(2);
      expect(pause).toHaveBeenCalledOnce();
      expect(resume).toHaveBeenCalledOnce();
      expect(frameTimeline(result)).toEqual([
        [0, undefined],
        [600, undefined],
        [1200, undefined],
      ]);
    });

    it('holds replay playback and its audio, through an overlapping modal, without changing playback intent', () => {
      const { result, rerender } = renderHook(useSimulationWiring, { initialProps: params });
      act(() => result.current.fastForwardTicks(3));
      act(() => result.current.replay.controlProps.onEnterReplay());
      act(() => result.current.replay.controlProps.onPlayPause());
      advanceFrame(300);
      const pause = vi.spyOn(params.audioEngine, 'pausePlayback');
      const resume = vi.spyOn(params.audioEngine, 'resumePlayback');

      rerender({ ...params, graphicsHeld: true });
      advanceFrame(600);
      rerender({ ...params, graphicsHeld: true, modalPaused: true });
      rerender({ ...params, modalPaused: true });
      advanceFrame(900);

      expect(result.current.replay.replayFrameStore.getSnapshot().playheadMs).toBe(300);
      expect(result.current.replay.controlProps.isPlaying).toBe(true);
      expect(pause).toHaveBeenCalledOnce();
      expect(resume).not.toHaveBeenCalled();
      rerender(params);
      advanceFrame(1200);
      expect(result.current.replay.replayFrameStore.getSnapshot().playheadMs).toBe(600);
      expect(resume).toHaveBeenCalledOnce();
    });

    it('refuses practice from the replay until the view is back', () => {
      const reason = 'Restore the 3D view before practicing from this replay.';
      const { result, rerender } = renderHook(useSimulationWiring, {
        initialProps: { ...params, sceneState: { kind: 'encounter', encounterKind: 'yama_p3' } as SceneState },
      });
      act(() => result.current.fastForwardTicks(3));
      act(() => result.current.replay.controlProps.onEnterReplay());

      rerender({ ...params, sceneState: { kind: 'encounter', encounterKind: 'yama_p3' }, graphicsHeld: true });
      expect(result.current.replay.replayPractice.practiceUnavailableReason).toBe(reason);
      expect(result.current.replay.replayPractice.retryUnavailableReason).toBe(reason);
      // A tutorial's own reason, from App, still comes first.
      rerender({ ...params, graphicsHeld: true, replayPracticeUnavailableReason: 'Tutorial active' });
      expect(result.current.replay.replayPractice.practiceUnavailableReason).toBe('Tutorial active');

      rerender({ ...params, sceneState: { kind: 'encounter', encounterKind: 'yama_p3' } });
      expect(result.current.replay.replayPractice.practiceUnavailableReason).not.toBe(reason);
    });

    it('re-applies the hold to a fight reset under it, and starts the new run once the view is back', () => {
      const resume = vi.spyOn(params.audioEngine, 'resumePlayback');
      const { result, rerender, engine } = renderWithYama();
      advanceFrame(600);
      rerender({ ...params, graphicsHeld: true });
      expect(playbackPaused(params.audioEngine)).toBe(true);

      nowMs = 1000;
      act(() => result.current.handleReset());
      expect(playbackPaused(params.audioEngine)).toBe(true);
      advanceFrame(5000);
      expect(engine.getState().currentTick).toBe(0);

      nowMs = 10_000;
      rerender(params);
      expect(resume).toHaveBeenCalledOnce();
      expect(playbackPaused(params.audioEngine)).toBe(false);
      advanceFrame(10_599);
      expect(engine.getState().currentTick).toBe(0);
      advanceFrame(10_600);
      expect(engine.getState().currentTick).toBe(1);
    });

    it('still runs a tutorial setup seek while graphics are held, and keeps automatic ticks held after it', () => {
      const { result, engine } = renderWithYama({ graphicsHeld: true });
      act(() => result.current.fastForwardTicks(5));
      expect(engine.getState().currentTick).toBe(5);

      advanceFrame(600);
      advanceFrame(5000);
      expect(engine.getState().currentTick).toBe(5);
    });
  });

  describe('through the app’s focus muting', () => {
    let audio: UseAudioManagerReturn | undefined;

    afterEach(() => {
      // The app's audio engine is a module singleton: leave it as the next test expects it.
      audio?.eventAudioPlayerRef.current.reset();
      audio?.audioEngine.stopAll();
      audio?.audioEngine.setFocusSuspended(false);
      audio = undefined;
    });

    function renderWithFocusMuting(overrides: Partial<WiringParams>) {
      params = { ...params, ...overrides };
      const view = renderHook(
        (props: WiringParams) => {
          const manager = useAudioManager({
            areaVolume: 1,
            masterVolume: 1,
            sfxVolume: 1,
            muteWhenUnfocused: true,
            tickAudioMetronomeEnabled: false,
            tickAudioMetronomeTock: false,
            tickAudioMetronomeVolume: 1,
          });
          audio = manager;
          return useSimulationWiring({
            ...props,
            audioEngine: manager.audioEngine,
            eventAudioPlayerRef: manager.eventAudioPlayerRef,
            frameSoundTrackerRef: manager.frameSoundTrackerRef,
          });
        },
        { initialProps: params },
      );
      if (!audio) expect.fail('useAudioManager did not render');
      return { ...view, audioEngine: audio.audioEngine };
    }

    it.each(
      [false, true].flatMap((pauseWhenUnfocused) =>
        [true, false].map((releaseFocusFirst) => ({ pauseWhenUnfocused, releaseFocusFirst })),
      ),
    )('keeps the modal’s audio hold through a focus mute (pause when unfocused: $pauseWhenUnfocused, focus released first: $releaseFocusFirst)', ({
      pauseWhenUnfocused,
      releaseFocusFirst,
    }) => {
      const { result, rerender, audioEngine } = renderWithFocusMuting({ pauseWhenUnfocused });
      advanceFrame(600);
      expect(result.current.simulationState.currentTick).toBe(1);
      rerender({ ...params, modalPaused: true });
      expect(playbackPaused(audioEngine)).toBe(true);

      changeFocus(false);
      expect(audioEngine.isFocusSuspended()).toBe(true);
      expect(playbackPaused(audioEngine)).toBe(true);

      if (releaseFocusFirst) {
        changeFocus(true);
        expect(audioEngine.isFocusSuspended()).toBe(false);
        // Still under the modal: nothing may play yet.
        expect(playbackPaused(audioEngine)).toBe(true);
        rerender(params);
      } else {
        rerender(params);
        // Released by the modal; still held only if the simulator pauses while unfocused.
        expect(playbackPaused(audioEngine)).toBe(pauseWhenUnfocused);
        changeFocus(true);
      }
      expect(playbackPaused(audioEngine)).toBe(false);
      expect(audioEngine.isFocusSuspended()).toBe(false);
      advanceFrame(5000);
      expect(result.current.simulationState.currentTick).toBeGreaterThan(1);
    });
  });
});

describe('useSimulationWiring late ticks', () => {
  let nowMs: number;
  let visibility: DocumentVisibilityState;
  let frames: Map<number, FrameRequestCallback>;
  let params: WiringParams;

  beforeEach(() => {
    resetPageActivityForTests();
    nowMs = 0;
    visibility = 'visible';
    frames = new Map();
    let nextId = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    vi.spyOn(document, 'hasFocus').mockImplementation(() => true);
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(++nextId, callback);
      return nextId;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    params = createParams({
      autoAdvance: true,
      isFullyLoaded: true,
      activeMechanicsConfig: { ...DEFAULT_MECHANICS_CONFIG, infiniteHealth: true },
    });
  });

  afterEach(() => params.audioEngine.dispose());

  function advanceFrame(timeMs: number): void {
    nowMs = timeMs;
    const queued = [...frames.values()];
    frames.clear();
    act(() => {
      for (const callback of queued) callback(timeMs);
    });
  }

  function renderWithYama(overrides: Partial<WiringParams> = {}) {
    params = { ...params, ...overrides };
    const view = renderHook(useSimulationWiring, { initialProps: params });
    const engine = new SimulationEngine({
      encounter: new YamaEncounter(undefined, 1234),
      combatSeed: 5678,
      startPos: [31, 37],
    });
    act(() => view.result.current.setEngine(engine));
    return { ...view, engine };
  }

  const recording = (result: { current: ReturnType<typeof useSimulationWiring> }) =>
    result.current.replay.exportReplayData();
  const actionsOn = (result: { current: ReturnType<typeof useSimulationWiring> }, tick: number) =>
    recording(result).frames[tick]?.actions;

  let probeYawDeg = 0;
  /** Where the replay clock stands at `atMs`: the time a viewport sample made then is stamped with. */
  function replayTimeAt(result: { current: ReturnType<typeof useSimulationWiring> }, atMs: number) {
    nowMs = atMs;
    probeYawDeg += 10;
    const viewportState = {
      kind: 'orbit3d',
      pitchDeg: 30,
      yawDeg: probeYawDeg,
      fovScale: 1,
      target: { x: 0, y: 0, z: 0 },
    } as const;
    act(() => result.current.replay.recordViewportSample(atMs, viewportState));
    return recording(result).viewportSamples.at(-1)?.tMs;
  }

  it.each(
    [0.5, 1, 2].flatMap((speedMultiplier) =>
      [0, 20].flatMap((inputLagMs) => [80, 200].map((lateMs) => ({ speedMultiplier, inputLagMs, lateMs }))),
    ),
  )('runs a tick $lateMs ms late as a longer tick at $speedMultiplier x with $inputLagMs ms lag', ({
    speedMultiplier,
    inputLagMs,
    lateMs,
  }) => {
    const intervalMs = 600 / speedMultiplier;
    const lagMs = inputLagMs / speedMultiplier;
    const { result, engine } = renderWithYama({ speedMultiplier, inputLagMs });
    advanceFrame(intervalMs);
    expect(engine.getState().currentTick).toBe(1);
    const ranAtMs = 2 * intervalMs + lateMs;

    // Arrives before the scheduled boundary, and in the late stretch after it: both before the tick ran.
    nowMs = 2 * intervalMs - lagMs - 10;
    act(() => result.current.handlePrayerChange(PrayerType.ProtectMagic));
    nowMs = ranAtMs - lagMs - 10;
    act(() => result.current.handleRunToggle());
    advanceFrame(2 * intervalMs - 1);
    expect(engine.getState().currentTick).toBe(1);
    advanceFrame(ranAtMs);
    expect(engine.getState().currentTick).toBe(2);
    expect(actionsOn(result, 2)?.map((action) => action.type)).toEqual(['protectionPrayer', 'runToggle']);

    // Made once the late tick had run: the next tick, a full interval after the late one ran.
    nowMs = ranAtMs + 5;
    act(() => result.current.handlePrayerChange(PrayerType.ProtectRange));
    advanceFrame(ranAtMs + intervalMs - 1);
    expect(engine.getState().currentTick).toBe(2);
    advanceFrame(ranAtMs + intervalMs);
    expect(engine.getState().currentTick).toBe(3);
    expect(actionsOn(result, 3)).toEqual([{ type: 'protectionPrayer', prayer: PrayerType.ProtectRange }]);

    const recorded = recording(result).frames;
    expect(recorded.map((frame) => frame.startMs)).toEqual([
      0,
      600,
      1200 + lateMs * speedMultiplier,
      1800 + lateMs * speedMultiplier,
    ]);
    expect(recorded[2]?.timing).toEqual({ lateByMs: lateMs, rafGapMs: lateMs + 1, tickWorkMs: 0 });
    expect(recorded[1]?.timing).toBeUndefined();
    expect(recorded[3]?.timing).toBeUndefined();
  });

  it.each([
    0, 20,
  ])('leaves an input arriving exactly when a late tick runs to the next tick with %i ms lag', (inputLagMs) => {
    const { result, engine } = renderWithYama({ inputLagMs });
    advanceFrame(600);
    nowMs = 1289 - inputLagMs;
    act(() => result.current.handlePrayerChange(PrayerType.ProtectMagic));
    nowMs = 1290 - inputLagMs;
    act(() => result.current.handleRunToggle());

    advanceFrame(1290);
    expect(engine.getState().currentTick).toBe(2);
    expect(actionsOn(result, 2)?.map((action) => action.type)).toEqual(['protectionPrayer']);
    advanceFrame(1890);
    expect(actionsOn(result, 3)?.map((action) => action.type)).toEqual(['runToggle']);
  });

  it.each([0, 20])('gives an input a tick subscriber dispatches to the next tick with %i ms lag', (inputLagMs) => {
    const { result, engine } = renderWithYama({ inputLagMs });
    const unsubscribe = tickBus.subscribe((tick) => {
      if (tick === 1) result.current.handlePrayerChange(PrayerType.ProtectMagic);
    });
    try {
      advanceFrame(700);
      expect(engine.getState().currentTick).toBe(1);
      expect(actionsOn(result, 1)).toEqual([]);
      advanceFrame(1300);
      expect(actionsOn(result, 2)?.map((action) => action.type)).toEqual(['protectionPrayer']);
    } finally {
      unsubscribe();
    }
  });

  it('keeps the rest of a tick across a hidden stretch and never counts it as late', () => {
    const { result, engine } = renderWithYama({ inputLagMs: 20 });
    advanceFrame(600);
    nowMs = 900;
    act(() => result.current.handlePrayerChange(PrayerType.ProtectMagic));
    advanceFrame(1000);
    visibility = 'hidden';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    advanceFrame(61_000);
    expect(engine.getState().currentTick).toBe(1);
    visibility = 'visible';
    act(() => document.dispatchEvent(new Event('visibilitychange')));

    advanceFrame(61_199);
    expect(engine.getState().currentTick).toBe(1);
    advanceFrame(61_200);
    expect(engine.getState().currentTick).toBe(2);
    expect(actionsOn(result, 2)?.map((action) => action.type)).toEqual(['protectionPrayer']);
    const tick = recording(result).frames[2];
    expect(tick?.startMs).toBe(1200);
    expect(tick?.timing).toBeUndefined();
  });

  it('keeps the time left in a tick when the speed changes mid-tick', () => {
    const { result, rerender, engine } = renderWithYama();
    advanceFrame(600);
    advanceFrame(900);
    rerender({ ...params, speedMultiplier: 2 });
    expect(replayTimeAt(result, 900)).toBe(900);

    // Half a tick was left: 150 ms at 2x.
    advanceFrame(1049);
    expect(engine.getState().currentTick).toBe(1);
    advanceFrame(1050);
    expect(engine.getState().currentTick).toBe(2);
    expect(recording(result).frames.map((frame) => [frame.startMs, frame.timing])).toEqual([
      [0, undefined],
      [600, undefined],
      [1200, undefined],
    ]);
  });

  /** Each tick's frame lasts its interval plus the lateness recorded for the tick after it. */
  function expectTimelineAgreesWithLateness(result: { current: ReturnType<typeof useSimulationWiring> }) {
    const frames = recording(result).frames;
    for (let index = 2; index < frames.length; index++) {
      const lengthMs = (frames[index]?.startMs ?? 0) - (frames[index - 1]?.startMs ?? 0);
      expect(lengthMs).toBe(600 + (frames[index]?.timing?.lateByMs ?? 0));
    }
  }

  it('starts a full tick when the fight is reset mid-tick, with the recording anchored at the reset', () => {
    const { result, engine } = renderWithYama();
    advanceFrame(600);
    advanceFrame(900);
    act(() => result.current.handleReset());

    advanceFrame(1200);
    expect(engine.getState().currentTick).toBe(0);
    advanceFrame(1499);
    expect(engine.getState().currentTick).toBe(0);
    advanceFrame(1500);
    expect(engine.getState().currentTick).toBe(1);
    expect(recording(result).frames.map((frame) => [frame.startMs, frame.timing])).toEqual([
      [0, undefined],
      [600, undefined],
    ]);
  });

  it('finishes a tick across a manual pause that spans its boundary, and times a late resume truthfully', () => {
    const { result, rerender, engine } = renderWithYama();
    advanceFrame(600);
    advanceFrame(900);
    nowMs = 900;
    rerender({ ...params, autoAdvance: false });
    nowMs = 5000;
    rerender(params);

    // 300 ms were left; the first frame after them comes 100 ms late.
    advanceFrame(5299);
    expect(engine.getState().currentTick).toBe(1);
    advanceFrame(5400);
    expect(engine.getState().currentTick).toBe(2);
    advanceFrame(6000);
    expect(engine.getState().currentTick).toBe(3);
    expect(recording(result).frames.map((frame) => frame.startMs)).toEqual([0, 600, 1300, 1900]);
    expect(recording(result).frames[2]?.timing?.lateByMs).toBe(100);
    expectTimelineAgreesWithLateness(result);
  });

  it('freezes a tick through a tutorial hold that spans its boundary, and times a late resume truthfully', () => {
    const { result, engine } = renderWithYama();
    advanceFrame(600);
    advanceFrame(616);
    // Held at 700, between frames, with 500 ms left; frames keep coming past where it was due.
    nowMs = 700;
    act(() => result.current.setTutorialPaused(true));
    advanceFrame(1200);
    advanceFrame(3000);
    expect(engine.getState().currentTick).toBe(1);
    nowMs = 3100;
    act(() => result.current.setTutorialPaused(false));

    // 500 ms left from the resume at 3100; the first frame after them comes 120 ms late.
    advanceFrame(3599);
    expect(engine.getState().currentTick).toBe(1);
    advanceFrame(3720);
    expect(engine.getState().currentTick).toBe(2);
    expect(recording(result).frames.map((frame) => frame.startMs)).toEqual([0, 600, 1320]);
    expect(recording(result).frames[2]?.timing?.lateByMs).toBe(120);
    expectTimelineAgreesWithLateness(result);
  });

  it('freezes at the tick that a tick subscriber holds, not at the late frame that next sees the hold', () => {
    const { result, engine } = renderWithYama();
    const unsubscribe = tickBus.subscribe((tick) => {
      if (tick === 1) engine.setTutorialPaused(true);
    });
    try {
      advanceFrame(600);
      expect(engine.getState().currentTick).toBe(1);
      // The next frame comes long after the hold began, and frames keep coming while it lasts.
      advanceFrame(1900);
      advanceFrame(4000);
      expect(engine.getState().currentTick).toBe(1);
      expect(replayTimeAt(result, 4500)).toBe(600);
      nowMs = 5000;
      act(() => result.current.setTutorialPaused(false));

      // Resumed at 5000 with the whole tick the hold left: none of the hold counts as lateness.
      advanceFrame(5599);
      expect(engine.getState().currentTick).toBe(1);
      advanceFrame(5600);
      expect(engine.getState().currentTick).toBe(2);
      expect(recording(result).frames.map((frame) => [frame.startMs, frame.timing])).toEqual([
        [0, undefined],
        [600, undefined],
        [1200, undefined],
      ]);
      expectTimelineAgreesWithLateness(result);
    } finally {
      unsubscribe();
    }
  });

  type WiringView = ReturnType<typeof renderWithYama>;
  const setVisibility = (value: DocumentVisibilityState) => {
    visibility = value;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
  };

  // Every way the live tick stops mid-tick. Each pauses at 900 with 300 ms of tick 2 left and
  // resumes at 60 000: the tick finishes 300 ms later, on time, and the replay never sees the gap.
  it.each<{
    path: string;
    overrides?: Partial<WiringParams>;
    pause: (view: WiringView) => void;
    resume: (view: WiringView) => void;
    /** The replay records nothing while it is being viewed, so there is nothing to stamp then. */
    recordsWhilePaused?: false;
  }>([
    { path: 'a hidden tab', pause: () => setVisibility('hidden'), resume: () => setVisibility('visible') },
    {
      path: 'an unfocused window',
      overrides: { pauseWhenUnfocused: true },
      pause: () => act(() => window.dispatchEvent(new Event('blur'))),
      resume: () => act(() => window.dispatchEvent(new Event('focus'))),
    },
    {
      path: 'a manual pause',
      pause: ({ rerender }) => rerender({ ...params, autoAdvance: false }),
      resume: ({ rerender }) => rerender(params),
    },
    {
      path: 'a tutorial hold',
      pause: ({ result }) => act(() => result.current.setTutorialPaused(true)),
      resume: ({ result }) => act(() => result.current.setTutorialPaused(false)),
    },
    {
      path: 'a covering modal',
      pause: ({ rerender }) => rerender({ ...params, modalPaused: true }),
      resume: ({ rerender }) => rerender(params),
    },
    {
      path: 'a 3D view that cannot draw',
      pause: ({ rerender }) => rerender({ ...params, graphicsHeld: true }),
      resume: ({ rerender }) => rerender(params),
    },
    {
      path: 'replay viewing',
      pause: ({ result }) => act(() => result.current.replay.controlProps.onEnterReplay()),
      resume: ({ result }) => act(() => result.current.replay.controlProps.onExitReplay()),
      recordsWhilePaused: false,
    },
  ])('counts none of $path toward the tick, its lateness or replay time', ({
    overrides,
    pause,
    resume,
    recordsWhilePaused,
  }) => {
    const view = renderWithYama(overrides);
    const { result, engine } = view;
    advanceFrame(600);
    advanceFrame(616);
    nowMs = 900;
    pause(view);
    advanceFrame(1900);
    advanceFrame(30_000);
    expect(engine.getState().currentTick).toBe(1);
    if (recordsWhilePaused !== false) expect(replayTimeAt(result, 30_000)).toBe(900);

    nowMs = 60_000;
    resume(view);
    expect(replayTimeAt(result, 60_000)).toBe(900);
    advanceFrame(60_299);
    expect(engine.getState().currentTick).toBe(1);
    advanceFrame(60_300);
    expect(engine.getState().currentTick).toBe(2);
    expect(recording(result).frames.map((frame) => [frame.startMs, frame.timing])).toEqual([
      [0, undefined],
      [600, undefined],
      [1200, undefined],
    ]);
  });

  it('counts none of the landing intro toward the first tick or replay time', () => {
    const { result } = renderHook(useSimulationWiring, { initialProps: params });
    const engine = new SimulationEngine({
      encounter: new YamaEncounter(undefined, 1234),
      combatSeed: 5678,
      startPos: [31, 37],
      enableIntro: true,
    });
    act(() => result.current.setEngine(engine));
    expect(result.current.simulationState.introActive).toBe(true);
    advanceFrame(600);
    advanceFrame(30_000);
    expect(engine.getState().currentTick).toBe(0);
    expect(replayTimeAt(result, 30_000)).toBe(0);

    nowMs = 60_000;
    act(() => result.current.handleIntroComplete());
    advanceFrame(60_599);
    expect(engine.getState().currentTick).toBe(0);
    advanceFrame(60_600);
    expect(engine.getState().currentTick).toBe(1);
    expect(recording(result).frames.map((frame) => [frame.startMs, frame.timing])).toEqual([
      [0, undefined],
      [600, undefined],
    ]);
  });

  it('counts none of the wait for the scene to load toward the first tick or replay time', () => {
    const { result, rerender, engine } = renderWithYama({ isFullyLoaded: false });
    advanceFrame(30_000);
    expect(engine.getState().currentTick).toBe(0);
    expect(replayTimeAt(result, 30_000)).toBe(0);

    nowMs = 60_000;
    rerender({ ...params, isFullyLoaded: true });
    advanceFrame(60_599);
    expect(engine.getState().currentTick).toBe(0);
    advanceFrame(60_600);
    expect(engine.getState().currentTick).toBe(1);
    expect(recording(result).frames.map((frame) => [frame.startMs, frame.timing])).toEqual([
      [0, undefined],
      [600, undefined],
    ]);
  });

  /** The wiring with the viewport's click handling, so a manual step runs its real path. */
  function renderWithViewport(overrides: Partial<WiringParams> = {}) {
    params = { ...params, sceneState: { kind: 'encounter', encounterKind: 'yama_p3' }, ...overrides };
    const view = renderHook(
      (props: WiringParams) => {
        const wiring = useSimulationWiring(props);
        const viewport = useViewportInteraction({
          autoAdvance: props.autoAdvance,
          graphicsHeld: props.graphicsHeld ?? false,
          engineRef: wiring.engineRef,
          dispatchInput: wiring.dispatchInput,
          onEnterEncounter: () => {},
          onSelectLobbyEncounter: () => {},
          replay: wiring.replay,
          getReplayUiState: props.getReplayUiState,
          sceneState: props.sceneState,
          publishEngineState: wiring.publishEngineState,
          setSimulationState: wiring.setSimulationState,
          setTargetTile: wiring.setTargetTile,
          simulationState: wiring.simulationState,
          targetTileRef: wiring.targetTileRef,
          armedSpell: null,
          setArmedSpell: () => {},
          previewTargetTile: wiring.previewTargetTile,
        });
        return { ...wiring, handleTileClick: viewport.handleTileClick };
      },
      { initialProps: params },
    );
    const engine = new SimulationEngine({
      encounter: new YamaEncounter(undefined, 1234),
      combatSeed: 5678,
      startPos: [31, 37],
    });
    act(() => view.result.current.setEngine(engine));
    return { ...view, engine };
  }

  it('counts none of the idle time before the first manual step toward replay time', () => {
    const { result, rerender, engine } = renderWithYama({ autoAdvance: false });
    advanceFrame(30_000);
    expect(replayTimeAt(result, 30_000)).toBe(0);

    nowMs = 60_000;
    rerender({ ...params, autoAdvance: true });
    advanceFrame(60_599);
    expect(engine.getState().currentTick).toBe(0);
    advanceFrame(60_600);
    expect(engine.getState().currentTick).toBe(1);
    expect(recording(result).frames.map((frame) => [frame.startMs, frame.timing])).toEqual([
      [0, undefined],
      [600, undefined],
    ]);
  });

  it('holds replay time at a manual step through a long idle pause, then resumes live from there', () => {
    const { result, rerender, engine } = renderWithViewport({ autoAdvance: false });
    nowMs = 10_000;
    act(() => result.current.handleTileClick([32, 37]));
    expect(engine.getState().currentTick).toBe(1);
    // An input made while idle sits at the step's frame start, before the next frame.
    advanceFrame(40_000);
    expect(replayTimeAt(result, 40_000)).toBe(600);
    expect(replayTimeAt(result, 50_000)).toBe(600);

    nowMs = 60_000;
    rerender({ ...params, autoAdvance: true });
    advanceFrame(60_599);
    expect(engine.getState().currentTick).toBe(1);
    advanceFrame(60_600);
    expect(engine.getState().currentTick).toBe(2);
    expect(recording(result).frames.map((frame) => [frame.startMs, frame.timing])).toEqual([
      [0, undefined],
      [600, undefined],
      [1200, undefined],
    ]);
  });

  it('holds replay time through a tutorial hold that no live tick owns, across the switch to auto-advance', () => {
    const { result, rerender, engine } = renderWithYama({ autoAdvance: false });
    act(() => result.current.fastForwardTicks(1));
    nowMs = 200;
    act(() => result.current.setTutorialPaused(true));
    advanceFrame(10_000);
    expect(replayTimeAt(result, 10_000)).toBe(600);
    rerender({ ...params, autoAdvance: true });
    advanceFrame(30_000);
    expect(replayTimeAt(result, 30_000)).toBe(600);

    nowMs = 60_000;
    act(() => result.current.setTutorialPaused(false));
    advanceFrame(60_599);
    expect(engine.getState().currentTick).toBe(1);
    advanceFrame(60_600);
    expect(engine.getState().currentTick).toBe(2);
    expect(recording(result).frames.map((frame) => [frame.startMs, frame.timing])).toEqual([
      [0, undefined],
      [600, undefined],
      [1200, undefined],
    ]);
  });

  it('holds replay time at a manual step that ends the fight', () => {
    const { result, engine } = renderWithViewport({ autoAdvance: false });
    const canAdvance = engine.canAdvance.bind(engine);
    const advanceTick = engine.advanceTick.bind(engine);
    let over = false;
    vi.spyOn(engine, 'canAdvance').mockImplementation(() => !over && canAdvance());
    vi.spyOn(engine, 'advanceTick').mockImplementation((target) => {
      advanceTick(target);
      over = true;
    });
    nowMs = 1000;
    act(() => result.current.handleTileClick([32, 37]));
    act(() => result.current.handleTileClick([33, 37]));
    expect(engine.getState().currentTick).toBe(1);

    expect(replayTimeAt(result, 50_000)).toBe(600);
    expect(recording(result).frames.map((frame) => frame.startMs)).toEqual([0, 600]);
  });

  it('stops replay time at the tick that ends the fight, not at the late frame that next sees it', () => {
    const { result, engine } = renderWithYama();
    // Stand-in for a death or a kill: the engine refuses to advance once tick 2 has run.
    const canAdvance = engine.canAdvance.bind(engine);
    const advanceTick = engine.advanceTick.bind(engine);
    let over = false;
    vi.spyOn(engine, 'canAdvance').mockImplementation(() => !over && canAdvance());
    vi.spyOn(engine, 'advanceTick').mockImplementation((target) => {
      advanceTick(target);
      over = engine.getState().currentTick >= 2;
    });
    advanceFrame(600);
    advanceFrame(1200);
    expect(engine.getState().currentTick).toBe(2);
    advanceFrame(5000);
    advanceFrame(9000);

    expect(engine.getState().currentTick).toBe(2);
    expect(replayTimeAt(result, 9500)).toBe(1200);
    expect(recording(result).frames.map((frame) => [frame.startMs, frame.timing])).toEqual([
      [0, undefined],
      [600, undefined],
      [1200, undefined],
    ]);
  });

  it('enters Tutorial Mode mid-tick as a fresh, held run with a new recording and the current loadout', () => {
    const { result, engine } = renderWithYama({ inputLagMs: 200 });
    advanceFrame(600);
    advanceFrame(1200);
    expect(engine.getState().currentTick).toBe(2);
    // Still in flight when Tutorial Mode is entered, 300 ms into tick 3.
    nowMs = 1450;
    act(() => result.current.handlePrayerChange(PrayerType.ProtectMagic));
    advanceFrame(1500);

    const equipment = { body: 11832, legs: 11834, boots: 11840 };
    const inventory = createEmptyInventory();
    inventory[0] = { id: 385, quantity: 1 };
    const supplies = createEmptyCombatSupplies();
    const mechanicsConfig = { ...DEFAULT_MECHANICS_CONFIG, infiniteHealth: true };
    act(() => result.current.resetForTutorial({ equipment, inventory, supplies, mechanicsConfig }));

    expect(engine.getState().currentTick).toBe(0);
    expect(engine.isTutorialPaused()).toBe(true);
    expect(engine.getState().playerEquipment).toEqual(equipment);
    expect(engine.getState().inventory).toEqual(inventory);
    expect(result.current.playerInventoryRef.current).not.toBe(inventory);
    const started = recording(result);
    expect(started.frames.map((frame) => frame.state.currentTick)).toEqual([0]);
    expect(started.runConfig?.bootstrap).toMatchObject({ mechanicsConfig: { infiniteHealth: true }, equipment });
    advanceFrame(30_000);
    expect(engine.getState().currentTick).toBe(0);
    expect(replayTimeAt(result, 30_000)).toBe(0);

    // A full tick from the resume: none of the old run's 300 ms remainder carries over.
    nowMs = 60_000;
    act(() => result.current.setTutorialPaused(false));
    advanceFrame(60_300);
    expect(engine.getState().currentTick).toBe(0);
    advanceFrame(60_599);
    expect(engine.getState().currentTick).toBe(0);
    advanceFrame(60_600);
    expect(engine.getState().currentTick).toBe(1);
    expect(engine.getState().activePrayer).toBeNull();
    expect(recording(result).frames.map((frame) => [frame.startMs, frame.timing, frame.actions])).toEqual([
      [0, undefined, []],
      [600, undefined, []],
    ]);
  });

  it('times a replacement engine from its own start, not from the partial tick of the one it replaced', () => {
    const { result, engine } = renderWithYama();
    advanceFrame(600);
    advanceFrame(900);
    const replacement = new SimulationEngine({
      encounter: new YamaEncounter(undefined, 99),
      combatSeed: 7,
      startPos: [31, 37],
    });
    nowMs = 950;
    act(() => result.current.setEngine(replacement));

    advanceFrame(1200);
    expect(engine.getState().currentTick).toBe(1);
    expect(replacement.getState().currentTick).toBe(0);
    advanceFrame(1550);
    expect(replacement.getState().currentTick).toBe(1);
    expect(recording(result).frames.map((frame) => [frame.startMs, frame.timing])).toEqual([
      [0, undefined],
      [600, undefined],
    ]);
  });

  it("does not carry one engine's unfinished tick into another engine", () => {
    const { result, rerender } = renderWithYama();
    advanceFrame(600);
    advanceFrame(900);
    nowMs = 900;
    rerender({ ...params, autoAdvance: false });
    const replacement = new SimulationEngine({
      encounter: new YamaEncounter(undefined, 99),
      combatSeed: 7,
      startPos: [31, 37],
    });
    act(() => result.current.setEngine(replacement));
    nowMs = 5000;
    rerender(params);

    advanceFrame(5300);
    expect(replacement.getState().currentTick).toBe(0);
    advanceFrame(5600);
    expect(replacement.getState().currentTick).toBe(1);
  });

  describe('a walk clicked while the player is busy', () => {
    const START: Coordinate = [31, 37];
    const NORTH: Coordinate = [31, 41];

    /** Yama with the player busy on `ticks`, as Inferno's Zuk intro makes them; a rebuilt engine is too. */
    function busyOn(ticks: readonly number[]) {
      const rules = YamaEncounter.prototype.getEngineRules;
      vi.spyOn(YamaEncounter.prototype, 'getEngineRules').mockImplementation(function (this: YamaEncounter) {
        return { ...rules.call(this), playerInputLocked: (ctx) => ticks.includes(ctx.tick) };
      });
    }
    const position = (result: { current: ReturnType<typeof useSimulationWiring> }) =>
      result.current.engine.getState().playerPosition;
    const marker = (result: { current: ReturnType<typeof useSimulationWiring> }) =>
      result.current.inputPresentation.getTargetTile();

    it('is dropped by the live loop, so the player does not walk once free', () => {
      busyOn([1]);
      const { result } = renderWithViewport();
      nowMs = 100;
      act(() => result.current.handleTileClick(NORTH));
      advanceFrame(600);
      expect(result.current.engine.currentTick).toBe(1);
      expect(marker(result)).toBeNull();
      advanceFrame(1200);
      advanceFrame(1800);
      expect(position(result)).toEqual(START);
    });

    it('is dropped by a manual step, so switching to auto-advance does not walk to it', () => {
      busyOn([1]);
      const { result, rerender } = renderWithViewport({ autoAdvance: false });
      nowMs = 100;
      act(() => result.current.handleTileClick(NORTH));
      expect(result.current.engine.currentTick).toBe(1);
      expect(position(result)).toEqual(START);
      expect(marker(result)).toBeNull();
      expect(result.current.targetTile).toBeNull();

      nowMs = 10_000;
      rerender({ ...params, autoAdvance: true });
      advanceFrame(10_600);
      advanceFrame(11_200);
      expect(result.current.engine.currentTick).toBe(3);
      expect(position(result)).toEqual(START);
    });

    /** Clicks NORTH just before tick 2, plays to tick 3, then takes over tick 3 (restoring tick 2). */
    function takeOverTick3(busyTicks: readonly number[]) {
      busyOn(busyTicks);
      const view = renderWithViewport();
      advanceFrame(600);
      nowMs = 700;
      act(() => view.result.current.handleTileClick(NORTH));
      advanceFrame(1200);
      advanceFrame(1800);
      const recorded = recording(view.result).frames[2];
      expect(recorded?.input).toEqual(NORTH);
      const live = view.result.current.engine;
      act(() => view.result.current.replay.controlProps.onEnterReplay());
      act(() => view.result.current.replay.controlProps.onSeek(3));
      act(() => {
        void view.result.current.replay.controlProps.onTakeOver();
      });
      advanceFrame(1900);
      advanceFrame(1916);
      expect(view.result.current.engine).not.toBe(live);
      expect(view.result.current.simulationState.currentTick).toBe(2);
      return { ...view, anchorPosition: recorded?.state.playerPosition };
    }

    it('is not restored by a takeover from the tick that dropped it', () => {
      const { result, anchorPosition } = takeOverTick3([2]);
      expect(anchorPosition).toEqual(START);
      expect(marker(result)).toBeNull();
      expect(result.current.targetTile).toBeNull();
      advanceFrame(2600);
      advanceFrame(3200);
      expect(result.current.engine.currentTick).toBeGreaterThan(2);
      expect(position(result)).toEqual(START);
    });

    it('is restored by a takeover from a tick that walked it', () => {
      const { result, anchorPosition } = takeOverTick3([]);
      expect(anchorPosition).not.toEqual(START);
      expect(marker(result)).toEqual(NORTH);
      expect(result.current.targetTile).toEqual(NORTH);
      advanceFrame(2600);
      advanceFrame(3200);
      expect(position(result)).toEqual(NORTH);
    });
  });
});

describe('useSimulationWiring start-of-fight countdown', () => {
  let nowMs: number;
  let focused: boolean;
  let frames: Map<number, FrameRequestCallback>;
  let params: WiringParams;

  beforeEach(() => {
    resetPageActivityForTests();
    nowMs = 0;
    focused = true;
    frames = new Map();
    let nextId = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(++nextId, callback);
      return nextId;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    params = createParams({
      autoAdvance: true,
      isFullyLoaded: true,
      pauseWhenUnfocused: true,
      activeMechanicsConfig: { ...DEFAULT_MECHANICS_CONFIG, infiniteHealth: true },
      fightStartCountdownTicks: 3,
      sceneState: { kind: 'encounter', encounterKind: 'yama_p3' },
    });
  });

  afterEach(() => {
    params.audioEngine.dispose();
    resetPageActivityForTests();
  });

  function advanceFrame(timeMs: number): void {
    nowMs = timeMs;
    const queued = [...frames.values()];
    frames.clear();
    act(() => {
      for (const callback of queued) callback(timeMs);
    });
  }

  function changeFocus(value: boolean): void {
    focused = value;
    act(() => window.dispatchEvent(new Event(value ? 'focus' : 'blur')));
  }

  function createYama(enableIntro = false): SimulationEngine {
    return new SimulationEngine({
      encounter: new YamaEncounter(undefined, 1234),
      combatSeed: 5678,
      startPos: [31, 37],
      enableIntro,
    });
  }

  /** A fight already in its encounter scene, so only Restart starts a countdown. */
  function renderInFight(overrides: Partial<WiringParams> = {}, { enableIntro = false } = {}) {
    params = { ...params, ...overrides };
    const view = renderHook(useSimulationWiring, { initialProps: params });
    const engine = createYama(enableIntro);
    act(() => view.result.current.setEngine(engine));
    return { ...view, engine };
  }

  /** Entering Yama from loading, with the scene in React state as App owns it. */
  function renderEntering(overrides: Partial<WiringParams> = {}) {
    params = {
      ...params,
      rendererType: 'webgl',
      sceneState: { kind: 'loading', targetEncounter: 'yama_p3' },
      ...overrides,
    };
    const view = renderHook(
      (props: WiringParams) => {
        const [sceneState, setSceneState] = useState<SceneState>(props.sceneState);
        return { ...useSimulationWiring({ ...props, sceneState, setSceneState }), sceneState };
      },
      { initialProps: params },
    );
    const engine = createYama();
    act(() => view.result.current.setEngine(engine));
    return { ...view, engine };
  }

  type WiringResult = { current: Pick<ReturnType<typeof useSimulationWiring>, 'replay'> };

  function recordPracticeAttempt(view: ReturnType<typeof renderInFight>, start: number, end: number) {
    const { result } = view;
    const settings = params;
    view.rerender({ ...settings, autoAdvance: false, fightStartCountdownTicks: null });
    act(() => result.current.fastForwardTicks(end));
    act(() => result.current.replay.controlProps.onEnterReplay());
    act(() => result.current.replay.controlProps.onSeek(start));
    act(() => {
      void result.current.replay.replayPractice.onStartPractice();
    });
    advanceFrame(0);
    advanceFrame(0);
    // Practicing tick `start` restores the tick before it; the point keeps the chosen label.
    expect(result.current.replay.replayPractice.startTick).toBe(start);
    expect(result.current.simulationState.currentTick).toBe(start - 1);
    view.rerender(settings);
    act(() => result.current.fastForwardTicks(end));
  }

  it('clears only start metadata without pausing or rescheduling the running fight', () => {
    const view = renderInFight({ fightStartCountdownTicks: null });
    const { result } = view;
    recordPracticeAttempt(view, 4, 8);
    const engine = result.current.engine;
    advanceFrame(300);
    const recording = result.current.replay.exportReplayData();
    const pause = vi.spyOn(params.audioEngine, 'pausePlayback');
    act(() => result.current.replay.replayPractice.onClearStart());
    expect(result.current.engine).toBe(engine);
    expect(result.current.replay.replayPractice.startTick).toBeNull();
    expect(result.current.replay.replayPractice.message).toBeNull();
    expect(result.current.replay.replayMode).toBe(false);
    expect(result.current.replay.exportReplayData()).toEqual(recording);
    expect(pause).not.toHaveBeenCalled();
    advanceFrame(599);
    expect(result.current.simulationState.currentTick).toBe(8);
    advanceFrame(600);
    expect(result.current.simulationState.currentTick).toBe(9);
  });

  it.each([
    0.5, 1, 2,
  ])('opens a full restored input interval at GO and applies a post-GO input to the selected tick at %sx', (speedMultiplier) => {
    const view = renderInFight({ inputLagMs: 500, speedMultiplier });
    const { result } = view;
    const goAt = 116 + 1800 / speedMultiplier;
    const boundaryAt = goAt + 600 / speedMultiplier;
    recordPracticeAttempt(view, 4, 8);
    const oldInput = vi.fn();
    act(() => result.current.dispatchInput(oldInput));
    act(() => result.current.replay.replayPractice.onRetry());
    expect(result.current.replay.replayPractice.busy).toBe(true);
    advanceFrame(100);
    expect(result.current.simulationState.currentTick).toBe(8);
    advanceFrame(116);
    expect(result.current.simulationState.currentTick).toBe(3);
    expect(result.current.replay.replayPractice.startTick).toBe(4);
    const restoration = result.current.replay.restoredPresentation;
    expect(restoration).toMatchObject({ engine: result.current.engine, tick: 3, timeMs: 2400 });
    expect(result.current.fightStartCountdown).not.toBeNull();
    advanceFrame(goAt - 1);
    expect(result.current.simulationState.currentTick).toBe(3);
    advanceFrame(goAt);
    expect(result.current.simulationState.currentTick).toBe(3);
    expect(result.current.replay.restoredPresentation).toBe(restoration);
    const runBefore = result.current.engine.getState().isRunEnabled;
    advanceFrame(goAt + 84 / speedMultiplier);
    act(() => result.current.handleRunToggle());
    advanceFrame(boundaryAt - 1);
    expect(result.current.simulationState.currentTick).toBe(3);
    expect(result.current.engine.getState().isRunEnabled).toBe(runBefore);
    advanceFrame(boundaryAt);
    expect(result.current.simulationState.currentTick).toBe(4);
    expect(result.current.engine.getState().isRunEnabled).toBe(!runBefore);
    expect(oldInput).not.toHaveBeenCalled();
    const recording = result.current.replay.exportReplayData();
    expect(recording.frames).toHaveLength(5);
    expect(recording.frames.at(-1)?.state.currentTick).toBe(4);
    expect(recording.frames.at(-1)?.actions).toContainEqual({ type: 'runToggle' });
  });

  it('Retry during the restored countdown discards an input buffered since adoption and restarts the attempt', () => {
    const view = renderInFight({ inputLagMs: 500 });
    const { result } = view;
    recordPracticeAttempt(view, 4, 8);
    act(() => result.current.replay.replayPractice.onRetry());
    advanceFrame(100);
    advanceFrame(116);
    expect(result.current.simulationState.currentTick).toBe(3);
    const adopted = result.current.engine;
    const restoration = result.current.replay.restoredPresentation;
    const countdown = result.current.fightStartCountdown;
    expect(countdown).not.toBeNull();
    // Still on the anchor's tick, but with an input on its way to the engine.
    const buffered = vi.fn();
    act(() => result.current.dispatchInput(buffered));
    act(() => {
      result.current.replay.replayPractice.onRetry();
      result.current.replay.replayPractice.onRetry();
    });
    expect(result.current.replay.replayPractice.busy).toBe(true);
    advanceFrame(200);
    advanceFrame(216);
    expect(result.current.replay.replayPractice.busy).toBe(false);
    expect(result.current.engine).not.toBe(adopted);
    expect(result.current.replay.restoredPresentation).not.toBe(restoration);
    expect(result.current.fightStartCountdown?.key).not.toBe(countdown?.key);
    expect(result.current.simulationState.currentTick).toBe(3);
    advanceFrame(2016);
    advanceFrame(2615);
    expect(result.current.simulationState.currentTick).toBe(3);
    advanceFrame(2616);
    expect(result.current.simulationState.currentTick).toBe(4);
    expect(buffered).not.toHaveBeenCalled();
  });

  it('keeps restored manual play paused without a countdown', () => {
    const view = renderInFight({ autoAdvance: false });
    const { result } = view;
    recordPracticeAttempt(view, 10, 20);
    act(() => result.current.replay.replayPractice.onRetry());
    advanceFrame(100);
    advanceFrame(116);
    expect(result.current.simulationState.currentTick).toBe(9);
    expect(result.current.fightStartCountdown).toBeNull();
    const restoration = result.current.replay.restoredPresentation;
    expect(restoration).toMatchObject({ engine: result.current.engine, tick: 9, timeMs: 6000 });
    act(() => result.current.replay.replayPractice.onClearStart());
    expect(result.current.replay.restoredPresentation).toBe(restoration);
    advanceFrame(5000);
    expect(result.current.simulationState.currentTick).toBe(9);
    expect(result.current.replay.replayPractice.startTick).toBeNull();
    // The first manual step executes the selected tick itself.
    act(() => result.current.fastForwardTicks(10));
    expect(result.current.simulationState.currentTick).toBe(10);
    expect(result.current.replay.exportReplayData().frames).toHaveLength(11);
    expect(result.current.replay.restoredPresentation).toBe(restoration);
  });

  it.each([
    'modal',
    'speed',
    'manual',
  ] as const)('spends a restored mid-fight GO once across a %s schedule restart', (restart) => {
    const view = renderInFight();
    const { result, rerender } = view;
    recordPracticeAttempt(view, 4, 8);
    act(() => result.current.replay.replayPractice.onRetry());
    advanceFrame(100);
    advanceFrame(116);
    advanceFrame(1916);
    expect(result.current.simulationState.currentTick).toBe(3);
    advanceFrame(2216);
    if (restart === 'speed') {
      rerender({ ...params, speedMultiplier: 2 });
      expect(result.current.simulationState.currentTick).toBe(3);
      advanceFrame(2365);
      expect(result.current.simulationState.currentTick).toBe(3);
      advanceFrame(2366);
    } else {
      rerender({ ...params, ...(restart === 'modal' ? { modalPaused: true } : { autoAdvance: false }) });
      advanceFrame(4000);
      rerender(params);
      expect(result.current.simulationState.currentTick).toBe(3);
      advanceFrame(4299);
      expect(result.current.simulationState.currentTick).toBe(3);
      advanceFrame(4300);
    }
    expect(result.current.simulationState.currentTick).toBe(4);
  });

  it('restores without a countdown using the existing full interval from adoption', () => {
    const view = renderInFight({ fightStartCountdownTicks: null });
    const { result } = view;
    recordPracticeAttempt(view, 4, 8);
    act(() => result.current.replay.replayPractice.onRetry());
    advanceFrame(100);
    advanceFrame(116);
    expect(result.current.simulationState.currentTick).toBe(3);
    expect(result.current.fightStartCountdown).toBeNull();
    advanceFrame(715);
    expect(result.current.simulationState.currentTick).toBe(3);
    advanceFrame(716);
    expect(result.current.simulationState.currentTick).toBe(4);
  });

  it('preserves the first restored interval across a focus suspension after GO', () => {
    const view = renderInFight();
    const { result } = view;
    recordPracticeAttempt(view, 4, 8);
    act(() => result.current.replay.replayPractice.onRetry());
    advanceFrame(100);
    advanceFrame(116);
    advanceFrame(1916);
    advanceFrame(2216);
    expect(result.current.simulationState.currentTick).toBe(3);
    changeFocus(false);
    advanceFrame(5000);
    expect(result.current.simulationState.currentTick).toBe(3);
    changeFocus(true);
    advanceFrame(5299);
    expect(result.current.simulationState.currentTick).toBe(3);
    advanceFrame(5300);
    expect(result.current.simulationState.currentTick).toBe(4);
  });

  it('gives restored tick zero a full input interval even after Clear, but preserves fresh immediate GO', () => {
    const view = renderInFight();
    const { result } = view;
    // Practicing tick 1 restores tick 0, the earliest playable anchor.
    recordPracticeAttempt(view, 1, 4);
    act(() => result.current.replay.replayPractice.onRetry());
    advanceFrame(100);
    advanceFrame(116);
    const restoration = result.current.replay.restoredPresentation;
    expect(restoration?.tick).toBe(0);
    act(() => result.current.replay.replayPractice.onClearStart());
    expect(result.current.replay.replayPractice.startTick).toBeNull();
    advanceFrame(1916);
    expect(result.current.simulationState.currentTick).toBe(0);
    advanceFrame(2515);
    expect(result.current.simulationState.currentTick).toBe(0);
    advanceFrame(2516);
    expect(result.current.simulationState.currentTick).toBe(1);
    act(() => result.current.handleReset());
    expect(result.current.replay.restoredPresentation).toBeNull();
    advanceFrame(4316);
    expect(result.current.simulationState.currentTick).toBe(1);
  });

  it('balances audio and the original live tick schedule after failed reconstruction', () => {
    const view = renderInFight({ fightStartCountdownTicks: null });
    const { result } = view;
    recordPracticeAttempt(view, 2, 12);
    const engine = result.current.engine;
    const pause = vi.spyOn(params.audioEngine, 'pausePlayback');
    const resume = vi.spyOn(params.audioEngine, 'resumePlayback');
    vi.spyOn(engineFactory, 'reconstructReplayPrefix').mockImplementation(() => {
      throw new Error('failed rebuild');
    });
    advanceFrame(300);
    act(() => result.current.replay.replayPractice.onRetry());
    expect(pause).toHaveBeenCalledOnce();
    advanceFrame(316);
    advanceFrame(332);
    expect(result.current.engine).toBe(engine);
    expect(result.current.simulationState.currentTick).toBe(12);
    expect(resume).toHaveBeenCalledOnce();
    advanceFrame(631);
    expect(result.current.simulationState.currentTick).toBe(12);
    advanceFrame(632);
    expect(result.current.simulationState.currentTick).toBe(13);
  });

  it('leaves manual stepping audio untouched when restoration fails', () => {
    const view = renderInFight({ autoAdvance: false });
    const { result } = view;
    recordPracticeAttempt(view, 2, 12);
    const engine = result.current.engine;
    const pause = vi.spyOn(params.audioEngine, 'pausePlayback');
    const resume = vi.spyOn(params.audioEngine, 'resumePlayback');
    vi.spyOn(engineFactory, 'reconstructReplayPrefix').mockImplementation(() => {
      throw new Error('failed rebuild');
    });
    act(() => result.current.replay.replayPractice.onRetry());
    advanceFrame(100);
    advanceFrame(116);
    advanceFrame(5000);
    expect(result.current.engine).toBe(engine);
    expect(result.current.simulationState.currentTick).toBe(12);
    expect(pause).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it.each(['modal', 'manual'] as const)('keeps a %s hold when a queued live restore is canceled', (hold) => {
    const view = renderInFight({ fightStartCountdownTicks: null });
    const { result, rerender } = view;
    recordPracticeAttempt(view, 2, 12);
    const engine = result.current.engine;
    const pause = vi.spyOn(params.audioEngine, 'pausePlayback');
    const resume = vi.spyOn(params.audioEngine, 'resumePlayback');
    const reconstruct = vi.spyOn(engineFactory, 'reconstructReplayPrefix');
    act(() => result.current.replay.replayPractice.onRetry());
    rerender({
      ...params,
      replayPracticeUnavailableReason: 'Restore canceled',
      ...(hold === 'modal' ? { modalPaused: true } : { autoAdvance: false }),
    });
    advanceFrame(100);
    advanceFrame(116);
    expect(reconstruct).not.toHaveBeenCalled();
    expect(result.current.engine).toBe(engine);
    expect(result.current.replay.replayPractice.busy).toBe(false);
    expect(pause).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
    advanceFrame(2000);
    expect(result.current.simulationState.currentTick).toBe(12);
    rerender(params);
    expect(resume).toHaveBeenCalledOnce();
    advanceFrame(2600);
    expect(result.current.simulationState.currentTick).toBe(13);
  });

  it('keeps failed replay restoration paused rather than resuming live audio', () => {
    const { result, engine } = renderInFight({ fightStartCountdownTicks: null });
    act(() => result.current.fastForwardTicks(12));
    act(() => result.current.replay.controlProps.onEnterReplay());
    act(() => result.current.replay.controlProps.onSeek(4));
    act(() => result.current.replay.controlProps.onPlayPause());
    vi.spyOn(engineFactory, 'reconstructReplayPrefix').mockImplementation(() => {
      throw new Error('failed rebuild');
    });
    const pause = vi.spyOn(params.audioEngine, 'pausePlayback');
    const resume = vi.spyOn(params.audioEngine, 'resumePlayback');
    act(() => {
      void result.current.replay.controlProps.onTakeOver();
    });
    advanceFrame(100);
    advanceFrame(116);
    expect(result.current.engine).toBe(engine);
    expect(result.current.replay.replayMode).toBe(true);
    expect(result.current.replay.controlProps.isPlaying).toBe(false);
    expect(pause).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
  });

  it('preserves a manual pause made while a restore is queued, then clears the point on an engine replacement', () => {
    const view = renderInFight();
    const { result, rerender } = view;
    recordPracticeAttempt(view, 10, 20);
    act(() => result.current.replay.replayPractice.onRetry());
    rerender({ ...params, autoAdvance: false });
    advanceFrame(100);
    advanceFrame(116);
    expect(result.current.simulationState.currentTick).toBe(9);
    expect(result.current.replay.replayPractice.startTick).toBe(10);
    expect(result.current.fightStartCountdown).toBeNull();
    advanceFrame(5000);
    expect(result.current.simulationState.currentTick).toBe(9);
    act(() => result.current.setEngine(createYama()));
    expect(result.current.replay.replayPractice.startTick).toBeNull();
  });

  it('retains focus holds across a restore and blocks tutorial, loading and decision-modal actions', () => {
    const view = renderInFight();
    const { result, rerender } = view;
    recordPracticeAttempt(view, 10, 20);
    const held = { current: false };
    for (const blocked of [
      { modalPaused: true },
      { graphicsHeld: true },
      { isFullyLoaded: false },
      { replayPracticeUnavailableReason: 'Tutorial active' },
      { replayPracticeHeld: { current: true } },
    ]) {
      rerender({ ...params, ...blocked });
      act(() => {
        void result.current.replay.replayPractice.onStartPractice();
        result.current.replay.replayPractice.onClearStart();
        result.current.replay.replayPractice.onChangeStart();
        result.current.replay.replayPractice.onRetry();
      });
      expect(result.current.simulationState.currentTick).toBe(20);
      expect(result.current.replay.replayPractice.startTick).toBe(10);
      expect(result.current.replay.replayPractice.busy).toBe(false);
    }
    rerender({ ...params, replayPracticeHeld: held });
    changeFocus(false);
    act(() => result.current.replay.replayPractice.onRetry());
    advanceFrame(100);
    advanceFrame(116);
    expect(result.current.simulationState.currentTick).toBe(9);
    expect(result.current.focusPaused).toBe(true);
    expect(result.current.fightStartCountdown).toBeNull();
    advanceFrame(5000);
    expect(result.current.simulationState.currentTick).toBe(9);
    changeFocus(true);
    expect(result.current.fightStartCountdown).not.toBeNull();
  });

  const recording = (result: WiringResult) => result.current.replay.exportReplayData();
  function replayTimeAt(result: WiringResult, atMs: number) {
    nowMs = atMs;
    const viewportState = {
      kind: 'orbit3d',
      pitchDeg: 30,
      yawDeg: atMs,
      fovScale: 1,
      target: { x: 0, y: 0, z: 0 },
    } as const;
    act(() => result.current.replay.recordViewportSample(atMs, viewportState));
    return recording(result).viewportSamples.at(-1)?.tMs;
  }

  it('holds a fight entered from loading until GO, keeping the countdown out of tick timing and replay time', () => {
    const { result, engine } = renderEntering();
    advanceFrame(500);
    nowMs = 1000;
    act(() => result.current.handleSceneReady());
    expect(result.current.sceneState).toEqual({ kind: 'encounter', encounterKind: 'yama_p3' });
    expect(result.current.fightStartPresentation).toBe('entry');
    expect(result.current.fightStartCountdown).toEqual({
      key: expect.any(Number),
      startsAtMs: 1000,
      endsAtMs: 2800,
      releasedAtMs: null,
      tickCount: 3,
      tickMs: 600,
    });

    advanceFrame(1600);
    advanceFrame(2799);
    expect(engine.getState().currentTick).toBe(0);
    expect(replayTimeAt(result, 2799)).toBe(0);

    // GO: the fight is live, and the overlay stays for its exit.
    advanceFrame(2800);
    expect(result.current.fightStartCountdown?.releasedAtMs).toBe(2800);
    expect(result.current.fightStartCountdown).not.toBeNull();
    expect(engine.getState().currentTick).toBe(1);
    expect(recording(result).frames[1]?.timing).toBeUndefined();
    advanceFrame(3399);
    expect(engine.getState().currentTick).toBe(1);
    // The second tick comes 80 ms late: that is all the lateness it records.
    advanceFrame(3480);
    expect(engine.getState().currentTick).toBe(2);
    expect(recording(result).frames[2]?.timing?.lateByMs).toBe(80);
    expect(recording(result).frames.map((frame) => frame.startMs)).toEqual([0, 1, 681]);
  });

  it('re-arms on Restart, starting over from the latest one, and times the run from GO', () => {
    const { result, engine } = renderInFight();
    expect(result.current.fightStartCountdown).toBeNull();
    advanceFrame(600);
    advanceFrame(1200);
    expect(engine.getState().currentTick).toBe(2);

    nowMs = 1500;
    act(() => result.current.handleReset());
    const first = result.current.fightStartCountdown;
    expect(result.current.fightStartPresentation).toBe('restart');
    expect(first).toEqual({
      key: expect.any(Number),
      startsAtMs: 1500,
      endsAtMs: 3300,
      releasedAtMs: null,
      tickCount: 3,
      tickMs: 600,
    });
    nowMs = 2000;
    act(() => result.current.handleReset());
    expect(result.current.fightStartCountdown).toEqual({
      key: expect.any(Number),
      startsAtMs: 2000,
      endsAtMs: 3800,
      releasedAtMs: null,
      tickCount: 3,
      tickMs: 600,
    });
    expect(result.current.fightStartCountdown?.key).not.toBe(first?.key);

    advanceFrame(3799);
    advanceFrame(3800);
    expect(engine.getState().currentTick).toBe(1);
    advanceFrame(4399);
    expect(engine.getState().currentTick).toBe(1);
    advanceFrame(4400);
    expect(engine.getState().currentTick).toBe(2);
    expect(recording(result).frames.map((frame) => frame.startMs)).toEqual([0, 1, 601]);
    expect(
      recording(result)
        .frames.slice(1)
        .map((frame) => frame.timing),
    ).toEqual([undefined, undefined]);
  });

  it('unmounts the overlay once its exit finishes after GO, and not before', () => {
    const { result } = renderInFight();
    nowMs = 1000;
    act(() => result.current.handleReset());
    const key = result.current.fightStartCountdown?.key ?? -1;
    nowMs = 2000;
    act(() => result.current.handleFightStartCountdownFinished(key));
    expect(result.current.fightStartCountdown).not.toBeNull();
    advanceFrame(2800);
    nowMs = 3300;
    act(() => result.current.handleFightStartCountdownFinished(key + 1));
    expect(result.current.fightStartCountdown).not.toBeNull();
    act(() => result.current.handleFightStartCountdownFinished(key));
    expect(result.current.fightStartCountdown).toBeNull();
    expect(result.current.fightStartPresentation).toBe('restart');
  });

  it('changes nothing with the countdown off', () => {
    const entering = renderEntering({ fightStartCountdownTicks: null });
    nowMs = 1000;
    act(() => entering.result.current.handleSceneReady());
    expect(entering.result.current.fightStartCountdown).toBeNull();
    advanceFrame(1599);
    expect(entering.engine.getState().currentTick).toBe(0);
    advanceFrame(1600);
    expect(entering.engine.getState().currentTick).toBe(1);

    nowMs = 1900;
    act(() => entering.result.current.handleReset());
    expect(entering.result.current.fightStartCountdown).toBeNull();
    advanceFrame(2499);
    expect(entering.engine.getState().currentTick).toBe(0);
    advanceFrame(2500);
    expect(entering.engine.getState().currentTick).toBe(1);
  });

  it('keeps entry presentation through modal rearm and overlay finish', () => {
    const { result, rerender } = renderEntering();
    act(() => result.current.handleSceneReady());
    expect(result.current.fightStartPresentation).toBe('entry');
    nowMs = 1000;
    rerender({ ...params, modalPaused: true });
    expect(result.current.fightStartCountdown).toBeNull();
    expect(result.current.fightStartPresentation).toBe('entry');
    nowMs = 2000;
    rerender(params);
    expect(result.current.fightStartPresentation).toBe('entry');
    advanceFrame(3800);
    act(() => result.current.handleFightStartCountdownFinished(result.current.fightStartCountdown?.key ?? -1));
    expect(result.current.fightStartCountdown).toBeNull();
    expect(result.current.fightStartPresentation).toBe('entry');
  });

  it('does not switch presentation for a rejected reset, and clears restart when leaving', () => {
    const { result, rerender } = renderInFight({}, { enableIntro: true });
    expect(result.current.fightStartPresentation).toBe('entry');
    act(() => result.current.handleReset());
    expect(result.current.fightStartCountdown).toBeNull();
    expect(result.current.fightStartPresentation).toBe('entry');
    act(() => result.current.handleIntroComplete());
    act(() => result.current.handleReset());
    const first = result.current.fightStartCountdown;
    expect(result.current.fightStartPresentation).toBe('restart');
    act(() => result.current.handleReset());
    expect(result.current.fightStartCountdown).toEqual(first);
    expect(result.current.fightStartPresentation).toBe('restart');
    rerender({ ...params, sceneState: { kind: 'lobby' } });
    expect(result.current.fightStartPresentation).toBe('entry');
    expect(result.current.fightStartCountdown).toBeNull();
  });

  it('ends a running countdown at once when it is turned off', () => {
    const { result, rerender, engine } = renderInFight();
    nowMs = 1000;
    act(() => result.current.handleReset());
    nowMs = 2000;
    rerender({ ...params, fightStartCountdownTicks: null });
    expect(result.current.fightStartCountdown).toBeNull();
    advanceFrame(2599);
    expect(engine.getState().currentTick).toBe(0);
    advanceFrame(2600);
    expect(engine.getState().currentTick).toBe(1);
  });

  it('never counts down in the lobby or under manual stepping', () => {
    const lobby = renderInFight({ sceneState: { kind: 'lobby' } });
    nowMs = 1000;
    act(() => lobby.result.current.handleReset());
    expect(lobby.result.current.fightStartCountdown).toBeNull();
    cleanup();

    const stepping = renderInFight({ autoAdvance: false });
    act(() => stepping.result.current.handleReset());
    expect(stepping.result.current.fightStartCountdown).toBeNull();
  });

  it('never counts down in replay viewing, and ends one running when viewing starts', () => {
    const { result, engine } = renderInFight();
    advanceFrame(600);
    nowMs = 700;
    act(() => result.current.handleReset());
    advanceFrame(1300);
    expect(engine.getState().currentTick).toBe(0);
    act(() => result.current.replay.controlProps.onEnterReplay());
    expect(result.current.replay.replayMode).toBe(true);
    expect(result.current.fightStartCountdown).toBeNull();
    act(() => result.current.handleReset());
    act(() => result.current.replay.controlProps.onExitReplay());
    expect(result.current.fightStartCountdown).toBeNull();
  });

  it('leaves Tutorial Mode runs to their own holds', () => {
    const { result } = renderInFight();
    nowMs = 1000;
    act(() => result.current.handleReset());
    expect(result.current.fightStartCountdown).not.toBeNull();
    act(() =>
      result.current.resetForTutorial({
        equipment: {},
        inventory: createEmptyInventory(),
        supplies: createEmptyCombatSupplies(),
        mechanicsConfig: { ...DEFAULT_MECHANICS_CONFIG, infiniteHealth: true },
      }),
    );
    expect(result.current.fightStartCountdown).toBeNull();
    act(() => result.current.handleTutorialReset('external-owned'));
    expect(result.current.fightStartCountdown).toBeNull();
  });

  it.each<{
    cover: string;
    pause: (rerender: (props: WiringParams) => void) => void;
    resume: (rerender: (props: WiringParams) => void) => void;
  }>([
    {
      cover: 'a covering modal',
      pause: (rerender) => rerender({ ...params, modalPaused: true }),
      resume: (rerender) => rerender(params),
    },
    {
      cover: 'a 3D view that cannot draw',
      pause: (rerender) => rerender({ ...params, graphicsHeld: true }),
      resume: (rerender) => rerender(params),
    },
    { cover: 'focus suspension', pause: () => changeFocus(false), resume: () => changeFocus(true) },
  ])('starts the countdown over once $cover lifts, never counting behind it', ({ cover, pause, resume }) => {
    const { result, rerender, engine } = renderInFight();
    nowMs = 1000;
    act(() => result.current.handleReset());
    const first = result.current.fightStartCountdown;
    nowMs = 2000;
    pause(rerender);
    expect(result.current.fightStartCountdown).toBeNull();
    expect(result.current.fightStartPresentation).toBe('restart');
    advanceFrame(3800);
    expect(engine.getState().currentTick).toBe(0);

    nowMs = 20_000;
    resume(rerender);
    expect(result.current.fightStartCountdown).toEqual({
      key: expect.any(Number),
      startsAtMs: 20_000,
      endsAtMs: 21_800,
      releasedAtMs: null,
      tickCount: 3,
      tickMs: 600,
    });
    expect(result.current.fightStartPresentation).toBe('restart');
    expect(result.current.fightStartCountdown?.key).not.toBe(first?.key);
    advanceFrame(21_800);
    expect(engine.getState().currentTick).toBe(1);
    expect(prayerFlickTimeline.getSnapshot().window?.startTime).toBe(cover === 'focus suspension' ? 3800 : 21_800);
    advanceFrame(22_399);
    expect(engine.getState().currentTick).toBe(1);
    advanceFrame(22_400);
    expect(engine.getState().currentTick).toBe(2);
    expect(recording(result).frames.map((frame) => frame.startMs)).toEqual([0, 1, 601]);
  });

  it('leaves live audio alone under a modal while the fight is still counting down', () => {
    const pause = vi.spyOn(params.audioEngine, 'pausePlayback');
    const { result, rerender } = renderInFight();
    nowMs = 1000;
    act(() => result.current.handleReset());
    rerender({ ...params, modalPaused: true });
    expect(pause).not.toHaveBeenCalled();
  });

  it.each([0, 100])('gives inputs made during the countdown to the first tick with %i ms lag', (inputLagMs) => {
    const { result, engine } = renderInFight({ inputLagMs });
    nowMs = 1000;
    act(() => result.current.handleReset());
    nowMs = 2000;
    act(() => result.current.handlePrayerChange(PrayerType.ProtectMagic));
    advanceFrame(2600);
    advanceFrame(2800);
    expect(engine.getState().currentTick).toBe(1);
    expect(engine.getState().activePrayer).toBe(PrayerType.ProtectMagic);
    expect(recording(result).frames[1]?.actions.map((action) => action.type)).toEqual(['protectionPrayer']);
  });

  it.each([
    0.5, 1, 2,
  ])('runs GO once, publishes its clocks once, then waits a full interval at %sx', (speedMultiplier) => {
    const { result, engine, rerender } = renderInFight({ speedMultiplier });
    nowMs = 1000;
    act(() => result.current.handleReset());
    const publish = vi.spyOn(tickBus, 'publish');
    const window = vi.spyOn(prayerFlickTimeline, 'recordTickWindow');
    const timing = vi.spyOn(ReplayRecorder.prototype, 'recordFrameTiming');
    const interval = 600 / speedMultiplier;
    const goAtMs = 1000 + 3 * interval;
    advanceFrame(goAtMs - 1);
    expect(engine.currentTick).toBe(0);
    advanceFrame(goAtMs);
    expect(engine.currentTick).toBe(1);
    expect(publish).toHaveBeenCalledExactlyOnceWith(1, expect.any(Array));
    expect(window).toHaveBeenCalledExactlyOnceWith(1, goAtMs, interval);
    expect(timing).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ lateByMs: 0 }));
    expect(frames.size).toBe(1);
    expect(recording(result).frames.map((frame) => frame.startMs)).toEqual([0, 1]);
    nowMs = goAtMs + 100;
    act(() => result.current.handleFightStartCountdownFinished(result.current.fightStartCountdown?.key ?? -1));
    rerender(params);
    expect(engine.currentTick).toBe(1);
    expect(publish).toHaveBeenCalledTimes(1);
    advanceFrame(goAtMs + interval - 1);
    expect(engine.currentTick).toBe(1);
    advanceFrame(goAtMs + interval);
    expect(engine.currentTick).toBe(2);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(recording(result).frames.map((frame) => frame.startMs)).toEqual([0, 1, 601]);
    expect(
      recording(result)
        .frames.slice(1)
        .map((frame) => frame.timing),
    ).toEqual([undefined, undefined]);
    expect(timing).toHaveBeenCalledTimes(2);
    expect(timing).toHaveBeenLastCalledWith(expect.objectContaining({ lateByMs: 0 }));
  });

  it('does not repeat GO after a speed change or overlay finish', () => {
    const { result, engine, rerender } = renderInFight();
    nowMs = 1000;
    act(() => result.current.handleReset());
    advanceFrame(2800);
    const key = result.current.fightStartCountdown?.key ?? -1;
    const liveSnapshot = result.current.fightStartCountdown;
    nowMs = 2900;
    rerender({ ...params, speedMultiplier: 2 });
    expect(result.current.fightStartCountdown).toEqual(liveSnapshot);
    expect(engine.currentTick).toBe(1);
    nowMs = 3000;
    act(() => result.current.handleFightStartCountdownFinished(key));
    expect(engine.currentTick).toBe(1);
    advanceFrame(3149);
    expect(engine.currentTick).toBe(1);
    advanceFrame(3150);
    expect(engine.currentTick).toBe(2);
  });

  it.each([0.5, 2])('restarts a pre-GO speed change with a full three-tick count at %sx', (speedMultiplier) => {
    const { result, engine, rerender } = renderInFight();
    nowMs = 1000;
    act(() => result.current.handleReset());
    const firstKey = result.current.fightStartCountdown?.key;
    nowMs = 2000;
    rerender({ ...params, speedMultiplier });
    const tickMs = 600 / speedMultiplier;
    const deadline = 2000 + 3 * tickMs;
    expect(result.current.fightStartCountdown).toMatchObject({
      startsAtMs: 2000,
      endsAtMs: deadline,
      tickCount: 3,
      tickMs,
      releasedAtMs: null,
    });
    expect(result.current.fightStartCountdown?.key).not.toBe(firstKey);
    advanceFrame(2800);
    expect(engine.currentTick).toBe(0);
    advanceFrame(deadline);
    expect(engine.currentTick).toBe(1);
    advanceFrame(deadline + tickMs - 1);
    expect(engine.currentTick).toBe(1);
    advanceFrame(deadline + tickMs);
    expect(engine.currentTick).toBe(2);
    expect(recording(result).frames.map((frame) => frame.startMs)).toEqual([0, 1, 601]);
  });

  it('keeps the one-shot release under StrictMode effect setup and cleanup', () => {
    const view = renderHook(useSimulationWiring, { initialProps: params, wrapper: StrictMode });
    const engine = createYama();
    act(() => view.result.current.setEngine(engine));
    nowMs = 1000;
    act(() => view.result.current.handleReset());
    advanceFrame(2800);
    expect(engine.currentTick).toBe(1);
    expect(frames.size).toBe(1);
    advanceFrame(3399);
    expect(engine.currentTick).toBe(1);
    advanceFrame(3400);
    expect(engine.currentTick).toBe(2);
  });

  it.each([
    2700, 2750,
  ])('keeps a 100 ms input sent at %i out of GO when it has not arrived strictly before it', (sentAtMs) => {
    const { result, engine } = renderInFight({ inputLagMs: 100 });
    nowMs = 1000;
    act(() => result.current.handleReset());
    nowMs = sentAtMs;
    act(() => result.current.handlePrayerChange(PrayerType.ProtectMagic));
    advanceFrame(2800);
    expect(engine.currentTick).toBe(1);
    expect(engine.activePrayer).toBeNull();
    expect(recording(result).frames[1]?.actions).toEqual([]);
    advanceFrame(3400);
    expect(engine.currentTick).toBe(2);
    expect(engine.activePrayer).toBe(PrayerType.ProtectMagic);
    expect(recording(result).frames[2]?.actions.map((action) => action.type)).toEqual(['protectionPrayer']);
  });

  it('does not spend an old countdown release on a replacement engine', () => {
    const { result, engine } = renderInFight();
    nowMs = 1000;
    act(() => result.current.handleReset());
    const replacement = createYama();
    nowMs = 2000;
    act(() => result.current.setEngine(replacement));
    advanceFrame(2800);
    expect(engine.currentTick).toBe(0);
    expect(replacement.currentTick).toBe(0);
    advanceFrame(3400);
    expect(replacement.currentTick).toBe(1);
  });

  it('cancels a countdown on leaving the encounter without giving the next run a GO tick', () => {
    const { result, engine, rerender } = renderInFight();
    nowMs = 1000;
    act(() => result.current.handleReset());
    nowMs = 2000;
    rerender({ ...params, sceneState: { kind: 'lobby' } });
    expect(result.current.fightStartCountdown).toBeNull();
    advanceFrame(2599);
    expect(engine.currentTick).toBe(0);
    advanceFrame(2600);
    expect(engine.currentTick).toBe(1);
    advanceFrame(2800);
    expect(engine.currentTick).toBe(1);
    advanceFrame(3200);
    expect(engine.currentTick).toBe(2);
  });

  it('reports the countdown phase: holding until GO, released until the overlay finishes, then none', () => {
    const { result, rerender } = renderInFight();
    nowMs = 1000;
    act(() => result.current.handleReset());
    expect(result.current.fightStartCountdownPhase).toBe('holding');
    advanceFrame(2799);
    expect(result.current.fightStartCountdownPhase).toBe('holding');
    advanceFrame(2800);
    expect(result.current.fightStartCountdownPhase).toBe('released');
    const key = result.current.fightStartCountdown?.key ?? -1;
    act(() => result.current.handleFightStartCountdownFinished(key));
    expect(result.current.fightStartCountdownPhase).toBeNull();

    act(() => result.current.handleReset());
    expect(result.current.fightStartCountdownPhase).toBe('holding');
    rerender({ ...params, sceneState: { kind: 'lobby' } });
    expect(result.current.fightStartCountdownPhase).toBeNull();
  });

  it('consumes the release only after a tutorial hold permits the callback to execute', () => {
    const { result, engine } = renderInFight();
    nowMs = 1000;
    act(() => result.current.handleReset());
    act(() => result.current.setTutorialPaused(true));
    advanceFrame(2800);
    expect(engine.currentTick).toBe(0);
    nowMs = 2900;
    act(() => result.current.setTutorialPaused(false));
    advanceFrame(2900);
    expect(engine.currentTick).toBe(1);
    advanceFrame(3499);
    expect(engine.currentTick).toBe(1);
    advanceFrame(3500);
    expect(engine.currentTick).toBe(2);
  });

  it('never uses the synchronous GO path while the document is hidden', () => {
    const { result, engine } = renderInFight({ pauseWhenUnfocused: false });
    nowMs = 1000;
    act(() => result.current.handleReset());
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    advanceFrame(2800);
    expect(result.current.fightStartCountdown?.releasedAtMs).toBe(2800);
    expect(engine.currentTick).toBe(0);
    advanceFrame(2900);
    expect(engine.currentTick).toBe(0);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    advanceFrame(3000);
    expect(engine.currentTick).toBe(1);
    advanceFrame(3599);
    expect(engine.currentTick).toBe(1);
    advanceFrame(3600);
    expect(engine.currentTick).toBe(2);
  });

  it('does not spend an unexecuted hidden release on an engine replacement', () => {
    const { result, engine } = renderInFight();
    nowMs = 1000;
    act(() => result.current.handleReset());
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    advanceFrame(2800);
    expect(engine.currentTick).toBe(0);
    const replacement = createYama();
    nowMs = 2900;
    act(() => result.current.setEngine(replacement));
    nowMs = 3000;
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    advanceFrame(3000);
    expect(engine.currentTick).toBe(0);
    expect(replacement.currentTick).toBe(0);
    advanceFrame(3599);
    expect(replacement.currentTick).toBe(0);
    advanceFrame(3600);
    expect(replacement.currentTick).toBe(1);
    expect(recording(result).frames.map((frame) => frame.startMs)).toEqual([0, 600]);
  });

  it('cancels an unexecuted hidden release when the countdown setting is disabled', () => {
    const { result, engine, rerender } = renderInFight();
    nowMs = 1000;
    act(() => result.current.handleReset());
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    advanceFrame(2800);
    expect(engine.currentTick).toBe(0);
    nowMs = 2900;
    rerender({ ...params, fightStartCountdownTicks: null });
    nowMs = 3000;
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    advanceFrame(3000);
    expect(engine.currentTick).toBe(0);
    advanceFrame(3599);
    expect(engine.currentTick).toBe(0);
    advanceFrame(3600);
    expect(engine.currentTick).toBe(1);
  });

  it('does not carry a canceled GO boundary through manual stepping and back to auto-advance', () => {
    const { result, engine, rerender } = renderInFight();
    nowMs = 1000;
    act(() => result.current.handleReset());
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    advanceFrame(2800);
    expect(engine.currentTick).toBe(0);
    nowMs = 2900;
    rerender({ ...params, autoAdvance: false });
    nowMs = 3000;
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    rerender(params);
    advanceFrame(3000);
    expect(engine.currentTick).toBe(0);
    advanceFrame(3599);
    expect(engine.currentTick).toBe(0);
    advanceFrame(3600);
    expect(engine.currentTick).toBe(1);
  });

  it.each([0, 1])('preserves the existing fast-forward contract for %i stepped ticks while GO is pending', (steps) => {
    const { result, engine } = renderInFight();
    nowMs = 1000;
    act(() => result.current.handleReset());
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    advanceFrame(2800);
    expect(engine.currentTick).toBe(0);
    nowMs = 2900;
    act(() => result.current.fastForwardTicks(steps));
    expect(engine.currentTick).toBe(steps);
    expect(recording(result).frames).toHaveLength(steps + 1);
    nowMs = 3000;
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    advanceFrame(3000);
    // Zero steps leave the genuine pending release intact; an actual step must not get an extra GO tick.
    expect(engine.currentTick).toBe(1);
    advanceFrame(3599);
    expect(engine.currentTick).toBe(1);
    advanceFrame(3600);
    expect(engine.currentTick).toBe(2);
  });

  it('replaces an unexecuted hidden release on Restart rather than starting the newer run early', () => {
    const { result, engine } = renderInFight();
    nowMs = 1000;
    act(() => result.current.handleReset());
    const oldKey = result.current.fightStartCountdown?.key;
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    advanceFrame(2800);
    expect(engine.currentTick).toBe(0);
    nowMs = 2900;
    act(() => result.current.handleReset());
    nowMs = 3000;
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(result.current.fightStartCountdown?.key).not.toBe(oldKey);
    advanceFrame(3000);
    expect(engine.currentTick).toBe(0);
    advanceFrame(4799);
    expect(engine.currentTick).toBe(0);
    advanceFrame(4800);
    expect(engine.currentTick).toBe(1);
  });

  describe('with a landing intro', () => {
    let introRemainingMs: number | null | undefined;

    it('waits for renderer tempo acknowledgement across skipped RAFs and executes GO at the matching intro end', () => {
      let rendererSpeed = 1;
      let remainingAnimMs = 3500;
      const getter = vi.fn((expectedSpeedMultiplier: number) =>
        expectedSpeedMultiplier === rendererSpeed ? remainingAnimMs / rendererSpeed : null,
      );
      const { result, engine, rerender } = renderInFight(
        { getIntroAnimationRemainingMs: getter },
        { enableIntro: true },
      );
      act(() => result.current.handleIntroComplete());
      advanceFrame(600);
      nowMs = 1000;
      act(() => result.current.handleReset());
      const originalKey = result.current.fightStartCountdown?.key;
      expect(result.current.fightStartCountdown).toMatchObject({ endsAtMs: 4500, tickMs: 600 });
      rerender({ ...params, speedMultiplier: 2 });
      for (const frame of [1016, 1032, 1048]) {
        advanceFrame(frame);
        expect(getter).toHaveBeenLastCalledWith(2);
        expect(result.current.fightStartCountdown).toBeNull();
        expect(result.current.fightStartCountdownActive).toBe(true);
        expect(engine.currentTick).toBe(0);
      }
      rendererSpeed = 2;
      remainingAnimMs = (2766 - 1064) * rendererSpeed;
      advanceFrame(1064);
      expect(result.current.fightStartCountdown).toMatchObject({ startsAtMs: 1866, endsAtMs: 2766, tickMs: 300 });
      expect(result.current.fightStartCountdown?.key).not.toBe(originalKey);
      advanceFrame(2765);
      expect(engine.currentTick).toBe(0);
      nowMs = 2766;
      act(() => result.current.handleIntroComplete());
      expect(result.current.fightStartCountdown?.releasedAtMs).toBe(2766);
      expect(engine.currentTick).toBe(1);
      advanceFrame(3065);
      expect(engine.currentTick).toBe(1);
      advanceFrame(3066);
      expect(engine.currentTick).toBe(2);
      expect(recording(result).frames.map((frame) => frame.startMs)).toEqual([0, 1, 601]);
    });

    /** Yama after its first intro and a tick, restarted at 1000 into a fresh intro. */
    function restartIntoIntro() {
      introRemainingMs = null;
      const view = renderInFight(
        { getIntroAnimationRemainingMs: (_expectedSpeedMultiplier: number) => introRemainingMs },
        { enableIntro: true },
      );
      act(() => view.result.current.handleIntroComplete());
      advanceFrame(600);
      expect(view.engine.getState().currentTick).toBe(1);
      nowMs = 1000;
      act(() => view.result.current.handleReset());
      expect(view.result.current.simulationState.introActive).toBe(true);
      return view;
    }

    it.each([
      { introMs: 4500, startsAtMs: 3900, endsAtMs: 5700, introEndsAtMs: 5700 },
      { introMs: 3000, startsAtMs: 2400, endsAtMs: 4200, introEndsAtMs: 4200 },
      // Shorter than the countdown: it starts with the intro, and the fight waits for it afterwards.
      { introMs: 1200, startsAtMs: 1200, endsAtMs: 3000, introEndsAtMs: 2400 },
    ])('ends a countdown with a $introMs ms intro at $endsAtMs', ({ introMs, startsAtMs, endsAtMs, introEndsAtMs }) => {
      const { result, engine } = restartIntoIntro();
      // Nothing to show until the intro animation is playing and can say how long it has left.
      expect(result.current.fightStartCountdown).toBeNull();
      advanceFrame(1100);
      expect(result.current.fightStartCountdown).toBeNull();
      introRemainingMs = introMs;
      advanceFrame(1200);
      expect(result.current.fightStartCountdown).toEqual({
        key: expect.any(Number),
        startsAtMs,
        endsAtMs,
        releasedAtMs: null,
        tickCount: 3,
        tickMs: 600,
      });

      advanceFrame(introEndsAtMs - 1);
      expect(engine.getState().currentTick).toBe(0);
      nowMs = introEndsAtMs;
      act(() => result.current.handleIntroComplete());
      if (introEndsAtMs < endsAtMs) {
        expect(result.current.fightStartCountdown?.releasedAtMs).toBeNull();
        expect(engine.getState().currentTick).toBe(0);
        advanceFrame(endsAtMs - 1);
      } else {
        expect(engine.getState().currentTick).toBe(1);
      }
      advanceFrame(endsAtMs);
      expect(result.current.fightStartCountdown?.releasedAtMs).toBe(endsAtMs);
      advanceFrame(endsAtMs + 599);
      expect(engine.getState().currentTick).toBe(1);
      advanceFrame(endsAtMs + 600);
      expect(engine.getState().currentTick).toBe(2);
      expect(recording(result).frames.map((frame) => frame.startMs)).toEqual([0, 1, 601]);
    });

    it('counts down plainly from the restart when no viewport can time the intro', () => {
      const { result } = restartIntoIntro();
      introRemainingMs = undefined;
      advanceFrame(1100);
      expect(result.current.fightStartCountdown).toEqual({
        key: expect.any(Number),
        startsAtMs: 1100,
        endsAtMs: 2900,
        releasedAtMs: null,
        tickCount: 3,
        tickMs: 600,
      });
    });

    it('counts down plainly once the intro ends before it could be timed', () => {
      const { result } = restartIntoIntro();
      nowMs = 1500;
      act(() => result.current.handleIntroComplete());
      expect(result.current.fightStartCountdown).toEqual({
        key: expect.any(Number),
        startsAtMs: 1500,
        endsAtMs: 3300,
        releasedAtMs: null,
        tickCount: 3,
        tickMs: 600,
      });
    });

    it('holds past the predicted end without polling, rejects finish, and releases only on actual intro completion', () => {
      const { result, engine } = restartIntoIntro();
      introRemainingMs = 3000;
      advanceFrame(1200);
      const key = result.current.fightStartCountdown?.key ?? -1;
      advanceFrame(4200);
      expect(result.current.fightStartCountdown?.releasedAtMs).toBeNull();
      expect(frames.size).toBe(0);
      nowMs = 5000;
      act(() => result.current.handleFightStartCountdownFinished(key));
      expect(result.current.fightStartCountdown?.key).toBe(key);
      expect(engine.getState().currentTick).toBe(0);
      expect(replayTimeAt(result, 5000)).toBe(0);
      // Grid's completion signal, not the remaining-time estimate, releases the fight.
      act(() => result.current.handleIntroComplete());
      expect(result.current.fightStartCountdown?.releasedAtMs).toBe(5000);
      expect(engine.getState().currentTick).toBe(1);
      expect(recording(result).frames[1]?.timing).toBeUndefined();
      advanceFrame(5599);
      expect(engine.getState().currentTick).toBe(1);
      advanceFrame(5600);
      expect(engine.getState().currentTick).toBe(2);
      expect(recording(result).frames.map((frame) => frame.startMs)).toEqual([0, 1, 601]);
    });
  });

  describe('with countdown movement', () => {
    const LANDING: Coordinate = [31, 37];
    const NORTH: Coordinate = [31, 41];

    let arena = getArenaConfig();
    let allowUnbounded = false;
    const movementModule = encounterModuleForKind('yama_p3');
    if (!movementModule) throw new Error('missing Yama module');
    beforeEach(() => {
      arena = getArenaConfig();
      allowUnbounded = getArenaAllowUnboundedFallback();
      // Restart lands Yama's player at random: pin it to the tile the first run starts on.
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      // Exercise the shared positioning contract with Yama's intro, NPC targeting and replay
      // fixtures by temporarily opting its module in, as a future encounter could do.
      Object.defineProperty(movementModule, 'countdownMovement', { configurable: true, value: () => true });
    });
    afterEach(() => {
      Reflect.deleteProperty(movementModule, 'countdownMovement');
      clearResolvedArenaConfigs();
      setArenaConfig(arena, allowUnbounded);
    });

    /** The wiring with the viewport's real click handling, in a fight already in its scene. */
    function renderMoving(overrides: Partial<WiringParams> = {}, { enableIntro = false } = {}) {
      params = { ...params, ...overrides };
      const view = renderHook(
        (props: WiringParams) => {
          const wiring = useSimulationWiring(props);
          const viewport = useViewportInteraction({
            autoAdvance: props.autoAdvance,
            graphicsHeld: props.graphicsHeld ?? false,
            engineRef: wiring.engineRef,
            dispatchInput: wiring.dispatchInput,
            onEnterEncounter: () => {},
            onSelectLobbyEncounter: () => {},
            replay: wiring.replay,
            getReplayUiState: props.getReplayUiState,
            sceneState: props.sceneState,
            publishEngineState: wiring.publishEngineState,
            setSimulationState: wiring.setSimulationState,
            setTargetTile: wiring.setTargetTile,
            simulationState: wiring.simulationState,
            targetTileRef: wiring.targetTileRef,
            armedSpell: null,
            setArmedSpell: () => {},
            previewTargetTile: wiring.previewTargetTile,
          });
          return { ...wiring, handleTileClick: viewport.handleTileClick };
        },
        { initialProps: params },
      );
      const engine = createYama(enableIntro);
      act(() => view.result.current.setEngine(engine));
      return { ...view, engine };
    }

    type MovingResult = ReturnType<typeof renderMoving>['result'];
    const position = (result: MovingResult) => result.current.engine.getState().playerPosition;
    const preparation = (result: MovingResult) => result.current.inputPresentation.getStartPositionPreparation();
    function clickAt(result: MovingResult, atMs: number, tile: Coordinate, ctrlKey = false, npc?: string) {
      nowMs = atMs;
      act(() => result.current.handleTileClick(tile, ctrlKey, npc));
    }
    /** Restart at 1000: a 3-tick countdown 1000..2800, stepping at 1600 and 2200. */
    function restartAt1000(result: MovingResult) {
      nowMs = 1000;
      act(() => result.current.handleReset());
      expect(position(result)).toEqual(LANDING);
    }

    it.each([
      0, 100,
    ])('walks to a ground click at each countdown interval with %i ms lag, then starts the run there', (inputLagMs) => {
      const { result } = renderMoving({ inputLagMs });
      restartAt1000(result);
      const publish = vi.spyOn(tickBus, 'publish');
      const window = vi.spyOn(prayerFlickTimeline, 'recordTickWindow');
      const recordFrame = vi.spyOn(ReplayRecorder.prototype, 'recordFrame');
      const timing = vi.spyOn(ReplayRecorder.prototype, 'recordFrameTiming');
      clickAt(result, 1100, NORTH);
      advanceFrame(1599);
      expect(position(result)).toEqual(LANDING);
      advanceFrame(1600);
      expect(position(result)).toEqual([31, 39]);
      expect(result.current.simulationState.playerPosition).toEqual([31, 39]);
      expect(preparation(result)).toMatchObject({
        sequence: 1,
        steppedAtMs: 1600,
        step: { from: LANDING, to: [31, 39], isRunning: true },
      });
      advanceFrame(2200);
      expect(position(result)).toEqual(NORTH);
      expect(preparation(result)?.sequence).toBe(2);
      advanceFrame(2799);
      expect(result.current.engine.currentTick).toBe(0);
      expect(result.current.simulationState.currentTick).toBe(0);
      for (const spy of [publish, window, recordFrame, timing]) expect(spy).not.toHaveBeenCalled();

      advanceFrame(2800);
      expect(result.current.engine.currentTick).toBe(1);
      expect(position(result)).toEqual(NORTH);
      expect(preparation(result)).toBeNull();
      expect(publish).toHaveBeenCalledExactlyOnceWith(1, expect.any(Array));
      expect(window).toHaveBeenCalledExactlyOnceWith(1, 2800, 600);
      expect(recordFrame).toHaveBeenCalledOnce();
      const recorded = recording(result);
      expect(recorded.runConfig?.bootstrap?.startPosition).toEqual(NORTH);
      expect(recorded.frames.map((frame) => frame.state.playerPosition)).toEqual([NORTH, NORTH]);
      expect(recorded.frames[0]?.state.introActive).toBe(false);
      expect(recorded.frames[0]?.actions).toEqual([]);
      expect(recorded.frames[1]?.actions.map((action) => action.type)).toEqual(['ctrlClick', 'attackTarget']);
      expect(recorded.frames.map((frame) => frame.startMs)).toEqual([0, 1]);
      advanceFrame(3399);
      expect(result.current.engine.currentTick).toBe(1);
      advanceFrame(3400);
      expect(result.current.engine.currentTick).toBe(2);
    });

    it('keeps a click that has not arrived by a boundary for the next one, and takes no extra step at GO', () => {
      const { result } = renderMoving({ inputLagMs: 100 });
      restartAt1000(result);
      clickAt(result, 1550, NORTH);
      advanceFrame(1600);
      expect(position(result)).toEqual(LANDING);
      advanceFrame(2200);
      expect(position(result)).toEqual([31, 39]);
      // GO commits [31, 39]; tick 1 then takes the ordinary step from there.
      advanceFrame(2800);
      const recorded = recording(result);
      expect(recorded.runConfig?.bootstrap?.startPosition).toEqual([31, 39]);
      expect(recorded.frames.map((frame) => frame.state.playerPosition)).toEqual([
        [31, 39],
        [31, 41],
      ]);
    });

    it.each([0, 100])('still gives other inputs to the first tick with %i ms lag', (inputLagMs) => {
      const { result } = renderMoving({ inputLagMs });
      restartAt1000(result);
      clickAt(result, 1100, NORTH);
      advanceFrame(1600);
      nowMs = 2000;
      act(() => result.current.handlePrayerChange(PrayerType.ProtectMagic));
      advanceFrame(2200);
      expect(position(result)).toEqual(NORTH);
      expect(result.current.engine.activePrayer).toBeNull();
      advanceFrame(2600);
      advanceFrame(2800);
      expect(result.current.engine.currentTick).toBe(1);
      expect(result.current.engine.activePrayer).toBe(PrayerType.ProtectMagic);
      expect(recording(result).frames[1]?.actions.map((action) => action.type)).toEqual([
        'ctrlClick',
        'attackTarget',
        'protectionPrayer',
      ]);
    });

    it('follows the latest click, keeps every click in order for tick 1, and never chases an NPC', () => {
      const { result } = renderMoving();
      restartAt1000(result);
      clickAt(result, 1100, NORTH);
      advanceFrame(1600);
      expect(position(result)).toEqual([31, 39]);
      clickAt(result, 1700, LANDING, true);
      advanceFrame(2200);
      // Ctrl walks one tile back toward the landing.
      expect(position(result)).toEqual([31, 38]);
      clickAt(result, 2300, NORTH, false, 'yama');
      advanceFrame(2799);
      expect(position(result)).toEqual([31, 38]);
      expect(result.current.engine.getState().attackTarget).toBeNull();
      advanceFrame(2800);
      expect(result.current.engine.getState().attackTarget).toBe('yama');
      expect(recording(result).frames[0]?.state.playerPosition).toEqual([31, 38]);
      expect(recording(result).frames[1]?.actions).toEqual([
        { type: 'ctrlClick', ctrlKey: false },
        { type: 'attackTarget', targetId: null },
        { type: 'ctrlClick', ctrlKey: true },
        { type: 'attackTarget', targetId: null },
        { type: 'ctrlClick', ctrlKey: false },
        { type: 'attackTarget', targetId: 'yama' },
      ]);
    });

    it.each([0.5, 2])('steps on the countdown interval at %sx', (speedMultiplier) => {
      const { result } = renderMoving({ speedMultiplier });
      restartAt1000(result);
      const interval = 600 / speedMultiplier;
      clickAt(result, 1001, NORTH);
      advanceFrame(1000 + interval - 1);
      expect(position(result)).toEqual(LANDING);
      advanceFrame(1000 + interval);
      expect(position(result)).toEqual([31, 39]);
      advanceFrame(1000 + 2 * interval);
      expect(position(result)).toEqual(NORTH);
      advanceFrame(1000 + 3 * interval);
      expect(result.current.engine.currentTick).toBe(1);
    });

    it('takes one step for a late frame, never catching up the boundaries it missed', () => {
      const { result } = renderMoving();
      restartAt1000(result);
      clickAt(result, 1100, NORTH);
      advanceFrame(2300);
      expect(position(result)).toEqual([31, 39]);
      expect(preparation(result)?.sequence).toBe(1);
      advanceFrame(2799);
      expect(position(result)).toEqual([31, 39]);
      advanceFrame(2800);
      expect(recording(result).frames[0]?.state.playerPosition).toEqual([31, 39]);
    });

    it.each<{
      cover: string;
      pause: (rerender: (props: WiringParams) => void) => void;
      resume: (rerender: (props: WiringParams) => void) => void;
    }>([
      {
        cover: 'a covering modal',
        pause: (rerender) => rerender({ ...params, modalPaused: true }),
        resume: (rerender) => rerender(params),
      },
      {
        cover: 'a 3D view that cannot draw',
        pause: (rerender) => rerender({ ...params, graphicsHeld: true }),
        resume: (rerender) => rerender(params),
      },
      { cover: 'focus suspension', pause: () => changeFocus(false), resume: () => changeFocus(true) },
    ])('freezes under $cover, keeps the tile, and restarts the cadence with the countdown', ({ pause, resume }) => {
      const { result, rerender } = renderMoving();
      restartAt1000(result);
      clickAt(result, 1100, [31, 43]);
      advanceFrame(1600);
      expect(position(result)).toEqual([31, 39]);
      nowMs = 1700;
      pause(rerender);
      advanceFrame(2200);
      advanceFrame(4000);
      expect(position(result)).toEqual([31, 39]);
      nowMs = 5000;
      resume(rerender);
      expect(result.current.fightStartCountdown).toMatchObject({ startsAtMs: 5000, endsAtMs: 6800 });
      advanceFrame(5599);
      expect(position(result)).toEqual([31, 39]);
      advanceFrame(5600);
      expect(position(result)).toEqual([31, 41]);
      advanceFrame(6200);
      expect(position(result)).toEqual([31, 43]);
      advanceFrame(6800);
      expect(result.current.engine.currentTick).toBe(1);
      expect(recording(result).frames[0]?.state.playerPosition).toEqual([31, 43]);
    });

    it('does not step while the document is hidden', () => {
      const { result } = renderMoving({ pauseWhenUnfocused: false });
      restartAt1000(result);
      clickAt(result, 1100, NORTH);
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      advanceFrame(1600);
      advanceFrame(2000);
      expect(position(result)).toEqual(LANDING);
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      advanceFrame(2100);
      expect(position(result)).toEqual([31, 39]);
      advanceFrame(2200);
      expect(position(result)).toEqual(NORTH);
    });

    it('counts down only after the landing intro, and walks once it has', () => {
      const { result } = renderMoving({ getIntroAnimationRemainingMs: () => 3000 }, { enableIntro: true });
      act(() => result.current.handleIntroComplete());
      advanceFrame(600);
      nowMs = 1000;
      act(() => result.current.handleReset());
      expect(result.current.simulationState.introActive).toBe(true);
      clickAt(result, 1100, NORTH);
      advanceFrame(1600);
      advanceFrame(2200);
      expect(result.current.fightStartCountdown).toBeNull();
      expect(result.current.fightStartCountdownActive).toBe(true);
      expect(position(result)).toEqual(LANDING);
      nowMs = 3000;
      act(() => result.current.handleIntroComplete());
      expect(result.current.fightStartCountdown).toMatchObject({ startsAtMs: 3000, endsAtMs: 4800 });
      advanceFrame(3599);
      expect(position(result)).toEqual(LANDING);
      advanceFrame(3600);
      expect(position(result)).toEqual([31, 39]);
      advanceFrame(4800);
      expect(result.current.engine.currentTick).toBe(1);
      const recorded = recording(result);
      expect(recorded.frames[0]?.state).toMatchObject({ introActive: false, playerPosition: NORTH });
      expect(recorded.runConfig?.bootstrap?.startPosition).toEqual(NORTH);
    });

    it('drops the old countdown on Restart, so its boundaries never step the new run', () => {
      const { result } = renderMoving();
      restartAt1000(result);
      clickAt(result, 1100, NORTH);
      advanceFrame(1600);
      expect(position(result)).toEqual([31, 39]);
      nowMs = 1700;
      act(() => result.current.handleReset());
      expect(position(result)).toEqual(LANDING);
      expect(preparation(result)).toBeNull();
      clickAt(result, 1800, NORTH);
      advanceFrame(2200);
      expect(position(result)).toEqual(LANDING);
      advanceFrame(2300);
      expect(position(result)).toEqual([31, 39]);
      expect(preparation(result)?.sequence).toBe(1);
    });

    it.each([
      { change: 'the countdown turned off', props: { fightStartCountdownTicks: null } },
      { change: 'manual stepping', props: { autoAdvance: false } },
    ])('commits the chosen tile once when $change ends the countdown', ({ props }) => {
      const finalize = vi.spyOn(SimulationEngine.prototype, 'finalizeStartPosition');
      const { result, rerender } = renderMoving();
      restartAt1000(result);
      clickAt(result, 1100, NORTH);
      advanceFrame(1600);
      nowMs = 1700;
      rerender({ ...params, ...props });
      expect(finalize).toHaveBeenCalledOnce();
      expect(preparation(result)).toBeNull();
      expect(recording(result).runConfig?.bootstrap?.startPosition).toEqual([31, 39]);
      expect(recording(result).frames[0]?.state.playerPosition).toEqual([31, 39]);
      advanceFrame(2200);
      advanceFrame(2800);
      expect(finalize).toHaveBeenCalledOnce();
      expect(recording(result).frames[0]?.state.playerPosition).toEqual([31, 39]);
    });

    it('cancels without committing when the run is left', () => {
      const finalize = vi.spyOn(SimulationEngine.prototype, 'finalizeStartPosition');
      const { result, rerender } = renderMoving();
      restartAt1000(result);
      clickAt(result, 1100, NORTH);
      advanceFrame(1600);
      rerender({ ...params, sceneState: { kind: 'lobby' } });
      expect(preparation(result)).toBeNull();
      advanceFrame(2200);
      advanceFrame(2800);
      expect(finalize).not.toHaveBeenCalled();
      expect(recording(result).frames[0]?.state.playerPosition).toEqual(LANDING);
    });

    it('commits on entering replay, so the recording and the resumed live run both start at the tile', () => {
      const { result } = renderMoving();
      restartAt1000(result);
      clickAt(result, 1100, NORTH);
      advanceFrame(1600);
      act(() => result.current.replay.controlProps.onEnterReplay());
      expect(result.current.replay.replayMode).toBe(true);
      expect(result.current.replay.displayState.playerPosition).toEqual([31, 39]);
      expect(recording(result).runConfig?.bootstrap?.startPosition).toEqual([31, 39]);
      advanceFrame(2200);
      expect(position(result)).toEqual([31, 39]);
      nowMs = 3000;
      act(() => result.current.replay.controlProps.onExitReplay());
      advanceFrame(3600);
      expect(result.current.engine.currentTick).toBe(1);
      expect(recording(result).frames.map((frame) => frame.state.playerPosition)).toEqual([
        [31, 39],
        [31, 41],
      ]);
    });

    itWithArena.each([
      // Retry on wave 1 opens on the landing tile (30,32); Go to wave 30 on the start tile (34,44).
      // Retry on a custom wave keeps the run seed, so wave 1 here carries a layout for it.
      {
        command: { encounter: 'inferno', type: 'retry-wave' } as const,
        keepsSeed: true,
        wave: '1',
        layout: '1:b--------',
        walkTo: [30, 36] as Coordinate,
      },
      {
        command: { encounter: 'inferno', type: 'retry-wave' } as const,
        keepsSeed: false,
        wave: '1',
        layout: '',
        walkTo: [30, 36] as Coordinate,
      },
      // Lock layout keeps the run seed on a random wave too.
      {
        command: { encounter: 'inferno', type: 'keep-spawns' } as const,
        keepsSeed: true,
        wave: '1',
        layout: '',
        walkTo: [30, 36] as Coordinate,
      },
      {
        command: { encounter: 'inferno', type: 'go-to-wave', wave: 30 } as const,
        keepsSeed: false,
        wave: '30',
        layout: '',
        walkTo: [30, 44] as Coordinate,
      },
    ])(
      'positions an encounter fresh restart ($command.type, layout "$layout"), keeping its seeds and run setup',
      ({ command, keepsSeed, wave, layout, walkTo }) => {
        setResolvedArenaConfig('inferno', loadInfernoArena());
        // Wave 1 named: the default start is wave 69.
        const saved = { ...params.activeMechanicsConfig, infernoStartWave: '1', [INFERNO_SPAWN_LAYOUT_KEY]: layout };
        const view = renderMoving({
          activeMechanicsConfig: saved,
          sceneState: { kind: 'encounter', encounterKind: 'inferno' },
        });
        const inferno = new SimulationEngine({ encounter: new InfernoEncounter(99), combatSeed: 5678 });
        inferno.setMechanicsConfig(saved);
        act(() => view.result.current.setEngine(inferno));
        const { result } = view;
        nowMs = 1000;
        vi.mocked(Math.random).mockReturnValue(0.25);
        act(() => {
          result.current.handleExecuteEncounterCommand(command);
        });
        expect(result.current.fightStartCountdown).toMatchObject({ startsAtMs: 1000, endsAtMs: 2800 });
        const opening = recording(result).runConfig;
        clickAt(result, 1100, walkTo);
        advanceFrame(1600);
        // A setting sync at tick 0 re-applies the saved setup; the restart keeps its own wave.
        view.rerender({ ...params, activeMechanicsConfig: { ...saved, infernoStartWave: '62' } });
        advanceFrame(2200);
        expect(position(result)).toEqual(walkTo);
        advanceFrame(2800);
        const recorded = recording(result).runConfig;
        expect(recorded).toEqual({ ...opening, bootstrap: { ...opening?.bootstrap, startPosition: walkTo } });
        expect(recorded?.bootstrap?.mechanicsConfig.infernoStartWave).toBe(wave);
        // Retry on a custom wave keeps the run seed (its spawns) under a fresh attempt seed (the
        // monsters' rolls); on a random wave, like Go, it draws a new run seed.
        expect(recorded?.encounter.seeds).toEqual(
          keepsSeed ? { runSeed: 99, attemptSeed: 0x40000000 } : { runSeed: 0x40000000 },
        );
        expect((inferno.getEncounterSnapshot() as InfernoSnapshot).state).toMatchObject({ wave: Number(wave) });
      },
    );

    itWithArena.each([
      {
        label: 'Retry Wave',
        restart: (result: MovingResult) =>
          result.current.handleExecuteEncounterCommand({ encounter: 'inferno', type: 'retry-wave' }),
      },
      { label: 'Restart fight', restart: (result: MovingResult) => result.current.handleReset() },
    ])('starts an Inferno $label where the player stood, through its countdown and tick-zero sync', ({ restart }) => {
      setResolvedArenaConfig('inferno', loadInfernoArena());
      const saved = { ...params.activeMechanicsConfig, infiniteHealth: true, infernoStartWave: '30' };
      const view = renderMoving({
        activeMechanicsConfig: saved,
        sceneState: { kind: 'encounter', encounterKind: 'inferno' },
      });
      const inferno = new SimulationEngine({ encounter: new InfernoEncounter(99), combatSeed: 5678 });
      inferno.setMechanicsConfig(saved);
      act(() => view.result.current.setEngine(inferno));
      const { result } = view;
      act(() => result.current.fastForwardTicks(11));
      const player = (Reflect.get(inferno, 'worldState') as WorldState).getPlayer();
      if (!player) throw new Error('missing player');
      player.position = [30, 36];
      nowMs = 1000;
      act(() => {
        restart(result);
      });
      expect(result.current.fightStartCountdown).toMatchObject({ startsAtMs: 1000, endsAtMs: 2800 });
      expect(position(result)).toEqual([30, 36]);
      advanceFrame(1600);
      // A setting sync at tick 0 re-applies the saved setup.
      view.rerender({ ...params, activeMechanicsConfig: { ...saved } });
      advanceFrame(2200);
      advanceFrame(2800);
      expect(inferno.currentTick).toBe(1);
      expect(position(result)).toEqual([30, 36]);
      expect(recording(result).runConfig?.bootstrap?.startPosition).toEqual([30, 36]);
      expect((inferno.getEncounterSnapshot() as InfernoSnapshot).state).toMatchObject({ wave: 30 });
    });

    itWithArena(
      'holds the fight under an open encounter tool, and counts its started wave down only once it closes',
      () => {
        // App holds the fight under an open encounter tool (Edit layout) through `modalPaused`.
        setResolvedArenaConfig('inferno', loadInfernoArena());
        const saved = { ...params.activeMechanicsConfig, infiniteHealth: true, infernoStartWave: '30' };
        const view = renderMoving({
          activeMechanicsConfig: saved,
          sceneState: { kind: 'encounter', encounterKind: 'inferno' },
        });
        const inferno = new SimulationEngine({ encounter: new InfernoEncounter(99), combatSeed: 5678 });
        inferno.setMechanicsConfig(saved);
        act(() => view.result.current.setEngine(inferno));
        const { result } = view;
        advanceFrame(600);
        expect(inferno.currentTick).toBe(1);
        const toolOpen = { ...params, modalPaused: true };

        // Open: the fight stops, and a pause and unpause of the player's own leaves it held.
        nowMs = 900;
        view.rerender(toolOpen);
        advanceFrame(5000);
        view.rerender({ ...toolOpen, autoAdvance: false });
        view.rerender(toolOpen);
        advanceFrame(6000);
        expect(inferno.currentTick).toBe(1);

        // Start wave 40: the restart happens under the hold, and its countdown waits for the close.
        nowMs = 7000;
        act(() => {
          result.current.handleExecuteEncounterCommand({ encounter: 'inferno', type: 'go-to-wave', wave: 40 });
        });
        expect(inferno.currentTick).toBe(0);
        advanceFrame(9000);
        expect(inferno.currentTick).toBe(0);
        nowMs = 10_000;
        view.rerender(params);
        expect(result.current.fightStartCountdown).toMatchObject({ startsAtMs: 10_000, endsAtMs: 11_800 });
        advanceFrame(10_600);
        advanceFrame(11_200);
        advanceFrame(11_799);
        expect(inferno.currentTick).toBe(0);
        advanceFrame(11_800);
        expect(inferno.currentTick).toBe(1);
        expect((inferno.getEncounterSnapshot() as InfernoSnapshot).state).toMatchObject({ wave: 40 });

        // A pause the player made before opening the tool outlasts its close.
        view.rerender({ ...params, autoAdvance: false });
        view.rerender({ ...toolOpen, autoAdvance: false });
        view.rerender({ ...params, autoAdvance: false });
        advanceFrame(20_000);
        expect(inferno.currentTick).toBe(1);
      },
    );

    itWithArena.each([
      { label: 'an ordinary wave', startWave: '30', target: [30, 36] as Coordinate, start: [30, 36] as Coordinate },
      { label: 'wave 69', startWave: '69', target: [31, 40] as Coordinate, start: [31, 44] as Coordinate },
    ])(
      'the Inferno allows countdown movement on ordinary waves but not Zuk ($label)',
      ({ startWave, target, start }) => {
        setResolvedArenaConfig('inferno', loadInfernoArena());
        const saved = { ...params.activeMechanicsConfig, infiniteHealth: true, infernoStartWave: startWave };
        const view = renderMoving({
          activeMechanicsConfig: saved,
          sceneState: { kind: 'encounter', encounterKind: 'inferno' },
        });
        // Opened on wave 1's landing tile, which an ordinary wave set at tick 0 keeps (the default
        // start, wave 69, would move it to the practice start tile).
        const inferno = new SimulationEngine({
          encounter: new InfernoEncounter(99),
          combatSeed: 5678,
          mechanics: { infernoStartWave: '1' },
        });
        inferno.setMechanicsConfig(saved);
        act(() => view.result.current.setEngine(inferno));
        const { result } = view;
        const opening = position(result);
        nowMs = 1000;
        act(() => result.current.handleReset());
        expect(position(result)).toEqual(opening);
        clickAt(result, 1100, target);
        advanceFrame(1600);
        advanceFrame(2200);
        expect(inferno.currentTick).toBe(0);
        expect(position(result)).toEqual(start);
        advanceFrame(2800);
        expect(inferno.currentTick).toBe(1);
        // The recording opens where the countdown left the player; the walk itself is not an input.
        expect(recording(result).runConfig?.bootstrap?.startPosition).toEqual(start);
        expect(recording(result).frames[0]?.state.playerPosition).toEqual(start);
      },
    );

    /** The practice pane saves a typed start wave; the unstarted run takes it up mid-countdown. */
    itWithArena.each([
      { from: '30', to: '69' },
      { from: '69', to: '30' },
    ])('a start wave typed during the countdown ($from to $to) decides the walk from then on', ({ from, to }) => {
      setResolvedArenaConfig('inferno', loadInfernoArena());
      const saved = (wave: string) => ({
        ...params.activeMechanicsConfig,
        infiniteHealth: true,
        infernoStartWave: wave,
      });
      const view = renderMoving({
        activeMechanicsConfig: saved(from),
        sceneState: { kind: 'encounter', encounterKind: 'inferno' },
      });
      const inferno = new SimulationEngine({ encounter: new InfernoEncounter(99), combatSeed: 5678 });
      inferno.setMechanicsConfig(saved(from));
      act(() => view.result.current.setEngine(inferno));
      const { result } = view;
      const ZUK_START: Coordinate = [31, 44];
      // Wave 30 opens on the practice start tile, two north of the north-east pillar.
      const startOf = (wave: string): Coordinate => (wave === '69' ? ZUK_START : [34, 44]);
      const towards = (wave: string): Coordinate => (wave === '69' ? [31, 40] : [34, 46]);
      nowMs = 1000;
      act(() => result.current.handleReset());
      clickAt(result, 1100, towards(from));
      advanceFrame(1600);
      const walkedBefore = from === '30';
      if (walkedBefore) expect(position(result)).not.toEqual(startOf(from));
      else expect(position(result)).toEqual(startOf(from));

      // Typed, not Go: no restart, the same countdown; the run moves to the new stage's start tile.
      nowMs = 1700;
      act(() => view.rerender({ ...params, activeMechanicsConfig: saved(to) }));
      expect((inferno.getEncounterSnapshot() as InfernoSnapshot).state).toMatchObject({ wave: Number(to) });
      expect(inferno.currentTick).toBe(0);
      expect(position(result)).toEqual(startOf(to));
      clickAt(result, 1800, towards(to));
      advanceFrame(2200);
      const walks = to === '30';
      if (walks) expect(position(result)[1]).toBeGreaterThan(startOf(to)[1]);
      else expect(position(result)).toEqual(startOf(to));
      const reached = position(result);
      advanceFrame(2800);
      expect(inferno.currentTick).toBe(1);
      // GO starts the run where the countdown left the player, and records it there.
      expect(recording(result).runConfig?.bootstrap?.startPosition).toEqual(reached);
      expect(recording(result).frames[0]?.state.playerPosition).toEqual(reached);
    });

    itWithArena('lands an Inferno wave-1 run first, then counts down and walks, and says so on the first tick', () => {
      setResolvedArenaConfig('inferno', loadInfernoArena());
      const saved = { ...params.activeMechanicsConfig, infiniteHealth: true, infernoStartWave: '1' };
      const view = renderMoving({
        getIntroAnimationRemainingMs: () => 3000,
        activeMechanicsConfig: saved,
        sceneState: { kind: 'encounter', encounterKind: 'inferno' },
      });
      const inferno = new SimulationEngine({
        encounter: new InfernoEncounter(99),
        combatSeed: 5678,
        enableIntro: true,
        mechanics: saved,
      });
      act(() => view.result.current.setEngine(inferno));
      const { result } = view;
      act(() => result.current.handleIntroComplete());
      advanceFrame(600);
      nowMs = 1000;
      act(() => result.current.handleReset());
      expect(result.current.simulationState.introActive).toBe(true);
      expect(inferno.getLastTickEvents()).toContainEqual(
        expect.objectContaining({ type: 'intro_started', animationSeqId: 4367, landingPosition: [30, 32] }),
      );
      clickAt(result, 1100, [30, 36]);
      advanceFrame(1600);
      advanceFrame(2200);
      expect(result.current.fightStartCountdown).toBeNull();
      expect(position(result)).toEqual([30, 32]);
      nowMs = 3000;
      act(() => result.current.handleIntroComplete());
      expect(result.current.fightStartCountdown).toMatchObject({ startsAtMs: 3000, endsAtMs: 4800 });
      advanceFrame(3600);
      advanceFrame(4200);
      expect(position(result)).toEqual([30, 36]);
      advanceFrame(4800);
      expect(inferno.currentTick).toBe(1);
      const recorded = recording(result);
      expect(recorded.runConfig?.bootstrap).toMatchObject({ enableIntro: true, startPosition: [30, 36] });
      expect(
        recorded.frames.flatMap((frame) => frame.events).filter((event) => event.type === 'game_message'),
      ).toMatchObject([
        { tick: 1, kind: 'game', segments: [{ text: 'You hit the ground in the centre of The Inferno.' }] },
      ]);
    });

    /** The practice pane's start-wave field saves as it is typed; a run still on tick 0 takes it up. */
    itWithArena(
      'takes a start wave typed during the landing or the countdown without starting or keeping a landing it no longer opens with',
      () => {
        setResolvedArenaConfig('inferno', loadInfernoArena());
        const LANDED = 'You hit the ground in the centre of The Inferno.';
        const saved = (wave: string) => ({
          ...params.activeMechanicsConfig,
          infiniteHealth: true,
          infernoStartWave: wave,
        });
        const view = renderMoving({
          getIntroAnimationRemainingMs: () => 3000,
          activeMechanicsConfig: saved('1'),
          sceneState: { kind: 'encounter', encounterKind: 'inferno' },
        });
        const inferno = new SimulationEngine({
          encounter: new InfernoEncounter(99),
          combatSeed: 5678,
          enableIntro: true,
          mechanics: saved('1'),
        });
        act(() => view.result.current.setEngine(inferno));
        const { result } = view;
        const gameMessages = () =>
          recording(result)
            .frames.flatMap((frame) => frame.events)
            .flatMap((event) =>
              event.type === 'game_message' && event.kind === 'game'
                ? [{ tick: event.tick, text: (event.segments as readonly { text: string }[])[0]?.text }]
                : [],
            );
        act(() => result.current.handleIntroComplete());
        advanceFrame(600);

        // 1 -> 30 while the landing plays: it plays out, then the count; wave 30 comes on GO, unannounced.
        nowMs = 1000;
        act(() => result.current.handleReset());
        expect(result.current.simulationState.introActive).toBe(true);
        act(() => view.rerender({ ...params, activeMechanicsConfig: saved('30') }));
        expect(inferno.getEncounterSnapshot()).toMatchObject({ state: { wave: 30, startWave: 30 } });
        expect(result.current.simulationState.introActive).toBe(true);
        nowMs = 3000;
        act(() => result.current.handleIntroComplete());
        expect(result.current.fightStartCountdown).toMatchObject({ startsAtMs: 3000, endsAtMs: 4800 });
        advanceFrame(4800);
        expect(inferno.currentTick).toBe(1);
        expect(gameMessages()).toEqual([{ tick: 1, text: 'Wave: 30' }]);

        // 30 -> 1 during the count: no landing starts mid-countdown, and none is announced.
        nowMs = 6000;
        act(() => result.current.handleReset());
        expect(result.current.simulationState.introActive).toBe(false);
        advanceFrame(6600);
        act(() => view.rerender({ ...params, activeMechanicsConfig: saved('1') }));
        expect(inferno.getEncounterSnapshot()).toMatchObject({ state: { wave: 1, startWave: 1 } });
        expect(result.current.simulationState.introActive).toBe(false);
        expect(inferno.getLastTickEvents().some((event) => event.type === 'intro_started')).toBe(false);
        advanceFrame(7800);
        expect(inferno.currentTick).toBe(1);
        expect(gameMessages().map(({ text }) => text)).not.toContain(LANDED);
      },
    );

    it('Yama stays put during the countdown because its module does not opt in', () => {
      Reflect.deleteProperty(movementModule, 'countdownMovement');
      const { result } = renderMoving();
      restartAt1000(result);
      clickAt(result, 1100, NORTH);
      advanceFrame(1600);
      advanceFrame(2200);
      expect(result.current.engine.currentTick).toBe(0);
      expect(position(result)).toEqual(LANDING);
      expect(preparation(result)).toBeNull();
    });

    it('takes over at tick 1 from the committed start, and the restored countdown never moves', () => {
      const { result } = renderMoving();
      restartAt1000(result);
      clickAt(result, 1100, NORTH);
      advanceFrame(1600);
      advanceFrame(2200);
      advanceFrame(2800);
      advanceFrame(3400);
      advanceFrame(4000);
      expect(result.current.engine.currentTick).toBe(3);
      const prepared = result.current.engine;
      act(() => result.current.replay.controlProps.onEnterReplay());
      act(() => result.current.replay.controlProps.onSeek(1));
      expect(result.current.replay.controlProps.takeOverUnavailableReason).toBeNull();
      act(() => {
        void result.current.replay.controlProps.onTakeOver();
      });
      advanceFrame(4100);
      advanceFrame(4116);
      expect(result.current.engine).not.toBe(prepared);
      expect(result.current.replay.restoredPresentation?.tick).toBe(0);
      expect(result.current.simulationState).toMatchObject({ currentTick: 0, playerPosition: NORTH });
      expect(result.current.fightStartCountdown).not.toBeNull();
      clickAt(result, 4200, LANDING);
      for (const atMs of [4716, 5316, 5915]) {
        advanceFrame(atMs);
        expect(position(result)).toEqual(NORTH);
      }
      expect(preparation(result)).toBeNull();
    });
  });
});

describe('useSimulationWiring', () => {
  it.each([0, 100])('predicts equip/spec input order with %i ms input lag', (inputLagMs) => {
    const params = createParams({ autoAdvance: inputLagMs > 0, inputLagMs });
    const { result } = renderHook(() => useSimulationWiring(params));
    const engine = result.current.engine;
    vi.spyOn(engine, 'getItemEquipSlot').mockReturnValue('weapon');
    act(() => {
      engine.setEquipment({ weapon: 11802 });
      engine.setInventory([{ id: 11804 }, { id: 11806 }]);
      result.current.publishEngineState(engine.getState());
    });

    act(() => {
      result.current.handleEquipFromInventory(0);
      result.current.handleSpecialAttackToggle();
    });
    expect(
      result.current.inputPresentation.specialAttackActive ?? result.current.simulationState.pendingSpecialAttackActive,
    ).toBe(true);

    act(() => result.current.handleEquipFromInventory(1));
    expect(
      result.current.inputPresentation.specialAttackActive ?? result.current.simulationState.pendingSpecialAttackActive,
    ).toBe(false);
    params.audioEngine.dispose();
  });

  it('shows a sent walk destination to the renderer without re-rendering', () => {
    const params = createParams();
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useSimulationWiring(params);
    });
    const { getTargetTile } = result.current.inputPresentation;
    expect(getTargetTile()).toBeNull();
    const rendersBefore = renders;

    let retire = () => {};
    act(() => {
      retire = result.current.previewTargetTile([32, 37]);
    });
    expect(renders).toBe(rendersBefore);
    expect(getTargetTile()).toEqual([32, 37]);

    // Arriving at the server, the committed destination takes over in the same frame.
    act(() => {
      result.current.targetTileRef.current = [32, 37];
      retire();
    });
    expect(renders).toBe(rendersBefore);
    expect(getTargetTile()).toEqual([32, 37]);
    expect(result.current.inputPresentation.getTargetTile).toBe(getTargetTile);
    params.audioEngine.dispose();
  });

  it('records and dispatches Guzzle instead of the default rock-cake action', () => {
    const params = createParams();
    const { result } = renderHook(() => useSimulationWiring(params));
    act(() => result.current.engine.setInventory([{ id: 7510 }]));

    act(() => {
      result.current.handleUseItem(0, 'guzzle');
      result.current.fastForwardTicks(1);
    });

    expect(result.current.engine.getState().playerHP).toBe(89);
    expect(result.current.replay.exportReplayData().frames.at(-1)?.actions).toContainEqual({
      type: 'itemAction',
      inventoryIndex: 0,
      option: 'guzzle',
    });
    params.audioEngine.dispose();
  });

  it('captures DPS once per run opening and recorded tick, not per render or state read', () => {
    const projection = vi.spyOn(SimulationEngine.prototype, 'getAdjustedTheoreticalDps');
    const params = createParams();
    const { result, rerender } = renderHook(() => useSimulationWiring(params));
    expect(projection).toHaveBeenCalledTimes(1);
    expect(result.current.replay.exportReplayData().frames[0]?.dpsProjection).toBeNull();

    rerender();
    result.current.engine.getState();
    act(() => result.current.fastForwardTicks(2));

    expect(projection).toHaveBeenCalledTimes(3);
    expect(result.current.replay.exportReplayData().frames.map((frame) => frame.dpsProjection)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('retains recorded DPS when the current engine loadout and target change', () => {
    const params = createParams();
    const { result } = renderHook(() => useSimulationWiring(params));
    const engine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [31, 37] });
    act(() => {
      result.current.playerEquipmentRef.current = { weapon: 31113 };
      result.current.setEngine(engine);
    });
    act(() => result.current.fastForwardTicks(1));
    const recordedProjection = engine.getAdjustedTheoreticalDps();
    expect(recordedProjection?.dps).toBeGreaterThan(0);

    act(() => {
      engine.setEquipment({});
      engine.setBossHp(0);
      result.current.publishEngineState(engine.getState());
    });

    expect(engine.getAdjustedTheoreticalDps()).toBeNull();
    expect(result.current.replay.exportReplayData().frames[1]?.dpsProjection).toEqual(recordedProjection);
  });

  it('preserves shared player mechanics when synchronizing the live engine', () => {
    const mechanicsConfig = { ...DEFAULT_MECHANICS_CONFIG, upgradedPrayers: false, zealPrayer: true };
    const params = createParams({
      activeMechanicsConfig: mechanicsConfig,
    });

    const { result } = renderHook(() => useSimulationWiring(params));

    expect(result.current.engine.getState().mechanicsConfig.upgradedPrayers).toBe(false);
    expect(result.current.engine.getState().mechanicsConfig.zealPrayer).toBe(true);
  });

  it("transitions a loading scene when rendererType is 'none'", () => {
    const setSceneState = vi.fn<(next: SetStateAction<SceneState>) => void>();
    const params = createParams({
      rendererType: 'none',
      sceneState: { kind: 'loading', targetEncounter: 'lobby' },
      setSceneState,
    });

    renderHook(() => useSimulationWiring(params));

    expect(setSceneState).toHaveBeenCalledWith({ kind: 'encounter', encounterKind: 'lobby' });
  });

  it('applies tutorial ownership to the live Lobby engine through reset', () => {
    const params = createParams();
    const { result } = renderHook(() => useSimulationWiring(params));

    expect(result.current.engine.getRunConfig().encounter.kind).toBe(new LobbyEncounter().kind);
    act(() => result.current.handleIntroComplete());
    expect(result.current.simulationState.introActive).toBe(false);

    act(() => result.current.handleTutorialReset('external-owned'));

    expect(result.current.engine.getRunConfig()).toMatchObject({
      completionOwnership: 'external-owned',
      encounter: { kind: 'lobby' },
    });
    expect(result.current.targetTile).toEqual([31, 25]);
  });
});

describe('useSimulationWiring practice restarts', () => {
  let arena: ReturnType<typeof getArenaConfig>;
  let allowUnbounded: boolean;
  beforeEach(() => {
    arena = getArenaConfig();
    allowUnbounded = getArenaAllowUnboundedFallback();
  });
  afterEach(() => {
    clearResolvedArenaConfigs();
    setArenaConfig(arena, allowUnbounded);
  });

  const RETRY = { encounter: 'inferno', type: 'retry-wave' } as const;
  const REROLL = { encounter: 'inferno', type: 'reroll-wave' } as const;

  itWithArena('restarts on the tile the player stands on, and records it as the new run’s start', () => {
    setResolvedArenaConfig('inferno', loadInfernoArena());
    const saved = { ...DEFAULT_MECHANICS_CONFIG, infiniteHealth: true, infernoStartWave: '30' };
    const params = createParams({
      activeMechanicsConfig: saved,
      sceneState: { kind: 'encounter', encounterKind: 'inferno' },
    });
    const { result } = renderHook((props: WiringParams) => useSimulationWiring(props), { initialProps: params });
    const engine = new SimulationEngine({ encounter: new InfernoEncounter(99), combatRandom: () => 0.5 });
    engine.setMechanicsConfig(saved);
    act(() => result.current.setEngine(engine));
    act(() => result.current.fastForwardTicks(11));
    const player = (Reflect.get(engine, 'worldState') as WorldState).getPlayer();
    if (!player) throw new Error('missing player');
    player.position = [30, 36];

    act(() => result.current.handleExecuteEncounterCommand(RETRY));
    expect(engine.currentTick).toBe(0);
    expect(engine.getState().playerPosition).toEqual([30, 36]);
    expect(result.current.targetTile).toEqual([30, 36]);
    expect(result.current.replay.exportReplayData().runConfig?.bootstrap?.startPosition).toEqual([30, 36]);
    params.audioEngine.dispose();
  });

  /** An Inferno run on the player's saved start wave, at tick 11 with the player moved to `tile`. */
  function infernoRunStandingOn(startWave: string, tile: Coordinate, setup: Partial<MechanicsConfig> = {}) {
    setResolvedArenaConfig('inferno', loadInfernoArena());
    const saved = { ...DEFAULT_MECHANICS_CONFIG, infiniteHealth: true, infernoStartWave: startWave, ...setup };
    const params = createParams({
      activeMechanicsConfig: saved,
      // Loaded, so the replay's retry (Ctrl+R) is available.
      isFullyLoaded: true,
      sceneState: { kind: 'encounter', encounterKind: 'inferno' },
    });
    const { result, rerender } = renderHook((props: WiringParams) => useSimulationWiring(props), {
      initialProps: params,
    });
    const engine = new SimulationEngine({ encounter: new InfernoEncounter(99), combatRandom: () => 0.5 });
    engine.setMechanicsConfig(saved);
    act(() => result.current.setEngine(engine));
    act(() => result.current.fastForwardTicks(11));
    const player = (Reflect.get(engine, 'worldState') as WorldState).getPlayer();
    if (!player) throw new Error('missing player');
    player.position = [...tile];
    return { result, rerender, engine, params };
  }

  itWithArena('restarts the fight on the tile the player stands on, at the saved start wave', () => {
    const { result, engine, params } = infernoRunStandingOn('30', [30, 36]);
    act(() => result.current.handleReset());
    expect(engine.currentTick).toBe(0);
    expect((engine.getEncounterSnapshot() as InfernoSnapshot).state).toMatchObject({ wave: 30, startWave: 30 });
    expect(engine.getState().playerPosition).toEqual([30, 36]);
    expect(result.current.targetTile).toEqual([30, 36]);
    expect(result.current.replay.exportReplayData().runConfig?.bootstrap?.startPosition).toEqual([30, 36]);

    // And again from there.
    act(() => result.current.handleReset());
    expect(engine.getState().playerPosition).toEqual([30, 36]);
    params.audioEngine.dispose();
  });

  describe('Ctrl+R without a practice start', () => {
    /** Ctrl+R's own route: the replay's retry, which falls back to the encounter session's primary. */
    const ctrlR = (run: ReturnType<typeof infernoRunStandingOn>) => {
      expect(run.result.current.replay.replayPractice.startTick).toBeNull();
      act(() => run.result.current.replay.replayPractice.onRetry());
    };
    const state = (run: ReturnType<typeof infernoRunStandingOn>) =>
      (run.engine.getEncounterSnapshot() as InfernoSnapshot).state;
    /** The Actions list's restarts beyond Retry, as TopChrome and Mobile Practice filter them. */
    const listedSecondary = (run: ReturnType<typeof infernoRunStandingOn>, saved: Partial<MechanicsConfig>) => {
      const encounterSnapshot = run.result.current.simulationState.encounter;
      return visibleInPractice(buildInfernoControls().debugActions, {
        config: saved,
        stage: encounterSetupStage(encounterSnapshot) ?? undefined,
        encounterSnapshot,
      })
        .map(({ label }) => label)
        .filter((label) => label === 'Random Spawns' || label === 'Lock Layout');
    };

    itWithArena(
      'retries the wave being fought, as the session bar’s Retry does, rather than the saved start wave',
      () => {
        const run = infernoRunStandingOn('30', [30, 36]);
        act(() =>
          run.result.current.handleExecuteEncounterCommand({ encounter: 'inferno', type: 'go-to-wave', wave: 35 }),
        );
        act(() => run.result.current.fastForwardTicks(11));
        const player = (Reflect.get(run.engine, 'worldState') as WorldState).getPlayer();
        if (!player) throw new Error('missing player');
        player.position = [30, 36];
        expect(run.result.current.encounterSession?.primary.label).toBe('Retry wave 35');
        // A random wave: new spawns each time, never the saved start wave.
        vi.spyOn(Math, 'random').mockReturnValue(0.25);
        ctrlR(run);
        expect(run.engine.currentTick).toBe(0);
        expect(state(run)).toMatchObject({ wave: 35, startWave: 35 });
        expect(run.engine.getRunConfig().encounter.seeds).toEqual({ runSeed: 0x40000000 });
        expect(run.engine.getState().playerPosition).toEqual([30, 36]);
        expect(
          run.result.current.replay.exportReplayData().runConfig?.bootstrap?.mechanicsConfig.infernoStartWave,
        ).toBe('35');
        // The whole-fight restart stays the Restart fight button's.
        act(() => run.result.current.handleReset());
        expect(state(run)).toMatchObject({ wave: 30, startWave: 30 });
        run.params.audioEngine.dispose();
      },
    );

    itWithArena('repeats a custom wave’s spawns under its run seed, until Random spawns makes it random', () => {
      const run = infernoRunStandingOn('6', [30, 36], { [INFERNO_SPAWN_LAYOUT_KEY]: '6:-b-------' });
      expect(run.result.current.encounterSession?.secondary?.label).toBe('Random spawns');
      ctrlR(run);
      expect(run.engine.getRunConfig().encounter.seeds).toEqual({ runSeed: 99, attemptSeed: expect.any(Number) });
      expect(state(run)).toMatchObject({ wave: 6, startSpawnLayout: '6:-b-------' });

      const saved = run.params.activeMechanicsConfig;
      expect(listedSecondary(run, saved)).toEqual(['Random Spawns']);
      act(() => run.result.current.encounterSession?.secondary?.onClick());
      expect(state(run)).toMatchObject({ wave: 6, startSpawnLayout: '' });
      // Random now, so the bar's second restart is the one that keeps these spawns, and the Actions
      // list follows the run, though the saved layout is still the custom one.
      expect(run.result.current.encounterSession?.secondary?.label).toBe('Lock layout');
      expect(saved[INFERNO_SPAWN_LAYOUT_KEY]).toBe('6:-b-------');
      expect(listedSecondary(run, saved)).toEqual(['Lock Layout']);
      vi.spyOn(Math, 'random').mockReturnValue(0.75);
      ctrlR(run);
      expect(run.engine.getRunConfig().encounter.seeds).toEqual({ runSeed: 0xc0000000 });
      expect(state(run)).toMatchObject({ wave: 6, startSpawnLayout: '' });

      // Lock layout keeps that run seed, and the run stays random on the wave, these spawns kept.
      act(() => run.result.current.encounterSession?.secondary?.onClick());
      expect(run.engine.getRunConfig().encounter.seeds).toEqual({ runSeed: 0xc0000000, attemptSeed: 0xc0000000 });
      expect(state(run)).toMatchObject({ wave: 6, startSpawnLayout: '', pinnedWave: 6 });
      expect(run.engine.getState().playerPosition).toEqual([30, 36]);
      expect(listedSecondary(run, saved)).toEqual(['Random Spawns']);
      run.params.audioEngine.dispose();
    });

    itWithArena(
      'keeps the run’s own restarts through a mid-run layout edit, until Go or Restart fight applies it',
      () => {
        const run = infernoRunStandingOn('6', [30, 36]);
        expect(run.result.current.encounterSession?.secondary?.label).toBe('Lock layout');
        // Saved mid-run: the run already spawned wave 6 at random, so nothing it offers changes.
        const edited = { ...run.params.activeMechanicsConfig, [INFERNO_SPAWN_LAYOUT_KEY]: '6:-b-------' };
        run.rerender({ ...run.params, activeMechanicsConfig: edited });
        expect(state(run)).toMatchObject({ wave: 6, startSpawnLayout: '' });
        expect(run.result.current.encounterSession?.secondary?.label).toBe('Lock layout');
        expect(listedSecondary(run, edited)).toEqual(['Lock Layout']);
        // Lock layout keeps the run random on the wave too, rather than swapping the edit in.
        act(() => run.result.current.encounterSession?.secondary?.onClick());
        expect(state(run)).toMatchObject({ wave: 6, startSpawnLayout: '', pinnedWave: 6 });
        expect(run.engine.getRunConfig().encounter.seeds).toEqual({ runSeed: 99, attemptSeed: expect.any(Number) });
        // As does a Retry of those kept spawns.
        act(() => run.result.current.encounterSession?.primary.onClick());
        expect(state(run)).toMatchObject({ wave: 6, startSpawnLayout: '', pinnedWave: 6 });

        // Go to the wave applies the saved setup: the run places it from the layout now.
        act(() =>
          run.result.current.handleExecuteEncounterCommand({ encounter: 'inferno', type: 'go-to-wave', wave: 6 }),
        );
        expect(state(run)).toMatchObject({ wave: 6, startSpawnLayout: '6:-b-------' });
        expect(run.result.current.encounterSession?.secondary?.label).toBe('Random spawns');
        expect(listedSecondary(run, edited)).toEqual(['Random Spawns']);

        // As does Restart fight, from a run Random spawns had made random.
        act(() => run.result.current.encounterSession?.secondary?.onClick());
        expect(listedSecondary(run, edited)).toEqual(['Lock Layout']);
        act(() => run.result.current.handleReset());
        expect(state(run)).toMatchObject({ wave: 6, startSpawnLayout: '6:-b-------' });
        expect(listedSecondary(run, edited)).toEqual(['Random Spawns']);
        run.params.audioEngine.dispose();
      },
    );

    itWithArena(
      'keeps spawns through Retry and Ctrl+R until New spawns, Go or Restart fight, never saving them',
      () => {
        const run = infernoRunStandingOn('30', [30, 36]);
        const { engine, result, params } = run;
        // Put on mid-run: every restart into wave 30 carries the gear worn.
        const worn = { head: 10828, weapon: 20997 };
        engine.setEquipment(worn);
        const session = () => result.current.encounterSession;
        const pinOf = () => (engine.getEncounterSnapshot() as InfernoSnapshot).state.pinnedWave;
        const random = vi.spyOn(Math, 'random');
        /** The restart just made: its recorded seeds and pin, opening where the player stood, that gear still worn. */
        const restarted = () => {
          expect(engine.currentTick).toBe(0);
          expect((engine.getEncounterSnapshot() as InfernoSnapshot).state).toMatchObject({ wave: 30, startWave: 30 });
          const bootstrap = result.current.replay.exportReplayData().runConfig?.bootstrap;
          expect(bootstrap?.startPosition).toEqual([30, 36]);
          expect(engine.getState().playerPosition).toEqual([30, 36]);
          expect(engine.getState().playerEquipment).toEqual(worn);
          expect(bootstrap?.equipment).toEqual(worn);
          // A run override: the saved setup the wiring was given, and the engine's copy of it, never take it.
          expect(params.activeMechanicsConfig).not.toHaveProperty('infernoPinnedWave');
          expect(Reflect.get(engine, 'playerMechanicsConfig')).not.toHaveProperty('infernoPinnedWave');
          return {
            seeds: result.current.replay.exportReplayData().runConfig?.encounter.seeds,
            pin: bootstrap?.mechanicsConfig.infernoPinnedWave,
            snapshotPin: pinOf(),
          };
        };

        expect(session()?.secondary?.label).toBe('Lock layout');
        random.mockReturnValue(0.25);
        act(() => session()?.secondary?.onClick());
        expect(restarted()).toEqual({ seeds: { runSeed: 99, attemptSeed: 0x40000000 }, pin: '30', snapshotPin: 30 });
        expect(session()?.title).toBe('Wave 30 · spawn layout locked');
        expect(session()?.secondary?.label).toBe('New spawns');
        // The button's Retry, then Ctrl+R: the same spawns, the monsters rolling afresh each time.
        random.mockReturnValue(0.5);
        act(() => session()?.primary.onClick());
        expect(restarted()).toEqual({ seeds: { runSeed: 99, attemptSeed: 0x80000000 }, pin: '30', snapshotPin: 30 });
        random.mockReturnValue(0.625);
        ctrlR(run);
        expect(restarted()).toEqual({ seeds: { runSeed: 99, attemptSeed: 0xa0000000 }, pin: '30', snapshotPin: 30 });
        // New spawns stops keeping them, and Ctrl+R rolls new ones again.
        random.mockReturnValue(0.75);
        act(() => session()?.secondary?.onClick());
        expect(restarted()).toEqual({ seeds: { runSeed: 0xc0000000 }, pin: undefined, snapshotPin: undefined });
        expect(session()?.secondary?.label).toBe('Lock layout');
        random.mockReturnValue(0.375);
        ctrlR(run);
        expect(restarted()).toEqual({ seeds: { runSeed: 0x60000000 }, pin: undefined, snapshotPin: undefined });

        // Go to the same wave keeps the run seed but not the pin; Restart fight keeps neither.
        act(() => session()?.secondary?.onClick());
        expect(pinOf()).toBe(30);
        act(() => result.current.handleExecuteEncounterCommand({ encounter: 'inferno', type: 'go-to-wave', wave: 30 }));
        expect(engine.getRunConfig().encounter.seeds).toMatchObject({ runSeed: 0x60000000 });
        expect(engine.getRunConfig().bootstrap?.mechanicsConfig).not.toHaveProperty('infernoPinnedWave');
        expect(pinOf()).toBeUndefined();
        expect(session()?.secondary?.label).toBe('Lock layout');
        // Go opened on the setup's start tile; back where the rest of this run stood.
        const goPlayer = (Reflect.get(engine, 'worldState') as WorldState).getPlayer();
        if (!goPlayer) throw new Error('missing player');
        goPlayer.position = [30, 36];
        act(() => session()?.secondary?.onClick());
        expect(pinOf()).toBe(30);
        act(() => result.current.handleReset());
        expect(restarted()).toMatchObject({ pin: undefined, snapshotPin: undefined });
        params.audioEngine.dispose();
      },
    );

    it('restarts the whole fight in an encounter without a session', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const params = createParams({ isFullyLoaded: true, sceneState: { kind: 'encounter', encounterKind: 'yama_p3' } });
      const { result } = renderHook((props: WiringParams) => useSimulationWiring(props), { initialProps: params });
      const engine = new SimulationEngine({ encounter: new YamaEncounter(undefined, 1234), enableIntro: false });
      act(() => result.current.setEngine(engine));
      act(() => result.current.fastForwardTicks(3));
      expect(result.current.encounterSession).toBeNull();
      act(() => result.current.replay.replayPractice.onRetry());
      expect(engine.currentTick).toBe(0);
      params.audioEngine.dispose();
    });
  });

  describe('Restart fight with the saved spawn layout', () => {
    /** The slots wave 6 spawned on, under the run's seed (`waveSpawnLayout`), after Restart fight at `random`. */
    function restartedSpawns(result: ReturnType<typeof infernoRunStandingOn>, random: number) {
      vi.spyOn(Math, 'random').mockReturnValue(random);
      act(() => result.result.current.handleReset());
      act(() => result.result.current.fastForwardTicks(11));
      const { state } = result.engine.getEncounterSnapshot() as InfernoSnapshot;
      expect(state).toMatchObject({ wave: 6, startWave: 6 });
      const runSeed = Number(result.engine.getRunConfig().encounter.seeds.runSeed);
      return { spawned: state.waveSpawnLayout, runSeed, startLayout: state.startSpawnLayout };
    }
    /** What `layout` (none: random) spawns on wave 6 under `runSeed`. */
    const planned = (runSeed: number, layout: string) =>
      serializeSpawnLayout(
        layoutFromPlacements(6, planWaveSpawns(runSeed, 6, undefined, -1, parseSpawnLayout(layout))) ??
          assert.fail('no layout'),
      );

    itWithArena.each([
      { name: 'a whole layout', layout: '6:-b-l----b' },
      { name: 'a partial layout', layout: '6:-b-------' },
      { name: 'none', layout: '' },
    ])('keeps $name, under a new run seed each time', ({ layout }) => {
      const run = infernoRunStandingOn('6', [30, 36], { [INFERNO_SPAWN_LAYOUT_KEY]: layout });
      const seen = new Set<string>();
      for (const random of [0.25, 0.5, 0.75]) {
        const { spawned, runSeed, startLayout } = restartedSpawns(run, random);
        expect(runSeed).toBe(Math.floor(random * 2 ** 32));
        expect(startLayout).toBe(layout);
        expect(spawned).toBe(planned(runSeed, layout));
        // A partial layout keeps its bat on slot 1; only the rest move.
        if (layout) expect(spawned[3]).toBe('b');
        seen.add(spawned);
      }
      // Fixed only when every spawn is placed.
      expect(seen.size).toBe(layout === '6:-b-l----b' ? 1 : 3);
      run.params.audioEngine.dispose();
    });
  });

  itWithArena('restarts a wave-1 setup on the landing tile it falls to', () => {
    const { result, engine, params } = infernoRunStandingOn('1', [30, 36]);
    act(() => result.current.handleReset());
    expect(engine.getState().playerPosition).toEqual([30, 32]);
    expect(result.current.replay.exportReplayData().runConfig?.bootstrap?.startPosition).toEqual([30, 32]);
    params.audioEngine.dispose();
  });

  it('leaves other encounters’ restarts on their own start', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const params = createParams({ sceneState: { kind: 'encounter', encounterKind: 'yama_p3' } });
    const { result } = renderHook((props: WiringParams) => useSimulationWiring(props), { initialProps: params });
    const engine = new SimulationEngine({ encounter: new YamaEncounter(undefined, 1234), enableIntro: false });
    act(() => result.current.setEngine(engine));
    const opening = engine.getState().playerPosition;
    act(() => result.current.fastForwardTicks(3));
    const player = (Reflect.get(engine, 'worldState') as WorldState).getPlayer();
    if (!player) throw new Error('missing player');
    player.position = [opening[0] + 2, opening[1] + 2];
    expect(engine.planRestartStart()).toBeNull();
    act(() => result.current.handleReset());
    expect(engine.getState().playerPosition).toEqual(opening);
    params.audioEngine.dispose();
  });

  it('restarts the current wave for that run only: the saved start wave keeps driving full restarts', () => {
    const saved = { ...DEFAULT_MECHANICS_CONFIG, infiniteHealth: true, infernoStartWave: '5' };
    const params = createParams({
      activeMechanicsConfig: saved,
      sceneState: { kind: 'encounter', encounterKind: 'inferno' },
    });
    const { result, rerender } = renderHook((props: WiringParams) => useSimulationWiring(props), {
      initialProps: params,
    });
    const engine = new SimulationEngine({ encounter: new InfernoEncounter(99), combatRandom: () => 0.5 });
    engine.setMechanicsConfig(saved);
    act(() => result.current.setEngine(engine));
    const wave = () => (engine.getEncounterSnapshot() as InfernoSnapshot).state;
    const runSeed = () => engine.getRunConfig().encounter.seeds.runSeed;
    const recordedStartWave = () =>
      result.current.replay.exportReplayData().runConfig?.bootstrap?.mechanicsConfig.infernoStartWave;

    // Clear wave 5 so the run is on wave 6.
    act(() => result.current.fastForwardTicks(11));
    const world = Reflect.get(engine, 'worldState') as WorldState;
    for (let guard = 0; wave().wave === 5 && guard < 50; guard++) {
      const tick = engine.currentTick;
      for (const npc of world.getNpcs()) {
        if (!npc.alive || !npc.id.startsWith('inferno_') || npc.id.startsWith('inferno_pillar')) continue;
        enqueueEnginePendingHit(engine, {
          sourceId: 'player',
          targetId: npc.id,
          style: 'typeless',
          attackKind: 'typeless',
          launchTick: tick,
          impactTick: tick + 1,
          rolledDamage: npc.vitals.hp,
          accuracySucceeded: true,
        });
      }
      act(() => result.current.fastForwardTicks(tick + 1));
    }
    expect(wave()).toMatchObject({ wave: 6, startWave: 5 });

    // A random wave, so Retry draws a new run seed.
    vi.spyOn(Math, 'random').mockReturnValue(0.75);
    act(() => result.current.handleExecuteEncounterCommand(RETRY));
    // Any later setting sync at tick 0 re-applies the saved setup; the run keeps its own wave.
    rerender({ ...params, activeMechanicsConfig: { ...saved } });
    expect(engine.currentTick).toBe(0);
    expect(wave()).toMatchObject({ wave: 6, startWave: 6 });
    expect(runSeed()).toBe(0xc0000000);
    const retrySeeds = engine.getRunConfig().encounter.seeds;
    expect(retrySeeds).toEqual({ runSeed: 0xc0000000 });
    expect(result.current.replay.exportReplayData().runConfig?.encounter.seeds).toEqual(retrySeeds);
    expect(recordedStartWave()).toBe('6');

    // The player changes the saved setup mid-run, then rerolls: still the current wave, a new seed.
    act(() => result.current.fastForwardTicks(3));
    const changed = { ...saved, infernoStartWave: '62' };
    rerender({ ...params, activeMechanicsConfig: changed });
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    act(() => result.current.handleExecuteEncounterCommand(REROLL));
    expect(wave()).toMatchObject({ wave: 6, startWave: 6 });
    expect(engine.getRunConfig().encounter.seeds).toEqual({ runSeed: 0x40000000 });
    expect(recordedStartWave()).toBe('6');

    act(() => result.current.handleReset());
    expect(wave()).toMatchObject({ wave: 62, startWave: 62 });
    expect(engine.getMechanicsConfig().infernoStartWave).toBe('62');
    expect(recordedStartWave()).toBe('62');
    params.audioEngine.dispose();
  });
});

describe('useSimulationWiring restarts keep worn equipment', () => {
  let arena: ReturnType<typeof getArenaConfig>;
  let allowUnbounded: boolean;
  beforeEach(() => {
    arena = getArenaConfig();
    allowUnbounded = getArenaAllowUnboundedFallback();
  });
  afterEach(() => {
    clearResolvedArenaConfigs();
    setArenaConfig(arena, allowUnbounded);
  });

  const HELM = 10828;
  const WHIP = 4151;
  const DEFENDER = 12954;
  const BOW = 20997;
  const BREW = 6685;
  const configured: WornLoadout = {
    equipment: { head: HELM, weapon: WHIP, shield: DEFENDER },
    inventory: (() => {
      const inventory = createEmptyInventory();
      inventory[0] = { id: BOW };
      inventory[1] = { id: BREW };
      return inventory;
    })(),
  };

  /** A run entered with `configured` (as `enterEncounter` seeds it), at tick 5 of its fight. */
  function runWith(engine: SimulationEngine, encounterKind: string, mechanics: MechanicsConfig) {
    let loadout = configured;
    const params = createParams({
      activeMechanicsConfig: mechanics,
      isFullyLoaded: true,
      sceneState: { kind: 'encounter', encounterKind },
      getEncounterEquipment: () => loadout.equipment,
      getEncounterInventory: () => loadout.inventory,
    });
    const { result } = renderHook((props: WiringParams) => useSimulationWiring(props), { initialProps: params });
    result.current.playerEquipmentRef.current = configured.equipment;
    result.current.playerInventoryRef.current = cloneInventory(configured.inventory);
    act(() => result.current.setEngine(engine));
    act(() => result.current.fastForwardTicks(5));
    const editLoadout = (next: WornLoadout) => {
      loadout = next;
    };
    return { result, params, editLoadout };
  }

  // These cases carry a loadout across a restart; any arena will do, so the encounter's own
  // pre-cache placeholder stands in for the baked one.
  function infernoRun(startWave: string) {
    const encounter = new InfernoEncounter(99);
    setResolvedArenaConfig('inferno', encounter.getArenaConfig());
    const mechanics = { ...DEFAULT_MECHANICS_CONFIG, infiniteHealth: true, infernoStartWave: startWave };
    const engine = new SimulationEngine({ encounter, combatRandom: () => 0.5 });
    engine.setMechanicsConfig(mechanics);
    return { engine, ...runWith(engine, 'inferno', mechanics) };
  }

  const loadoutOf = (engine: SimulationEngine) => {
    const { playerEquipment, inventory } = engine.getState();
    return { equipment: playerEquipment, inventory };
  };

  it('keeps a swap, the displaced items taking the bow’s slot and the first free one, in the recording too', () => {
    const { engine, result, params } = infernoRun('30');
    // The bow worn from slot 0, which displaced the whip and the defender.
    engine.setEquipment({ head: HELM, weapon: BOW });
    act(() => result.current.handleReset());
    const kept = {
      equipment: { head: HELM, weapon: BOW },
      inventory: (() => {
        const inventory = createEmptyInventory();
        inventory[0] = { id: WHIP };
        inventory[1] = { id: BREW };
        inventory[2] = { id: DEFENDER };
        return inventory;
      })(),
    };
    expect(engine.currentTick).toBe(0);
    expect(loadoutOf(engine)).toEqual(kept);
    // The worn model follows the kept gear.
    const update = vi.mocked(params.setPlayerConfig).mock.calls.at(-1)?.[0];
    expect(typeof update === 'function' ? update(DEFAULT_PLAYER_CONFIG).equipment : update).toEqual(kept.equipment);
    const bootstrap = result.current.replay.exportReplayData().runConfig?.bootstrap;
    expect(bootstrap?.equipment).toEqual(kept.equipment);
    expect(bootstrap?.inventory).toEqual(kept.inventory);

    // Retry wave keeps it too, and the run it starts replays exactly from its recording.
    act(() => result.current.handleExecuteEncounterCommand({ encounter: 'inferno', type: 'retry-wave' }));
    expect(loadoutOf(engine)).toEqual(kept);
    act(() => result.current.fastForwardTicks(4));
    const data = result.current.replay.exportReplayData();
    if (!data.runConfig) throw new Error('missing bootstrap');
    const recorder = new ReplayRecorder();
    recorder.load(data);
    const rebuilt = engineFactory.reconstructReplayPrefix(
      data.runConfig,
      recorder.getReconstructionFrames(),
      recorder.getFrameCount() - 1,
      null,
    );
    if (!rebuilt) throw new Error('reconstruction refused');
    expect(rebuilt.getState().playerEquipment).toEqual(kept.equipment);
    expect(diffResumableState(engine.getState(), rebuilt.getState())).toEqual([]);
    params.audioEngine.dispose();
  });

  it('keeps an item taken off and dropped unworn, back in the inventory, with the floor cleared', () => {
    const { engine, result, params } = infernoRun('30');
    act(() => result.current.handleUnequipSlot('head'));
    act(() => result.current.fastForwardTicks(engine.currentTick + 1));
    const helmSlot = engine.getState().inventory.findIndex((item) => item?.id === HELM);
    expect(helmSlot).toBeGreaterThanOrEqual(0);
    act(() => result.current.handleDropItem(helmSlot));
    act(() => result.current.fastForwardTicks(engine.currentTick + 1));
    expect(engine.getState().groundItems.map((item) => item.itemId)).toContain(HELM);

    act(() => result.current.handleReset());
    expect(engine.getState().groundItems).toEqual([]);
    expect(loadoutOf(engine).equipment).toEqual({ weapon: WHIP, shield: DEFENDER });
    expect(loadoutOf(engine).inventory.slice(0, 3)).toEqual([{ id: BOW }, { id: BREW }, { id: HELM }]);
    params.audioEngine.dispose();
  });

  it('starts from an edited loadout as it is, carrying nothing', () => {
    const { engine, result, params, editLoadout } = infernoRun('30');
    engine.setEquipment({ head: HELM, weapon: BOW });
    const edited = { equipment: { weapon: WHIP }, inventory: createEmptyInventory() };
    editLoadout(edited);
    act(() => result.current.handleReset());
    expect(loadoutOf(engine)).toEqual(edited);

    // From then on the edited loadout is the baseline, so the next restart carries again.
    engine.setEquipment({});
    act(() => result.current.handleReset());
    expect(loadoutOf(engine).equipment).toEqual({});
    expect(loadoutOf(engine).inventory[0]).toEqual({ id: WHIP });
    params.audioEngine.dispose();
  });

  it('leaves wave 69 restarts on the configured loadout', () => {
    const { engine, result, params } = infernoRun('69');
    engine.setEquipment({ head: HELM, weapon: BOW });
    act(() => result.current.handleReset());
    expect(loadoutOf(engine)).toEqual(configured);
    params.audioEngine.dispose();
  });

  it('leaves encounters without countdown movement on the configured loadout', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const engine = new SimulationEngine({ encounter: new YamaEncounter(undefined, 1234), enableIntro: false });
    const { result, params } = runWith(engine, 'yama_p3', DEFAULT_MECHANICS_CONFIG);
    engine.setEquipment({ head: HELM, weapon: BOW });
    act(() => result.current.handleReset());
    expect(loadoutOf(engine)).toEqual(configured);
    params.audioEngine.dispose();
  });
});

describe('useSimulationWiring restored practice on the real clock', () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  let previousActEnvironment: boolean | undefined;
  let params: WiringParams | undefined;

  beforeEach(() => {
    previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    resetPageActivityForTests();
  });
  afterEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    params?.audioEngine.dispose();
    resetPageActivityForTests();
  });

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  async function until(predicate: () => boolean, timeoutMs: number, label: string) {
    const deadline = performance.now() + timeoutMs;
    while (!predicate()) {
      if (performance.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
      await sleep(1);
    }
  }

  // No fake timers or RAF: React's own scheduler, the browser RAF and performance.now drive GO.
  it('holds restored tick 7 at GO and GO+100ms, and runs selected tick 8 no earlier than one interval after GO', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    params = createParams({
      autoAdvance: false,
      isFullyLoaded: true,
      rendererType: 'none',
      sceneState: { kind: 'encounter', encounterKind: 'yama_p3' },
      activeMechanicsConfig: { ...DEFAULT_MECHANICS_CONFIG, infiniteHealth: true },
      fightStartCountdownTicks: 1,
    });
    const view = renderHook(useSimulationWiring, { initialProps: params });
    const { result } = view;
    act(() =>
      result.current.setEngine(
        new SimulationEngine({
          encounter: new YamaEncounter(undefined, 1234),
          combatSeed: 5678,
          startPos: [31, 37],
          enableIntro: false,
        }),
      ),
    );
    act(() => result.current.fastForwardTicks(12));
    act(() => result.current.replay.controlProps.onEnterReplay());
    act(() => result.current.replay.controlProps.onSeek(8));
    // Replay mode holds the loop; auto-advance only matters once practice adopts.
    view.rerender({ ...params, autoAdvance: true });

    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    await result.current.replay.replayPractice.onStartPractice();
    await until(() => !result.current.replay.replayMode, 1000, 'adoption');
    const adopted = result.current.engine;
    expect(adopted.currentTick).toBe(7);
    expect(result.current.replay.replayPractice.startTick).toBe(8);

    await until(() => (result.current.fightStartCountdown?.releasedAtMs ?? null) !== null, 3000, 'GO');
    const goAt = result.current.fightStartCountdown?.releasedAtMs ?? Number.NaN;
    const atGo = adopted.currentTick;
    await sleep(Math.max(0, goAt + 100 - performance.now()));
    const atGoPlus100 = adopted.currentTick;
    await until(() => adopted.currentTick >= 8, 3000, 'selected tick');
    const firstTickAt = performance.now();

    expect(atGo).toBe(7);
    expect(atGoPlus100).toBe(7);
    expect(adopted.currentTick).toBe(8);
    expect(firstTickAt - goAt).toBeGreaterThanOrEqual(600);
    const branch = result.current.replay.exportReplayData();
    expect(branch.frames.at(-1)?.state.currentTick).toBe(8);
    expect(branch.frames).toHaveLength(9);
    view.unmount();
  }, 10_000);
});
