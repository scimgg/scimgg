// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { type ComponentProps, Profiler, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplayFrameProvider } from '../../../contexts/ReplayFrameContext';
import { type SettingsGridContextValue, SettingsProvider } from '../../../contexts/SettingsContext';
import { type SimulationGridContextValue, SimulationProvider } from '../../../contexts/SimulationContext';
import type { ReplayDisplayFrame, ReplayViewportState } from '../../../core/ReplayRecorder';
import { ReplayFrameStore } from '../../../core/replayFrameStore';
import { ReplaySafetyError } from '../../../core/replaySafety';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { INFERNO_RENDER_CONFIG } from '../../../encounters/inferno/renderConfig';
import { LobbyEncounter } from '../../../encounters/lobby/LobbyEncounter';
import { SolHereditEncounter } from '../../../encounters/solHeredit/SolHereditEncounter';
import { DEFAULT_CAMERA_KEYBINDS } from '../../../hooks/useCameraKeybinds';
import { PERSISTED_SETTINGS_DEFAULTS, resolveAntialias } from '../../../hooks/usePersistedSettings';
import { useReplay } from '../../../hooks/useReplay';
import { runSyntheticInput } from '../../../input/inputProvenance';
import { REPLAY_CLICK_OWNER_ATTRIBUTE, REPLAY_CLICK_OWNERS } from '../../../input/replayClickFeedback';
import { TOUCH_SLOP_PX } from '../../../input/touchHold';
import { TOUCH_LONG_PRESS_DEFAULT_MS } from '../../../input/touchPrefs';
import { CacheIndexDat } from '../../../rs/cache/CacheIndex';
import { IndexType } from '../../../rs/cache/IndexType';
import { ReferenceTable } from '../../../rs/cache/ref/ReferenceTable';
import { MemoryStore } from '../../../rs/cache/store/MemoryStore';
import { MapLoader } from '../../../rs/map/MapLoader';
import { NpcModelLoader } from '../../../rs/model/NpcModelLoader';
import type { PlayerModelLoader } from '../../../rs/model/PlayerModelLoader';
import type { SpotAnimModelLoader } from '../../../rs/model/SpotAnimModelLoader';
import type { TextureLoader } from '../../../rs/texture/TextureLoader';
import { yamaSnapshot } from '../../../test/helpers/encounterSnapshot';
import { stubMaxTouchPoints } from '../../../test/helpers/maxTouchPoints';
import { setWatchInputGated } from '../../../tutorial/runtime/tutorialInputBoundary';
import { createEmptyCombatSupplies } from '../../../types/encounterLoadout';
import { createEmptyStats as createEmptyEquipmentStats } from '../../../types/equipmentStats';
import { createEmptyInventory } from '../../../types/inventory';
import { DEFAULT_PLAYER_CONFIG } from '../../../types/player';
import {
  createDefaultRunEnergy,
  createDefaultSpecialAttack,
  createDefaultStats,
  createDefaultTimers,
} from '../../../types/playerState';
import type { Coordinate, SimulationState } from '../../../types/simulation';
import type { StartPositionPreparation } from '../../../types/startPositionPreparation';
import { log } from '../../../util/Logger';
import { AnimationSystem } from '../../backends/picogl/AnimationSystem';
import { createPicoGLRenderer, type PicoGLRenderer } from '../../backends/picogl/PicoGLRenderer';
import {
  createQueue,
  isResidentMesh3DCommand,
  OVERLAY_LAYER_Z_INDEX,
  type RenderQueue,
  type ResidentMesh3DCommand,
} from '../../core/commands';
import { ImmutableMeshSource } from '../../core/meshSource';
import {
  type ContextStatusRenderer,
  createNullAssetManager,
  type Renderer,
  RendererUnsupportedError,
  type RenderFrame,
  type RenderStatus,
  type TextureCapableRenderer,
} from '../../core/renderer';
import type { FightStartCountdownPhase } from '../../graphics/sceneObjectTypes';
import { createProjection3D, getOsrsCameraDistance, type Projection3D } from '../../projections/Projection3D';
import { orbitCameraStateToReplayViewportState } from '../../projections/replayViewportMapper';
import { InfernoSceneCompositor } from '../../scene/InfernoSceneCompositor';
import type { RenderContext, SceneBuilderLike, SceneCutsceneFrame } from '../../scene/types';
import { createZukSceneBuilder } from '../../scene/zukSceneBuilder';
import { MAX_CONSECUTIVE_LIVE_FRAME_FAILURES, RenderViewport3D } from '../RenderViewport3D';

function makeSimulationState(): SimulationState {
  const playerPosition: [number, number] = [31, 37];
  const npcPosition: [number, number] = [29, 28];

  return {
    currentTick: 10,
    groundItems: [],
    playerPosition,
    playerPreviousPosition: playerPosition,
    playerMovementPath: [],
    playerFacingAngle: 0,
    playerIsMoving: false,
    playerIsRunning: false,
    primaryNpcPosition: npcPosition,
    primaryNpcPreviousPosition: npcPosition,
    primaryNpcFacingAngle: 0,
    primaryNpcSize: 5,
    playerOutline: undefined,
    npcs: [],
    encounter: yamaSnapshot({ state: { firstRangeMageType: 'magic' } }),
    encounterOutcome: { phase: 'active' },
    isAlive: true,
    markOfDarknessActive: false,
    markOfDarknessTicksRemaining: 0,
    activePrayer: null,
    boostPrayers: [],
    independentPrayers: [],
    failedCondition: null,
    playerHistory: new Map([[10, playerPosition]]),
    primaryNpcHistory: new Map([[10, npcPosition]]),
    playerHP: 99,
    maxHP: 99,
    poisonVarp: 0,
    poisonTickCounter: 30,
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
    prayerState: { points: 99, maxPoints: 99, drainCounter: 0, activePrayers: [], prayerActivationTicks: {} },
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

function makeRenderer(): Renderer {
  return {
    id: 'test-renderer',
    supports: () => true,
    init: () => {},
    resize: () => {},
    render: () => {},
    assets: createNullAssetManager(),
    dispose: () => {},
  };
}

function makeSceneBuilder(): SceneBuilderLike {
  return {
    build: () => createQueue(),
    loadTerrain: () => Promise.resolve(),
    isTerrainLoaded: () => true,
    loadNpc: () => Promise.resolve(),
    isNpcLoaded: () => true,
    loadPlayer: () => Promise.resolve(),
    isPlayerLoaded: () => true,
    loadSpotAnims: () => Promise.resolve(),
    isSpotAnimsLoaded: () => true,
    loadLocs: () => Promise.resolve(),
    isLocsLoaded: () => true,
  };
}

function makeProjection3D(): Projection3D {
  return createProjection3D(
    { width: 800, height: 600, dpr: 1 },
    {
      pitch: -45,
      yaw: 180,
      targetX: 31.5,
      targetY: 37.5,
      targetZ: 0.9,
    },
  );
}

function makeReplayViewportState(yawDeg: number, fovScale: number): ReplayViewportState {
  return {
    kind: 'orbit3d',
    pitchDeg: -35,
    yawDeg,
    fovScale,
    target: { x: 30.5, y: 36.5, z: 1.1 },
  };
}

function getViewportContainer(): HTMLElement {
  const canvas = screen.getByLabelText('3D Game Grid');
  const container = canvas.parentElement;
  expect(container).toBeInstanceOf(HTMLElement);
  if (container instanceof HTMLElement) return container;
  throw new TypeError('3D viewport container was not rendered');
}

function stubCanvasRect(canvas: HTMLElement): void {
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));
}

function mouseDownEvent(init: MouseEventInit, timeStamp: number): MouseEvent {
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, 'timeStamp', { value: timeStamp, configurable: true });
  return event;
}

beforeEach(() => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((_callback: FrameRequestCallback) => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  cleanup();
  setWatchInputGated(false);
  Object.defineProperty(document, 'pointerLockElement', { configurable: true, value: null });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('RenderViewport3D graphics settings', () => {
  it.each([
    [3, 0.85, 1.7],
    [1.5, 0.85, 1.275],
  ])('caps device density %s at 2 while preserving render scale %s', (devicePixelRatio, renderScale, expectedDpr) => {
    vi.stubGlobal('devicePixelRatio', devicePixelRatio);
    const renderer = makeRenderer();
    const resize = vi.spyOn(renderer, 'resize');
    const projection = makeProjection3D();
    const project = () => projection.tileToScreen({ x: 31, y: 37 });
    const props = {
      simulationState: makeSimulationState(),
      onTileClick: vi.fn(),
      showCoordinates: false,
      renderer,
      sceneBuilder: makeSceneBuilder(),
      projection3D: projection,
    };
    const { rerender } = render(<RenderViewport3D {...props} renderScale={1} />);
    const before = project();
    rerender(<RenderViewport3D {...props} renderScale={renderScale} />);
    expect(resize).toHaveBeenLastCalledWith({ width: 800, height: 600, dpr: expectedDpr });
    const after = project();
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    // Integer raster dimensions can round differently; framing stays within one CSS pixel.
    expect(after?.x).toBeCloseTo(before?.x ?? 0, 0);
    expect(after?.y).toBeCloseTo(before?.y ?? 0, 0);
  });

  it('initializes the renderer with the anti-aliasing setting without recreating it on re-render', () => {
    const renderer = makeRenderer();
    const init = vi.spyOn(renderer, 'init');
    const dispose = vi.spyOn(renderer, 'dispose');
    const props = {
      simulationState: makeSimulationState(),
      onTileClick: vi.fn(),
      showCoordinates: false,
      renderer,
      sceneBuilder: makeSceneBuilder(),
    };
    const tree = (antialias: boolean) => (
      <SettingsProvider value={{ antialias } as SettingsGridContextValue}>
        <RenderViewport3D {...props} />
      </SettingsProvider>
    );
    const { rerender, unmount } = render(tree(false));
    expect(init).toHaveBeenCalledExactlyOnceWith(screen.getByLabelText('3D Game Grid'), {
      antialias: false,
    });
    rerender(tree(true));
    expect(init).toHaveBeenCalledOnce();
    unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'off on iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
      false,
    ],
    [
      'on on Android',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
      true,
    ],
  ] as const)('initializes the renderer with the Auto default %s', (_name, userAgent, expected) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    const renderer = makeRenderer();
    const init = vi.spyOn(renderer, 'init');
    // App's path: the stored preference resolved once, then handed down through the settings context.
    const antialias = resolveAntialias(PERSISTED_SETTINGS_DEFAULTS.antiAliasing, 'hardware');
    render(
      <SettingsProvider value={{ antialias } as SettingsGridContextValue}>
        <RenderViewport3D
          simulationState={makeSimulationState()}
          onTileClick={vi.fn()}
          showCoordinates={false}
          renderer={renderer}
          sceneBuilder={makeSceneBuilder()}
        />
      </SettingsProvider>,
    );
    expect(init).toHaveBeenCalledExactlyOnceWith(screen.getByLabelText('3D Game Grid'), {
      antialias: expected,
    });
  });

  it('leaves anti-aliasing to the renderer default without a settings context', () => {
    const renderer = makeRenderer();
    const init = vi.spyOn(renderer, 'init');
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={renderer}
        sceneBuilder={makeSceneBuilder()}
      />,
    );
    expect(init).toHaveBeenCalledExactlyOnceWith(screen.getByLabelText('3D Game Grid'), {
      antialias: undefined,
    });
  });
});

