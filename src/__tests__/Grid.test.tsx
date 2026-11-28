// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { type ComponentProps, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeReplayPractice } from '../components/__tests__/ReplayPractice.fixtures';
import * as menuBuilders from '../components/ContextMenu/contextMenuBuilders';
import * as chatLog from '../components/chatLog';
import { EncounterTitleCard } from '../components/EncounterTitleCard';
import type { BarTextTarget, BarValuePaintSpec } from '../components/GamePanel/statusBarsPaint';
import { Grid } from '../components/Grid';
import { PanelSnapRegistryProvider } from '../components/snap/PanelSnapRegistry';
import { ReplayPresentationProvider } from '../contexts/ReplayPresentationContext';
import { type SimulationGridContextValue, SimulationProvider } from '../contexts/SimulationContext';
import { WorkspaceDockContext } from '../contexts/WorkspaceDockContext';
import type { ReplayCursorTrack } from '../core/ReplayRecorder';
import type { ReplayPresentationState } from '../core/replayPresentation';
import type { SimulationEngine } from '../core/SimulationEngine';
import { encounterDefaultCamera } from '../encounters/presentationModules';
import { YAMA_START_POS } from '../encounters/yamaP3/constants';
import { __resetKeyStateForTest } from '../input/keyState';
import { osmLeftColumnRight } from '../layout/osmFrame';
import { DEFAULT_MOBILE_TOOL_WINDOW } from '../layout/osmToolWindowState';
import { FIXED_SCENE, FIXED_VIEWPORT, type Rect } from '../layout/osrsClientLayout';
import type { RenderStatus } from '../render/core/renderer';
import { OSRS_DEFAULT_FOV_SCALE } from '../render/projections/Projection3D';
import type { NpcTypeLoader } from '../rs/config/npctype/NpcTypeLoader';
import { yamaSnapshot } from '../test/helpers/encounterSnapshot';
import { defaultOsmFrame } from '../test/helpers/osmFrame';
import { TUTORIAL_REPLAY_ENTERED_EVENT } from '../tutorial/events';
import { createEmptyCombatSupplies } from '../types/encounterLoadout';
import { DEFAULT_ENTITY_HIDER_OPTIONS, type EntityHiderOptions } from '../types/entityHider';
import { createEmptyStats as createEmptyEquipmentStats } from '../types/equipmentStats';
import { createEmptyInventory } from '../types/inventory';
import {
  createDefaultRunEnergy,
  createDefaultSpecialAttack,
  createDefaultStats,
  createDefaultTimers,
} from '../types/playerState';
import type { NpcState, SimulationState } from '../types/simulation';

const WATCH_GATE_ATTR = 'data-tutorial-watch-input-gated';

const paintBarValueSpy = vi.hoisted(() => vi.fn<(target: BarTextTarget, spec: BarValuePaintSpec) => void>());

vi.mock('../components/GamePanel/statusBarsPaint', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/GamePanel/statusBarsPaint')>();
  paintBarValueSpy.mockImplementation(actual.paintBarValue);
  return { ...actual, paintBarValue: paintBarValueSpy };
});

// Exercise Grid's real menu and selection callbacks without a GPU or scene picking. The props are
// recorded so a test can fire what the renderer reports (onRenderStatusChange) as the real one does.
const viewportProps = vi.hoisted(() => ({
  current: null as ComponentProps<typeof import('../render/components/RenderViewport3D').RenderViewport3D> | null,
}));
vi.mock('../render/components/RenderViewport3D', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../render/components/RenderViewport3D')>();
  return {
    ...actual,
    RenderViewport3D: (props: ComponentProps<typeof actual.RenderViewport3D>) => {
      viewportProps.current = props;
      return (
        <button type="button" onMouseDown={() => props.onContextMenu?.([30, 30], 100, 100)}>
          Open viewport menu
        </button>
      );
    },
  };
});

// The launcher row is window chrome Grid only hears about (onRowChange, onPluginsChange): a stub
// that hands the test its props stands in for it. No other test here mounts it.
const topChromeProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('../components/launcher/TopChrome', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/launcher/TopChrome')>();
  return {
    ...actual,
    TopChrome: (props: Record<string, unknown>) => {
      topChromeProps.current = props;
      return null;
    },
  };
});

// The real boss bar, with the default slot Grid hands it recorded.
const bossBarProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('../components/BossHealthBarOverlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/BossHealthBarOverlay')>();
  return {
    ...actual,
    BossHealthBarOverlay: (props: ComponentProps<typeof actual.BossHealthBarOverlay>) => {
      bossBarProps.current = props as unknown as Record<string, unknown>;
      return <actual.BossHealthBarOverlay {...props} />;
    },
  };
});

/** Fixed player start for tests. Production uses randomLandingPosition() over [29,35]→[33,39]. */
const PLAYER_START_POS: [number, number] = [31, 37];

