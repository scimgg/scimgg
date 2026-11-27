// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplayFrameProvider } from '../../../contexts/ReplayFrameContext';
import { TickProgressProvider } from '../../../contexts/TickProgressContext';
import { getArenaAllowUnboundedFallback, getArenaConfig, setArenaConfig } from '../../../core/constants';
import { ReplayFrameStore } from '../../../core/replayFrameStore';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { TickProgressStore } from '../../../core/tickProgressStore';
import { LobbyEncounter } from '../../../encounters/lobby/LobbyEncounter';
import { REPLAY_CLICK_OWNER_ATTRIBUTE, REPLAY_CLICK_OWNERS } from '../../../input/replayClickFeedback';
import { yamaSnapshot } from '../../../test/helpers/encounterSnapshot';
import { setWatchInputGated } from '../../../tutorial/runtime/tutorialInputBoundary';
import { createEmptyCombatSupplies } from '../../../types/encounterLoadout';
import { createEmptyStats as createEmptyEquipmentStats } from '../../../types/equipmentStats';
import { createEmptyInventory } from '../../../types/inventory';
import {
  createDefaultRunEnergy,
  createDefaultSpecialAttack,
  createDefaultStats,
  createDefaultTimers,
} from '../../../types/playerState';
import type { RestoredPresentation } from '../../../types/restoredPresentation';
import type { Coordinate, SimulationState } from '../../../types/simulation';
import type { StartPositionPreparation } from '../../../types/startPositionPreparation';
import { animationFrames } from '../../../util/animationFrames';
import { IMAGE_CROSS_ORIGIN } from '../../../util/imageCache';
import {
  createQueue,
  type HealthBarOverlay,
  type HitsplatOverlay,
  OVERLAY_LAYER_Z_INDEX,
  type RenderQueue,
  type TimerBarOverlay,
} from '../../core/commands';
import { fpsReporter } from '../../core/fpsReporter';
import { createNullAssetManager, type Renderer } from '../../core/renderer';
import type { PlayerOverheadNumbers } from '../../overlay/UIOverlayRenderer';
import type { RenderContext, SceneBuilderLike } from '../../scene/types';
import { RenderViewport } from '../RenderViewport';
import { RenderViewport3D } from '../RenderViewport3D';

const restoredContext = vi.hoisted(() => ({
  current: undefined as RestoredPresentation | undefined,
}));
vi.mock('../../../contexts/SimulationContext', () => ({
  useSimulationContext: () => ({
    restoredPresentation: restoredContext.current,
  }),
}));
const initialArena = getArenaConfig();
const initialUnbounded = getArenaAllowUnboundedFallback();

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
    offensivePrayer: null,
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
    pendingOffensivePrayer: [false, null],
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
  restoredContext.current = undefined;
  setArenaConfig(initialArena, initialUnbounded);
  cleanup();
  animationFrames.setSuspended(false);
  animationFrames.clock.reset();
  setWatchInputGated(false);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('restored presentation in both viewport clocks', () => {
  it.each([
    '2d',
    '3d',
  ] as const)('%s uses completed presentation only for takeover preflight, not ordinary drag previews', (mode) => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const state: SimulationState = {
      ...makeSimulationState(),
      playerPreviousPosition: [10, 10],
      playerPosition: [11, 10],
      playerMovementPath: [[11, 10]],
    };
    const events = [{ type: 'actor_died', eventId: 1, tick: 10, actorId: 'selected' }];
    const futureEvents = [{ type: 'actor_died', eventId: 2, tick: 11, actorId: 'future' }];
    const frames = [
      { state, events },
      { state: { ...state, currentTick: 11 }, events: futureEvents },
    ];
    const store = new ReplayFrameStore();
    store.setHistory(frames);
    store.set(0, undefined);
    const builder = makeSceneBuilder();
    const build = vi.spyOn(builder, 'build');
    const renderer = makeRenderer();
    const Viewport = mode === '2d' ? RenderViewport : RenderViewport3D;
    const tree = () => (
      <ReplayFrameProvider store={store}>
        <Viewport
          simulationState={state}
          eventOverrides={events}
          onTileClick={vi.fn()}
          showCoordinates={false}
          renderer={renderer}
          sceneBuilder={builder}
          replayIsReplaying
          replayPaused
        />
      </ReplayFrameProvider>
    );
    render(tree());
    const draw = () => {
      act(() => frame?.(1000));
      return build.mock.calls.at(-1)?.[0];
    };
    expect(draw()).toMatchObject({ interpolatedTick: 10, timeline: { timeMs: 6000 } });
    for (const preview of [false, true]) {
      if (preview) act(() => store.setPreview({ state, events, frameIndex: 0 }));
      expect(draw()?.interpolatedTick).toBe(10);
      act(() => store.setPreview({ state, events, frameIndex: 0, completedBoundary: true }));
      expect(draw()).toMatchObject({
        simulationState: { currentTick: 10 },
        interpolatedTick: 11,
        events,
        replayHistory: { throughFrameIndex: 0 },
        timeline: { paused: true, timeMs: 6600 },
      });
      expect(draw()?.events).not.toEqual(futureEvents);
      act(() => store.setPreview(undefined));
    }
    expect(draw()).toMatchObject({
      simulationState: { currentTick: 10 },
      interpolatedTick: 10,
      timeline: { paused: true, timeMs: 6000 },
    });
    expect(store.getSnapshot().history).toBe(frames);
  });

  it.each([
    ['2d', false],
    ['3d', false],
    ['2d', true],
    ['3d', true],
  ] as const)('%s holds the endpoint across same-tick engine replacement; first render after GO=%s', (mode, afterGo) => {
    let now = 0;
    let frame: FrameRequestCallback | undefined;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    animationFrames.clock.reset();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const oldEngine = new SimulationEngine({ encounter: new LobbyEncounter() });
    const adopted = new SimulationEngine({ encounter: new LobbyEncounter() });
    const state: SimulationState = {
      ...makeSimulationState(),
      playerPreviousPosition: [10, 10],
      playerPosition: [11, 10],
      playerMovementPath: [[11, 10]],
    };
    const next: SimulationState = {
      ...state,
      currentTick: 11,
      playerPreviousPosition: [11, 10],
      playerPosition: [12, 10],
      playerMovementPath: [[12, 10]],
    };
    const frames = [
      { state, events: [] },
      { state: next, events: [] },
    ];
    const builder = makeSceneBuilder();
    const build = vi.spyOn(builder, 'build');
    const renderer = makeRenderer();
    const Viewport = mode === '2d' ? RenderViewport : RenderViewport3D;
    const props = { onTileClick: vi.fn(), showCoordinates: false, renderer, sceneBuilder: builder };
    const view = render(
      <Viewport {...props} simulationState={state} engine={oldEngine} replayTimelineKey="old-engine" />,
    );
    const draw = (at: number) => {
      now = at;
      act(() => frame?.(at));
      return build.mock.calls.at(-1)?.[0];
    };
    expect(draw(300)?.interpolatedTick).toBe(10.5);
    restoredContext.current = { engine: adopted, tick: 10, timeMs: 6600, history: { frames, throughFrameIndex: 0 } };
    view.rerender(
      <Viewport
        {...props}
        simulationState={afterGo ? next : state}
        engine={adopted}
        replayTimelineKey="adopted-engine"
      />,
    );
    if (!afterGo) {
      for (const at of [300, 2000, 5000]) {
        expect(draw(at)).toMatchObject({
          interpolatedTick: 11,
          frameDeltaMs: 0,
          timeline: { paused: true, timeMs: 6600 },
        });
      }
      now = 6000;
      view.rerender(<Viewport {...props} simulationState={next} engine={adopted} replayTimelineKey="adopted-engine" />);
      expect(draw(6000)).toMatchObject({
        interpolatedTick: 11,
        frameDeltaMs: 0,
        timeline: { paused: false, timeMs: 6600 },
      });
      expect(draw(6150)?.interpolatedTick).toBe(11.25);
    } else {
      expect(draw(450)).toMatchObject({
        interpolatedTick: 11.25,
        frameDeltaMs: 0,
        timeline: { paused: false, timeMs: 6750 },
      });
      expect(draw(600)?.interpolatedTick).toBe(11.5);
    }
    expect(build.mock.calls.at(-1)?.[0].restoredPresentation).toBe(restoredContext.current);
  });
});