describe('RenderViewport3D mouse input', () => {
  it.each([
    'paused-first',
    'paused-seek',
    'playing-seek',
  ] as const)('latches %s render failure once, skips partial drawing, and recovers for new history/live', (mode) => {
    let frame: FrameRequestCallback | undefined;
    let scheduled = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return ++scheduled;
    });
    const store = new ReplayFrameStore();
    const state = makeSimulationState();
    const history = [
      { state, events: [] },
      { state: { ...state, currentTick: 11 }, events: [] },
    ];
    store.setHistory(history);
    const error = new ReplaySafetyError('projectile-work-limit');
    let shouldFail = mode === 'paused-first';
    const build = vi.fn(() => {
      if (shouldFail) throw error;
      return createQueue();
    });
    const renderer = makeRenderer();
    const draw = vi.spyOn(renderer, 'render');
    const failed = vi.spyOn(store, 'failRender');
    const acknowledged = vi.spyOn(store, 'acknowledgeRender');
    const builder = { ...makeSceneBuilder(), build };
    const tree = (replaying: boolean) => (
      <ReplayFrameProvider store={store}>
        <RenderViewport3D
          simulationState={state}
          onTileClick={vi.fn()}
          showCoordinates={false}
          renderer={renderer}
          sceneBuilder={builder}
          replayIsReplaying={replaying}
          replayPlaying={mode === 'playing-seek'}
          replayPaused={mode !== 'playing-seek'}
        />
      </ReplayFrameProvider>
    );
    const view = render(tree(true));
    if (mode !== 'paused-first') {
      act(() => frame?.(1000));
      expect(draw).toHaveBeenCalledOnce();
      act(() => {
        if (mode === 'paused-seek') store.setPreview({ frameIndex: 1, ...history[1] });
        else store.set(600, undefined);
      });
      shouldFail = true;
      draw.mockClear();
      acknowledged.mockClear();
    }

    expect(() => act(() => frame?.(1016))).not.toThrow();

    expect(store.getRenderFailure()).toEqual({
      error,
      frameIndex: mode === 'paused-first' ? 0 : 1,
      playheadMs: mode === 'playing-seek' ? 600 : 0,
    });
    expect(draw).not.toHaveBeenCalled();
    expect(acknowledged).not.toHaveBeenCalled();
    expect(store.isFrameRendered(0)).toBe(false);
    const buildsAtFailure = build.mock.calls.length;
    const scheduledAtFailure = scheduled;
    act(() => store.resetRenderProgress());
    for (let step = 0; step < 4; step++) act(() => frame?.(1032 + step * 16));
    expect(build).toHaveBeenCalledTimes(buildsAtFailure);
    expect(failed).toHaveBeenCalledOnce();
    expect(scheduled).toBe(scheduledAtFailure + 4);

    shouldFail = false;
    act(() => {
      store.setHistory([...history]);
      store.set(0, undefined);
    });
    act(() => frame?.(1200));
    expect(store.getRenderFailure()).toBeUndefined();
    expect(draw).toHaveBeenCalledOnce();

    shouldFail = true;
    act(() => frame?.(1216));
    expect(store.getRenderFailure()?.error).toBe(error);
    shouldFail = false;
    act(() => store.setHistory(undefined));
    view.rerender(tree(false));
    act(() => frame?.(1232));
    expect(store.getRenderFailure()).toBeUndefined();
    expect(draw).toHaveBeenCalledTimes(2);
  });

  it('latches failures before movement callbacks and never stringifies an unknown thrown payload', () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const store = new ReplayFrameStore();
    store.setHistory([{ state: makeSimulationState(), events: [] }]);
    const payload = { toString: vi.fn(() => 'private replay payload') };
    const block = vi.fn(() => {
      throw payload;
    });
    const build = vi.fn(() => createQueue());
    const renderer = makeRenderer();
    const draw = vi.spyOn(renderer, 'render');
    render(
      <ReplayFrameProvider store={store}>
        <RenderViewport3D
          simulationState={makeSimulationState()}
          onTileClick={vi.fn()}
          showCoordinates={false}
          renderer={renderer}
          sceneBuilder={{ ...makeSceneBuilder(), build, getPrimaryAnimMovementBlock: block }}
          replayIsReplaying
        />
      </ReplayFrameProvider>,
    );

    expect(() => act(() => frame?.(1000))).not.toThrow();
    act(() => frame?.(1016));

    expect(block).toHaveBeenCalledOnce();
    expect(build).not.toHaveBeenCalled();
    expect(draw).not.toHaveBeenCalled();
    expect(store.getRenderFailure()?.error).toEqual(new Error('Replay rendering failed'));
    expect(payload.toString).not.toHaveBeenCalled();
  });

  it('does not poison a replacement history with an error from the old render epoch', () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const store = new ReplayFrameStore();
    const history = [{ state: makeSimulationState(), events: [] }];
    store.setHistory(history);
    const build = vi
      .fn(() => createQueue())
      .mockImplementationOnce(() => {
        store.setHistory([...history]);
        throw new ReplaySafetyError('invalid-clock');
      });
    const renderer = makeRenderer();
    const draw = vi.spyOn(renderer, 'render');
    render(
      <ReplayFrameProvider store={store}>
        <RenderViewport3D
          simulationState={makeSimulationState()}
          onTileClick={vi.fn()}
          showCoordinates={false}
          renderer={renderer}
          sceneBuilder={{ ...makeSceneBuilder(), build }}
          replayIsReplaying
          replayPlaying
        />
      </ReplayFrameProvider>,
    );

    expect(() => act(() => frame?.(1000))).not.toThrow();
    expect(store.getRenderFailure()).toBeUndefined();
    expect(draw).not.toHaveBeenCalled();
    act(() => frame?.(1016));
    expect(draw).toHaveBeenCalledOnce();
    expect(store.isFrameRendered(0)).toBe(true);
  });

  it('keeps the live loop alive through a thrown frame, reports it once, and never publishes a replay failure', () => {
    let frame: FrameRequestCallback | undefined;
    let scheduled = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return ++scheduled;
    });
    const store = new ReplayFrameStore();
    const error = new TypeError('live render error');
    let shouldFail = true;
    const build = vi.fn(() => {
      if (shouldFail) throw error;
      return createQueue();
    });
    const reported = vi.spyOn(log, 'error').mockImplementation(() => {});
    const statuses: RenderStatus[] = [];
    render(
      <ReplayFrameProvider store={store}>
        <RenderViewport3D
          simulationState={makeSimulationState()}
          onTileClick={vi.fn()}
          showCoordinates={false}
          renderer={makeRenderer()}
          sceneBuilder={{ ...makeSceneBuilder(), build }}
          onRenderStatusChange={(status) => statuses.push(status)}
        />
      </ReplayFrameProvider>,
    );

    const scheduledBefore = scheduled;
    expect(() => act(() => frame?.(1000))).not.toThrow();
    expect(() => act(() => frame?.(1016))).not.toThrow();
    shouldFail = false;
    act(() => frame?.(1032));

    expect(scheduled).toBe(scheduledBefore + 3);
    expect(build).toHaveBeenCalledTimes(3);
    expect(reported).toHaveBeenCalledOnce();
    expect(reported).toHaveBeenCalledWith('Renderer', expect.any(String), error);
    expect(store.getRenderFailure()).toBeUndefined();
    expect(statuses).toEqual([{ kind: 'ok' }]);
  });

  it("hands the simulation context's fight-start countdown to the scene, following it frame by frame", () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const build = vi.fn((_ctx: RenderContext) => createQueue());
    const store = new ReplayFrameStore();
    const viewport = (fightStartCountdown?: FightStartCountdownPhase) => (
      <ReplayFrameProvider store={store}>
        {/* The viewport reads only the countdown from this context here; the rest comes as props. */}
        <SimulationProvider
          value={{ fightStartCountdown } as Partial<SimulationGridContextValue> as SimulationGridContextValue}
        >
          <RenderViewport3D
            simulationState={makeSimulationState()}
            onTileClick={vi.fn()}
            showCoordinates={false}
            renderer={makeRenderer()}
            sceneBuilder={{ ...makeSceneBuilder(), build }}
          />
        </SimulationProvider>
      </ReplayFrameProvider>
    );
    const lastCountdown = () => build.mock.calls.at(-1)?.[0].fightStartCountdown;

    const view = render(viewport('holding'));
    act(() => frame?.(1000));
    expect(lastCountdown()).toBe('holding');

    view.rerender(viewport('released'));
    act(() => frame?.(1016));
    expect(lastCountdown()).toBe('released');

    view.rerender(viewport());
    act(() => frame?.(1032));
    expect(build).toHaveBeenCalledTimes(3);
    expect(lastCountdown()).toBeUndefined();
  });

  it('stops a live loop that throws every frame and surfaces it as a failed render status', () => {
    let frame: FrameRequestCallback | undefined;
    let scheduled = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return ++scheduled;
    });
    const build = vi.fn((): ReturnType<SceneBuilderLike['build']> => {
      throw new TypeError('deterministic live render error');
    });
    const reported = vi.spyOn(log, 'error').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const statuses: RenderStatus[] = [];
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={{ ...makeSceneBuilder(), build }}
        onRenderStatusChange={(status) => statuses.push(status)}
      />,
    );

    const scheduledBefore = scheduled;
    for (let step = 0; step < MAX_CONSECUTIVE_LIVE_FRAME_FAILURES + 5; step++) {
      act(() => frame?.(1000 + step * 16));
    }

    expect(build).toHaveBeenCalledTimes(MAX_CONSECUTIVE_LIVE_FRAME_FAILURES);
    expect(scheduled).toBe(scheduledBefore + MAX_CONSECUTIVE_LIVE_FRAME_FAILURES - 1);
    expect(reported).toHaveBeenCalledOnce();
    expect(statuses).toEqual([{ kind: 'ok' }, { kind: 'failed', reason: 'render-loop' }]);
  });

  it('logs the first failure of each run, so an error after a recovery is still logged', () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const errorA = new TypeError('transient error');
    const errorB = new TypeError('persistent error');
    let failure: Error | null = errorA;
    const build = vi.fn(() => {
      if (failure) throw failure;
      return createQueue();
    });
    const reported = vi.spyOn(log, 'error').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const statuses: RenderStatus[] = [];
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={{ ...makeSceneBuilder(), build }}
        onRenderStatusChange={(status) => statuses.push(status)}
      />,
    );

    act(() => frame?.(1000));
    failure = null;
    act(() => frame?.(1016));
    failure = errorB;
    for (let step = 0; step < MAX_CONSECUTIVE_LIVE_FRAME_FAILURES; step++) {
      act(() => frame?.(1032 + step * 16));
    }

    expect(reported.mock.calls.map(([, , error]) => error)).toEqual([errorA, errorB]);
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'render-loop' });
  });

  it('forwards renderer context loss and restoration through onRenderStatusChange', () => {
    let status: RenderStatus = { kind: 'ok' };
    const listeners = new Set<(next: RenderStatus) => void>();
    const setStatus = (next: RenderStatus) => {
      status = next;
      for (const listener of listeners) listener(next);
    };
    const renderer: ContextStatusRenderer = {
      ...makeRenderer(),
      getContextStatus: () => status,
      subscribeContextStatus: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const statuses: RenderStatus[] = [];
    const view = render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={renderer}
        sceneBuilder={makeSceneBuilder()}
        onRenderStatusChange={(next) => statuses.push(next)}
      />,
    );

    act(() => setStatus({ kind: 'lost' }));
    act(() => setStatus({ kind: 'restoring' }));
    act(() => setStatus({ kind: 'ok' }));
    act(() => setStatus({ kind: 'failed', reason: 'context-timeout' }));

    expect(statuses).toEqual([
      { kind: 'ok' },
      { kind: 'lost' },
      { kind: 'restoring' },
      { kind: 'ok' },
      { kind: 'failed', reason: 'context-timeout' },
    ]);
    view.unmount();
    expect(listeners.size).toBe(0);
  });

  it('skips scene building while the renderer cannot draw and resumes once it is ok', () => {
    let frame: FrameRequestCallback | undefined;
    let scheduled = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return ++scheduled;
    });
    let status: RenderStatus = { kind: 'ok' };
    let notify: ((next: RenderStatus) => void) | undefined;
    const renderer: ContextStatusRenderer = {
      ...makeRenderer(),
      getContextStatus: () => status,
      subscribeContextStatus: (listener) => {
        notify = listener;
        return () => {
          notify = undefined;
        };
      },
    };
    const build = vi.fn(() => createQueue());
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={renderer}
        sceneBuilder={{ ...makeSceneBuilder(), build }}
      />,
    );
    const setStatus = (next: RenderStatus) => {
      status = next;
      act(() => notify?.(next));
    };

    act(() => frame?.(1000));
    expect(build).toHaveBeenCalledOnce();

    setStatus({ kind: 'lost' });
    act(() => frame?.(1016));
    setStatus({ kind: 'restoring' });
    act(() => frame?.(1032));
    expect(build).toHaveBeenCalledOnce();

    const scheduledBeforeRestore = scheduled;
    setStatus({ kind: 'ok' });
    act(() => frame?.(1048));
    expect(build).toHaveBeenCalledTimes(2);
    expect(scheduled).toBe(scheduledBeforeRestore + 1);
  });

  it('reports an unsupported renderer as a handled status instead of throwing into React', () => {
    const renderer: Renderer = {
      ...makeRenderer(),
      init: () => {
        throw new RendererUnsupportedError('PicoGLRenderer: WebGL2 not supported');
      },
    };
    const dispose = vi.spyOn(renderer, 'dispose');
    const reported = vi.spyOn(log, 'error').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const statuses: RenderStatus[] = [];

    const view = render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={renderer}
        sceneBuilder={makeSceneBuilder()}
        onRenderStatusChange={(next) => statuses.push(next)}
      />,
    );
    view.unmount();

    expect(statuses).toEqual([{ kind: 'failed', reason: 'unsupported' }]);
    expect(reported).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it('does not acknowledge a frame whose renderer throws and stops rebuilding that history', () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const store = new ReplayFrameStore();
    store.setHistory([{ state: makeSimulationState(), events: [] }]);
    const error = new TypeError('render failed');
    const renderer = makeRenderer();
    const draw = vi.spyOn(renderer, 'render').mockImplementation(() => {
      throw error;
    });
    const acknowledged = vi.spyOn(store, 'acknowledgeRender');
    const build = vi.fn(() => createQueue());
    render(
      <ReplayFrameProvider store={store}>
        <RenderViewport3D
          simulationState={makeSimulationState()}
          onTileClick={vi.fn()}
          showCoordinates={false}
          renderer={renderer}
          sceneBuilder={{ ...makeSceneBuilder(), build }}
          replayIsReplaying
          replayPlaying
        />
      </ReplayFrameProvider>,
    );

    expect(() => act(() => frame?.(1000))).not.toThrow();
    act(() => frame?.(1016));

    expect(store.getRenderFailure()?.error).toBe(error);
    expect(build).toHaveBeenCalledOnce();
    expect(draw).toHaveBeenCalledOnce();
    expect(acknowledged).not.toHaveBeenCalled();
  });

  // Screen points of real Zuk clicks. The recording's own camera differs from the current one,
  // so the tiles are the ones the current camera maps them to, pinned so the mapping cannot drift.
  it.each([
    {
      time: 1156,
      x: 1300,
      y: 515,
      pitch: -45.59765625,
      fov: 437,
      targetX: 31.5,
      targetY: 44.5,
      targetZ: 2.3984375,
      tileX: 34,
    },
    {
      time: 5735.8,
      x: 1351,
      y: 591,
      pitch: -70.56365625143047,
      fov: 412,
      targetX: 36.499805881705186,
      targetY: 46.49981846997235,
      targetZ: 2.3828125,
      tileX: 41,
    },
    {
      time: 12835.9,
      x: 676,
      y: 585,
      pitch: -70.56365625143047,
      fov: 412,
      targetX: 42.499999844456,
      targetY: 46.4999999999999,
      targetZ: 2.3828125,
      tileX: 38,
    },
  ])('preserves the recorded Zuk click geometry at $time ms with default viewer limits', (sample) => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const viewport = { width: 2010, height: 1163, dpr: 1 };
    const live = createProjection3D(viewport, {
      pitch: sample.pitch,
      yaw: 0.474609375,
      targetX: sample.targetX,
      targetY: sample.targetY,
      targetZ: sample.targetZ,
    });
    live.setCameraLimits({ relaxPitch: true });
    live.updateCamera({ fovScale: sample.fov });
    const heights = Array.from({ length: 65 }, () => new Int32Array(65).fill(-240));
    live.setTerrainHeights(heights);
    const recorded = orbitCameraStateToReplayViewportState(live.getCameraState());
    const projection = createProjection3D(viewport);
    projection.setTerrainHeights(heights);
    const store = new ReplayFrameStore();
    store.setHistory([{ state: makeSimulationState(), events: [] }]);
    store.set(0, recorded);
    const renderer = makeRenderer();
    const rendered = vi.spyOn(renderer, 'render');

    render(
      <ReplayFrameProvider store={store}>
        <RenderViewport3D
          simulationState={makeSimulationState()}
          onTileClick={vi.fn()}
          showCoordinates={false}
          renderer={renderer}
          sceneBuilder={{ ...makeSceneBuilder(), getTerrainHeights: () => heights }}
          projection3D={projection}
          width={viewport.width}
          height={viewport.height}
          replayIsReplaying
          replayPlaying
        />
      </ReplayFrameProvider>,
    );
    act(() => frame?.(1000));

    expect(rendered).toHaveBeenCalledOnce();
    expect(live.screenToTile(sample)).toEqual({ x: sample.tileX, y: 46 });
    expect(projection.screenToTile(sample)).toEqual(live.screenToTile(sample));
    expect(projection.getCameraState()).toEqual(live.getCameraState());
    expect(projection.viewMatrix()).toEqual(live.viewMatrix());
  });

  // Both happen while no live tick owns the replay clock, so both are stamped at the held time.
  it('renders the later camera without rewinding to a click at the same held timestamp', () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const engine = new SimulationEngine({ encounter: new LobbyEncounter() });
    const projection = makeProjection3D();
    const { result } = renderHook(() =>
      useReplay({
        engineRef: { current: engine },
        simulationState: engine.getState(),
        speedMultiplier: 1,
        mechanicsConfig: { infiniteHealth: false },
        objTypeLoader: null,
        onTakeOver: vi.fn(),
        getReplayViewportState: () => orbitCameraStateToReplayViewportState(projection.getCameraState()),
      }),
    );
    const onTileClick = vi.fn();
    const renderer = makeRenderer();
    const renderScene = vi.spyOn(renderer, 'render');
    const sceneBuilder = makeSceneBuilder();
    const tree = (replaying: boolean) => (
      <ReplayFrameProvider store={result.current.replayFrameStore}>
        <div className="game-viewport-frame">
          <RenderViewport3D
            simulationState={makeSimulationState()}
            onTileClick={onTileClick}
            showCoordinates={false}
            renderer={renderer}
            sceneBuilder={sceneBuilder}
            projection3D={projection}
            onCameraChange={(state) =>
              result.current.recordViewportSample(performance.now(), orbitCameraStateToReplayViewportState(state))
            }
            onReplayCursorClick={(...args) => result.current.recordCursorClick(...args)}
            replayIsReplaying={replaying}
            replayPlaying={replaying}
          />
        </div>
      </ReplayFrameProvider>
    );
    const view = render(tree(false));
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);
    const gameFrame = view.container.querySelector('.game-viewport-frame');
    if (!(gameFrame instanceof HTMLElement)) throw new TypeError('Missing game frame');
    vi.spyOn(gameFrame, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));
    act(() => result.current.startRun(engine.getRunConfig(), makeSimulationState()));
    act(() => frame?.(1000));
    const destination = { x: 31, y: 33 };
    const clickPoint = projection.tileToScreen({ x: destination.x + 0.5, y: destination.y + 0.5 });
    if (!clickPoint) throw new TypeError('Destination is not visible');
    now.mockReturnValue(1600);
    fireEvent(canvas, mouseDownEvent({ button: 0, clientX: clickPoint.x, clientY: clickPoint.y }, 1600));
    expect(onTileClick).toHaveBeenCalledWith([destination.x, destination.y], false);
    fireEvent.mouseDown(document.body, { button: 1, buttons: 4, clientX: 100, clientY: 100 });
    now.mockReturnValue(1601);
    fireEvent.mouseMove(window, { buttons: 4, clientX: 160, clientY: 100 });
    fireEvent.mouseUp(window, { button: 1 });
    act(() => frame?.(1601));
    const liveDestination = projection.tileToScreen({ x: destination.x + 0.5, y: destination.y + 0.5 });
    const liveView = projection.viewMatrix();
    const recording = result.current.exportReplayData();
    expect(recording.cursorClicks?.[0]?.tMs).toBe(0);
    expect(recording.viewportSamples?.at(-1)?.tMs).toBe(0);
    expect(recording.viewportSamples?.at(-1)?.viewportState.yawDeg).not.toBe(
      recording.cursorClicks?.[0]?.viewportState?.yawDeg,
    );

    act(() => result.current.loadExternalReplay(recording));
    view.rerender(tree(true));
    const renderFrame = frame;
    act(() => result.current.controlProps.onPlayPause());
    act(() => frame?.(2200));
    expect(result.current.replayFrameStore.getSnapshot().playheadMs).toBe(599);
    renderScene.mockClear();
    act(() => renderFrame?.(2200));

    expect(renderScene).toHaveBeenCalledOnce();
    expect(projection.tileToScreen({ x: destination.x + 0.5, y: destination.y + 0.5 })).toEqual(liveDestination);
    expect(projection.viewMatrix()).toEqual(liveView);
  });

  it.each([false, true])('acknowledges 3D scene processing only in the captured epoch (reset: %s)', (reset) => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const store = new ReplayFrameStore();
    store.setHistory([{ state: makeSimulationState(), events: [] }]);
    store.set(670, undefined);
    const build = vi.fn((context: RenderContext) => {
      expect(store.isFrameRendered(0)).toBe(false);
      expect(store.isPlayheadRendered(670)).toBe(false);
      expect(context.timeline?.timeMs).toBe(6670);
      if (reset) store.resetRenderProgress();
      return createQueue();
    });
    const view = render(
      <ReplayFrameProvider store={store}>
        <RenderViewport3D
          simulationState={makeSimulationState()}
          replayIsReplaying
          replayPlaying
          eventOverrides={[]}
          onTileClick={vi.fn()}
          showCoordinates={false}
          renderer={makeRenderer()}
          sceneBuilder={{ ...makeSceneBuilder(), build }}
        />
      </ReplayFrameProvider>,
    );
    expect(store.isFrameRendered(0)).toBe(false);

    act(() => frame?.(1000));

    expect(build).toHaveBeenCalledOnce();
    expect(store.isFrameRendered(0)).toBe(!reset);
    expect(store.isPlayheadRendered(670)).toBe(!reset);
    expect(store.isPlayheadRendered(671)).toBe(false);
    view.unmount();
    expect(store.isFrameRendered(1)).toBe(true);
  });

  it('acknowledges an active replay only after a ready queue has rendered', () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const store = new ReplayFrameStore();
    store.setHistory([{ state: makeSimulationState(), events: [] }]);
    store.set(670, undefined);
    const queue = createQueue();
    queue.replayPresentationReady = false;
    const renderer = makeRenderer();
    const renderFrame = vi.spyOn(renderer, 'render').mockImplementation(() => {
      expect(store.isFrameRendered(0)).toBe(false);
    });
    const view = render(
      <ReplayFrameProvider store={store}>
        <RenderViewport3D
          simulationState={makeSimulationState()}
          replayIsReplaying
          replayPlaying
          eventOverrides={[]}
          onTileClick={vi.fn()}
          showCoordinates={false}
          renderer={renderer}
          sceneBuilder={{ ...makeSceneBuilder(), build: () => queue }}
        />
      </ReplayFrameProvider>,
    );

    act(() => frame?.(1000));
    expect(renderFrame).toHaveBeenCalledOnce();
    expect(store.isFrameRendered(0)).toBe(false);

    queue.replayPresentationReady = true;
    act(() => frame?.(1016));
    expect(renderFrame).toHaveBeenCalledTimes(2);
    expect(store.isFrameRendered(0)).toBe(true);
    view.unmount();
  });

  it('marks the 3D canvas as world-owned replay click feedback', () => {
    // Given
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
      />,
    );

    // When
    const canvas = screen.getByLabelText('3D Game Grid');

    // Then
    expect(canvas).toHaveAttribute(REPLAY_CLICK_OWNER_ATTRIBUTE, REPLAY_CLICK_OWNERS.world);
  });

  it('applies the recorded replay camera on a paused seek and refuses local zoom in between', async () => {
    const projection3D = makeProjection3D();
    const recorded = makeReplayViewportState(270, 640);
    const nextRecorded = makeReplayViewportState(90, 512);
    const { rerender } = render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
        replayViewportState={recorded}
        replayIsReplaying={true}
        replayPlaying={false}
        replayFrameIndex={1}
        replayTimelineKey="test-replay"
        replayPaused={true}
      />,
    );

    await waitFor(() => expect(projection3D.getCameraState().yaw).toBe(270));

    // The camera stays locked to the recording while PAUSED too, not just while
    // playing. The replayed cursor is drawn against the recorded camera, so an
    // orbit or zoom here would aim it at a different part of the world than the
    // one it was recorded pointing at.
    fireEvent.wheel(getViewportContainer(), { deltaY: 100 });
    expect(projection3D.getCameraState().fovScale).toBe(recorded.fovScale);

    rerender(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
        replayViewportState={recorded}
        replayIsReplaying={true}
        replayPlaying={false}
        replayFrameIndex={1}
        replayTimelineKey="test-replay"
        replayPaused={true}
      />,
    );
    expect(projection3D.getCameraState().fovScale).toBe(recorded.fovScale);

    rerender(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
        replayViewportState={nextRecorded}
        replayIsReplaying={true}
        replayPlaying={false}
        replayFrameIndex={2}
        replayTimelineKey="test-replay"
        replayPaused={true}
      />,
    );

    await waitFor(() => expect(projection3D.getCameraState().fovScale).toBe(nextRecorded.fovScale));
    expect(projection3D.getCameraState().yaw).toBe(nextRecorded.yawDeg);
  });

  it('keeps active replay playback locked to the recorded camera against local mutations', async () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback);
        return rafCallbacks.length;
      }),
    );
    const projection3D = makeProjection3D();
    const recorded = makeReplayViewportState(270, 640);
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
        replayViewportState={recorded}
        replayIsReplaying={true}
        replayPlaying={true}
        replayFrameIndex={1}
        replayTimelineKey="test-replay"
        replayPaused={false}
      />,
    );

    await waitFor(() => expect(projection3D.getCameraState().fovScale).toBe(recorded.fovScale));
    fireEvent.wheel(getViewportContainer(), { deltaY: 100 });
    expect(projection3D.getCameraState().fovScale).toBe(recorded.fovScale);

    projection3D.updateCamera({ yaw: 45, targetX: 12, targetY: 18, targetZ: 0.2 });
    const renderFrame = rafCallbacks.at(-1);
    expect(renderFrame).toBeDefined();
    if (!renderFrame) return;

    act(() => {
      renderFrame(1000);
    });

    expect(projection3D.getCameraState().yaw).toBe(recorded.yawDeg);
    expect(projection3D.getCameraState().targetX).toBe(recorded.target.x);
    expect(projection3D.getCameraState().targetY).toBe(recorded.target.y);
  });

  it('opens the context menu when right-clicking while middle-drag is held', () => {
    const onContextMenu = vi.fn();
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        onContextMenu={onContextMenu}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);

    fireEvent.mouseDown(canvas, { button: 1, buttons: 4, clientX: 100, clientY: 100 });
    fireEvent.mouseDown(canvas, { button: 2, buttons: 6, clientX: 100, clientY: 100 });

    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });

  it('routes left-clicks while middle-drag is held', () => {
    const onVoidClick = vi.fn(() => true);
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        onVoidClick={onVoidClick}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);

    fireEvent.mouseDown(canvas, { button: 1, buttons: 4, clientX: 120, clientY: 130 });
    fireEvent.mouseDown(canvas, { button: 0, buttons: 5, clientX: 120, clientY: 130, ctrlKey: true });

    expect(onVoidClick).toHaveBeenCalledWith({ x: 120, y: 130 }, true);
  });

  it('records red replay cursor clicks at the void-click chokepoint', () => {
    const onReplayCursorClick = vi.fn();
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        onVoidClick={() => true}
        onReplayCursorClick={onReplayCursorClick}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);

    fireEvent(canvas, mouseDownEvent({ button: 0, buttons: 1, clientX: 120, clientY: 130 }, 1234));

    expect(onReplayCursorClick).toHaveBeenCalledWith(120, 130, 'red', 1234);
  });

  it('records tile replay cursor clicks with the left click type', () => {
    const onReplayCursorClick = vi.fn();
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        leftClickType="red"
        onReplayCursorClick={onReplayCursorClick}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);

    fireEvent(canvas, mouseDownEvent({ button: 0, buttons: 1, clientX: 400, clientY: 300 }, 2345));

    expect(onReplayCursorClick).toHaveBeenCalledWith(400, 300, 'red', 2345);
  });

  it('records tile replay cursor clicks before the tile callback', () => {
    const callOrder: string[] = [];
    const onReplayCursorClick = vi.fn(() => callOrder.push('cursor'));
    const onTileClick = vi.fn(() => callOrder.push('tile'));
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={onTileClick}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        onReplayCursorClick={onReplayCursorClick}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);

    fireEvent(canvas, mouseDownEvent({ button: 0, buttons: 1, clientX: 400, clientY: 300 }, 2345));

    expect(onReplayCursorClick).toHaveBeenCalledWith(400, 300, 'yellow', 2345);
    expect(onTileClick).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['cursor', 'tile']);
  });

  it('blocks physical hover updates while watch input is gated', () => {
    const onHoveredTileChange = vi.fn();
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        onHoveredTileChange={onHoveredTileChange}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);
    setWatchInputGated(true);

    fireEvent.mouseMove(canvas, { clientX: 400, clientY: 300 });

    expect(onHoveredTileChange).not.toHaveBeenCalled();
  });

  it('allows replay-synthetic hover updates while physical input is gated', () => {
    // Given
    const onHoveredTileChange = vi.fn();
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        onHoveredTileChange={onHoveredTileChange}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);
    setWatchInputGated(true);

    // When
    runSyntheticInput(() => fireEvent.mouseMove(canvas, { clientX: 400, clientY: 300 }));

    // Then
    expect(onHoveredTileChange).toHaveBeenCalledTimes(1);
  });

  it('draws the tile under a still cursor in the same frame the camera moves it', () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const projection = makeProjection3D();
    const hovered: (Coordinate | null)[] = [];
    const build = vi.fn((context: RenderContext) => {
      hovered.push(context.interaction.hoveredTile);
      return createQueue();
    });
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={{ ...makeSceneBuilder(), build }}
        projection3D={projection}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);
    // Off-center, so rotating the (player-following) camera moves the tile under it.
    fireEvent.mouseMove(canvas, { clientX: 250, clientY: 200 });
    act(() => frame?.(1000));
    const before = hovered.at(-1);
    expect(before).not.toBeNull();

    projection.updateCamera({ yaw: 90 });
    const expected = projection.screenToTile({ x: 250, y: 200 });
    act(() => frame?.(1016));

    expect(expected).not.toBeNull();
    expect(hovered.at(-1)).toEqual([expected?.x, expected?.y]);
    expect(hovered.at(-1)).not.toEqual(before);
  });

  it('reads the live walk destination every frame, with no re-render to deliver it', () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const targets: (Coordinate | null)[] = [];
    const build = vi.fn((context: RenderContext) => {
      targets.push(context.interaction.targetTile);
      return createQueue();
    });
    let live: Coordinate | null = null;
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={{ ...makeSceneBuilder(), build }}
        targetTile={[1, 1]}
        getTargetTile={() => live}
      />,
    );
    act(() => frame?.(1000));
    expect(targets.at(-1)).toBeNull();

    live = [32, 37];
    act(() => frame?.(1016));
    expect(targets.at(-1)).toEqual([32, 37]);
  });

  it('blocks physical tile and void clicks while watch input is gated', () => {
    const onReplayCursorClick = vi.fn();
    const onTileClick = vi.fn();
    const onVoidClick = vi.fn(() => true);
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={onTileClick}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        onVoidClick={onVoidClick}
        onReplayCursorClick={onReplayCursorClick}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);
    setWatchInputGated(true);

    fireEvent(canvas, mouseDownEvent({ button: 0, buttons: 1, clientX: 120, clientY: 130 }, 2345));

    expect(onReplayCursorClick).not.toHaveBeenCalled();
    expect(onTileClick).not.toHaveBeenCalled();
    expect(onVoidClick).not.toHaveBeenCalled();
  });

  it('does not record replay cursor clicks for middle or right mouse buttons', () => {
    const onReplayCursorClick = vi.fn();
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        onReplayCursorClick={onReplayCursorClick}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);

    fireEvent.mouseDown(canvas, { button: 1, buttons: 4, clientX: 120, clientY: 130 });
    fireEvent.mouseDown(canvas, { button: 2, buttons: 2, clientX: 120, clientY: 130 });

    expect(onReplayCursorClick).not.toHaveBeenCalled();
  });

  it('routes opposite left and right button presses independently', () => {
    const onVoidClick = vi.fn(() => true);
    const onContextMenu = vi.fn();
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        onVoidClick={onVoidClick}
        onContextMenu={onContextMenu}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);

    fireEvent.mouseDown(canvas, { button: 0, buttons: 1, clientX: 200, clientY: 210 });
    fireEvent.mouseDown(canvas, { button: 2, buttons: 3, clientX: 200, clientY: 210 });
    fireEvent.mouseDown(canvas, { button: 2, buttons: 2, clientX: 220, clientY: 230 });
    fireEvent.mouseDown(canvas, { button: 0, buttons: 3, clientX: 220, clientY: 230 });

    expect(onVoidClick).toHaveBeenCalledTimes(2);
    expect(onContextMenu).toHaveBeenCalledTimes(2);
  });

  it('treats Ctrl+right-click as an alternate to Shift for the extras flag (Firefox hijacks Shift+right-click)', () => {
    const onContextMenu = vi.fn();
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        onContextMenu={onContextMenu}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);

    // plain right-click -> extras flag false
    fireEvent.mouseDown(canvas, { button: 2, buttons: 2, clientX: 100, clientY: 100 });
    // shift+right-click -> extras flag true (works in Chrome)
    fireEvent.mouseDown(canvas, { button: 2, buttons: 2, clientX: 100, clientY: 100, shiftKey: true });
    // ctrl+right-click -> extras flag true (the Firefox-safe alternate)
    fireEvent.mouseDown(canvas, { button: 2, buttons: 2, clientX: 100, clientY: 100, ctrlKey: true });

    expect(onContextMenu).toHaveBeenCalledTimes(3);
    // 5th argument (index 4) is the shift/extras flag passed to the menu builder
    expect(onContextMenu.mock.calls[0][4]).toBe(false);
    expect(onContextMenu.mock.calls[1][4]).toBe(true);
    expect(onContextMenu.mock.calls[2][4]).toBe(true);
  });

  it('starts middle-mouse camera rotation when the press lands off-canvas (over UI)', () => {
    const onCameraChange = vi.fn();
    const projection3D = makeProjection3D();
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
        onCameraChange={onCameraChange}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);
    onCameraChange.mockClear(); // ignore the initial mount emission

    // The middle press lands on a non-canvas element — a UI panel layered over
    // the viewport. Initiation is window-level (capture phase), so the drag must
    // still start and rotate the camera, matching real OSRS.
    fireEvent.mouseDown(document.body, { button: 1, buttons: 4, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { buttons: 4, clientX: 160, clientY: 130 });

    expect(onCameraChange).toHaveBeenCalled();
  });

  it('starts right-mouse camera rotation from a canvas-owned camera drag', () => {
    const projection3D = makeProjection3D();
    const initialYaw = projection3D.getCameraState().yaw;
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
        onContextMenu={() => ({ kind: 'camera-drag' })}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);

    fireEvent.mouseDown(canvas, { button: 2, buttons: 2, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { buttons: 2, clientX: 160, clientY: 100 });

    expect(projection3D.getCameraState().yaw).toBeCloseTo(initialYaw - (60 * 0.9 * 360) / 2048);
  });

  it('multiplies right-mouse camera rotation by dragSpeed', () => {
    const projection3D = makeProjection3D();
    const initialYaw = projection3D.getCameraState().yaw;
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
        dragSpeed={2}
        onContextMenu={() => ({ kind: 'camera-drag' })}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);

    fireEvent.mouseDown(canvas, { button: 2, buttons: 2, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { buttons: 2, clientX: 160, clientY: 100 });

    expect(projection3D.getCameraState().yaw).toBeCloseTo(initialYaw - (60 * 0.9 * 360 * 2) / 2048);
  });

  it('does not rotate when right-click ownership belongs to a menu', () => {
    const projection3D = makeProjection3D();
    const initialYaw = projection3D.getCameraState().yaw;
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
        onContextMenu={() => ({ kind: 'claimed' })}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);

    fireEvent.mouseDown(canvas, { button: 2, buttons: 2, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { buttons: 2, clientX: 160, clientY: 100 });

    expect(projection3D.getCameraState().yaw).toBe(initialYaw);
  });

  it('stops right drag only on a matching right-button release', () => {
    const projection3D = makeProjection3D();
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
        onContextMenu={() => ({ kind: 'camera-drag' })}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);

    fireEvent.mouseDown(canvas, { button: 2, buttons: 2, clientX: 100, clientY: 100 });
    fireEvent.mouseUp(window, { button: 1, buttons: 2, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { buttons: 2, clientX: 140, clientY: 100 });
    const yawAfterMiddleRelease = projection3D.getCameraState().yaw;
    fireEvent.mouseUp(window, { button: 2, buttons: 0, clientX: 140, clientY: 100 });
    fireEvent.mouseMove(window, { buttons: 0, clientX: 180, clientY: 100 });

    expect(yawAfterMiddleRelease).not.toBe(180);
    expect(projection3D.getCameraState().yaw).toBe(yawAfterMiddleRelease);
  });

  it('does not let a right-button release cancel middle drag', () => {
    const projection3D = makeProjection3D();
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
      />,
    );

    fireEvent.mouseDown(document.body, { button: 1, buttons: 4, clientX: 100, clientY: 100 });
    fireEvent.mouseUp(window, { button: 2, buttons: 4, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { buttons: 4, clientX: 140, clientY: 100 });

    expect(projection3D.getCameraState().yaw).not.toBe(180);
  });

  it('recovers a lost right-button release from the buttons mask', () => {
    const projection3D = makeProjection3D();
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
        onContextMenu={() => ({ kind: 'camera-drag' })}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);

    fireEvent.mouseDown(canvas, { button: 2, buttons: 2, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { buttons: 0, clientX: 140, clientY: 100 });
    fireEvent.mouseMove(window, { buttons: 2, clientX: 180, clientY: 100 });

    expect(projection3D.getCameraState().yaw).toBe(180);
  });

  it('clears right drag on window blur', () => {
    const projection3D = makeProjection3D();
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
        onContextMenu={() => ({ kind: 'camera-drag' })}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);

    fireEvent.mouseDown(canvas, { button: 2, buttons: 2, clientX: 100, clientY: 100 });
    fireEvent.blur(window);
    fireEvent.mouseMove(window, { buttons: 2, clientX: 140, clientY: 100 });

    expect(projection3D.getCameraState().yaw).toBe(180);
  });

  it('clears right drag when the document becomes hidden', () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const projection3D = makeProjection3D();
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
        onContextMenu={() => ({ kind: 'camera-drag' })}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);

    fireEvent.mouseDown(canvas, { button: 2, buttons: 2, clientX: 100, clientY: 100 });
    fireEvent(document, new Event('visibilitychange'));
    fireEvent.mouseMove(window, { buttons: 2, clientX: 140, clientY: 100 });

    expect(projection3D.getCameraState().yaw).toBe(180);
  });

  it('does not start right drag away from the canvas', () => {
    const onContextMenu = vi.fn(() => ({ kind: 'camera-drag' as const }));
    const projection3D = makeProjection3D();
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
        onContextMenu={onContextMenu}
      />,
    );

    fireEvent.mouseDown(document.body, { button: 2, buttons: 2, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { buttons: 2, clientX: 140, clientY: 100 });

    expect(onContextMenu).not.toHaveBeenCalled();
    expect(projection3D.getCameraState().yaw).toBe(180);
  });

  it('blocks right drag while replay owns the camera', async () => {
    const projection3D = makeProjection3D();
    const recorded = makeReplayViewportState(270, 640);
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
        replayViewportState={recorded}
        replayIsReplaying={true}
        onContextMenu={() => ({ kind: 'camera-drag' })}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);
    await waitFor(() => expect(projection3D.getCameraState().yaw).toBe(270));

    fireEvent.mouseDown(canvas, { button: 2, buttons: 2, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { buttons: 2, clientX: 140, clientY: 100 });

    expect(projection3D.getCameraState().yaw).toBe(270);
  });

  it('blocks right-click ownership while tutorial input is gated', () => {
    const onContextMenu = vi.fn(() => ({ kind: 'camera-drag' as const }));
    const projection3D = makeProjection3D();
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
        onContextMenu={onContextMenu}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);
    setWatchInputGated(true);

    fireEvent.mouseDown(canvas, { button: 2, buttons: 2, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { buttons: 2, clientX: 140, clientY: 100 });

    expect(onContextMenu).not.toHaveBeenCalled();
    expect(projection3D.getCameraState().yaw).toBe(180);
  });

  it('requires a fresh right press after tutorial gating interrupts an active drag', () => {
    const projection3D = makeProjection3D();
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
        onContextMenu={() => ({ kind: 'camera-drag' })}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);
    fireEvent.mouseDown(canvas, { button: 2, buttons: 2, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { buttons: 2, clientX: 120, clientY: 100 });
    const yawBeforeGate = projection3D.getCameraState().yaw;

    setWatchInputGated(true);
    setWatchInputGated(false);
    fireEvent.mouseMove(window, { buttons: 2, clientX: 180, clientY: 100 });

    expect(projection3D.getCameraState().yaw).toBe(yawBeforeGate);
  });

  it("plays a replay at the game's pitch-driven distance", async () => {
    const projection3D = makeProjection3D();
    const recorded = makeReplayViewportState(270, 640);
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
        replayViewportState={recorded}
        replayIsReplaying={true}
        replayFrameIndex={1}
      />,
    );

    await waitFor(() => expect(projection3D.getCameraState().yaw).toBe(recorded.yawDeg));
    expect(projection3D.getCameraState().distance).toBe(
      getOsrsCameraDistance(recorded.pitchDeg, projection3D.viewport.height),
    );
  });

  it('requires a fresh right press after replay interrupts an active drag', async () => {
    const projection3D = makeProjection3D();
    const recorded = makeReplayViewportState(270, 640);
    const baseProps = {
      simulationState: makeSimulationState(),
      onTileClick: vi.fn(),
      showCoordinates: false,
      renderer: makeRenderer(),
      sceneBuilder: makeSceneBuilder(),
      projection3D,
      onContextMenu: () => ({ kind: 'camera-drag' as const }),
    };
    const { rerender } = render(<RenderViewport3D {...baseProps} replayIsReplaying={false} />);
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);
    fireEvent.mouseDown(canvas, { button: 2, buttons: 2, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { buttons: 2, clientX: 120, clientY: 100 });

    rerender(
      <RenderViewport3D {...baseProps} replayViewportState={recorded} replayIsReplaying={true} replayFrameIndex={1} />,
    );
    await waitFor(() => expect(projection3D.getCameraState().yaw).toBe(recorded.yawDeg));
    rerender(<RenderViewport3D {...baseProps} replayViewportState={recorded} replayIsReplaying={false} />);
    fireEvent.mouseMove(window, { buttons: 2, clientX: 180, clientY: 100 });

    expect(projection3D.getCameraState().yaw).toBe(recorded.yawDeg);
  });

  it('falls back to orbit when the browser refuses the pointer lock', async () => {
    const projection3D = makeProjection3D();
    const canvasProto = window.HTMLCanvasElement.prototype as unknown as {
      requestPointerLock: () => Promise<void>;
    };
    const original = canvasProto.requestPointerLock;
    canvasProto.requestPointerLock = () => Promise.reject(new DOMException('rate limited', 'NotAllowedError'));

    try {
      render(
        <RenderViewport3D
          simulationState={makeSimulationState()}
          onTileClick={vi.fn()}
          showCoordinates={false}
          renderer={makeRenderer()}
          sceneBuilder={makeSceneBuilder()}
          projection3D={projection3D}
        />,
      );

      fireEvent.keyDown(window, { key: 'F10' });
      expect(projection3D.getCameraMode()).toBe('freeform');

      await waitFor(() => expect(projection3D.getCameraMode()).toBe('orbit'));
    } finally {
      canvasProto.requestPointerLock = original;
    }
  });

  it('toggles freeform for a letter keybind when Caps Lock changes the reported key case', () => {
    const projection3D = makeProjection3D();
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
        cameraKeybinds={{ ...DEFAULT_CAMERA_KEYBINDS, toggleFreeform: 'g' }}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    Object.defineProperty(canvas, 'requestPointerLock', { configurable: true, value: vi.fn() });

    fireEvent.keyDown(window, { key: 'G', code: 'KeyG' });

    expect(projection3D.getCameraMode()).toBe('freeform');
  });

  it('falls back to orbit on pointerlockerror', () => {
    const projection3D = makeProjection3D();
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
      />,
    );
    projection3D.setCameraMode('freeform');

    fireEvent(document, new Event('pointerlockerror'));

    expect(projection3D.getCameraMode()).toBe('orbit');
  });

  it('looks upward when the mouse moves upward in freeform mode', () => {
    const projection3D = makeProjection3D();
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    projection3D.setCameraMode('freeform');
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, value: canvas });
    fireEvent(document, new Event('pointerlockchange'));
    const initialPitch = projection3D.getFreeformState().pitch;
    const mouseMove = new MouseEvent('mousemove', { bubbles: true });
    Object.defineProperties(mouseMove, {
      movementX: { value: 0 },
      movementY: { value: -20 },
    });

    fireEvent(window, mouseMove);

    expect(projection3D.getFreeformState().pitch).toBeGreaterThan(initialPitch);
  });

  it('keeps freeform yaw continuous when mouse look crosses a full turn', () => {
    const projection3D = makeProjection3D();
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    projection3D.setCameraMode('freeform');
    projection3D.updateFreeformCamera({ yaw: 359 });
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, value: canvas });
    fireEvent(document, new Event('pointerlockchange'));
    const mouseMove = new MouseEvent('mousemove', { bubbles: true });
    Object.defineProperties(mouseMove, {
      movementX: { value: -20 },
      movementY: { value: 0 },
    });

    fireEvent(window, mouseMove);

    expect(projection3D.getFreeformState().yaw).toBe(362);
  });

  it('prevents anomalous pointer-lock deltas from snapping freeform orientation', () => {
    const projection3D = makeProjection3D();
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    projection3D.setCameraMode('freeform');
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, value: canvas });
    fireEvent(document, new Event('pointerlockchange'));
    const initial = projection3D.getFreeformState();
    const mouseMove = new MouseEvent('mousemove', { bubbles: true });
    Object.defineProperties(mouseMove, {
      movementX: { value: 4000 },
      movementY: { value: 4000 },
    });

    fireEvent(window, mouseMove);

    const updated = projection3D.getFreeformState();
    expect(Math.abs(updated.yaw - initial.yaw)).toBeLessThanOrEqual(15);
    expect(Math.abs(updated.pitch - initial.pitch)).toBeLessThanOrEqual(15);
  });
});

