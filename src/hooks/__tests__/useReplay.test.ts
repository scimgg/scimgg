// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setArenaConfig } from '../../core/constants';
import type { GameEvent } from '../../core/events/types';
import {
  modifierMaskAt,
  ReplayRecorder,
  type ReplayUiState,
  type ReplayViewportState,
} from '../../core/ReplayRecorder';
import type { ReplayMenuState } from '../../core/replayMenu';
import type { ReplayOverlays, ReplayPresentationState } from '../../core/replayPresentation';
import { ReplayTakeoverWork } from '../../core/replayTakeover';
import type { EngineAction } from '../../core/SimulationEngine';
import { type EngineRunConfig, SimulationEngine } from '../../core/SimulationEngine';
import { EQUIPMENT_PRESETS } from '../../data/playerPresets';
import { resolveEncounterEntry } from '../../encounters/modules';
import { encounterRegistry } from '../../encounters/registry';
import * as engineFactory from '../../encounters/simulationEngineFactory';
import { createSimulationEngineForNewRun, type EncounterSetupConfig } from '../../encounters/simulationEngineFactory';
import { YamaEncounter } from '../../encounters/yamaP3/YamaEncounter';
import { runSyntheticInput } from '../../input/inputProvenance';
import { __resetKeyStateForTest, MODIFIER_BIT } from '../../input/keyState';
import {
  getReplayClickDurationMs,
  REPLAY_CLICK_OWNER_ATTRIBUTE,
  REPLAY_CLICK_OWNERS,
} from '../../input/replayClickFeedback';
import { publishLiveReplayMenuState } from '../../input/replayMenuState';
import { freshReplayCapture } from '../../replay/format/capture';
import { ReplayPresentationStateSchema } from '../../replay/format/presentationFormat';
import { diffResumableState } from '../../replay/resumableState';
import type { PlayerEquipment } from '../../rs/model/PlayerModelLoader';
import { yamaSnapshot } from '../../test/helpers/encounterSnapshot';
import { stubMaxTouchPoints } from '../../test/helpers/maxTouchPoints';
import { validPresentationSample } from '../../test/helpers/replayFixtures';
import { createEmptyCombatSupplies } from '../../types/encounterLoadout';
import { createEmptyStats as createEmptyEquipmentStats } from '../../types/equipmentStats';
import { createEmptyInventory } from '../../types/inventory';
import {
  createDefaultRunEnergy,
  createDefaultSpecialAttack,
  createDefaultStats,
  createDefaultTimers,
  POISON_TICK_INTERVAL,
} from '../../types/playerState';
import {
  type Coordinate,
  createDefaultPrayerState,
  type MechanicsConfig,
  type SimulationState,
} from '../../types/simulation';
import { animationFrames } from '../../util/animationFrames';
import { log } from '../../util/Logger';
import { type GameFrameRect, getGameFrameRect } from '../../util/viewportBounds';
import { TAKE_OVER_UNAVAILABLE_TEXT, useReplay } from '../useReplay';

vi.mock('../../util/viewportBounds', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../util/viewportBounds')>();
  return {
    ...actual,
    getGameFrameRect: vi.fn(() => ({ left: 0, top: 0, width: 100, height: 100 })),
  };
});

const BOUNDS: GameFrameRect = { left: 0, top: 0, width: 100, height: 100 };
const RUN_CONFIG: EngineRunConfig = {
  completionOwnership: 'encounter-owned',
  encounter: { kind: 'yama_p3', seeds: {} },
};

beforeEach(() => {
  vi.mocked(getGameFrameRect).mockReset();
  vi.mocked(getGameFrameRect).mockReturnValue(BOUNDS);
});

afterEach(() => {
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
  vi.restoreAllMocks();
});

/**
 * Hand the replay clock to the live tick loop from now, as the loop does for a running fight.
 * Without it the recorder's idle clock holds at the newest frame, as it does while nothing runs.
 */
function startLiveClock(replay: { anchorLiveClock: (atMs: number, speedMultiplier: number) => void }, speed = 1) {
  replay.anchorLiveClock(animationFrames.clock.now(), speed);
}

function createHook() {
  const engine = new SimulationEngine({ encounter: encounterRegistry.create('yama_p3') });
  return renderHook(() =>
    useReplay({
      engineRef: { current: engine },
      simulationState: engine.getState(),
      speedMultiplier: 1,
      mechanicsConfig: { infiniteHealth: false },
      objTypeLoader: null,
      onTakeOver: vi.fn(),
    }),
  );
}

describe('useReplay render failures', () => {
  afterEach(() => {
    setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
    vi.restoreAllMocks();
  });

  it('does not restart playback when the automatic rewind publishes a render failure', () => {
    const { result } = createHook();
    const state = result.current.displayState;
    act(() => {
      result.current.startRun(RUN_CONFIG, state);
      result.current.recordFrame(1, state.playerPosition, { ...state, currentTick: 1 }, []);
      result.current.controlProps.onEnterReplay();
    });
    const store = result.current.replayFrameStore;
    const unsubscribe = store.subscribe(() => {
      if (store.getSnapshot().playheadMs === 0 && !store.getRenderFailure())
        store.failRender(store.getRenderEpoch(), {
          error: new Error('Replay rendering failed'),
          frameIndex: 0,
          playheadMs: 0,
        });
    });
    try {
      act(() => result.current.controlProps.onPlayPause());
      expect(result.current.controlProps.isPlaying).toBe(false);
      expect(result.current.controlProps.playbackError).not.toBeNull();
    } finally {
      unsubscribe();
    }
  });

  it.each([
    false,
    true,
  ])('latches a render failure once while playing=%s and blocks failed-history controls', async (playing) => {
    const engine = new SimulationEngine({ encounter: encounterRegistry.create('yama_p3') });
    const engineRef = { current: engine };
    const onPause = vi.fn();
    const onTakeOver = vi.fn();
    const { result } = renderHook(() =>
      useReplay({
        engineRef,
        simulationState: engine.getState(),
        speedMultiplier: 1,
        mechanicsConfig: { infiniteHealth: false },
        objTypeLoader: null,
        onPause,
        onTakeOver,
      }),
    );
    act(() => {
      result.current.startRun(engine.getRunConfig(), engine.getState());
      result.current.recordFrame(1, [29, 34], { ...engine.getState(), currentTick: 1 }, []);
      result.current.controlProps.onEnterReplay();
      result.current.controlProps.onSeek(0);
    });
    if (playing) act(() => result.current.controlProps.onPlayPause());
    const store = result.current.replayFrameStore;
    const history = store.getSnapshot().history;
    const recording = result.current.exportReplayData();
    const error = new Error('Replay rendering failed');

    act(() => store.failRender(store.getRenderEpoch(), { error, frameIndex: 0, playheadMs: 0 }));
    await act(async () => {
      const controls = result.current.controlProps;
      controls.onPlayPause();
      controls.onSeek(1);
      controls.onPreviewSeek(1);
      controls.onStepForward();
      controls.onJumpToEnd();
      await controls.onTakeOver();
      store.failRender(store.getRenderEpoch(), { error, frameIndex: 1, playheadMs: 600 });
    });

    expect(result.current.controlProps.playbackError).not.toBeNull();
    expect(result.current.controlProps.isPlaying).toBe(false);
    expect(result.current.controlProps.replayFrameIndex).toBe(0);
    expect(store.getSnapshot().history).toBe(history);
    expect(store.getSnapshot().preview).toBeUndefined();
    expect(result.current.exportReplayData()).toEqual(recording);
    expect(engineRef.current).toBe(engine);
    expect(onTakeOver).not.toHaveBeenCalled();
    expect(onPause).toHaveBeenCalledTimes(1);

    act(() => result.current.controlProps.onExitReplay());
    expect(result.current.controlProps.playbackError).toBeNull();
    act(() => result.current.loadExternalReplay(recording));
    expect(store.getRenderFailure()).toBeUndefined();
    act(() => result.current.controlProps.onSeek(1));
    expect(result.current.controlProps.replayFrameIndex).toBe(1);
  });
});

describe('useReplay menu capture', () => {
  it('does not expose imported XP events as live history after exiting an external replay', () => {
    const { result } = createHook();
    const liveState = result.current.displayState;
    act(() => result.current.startRun(RUN_CONFIG, liveState));
    const imported = new ReplayRecorder();
    imported.startRun(RUN_CONFIG);
    imported.recordFrame(0, liveState.playerPosition, liveState, [], 0);
    imported.recordFrame(
      1,
      liveState.playerPosition,
      { ...liveState, currentTick: 1 },
      [{ type: 'xp_drop', eventId: 987, tick: 1, skills: [{ skill: 'attack', amount: 42 }], predictedHit: 10 }],
      600,
    );
    act(() => result.current.loadExternalReplay(imported.exportData()));
    expect(result.current.displayHistory[1].events).toHaveLength(1);

    act(() => result.current.controlProps.onExitReplay());

    expect(result.current.replayMode).toBe(false);
    expect(
      result.current.displayHistory.flatMap((frame) => frame.events).filter((event) => event.type === 'xp_drop'),
    ).toEqual([]);
    act(() => result.current.recordFrame(1, liveState.playerPosition, { ...liveState, currentTick: 1 }, []));
    expect(result.current.displayHistory.map((frame) => frame.state.currentTick)).toEqual([0, 1]);
  });

  it('releases externally loaded history on reset without clearing a subsequently started live run', () => {
    const { result } = createHook();
    const liveState = result.current.displayState;
    const imported = new ReplayRecorder();
    imported.startRun(RUN_CONFIG);
    imported.recordFrame(10, liveState.playerPosition, { ...liveState, currentTick: 10 }, [], 0);
    act(() => result.current.loadExternalReplay(imported.exportData()));

    act(() => result.current.resetReplay());

    expect(result.current.displayHistory).toHaveLength(0);
    expect(result.current.controlProps.hasRecording).toBe(false);
    act(() => result.current.loadExternalReplay(imported.exportData()));
    act(() => result.current.startRun(RUN_CONFIG, liveState));
    const started = result.current.displayHistory;
    act(() => result.current.resetReplay());
    expect(result.current.displayHistory).toBe(started);
    expect(result.current.displayHistory.map((frame) => frame.state.currentTick)).toEqual([0]);
  });

  const menu: ReplayMenuState = {
    entries: [{ action: 'Walk here' }],
    x: 10,
    y: 20,
    scale: 1,
    hoveredIndex: -1,
    submenuParentIndex: -1,
    hoveredSubmenuIndex: -1,
    submenuPosition: null,
  };

  afterEach(() => {
    publishLiveReplayMenuState(null);
    vi.restoreAllMocks();
  });

  it('captures the opening menu and hover changes without rerendering the hook', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    publishLiveReplayMenuState(menu);
    const { result } = createHook();
    act(() => result.current.startRun(RUN_CONFIG, result.current.displayState));
    startLiveClock(result.current);
    const rendered = result.current;
    now.mockReturnValue(1100);

    act(() => publishLiveReplayMenuState({ ...menu, hoveredIndex: 0 }));

    expect(result.current).toBe(rendered);
    expect(result.current.exportReplayData().menuEvents).toMatchObject([
      { kind: 'open', tMs: 0, state: menu },
      { kind: 'update', tMs: 100, view: { hoveredIndex: 0 } },
    ]);
  });

  it('publishes the menu timeline and duration, and ignores live menu changes during playback', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    publishLiveReplayMenuState(null);
    const { result } = createHook();
    act(() => result.current.startRun(RUN_CONFIG, result.current.displayState));
    startLiveClock(result.current);
    now.mockReturnValue(1100);
    act(() => publishLiveReplayMenuState(menu));

    act(() => result.current.controlProps.onEnterReplay());

    expect(result.current.replayPlayheadMs).toBe(100);
    expect(result.current.replayFrameStore.getMenuState()).toEqual(menu);
    const recorded = result.current.exportReplayData().menuEvents;
    act(() => publishLiveReplayMenuState(null));
    expect(result.current.exportReplayData().menuEvents).toEqual(recorded);
    now.mockReturnValue(1200);
    act(() => result.current.controlProps.onExitReplay());
    expect(result.current.exportReplayData().menuEvents?.at(-1)).toEqual({ kind: 'close', tMs: 200 });
  });
});

describe('useReplay background recording clock', () => {
  afterEach(() => {
    cleanup();
    animationFrames.setSuspended(false);
    animationFrames.clock.reset();
    publishLiveReplayMenuState(null);
    __resetKeyStateForTest();
  });

  it.each([
    0.5, 1, 2,
  ])('excludes repeated pauses from every ancillary track and preserves native event times at %sx', (speedMultiplier) => {
    let nowMs = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const engine = new SimulationEngine({ encounter: encounterRegistry.create('yama_p3') });
    const presentation = ReplayPresentationStateSchema.parse(validPresentationSample().state);
    const camera: ReplayViewportState = {
      kind: 'orbit3d',
      pitchDeg: -45,
      yawDeg: 270,
      fovScale: 512,
      target: { x: 31.5, y: 37.5, z: 0.9 },
    };
    const { result } = renderHook(() =>
      useReplay({
        engineRef: { current: engine },
        simulationState: engine.getState(),
        speedMultiplier,
        mechanicsConfig: { infiniteHealth: false },
        objTypeLoader: null,
        onTakeOver: vi.fn(),
      }),
    );
    act(() => result.current.startRun(engine.getRunConfig(), engine.getState()));
    startLiveClock(result.current, speedMultiplier);
    nowMs = 1000 + 450 / speedMultiplier;
    animationFrames.setSuspended(true);
    nowMs += 60_000;
    act(() => result.current.recordPresentationState(presentation));
    expect(result.current.exportReplayData().presentationSamples?.at(-1)?.tMs).toBe(450);
    animationFrames.setSuspended(false);
    nowMs += 10 / speedMultiplier;
    animationFrames.setSuspended(true);
    nowMs += 120_000;
    animationFrames.setSuspended(false);
    nowMs = 181_000 + 500 / speedMultiplier;
    const event = new MouseEvent('pointermove', { clientX: 25, clientY: 35 });
    Object.defineProperty(event, 'timeStamp', { value: 1000 + 425 / speedMultiplier });
    act(() => {
      window.dispatchEvent(event);
      result.current.recordCursorClick(30, 40, 'ui', performance.timeOrigin + 181_000 + 475 / speedMultiplier);
      result.current.recordViewportSample(undefined, camera);
      result.current.recordPresentationState({ ...presentation, insets: { left: 20, right: 20 } });
      publishLiveReplayMenuState({
        entries: [{ action: 'Walk here' }],
        x: 10,
        y: 20,
        scale: 1,
        hoveredIndex: -1,
        submenuParentIndex: -1,
        hoveredSubmenuIndex: -1,
        submenuPosition: null,
      });
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true }));
    });
    const recording = result.current.exportReplayData();
    expect(recording.cursorSamples[0]?.tMs).toBe(425);
    expect(recording.cursorClicks[0]?.tMs).toBe(475);
    expect(recording.viewportSamples.at(-1)?.tMs).toBe(500);
    expect(recording.presentationSamples?.at(-1)?.tMs).toBe(500);
    expect(recording.menuEvents?.at(-1)?.tMs).toBe(500);
    expect(recording.modifierSamples?.at(-1)).toMatchObject({ tMs: 500, mask: MODIFIER_BIT.shift });
  });
});

describe('useReplay cursor bounds snapshots', () => {
  it('reads current presentation once while keeping real game-frame bounds for moves and clicks', () => {
    const frame = { left: 258, top: 109, width: 765, height: 503 };
    vi.mocked(getGameFrameRect).mockReturnValue(frame);
    const engine = new SimulationEngine({ encounter: encounterRegistry.create('yama_p3') });
    const baseline = ReplayPresentationStateSchema.parse(validPresentationSample().state);
    let presentation: ReplayPresentationState = { ...baseline, frame: { width: 765, height: 503 } };
    const getPresentationState = vi.fn(() => presentation);
    const { result } = renderHook(() =>
      useReplay({
        engineRef: { current: engine },
        simulationState: engine.getState(),
        speedMultiplier: 1,
        mechanicsConfig: { infiniteHealth: false },
        objTypeLoader: null,
        onTakeOver: vi.fn(),
        getPresentationState,
      }),
    );
    act(() => result.current.startRun(RUN_CONFIG, engine.getState()));
    presentation = {
      ...presentation,
      insets: { left: 20, right: 20 },
      workspace: { width: 765, height: 503 },
    };
    const event = new MouseEvent('pointermove', { clientX: 300, clientY: 209 });
    Object.defineProperty(event, 'getCoalescedEvents', {
      value: () => [
        new MouseEvent('pointermove', { clientX: 400, clientY: 209 }),
        new MouseEvent('pointermove', { clientX: 300, clientY: 209 }),
        new MouseEvent('pointermove', { clientX: 268, clientY: 209 }),
      ],
    });
    getPresentationState.mockClear();
    vi.mocked(getGameFrameRect).mockClear();

    act(() => {
      window.dispatchEvent(event);
      result.current.recordCursorClick(400, 209, 'ui');
    });

    expect(getPresentationState).toHaveBeenCalledTimes(2);
    expect(getGameFrameRect).toHaveBeenCalledTimes(2);
    expect(result.current.cursorTrack.samples).toMatchObject([
      { x: 142, y: 100, insideFrame: true },
      { x: 42, y: 100, insideFrame: true },
      { x: 10, y: 100, insideFrame: false },
      { x: 142, y: 100, insideFrame: true, pinned: true },
    ]);
    expect(result.current.cursorTrack.clicks).toMatchObject([{ x: 142, y: 100, insideFrame: true, type: 'ui' }]);
  });

  it('keeps the dedicated camera track authoritative when pointermove captures cursor positions', () => {
    const engine = new SimulationEngine({ encounter: encounterRegistry.create('yama_p3') });
    const camera: ReplayViewportState = {
      kind: 'orbit3d',
      pitchDeg: -45,
      yawDeg: 270,
      fovScale: 512,
      target: { x: 31.5, y: 37.5, z: 0.9 },
    };
    const getReplayViewportState = vi.fn(() => camera);
    const { result } = renderHook(() =>
      useReplay({
        engineRef: { current: engine },
        simulationState: engine.getState(),
        speedMultiplier: 1,
        mechanicsConfig: { infiniteHealth: false },
        objTypeLoader: null,
        onTakeOver: vi.fn(),
        getReplayViewportState,
      }),
    );
    act(() => result.current.startRun(RUN_CONFIG, engine.getState()));
    getReplayViewportState.mockClear();

    act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 20 })));

    expect(getReplayViewportState).not.toHaveBeenCalled();
    expect(result.current.cursorTrack.samples.at(-1)).not.toHaveProperty('viewportState');
    expect(result.current.viewportTrack.samples.at(-1)?.viewportState).toEqual(camera);
  });

  it('reads bounds once for one outer pointermove with multiple coalesced samples', () => {
    const { result } = createHook();
    act(() => result.current.startRun(RUN_CONFIG, result.current.displayState));
    const event = new MouseEvent('pointermove', { clientX: 30, clientY: 40 });
    Object.defineProperty(event, 'getCoalescedEvents', {
      configurable: true,
      value: vi.fn(() => [
        new MouseEvent('pointermove', { clientX: 10, clientY: 20 }),
        new MouseEvent('pointermove', { clientX: 20, clientY: 30 }),
        new MouseEvent('pointermove', { clientX: 30, clientY: 40 }),
      ]),
    });

    act(() => window.dispatchEvent(event));

    expect(getGameFrameRect).toHaveBeenCalledOnce();
    expect(result.current.cursorTrack.samples).toEqual([
      { tMs: expect.any(Number), x: 10, y: 20, insideFrame: true },
      { tMs: expect.any(Number), x: 30, y: 40, insideFrame: true },
    ]);
  });

  it('keeps the public click API unchanged while reading one bounds snapshot', () => {
    const { result } = createHook();
    act(() => result.current.startRun(RUN_CONFIG, result.current.displayState));

    act(() => result.current.recordCursorClick(50, 60, 'red'));

    expect(getGameFrameRect).toHaveBeenCalledOnce();
    expect(result.current.cursorTrack.clicks).toEqual([
      { tMs: expect.any(Number), x: 50, y: 60, insideFrame: true, type: 'red' },
    ]);
  });

  it('records a click without re-rendering the hook, and replay and export still see it', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const { result } = createHook();
    act(() => result.current.startRun(RUN_CONFIG, result.current.displayState));
    const rendered = result.current;

    act(() => result.current.recordCursorClick(50, 60, 'yellow', 1400));

    // A re-render here re-renders the whole App on every click and tap.
    expect(result.current).toBe(rendered);
    expect(result.current.exportReplayData().cursorClicks).toMatchObject([{ x: 50, y: 60, type: 'yellow' }]);
    now.mockReturnValue(1500);
    act(() => result.current.controlProps.onEnterReplay());
    expect(result.current.cursorTrack.clicks).toMatchObject([{ x: 50, y: 60, type: 'yellow' }]);
    now.mockRestore();
  });
});