describe.each([
  { name: '2D', ViewportComponent: RenderViewport },
  { name: '3D', ViewportComponent: RenderViewport3D },
])('$name background suspension', ({ ViewportComponent }) => {
  const nativeFrames = new Map<number, FrameRequestCallback>();
  let nextId = 0;

  beforeEach(() => {
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const id = ++nextId;
        nativeFrames.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => nativeFrames.delete(id)),
    );
  });

  afterEach(() => {
    cleanup();
    animationFrames.setSuspended(false);
    expect(nativeFrames.size).toBe(0);
    nativeFrames.clear();
  });

  function frameAt(time: number): void {
    vi.mocked(performance.now).mockReturnValue(time);
    act(() => {
      for (const [id, callback] of [...nativeFrames]) {
        if (nativeFrames.delete(id)) callback(time);
      }
    });
  }

  it('stops scene builds and GPU submissions, then resumes without advancing suspended time', () => {
    const renderer = createRenderer();
    const build = vi.fn((_context: RenderContext) => createQueue());
    const report = vi.spyOn(fpsReporter, 'report');
    const view = render(
      <ViewportComponent
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={renderer}
        sceneBuilder={createSceneBuilder(build)}
        fpsCap={30}
      />,
    );
    frameAt(1100);
    const before = build.mock.lastCall?.[0];
    const queued = [...nativeFrames.values()][0];
    const requestsBefore = vi.mocked(requestAnimationFrame).mock.calls.length;

    animationFrames.setSuspended(true);
    frameAt(60_000);
    act(() => queued?.(60_000));

    expect(nativeFrames.size).toBe(0);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(requestsBefore);
    expect(build).toHaveBeenCalledOnce();
    expect(renderer.render).toHaveBeenCalledOnce();

    animationFrames.setSuspended(false);
    frameAt(60_016);
    expect(build).toHaveBeenCalledTimes(2);
    expect(renderer.render).toHaveBeenCalledTimes(2);
    expect(build.mock.lastCall?.[0].interpolatedTick).toBeCloseTo((before?.interpolatedTick ?? 0) + 16 / 600);
    if (ViewportComponent === RenderViewport3D) {
      expect(build.mock.lastCall?.[0].frameDeltaMs).toBe(16);
      expect(build.mock.lastCall?.[0].playerVisual).toEqual(before?.playerVisual);
    }
    expect(report).not.toHaveBeenCalled();
    expect(renderer.init).toHaveBeenCalledOnce();
    expect(renderer.dispose).not.toHaveBeenCalled();
    frameAt(60_032);
    expect(renderer.render).toHaveBeenCalledTimes(2);
    frameAt(60_050);
    expect(renderer.render).toHaveBeenCalledTimes(3);
    view.unmount();
  });

  it.each([
    0.5, 1, 2,
  ])('preserves the live tick phase when suspension begins between draws at %sx', (speedMultiplier) => {
    const build = vi.fn((_context: RenderContext) => createQueue());
    render(
      <ViewportComponent
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={createRenderer()}
        sceneBuilder={createSceneBuilder(build)}
        speedMultiplier={speedMultiplier}
      />,
    );
    frameAt(1000 + 400 / speedMultiplier);
    vi.mocked(performance.now).mockReturnValue(1000 + 450 / speedMultiplier);
    animationFrames.setSuspended(true);
    frameAt(61_000 + 450 / speedMultiplier);
    animationFrames.setSuspended(false);
    frameAt(61_000 + 500 / speedMultiplier);
    expect(build.mock.lastCall?.[0].interpolatedTick).toBeCloseTo(10 + 500 / 600);
    frameAt(61_000 + 599 / speedMultiplier);
    expect(build.mock.lastCall?.[0].interpolatedTick).toBeCloseTo(10 + 599 / 600);
  });

  it.each([false, true])('leaves no native callbacks when unmounted (suspended: %s)', (suspended) => {
    const renderer = createRenderer();
    const build = vi.fn((_context: RenderContext) => createQueue());
    const view = render(
      <ViewportComponent
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={renderer}
        sceneBuilder={createSceneBuilder(build)}
      />,
    );
    const queued = [...nativeFrames.values()][0];
    animationFrames.setSuspended(suspended);

    view.unmount();
    animationFrames.setSuspended(false);
    act(() => queued?.(60_000));

    expect(nativeFrames.size).toBe(0);
    expect(build).not.toHaveBeenCalled();
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('retains the resume timing reset when resized before the next frame', () => {
    const renderer = createRenderer();
    const build = vi.fn((_context: RenderContext) => createQueue());
    const sceneBuilder = createSceneBuilder(build);
    const state = makeSimulationState();
    const tree = (width: number) => (
      <ViewportComponent
        simulationState={state}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={renderer}
        sceneBuilder={sceneBuilder}
        width={width}
      />
    );
    const view = render(tree(800));
    frameAt(1100);
    const before = build.mock.lastCall?.[0].interpolatedTick;
    animationFrames.setSuspended(true);
    frameAt(60_000);

    animationFrames.setSuspended(false);
    view.rerender(tree(900));
    frameAt(60_016);

    expect(build.mock.lastCall?.[0].interpolatedTick).toBeCloseTo((before ?? 0) + 16 / 600);
    if (ViewportComponent === RenderViewport3D) expect(build.mock.lastCall?.[0].frameDeltaMs).toBe(16);
  });

  it('defers the initial scene build when mounted while suspended', () => {
    animationFrames.setSuspended(true);
    const renderer = createRenderer();
    const build = vi.fn((_context: RenderContext) => createQueue());

    render(
      <ViewportComponent
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={renderer}
        sceneBuilder={createSceneBuilder(build)}
      />,
    );
    frameAt(60_000);

    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(renderer.render).not.toHaveBeenCalled();
    animationFrames.setSuspended(false);
    frameAt(60_016);
    expect(renderer.render).toHaveBeenCalledOnce();
    expect(build.mock.lastCall?.[0].interpolatedTick).toBeCloseTo(10 + 16 / 600);
  });

  it('keeps drawing camera updates while replay is manually paused', () => {
    const renderer = createRenderer();
    const build = vi.fn((_context: RenderContext) => createQueue());
    const view = render(
      <ViewportComponent
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={renderer}
        sceneBuilder={createSceneBuilder(build)}
        replayPaused
      />,
    );
    frameAt(1100);
    const canvas = view.container.querySelector('canvas');
    if (!canvas) throw new Error('Viewport canvas missing');

    fireEvent.wheel(canvas.parentElement ?? canvas, { deltaY: -100 });
    frameAt(1200);

    expect(renderer.render).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenCalledTimes(2);
    expect(build.mock.lastCall?.[0].replayPaused).toBe(true);
  });
});