const renderer = {
  id: 'scene-ready-test',
  supports: () => true,
  init: () => {},
  resize: () => {},
  render: () => {},
  assets: createNullAssetManager(),
  dispose: () => {},
  loadTextures: () => {},
  getTextureArrayManager: () => null,
  releaseSceneMeshes: () => {},
} satisfies Renderer & TextureCapableRenderer;

/**
 * A scene builder whose terrain load finishes only when the test says so. Like the real
 * compositor, a repeated request joins the load in flight.
 */
function deferredTerrainBuilder() {
  let loaded = false;
  let inFlight: Promise<void> | null = null;
  let finish = () => {};
  const builder = {
    ...makeSceneBuilder(),
    build: vi.fn((_ctx: RenderContext) => createQueue()),
    loadTerrain: vi.fn((..._args: Parameters<SceneBuilderLike['loadTerrain']>) => {
      inFlight ??= new Promise<void>((resolve) => {
        finish = () => {
          loaded = true;
          resolve();
        };
      });
      return inFlight;
    }),
    isTerrainLoaded: () => loaded,
    dispose: vi.fn(),
    finishTerrain: () => finish(),
  };
  return builder;
}

const locsFor = (id: number) => [{ location: { id }, locType: { clipped: false, sizeX: 1, sizeY: 1 } }] as never;

