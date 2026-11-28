// @vitest-environment happy-dom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App, { App as HarnessApp } from '../App';
import { DraggablePanel } from '../components/DraggablePanel';
import type { TopChromeProps } from '../components/launcher/TopChrome';
import { PanelSnapRegistryProvider } from '../components/snap/PanelSnapRegistry';
import { ReplayPresentationProvider } from '../contexts/ReplayPresentationContext';
import { setArenaConfig } from '../core/constants';
import { ReplayRecorder } from '../core/ReplayRecorder';
import type { ReplayPresentationState } from '../core/replayPresentation';
import { SimulationEngine } from '../core/SimulationEngine';
import { EQUIPMENT_PRESETS } from '../data/playerPresets';
import type { DevHarnessSource } from '../harness/devHarnessTypes';
import { AUTO_SETTLE_MS } from '../hooks/useAutoOverlayScale';
import type { UIPosition } from '../hooks/usePersistedSettings';
import type { RenderStatus } from '../render/core/renderer';
import { ReplayPresentationStateSchema } from '../replay/format/presentationFormat';
import * as replayCapture from '../replay/replayCapture';
import { TUTORIAL_PROGRESS_KEY } from '../tutorial/persistence';
import type { ReplayPracticeControls } from '../types/replayPractice';
import { animationFrames } from '../util/animationFrames';
import { DEVICE_MODE_STORAGE_KEY, resetDeviceModeForTests, setDeviceMode } from '../util/deviceMode';
import { detectGpuStatus } from '../util/gpuDetection';
import { deleteSetting, loadSetting, saveSetting } from '../util/storage';

const cacheBootstrapTestState = vi.hoisted(() => ({ isFullyLoaded: false }));
const drawerRenders = vi.hoisted(() => ({ plugins: vi.fn(), settings: vi.fn(), app: vi.fn() }));

// Probe one unconditional body child per drawer, retaining the real controls.
vi.mock('../components/ui/OsrsToggle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/ui/OsrsToggle')>();
  const OsrsToggle: typeof actual.OsrsToggle = (props) => {
    if (props.accessibleLabel === 'Anti Drag') drawerRenders.plugins();
    return <actual.OsrsToggle {...props} />;
  };
  return { ...actual, OsrsToggle };
});
vi.mock('../components/CollapsibleSection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/CollapsibleSection')>();
  const CollapsibleSection: typeof actual.CollapsibleSection = (props) => {
    if (props.title === 'Simulation') drawerRenders.settings();
    return <actual.CollapsibleSection {...props} />;
  };
  return { ...actual, CollapsibleSection };
});
vi.mock('../hooks/useAutoOverlayScale', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useAutoOverlayScale')>();
  const useAutoOverlayScales: typeof actual.useAutoOverlayScales = (...args) => {
    drawerRenders.app();
    return actual.useAutoOverlayScales(...args);
  };
  return { ...actual, useAutoOverlayScales };
});

afterEach(() => {
  for (const probe of Object.values(drawerRenders)) probe.mockClear();
});
const layoutCaptureTestState = vi.hoisted(() => ({
  enabled: false,
  width: 1000,
  height: 800,
  setExclusion: null as ((enabled: boolean) => void) | null,
}));

vi.mock('../util/gpuDetection', () => ({
  detectGpuStatus: vi.fn(() => ({
    status: 'hardware',
    renderer: 'Test GPU',
    vendor: 'Test Vendor',
  })),
}));

vi.mock('../hooks/useCacheBootstrap', () => ({
  useCacheBootstrap: () => ({
    bootstrapState: {
      cacheDownloadState: { status: cacheBootstrapTestState.isFullyLoaded ? 'success' : 'idle' },
      isFullyLoaded: cacheBootstrapTestState.isFullyLoaded,
    },
    loaders: {
      animationSystem: null,
      enumTypeLoader: null,
      locModelLoader: null,
      mapLoader: null,
      minimapNpcDotUrl: null,
      modelLoader: null,
      npcModelLoader: null,
      npcTypeLoader: null,
      objTypeLoader: null,
      overlayLoader: null,
      playerModelLoader: null,
      spotAnimLoader: null,
      spotAnimModelLoader: null,
      structTypeLoader: null,
      textureLoader: null,
      underlayLoader: null,
    },
    actions: { handleCacheRetry: vi.fn() },
  }),
}));

type GridTopChrome = Pick<TopChromeProps, 'menu' | 'settings' | 'plugins' | 'showFps' | 'elevated'>;

const arenaProps = vi.hoisted(() => ({
  current: null as {
    onSceneReady?: () => void;
    statusBarsShowValues?: boolean;
    overlayScale?: number;
    chromeScale?: number;
    stretchedModePluginEnabled?: boolean;
    replayPaused?: boolean;
    replayPractice?: ReplayPracticeControls;
    exitReplay?: () => void;
    enterReplay?: () => void;
    takeOver?: () => void | Promise<void>;
    onUiScaleChange?: (scale: number) => void;
    uiScale?: number;
    renderStatus?: RenderStatus;
    onRenderStatusChange?: (status: RenderStatus) => void;
    graphicsHeld?: boolean;
    graphicsHeldActivity?: 'fight' | 'replay' | null;
  } | null,
}));

vi.mock('../components/Grid', async () => {
  const { useEffect, useState } = await import('react');
  const { DraggablePanel } = await import('../components/DraggablePanel');
  const { useSimulationContext } = await import('../contexts/SimulationContext');
  const { useSettingsContext } = await import('../contexts/SettingsContext');
  return {
    Grid: (props: {
      sceneOverlay?: ReactNode;
      onSceneReady?: () => void;
      statusBarsShowValues?: boolean;
      compactOrbs?: boolean;
      overlayScale?: number;
      chromeScale?: number;
      zukSetTimerPosition?: UIPosition | null;
      topChrome?: GridTopChrome;
      replayPractice?: ReplayPracticeControls;
      renderStatus?: RenderStatus;
      onRenderStatusChange?: (status: RenderStatus) => void;
      graphicsHeld?: boolean;
      graphicsHeldActivity?: 'fight' | 'replay' | null;
    }) => {
      const simulation = useSimulationContext();
      const settings = useSettingsContext();
      const [exclude, setExclusion] = useState(false);
      layoutCaptureTestState.setExclusion = setExclusion;
      arenaProps.current = {
        ...props,
        replayPaused: simulation?.replayPaused,
        exitReplay: simulation?.replayControls?.onExitReplay,
        enterReplay: simulation?.replayControls?.onEnterReplay,
        takeOver: simulation?.replayControls?.onTakeOver,
        onUiScaleChange: settings?.onUiScaleChange,
        uiScale: settings?.uiScale,
      };
      useEffect(() => props.onSceneReady?.(), [props.onSceneReady]);
      // What App hands the desktop top chrome (launcher/TopChrome.tsx, tested on its own): the menu's
      // buttons (Settings first) and Plugins, drawn here at the chrome's zoom. The row moves past the
      // open Settings drawer rather than tucking under it.
      const top = props.topChrome;
      const chrome = top && (
        <>
          <nav
            aria-label="Game menu"
            style={{ zoom: props.chromeScale, left: top.settings.open ? top.settings.inset : 0 }}
          >
            {top.menu.items}
          </nav>
          {top.plugins && (
            <nav
              className="top-chrome-plugins"
              style={{ zoom: props.chromeScale, right: top.plugins.open ? top.plugins.inset : 0 }}
              inert={top.plugins.open && top.plugins.inset === 0}
            >
              <button type="button" title="Open Plugins" aria-pressed={top.plugins.open} onClick={top.plugins.onToggle}>
                Plugins
              </button>
            </nav>
          )}
        </>
      );
      // The layout-capture test mounts the real placement/registry path under App
      // without requiring the unrelated GPU/cache-backed Grid contents.
      if (layoutCaptureTestState.enabled && settings) {
        const boxes = [
          {
            name: 'game-panel',
            position: settings.gamePanelPosition,
            width: 200,
            height: 200,
            changed: settings.onGamePanelPositionChange,
          },
          {
            name: 'minimap',
            position: props.compactOrbs ? settings.compactOrbsPosition : settings.minimapPosition,
            width: 160,
            height: 100,
            changed: props.compactOrbs ? settings.onCompactOrbsPositionChange : settings.onMinimapPositionChange,
          },
          {
            name: 'infobox-panel',
            position: settings.infoboxPosition ?? undefined,
            width: 100,
            height: 100,
            changed: settings.onInfoboxPositionChange,
          },
          {
            name: 'zuk-set-timer-overlay',
            position: props.zukSetTimerPosition ?? undefined,
            width: 208,
            height: 134,
            changed: undefined,
          },
        ];
        return (
          <>
            {chrome}
            {props.sceneOverlay}
            {boxes.map((box) => (
              <DraggablePanel
                key={box.name}
                dataTutorial={box.name}
                defaultPosition={{ x: 359, y: 74, anchorX: 'left', anchorY: 'top' }}
                position={box.position}
                width={box.width}
                height={box.height}
                scale={box.name === 'zuk-set-timer-overlay' ? props.overlayScale : settings.uiScale}
                viewportWidth={layoutCaptureTestState.width}
                viewportHeight={layoutCaptureTestState.height}
                exclusionRects={
                  exclude && box.name === 'game-panel' ? [{ left: 500, top: 0, right: 900, bottom: 1000 }] : undefined
                }
                onPositionChange={box.changed}
              >
                content
              </DraggablePanel>
            ))}
          </>
        );
      }
      return (
        <>
          {chrome}
          {props.sceneOverlay}
        </>
      );
    },
  };
});