describe('RenderViewport displayed tick clock', () => {
  const advanceFrame = installFrameQueue();

  it.each([false, true])('interpolates tutorial event overrides outside replay (retained history: %s)', (retained) => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const store = new ReplayFrameStore();
    const state: SimulationState = {
      ...makeSimulationState(),
      playerPreviousPosition: [31, 37],
      playerPosition: [32, 37],
      playerMovementPath: [[32, 37]],
    };
    if (retained) {
      const preview = { frameIndex: 0, state: { ...state, currentTick: 70 }, events: [] };
      store.setHistory([preview]);
      store.setPreview(preview);
    }
    const events = [
      { type: 'prayer_depleted', eventId: 1, tick: 10, actorId: 'player' },
    ] satisfies RenderContext['events'];
    const build = vi.fn((_context: RenderContext) => createQueue());
    render(
      <ReplayFrameProvider store={store}>
        <RenderViewport
          simulationState={state}
          eventOverrides={events}
          onTileClick={vi.fn()}
          showCoordinates={false}
          renderer={makeRenderer()}
          sceneBuilder={{ ...makeSceneBuilder(), build }}
        />
      </ReplayFrameProvider>,
    );

    for (const time of [1000, 1300, 1600]) {
      now.mockReturnValue(time);
      advanceFrame();
    }

    expect(build.mock.calls.map(([context]) => context.interpolatedTick)).toEqual([10, 10.5, 11]);
    for (const [context] of build.mock.calls) {
      expect(context.simulationState).toBe(state);
      expect(context.events).toBe(events);
      expect(context.replayHistory).toBeUndefined();
      expect(context.playerVisual).toBeUndefined();
      expect(context.replayPaused).toBe(false);
    }
  });

  it.each([
    { mode: 'live', replaying: false, paused: false, previewing: false, firstTick: 10.5, laterTick: 11 },
    { mode: 'replay', replaying: true, paused: false, previewing: false, firstTick: 71.25, laterTick: 71.25 },
    { mode: 'paused replay', replaying: true, paused: true, previewing: false, firstTick: 71.25, laterTick: 71.25 },
    { mode: 'seek preview', replaying: true, paused: false, previewing: true, firstTick: 71.25, laterTick: 70 },
  ])('publishes the scene tick on the current frame in $mode', ({
    replaying,
    paused,
    previewing,
    firstTick,
    laterTick,
  }) => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const replayStore = new ReplayFrameStore();
    const tickStore = new TickProgressStore();
    const origin = { state: { ...makeSimulationState(), currentTick: 70 }, events: [] };
    replayStore.setHistory([origin, { state: { ...makeSimulationState(), currentTick: 71 }, events: [] }]);
    replayStore.set(750, undefined);
    const sceneTicks: number[] = [];
    const publishedTicks: number[] = [];
    const build = vi.fn((context: RenderContext) => {
      sceneTicks.push(context.interpolatedTick);
      publishedTicks.push(tickStore.getSnapshot());
      return createQueue();
    });
    render(
      <TickProgressProvider store={tickStore}>
        <ReplayFrameProvider store={replayStore}>
          <RenderViewport
            simulationState={makeSimulationState()}
            eventOverrides={replaying ? [] : undefined}
            replayPaused={paused}
            replayIsReplaying={replaying}
            onTileClick={vi.fn()}
            showCoordinates={false}
            renderer={makeRenderer()}
            sceneBuilder={{ ...makeSceneBuilder(), build }}
          />
        </ReplayFrameProvider>
      </TickProgressProvider>,
    );

    now.mockReturnValue(1300);
    advanceFrame();
    if (previewing) replayStore.setPreview({ ...origin, frameIndex: 0 });
    now.mockReturnValue(5000);
    advanceFrame();
    now.mockReturnValue(9000);
    advanceFrame();

    expect(sceneTicks).toEqual([firstTick, laterTick, laterTick]);
    expect(publishedTicks).toEqual([firstTick, laterTick, laterTick]);
    expect(tickStore.getSnapshot()).toBe(laterTick);
  });

  it.each([
    16, 50,
  ])('animates countdown positioning at tick 0 and hands over to tick 1 without a snap at %i ms frames', (frameMs) => {
    let nowMs = 1600;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const contexts: RenderContext[] = [];
    const build = vi.fn((context: RenderContext) => {
      contexts.push(context);
      return createQueue();
    });
    const landing: Coordinate = [31, 37];
    const stepped: SimulationState = {
      ...makeSimulationState(),
      currentTick: 0,
      playerPreviousPosition: landing,
      playerPosition: [31, 39],
      playerMovementPath: [
        [31, 38],
        [31, 39],
      ],
    };
    let preparation: StartPositionPreparation | null = {
      boundary: {},
      sequence: 1,
      steppedAtMs: 1600,
      step: { from: landing, stepTiles: stepped.playerMovementPath, to: [31, 39], isRunning: true },
    };
    const props = {
      onTileClick: vi.fn(),
      showCoordinates: false,
      renderer: makeRenderer(),
      sceneBuilder: { ...makeSceneBuilder(), build },
      getStartPositionPreparation: () => preparation,
    };
    const view = render(<RenderViewport {...props} simulationState={stepped} />);
    const ys: number[] = [];
    const run = (untilMs: number) => {
      while (nowMs < untilMs) {
        nowMs = Math.min(nowMs + frameMs, untilMs);
        advanceFrame();
        const context = contexts.at(-1);
        if (context?.playerVisual) ys.push(context.playerVisual.position[1]);
        // The fight's clock does not run during the countdown.
        expect(context?.simulationState.currentTick).toBe(0);
      }
    };
    run(1900);
    // Halfway through the step's interval, halfway along its two tiles.
    expect(contexts.at(-1)?.playerVisual?.position).toEqual([31, 38]);
    expect(contexts.at(-1)?.playerVisual?.isRunning).toBe(true);
    run(2800);
    expect(contexts.at(-1)?.playerVisual).toMatchObject({
      position: [31, 39],
      isVisuallyMoving: false,
      facingAngle: 1024,
    });
    for (let index = 1; index < ys.length; index++) expect(ys[index]).toBeGreaterThanOrEqual(ys[index - 1] ?? 0);

    // GO: the descriptor is gone and tick 1 interpolates from the committed start onward.
    preparation = null;
    view.rerender(
      <RenderViewport
        {...props}
        simulationState={{
          ...stepped,
          currentTick: 1,
          playerPreviousPosition: [31, 39],
          playerPosition: [31, 41],
          playerMovementPath: [
            [31, 40],
            [31, 41],
          ],
        }}
      />,
    );
    nowMs += frameMs;
    advanceFrame();
    const handover = contexts.at(-1);
    expect(handover?.playerVisual).toBeUndefined();
    expect(handover?.simulationState.currentTick).toBe(1);
    // Tick 1 starts its interval at GO, from where the countdown left the player.
    expect(handover?.interpolatedTick).toBeLessThan(1.1);
  });
});