const mapLoader = new MapLoader(
  new CacheIndexDat(IndexType.DAT.maps, ReferenceTable.fromArchiveCount(0), new MemoryStore(new ArrayBuffer(0), [])),
);

const textureLoader = {
  getTextureIds: () => [],
  getTextureIndex: () => -1,
  isSmall: () => false,
  isSd: () => false,
  isTransparent: () => false,
  getAverageHsl: () => 0,
  getAnimationUv: () => [0, 0],
  getMaterial: (id) => ({
    id,
    isSmall: false,
    isSd: false,
    isTransparent: false,
    averageHsl: 0,
    animationU: 0,
    animationV: 0,
  }),
  getPixelsRgb: () => new Int32Array(),
  getPixelsArgb: () => new Int32Array(),
} satisfies TextureLoader;

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (_callback: FrameRequestCallback) => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RenderViewport3D scene readiness', () => {
  it('has the scene load every declared NPC type once, keeping the Jad healer death duration', async () => {
    const npcModelLoader = new NpcModelLoader(
      {
        load: () => {
          throw new Error('Preloading is handled by the scene builder');
        },
        getCount: () => 0,
        clearCache: () => {},
      },
      {
        getModel: () => {
          throw new Error('Preloading is handled by the scene builder');
        },
      },
    );
    const animationSystem = new AnimationSystem();
    const scene = createZukSceneBuilder({ encounterRenderConfig: INFERNO_RENDER_CONFIG });
    if (!(scene instanceof InfernoSceneCompositor)) expect.fail('Expected Inferno compositor');
    const loadNpcType = vi.spyOn(scene, 'loadNpcType').mockResolvedValue();
    const sceneBuilder: SceneBuilderLike = {
      ...makeSceneBuilder(),
      isNpcLoaded: () => scene.isNpcLoaded(),
      loadNpc: (loader, animation) => scene.loadNpc(loader, animation),
    };

    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={() => {}}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={sceneBuilder}
        npcModelLoader={npcModelLoader}
        animationSystem={animationSystem}
      />,
    );

    await waitFor(() => expect(loadNpcType).toHaveBeenCalled());
    expect(loadNpcType).toHaveBeenCalledWith(
      7705,
      npcModelLoader,
      animationSystem,
      expect.objectContaining({ deathSeqId: 2638, deathDurationMs: 1800 }),
    );
    const declared = INFERNO_RENDER_CONFIG.preloadNpcTypes?.map(({ npcTypeId }) => npcTypeId) ?? [];
    expect(loadNpcType.mock.calls.map(([npcTypeId]) => npcTypeId)).toEqual(declared);
    scene.dispose();
  });

  // The Inferno has no primary NPC, so its scene once reported its NPC "loaded" before `loadNpc`
  // ran; the viewport then never called it, and the player loaded with no animation system (T-pose).
  it('hands a scene with no primary NPC its animation system before the player loads', async () => {
    const scene = createZukSceneBuilder({ encounterRenderConfig: INFERNO_RENDER_CONFIG });
    if (!(scene instanceof InfernoSceneCompositor)) expect.fail('Expected Inferno compositor');
    vi.spyOn(scene as unknown as { loadEncounterNpc: () => Promise<void> }, 'loadEncounterNpc').mockResolvedValue();
    const animationSystem = new AnimationSystem();
    const npcModelLoader = {} as NpcModelLoader;
    const loadNpc = vi.spyOn(scene, 'loadNpc');
    let animationAtPlayerLoad: unknown = 'player not loaded';
    const sceneBuilder: SceneBuilderLike = {
      ...makeSceneBuilder(),
      isNpcLoaded: () => scene.isNpcLoaded(),
      loadNpc: (loader, animation) => scene.loadNpc(loader, animation),
      loadPlayer: () => {
        animationAtPlayerLoad = scene['playerAnimationSystem'];
        return Promise.resolve();
      },
    };
    expect(scene.isNpcLoaded()).toBe(false);

    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={() => {}}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={sceneBuilder}
        npcModelLoader={npcModelLoader}
        animationSystem={animationSystem}
        playerModelLoader={{} as PlayerModelLoader}
        playerConfig={DEFAULT_PLAYER_CONFIG}
      />,
    );

    await waitFor(() => expect(animationAtPlayerLoad).toBe(animationSystem));
    expect(loadNpc).toHaveBeenCalledWith(npcModelLoader, animationSystem);
    expect(scene.isNpcLoaded()).toBe(true);
    scene.dispose();
  });

  it('waits for required loc metadata before starting terrain loading', async () => {
    // Given
    const loadTerrain = vi.fn(() => Promise.resolve());
    const sceneBuilder: SceneBuilderLike = {
      build: () => createQueue(),
      loadTerrain,
      isTerrainLoaded: () => false,
      loadNpc: () => Promise.resolve(),
      isNpcLoaded: () => true,
      loadPlayer: () => Promise.resolve(),
      isPlayerLoaded: () => true,
      loadSpotAnims: () => Promise.resolve(),
      isSpotAnimsLoaded: () => true,
      loadLocs: () => Promise.resolve(),
      isLocsLoaded: () => true,
    };
    const props = {
      simulationState: new SimulationEngine({ encounter: new LobbyEncounter() }).getState(),
      onTileClick: () => {},
      showCoordinates: false,
      renderer,
      sceneBuilder,
      mapLoader,
      textureLoader,
      encounterRequiresLocs: true,
    };
    const { rerender } = render(<RenderViewport3D {...props} />);

    // When
    await act(async () => Promise.resolve());

    // Then
    expect(loadTerrain).not.toHaveBeenCalled();

    // When
    rerender(<RenderViewport3D {...props} mapLocs={[]} />);

    // Then
    await waitFor(() => expect(loadTerrain).toHaveBeenCalledOnce());
  });

  // Entering Sol Heredit from the lobby must not create a second WebGL context: on iPad,
  // iOS then loses the live one about two seconds into the fight.
  it('enters Sol Heredit from the lobby in place: same canvas and context, textures kept, scene state reset', async () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const init = vi.spyOn(renderer, 'init');
    const dispose = vi.spyOn(renderer, 'dispose');
    const loadTextures = vi.spyOn(renderer, 'loadTextures');
    const releaseSceneMeshes = vi.spyOn(renderer, 'releaseSceneMeshes');
    const lobby = deferredTerrainBuilder();
    const sol = deferredTerrainBuilder();
    const onSceneReady = vi.fn();
    const lobbyState = new SimulationEngine({ encounter: new LobbyEncounter() }).getState();
    const solState = new SimulationEngine({ encounter: new SolHereditEncounter(7), combatSeed: 1 }).getState();
    const [x, y] = solState.playerPosition;
    expect([x, y]).not.toEqual(lobbyState.playerPosition);
    const props = { onTileClick: () => {}, showCoordinates: false, renderer, mapLoader, textureLoader, onSceneReady };
    const { rerender } = render(<RenderViewport3D {...props} simulationState={lobbyState} sceneBuilder={lobby} />);
    await act(async () => lobby.finishTerrain());
    expect(onSceneReady).toHaveBeenCalledOnce();
    const canvas = screen.getByLabelText('3D Game Grid');
    act(() => frame?.(1000));

    // Sol needs its map LOCs, which the encounter manager has not loaded yet.
    const solProps = { ...props, simulationState: solState, sceneBuilder: sol, encounterRequiresLocs: true };
    rerender(<RenderViewport3D {...solProps} />);
    expect(releaseSceneMeshes).toHaveBeenCalledOnce();
    expect(sol.loadTerrain).not.toHaveBeenCalled();
    rerender(<RenderViewport3D {...solProps} mapLocs={locsFor(7)} />);
    await act(async () => sol.finishTerrain());
    act(() => frame?.(1016));

    expect(onSceneReady).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('3D Game Grid')).toBe(canvas);
    expect(init).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
    expect(loadTextures).toHaveBeenCalledOnce();
    expect(sol.loadTerrain).toHaveBeenCalledOnce();
    expect(sol.loadTerrain.mock.calls[0][4]).toEqual([{ id: 7 }]);
    expect(lobby.dispose).toHaveBeenCalledOnce();
    // The player starts the new scene where it stands, not walking over from the lobby.
    expect(sol.build.mock.lastCall?.[0].playerVisual?.position).toEqual([x, y]);
  });

  // dispose() drops the texture array; a renderer re-initialized without a remount (Fast
  // Refresh re-runs the effect the same way) drew every textured face untextured.
  it('uploads textures to a renderer re-initialized without a remount', async () => {
    const first = { ...renderer, loadTextures: vi.fn(), dispose: vi.fn() };
    const second = { ...renderer, loadTextures: vi.fn() };
    const builder = deferredTerrainBuilder();
    const props = {
      onTileClick: () => {},
      showCoordinates: false,
      mapLoader,
      textureLoader,
      simulationState: new SimulationEngine({ encounter: new LobbyEncounter() }).getState(),
      sceneBuilder: builder,
    };
    const { rerender } = render(<RenderViewport3D {...props} renderer={first} />);
    await act(async () => builder.finishTerrain());
    expect(first.loadTextures).toHaveBeenCalledOnce();

    rerender(<RenderViewport3D {...props} renderer={second} />);

    expect(first.dispose).toHaveBeenCalledOnce();
    await waitFor(() => expect(second.loadTextures).toHaveBeenCalledWith(textureLoader));
  });

  it.each([
    'previous scene',
    'new scene',
  ] as const)('reports readiness once, for the new scene, when the %s finishes loading first', async (first) => {
    const onSceneReady = vi.fn();
    const state = new SimulationEngine({ encounter: new LobbyEncounter() }).getState();
    const previous = deferredTerrainBuilder();
    const next = deferredTerrainBuilder();
    const props = {
      onTileClick: () => {},
      showCoordinates: false,
      renderer,
      mapLoader,
      textureLoader,
      onSceneReady,
      simulationState: state,
      encounterRequiresLocs: true,
    };
    const { rerender } = render(<RenderViewport3D {...props} sceneBuilder={previous} mapLocs={locsFor(1)} />);
    await act(async () => Promise.resolve());
    expect(previous.loadTerrain).toHaveBeenCalledOnce();

    // The previous scene is still loading when the next one arrives, LOCs to follow.
    rerender(<RenderViewport3D {...props} sceneBuilder={next} />);
    rerender(<RenderViewport3D {...props} sceneBuilder={next} mapLocs={locsFor(2)} />);
    // A re-delivered LOC list re-runs the load effect mid-load; it must join, not restart.
    rerender(<RenderViewport3D {...props} sceneBuilder={next} mapLocs={locsFor(2)} />);
    await act(async () => Promise.resolve());

    const finishers = { 'previous scene': previous.finishTerrain, 'new scene': next.finishTerrain };
    const order =
      first === 'previous scene'
        ? (['previous scene', 'new scene'] as const)
        : (['new scene', 'previous scene'] as const);
    await act(async () => finishers[order[0]]());
    expect(onSceneReady).toHaveBeenCalledTimes(order[0] === 'new scene' ? 1 : 0);
    await act(async () => finishers[order[1]]());

    expect(onSceneReady).toHaveBeenCalledOnce();
    expect(next.loadTerrain.mock.calls.every((call) => JSON.stringify(call[4]) === JSON.stringify([{ id: 2 }]))).toBe(
      true,
    );
  });

  it('replaces the scene while the context is lost and draws the new one once it is restored', async () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    let status: RenderStatus = { kind: 'ok' };
    let notify: ((next: RenderStatus) => void) | undefined;
    const releaseSceneMeshes = vi.fn();
    const statusRenderer: ContextStatusRenderer & TextureCapableRenderer = {
      ...renderer,
      releaseSceneMeshes,
      getContextStatus: () => status,
      subscribeContextStatus: (listener) => {
        notify = listener;
        return () => {
          notify = undefined;
        };
      },
    };
    const setStatus = (next: RenderStatus) => {
      status = next;
      act(() => notify?.(next));
    };
    vi.spyOn(log, 'error').mockImplementation(() => {});
    const onSceneReady = vi.fn();
    const state = new SimulationEngine({ encounter: new LobbyEncounter() }).getState();
    const previous = deferredTerrainBuilder();
    const next = deferredTerrainBuilder();
    const props = {
      onTileClick: () => {},
      showCoordinates: false,
      renderer: statusRenderer,
      mapLoader,
      textureLoader,
      onSceneReady,
      simulationState: state,
    };
    const { rerender } = render(<RenderViewport3D {...props} sceneBuilder={previous} />);
    await act(async () => previous.finishTerrain());

    setStatus({ kind: 'lost' });
    rerender(<RenderViewport3D {...props} sceneBuilder={next} />);
    await act(async () => next.finishTerrain());
    act(() => frame?.(1000));
    expect(releaseSceneMeshes).toHaveBeenCalledOnce();
    expect(next.build).not.toHaveBeenCalled();

    setStatus({ kind: 'restoring' });
    setStatus({ kind: 'ok' });
    act(() => frame?.(1016));

    expect(next.build).toHaveBeenCalledOnce();
    expect(previous.build).not.toHaveBeenCalled();
    expect(onSceneReady).toHaveBeenCalledTimes(2);
  });

  it("clears the previous scene's overlays at the switch, even when no frame can be drawn", () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    let status: RenderStatus = { kind: 'ok' };
    let notify: ((next: RenderStatus) => void) | undefined;
    const statusRenderer: ContextStatusRenderer = {
      ...renderer,
      getContextStatus: () => status,
      subscribeContextStatus: (listener) => {
        notify = listener;
        return () => {
          notify = undefined;
        };
      },
    };
    vi.spyOn(log, 'error').mockImplementation(() => {});
    const withOverheadText = {
      ...makeSceneBuilder(),
      build: () => ({
        ...createQueue(),
        overheadTexts: [{ screenX: 10, screenY: 10, text: 'Previous', textColor: '#fff', fontSize: 12, key: 'a' }],
      }),
    };
    const props = { onTileClick: () => {}, showCoordinates: false, renderer: statusRenderer };
    const { rerender } = render(
      <RenderViewport3D {...props} simulationState={makeSimulationState()} sceneBuilder={withOverheadText} />,
    );
    act(() => frame?.(1000));
    expect(document.querySelector('[data-overhead-texts]')).not.toBeNull();

    status = { kind: 'lost' };
    act(() => notify?.(status));
    rerender(<RenderViewport3D {...props} simulationState={makeSimulationState()} sceneBuilder={makeSceneBuilder()} />);

    expect(document.querySelector('[data-overhead-texts]')).toBeNull();
  });

  it('clears an exhausted live-loop failure once the replay that replaced the scene draws a frame', () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.spyOn(log, 'error').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const store = new ReplayFrameStore();
    const history = [{ state: makeSimulationState(), events: [] }];
    const broken = {
      ...makeSceneBuilder(),
      build: (): ReturnType<SceneBuilderLike['build']> => {
        throw new TypeError('broken scene');
      },
    };
    // The replay's first build invalidates its own epoch (a history swap mid-frame): that
    // frame never reaches the renderer and must not count as recovery.
    const replayScene = {
      ...makeSceneBuilder(),
      build: vi
        .fn(() => createQueue())
        .mockImplementationOnce(() => {
          store.setHistory([...history]);
          return createQueue();
        }),
    };
    const renderer = makeRenderer();
    const draw = vi.spyOn(renderer, 'render');
    const statuses: RenderStatus[] = [];
    const tree = (sceneBuilder: SceneBuilderLike, replaying: boolean) => (
      <ReplayFrameProvider store={store}>
        <RenderViewport3D
          simulationState={makeSimulationState()}
          onTileClick={vi.fn()}
          showCoordinates={false}
          renderer={renderer}
          sceneBuilder={sceneBuilder}
          replayIsReplaying={replaying}
          replayPlaying={replaying}
          onRenderStatusChange={(status) => statuses.push(status)}
        />
      </ReplayFrameProvider>
    );
    const view = render(tree(broken, false));
    for (let step = 0; step < MAX_CONSECUTIVE_LIVE_FRAME_FAILURES; step++) act(() => frame?.(1000 + step * 16));
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'render-loop' });

    act(() => store.setHistory(history));
    view.rerender(tree(replayScene, true));
    act(() => frame?.(3000));
    expect(draw).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'render-loop' });

    act(() => frame?.(3016));
    expect(draw).toHaveBeenCalledOnce();
    // App derives its graphics hold from this status, so replay playback is free again.
    expect(statuses.at(-1)).toEqual({ kind: 'ok' });
  });

  it('gives a new scene a fresh render-failure budget', () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.spyOn(log, 'error').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const broken = {
      ...makeSceneBuilder(),
      build: (): ReturnType<SceneBuilderLike['build']> => {
        throw new TypeError('broken scene');
      },
    };
    // The new scene stumbles once while it settles, then draws.
    const working = {
      ...makeSceneBuilder(),
      build: vi
        .fn(() => createQueue())
        .mockImplementationOnce(() => {
          throw new TypeError('settling');
        }),
    };
    const statuses: RenderStatus[] = [];
    const props = {
      onTileClick: () => {},
      showCoordinates: false,
      renderer: makeRenderer(),
      simulationState: makeSimulationState(),
      onRenderStatusChange: (next: RenderStatus) => statuses.push(next),
    };
    const { rerender } = render(<RenderViewport3D {...props} sceneBuilder={broken} />);
    for (let step = 0; step < MAX_CONSECUTIVE_LIVE_FRAME_FAILURES; step++) act(() => frame?.(1000 + step * 16));
    expect(statuses.at(-1)).toEqual({ kind: 'failed', reason: 'render-loop' });

    rerender(<RenderViewport3D {...props} sceneBuilder={working} />);
    act(() => frame?.(2000));
    act(() => frame?.(2016));

    expect(working.build).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toEqual({ kind: 'ok' });
  });

  it('lets go of a pointer-locked freeform camera at a scene change', () => {
    const projection3D = makeProjection3D();
    const exitPointerLock = vi.fn();
    Object.defineProperty(document, 'exitPointerLock', { configurable: true, value: exitPointerLock });
    const props = {
      onTileClick: () => {},
      showCoordinates: false,
      renderer,
      simulationState: makeSimulationState(),
      projection3D,
    };
    const { rerender } = render(<RenderViewport3D {...props} sceneBuilder={makeSceneBuilder()} />);
    const canvas = screen.getByLabelText('3D Game Grid');
    projection3D.setCameraMode('freeform');
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, value: canvas });

    try {
      rerender(<RenderViewport3D {...props} sceneBuilder={makeSceneBuilder()} />);

      expect(exitPointerLock).toHaveBeenCalledOnce();
      expect(projection3D.getCameraMode()).toBe('orbit');
    } finally {
      Reflect.deleteProperty(document, 'exitPointerLock');
    }
  });

  it('keeps one WebGL context through a StrictMode replay and releases it once on unmount', async () => {
    // A real PicoGLRenderer over a stand-in context: every call is a no-op except the few
    // answers the renderer and PicoGL branch on.
    class FakeWebGL2RenderingContext {}
    vi.stubGlobal('WebGL2RenderingContext', FakeWebGL2RenderingContext);
    const loseContext = vi.fn();
    const answers: Record<PropertyKey, unknown> = {
      drawingBufferWidth: 300,
      drawingBufferHeight: 150,
      isContextLost: () => false,
      getParameter: () => 2048,
      getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null),
      getSupportedExtensions: () => [],
      getContextAttributes: () => ({ antialias: true }),
      getShaderParameter: () => true,
      getProgramParameter: (_program: unknown, pname: number) => pname === 0x8b82,
    };
    const gl = new Proxy(new FakeWebGL2RenderingContext(), {
      get: (_target, name) => (name in answers ? answers[name] : () => ({})),
    });
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(gl as never);
    const picoRenderer = createPicoGLRenderer() as PicoGLRenderer;
    const statuses: RenderStatus['kind'][] = [];
    const textures = {
      ...textureLoader,
      getTextureIds: () => [1],
      getPixelsArgb: () => new Int32Array(128 * 128),
    } satisfies TextureLoader;

    const view = render(
      <StrictMode>
        <RenderViewport3D
          simulationState={makeSimulationState()}
          onTileClick={() => {}}
          showCoordinates={false}
          renderer={picoRenderer}
          sceneBuilder={makeSceneBuilder()}
          textureLoader={textures}
          onRenderStatusChange={(status) => statuses.push(status.kind)}
        />
      </StrictMode>,
    );
    await act(async () => Promise.resolve());
    const canvas = screen.getByLabelText('3D Game Grid');

    // The replayed effects re-initialize the same, still-attached canvas: its context is kept.
    // Each init asks twice (the renderer, then PicoGL), so two inits ran.
    expect(getContext).toHaveBeenCalledTimes(4);
    expect(new Set(getContext.mock.contexts)).toEqual(new Set([canvas]));
    expect(loseContext).not.toHaveBeenCalled();
    expect(picoRenderer.getTextureArrayManager()?.getTextureArray()).toBeTruthy();
    expect(picoRenderer.getContextStatus()).toEqual({ kind: 'ok' });

    view.unmount();

    expect(loseContext).toHaveBeenCalledOnce();
    expect(statuses.every((status) => status === 'ok')).toBe(true);
  });

  it('queues the loaded spotanims for upload ahead once they finish loading', async () => {
    const prepareResidentSources = vi.fn();
    const preparing = { ...renderer, prepareResidentSources };
    const effects = [new ImmutableMeshSource('spotanim-1', [], () => [], { scope: 'loader' })];
    let spotAnimsLoaded = false;
    let finishSpotAnims = () => {};
    const builder = {
      ...deferredTerrainBuilder(),
      loadSpotAnims: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishSpotAnims = () => {
              spotAnimsLoaded = true;
              resolve();
            };
          }),
      ),
      isSpotAnimsLoaded: () => spotAnimsLoaded,
      getResidentMeshSources: () => effects,
    };
    render(
      <RenderViewport3D
        onTileClick={() => {}}
        showCoordinates={false}
        renderer={preparing}
        mapLoader={mapLoader}
        textureLoader={textureLoader}
        spotAnimModelLoader={{} as SpotAnimModelLoader}
        simulationState={makeSimulationState()}
        sceneBuilder={builder}
      />,
    );
    await act(async () => builder.finishTerrain());
    expect(builder.loadSpotAnims).toHaveBeenCalledOnce();
    expect(prepareResidentSources).not.toHaveBeenCalled();

    await act(async () => finishSpotAnims());

    expect(prepareResidentSources).toHaveBeenCalledWith(effects);
  });

  it('reloads, prepares and draws the new loader’s spotanims when the loader is replaced under the same scene', async () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const loaderA = { name: 'A' } as unknown as SpotAnimModelLoader;
    const loaderB = { name: 'B' } as unknown as SpotAnimModelLoader;
    const sourceOf = new Map(
      [loaderA, loaderB].map((loader) => [
        loader,
        new ImmutableMeshSource('spotanim-1', [], () => [], { scope: 'loader', owner: loader }),
      ]),
    );
    const prepared: ImmutableMeshSource[] = [];
    const drawn: ImmutableMeshSource[] = [];
    const retired: object[] = [];
    const recording = {
      ...renderer,
      prepareResidentSources: (sources: readonly ImmutableMeshSource[]) => prepared.push(...sources),
      retireResidentSources: (owner: object) => retired.push(owner),
      render: ({ queue }: RenderFrame) => {
        for (const command of queue.commands) {
          if (command.kind === 'mesh3d' && isResidentMesh3DCommand(command)) drawn.push(command.meshSource);
        }
      },
    };
    // Like the compositor: effects come from whichever loader they were last loaded with, and
    // readiness for a loader means loaded from that loader.
    let loadedFrom: SpotAnimModelLoader | null = null;
    const terrain = deferredTerrainBuilder();
    const builder = {
      ...terrain,
      build: vi.fn((_ctx: RenderContext) => {
        const queue = createQueue();
        const source = loadedFrom && sourceOf.get(loadedFrom);
        if (source) {
          const command: ResidentMesh3DCommand = {
            kind: 'mesh3d',
            meshId: 'spotanim-1-opaque',
            materialId: 'osrs-npc',
            modelMatrix: new Float32Array(16),
            meshSource: source,
            meshSourcePart: 0,
          };
          queue.commands.push(command);
        }
        return queue;
      }),
      loadSpotAnims: vi.fn(async (loader: SpotAnimModelLoader) => {
        loadedFrom = loader;
      }),
      isSpotAnimsLoaded: (loader?: SpotAnimModelLoader) => loadedFrom !== null && (!loader || loadedFrom === loader),
      getResidentMeshSources: () => (loadedFrom ? [sourceOf.get(loadedFrom)!] : []),
    };
    const props = {
      onTileClick: () => {},
      showCoordinates: false,
      renderer: recording,
      mapLoader,
      textureLoader,
      simulationState: makeSimulationState(),
      sceneBuilder: builder,
    };
    const { rerender } = render(<RenderViewport3D {...props} spotAnimModelLoader={loaderA} />);
    await act(async () => builder.finishTerrain());
    act(() => frame?.(1000));
    expect(prepared).toEqual([sourceOf.get(loaderA)]);
    expect(drawn).toContain(sourceOf.get(loaderA));

    prepared.length = 0;
    drawn.length = 0;
    rerender(<RenderViewport3D {...props} spotAnimModelLoader={loaderB} />);
    await act(async () => Promise.resolve());
    act(() => frame?.(1016));
    act(() => frame?.(1032));

    expect(retired).toEqual([loaderA]);
    expect(builder.loadSpotAnims).toHaveBeenLastCalledWith(loaderB);
    expect(prepared).toEqual([sourceOf.get(loaderB)]);
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.every((source) => source === sourceOf.get(loaderB))).toBe(true);
  });

  it('keeps a still-owned scene builder when the 3D view unmounts and comes back (3D to 2D to 3D)', async () => {
    const onSceneReady = vi.fn();
    const builder = deferredTerrainBuilder();
    const props = {
      onTileClick: () => {},
      showCoordinates: false,
      renderer,
      mapLoader,
      textureLoader,
      onSceneReady,
      simulationState: makeSimulationState(),
      sceneBuilder: builder,
    };
    const first = render(<RenderViewport3D {...props} />);
    await act(async () => builder.finishTerrain());
    first.unmount();

    render(<RenderViewport3D {...props} />);
    await act(async () => Promise.resolve());

    expect(builder.dispose).not.toHaveBeenCalled();
    expect(builder.loadTerrain).toHaveBeenCalledOnce();
    expect(onSceneReady).toHaveBeenCalledTimes(2);
  });

  it('reports ready when remounting a scene whose terrain is already loaded', async () => {
    // Given
    const onSceneReady = vi.fn();
    const sceneBuilder: SceneBuilderLike = {
      build: () => createQueue(),
      loadTerrain: () => Promise.resolve(),
      isTerrainLoaded: () => true,
      loadNpc: () => Promise.resolve(),
      isNpcLoaded: () => true,
      loadPlayer: () => Promise.resolve(),
      isPlayerLoaded: () => true,
      loadSpotAnims: () => Promise.resolve(),
      isSpotAnimsLoaded: () => true,
      loadLocs: () => Promise.resolve(),
      isLocsLoaded: () => true,
    };

    // When
    render(
      <RenderViewport3D
        simulationState={new SimulationEngine({ encounter: new LobbyEncounter() }).getState()}
        onTileClick={() => {}}
        showCoordinates={false}
        renderer={renderer}
        sceneBuilder={sceneBuilder}
        onSceneReady={onSceneReady}
      />,
    );

    // Then
    await waitFor(() => expect(onSceneReady).toHaveBeenCalledOnce());
  });
});