describe('useReplay core playback', () => {
  // The module mock and its beforeEach live at the top of this file; a second copy here
  // would be hoisted out of this describe anyway (vitest warns on it) and reset the same
  // spy twice.

  function makeState(tick: number): SimulationState {
    return {
      currentTick: tick,
      groundItems: [],
      playerPosition: [31, 37],
      playerPreviousPosition: [31, 37],
      playerMovementPath: [],
      playerFacingAngle: 0,
      playerIsMoving: false,
      playerIsRunning: false,
      primaryNpcPosition: [29, 28],
      primaryNpcPreviousPosition: [29, 28],
      primaryNpcFacingAngle: 0,
      primaryNpcSize: 5,
      npcs: [],
      encounter: yamaSnapshot(),
      encounterOutcome: { phase: 'active' },
      isAlive: true,
      markOfDarknessActive: false,
      markOfDarknessTicksRemaining: 0,
      activePrayer: null,
      boostPrayers: [],
      independentPrayers: [],
      failedCondition: null,
      playerHistory: new Map(),
      primaryNpcHistory: new Map(),
      playerHP: 99,
      maxHP: 99,
      poisonVarp: 0,
      poisonTickCounter: POISON_TICK_INTERVAL,
      damageHistory: [],
      eventLog: [],
      stats: createDefaultStats(),
      specialAttack: createDefaultSpecialAttack(),
      combatTimers: createDefaultTimers(),
      inventory: createEmptyInventory(),
      isRunEnabled: true,
      isSpecialAttackActive: false,
      pendingSpecialAttackToggles: 0,
      pendingProtectionPrayer: [false, null],
      pendingBoostPrayers: [false, []],
      pendingIndependentPrayers: [false, []],
      quickPrayersActive: false,
      runEnergy: createDefaultRunEnergy(),
      equipmentStats: createEmptyEquipmentStats(),
      prayerState: createDefaultPrayerState(),
      playerEquipment: {},
      playerCombatSupplies: createEmptyCombatSupplies(),
      cooldownTracks: { food: 0, potion: 0, combo_food: 0 },
      mechanicsConfig: { infiniteHealth: false },
      attackTarget: null,
      lastAttackTarget: null,
      selectedAttackStyleIndex: 0,
      playerAttackCooldown: 0,
      playerNextAttackTick: -1,
      playerAttackSpeed: 4,
      introActive: false,
    };
  }

  function makeEvent(eventId: number, tick: number, type: string): GameEvent {
    return { eventId, tick, type };
  }

  function makeRunConfig(): EngineRunConfig {
    return {
      completionOwnership: 'encounter-owned',
      encounter: {
        kind: 'yama_p3',
        seeds: {},
      },
    };
  }

  function makeOrbitViewportState(yawDeg: number): ReplayViewportState {
    return {
      kind: 'orbit3d',
      pitchDeg: -45,
      yawDeg,
      fovScale: 512,
      target: { x: 31.5, y: 37.5, z: 0.9 },
    };
  }

  function createHook(liveMechanicsConfig: MechanicsConfig = { infiniteHealth: false }, speedMultiplier = 1) {
    const engineRef = { current: { isTutorialPaused: () => false, getState: () => makeState(0) } as SimulationEngine };
    const onTakeOver = vi.fn();
    const onEnterReplay = vi.fn();
    const onExitReplay = vi.fn();
    const onSeek = vi.fn();
    const onPause = vi.fn();
    const onResume = vi.fn();
    const onPlaybackEnd = vi.fn();

    const hook = renderHook(
      ({ playbackHeld }) =>
        useReplay({
          engineRef,
          simulationState: makeState(0),
          speedMultiplier,
          mechanicsConfig: liveMechanicsConfig,
          objTypeLoader: null,
          onTakeOver,
          onEnterReplay,
          onExitReplay,
          onSeek,
          onPause,
          onResume,
          onPlaybackEnd,
          playbackHeld,
        }),
      { initialProps: { playbackHeld: false } },
    );

    return {
      ...hook,
      onTakeOver,
      onEnterReplay,
      onExitReplay,
      onSeek,
      onPause,
      onResume,
      onPlaybackEnd,
    };
  }

  function seedRecording(
    result: { current: ReturnType<typeof useReplay> },
    frames: Array<{ tick: number; input: Coordinate; state: SimulationState; events: GameEvent[] }>,
  ): void {
    act(() => {
      result.current.startRun(makeRunConfig(), makeState(0));
      for (const frame of frames) {
        result.current.recordFrame(frame.tick, frame.input, frame.state, frame.events);
      }
    });
  }

  describe('replay chapters', () => {
    const INFERNO_RUN_CONFIG: EngineRunConfig = {
      completionOwnership: 'encounter-owned',
      encounter: { kind: 'inferno', seeds: { runSeed: 1 } },
    };
    function infernoState(tick: number, wave: number, phase: 'countdown' | 'active'): SimulationState {
      return {
        ...makeState(tick),
        encounter: {
          kind: 'inferno',
          state: {
            wave,
            startWave: 1,
            startDestroyedPillars: { west: false, south: false, northEast: false },
            startSpawnLayout: '',
            startPlayerTile: '',
            waveSpawnLayout: '',
            waveStartDestroyedPillars: { west: false, south: false, northEast: false },
            waveStartPlayerTile: null,
            phase,
            nextWaveTick: phase === 'countdown' ? tick + 1 : null,
            pillars: [],
            zuk: null,
          },
          visuals: { pillarLocs: [], zukControlTick: null },
        },
      };
    }
    /** Wave 1's countdown (ticks 0-1), its fight (2-4), then wave 2's countdown (5-6) and fight (7). */
    function recordInfernoRun(result: { current: ReturnType<typeof useReplay> }): void {
      const script = ['countdown', 'countdown', 'active', 'active', 'active'] as const;
      const states = [
        ...script.map((phase, tick) => infernoState(tick, 1, phase)),
        infernoState(5, 2, 'countdown'),
        infernoState(6, 2, 'countdown'),
        infernoState(7, 2, 'active'),
      ];
      act(() => {
        result.current.startRun(INFERNO_RUN_CONFIG, states[0]);
        for (const state of states.slice(1)) {
          result.current.recordFrame(state.currentTick, state.playerPosition, state, []);
        }
      });
    }

    it('derives the recording’s waves only once replay opens, in display-frame indices', () => {
      const { result } = createHook();
      recordInfernoRun(result);
      expect(result.current.controlProps.chapters).toBeNull();

      act(() => result.current.controlProps.onEnterReplay());

      const chapters = result.current.controlProps.chapters;
      expect(chapters?.title).toBe('Waves');
      expect(chapters?.chapters).toMatchObject([
        { label: 'Wave 1', startFrame: 0, engageFrame: 2, endFrame: 5, cleared: true, attempt: 1 },
        { label: 'Wave 2', startFrame: 5, engageFrame: 7, endFrame: 8, cleared: false, attempt: 1 },
      ]);
      expect(result.current.controlProps.totalFrames).toBe(8);
      // Playback re-renders the hook every tick; the chapters must not be derived again.
      act(() => result.current.controlProps.onSeek(6));
      expect(result.current.controlProps.chapters).toBe(chapters);
    });

    it('names none for an encounter without chapters', () => {
      const { result } = createHook();
      seedRecording(
        result,
        [1, 2].map((tick) => ({ tick, input: [31, 37] satisfies Coordinate, state: makeState(tick), events: [] })),
      );
      act(() => result.current.controlProps.onEnterReplay());

      expect(result.current.replayMode).toBe(true);
      expect(result.current.controlProps.chapters).toBeNull();
    });
  });

  describe('useReplay', () => {
    /**
     * Takeover reconstructs a run by re-simulating it, so these drive a REAL engine rather than
     * the synthetic `makeState` frames the playback tests use. A hand-built frame cannot be
     * reconstructed by definition — no engine run produces it — so asserting takeover against one
     * would only ever prove that the fixture matches itself.
     */
    function recordRealRun(options: {
      ticks: number;
      encounter?: Pick<EncounterSetupConfig, 'kind' | 'options'>;
      viewerMechanics?: MechanicsConfig;
      recordedMechanics?: Partial<MechanicsConfig>;
      equipment?: PlayerEquipment;
      openingAction?: EngineAction;
      /** Parses as a bootstrap but blows up inside the rebuild, like a corrupted recording. */
      corruptBootstrap?: boolean;
      actionAt?: (tick: number) => EngineAction | undefined;
      beforeTick?: (engine: SimulationEngine, tick: number) => void;
      getPresentationState?: () => ReplayPresentationState;
    }) {
      // A retired kind (`zuk`) records as the encounter that owns it, at its run setup, as entering does.
      const entry = resolveEncounterEntry(options.encounter?.kind ?? 'yama_p3');
      const engine = createSimulationEngineForNewRun({
        encounterConfig: {
          ...options.encounter,
          kind: entry?.kind ?? 'yama_p3',
          mechanics: { ...entry?.mechanics, ...(options.recordedMechanics ?? { infiniteHealth: true }) },
        },
        enableIntro: false,
        stats: createDefaultStats(),
        inventory: createEmptyInventory(),
        equipment: options.equipment ?? {},
        combatSupplies: createEmptyCombatSupplies(),
        attackStylePerCategory: {},
        combatSeed: 0x1234abcd,
      });
      const engineRef = { current: engine };
      const onTakeOver = vi.fn();
      const onRetryFight = vi.fn();
      const onPause = vi.fn();
      const hook = renderHook(() =>
        useReplay({
          engineRef,
          simulationState: engineRef.current.getState(),
          onRetryFight,
          onPause,
          speedMultiplier: 1,
          mechanicsConfig: options.viewerMechanics ?? { infiniteHealth: true },
          objTypeLoader: null,
          onTakeOver,
          getPresentationState: options.getPresentationState,
        }),
      );
      act(() => {
        const runConfig = engine.getRunConfig();
        hook.result.current.startRun(
          options.corruptBootstrap
            ? ({ ...runConfig, bootstrap: { ...runConfig.bootstrap, baseStats: {} } } as typeof runConfig)
            : runConfig,
          engine.getState(),
        );
        if (options.openingAction) {
          hook.result.current.recordAction(options.openingAction);
          engine.applyAction(options.openingAction);
        }
        for (let tick = 1; tick <= options.ticks; tick++) {
          options.beforeTick?.(engine, tick);
          const action = options.actionAt?.(tick);
          if (action) {
            hook.result.current.recordAction(action);
            engine.applyAction(action);
          }
          const target = engine.getState().playerPosition;
          engine.advanceTick(target);
          hook.result.current.recordFrame(
            engine.getState().currentTick,
            target,
            engine.getState(),
            engine.getLastTickEvents(),
          );
        }
        hook.result.current.controlProps.onEnterReplay();
      });
      return { ...hook, engine, engineRef, onTakeOver, onRetryFight, onPause };
    }

    describe('replay practice', () => {
      async function finishRestore(result: { current: ReturnType<typeof useReplay> }) {
        await waitFor(() => expect(result.current.replayPractice.busy).toBe(false));
      }

      /** Practice tick `tick` (frame index == tick in these runs): the engine restores `tick − 1`. */
      async function establishPracticeAttempt(run: ReturnType<typeof recordRealRun>, tick: number, replaying = true) {
        const end = run.engineRef.current.currentTick;
        act(() => run.result.current.controlProps.onSeek(tick));
        await act(async () => {
          await run.result.current.replayPractice.onStartPractice();
        });
        expect(run.result.current.replayPractice.startTick).toBe(tick);
        expect(run.engineRef.current.currentTick).toBe(tick - 1);
        act(() => {
          while (run.engineRef.current.currentTick < end) {
            const engine = run.engineRef.current;
            const previousTick = engine.currentTick;
            const input = engine.getState().playerPosition;
            engine.advanceTick(input);
            expect(engine.currentTick).toBe(previousTick + 1);
            run.result.current.recordFrame(engine.currentTick, input, engine.getState(), engine.getLastTickEvents());
          }
        });
        run.rerender();
        if (replaying) act(() => run.result.current.controlProps.onEnterReplay());
        run.onTakeOver.mockClear();
      }

      it('plain Take over at tick 6 restores tick 5 without creating a restart point', async () => {
        const { result, engineRef } = recordRealRun({ ticks: 20 });
        act(() => result.current.controlProps.onSeek(6));
        const position = result.current.replayFrameStore.getSnapshot();
        let pending: Promise<void> | undefined;
        act(() => {
          pending = result.current.controlProps.onTakeOver();
        });
        expect(result.current.replayPractice.startFrameIndex).toBeNull();
        expect(result.current.replayFrameStore.getSnapshot()).toMatchObject({
          playheadMs: position.playheadMs,
          preview: { frameIndex: 5, completedBoundary: true },
        });
        await act(async () => {
          await pending;
        });
        expect(engineRef.current.currentTick).toBe(5);
        expect(result.current.restoredPresentation).toMatchObject({
          tick: 5,
          timeMs: 6 * 600,
          history: { throughFrameIndex: 5 },
        });
        expect(result.current.displayHistory).toHaveLength(6);
        expect(result.current.replayMode).toBe(false);
        expect(result.current.replayPractice.startTick).toBeNull();
        expect(result.current.replayPractice.startFrameIndex).toBeNull();
        expect(result.current.replayFrameStore.getSnapshot().preview).toBeUndefined();
      });

      it('Practice pauses and previews the completed predecessor, then atomically adopts it and establishes the point', async () => {
        const run = recordRealRun({ ticks: 20 });
        await establishPracticeAttempt(run, 4);
        const { result, engineRef, onRetryFight, onPause, onTakeOver } = run;
        act(() => result.current.controlProps.onSeek(12));
        const recording = result.current.exportReplayData();
        const engine = engineRef.current;
        const descriptor = result.current.restoredPresentation;
        const fork = vi.spyOn(ReplayRecorder.prototype, 'forkAt');
        act(() => result.current.controlProps.onPlayPause());
        const position = result.current.replayFrameStore.getSnapshot();
        onPause.mockClear();
        let pending: Promise<void> | undefined;
        act(() => {
          pending = result.current.replayPractice.onStartPractice();
        });
        expect(result.current.controlProps.isPlaying).toBe(false);
        expect(result.current.displayState.currentTick).toBe(12);
        expect(result.current.replayPractice.startTick).toBe(4);
        expect(result.current.replayPractice.startFrameIndex).toBe(4);
        expect(result.current.replayMode).toBe(true);
        expect(result.current.replayFrameStore.getSnapshot()).toMatchObject({
          playheadMs: position.playheadMs,
          viewportState: position.viewportState,
          preview: { frameIndex: 11, completedBoundary: true },
        });
        expect(result.current.restoredPresentation).toBe(descriptor);
        expect(result.current.replayPractice.busy).toBe(true);
        expect(onPause).toHaveBeenCalledOnce();
        act(() => {
          void result.current.replayPractice.onStartPractice();
        });
        expect(onPause).toHaveBeenCalledOnce();
        expect(fork).not.toHaveBeenCalled();
        expect(onTakeOver).not.toHaveBeenCalled();
        expect(engineRef.current).toBe(engine);
        expect(onRetryFight).not.toHaveBeenCalled();
        expect(result.current.exportReplayData()).toEqual(recording);
        expect(engineRef.current.currentTick).toBe(20);
        await act(async () => {
          await pending;
        });
        expect(engineRef.current).not.toBe(engine);
        expect(engineRef.current.currentTick).toBe(11);
        expect(result.current.replayMode).toBe(false);
        expect(result.current.replayPractice.startFrameIndex).toBe(12);
        expect(result.current.replayPractice.startTick).toBe(12);
        expect(fork).toHaveBeenCalledOnce();
        expect(onTakeOver).toHaveBeenCalledOnce();
        expect(result.current.restoredPresentation).not.toBe(descriptor);
        expect(result.current.replayPractice.practiceUnavailableReason).not.toBeNull();
        await act(async () => {
          await result.current.replayPractice.onStartPractice();
        });
        expect(result.current.replayPractice.startTick).toBe(12);
        act(() => result.current.replayPractice.onClearStart());
        expect(result.current.replayPractice.startTick).toBeNull();
        expect(engineRef.current.currentTick).toBe(11);
        act(() => result.current.replayPractice.onRetry());
        expect(onRetryFight).toHaveBeenCalledOnce();
      });

      it('recovers a terminal current tick even when the engine sits on the fixed anchor', async () => {
        const { result, engineRef } = recordRealRun({ ticks: 1 });
        act(() => result.current.controlProps.onSeek(1));
        await act(async () => {
          await result.current.replayPractice.onStartPractice();
        });
        expect(engineRef.current.currentTick).toBe(0);
        expect(result.current.controlProps.totalFrames).toBe(1);
        const terminal = { ...engineRef.current.getState(), isAlive: false };
        vi.spyOn(engineRef.current, 'getState').mockReturnValue(terminal);
        act(() => result.current.replayPractice.onRetry());
        await finishRestore(result);
        expect(engineRef.current.getState().isAlive).toBe(true);
        expect(engineRef.current.currentTick).toBe(0);
        expect(result.current.replayPractice.startTick).toBe(1);
      });

      it.each([
        'death',
        'victory',
      ] as const)('retries a fixed start from %s and preserves it across repeated exact forks', async (outcome) => {
        const run = recordRealRun({ ticks: 20 });
        await establishPracticeAttempt(run, 10);
        const { result, engineRef, rerender } = run;
        // Tick 10 is played, so the restored state is recorded tick 9.
        act(() => result.current.controlProps.onSeek(9));
        const recordedTarget = result.current.displayState;
        act(() => {
          result.current.controlProps.onExitReplay();
          const state = engineRef.current.getState();
          const terminalState: SimulationState = {
            ...state,
            ...(outcome === 'death'
              ? { isAlive: false }
              : {
                  encounterOutcome: {
                    phase: 'victory',
                    decisiveTick: state.currentTick,
                    completionTick: state.currentTick,
                    primaryActorId: 'yama',
                    completionActorIds: ['yama'],
                  },
                }),
          };
          vi.spyOn(engineRef.current, 'getState').mockReturnValue(terminalState);
          result.current.recordFrame(20, state.playerPosition, terminalState, []);
          result.current.replayPractice.onRetry();
        });
        await finishRestore(result);
        expect(result.current.replayPractice.startTick).toBe(10);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          act(() => {
            for (let tick = 0; tick < 4; tick += 1) {
              const engine = engineRef.current;
              const input = engine.getState().playerPosition;
              engine.advanceTick(input);
              result.current.recordFrame(engine.currentTick, input, engine.getState(), engine.getLastTickEvents());
            }
          });
          rerender();
          act(() => result.current.replayPractice.onRetry());
          await finishRestore(result);
          expect(engineRef.current.currentTick).toBe(9);
          expect(diffResumableState(recordedTarget, engineRef.current.getState())).toEqual([]);
          expect(result.current.replayPractice.startTick).toBe(10);
          expect(result.current.replayPractice.message).toBeNull();
        }
        // Retry on the untouched anchor still rebuilds it; only an overlapping press is refused.
        const reconstruct = vi.spyOn(engineFactory, 'reconstructReplayPrefix');
        act(() => {
          result.current.replayPractice.onRetry();
          result.current.replayPractice.onRetry();
        });
        await finishRestore(result);
        expect(reconstruct).toHaveBeenCalledOnce();
        expect(engineRef.current.currentTick).toBe(9);
        expect(diffResumableState(recordedTarget, engineRef.current.getState())).toEqual([]);
        expect(result.current.replayPractice.message).toBeNull();
      });

      it('opens Change at the saved frame in ordinary paused replay, and an earlier successful takeover clears it', async () => {
        const run = recordRealRun({ ticks: 20 });
        await establishPracticeAttempt(run, 6, false);
        const { result, engineRef, onTakeOver } = run;
        const recording = result.current.exportReplayData();
        act(() => result.current.replayPractice.onChangeStart());
        expect(result.current.replayPractice.startTick).toBe(6);
        expect(result.current.displayState.currentTick).toBe(6);
        expect(result.current.exportReplayData()).toEqual(recording);
        expect(engineRef.current.currentTick).toBe(20);
        expect(onTakeOver).not.toHaveBeenCalled();
        act(() => result.current.controlProps.onSeek(15));
        expect(result.current.replayPractice.startTick).toBe(6);
        expect(result.current.replayPractice.startTick).toBe(6);
        expect(result.current.exportReplayData()).toEqual(recording);
        expect(result.current.controlProps.isPlaying).toBe(false);
        act(() => result.current.replayPractice.onChangeStart());
        expect(result.current.displayState.currentTick).toBe(6);
        act(() => result.current.controlProps.onSeek(4));
        await act(async () => {
          await result.current.controlProps.onTakeOver();
        });
        // Anchor 3 is earlier than the point's anchor 5, so the point is gone.
        expect(result.current.replayPractice.startTick).toBeNull();
        expect(result.current.replayPractice.startFrameIndex).toBeNull();
        expect(engineRef.current.currentTick).toBe(3);
        expect(onTakeOver).toHaveBeenCalledOnce();
      });

      it('starts Practice from the committed numeric seek instead of an uncommitted drag preview before React commits', async () => {
        const { result, engineRef } = recordRealRun({ ticks: 20 });
        let pending: Promise<void> | undefined;
        act(() => {
          result.current.controlProps.onSeek(4);
          result.current.controlProps.onPreviewSeek(12);
          pending = result.current.replayPractice.onStartPractice();
        });
        expect(result.current.displayState.currentTick).toBe(4);
        expect(result.current.replayPractice.startTick).toBeNull();
        expect(result.current.replayFrameStore.getSnapshot().preview).toMatchObject({
          frameIndex: 3,
          completedBoundary: true,
        });
        await act(async () => {
          await pending;
        });
        expect(result.current.replayPractice.startTick).toBe(4);
        expect(result.current.replayPractice.startFrameIndex).toBe(4);
        expect(engineRef.current.currentTick).toBe(3);
      });

      it.each([
        [2, false],
        [4, false],
        [8, false],
        [2, true],
        [8, true],
      ] as const)('takes over frame %s with existing point 4 atomically, reconstruction refused=%s', async (candidate, refused) => {
        const run = recordRealRun({ ticks: 20 });
        await establishPracticeAttempt(run, 4);
        const { result, engineRef, onTakeOver } = run;
        const originalPresentation = result.current.restoredPresentation;
        if (refused) vi.spyOn(engineFactory, 'reconstructReplayPrefix').mockReturnValue(null);
        act(() => result.current.controlProps.onSeek(12));
        const recording = result.current.exportReplayData();
        const engine = engineRef.current;
        let pending: Promise<void> | undefined;
        act(() => {
          result.current.controlProps.onSeek(candidate);
          pending = result.current.controlProps.onTakeOver();
          void result.current.replayPractice.onStartPractice();
          result.current.replayPractice.onClearStart();
        });
        expect(result.current.replayPractice.startTick).toBe(4);
        expect(result.current.replayPractice.message).toBe('Restoring tick…');
        expect(result.current.replayPractice.error).toBeNull();
        await act(async () => {
          await pending;
        });
        const expectedPoint = !refused && candidate < 4 ? null : 4;
        expect(result.current.replayPractice.startTick).toBe(expectedPoint);
        expect(result.current.replayPractice.startFrameIndex).toBe(expectedPoint);
        expect(result.current.replayMode).toBe(refused);
        if (refused) {
          expect(result.current.restoredPresentation).toBe(originalPresentation);
          expect(result.current.replayPractice.error).toContain('could not be restored exactly');
          expect(result.current.replayPractice.message).toBeNull();
          expect(result.current.replayPractice.busy).toBe(false);
          expect(engineRef.current).toBe(engine);
          expect(result.current.exportReplayData()).toEqual(recording);
          expect(onTakeOver).not.toHaveBeenCalled();
          expect(result.current.replayPractice.startTick).toBe(4);
        } else {
          // Anchors are compared: candidate 4 forks at 3, the point's own anchor, and keeps it.
          expect(result.current.restoredPresentation).toMatchObject({
            engine: engineRef.current,
            tick: candidate - 1,
            timeMs: candidate * 600,
            history: { throughFrameIndex: candidate - 1 },
          });
          expect(result.current.restoredPresentation?.history.frames).toBe(result.current.displayHistory);
          expect(result.current.replayPractice.message).toBeNull();
          expect(result.current.replayPractice.error).toBeNull();
          expect(engineRef.current.currentTick).toBe(candidate - 1);
          expect(result.current.exportReplayData().frames).toHaveLength(candidate);
          expect(onTakeOver).toHaveBeenCalledOnce();
          if (candidate < 4) {
            act(() => {
              while (engineRef.current.currentTick < 4) {
                const input = engineRef.current.getState().playerPosition;
                engineRef.current.advanceTick(input);
                result.current.recordFrame(
                  engineRef.current.currentTick,
                  input,
                  engineRef.current.getState(),
                  engineRef.current.getLastTickEvents(),
                );
              }
            });
            run.rerender();
            expect(result.current.replayPractice.startTick).toBeNull();
          }
        }
      });

      it.each([
        false,
        true,
      ])('Practice replaces an existing point only after successful adoption, refused=%s', async (refused) => {
        const run = recordRealRun({ ticks: 20 });
        await establishPracticeAttempt(run, 4);
        const { result, engineRef } = run;
        const engine = engineRef.current;
        const recording = result.current.exportReplayData();
        if (refused) vi.spyOn(engineFactory, 'reconstructReplayPrefix').mockReturnValue(null);
        act(() => result.current.controlProps.onSeek(2));
        let pending: Promise<void> | undefined;
        act(() => {
          pending = result.current.replayPractice.onStartPractice();
        });
        expect(result.current.replayPractice.startFrameIndex).toBe(4);
        await act(async () => {
          await pending;
        });
        expect(result.current.replayPractice.startFrameIndex).toBe(refused ? 4 : 2);
        expect(result.current.replayPractice.startTick).toBe(refused ? 4 : 2);
        expect(result.current.replayMode).toBe(refused);
        if (refused) {
          expect(engineRef.current).toBe(engine);
          expect(result.current.exportReplayData()).toEqual(recording);
        } else expect(engineRef.current.currentTick).toBe(1);
      });

      it('refuses a duplicate tick by index, then retries the saved anchor before tick T exists again', async () => {
        const run = recordRealRun({ ticks: 3 });
        await establishPracticeAttempt(run, 2, false);
        const { result, engineRef } = run;
        const liveFrameTicks = result.current.controlProps.frameTicks;
        expect(Object.isFrozen(liveFrameTicks)).toBe(true);
        const state = engineRef.current.getState();
        act(() => result.current.recordFrame(3, state.playerPosition, state, []));
        run.rerender();
        expect(result.current.controlProps.frameTicks).toBe(liveFrameTicks);
        expect(result.current.controlProps.frameTicks).toEqual([]);
        act(() => result.current.controlProps.onEnterReplay());
        expect(result.current.controlProps.frameTicks).toEqual([0, 1, 2, 3, 3]);
        act(() => result.current.controlProps.onSeek(4));
        // A duplicate idle snapshot is not tick T with a T−1 before it; never reinterpret it.
        expect(result.current.controlProps.takeOverUnavailableReason).toBe('nonconsecutive-tick');
        expect(result.current.replayPractice.practiceUnavailableReason).toBe(
          TAKE_OVER_UNAVAILABLE_TEXT['nonconsecutive-tick'],
        );
        const reconstruct = vi.spyOn(engineFactory, 'reconstructReplayPrefix');
        await act(async () => {
          await result.current.replayPractice.onStartPractice();
          await result.current.controlProps.onTakeOver();
        });
        expect(reconstruct).not.toHaveBeenCalled();
        expect(result.current.replayPractice.startFrameIndex).toBe(2);
        expect(result.current.replayPractice.startTick).toBe(2);
        act(() => result.current.replayPractice.onChangeStart());
        expect(result.current.controlProps.replayFrameIndex).toBe(2);
        act(() => result.current.controlProps.onExitReplay());
        const previous = engineRef.current;
        act(() => result.current.replayPractice.onRetry());
        await finishRestore(result);
        expect(reconstruct).toHaveBeenCalledOnce();
        expect(reconstruct.mock.calls[0]?.[2]).toBe(1);
        expect(engineRef.current).not.toBe(previous);
        expect(engineRef.current.currentTick).toBe(1);
        // Frame 2 does not exist on this branch yet; the point is still labeled 2.
        expect(result.current.controlProps.totalFrames).toBe(2);
        expect(result.current.replayPractice.startFrameIndex).toBe(2);
        expect(result.current.replayPractice.startTick).toBe(2);
        reconstruct.mockClear();
        // Live on the anchor with tick 2 still to run, Retry still rebuilds it from the saved anchor.
        act(() => result.current.replayPractice.onRetry());
        await finishRestore(result);
        expect(reconstruct).toHaveBeenCalledOnce();
        expect(reconstruct.mock.calls[0]?.[2]).toBe(1);
        expect(engineRef.current.currentTick).toBe(1);
        reconstruct.mockClear();
        // From replay, Retry rebuilds the anchor again without needing frame 2.
        act(() => result.current.controlProps.onEnterReplay());
        act(() => result.current.replayPractice.onRetry());
        await finishRestore(result);
        expect(reconstruct).toHaveBeenCalledOnce();
        expect(reconstruct.mock.calls[0]?.[2]).toBe(1);
        expect(engineRef.current.currentTick).toBe(1);
        expect(result.current.replayPractice.startTick).toBe(2);
        // Change shows the retained anchor until the branch records tick 2.
        act(() => result.current.replayPractice.onChangeStart());
        expect(result.current.controlProps.replayFrameIndex).toBe(1);
        expect(result.current.replayPractice.startFrameIndex).toBe(2);
      });

      it('Retry at the live anchor discards a same-tick attack style change and queued run toggle', async () => {
        const run = recordRealRun({ ticks: 20 });
        const { result, engineRef, onTakeOver } = run;
        const recordedTarget = result.current.exportReplayData().frames[4]?.state;
        act(() => result.current.controlProps.onSeek(4));
        await act(async () => {
          await result.current.replayPractice.onStartPractice();
        });
        expect(result.current.replayMode).toBe(false);
        expect(engineRef.current.currentTick).toBe(3);
        const anchor = engineRef.current.getState();
        const adopted = engineRef.current;
        onTakeOver.mockClear();
        // Auto-advance off: both inputs land on the engine and recorder without a tick running.
        const styleIndex = anchor.selectedAttackStyleIndex === 1 ? 2 : 1;
        act(() => {
          result.current.recordAction({ type: 'attackStyleChange', index: styleIndex });
          engineRef.current.setSelectedAttackStyleIndex(styleIndex);
          result.current.recordAction({ type: 'runToggle' });
          engineRef.current.queueRunToggle();
        });
        expect(engineRef.current.currentTick).toBe(3);
        expect(engineRef.current.getState().selectedAttackStyleIndex).toBe(styleIndex);

        act(() => result.current.replayPractice.onRetry());
        await finishRestore(result);

        expect(onTakeOver).toHaveBeenCalledOnce();
        expect(engineRef.current).not.toBe(adopted);
        expect(engineRef.current.currentTick).toBe(3);
        expect(diffResumableState(anchor, engineRef.current.getState())).toEqual([]);
        expect(result.current.replayPractice.startTick).toBe(4);
        // Tick 4 runs as recorded: neither discarded input reaches the engine or the recording.
        act(() => {
          const engine = engineRef.current;
          const input = engine.getState().playerPosition;
          engine.advanceTick(input);
          result.current.recordFrame(engine.currentTick, input, engine.getState(), engine.getLastTickEvents());
        });
        expect(engineRef.current.getState().isRunEnabled).toBe(recordedTarget?.isRunEnabled);
        expect(engineRef.current.getState().selectedAttackStyleIndex).toBe(recordedTarget?.selectedAttackStyleIndex);
        expect(result.current.exportReplayData().frames[4]?.actions).toEqual([]);
      });

      it('clears only point metadata without changing the live engine/history, and resets point metadata on recording replacement', async () => {
        const run = recordRealRun({ ticks: 20 });
        await establishPracticeAttempt(run, 20, false);
        const { result, engineRef, onTakeOver } = run;
        const recording = result.current.exportReplayData();
        const engine = engineRef.current;
        act(() => result.current.replayPractice.onClearStart());
        expect(result.current.replayPractice.startTick).toBeNull();
        expect(result.current.replayPractice.message).toBeNull();
        expect(result.current.replayMode).toBe(false);
        expect(result.current.replayPractice.busy).toBe(false);
        expect(engineRef.current).toBe(engine);
        expect(result.current.exportReplayData()).toEqual(recording);
        expect(onTakeOver).not.toHaveBeenCalled();
        act(() => result.current.controlProps.onEnterReplay());
        await act(async () => {
          await result.current.replayPractice.onStartPractice();
        });
        expect(result.current.replayPractice.startFrameIndex).toBe(20);
        act(() => result.current.loadExternalReplay(recording));
        expect(result.current.replayPractice.startTick).toBeNull();
        await act(async () => {
          await result.current.replayPractice.onStartPractice();
        });
        act(() => result.current.resetReplay());
        expect(result.current.replayPractice.startFrameIndex).toBeNull();
      });

      it('validates the recorded boundary before adopting the latest viewer mechanics after yielding', async () => {
        const options = { ticks: 20, viewerMechanics: { infiniteHealth: true } as MechanicsConfig };
        const { result, engineRef, onTakeOver, rerender } = recordRealRun(options);
        act(() => result.current.controlProps.onSeek(3));
        const recordedBoundary = result.current.displayState;
        act(() => result.current.controlProps.onSeek(4));
        let pending: Promise<void> | undefined;
        act(() => {
          pending = result.current.controlProps.onTakeOver();
        });
        options.viewerMechanics = { infiniteHealth: false, fireballStart: 'horizontal' };
        rerender();
        await act(async () => {
          await pending;
        });
        expect(engineRef.current.getMechanicsConfig().infiniteHealth).toBe(false);
        expect(engineRef.current.getMechanicsConfig().fireballStart).toBe('horizontal');
        expect(diffResumableState(recordedBoundary, onTakeOver.mock.calls[0]?.[1])).toEqual([]);
      });

      it('clears starts on recording replacement and reset, canceling stale queued restoration', async () => {
        const run = recordRealRun({ ticks: 20 });
        await establishPracticeAttempt(run, 20);
        const { result, onTakeOver } = run;
        const data = result.current.exportReplayData();
        act(() => result.current.controlProps.onSeek(4));
        let pending: Promise<void> | undefined;
        act(() => {
          pending = result.current.controlProps.onTakeOver();
        });
        act(() => result.current.loadExternalReplay(data));
        const replacementPreview = { frameIndex: 1, state: data.frames[1].state, events: data.frames[1].events };
        act(() => result.current.replayFrameStore.setPreview(replacementPreview));
        await act(async () => {
          await pending;
        });
        expect(onTakeOver).not.toHaveBeenCalled();
        expect(result.current.replayFrameStore.getSnapshot().preview).toBe(replacementPreview);
        expect(result.current.replayPractice.startTick).toBeNull();
        act(() => result.current.controlProps.onSeek(1));
        await act(async () => {
          await result.current.replayPractice.onStartPractice();
        });
        expect(result.current.replayPractice.startTick).toBe(1);
        act(() => result.current.resetReplay());
        expect(result.current.replayPractice.startTick).toBeNull();
      });

      it('does not mutate a fixed start or recording on reconstruction failure and rejects reentry', async () => {
        const run = recordRealRun({ ticks: 20 });
        await establishPracticeAttempt(run, 4);
        const { result, engineRef, onTakeOver } = run;
        const originalPresentation = result.current.restoredPresentation;
        act(() => result.current.controlProps.onSeek(12));
        const before = result.current.exportReplayData();
        const engine = engineRef.current;
        const reconstruct = vi.spyOn(engineFactory, 'reconstructReplayPrefix').mockImplementation(() => {
          throw new Error('cannot reconstruct');
        });
        let pending: Promise<void> | undefined;
        act(() => {
          pending = result.current.controlProps.onTakeOver();
          void result.current.controlProps.onTakeOver();
          result.current.replayPractice.onRetry();
        });
        await act(async () => {
          await pending;
        });
        expect(reconstruct).toHaveBeenCalledOnce();
        expect(result.current.replayPractice.startTick).toBe(4);
        expect(result.current.exportReplayData()).toEqual(before);
        expect(engineRef.current).toBe(engine);
        expect(onTakeOver).not.toHaveBeenCalled();
        expect(result.current.replayPractice.error).toContain('could not be restored exactly');
        expect(result.current.replayPractice.message).toBeNull();
        expect(result.current.replayPractice.busy).toBe(false);
        expect(result.current.restoredPresentation).toBe(originalPresentation);
        reconstruct.mockRestore();
        act(() => {
          pending = result.current.controlProps.onTakeOver();
        });
        expect(result.current.replayPractice.error).toBeNull();
        expect(result.current.replayPractice.message).toBe('Restoring tick…');
        expect(result.current.controlProps.takeOverError).toBeNull();
        await act(async () => {
          await pending;
        });
        expect(result.current.replayPractice.error).toBeNull();
        expect(result.current.replayPractice.message).toBeNull();
        expect(engineRef.current.currentTick).toBe(11);
      });

      it.each([
        'clear',
        'replacement',
        'reset',
      ] as const)('clears a genuine failure on point %s without leaving stale status', async (action) => {
        const run = recordRealRun({ ticks: 20 });
        await establishPracticeAttempt(run, 4);
        const { result, engineRef } = run;
        act(() => result.current.controlProps.onSeek(12));
        const recording = result.current.exportReplayData();
        const engine = engineRef.current;
        vi.spyOn(engineFactory, 'reconstructReplayPrefix').mockReturnValue(null);
        await act(async () => {
          await result.current.controlProps.onTakeOver();
        });
        expect(result.current.replayPractice.error).not.toBeNull();
        expect(result.current.replayPractice.message).toBeNull();
        expect(result.current.replayPractice.startFrameIndex).toBe(4);
        act(() => {
          if (action === 'clear') result.current.replayPractice.onClearStart();
          else if (action === 'replacement') result.current.loadExternalReplay(recording);
          else result.current.resetReplay();
        });
        expect(result.current.replayPractice.error).toBeNull();
        expect(result.current.replayPractice.message).toBeNull();
        expect(result.current.controlProps.takeOverError).toBeNull();
        expect(result.current.replayPractice.startFrameIndex).toBeNull();
        expect(engineRef.current).toBe(engine);
      });

      it('keeps a failed live retry visible across simulation ticks, then clears it on replay entry', async () => {
        const run = recordRealRun({ ticks: 12 });
        await establishPracticeAttempt(run, 4, false);
        const { result, engineRef } = run;
        vi.spyOn(engineFactory, 'reconstructReplayPrefix').mockReturnValue(null);
        act(() => result.current.replayPractice.onRetry());
        await finishRestore(result);
        const error = result.current.replayPractice.error;
        expect(error).toContain('could not be restored exactly');

        act(() => {
          const engine = engineRef.current;
          const input = engine.getState().playerPosition;
          engine.advanceTick(input);
          result.current.recordFrame(engine.currentTick, input, engine.getState(), engine.getLastTickEvents());
        });
        run.rerender();
        expect(result.current.replayPractice.error).toBe(error);
        act(() => result.current.controlProps.onEnterReplay());
        expect(result.current.replayPractice.error).toBeNull();
        expect(result.current.controlProps.takeOverError).toBeNull();
      });

      it('removes only its failed endpoint preview and preserves the original fractional paused playhead and camera', async () => {
        vi.spyOn(performance, 'now').mockReturnValue(1000);
        const run = recordRealRun({ ticks: 20 });
        await establishPracticeAttempt(run, 4);
        const { result, engineRef } = run;
        let scheduled: FrameRequestCallback | undefined;
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
          scheduled = callback;
          return 1;
        });
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
        act(() => result.current.controlProps.onSeek(6));
        act(() => result.current.controlProps.onPlayPause());
        act(() => scheduled?.(1150));
        act(() => result.current.controlProps.onPlayPause());
        const camera: ReplayViewportState = {
          kind: 'orbit3d',
          pitchDeg: -35,
          yawDeg: 90,
          fovScale: 512,
          target: { x: 30, y: 30, z: 1 },
        };
        act(() => result.current.replayFrameStore.set(result.current.replayPlayheadMs, camera));
        const before = result.current.replayFrameStore.getSnapshot();
        expect(before.playheadMs).toBe(3750);
        const recording = result.current.exportReplayData();
        const engine = engineRef.current;
        vi.spyOn(engineFactory, 'reconstructReplayPrefix').mockImplementation(() => {
          throw new Error('refused');
        });
        let pending: Promise<void> | undefined;
        act(() => {
          pending = result.current.controlProps.onTakeOver();
        });
        expect(result.current.replayFrameStore.getSnapshot().preview).toMatchObject({
          frameIndex: 5,
          completedBoundary: true,
        });
        await act(async () => {
          await pending;
        });
        const after = result.current.replayFrameStore.getSnapshot();
        expect(after.preview).toBeUndefined();
        expect(after.playheadMs).toBe(before.playheadMs);
        expect(after.viewportState).toBe(camera);
        expect(after.history).toBe(before.history);
        expect(result.current.replayPlayheadMs).toBe(before.playheadMs);
        expect(result.current.controlProps.replayFrameIndex).toBe(6);
        expect(result.current.controlProps.isPlaying).toBe(false);
        expect(result.current.replayPractice.startFrameIndex).toBe(4);
        expect(result.current.exportReplayData()).toEqual(recording);
        expect(engineRef.current).toBe(engine);
      });

      it('does not clear a newer preview owned by another publisher when a restoration fails', async () => {
        const { result } = recordRealRun({ ticks: 8 });
        act(() => result.current.controlProps.onSeek(4));
        vi.spyOn(engineFactory, 'reconstructReplayPrefix').mockReturnValue(null);
        let pending: Promise<void> | undefined;
        act(() => {
          pending = result.current.controlProps.onTakeOver();
        });
        const replacement = {
          frameIndex: 6,
          state: result.current.displayHistory[6].state,
          events: result.current.displayHistory[6].events,
        };
        act(() => result.current.replayFrameStore.setPreview(replacement));
        await act(async () => {
          await pending;
        });
        expect(result.current.replayFrameStore.getSnapshot().preview).toBe(replacement);
        expect(result.current.replayMode).toBe(true);
        expect(result.current.replayPractice.startFrameIndex).toBeNull();
      });

      it('refuses the first recorded tick quietly, in replay and out of it, without reconstruction', async () => {
        const { result, onTakeOver } = recordRealRun({ ticks: 3 });
        act(() => result.current.controlProps.onSeek(0));
        expect(result.current.controlProps.takeOverUnavailableReason).toBe('first-tick');
        expect(result.current.replayPractice.practiceUnavailableReason).toBe(TAKE_OVER_UNAVAILABLE_TEXT['first-tick']);
        const reconstruct = vi.spyOn(engineFactory, 'reconstructReplayPrefix');
        await act(async () => {
          await result.current.controlProps.onTakeOver();
          await result.current.replayPractice.onStartPractice();
        });
        expect(result.current.replayMode).toBe(true);
        expect(result.current.replayPractice.startTick).toBeNull();
        act(() => result.current.controlProps.onExitReplay());
        act(() => result.current.replayPractice.onClearStart());
        expect(result.current.replayPractice.message).toBeNull();
        await act(async () => {
          await result.current.controlProps.onTakeOver();
        });
        expect(result.current.replayPractice.message).toBeNull();
        expect(result.current.replayPractice.startTick).toBeNull();
        expect(reconstruct).not.toHaveBeenCalled();
        expect(onTakeOver).not.toHaveBeenCalled();
      });

      it.each([
        ['an intro predecessor', 'fight-start', 0],
        ['an intro selected frame', 'intro-frame', 1],
      ] as const)('refuses %s without reconstruction', async (_label, reason, introFrame) => {
        const { result, onTakeOver } = recordRealRun({ ticks: 3 });
        const data = result.current.exportReplayData();
        const frames = data.frames.map((frame, index) =>
          index <= introFrame ? { ...frame, state: { ...frame.state, introActive: true } } : frame,
        );
        act(() => result.current.loadExternalReplay({ ...data, frames }));
        act(() => result.current.controlProps.onSeek(1));
        expect(result.current.controlProps.takeOverUnavailableReason).toBe(reason);
        const reconstruct = vi.spyOn(engineFactory, 'reconstructReplayPrefix');
        await act(async () => {
          await result.current.controlProps.onTakeOver();
          await result.current.replayPractice.onStartPractice();
        });
        expect(reconstruct).not.toHaveBeenCalled();
        expect(onTakeOver).not.toHaveBeenCalled();
        expect(result.current.replayMode).toBe(true);
        // Once the predecessor is past the intro, the boundary is ordinary again.
        act(() => result.current.controlProps.onSeek(introFrame + 2));
        expect(result.current.controlProps.takeOverUnavailableReason).toBeNull();
      });

      it('uses simulation ticks rather than frame numbers and rejects noninteger seeks', () => {
        const { result } = recordRealRun({ ticks: 2 });
        const data = result.current.exportReplayData();
        const frames = data.frames.map((frame, index) => ({
          ...frame,
          state: { ...frame.state, currentTick: 40 + index * 3 },
        }));
        act(() => result.current.loadExternalReplay({ ...data, frames }));
        expect(result.current.controlProps.frameTicks).toEqual([40, 43, 46]);
        act(() => result.current.controlProps.onSeek(1));
        expect(result.current.displayState.currentTick).toBe(43);
        expect(result.current.replayPractice.startTick).toBeNull();
        // A gap is refused, not reinterpreted as a different predecessor.
        expect(result.current.controlProps.takeOverUnavailableReason).toBe('nonconsecutive-tick');
        for (const invalid of [NaN, Infinity, 0.5]) act(() => result.current.controlProps.onSeek(invalid));
        expect(result.current.controlProps.replayFrameIndex).toBe(1);
      });
    });

    it('reconstructs without exporting a clone and releases its limits before live continuation', async () => {
      const { result, engineRef, onTakeOver } = recordRealRun({ ticks: 1 });
      const exportData = vi.spyOn(ReplayRecorder.prototype, 'exportData').mockImplementation(() => {
        throw new Error('Guard: cloned full recording');
      });
      const reconstruct = engineFactory.reconstructReplayPrefix;
      vi.spyOn(engineFactory, 'reconstructReplayPrefix').mockImplementation((config, frames, index, loader) =>
        reconstruct(config, frames, index, loader, new ReplayTakeoverWork({ maxTicks: 1, maxActions: 0 })),
      );

      await act(async () => await result.current.controlProps.onTakeOver());

      expect(exportData).not.toHaveBeenCalled();
      expect(onTakeOver).toHaveBeenCalledOnce();
      engineRef.current.applyAction({ type: 'runToggle' });
      engineRef.current.advanceTick(engineRef.current.getState().playerPosition);
      // Restored tick 0, so the first live tick is the selected tick 1.
      expect(engineRef.current.currentTick).toBe(1);
    });

    it('does not take over when the completed preflight preview publishes a render failure', async () => {
      const { result, engine, engineRef, onTakeOver } = recordRealRun({ ticks: 1 });
      act(() => result.current.controlProps.onPreviewSeek(0));
      const store = result.current.replayFrameStore;
      let failed = false;
      const unsubscribe = store.subscribe(() => {
        if (failed || !store.getSnapshot().preview?.completedBoundary) return;
        failed = true;
        store.failRender(store.getRenderEpoch(), {
          error: new Error('Replay rendering failed'),
          frameIndex: 1,
          playheadMs: 0,
        });
      });
      try {
        await act(async () => await result.current.controlProps.onTakeOver());
        expect(onTakeOver).not.toHaveBeenCalled();
        expect(engineRef.current).toBe(engine);
        expect(result.current.controlProps.playbackError).not.toBeNull();
      } finally {
        unsubscribe();
      }
    });

    it('rejects repeated oversized takeover attempts without constructing or publishing an engine', async () => {
      const { result, engine, engineRef, onTakeOver } = recordRealRun({
        ticks: 1,
        encounter: { kind: 'zuk' },
      });
      const recording = result.current.exportReplayData();
      const baseline = recording.frames[0];
      const action = { type: 'encounterCommand', command: { encounter: 'zuk', type: 'spawn-healers' } } as const;
      const data = {
        ...recording,
        frames: [
          baseline,
          ...Array.from({ length: 256 }, (_, index) => ({
            ...baseline,
            startMs: (index + 1) * 600,
            state: { ...baseline.state, currentTick: index + 1 },
            actions: Array.from({ length: 256 }, () => action),
          })),
        ],
      };
      act(() => result.current.loadExternalReplay(data));
      act(() => result.current.controlProps.onSeek(256));
      const before = result.current.exportReplayData();
      const history = result.current.replayFrameStore.getSnapshot().history;
      const liveState = engine.getState();
      const create = vi.spyOn(encounterRegistry, 'create').mockImplementation(() => {
        throw new Error('Guard: unchecked constructor');
      });
      const fork = vi.spyOn(ReplayRecorder.prototype, 'forkAt');

      await act(async () => await result.current.controlProps.onTakeOver());
      await act(async () => await result.current.controlProps.onTakeOver());

      expect(create).not.toHaveBeenCalled();
      expect(fork).not.toHaveBeenCalled();
      expect(onTakeOver).not.toHaveBeenCalled();
      expect(result.current.controlProps.takeOverError).toContain('limits');
      expect(result.current.controlProps.playbackError).toBeNull();
      expect(result.current.replayFrameStore.getSnapshot().history).toBe(history);
      expect(result.current.exportReplayData()).toEqual(before);
      expect(engineRef.current).toBe(engine);
      expect(engine.getState()).toEqual(liveState);
      create.mockRestore();
      act(() => result.current.loadExternalReplay(recording));
      act(() => result.current.controlProps.onSeek(1));
      await act(async () => await result.current.controlProps.onTakeOver());
      expect(onTakeOver).toHaveBeenCalledOnce();
    });

    it('refuses a bounded mid-prefix registration failure without forking or replacing the live engine', async () => {
      const { result, engine, engineRef, onTakeOver } = recordRealRun({
        ticks: 0,
        encounter: { kind: 'zuk' },
      });
      const recording = result.current.exportReplayData();
      const baseline = recording.frames[0];
      const data = {
        ...recording,
        frames: [
          baseline,
          {
            ...baseline,
            startMs: 600,
            state: { ...baseline.state, currentTick: 1 },
            actions: [{ type: 'encounterCommand', command: { encounter: 'zuk', type: 'spawn-healers' } } as const],
          },
          { ...baseline, startMs: 1200, state: { ...baseline.state, currentTick: 2 } },
        ],
      };
      act(() => result.current.loadExternalReplay(data));
      // Playing tick 2 rebuilds through frame 1, whose action trips the bound.
      act(() => result.current.controlProps.onSeek(2));
      const reconstruct = engineFactory.reconstructReplayPrefix;
      vi.spyOn(engineFactory, 'reconstructReplayPrefix').mockImplementation((config, frames, index, loader) =>
        reconstruct(config, frames, index, loader, new ReplayTakeoverWork({ maxNpcs: 3 })),
      );
      const fork = vi.spyOn(ReplayRecorder.prototype, 'forkAt');
      const before = result.current.exportReplayData();

      await act(async () => await result.current.controlProps.onTakeOver());

      expect(result.current.controlProps.takeOverError).toContain('limits');
      expect(onTakeOver).not.toHaveBeenCalled();
      expect(fork).not.toHaveBeenCalled();
      expect(engineRef.current).toBe(engine);
      expect(result.current.exportReplayData()).toEqual(before);
    });

    it.each([
      false,
      true,
    ])('refuses a takeover that cannot be reconstructed for corruptBootstrap=%s', async (corruptBootstrap) => {
      const { result, engine, engineRef, onTakeOver } = recordRealRun({ ticks: 1, corruptBootstrap });
      if (!corruptBootstrap) {
        const data = result.current.exportReplayData();
        act(() =>
          result.current.loadExternalReplay({
            ...data,
            frames: data.frames.map((frame) => ({
              ...frame,
              state: { ...frame.state, playerHP: frame.state.playerHP - 1 },
            })),
          }),
        );
        act(() => result.current.controlProps.onSeek(1));
      }
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const genericReports = vi.spyOn(log, 'error');

      await act(async () => await result.current.controlProps.onTakeOver());

      expect(genericReports).not.toHaveBeenCalled();
      expect(engineRef.current).toBe(engine);
      expect(onTakeOver).not.toHaveBeenCalled();
      expect(result.current.replayMode).toBe(true);
    });

    it('stays in replay when reconstruction throws unexpectedly', async () => {
      const { result, onTakeOver } = recordRealRun({ ticks: 1 });
      const error = new Error('Unexpected reconstruction failure');
      vi.spyOn(engineFactory, 'reconstructReplayPrefix').mockImplementationOnce(() => {
        throw error;
      });

      await act(async () => await result.current.controlProps.onTakeOver());

      expect(onTakeOver).not.toHaveBeenCalled();
      expect(result.current.replayMode).toBe(true);
    });

    it('reconstructs the tick before the selected one exactly, so the selected tick is the first played', async () => {
      const { result, onTakeOver } = recordRealRun({ ticks: 20 });

      // Read BEFORE taking over: once replay mode ends, `displayState` falls back to the live
      // engine and no longer describes the recorded frame.
      act(() => result.current.controlProps.onSeek(11));
      const displayed = result.current.displayState;
      act(() => result.current.controlProps.onSeek(12));
      await act(async () => await result.current.controlProps.onTakeOver());

      // Combat rolls are seeded from the run config, so this is exact rather than approximate —
      // an unseeded prefix re-rolled the whole fight and resumed on different HP entirely.
      expect(onTakeOver).toHaveBeenCalledTimes(1);
      const resumed: SimulationState = onTakeOver.mock.calls[0]?.[1];
      expect(diffResumableState(displayed, resumed)).toEqual([]);
    });

    it('retains constructor options when takeover applies the viewer live mechanics', async () => {
      const { result, onTakeOver } = recordRealRun({
        ticks: 20,
        encounter: { kind: 'yama_p3', options: { fixtureOption: 'recorded' } },
        viewerMechanics: { infiniteHealth: true, fireballs: false },
      });
      act(() => result.current.controlProps.onSeek(11));
      const displayed = result.current.displayState;
      act(() => result.current.controlProps.onSeek(12));

      await act(async () => await result.current.controlProps.onTakeOver());

      expect(onTakeOver).toHaveBeenCalledOnce();
      const rebuilt: SimulationEngine = onTakeOver.mock.calls[0]?.[0];
      expect(rebuilt.getState()).toMatchObject({
        currentTick: 11,
        encounter: { kind: displayed.encounter.kind, state: displayed.encounter.state },
      });
      expect(rebuilt.getRunConfig().bootstrap?.encounterConfig).toEqual({ fixtureOption: 'recorded' });
      expect(rebuilt.getMechanicsConfig().fireballs).toBe(false);
    });

    it.each([
      {
        kind: 'inferno',
        recorded: { infernoStartWave: '62', infernoSouthPillarDestroyed: true },
        viewer: { infernoStartWave: '1' },
      },
      { kind: 'zuk', recorded: { zukShieldStart: 'right' }, viewer: { zukShieldStart: 'left' } },
    ])('keeps the recorded $kind run setup when taking over at the opening boundary', async ({
      kind,
      recorded,
      viewer,
    }) => {
      const { result, onTakeOver } = recordRealRun({
        ticks: 16,
        encounter: { kind },
        recordedMechanics: { infiniteHealth: true, ...recorded },
        viewerMechanics: { infiniteHealth: true, ...viewer },
      });
      const recording = result.current.exportReplayData();
      const recordedStates = recording.frames.map((frame) => ({
        ...frame.state,
        damageHistory: recording.damageHistory.slice(0, frame.damageHistoryLength),
      }));
      act(() => result.current.controlProps.onSeek(1));

      await act(async () => await result.current.controlProps.onTakeOver());

      expect(onTakeOver).toHaveBeenCalledOnce();
      const candidate: unknown = onTakeOver.mock.calls[0]?.[0];
      if (!(candidate instanceof SimulationEngine)) throw new TypeError('Missing opening takeover engine');
      expect(candidate.currentTick).toBe(0);
      // The viewer's own setup was applied on tick 0, and the run's setup stays the recording's.
      expect(candidate.getMechanicsConfig()).toMatchObject(recorded);
      candidate.setMechanicsConfig({ infiniteHealth: true, ...viewer });
      for (let tick = 1; tick < recordedStates.length; tick++) {
        candidate.advanceTick(candidate.getState().playerPosition);
        expect(diffResumableState(recordedStates[tick], candidate.getState())).toEqual([]);
      }
      // A plain restart is a new attempt from the viewer's own setup.
      candidate.reset();
      expect(candidate.getMechanicsConfig()).toMatchObject(viewer);
    });

    it('takes over a real Zuk prefix before pending healing and preserves future heals and RNG draws', async () => {
      const mechanics = { infiniteHealth: true, zukAttacks: false, zukSets: true };
      const { result, engine, onTakeOver } = recordRealRun({
        ticks: 87,
        encounter: { kind: 'zuk' },
        recordedMechanics: mechanics,
        viewerMechanics: mechanics,
        actionAt: (tick) => {
          if (tick === 80) return { type: 'setBossHp', hp: 500 };
          if (tick === 81) return { type: 'encounterCommand', command: { encounter: 'zuk', type: 'spawn-healers' } };
          if (tick === 82)
            return { type: 'encounterCommand', command: { encounter: 'zuk', type: 'spawn-jad-healers' } };
          return undefined;
        },
      });
      const displayed = result.current.displayState;
      expect(displayed.encounter).toMatchObject({ state: { zuk: { setTimer: 342, timerPaused: true } } });
      expect(engine['worldState'].getNpcs().filter((actor) => actor.npcTypeId === 7703)).toHaveLength(1);
      act(() => result.current.controlProps.onSeek(86));
      const anchor = result.current.displayState;
      act(() => result.current.controlProps.onSeek(87));

      await act(async () => await result.current.controlProps.onTakeOver());

      expect(onTakeOver).toHaveBeenCalledOnce();
      const candidate: unknown = onTakeOver.mock.calls[0]?.[0];
      if (!(candidate instanceof SimulationEngine)) throw new TypeError('Missing Zuk takeover engine');
      expect(diffResumableState(anchor, candidate.getState())).toEqual([]);
      // The selected tick 87 is the first one the restored engine plays.
      candidate.advanceTick(candidate.getState().playerPosition);
      expect(diffResumableState(displayed, candidate.getState())).toEqual([]);
      const futureHeals: GameEvent[] = [];
      for (let tick = 88; tick <= 105; tick++) {
        engine.advanceTick(engine.getState().playerPosition);
        candidate.advanceTick(candidate.getState().playerPosition);
        const originalEvents = engine.getLastTickEvents().map(({ eventId: _eventId, ...event }) => event);
        const rebuiltEvents = candidate.getLastTickEvents().map(({ eventId: _eventId, ...event }) => event);
        expect(rebuiltEvents).toEqual(originalEvents);
        expect(diffResumableState(engine.getState(), candidate.getState())).toEqual([]);
        futureHeals.push(
          ...engine
            .getLastTickEvents()
            .filter((event) => event.type === 'hitsplat_spawned' && event.hitsplatType === 'heal'),
        );
      }
      expect(futureHeals.length).toBeGreaterThan(4);
      // The spawn commands land at the start of ticks 81 and 82, so the first heal follows on 89.
      expect(futureHeals[0]).toMatchObject({ tick: 89, targetId: 'zuk' });
      expect(engine['worldState'].getNpc('zuk')?.vitals.hp).toBeGreaterThan(600);
      expect(candidate.getEncounterSnapshot()).toMatchObject({
        state: { zuk: { setTimer: null, timerPaused: false } },
      });
    });

    it('continues the ordinary set clock across a real takeover immediately before the next admission', async () => {
      const mechanics = { infiniteHealth: true, zukAttacks: false, zukSets: true };
      const { result, engine, onTakeOver } = recordRealRun({
        ticks: 421,
        encounter: { kind: 'zuk' },
        recordedMechanics: mechanics,
        viewerMechanics: mechanics,
      });
      expect(result.current.displayState.encounter).toMatchObject({ state: { zuk: { setTimer: 1 } } });

      await act(async () => await result.current.controlProps.onTakeOver());

      const candidate: unknown = onTakeOver.mock.calls[0]?.[0];
      if (!(candidate instanceof SimulationEngine)) throw new TypeError('Missing set-clock takeover engine');
      // Restored at 420; replay the selected tick 421, then both cross the admission together.
      candidate.advanceTick(candidate.getState().playerPosition);
      expect(diffResumableState(engine.getState(), candidate.getState())).toEqual([]);
      for (const target of [engine, candidate]) target.advanceTick(target.getState().playerPosition);
      expect(diffResumableState(engine.getState(), candidate.getState())).toEqual([]);
      expect(
        candidate['worldState']
          .getNpcs()
          .filter((actor) => actor.npcTypeId === 7703)
          .map((actor) => actor.spawnTick),
      ).toEqual([72, 422]);
    });

    it.each([
      {},
      { encounterSeed: '7' },
      { encounterSeed: -1 },
      { encounterSeed: 0x100000000 },
    ])('leaves a recorded Zuk frame in replay when its seed is invalid: %j', async (seeds) => {
      const { result, engine, engineRef, onTakeOver } = recordRealRun({ ticks: 1 });
      const runConfig: EngineRunConfig = {
        ...engine.getRunConfig(),
        encounter: { kind: 'zuk', seeds },
      };
      const frame: SimulationState = {
        ...engine.getState(),
        encounter: {
          kind: 'zuk',
          state: {
            setTimer: 50,
            timerPaused: false,
            enraged: false,
            jadSpawned: false,
            shieldX: 30,
            shieldMovingEast: true,
            shieldNextX: 31,
          },
          visuals: {},
        },
      };
      act(() => {
        result.current.startRun(runConfig, frame);
        result.current.recordFrame(
          frame.currentTick + 1,
          frame.playerPosition,
          {
            ...frame,
            currentTick: frame.currentTick + 1,
          },
          [],
        );
        result.current.controlProps.onEnterReplay();
      });
      expect(result.current.controlProps.takeOverUnavailableReason).toBeNull();
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await act(async () => await result.current.controlProps.onTakeOver());

      expect(onTakeOver).not.toHaveBeenCalled();
      expect(engineRef.current).toBe(engine);
      expect(result.current.controlProps.takeOverError).not.toBeNull();
      expect(result.current.displayState.encounter).toEqual(frame.encounter);
    });

    it('reconstructs exactly through a fight the player is actually attacking in', async () => {
      // Given: a real weapon and a live attack target, so the reconstruction has to reproduce
      // accuracy rolls, damage rolls and on-hit passives — the seeded combat RNG, which an
      // unarmed run never exercises.
      const preset = Object.values(EQUIPMENT_PRESETS.yama_p3 ?? {}).find((entry) => !entry.isFallback);
      const { result, onTakeOver } = recordRealRun({
        ticks: 40,
        equipment: preset?.equipment ?? {},
        openingAction: { type: 'attackTarget', targetId: 'yama' },
      });

      act(() => result.current.controlProps.onSeek(30));
      const displayed = result.current.displayState;
      act(() => result.current.controlProps.onSeek(31));
      await act(async () => await result.current.controlProps.onTakeOver());

      // Guard: the run really did trade damage, or this proves nothing about combat rolls.
      expect(displayed.damageHistory.length).toBeGreaterThan(0);
      expect(onTakeOver).toHaveBeenCalledTimes(1);
      const resumed: SimulationState = onTakeOver.mock.calls[0]?.[1];
      expect(diffResumableState(displayed, resumed)).toEqual([]);
    });

    it('previews and restores only the predecessor: the selected tick events and damage stay unexecuted', async () => {
      const preset = Object.values(EQUIPMENT_PRESETS.yama_p3 ?? {}).find((entry) => !entry.isFallback);
      const { result, onTakeOver } = recordRealRun({
        ticks: 40,
        equipment: preset?.equipment ?? {},
        openingAction: { type: 'attackTarget', targetId: 'yama' },
      });
      const frames = result.current.exportReplayData().frames;
      const damageAt = (index: number) => {
        act(() => result.current.controlProps.onSeek(index));
        return result.current.displayState.damageHistory.length;
      };
      let selected = -1;
      for (let index = 2; index < frames.length && selected < 0; index++) {
        if ((frames[index]?.events.length ?? 0) > 0 && damageAt(index) > damageAt(index - 1)) selected = index;
      }
      // Guard: the selected tick really adds damage and events, or nothing could leak.
      expect(selected).toBeGreaterThan(1);
      act(() => result.current.controlProps.onSeek(selected - 1));
      const anchor = result.current.displayState;
      act(() => result.current.controlProps.onSeek(selected));
      const selectedEventIds = new Set(frames[selected]?.events.map((event) => event.eventId));
      let pending: Promise<void> | undefined;
      act(() => {
        pending = result.current.replayPractice.onStartPractice();
      });
      const preview = result.current.replayFrameStore.getSnapshot().preview;
      expect(preview).toMatchObject({ frameIndex: selected - 1, completedBoundary: true });
      expect(preview?.state.currentTick).toBe(anchor.currentTick);
      expect(preview?.state.damageHistory).toHaveLength(anchor.damageHistory.length);
      expect(preview?.events.some((event) => selectedEventIds.has(event.eventId))).toBe(false);
      await act(async () => {
        await pending;
      });
      const restored = result.current.restoredPresentation;
      expect(restored).toMatchObject({
        tick: anchor.currentTick,
        timeMs: (anchor.currentTick + 1) * 600,
        history: { throughFrameIndex: selected - 1 },
      });
      expect(restored?.history.frames).toHaveLength(selected);
      expect(
        restored?.history.frames.some((frame) => frame.events.some((event) => selectedEventIds.has(event.eventId))),
      ).toBe(false);
      const resumed: SimulationState = onTakeOver.mock.calls[0]?.[1];
      expect(resumed.damageHistory).toHaveLength(anchor.damageHistory.length);
      expect(diffResumableState(anchor, resumed)).toEqual([]);
      expect(result.current.replayPractice.startTick).toBe(frames[selected]?.state.currentTick);
    });

    it('reconstructs a run where gear was swapped mid-fight', async () => {
      // Given: the player takes their weapon off partway through the fight and puts it back on,
      // which is what an in-fight gear swap actually is — a pair of recorded engine actions.
      const preset = Object.values(EQUIPMENT_PRESETS.yama_p3 ?? {}).find((entry) => !entry.isFallback);
      const weaponId = preset?.equipment?.weapon;
      expect(weaponId).toBeDefined();
      const { result, onTakeOver } = recordRealRun({
        ticks: 30,
        equipment: preset?.equipment ?? {},
        openingAction: { type: 'attackTarget', targetId: 'yama' },
        actionAt: (tick) => {
          if (tick === 8) return { type: 'unequip', slot: 'weapon' };
          if (tick === 18) {
            return { type: 'equipFromInventory', inventoryIndex: 0, itemId: weaponId as number, slot: 'weapon' };
          }
          return undefined;
        },
      });

      // Guard: the swap really happened, or the test proves nothing.
      act(() => result.current.controlProps.onSeek(12));
      expect(result.current.displayState.playerEquipment.weapon).toBeUndefined();

      act(() => result.current.controlProps.onSeek(24));
      const displayed = result.current.displayState;
      expect(displayed.playerEquipment.weapon).toBe(weaponId);
      act(() => result.current.controlProps.onSeek(25));
      await act(async () => await result.current.controlProps.onTakeOver());

      expect(onTakeOver).toHaveBeenCalledTimes(1);
      const resumed: SimulationState = onTakeOver.mock.calls[0]?.[1];
      expect(diffResumableState(displayed, resumed)).toEqual([]);
    });

    it('leaves playback genuinely paused when a rebuild is refused', async () => {
      const { result, onTakeOver } = recordRealRun({ ticks: 12, corruptBootstrap: true });
      act(() => result.current.controlProps.onSeek(6));
      act(() => result.current.controlProps.onPlayPause());
      expect(result.current.controlProps.isPlaying).toBe(true);

      await act(async () => await result.current.controlProps.onTakeOver());

      // Then: the transport must not still read Pause over a loop that has already been killed —
      // that costs the viewer two clicks to start playing again.
      expect(onTakeOver).not.toHaveBeenCalled();
      expect(result.current.controlProps.isPlaying).toBe(false);
      expect(result.current.replayMode).toBe(true);
      expect(result.current.controlProps.takeOverError).toBeTruthy();
    });

    it('retires both restore errors once a committed seek leaves the failed frame', async () => {
      const { result } = recordRealRun({ ticks: 12, corruptBootstrap: true });
      act(() => result.current.controlProps.onSeek(6));
      await act(async () => await result.current.controlProps.onTakeOver());
      expect(result.current.controlProps.takeOverError).toBeTruthy();
      expect(result.current.replayPractice.error).toContain('could not be restored exactly');

      const error = result.current.replayPractice.error;
      act(() => result.current.controlProps.onPreviewSeek(9));
      expect(result.current.replayPractice.error).toBe(error);

      act(() => result.current.controlProps.onSeek(9));

      // Then: the message described that frame, so it must not outlive it.
      expect(result.current.controlProps.takeOverError).toBeNull();
      expect(result.current.replayPractice.error).toBeNull();
    });

    it('retires both restore errors once playback advances beyond the failed frame', async () => {
      const { result } = recordRealRun({ ticks: 12, corruptBootstrap: true });
      act(() => result.current.controlProps.onSeek(6));
      await act(async () => await result.current.controlProps.onTakeOver());
      expect(result.current.controlProps.takeOverError).toBeTruthy();
      expect(result.current.replayPractice.error).toContain('could not be restored exactly');

      const callbacks: FrameRequestCallback[] = [];
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => callbacks.push(callback));
      vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
      vi.spyOn(performance, 'now').mockReturnValue(1000);
      act(() => result.current.controlProps.onPlayPause());
      const store = result.current.replayFrameStore;
      store.acknowledgeRender(store.getRenderEpoch(), 6, store.getSnapshot().playheadMs);
      const tick = callbacks.at(-1);
      if (!tick) throw new Error('Expected replay playback animation frame callback');
      act(() => tick(1600));

      expect(result.current.controlProps.replayFrameIndex).toBe(7);
      expect(result.current.controlProps.takeOverError).toBeNull();
      expect(result.current.replayPractice.error).toBeNull();
    });

    it('retires both restore errors when Play rewinds from the replay end', async () => {
      const { result } = recordRealRun({ ticks: 12, corruptBootstrap: true });
      await act(async () => await result.current.controlProps.onTakeOver());
      expect(result.current.controlProps.takeOverError).toBeTruthy();
      expect(result.current.replayPractice.error).toContain('could not be restored exactly');

      act(() => result.current.controlProps.onPlayPause());
      expect(result.current.controlProps.replayFrameIndex).toBe(0);
      expect(result.current.controlProps.takeOverError).toBeNull();
      expect(result.current.replayPractice.error).toBeNull();
    });

    it('lands the resumed player on the tile the recording started from', async () => {
      // The encounter randomizes its landing tile and it is not derivable from the encounter
      // seeds, so a reconstruction that re-rolls it offsets the player for the whole prefix.
      const { result, engine, onTakeOver } = recordRealRun({ ticks: 8 });
      const recordedStart = engine.getRunConfig().bootstrap?.startPosition;

      await act(async () => {
        result.current.controlProps.onSeek(1);
        await result.current.controlProps.onTakeOver();
      });

      const rebuilt: SimulationEngine = onTakeOver.mock.calls[0]?.[0];
      expect(rebuilt.getRunConfig().bootstrap?.startPosition).toEqual(recordedStart);
    });

    it('resumes on the move target the restored tick used, so the player does not walk off', async () => {
      const { result, onTakeOver } = recordRealRun({ ticks: 10 });
      const anchorInput = result.current.exportReplayData().frames[5]?.input;

      act(() => result.current.controlProps.onSeek(6));
      await act(async () => await result.current.controlProps.onTakeOver());

      expect(anchorInput).toBeDefined();
      expect(onTakeOver.mock.calls[0]?.[3]).toEqual(anchorInput);
    });

    it('resumes on no move target from a tick that discarded it, as live play would', async () => {
      // The anchor's frame still records the target that tick was given. Busy on ticks 5 and 6,
      // started at 5, so the rebuilt engine must also carry the deadline past the anchor.
      const rules = YamaEncounter.prototype.getEngineRules;
      vi.spyOn(YamaEncounter.prototype, 'getEngineRules').mockImplementation(function (this: YamaEncounter) {
        const original = rules.call(this);
        return {
          ...original,
          onTickStart: (ctx) => {
            if (ctx.tick === 5) ctx.lockPlayerActionsUntil(7);
            return original?.onTickStart?.(ctx) ?? null;
          },
        };
      });
      const { result, onTakeOver } = recordRealRun({ ticks: 10 });
      expect(result.current.exportReplayData().frames[5]?.input).toBeDefined();

      act(() => result.current.controlProps.onSeek(6));
      await act(async () => await result.current.controlProps.onTakeOver());

      const rebuilt: SimulationEngine = onTakeOver.mock.calls[0]?.[0];
      expect(rebuilt.didLastTickDiscardWalkTarget()).toBe(true);
      expect(onTakeOver.mock.calls[0]?.[3]).toBeNull();

      // Tick 6 is still busy on the rebuilt engine; tick 7 walks.
      const anchor = rebuilt.getState().playerPosition;
      const north: [number, number] = [anchor[0], anchor[1] + 3];
      rebuilt.advanceTick(north);
      expect(rebuilt.currentTick).toBe(6);
      expect(rebuilt.didLastTickDiscardWalkTarget()).toBe(true);
      expect(rebuilt.getState().playerPosition).toEqual(anchor);
      rebuilt.advanceTick(north);
      expect(rebuilt.didLastTickDiscardWalkTarget()).toBe(false);
      expect(rebuilt.getState().playerPosition).not.toEqual(anchor);
    });

    it('takes over the tick the viewer scrubbed to, even before React commits the seek', async () => {
      // `seekTo` commits the frame index inside `startTransition`. Clicking Take Over in the same
      // act() therefore reads a React state that is still on the previous tick.
      const { result, onTakeOver } = recordRealRun({ ticks: 20 });
      act(() => result.current.controlProps.onSeek(15));
      const tickAtFrame15 = result.current.displayState.currentTick;
      act(() => result.current.controlProps.onSeek(0));

      // Both calls in ONE act: React has not committed the seek when Take Over runs.
      await act(async () => {
        result.current.controlProps.onSeek(15);
        await result.current.controlProps.onTakeOver();
      });

      const resumed: SimulationState = onTakeOver.mock.calls[0]?.[1];
      // Tick 15 is the first played, so the restored state is the one before it.
      expect(resumed.currentTick).toBe(tickAtFrame15 - 1);
    });

    it('lets the viewer replay a death tick from its playable predecessor, but not a tick after it', async () => {
      const { result, onTakeOver, engine, engineRef } = recordRealRun({ ticks: 6 });

      act(() => {
        const state = engine.getState();
        result.current.recordFrame(7, state.playerPosition, { ...state, currentTick: 7, isAlive: false }, []);
        result.current.recordFrame(8, state.playerPosition, { ...state, currentTick: 8, isAlive: false }, []);
        result.current.controlProps.onSeek(8);
      });
      expect(result.current.controlProps.takeOverUnavailableReason).toBe('terminal-predecessor');
      expect(result.current.replayPractice.practiceUnavailableReason).toBe(
        TAKE_OVER_UNAVAILABLE_TEXT['terminal-predecessor'],
      );
      await act(async () => await result.current.controlProps.onTakeOver());
      expect(onTakeOver).not.toHaveBeenCalled();
      expect(result.current.replayMode).toBe(true);

      act(() => result.current.controlProps.onSeek(7));
      expect(result.current.displayState.isAlive).toBe(false);
      expect(result.current.controlProps.takeOverUnavailableReason).toBeNull();
      expect(result.current.replayPractice.practiceUnavailableReason).toBeNull();
      await act(async () => await result.current.replayPractice.onStartPractice());
      expect(onTakeOver).toHaveBeenCalledOnce();
      expect(engineRef.current.currentTick).toBe(6);
      expect(engineRef.current.getState().isAlive).toBe(true);
      expect(result.current.replayPractice.startTick).toBe(7);
      expect(result.current.replayPractice.startFrameIndex).toBe(7);
    });

    it('re-simulates the prefix on the recorded mechanics, not the viewer live config', async () => {
      // Mechanics decide outcomes (which fireball lines land, whether waves damage), so a prefix
      // replayed under the viewer's settings lands on a fight that never happened.
      const recorded = { infiniteHealth: true, fireballs: true, fireballStart: 'vertical' };
      const { result, onTakeOver } = recordRealRun({
        ticks: 16,
        recordedMechanics: recorded,
        viewerMechanics: { infiniteHealth: true, fireballs: true, fireballStart: 'horizontal' },
      });

      act(() => result.current.controlProps.onSeek(15));
      const displayed = result.current.displayState;
      act(() => result.current.controlProps.onSeek(16));
      await act(async () => await result.current.controlProps.onTakeOver());

      // The reconstruction matching the displayed frame IS the proof: had the prefix run on the
      // viewer's horizontal config, the fireball state would diverge and the diff would abort.
      expect(onTakeOver).toHaveBeenCalledTimes(1);
      const resumed: SimulationState = onTakeOver.mock.calls[0]?.[1];
      expect(diffResumableState(displayed, resumed)).toEqual([]);
    });

    it('hands the viewer their own live mechanics from the takeover boundary onward', async () => {
      const { result, onTakeOver } = recordRealRun({
        ticks: 16,
        recordedMechanics: { infiniteHealth: true, fireballs: true, fireballStart: 'vertical' },
        viewerMechanics: { infiniteHealth: true, fireballs: true, fireballStart: 'horizontal' },
      });

      await act(async () => {
        result.current.controlProps.onSeek(16);
        await result.current.controlProps.onTakeOver();
      });

      // The prefix is history; from here the Mechanics panel and the fight must agree.
      const takeoverEngine: SimulationEngine = onTakeOver.mock.calls[0]?.[0];
      expect(takeoverEngine.getMechanicsConfig().fireballStart).toBe('horizontal');
    });

    it('follows a mid-run mechanics change recorded partway through the prefix', async () => {
      // A single run-start config snapshot could not reproduce both halves of this run.
      const { result, onTakeOver } = recordRealRun({
        ticks: 30,
        recordedMechanics: { infiniteHealth: true, fireballs: true, fireballStart: 'vertical' },
        viewerMechanics: { infiniteHealth: true, fireballs: true, fireballStart: 'random' },
        beforeTick: (engine, tick) => {
          if (tick === 21) {
            engine.setMechanicsConfig({ infiniteHealth: true, fireballs: true, fireballStart: 'horizontal' });
          }
        },
      });

      act(() => result.current.controlProps.onSeek(29));
      const displayed = result.current.displayState;
      act(() => result.current.controlProps.onSeek(30));
      await act(async () => await result.current.controlProps.onTakeOver());

      expect(onTakeOver).toHaveBeenCalledTimes(1);
      const resumed: SimulationState = onTakeOver.mock.calls[0]?.[1];
      expect(diffResumableState(displayed, resumed)).toEqual([]);
    });

    it('keeps the recorded prefix so a taken-over run can itself be taken over', async () => {
      const { result, onTakeOver } = recordRealRun({ ticks: 20 });

      await act(async () => {
        result.current.controlProps.onSeek(12);
        await result.current.controlProps.onTakeOver();
      });

      // Forked, not restarted: the frames leading up to the boundary are what a second takeover
      // reconstructs from, and a fresh recording rooted at a mid-fight engine has none of them.
      expect(onTakeOver).toHaveBeenCalledTimes(1);
      expect(result.current.controlProps.totalFrames).toBe(12);
      expect(result.current.replayMode).toBe(false);
    });

    describe('takeover presentation baselines', () => {
      beforeEach(() => __resetKeyStateForTest());
      afterEach(() => {
        __resetKeyStateForTest();
        vi.restoreAllMocks();
      });

      it('records unchanged viewer layout and neutral input at the fork without changing the prefix', async () => {
        vi.spyOn(performance, 'now').mockReturnValue(10_000);
        const recorded = makePresentation();
        const viewer = makePresentation({ uiScale: 1.4 });
        let presentation = recorded;
        const { result, onTakeOver } = recordRealRun({ ticks: 3, getPresentationState: () => presentation });
        const original = result.current.exportReplayData();
        act(() =>
          result.current.loadExternalReplay({
            ...original,
            modifierSamples: [{ tMs: 0, mask: MODIFIER_BIT.shift, buttons: 1 }],
          }),
        );
        presentation = viewer;
        act(() => result.current.controlProps.onSeek(2));

        await act(async () => await result.current.controlProps.onTakeOver());

        expect(onTakeOver).toHaveBeenCalledOnce();
        const fork = result.current.exportReplayData();
        expect(fork.modifierSamples).toEqual([
          { tMs: 0, mask: MODIFIER_BIT.shift, buttons: 1 },
          { tMs: 600, mask: 0, buttons: 0 },
        ]);
        expect(fork.presentationSamples).toEqual([
          { tMs: 0, state: recorded },
          { tMs: 600, state: viewer },
        ]);
      });
    });

    it('keeps startRun stable across replay UI state rerenders while using the latest default UI state', () => {
      const engineRef = {
        current: { isTutorialPaused: () => false, getState: () => makeState(0) } as SimulationEngine,
      };
      const inventoryUiState: ReplayUiState = { activeGamePanelTab: 'inventory' };
      const equipmentUiState: ReplayUiState = { activeGamePanelTab: 'equipment' };
      const { result, rerender } = renderHook(
        ({ getReplayUiState }) =>
          useReplay({
            engineRef,
            simulationState: makeState(0),
            getReplayUiState,
            speedMultiplier: 1,
            mechanicsConfig: { infiniteHealth: false },
            objTypeLoader: null,
            onTakeOver: vi.fn(),
          }),
        { initialProps: { getReplayUiState: () => inventoryUiState } },
      );
      const firstStartRun = result.current.startRun;

      rerender({ getReplayUiState: () => equipmentUiState });

      expect(result.current.startRun).toBe(firstStartRun);

      act(() => {
        result.current.startRun(makeRunConfig(), makeState(0));
        result.current.controlProps.onEnterReplay();
        result.current.controlProps.onJumpToStart();
      });

      expect(result.current.displayUiState).toEqual(equipmentUiState);
    });

    it('records the tab the getter reports at record time, with no rerender in between', () => {
      // The whole point of the getter: GamePanelTabStore changes the tab without
      // rendering App, so a frame recorded afterwards must still carry the new tab.
      const engineRef = {
        current: { isTutorialPaused: () => false, getState: () => makeState(0) } as SimulationEngine,
      };
      let tab: ReplayUiState['activeGamePanelTab'] = 'inventory';
      const { result } = renderHook(() =>
        useReplay({
          engineRef,
          simulationState: makeState(0),
          getReplayUiState: () => ({ activeGamePanelTab: tab }),
          speedMultiplier: 1,
          mechanicsConfig: { infiniteHealth: false },
          objTypeLoader: null,
          onTakeOver: vi.fn(),
        }),
      );

      act(() => {
        result.current.startRun(makeRunConfig(), makeState(0));
      });
      tab = 'prayer';
      act(() => {
        result.current.recordFrame(1, [0, 0], makeState(1), []);
        result.current.controlProps.onEnterReplay();
        result.current.controlProps.onJumpToStart();
      });

      act(() => {
        result.current.controlProps.onStepForward();
      });
      expect(result.current.displayUiState.activeGamePanelTab).toBe('prayer');
    });

    it('shows the replay cursor by default', () => {
      const { result } = createHook();

      expect(result.current.controlProps.replayCursorVisible).toBe(true);
    });

    it('updates replay cursor visibility from the control callback', () => {
      const { result } = createHook();

      act(() => {
        result.current.controlProps.onReplayCursorVisibleChange(false);
      });
      expect(result.current.controlProps.replayCursorVisible).toBe(false);

      act(() => {
        result.current.controlProps.onReplayCursorVisibleChange(true);
      });
      expect(result.current.controlProps.replayCursorVisible).toBe(true);
    });

    it('shows frame events while replaying and stepping (not playing)', () => {
      const { result } = createHook();
      const frame1Events = [makeEvent(1, 1, 'frame_one')];
      const frame2Events = [makeEvent(2, 2, 'frame_two')];

      seedRecording(result, [
        { tick: 1, input: [32, 37], state: makeState(1), events: frame1Events },
        { tick: 2, input: [33, 37], state: makeState(2), events: frame2Events },
      ]);

      act(() => {
        result.current.controlProps.onEnterReplay();
      });

      expect(result.current.controlProps.isPlaying).toBe(false);
      expect(result.current.displayEvents).toEqual(frame2Events);

      act(() => {
        result.current.controlProps.onStepBack();
      });

      expect(result.current.controlProps.isPlaying).toBe(false);
      expect(result.current.displayEvents).toEqual(frame1Events);
    });

    it('exposes the active replay frame viewport state while entering and seeking', () => {
      const { result } = createHook();
      const frame1Viewport = makeOrbitViewportState(90);
      const frame2Viewport = makeOrbitViewportState(180);

      act(() => {
        result.current.startRun(makeRunConfig(), makeState(0));
        result.current.recordFrame(1, [32, 37], makeState(1), [], {
          viewportState: frame1Viewport,
        });
        result.current.recordFrame(2, [33, 37], makeState(2), [], {
          viewportState: frame2Viewport,
        });
        result.current.controlProps.onEnterReplay();
      });

      expect(result.current.displayViewportState).toEqual(frame2Viewport);

      act(() => {
        result.current.controlProps.onSeek(1);
      });

      expect(result.current.displayViewportState).toEqual(frame1Viewport);
    });

    it('uses per-tick camera snapshots after continuous camera capture stops', () => {
      const { result } = createHook();
      const initial = makeOrbitViewportState(180);
      const next = makeOrbitViewportState(90);
      act(() => {
        result.current.startRun(makeRunConfig(), makeState(0));
        result.current.recordFrame(1, [31, 37], makeState(1), [], { viewportState: next });
      });
      const data = result.current.exportReplayData();

      act(() => {
        result.current.loadExternalReplay({
          ...data,
          viewportSamples: [{ tMs: 0, viewportState: initial }],
          capture: {
            ...freshReplayCapture(),
            viewportSamples: { provenance: 'bounded-v1', stoppedAtMs: 100, reason: 'entry-limit' },
          },
        });
        result.current.controlProps.onSeek(1);
      });

      expect(result.current.displayViewportState).toEqual(next);
      expect(result.current.replayFrameStore.getSnapshot().viewportState).toEqual(next);
      expect(result.current.replayFrameStore.isTrackAvailable('viewportSamples')).toBe(false);
    });

    it('does not measure the DOM for a stopped cursor track when a local recording resumes', () => {
      const starts = vi.spyOn(ReplayRecorder.prototype, 'startRun');
      const { result } = createHook();
      act(() => result.current.startRun(makeRunConfig(), makeState(0)));
      const recorder = starts.mock.contexts[0];
      if (!(recorder instanceof ReplayRecorder)) throw new TypeError('Expected the live recorder');
      const data = result.current.exportReplayData();
      act(() =>
        recorder.load({
          ...data,
          capture: {
            ...freshReplayCapture(),
            cursorSamples: { provenance: 'bounded-v1', stoppedAtMs: 100, reason: 'entry-limit' },
          },
        }),
      );
      act(() => result.current.controlProps.onEnterReplay());
      act(() => result.current.controlProps.onExitReplay());
      vi.mocked(getGameFrameRect).mockClear();

      act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 20 })));

      expect(getGameFrameRect).not.toHaveBeenCalled();
    });

    it('returns undefined displayEvents when not in replay mode', () => {
      const { result } = createHook();
      seedRecording(result, [
        { tick: 1, input: [32, 37], state: makeState(1), events: [makeEvent(1, 1, 'frame_one')] },
      ]);

      expect(result.current.replayMode).toBe(false);
      expect(result.current.displayEvents).toBeUndefined();
    });

    it('publishes the recorder frame history to the frame store on entering replay, without copying it', () => {
      const { result } = createHook();
      const frame1Events = [makeEvent(1, 1, 'frame_one')];
      const frame2Events = [makeEvent(2, 2, 'frame_two')];
      seedRecording(result, [
        { tick: 1, input: [32, 37], state: makeState(1), events: frame1Events },
        { tick: 2, input: [33, 37], state: makeState(2), events: frame2Events },
      ]);
      expect(result.current.replayFrameStore.getSnapshot().history).toBeUndefined();

      act(() => {
        result.current.controlProps.onEnterReplay();
      });

      const history = result.current.replayFrameStore.getSnapshot().history;
      expect(history?.map((frame) => frame.state.currentTick)).toEqual([0, 1, 2]);
      expect(history?.[1]?.events).toEqual(frame1Events);
      // History is the whole run; the frame's own events stay the only ones on display.
      expect(result.current.displayEvents).toEqual(frame2Events);

      act(() => {
        result.current.controlProps.onStepBack();
      });
      expect(result.current.replayFrameStore.getSnapshot().history).toBe(history);
    });

    it('replaces the published history when an external replay is loaded', () => {
      const { result } = createHook();
      seedRecording(result, [{ tick: 1, input: [32, 37], state: makeState(1), events: [] }]);
      act(() => {
        result.current.controlProps.onEnterReplay();
      });
      const ownHistory = result.current.replayFrameStore.getSnapshot().history;
      const source = createHook();
      seedRecording(source.result, [
        { tick: 1, input: [32, 37], state: makeState(1), events: [] },
        { tick: 2, input: [33, 37], state: makeState(2), events: [] },
        { tick: 3, input: [34, 37], state: makeState(3), events: [] },
      ]);
      const shared = source.result.current.exportReplayData();

      act(() => {
        result.current.loadExternalReplay(shared);
      });

      const loadedHistory = result.current.replayFrameStore.getSnapshot().history;
      expect(loadedHistory).not.toBe(ownHistory);
      expect(loadedHistory?.map((frame) => frame.state.currentTick)).toEqual([0, 1, 2, 3]);
      expect(result.current.controlProps.replayFrameIndex).toBe(0);
    });

    it('exposes the recorder frame array as displayHistory while live, and it is what replay publishes', () => {
      const { result } = createHook();
      const beforeRun = result.current.displayHistory;
      seedRecording(result, [
        { tick: 1, input: [32, 37], state: makeState(1), events: [] },
        { tick: 2, input: [33, 37], state: makeState(2), events: [] },
      ]);

      // A run start swaps the array; frames recorded since land in it in place,
      // which is how a live overlay indexes the run as it is played.
      const recording = result.current.displayHistory;
      expect(recording).not.toBe(beforeRun);
      expect(recording.map((frame) => frame.state.currentTick)).toEqual([0, 1, 2]);
      act(() => {
        result.current.recordFrame(3, [34, 37], makeState(3), []);
      });
      expect(result.current.displayHistory).toBe(recording);
      expect(recording).toHaveLength(4);

      act(() => {
        result.current.controlProps.onEnterReplay();
      });
      expect(result.current.replayFrameStore.getSnapshot().history).toBe(recording);
      expect(result.current.displayHistory).toBe(recording);

      const source = createHook();
      seedRecording(source.result, [{ tick: 1, input: [32, 37], state: makeState(1), events: [] }]);
      act(() => {
        result.current.loadExternalReplay(source.result.current.exportReplayData());
      });
      expect(result.current.displayHistory).not.toBe(recording);
      expect(result.current.displayHistory).toBe(result.current.replayFrameStore.getSnapshot().history);
    });

    it('replaces every displayed surface when another recording loads at the same index', () => {
      const { result } = createHook();
      const first = new ReplayRecorder();
      first.startRun(makeRunConfig());
      first.recordFrame(0, [31, 37], makeState(0), [makeEvent(1, 0, 'first')], {
        uiState: { activeGamePanelTab: 'inventory' },
        viewportState: makeOrbitViewportState(90),
        recordedAtMs: 0,
      });
      first.recordPresentationState(1, 0, makePresentation());
      const second = new ReplayRecorder();
      second.startRun(makeRunConfig());
      const nextState = { ...makeState(0), playerHP: 37 };
      const nextUiState: ReplayUiState = { activeGamePanelTab: 'prayer' };
      const nextEvents = [makeEvent(2, 0, 'second')];
      const nextViewport = makeOrbitViewportState(180);
      const nextPresentation = makePresentation({ uiScale: 1.4 });
      second.recordFrame(0, [31, 37], nextState, nextEvents, {
        uiState: nextUiState,
        viewportState: nextViewport,
        recordedAtMs: 0,
      });
      second.recordPresentationState(1, 0, nextPresentation);
      act(() => result.current.loadExternalReplay(first.exportData()));

      act(() => result.current.loadExternalReplay(second.exportData()));

      expect(result.current.controlProps.replayFrameIndex).toBe(0);
      expect.soft(result.current.displayState).toEqual(nextState);
      expect.soft(result.current.displayUiState).toEqual(nextUiState);
      expect.soft(result.current.displayEvents).toEqual(nextEvents);
      expect.soft(result.current.displayViewportState).toEqual(nextViewport);
      expect.soft(result.current.displayPresentationState).toEqual(nextPresentation);
      expect(result.current.replayFrameStore.getSnapshot()).toMatchObject({
        playheadMs: 0,
        viewportState: nextViewport,
        history: [{ state: nextState, events: nextEvents }],
      });
    });

    describe('replay lifecycle', () => {
      afterEach(() => vi.restoreAllMocks());

      it.each([false, true])('pauses audio before preview publication when play is pending: %s', (pendingPlay) => {
        const { result, onPause, onSeek } = createHook();
        seedRecording(result, [
          { tick: 1, input: [31, 37], state: makeState(1), events: [] },
          { tick: 2, input: [31, 37], state: makeState(2), events: [] },
        ]);
        act(() => {
          result.current.controlProps.onEnterReplay();
          result.current.controlProps.onSeek(0);
        });
        onSeek.mockClear();
        if (!pendingPlay) act(() => result.current.controlProps.onPlayPause());
        const pausesAtPublication: number[] = [];
        const unsubscribe = result.current.replayFrameStore.subscribe(() => {
          if (result.current.replayFrameStore.getSnapshot().preview) {
            pausesAtPublication.push(onPause.mock.calls.length);
          }
        });

        act(() => {
          if (pendingPlay) result.current.controlProps.onPlayPause();
          result.current.controlProps.onPreviewSeek(1);
          result.current.controlProps.onPreviewSeek(2);
        });

        expect.soft(result.current.controlProps.isPlaying).toBe(false);
        expect.soft(onPause).toHaveBeenCalledOnce();
        expect(pausesAtPublication.length).toBeGreaterThan(0);
        expect.soft(pausesAtPublication.every((count) => count === 1)).toBe(true);
        expect(onSeek).not.toHaveBeenCalled();
        unsubscribe();
      });

      it('retains recorded damage history through the previewed tick', () => {
        const { result } = createHook();
        const damageEntry: SimulationState['damageHistory'][number] = {
          tick: 1,
          source: 'Fireball',
          targetId: 'player',
          baseDamage: 20,
          attackType: 'magic',
          activePrayer: null,
          prayedCorrectly: false,
          effectiveDamage: 20,
          hpBefore: 99,
          hpAfter: 79,
          playerPosition: [31, 37],
        };
        const damagedState: SimulationState = {
          ...makeState(1),
          damageHistory: [damageEntry],
        };
        seedRecording(result, [
          { tick: 1, input: [31, 37], state: damagedState, events: [] },
          {
            tick: 2,
            input: [31, 37],
            state: {
              ...makeState(2),
              damageHistory: [...damagedState.damageHistory, { ...damageEntry, tick: 2, hpBefore: 79, hpAfter: 59 }],
            },
            events: [],
          },
        ]);
        act(() => result.current.controlProps.onEnterReplay());

        act(() => result.current.controlProps.onPreviewSeek(1));

        expect(result.current.replayFrameStore.getSnapshot().preview?.state.damageHistory).toEqual(
          damagedState.damageHistory,
        );
      });

      it('updates recorded presentation at the previewed playhead', () => {
        const { result } = createHook();
        seedRecording(result, [
          { tick: 1, input: [31, 37], state: makeState(1), events: [makeEvent(1, 1, 'first')] },
          { tick: 2, input: [31, 37], state: makeState(2), events: [makeEvent(2, 2, 'second')] },
        ]);
        const recording = result.current.exportReplayData();
        const previewPresentation = makePresentation({ uiScale: 1.2 });
        act(() =>
          result.current.loadExternalReplay({
            ...recording,
            presentationSamples: [
              { tMs: 0, state: makePresentation() },
              { tMs: 600, state: previewPresentation },
              { tMs: 1200, state: makePresentation({ uiScale: 1.4 }) },
            ],
          }),
        );

        act(() => result.current.controlProps.onPreviewSeek(1));

        expect(result.current.displayPresentationState).toEqual(previewPresentation);
        expect(result.current.replayFrameStore.getSnapshot().playheadMs).toBe(600);
      });

      it('avoids hook rerenders for repeated previews within unchanged presentation', () => {
        const { result, onSeek, onPause } = createHook();
        const finalEvents = [makeEvent(2, 2, 'second')];
        seedRecording(result, [
          { tick: 1, input: [31, 37], state: makeState(1), events: [] },
          { tick: 2, input: [31, 37], state: makeState(2), events: finalEvents },
        ]);
        const recording = result.current.exportReplayData();
        act(() =>
          result.current.loadExternalReplay({
            ...recording,
            presentationSamples: [
              { tMs: 0, state: makePresentation() },
              { tMs: 600, state: makePresentation({ uiScale: 1.2 }) },
            ],
          }),
        );
        act(() => result.current.controlProps.onPreviewSeek(1));
        const rendered = result.current;

        act(() => result.current.controlProps.onPreviewSeek(1));
        act(() => result.current.controlProps.onPreviewSeek(2));

        expect(result.current).toBe(rendered);
        expect(result.current.replayFrameStore.getSnapshot().preview).toMatchObject({
          frameIndex: 2,
          state: { currentTick: 2 },
          events: finalEvents,
        });
        expect(onSeek).not.toHaveBeenCalled();
        expect(onPause).not.toHaveBeenCalled();
      });

      it('commits the previewed frame when playback resumes before drag release', () => {
        const { result } = createHook();
        seedRecording(result, [
          { tick: 1, input: [31, 37], state: makeState(1), events: [] },
          { tick: 2, input: [31, 37], state: makeState(2), events: [] },
        ]);
        act(() => result.current.controlProps.onEnterReplay());
        act(() => result.current.controlProps.onPreviewSeek(1));

        act(() => result.current.controlProps.onPlayPause());

        expect.soft(result.current.replayFrameStore.getSnapshot().preview).toBeUndefined();
        expect(result.current.controlProps.isPlaying).toBe(true);
        expect(result.current.controlProps.replayFrameIndex).toBe(1);
        expect(result.current.displayState.currentTick).toBe(1);
      });

      it.each([
        'exit',
        'reset',
        'load',
      ] as const)('clears the preview when replay lifecycle performs %s', (operation) => {
        const { result } = createHook();
        seedRecording(result, [{ tick: 1, input: [31, 37], state: makeState(1), events: [] }]);
        const recording = result.current.exportReplayData();
        act(() => result.current.controlProps.onEnterReplay());
        act(() => result.current.controlProps.onPreviewSeek(1));

        act(() => {
          switch (operation) {
            case 'exit':
              result.current.controlProps.onExitReplay();
              break;
            case 'reset':
              result.current.resetReplay();
              break;
            case 'load':
              result.current.loadExternalReplay(recording);
              break;
          }
        });

        expect(result.current.replayFrameStore.getSnapshot().preview).toBeUndefined();
      });

      it.each([
        false,
        true,
      ])('retires a drag preview without committing it during takeover, refused: %s', async (corruptBootstrap) => {
        const { result, onTakeOver } = recordRealRun({ ticks: 8, corruptBootstrap });
        act(() => result.current.controlProps.onPreviewSeek(4));
        const pausedPosition = result.current.replayFrameStore.getSnapshot().playheadMs;

        await act(async () => await result.current.controlProps.onTakeOver());

        expect.soft(result.current.replayFrameStore.getSnapshot().preview).toBeUndefined();
        expect(result.current.replayMode).toBe(corruptBootstrap);
        expect(onTakeOver).toHaveBeenCalledTimes(corruptBootstrap ? 0 : 1);
        if (corruptBootstrap) {
          expect(result.current.controlProps.replayFrameIndex).toBe(8);
          expect(result.current.displayState.currentTick).toBe(8);
          expect(result.current.replayFrameStore.getSnapshot().playheadMs).toBe(pausedPosition);
          expect(result.current.controlProps.takeOverError).toBeTruthy();
        }
      });

      it('retains a newly started recording when reset follows startRun', () => {
        const { result } = createHook();
        seedRecording(result, [{ tick: 1, input: [31, 37], state: makeState(1), events: [] }]);
        act(() => result.current.controlProps.onEnterReplay());
        act(() => result.current.controlProps.onPreviewSeek(1));
        const nextState = { ...makeState(0), playerHP: 37 };

        act(() => {
          result.current.startRun(makeRunConfig(), nextState);
          result.current.resetReplay();
        });

        expect.soft(result.current.replayFrameStore.getSnapshot().preview).toBeUndefined();
        expect(result.current.exportReplayData().frames.map((frame) => frame.state.playerHP)).toEqual([37]);
        expect(result.current.controlProps.hasRecording).toBe(true);
      });

      it.each(['exit', 'reset', 'load'] as const)('disarms a queued RAF before React flushes %s', (operation) => {
        const callbacks: FrameRequestCallback[] = [];
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
          callbacks.push(callback);
          return callbacks.length;
        });
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
        vi.spyOn(performance, 'now').mockReturnValue(0);
        const { result } = createHook();
        seedRecording(result, [
          { tick: 1, input: [31, 37], state: makeState(1), events: [] },
          { tick: 2, input: [31, 37], state: makeState(2), events: [] },
          { tick: 3, input: [31, 37], state: makeState(3), events: [] },
        ]);
        const recording = result.current.exportReplayData();
        act(() => {
          result.current.controlProps.onEnterReplay();
          result.current.controlProps.onSeek(0);
        });
        act(() => result.current.controlProps.onPlayPause());
        const staleTick = callbacks.at(-1);
        if (!staleTick) throw new Error('Expected queued replay RAF');

        act(() => {
          switch (operation) {
            case 'exit':
              result.current.controlProps.onExitReplay();
              break;
            case 'reset':
              result.current.resetReplay();
              break;
            case 'load':
              result.current.loadExternalReplay(recording);
              break;
          }
          const snapshot = result.current.replayFrameStore.getSnapshot();
          const scheduled = callbacks.length;
          staleTick(1200);
          expect.soft(result.current.replayFrameStore.getSnapshot()).toBe(snapshot);
          expect.soft(callbacks).toHaveLength(scheduled);
        });
      });

      it.each(['back', 'forward'] as const)('steps %s twice before React commits', (direction) => {
        const { result, onSeek } = createHook();
        seedRecording(result, [
          { tick: 1, input: [31, 37], state: makeState(1), events: [] },
          { tick: 2, input: [31, 37], state: makeState(2), events: [] },
          { tick: 3, input: [31, 37], state: makeState(3), events: [] },
        ]);
        act(() => {
          result.current.controlProps.onEnterReplay();
          result.current.controlProps.onSeek(direction === 'back' ? 3 : 0);
        });
        const step =
          direction === 'back' ? result.current.controlProps.onStepBack : result.current.controlProps.onStepForward;

        act(() => {
          step();
          step();
        });

        expect(result.current.controlProps.replayFrameIndex).toBe(direction === 'back' ? 1 : 2);
        expect(onSeek).toHaveBeenLastCalledWith(direction === 'back' ? 1 : 2);
      });
    });

    it('releases the published history when replay exits', () => {
      const { result } = createHook();
      seedRecording(result, [{ tick: 1, input: [32, 37], state: makeState(1), events: [] }]);
      act(() => {
        result.current.controlProps.onEnterReplay();
      });
      expect(result.current.replayFrameStore.getSnapshot().history).toBeDefined();

      act(() => {
        result.current.controlProps.onExitReplay();
      });

      expect(result.current.replayFrameStore.getSnapshot().history).toBeUndefined();
    });

    it('republishes the recorder frames when replay is re-entered after an exit', () => {
      const { result } = createHook();
      seedRecording(result, [{ tick: 1, input: [32, 37], state: makeState(1), events: [] }]);
      act(() => {
        result.current.controlProps.onEnterReplay();
      });
      const published = result.current.replayFrameStore.getSnapshot().history;
      act(() => {
        result.current.controlProps.onExitReplay();
      });

      act(() => {
        result.current.controlProps.onEnterReplay();
      });

      expect(result.current.replayFrameStore.getSnapshot().history).toBe(published);
    });

    it('releases the published history when replay is reset', () => {
      const { result } = createHook();
      seedRecording(result, [{ tick: 1, input: [32, 37], state: makeState(1), events: [] }]);
      act(() => {
        result.current.controlProps.onEnterReplay();
      });
      expect(result.current.replayFrameStore.getSnapshot().history).toBeDefined();

      act(() => {
        result.current.resetReplay();
      });

      expect(result.current.replayFrameStore.getSnapshot().history).toBeUndefined();
    });

    it('releases the published history once a takeover succeeds', async () => {
      const { result, onTakeOver } = recordRealRun({ ticks: 8 });
      expect(result.current.replayFrameStore.getSnapshot().history).toBeDefined();

      await act(async () => {
        result.current.controlProps.onSeek(4);
        await result.current.controlProps.onTakeOver();
      });

      expect(onTakeOver).toHaveBeenCalledOnce();
      expect(result.current.replayFrameStore.getSnapshot().history).toBeUndefined();
    });

    it('keeps the published history when a takeover is refused, since the replay stays on screen', async () => {
      const { result, onTakeOver } = recordRealRun({ ticks: 12, corruptBootstrap: true });
      const published = result.current.replayFrameStore.getSnapshot().history;
      expect(published).toBeDefined();

      await act(async () => {
        result.current.controlProps.onSeek(6);
        await result.current.controlProps.onTakeOver();
      });

      expect(onTakeOver).not.toHaveBeenCalled();
      expect(result.current.replayFrameStore.getSnapshot().history).toBe(published);
    });

    it('records pointer movement while live and ignores it during replay', () => {
      const { result } = createHook();
      act(() => {
        result.current.startRun(makeRunConfig(), makeState(0));
      });

      act(() => {
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 20 }));
      });
      expect(result.current.cursorTrack.samples).toEqual([
        { tMs: expect.any(Number), x: 10, y: 20, insideFrame: true },
      ]);

      act(() => {
        result.current.controlProps.onEnterReplay();
      });
      act(() => {
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 30, clientY: 40 }));
      });

      expect(result.current.cursorTrack.samples).toHaveLength(1);
      expect(getGameFrameRect).toHaveBeenCalledOnce();
    });

    it('records replay cursor clicks', () => {
      const { result } = createHook();
      act(() => {
        result.current.startRun(makeRunConfig(), makeState(0));
        result.current.recordCursorClick(50, 60, 'red');
      });

      expect(result.current.cursorTrack.clicks).toEqual([
        { tMs: expect.any(Number), x: 50, y: 60, insideFrame: true, type: 'red' },
      ]);
      expect(result.current.cursorTrack.samples).toEqual([
        { tMs: expect.any(Number), x: 50, y: 60, insideFrame: true, pinned: true },
      ]);
      expect(getGameFrameRect).toHaveBeenCalledOnce();
    });

    it('records one neutral replay click for a primary UI pointerdown', () => {
      const { result } = createHook();
      const button = document.createElement('button');
      document.body.appendChild(button);
      act(() => result.current.startRun(makeRunConfig(), makeState(0)));

      act(() => {
        button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 50, clientY: 60 }));
      });

      expect(result.current.cursorTrack.clicks).toEqual([
        { tMs: expect.any(Number), x: 50, y: 60, insideFrame: true, type: 'ui' },
      ]);
      button.remove();
    });

    it('records one neutral replay click before the target stops pointerdown propagation', () => {
      const { result } = createHook();
      const button = document.createElement('button');
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      document.body.appendChild(button);
      act(() => result.current.startRun(makeRunConfig(), makeState(0)));

      act(() => {
        button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 50, clientY: 60 }));
      });

      expect(result.current.cursorTrack.clicks).toEqual([
        { tMs: expect.any(Number), x: 50, y: 60, insideFrame: true, type: 'ui' },
      ]);
      button.remove();
    });

    describe('where a finger comes down', () => {
      const press = (target: Element, pointerType: string, clientX: number, clientY: number) =>
        act(() => {
          target.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType, clientX, clientY }),
          );
        });
      let world: HTMLElement;
      beforeEach(() => {
        world = document.createElement('div');
        world.setAttribute(REPLAY_CLICK_OWNER_ATTRIBUTE, REPLAY_CLICK_OWNERS.world);
        document.body.appendChild(world);
      });
      let restoreTouchPoints = () => {};
      afterEach(() => {
        world.remove();
        restoreTouchPoints();
        restoreTouchPoints = () => {};
      });

      it('pins a touch sample at the press point on the world, which the next moves do not compact away', () => {
        const { result } = createHook();
        act(() => result.current.startRun(makeRunConfig(), makeState(0)));

        press(world, 'touch', 40, 50);
        // The finger then wobbles and drags off inside the same 60Hz bucket.
        act(() => {
          for (const x of [41, 44, 48]) {
            window.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'touch', clientX: x, clientY: 50 }));
          }
        });

        expect(result.current.cursorTrack.clicks).toEqual([]);
        expect(result.current.cursorTrack.samples[0]).toEqual({
          tMs: expect.any(Number),
          x: 40,
          y: 50,
          insideFrame: true,
          pinned: true,
          touch: true,
        });
      });

      it('records nothing extra for a mouse press on the world', () => {
        const { result } = createHook();
        act(() => result.current.startRun(makeRunConfig(), makeState(0)));

        press(world, 'mouse', 40, 50);

        expect(result.current.cursorTrack.samples).toEqual([]);
        expect(result.current.cursorTrack.clicks).toEqual([]);
        expect(getGameFrameRect).not.toHaveBeenCalled();
      });

      it.each([
        { where: "on a touchscreen as a finger's", maxTouchPoints: 10, touch: true },
        {
          where: 'on a separate pad (no touchscreen) as a mouse press, which pins nothing',
          maxTouchPoints: 0,
          touch: false,
        },
      ])('records a pen press on the world $where', ({ maxTouchPoints, touch }) => {
        restoreTouchPoints = stubMaxTouchPoints(maxTouchPoints);
        const { result } = createHook();
        act(() => result.current.startRun(makeRunConfig(), makeState(0)));

        press(world, 'pen', 40, 50);

        expect(result.current.cursorTrack.samples).toEqual(
          touch ? [{ tMs: expect.any(Number), x: 40, y: 50, insideFrame: true, pinned: true, touch: true }] : [],
        );
      });

      it("reuses a touch UI click's pinned sample rather than recording a second", () => {
        const { result } = createHook();
        const button = document.createElement('button');
        document.body.appendChild(button);
        act(() => result.current.startRun(makeRunConfig(), makeState(0)));

        press(button, 'touch', 50, 60);

        expect(result.current.cursorTrack.clicks).toEqual([
          { tMs: expect.any(Number), x: 50, y: 60, insideFrame: true, type: 'ui', touch: true },
        ]);
        expect(result.current.cursorTrack.samples).toEqual([
          { tMs: expect.any(Number), x: 50, y: 60, insideFrame: true, pinned: true, touch: true },
        ]);
        button.remove();
      });

      it('records no press without a recording or during replay', () => {
        const { result } = createHook();
        press(world, 'touch', 40, 50);
        expect(result.current.cursorTrack.samples).toEqual([]);

        act(() => {
          result.current.startRun(makeRunConfig(), makeState(0));
          result.current.controlProps.onEnterReplay();
        });
        press(world, 'touch', 40, 50);
        expect(result.current.cursorTrack.samples).toEqual([]);
      });
    });

    it('does not record neutral UI clicks without an active recording', () => {
      const { result } = createHook();
      const button = document.createElement('button');
      document.body.appendChild(button);

      act(() => {
        button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 50, clientY: 60 }));
      });

      expect(result.current.cursorTrack.clicks).toHaveLength(0);
      expect(getGameFrameRect).not.toHaveBeenCalled();
      button.remove();
    });

    it('does not record synthetic neutral UI clicks', () => {
      const { result } = createHook();
      const button = document.createElement('button');
      document.body.appendChild(button);
      act(() => result.current.startRun(makeRunConfig(), makeState(0)));

      act(() => {
        runSyntheticInput(() => {
          button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 50, clientY: 60 }));
        });
      });

      expect(result.current.cursorTrack.clicks).toHaveLength(0);
      expect(getGameFrameRect).not.toHaveBeenCalled();
      button.remove();
    });

    it('does not mutate replay cursor markers while replaying', () => {
      const { result } = createHook();
      act(() => {
        result.current.startRun(makeRunConfig(), makeState(0));
        result.current.recordCursorClick(50, 60, 'red');
        result.current.controlProps.onEnterReplay();
      });

      act(() => {
        result.current.recordCursorClick(70, 80, 'yellow');
      });

      expect(result.current.cursorTrack.clicks).toEqual([
        { tMs: expect.any(Number), x: 50, y: 60, insideFrame: true, type: 'red' },
      ]);
      expect(result.current.cursorTrack.samples).toEqual([
        { tMs: expect.any(Number), x: 50, y: 60, insideFrame: true, pinned: true },
      ]);
    });

    describe('recording clock rate changes', () => {
      afterEach(() => {
        __resetKeyStateForTest();
        vi.restoreAllMocks();
      });

      // The live loop re-anchors the clock at each speed change, releasing it at the old rate first.
      it('preserves unsampled elapsed progress on every track when speed drops midtick and returns to 1x', () => {
        const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1000);
        const engineRef = { current: new SimulationEngine({ encounter: encounterRegistry.create('yama_p3') }) };
        const { result, rerender } = renderHook(
          ({ speedMultiplier }) =>
            useReplay({
              engineRef,
              simulationState: makeState(0),
              speedMultiplier,
              mechanicsConfig: { infiniteHealth: false },
              objTypeLoader: null,
              onTakeOver: vi.fn(),
            }),
          { initialProps: { speedMultiplier: 2 } },
        );
        act(() => result.current.startRun(makeRunConfig(), makeState(0)));
        const recordTracks = (nowMs: number, position: number, shiftKey: boolean) => {
          nowSpy.mockReturnValue(nowMs);
          act(() => {
            result.current.recordCursorClick(position, 20, 'yellow', nowMs);
            const move = new MouseEvent('pointermove', { clientX: position + 2, clientY: 20 });
            Object.defineProperty(move, 'timeStamp', { value: nowMs });
            window.dispatchEvent(move);
            result.current.recordPresentationState(makePresentation({ uiScale: 1 + position / 100 }), nowMs);
            result.current.recordViewportSample(nowMs, makeOrbitViewportState(180 + position));
            window.dispatchEvent(new KeyboardEvent(shiftKey ? 'keydown' : 'keyup', { key: 'Shift', shiftKey }));
          });
        };
        startLiveClock(result.current, 2);
        recordTracks(1100, 10, true);

        const changeSpeed = (atMs: number, speedMultiplier: number) => {
          nowSpy.mockReturnValue(atMs);
          result.current.releaseLiveClock(atMs);
          rerender({ speedMultiplier });
          startLiveClock(result.current, speedMultiplier);
        };
        changeSpeed(1120, 0.5);
        recordTracks(1140, 20, false);
        changeSpeed(1160, 1);
        recordTracks(1180, 30, true);

        const data = result.current.exportReplayData();
        expect.soft(data.cursorSamples.map(({ tMs }) => tMs)).toEqual([200, 200, 250, 250, 280, 280]);
        for (const track of [data.cursorClicks, data.presentationSamples, data.viewportSamples]) {
          expect.soft(track.map(({ tMs }) => tMs)).toEqual([200, 250, 280]);
          expect
            .soft(track.every(({ tMs }, index) => Number.isFinite(tMs) && tMs >= (track[index - 1]?.tMs ?? 0)))
            .toBe(true);
        }
        expect.soft(data.modifierSamples?.map(({ tMs }) => tMs)).toEqual([0, 200, 250, 280]);
        expect(data.cursorClicks.map(({ x }) => x)).toEqual([10, 20, 30]);
      });
    });

    it('records cursor clicks at the event timestamp relative to the last recorded frame', () => {
      const { result } = createHook();
      const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(2600);

      try {
        act(() => {
          result.current.startRun(makeRunConfig(), makeState(0));
          result.current.recordFrame(1, [32, 37], makeState(1), [], {
            recordedAtMs: 2000,
            liveTick: { ranAtMs: 2000, speedMultiplier: 1 },
          });
          result.current.recordCursorClick(50, 60, 'yellow', 2250);
        });

        expect(result.current.cursorTrack.clicks).toEqual([
          { tMs: 850, x: 50, y: 60, insideFrame: true, type: 'yellow' },
        ]);
        expect(result.current.cursorTrack.samples.at(-1)).toEqual({
          tMs: 850,
          x: 50,
          y: 60,
          insideFrame: true,
          pinned: true,
        });
      } finally {
        nowSpy.mockRestore();
      }
    });

    describe('bounded replay transport', () => {
      let nextFrame: FrameRequestCallback | undefined;
      let nowMs = 0;

      beforeEach(() => {
        nextFrame = undefined;
        nowMs = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
          nextFrame = callback;
          return 1;
        });
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
      });
      afterEach(() => vi.restoreAllMocks());

      function advanceFrame(timeMs: number) {
        nowMs = timeMs;
        const callback = nextFrame;
        nextFrame = undefined;
        if (!callback) throw new Error('Expected a queued transport frame');
        act(() => callback(timeMs));
      }

      function startPlayback(frameCount = 5, speedMultiplier = 1) {
        const hook = createHook(undefined, speedMultiplier);
        seedRecording(
          hook.result,
          Array.from({ length: frameCount - 1 }, (_, index) => ({
            tick: index + 1,
            input: [31, 37] satisfies Coordinate,
            state: makeState(index + 1),
            events: [makeEvent(index + 1, index + 1, 'recorded_tick')],
          })),
        );
        act(() => {
          hook.result.current.controlProps.onEnterReplay();
          hook.result.current.controlProps.onSeek(0);
        });
        act(() => hook.result.current.controlProps.onPlayPause());
        return hook;
      }

      function cutoffRecording() {
        const recorder = new ReplayRecorder({ menuEvents: 1 });
        const state = makeState(0);
        recorder.startRun(makeRunConfig());
        recorder.recordFrame(0, state.playerPosition, state, [], 0);
        recorder.recordMenuState(1, 0, {
          entries: [{ action: 'Walk here' }],
          x: 10,
          y: 20,
          scale: 1,
          hoveredIndex: -1,
          submenuParentIndex: -1,
          hoveredSubmenuIndex: -1,
          submenuPosition: null,
        });
        recorder.recordMenuState(1, 100, null);
        return recorder.exportData();
      }

      it('enters at the capture cutoff when the final menu close was rejected', () => {
        const { result } = createHook();
        act(() => result.current.loadExternalReplay(cutoffRecording()));

        act(() => result.current.controlProps.onEnterReplay());

        expect(result.current.replayPlayheadMs).toBe(100);
        expect(result.current.replayFrameStore.getMenuState()).toBeNull();
      });

      it('clears the menu at the cutoff and waits for its final render before completing', () => {
        const { result, onPlaybackEnd } = createHook();
        act(() => result.current.loadExternalReplay(cutoffRecording()));
        const store = result.current.replayFrameStore;
        const detach = store.registerRenderConsumer();
        act(() => result.current.controlProps.onPlayPause());

        advanceFrame(50);
        expect(store.getMenuState()).not.toBeNull();
        act(() => result.current.controlProps.onPlayPause());
        act(() => result.current.controlProps.onPlayPause());
        expect(store.getSnapshot().playheadMs).toBe(50);
        advanceFrame(100);

        expect(store.getSnapshot().playheadMs).toBe(100);
        expect(store.getMenuState()).toBeNull();
        expect(result.current.controlProps.isPlaying).toBe(true);
        expect(onPlaybackEnd).not.toHaveBeenCalled();
        store.acknowledgeRender(store.getRenderEpoch(), 0, 100);
        advanceFrame(110);
        expect(result.current.replayPlayheadMs).toBe(100);
        expect(result.current.controlProps.isPlaying).toBe(false);
        expect(onPlaybackEnd).toHaveBeenCalledOnce();
        detach();
      });

      it('pauses at the exact existing playhead after a multi-second RAF gap and resumes on a fresh clock', () => {
        const { result, onPause, onPlaybackEnd } = startPlayback();
        advanceFrame(300);

        advanceFrame(5000);

        expect(result.current.controlProps.isPlaying).toBe(false);
        expect(result.current.controlProps.replayFrameIndex).toBe(0);
        expect(result.current.replayPlayheadMs).toBe(300);
        expect(result.current.replayFrameStore.getSnapshot().playheadMs).toBe(300);
        expect(onPause).toHaveBeenCalledOnce();
        expect(onPlaybackEnd).not.toHaveBeenCalled();
        act(() => result.current.controlProps.onPlayPause());
        advanceFrame(5100);
        expect(result.current.replayFrameStore.getSnapshot().playheadMs).toBe(400);
        expect(result.current.controlProps.isPlaying).toBe(true);
      });

      it('holds an unacknowledged tick without renders, emissions, or catch-up debt', () => {
        const { result, onPause } = startPlayback();
        const store = result.current.replayFrameStore;
        const detach = store.registerRenderConsumer();
        advanceFrame(500);
        const rendered = result.current;
        const snapshot = store.getSnapshot();
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);

        for (const timeMs of [600, 800, 1000, 1200, 1400, 1600]) advanceFrame(timeMs);

        expect(result.current).toBe(rendered);
        expect(store.getSnapshot()).toBe(snapshot);
        expect(listener).not.toHaveBeenCalled();
        expect(result.current.controlProps.isPlaying).toBe(true);
        expect(onPause).not.toHaveBeenCalled();
        store.acknowledgeRender(store.getRenderEpoch(), 0, 500);
        advanceFrame(1700);
        expect(store.getSnapshot().playheadMs).toBe(600);
        expect(result.current.controlProps.replayFrameIndex).toBe(1);
        advanceFrame(2300);
        expect(store.getSnapshot().playheadMs).toBe(600);
        store.acknowledgeRender(store.getRenderEpoch(), 1, 600);
        advanceFrame(2400);
        expect(store.getSnapshot().playheadMs).toBe(700);
        unsubscribe();
        detach();
      });

      it('unblocks playback when the last renderer detaches', () => {
        const { result } = startPlayback();
        const store = result.current.replayFrameStore;
        const detach = store.registerRenderConsumer();
        advanceFrame(600);

        detach();
        advanceFrame(1200);

        expect(result.current.controlProps.replayFrameIndex).toBe(1);
        expect(store.getSnapshot().playheadMs).toBe(600);
      });

      it.each(['seek', 'load', 'preview'] as const)('rejects in-flight renderer progress after %s', (operation) => {
        const { result } = startPlayback();
        const store = result.current.replayFrameStore;
        const detach = store.registerRenderConsumer();
        const epoch = store.getRenderEpoch();
        const recording = result.current.exportReplayData();
        act(() => {
          switch (operation) {
            case 'seek':
              result.current.controlProps.onSeek(0);
              break;
            case 'load':
              result.current.loadExternalReplay(recording);
              break;
            case 'preview':
              result.current.controlProps.onPreviewSeek(0);
              break;
          }
        });

        store.acknowledgeRender(epoch, 0, 0);

        expect(store.isFrameRendered(0)).toBe(false);
        act(() => result.current.controlProps.onPlayPause());
        advanceFrame(600);
        expect(store.getSnapshot().playheadMs).toBe(0);
        detach();
      });

      it('invalidates a paused renderer acknowledgement when play restarts', () => {
        const { result } = startPlayback();
        const store = result.current.replayFrameStore;
        const detach = store.registerRenderConsumer();
        act(() => result.current.controlProps.onPlayPause());
        const epoch = store.getRenderEpoch();
        store.acknowledgeRender(epoch, 0, 0);

        act(() => result.current.controlProps.onPlayPause());
        store.acknowledgeRender(epoch, 0, 0);
        advanceFrame(600);

        expect(store.getSnapshot().playheadMs).toBe(0);
        detach();
      });

      it('consumes the final frame before stopping and calls playback end exactly once', () => {
        const { result, onPause, onPlaybackEnd } = startPlayback(2);
        const store = result.current.replayFrameStore;
        const detach = store.registerRenderConsumer();
        store.acknowledgeRender(store.getRenderEpoch(), 0, 0);
        advanceFrame(600);
        expect(result.current.controlProps.isPlaying).toBe(true);
        expect(onPlaybackEnd).not.toHaveBeenCalled();
        advanceFrame(700);
        const finalTick = nextFrame;

        store.acknowledgeRender(store.getRenderEpoch(), 1, 600);
        advanceFrame(800);
        act(() => finalTick?.(900));

        expect(result.current.controlProps.isPlaying).toBe(false);
        expect(result.current.replayPlayheadMs).toBe(600);
        expect(onPlaybackEnd).toHaveBeenCalledOnce();
        expect(onPause).not.toHaveBeenCalled();
        detach();
      });

      function startTailPlayback() {
        const hook = createHook();
        act(() => {
          hook.result.current.startRun(makeRunConfig(), makeState(10));
          startLiveClock(hook.result.current);
          hook.result.current.recordCursorClick(50, 60, 'ui', 250);
          hook.result.current.recordViewportSample(250, makeOrbitViewportState(135));
          hook.result.current.controlProps.onEnterReplay();
          hook.result.current.controlProps.onSeek(0);
        });
        act(() => hook.result.current.controlProps.onPlayPause());
        return hook;
      }

      describe.each(['rendererless', 'rendered', 'unrendered'] as const)('%s tail stall', (rendering) => {
        it.each(['final-frame', 'cursor-tail'] as const)('pauses without advancing after a large %s gap', (tail) => {
          const { result, onPause, onPlaybackEnd } = tail === 'final-frame' ? startPlayback(2) : startTailPlayback();
          const store = result.current.replayFrameStore;
          const detach = rendering === 'rendererless' ? undefined : store.registerRenderConsumer();
          advanceFrame(300);
          if (rendering === 'rendered') store.acknowledgeRender(store.getRenderEpoch(), 0, 300);
          const snapshot = store.getSnapshot();

          advanceFrame(5000);

          expect(result.current.controlProps.isPlaying).toBe(false);
          expect(result.current.controlProps.replayFrameIndex).toBe(0);
          expect(result.current.replayPlayheadMs).toBe(300);
          expect(store.getSnapshot()).toBe(snapshot);
          expect(onPause).toHaveBeenCalledOnce();
          expect(onPlaybackEnd).not.toHaveBeenCalled();
          detach?.();
        });

        it('pauses instead of completing when the final playhead is awaiting acknowledgement', () => {
          const { result, onPause, onPlaybackEnd } = startPlayback(2);
          const store = result.current.replayFrameStore;
          const detach = store.registerRenderConsumer();
          store.acknowledgeRender(store.getRenderEpoch(), 0, 0);
          advanceFrame(600);
          if (rendering === 'rendered') store.acknowledgeRender(store.getRenderEpoch(), 1, 600);
          if (rendering === 'rendererless') detach();

          advanceFrame(5600);

          expect(result.current.controlProps.isPlaying).toBe(false);
          expect(result.current.replayPlayheadMs).toBe(600);
          expect(onPause).toHaveBeenCalledOnce();
          expect(onPlaybackEnd).not.toHaveBeenCalled();
          if (rendering !== 'rendererless') detach();
        });
      });

      it('plays a tick that ran late for as long as it took, and reports it as late', () => {
        const { result } = createHook();
        seedRecording(
          result,
          [1, 2].map((tick) => ({ tick, input: [31, 37] satisfies Coordinate, state: makeState(tick), events: [] })),
        );
        const recording = result.current.exportReplayData();
        const starts = [0, 700, 1300];
        act(() =>
          result.current.loadExternalReplay({
            ...recording,
            frames: recording.frames.map((frame, index) => ({
              ...frame,
              startMs: starts[index],
              ...(index === 1 ? { timing: { lateByMs: 100, rafGapMs: 120 } } : {}),
            })),
          }),
        );

        expect(result.current.controlProps.lateTicks).toEqual([{ frameIndex: 1, lateByMs: 100 }]);
        expect(result.current.displayHistory.map((frame) => frame.startMs)).toEqual(starts);
        act(() => result.current.controlProps.onSeek(1));
        expect(result.current.replayPlayheadMs).toBe(700);
        act(() => result.current.controlProps.onSeek(0));
        act(() => result.current.controlProps.onPlayPause());

        const frameAt = (timeMs: number) => {
          advanceFrame(timeMs);
          return result.current.controlProps.replayFrameIndex;
        };
        expect(frameAt(400)).toBe(0);
        expect(frameAt(699)).toBe(0);
        expect(frameAt(700)).toBe(1);
        expect(frameAt(1299)).toBe(1);
        expect(frameAt(1300)).toBe(2);
      });

      it('plays a long one-frame tail normally while RAF progress stays within one tick', () => {
        const { result, onPause, onPlaybackEnd } = startTailPlayback();
        const recording = result.current.exportReplayData();
        act(() => result.current.loadExternalReplay({ ...recording, menuEvents: [{ kind: 'close', tMs: 3000 }] }));
        act(() => result.current.controlProps.onPlayPause());

        for (const timeMs of [500, 1000, 1500, 2000, 2500, 3000]) advanceFrame(timeMs);

        expect(result.current.replayPlayheadMs).toBe(3000);
        expect(onPause).not.toHaveBeenCalled();
        expect(onPlaybackEnd).toHaveBeenCalledOnce();
      });

      it('waits for the final playhead acknowledgement through a one-frame cursor tail', () => {
        const { result, onPause, onPlaybackEnd } = startTailPlayback();
        const store = result.current.replayFrameStore;
        const detach = store.registerRenderConsumer();
        store.acknowledgeRender(store.getRenderEpoch(), 0, 0);

        advanceFrame(670);

        expect(store.getSnapshot().playheadMs).toBe(670);
        expect(result.current.controlProps.isPlaying).toBe(true);
        expect(onPlaybackEnd).not.toHaveBeenCalled();
        const rendered = result.current;
        const snapshot = store.getSnapshot();
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);
        advanceFrame(700);
        store.acknowledgeRender(store.getRenderEpoch(), 0, 669);
        advanceFrame(800);
        expect(result.current).toBe(rendered);
        expect(store.getSnapshot()).toBe(snapshot);
        expect(listener).not.toHaveBeenCalled();
        const finalTick = nextFrame;
        store.acknowledgeRender(store.getRenderEpoch(), 0, 670);
        advanceFrame(900);
        act(() => finalTick?.(1000));
        expect(result.current.controlProps.isPlaying).toBe(false);
        expect(result.current.replayPlayheadMs).toBe(670);
        expect(onPlaybackEnd).toHaveBeenCalledExactlyOnceWith();
        expect(onPause).not.toHaveBeenCalled();
        unsubscribe();
        detach();
      });

      it.each([false, true])('rejects a stale final playhead acknowledgement after seek/load (load: %s)', (load) => {
        const { result, onPlaybackEnd } = startTailPlayback();
        const store = result.current.replayFrameStore;
        const detach = store.registerRenderConsumer();
        const epoch = store.getRenderEpoch();
        const recording = result.current.exportReplayData();
        store.acknowledgeRender(epoch, 0, 670);
        act(() => {
          if (load) result.current.loadExternalReplay(recording);
          else result.current.controlProps.onSeek(0);
        });
        expect(store.isPlayheadRendered(670)).toBe(false);
        act(() => result.current.controlProps.onPlayPause());
        store.acknowledgeRender(store.getRenderEpoch(), 0, 0);

        store.acknowledgeRender(epoch, 0, 670);
        advanceFrame(670);

        expect(result.current.controlProps.isPlaying).toBe(true);
        expect(onPlaybackEnd).not.toHaveBeenCalled();
        store.acknowledgeRender(store.getRenderEpoch(), 0, 670);
        advanceFrame(700);
        expect(onPlaybackEnd).toHaveBeenCalledExactlyOnceWith();
        detach();
      });

      it('completes rendererless playback normally', () => {
        const { result, onPlaybackEnd } = startPlayback(3);
        advanceFrame(600);

        advanceFrame(1200);

        expect(result.current.controlProps.isPlaying).toBe(false);
        expect(result.current.controlProps.replayFrameIndex).toBe(2);
        expect(onPlaybackEnd).toHaveBeenCalledOnce();
      });

      it.each([1, 4])('preserves normal subtick progression and tick events at %sx', (speed) => {
        const { result } = startPlayback(3, speed);
        const store = result.current.replayFrameStore;
        const detach = store.registerRenderConsumer();
        store.acknowledgeRender(store.getRenderEpoch(), 0, 0);
        const rendered = result.current;

        for (const playheadMs of [100, 200, 300, 400, 500]) {
          advanceFrame(playheadMs / speed);
          expect(store.getSnapshot().playheadMs).toBe(playheadMs);
          expect(result.current).toBe(rendered);
        }
        advanceFrame(600 / speed);

        expect(result.current.controlProps.replayFrameIndex).toBe(1);
        expect(result.current.displayEvents).toEqual([makeEvent(1, 1, 'recorded_tick')]);
        detach();
      });

      it.each(['pause', 'seek', 'exit'] as const)('does not signal natural completion on %s', (operation) => {
        const { result, onPlaybackEnd } = startPlayback();

        act(() => {
          switch (operation) {
            case 'pause':
              result.current.controlProps.onPlayPause();
              break;
            case 'seek':
              result.current.controlProps.onSeek(1);
              break;
            case 'exit':
              result.current.controlProps.onExitReplay();
              break;
          }
        });

        expect(onPlaybackEnd).not.toHaveBeenCalled();
      });

      it('pauses immediately while hidden and stays paused when visible again', () => {
        const { result, onPause, onPlaybackEnd } = startPlayback();
        advanceFrame(300);
        const queued = nextFrame;
        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

        act(() => document.dispatchEvent(new Event('visibilitychange')));
        act(() => queued?.(5000));
        visibility.mockReturnValue('visible');
        act(() => document.dispatchEvent(new Event('visibilitychange')));

        expect(result.current.controlProps.isPlaying).toBe(false);
        expect(result.current.replayPlayheadMs).toBe(300);
        expect(onPause).toHaveBeenCalledOnce();
        expect(onPlaybackEnd).not.toHaveBeenCalled();
      });

      it('temporarily suspends the playhead and audio without changing playback intent', () => {
        const { result, rerender, onPause, onResume } = startPlayback();
        advanceFrame(300);
        const queued = nextFrame;
        onResume.mockClear();

        rerender({ playbackHeld: true });
        nowMs = 10000;
        act(() => queued?.(nowMs));

        expect(result.current.controlProps.isPlaying).toBe(true);
        expect(result.current.replayFrameStore.getSnapshot().playheadMs).toBe(300);
        expect(onPause).toHaveBeenCalledOnce();
        rerender({ playbackHeld: false });
        advanceFrame(10300);
        expect(result.current.replayFrameStore.getSnapshot().playheadMs).toBe(600);
        expect(result.current.controlProps.replayFrameIndex).toBe(1);
        expect(onResume).toHaveBeenCalledOnce();
      });

      it('keeps a manual pause made during focus suspension after focus returns', () => {
        const { result, rerender, onResume } = startPlayback();
        advanceFrame(300);
        rerender({ playbackHeld: true });
        onResume.mockClear();

        act(() => result.current.controlProps.onPlayPause());
        rerender({ playbackHeld: false });

        expect(result.current.controlProps.isPlaying).toBe(false);
        expect(result.current.replayFrameStore.getSnapshot().playheadMs).toBe(300);
        expect(onResume).not.toHaveBeenCalled();
      });

      it('does not touch already manually paused playback or audio on focus changes', () => {
        const { result, rerender, onPause, onResume } = startPlayback();
        act(() => result.current.controlProps.onPlayPause());
        onPause.mockClear();
        onResume.mockClear();

        rerender({ playbackHeld: true });
        rerender({ playbackHeld: false });

        expect(result.current.controlProps.isPlaying).toBe(false);
        expect(onPause).not.toHaveBeenCalled();
        expect(onResume).not.toHaveBeenCalled();
      });

      it('keeps hidden-tab pause semantics when the window was already focus-suspended', () => {
        const { result, rerender, onResume } = startPlayback();
        advanceFrame(300);
        rerender({ playbackHeld: true });
        onResume.mockClear();
        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

        act(() => document.dispatchEvent(new Event('visibilitychange')));
        visibility.mockReturnValue('visible');
        act(() => document.dispatchEvent(new Event('visibilitychange')));
        rerender({ playbackHeld: false });

        expect(result.current.controlProps.isPlaying).toBe(false);
        expect(result.current.replayFrameStore.getSnapshot().playheadMs).toBe(300);
        expect(onResume).not.toHaveBeenCalled();
      });

      it('defers play and audio when started while focus-suspended', () => {
        const { result, rerender, onResume } = startPlayback();
        act(() => result.current.controlProps.onPlayPause());
        rerender({ playbackHeld: true });
        onResume.mockClear();

        act(() => result.current.controlProps.onPlayPause());
        const queued = nextFrame;
        nowMs = 10000;
        act(() => queued?.(nowMs));

        expect(result.current.controlProps.isPlaying).toBe(true);
        expect(result.current.replayFrameStore.getSnapshot().playheadMs).toBe(0);
        expect(onResume).not.toHaveBeenCalled();
        rerender({ playbackHeld: false });
        advanceFrame(10300);
        expect(result.current.replayFrameStore.getSnapshot().playheadMs).toBe(300);
        expect(onResume).toHaveBeenCalledOnce();
      });
    });

    it('updates active playback viewport inside a tick before the replay frame advances', () => {
      const rafCallbacks: FrameRequestCallback[] = [];
      const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        rafCallbacks.push(cb);
        return rafCallbacks.length;
      });
      const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
      const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1000);

      try {
        const { result } = createHook();
        const frame0Viewport = makeOrbitViewportState(90);
        const frame1Viewport = makeOrbitViewportState(180);
        act(() => {
          result.current.startRun(makeRunConfig(), makeState(0));
          result.current.recordViewportSample(1000, frame0Viewport);
          result.current.recordViewportSample(1300, makeOrbitViewportState(135));
          result.current.recordFrame(1, [32, 37], makeState(1), [], {
            viewportState: frame1Viewport,
            recordedAtMs: 1600,
          });
          result.current.recordViewportSample(1600, frame1Viewport);
          result.current.controlProps.onEnterReplay();
          result.current.controlProps.onSeek(0);
          result.current.controlProps.onPlayPause();
        });

        const callback = rafCallbacks.at(-1);
        if (!callback) throw new Error('Expected replay playback animation frame callback');

        act(() => callback(1300));

        // During active playback the sub-tick playhead + interpolated camera advance
        // through the external ReplayFrameStore (not React state), so a per-frame update
        // never re-renders Grid/HUD. The displayed frame index still tracks per tick.
        expect(result.current.controlProps.replayFrameIndex).toBe(0);
        // The per-frame contract: React state (replayPlayheadMs) must NOT advance
        // during a sub-tick RAF update — only the store does. Reintroducing a
        // per-frame setState here would re-render the whole tree and fail this.
        expect(result.current.replayPlayheadMs).toBe(0);
        const snapshot = result.current.replayFrameStore.getSnapshot();
        expect(snapshot.playheadMs).toBe(300);
        expect(snapshot.viewportState).toEqual(makeOrbitViewportState(135));
      } finally {
        rafSpy.mockRestore();
        cancelSpy.mockRestore();
        nowSpy.mockRestore();
      }
    });

    it('preserves the sub-tick playhead and viewport when pausing active playback', () => {
      const rafCallbacks: FrameRequestCallback[] = [];
      const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        rafCallbacks.push(cb);
        return rafCallbacks.length;
      });
      const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
      const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1000);

      try {
        const { result } = createHook();
        const frame0Viewport = makeOrbitViewportState(90);
        const frame1Viewport = makeOrbitViewportState(180);
        act(() => {
          result.current.startRun(makeRunConfig(), makeState(0));
          result.current.recordViewportSample(1000, frame0Viewport);
          result.current.recordViewportSample(1300, makeOrbitViewportState(135));
          result.current.recordFrame(1, [32, 37], makeState(1), [], {
            viewportState: frame1Viewport,
            recordedAtMs: 1600,
          });
          result.current.recordViewportSample(1600, frame1Viewport);
          result.current.controlProps.onEnterReplay();
          result.current.controlProps.onSeek(0);
          result.current.controlProps.onPlayPause();
        });

        const callback = rafCallbacks.at(-1);
        if (!callback) throw new Error('Expected replay playback animation frame callback');

        act(() => callback(1300));
        act(() => {
          result.current.controlProps.onPlayPause();
        });

        expect(result.current.controlProps.isPlaying).toBe(false);
        expect(result.current.controlProps.replayFrameIndex).toBe(0);
        expect(result.current.replayPlayheadMs).toBe(300);
        expect(result.current.displayViewportState).toEqual(makeOrbitViewportState(135));
      } finally {
        rafSpy.mockRestore();
        cancelSpy.mockRestore();
        nowSpy.mockRestore();
      }
    });

    it('never steps the playhead backwards when the first RAF timestamp precedes the play press', () => {
      const rafCallbacks: FrameRequestCallback[] = [];
      const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        rafCallbacks.push(cb);
        return rafCallbacks.length;
      });
      const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
      // The play-loop effect samples performance.now() as its base; the browser is
      // free to hand the first rAF callback the FRAME START time, which can be
      // earlier than that sample.
      const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(2000);

      try {
        const { result } = createHook();
        act(() => {
          result.current.startRun(makeRunConfig(), makeState(0));
          result.current.recordFrame(1, [32, 37], makeState(1), [], { recordedAtMs: 1600 });
          result.current.recordFrame(2, [33, 37], makeState(2), [], { recordedAtMs: 2200 });
          result.current.controlProps.onEnterReplay();
          result.current.controlProps.onSeek(1);
          result.current.controlProps.onPlayPause();
        });

        const callback = rafCallbacks.at(-1);
        if (!callback) throw new Error('Expected replay playback animation frame callback');

        act(() => callback(1995));

        // Parked on the frame-1 boundary (600ms). A negative delta would floor to
        // frame 0, which the renderer reads as a rewind and pops its transient state.
        expect(result.current.replayFrameStore.getSnapshot().playheadMs).toBe(600);
        expect(result.current.controlProps.replayFrameIndex).toBe(1);
      } finally {
        rafSpy.mockRestore();
        cancelSpy.mockRestore();
        nowSpy.mockRestore();
      }
    });

    it('clamps seek to 0 for negative indices', () => {
      const { result } = createHook();
      seedRecording(result, [
        { tick: 1, input: [32, 37], state: makeState(1), events: [] },
        { tick: 2, input: [33, 37], state: makeState(2), events: [] },
      ]);

      act(() => {
        result.current.controlProps.onEnterReplay();
        result.current.controlProps.onSeek(-10);
      });

      expect(result.current.controlProps.replayFrameIndex).toBe(0);
    });

    it('calls onSeek callback when seeking below first frame', () => {
      const { result, onSeek } = createHook();
      seedRecording(result, [
        { tick: 1, input: [32, 37], state: makeState(1), events: [] },
        { tick: 2, input: [33, 37], state: makeState(2), events: [] },
      ]);

      act(() => {
        result.current.controlProps.onEnterReplay();
        result.current.controlProps.onSeek(-10);
      });

      expect(onSeek).toHaveBeenCalledWith(0);
    });

    it('clamps seek to the last frame for out-of-range indices', () => {
      const { result } = createHook();
      seedRecording(result, [
        { tick: 1, input: [32, 37], state: makeState(1), events: [] },
        { tick: 2, input: [33, 37], state: makeState(2), events: [] },
      ]);

      act(() => {
        result.current.controlProps.onEnterReplay();
        result.current.controlProps.onSeek(999);
      });

      expect(result.current.controlProps.replayFrameIndex).toBe(result.current.controlProps.totalFrames - 1);
    });

    it('seeks to a valid frame index without clamping', () => {
      const { result } = createHook();
      seedRecording(result, [
        { tick: 1, input: [32, 37], state: makeState(1), events: [] },
        { tick: 2, input: [33, 37], state: makeState(2), events: [] },
        { tick: 3, input: [34, 37], state: makeState(3), events: [] },
      ]);

      act(() => {
        result.current.controlProps.onEnterReplay();
        result.current.controlProps.onSeek(2);
      });

      expect(result.current.controlProps.replayFrameIndex).toBe(2);
    });

    it('calls onEnterReplay callback when entering replay', () => {
      const { result, onEnterReplay } = createHook();
      seedRecording(result, [{ tick: 1, input: [32, 37], state: makeState(1), events: [] }]);

      act(() => {
        result.current.controlProps.onEnterReplay();
      });

      expect(onEnterReplay).toHaveBeenCalledTimes(1);
      expect(result.current.replayMode).toBe(true);
    });

    it('calls onExitReplay callback when exiting replay', () => {
      const { result, onExitReplay } = createHook();
      seedRecording(result, [{ tick: 1, input: [32, 37], state: makeState(1), events: [] }]);

      act(() => {
        result.current.controlProps.onEnterReplay();
        result.current.controlProps.onExitReplay();
      });

      expect(onExitReplay).toHaveBeenCalledTimes(1);
      expect(result.current.replayMode).toBe(false);
    });
    it('runs the onSeek reset path for step and jump controls, not only the slider', () => {
      const { result, onSeek } = createHook();
      seedRecording(result, [
        { tick: 1, input: [32, 37], state: makeState(1), events: [] },
        { tick: 2, input: [33, 37], state: makeState(2), events: [] },
        { tick: 3, input: [34, 37], state: makeState(3), events: [] },
      ]);
      act(() => {
        result.current.controlProps.onEnterReplay();
      }); // lands on last frame (index 3)
      onSeek.mockClear();

      act(() => {
        result.current.controlProps.onStepBack();
      });
      expect(onSeek).toHaveBeenLastCalledWith(2);

      act(() => {
        result.current.controlProps.onStepForward();
      });
      expect(onSeek).toHaveBeenLastCalledWith(3);

      act(() => {
        result.current.controlProps.onJumpToStart();
      });
      expect(onSeek).toHaveBeenLastCalledWith(0);

      act(() => {
        result.current.controlProps.onJumpToEnd();
      });
      expect(onSeek).toHaveBeenLastCalledWith(3);
    });

    it('stops audio on pause and restarts from frame 0 when Play is pressed at the end', () => {
      const { result, onPause, onSeek } = createHook();
      seedRecording(result, [
        { tick: 1, input: [32, 37], state: makeState(1), events: [] },
        { tick: 2, input: [33, 37], state: makeState(2), events: [] },
      ]);
      act(() => {
        result.current.controlProps.onEnterReplay();
      }); // parked at last frame, not playing
      onSeek.mockClear();
      onPause.mockClear();

      // Play while parked at the end restarts from frame 0 (otherwise Play no-ops).
      act(() => {
        result.current.controlProps.onPlayPause();
      });
      expect(result.current.controlProps.isPlaying).toBe(true);
      expect(result.current.controlProps.replayFrameIndex).toBe(0);
      expect(onSeek).toHaveBeenCalledWith(0);

      // Pausing stops already-playing/delayed audio.
      act(() => {
        result.current.controlProps.onPlayPause();
      });
      expect(result.current.controlProps.isPlaying).toBe(false);
      expect(onPause).toHaveBeenCalledTimes(1);
    });

    it('notifies resume only when starting playback, after any restart seek', () => {
      const { result, onResume, onSeek, rerender } = createHook();
      seedRecording(result, [
        { tick: 1, input: [32, 37], state: makeState(1), events: [] },
        { tick: 2, input: [33, 37], state: makeState(2), events: [] },
      ]);
      act(() => result.current.controlProps.onEnterReplay());
      expect(onResume).not.toHaveBeenCalled();

      act(() => result.current.controlProps.onPlayPause());

      expect(onResume).toHaveBeenCalledOnce();
      expect(onSeek.mock.invocationCallOrder[0]).toBeLessThan(onResume.mock.invocationCallOrder[0]);
      rerender({ playbackHeld: false });
      act(() => result.current.controlProps.onPlayPause());
      expect(onResume).toHaveBeenCalledOnce();
      act(() => result.current.controlProps.onPlayPause());
      expect(onResume).toHaveBeenCalledTimes(2);
      act(() => result.current.controlProps.onSeek(1));
      act(() => result.current.controlProps.onExitReplay());
      expect(onResume).toHaveBeenCalledTimes(2);
    });

    it('plays a final-frame click tail without restarting at the frame boundary', () => {
      const rafCallbacks: FrameRequestCallback[] = [];
      const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
        rafCallbacks.push(callback);
        return rafCallbacks.length;
      });
      const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
      const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1000);

      try {
        const { result, onSeek } = createHook();
        act(() => {
          result.current.startRun(makeRunConfig(), makeState(0));
          startLiveClock(result.current);
          result.current.recordCursorClick(50, 60, 'ui', 1250);
          result.current.controlProps.onEnterReplay();
        });
        const replayEndMs = 250 + getReplayClickDurationMs('ui');
        expect(result.current.replayPlayheadMs).toBe(replayEndMs);

        act(() => result.current.controlProps.onSeek(0));
        onSeek.mockClear();

        act(() => result.current.controlProps.onPlayPause());
        const callback = rafCallbacks.at(-1);
        if (!callback) throw new Error('Expected replay playback animation frame callback');
        act(() => callback(1000 + replayEndMs));

        expect(onSeek).not.toHaveBeenCalled();
        expect(result.current.replayPlayheadMs).toBe(replayEndMs);
        expect(result.current.controlProps.isPlaying).toBe(false);
      } finally {
        rafSpy.mockRestore();
        cancelSpy.mockRestore();
        nowSpy.mockRestore();
      }
    });

    it('a stale play-loop RAF callback cannot advance past a manual seek', () => {
      // Capture (don't auto-run) RAF callbacks, and freeze time so an invoked
      // callback sees > 1 tick of elapsed time (and would therefore advance).
      const rafCallbacks: FrameRequestCallback[] = [];
      const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        rafCallbacks.push(cb);
        return rafCallbacks.length;
      });
      const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
      const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(0);

      try {
        const { result } = createHook();
        seedRecording(result, [
          { tick: 1, input: [32, 37], state: makeState(1), events: [] },
          { tick: 2, input: [33, 37], state: makeState(2), events: [] },
          { tick: 3, input: [34, 37], state: makeState(3), events: [] },
        ]);

        act(() => {
          result.current.controlProps.onEnterReplay();
          result.current.controlProps.onSeek(0);
        });
        act(() => {
          result.current.controlProps.onPlayPause();
        }); // play from frame 0
        expect(result.current.controlProps.isPlaying).toBe(true);

        // The play effect scheduled exactly one RAF tick; capture it.
        const staleTick = rafCallbacks[rafCallbacks.length - 1];
        expect(typeof staleTick).toBe('function');

        // A manual step races the play loop: seekTo sets playLoopActiveRef false
        // synchronously and pauses, landing on frame 1.
        act(() => {
          result.current.controlProps.onStepForward();
        });
        expect(result.current.controlProps.replayFrameIndex).toBe(1);
        expect(result.current.controlProps.isPlaying).toBe(false);

        // The already-scheduled RAF now fires with > 1 tick of elapsed time.
        // Without the guard it would advance 1 -> 2; the guard makes it a no-op.
        act(() => {
          staleTick(1000);
        });

        expect(result.current.controlProps.replayFrameIndex).toBe(1);
      } finally {
        rafSpy.mockRestore();
        cancelSpy.mockRestore();
        nowSpy.mockRestore();
      }
    });
  });

  function makePresentation(overrides: Partial<ReplayPresentationState> = {}): ReplayPresentationState {
    return {
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
        infoboxPinTarget: 'inventory',
        showCoordinates: false,
      },
      ...overrides,
    };
  }

  it('snapshots the layout at run start, so a run that never changes it still has one', () => {
    // startRun clears the presentation track, and the change-driven effect only
    // fires when the layout actually moves. Without the snapshot, a recorder who
    // never touches theirs for a whole fight would produce an EMPTY track, and
    // playback would rebuild nothing and fall back to the viewer's own layout.
    const engineRef = { current: { isTutorialPaused: () => false, getState: () => makeState(0) } as SimulationEngine };
    const presentation = makePresentation();

    const { result } = renderHook(() =>
      useReplay({
        engineRef,
        simulationState: makeState(0),
        speedMultiplier: 1,
        mechanicsConfig: { infiniteHealth: false },
        objTypeLoader: null,
        onTakeOver: vi.fn(),
        getPresentationState: () => presentation,
      }),
    );

    act(() => {
      result.current.startRun(makeRunConfig(), makeState(0));
    });

    expect(result.current.displayPresentationState).toBeNull(); // not replaying yet
    act(() => {
      result.current.controlProps.onEnterReplay();
    });
    expect(result.current.displayPresentationState).toEqual(presentation);
  });

  it('enters and plays through a presentation-only tail after the final frame', () => {
    const callbacks: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      const { result, onSeek } = createHook();
      const presentation = makePresentation({ uiScale: 1.4 });
      act(() => {
        result.current.startRun(makeRunConfig(), makeState(0));
        startLiveClock(result.current);
        result.current.recordPresentationState(presentation, 250);
        result.current.controlProps.onEnterReplay();
      });
      expect(result.current.replayPlayheadMs).toBe(250);
      expect(result.current.displayPresentationState).toEqual(presentation);
      act(() => result.current.controlProps.onSeek(0));
      onSeek.mockClear();

      act(() => result.current.controlProps.onPlayPause());
      const callback = callbacks.at(-1);
      if (!callback) throw new Error('Missing playback callback');
      act(() => callback(250));

      expect(onSeek).not.toHaveBeenCalled();
      expect(result.current.replayPlayheadMs).toBe(250);
      expect(result.current.displayPresentationState).toEqual(presentation);
      expect(result.current.controlProps.isPlaying).toBe(false);
    } finally {
      raf.mockRestore();
      cancel.mockRestore();
      now.mockRestore();
    }
  });

  it('advances the layout while the replay is PLAYING, not only on seek', () => {
    // The play loop drives the playhead through ReplayFrameStore and deliberately
    // never setState's, so resolving the layout from the React playhead left it
    // frozen at whatever it was when playback started: a panel move or a resize
    // made mid-recording never applied while the replay was actually running.
    const rafCallbacks: FrameRequestCallback[] = [];
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(0);

    try {
      const engineRef = {
        current: { isTutorialPaused: () => false, getState: () => makeState(0) } as SimulationEngine,
      };
      const before = makePresentation();
      const after = makePresentation({ uiScale: 1.4 });
      let current = before;

      const { result } = renderHook(() =>
        useReplay({
          engineRef,
          simulationState: makeState(0),
          speedMultiplier: 1,
          mechanicsConfig: { infiniteHealth: false },
          objTypeLoader: null,
          onTakeOver: vi.fn(),
          getPresentationState: () => current,
        }),
      );

      act(() => {
        result.current.startRun(makeRunConfig(), makeState(0));
        result.current.recordFrame(1, [32, 37], makeState(1), []);
      });
      // The recorder moved something one tick in, so the change sits early in the
      // track and any forward playback crosses it.
      current = after;
      act(() => {
        result.current.recordPresentationState(after, 0);
      });
      act(() => {
        // A long enough recording that the RAF below lands MID-playback. Running
        // to the end would sync the React playhead on the terminal branch and hide
        // exactly the staleness this is testing.
        for (const tick of [2, 3, 4, 5, 6, 7, 8, 9]) {
          result.current.recordFrame(tick, [32, 37], makeState(tick), []);
        }
      });

      act(() => {
        result.current.controlProps.onEnterReplay();
        result.current.controlProps.onSeek(0);
      });
      expect(result.current.displayPresentationState).toEqual(before);

      act(() => {
        result.current.controlProps.onPlayPause();
      });
      // Advance past the change but nowhere near the end, with no discrete seek.
      act(() => {
        rafCallbacks[rafCallbacks.length - 1]?.(700);
      });

      expect(result.current.displayPresentationState).toEqual(after);
    } finally {
      rafSpy.mockRestore();
      cancelSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });

  it('releases the recorded layout exactly at its cutoff during playback and restores it on rewind', () => {
    const callbacks: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      const engine = new SimulationEngine({ encounter: encounterRegistry.create('yama_p3') });
      const presentation = makePresentation();
      const { result } = renderHook(() =>
        useReplay({
          engineRef: { current: engine },
          simulationState: engine.getState(),
          speedMultiplier: 1,
          mechanicsConfig: { infiniteHealth: false },
          objTypeLoader: null,
          onTakeOver: vi.fn(),
          getPresentationState: () => presentation,
        }),
      );
      act(() => {
        result.current.startRun(makeRunConfig(), makeState(0));
        result.current.recordFrame(1, [32, 37], makeState(1), []);
        result.current.recordFrame(2, [32, 37], makeState(2), []);
      });
      const data = result.current.exportReplayData();
      act(() =>
        result.current.loadExternalReplay({
          ...data,
          capture: {
            ...freshReplayCapture(),
            presentationSamples: { provenance: 'bounded-v1', stoppedAtMs: 100, reason: 'entry-limit' },
          },
        }),
      );
      act(() => result.current.controlProps.onSeek(0));
      act(() => result.current.controlProps.onPlayPause());
      act(() => callbacks.at(-1)?.(99.5));
      expect(result.current.displayPresentationState).toEqual(presentation);
      act(() => callbacks.at(-1)?.(100));
      expect(result.current.displayPresentationState).toBeNull();
      expect(result.current.controlProps.isPlaying).toBe(true);
      act(() => result.current.controlProps.onSeek(0));
      expect(result.current.displayPresentationState).toEqual(presentation);
    } finally {
      raf.mockRestore();
      cancel.mockRestore();
      now.mockRestore();
    }
  });
});