describe('Grid', () => {
  afterEach(() => vi.restoreAllMocks());
  const defaultMechanicsConfig = { infiniteHealth: false };

  const mockState: SimulationState = {
    currentTick: 10,
    groundItems: [],
    playerPosition: PLAYER_START_POS,
    playerPreviousPosition: PLAYER_START_POS,
    playerMovementPath: [],
    playerFacingAngle: 0,
    playerIsMoving: false,
    playerIsRunning: false,
    primaryNpcPosition: YAMA_START_POS,
    primaryNpcPreviousPosition: YAMA_START_POS,
    primaryNpcFacingAngle: 0,
    primaryNpcSize: 5,
    npcs: [],
    encounter: yamaSnapshot({ state: { firstRangeMageType: 'magic' } }),
    encounterOutcome: { phase: 'active' },
    markOfDarknessActive: false,
    markOfDarknessTicksRemaining: 0,
    playerHistory: new Map([[10, PLAYER_START_POS]]),
    primaryNpcHistory: new Map([[10, YAMA_START_POS]]),
    failedCondition: null,
    isAlive: true,
    playerHP: 99,
    maxHP: 99,
    poisonVarp: 0,
    poisonTickCounter: 30,
    activePrayer: null,
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
    boostPrayers: [],
    independentPrayers: [],
    prayerState: { points: 99, maxPoints: 99, drainCounter: 0, activePrayers: [], prayerActivationTicks: {} },
    playerEquipment: {},
    playerCombatSupplies: createEmptyCombatSupplies(),
    attackTarget: null,
    lastAttackTarget: null,
    selectedAttackStyleIndex: 0,
    playerAttackCooldown: 0,
    playerNextAttackTick: -1,
    playerAttackSpeed: 4,
    cooldownTracks: { food: 0, potion: 0, combo_food: 0 },
    mechanicsConfig: { yamaMageRange: true, waves: true, fireballs: true, infiniteHealth: true },
    introActive: false,
  };

  const mockOnTileClick = vi.fn();
  const mockOnPrayerChange = vi.fn();
  const mockOnRunToggle = vi.fn();
  const mockOnSpecialAttackToggle = vi.fn();

  const gridProps = {
    onTileClick: mockOnTileClick,
    onPrayerChange: mockOnPrayerChange,
    onRunToggle: mockOnRunToggle,
    onSpecialAttackToggle: mockOnSpecialAttackToggle,
    showCoordinates: false as boolean,
    rendererType: 'canvas2d' as const,
    encounterKind: 'yama_p3',
  };

  it.each([
    'none',
    'webgl',
  ] as const)('shares the %s viewport geometry with click-through presentation above client chrome', (rendererType) => {
    render(
      <Grid
        {...gridProps}
        simulationState={mockState}
        rendererType={rendererType}
        sceneOverlay={<div data-testid="scene-overlay">Countdown</div>}
      />,
    );
    const overlay = screen.getByTestId('scene-overlay');
    const presentation = overlay.parentElement;
    const scene = document.querySelector<HTMLElement>('.scene-viewport');
    expect(presentation).toHaveClass('scene-presentation');
    expect(presentation?.style.position).toBe('absolute');
    for (const field of ['top', 'left', 'width', 'height', 'transform', 'transition'] as const)
      expect(presentation?.style[field]).toBe(scene?.style[field]);
    expect(presentation?.style.pointerEvents).toBe('none');
    expect(Number(presentation?.style.zIndex)).toBeGreaterThan(20);
    expect(scene?.style.zIndex).toBe('0');
    if (rendererType === 'webgl')
      expect(screen.getByRole('button', { name: 'Open viewport menu' }).parentElement).toBe(scene);
  });

  // Entering Sol Heredit (a new encounter and scene load) must not remount the viewport:
  // a new canvas would take a second WebGL context, which iOS on iPad then loses.
  it('keeps the 3D viewport, canvas owner and renderer when entering Sol Heredit from the lobby', () => {
    const lobby = { ...gridProps, simulationState: mockState, rendererType: 'webgl' as const };
    const { rerender } = render(<Grid {...lobby} encounterKind="lobby" sceneLoadId={0} />);
    const viewport = screen.getByRole('button', { name: 'Open viewport menu' });
    const renderer = viewportProps.current?.renderer;
    const lobbyScene = viewportProps.current?.sceneBuilder;

    rerender(<Grid {...lobby} encounterKind="sol_heredit" sceneLoadId={1} />);

    expect(screen.getByRole('button', { name: 'Open viewport menu' })).toBe(viewport);
    expect(viewportProps.current?.renderer).toBe(renderer);
    // The scene itself does change, in place.
    expect(viewportProps.current?.sceneBuilder).not.toBe(lobbyScene);
  });

  it('keeps the player’s camera over restarts, and opens a restart onto a different opening view on that view', () => {
    const inferno = { ...gridProps, rendererType: 'webgl' as const, encounterKind: 'inferno' };
    const at = (currentTick: number, infernoStartWave: string): SimulationState => ({
      ...mockState,
      currentTick,
      mechanicsConfig: { ...mockState.mechanicsConfig, infernoStartWave },
    });
    const { rerender } = render(<Grid {...inferno} simulationState={at(10, '30')} />);
    const projection = viewportProps.current?.projection3D;
    if (!projection) throw new Error('Expected the 3D viewport props');
    const view = () => {
      const { yaw, pitch, fovScale } = projection.getCameraState();
      return { yaw, pitch, fovScale };
    };
    projection.updateCamera({ yaw: 77, pitch: -40, fovScale: 300 });
    const own = view();

    // Retry, Random spawns or Go to wave on the ordinary waves: a fresh run, the same view.
    rerender(<Grid {...inferno} simulationState={at(0, '30')} />);
    expect(view()).toEqual(own);
    rerender(<Grid {...inferno} simulationState={at(0, '45')} />);
    expect(view()).toEqual(own);
    rerender(<Grid {...inferno} simulationState={at(0, '66')} />);
    expect(view()).toEqual(own);

    // Into wave 67 and then 68: each Jad wave's own opening view.
    for (const wave of ['67', '68']) {
      rerender(<Grid {...inferno} simulationState={at(5, wave)} />);
      rerender(<Grid {...inferno} simulationState={at(0, wave)} />);
      const jad = encounterDefaultCamera('inferno', { infernoStartWave: wave });
      expect(view(), wave).toEqual({ yaw: jad.yaw, pitch: jad.pitch, fovScale: jad.zoom });
    }
    expect(view()).toMatchObject({ yaw: 180, fovScale: 220 });

    // Into wave 69: its own opening view.
    rerender(<Grid {...inferno} simulationState={at(0, '69')} />);
    const zuk = encounterDefaultCamera('inferno', { infernoStartWave: '69' });
    expect(view()).toEqual({ yaw: zuk.yaw, pitch: zuk.pitch, fovScale: zuk.zoom });

    // Retrying wave 69 keeps what the player has made of it since.
    projection.updateCamera({ yaw: 33 });
    const turned = view();
    rerender(<Grid {...inferno} simulationState={at(5, '69')} />);
    rerender(<Grid {...inferno} simulationState={at(0, '69')} />);
    expect(view()).toEqual(turned);

    // A setting changed mid-fight never moves the camera; the attempt it applies to does.
    rerender(<Grid {...inferno} simulationState={at(5, '30')} />);
    expect(view()).toEqual(turned);
    rerender(<Grid {...inferno} simulationState={at(0, '30')} />);
    const waves = encounterDefaultCamera('inferno', { infernoStartWave: '30' });
    expect(view()).toEqual({ yaw: waves.yaw, pitch: waves.pitch, fovScale: waves.zoom ?? OSRS_DEFAULT_FOV_SCALE });
  });

  it('opens a Retry Wave made during the wave 68 to 69 cutscene on wave 69’s view, not the cutscene’s leftovers', () => {
    const inferno = { ...gridProps, rendererType: 'webgl' as const, encounterKind: 'inferno' };
    const at = (currentTick: number, infernoStartWave: string): SimulationState => ({
      ...mockState,
      currentTick,
      mechanicsConfig: { ...mockState.mechanicsConfig, infernoStartWave },
    });
    // A run started on wave 68, cleared into wave 69's intro, whose scripted camera holds the view.
    const { rerender } = render(<Grid {...inferno} simulationState={at(40, '68')} />);
    const projection = viewportProps.current?.projection3D;
    if (!projection) throw new Error('Expected the 3D viewport props');
    const view = () => {
      const { yaw, pitch, fovScale } = projection.getCameraState();
      return { yaw, pitch, fovScale };
    };
    projection.updateCamera({ yaw: 77, pitch: -40, fovScale: 300 });
    projection.setScriptedCamera({ eye: { x: 35.5, y: 35.5, z: 8 }, lookAt: { x: 28.5, y: 56.5, z: 1 } });
    // Player input stays frozen under a live cutscene.
    projection.updateCamera({ yaw: 10 });
    expect(view().yaw).toBe(77);

    // Retry Wave: a fresh run on wave 69, its opening view applied at once.
    rerender(<Grid {...inferno} simulationState={at(0, '69')} />);
    const zuk = encounterDefaultCamera('inferno', { infernoStartWave: '69' });
    expect(projection.getScriptedCamera()).toBeNull();
    expect(view()).toEqual({ yaw: zuk.yaw, pitch: zuk.pitch, fovScale: zuk.zoom });
    // Later tick-0 renders keep it (the viewport re-applies a cutscene only for the run that has one).
    rerender(<Grid {...inferno} simulationState={{ ...at(0, '69'), playerPosition: [31, 44] }} />);
    expect(view()).toEqual({ yaw: zuk.yaw, pitch: zuk.pitch, fovScale: zuk.zoom });
  });

  it('keeps the replay’s camera on taking over tick 1 of an Inferno replay whose start wave has another opening view', () => {
    const inferno = { ...gridProps, rendererType: 'webgl' as const, encounterKind: 'inferno' };
    const at = (currentTick: number, infernoStartWave: string): SimulationState => ({
      ...mockState,
      currentTick,
      mechanicsConfig: { ...mockState.mechanicsConfig, infernoStartWave },
    });
    // The restored boundary is the live engine's (GridProviders hands it down only then).
    const restored = {
      engine: {} as SimulationEngine,
      tick: 0,
      timeMs: 0,
      history: { frames: [], throughFrameIndex: 0 },
    };
    const grid = (state: SimulationState, options: { replaying?: boolean; restoredBoundary?: boolean } = {}) => (
      <SimulationProvider
        // Grid reads only the restored boundary from the context here; its props carry the rest.
        value={(options.restoredBoundary ? { restoredPresentation: restored } : {}) as SimulationGridContextValue}
      >
        <Grid {...inferno} simulationState={state} {...(options.replaying ? { replayControls } : {})} />
      </SimulationProvider>
    );
    // A live wave-30 run, then a replay of a wave-1 run, whose recorded camera the viewport applies.
    const { rerender } = render(grid(at(10, '30')));
    const projection = viewportProps.current?.projection3D;
    if (!projection) throw new Error('Expected the 3D viewport props');
    const view = () => {
      const { yaw, pitch, fovScale } = projection.getCameraState();
      return { yaw, pitch, fovScale };
    };
    rerender(grid(at(0, '1'), { replaying: true }));
    rerender(grid(at(5, '1'), { replaying: true }));
    projection.updateCamera({ yaw: 120, pitch: -30, fovScale: 250 });
    const recorded = view();

    // Take Over at tick 1 restores tick 0 of the replay's wave-1 run: not a fresh opening.
    rerender(grid(at(0, '1'), { restoredBoundary: true }));
    expect(view()).toEqual(recorded);
    rerender(grid({ ...at(0, '1'), playerPosition: [30, 33] }, { restoredBoundary: true }));
    expect(view()).toEqual(recorded);

    // A Retry from there is a fresh run on the same view: the player's camera carries over it.
    rerender(grid(at(0, '1')));
    expect(view()).toEqual(recorded);
  });

  it('opens a restart into Inferno wave 1 facing south, zoomed out, and keeps the player’s view on its retries', () => {
    const inferno = { ...gridProps, rendererType: 'webgl' as const, encounterKind: 'inferno' };
    const at = (currentTick: number, infernoStartWave: string): SimulationState => ({
      ...mockState,
      currentTick,
      mechanicsConfig: { ...mockState.mechanicsConfig, infernoStartWave },
    });
    const { rerender } = render(<Grid {...inferno} simulationState={at(10, '30')} />);
    const projection = viewportProps.current?.projection3D;
    if (!projection) throw new Error('Expected the 3D viewport props');
    const view = () => {
      const { yaw, pitch, fovScale } = projection.getCameraState();
      return { yaw, pitch, fovScale };
    };
    projection.updateCamera({ yaw: 77, pitch: -40, fovScale: 300 });

    rerender(<Grid {...inferno} simulationState={at(0, '1')} />);
    const waveOne = encounterDefaultCamera('inferno', { infernoStartWave: '1' });
    expect(waveOne.yaw).toBe(180);
    expect(view()).toEqual({ yaw: 180, pitch: waveOne.pitch, fovScale: waveOne.zoom });

    projection.updateCamera({ yaw: 33 });
    const turned = view();
    rerender(<Grid {...inferno} simulationState={at(5, '1')} />);
    rerender(<Grid {...inferno} simulationState={at(0, '1')} />);
    expect(view()).toEqual(turned);
  });

  /** App's side of the status: it holds what the viewport reports and hands it back down. */
  function StatusOwningGrid(props: Partial<ComponentProps<typeof Grid>>) {
    const [renderStatus, setRenderStatus] = useState<RenderStatus>({ kind: 'ok' });
    return (
      <Grid
        {...gridProps}
        simulationState={mockState}
        rendererType="webgl"
        {...props}
        renderStatus={renderStatus}
        onRenderStatusChange={setRenderStatus}
      />
    );
  }

  it('explains a dead 3D view over the visible scene, not the shifted canvas', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
    render(<StatusOwningGrid viewportOffsetX={120} viewportInsets={{ left: 200, right: 0, top: 0, bottom: 0 }} />);
    const scene = document.querySelector<HTMLElement>('.scene-viewport');
    expect(document.querySelector('.viewport-status')).toBeNull();

    act(() => viewportProps.current?.onRenderStatusChange?.({ kind: 'failed', reason: 'context-timeout' }));
    const layer = document.querySelector<HTMLElement>('.viewport-status');
    expect(layer?.textContent).toContain('The 3D view stopped');
    expect(within(layer as HTMLElement).getByRole('button', { name: 'Reload page' })).toBeDefined();

    // The part of the scene an open drawer leaves visible, in pixels. The canvas slides sideways
    // to keep the player centered behind that drawer; the notice belongs in the visible UI area,
    // so it neither follows the shift nor inherits the transform (and `will-change`) that moves it.
    expect([layer?.style.left, layer?.style.width, layer?.style.top, layer?.style.height]).toEqual([
      '200px',
      '1000px',
      '0px',
      '800px',
    ]);
    expect(scene?.style.transform).toBe('translateX(120px)');
    expect(layer?.style.transform).toBe('');
    expect(layer?.style.willChange).toBe('');
    // A sibling of the scene, so it survives whatever the renderer does to its canvas.
    expect(layer?.parentElement).toBe(scene?.parentElement);

    act(() => viewportProps.current?.onRenderStatusChange?.({ kind: 'ok' }));
    expect(document.querySelector('.viewport-status')).toBeNull();
  });

  // Measured from that same rectangle, never guessed from the device or a media query.
  it.each([
    { width: 420, height: 900, portrait: true },
    { width: 900, height: 420, portrait: false },
  ])('takes the banner form at $width x $height: $portrait', ({ width, height, portrait }) => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(height);
    render(
      <Grid
        {...gridProps}
        simulationState={mockState}
        rendererType="webgl"
        renderStatus={{ kind: 'failed', reason: 'render-loop' }}
      />,
    );
    expect(document.querySelector('.viewport-status')?.classList.contains('viewport-status--portrait')).toBe(portrait);
  });

  it('hands the viewport’s status to its owner and shows the one it is given', () => {
    const onRenderStatusChange = vi.fn();
    const { rerender } = render(
      <Grid
        {...gridProps}
        simulationState={mockState}
        rendererType="webgl"
        renderStatus={{ kind: 'ok' }}
        onRenderStatusChange={onRenderStatusChange}
      />,
    );
    act(() => viewportProps.current?.onRenderStatusChange?.({ kind: 'lost' }));
    expect(onRenderStatusChange).toHaveBeenCalledWith({ kind: 'lost' });
    // Grid keeps no copy of its own: nothing shows until the owner passes the status back.
    expect(document.querySelector('.viewport-status')).toBeNull();

    rerender(
      <Grid
        {...gridProps}
        simulationState={mockState}
        rendererType="webgl"
        renderStatus={{ kind: 'failed', reason: 'context-restore' }}
        graphicsHeld
        graphicsHeldActivity="fight"
        onRenderStatusChange={onRenderStatusChange}
      />,
    );
    expect(document.querySelector('.viewport-status')?.textContent).toContain('The fight is paused.');
  });

  it('hides the scene presentation while graphics are held, keeping it mounted', () => {
    const presentation = () => screen.getByTestId('scene-overlay').parentElement;
    const { rerender } = render(
      <Grid
        {...gridProps}
        simulationState={mockState}
        rendererType="webgl"
        sceneOverlay={<div data-testid="scene-overlay">Countdown</div>}
      />,
    );
    const mounted = screen.getByTestId('scene-overlay');
    expect(presentation()?.style.visibility).toBe('');

    rerender(
      <Grid
        {...gridProps}
        simulationState={mockState}
        rendererType="webgl"
        renderStatus={{ kind: 'lost' }}
        graphicsHeld
        sceneOverlay={<div data-testid="scene-overlay">Countdown</div>}
      />,
    );
    expect(screen.getByTestId('scene-overlay')).toBe(mounted);
    expect(presentation()?.style.visibility).toBe('hidden');
  });

  it.each(['canvas2d', 'none'] as const)('mounts no status layer for the %s viewport', (rendererType) => {
    render(<Grid {...gridProps} simulationState={mockState} rendererType={rendererType} />);
    expect(document.querySelector('.viewport-status')).toBeNull();
  });

  // A browser page translation rewriting text nodes React owns tears the live HUD down mid-render.
  it('opts the live scene out of browser page translation', () => {
    render(<Grid {...gridProps} simulationState={mockState} rendererType="none" />);
    expect(document.querySelector('.scene-viewport')?.getAttribute('translate')).toBe('no');
  });

  it.each([
    { chatboxVisible: true, scale: 1 },
    { chatboxVisible: false, scale: 1 },
    { chatboxVisible: true, scale: 2 },
    { chatboxVisible: false, scale: 2 },
  ])('shares the Fixed scene rectangle (chat=$chatboxVisible, scale=$scale)', ({ chatboxVisible, scale }) => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(765 * scale);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(503 * scale);
    render(
      <Grid
        {...gridProps}
        simulationState={mockState}
        rendererType="none"
        clientLayoutMode="fixed"
        chatboxVisible={chatboxVisible}
        viewportOffsetX={120}
        sceneOverlay={
          <EncounterTitleCard
            countdownActive={true}
            encounterName="Sol Heredit"
            countdown={{
              key: 1,
              startsAtMs: performance.now() - 100,
              endsAtMs: performance.now() + 1700,
              releasedAtMs: null,
              tickCount: 3,
              tickMs: 600,
              onFinished: () => {},
            }}
          />
        }
      />,
    );
    const arrival = document.querySelector('.encounter-arrival');
    const scene = arrival?.parentElement;
    expect(arrival?.querySelector('.encounter-title-card-text-fill')?.textContent).toBe('Sol Heredit');
    expect(arrival?.querySelector('.fight-start-countdown')).not.toBeNull();
    const rect = chatboxVisible ? FIXED_VIEWPORT : FIXED_SCENE;
    expect(scene?.style.left).toBe(`${rect.x * scale}px`);
    expect(scene?.style.top).toBe(`${rect.y * scale}px`);
    expect(scene?.style.width).toBe(`${rect.width * scale}px`);
    expect(scene?.style.height).toBe(`${rect.height * scale}px`);
    expect(scene?.style.transform).toBe('');
    const viewport = document.querySelector<HTMLElement>('.scene-viewport');
    for (const field of ['top', 'left', 'width', 'height'] as const)
      expect(scene?.style[field]).toBe(viewport?.style[field]);
    if (chatboxVisible && scale === 1) {
      expect([rect.x + rect.width / 2, rect.y + rect.height / 2]).toEqual([260, 171]);
    }
  });

  it.each([
    'classic',
    'modern',
    'mobile',
  ] as const)('shares the full %s scene and its existing translation', (clientLayoutMode) => {
    render(
      <Grid
        {...gridProps}
        simulationState={mockState}
        rendererType="none"
        clientLayoutMode={clientLayoutMode}
        mechanicsConfig={defaultMechanicsConfig}
        onMechanicsConfigChange={vi.fn()}
        mechanicsToggles={[]}
        debugActions={[]}
        onExecuteEncounterCommand={vi.fn()}
        viewportOffsetX={120}
        sceneOverlay={<div data-testid="scene-overlay" />}
      />,
    );
    const scene = screen.getByTestId('scene-overlay').parentElement;
    expect(scene?.style.width).toBe('100%');
    expect(scene?.style.height).toBe('100%');
    expect(scene?.style.transform).toBe('translateX(120px)');
    const viewport = document.querySelector<HTMLElement>('.scene-viewport');
    for (const field of ['top', 'left', 'width', 'height', 'transform'] as const)
      expect(scene?.style[field]).toBe(viewport?.style[field]);
  });

  const replayControls = {
    isReplaying: true,
    replayFrameIndex: 0,
    totalFrames: 2,
    hasRecording: true,
    onEnterReplay: vi.fn(),
    onExitReplay: vi.fn(),
    onStepBack: vi.fn(),
    onStepForward: vi.fn(),
    onJumpToStart: vi.fn(),
    onJumpToEnd: vi.fn(),
    onSeek: vi.fn(),
    onPreviewSeek: vi.fn(),
    onPlayPause: vi.fn(),
    isPlaying: false,
    onTakeOver: vi.fn(),
    replayCursorVisible: true,
    onReplayCursorVisibleChange: vi.fn(),
  } satisfies NonNullable<ComponentProps<typeof Grid>['replayControls']>;

  it('starts desktop transport Practice through the explicit practice prop, not the replay controls', () => {
    const practice = makeReplayPractice();
    render(
      <Grid {...gridProps} simulationState={mockState} replayControls={replayControls} replayPractice={practice} />,
    );
    expect(replayControls).not.toHaveProperty('replayPractice');
    fireEvent.click(screen.getByRole('button', { name: 'Practice' }));
    expect(practice.onStartPractice).toHaveBeenCalledOnce();
  });

  it.each(['fixed', 'modern'] as const)('keeps the %s chat subscription outside tick-only Grid renders', (mode) => {
    const messages = vi.spyOn(chatLog, 'useChatLog').mockReturnValue([]);
    const onChatboxVisibleChange = vi.fn();
    const props = { ...gridProps, clientLayoutMode: mode, onChatboxVisibleChange };
    const view = render(<Grid {...props} simulationState={mockState} />);
    messages.mockClear();
    view.rerender(<Grid {...props} simulationState={{ ...mockState, currentTick: mockState.currentTick + 1 }} />);
    expect(messages).not.toHaveBeenCalled();
    fireEvent.click(within(view.container).getByRole('button', { name: 'All' }));
    expect(onChatboxVisibleChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('tells the tutorial a replay was entered once playback runs, with its transport on screen', () => {
    // Asking for playback is not enough: the Mobile Replay tab asks from an effect, and the step
    // after this one spotlights the transport, which only exists once the replay plays.
    const transportAtEvent: Array<Element | null> = [];
    const entered = () =>
      transportAtEvent.push(document.querySelector('[data-tutorial="replay-controls"] .replay-bar'));
    window.addEventListener(TUTORIAL_REPLAY_ENTERED_EVENT, entered);
    try {
      const grid = (isReplaying: boolean) => (
        <Grid
          {...gridProps}
          simulationState={mockState}
          replayControls={{ ...replayControls, isReplaying }}
          mechanicsConfig={defaultMechanicsConfig}
          onMechanicsConfigChange={vi.fn()}
          mechanicsToggles={[]}
          debugActions={[]}
          onExecuteEncounterCommand={vi.fn()}
        />
      );
      const view = render(grid(false));
      expect(transportAtEvent).toEqual([]);
      view.rerender(grid(true));
      expect(transportAtEvent).toHaveLength(1);
      expect(transportAtEvent[0]).not.toBeNull();
      // A tick of playback is not a second entry.
      view.rerender(grid(true));
      expect(transportAtEvent).toHaveLength(1);
    } finally {
      window.removeEventListener(TUTORIAL_REPLAY_ENTERED_EVENT, entered);
    }
  });

  it.each([
    undefined,
    1.5,
  ])('uses the recorded overlay size (%s) and the live window size for the transport', (recordedScale) => {
    const presentation: ReplayPresentationState = {
      clientLayoutMode: 'modern',
      frame: { width: 1280, height: 720 },
      insets: { left: 0, right: 0 },
      uiScale: 1,
      ...(recordedScale === undefined ? {} : { overlayScale: recordedScale }),
      panels: {
        gamePanel: { x: 0, y: 0, anchorX: 'right', anchorY: 'bottom' },
        minimap: { x: 0, y: 0, anchorX: 'right', anchorY: 'top' },
        compactOrbs: { x: 0, y: 0, anchorX: 'right', anchorY: 'top' },
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
    };
    const view = (recorded: ReplayPresentationState | null) => (
      <ReplayPresentationProvider
        presentation={recorded}
        reportPanelPresentation={() => {}}
        reportMinimapZoom={() => {}}
      >
        <Grid
          {...gridProps}
          simulationState={mockState}
          overlayScale={1.5}
          chromeScale={2}
          replayControls={replayControls}
          mechanicsConfig={defaultMechanicsConfig}
          onMechanicsConfigChange={vi.fn()}
          mechanicsToggles={[]}
          debugActions={[]}
          onExecuteEncounterCommand={vi.fn()}
          xpDropsEnabled
        />
      </ReplayPresentationProvider>
    );
    const { container, rerender } = render(view(presentation));
    // Master recordings carry no size and play at 1x.
    const xpPanel = container.querySelector<HTMLElement>('[data-tutorial="xp-drops-panel"]');
    expect(xpPanel?.style.width).toBe(`${170 * (recordedScale ?? 1)}px`);
    expect(document.querySelector<HTMLElement>('.replay-transport-dock > div')?.style.zoom).toBe('2');
    rerender(view(null));
    expect(xpPanel?.style.width).toBe('255px');
  });

  it('places every panel against a resized frame before that frame is painted', () => {
    // The frame's ResizeObserver runs after layout and before paint. Its update must be
    // committed there and then: deferred, each step of a window drag painted the panels
    // placed for the previous size, trailing the edge and catching up a frame late.
    const observers: Array<{ callback: ResizeObserverCallback; targets: Element[] }> = [];
    // Start from a real laid-out frame. A zero-sized reference deliberately uses
    // the center under the normalized-placement policy, not an anchor fallback.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
    const Original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      private readonly entry: { callback: ResizeObserverCallback; targets: Element[] };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.push(target);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      const { container } = render(
        <Grid
          simulationState={mockState}
          {...gridProps}
          mechanicsConfig={defaultMechanicsConfig}
          onMechanicsConfigChange={vi.fn()}
          mechanicsToggles={[]}
          debugActions={[]}
          onExecuteEncounterCommand={vi.fn()}
        />,
      );
      const tabBar = () => container.querySelector<HTMLElement>('[role="presentation"][data-tutorial="tab-bar"]');
      const before = tabBar()?.style.transform;
      // The frame's own size observer, and the chrome measure's (useLayoutMeasure), which watches it too.
      const frames = observers.filter(({ targets }) => targets.some((target) => target.contains(tabBar())));
      if (frames.length === 0) throw new Error('frame observer not found');
      const [target] = frames[0].targets;
      Object.defineProperty(target, 'clientWidth', { value: 1500, configurable: true });
      Object.defineProperty(target, 'clientHeight', { value: 800, configurable: true });

      // No act(), no await: the move must be on the DOM when the callback returns.
      for (const frame of frames) frame.callback([], {} as ResizeObserver);
      expect(tabBar()?.style.transform).not.toBe(before);
      expect(tabBar()?.style.transform).toBe(`translate3d(${1500 - 237}px, ${800 - 36}px, 0)`);
    } finally {
      globalThis.ResizeObserver = Original;
    }
  });

  it('measures the frame and its minimap on a real change, never on a tick', async () => {
    const reads: Element[] = [];
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      reads.push(this);
      return new DOMRect(0, 0, 0, 0);
    });
    const grid = (tick: number, minimapX: number) => (
      <PanelSnapRegistryProvider>
        <Grid
          simulationState={{ ...mockState, currentTick: tick }}
          {...gridProps}
          // The minimap is drawn with the 3D renderers.
          rendererType="webgl"
          clientLayoutMode="modern"
          minimapPosition={{ x: minimapX, y: 0, anchorX: 'right', anchorY: 'top' }}
          topChrome={{
            settings: { open: false, inset: 0 },
            menu: { items: null, pinned: false },
            plugins: null,
            showFps: false,
          }}
          mechanicsConfig={defaultMechanicsConfig}
          onMechanicsConfigChange={vi.fn()}
          mechanicsToggles={[]}
          debugActions={[]}
          onExecuteEncounterCommand={vi.fn()}
        />
      </PanelSnapRegistryProvider>
    );
    const view = render(grid(10, 0));
    await act(async () => {});
    const frame = (topChromeProps.current?.frameRef as { current: HTMLElement | null }).current;
    const minimap = view.container.querySelector('[data-tutorial="minimap"]');
    if (!frame || !minimap) throw new Error('frame or minimap not mounted');
    const measured = () => reads.filter((element) => element === frame || element === minimap).length;
    reads.length = 0;

    for (let tick = 11; tick <= 13; tick++) {
      await act(async () => {
        view.rerender(grid(tick, 0));
      });
    }
    expect(measured()).toBe(0);

    // The minimap dragged elsewhere: its solve is what tells Grid.
    await act(async () => {
      view.rerender(grid(13, 40));
    });
    expect(measured()).toBeGreaterThan(0);

    // The window resizing.
    reads.length = 0;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(reads).toContain(frame);
  });

  describe('NPC picking under Entity Hider', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      __resetKeyStateForTest();
    });

    const boss: NpcState = {
      id: 'boss',
      npcTypeId: 1,
      archetypeId: 'test',
      role: 'boss',
      alive: true,
      position: YAMA_START_POS,
      previousPosition: YAMA_START_POS,
      facingAngle: 0,
      combatTargetId: null,
      size: 5,
      hp: 100,
      maxHp: 100,
      history: new Map(),
    };
    const npcTypeLoader = {
      load: () => ({ name: 'Test NPC', combatLevel: 0, actions: ['Attack'] }),
    } as unknown as NpcTypeLoader;

    // The scene left the sole boss's clickbox out (hidden, or its model not drawn yet), so Grid's
    // picker falls back to the boss's coarse footprint box. Clicks aim at the middle of it.
    function renderBossGrid(entityHider: EntityHiderOptions | null) {
      const onTileClick = vi.fn();
      render(
        <Grid
          {...gridProps}
          rendererType="webgl"
          onTileClick={onTileClick}
          npcTypeLoader={npcTypeLoader}
          entityHider={entityHider}
          simulationState={{ ...mockState, npcs: [boss] }}
        />,
      );
      const props = viewportProps.current;
      if (!props?.sceneBuilder || !props.projection3D) throw new Error('Expected the 3D viewport props');
      vi.spyOn(props.sceneBuilder, 'getAllNpcHitTestData').mockReturnValue([]);
      const projection = props.projection3D;
      const middle = { x: YAMA_START_POS[0] + 2.5, y: YAMA_START_POS[1] + 2.5, level: 1 };
      projection.updateViewport({ width: 800, height: 600, dpr: 1 });
      projection.updateCamera({ targetX: middle.x, targetY: middle.y, targetZ: 1 });
      const screenPx = projection.tileToScreen(middle);
      if (!screenPx) throw new Error('Expected the boss on screen');
      return { props, onTileClick, screenPx };
    }

    it('attacks and lists a shown boss through the footprint fallback', () => {
      const { props, onTileClick, screenPx } = renderBossGrid(null);

      expect(props.onVoidClick?.(screenPx, false)).toBe(true);
      expect(onTileClick).toHaveBeenCalledExactlyOnceWith(boss.position, false, 'boss');
      act(() => {
        props.onContextMenu?.(YAMA_START_POS, 100, 100, screenPx);
      });
      expect(screen.getByRole('menuitem', { name: 'Attack Test NPC' })).toBeDefined();
    });

    it.each([
      { label: 'Hide NPCs', options: { hideNpcs: true } },
      { label: 'Hide NPCs and Hide attackers', options: { hideNpcs: true, hideAttackers: true } },
    ])('cannot attack or open a menu on a sole boss $label leaves undrawn', ({ options }) => {
      const { props, onTileClick, screenPx } = renderBossGrid({ ...DEFAULT_ENTITY_HIDER_OPTIONS, ...options });

      expect(props.onVoidClick?.(screenPx, false)).toBe(false);
      expect(onTileClick).not.toHaveBeenCalled();
      act(() => {
        props.onContextMenu?.(YAMA_START_POS, 100, 100, screenPx);
      });
      expect(screen.queryByRole('menuitem', { name: 'Attack Test NPC' })).toBeNull();
    });
  });

  describe('NPC context-menu Ctrl clicks', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      __resetKeyStateForTest();
    });

    it.each([
      { route: 'primary', openedWithCtrl: true, selectedWithCtrl: true },
      { route: 'target', openedWithCtrl: true, selectedWithCtrl: true },
      { route: 'primary', openedWithCtrl: false, selectedWithCtrl: true },
      { route: 'target', openedWithCtrl: false, selectedWithCtrl: true },
      { route: 'primary', openedWithCtrl: true, selectedWithCtrl: false },
      { route: 'target', openedWithCtrl: true, selectedWithCtrl: false },
      { route: 'primary', openedWithCtrl: false, selectedWithCtrl: false },
      { route: 'target', openedWithCtrl: false, selectedWithCtrl: false },
    ])('uses selection-time Ctrl for $route attacks (open=$openedWithCtrl, select=$selectedWithCtrl)', ({
      route,
      openedWithCtrl,
      selectedWithCtrl,
    }) => {
      const onTileClick = vi.fn();
      vi.spyOn(menuBuilders, 'resolveViewportRightClick').mockImplementation((options) => ({
        kind: 'menu',
        content: {
          entries: [
            {
              action: 'Attack',
              target: 'Test NPC',
              onClick: () => {
                if (route === 'primary') options.onNpcAction?.([30, 30]);
                else options.onNpcActionByTarget?.('target-npc', [30, 30]);
              },
            },
          ],
        },
      }));
      render(
        <Grid
          {...gridProps}
          rendererType="webgl"
          onTileClick={onTileClick}
          mechanicsConfig={defaultMechanicsConfig}
          onMechanicsConfigChange={vi.fn()}
          mechanicsToggles={[]}
          debugActions={[]}
          onExecuteEncounterCommand={vi.fn()}
          simulationState={{
            ...mockState,
            npcs: [
              {
                id: 'boss',
                npcTypeId: 1,
                archetypeId: 'test',
                role: 'boss',
                alive: true,
                position: [30, 30],
                previousPosition: [30, 30],
                facingAngle: 0,
                size: 1,
                hp: 100,
                maxHp: 100,
                history: new Map(),
              },
            ],
          }}
        />,
      );
      fireEvent.mouseDown(screen.getByRole('button', { name: 'Open viewport menu' }), {
        button: 2,
        ctrlKey: openedWithCtrl,
      });
      const attack = screen.getByRole('menuitem', { name: 'Attack Test NPC' });
      vi.spyOn(attack, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 100, 20));

      fireEvent.mouseDown(attack, { button: 0, clientX: 110, clientY: 110, ctrlKey: selectedWithCtrl });

      expect(onTileClick).toHaveBeenCalledExactlyOnceWith(
        [30, 30],
        selectedWithCtrl,
        route === 'primary' ? 'boss' : 'target-npc',
      );
    });
  });

  describe('tool anchoring', () => {
    afterEach(() => vi.restoreAllMocks());

    function renderSmallTools(
      mode: 'modern' | 'classic' | 'fixed',
      height = 503,
      width = 765,
      chatboxVisible = true,
      onChatboxVisibleChange = vi.fn(),
    ) {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(height);
      const view = render(
        <Grid
          {...gridProps}
          simulationState={mockState}
          clientLayoutMode={mode}
          chatboxVisible={chatboxVisible}
          onChatboxVisibleChange={onChatboxVisibleChange}
          infoboxPinTarget="hud"
          showTickCounterInfobox
          mechanicsConfig={defaultMechanicsConfig}
          onMechanicsConfigChange={vi.fn()}
          mechanicsToggles={[{ key: 'waves', label: 'Waves' }]}
          debugActions={[]}
          onExecuteEncounterCommand={vi.fn()}
        />,
      );
      return { view };
    }

    /** Where the Chatbox infobox strip sits, from its DraggablePanel transform. */
    function infoboxStrip(view: ReturnType<typeof render>): { left: number; top: number } {
      const strip = view.container.querySelector<HTMLElement>('[data-tutorial="infobox-panel"]');
      const match = strip?.style.transform.match(/translate3d\(([-\d.]+)px, ([-\d.]+)px/);
      if (!match) throw new TypeError('Missing infobox strip');
      return { left: Number(match[1]), top: Number(match[2]) };
    }

    // Fixed at 1x: one tick-counter tile, one 4px gap above the 165-row chatbox (or the 23-row
    // controls row once it is collapsed), and the same gap in from the 4px stone border.
    it('sits the Chatbox infoboxes one gap inside the Fixed border and above the chat', () => {
      expect(infoboxStrip(renderSmallTools('fixed').view)).toEqual({ left: 8, top: 338 - 4 - 32 });
    });

    it('drops the Chatbox infoboxes with the chat when it collapses', () => {
      expect(infoboxStrip(renderSmallTools('fixed', 503, 765, false).view)).toEqual({ left: 8, top: 480 - 4 - 32 });
    });

    it.each(['modern', 'classic'] as const)('sits the %s Chatbox infoboxes on top of the open chatbox', (mode) => {
      expect(infoboxStrip(renderSmallTools(mode, 839, 1280).view).top).toBe(839 - 165 - 4 - 32);
    });

    // The chatbox is the bottom layer: panels draw over it rather than being pushed off it, so
    // the side panel keeps one position whether the chat is open, collapsed, or overlapped.
    it.each(['modern', 'classic'] as const)('leaves a %s side panel that overlaps the chatbox where it is', (mode) => {
      // 700 wide: the 519-wide chatbox and the bottom-right side panel share the bottom edge.
      const panelTransform = (chatboxVisible: boolean) => {
        const { view } = renderSmallTools(mode, 600, 700, chatboxVisible);
        const transform = view.container.querySelector<HTMLElement>('[data-tutorial="game-panel"]')?.style.transform;
        view.unmount();
        return transform;
      };
      const open = panelTransform(true);
      expect(open).toBeTruthy();
      expect(panelTransform(false)).toBe(open);
    });

    it.each(['modern', 'classic', 'fixed'] as const)('toggles the %s chatbox from the selected All tab', (mode) => {
      for (const open of [true, false]) {
        const onChatboxVisibleChange = vi.fn();
        const { view } = renderSmallTools(mode, 839, 1280, open, onChatboxVisibleChange);
        fireEvent.click(within(view.container).getByRole('button', { name: 'All' }));
        expect(onChatboxVisibleChange).toHaveBeenCalledExactlyOnceWith(!open);
        view.unmount();
      }
    });

    it('mounts the chatbox in every desktop layout and none in Mobile', () => {
      for (const mode of ['fixed', 'modern', 'classic'] as const) {
        const { view } = renderSmallTools(mode, 839, 1280);
        expect(view.container.querySelector('.chatbox')).not.toBeNull();
        view.unmount();
      }
    });
  });

  it('renders without crashing', () => {
    render(
      <Grid
        simulationState={mockState}
        {...gridProps}
        mechanicsConfig={defaultMechanicsConfig}
        onMechanicsConfigChange={vi.fn()}
        mechanicsToggles={[]}
        debugActions={[]}
        onExecuteEncounterCommand={vi.fn()}
      />,
    );
    const canvases = screen.getAllByRole('img');
    expect(canvases.length).toBeGreaterThan(0);
  });

  it('renders the Game Grid canvas', () => {
    render(
      <Grid
        simulationState={mockState}
        {...gridProps}
        mechanicsConfig={defaultMechanicsConfig}
        onMechanicsConfigChange={vi.fn()}
        mechanicsToggles={[]}
        debugActions={[]}
        onExecuteEncounterCommand={vi.fn()}
      />,
    );
    const canvases = screen.getAllByRole('img');
    expect(canvases.find((c) => c.getAttribute('aria-label') === 'Game Grid')).toBeDefined();
  });

  it('draws no readout card of its own: the fight stats live in Practice', () => {
    const { container } = render(
      <Grid
        simulationState={mockState}
        {...gridProps}
        mechanicsConfig={defaultMechanicsConfig}
        onMechanicsConfigChange={vi.fn()}
        mechanicsToggles={[]}
        debugActions={[]}
        onExecuteEncounterCommand={vi.fn()}
      />,
    );
    expect(screen.queryByText('Max Hit')).toBeNull();
    expect(container.querySelector('.launcher-row')).toBeNull();
  });

  it('passes props correctly to GridCanvas', () => {
    render(
      <Grid
        simulationState={mockState}
        {...gridProps}
        showCoordinates={true}
        mechanicsConfig={defaultMechanicsConfig}
        onMechanicsConfigChange={vi.fn()}
        mechanicsToggles={[]}
        debugActions={[]}
        onExecuteEncounterCommand={vi.fn()}
      />,
    );
    const canvases = screen.getAllByRole('img');
    const canvas = canvases.find((c) => c.getAttribute('aria-label') === 'Game Grid') as HTMLCanvasElement;
    expect(canvas).toBeDefined();
  });

  it('passes onTileClick callback to GridCanvas', () => {
    const { container } = render(
      <Grid
        simulationState={mockState}
        {...gridProps}
        mechanicsConfig={defaultMechanicsConfig}
        onMechanicsConfigChange={vi.fn()}
        mechanicsToggles={[]}
        debugActions={[]}
        onExecuteEncounterCommand={vi.fn()}
      />,
    );
    const canvas = container.querySelector('canvas');
    expect(canvas).toBeDefined();
  });

  it('renders with showCoordinates prop', () => {
    render(
      <Grid
        simulationState={mockState}
        {...gridProps}
        showCoordinates={true}
        mechanicsConfig={defaultMechanicsConfig}
        onMechanicsConfigChange={vi.fn()}
        mechanicsToggles={[]}
        debugActions={[]}
        onExecuteEncounterCommand={vi.fn()}
      />,
    );
    const canvases = screen.getAllByRole('img');
    expect(canvases.length).toBeGreaterThan(0);
  });

  it('renders with rendererType prop', () => {
    render(
      <Grid
        simulationState={mockState}
        {...gridProps}
        mechanicsConfig={defaultMechanicsConfig}
        onMechanicsConfigChange={vi.fn()}
        mechanicsToggles={[]}
        debugActions={[]}
        onExecuteEncounterCommand={vi.fn()}
      />,
    );
    const canvases = screen.getAllByRole('img');
    expect(canvases.length).toBeGreaterThan(0);
  });

  it('hands over a getter for the intro time left, null with no intro playing, and takes it back on unmount', () => {
    const onIntroTimingGetterChange =
      vi.fn<(getter: ((expectedSpeedMultiplier: number) => number | null) | null) => void>();
    const view = render(
      <Grid
        simulationState={mockState}
        {...gridProps}
        mechanicsConfig={defaultMechanicsConfig}
        onMechanicsConfigChange={vi.fn()}
        mechanicsToggles={[]}
        debugActions={[]}
        onExecuteEncounterCommand={vi.fn()}
        onIntroTimingGetterChange={onIntroTimingGetterChange}
      />,
    );
    const getter = onIntroTimingGetterChange.mock.lastCall?.[0];
    expect(getter).toBeTypeOf('function');
    expect(getter?.(1)).toBeNull();
    expect(getter?.(2)).toBeNull();
    view.unmount();
    expect(onIntroTimingGetterChange).toHaveBeenLastCalledWith(null);
  });

  it('does not thread explicit yellow replay clicks through the production GamePanel', () => {
    const onPrayerChange = vi.fn();
    const onReplayCursorClick = vi.fn();
    render(
      <Grid
        simulationState={mockState}
        {...gridProps}
        activeGamePanelTab="prayer"
        onPrayerChange={onPrayerChange}
        onReplayCursorClick={onReplayCursorClick}
        mechanicsConfig={defaultMechanicsConfig}
        onMechanicsConfigChange={vi.fn()}
        mechanicsToggles={[]}
        debugActions={[]}
        onExecuteEncounterCommand={vi.fn()}
      />,
    );
    const prayerButton = screen.getByRole('button', { name: 'Protect from Magic' });

    fireEvent.mouseDown(prayerButton, { button: 0, clientX: 101, clientY: 202 });

    expect(onPrayerChange).toHaveBeenCalledTimes(1);
    expect(onReplayCursorClick).not.toHaveBeenCalled();
  });

  it('mounts the replay cursor layer only when replay cursor visibility is enabled', () => {
    const elementFromPoint = vi.fn(() => null);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: elementFromPoint,
    });
    const replayCursorTrack = {
      samples: [{ tMs: 0, x: 12, y: 34, insideFrame: true }],
      clicks: [{ tMs: 0, x: 12, y: 34, insideFrame: true, type: 'red' }],
    } satisfies ReplayCursorTrack;
    const { rerender } = render(
      <Grid
        simulationState={mockState}
        {...gridProps}
        replayControls={replayControls}
        replayCursorTrack={replayCursorTrack}
        mechanicsConfig={defaultMechanicsConfig}
        onMechanicsConfigChange={vi.fn()}
        mechanicsToggles={[]}
        debugActions={[]}
        onExecuteEncounterCommand={vi.fn()}
      />,
    );

    expect(screen.getByTestId('replay-cursor')).toBeInTheDocument();
    expect(screen.getByTestId('replay-click-marker-red')).toBeInTheDocument();
    expect(document.body).toHaveAttribute(WATCH_GATE_ATTR, 'true');
    elementFromPoint.mockClear();

    rerender(
      <Grid
        simulationState={mockState}
        {...gridProps}
        replayControls={{ ...replayControls, replayCursorVisible: false }}
        replayCursorTrack={replayCursorTrack}
        mechanicsConfig={defaultMechanicsConfig}
        onMechanicsConfigChange={vi.fn()}
        mechanicsToggles={[]}
        debugActions={[]}
        onExecuteEncounterCommand={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('replay-cursor')).toBeNull();
    expect(screen.queryByTestId('replay-click-marker-red')).toBeNull();
    expect(document.body).not.toHaveAttribute(WATCH_GATE_ATTR);
    expect(elementFromPoint).not.toHaveBeenCalled();
  });

  it('pins the game UI at 100% while the Stretched Mode plugin is off, keeping the chosen scale', () => {
    const panelWidths = (stretchedModePluginEnabled: boolean) => {
      const view = render(
        <Grid
          simulationState={mockState}
          {...gridProps}
          uiScale={2}
          stretchedModePluginEnabled={stretchedModePluginEnabled}
          mechanicsConfig={defaultMechanicsConfig}
          onMechanicsConfigChange={vi.fn()}
          mechanicsToggles={[]}
          debugActions={[]}
          onExecuteEncounterCommand={vi.fn()}
        />,
      );
      const widths = Array.from(document.querySelectorAll<HTMLElement>('[role="presentation"]'))
        .filter((panel) => panel.querySelector('.panel-surface'))
        .map((panel) => Number.parseFloat(panel.style.width));
      view.unmount();
      return widths;
    };

    // The widest scaled panel is the game panel's icon bar: 237px at 100%.
    expect(Math.max(...panelWidths(true))).toBe(474);
    expect(Math.max(...panelWidths(false))).toBe(237);
  });

  it('carries the Status Bars value setting down to the side panel', () => {
    const renderBars = (statusBarsShowValues?: boolean) =>
      render(
        <Grid
          simulationState={mockState}
          {...gridProps}
          mechanicsConfig={defaultMechanicsConfig}
          onMechanicsConfigChange={vi.fn()}
          mechanicsToggles={[]}
          debugActions={[]}
          onExecuteEncounterCommand={vi.fn()}
          statusBarsEnabled
          statusBarsShowValues={statusBarsShowValues}
        />,
      );

    paintBarValueSpy.mockClear();
    const off = renderBars(false);
    expect(document.querySelector('[data-status-bars]')).not.toBeNull();
    expect(paintBarValueSpy).not.toHaveBeenCalled();
    off.unmount();

    paintBarValueSpy.mockClear();
    const on = renderBars(true);
    expect(paintBarValueSpy.mock.calls.map(([, spec]) => spec.current)).toEqual([
      mockState.playerHP,
      mockState.prayerState.points,
    ]);
    on.unmount();
  });

  describe('viewer-owned replay transport', () => {
    const spies: Array<{ mockRestore: () => void }> = [];

    function stubFrameSize(width: number, height: number) {
      spies.push(
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width),
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(height),
      );
    }

    afterEach(() => {
      for (const spy of spies.splice(0)) spy.mockRestore();
    });

    function renderDockedReplay(replayFrameScale: number, viewerWidth = 1024, overlayScale = 1) {
      const chromeHost = document.createElement('div');
      const transportHost = document.createElement('div');
      render(
        <WorkspaceDockContext value={{ chromeHost, cursorHost: null, transportHost }}>
          <Grid
            simulationState={mockState}
            {...gridProps}
            replayControls={replayControls}
            replayViewportWidth={viewerWidth}
            overlayScale={overlayScale}
            overlayOuterScale={replayFrameScale}
            mechanicsConfig={defaultMechanicsConfig}
            onMechanicsConfigChange={vi.fn()}
            mechanicsToggles={[]}
            debugActions={[]}
            onExecuteEncounterCommand={vi.fn()}
          />
        </WorkspaceDockContext>,
      );
      return { chromeHost, transportHost };
    }

    function transportTransform(host: HTMLElement, variant: 'full' | 'compact'): string | undefined {
      return host.querySelector<HTMLElement>(`.replay-bar--${variant}`)?.parentElement?.style.transform;
    }

    it('keeps the full transport outside a downscaled recording frame', () => {
      stubFrameSize(1600, 900);
      const { chromeHost, transportHost } = renderDockedReplay(0.5);

      expect(transportTransform(transportHost, 'full')).toBe('');
      expect(chromeHost.querySelector('.replay-bar')).toBeNull();
    });

    it('draws the transport at the viewer chrome zoom, never the recording frame scale', () => {
      stubFrameSize(1600, 900);
      // 1024 wide at zoom 2 is 512 of chrome: the compact bar.
      const { transportHost } = renderDockedReplay(0.5, 1024, 2);
      const transport = transportHost.querySelector<HTMLElement>('.replay-bar--compact')?.parentElement;
      expect(transport?.style.zoom).toBe('2');
      expect(transport?.style.transform).toBe('');
    });

    it('uses the same unscaled host for a compact viewer', () => {
      stubFrameSize(1024, 768);
      const { chromeHost, transportHost } = renderDockedReplay(0.5, 500);

      expect(transportTransform(transportHost, 'compact')).toBe('');
      expect(chromeHost.querySelector('.replay-bar')).toBeNull();
    });

    it.each([
      [721, 'full'],
      [720, 'compact'],
      [700, 'compact'],
      [699, 'compact'],
    ] as const)('uses only the %s-width transport presentation (%s)', (width, variant) => {
      stubFrameSize(1024, 768);
      const { transportHost } = renderDockedReplay(1, width);

      expect(transportHost.querySelector(`.replay-bar--${variant}`)).not.toBeNull();
    });

    describe('drawn over the chatbox, centered in the window', () => {
      const px = (value: string) => Number.parseFloat(value) || 0;

      /**
       * A window of `window` CSS pixels whose frame is drawn at `fit` from `origin`: the chatbox's
       * box is its frame-pixel style through that fit, and the bar (the dock's zoomed child) is
       * `bar.width` wide at `bar.x`, 40 tall, at the window's bottom. Should Grid ever measure them
       * again to move the bar off the chat, these are the boxes it would see overlapping.
       */
      function stubLayout(options: {
        window: { width: number; height: number };
        bar: { x: number; width: number };
        fit?: number;
        origin?: { x: number; y: number };
      }) {
        const { fit = 1, origin = { x: 0, y: 0 } } = options;
        vi.stubGlobal('innerWidth', options.window.width);
        vi.stubGlobal('innerHeight', options.window.height);
        spies.push({ mockRestore: () => vi.unstubAllGlobals() });
        spies.push(
          vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            if (this.classList.contains('chatbox')) {
              const { left, top, width, height } = this.style;
              return new DOMRect(
                origin.x + px(left) * fit,
                origin.y + px(top) * fit,
                px(width) * fit,
                px(height) * fit,
              );
            }
            if (this.parentElement?.classList.contains('replay-transport-dock')) {
              return new DOMRect(options.bar.x, options.window.height - 8 - 40, options.bar.width, 40);
            }
            return new DOMRect(0, 0, 0, 0);
          }),
        );
      }

      function renderReplay(props: Partial<ComponentProps<typeof Grid>> = {}) {
        return render(
          <Grid
            simulationState={mockState}
            {...gridProps}
            replayControls={replayControls}
            replayViewportWidth={1024}
            infoboxPinTarget="hud"
            showTickCounterInfobox
            mechanicsConfig={defaultMechanicsConfig}
            onMechanicsConfigChange={vi.fn()}
            mechanicsToggles={[]}
            debugActions={[]}
            onExecuteEncounterCommand={vi.fn()}
            {...props}
          />,
        );
      }

      const dock = () => document.querySelector<HTMLElement>('.replay-transport-dock');

      /** The dock keeps its stylesheet place: the window's bottom pad, centered between 8px margins. */
      function expectAtItsCssPlace() {
        const style = dock()?.style;
        expect(style).toBeDefined();
        expect(style?.bottom).toBe('');
        expect(style?.left).toBe('');
        expect(style?.right).toBe('');
        expect(style?.width).toBe('');
      }

      it.each([
        // Resizable: the chat at the window's bottom left, 0..519; the 500px bar centered at 262..762.
        ['modern', { width: 1024, height: 768 }, { x: 262, width: 500 }],
        ['classic', { width: 1024, height: 768 }, { x: 262, width: 500 }],
        // Fixed 1x: the chat at 0..519 by 338..503; a 420px bar centered at 172..592.
        ['fixed', { width: 765, height: 503 }, { x: 172, width: 420 }],
      ] as const)('stays put over a %s chat and its infobox rows, never pushed off them', (layout, size, bar) => {
        stubFrameSize(size.width, size.height);
        stubLayout({ window: size, bar });
        renderReplay({ clientLayoutMode: layout, replayViewportWidth: size.width });

        const chat = document.querySelector<HTMLElement>('.chatbox');
        expect(chat).not.toBeNull();
        expect(px(chat?.style.top ?? '') + px(chat?.style.height ?? '')).toBe(size.height);
        expect(document.querySelector('[data-tutorial="infobox-panel"]')).not.toBeNull();
        expectAtItsCssPlace();
      });

      it('stays put over the chat of a replay frame fitted into a smaller window', () => {
        // A 1920x1080 recording drawn at half size from (40, 20) in a 1040x600 window: the chat
        // (40..299.5 by 477.5..560) is under the bar (270..770 by 552..592).
        stubFrameSize(1920, 1080);
        stubLayout({
          window: { width: 1040, height: 600 },
          bar: { x: 270, width: 500 },
          fit: 0.5,
          origin: { x: 40, y: 20 },
        });
        renderReplay({ replayViewportWidth: 1040, overlayOuterScale: 0.5 });

        expect(document.querySelector('.chatbox')).not.toBeNull();
        expectAtItsCssPlace();
      });

      it('sizes its form from the window, wherever the chat is', () => {
        // A recorded 320px sidebar puts the chat at x=320 in a 765 window; the bar still takes the
        // window's width (765 > 720: the full form) rather than the room beside the chat.
        stubFrameSize(765, 503);
        stubLayout({ window: { width: 765, height: 503 }, bar: { x: 172, width: 420 } });
        renderReplay({ replayViewportWidth: 765, viewportInsets: { left: 320, right: 0, top: 0, bottom: 0 } });

        expect(document.querySelector('.replay-bar--full')).not.toBeNull();
        expect(dock()?.style.getPropertyValue('--transport-room')).toBe('749px');
        expectAtItsCssPlace();
      });

      it.each([
        ['Settings', 320, 0, '328px', ''],
        ['Plugins', 0, 280, '', '288px'],
      ])('bounds Fixed 1x transport beside %s and chooses compact from the remaining width', (_name, left, right, cssLeft, cssRight) => {
        stubFrameSize(765, 503);
        renderReplay({
          clientLayoutMode: 'fixed',
          replayViewportWidth: 765,
          uiInsets: { left: Number(left), right: Number(right), top: 0, bottom: 0 },
        });
        expect(dock()?.style.left).toBe(cssLeft);
        expect(dock()?.style.right).toBe(cssRight);
        expect(dock()?.style.getPropertyValue('--transport-room')).toBe(`${765 - Number(left) - Number(right) - 16}px`);
        expect(document.querySelector('.replay-bar--compact')).not.toBeNull();
      });

      it('uses both live drawer insets and accounts for chrome zoom without using frame fitting', () => {
        stubFrameSize(1920, 1080);
        renderReplay({
          replayViewportWidth: 1440,
          uiInsets: { left: 300, right: 260, top: 0, bottom: 0 },
          viewportInsets: { left: 0, right: 0, top: 0, bottom: 0 },
          chromeScale: 1.5,
          overlayOuterScale: 0.5,
        });
        expect(dock()?.style.left).toBe('308px');
        expect(dock()?.style.right).toBe('268px');
        expect(dock()?.style.getPropertyValue('--transport-room')).toBe('576px');
        expect(document.querySelector('.replay-bar--compact')).not.toBeNull();
      });

      it('bounds the bar to the available dock, and takes clicks only on the bar', () => {
        const css = readFileSync(join(__dirname, '..', 'components', 'ReplayControls.css'), 'utf8').replace(
          /\s+/g,
          ' ',
        );
        expect(css).toMatch(
          /\.replay-bar \{[^}]*max-width: min\(calc\(96vw \/ var\(--overlay-scale, 1\)\), calc\(var\(--transport-room, 100vw\) - 2px\)\);/,
        );
        // The dock spans the window's bottom over the chat; only the bar itself takes the pointer, so
        // the chat beside it keeps its clicks, wheel and scrollbar.
        expect(css).toMatch(/\.replay-transport-dock \{[^}]*pointer-events: none;/);
        expect(css).toMatch(/\.replay-bar \{[^}]*pointer-events: auto;/);
      });
    });
  });

  describe('a replay frame fitted into a smaller window', () => {
    // A 1920x1080 recording drawn at half size (App's transform: scale(0.5) on the frame), its
    // top-left at (40, 20) in the window.
    const FRAME = { width: 1920, height: 1080 };
    const FIT = 0.5;
    const ORIGIN = { x: 40, y: 20 };

    afterEach(() => {
      topChromeProps.current = null;
      bossBarProps.current = null;
    });

    it("hands the boss bar's default the window chrome in frame pixels, its gaps at the frame's scale", () => {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(FRAME.width);
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(FRAME.height);
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const frameRef = topChromeProps.current?.frameRef as { current: HTMLElement | null } | undefined;
        return this === frameRef?.current
          ? new DOMRect(ORIGIN.x, ORIGIN.y, FRAME.width * FIT, FRAME.height * FIT)
          : new DOMRect(0, 0, 0, 0);
      });
      render(
        <Grid
          simulationState={mockState}
          {...gridProps}
          chromeScale={2}
          topChrome={{
            settings: { open: false, inset: 0 },
            menu: { items: null, pinned: false },
            plugins: null,
            showFps: false,
          }}
          mechanicsConfig={defaultMechanicsConfig}
          onMechanicsConfigChange={vi.fn()}
          mechanicsToggles={[]}
          debugActions={[]}
          onExecuteEncounterCommand={vi.fn()}
        />,
      );
      const props = topChromeProps.current;
      if (!props) throw new Error('top chrome not mounted');
      const onRowChange = props.onRowChange as (rect: Rect | null) => void;
      const onPluginsChange = props.onPluginsChange as (rect: Rect | null) => void;

      // In window pixels, as the top chrome measures them.
      act(() => {
        onRowChange({ x: 48, y: 28, width: 300, height: 40 });
        onPluginsChange({ x: 900, y: 28, width: 60, height: 40 });
      });

      const slot = bossBarProps.current?.defaultSlot as { row: Rect; zoom: number; chrome: Rect[] } | undefined;
      expect(slot?.row).toEqual({ x: 16, y: 16, width: 600, height: 80 });
      expect(slot?.chrome).toEqual([{ x: 1720, y: 16, width: 120, height: 80 }]);
      // A chrome gap of 2 window px a unit is 4 frame px at half size.
      expect(slot?.zoom).toBe(2 / FIT);
    });

    it("centers the boss bar's default on the part of the scene the sidebars leave visible", () => {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(FRAME.width);
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(FRAME.height);
      const grid = (left: number, right: number) => (
        <Grid
          simulationState={mockState}
          {...gridProps}
          viewportInsets={{ left, right, top: 0, bottom: 0 }}
          mechanicsConfig={defaultMechanicsConfig}
          onMechanicsConfigChange={vi.fn()}
          mechanicsToggles={[]}
          debugActions={[]}
          onExecuteEncounterCommand={vi.fn()}
        />
      );
      const scene = () => (bossBarProps.current?.defaultSlot as { scene: Rect } | undefined)?.scene;
      const { rerender } = render(grid(0, 0));
      expect(scene()).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
      rerender(grid(320, 0));
      expect(scene()).toEqual({ x: 320, y: 0, width: 1600, height: 1080 });
      rerender(grid(320, 320));
      expect(scene()).toEqual({ x: 320, y: 0, width: 1280, height: 1080 });
    });

    it("passes App's combat-tutorial Replay suppression to the top chrome, keeping the replay controls", () => {
      // App's effectiveReplay hides the recording in a combat tutorial; the transport still has its controls.
      render(
        <Grid
          simulationState={mockState}
          {...gridProps}
          replayControls={{ ...replayControls, isReplaying: false, hasRecording: false }}
          topChrome={{
            settings: { open: false, inset: 0 },
            menu: { items: null, pinned: false },
            plugins: null,
            showFps: false,
            replaySuppressed: true,
          }}
          mechanicsConfig={defaultMechanicsConfig}
          onMechanicsConfigChange={vi.fn()}
          mechanicsToggles={[]}
          debugActions={[]}
          onExecuteEncounterCommand={vi.fn()}
        />,
      );
      expect(topChromeProps.current?.replaySuppressed).toBe(true);
      expect(topChromeProps.current?.replay).toMatchObject({ hasRecording: false });
    });

    it("reports the hint toast's corner in window pixels, through the frame's fit", () => {
      // Fixed 1x drawn at half size: the corner is one gap inside the 4px border, one gap above the
      // chat at y 338. In window pixels, from the frame's origin, at half size.
      const FIXED = { width: 765, height: 503 };
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(FIXED.width);
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(FIXED.height);
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const frameRef = topChromeProps.current?.frameRef as { current: HTMLElement | null } | undefined;
        return this === frameRef?.current
          ? new DOMRect(ORIGIN.x, ORIGIN.y, FIXED.width * FIT, FIXED.height * FIT)
          : new DOMRect(0, 0, 0, 0);
      });
      const onHintToastAnchorChange = vi.fn();
      const grid = (sidebar: number) => (
        <Grid
          simulationState={mockState}
          {...gridProps}
          clientLayoutMode="fixed"
          viewportInsets={{ left: sidebar, right: 0, top: 0, bottom: 0 }}
          topChrome={{
            settings: { open: false, inset: 0 },
            menu: { items: null, pinned: false },
            plugins: null,
            showFps: false,
          }}
          onHintToastAnchorChange={onHintToastAnchorChange}
          mechanicsConfig={defaultMechanicsConfig}
          onMechanicsConfigChange={vi.fn()}
          mechanicsToggles={[]}
          debugActions={[]}
          onExecuteEncounterCommand={vi.fn()}
        />
      );
      const { rerender } = render(grid(0));
      expect(onHintToastAnchorChange).toHaveBeenLastCalledWith({
        left: ORIGIN.x + (4 + 4) * FIT,
        top: ORIGIN.y + (338 - 4) * FIT,
      });

      // A sidebar over the frame's left: the corner stays inside the border, the toast clears the
      // sidebar.
      rerender(grid(60));
      expect(onHintToastAnchorChange).toHaveBeenLastCalledWith({
        left: ORIGIN.x + (60 + 4) * FIT,
        top: ORIGIN.y + (338 - 4) * FIT,
      });
    });

    it.each([
      { frame: 'stretched taller than wide (Stretch to Window)', scaleX: 1.5, scaleY: 2 },
      { frame: 'fitted at half size (a replay)', scaleX: FIT, scaleY: FIT },
    ])('stacks the hint toast on the Chatbox infoboxes in frame pixels, $frame', ({ scaleX, scaleY }) => {
      // Fixed 1x with one 32px tick-counter tile over the chat, its strip measured on screen (so
      // through the frame's transform): the toast rests one gap above the strip, at y 334 - 36.
      const FIXED = { width: 765, height: 503 };
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(FIXED.width);
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(FIXED.height);
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const frameRef = topChromeProps.current?.frameRef as { current: HTMLElement | null } | undefined;
        if (this === frameRef?.current) {
          return new DOMRect(ORIGIN.x, ORIGIN.y, FIXED.width * scaleX, FIXED.height * scaleY);
        }
        if (this.dataset.tutorial === 'infobox-panel') return new DOMRect(0, 0, 32 * scaleX, 32 * scaleY);
        return new DOMRect(0, 0, 0, 0);
      });
      const onHintToastAnchorChange = vi.fn();
      render(
        <Grid
          simulationState={mockState}
          {...gridProps}
          clientLayoutMode="fixed"
          infoboxPinTarget="hud"
          showTickCounterInfobox
          topChrome={{
            settings: { open: false, inset: 0 },
            menu: { items: null, pinned: false },
            plugins: null,
            showFps: false,
          }}
          onHintToastAnchorChange={onHintToastAnchorChange}
          mechanicsConfig={defaultMechanicsConfig}
          onMechanicsConfigChange={vi.fn()}
          mechanicsToggles={[]}
          debugActions={[]}
          onExecuteEncounterCommand={vi.fn()}
        />,
      );
      expect(onHintToastAnchorChange).toHaveBeenLastCalledWith({
        left: ORIGIN.x + (4 + 4) * scaleX,
        top: ORIGIN.y + (338 - 4 - (32 + 4)) * scaleY,
      });
    });
  });

  describe('Chatbox infoboxes under the viewer’s Mobile tools', () => {
    const VIEWPORT = { width: 1024, height: 768 };
    const STALE_POSITION = { x: 300, y: 200, anchorX: 'left', anchorY: 'top' } as const;

    afterEach(() => vi.restoreAllMocks());

    function mobileTools(): NonNullable<ComponentProps<typeof Grid>['mobileTools']> {
      return {
        state: DEFAULT_MOBILE_TOOL_WINDOW,
        onStateChange: vi.fn(),
        tutorialTarget: null,
        menuHostRef: () => {},
        frame: defaultOsmFrame(VIEWPORT, { top: 0, right: 0, bottom: 0, left: 0 }),
        viewport: VIEWPORT,
      };
    }

    function grid(props: Partial<ComponentProps<typeof Grid>>) {
      return (
        <Grid
          {...gridProps}
          simulationState={mockState}
          replayControls={replayControls}
          infoboxPinTarget="hud"
          showTickCounterInfobox
          mechanicsConfig={defaultMechanicsConfig}
          onMechanicsConfigChange={vi.fn()}
          mechanicsToggles={[]}
          debugActions={[]}
          onExecuteEncounterCommand={vi.fn()}
          {...props}
        />
      );
    }

    function renderGrid(props: Partial<ComponentProps<typeof Grid>>) {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(VIEWPORT.width);
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(VIEWPORT.height);
      return render(grid(props));
    }

    const infoboxPanels = () => document.querySelectorAll<HTMLElement>('[data-tutorial="infobox-panel"]');
    const tickCounters = () => document.querySelectorAll('[data-infobox-id="tick-counter"]');

    it.each([
      'modern',
      'classic',
      'fixed',
    ] as const)('shows them once, in the standalone strip, over a %s frame', (clientLayoutMode) => {
      const onInfoboxPositionChange = vi.fn();
      const { rerender } = renderGrid({ clientLayoutMode, mobileTools: mobileTools(), onInfoboxPositionChange });

      expect(document.querySelector('.osm-tools')).not.toBeNull();
      expect(document.querySelector('.replay-transport-dock')).toBeNull();
      expect(infoboxPanels()).toHaveLength(1);
      expect(tickCounters()).toHaveLength(1);
      expect(onInfoboxPositionChange).not.toHaveBeenCalled();

      // A desktop viewer again: back at the chatbox, still once.
      rerender(grid({ clientLayoutMode, onInfoboxPositionChange }));
      expect(document.querySelector('.osm-tools')).toBeNull();
      expect(infoboxPanels()).toHaveLength(1);
      expect(tickCounters()).toHaveLength(1);
    });

    it('places the strip at its default, ignoring a stale saved position', () => {
      const placement = (infoboxPosition: ComponentProps<typeof Grid>['infoboxPosition']) => {
        const view = renderGrid({ mobileTools: mobileTools(), infoboxPosition });
        const transform = infoboxPanels()[0]?.style.transform;
        view.unmount();
        vi.restoreAllMocks();
        return transform;
      };

      const unsaved = placement(null);
      expect(unsaved).toBeTruthy();
      expect(placement(STALE_POSITION)).toBe(unsaved);
    });

    it("rests the hint toast clear of the viewer's Mobile left column", () => {
      const onHintToastAnchorChange = vi.fn();
      const tools = mobileTools();
      renderGrid({ mobileTools: tools, onHintToastAnchorChange });
      if (!tools.frame) throw new Error('no Mobile frame');

      expect(onHintToastAnchorChange.mock.lastCall?.[0].left).toBe(osmLeftColumnRight(tools.frame) + 4);
    });

    it('leaves a Mobile frame on its native buff bar', () => {
      renderGrid({ clientLayoutMode: 'mobile', mobileTools: mobileTools() });

      expect(document.querySelector('.infobox-strip--osm-buff-bar')).not.toBeNull();
      expect(infoboxPanels()).toHaveLength(0);
      expect(tickCounters()).toHaveLength(1);
    });
  });
});