// Wheel zoom notch normalization
describe('RenderViewport3D — wheel zoom is per notch, not per event', () => {
  /**
   * `fireEvent.wheel` drops `wheelDeltaY`, which is the property that tells a
   * detented mouse from a trackpad — without it every case here silently
   * exercises the trackpad path.
   */
  function scroll(init: {
    deltaY: number;
    wheelDeltaY?: number;
    deltaMode?: number;
    deltaX?: number;
    altKey?: boolean;
  }): WheelEvent {
    const event = new WheelEvent('wheel', {
      deltaY: init.deltaY,
      deltaX: init.deltaX ?? 0,
      deltaMode: init.deltaMode ?? 0,
      bubbles: true,
      cancelable: true,
    });
    // happy-dom's WheelEvent ignores modifier keys in its init dict.
    if (init.altKey) Object.defineProperty(event, 'altKey', { value: true });
    if (init.wheelDeltaY !== undefined) {
      Object.defineProperty(event, 'wheelDeltaY', { value: init.wheelDeltaY });
    }
    fireEvent(getViewportContainer(), event);
    return event;
  }

  it('leaves Alt+wheel to the UI-panel resize gesture: no camera zoom, and it reaches the window', () => {
    const projection3D = makeProjection3D();
    renderPlain(projection3D);
    const start = projection3D.getCameraState().fovScale;
    const reachedWindow = vi.fn();
    window.addEventListener('wheel', reachedWindow);
    try {
      const event = scroll({ deltaY: 100, wheelDeltaY: -120, altKey: true });
      expect(projection3D.getCameraState().fovScale).toBe(start);
      expect(reachedWindow).toHaveBeenCalledTimes(1);
      // Still canceled, so the page never scrolls or zooms under the gesture.
      expect(event.defaultPrevented).toBe(true);
    } finally {
      window.removeEventListener('wheel', reachedWindow);
    }
    // A plain wheel still zooms.
    scroll({ deltaY: 100, wheelDeltaY: -120 });
    expect(projection3D.getCameraState().fovScale).toBe(start - 25);
  });

  function renderPlain(projection3D: ReturnType<typeof makeProjection3D>) {
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
      />,
    );
  }

  it("moves one increment per notch, in the client's direction", () => {
    const projection3D = makeProjection3D();
    renderPlain(projection3D);
    const start = projection3D.getCameraState().fovScale;

    // deltaY > 0 is scroll-down, which the client zooms OUT.
    scroll({ deltaY: 100, wheelDeltaY: -120 });
    expect(projection3D.getCameraState().fovScale).toBe(start - 25);

    scroll({ deltaY: -100, wheelDeltaY: 120 });
    expect(projection3D.getCameraState().fovScale).toBe(start);
  });

  it('counts notches from wheelDeltaY, so a coalesced burst is not lost', () => {
    const projection3D = makeProjection3D();
    renderPlain(projection3D);
    const start = projection3D.getCameraState().fovScale;

    // Three notches turned quickly, delivered as one event. deltaY is a scroll
    // DISTANCE the browser scales per platform (159 here, not 300), so counting
    // notches from it loses one; wheelDeltaY is exactly 120 per notch.
    scroll({ deltaY: 159, wheelDeltaY: -360 });
    expect(projection3D.getCameraState().fovScale).toBe(start - 3 * 25);
  });

  it('never drops a notch from a mouse that reports less than 100px per click', () => {
    const projection3D = makeProjection3D();
    renderPlain(projection3D);
    const start = projection3D.getCameraState().fovScale;

    // Plenty of setups report ~53px per notch. Accumulating those banks a
    // fraction per click, so the first click of every gesture does nothing and
    // the wheel feels like it is eating scrolls.
    for (let i = 0; i < 3; i++) {
      scroll({ deltaY: 53, wheelDeltaY: -120 });
    }
    expect(projection3D.getCameraState().fovScale).toBe(start - 3 * 25);
  });

  it('spends a fast trackpad flick by how far it moved, not per event', () => {
    const projection3D = makeProjection3D();
    renderPlain(projection3D);
    const start = projection3D.getCameraState().fovScale;

    // wheelDeltaY is not a multiple of 120, so this is a surface. Two events of
    // 1.325 notches is 2.65 notches of movement, which spends 2 and banks the
    // rest — not 2 because there were 2 events.
    for (let i = 0; i < 2; i++) scroll({ deltaY: 53, wheelDeltaY: -159 });
    expect(projection3D.getCameraState().fovScale).toBe(start - 2 * 25);

    // A third event crosses the next whole notch off the banked remainder.
    scroll({ deltaY: 53, wheelDeltaY: -159 });
    expect(projection3D.getCameraState().fovScale).toBe(start - 3 * 25);
  });

  it('does not take a whole notch from every trackpad event', () => {
    const projection3D = makeProjection3D();
    renderPlain(projection3D);
    const start = projection3D.getCameraState().fovScale;

    // Four events of 0.625 notches is 2.5 notches of movement. Taking a full 25
    // from each would make a swipe race away.
    for (let i = 0; i < 4; i++) scroll({ deltaY: 25, wheelDeltaY: -75 });
    expect(projection3D.getCameraState().fovScale).toBe(start - 2 * 25);
  });

  it('does not bank a remainder from an over-sized notch', () => {
    const projection3D = makeProjection3D();
    renderPlain(projection3D);
    const start = projection3D.getCameraState().fovScale;

    // A mouse reporting 120/notch must still step once per notch, five times,
    // rather than accumulating 0.2 each time and lurching on the fifth.
    for (let i = 0; i < 5; i++) scroll({ deltaY: 120, wheelDeltaY: -120 });
    expect(projection3D.getCameraState().fovScale).toBe(start - 5 * 25);
  });

  it('reads line and page deltaModes as notches too', () => {
    const projection3D = makeProjection3D();
    renderPlain(projection3D);
    const start = projection3D.getCameraState().fovScale;

    scroll({ deltaY: 3, deltaMode: 1 });
    expect(projection3D.getCameraState().fovScale).toBe(start - 25);

    scroll({ deltaY: 1, deltaMode: 2 });
    expect(projection3D.getCameraState().fovScale).toBe(start - 50);
  });

  it('ignores a horizontal-only gesture', () => {
    const projection3D = makeProjection3D();
    renderPlain(projection3D);
    const start = projection3D.getCameraState().fovScale;

    scroll({ deltaY: 0, deltaX: 200 });
    expect(projection3D.getCameraState().fovScale).toBe(start);
  });
});