describe('useReplay overlay snapshot', () => {
  const OVERLAYS: ReplayOverlays = {
    tileMarkers: [{ x: 31, y: 37, color: '#3BA9FF', opacity: 1 }],
    showTileMarkers: true,
    showTileMarkerLabels: false,
    lineMarkers: [],
    showLineMarkers: true,
    showLineMarkerLabels: true,
    lineMarkerWidth: 2,
  };

  function createOverlayHook(getOverlays?: () => ReplayOverlays | null) {
    const engine = new SimulationEngine({ encounter: encounterRegistry.create('yama_p3') });
    return renderHook(() =>
      useReplay({
        engineRef: { current: engine },
        simulationState: engine.getState(),
        speedMultiplier: 1,
        mechanicsConfig: { infiniteHealth: false },
        objTypeLoader: null,
        onTakeOver: vi.fn(),
        ...(getOverlays ? { getOverlays } : {}),
      }),
    );
  }

  it('withholds the recorded markers while the run is still being recorded', () => {
    const { result } = createOverlayHook(() => OVERLAYS);

    act(() => result.current.startRun(RUN_CONFIG, result.current.displayState));

    // Non-null here would draw the snapshot over the live arena mid-fight.
    expect(result.current.displayOverlays).toBeNull();
  });

  it('serves the run-start markers once playback starts', () => {
    const { result } = createOverlayHook(() => OVERLAYS);

    act(() => {
      result.current.startRun(RUN_CONFIG, result.current.displayState);
      result.current.controlProps.onEnterReplay();
    });

    expect(result.current.displayOverlays).toEqual(OVERLAYS);
  });

  it('holds the snapshot taken at run start, not whatever the markers became later', () => {
    let current = OVERLAYS;
    const { result } = createOverlayHook(() => current);

    act(() => result.current.startRun(RUN_CONFIG, result.current.displayState));
    current = { ...OVERLAYS, tileMarkers: [], showTileMarkers: false };
    act(() => result.current.controlProps.onEnterReplay());

    expect(result.current.displayOverlays).toEqual(OVERLAYS);
  });

  it('reports none for a recording that captured none, so playback keeps the viewer markers', () => {
    const { result } = createOverlayHook();

    act(() => {
      result.current.startRun(RUN_CONFIG, result.current.displayState);
      result.current.controlProps.onEnterReplay();
    });

    expect(result.current.displayOverlays).toBeNull();
  });
});