describe('RenderViewport mouse input', () => {
  it.each([false, true])('acknowledges 2D scene processing only in the captured epoch (reset: %s)', (reset) => {
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
        <RenderViewport
          simulationState={makeSimulationState()}
          eventOverrides={[]}
          replayIsReplaying
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
        <RenderViewport
          simulationState={makeSimulationState()}
          eventOverrides={[]}
          replayIsReplaying
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

  it('uses the store clock and preview in 2D without changing pose on pause or speed change', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const store = new ReplayFrameStore();
    const state: SimulationState = {
      ...makeSimulationState(),
      currentTick: 70,
      playerPreviousPosition: [31, 37],
      playerPosition: [32, 37],
      playerMovementPath: [[32, 37]],
      playerFacingAngle: 1536,
    };
    const frames = [{ state, events: [] }];
    store.setHistory(frames);
    store.set(300, undefined);
    const build = vi.fn((_context: RenderContext) => createQueue());
    const sceneBuilder = { ...makeSceneBuilder(), build };
    const renderer = makeRenderer();
    const tree = (paused: boolean, speed: number) => (
      <ReplayFrameProvider store={store}>
        <RenderViewport
          simulationState={makeSimulationState()}
          eventOverrides={[]}
          replayIsReplaying
          onTileClick={vi.fn()}
          showCoordinates={false}
          renderer={renderer}
          sceneBuilder={sceneBuilder}
          replayPaused={paused}
          speedMultiplier={speed}
        />
      </ReplayFrameProvider>
    );
    const view = render(tree(false, 1));
    act(() => frame?.(1000));
    const before = build.mock.lastCall?.[0];

    view.rerender(tree(true, 4));
    vi.mocked(performance.now).mockReturnValue(5000);
    act(() => frame?.(5000));
    const after = build.mock.lastCall?.[0];

    expect(before?.interpolatedTick).toBe(70.5);
    expect(before?.playerVisual?.position).toEqual([31.5, 37]);
    expect(after?.interpolatedTick).toBe(before?.interpolatedTick);
    expect(after?.playerVisual).toEqual(before?.playerVisual);
    expect(after?.replayHistory).toEqual({ frames, throughFrameIndex: 0 });
  });

  it('treats a 2D preview as paused even while the committed pause prop is false', () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const store = new ReplayFrameStore();
    const preview = { frameIndex: 0, state: { ...makeSimulationState(), currentTick: 45 }, events: [] };
    store.setHistory([preview]);
    const build = vi.fn((_context: RenderContext) => createQueue());
    render(
      <ReplayFrameProvider store={store}>
        <RenderViewport
          simulationState={makeSimulationState()}
          eventOverrides={[]}
          replayIsReplaying
          onTileClick={vi.fn()}
          showCoordinates={false}
          renderer={makeRenderer()}
          sceneBuilder={{ ...makeSceneBuilder(), build }}
        />
      </ReplayFrameProvider>,
    );

    act(() => store.setPreview(preview));
    act(() => frame?.(1000));

    const context = build.mock.lastCall?.[0];
    expect(context?.simulationState).toBe(preview.state);
    expect(context?.events).toBe(preview.events);
    expect(context?.timeline?.paused).toBe(true);
    expect(context?.interpolatedTick).toBe(45);
  });

  it('ignores retained replay history and preview when displaying live events', () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const store = new ReplayFrameStore();
    const state = makeSimulationState();
    const preview = { frameIndex: 0, state: { ...state, currentTick: 45 }, events: [] };
    store.setHistory([preview]);
    store.setPreview(preview);
    const build = vi.fn((_context: RenderContext) => createQueue());
    render(
      <ReplayFrameProvider store={store}>
        <RenderViewport
          simulationState={state}
          onTileClick={vi.fn()}
          showCoordinates={false}
          renderer={makeRenderer()}
          sceneBuilder={{ ...makeSceneBuilder(), build }}
        />
      </ReplayFrameProvider>,
    );

    act(() => frame?.(1000));

    const context = build.mock.lastCall?.[0];
    expect(context?.simulationState).toBe(state);
    expect(context?.replayHistory).toBeUndefined();
    expect(context?.playerVisual).toBeUndefined();
    expect(context?.timeline?.paused).toBe(false);
  });

  it('marks the 2D canvas as world-owned replay click feedback', () => {
    // Given
    render(
      <RenderViewport
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
      />,
    );

    // When
    const canvas = screen.getByLabelText('Game Grid');

    // Then
    expect(canvas).toHaveAttribute(REPLAY_CLICK_OWNER_ATTRIBUTE, REPLAY_CLICK_OWNERS.world);
  });

  it('continues 2D camera rotation from window mouse movement during middle-drag', () => {
    const onCameraChange = vi.fn();
    render(
      <RenderViewport
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        onCameraChange={onCameraChange}
      />,
    );
    const canvas = screen.getByLabelText('Game Grid');
    stubCanvasRect(canvas);

    fireEvent.mouseDown(canvas, { button: 1, buttons: 4, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { buttons: 4, clientX: 190, clientY: 100 });

    expect(onCameraChange).toHaveBeenCalledWith({ rotation: 270, zoom: 1 });
  });

  it('records tile click replay cursor markers with the left click type', () => {
    const onReplayCursorClick = vi.fn();
    render(
      <RenderViewport
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        leftClickType="red"
        onReplayCursorClick={onReplayCursorClick}
      />,
    );
    const canvas = screen.getByLabelText('Game Grid');
    stubCanvasRect(canvas);

    fireEvent(canvas, mouseDownEvent({ button: 0, buttons: 1, clientX: 400, clientY: 300 }, 3456));

    expect(onReplayCursorClick).toHaveBeenCalledWith(400, 300, 'red', 3456);
  });

  it('records tile click replay cursor markers before the tile callback', () => {
    const callOrder: string[] = [];
    const onReplayCursorClick = vi.fn(() => callOrder.push('cursor'));
    const onTileClick = vi.fn(() => callOrder.push('tile'));
    render(
      <RenderViewport
        simulationState={makeSimulationState()}
        onTileClick={onTileClick}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        onReplayCursorClick={onReplayCursorClick}
      />,
    );
    const canvas = screen.getByLabelText('Game Grid');
    stubCanvasRect(canvas);

    fireEvent(canvas, mouseDownEvent({ button: 0, buttons: 1, clientX: 400, clientY: 300 }, 3456));

    expect(onReplayCursorClick).toHaveBeenCalledWith(400, 300, 'yellow', 3456);
    expect(onTileClick).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['cursor', 'tile']);
  });

  it('blocks physical tile clicks while watch input is gated', () => {
    const onReplayCursorClick = vi.fn();
    const onTileClick = vi.fn();
    render(
      <RenderViewport
        simulationState={makeSimulationState()}
        onTileClick={onTileClick}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        onReplayCursorClick={onReplayCursorClick}
      />,
    );
    const canvas = screen.getByLabelText('Game Grid');
    stubCanvasRect(canvas);
    setWatchInputGated(true);

    fireEvent(canvas, mouseDownEvent({ button: 0, buttons: 1, clientX: 400, clientY: 300 }, 3456));

    expect(onReplayCursorClick).not.toHaveBeenCalled();
    expect(onTileClick).not.toHaveBeenCalled();
  });

  it('picks tiles across the supplied arena extent, the square north of the origin included', () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    const onTileClick = vi.fn();
    // A 1x2 arena: the origin square and the one north of it, as `arenaTileExtent` resolves it.
    render(
      <RenderViewport
        simulationState={makeSimulationState()}
        onTileClick={onTileClick}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        tileExtent={{ width: 64, height: 128 }}
      />,
    );
    const canvas = screen.getByLabelText('Game Grid');
    stubCanvasRect(canvas);
    act(() => frame?.(1000));

    // The camera centers the player (31, 37) in the 800x600 canvas: 32 px tiles, north up over 128 rows.
    const tileCenter = (x: number, y: number) => ({ x: (x + 0.5) * 32, y: (127 - y + 0.5) * 32 });
    const player = tileCenter(31, 37);
    const offset = { x: Math.round(player.x - 400), y: Math.round(player.y - 300) };
    const click = (x: number, y: number) => {
      const center = tileCenter(x, y);
      fireEvent.mouseDown(canvas, {
        button: 0,
        buttons: 1,
        clientX: center.x - offset.x,
        clientY: center.y - offset.y,
      });
    };
    click(28, 63);
    click(28, 64);
    click(28, 127);
    // One row past the north square's top is outside the arena.
    click(28, 128);

    expect(onTileClick.mock.calls.map(([tile]) => tile)).toEqual([
      [28, 63],
      [28, 64],
      [28, 127],
    ]);
  });

  it('does not record replay cursor markers for middle or right buttons', () => {
    const onReplayCursorClick = vi.fn();
    render(
      <RenderViewport
        simulationState={makeSimulationState()}
        onTileClick={vi.fn()}
        showCoordinates={false}
        renderer={makeRenderer()}
        sceneBuilder={makeSceneBuilder()}
        onReplayCursorClick={onReplayCursorClick}
      />,
    );
    const canvas = screen.getByLabelText('Game Grid');
    stubCanvasRect(canvas);

    fireEvent.mouseDown(canvas, { button: 1, buttons: 4, clientX: 400, clientY: 300 });
    fireEvent.mouseDown(canvas, { button: 2, buttons: 2, clientX: 400, clientY: 300 });

    expect(onReplayCursorClick).not.toHaveBeenCalled();
  });
});