describe('RenderViewport3D touch camera (touch-only devices)', () => {
  function stubPointers(kind: 'touch-only' | 'touchscreen-laptop'): void {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        // A touchscreen laptop also has a fine pointer, so the touch-only query fails.
        matches: kind === 'touch-only' && query.includes('coarse'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  }

  function touch(
    type: 'pointerdown' | 'pointermove' | 'pointerup',
    id: number,
    x: number,
    y: number,
    pointerType = 'touch',
  ): void {
    fireEvent(
      screen.getByLabelText('3D Game Grid'),
      new PointerEvent(type, { bubbles: true, pointerType, pointerId: id, clientX: x, clientY: y }),
    );
  }

  function renderTouch(
    projection3D: Projection3D,
    props: Partial<ComponentProps<typeof RenderViewport3D>> = {},
  ): HTMLElement {
    render(
      <RenderViewport3D
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        projection3D={projection3D}
        {...props}
      />,
    );
    const canvas = screen.getByLabelText('3D Game Grid');
    stubCanvasRect(canvas);
    return canvas;
  }

  let restoreTouchPoints = () => {};
  afterEach(() => {
    vi.useRealTimers();
    restoreTouchPoints();
    restoreTouchPoints = () => {};
  });

  it.each([
    'touch',
    'pen',
  ])('drives the camera from a %s on a touchscreen laptop too, claiming its canvas touches', (pointerType) => {
    stubPointers('touchscreen-laptop');
    restoreTouchPoints = stubMaxTouchPoints(10);
    const projection3D = makeProjection3D();
    const initialYaw = projection3D.getCameraState().yaw;
    const canvas = renderTouch(projection3D);

    touch('pointerdown', 1, 100, 100, pointerType);
    touch('pointermove', 1, 100 + TOUCH_SLOP_PX, 100, pointerType);
    touch('pointermove', 1, 200, 100, pointerType);

    expect(canvas.style.touchAction).toBe('none');
    expect(projection3D.getCameraState().yaw).not.toBe(initialYaw);
  });

  it('leaves a pen on a separate pad (no touchscreen) on the mouse path: it hovers, clicks, and never turns the camera', () => {
    stubPointers('touchscreen-laptop');
    restoreTouchPoints = stubMaxTouchPoints(0);
    const projection3D = makeProjection3D();
    const initialYaw = projection3D.getCameraState().yaw;
    const onTileClick = vi.fn();
    const onHoveredTileChange = vi.fn();
    const canvas = renderTouch(projection3D, { onTileClick, onHoveredTileChange });

    // Hovering above the pad, as a mouse moves.
    touch('pointermove', 1, 400, 300, 'pen');
    fireEvent.mouseMove(canvas, { clientX: 400, clientY: 300 });
    expect(onHoveredTileChange).toHaveBeenCalledTimes(1);

    // A press and drag: the camera ignores it, and its compatibility mousedown clicks.
    touch('pointerdown', 1, 400, 300, 'pen');
    fireEvent(canvas, mouseDownEvent({ button: 0, buttons: 1, clientX: 400, clientY: 300 }, 0));
    touch('pointermove', 1, 400 + TOUCH_SLOP_PX, 300, 'pen');
    touch('pointermove', 1, 500, 300, 'pen');
    touch('pointerup', 1, 500, 300, 'pen');
    expect(onTileClick).toHaveBeenCalledTimes(1);
    expect(projection3D.getCameraState().yaw).toBe(initialYaw);
  });

  it("drops the mouse's hover while a finger turns the camera, and the mouse's next move brings it back", () => {
    stubPointers('touchscreen-laptop');
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const hovered: (Coordinate | null)[] = [];
    const build = vi.fn((context: RenderContext) => {
      hovered.push(context.interaction.hoveredTile);
      return createQueue();
    });
    const canvas = renderTouch(makeProjection3D(), { sceneBuilder: { ...makeSceneBuilder(), build } });
    const mouseMove = () => {
      fireEvent(
        canvas,
        new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: 250, clientY: 200 }),
      );
      fireEvent.mouseMove(canvas, { clientX: 250, clientY: 200 });
    };

    mouseMove();
    act(() => frame?.(1000));
    expect(hovered.at(-1)).not.toBeNull();

    touch('pointerdown', 1, 300, 300);
    act(() => frame?.(1016));
    for (const [x, time] of [
      [300 + TOUCH_SLOP_PX, 1032],
      [400, 1048],
    ]) {
      touch('pointermove', 1, x, 300);
      act(() => frame?.(time));
      expect(hovered.at(-1)).toBeNull();
    }
    touch('pointerup', 1, 400, 300);

    mouseMove();
    act(() => frame?.(1064));
    expect(hovered.at(-1)).not.toBeNull();
  });

  it("leaves a touchscreen laptop's mouse as it was: it clicks and hovers, while a tap's mousemove does not", () => {
    stubPointers('touchscreen-laptop');
    const onTileClick = vi.fn();
    const onHoveredTileChange = vi.fn();
    const canvas = renderTouch(makeProjection3D(), { onTileClick, onHoveredTileChange });
    const mouse = (type: string) =>
      fireEvent(canvas, new PointerEvent(type, { bubbles: true, pointerType: 'mouse', clientX: 400, clientY: 300 }));

    mouse('pointermove');
    fireEvent.mouseMove(canvas, { clientX: 400, clientY: 300 });
    expect(onHoveredTileChange).toHaveBeenCalledTimes(1);

    // A finger's tap walks and drops the mouse's hover, and the compatibility mousemove the
    // browser sends with it is no hover.
    touch('pointerdown', 1, 400, 300);
    touch('pointerup', 1, 400, 300);
    fireEvent.mouseMove(canvas, { clientX: 400, clientY: 300 });
    expect(onTileClick).toHaveBeenCalledTimes(1);
    expect(onHoveredTileChange).toHaveBeenCalledTimes(2);
    expect(onHoveredTileChange).toHaveBeenLastCalledWith(null, { x: -1, y: -1 });

    // The mouse's own pointer events hand hover and clicks straight back.
    mouse('pointermove');
    fireEvent.mouseMove(canvas, { clientX: 400, clientY: 300 });
    expect(onHoveredTileChange).toHaveBeenCalledTimes(3);
    expect(onHoveredTileChange.mock.lastCall?.[0]).not.toBeNull();
    mouse('pointerdown');
    fireEvent(canvas, mouseDownEvent({ button: 0, buttons: 1, clientX: 400, clientY: 300 }, 0));
    expect(onTileClick).toHaveBeenCalledTimes(2);
  });

  it('claims canvas touches on a touch-only device so the page does not scroll or zoom', () => {
    stubPointers('touch-only');
    expect(renderTouch(makeProjection3D()).style.touchAction).toBe('none');
  });

  it('rotates on a one-finger drag at twice the mouse rate, after the tap slop', () => {
    stubPointers('touch-only');
    const projection3D = makeProjection3D();
    const initialYaw = projection3D.getCameraState().yaw;
    renderTouch(projection3D);

    touch('pointerdown', 1, 100, 100);
    touch('pointermove', 1, 100 + TOUCH_SLOP_PX - 1, 100);
    touch('pointermove', 1, 110 + TOUCH_SLOP_PX, 100);
    expect(projection3D.getCameraState().yaw).toBe(initialYaw);
    touch('pointermove', 1, 170 + TOUCH_SLOP_PX, 100);

    expect(projection3D.getCameraState().yaw).toBeCloseTo(initialYaw - (60 * 0.9 * 360 * 2) / 2048);
  });

  it.each([200, 500])('doubles the view when two fingers spread twice as far apart, from zoom %i alike', (start) => {
    stubPointers('touch-only');
    const projection3D = makeProjection3D();
    projection3D.updateCamera({ fovScale: start });
    renderTouch(projection3D);

    touch('pointerdown', 1, 300, 300);
    touch('pointerdown', 2, 400, 300);
    touch('pointermove', 2, 450, 300);
    touch('pointermove', 1, 250, 300);

    // Every 256 of zoom doubles the lens (zoomToLensStrength).
    expect(projection3D.getCameraState().fovScale).toBe(start + 256);
  });

  it('halves the view when two fingers close to half their spread', () => {
    stubPointers('touch-only');
    const projection3D = makeProjection3D();
    projection3D.updateCamera({ fovScale: 500 });
    renderTouch(projection3D);

    touch('pointerdown', 1, 300, 300);
    touch('pointerdown', 2, 500, 300);
    touch('pointermove', 2, 400, 300);

    expect(projection3D.getCameraState().fovScale).toBe(244);
  });

  it('scales pinch zoom with the zoom Speed setting, 25 being one doubling per doubled spread', () => {
    stubPointers('touch-only');
    const projection3D = makeProjection3D();
    projection3D.updateCamera({ fovScale: 200 });
    renderTouch(projection3D, { zoomIncrement: 50 });

    touch('pointerdown', 1, 300, 300);
    touch('pointerdown', 2, 400, 300);
    touch('pointermove', 2, 500, 300);

    expect(projection3D.getCameraState().fovScale).toBe(712);
  });

  it('zooms back out at once when a pinch that overshot the zoom limit closes', () => {
    stubPointers('touch-only');
    const projection3D = makeProjection3D();
    projection3D.updateCamera({ fovScale: 300 });
    renderTouch(projection3D);

    touch('pointerdown', 1, 300, 300);
    touch('pointerdown', 2, 400, 300);
    // Eight times the spread asks for 300 + 3 * 256 = 1068, past the 896 limit.
    touch('pointermove', 2, 1100, 300);
    expect(projection3D.getCameraState().fovScale).toBe(896);
    // Halving the spread from there halves the view, without first undoing the overshoot.
    touch('pointermove', 2, 700, 300);

    expect(projection3D.getCameraState().fovScale).toBe(640);
  });

  it('opens the right-click menu on a held touch at the touch point', () => {
    stubPointers('touch-only');
    vi.useFakeTimers();
    const onContextMenu = vi.fn(() => ({ kind: 'claimed' as const }));
    renderTouch(makeProjection3D(), { onContextMenu });

    touch('pointerdown', 1, 400, 300);
    vi.advanceTimersByTime(TOUCH_LONG_PRESS_DEFAULT_MS - 1);
    expect(onContextMenu).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onContextMenu).toHaveBeenCalledWith(expect.anything(), 400, 300, { x: 400, y: 300 }, false);
  });

  it('does not open the menu once a touch has started rotating', () => {
    stubPointers('touch-only');
    vi.useFakeTimers();
    const onContextMenu = vi.fn(() => ({ kind: 'claimed' as const }));
    renderTouch(makeProjection3D(), { onContextMenu });

    touch('pointerdown', 1, 400, 300);
    touch('pointermove', 1, 450, 300);
    vi.advanceTimersByTime(1000);

    expect(onContextMenu).not.toHaveBeenCalled();
  });

  it('walks once per tap, and swallows the compatibility mousedown after a tap, drag, or hold', () => {
    stubPointers('touch-only');
    vi.useFakeTimers();
    const onTileClick = vi.fn();
    const menuSawMouseDown = vi.fn();
    const canvas = renderTouch(makeProjection3D(), { onTileClick, onContextMenu: () => ({ kind: 'claimed' }) });
    const compatMouseDown = (x: number) =>
      fireEvent(canvas, mouseDownEvent({ button: 0, buttons: 1, clientX: x, clientY: 300 }, 0));

    touch('pointerdown', 1, 400, 300);
    touch('pointerup', 1, 400, 300);
    expect(onTileClick).toHaveBeenCalledTimes(1);
    compatMouseDown(400);
    expect(onTileClick).toHaveBeenCalledTimes(1);

    touch('pointerdown', 1, 400, 300);
    touch('pointermove', 1, 460, 300);
    touch('pointerup', 1, 460, 300);
    compatMouseDown(460);
    expect(onTileClick).toHaveBeenCalledTimes(1);

    // A hold opens a menu under the finger; a later window-capture listener (like the menu's)
    // must not see the release's compatibility mousedown as a pick.
    touch('pointerdown', 1, 400, 300);
    vi.advanceTimersByTime(TOUCH_LONG_PRESS_DEFAULT_MS);
    window.addEventListener('mousedown', menuSawMouseDown, true);
    try {
      touch('pointerup', 1, 400, 300);
      compatMouseDown(400);
      expect(menuSawMouseDown).not.toHaveBeenCalled();
      expect(onTileClick).toHaveBeenCalledTimes(1);

      // The next tap reaches the menu as a pick, exactly once.
      touch('pointerdown', 1, 400, 300);
      touch('pointerup', 1, 400, 300);
      compatMouseDown(400);
      expect(menuSawMouseDown).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('mousedown', menuSawMouseDown, true);
    }
  });

  it('takes a canvas touch over and sends its tap as a full left click with its modifiers', () => {
    stubPointers('touch-only');
    const canvas = renderTouch(makeProjection3D());
    const seen: string[] = [];
    const record = (e: MouseEvent) => seen.push(`${e.type}:${e.buttons}:${e.shiftKey}`);
    canvas.addEventListener('mousedown', record);
    canvas.addEventListener('mouseup', record);

    const down = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerType: 'touch',
      pointerId: 1,
      clientX: 400,
      clientY: 300,
    });
    fireEvent(canvas, down);
    fireEvent(
      canvas,
      new PointerEvent('pointerup', {
        bubbles: true,
        pointerType: 'touch',
        pointerId: 1,
        clientX: 400,
        clientY: 300,
        shiftKey: true,
      }),
    );

    expect(down.defaultPrevented).toBe(true);
    // The release clears the button, so nothing tracking it is left holding a press.
    expect(seen).toEqual(['mousedown:1:true', 'mouseup:0:true']);
  });

  it('walks on a slow tap the browser would not turn into a click', () => {
    stubPointers('touch-only');
    vi.useFakeTimers();
    const onTileClick = vi.fn();
    renderTouch(makeProjection3D(), { onTileClick });

    touch('pointerdown', 1, 400, 300);
    vi.advanceTimersByTime(TOUCH_LONG_PRESS_DEFAULT_MS - 50);
    touch('pointermove', 1, 404, 302);
    touch('pointerup', 1, 404, 302);

    expect(onTileClick).toHaveBeenCalledTimes(1);
  });

  it("does not treat a tap's compatibility mousemove as a hover", () => {
    stubPointers('touch-only');
    const onHoveredTileChange = vi.fn();
    const canvas = renderTouch(makeProjection3D(), { onHoveredTileChange });

    fireEvent.mouseMove(canvas, { clientX: 400, clientY: 300 });

    expect(onHoveredTileChange).not.toHaveBeenCalled();
  });

  it('ignores touch rotation while a watch step gates input', () => {
    stubPointers('touch-only');
    const projection3D = makeProjection3D();
    const initialYaw = projection3D.getCameraState().yaw;
    renderTouch(projection3D);
    setWatchInputGated(true);

    touch('pointerdown', 1, 100, 100);
    touch('pointermove', 1, 200, 100);

    expect(projection3D.getCameraState().yaw).toBe(initialYaw);
  });
});