describe('BrowserSupportGate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cacheBootstrapTestState.isFullyLoaded = false;
  });

  it('blocks the app when WebGL2 is unavailable', () => {
    vi.mocked(detectGpuStatus).mockReturnValueOnce({
      status: 'no-webgl2',
      renderer: null,
      vendor: null,
    });
    const { container } = render(<App />);

    expect(container.querySelector('.browser-support')).not.toBeNull();
    expect(screen.getByRole('heading', { name: '3D graphics unavailable' })).toBeDefined();
    expect(screen.queryByTitle('Open Settings')).toBeNull();
  });

  it('does not block the app when WebAssembly is unavailable', () => {
    vi.stubGlobal('WebAssembly', undefined);
    cacheBootstrapTestState.isFullyLoaded = true;
    const { container } = render(<App />);

    expect(container.querySelector('.browser-support')).toBeNull();
    expect(screen.getByTitle('Open Settings')).toBeDefined();
  });
});

describe('App', () => {
  // The menu is the top chrome's, drawn with the game (behind the loading screen until then).
  const withGame = () => {
    cacheBootstrapTestState.isFullyLoaded = true;
  };
  afterEach(() => {
    cacheBootstrapTestState.isFullyLoaded = false;
  });

  it('renders the main shell and simulation controls', () => {
    withGame();
    render(<App />);
    expect(screen.getAllByText(/SCIM\.GG/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Simulation')).toBeDefined();
    fireEvent.click(screen.getByTitle('Open Settings'));
    fireEvent.click(screen.getByText('Simulation'));
    expect(screen.getByText(/Restart Simulation/)).toBeDefined();
  });

  it('shows and toggles the coordinate overlay in plugins', () => {
    render(<App />);
    const openPlugins = screen.queryByTitle('Open Plugins');
    if (openPlugins) fireEvent.click(openPlugins);
    fireEvent.click(screen.getByText('Debug Overlays'));
    const checkbox = screen.getByRole('checkbox', { name: 'Coordinate Overlay' });
    expect(checkbox).toBeDefined();
    fireEvent.click(checkbox);
  });

  it('stages native Tile Indicator color input until the final change event', () => {
    withGame();
    localStorage.removeItem('osrs-tile-indicators');
    const { container } = render(<App />);
    fireEvent.click(screen.getByTitle('Open Settings'));
    fireEvent.click(screen.getByTitle('Open Plugins'));
    fireEvent.click(screen.getByText('Tile Indicators'));
    const pluginsPanel = container.querySelector('.plugins-content');
    if (pluginsPanel === null) {
      throw new Error('Expected the Plugins panel to be rendered');
    }
    const swatch = pluginsPanel.querySelector<HTMLInputElement>('.ti-swatch input[type=color]');
    if (swatch === null) {
      throw new Error('Expected the first Tile Indicators color swatch to be rendered');
    }

    fireEvent.change(swatch, { target: { value: '#0e8fdb' } });
    expect(localStorage.getItem('osrs-tile-indicators')).toBeNull();

    fireEvent.input(swatch, { target: { value: '#112233' } });
    fireEvent.input(swatch, { target: { value: '#223344' } });
    fireEvent.input(swatch, { target: { value: '#445566' } });

    expect(swatch.value).toBe('#445566');
    expect(localStorage.getItem('osrs-tile-indicators')).toBeNull();

    fireEvent.change(swatch, { target: { value: '#445566' } });
    const storedConfig = JSON.parse(localStorage.getItem('osrs-tile-indicators') ?? '{}');
    expect(storedConfig.config.trueTile.color).toBe('#445566');
  });

  it('opens the quick search from the menu, which names its shortcut', () => {
    withGame();
    render(<App />);

    const item = screen.getByRole('button', { name: /Quick search/ });
    expect(item.textContent).toContain('Ctrl+K');
    fireEvent.click(item);

    expect(screen.getByRole('dialog', { name: 'Quick search' })).toBeDefined();
  });

  it('opens the Keyboard Shortcuts reference itself from a search result', () => {
    withGame();
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /Quick search/ }));
    const field = within(screen.getByRole('dialog', { name: 'Quick search' })).getByRole('combobox');
    fireEvent.change(field, { target: { value: 'shortcuts reference' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(screen.queryByRole('dialog', { name: 'Quick search' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Shortcuts' })).toBeDefined();
    // Not by way of the Settings drawer: it stays closed.
    expect(document.querySelector('.controls-overlay.open')).toBeNull();
  });

  describe('Ctrl+K over another modal', () => {
    const ctrlK = () => {
      act(() => {
        fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
      });
    };
    const quickSearch = () => screen.queryByRole('dialog', { name: 'Quick search' });

    it('closes the Keyboard Shortcuts reference', () => {
      withGame();
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: /Quick search/ }));
      const field = within(quickSearch() as HTMLElement).getByRole('combobox');
      fireEvent.change(field, { target: { value: 'shortcuts reference' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(screen.getByRole('heading', { name: 'Shortcuts' })).toBeDefined();

      ctrlK();

      expect(screen.queryByRole('heading', { name: 'Shortcuts' })).toBeNull();
      expect(quickSearch()).not.toBeNull();
    });

    it("does nothing over an encounter's loadout editor", () => {
      withGame();
      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: 'Encounters' }));
      fireEvent.click(screen.getByRole('button', { name: /Fortis Colosseum/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
      const editor = screen.getByRole('dialog', { name: 'Fortis Colosseum' });

      ctrlK();

      expect(quickSearch()).toBeNull();
      expect(editor.isConnected).toBe(true);
    });
  });

  // Keyboard and focus policy: a menu button that kept focus would take Space or Enter from the game.
  // Explicit timeout: this renders the whole App, boots a real SimulationEngine and
  // drives a tutorial reset. ~0.8s on a fast machine but ~10s on a slower one where
  // every worker contends for 2 cores - well past the 5s vitest default.
  it('applies tutorial preset supplies after resetting the current encounter', async () => {
    // Yama is already loaded with supplies that differ from the Basics preset.
    cacheBootstrapTestState.isFullyLoaded = true;
    window.history.replaceState(null, '', '/yama');
    const activeEngine: { current: SimulationEngine | null } = { current: null };
    const originalGetState = SimulationEngine.prototype.getState;
    const getStateSpy = vi.spyOn(SimulationEngine.prototype, 'getState').mockImplementation(function (
      this: SimulationEngine,
    ) {
      activeEngine.current = this;
      return originalGetState.call(this);
    });
    render(<App />);
    const trainingButton = await screen.findByTitle('Training');
    await waitFor(() => expect(activeEngine.current?.getRunConfig().encounter.kind).toBe('yama_p3'));
    const engine = activeEngine.current;
    if (engine === null) throw new Error('Expected the active simulation engine');
    engine.setCombatSupplies({
      equippedAmmo: { id: 9242 },
      quiverAmmo: null,
      runePouch: null,
      blowpipe: null,
      selectedSpell: null,
      spellbook: 'arceuus' as const,
    });

    // The same-encounter Basics tutorial enters Tutorial Mode and resets.
    fireEvent.click(trainingButton);
    fireEvent.click(screen.getByRole('button', { name: /Yama/ }));
    expect(screen.getByRole('heading', { level: 2, name: 'Basics' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Begin' }));

    // The preset's pouch supplies replace the stale ammo preserved by reset().
    await waitFor(() =>
      expect(activeEngine.current?.getCombatSupplies()).toEqual(EQUIPMENT_PRESETS.yama_p3['max-mage'].supplies),
    );
    getStateSpy.mockRestore();
    cacheBootstrapTestState.isFullyLoaded = false;
    window.history.replaceState(null, '', '/');
  }, 30000);
});

describe('App tutorial setup isolation', () => {
  afterEach(() => {
    cacheBootstrapTestState.isFullyLoaded = false;
    localStorage.removeItem('osrs-yama-settings');
    deleteSetting('osrs-encounter-equipment');
    window.history.replaceState(null, '', '/');
    setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
  });

  it('runs a lesson in its own options and gear, saving none of it, and returns to the saved ones on exit', async () => {
    cacheBootstrapTestState.isFullyLoaded = true;
    window.history.replaceState(null, '', '/yama');
    const savedMechanics = { yama_p3: { infiniteSpecialAttack: true } };
    localStorage.setItem('osrs-yama-settings', JSON.stringify({ mechanicsConfigPerEncounter: savedMechanics }));
    const savedGear = { weapon: EQUIPMENT_PRESETS.yama_p3['max-mage'].equipment.weapon };
    saveSetting('osrs-encounter-equipment', {
      yama_p3: {
        equipment: savedGear,
        inventory: EQUIPMENT_PRESETS.yama_p3['max-mage'].inventory,
        supplies: EQUIPMENT_PRESETS.yama_p3['max-mage'].supplies,
      },
    });
    const source: { ref: { readonly current: DevHarnessSource | null } | null } = { ref: null };
    render(<HarnessApp devHarness={{ onReady: (ref) => (source.ref = ref) }} />);
    const harness = () => source.ref?.current ?? expect.fail('Expected the harness source');
    await waitFor(() => expect(harness().sceneKind).toBe('encounter'));
    const settingsBefore = localStorage.getItem('osrs-yama-settings');
    const gearBefore = JSON.stringify(loadSetting('osrs-encounter-equipment'));

    act(() => harness().ui.startTutorial('yama-basics'));
    await waitFor(() => expect(harness().engine.getState().mechanicsConfig.infiniteHealth).toBe(true));
    await waitFor(() =>
      expect(harness().engine.playerEquipment).toEqual(EQUIPMENT_PRESETS.yama_p3['max-mage'].equipment),
    );
    // The lesson plays the defaults, not the saved Infinite Special Attack.
    expect(harness().engine.getState().mechanicsConfig.infiniteSpecialAttack).toBe(false);
    expect(localStorage.getItem('osrs-yama-settings')).toBe(settingsBefore);
    expect(JSON.stringify(loadSetting('osrs-encounter-equipment'))).toBe(gearBefore);

    fireEvent.click(screen.getByRole('button', { name: 'Exit Training' }));
    await waitFor(() => expect(harness().engine.getState().mechanicsConfig.infiniteHealth).toBe(false));
    expect(harness().engine.getState().mechanicsConfig.infiniteSpecialAttack).toBe(true);
    expect(harness().engine.playerEquipment).toEqual(savedGear);
    expect(localStorage.getItem('osrs-yama-settings')).toBe(settingsBefore);
    expect(JSON.stringify(loadSetting('osrs-encounter-equipment'))).toBe(gearBefore);
  }, 30000);
});

describe('App replay practice wiring', () => {
  afterEach(() => {
    cacheBootstrapTestState.isFullyLoaded = false;
    deleteSetting('osrs-yama-settings');
    window.history.replaceState(null, '', '/');
    setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
  });

  it('wires independent takeover, atomic Practice, retry and clearing', async () => {
    cacheBootstrapTestState.isFullyLoaded = true;
    window.history.replaceState(null, '', '/yama');
    localStorage.setItem('osrs-yama-settings', JSON.stringify({ autoAdvance: false }));
    const source: { ref: { readonly current: DevHarnessSource | null } | null } = { ref: null };
    render(
      <HarnessApp
        devHarness={{
          onReady: (ref) => {
            source.ref = ref;
          },
        }}
      />,
    );
    await waitFor(() => expect(source.ref?.current?.sceneKind).toBe('encounter'));
    act(() => source.ref?.current?.fastForwardTo(8));
    expect(arenaProps.current?.replayPractice).toBeDefined();
    act(() => arenaProps.current?.enterReplay?.());
    // Take over at tick 8 restores tick 7 and drops frame 8; Practice then picks tick 7 (anchor 6).
    await act(async () => arenaProps.current?.takeOver?.());
    expect(arenaProps.current?.replayPractice?.startTick).toBeNull();
    expect(source.ref?.current?.engine.currentTick).toBe(7);
    act(() => arenaProps.current?.enterReplay?.());
    const selectedEngine = source.ref?.current?.engine;
    await act(async () => {
      await arenaProps.current?.replayPractice?.onStartPractice();
    });
    expect(source.ref?.current?.engine).not.toBe(selectedEngine);
    expect(source.ref?.current?.engine.currentTick).toBe(6);
    expect(arenaProps.current?.replayPractice?.startFrameIndex).toBe(7);
    expect(arenaProps.current?.replayPractice?.startTick).toBe(7);
    act(() => source.ref?.current?.fastForwardTo(12));
    fireEvent.keyDown(window, { key: 'r', ctrlKey: true });
    await waitFor(() => expect(source.ref?.current?.engine.currentTick).toBe(6));
    expect(arenaProps.current?.replayPractice?.startTick).toBe(7);
    act(() => arenaProps.current?.replayPractice?.onClearStart());
    expect(arenaProps.current?.replayPractice?.startTick).toBeNull();
    expect(source.ref?.current?.engine.currentTick).toBe(6);
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(source.ref?.current?.engine.currentTick).toBe(6);
    expect(arenaProps.current?.replayPractice?.startTick).toBeNull();
    fireEvent.keyDown(window, { key: 'r', metaKey: true });
    expect(source.ref?.current?.engine.currentTick).toBe(0);
  }, 30000);
});

describe('App preserves edited encounter loadouts', () => {
  const preset = Object.values(EQUIPMENT_PRESETS.sol_heredit)[0];
  const stripped = { weapon: preset.equipment.weapon };

  beforeEach(() => {
    cacheBootstrapTestState.isFullyLoaded = true;
    window.history.replaceState(null, '', '/');
    saveSetting('osrs-encounter-equipment', {
      sol_heredit: { equipment: stripped, inventory: preset.inventory, supplies: preset.supplies },
    });
  });

  afterEach(() => {
    cacheBootstrapTestState.isFullyLoaded = false;
    deleteSetting('osrs-encounter-equipment');
    window.history.replaceState(null, '', '/');
    setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
  });

  function renderHarness() {
    const source: { ref: { readonly current: DevHarnessSource | null } | null } = { ref: null };
    render(<HarnessApp devHarness={{ onReady: (ref) => (source.ref = ref) }} />);
    return () => {
      const current = source.ref?.current;
      if (!current) expect.fail('Expected the harness source');
      return current;
    };
  }

  function openSolPicker() {
    fireEvent.click(screen.getByRole('button', { name: 'Encounters' }));
    fireEvent.click(screen.getByRole('button', { name: /Fortis Colosseum/ }));
  }

  const storedLoadout = () => loadSetting<Record<string, unknown>>('osrs-encounter-equipment')?.sol_heredit;

  it('keeps a configurer edit through Start, restarts, the lobby and ordinary Enter', async () => {
    const harness = renderHarness();
    const namedPresets = loadSetting('osrs-custom-equipment-presets');
    openSolPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
    fireEvent.click(screen.getByRole('button', { name: /^Weapon:/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear slot' }));
    const editedLoadout = { equipment: {}, inventory: preset.inventory, supplies: preset.supplies };
    await waitFor(() => expect(storedLoadout()).toEqual(editedLoadout));
    expect(
      screen.getAllByText('This loadout is not saved as a preset. Starting the encounter will not save it.').length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Start Encounter' }));
    await waitFor(() => expect(harness().sceneKind).toBe('encounter'));
    expect(harness().engine.playerEquipment).toEqual({});
    expect(storedLoadout()).toEqual(editedLoadout);

    // Practice's Restart fight, Ctrl+R and the death and victory retries.
    await act(async () => harness().reset());
    expect(harness().engine.playerEquipment).toEqual({});

    // The Modifiers dialog's restart re-enters the encounter rather than resetting it.
    const loadId = harness().sceneLoadId;
    act(() => harness().ui.openModifiers());
    fireEvent.click(screen.getByRole('button', { name: 'Restart fight' }));
    await waitFor(() => expect(harness().sceneLoadId).not.toBe(loadId));
    expect(harness().engine.playerEquipment).toEqual({});
    expect(storedLoadout()).toEqual(editedLoadout);

    // Browser navigation returns to the lobby; the picker then uses ordinary Enter, not Configure.
    act(() => {
      window.history.replaceState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(harness().sceneKind).toBe('lobby'));
    expect(storedLoadout()).toEqual(editedLoadout);
    const savedMap = loadSetting('osrs-encounter-equipment');
    openSolPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
    await waitFor(() => expect(harness().sceneKind).toBe('encounter'));
    expect(harness().engine.playerEquipment).toEqual({});
    expect(storedLoadout()).toEqual(editedLoadout);
    expect(loadSetting('osrs-encounter-equipment')).toEqual(savedMap);
    expect(loadSetting('osrs-custom-equipment-presets')).toEqual(namedPresets);
  }, 30000);

  it('uses sparse saved gear on direct Enter without rewriting the saved loadout', async () => {
    const harness = renderHarness();
    const savedMap = loadSetting('osrs-encounter-equipment');
    openSolPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
    await waitFor(() => expect(harness().sceneKind).toBe('encounter'));
    expect(harness().engine.playerEquipment).toEqual(stripped);
    expect(loadSetting('osrs-encounter-equipment')).toEqual(savedMap);
  }, 30000);
});

describe('App encounter modifier selection', () => {
  afterEach(() => {
    cacheBootstrapTestState.isFullyLoaded = false;
    localStorage.removeItem('osrs-yama-settings');
    window.history.replaceState(null, '', '/');
    setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
  });

  function openSolPicker() {
    fireEvent.click(screen.getByRole('button', { name: 'Encounters' }));
    fireEvent.click(screen.getByRole('button', { name: /Fortis Colosseum/ }));
  }

  it('remembers modifiers through reopen, Start and Enter, an all-off choice included, and resets them', async () => {
    cacheBootstrapTestState.isFullyLoaded = true;
    window.history.replaceState(null, '', '/');
    const source: { ref: { readonly current: DevHarnessSource | null } | null } = { ref: null };
    render(
      <HarnessApp
        devHarness={{
          onReady: (ref) => {
            source.ref = ref;
          },
        }}
      />,
    );
    const runModifiers = () => source.ref?.current?.engine.getRunConfig().bootstrap?.encounterConfig;
    const storedSettings = () => JSON.parse(localStorage.getItem('osrs-yama-settings') ?? '{}');

    openSolPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
    await waitFor(() => expect(source.ref?.current?.sceneKind).toBe('encounter'));
    expect(runModifiers()).toEqual({ modifiers: { blasphemy: 3 } });

    openSolPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
    fireEvent.click(screen.getByRole('button', { name: 'Details & edit' }));
    expect(screen.getByRole('button', { name: 'Blasphemy tier III' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Doom tier II' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Fortis Colosseum' })).getByRole('button', { name: 'Close' }),
    );
    expect(storedSettings().modifiersPerEncounter).toEqual({ sol_heredit: { blasphemy: 3, doom: 2 } });

    // Reopening shows the choice; every modifier off is a choice too.
    openSolPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
    fireEvent.click(screen.getByRole('button', { name: 'Details & edit' }));
    expect(screen.getByRole('button', { name: 'Blasphemy tier III' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Doom tier II' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Blasphemy off' }));
    fireEvent.click(screen.getByRole('button', { name: 'Doom off' }));
    expect(screen.queryByRole('button', { name: 'Start Encounter' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Return to setup' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start Encounter' }));
    await waitFor(() => expect(source.ref?.current?.sceneKind).toBe('encounter'));
    expect(runModifiers()).toBeUndefined();
    expect(storedSettings().modifiersPerEncounter).toEqual({ sol_heredit: {} });

    // Ordinary Enter uses the remembered choice rather than the descriptor default.
    const loadId = source.ref?.current?.sceneLoadId;
    openSolPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
    await waitFor(() => expect(source.ref?.current?.sceneLoadId).not.toBe(loadId));
    expect(runModifiers()).toBeUndefined();

    // Reset to defaults brings the descriptor default back.
    openSolPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    await waitFor(() => expect(storedSettings().modifiersPerEncounter).toEqual({}));
    // At the defaults the reset gives way to its Undo, which puts the remembered choice back.
    expect(screen.queryByRole('button', { name: 'Reset to defaults' })).toBeNull();
    expect(screen.getByText('Defaults restored')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(storedSettings().modifiersPerEncounter).toEqual({ sol_heredit: {} }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    await waitFor(() => expect(storedSettings().modifiersPerEncounter).toEqual({}));
    fireEvent.click(screen.getByRole('button', { name: 'Start Encounter' }));
    await waitFor(() => expect(runModifiers()).toEqual({ modifiers: { blasphemy: 3 } }));
  }, 30000);
});

describe('App remembered encounter setup', () => {
  afterEach(() => {
    cacheBootstrapTestState.isFullyLoaded = false;
    localStorage.removeItem('osrs-yama-settings');
    window.history.replaceState(null, '', '/');
    setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
  });

  function renderHarness() {
    const source: { ref: { readonly current: DevHarnessSource | null } | null } = { ref: null };
    render(<HarnessApp devHarness={{ onReady: (ref) => (source.ref = ref) }} />);
    return () => {
      const current = source.ref?.current;
      if (!current) expect.fail('Expected the harness source');
      return current;
    };
  }
  const storedMechanics = () =>
    JSON.parse(localStorage.getItem('osrs-yama-settings') ?? '{}').mechanicsConfigPerEncounter ?? {};

  it('keeps saved mechanics through Configure, its Close, picker Enter, the lobby and the URL route', async () => {
    cacheBootstrapTestState.isFullyLoaded = true;
    window.history.replaceState(null, '', '/');
    const saved = { sol_heredit: { infiniteHealth: true, infiniteSpecialAttack: true } };
    localStorage.setItem('osrs-yama-settings', JSON.stringify({ mechanicsConfigPerEncounter: saved }));
    const harness = renderHarness();

    fireEvent.click(screen.getByRole('button', { name: 'Encounters' }));
    fireEvent.click(screen.getByRole('button', { name: /Fortis Colosseum/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
    expect(screen.getByRole('checkbox', { name: 'Infinite Health' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Close encounter panel' }));
    expect(storedMechanics()).toEqual(saved);

    fireEvent.click(screen.getByRole('button', { name: 'Encounters' }));
    fireEvent.click(screen.getByRole('button', { name: /Fortis Colosseum/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
    await waitFor(() => expect(harness().sceneKind).toBe('encounter'));
    expect(harness().engine.getState().mechanicsConfig).toMatchObject(saved.sol_heredit);

    act(() => {
      window.history.replaceState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(harness().sceneKind).toBe('lobby'));
    act(() => {
      window.history.replaceState(null, '', '/colosseum/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(harness().sceneKind).toBe('encounter'));
    expect(harness().engine.getState().mechanicsConfig).toMatchObject(saved.sol_heredit);
    expect(storedMechanics()).toEqual(saved);
  }, 30000);

  it('opens the former /sol-heredit link on wave 12 without wiping the rest of the saved Colosseum options', async () => {
    cacheBootstrapTestState.isFullyLoaded = true;
    const solHeredit = { colosseumStartWave: '5', infiniteHealth: true };
    localStorage.setItem(
      'osrs-yama-settings',
      JSON.stringify({ mechanicsConfigPerEncounter: { sol_heredit: solHeredit } }),
    );
    window.history.replaceState(null, '', '/sol-heredit/');
    const harness = renderHarness();

    await waitFor(() => expect(harness().sceneKind).toBe('encounter'));
    expect(harness().engine.getState().mechanicsConfig).toMatchObject({ ...solHeredit, colosseumStartWave: '12' });
    // Saved as a setup pick would be, so a reload of the canonical address stays on wave 12.
    expect(storedMechanics()).toEqual({ sol_heredit: { ...solHeredit, colosseumStartWave: '12' } });
  }, 30000);

  it("applies a setup link over the saved Inferno options, and its notice's Undo puts them back", async () => {
    cacheBootstrapTestState.isFullyLoaded = true;
    const inferno = { infernoStartWave: '12', zukShieldSafeTiles: true };
    localStorage.setItem('osrs-yama-settings', JSON.stringify({ mechanicsConfigPerEncounter: { inferno } }));
    window.history.replaceState(null, '', '/?wave=31');
    // Signed out, so the link applies once the (anonymous) profile is final.
    render(<HarnessApp devHarness={{ onReady: () => {} }} />);
    // Its own keys only, over the rest.
    await waitFor(() =>
      expect(storedMechanics()).toMatchObject({ inferno: { infernoStartWave: '31', zukShieldSafeTiles: true } }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(storedMechanics()).toEqual({ inferno }));
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  }, 30000);

  it('opens the Zuk statue on wave 69 without wiping the rest of the saved Inferno options', async () => {
    cacheBootstrapTestState.isFullyLoaded = true;
    window.history.replaceState(null, '', '/');
    const inferno = { infernoStartWave: '12', infernoSouthPillarDestroyed: true, zukShieldSafeTiles: true };
    localStorage.setItem('osrs-yama-settings', JSON.stringify({ mechanicsConfigPerEncounter: { inferno } }));
    const harness = renderHarness();
    await waitFor(() => expect(harness().sceneKind).toBe('lobby'));
    act(() => harness().ui.configureEncounter('zuk', 'TzKal-Zuk', ''));
    await waitFor(() => expect(storedMechanics()).toEqual({ inferno: { ...inferno, infernoStartWave: '69' } }));
    // The card is the Inferno's, on the saved options.
    expect(document.querySelector('.encounter-panel-overlay')).not.toBeNull();
  }, 30000);
});

// App derives the modal hold itself (`modalCoversFight`, exempting the lobby), so this drives the real
// tick loop through the dev harness boot: the encounter picker over the lobby, then over a fight.
describe('App modal hold: lobby vs fight', () => {
  let nowMs: number;
  let frames: FrameRequestCallback[];

  beforeEach(() => {
    cacheBootstrapTestState.isFullyLoaded = true;
    window.history.replaceState(null, '', '/');
    nowMs = 1000;
    frames = [];
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => frames.push(callback));
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    cacheBootstrapTestState.isFullyLoaded = false;
    window.history.replaceState(null, '', '/');
    setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
    vi.restoreAllMocks();
  });

  /** Run animation frames every 100 ms for `durationMs`. */
  function runFor(durationMs: number): void {
    for (const end = nowMs + durationMs; nowMs < end; ) {
      nowMs += 100;
      const queued = frames;
      frames = [];
      act(() => {
        for (const callback of queued) callback(nowMs);
      });
    }
  }

  const openEncounterPicker = () => fireEvent.click(screen.getByRole('button', { name: 'Encounters' }));
  const closeEncounterPicker = () => {
    const close = document.querySelector<HTMLButtonElement>('.picker-close');
    if (!close) expect.fail('Expected the encounter picker to be open');
    fireEvent.click(close);
  };

  it('keeps the lobby ticking under a modal, and holds a fight under it until it closes', async () => {
    const source: { ref: { readonly current: DevHarnessSource | null } | null } = { ref: null };
    render(<HarnessApp devHarness={{ onReady: (ref) => (source.ref = ref) }} />);
    const harness = () => {
      const current = source.ref?.current;
      if (!current) expect.fail('Expected the harness source');
      return current;
    };
    const tick = () => harness().engine.getState().currentTick;
    expect(harness().sceneKind).toBe('lobby');
    expect(harness().autoAdvance).toBe(true);

    openEncounterPicker();
    const lobbyTick = tick();
    runFor(1800);
    expect(tick()).toBeGreaterThanOrEqual(lobbyTick + 2);
    closeEncounterPicker();

    openEncounterPicker();
    fireEvent.click(screen.getByRole('button', { name: /Fortis Colosseum/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
    await waitFor(() => {
      runFor(100);
      expect(harness().sceneKind).toBe('encounter');
    });
    expect(harness().encounterKind).toBe('sol_heredit');
    // The default three game ticks (1800ms at 1x) hold the fight first.
    expect(screen.getByText('Fight starts in 3 ticks')).toBeDefined();
    const arrival = document.querySelector('.encounter-arrival');
    expect(arrival?.querySelector('.encounter-title-card-text-fill')?.textContent).toBe('Fortis Colosseum');
    expect(arrival?.querySelector('.fight-start-countdown-name')).toBeNull();
    expect(arrival?.querySelector('.fight-start-countdown')?.previousElementSibling).toHaveClass(
      'encounter-title-card',
    );
    runFor(1500);
    expect(tick()).toBe(0);
    runFor(900);
    expect(tick()).toBeGreaterThanOrEqual(1);

    openEncounterPicker();
    const heldTick = tick();
    runFor(5000);
    expect(tick()).toBe(heldTick);

    closeEncounterPicker();
    runFor(1200);
    expect(tick()).toBeGreaterThan(heldTick);

    await act(async () => harness().reset());
    expect(document.querySelector('.encounter-title-card:not(.encounter-title-card--reserved)')).toBeNull();
    expect(document.querySelector('.encounter-title-card--reserved')).toHaveAttribute('aria-hidden', 'true');
    expect(document.querySelector('.encounter-title-card-vignette')).toBeNull();
    expect(document.querySelector('.fight-start-countdown-name')?.textContent).toBe('Fortis Colosseum');
  }, 30000);
});

describe('App Mobile Restart stone', () => {
  afterEach(() => {
    localStorage.removeItem('osrs-yama-settings');
    localStorage.removeItem(DEVICE_MODE_STORAGE_KEY);
    resetDeviceModeForTests();
  });

  it('puts Restart in the Mobile left column and nowhere in the desktop layouts', () => {
    setDeviceMode('mobile');
    const { unmount } = render(<App />);
    expect(screen.getByRole('button', { name: 'Restart' }).closest('.osm-restart')).not.toBeNull();
    unmount();

    setDeviceMode('desktop');
    localStorage.setItem('osrs-yama-settings', JSON.stringify({ clientLayoutMode: 'fixed' }));
    render(<App />);
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();
    expect(document.querySelector('.osm-restart')).toBeNull();
  }, 30000);
});

// The arena only mounts once the cache reports loaded, and this is the only
// suite here that needs it mounted rather than merely reachable.
describe('App Status Bars values', () => {
  beforeEach(() => {
    cacheBootstrapTestState.isFullyLoaded = true;
  });
  afterEach(() => {
    cacheBootstrapTestState.isFullyLoaded = false;
  });

  it('persists the Show values setting and hands the new value to the arena', () => {
    // On a fresh install the counters ride along with the plugin by default.
    localStorage.removeItem('osrs-yama-settings');
    render(<App />);
    expect(arenaProps.current?.statusBarsShowValues).toBe(true);
    fireEvent.click(screen.getByTitle('Open Plugins'));
    fireEvent.click(screen.getByText('Status Bars'));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show values' }));

    expect(arenaProps.current?.statusBarsShowValues).toBe(false);
    const stored = JSON.parse(localStorage.getItem('osrs-yama-settings') ?? '{}');
    expect(stored.statusBarsShowValues).toBe(false);
  }, 30000);
});

function setWindowSize(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}
const JSDOM_WINDOW = { width: window.innerWidth, height: window.innerHeight };
function restoreWindowSize() {
  setWindowSize(JSDOM_WINDOW.width, JSDOM_WINDOW.height);
}

describe('App closed drawer work', () => {
  afterEach(() => {
    cacheBootstrapTestState.isFullyLoaded = false;
    localStorage.removeItem('osrs-yama-settings');
    window.history.replaceState(null, '', '/');
    setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
    vi.useRealTimers();
  });

  it('does not render either closed drawer body across eight published simulation ticks', async () => {
    cacheBootstrapTestState.isFullyLoaded = true;
    window.history.replaceState(null, '', '/yama');
    const source: { ref: { readonly current: DevHarnessSource | null } | null } = { ref: null };
    render(
      <HarnessApp
        devHarness={{
          onReady: (ref) => {
            source.ref = ref;
          },
        }}
      />,
    );
    await waitFor(() => expect(source.ref?.current?.sceneKind).toBe('encounter'));
    expect(drawerRenders.plugins).toHaveBeenCalled();
    expect(drawerRenders.settings).toHaveBeenCalled();
    for (const probe of Object.values(drawerRenders)) probe.mockClear();

    for (let tick = 1; tick <= 8; tick++) {
      await act(async () => source.ref?.current?.fastForwardTo(tick));
    }
    expect(source.ref?.current?.engine.getState().currentTick).toBe(8);
    expect(drawerRenders.app.mock.calls.length).toBeGreaterThanOrEqual(8);
    expect({
      plugins: drawerRenders.plugins.mock.calls.length,
      settings: drawerRenders.settings.mock.calls.length,
    }).toEqual({ plugins: 0, settings: 0 });
  }, 30000);

  it('does not render closed drawer bodies during live-scale detents or their persistence echo', () => {
    vi.useFakeTimers();
    cacheBootstrapTestState.isFullyLoaded = true;
    localStorage.setItem('osrs-yama-settings', JSON.stringify({ uiScale: 1 }));
    const app = render(<App />);
    for (const probe of Object.values(drawerRenders)) probe.mockClear();

    for (const scale of [7 / 6, 4 / 3, 1.5, 5 / 3, 11 / 6]) {
      act(() => arenaProps.current?.onUiScaleChange?.(scale));
      expect(arenaProps.current?.uiScale).toBe(scale);
    }
    const beforePersistence = {
      app: drawerRenders.app.mock.calls.length,
      plugins: drawerRenders.plugins.mock.calls.length,
      settings: drawerRenders.settings.mock.calls.length,
    };
    act(() => vi.advanceTimersByTime(250));
    expect(JSON.parse(localStorage.getItem('osrs-yama-settings') ?? '{}').uiScale).toBe(11 / 6);
    expect({
      beforePersistence,
      afterPersistence: {
        app: drawerRenders.app.mock.calls.length,
        plugins: drawerRenders.plugins.mock.calls.length,
        settings: drawerRenders.settings.mock.calls.length,
      },
    }).toEqual({
      beforePersistence: { app: expect.any(Number), plugins: 0, settings: 0 },
      afterPersistence: { app: expect.any(Number), plugins: 0, settings: 0 },
    });
    app.unmount();
  }, 30000);

  it('preserves drawer DOM, expansion and scroll state, then reveals current settings on reopen', () => {
    cacheBootstrapTestState.isFullyLoaded = true;
    localStorage.setItem('osrs-yama-settings', JSON.stringify({ uiScale: 1 }));
    const app = render(<App />);
    fireEvent.click(screen.getByTitle('Open Plugins'));
    fireEvent.click(screen.getByText('Stretched Mode'));
    const plugins = app.container.querySelector<HTMLElement>('.plugins-content')!;
    const pluginRow = within(plugins).getByText('Stretched Mode').closest('.plugin-row');
    expect(pluginRow).toHaveAttribute('data-expanded', 'true');
    plugins.scrollTop = 137;
    fireEvent.click(screen.getByRole('button', { name: 'Close plugins' }));
    fireEvent.transitionEnd(plugins.parentElement!, { propertyName: 'transform' });

    fireEvent.click(screen.getByTitle('Open Settings'));
    fireEvent.click(screen.getByRole('button', { name: /^Interface$/ }));
    const settings = app.container.querySelector<HTMLElement>('.controls-content')!;
    const interfaceSection = within(settings).getByText('Interface').closest('.collapsible-section');
    expect(interfaceSection).toHaveClass('expanded');
    settings.scrollTop = 211;
    fireEvent.click(screen.getByRole('button', { name: 'Close Settings' }));
    fireEvent.transitionEnd(settings.parentElement!, { propertyName: 'transform' });

    act(() => arenaProps.current?.onUiScaleChange?.(1.5));
    fireEvent.click(screen.getByTitle('Open Plugins'));
    expect(app.container.querySelector('.plugins-content')).toBe(plugins);
    expect(pluginRow).toHaveAttribute('data-expanded', 'true');
    expect(plugins.scrollTop).toBe(137);
    expect(within(plugins).getByRole('radio', { name: '150' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Close plugins' }));

    fireEvent.click(screen.getByTitle('Open Settings'));
    expect(app.container.querySelector('.controls-content')).toBe(settings);
    expect(interfaceSection).toHaveClass('expanded');
    expect(settings.scrollTop).toBe(211);
    expect(settings.querySelector('[data-tutorial="interface-section"]')).not.toBeNull();
    app.unmount();
  }, 30000);
});

describe('App Stretched Mode plugin', () => {
  beforeEach(() => {
    cacheBootstrapTestState.isFullyLoaded = true;
  });
  afterEach(() => {
    cacheBootstrapTestState.isFullyLoaded = false;
    localStorage.removeItem('osrs-yama-settings');
    restoreWindowSize();
  });

  it('renders everything at 100% while off and keeps the chosen sizes for when it is back on', () => {
    setWindowSize(3840, 2160);
    localStorage.setItem('osrs-yama-settings', JSON.stringify({ uiScale: 1.5 }));
    render(<App />);
    const nav = () => screen.getByTitle('Open Settings').closest('nav');
    const pluginsNav = () => screen.getByTitle('Open Plugins').closest('nav');
    expect(arenaProps.current?.overlayScale).toBe(2);
    expect(arenaProps.current?.stretchedModePluginEnabled).toBe(true);
    // The menu and Plugins follow Auto with the rest of the top chrome.
    expect(nav()?.style.zoom).toBe('2');
    expect(pluginsNav()).not.toBe(nav());
    expect(pluginsNav()?.style.zoom).toBe('2');

    fireEvent.click(screen.getByTitle('Open Plugins'));
    fireEvent.click(screen.getByRole('switch', { name: 'Stretched Mode' }));

    expect(arenaProps.current?.overlayScale).toBe(1);
    expect(arenaProps.current?.stretchedModePluginEnabled).toBe(false);
    expect(nav()?.style.zoom).toBe('1');
    expect(pluginsNav()?.style.zoom).toBe('1');
    const stored = JSON.parse(localStorage.getItem('osrs-yama-settings') ?? '{}');
    expect(stored).toMatchObject({
      stretchedModePluginEnabled: false,
      uiScale: 1.5,
    });
  }, 30000);
});

describe('App Auto overlay size', () => {
  beforeEach(() => {
    cacheBootstrapTestState.isFullyLoaded = true;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    cacheBootstrapTestState.isFullyLoaded = false;
    localStorage.removeItem('osrs-yama-settings');
    restoreWindowSize();
  });

  it('keeps every Auto surface at its size through a window drag and changes them once it settles', () => {
    setWindowSize(1920, 1080);
    render(<App />);
    const nav = () => screen.getByTitle('Open Settings').closest('nav');
    expect(arenaProps.current?.overlayScale).toBe(1);

    // A window edge dragged out to 1440p, a step every frame.
    const zooms = new Set<number>();
    for (let i = 1; i <= 40; i++) {
      act(() => {
        setWindowSize(1920 + (640 * i) / 40, 1080 + (360 * i) / 40);
        window.dispatchEvent(new Event('resize'));
        vi.advanceTimersByTime(16);
      });
      zooms.add(arenaProps.current?.overlayScale ?? 0);
    }
    expect([...zooms]).toEqual([1]);
    expect(nav()?.style.zoom).toBe('1');

    act(() => vi.advanceTimersByTime(AUTO_SETTLE_MS));
    expect(arenaProps.current?.overlayScale).toBe(1.25);
    expect(nav()?.style.zoom).toBe('1.25');
    // Nothing about Auto is stored.
    expect(localStorage.getItem('osrs-yama-settings') ?? '').not.toMatch(/overlayScale"/);
  }, 30000);

  it('shows the menus, panels and overlays at 100% with Auto sizing off, apart from the plugin', () => {
    setWindowSize(3840, 2160);
    localStorage.setItem('osrs-yama-settings', JSON.stringify({ uiScale: 1.5 }));
    render(<App />);
    const nav = () => screen.getByTitle('Open Settings').closest('nav');
    const stored = () => JSON.parse(localStorage.getItem('osrs-yama-settings') ?? '{}');
    expect(arenaProps.current?.overlayScale).toBe(2);

    fireEvent.click(screen.getByTitle('Open Plugins'));
    fireEvent.click(screen.getByText('Stretched Mode'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto-size interface and overlays' }));
    expect(arenaProps.current?.overlayScale).toBe(1);
    expect(nav()?.style.zoom).toBe('1');
    // The game UI scale is its own setting, untouched.
    expect(arenaProps.current?.uiScale).toBe(1.5);
    expect(arenaProps.current?.stretchedModePluginEnabled).toBe(true);
    expect(stored()).toMatchObject({ autoOverlayScaleEnabled: false, stretchedModePluginEnabled: true });

    // Back on: Auto's size again, at once (no settle: nothing about the window changed).
    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto-size interface and overlays' }));
    expect(arenaProps.current?.overlayScale).toBe(2);
    // The plugin off still forces 100%, whatever Auto sizing says.
    fireEvent.click(screen.getByRole('switch', { name: 'Stretched Mode' }));
    expect(arenaProps.current?.overlayScale).toBe(1);
    expect(stored()).toMatchObject({ autoOverlayScaleEnabled: true, stretchedModePluginEnabled: false });
  }, 30000);
});

describe('App Auto sizes from the space each surface lives in', () => {
  beforeEach(() => {
    cacheBootstrapTestState.isFullyLoaded = true;
  });
  afterEach(() => {
    cacheBootstrapTestState.isFullyLoaded = false;
    localStorage.removeItem('osrs-yama-settings');
    restoreWindowSize();
    vi.restoreAllMocks();
  });

  const nav = () => screen.getByTitle('Open Settings').closest('nav');

  it('grows the menu buttons with a big window in Fixed while the overlays follow the small view', () => {
    // A 3840x2020 window fits the fixed client at about 4x: its 512x334 view becomes 2056x1341.
    setWindowSize(3840, 2020);
    localStorage.setItem('osrs-yama-settings', JSON.stringify({ clientLayoutMode: 'fixed' }));
    render(<App />);
    expect(nav()?.style.zoom).toBe('2');
    expect(arenaProps.current?.chromeScale).toBe(2);
    expect(arenaProps.current?.overlayScale).toBe(1.25);
    expect(screen.getByTitle('Open Plugins').closest('nav')?.style.zoom).toBe('2');
  }, 30000);

  it('sizes the overlays from a set resolution rather than the window around it', () => {
    setWindowSize(2560, 1300);
    localStorage.setItem(
      'osrs-yama-settings',
      JSON.stringify({ gameResolution: { mode: 'fixed', width: 1280, height: 720, presetId: 'custom' } }),
    );
    render(<App />);
    expect(nav()?.style.zoom).toBe('1.25');
    expect(arenaProps.current?.chromeScale).toBe(1.25);
    expect(arenaProps.current?.overlayScale).toBe(1);
  }, 30000);

  it.each([
    [{ autoOverlayScaleEnabled: false }],
    [{ stretchedModePluginEnabled: false }],
  ])('puts both sizes at 100%% with %j', (settings) => {
    setWindowSize(3840, 2020);
    localStorage.setItem('osrs-yama-settings', JSON.stringify({ clientLayoutMode: 'fixed', ...settings }));
    render(<App />);
    expect(nav()?.style.zoom).toBe('1');
    expect(arenaProps.current?.chromeScale).toBe(1);
    expect(arenaProps.current?.overlayScale).toBe(1);
  }, 30000);

  it('records the game-view size for replays, never the window size', () => {
    setWindowSize(3840, 2020);
    localStorage.setItem('osrs-yama-settings', JSON.stringify({ clientLayoutMode: 'fixed' }));
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1280);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(720);
    const project = vi.spyOn(replayCapture, 'projectReplayPresentation');
    render(<App />);
    const recorded = project.mock.results.at(-1)?.value;
    expect(recorded.overlayScale).toBe(1.25);
    // The chrome is the viewer's own; nothing records a size for it.
    expect(JSON.stringify(recorded)).not.toMatch(/chrome/i);
  }, 30000);
});

describe('App Plugins button', () => {
  beforeEach(() => {
    cacheBootstrapTestState.isFullyLoaded = true;
  });
  afterEach(() => {
    vi.useRealTimers();
    cacheBootstrapTestState.isFullyLoaded = false;
    localStorage.removeItem('osrs-yama-settings');
    restoreWindowSize();
  });

  // Plugins sits beside the minimap rather than over it (layout/topChromeLayout.ts), so it grows
  // with the rest of the chrome, uncapped.
  it.each([
    [7680, 4180, 1, '2.5'],
    [2560, 1440, 1, '1.25'],
  ])(
    'at %ix%i (UI scale %s) grows with the chrome to %sx',
    (width, height, uiScale, zoom) => {
      setWindowSize(width, height);
      localStorage.setItem('osrs-yama-settings', JSON.stringify({ uiScale }));
      render(<App />);
      expect(screen.getByTitle('Open Plugins').closest('nav')?.style.zoom).toBe(zoom);
      expect(screen.getByTitle('Open Settings').closest('nav')?.style.zoom).toBe(zoom);
    },
    30000,
  );

  it('stays reachable while the Settings drawer is open', () => {
    render(<App />);
    fireEvent.click(screen.getByTitle('Open Settings'));
    // The Settings drawer is on the left; Plugins lives on the right.
    const plugins = screen.getByTitle('Open Plugins');
    expect(plugins.closest('nav')?.hasAttribute('inert')).toBe(false);
    expect(plugins).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(plugins);
    expect(document.querySelector('.plugins-overlay.open')).not.toBeNull();
    // Open, it stays pressable beside its own drawer, pressed, and handed the drawer's width.
    expect(plugins.closest('nav')?.hasAttribute('inert')).toBe(false);
    expect(plugins).toHaveAttribute('aria-pressed', 'true');
    expect(plugins.closest('nav')?.style.right).toBe('320px');
    fireEvent.click(plugins);
    expect(document.querySelector('.plugins-overlay.open')).toBeNull();
    expect(plugins).toHaveAttribute('aria-pressed', 'false');
  }, 30000);
});

describe('App Settings in the menu', () => {
  // Earlier tests open Training, which is remembered; "Start here" needs a player who has not.
  beforeEach(() => {
    deleteSetting(TUTORIAL_PROGRESS_KEY);
    cacheBootstrapTestState.isFullyLoaded = true;
  });
  afterEach(() => {
    deleteSetting(TUTORIAL_PROGRESS_KEY);
    cacheBootstrapTestState.isFullyLoaded = false;
  });

  it('toggles the drawer from the menu, and hands the top chrome its width so the launchers move past it', () => {
    render(<App />);
    const settings = () => document.querySelector<HTMLElement>('[data-menu-item="settings"]') as HTMLElement;
    expect(settings()).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(settings());
    expect(document.querySelector('.controls-overlay.open')).not.toBeNull();
    expect(settings()).toHaveAttribute('aria-pressed', 'true');
    expect(settings()).toHaveAttribute('title', 'Hide Settings');
    // The row is not tucked: it sits past the 320px drawer, still pressable.
    expect(settings().closest('nav')?.style.left).toBe('320px');
    expect(settings().closest('nav')?.hasAttribute('inert')).toBe(false);
    fireEvent.click(settings());
    expect(document.querySelector('.controls-overlay.open')).toBeNull();
  }, 30000);

  it('marks Training "Start here" until the player has opened it', () => {
    render(<App />);
    const training = () =>
      Array.from(document.querySelectorAll('.controls-toggle-open')).find((b) => b.textContent?.startsWith('Training'));
    expect(training()?.querySelector('.launcher-menu__note')?.textContent).toBe('Start here');
    fireEvent.click(training() as HTMLElement);
    expect(training()?.querySelector('.launcher-menu__note')).toBeNull();
  }, 30000);
});

describe('App Zuk timer presentation capture', () => {
  afterEach(() => {
    cacheBootstrapTestState.isFullyLoaded = false;
    localStorage.removeItem('osrs-yama-settings');
    vi.restoreAllMocks();
    restoreWindowSize();
  });

  // A 3840x2160 window: Auto 2.
  it.each([
    { settings: {}, x: 718, y: 148 },
    { settings: { autoOverlayScaleEnabled: false }, x: 359, y: 74 },
    { settings: { stretchedModePluginEnabled: false }, x: 359, y: 74 },
  ])('captures the concrete effective default instead of null: $settings', ({ settings, x, y }) => {
    cacheBootstrapTestState.isFullyLoaded = true;
    setWindowSize(3840, 2160);
    localStorage.setItem('osrs-yama-settings', JSON.stringify({ ...settings, zukSetTimerPosition: null }));
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1280);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(720);
    const project = vi.spyOn(replayCapture, 'projectReplayPresentation');
    render(<App />);
    expect(project).toHaveBeenCalled();
    const recorded = project.mock.results.at(-1)?.value;
    expect(recorded.panels.zukSetTimer).toEqual({ x, y, anchorX: 'left', anchorY: 'top' });
    const roundTripped = ReplayPresentationStateSchema.parse(JSON.parse(JSON.stringify(recorded)));
    expect(roundTripped.panels.zukSetTimer).toEqual(recorded.panels.zukSetTimer);
  }, 30000);
});

describe('App solved-layout replay capture', () => {
  afterEach(() => {
    layoutCaptureTestState.enabled = false;
    layoutCaptureTestState.width = 1000;
    layoutCaptureTestState.height = 800;
    layoutCaptureTestState.setExclusion = null;
    cacheBootstrapTestState.isFullyLoaded = false;
    localStorage.removeItem('osrs-yama-settings');
    restoreWindowSize();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('seeds capture while the solver is unmeasured, then replaces the fallback on publication', async () => {
    cacheBootstrapTestState.isFullyLoaded = true;
    layoutCaptureTestState.enabled = true;
    layoutCaptureTestState.width = 0;
    layoutCaptureTestState.height = 0;
    setWindowSize(1000, 800);
    const saved = { x: 100, y: 150, anchorX: 'left', anchorY: 'top' } as const;
    localStorage.setItem(
      'osrs-yama-settings',
      JSON.stringify({
        gamePanelPosition: saved,
        uiScale: 1,
        autoOverlayScaleEnabled: false,
      }),
    );
    // The frame observer has a real size while Grid's layout is not measured
    // yet (as with a hidden container or the harness's zero client dimensions).
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
    vi.spyOn(ReplayRecorder.prototype, 'hasRecording').mockReturnValue(true);
    const record = vi.spyOn(ReplayRecorder.prototype, 'recordPresentationState');
    const app = render(<App />);
    const latest = () => record.mock.calls.at(-1)?.[2];
    await waitFor(() => expect(latest()?.panels.gamePanel).toEqual(saved));
    expect(latest()?.frame).toEqual({ width: 1000, height: 800 });

    // An unavailable solve must not freeze the fallback at its first metadata.
    await act(async () => arenaProps.current?.onUiScaleChange?.(1.5));
    await waitFor(() => expect(latest()?.uiScale).toBe(1.5));
    expect(latest()?.panels.gamePanel).toEqual(saved);

    await act(async () => {
      layoutCaptureTestState.width = 1000;
      layoutCaptureTestState.height = 800;
      app.rerender(<App />);
    });
    // A zero-slack reference projects to the center once space is available.
    await waitFor(() => expect(latest()?.panels.gamePanel).toEqual({ ...saved, x: 350, y: 250 }));
    expect(JSON.parse(localStorage.getItem('osrs-yama-settings')!).gamePanelPosition).toEqual(saved);
  }, 30000);

  it.each([
    false,
    true,
  ])('records solved targets after resizing without persisting, then plays them back (compact=%s)', async (compactOrbsEnabled) => {
    layoutCaptureTestState.enabled = true;
    cacheBootstrapTestState.isFullyLoaded = true;
    setWindowSize(1000, 800);
    const point = (x: number, y: number): UIPosition => ({ x, y, anchorX: 'left', anchorY: 'top' });
    const saved = {
      gamePanelPosition: point(400, 300),
      minimapPosition: { x: 150, y: 70, anchorX: 'right', anchorY: 'top' },
      compactOrbsPosition: { x: 150, y: 70, anchorX: 'right', anchorY: 'top' },
      infoboxPosition: point(605, 300),
      zukSetTimerPosition: null,
    };
    localStorage.setItem(
      'osrs-yama-settings',
      JSON.stringify({
        ...saved,
        compactOrbsEnabled,
        infoboxPinTarget: 'free',
        uiScale: 1,
        autoOverlayScaleEnabled: false,
      }),
    );
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => layoutCaptureTestState.width);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => layoutCaptureTestState.height);
    const observers = new Set<ResizeObserverCallback>();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private callback: ResizeObserverCallback) {}
        observe() {
          observers.add(this.callback);
        }
        unobserve() {}
        disconnect() {
          observers.delete(this.callback);
        }
      },
    );
    // This test exercises capture, not the run-start UI. Keep the real recorder
    // and deduplication but open its recording gate in the otherwise idle lobby.
    vi.spyOn(ReplayRecorder.prototype, 'hasRecording').mockReturnValue(true);
    const record = vi.spyOn(ReplayRecorder.prototype, 'recordPresentationState');
    const app = render(<App />);
    const latest = (): ReplayPresentationState => {
      const state = record.mock.calls.at(-1)?.[2];
      if (!state) throw new Error('Expected a captured presentation');
      return state;
    };
    const rectPosition = (container: HTMLElement, name: string) => {
      const element = container.querySelector<HTMLElement>(`[data-tutorial="${name}"]`)!;
      const [x, y] = /translate3d\(([-\d.e]+)px, ([-\d.e]+)px/.exec(element.style.transform)!.slice(1).map(Number);
      return point(x, y);
    };
    await waitFor(() => expect(latest().panels.gamePanel).toEqual(point(400, 300)));
    const atA = latest();
    expect(atA.frame).toEqual({ width: 1000, height: 800 });

    await act(async () => {
      layoutCaptureTestState.width = 1400;
      layoutCaptureTestState.height = 1000;
      setWindowSize(1400, 1000);
      fireEvent(window, new Event('resize'));
      for (const callback of [...observers]) callback([], {} as ResizeObserver);
    });
    await waitFor(() => expect(latest().frame).toEqual({ width: 1400, height: 1000 }));
    const atB = latest();
    expect(atB.panels.gamePanel).toEqual(point(600, 400));
    expect(atB.panels.infobox).toEqual(point(805, 400));
    expect(atB.panels.gamePanel).not.toEqual(atA.panels.gamePanel);
    const activeMap = compactOrbsEnabled ? 'compactOrbs' : 'minimap';
    const liveMap = rectPosition(app.container, 'minimap');
    expect(atB.panels[activeMap]).toMatchObject({ y: liveMap.y, anchorX: 'right', anchorY: 'top' });
    expect(atB.panels[activeMap].x).toBeCloseTo(1400 - 160 - liveMap.x, 9);
    expect(atB.panels.zukSetTimer).toEqual(rectPosition(app.container, 'zuk-set-timer-overlay'));
    expect(atB.panels.zukSetTimer).not.toBeNull();

    // A child-only solve does not change App settings, frame metadata or scale.
    // Its publication must still update capture through the registry subscription.
    const callsBefore = record.mock.calls.length;
    await act(async () => layoutCaptureTestState.setExclusion?.(true));
    await waitFor(() => expect(record.mock.calls.length).toBeGreaterThan(callsBefore));
    const moved = latest();
    expect(moved.panels.gamePanel).not.toEqual(atB.panels.gamePanel);
    expect(moved.panels.gamePanel).toEqual(rectPosition(app.container, 'game-panel'));
    expect(moved.panels.infobox).toEqual(rectPosition(app.container, 'infobox-panel'));
    expect(moved.panels.infobox!.x - moved.panels.gamePanel.x - 200).toBe(5);

    await act(async () => arenaProps.current?.onUiScaleChange?.(1.5));
    await waitFor(() => expect(latest().uiScale).toBe(1.5));
    const captured = ReplayPresentationStateSchema.parse(latest());
    expect(captured.panels.gamePanel).toEqual(rectPosition(app.container, 'game-panel'));
    expect(captured.panels.infobox).toEqual(rectPosition(app.container, 'infobox-panel'));
    expect(captured.panels.infobox!.x - captured.panels.gamePanel.x - 300).toBe(5);
    expect(JSON.parse(localStorage.getItem('osrs-yama-settings')!)).toMatchObject(saved);
    app.unmount();

    const boxes = [
      { name: 'game-panel', position: captured.panels.gamePanel, width: 200, height: 200 },
      { name: 'minimap', position: captured.panels[activeMap], width: 160, height: 100 },
      { name: 'infobox-panel', position: captured.panels.infobox!, width: 100, height: 100 },
      { name: 'zuk-set-timer-overlay', position: captured.panels.zukSetTimer!, width: 208, height: 134 },
    ];
    const writes = vi.fn();
    const playback = render(
      <ReplayPresentationProvider
        presentation={captured}
        reportPanelPresentation={() => {}}
        reportMinimapZoom={() => {}}
      >
        <PanelSnapRegistryProvider>
          {boxes.map((box) => (
            <DraggablePanel
              key={box.name}
              dataTutorial={box.name}
              defaultPosition={point(0, 0)}
              position={box.position}
              width={box.width}
              height={box.height}
              scale={box.name === 'zuk-set-timer-overlay' ? captured.overlayScale : captured.uiScale}
              viewportWidth={captured.frame.width}
              viewportHeight={captured.frame.height}
              onPositionChange={writes}
            >
              content
            </DraggablePanel>
          ))}
        </PanelSnapRegistryProvider>
      </ReplayPresentationProvider>,
    );
    for (const box of boxes) {
      const scale = box.name === 'zuk-set-timer-overlay' ? (captured.overlayScale ?? 1) : captured.uiScale;
      expect(rectPosition(playback.container, box.name)).toEqual(
        point(
          box.position.anchorX === 'left' ? box.position.x : captured.frame.width - box.width * scale - box.position.x,
          box.position.anchorY === 'top' ? box.position.y : captured.frame.height - box.height * scale - box.position.y,
        ),
      );
    }
    expect(writes).not.toHaveBeenCalled();
  }, 30000);
});

describe('App 3D view status', () => {
  afterEach(() => {
    cacheBootstrapTestState.isFullyLoaded = false;
    localStorage.removeItem('osrs-yama-settings');
    vi.restoreAllMocks();
  });

  it('holds on the status the viewport reports, and drops it on leaving WebGL', () => {
    cacheBootstrapTestState.isFullyLoaded = true;
    render(<App />);
    expect(arenaProps.current?.renderStatus).toEqual({ kind: 'ok' });
    expect(arenaProps.current?.graphicsHeld).toBe(false);

    act(() => arenaProps.current?.onRenderStatusChange?.({ kind: 'lost' }));
    expect(arenaProps.current?.renderStatus).toEqual({ kind: 'lost' });
    expect(arenaProps.current?.graphicsHeld).toBe(true);
    // The lobby has no fight or replay for the notice to name.
    expect(arenaProps.current?.graphicsHeldActivity).toBeNull();

    fireEvent.click(screen.getByTitle('Open Settings'));
    fireEvent.click(screen.getByText('Graphics & Performance'));
    fireEvent.change(screen.getByDisplayValue('3D View (WebGL)'), { target: { value: 'canvas2d' } });
    expect(arenaProps.current?.graphicsHeld).toBe(false);
    expect(arenaProps.current?.renderStatus).toEqual({ kind: 'ok' });

    // Back on WebGL, the new view starts clear and reports for itself.
    fireEvent.change(screen.getByDisplayValue('2D View (Debug)'), { target: { value: 'webgl' } });
    expect(arenaProps.current?.graphicsHeld).toBe(false);
    act(() => arenaProps.current?.onRenderStatusChange?.({ kind: 'failed', reason: 'context-timeout' }));
    expect(arenaProps.current?.graphicsHeld).toBe(true);
    act(() => arenaProps.current?.onRenderStatusChange?.({ kind: 'ok' }));
    expect(arenaProps.current?.graphicsHeld).toBe(false);
  });
});

describe('App focus pause setting', () => {
  afterEach(() => {
    cacheBootstrapTestState.isFullyLoaded = false;
    localStorage.removeItem('osrs-yama-settings');
    vi.restoreAllMocks();
  });

  it('connects the Simulation preference to the live renderer pause state', () => {
    cacheBootstrapTestState.isFullyLoaded = true;
    localStorage.setItem('osrs-yama-settings', JSON.stringify({ pauseWhenUnfocused: true }));
    let focused = true;
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const suspendFrames = vi.spyOn(animationFrames, 'setSuspended');
    render(<App />);
    fireEvent.click(screen.getByTitle('Open Settings'));
    fireEvent.click(screen.getByText('Simulation'));
    const checkbox = screen.getByRole('checkbox', { name: 'Pause simulator when unfocused' });
    expect(checkbox).toHaveAttribute('aria-checked', 'true');
    expect(arenaProps.current?.replayPaused).toBe(false);

    focused = false;
    act(() => window.dispatchEvent(new Event('blur')));
    expect(arenaProps.current?.replayPaused).toBe(true);
    expect(suspendFrames).toHaveBeenLastCalledWith(true);

    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute('aria-checked', 'false');
    expect(arenaProps.current?.replayPaused).toBe(false);
    expect(suspendFrames).toHaveBeenLastCalledWith(false);

    visibility.mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(suspendFrames).toHaveBeenLastCalledWith(true);
    visibility.mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));

    fireEvent.click(checkbox);
    expect(arenaProps.current?.replayPaused).toBe(true);
    focused = true;
    act(() => window.dispatchEvent(new Event('focus')));
    expect(arenaProps.current?.replayPaused).toBe(false);
    expect(suspendFrames).toHaveBeenLastCalledWith(false);
  });
});