function createRenderer(): Renderer {
  return {
    id: 'fake-renderer',
    assets: createNullAssetManager(),
    supports: () => true,
    init: vi.fn(),
    resize: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
  };
}

function createSceneBuilder(getQueue: (context: RenderContext) => RenderQueue): SceneBuilderLike {
  return {
    build: getQueue,
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

function createState(): SimulationState {
  return {
    currentTick: 5,
    groundItems: [],
    playerPosition: [32, 30],
    playerPreviousPosition: [32, 30],
    playerMovementPath: [],
    playerFacingAngle: 0,
    playerIsMoving: false,
    playerIsRunning: false,
    primaryNpcPosition: [34, 32],
    primaryNpcPreviousPosition: [34, 32],
    primaryNpcFacingAngle: 0,
    primaryNpcSize: 5,
    npcs: [],
    encounter: yamaSnapshot({ state: { firstRangeMageType: 'magic' } }),
    encounterOutcome: { phase: 'active' },
    playerHistory: new Map([[5, [32, 30] as Coordinate]]),
    primaryNpcHistory: new Map([[5, [34, 32] as Coordinate]]),
    failedCondition: null,
    isAlive: true,
    markOfDarknessActive: false,
    markOfDarknessTicksRemaining: 0,
    playerHP: 99,
    maxHP: 99,
    poisonVarp: 0,
    poisonTickCounter: 30,
    activePrayer: null,
    offensivePrayer: null,
    independentPrayers: [],
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
    pendingOffensivePrayer: [false, null],
    pendingIndependentPrayers: [false, []],
    quickPrayersActive: false,
    runEnergy: createDefaultRunEnergy(),
    equipmentStats: createEmptyEquipmentStats(),
    prayerState: { points: 99, maxPoints: 99, drainCounter: 0, activePrayers: [], prayerActivationTicks: {} },
    playerEquipment: {},
    playerCombatSupplies: createEmptyCombatSupplies(),
    cooldownTracks: { food: 0, potion: 0, combo_food: 0 },
    mechanicsConfig: { yamaMageRange: true, waves: true, fireballs: true, infiniteHealth: true },
    attackTarget: null,
    lastAttackTarget: null,
    selectedAttackStyleIndex: 0,
    playerAttackCooldown: 0,
    playerNextAttackTick: -1,
    playerAttackSpeed: 4,
    introActive: false,
  };
}

type ViewportOptionProps = {
  showNpcAttackTimerMetronome?: boolean;
  playerOverheadNumbers?: PlayerOverheadNumbers;
};

const VIEWPORT_HARNESSES = [
  {
    label: 'RenderViewport',
    renderViewport: (getQueue: (context: RenderContext) => RenderQueue, options: ViewportOptionProps = {}) =>
      render(
        <RenderViewport
          simulationState={createState()}
          onTileClick={vi.fn()}
          showCoordinates={false}
          renderer={createRenderer()}
          sceneBuilder={createSceneBuilder(getQueue)}
          {...options}
        />,
      ),
  },
  {
    label: 'RenderViewport3D',
    renderViewport: (getQueue: (context: RenderContext) => RenderQueue, options: ViewportOptionProps = {}) =>
      render(
        <RenderViewport3D
          simulationState={createState()}
          onTileClick={vi.fn()}
          showCoordinates={false}
          renderer={createRenderer()}
          sceneBuilder={createSceneBuilder(getQueue)}
          {...options}
        />,
      ),
  },
] as const;

function installFrameQueue(): () => void {
  const rafCallbacks: FrameRequestCallback[] = [];

  beforeEach(() => {
    rafCallbacks.length = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  return function advanceFrame(): void {
    const callback = rafCallbacks.shift();
    if (!callback) return;
    act(() => {
      callback(performance.now());
    });
  };
}

describe.each(VIEWPORT_HARNESSES)('$label overhead text overlays', ({ renderViewport }) => {
  const advanceFrame = installFrameQueue();

  it('renders queued overhead text spans and clears them when the queue is empty', () => {
    let queue: RenderQueue = {
      replayPresentationReady: true,
      commands: [],
      overheadTexts: [
        {
          screenX: 123,
          screenY: 77,
          text: 'Well fought!',
          textColor: '#ffff00',
          fontSize: 18,
          key: 'actor:player',
        },
      ],
    };

    const { container } = renderViewport(() => queue);

    advanceFrame();

    const textContainer = container.querySelector<HTMLDivElement>('[data-overhead-texts="true"]');
    const textSpan = textContainer?.querySelector('span');
    expect(textContainer?.style.zIndex).toBe(`${OVERLAY_LAYER_Z_INDEX.overheadTexts}`);
    expect(textContainer?.parentElement?.style.zIndex).toBe('');
    expect(textSpan).toBeInTheDocument();
    expect(textSpan).toHaveTextContent('Well fought!');
    expect(textSpan?.style.fontFamily).toBe('"RuneScape Bold 12", monospace');
    expect(textSpan).toHaveStyle({
      position: 'absolute',
      pointerEvents: 'none',
      fontWeight: 'normal',
      lineHeight: '1',
      transform: 'translate(-50%, -100%)',
      whiteSpace: 'nowrap',
      textShadow: '1px 1px 0 #000',
      color: '#ffff00',
      fontSize: '18px',
    });
    expect(textSpan?.style.left).toBe('123px');
    expect(textSpan?.style.top).toBe('77px');

    queue = { replayPresentationReady: true, commands: [], overheadTexts: [] };
    advanceFrame();

    expect(container.querySelector('[data-overhead-texts="true"]')).not.toBeInTheDocument();
  });

  it('renders segmented overhead text with a base color and colored target word span', () => {
    let queue: RenderQueue = {
      replayPresentationReady: true,
      commands: [],
      overheadTexts: [
        {
          screenX: 123,
          screenY: 77,
          text: "I'LL BREAK YOUR BACK!",
          textColor: '#ff0000',
          fontSize: 18,
          key: 'actor:test_boss',
          segments: [{ text: "I'LL BREAK YOUR " }, { text: 'BACK', color: '#ffffff' }, { text: '!' }],
        },
      ],
    };

    const { container } = renderViewport(() => queue);

    advanceFrame();

    const textSpan = container.querySelector('[data-overhead-texts="true"] > span');
    const segmentSpans = textSpan?.querySelectorAll('span');
    expect(textSpan).toHaveTextContent("I'LL BREAK YOUR BACK!");
    expect(textSpan).toHaveStyle({ color: '#ff0000' });
    expect(segmentSpans).toHaveLength(3);
    expect(segmentSpans?.[1]).toHaveTextContent('BACK');
    expect(segmentSpans?.[1]).toHaveStyle({ color: '#ffffff' });

    queue = {
      replayPresentationReady: true,
      commands: [],
      overheadTexts: [
        {
          screenX: 123,
          screenY: 77,
          text: 'Plain again.',
          textColor: '#ffff00',
          fontSize: 18,
          key: 'actor:test_boss',
        },
      ],
    };
    advanceFrame();

    const plainSpan = container.querySelector('[data-overhead-texts="true"] > span');
    expect(plainSpan).toHaveTextContent('Plain again.');
    expect(plainSpan?.children).toHaveLength(0);
  });

  it('keeps unchanged overhead text nodes across frames, and rebuilds when a segment color changes', () => {
    const overheadText = (color: string) => ({
      screenX: 123,
      screenY: 77,
      text: 'BACK!',
      textColor: '#ff0000',
      fontSize: 18,
      key: 'actor:test_boss',
      segments: [{ text: 'BACK', color }, { text: '!' }],
    });
    let queue: RenderQueue = { replayPresentationReady: true, commands: [], overheadTexts: [overheadText('#ffffff')] };
    const { container } = renderViewport(() => queue);
    const segment = () => container.querySelector('[data-overhead-texts="true"] > span > span');

    advanceFrame();
    const first = segment();
    queue = { ...queue, overheadTexts: [{ ...overheadText('#ffffff'), screenX: 140 }] };
    advanceFrame();
    expect(segment()).toBe(first);

    queue = { ...queue, overheadTexts: [overheadText('#00ff00')] };
    advanceFrame();
    expect(segment()).not.toBe(first);
    expect(segment()).toHaveStyle({ color: '#00ff00' });
  });
});

describe.each(VIEWPORT_HARNESSES)('$label NPC attack timer metronome option', ({ renderViewport }) => {
  const advanceFrame = installFrameQueue();

  it.each([
    { prop: undefined, forwarded: false },
    { prop: true, forwarded: true },
  ])('forwards showNpcAttackTimerMetronome=$prop to the scene as $forwarded', ({ prop, forwarded }) => {
    const build = vi.fn((_context: RenderContext) => createQueue());

    renderViewport(build, { showNpcAttackTimerMetronome: prop });
    advanceFrame();

    expect(build).toHaveBeenCalled();
    expect(build.mock.lastCall?.[0].options.showNpcAttackTimerMetronome).toBe(forwarded);
  });
});

describe.each(VIEWPORT_HARNESSES)('$label player overhead numbers', ({ renderViewport }) => {
  const advanceFrame = installFrameQueue();

  it('forwards playerOverheadNumbers to the scene', () => {
    const build = vi.fn((_context: RenderContext) => createQueue());
    const playerOverheadNumbers = {
      tickCounter: null,
      attackCooldown: { fontSize: 16, abovePrayerIcon: false, offsetX: 0, offsetY: 0 },
    };

    renderViewport(build, { playerOverheadNumbers });
    advanceFrame();

    expect(build.mock.lastCall?.[0].options.playerOverheadNumbers).toBe(playerOverheadNumbers);
  });
});

interface OverlayLayer {
  element: HTMLDivElement;
  zIndex: number;
  domIndex: number;
}

function readOverlayLayer(container: HTMLElement, selector: string): OverlayLayer {
  const element = container.querySelector<HTMLDivElement>(selector);
  if (!element) throw new Error(`Expected overlay layer ${selector} to be in the document`);
  const siblings = Array.from(element.parentElement?.children ?? []);
  return { element, zIndex: Number(element.style.zIndex), domIndex: siblings.indexOf(element) };
}

interface OverlayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function overlayRect(element: HTMLElement | null): OverlayRect {
  if (!element) throw new Error('Expected a positioned overlay element');
  const translate = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(element.style.transform);
  return {
    left: translate ? Number(translate[1]) : Number.parseFloat(element.style.left),
    top: translate ? Number(translate[2]) : Number.parseFloat(element.style.top),
    width: Number.parseFloat(element.style.width),
    height: Number.parseFloat(element.style.height),
  };
}

function rectsOverlap(a: OverlayRect, b: OverlayRect): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

const OVERLAPPING_HITSPLAT: HitsplatOverlay = {
  screenX: 400,
  screenY: 300,
  amount: 27,
  type: 'damage',
  key: 'npc:7:hitsplat:0',
  progress: 0.2,
  width: 24,
  height: 22,
  fontSize: 11,
};

const OVERLAPPING_HEALTH_BAR: HealthBarOverlay = {
  screenX: 400,
  screenY: 298,
  ratio: 0.6,
  width: 40,
  height: 5,
  key: 'npc:7:healthbar',
  progress: 0.2,
};

const OVERLAPPING_TIMER_BAR: TimerBarOverlay = {
  screenX: 400,
  screenY: 292,
  ratio: 0.5,
  width: 40,
  height: 5,
  key: 'npc:7:timerbar',
};

function splatsAndBarsQueue(): RenderQueue {
  return {
    replayPresentationReady: true,
    commands: [],
    hitsplats: [OVERLAPPING_HITSPLAT],
    healthBars: [OVERLAPPING_HEALTH_BAR],
    timerBars: [OVERLAPPING_TIMER_BAR],
  };
}

function splatsOnlyQueue(): RenderQueue {
  return { replayPresentationReady: true, commands: [], hitsplats: [OVERLAPPING_HITSPLAT] };
}

function barsOnlyQueue(): RenderQueue {
  return {
    replayPresentationReady: true,
    commands: [],
    healthBars: [OVERLAPPING_HEALTH_BAR],
    timerBars: [OVERLAPPING_TIMER_BAR],
  };
}

describe.each(VIEWPORT_HARNESSES)('$label hitsplat and bar stacking', ({ renderViewport }) => {
  const advanceFrame = installFrameQueue();

  it('paints hitsplats above the health and timer bars their rectangle overlaps', () => {
    const queue = splatsAndBarsQueue();

    const { container } = renderViewport(() => queue);
    advanceFrame();

    const hitsplats = readOverlayLayer(container, '[data-hitsplats]');
    const healthBars = readOverlayLayer(container, '[data-healthbars]');
    const timerBars = readOverlayLayer(container, '[data-timerbars]');
    const splatRect = overlayRect(hitsplats.element.querySelector<HTMLDivElement>('div'));
    const healthBarRect = overlayRect(healthBars.element.querySelector<HTMLDivElement>('div'));

    expect(rectsOverlap(splatRect, healthBarRect)).toBe(true);
    expect(hitsplats.element.style.zIndex).toBe(`${OVERLAY_LAYER_Z_INDEX.hitsplats}`);
    expect(healthBars.element.style.zIndex).toBe(`${OVERLAY_LAYER_Z_INDEX.healthBars}`);
    expect(timerBars.element.style.zIndex).toBe(`${OVERLAY_LAYER_Z_INDEX.timerBars}`);
    expect(hitsplats.zIndex).toBeGreaterThan(healthBars.zIndex);
    expect(hitsplats.zIndex).toBeGreaterThan(timerBars.zIndex);
    expect(hitsplats.zIndex).toBeLessThan(OVERLAY_LAYER_Z_INDEX.overheadIcons);
  });

  it('keeps hitsplats above bar layers created after theirs', () => {
    let queue: RenderQueue = splatsOnlyQueue();
    const { container } = renderViewport(() => queue);
    advanceFrame();

    queue = splatsAndBarsQueue();
    advanceFrame();

    const hitsplats = readOverlayLayer(container, '[data-hitsplats]');
    const healthBars = readOverlayLayer(container, '[data-healthbars]');
    const timerBars = readOverlayLayer(container, '[data-timerbars]');

    expect(healthBars.domIndex).toBeGreaterThan(hitsplats.domIndex);
    expect(timerBars.domIndex).toBeGreaterThan(hitsplats.domIndex);
    expect(hitsplats.zIndex).toBeGreaterThan(healthBars.zIndex);
    expect(hitsplats.zIndex).toBeGreaterThan(timerBars.zIndex);
  });

  it('keeps hitsplats above bar layers created before theirs', () => {
    let queue: RenderQueue = barsOnlyQueue();
    const { container } = renderViewport(() => queue);
    advanceFrame();

    queue = splatsAndBarsQueue();
    advanceFrame();

    const hitsplats = readOverlayLayer(container, '[data-hitsplats]');
    const healthBars = readOverlayLayer(container, '[data-healthbars]');
    const timerBars = readOverlayLayer(container, '[data-timerbars]');

    expect(hitsplats.domIndex).toBeGreaterThan(healthBars.domIndex);
    expect(hitsplats.zIndex).toBeGreaterThan(healthBars.zIndex);
    expect(hitsplats.zIndex).toBeGreaterThan(timerBars.zIndex);
  });

  // An <img> in another request mode is a separate Blink memory-cache entry from the copy the
  // preloader warmed, so every overlay sprite would load and decode again on first sight.
  it('requests every overlay sprite in the preloader’s CORS mode', () => {
    const queue: RenderQueue = {
      ...splatsAndBarsQueue(),
      overheadIcons: [
        { screenX: 400, screenY: 250, iconPath: '/assets/ui/overhead_melee.png', key: 'player', width: 25, height: 25 },
      ],
    };
    const { container } = renderViewport(() => queue);
    advanceFrame();

    const images = [...container.querySelectorAll('img')];
    const layers = ['[data-overhead-icons]', '[data-hitsplats]', '[data-healthbars]', '[data-timerbars]'];
    for (const layer of layers) {
      expect(container.querySelector(`${layer} img`), `${layer} has no image`).not.toBeNull();
    }
    for (const image of images) {
      expect(image.crossOrigin, image.getAttribute('src') ?? '').toBe(IMAGE_CROSS_ORIGIN);
    }
  });

  it('keeps hitsplats above bar layers that are cleared and recreated', () => {
    let queue: RenderQueue = splatsAndBarsQueue();
    const { container } = renderViewport(() => queue);
    advanceFrame();

    queue = splatsOnlyQueue();
    advanceFrame();
    expect(container.querySelector('[data-healthbars]')).toBeNull();
    expect(container.querySelector('[data-timerbars]')).toBeNull();

    queue = splatsAndBarsQueue();
    advanceFrame();

    const hitsplats = readOverlayLayer(container, '[data-hitsplats]');
    const healthBars = readOverlayLayer(container, '[data-healthbars]');
    const timerBars = readOverlayLayer(container, '[data-timerbars]');

    expect(healthBars.domIndex).toBeGreaterThan(hitsplats.domIndex);
    expect(hitsplats.zIndex).toBeGreaterThan(healthBars.zIndex);
    expect(hitsplats.zIndex).toBeGreaterThan(timerBars.zIndex);
  });
});