describe('RenderViewport3D replay history', () => {
  function historyFrames(count: number): readonly ReplayDisplayFrame[] {
    return Array.from({ length: count }, () => ({ state: makeSimulationState(), events: [] }));
  }

  interface ReplayProps {
    readonly replayIsReplaying: boolean;
    readonly replayFrameIndex: number;
    readonly replayPaused?: boolean;
    readonly speedMultiplier?: number;
  }

  /** Mounts inside a real frame store; `renderFrame` runs one render-loop frame and returns its context. */
  function mountWithStore(store: ReplayFrameStore, initial: ReplayProps) {
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback);
        return rafCallbacks.length;
      }),
    );
    const build = vi.fn((_ctx: RenderContext) => createQueue());
    const sceneBuilder: SceneBuilderLike = { ...makeSceneBuilder(), build };
    const renderer = makeRenderer();
    const simulationState = makeSimulationState();
    const onRender = vi.fn();
    const projection3D = makeProjection3D();
    const tree = (props: ReplayProps) => (
      <ReplayFrameProvider store={store}>
        <Profiler id="viewport" onRender={onRender}>
          <RenderViewport3D
            simulationState={simulationState}
            onTileClick={vi.fn()}
            showCoordinates={false}
            renderer={renderer}
            sceneBuilder={sceneBuilder}
            replayIsReplaying={props.replayIsReplaying}
            replayFrameIndex={props.replayFrameIndex}
            replayPaused={props.replayPaused}
            replayPlaying={!props.replayPaused}
            speedMultiplier={props.speedMultiplier}
            projection3D={projection3D}
          />
        </Profiler>
      </ReplayFrameProvider>
    );
    const { rerender } = render(tree(initial));
    const renderFrame = (): RenderContext | undefined => {
      const frame = rafCallbacks.at(-1);
      if (!frame) throw new Error('Expected the render loop to have scheduled a frame');
      act(() => frame(1000));
      return build.mock.lastCall?.[0];
    };
    return { rerender: (props: ReplayProps) => rerender(tree(props)), renderFrame, onRender, projection3D };
  }

  it.each([
    [false, true, 1],
    [true, false, 1],
    [false, false, 4],
    [true, true, 4],
  ])('holds the exact subtick and player pose from paused=%s to paused=%s at speed=%s', (initialPaused, paused, speed) => {
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    const store = new ReplayFrameStore();
    const state: SimulationState = {
      ...makeSimulationState(),
      currentTick: 51,
      playerPreviousPosition: [31, 37],
      playerPosition: [32, 38],
      playerMovementPath: [
        [32, 37],
        [32, 38],
      ],
      playerFacingAngle: 1024,
      playerIsMoving: true,
      playerIsRunning: true,
    };
    store.setHistory([
      { state: makeSimulationState(), events: [] },
      { state, events: [] },
    ]);
    store.set(1050, undefined);
    const view = mountWithStore(store, { replayIsReplaying: true, replayFrameIndex: 0, replayPaused: initialPaused });
    const before = view.renderFrame();

    view.rerender({ replayIsReplaying: true, replayFrameIndex: 1, replayPaused: paused, speedMultiplier: speed });
    vi.mocked(performance.now).mockReturnValue(5000);
    const after = view.renderFrame();

    expect(before?.interpolatedTick).toBe(51.75);
    expect(before?.playerVisual).toMatchObject({ position: [32, 37.5], facingAngle: 1024 });
    expect(after?.interpolatedTick).toBe(before?.interpolatedTick);
    expect(after?.playerVisual).toEqual(before?.playerVisual);
  });

  it('pauses a preview before the playing prop commits and supplies its state and events', () => {
    const store = new ReplayFrameStore();
    const frames = historyFrames(4);
    store.setHistory(frames);
    const view = mountWithStore(store, { replayIsReplaying: true, replayFrameIndex: 3, replayPaused: false });
    const preview = { frameIndex: 1, state: { ...makeSimulationState(), currentTick: 32 }, events: [] };

    act(() => store.setPreview(preview));
    const context = view.renderFrame();

    expect(context?.simulationState).toBe(preview.state);
    expect(context?.events).toBe(preview.events);
    expect(context?.interpolatedTick).toBe(32);
    expect(context?.timeline?.paused).toBe(true);
    expect(context?.frameDeltaMs).toBe(0);
  });

  it('applies new store camera samples in RAF without a React commit', () => {
    const store = new ReplayFrameStore();
    store.set(0, makeReplayViewportState(90, 512));
    const view = mountWithStore(store, { replayIsReplaying: true, replayFrameIndex: 0 });
    const baseline = view.onRender.mock.calls.length;

    act(() => store.set(250, makeReplayViewportState(270, 640)));
    view.renderFrame();

    expect(view.onRender).toHaveBeenCalledTimes(baseline);
    expect(view.projection3D.getCameraState().yaw).toBe(270);
  });

  it('retains client-cycle turning instead of snapping replay movement to the target angle', () => {
    const store = new ReplayFrameStore();
    const state: SimulationState = {
      ...makeSimulationState(),
      playerPreviousPosition: [31, 37],
      playerPosition: [32, 37],
      playerMovementPath: [[32, 37]],
      playerFacingAngle: 0,
      playerIsMoving: true,
      playerIsRunning: false,
    };
    store.setHistory([{ state, events: [] }]);
    const view = mountWithStore(store, { replayIsReplaying: true, replayFrameIndex: 0 });
    view.renderFrame();

    act(() => store.set(20, undefined));
    const context = view.renderFrame();

    expect(context?.playerVisual).toMatchObject({ facingAngle: 2016, targetAngle: 1536, isTurning: true });
  });

  it('advances the selected frame and pose before the discrete React frame index commits', () => {
    const store = new ReplayFrameStore();
    const nextState: SimulationState = {
      ...makeSimulationState(),
      currentTick: 42,
      playerPreviousPosition: [31, 37],
      playerPosition: [32, 37],
      playerMovementPath: [[32, 37]],
      playerFacingAngle: 1536,
    };
    const frames = [
      { state: makeSimulationState(), events: [] },
      { state: nextState, events: [] },
    ];
    store.setHistory(frames);
    const view = mountWithStore(store, { replayIsReplaying: true, replayFrameIndex: 0 });
    view.renderFrame();
    const baseline = view.onRender.mock.calls.length;

    act(() => store.set(900, undefined));
    const context = view.renderFrame();

    expect(view.onRender).toHaveBeenCalledTimes(baseline);
    expect(context?.simulationState).toBe(nextState);
    expect(context?.events).toBe(frames[1].events);
    expect(context?.interpolatedTick).toBe(42.5);
    expect(context?.playerVisual?.position).toEqual([31.5, 37]);
    expect(context?.replayHistory?.throughFrameIndex).toBe(1);
  });

  it('draws a teleport during normal-speed playback on its tick, not at the next step', () => {
    const store = new ReplayFrameStore();
    const before: SimulationState = { ...makeSimulationState(), currentTick: 26, playerPosition: [22, 22] };
    before.playerPreviousPosition = before.playerPosition;
    const teleported: SimulationState = {
      ...makeSimulationState(),
      currentTick: 27,
      playerPosition: [31, 44],
      playerPreviousPosition: [31, 44],
      playerFacingAngle: 1024,
    };
    store.setHistory([
      { state: before, events: [] },
      { state: teleported, events: [] },
    ]);
    const view = mountWithStore(store, { replayIsReplaying: true, replayFrameIndex: 0 });
    act(() => store.set(300, undefined));
    expect(view.renderFrame()?.playerVisual?.position).toEqual([22, 22]);

    act(() => store.set(900, undefined));
    const context = view.renderFrame();
    expect(context?.simulationState).toBe(teleported);
    expect(context?.playerVisual?.position).toEqual([31, 44]);
    expect(view.projection3D.getCameraState()).toMatchObject({ targetX: 31.5, targetY: 44.5 });
  });

  it('cancels an existing drag when camera ownership arrives through the raw store', () => {
    const store = new ReplayFrameStore();
    const view = mountWithStore(store, { replayIsReplaying: true, replayFrameIndex: 0 });
    fireEvent.mouseDown(window, { button: 1, buttons: 4, clientX: 100, clientY: 100 });
    act(() => store.set(100, makeReplayViewportState(90, 512)));
    view.renderFrame();
    view.rerender({ replayIsReplaying: false, replayFrameIndex: 0 });
    const camera = view.projection3D.getCameraState();

    fireEvent.mouseMove(window, { buttons: 4, clientX: 150, clientY: 100 });

    expect(view.projection3D.getCameraState().yaw).toBe(camera.yaw);
  });

  it('hands the scene the full history through the previewed tick while a scrub is in flight', () => {
    const store = new ReplayFrameStore();
    const frames = historyFrames(4);
    store.setHistory(frames);
    const { renderFrame } = mountWithStore(store, { replayIsReplaying: true, replayFrameIndex: 3 });

    act(() => store.setPreview({ frameIndex: 1, state: makeSimulationState(), events: [] }));

    const history = renderFrame()?.replayHistory;
    expect(history?.frames).toBe(frames);
    expect(history?.throughFrameIndex).toBe(1);
  });

  it('falls back to the committed frame index once the preview clears', () => {
    const store = new ReplayFrameStore();
    const frames = historyFrames(4);
    store.setHistory(frames);
    store.setPreview({ frameIndex: 1, state: makeSimulationState(), events: [] });
    store.set(1800, undefined);
    const { renderFrame } = mountWithStore(store, { replayIsReplaying: true, replayFrameIndex: 3 });

    act(() => store.setPreview(undefined));

    const history = renderFrame()?.replayHistory;
    expect(history?.frames).toBe(frames);
    expect(history?.throughFrameIndex).toBe(3);
  });

  it('withholds history from a live scene even while the store still holds one', () => {
    const store = new ReplayFrameStore();
    store.setHistory(historyFrames(2));

    const { renderFrame } = mountWithStore(store, { replayIsReplaying: false, replayFrameIndex: 0 });

    expect(renderFrame()?.replayHistory).toBeUndefined();
  });

  it('drops the history the moment replay exits, before the store forgets it', () => {
    const store = new ReplayFrameStore();
    const frames = historyFrames(3);
    store.setHistory(frames);
    const { rerender, renderFrame } = mountWithStore(store, { replayIsReplaying: true, replayFrameIndex: 2 });
    expect(renderFrame()?.replayHistory?.frames).toBe(frames);

    rerender({ replayIsReplaying: false, replayFrameIndex: 2 });

    expect(renderFrame()?.replayHistory).toBeUndefined();
  });
});