describe('useReplay modifier track', () => {
  afterEach(() => {
    __resetKeyStateForTest();
  });

  function pressShift(): void {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true }));
  }

  function releaseShift(): void {
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', shiftKey: false }));
  }

  it('records a baseline at run start so the early playhead resolves', () => {
    const { result } = createHook();
    pressShift();

    act(() => result.current.startRun(RUN_CONFIG, result.current.displayState));

    // Without this sample a run begun with Shift already down would report it
    // released until the first release.
    expect(modifierMaskAt(result.current.modifierTrack, 0)).toBe(MODIFIER_BIT.shift);
  });

  it('appends a sample per transition and nothing in between', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const { result } = createHook();
    act(() => result.current.startRun(RUN_CONFIG, result.current.displayState));
    startLiveClock(result.current);
    const baseline = result.current.modifierTrack.length;

    act(() => {
      now.mockReturnValue(1010);
      pressShift();
      // A second event carrying the same state must not append.
      window.dispatchEvent(new MouseEvent('mousemove', { shiftKey: true }));
      now.mockReturnValue(1020);
      releaseShift();
    });

    expect(result.current.modifierTrack.length).toBe(baseline + 2);
    expect(result.current.modifierTrack.at(-2)?.mask).toBe(MODIFIER_BIT.shift);
    expect(result.current.modifierTrack.at(-1)?.mask).toBe(0);
  });

  it('ignores presses the app synthesized rather than the user', () => {
    const { result } = createHook();
    act(() => result.current.startRun(RUN_CONFIG, result.current.displayState));
    const baseline = result.current.modifierTrack.length;

    act(() => {
      runSyntheticInput(() => window.dispatchEvent(new MouseEvent('mousemove', { shiftKey: true })));
    });

    expect(result.current.modifierTrack.length).toBe(baseline);
  });

  it('records nothing before a run has started', () => {
    const { result } = createHook();

    act(() => {
      pressShift();
      releaseShift();
    });

    expect(result.current.modifierTrack).toEqual([]);
  });
});