describe('RenderViewport3D countdown start positioning', () => {
  const LANDING: Coordinate = [31, 37];
  const tickZero = (position: Coordinate): SimulationState => ({
    ...makeSimulationState(),
    currentTick: 0,
    playerPosition: position,
    playerPreviousPosition: position,
    // Facing the walk, so turning does not slow it.
    playerFacingAngle: 1024,
  });

  it.each([
    16, 33,
  ])('walks each step once at tick 0 and hands over to tick 1 without a snap or replay at %i ms frames', (frameMs) => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    let nowMs = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const contexts: RenderContext[] = [];
    const build = vi.fn((context: RenderContext) => {
      contexts.push(context);
      return createQueue();
    });
    const projection = makeProjection3D();
    let preparation: StartPositionPreparation | null = null;
    const props = {
      onTileClick: vi.fn(),
      showCoordinates: false,
      renderer: makeRenderer(),
      sceneBuilder: { ...makeSceneBuilder(), build },
      projection3D: projection,
      getStartPositionPreparation: () => preparation,
    };
    const view = render(<RenderViewport3D {...props} simulationState={tickZero(LANDING)} />);
    const ys: number[] = [];
    const run = (untilMs: number) => {
      while (nowMs < untilMs) {
        nowMs = Math.min(nowMs + frameMs, untilMs);
        act(() => frame?.(nowMs));
        const context = contexts.at(-1);
        ys.push(context?.playerVisual?.position[1] ?? Number.NaN);
        // The countdown's ticks are not the fight's: interpolation never runs past tick 1.
        if (context?.simulationState.currentTick === 0) expect(context.interpolatedTick).toBeLessThanOrEqual(1);
      }
    };
    run(1600);
    expect(contexts.at(-1)?.playerVisual?.position).toEqual(LANDING);

    // Two positioning steps north, as the wiring publishes them: descriptor first, state after.
    const boundary = {};
    preparation = {
      boundary,
      sequence: 1,
      steppedAtMs: 1600,
      step: {
        from: LANDING,
        stepTiles: [
          [31, 38],
          [31, 39],
        ],
        to: [31, 39],
        isRunning: true,
      },
    };
    view.rerender(<RenderViewport3D {...props} simulationState={tickZero([31, 39])} />);
    run(1900);
    const midway = contexts.at(-1)?.playerVisual?.position[1] ?? 0;
    expect(midway).toBeGreaterThan(37);
    expect(midway).toBeLessThan(39);
    run(2200);
    expect(contexts.at(-1)?.playerVisual?.position[1]).toBeGreaterThan(38.5);
    preparation = {
      ...preparation,
      sequence: 2,
      steppedAtMs: 2200,
      step: {
        from: [31, 39],
        stepTiles: [
          [31, 40],
          [31, 41],
        ],
        to: [31, 41],
        isRunning: true,
      },
    };
    view.rerender(<RenderViewport3D {...props} simulationState={tickZero([31, 41])} />);
    // The same step seen on many frames is walked once.
    run(2800);
    const beforeGo = contexts.at(-1)?.playerVisual?.position[1] ?? 0;
    expect(beforeGo).toBeGreaterThan(40.5);
    expect(beforeGo).toBeLessThanOrEqual(41);
    // The follow camera follows the walk.
    expect(projection.getCameraState().targetY).toBeGreaterThan(40);

    // GO: the descriptor is gone, the committed start is stationary, tick 1 walks on from it.
    preparation = null;
    view.rerender(<RenderViewport3D {...props} simulationState={tickZero([31, 41])} />);
    view.rerender(
      <RenderViewport3D
        {...props}
        simulationState={{
          ...tickZero([31, 43]),
          currentTick: 1,
          playerPreviousPosition: [31, 41],
          playerMovementPath: [
            [31, 42],
            [31, 43],
          ],
          playerIsMoving: true,
          playerIsRunning: true,
        }}
      />,
    );
    const atGo = ys.length;
    run(4000);
    expect(contexts.at(-1)?.playerVisual?.position).toEqual([31, 43]);
    // Never back toward the landing, and no jump at GO: one continuous walk north.
    for (let index = 1; index < ys.length; index++) expect(ys[index]).toBeGreaterThanOrEqual(ys[index - 1] ?? 0);
    expect((ys[atGo] ?? 0) - (ys[atGo - 1] ?? 0)).toBeLessThan(0.5);
  });

  /**
   * In-game report: Ctrl+R / Retry into wave 1 drew the landing on the tile the player had walked to,
   * then jumped once control returned. The run restarts on the landing tile without a tick, from a run
   * that may still be on tick 0 itself (its countdown) or already well into the fight.
   */
  it.each([
    { label: 'during the previous run’s countdown (tick 0 to tick 0)', fromTick: 0 },
    { label: 'mid-fight', fromTick: 40 },
  ])('restarts into a landing $label on the landing tile, and walks the next countdown from it without a jump', ({
    fromTick,
  }) => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    let nowMs = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const contexts: RenderContext[] = [];
    const build = vi.fn((context: RenderContext) => {
      contexts.push(context);
      return createQueue();
    });
    const projection = makeProjection3D();
    let preparation: StartPositionPreparation | null = null;
    const props = {
      onTileClick: vi.fn(),
      showCoordinates: false,
      renderer: makeRenderer(),
      sceneBuilder: { ...makeSceneBuilder(), build },
      projection3D: projection,
      getStartPositionPreparation: () => preparation,
    };
    const view = render(<RenderViewport3D {...props} simulationState={tickZero(LANDING)} />);
    const run = (untilMs: number) => {
      while (nowMs < untilMs) {
        nowMs = Math.min(nowMs + 16, untilMs);
        act(() => frame?.(nowMs));
      }
    };
    const shown = () => contexts.at(-1)?.playerVisual?.position;
    run(1600);

    // The previous run: walked north during its countdown, maybe fought on from there.
    const away: Coordinate = [31, 41];
    preparation = {
      boundary: {},
      sequence: 1,
      steppedAtMs: 1600,
      step: { from: LANDING, stepTiles: [[31, 39], away], to: away, isRunning: true },
    };
    view.rerender(<RenderViewport3D {...props} simulationState={tickZero(away)} />);
    run(3200);
    if (fromTick > 0) {
      preparation = null;
      view.rerender(<RenderViewport3D {...props} simulationState={{ ...tickZero(away), currentTick: fromTick }} />);
      run(3800);
    }
    expect(shown()).toEqual(away);

    // Restart: the new run lands on the landing tile, no tick, while its landing plays.
    preparation = null;
    view.rerender(<RenderViewport3D {...props} simulationState={{ ...tickZero(LANDING), introActive: true }} />);
    const landingFrom = nowMs;
    run(landingFrom + 16);
    expect(shown()).toEqual(LANDING);
    run(landingFrom + 3000);
    expect(shown()).toEqual(LANDING);
    expect(projection.getCameraState().targetY).toBeCloseTo(LANDING[1] + 0.5, 1);

    // Control: the next countdown walks from the landing tile, continuously, then GO.
    view.rerender(<RenderViewport3D {...props} simulationState={tickZero(LANDING)} />);
    run(landingFrom + 3100);
    const ys: number[] = [];
    const walk = (untilMs: number) => {
      while (nowMs < untilMs) {
        nowMs = Math.min(nowMs + 16, untilMs);
        act(() => frame?.(nowMs));
        ys.push(shown()?.[1] ?? Number.NaN);
      }
    };
    preparation = {
      boundary: {},
      sequence: 1,
      steppedAtMs: nowMs,
      step: {
        from: LANDING,
        stepTiles: [
          [31, 38],
          [31, 39],
        ],
        to: [31, 39],
        isRunning: true,
      },
    };
    view.rerender(<RenderViewport3D {...props} simulationState={tickZero([31, 39])} />);
    walk(nowMs + 600);
    preparation = null;
    view.rerender(<RenderViewport3D {...props} simulationState={{ ...tickZero([31, 39]), currentTick: 1 }} />);
    walk(nowMs + 600);
    expect(shown()).toEqual([31, 39]);
    expect(ys[0]).toBeLessThan(37.5);
    for (let index = 1; index < ys.length; index++) {
      expect(ys[index]).toBeGreaterThanOrEqual(ys[index - 1] ?? 0);
      expect((ys[index] ?? 0) - (ys[index - 1] ?? 0)).toBeLessThan(0.5);
    }
  });

  it('snaps a tick-zero placement without a walk (a typed start wave across the Zuk line), but never a countdown step', () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    let nowMs = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const contexts: RenderContext[] = [];
    const build = vi.fn((context: RenderContext) => {
      contexts.push(context);
      return createQueue();
    });
    let preparation: StartPositionPreparation | null = null;
    const props = {
      onTileClick: vi.fn(),
      showCoordinates: false,
      renderer: makeRenderer(),
      sceneBuilder: { ...makeSceneBuilder(), build },
      projection3D: makeProjection3D(),
      getStartPositionPreparation: () => preparation,
    };
    const view = render(<RenderViewport3D {...props} simulationState={tickZero(LANDING)} />);
    const step = () => {
      nowMs += 16;
      act(() => frame?.(nowMs));
      return contexts.at(-1)?.playerVisual?.position;
    };
    step();
    // The wiring publishes a countdown step's descriptor a frame before its state: no snap back.
    preparation = {
      boundary: {},
      sequence: 1,
      steppedAtMs: nowMs,
      step: { from: LANDING, stepTiles: [[31, 38]], to: [31, 38], isRunning: false },
    };
    const early = step();
    expect(early?.[1]).toBeGreaterThanOrEqual(37);
    expect(early?.[1]).toBeLessThanOrEqual(38);
    view.rerender(<RenderViewport3D {...props} simulationState={tickZero([31, 38])} />);
    const after = step();
    expect(after?.[1]).toBeGreaterThanOrEqual(early?.[1] ?? 0);
    expect(after?.[1]).toBeLessThan(38);

    // A placement with no walk: the Zuk start.
    view.rerender(<RenderViewport3D {...props} simulationState={tickZero([31, 44])} />);
    expect(step()).toEqual([31, 44]);
  });
});

describe('RenderViewport3D teleports and cutscenes', () => {
  const at = (currentTick: number, position: Coordinate, facing = 0): SimulationState => ({
    ...makeSimulationState(),
    currentTick,
    playerPosition: position,
    playerPreviousPosition: position,
    playerFacingAngle: facing,
  });

  function liveView(sceneBuilder: SceneBuilderLike, initial: SimulationState) {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    let nowMs = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const projection = makeProjection3D();
    const props = { onTileClick: vi.fn(), showCoordinates: false, renderer: makeRenderer(), sceneBuilder };
    const view = render(<RenderViewport3D {...props} projection3D={projection} simulationState={initial} />);
    const step = (ms: number) => {
      nowMs += ms;
      act(() => frame?.(nowMs));
    };
    const setState = (state: SimulationState) =>
      view.rerender(<RenderViewport3D {...props} projection3D={projection} simulationState={state} />);
    return { projection, step, setState };
  }

  it('draws a live teleport on its tick and cuts the follow camera to it', () => {
    const contexts: RenderContext[] = [];
    const build = vi.fn((context: RenderContext) => {
      contexts.push(context);
      return createQueue();
    });
    const view = liveView({ ...makeSceneBuilder(), build }, at(26, [22, 22], 256));
    view.step(16);
    view.step(600);
    expect(contexts.at(-1)?.playerVisual?.position).toEqual([22, 22]);

    // Wave 69's intro: placed on [31, 44] facing north, with no route (previous position is the new tile).
    view.setState(at(27, [31, 44], 1024));
    view.step(16);
    expect(contexts.at(-1)?.playerVisual?.position).toEqual([31, 44]);
    expect(contexts.at(-1)?.playerVisual?.facingAngle).toBe(1024);
    expect(view.projection.getCameraState()).toMatchObject({ targetX: 31.5, targetY: 44.5 });
  });

  it.each([
    { label: 'on the tile it is heading for, finishes the step', restart: [22, 24] as Coordinate, finishes: true },
    { label: 'anywhere else, snaps there', restart: [30, 32] as Coordinate, finishes: false },
  ])('on a restart mid-step, $label', ({ restart, finishes }) => {
    const contexts: RenderContext[] = [];
    const build = vi.fn((context: RenderContext) => {
      contexts.push(context);
      return createQueue();
    });
    const view = liveView({ ...makeSceneBuilder(), build }, at(19, [22, 22], 1024));
    view.step(16);
    // Running two tiles north this tick; the restart lands partway through the step.
    view.setState({
      ...at(20, [22, 24], 1024),
      playerPreviousPosition: [22, 22],
      playerMovementPath: [
        [22, 23],
        [22, 24],
      ],
      playerIsMoving: true,
      playerIsRunning: true,
    });
    view.step(16);
    view.step(150);
    const midway = contexts.at(-1)?.playerVisual?.position[1] ?? 0;
    expect(midway).toBeGreaterThan(22);
    expect(midway).toBeLessThan(24);

    view.setState(at(0, restart, 1024));
    view.step(16);
    const after = contexts.at(-1)?.playerVisual;
    if (finishes) {
      expect(after?.position[0]).toBe(22);
      expect(after?.position[1]).toBeGreaterThan(midway);
      expect(after?.position[1]).toBeLessThan(24);
      expect(after?.isVisuallyMoving).toBe(true);
      expect(view.projection.getCameraState().targetY).toBeLessThan(24.5);
      // Frames are capped at 50 ms of movement each.
      for (let frame = 0; frame < 40; frame++) view.step(16);
      expect(contexts.at(-1)?.playerVisual).toMatchObject({ position: [22, 24], isVisuallyMoving: false });
    } else {
      expect(after?.position).toEqual(restart);
      expect(view.projection.getCameraState()).toMatchObject({ targetX: restart[0] + 0.5, targetY: restart[1] + 0.5 });
    }
  });

  it('holds a cutscene view and fade over the scene, then releases the player camera untouched', () => {
    const pose = { eye: { x: 35.5, y: 35.5, z: 8 }, lookAt: { x: 28.5, y: 56.5, z: 1 } };
    let cutscene: SceneCutsceneFrame | null = { fadeOpacity: 0.25, camera: pose };
    const getCutsceneFrame = vi.fn(() => cutscene);
    // A frame carrying the scene's DOM overlays, for the fade's stacking.
    const build = (): RenderQueue => ({
      ...createQueue(),
      overheadTexts: [{ screenX: 400, screenY: 280, text: 'Hi', textColor: '#ff0', fontSize: 12, key: 'text' }],
      hitsplats: [
        {
          screenX: 400,
          screenY: 300,
          amount: 27,
          type: 'damage',
          key: 'splat',
          progress: 0.2,
          width: 24,
          height: 22,
          fontSize: 11,
        },
      ],
      healthBars: [{ screenX: 400, screenY: 298, ratio: 0.6, width: 40, height: 5, key: 'hp', progress: 0.2 }],
      timerBars: [{ screenX: 400, screenY: 292, ratio: 0.5, width: 40, height: 5, key: 'timer' }],
    });
    const view = liveView({ ...makeSceneBuilder(), build, getCutsceneFrame }, at(30, [31, 44]));
    const before = view.projection.getCameraState();
    view.step(16);
    expect(getCutsceneFrame).toHaveBeenLastCalledWith(expect.objectContaining({ currentTick: 30 }), expect.any(Number));
    expect(view.projection.getScriptedCamera()).toEqual(pose);
    const fade = document.querySelector<HTMLElement>('[data-cutscene-fade]');
    expect(fade?.style.opacity).toBe('0.25');
    // The fade blacks out the scene's DOM overlays too, not just the canvas under them.
    const fadeZ = Number(fade?.style.zIndex);
    const { cutsceneFade, ...sceneLayers } = OVERLAY_LAYER_Z_INDEX;
    expect(fadeZ).toBe(cutsceneFade);
    for (const z of Object.values(sceneLayers)) expect(fadeZ).toBeGreaterThan(z);
    const layered = [...getViewportContainer().querySelectorAll<HTMLElement>('[style*="z-index"]')].filter(
      (element) => element !== fade,
    );
    expect(layered.length).toBeGreaterThanOrEqual(4);
    for (const layer of layered) expect(Number(layer.style.zIndex)).toBeLessThan(fadeZ);
    // The player cannot turn or zoom the held view.
    fireEvent.wheel(getViewportContainer(), { deltaY: -100 });
    expect(view.projection.getCameraState().fovScale).toBe(before.fovScale);

    cutscene = null;
    view.step(16);
    expect(view.projection.getScriptedCamera()).toBeNull();
    expect(fade?.style.opacity).toBe('0');
    expect(view.projection.getCameraState()).toMatchObject({
      yaw: before.yaw,
      pitch: before.pitch,
      fovScale: before.fovScale,
    });
  });
});
