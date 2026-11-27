import {
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import './App.css';
import './components/LoadingScreen.css';
import { CacheManager } from './cache/CacheManager';
import { BrowserSupportScreen } from './components/BrowserSupportScreen';
import { CacheExplorer } from './components/CacheExplorer';
import { CreditsModal } from './components/Credits';
import { DeathModal } from './components/DeathModal';
import { EncounterPanel } from './components/EncounterPanel';
import { EncounterPicker } from './components/EncounterPicker';
import { EncounterTitleCard, resolveTitleParts } from './components/EncounterTitleCard';
import { FpsOverlay } from './components/FpsOverlay';
import { Grid } from './components/Grid';
import { GridProviders } from './components/GridProviders';
import { HardwareAccelWarning } from './components/HardwareAccelWarning';
import { KeyboardShortcutsModal } from './components/KeyboardShortcutsModal';
import { LoadingScreen } from './components/LoadingScreen';
import { LauncherIcon } from './components/launcher/launcherIcons';
import { DEFAULT_MINIMAP_ZOOM } from './components/Minimap';
import { MobileEntry } from './components/MobileEntry';
import { MobileFullscreenStone } from './components/MobileFullscreenStone';
import { MobileRestartStone } from './components/MobileRestartStone';
import { ModifierKeysOverlay } from './components/ModifierKeysOverlay';
import { ModifiersModal, runModifierSelection } from './components/ModifiersModal';
import { PluginsPanel } from './components/PluginsPanel';
import { type EncounterSelection, QuickSearch } from './components/QuickSearch';
import { RendererErrorBoundary } from './components/RendererErrorBoundary';
import { SettingsSidebar } from './components/SettingsSidebar';
import { closeDrawerForNavigation, searchLayoutOf } from './components/SidebarSearch';
import { SoundDebugOverlay } from './components/SoundDebugOverlay';
import {
  drawersConflict,
  drawersCoveringGamePanel,
  useRevealAction,
  useSettingsRevealListener,
} from './components/settingsReveal';
import { PanelSnapRegistryProvider, usePanelSnapRegistry } from './components/snap';
import { TickTimingOverlay } from './components/TickTimingOverlay';
import { HotkeyCustomizationProvider } from './components/TouchControls';
import { TransitionOverlay } from './components/TransitionOverlay';
import { TutorialPickerModal } from './components/TutorialPickerModal';
import { resolveTerminalDialog } from './components/terminalDialog';
import { isMobileUi, useMobileUiRoot } from './components/ui/mobileSheet';
import { VictoryModal } from './components/VictoryModal';
import { ViewportSizeWarning } from './components/ViewportSizeWarning';
import { type HintToastAnchor, useZoomHintToast, ZoomHintToast } from './components/ZoomHintToast';
import { resolveZukSetTimerPosition } from './components/ZukSetTimerOverlay';
import { ReplayPresentationProvider } from './contexts/ReplayPresentationContext';
import { WorkspaceDockContext } from './contexts/WorkspaceDockContext';
import type { EncounterModifierSelection } from './core/encounters/encounterFactory';
import { zukWaveState } from './core/encounters/snapshot';
import { resolveEncounterPresetsKey } from './core/encounters/variantTypes';
import { GamePanelTabStore } from './core/gamePanelTabStore';
import type { ReplayUiState, ReplayViewportState } from './core/ReplayRecorder';
import {
  playbackClientLayoutMode,
  type ReplayOverlays,
  type ReplayPanelPresentation,
  type ReplayPresentationState,
  resolveReplayChatboxVisible,
  resolveReplayMobileChromeScale,
  resolveReplaySafeAreaInsets,
  resolveReplayZukSetTimerPosition,
} from './core/replayPresentation';
import { encounterPluginOptions, isEncounterPluginShown } from './data/encounterPlugins';
import { exportInventorySetup } from './data/inventorySetupIO';
import { getLinePresetsForEncounter } from './data/linePackPresets';
import { EQUIPMENT_PRESETS } from './data/playerPresets';
import { getListedPresetsForEncounter, getPresetsForEncounter } from './data/tilePackPresets';
import { canonicalEncounterKind } from './encounters/catalog';
import { INFERNO_KIND } from './encounters/inferno/constants';
import { infernoSetupQuery } from './encounters/inferno/setupLink';
import { encounterControlsForKind } from './encounters/modules';
import { encounterRegistry } from './encounters/registry';
import type { DevHarnessBoot, DevHarnessSource } from './harness/devHarnessTypes';
import { useAntiDrag } from './hooks/useAntiDrag';
import { useAudioManager, useEventAudioScope } from './hooks/useAudioManager';
import { useAutoOverlayScales } from './hooks/useAutoOverlayScale';
import { useBossHealthBarSettings } from './hooks/useBossHealthBarSettings';
import { useCacheBootstrap } from './hooks/useCacheBootstrap';
import { useDevicePixelRatio } from './hooks/useDevicePixelRatio';
import { useEncounterEquipment } from './hooks/useEncounterEquipment';
import { type EncounterManagerBindings, tutorialSetup, useEncounterManager } from './hooks/useEncounterManager';
import { ESC_PRIORITY, useEscapeLayer } from './hooks/useEscapeLayer';
import { useGlobalUiShortcuts } from './hooks/useGlobalUiShortcuts';
import { useInfernoSetupLink } from './hooks/useInfernoSetupLink';
import { useInfernoSetupQuery } from './hooks/useInfernoSetupQuery';
import { useInventoryTags } from './hooks/useInventoryTags';
import { useIsMobile } from './hooks/useIsMobile';
import { useIsMobileDevice } from './hooks/useIsMobileDevice';
import { useIsTouchOnly } from './hooks/useIsTouchOnly';
import { useLineMarkers } from './hooks/useLineMarkers';
import { useLiveSetting } from './hooks/useLiveSetting';
import { useMobileEntry } from './hooks/useMobileEntry';
import { useNpcHighlights } from './hooks/useNpcHighlights';
import {
  resolveAntialias,
  resolveRequestedFrameSize,
  type UIPosition,
  usePersistedSettings,
} from './hooks/usePersistedSettings';
import { usePlayerStats } from './hooks/usePlayerStats';
import { useRouting } from './hooks/useRouting';
import { useSafeAreaInsets } from './hooks/useSafeAreaInsets';
import { useSimulationWiring } from './hooks/useSimulationWiring';
import { useTileIndicators } from './hooks/useTileIndicators';
import { useTileMarkerClipboard } from './hooks/useTileMarkerClipboard';
import { useTileMarkers } from './hooks/useTileMarkers';
import { useViewportInteraction } from './hooks/useViewportInteraction';
import { useWorkspaceDockLayout } from './hooks/useWorkspaceDockLayout';
import { useXpDropSettings } from './hooks/useXpDropSettings';
import { useZukSetTimer } from './hooks/useZukSetTimer';
import { osmChromeScale } from './layout/osmClientLayout';
import { osmFrame, osmFramePlaced } from './layout/osmFrame';
import { DEFAULT_MOBILE_TOOL_WINDOW, type MobileToolWindowState, toolWindowReducer } from './layout/osmToolWindowState';
import { fixedFrameSizeAtScale, placeFixedFrame } from './layout/osrsClientLayout';
import { overlaySpacesForLayout } from './layout/overlayScale';
import { fitReplayWorkspace, recordedWorkspace, resolveViewportSizeWarning } from './layout/replayWorkspaceLayout';
import type { RenderStatus } from './render/core/renderer';
import { getLobbyEffectDefaults } from './render/scene/lobbyEffectConfig';
import { capturePanelLayout } from './replay/capturePanelLayout';
import { projectReplayOverlays, projectReplayPresentation } from './replay/replayCapture';
import { preloadUiAssets } from './services/AssetPreloader';
import { KEYBOARD_SHORTCUTS_REFERENCE_ID } from './settingsSearch/ids';
import { TutorialOverlay } from './tutorial/components/TutorialOverlay';
import { getCourseForEncounterKind, getTutorialById, getTutorialTargetEncounter } from './tutorial/content';
import {
  hasOpenedTutorialPicker,
  hasShownFirstRunMenu,
  markFirstRunMenuShown,
  markTutorialPickerOpened,
} from './tutorial/persistence';
import { useTutorialDirector } from './tutorial/runtime/useTutorialDirector';
import { createEmptyCombatSupplies, type EncounterLoadout } from './types/encounterLoadout';
import { DEFAULT_PLAYER_CONFIG, type PlayerConfig } from './types/player';
import type { SetupContextControls } from './types/setupContext';
import type { MechanicsConfig } from './types/simulation';
import type { TileGridStyle } from './types/tileGrid';
import { DEFAULT_TILE_MARKER_WIDTH, type TileMarker } from './types/tileMarkers';
import { animationFrames } from './util/animationFrames';
import { detectGpuStatus } from './util/gpuDetection';
import { log } from './util/Logger';
import { cloneInventory } from './util/loadoutUtils';
import { frameOrigin, sidebarOverlap } from './util/viewportLayout';

const cacheManagerSingleton = new CacheManager();

/**
 * URL-level detection of popout mode. Stable for the lifetime of the
 * tab, so it's safe to compute at module scope.
 */
const IS_POPOUT_WINDOW: boolean =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('popout') === '1';

/** Extra window height to account for browser chrome when popping out. */
const POPOUT_CHROME_HEIGHT_PX = 80;

/**
 * Settings sidebar (left) and plugins panel (right) widths. Must stay
 * in sync with the CSS in SettingsSidebar.css and PluginsPanel.css —
 * the JS side uses it for layout math (uiInsets, viewportInsets,
 * viewportOffsetX, popout sizing fallback).
 *
 * If the CSS width ever changes, update this constant too, or the
 * frame-overlap calculations will drift from the actual rendered width.
 */
const SIDEBAR_PANEL_WIDTH_PX = 320;

/** How long the lobby must hold before the first-run menu opens (App `firstRunMenuDue`). */
const FIRST_RUN_MENU_SETTLE_MS = 800;

/** Popout window default size when the user hasn't locked a resolution. */
const POPOUT_DEFAULT_WIDTH_PX = 1280;
const POPOUT_DEFAULT_HEIGHT_PX = 720;

/** Stands in for every marker mutator while a replay owns the overlays on screen. */
const ignoreMarkerEdit = (): void => {};

const RENDER_STATUS_OK: RenderStatus = { kind: 'ok' };

/**
 * A clicked menu button keeps no focus, where Space or Enter would press it again instead of
 * reaching the game (docs/agent-reference.md, Keyboard and focus policy). The click still runs.
 */
const keepFocusOffMenuButtons = (event: ReactMouseEvent) => {
  if (event.target instanceof Element && event.target.closest('button')) event.preventDefault();
};

// Keep navigation and game-frame targets in the same registry.
export function App(props: { devHarness?: DevHarnessBoot } = {}) {
  return (
    <PanelSnapRegistryProvider>
      <AppShell {...props} />
    </PanelSnapRegistryProvider>
  );
}

/**
 * `devHarness` is supplied only by the dev UI harness entry (`/ui-harness.html`),
 * never by the app. Every read of it sits behind a leading `import.meta.env.DEV`
 * so a production build folds the harness seams away entirely.
 */
function AppShell({ devHarness }: { devHarness?: DevHarnessBoot } = {}) {
  const panelLayout = usePanelSnapRegistry()?.layout;
  const harnessMode = import.meta.env.DEV && devHarness !== undefined;
  const cacheManagerRef = useRef<CacheManager>(cacheManagerSingleton);
  const { stats: playerStats, setStats: setPlayerStats } = usePlayerStats();
  const [playerConfigBase, setPlayerConfigBase] = useState(() => ({
    appearance: DEFAULT_PLAYER_CONFIG.appearance,
    equipment: DEFAULT_PLAYER_CONFIG.equipment,
  }));
  const playerConfig = useMemo<PlayerConfig>(
    () => ({ ...playerConfigBase, stats: playerStats }),
    [playerConfigBase, playerStats],
  );
  const playerConfigRef = useRef(playerConfig);
  playerConfigRef.current = playerConfig;
  const setPlayerConfig = useCallback<Dispatch<SetStateAction<PlayerConfig>>>(
    (update) => {
      const previous = playerConfigRef.current;
      const next = typeof update === 'function' ? update(previous) : update;
      playerConfigRef.current = next;
      setPlayerConfigBase({ appearance: next.appearance, equipment: next.equipment });
      setPlayerStats(next.stats);
    },
    [setPlayerStats],
  );
  // Lives in an external store, not React state: a tab switch must not re-render
  // App (and with it the unmemoized sidebars/Grid). See GamePanelTabStore.
  const gamePanelTabStore = useRef<GamePanelTabStore>(null!);
  if (gamePanelTabStore.current === null) gamePanelTabStore.current = new GamePanelTabStore('inventory');
  const tabStore = gamePanelTabStore.current;
  const [cacheExplorerOpen, setCacheExplorerOpen] = useState(false);
  const [encounterPickerOpen, setEncounterPickerOpen] = useState(false);
  /** The encounter a quick search chose, for the picker to open on; cleared when it closes. */
  const [encounterPickerSelection, setEncounterPickerSelection] = useState<EncounterSelection | null>(null);
  const [quickSearchOpen, setQuickSearchOpen] = useState(false);
  const [shortcutsModalOpen, setShortcutsModalOpen] = useState(false);
  const [creditsModalOpen, setCreditsModalOpen] = useState(false);
  /** The Modifiers picker over a running fight: its encounter and the run's selection it opened on. */
  const [modifiersPicker, setModifiersPicker] = useState<{
    readonly kind: string;
    readonly selection: EncounterModifierSelection;
  } | null>(null);
  const encounterBindingsRef = useRef<EncounterManagerBindings | null>(null);
  const [settings, updateSetting] = usePersistedSettings();
  const {
    masterVolume,
    sfxVolume,
    areaVolume,
    muteWhenUnfocused,
    pauseWhenUnfocused,
    speedMultiplier,
    autoAdvance,
    showCoordinates,
    showWaveTiles,
    showNpcClickbox,
    showDamageTiles,
    showFireballDangerTiles,
    smoothTerrain,
    brightness,
    contrast,
    saturation,
    rendererType,
    mechanicsConfigPerEncounter,
    modifiersPerEncounter,
    startingHpPerEncounter,
    logLevel,
    gamePanelPosition,
    minimapPosition,
    compactOrbsPosition,
    infoboxPosition,
    infoboxPinTarget,
    uiScale: persistedUiScale,
    stretchedModePluginEnabled,
    autoOverlayScaleEnabled,
    showTickCounter,
    showTickCounterOverhead,
    tickCounterAbovePrayerIcon,
    tickCounterColors,
    tickCounterOffsetX,
    tickCounterOffsetY,
    showTickCounterInfobox,
    tickCounterMax,
    infoboxTextOutlineColor,
    infoboxTextOutlineEnabled,
    tickCounterFontSize,
    showTickTiming,
    showDetailedDps,
    detailedDpsPosition,
    dpsOverlayShowDetails,
    showSoundDebug,
    showCameraDebug,
    showModifierKeys,
    attackStylePerCategory,
    showShortcutHints,
    disabledShortcutHints,
    hideHardwareAccelWarning,
    hideMobileWarning,
    showFps,
    fpsCap,
    cameraPluginEnabled,
    cameraVerticalCamera,
    cameraInvertYaw,
    cameraInvertPitch,
    cameraInnerZoomLevel,
    cameraOuterZoomLimit,
    cameraSpeed,
    cameraDragSpeed,
    cameraRightClickMovesCamera,
    cameraZoomIncrement,
    attackTimerMetronomeEnabled,
    attackTimerMetronomeShowBar,
    attackTimerMetronomeShowTicks,
    attackTimerMetronomeFontSize,
    attackTimerMetronomeAbovePrayerIcon,
    attackTimerMetronomeOffsetX,
    attackTimerMetronomeOffsetY,
    npcAttackTimerMetronomeEnabled,
    customMenuSwapsEnabled,
    customMenuSwaps,
    instantInventoryEnabled,
    instantPrayerEnabled,
    prayerEnabled,
    prayerFlickOrbEnabled,
    prayerFlickAlwaysOn,
    prayerFlickEnabled,
    prayerFlickPosition,
    tickAudioMetronomeEnabled,
    tickAudioMetronomeTock,
    tickAudioMetronomeVolume,
    tileGridEnabled,
    tileGridColor,
    tileGridOpacity,
    tileGridWidth,
    statusBarsEnabled,
    statusBarsShowValues,
    entityHiderEnabled,
    entityHider,
    tzhaarHpTrackerEnabled,
    tzhaarHpTracker,
    infernoAdditionsEnabled,
    infernoAdditions,
    colosseumAdditionsEnabled,
    colosseumAdditions,
    touchLongPressMs,
    touchMenuRowHeight,
    touchHapticsEnabled,
    mobileHotkeys,
    mobileHotkeysOpenOnLeft,
    mobileInterfaceScaling,
    zukSetTimerPosition,
    compactOrbsEnabled,
    compactOrbsLayout,
    compactOrbsOrder,
    gameResolution,
    clientLayoutMode,
    fixedLayoutScale,
    fixedLayoutIntegerScaling,
    fixedChatboxVisible,
    transparentChatbox,
    transparentSidePanel,
    hotkeysCloseSidePanel,
    clickThroughTransparentChatbox,
    inputLagMs,
    fightStartCountdown: fightStartCountdownEnabled,
    fightStartCountdownTicks,
  } = settings;
  const attackCooldownTicks = useMemo(
    () =>
      attackTimerMetronomeEnabled && attackTimerMetronomeShowTicks
        ? {
            fontSize: attackTimerMetronomeFontSize,
            abovePrayerIcon: attackTimerMetronomeAbovePrayerIcon,
            offsetX: attackTimerMetronomeOffsetX,
            offsetY: attackTimerMetronomeOffsetY,
          }
        : null,
    [
      attackTimerMetronomeEnabled,
      attackTimerMetronomeShowTicks,
      attackTimerMetronomeFontSize,
      attackTimerMetronomeAbovePrayerIcon,
      attackTimerMetronomeOffsetX,
      attackTimerMetronomeOffsetY,
    ],
  );
  const gpuStatus = detectGpuStatus();
  // Context attributes cannot change on an existing canvas; apply preference edits after reload.
  const [antialias] = useState(() => resolveAntialias(settings.antiAliasing, gpuStatus.status));
  // No viewport at all in the harness; see GridProps.rendererType.
  const effectiveRendererType = harnessMode ? ('none' as const) : rendererType;
  // The 3D view's last reported status (RenderViewport3D's onRenderStatusChange, through Grid). A
  // mounted 3D view publishes its own status on mount and re-emits on every remount, so leaving
  // WebGL drops whatever the old view last said rather than carrying it to the next one.
  const [renderStatus, setRenderStatus] = useState<RenderStatus>(RENDER_STATUS_OK);
  if (effectiveRendererType !== 'webgl' && renderStatus.kind !== 'ok') setRenderStatus(RENDER_STATUS_OK);
  // A fight or replay the player cannot see does not carry on: held, as under a modal, from the
  // moment the view stops drawing (the overlay's delay is display-only) until it reports `ok`.
  const graphicsHeld = effectiveRendererType === 'webgl' && renderStatus.kind !== 'ok';
  const activeRenderScale =
    gpuStatus.status === 'hardware' ? settings.renderScaleHardware : settings.renderScaleSoftware;
  const [tutorialPickerOpen, setTutorialPickerOpen] = useState(false);
  const [tutorialPickerInitialCourseId, setTutorialPickerInitialCourseId] = useState<string | null>(null);
  const [pendingEncounterTutorialStart, setPendingEncounterTutorialStart] = useState<{
    id: string;
    target: string;
  } | null>(null);
  const [tutorialPickerSeen, setTutorialPickerSeen] = useState<boolean>(hasOpenedTutorialPicker);
  useEffect(() => {
    if (!tutorialPickerOpen || tutorialPickerSeen) return;
    markTutorialPickerOpened();
    setTutorialPickerSeen(true);
  }, [tutorialPickerOpen, tutorialPickerSeen]);
  // Tutorial Mode — a persistent training-space state separate from any single
  // tutorial run. While active: sim is paused-by-default via the tutorial pause
  // channel, infinite health is enforced. The user can still resume practice
  // freely; specific tutorials manage their own pause/mechanics on top.
  const [tutorialMode, setTutorialMode] = useState(false);
  const [tutorialModeKind, setTutorialModeKind] = useState<string | null>(null);
  // Tutorial Mode's mechanics and a lesson's gear live in the scene's tutorial setup
  // (useEncounterManager), never in the player's saved setup, so leaving restores nothing.
  const [controlsVisible, setControlsVisibleBase] = useState(false);
  const [quickPrayerSetupOpen, setQuickPrayerSetupOpen] = useState(false);
  // Counts every request, so asking again while setup is already open still shows it.
  const [quickPrayerSetupRequest, setQuickPrayerSetupRequest] = useState(0);
  const setControlsVisible = useCallback((visible: boolean) => {
    setControlsVisibleBase(visible);
    window.dispatchEvent(new CustomEvent(visible ? 'tutorial:settings-opened' : 'tutorial:settings-closed'));
  }, []);
  const [pluginsVisible, setPluginsVisible] = useState(false);
  const { audioEngine, eventAudioPlayerRef, frameSoundTrackerRef } = useAudioManager({
    areaVolume,
    masterVolume,
    sfxVolume,
    muteWhenUnfocused,
    tickAudioMetronomeEnabled,
    tickAudioMetronomeTock,
    tickAudioMetronomeVolume,
    soundEffectCache: cacheManagerRef.current,
  });
  const {
    bootstrapState: { cacheDownloadState, isFullyLoaded },
    loaders,
    actions: { handleCacheRetry },
  } = useCacheBootstrap({
    audioEngine,
    bindingsRef: encounterBindingsRef,
    cacheManagerRef,
    eventAudioPlayerRef,
    devHarness: harnessMode,
  });
  const {
    animationSystem,
    modelLoader,
    npcTypeLoader,
    objTypeLoader,
    spotAnimLoader,
    spotAnimModelLoader,
    textureLoader,
  } = loaders;
  // A new player's first lobby visit opens the desktop menu, once (TopChrome `menu.openOnce`):
  // Settings is its first row and Training carries "Start here" until it has been opened.
  const [firstRunMenuShown, setFirstRunMenuShown] = useState<boolean>(
    () => tutorialPickerSeen || hasShownFirstRunMenu(),
  );
  const onFirstRunMenuOpened = useCallback(() => {
    markFirstRunMenuShown();
    setFirstRunMenuShown(true);
  }, []);
  const isTouchOnly = useIsTouchOnly();
  // Adapter context that callbacks need to read at call-time, not closure-capture time.
  // mechanicsVariantKind / activeEncounterKind change as the user navigates;
  // the director must always see the latest values.
  const adapterCtxRef = useRef({
    activeEncounterKindForAdapter: 'lobby',
    mechanicsVariantKindForAdapter: 'lobby',
  });
  const [encounterDebugFlags, setEncounterDebugFlags] = useState<Record<string, boolean | number>>(() => {
    const init: Record<string, boolean | number> = {};
    const defaults = getLobbyEffectDefaults();
    for (const [key, alpha] of Object.entries(defaults)) {
      init[`lobby_${key}_alpha`] = alpha;
    }
    init.waveTiles = showWaveTiles;
    init.damageTiles = showDamageTiles;
    init.fireballDangerTiles = showFireballDangerTiles;
    return init;
  });
  const setEncounterDebugFlag = useCallback((key: string, value: boolean | number) => {
    setEncounterDebugFlags((prev) => ({ ...prev, [key]: value }));
  }, []);
  const {
    getEquipment: getEncounterEquipment,
    getInventory: getEncounterInventory,
    getSupplies: getEncounterSupplies,
    getLoadout: getEncounterLoadout,
    setEquipment: setEncounterEquipment,
    setInventory: setEncounterInventory,
    setSupplies: setEncounterSupplies,
    setLoadout: setEncounterLoadout,
  } = useEncounterEquipment();
  // Stable, so the mechanics-change handler built on it keeps its identity across renders.
  const updateMechanicsConfigPerEncounter = useCallback(
    (next: Record<string, Partial<MechanicsConfig>>) => updateSetting('mechanicsConfigPerEncounter', next),
    [updateSetting],
  );
  const updateModifiersPerEncounter = useCallback(
    (next: Record<string, EncounterModifierSelection>) => updateSetting('modifiersPerEncounter', next),
    [updateSetting],
  );
  const updateStartingHpPerEncounter = useCallback(
    (next: Record<string, number>) => updateSetting('startingHpPerEncounter', next),
    [updateSetting],
  );

  const {
    activeEncounterKind,
    activeMechanicsConfig,
    activeSetup,
    mechanicsVariantKind,
    encounterDescriptor,
    enterEncounter,
    enterLobby,
    exitFadePhase,
    getEncounterMergedMechanicsConfig,
    getSavedSetup,
    handleConfigureEncounter,
    handleExitFadeTransitionEnd,
    handleMechanicsConfigChange,
    handleReturnToLobby,
    mapLocs,
    persistEncounterMechanicsConfig,
    saveEncounterModifiers,
    saveEncounterStartingHp,
    resetSavedSetup,
    persistEquipmentEncounterKind,
    getActiveSetupLoadout,
    setActiveSetupSupplies,
    beginTutorialSetup,
    updateTutorialSetup,
    endTutorialSetup,
    sceneLoadId,
    sceneState,
    selectedLobbyEncounter,
    setSceneState,
    setSelectedLobbyEncounter,
  } = useEncounterManager({
    attackStylePerCategory,
    bindingsRef: encounterBindingsRef,
    cacheManagerRef,
    getEncounterEquipment,
    getEncounterInventory,
    getEncounterSupplies,
    isFullyLoaded,
    mechanicsConfigPerEncounter,
    modifiersPerEncounter,
    startingHpPerEncounter,
    objTypeLoader,
    playerStats,
    setEncounterEquipment,
    setEncounterInventory,
    setEncounterSupplies,
    updateMechanicsConfigPerEncounter,
    updateModifiersPerEncounter,
    updateStartingHpPerEncounter,
    devHarness: harnessMode,
  });
  // The kind Grid builds the displayed scene for, so its sounds come from the same encounter.
  useEventAudioScope(eventAudioPlayerRef, activeEncounterKind);
  const settledEncounterKind =
    sceneState.kind === 'encounter' ? sceneState.encounterKind : sceneState.kind === 'lobby' ? 'lobby' : null;
  const activeTzhaarHpTracker = encounterPluginOptions(
    'tzhaarHpTracker',
    settledEncounterKind,
    tzhaarHpTrackerEnabled,
    tzhaarHpTracker,
  );
  const activeInfernoAdditions = encounterPluginOptions(
    'infernoAdditions',
    settledEncounterKind,
    infernoAdditionsEnabled,
    infernoAdditions,
  );
  const activeColosseumAdditions = encounterPluginOptions(
    'colosseumAdditions',
    settledEncounterKind,
    colosseumAdditionsEnabled,
    colosseumAdditions,
  );
  const pillarAdditions = useMemo(
    () =>
      activeInfernoAdditions || activeColosseumAdditions
        ? { inferno: activeInfernoAdditions, colosseum: activeColosseumAdditions }
        : null,
    [activeInfernoAdditions, activeColosseumAdditions],
  );
  // Restarts and the Combat tab's autocast pick read and write the scene's own loadout: a lesson's
  // preset gear in its tutorial setup, else the saved loadout.
  const getActiveSetupEquipment = useCallback(
    (kind: string) => getActiveSetupLoadout(kind).equipment,
    [getActiveSetupLoadout],
  );
  const getActiveSetupInventory = useCallback(
    (kind: string) => getActiveSetupLoadout(kind).inventory,
    [getActiveSetupLoadout],
  );
  const getActiveSetupSupplies = useCallback(
    (kind: string) => getActiveSetupLoadout(kind).supplies,
    [getActiveSetupLoadout],
  );
  // The running encounter's starting loadout, the one it started from, as the pre-fight card exports
  // it: in-fight swaps and spent supplies never reach it, so a link never carries them.
  const exportEncounterGear = useMemo(() => {
    if (sceneState.kind !== 'encounter') return undefined;
    const kind = sceneState.encounterKind;
    const descriptor = encounterRegistry.getDescriptorForKind(kind);
    return () => exportInventorySetup(descriptor?.displayName ?? kind, getActiveSetupLoadout(kind), objTypeLoader);
  }, [sceneState, getActiveSetupLoadout, objTypeLoader]);
  const availableLinePresets = useMemo(() => getLinePresetsForEncounter(activeEncounterKind), [activeEncounterKind]);

  const {
    markers,
    effectiveMarkers,
    showMarkers,
    showLabels,
    lastColor,
    lastOpacity,
    activePresetIds,
    addMarker,
    removeMarker,
    updateMarkerColor,
    updateMarkerLabel,
    toggleShowMarkers,
    toggleShowLabels,
    clearAllMarkers,
    importMarkers,
    markerWidth: tileMarkerWidth,
    setMarkerWidth: setTileMarkerWidth,
    togglePreset,
    activateAllPresets,
    deactivateAllPresets,
  } = useTileMarkers(activeEncounterKind);
  const {
    lines: lineMarkers,
    userLines: userLineMarkers,
    showLines: showLineMarkers,
    showLabels: showLineMarkerLabels,
    addEdge: addLineEdge,
    removeEdge: removeLineEdge,
    removeLine: removeLineMarker,
    updateEdgeColor: updateLineEdgeColor,
    updateEdgeLabel: updateLineEdgeLabel,
    toggleShowLines: toggleShowLineMarkers,
    toggleShowLabels: toggleShowLineMarkerLabels,
    clearAllLines: clearAllLineMarkers,
    lineWidth: lineMarkerWidth,
    setLineWidth: setLineMarkerWidth,
    activePresetIds: activeLinePresetIds,
    togglePreset: toggleLinePreset,
    deactivateAllPresets: deactivateAllLinePresets,
  } = useLineMarkers(activeEncounterKind, availableLinePresets);
  const npcHighlightState = useNpcHighlights();
  const antiDragState = useAntiDrag();
  const xpDropState = useXpDropSettings();
  const bossHealthBarState = useBossHealthBarSettings();
  const inventoryTagState = useInventoryTags();
  const tileIndicatorState = useTileIndicators();
  const quickPrayerSelectionsRef = useRef<string[]>([]);

  useEffect(() => {
    const urlOverride = new URLSearchParams(window.location.search).get('logLevel');
    if (!urlOverride) {
      log.setLevel(logLevel);
    }
  }, [logLevel]);

  const handleRendererChange = (type: 'webgl' | 'canvas2d') => {
    if (type === 'webgl' && rendererType !== 'webgl') {
      setIsSceneReady(false);
    }
    updateSetting('rendererType', type);
  };

  const handleGamePanelPositionChange = useCallback(
    (pos: UIPosition) => {
      updateSetting('gamePanelPosition', pos);
    },
    [updateSetting],
  );

  const handleMinimapPositionChange = useCallback(
    (pos: UIPosition) => {
      updateSetting('minimapPosition', pos);
    },
    [updateSetting],
  );

  const handleCompactOrbsPositionChange = useCallback(
    (pos: UIPosition) => {
      updateSetting('compactOrbsPosition', pos);
    },
    [updateSetting],
  );

  const handleInfoboxPositionChange = useCallback(
    (pos: UIPosition | null) => {
      updateSetting('infoboxPosition', pos);
    },
    [updateSetting],
  );

  // Publish the live scale immediately for panel inputs, replay capture and the
  // Plugins-button cap. Only storage/BroadcastChannel writes wait for the burst.
  const persistUiScale = useCallback((scale: number) => updateSetting('uiScale', scale), [updateSetting]);
  const liveUiScale = useLiveSetting(persistedUiScale, persistUiScale);
  const uiScale = liveUiScale.value;
  const handleUiScaleChange = liveUiScale.change;
  const handleUiScaleSettingChange = liveUiScale.commit;
  const handleVolumeChange = useCallback(
    (key: 'masterVolume' | 'sfxVolume' | 'areaVolume', value: number) => {
      updateSetting(key, Number(value));
    },
    [updateSetting],
  );
  const handleMuteWhenUnfocusedChange = useCallback(
    (value: boolean) => {
      updateSetting('muteWhenUnfocused', value);
    },
    [updateSetting],
  );

  const isNarrowViewport = useIsMobile();
  const isMobileDevice = useIsMobileDevice();
  const markMobileIntroSeen = useCallback(() => updateSetting('hideMobileWarning', true), [updateSetting]);
  const mobileEntry = useMobileEntry({
    isMobileDevice,
    introSeen: hideMobileWarning,
    onIntroSeen: markMobileIntroSeen,
  });

  // "Has fixed layout" — the user has explicitly locked a custom game
  // resolution, opting into a desktop layout regardless of window
  // width. The responsive-collapse-to-mobile behavior must respect this
  // choice; otherwise shrinking the window silently overrides the user's
  // configured layout.
  // Fixed layout owns the frame outright: `gameResolution` is ignored (but
  // deliberately left stored, so it returns intact on the way back to a
  // resizable layout) and the 765x503 client is drawn at `fixedLayoutScale`.
  const isFixedLayout = clientLayoutMode === 'fixed';
  const hasFixedLayout = isFixedLayout || gameResolution.mode === 'fixed';
  // With the Stretched Mode plugin off, Fixed shows the client at its native 765x503, as
  // RuneLite does without its Stretched Mode plugin; the stored choice returns with it.
  const effectiveFixedLayoutScale = stretchedModePluginEnabled ? fixedLayoutScale : 1;
  /** The multiple Fixed is drawn at, or undefined for Fit / Stretch to Window. */
  const requestedFixedScale = typeof effectiveFixedLayoutScale === 'number' ? effectiveFixedLayoutScale : undefined;

  // The effective "is mobile" signal for layout decisions:
  //   - true  → collapse sidebars to full-screen drawers, zero canvas insets
  //   - false → keep desktop layout (sidebars reserve canvas space)
  // We treat the layout as desktop whenever the user has a fixed layout
  // active, even if the viewport is narrow. The CSS @media (max-width:
  // 720px) rules are scoped under `.app-container:not(.has-fixed-layout)`
  // so the two sides stay in sync — see the className composition on the
  // root element below.
  const isMobile = isNarrowViewport && !hasFixedLayout;

  // uiInsets: window-relative sidebar widths. Used by window-placed chrome
  // that measures from the window edge, not the frame edge (the top chrome,
  // and CSS through --ui-inset-*), and to center a placed frame or a replay
  // beside the open sidebars.
  //
  // On mobile viewports the side drawers become full-screen overlays
  // and do not reserve any canvas space — collapsing the insets here
  // keeps hit-testing, top-chrome offset, and viewport translation consistent
  // with the CSS overrides in SettingsSidebar/PluginsPanel.
  const uiInsets = useMemo(
    () => ({
      left: !isMobile && controlsVisible ? SIDEBAR_PANEL_WIDTH_PX : 0,
      right: !isMobile && pluginsVisible ? SIDEBAR_PANEL_WIDTH_PX : 0,
      top: 0,
      bottom: 0,
    }),
    [controlsVisible, pluginsVisible, isMobile],
  );

  // Track window dimensions so we can recompute frame overlap and detect
  // when the locked resolution no longer fits inside the current window.
  const [windowSize, setWindowSize] = useState<{ width: number; height: number }>(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 0,
    height: typeof window !== 'undefined' ? window.innerHeight : 0,
  }));
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  const overlaySpaces = useMemo(
    () =>
      overlaySpacesForLayout({
        layout: clientLayoutMode,
        window: windowSize,
        fixedLayoutScale: effectiveFixedLayoutScale,
        fixedIntegerScaling: fixedLayoutIntegerScaling,
        resolution: gameResolution.mode === 'fixed' ? gameResolution : null,
      }),
    [clientLayoutMode, windowSize, effectiveFixedLayoutScale, fixedLayoutIntegerScaling, gameResolution],
  );
  // Auto sizes each surface from the space it lives in: the menu buttons and the replay
  // transport from the window, the plugin overlays from the game view (they differ
  // in Fixed and with a set resolution). It lands only on sizes that keep the pixel fonts
  // crisp on this display, so it follows the display's pixel ratio too (monitor moves,
  // browser zoom), and it changes only once a resize has settled: while a window edge is
  // dragged everything keeps its size and tracks the window.
  const devicePixelRatio = useDevicePixelRatio(Number.POSITIVE_INFINITY);
  const autoScales = useAutoOverlayScales(overlaySpaces, devicePixelRatio);
  // What is on screen. The Stretched Mode plugin off shows the game UI and the overlays at
  // 100% without touching the stored UI scale; its Auto sizing off shows just the overlays
  // at 100%. Replays record the scene size; the window size is the viewer's own chrome and
  // never recorded.
  const autoSizing = stretchedModePluginEnabled && autoOverlayScaleEnabled;
  const effectiveOverlayScale = autoSizing ? autoScales.scene : 1;
  const effectiveChromeScale = autoSizing ? autoScales.chrome : 1;
  const effectiveUiScale = stretchedModePluginEnabled ? uiScale : 1;
  // The Mobile layout's menu column (in its tool window). The desktop menu is the top chrome's
  // Menu pane (launcher/TopChrome.tsx).
  const navRef = useRef<HTMLElement>(null);

  // The stage the fixed frame is centered in.
  //
  // Centering with `left: 50%` and a negative margin lands the frame on a half
  // pixel whenever the stage or the frame has an odd width, which puts the whole
  // frame off the device pixel grid and makes Chrome resample every layer inside
  // it — a blended row at every sprite boundary in the chrome. Measuring the
  // stage is what lets the frame be centered on whole screen pixels instead.
  //
  // A callback ref, not an effect: the stage mounts only once the app has
  // loaded, so an effect reading a ref on mount finds nothing and never re-runs.
  const [stageBox, setStageBox] = useState<DOMRect | null>(null);
  const measureStage = useCallback((el: HTMLDivElement | null) => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setStageBox(el.getBoundingClientRect()));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The live frame's box when it is smaller than the stage (Fixed's client, or a locked
  // resolution), else null: the frame fills the stage. The one place its origin is decided,
  // for the frame's style, the sidebar overlap and the Mobile chrome that follows it.
  //
  // It is centered in the room the open sidebars leave (`frameOrigin`), so opening one moves
  // the frame beside it rather than under it, as the resizable layouts keep the player centered
  // there. It moves at once, not on the drawers' slide: the chrome placed against it (the top
  // chrome, the hint toast, the replay workspace) measures it when its style changes, and a
  // transition would leave them all reading where it started. Fixed is centered on whole SCREEN
  // pixels once the stage has been measured: the frame is the box every rectangle inside it is
  // snapped against, so it has to sit on the device grid itself.
  //
  // `width`/`height` are the box it occupies on screen; `layoutWidth`/`layoutHeight` the box it is
  // laid out in. They differ only under Stretch to Window, which fills the room beside the open
  // sidebars (so it never sits under one) by drawing the uniformly laid-out frame stretched.
  const placedFrame = useMemo(() => {
    const windowArea = { left: 0, top: 0, width: windowSize.width, height: windowSize.height };
    if (isFixedLayout) {
      const stretch = effectiveFixedLayoutScale === 'stretch';
      const { layout, painted } = placeFixedFrame(
        stretch ? Math.max(0, windowSize.width - uiInsets.left - uiInsets.right) : windowSize.width,
        windowSize.height,
        effectiveFixedLayoutScale,
        fixedLayoutIntegerScaling,
      );
      const area = stageBox ?? windowArea;
      const origin = frameOrigin(painted, area, uiInsets);
      return {
        width: painted.width,
        height: painted.height,
        layoutWidth: layout.width,
        layoutHeight: layout.height,
        ...origin,
        windowX: area.left + origin.x,
        windowY: area.top + origin.y,
      };
    }
    if (gameResolution.mode !== 'fixed') return null;
    // Placed in the window, not the measured stage, as it always has been (the stage spans it).
    const origin = frameOrigin(gameResolution, windowArea, uiInsets);
    return {
      width: gameResolution.width,
      height: gameResolution.height,
      layoutWidth: gameResolution.width,
      layoutHeight: gameResolution.height,
      ...origin,
      windowX: origin.x,
      windowY: origin.y,
    };
  }, [
    isFixedLayout,
    gameResolution,
    windowSize,
    effectiveFixedLayoutScale,
    fixedLayoutIntegerScaling,
    stageBox,
    uiInsets,
  ]);
  /**
   * How much larger than laid out the live frame is drawn, per axis: Stretch to Window's residual
   * stretch, else 1. A replay draws the recorder's frame instead, so it never carries this.
   */
  const liveFramePaintScale = useMemo(
    () =>
      placedFrame && (placedFrame.width !== placedFrame.layoutWidth || placedFrame.height !== placedFrame.layoutHeight)
        ? { x: placedFrame.width / placedFrame.layoutWidth, y: placedFrame.height / placedFrame.layoutHeight }
        : null,
    [placedFrame],
  );

  // viewportInsets: frame-local overlap between each sidebar and the
  // game viewport (`.game-viewport-frame`). Used by Grid for its
  // exclusion rects and in-viewport layout (chatbox, Chatbox infobox rows, toasts).
  //
  // A frame that fills the stage sits directly under the sidebars, so its overlap is
  // uiInsets. A placed frame counts only the part of each sidebar that actually covers it:
  // normally none, since it is centered beside them, unless the window is too narrow for both.
  // On mobile the side drawers are full-screen overlays and uiInsets is already zero, so
  // Grid's exclusion rects and viewportOffsetX both see zero.
  const viewportInsets = useMemo(() => {
    const overlap = placedFrame
      ? sidebarOverlap({ x: placedFrame.windowX, width: placedFrame.width }, windowSize.width, uiInsets)
      : uiInsets;
    return { left: overlap.left, right: overlap.right, top: 0, bottom: 0 };
  }, [placedFrame, windowSize.width, uiInsets]);

  // The same insets for CSS, on the root so portalled surfaces read them too: window-centered
  // chrome that stays beside an open sidebar (beneath it, not under a backdrop covering it)
  // centers in the room the sidebars leave.
  useLayoutEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--ui-inset-left', `${uiInsets.left}px`);
    root.setProperty('--ui-inset-right', `${uiInsets.right}px`);
    return () => {
      root.removeProperty('--ui-inset-left');
      root.removeProperty('--ui-inset-right');
    };
  }, [uiInsets]);

  // The canvas offset derives from the sidebar overlap — single source of truth
  // for the sidebar-vs-frame overlap math. It shifts the canvas by half the net
  // overlap to keep the player centered in the visible portion of the frame when
  // a sidebar opens on one side only. Derived from the EFFECTIVE insets below, so
  // replay reproduces the recorder's offset rather than the viewer's.

  // Resolution + letterbox + popout support
  //
  // A selected resolution is never reduced to fit the window. Center it when
  // it fits; otherwise pin its top-left edge and let the stage clip the excess.
  //
  // Only Stretch to Window puts a transform on the frame, and only the residual non-uniform part
  // (one axis is 1): the frame is laid out crisply at its uniform multiple, then stretched. A
  // transform makes the frame the containing block for position: fixed descendants (W3C spec), so
  // nothing window-anchored may render inside it: the live context menu portals to the body, the
  // tooltip to the workspace surface beside the frame (TooltipOverlay), and the top chrome and
  // replay layers to the workspace hosts. Never `will-change`: it would hold the frame on its own
  // layer and blur it at rest.
  const gameFrameStyle = useMemo<React.CSSProperties>(
    () =>
      placedFrame
        ? {
            position: 'absolute',
            width: `${placedFrame.layoutWidth}px`,
            height: `${placedFrame.layoutHeight}px`,
            left: `${placedFrame.x}px`,
            top: `${placedFrame.y}px`,
            ...(liveFramePaintScale
              ? { transform: `scale(${liveFramePaintScale.x}, ${liveFramePaintScale.y})`, transformOrigin: '0 0' }
              : {}),
          }
        : { position: 'absolute', inset: 0 },
    [placedFrame, liveFramePaintScale],
  );

  const handleOpenPopout = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (IS_POPOUT_WINDOW) return;
    // Fixed layout pops out at the multiple it is drawn at (native size when it
    // is fitting the window); a resizable layout uses whatever resolution the
    // user locked, else the generic default.
    const fixedPopoutSize = fixedFrameSizeAtScale(requestedFixedScale ?? 1);
    const targetW = isFixedLayout
      ? fixedPopoutSize.width
      : gameResolution.mode === 'fixed'
        ? gameResolution.width
        : Math.min(POPOUT_DEFAULT_WIDTH_PX, window.screen.availWidth);
    const targetH = isFixedLayout
      ? fixedPopoutSize.height
      : gameResolution.mode === 'fixed'
        ? gameResolution.height
        : Math.min(POPOUT_DEFAULT_HEIGHT_PX, window.screen.availHeight - POPOUT_CHROME_HEIGHT_PX);
    const popoutUrl = new URL(window.location.href);
    popoutUrl.searchParams.set('popout', '1');
    const features = [
      'popup=yes',
      `width=${Math.round(targetW)}`,
      `height=${Math.round(targetH + POPOUT_CHROME_HEIGHT_PX)}`,
      'resizable=yes',
      'scrollbars=no',
      'menubar=no',
      'toolbar=no',
      'location=no',
      'status=no',
    ].join(',');
    const popoutWindow = window.open(popoutUrl.toString(), 'scimgg-popout', features);
    if (!popoutWindow) {
      // Popup was blocked — surface a minimal native prompt rather than
      // silently failing. The design hint underneath the button explains
      // the expected behavior, so this only fires on explicit failure.
      window.alert('Your browser blocked the popout window. Please allow popups for this site and try again.');
    }
  }, [gameResolution, isFixedLayout, requestedFixedScale]);

  /** The frame size the user explicitly asked for, or null for "fill the window". */
  const requestedFrameSize = useMemo(
    () => resolveRequestedFrameSize(clientLayoutMode, gameResolution, effectiveFixedLayoutScale),
    [clientLayoutMode, gameResolution, effectiveFixedLayoutScale],
  );

  // Derived below, once the replay workspace fit it depends on exists.

  const { importExportStatus, handleExportMarkers, handleExportPreset, handleImportMarkers } = useTileMarkerClipboard({
    activeEncounterKind,
    markers,
    importMarkers,
  });
  // A getter, not a value: recording reads the tab at execution time, so a tab
  // change needs no App render to reach the recorder.
  const getReplayUiState = useCallback<() => ReplayUiState>(
    () => ({ activeGamePanelTab: tabStore.getSnapshot() }),
    [tabStore],
  );
  const handleReplayUiStateChange = useCallback(
    (uiState: ReplayUiState) => {
      tabStore.set(uiState.activeGamePanelTab);
    },
    [tabStore],
  );
  // The live layout is derived further down (it needs values this hook call
  // returns), so `startRun` reaches it through a ref rather than a value that
  // does not exist yet.
  const presentationSourceRef = useRef<ReplayPresentationState | null>(null);
  const getPresentationState = useCallback(() => {
    const source = presentationSourceRef.current;
    if (!source) return null;
    const activeGamePanelTab = tabStore.getSnapshot();
    const current =
      source.variants.activeGamePanelTab === activeGamePanelTab
        ? source
        : {
            ...source,
            variants: { ...source.variants, activeGamePanelTab },
          };
    const solved = capturePanelLayout(current, panelLayout?.getPositions() ?? new Map());
    // Grid and App have separate frame observers. Never pair a solved B position
    // with frame A metadata while those observers are converging, but always seed
    // capture once frame metadata exists. An unmeasured/hidden Grid can keep the
    // solver on a zero-sized viewport indefinitely. Use the coherent settings/
    // default fallback until a matching publication replaces it, not a nullable
    // "last solved" snapshot that can leave the whole recording without a layout.
    return solved ?? current;
  }, [panelLayout, tabStore]);
  /**
   * The markers `startRun` snapshots for the run. Unlike the layout these values
   * are all in scope by now, so the ref exists only to keep `getOverlays` stable
   * for the wiring hook below.
   */
  const liveOverlays = useMemo<ReplayOverlays>(() => {
    const { overlays, omitted } = projectReplayOverlays({
      tileMarkers: effectiveMarkers,
      showTileMarkers: showMarkers,
      showTileMarkerLabels: showLabels,
      tileMarkerWidth,
      lineMarkers,
      showLineMarkers,
      showLineMarkerLabels,
      lineMarkerWidth,
    });
    if (omitted.tileMarkers > 0 || omitted.lineMarkers > 0) {
      log.warn(
        'Replay',
        `A replay cannot carry every marker on screen: omitting ${omitted.tileMarkers} tile and ${omitted.lineMarkers} line markers. They stay on screen and in your settings.`,
      );
    }
    return overlays;
  }, [
    effectiveMarkers,
    showMarkers,
    showLabels,
    tileMarkerWidth,
    lineMarkers,
    showLineMarkers,
    showLineMarkerLabels,
    lineMarkerWidth,
  ]);
  const liveOverlaysRef = useRef(liveOverlays);
  liveOverlaysRef.current = liveOverlays;
  const getOverlays = useCallback(() => liveOverlaysRef.current, []);
  const replayViewportStateGetterRef = useRef<(() => ReplayViewportState | undefined) | null>(null);
  const getReplayViewportState = useCallback(() => replayViewportStateGetterRef.current?.(), []);
  const handleReplayViewportStateGetterChange = useCallback(
    (getter: (() => ReplayViewportState | undefined) | null) => {
      replayViewportStateGetterRef.current = getter;
    },
    [],
  );
  const introTimingGetterRef = useRef<((expectedSpeedMultiplier: number) => number | null) | null>(null);
  const getIntroAnimationRemainingMs = useCallback(
    (expectedSpeedMultiplier: number) => introTimingGetterRef.current?.(expectedSpeedMultiplier),
    [],
  );
  const handleIntroTimingGetterChange = useCallback(
    (getter: ((expectedSpeedMultiplier: number) => number | null) | null) => {
      introTimingGetterRef.current = getter;
    },
    [],
  );

  /**
   * Whether a modal covers the screen, holding the live fight (not the lobby) and replay playback
   * behind it until the last one closes. Every modal belongs here (and on one of the quick search's two lists
   * below). The death and victory dialogs do not: the fight has already stopped under them.
   */
  const modalCoversFight =
    cacheExplorerOpen ||
    encounterPickerOpen ||
    quickSearchOpen ||
    shortcutsModalOpen ||
    creditsModalOpen ||
    modifiersPicker !== null ||
    tutorialPickerOpen ||
    selectedLobbyEncounter !== null;
  /**
   * Open encounter tools (Edit layout). Not modals, but they hold the fight the same way while open,
   * so nothing (a death, a wave) happens behind the editor. A count, so one tool closing never releases
   * another still open.
   */
  const [openEncounterTools, setOpenEncounterTools] = useState(0);
  const handleEncounterToolOpenChange = useCallback(
    (open: boolean) => setOpenEncounterTools((count) => count + (open ? 1 : -1)),
    [],
  );

  // The tutorial director depends on the simulation below; actions read its hold through this ref.
  const replayPracticeTutorialRef = useRef(false);
  const {
    engineRef,
    handleAttackStyleChange,
    handleSelectedSpellChange,
    handleEquipFromInventory,
    handleEquipmentSlotClick,
    handleIntroComplete,
    fightStartCountdown,
    fightStartCountdownActive,
    fightStartCountdownPhase,
    fightStartPresentation,
    handleFightStartCountdownFinished,
    fastForwardTicks,
    setTutorialPaused,
    handleMarkOfDarknessCast,
    handleDeathChargeCast,
    handleQuickPrayerToggle,
    handleOffensivePrayerChange,
    handleIndependentPrayerChange,
    handlePrayerChange,
    handleReset,
    resetForTutorial,
    handleTutorialReset,
    handleRunToggle,
    handleSceneReady,
    handleSpecialAttackToggle,
    handleSwapInventorySlots,
    handleExecuteEncounterCommand,
    // The encounter's own practice session, where the fight has stages a player repeats rather than
    // one run to restart (Inferno's waves). Shown in the top chrome's session slot, the Mobile Tools
    // Practice session page and the terminal screens; Ctrl+R runs its primary.
    encounterSession,
    handleSetBossHp,
    handleApplyBossHpPreset,
    handleUnequipSlot,
    handleUnequipAmmo,
    handleUseItem,
    handleDropItem,
    playerEquipmentRef,
    playerInventoryRef,
    playerCombatSuppliesRef,
    publishEngineState,
    replay,
    replayPlayerConfig,
    instantInventoryResetToken,
    inputPresentation,
    previewTargetTile,
    prayerPresentation,
    quickPrayersActive,
    setEngine,
    setIsSceneReady,
    setSimulationState,
    setTargetTile,
    simulationState,
    targetTile,
    targetTileRef,
    tickTimingRef,
    dispatchInput,
    focusPaused,
  } = useSimulationWiring({
    activeMechanicsConfig,
    attackStylePerCategory,
    autoAdvance,
    pauseWhenUnfocused,
    // The lobby has no fight to hold, so it keeps ticking (and the player walking) under a modal.
    modalPaused: (modalCoversFight || openEncounterTools > 0) && sceneState.kind !== 'lobby',
    graphicsHeld,
    replayPracticeHeld: replayPracticeTutorialRef,
    replayPracticeUnavailableReason:
      tutorialMode || pendingEncounterTutorialStart !== null
        ? 'Replay practice is unavailable during tutorials.'
        : null,
    // Tutorial runs, and a tutorial about to start in the encounter being entered, have their own holds.
    fightStartCountdownTicks:
      fightStartCountdownEnabled && !tutorialMode && pendingEncounterTutorialStart === null
        ? fightStartCountdownTicks
        : null,
    getIntroAnimationRemainingMs,
    audioEngine,
    eventAudioPlayerRef,
    frameSoundTrackerRef,
    getEncounterEquipment: getActiveSetupEquipment,
    getEncounterInventory: getActiveSetupInventory,
    getEncounterSupplies: getActiveSetupSupplies,
    setEncounterSupplies: setActiveSetupSupplies,
    isFullyLoaded,
    instantInventoryEnabled,
    instantPrayerEnabled,
    objTypeLoader,
    persistEquipmentEncounterKind,
    playerConfig,
    getReplayUiState,
    getReplayViewportState,
    getPresentationState,
    getOverlays,
    onReplayUiStateChange: handleReplayUiStateChange,
    rendererType: effectiveRendererType,
    sceneState,
    setPlayerConfig,
    setSceneState,
    speedMultiplier,
    inputLagMs,
    updateAttackStylePerCategory: (next) => updateSetting('attackStylePerCategory', next),
  });
  // What the graphics hold has paused, for the 3D view's status notice to name: the replay being
  // viewed, or a fight still in progress. Nothing in the lobby, while loading or once a fight ends.
  const graphicsHeldActivity: 'fight' | 'replay' | null = !graphicsHeld
    ? null
    : replay.replayMode
      ? 'replay'
      : sceneState.kind === 'encounter' && simulationState.encounterOutcome.phase === 'active'
        ? 'fight'
        : null;

  // Replay presentation
  //
  // A replayed cursor is only meaningful against the layout it was recorded
  // over, so recording captures that layout and playback renders it instead of
  // the viewer's. Every in-frame widget therefore reads its geometry from the
  // recording while `replayPresentation` is non-null. The viewer's own settings
  // are only shadowed for the duration — nothing here writes them back.
  const replayPresentation = replay.displayPresentationState;
  // The prayer/spellbook arrangement lives in `GamePanel` — the modes in its own
  // state, the filters in its `usePanelFilters` — so it reports itself up here: a
  // second `usePanelFilters` in App would be a
  // separate `useState` that never sees the panel's edits. Null until the panel
  // first mounts, which is why the presentation state omits the field rather than
  // recording an empty arrangement.
  const [reportedPanelPresentation, setReportedPanelPresentation] = useState<ReplayPanelPresentation | null>(null);
  const reportPanelPresentation = useCallback((panel: ReplayPanelPresentation) => {
    setReportedPanelPresentation((previous) => (previous === panel ? previous : panel));
  }, []);
  const [reportedMinimapZoom, setReportedMinimapZoom] = useState(DEFAULT_MINIMAP_ZOOM);
  const reportMinimapZoom = useCallback((zoom: number) => {
    setReportedMinimapZoom((previous) => (previous === zoom ? previous : zoom));
  }, []);

  // One layout for the frame element itself (effectiveGameFrameStyle) and the Mobile chrome that
  // follows it (mobileMenuFrame), so they read the same object or neither does.
  const replayWorkspaceFit = useMemo(
    () =>
      replayPresentation
        ? fitReplayWorkspace(
            replayPresentation,
            windowSize.width,
            windowSize.height,
            requestedFrameSize !== null,
            uiInsets,
          )
        : null,
    [replayPresentation, windowSize, requestedFrameSize, uiInsets],
  );
  const replayFrameLayout = replayWorkspaceFit?.frame ?? null;

  const viewportSizeWarning = useMemo(
    () =>
      resolveViewportSizeWarning({
        presentation: replayPresentation,
        fit: replayWorkspaceFit,
        requestedFrameSize,
        windowWidth: windowSize.width,
        windowHeight: windowSize.height,
      }),
    [replayPresentation, replayWorkspaceFit, requestedFrameSize, windowSize],
  );

  const effectiveViewportInsets = useMemo(
    () =>
      replayPresentation
        ? { left: replayPresentation.insets.left, right: replayPresentation.insets.right, top: 0, bottom: 0 }
        : viewportInsets,
    [replayPresentation, viewportInsets],
  );
  const effectiveViewportOffsetX = useMemo(
    () => (effectiveViewportInsets.left - effectiveViewportInsets.right) / 2,
    [effectiveViewportInsets],
  );

  // `??` is wrong for the nullable positions: a recording that stored `null`
  // means "the panel used its computed default", which must not fall through to
  // the viewer's stored position.
  const effectiveGamePanelPosition = replayPresentation?.panels.gamePanel ?? gamePanelPosition;
  const effectiveMinimapPosition = replayPresentation?.panels.minimap ?? minimapPosition;
  const effectiveCompactOrbsPosition = replayPresentation?.panels.compactOrbs ?? compactOrbsPosition;
  const effectiveInfoboxPosition = replayPresentation ? replayPresentation.panels.infobox : infoboxPosition;
  const effectiveClientLayoutMode = playbackClientLayoutMode(
    clientLayoutMode,
    replayPresentation?.clientLayoutMode,
    isMobileDevice,
  );
  // What the game frame itself is drawn as: always the recording's layout while one plays.
  // Only differs from the effective mode on a phone or tablet, whose own chrome (the tool
  // window and its menu) stays Mobile around a desktop recording's frame.
  const frameClientLayoutMode = replayPresentation?.clientLayoutMode ?? effectiveClientLayoutMode;
  // The device's safe-area insets, read once for every consumer: the recording, the viewer's
  // Mobile chrome (mobileMenuFrame) and Grid's frame.
  const liveSafeAreaInsets = useSafeAreaInsets(clientLayoutMode === 'mobile' || effectiveClientLayoutMode === 'mobile');
  // Warm every interface sprite on mount. Runs here rather than off the cache bootstrap because
  // none of it depends on the OSRS cache: waiting for that download would leave panels cold for
  // the whole of it.
  useEffect(() => {
    void preloadUiAssets();
  }, []);
  const effectiveInfoboxPinTarget = replayPresentation?.variants.infoboxPinTarget ?? infoboxPinTarget;
  const effectiveCompactOrbsEnabled = replayPresentation?.variants.compactOrbsEnabled ?? compactOrbsEnabled;
  const effectiveCompactOrbsLayout = replayPresentation?.variants.compactOrbsLayout ?? compactOrbsLayout;
  const effectiveZukSetTimerPosition = replayPresentation
    ? resolveReplayZukSetTimerPosition(replayPresentation)
    : zukSetTimerPosition;
  // Copied out of the readonly recording into the mutable shape the panel props
  // expect; memoized so the identity only changes when the recording's does.
  const effectiveCompactOrbsOrder = useMemo(
    () => (replayPresentation ? [...replayPresentation.variants.compactOrbsOrder] : compactOrbsOrder),
    [replayPresentation, compactOrbsOrder],
  );
  const effectiveShowCoordinates = replayPresentation?.variants.showCoordinates ?? showCoordinates;
  const tileGrid = useMemo<TileGridStyle | null>(
    () => (tileGridEnabled ? { color: tileGridColor, opacity: tileGridOpacity, width: tileGridWidth } : null),
    [tileGridEnabled, tileGridColor, tileGridOpacity, tileGridWidth],
  );
  const effectiveChatboxVisible = resolveReplayChatboxVisible(replayPresentation, fixedChatboxVisible);

  /**
   * The frame's LOGICAL size, observed rather than read during render.
   *
   * `getBoundingClientRect` here would be a commit behind exactly when it matters:
   * entering and leaving replay changes the frame's own size, and a render-time read
   * still sees the previous one — so the first snapshot of the viewer's next
   * recording could carry the replay's dimensions. A ResizeObserver reports the
   * CONTENT box, which is also what we want on its own merits: it ignores the
   * playback transform and reports the size the layout actually uses.
   */
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const frameObserverRef = useRef<ResizeObserver | null>(null);
  // The observer is attached by the ref callback, NOT by an effect. The frame is
  // mounted conditionally on `isFullyLoaded`, so an effect running once at mount
  // sees no node, never retries, and leaves frameSize frozen at whatever the first
  // measurement happened to be.
  const measureGameFrame = useCallback((node: HTMLDivElement | null) => {
    frameObserverRef.current?.disconnect();
    frameObserverRef.current = null;
    if (!node) {
      setFrameSize(null);
      return;
    }
    const measure = () => {
      setFrameSize((previous) => {
        const next = { width: node.offsetWidth, height: node.offsetHeight };
        if (next.width <= 0 || next.height <= 0) return previous;
        return previous && previous.width === next.width && previous.height === next.height ? previous : next;
      });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    frameObserverRef.current = observer;
  }, []);
  useEffect(() => () => frameObserverRef.current?.disconnect(), []);

  const liveWorkspace = useWorkspaceDockLayout({
    stage: stageBox,
    frameStyle: gameFrameStyle,
    frameSize,
    replaying: replayPresentation !== null,
  });

  // Where the window-fixed hint toast rests, reported by Grid, which lays out the bottom-left corner
  // it sits on.
  const [hintToastAnchor, setHintToastAnchor] = useState<HintToastAnchor | null>(null);
  // The Mobile chrome's scale on this screen, from the whole frame and its safe area. One value
  // for the gameframe Grid draws, the left column drawn here and the recording, so a recording
  // carries exactly the scale that was on screen.
  const liveMobileChromeScale = osmChromeScale({
    interfaceScaling: mobileInterfaceScaling,
    devicePixelRatio,
    viewport: liveWorkspace?.frame ?? frameSize ?? windowSize,
    safeAreaInsets: liveSafeAreaInsets,
  });
  const workspaceGeometry = useMemo(
    () => (replayPresentation ? recordedWorkspace(replayPresentation) : (liveWorkspace?.workspace ?? null)),
    [replayPresentation, liveWorkspace],
  );
  const [workspaceChromeHost, setWorkspaceChromeHost] = useState<HTMLDivElement | null>(null);
  const [workspaceCursorHost, setWorkspaceCursorHost] = useState<HTMLDivElement | null>(null);
  const [workspaceTransportHost, setWorkspaceTransportHost] = useState<HTMLDivElement | null>(null);
  const workspaceContext = useMemo(
    () => ({
      chromeHost: workspaceChromeHost,
      cursorHost: workspaceCursorHost,
      transportHost: workspaceTransportHost,
    }),
    [workspaceChromeHost, workspaceCursorHost, workspaceTransportHost],
  );
  const workspaceX = replayWorkspaceFit?.workspace.offsetX ?? liveWorkspace?.bounds.x ?? 0;
  const workspaceY = replayWorkspaceFit?.workspace.offsetY ?? liveWorkspace?.bounds.y ?? 0;
  const workspaceScale = replayWorkspaceFit?.workspace.scale ?? 1;
  // Live, the workspace is the frame; under Stretch to Window the surface covers the frame as it
  // is painted rather than as laid out, unstretched itself, so the tooltip it hosts stays in window
  // pixels at its own size and can reach the stretched frame's far edges.
  const surfacePaintScale = replayPresentation ? null : liveFramePaintScale;
  const workspaceStyle: React.CSSProperties = {
    left: workspaceX,
    top: workspaceY,
    width: (workspaceGeometry?.width ?? 0) * (surfacePaintScale?.x ?? 1),
    height: (workspaceGeometry?.height ?? 0) * (surfacePaintScale?.y ?? 1),
    visibility: workspaceGeometry ? 'visible' : 'hidden',
    transform: workspaceScale < 1 ? `scale(${workspaceScale})` : undefined,
    transformOrigin: '0 0',
  };

  // Metadata and fallbacks for surfaces not currently mounted. getPresentationState
  // replaces mounted positions from the registry's complete solve before capture.
  // Validate the settings/child-reported source at the replay-schema boundary.
  const lastProjectedPresentationRef = useRef<ReplayPresentationState | null>(null);
  const presentationSource = useMemo<ReplayPresentationState | null>(() => {
    if (!frameSize) return null;
    const projected = projectReplayPresentation(
      {
        clientLayoutMode,
        ...(clientLayoutMode === 'mobile'
          ? // The Mobile chrome is placed inside these, so a Mobile recording carries them.
            { safeAreaInsets: liveSafeAreaInsets, mobileChromeScale: liveMobileChromeScale }
          : {}),
        frame: liveWorkspace?.frame ?? frameSize,
        ...(liveWorkspace ? { workspace: liveWorkspace.workspace } : {}),
        insets: { left: viewportInsets.left, right: viewportInsets.right },
        uiScale: effectiveUiScale,
        overlayScale: effectiveOverlayScale,
        panels: {
          gamePanel: gamePanelPosition,
          minimap: minimapPosition,
          compactOrbs: compactOrbsPosition,
          infobox: infoboxPosition,
          zukSetTimer: resolveZukSetTimerPosition(zukSetTimerPosition, effectiveOverlayScale),
        },
        variants: {
          // Read imperatively: the store subscription below re-records on a tab
          // change, so this must NOT be a memo dependency.
          activeGamePanelTab: tabStore.getSnapshot(),
          compactOrbsEnabled,
          compactOrbsLayout,
          compactOrbsOrder,
          infoboxPinTarget,
          showCoordinates,
          // One setting drives both; the field the recorded layout reads is the one that counts.
          fixedChatboxVisible,
          resizableChatboxVisible: fixedChatboxVisible,
          minimapZoom: reportedMinimapZoom,
          ...(reportedPanelPresentation === null ? {} : { panelPresentation: reportedPanelPresentation }),
        },
      },
      lastProjectedPresentationRef.current,
    );
    lastProjectedPresentationRef.current = projected;
    return projected;
  }, [
    tabStore,
    compactOrbsEnabled,
    compactOrbsLayout,
    compactOrbsOrder,
    compactOrbsPosition,
    fixedChatboxVisible,
    frameSize,
    liveWorkspace,
    gamePanelPosition,
    infoboxPinTarget,
    infoboxPosition,
    minimapPosition,
    reportedMinimapZoom,
    showCoordinates,
    effectiveUiScale,
    viewportInsets,
    effectiveOverlayScale,
    zukSetTimerPosition,
    clientLayoutMode,
    liveSafeAreaInsets,
    liveMobileChromeScale,
    reportedPanelPresentation,
  ]);

  presentationSourceRef.current = presentationSource;
  const recordPresentationState = replay.recordPresentationState;
  useLayoutEffect(() => {
    if (!presentationSource) return;
    let pending = false;
    let disposed = false;
    const record = () => {
      if (pending) return;
      pending = true;
      // Mounts and owner-following can publish more than once in one React commit.
      // Record its complete target layout once, without causing another render.
      queueMicrotask(() => {
        pending = false;
        if (disposed) return;
        const state = getPresentationState();
        if (state) recordPresentationState(state);
      });
    };
    const unsubscribe = panelLayout?.subscribePositions(record);
    record();
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [presentationSource, panelLayout, getPresentationState, recordPresentationState]);

  // The recorded LAYOUT owns the tab (GridProviders prefers it over the per-tick
  // snapshot, which can lag the cursor samples that followed a switch). The tab
  // does not flow through a render, so re-record it straight off the store.
  useEffect(
    () =>
      tabStore.subscribe(() => {
        const state = getPresentationState();
        if (state) recordPresentationState(state);
      }),
    [tabStore, getPresentationState, recordPresentationState],
  );

  /**
   * The frame playback actually draws into: the recorder's frame, at its recorded
   * size, downscaled uniformly only if the viewer has less room than it needs.
   *
   * Never upscaled. When the viewer has the room the frame renders at exactly the
   * recorded size with no transform at all — which keeps the WebGL canvas at its
   * native backing resolution, and keeps this element from becoming the containing
   * block for the `position: fixed` tooltip and context-menu overlays (see the
   * note on gameFrameStyle). Only the downscale path pays that cost.
   */
  const effectiveGameFrameStyle = useMemo<React.CSSProperties>(() => {
    if (!replayPresentation || !replayFrameLayout) return gameFrameStyle;
    const { frame } = replayPresentation;
    const layout = replayFrameLayout;
    const base: React.CSSProperties = {
      position: 'absolute',
      width: `${frame.width}px`,
      height: `${frame.height}px`,
      left: `${layout.offsetX}px`,
      top: `${layout.offsetY}px`,
      // Always its own stacking context, so the recorded context menu (z-index 100000,
      // portalled into this frame) stays beneath the replay cursor layer in the workspace
      // surface. Without it, an unscaled frame let the menu escape above the cursor and
      // click marks, while a scaled frame (its transform isolates) kept it beneath.
      isolation: 'isolate',
    };
    if (layout.scale >= 1) return base;
    return {
      ...base,
      transform: `scale(${layout.scale})`,
      transformOrigin: '0 0',
      // Lets chrome that is NOT part of the recorded scene — the replay transport —
      // cancel the scale and stay legible. Gameplay panels
      // deliberately do not: the recorded cursor has to land on the same inventory
      // slot and the same prayer, which only holds if they scale with the frame.
      '--replay-inverse-scale': `${1 / layout.scale}`,
    } as React.CSSProperties;
  }, [gameFrameStyle, replayPresentation, replayFrameLayout]);
  // Arbitrate exactly one terminal overlay: death wins a same-tick mutual defeat; victory shows
  // only for a live, non-replay, non-tutorial-owned outcome on an encounter with victory metadata.
  const victoryDescriptor = encounterRegistry.getDescriptorForKind(simulationState.encounter.kind)?.victory;
  const terminalDialog = resolveTerminalDialog({
    outcomePhase: simulationState.encounterOutcome.phase,
    playerFailed: simulationState.failedCondition !== null,
    tutorialOwned: tutorialMode,
    isReplaying: replay.replayMode,
    hasVictoryDescriptor: victoryDescriptor !== undefined,
  });

  const closeEncounterPicker = () => {
    setEncounterPickerOpen(false);
    setEncounterPickerSelection(null);
  };
  const closeTutorialPicker = () => {
    setTutorialPickerOpen(false);
    setTutorialPickerInitialCourseId(null);
    // Drop any tutorial that was queued for after-encounter-load. If the user dismisses the
    // picker before the encounter settles, they did not commit to that start; firing it later
    // would surprise them.
    setPendingEncounterTutorialStart(null);
  };
  /**
   * The one handoff into the quick search (Ctrl+K and the menu's Quick search). It opens over
   * everything by closing what it would otherwise open behind, rather than by stacking order:
   * - closed first, since they only show something: the encounter, tutorial and modifier pickers,
   *   Keyboard Shortcuts and Credits;
   * - left alone, with Ctrl+K doing nothing, because closing them would lose work or a decision:
   *   an encounter's loadout editor, the cache explorer, and a fight's death or victory dialog.
   * A new modal belongs on one of these two lists, and on `modalCoversFight` too.
   */
  const quickSearchHeldOff = selectedLobbyEncounter !== null || cacheExplorerOpen || terminalDialog !== 'none';
  const openQuickSearch = () => {
    if (quickSearchHeldOff) return;
    closeEncounterPicker();
    // Only when shown: closing it also drops a tutorial queued to start once an encounter loads.
    if (tutorialPickerOpen) closeTutorialPicker();
    setModifiersPicker(null);
    setShortcutsModalOpen(false);
    setCreditsModalOpen(false);
    setQuickSearchOpen(true);
  };
  const { hintToasts, dismissHintToast, handleHintOptOut } = useGlobalUiShortcuts({
    disabledShortcutHints,
    onReset: replay.replayPractice.onRetry,
    onToggleQuickSearch: () => {
      if (quickSearchOpen) setQuickSearchOpen(false);
      else openQuickSearch();
    },
    onToggleShowFps: () => updateSetting('showFps', !settings.showFps),
    showShortcutHints,
    updateDisabledShortcutHints: (nextDisabledTypes) => updateSetting('disabledShortcutHints', nextDisabledTypes),
  });
  // Spell armed for a manual cast, awaiting a target click. Client-side state in
  // OSRS too: nothing reaches the server until a target is picked.
  const [armedSpell, setArmedSpell] = useState<string | null>(null);
  const { handleTileClick, handleTakeGroundItem, introFadeFading } = useViewportInteraction({
    autoAdvance,
    graphicsHeld,
    engineRef,
    dispatchInput,
    onEnterEncounter: (kind: string) => enterEncounter(kind),
    onSelectLobbyEncounter: (card) => {
      handleConfigureEncounter(card.encounterKind, card.displayName, card.description);
    },
    replay,
    getReplayUiState,
    sceneState,
    publishEngineState,
    setSimulationState,
    setTargetTile,
    simulationState,
    targetTileRef,
    armedSpell,
    setArmedSpell,
    previewTargetTile,
  });
  const simulationStateRef = useRef(simulationState);
  simulationStateRef.current = simulationState;

  // Zuk set timer: a manual, hotkey-driven countdown drawn as its own overlay.
  // Scoped to the Inferno's wave 69, and gated on its `zukSetTimer` mechanics toggle, so its keys
  // are free everywhere else (the ordinary waves included).
  const zukSetTimer = useZukSetTimer({
    enabled:
      !replay.replayMode &&
      zukWaveState(simulationState.encounter) !== null &&
      simulationState.mechanicsConfig.zukSetTimer === true,
    currentTick: simulationState.currentTick,
  });
  encounterBindingsRef.current = {
    engineRef,
    playerEquipmentRef,
    playerInventoryRef,
    playerCombatSuppliesRef,
    replay,
    setEngine,
    setIsSceneReady,
    setPlayerConfig,
    setSimulationState,
    setTargetTile,
    simulationStateRef,
    targetTileRef,
  };

  // Refresh adapter context refs every render so the director's stable
  // adapter callbacks read the latest encounter / mechanics state.
  adapterCtxRef.current = {
    activeEncounterKindForAdapter: activeEncounterKind,
    mechanicsVariantKindForAdapter: mechanicsVariantKind,
  };

  const tutorialDirector = useTutorialDirector({
    isTouchOnly,
    engineRef,
    simulationState,
    completionOwnership: tutorialMode ? 'external-owned' : 'encounter-owned',
    activeEncounterKind,
    settledEncounterKind,
    // A lesson that moves to another encounter (an action, a checkpoint) enters it in a tutorial
    // setup; outside Tutorial Mode it is an ordinary entry.
    enterEncounter: useCallback(
      (kind: string) => enterEncounter(kind, undefined, tutorialMode ? { tutorial: tutorialSetup(kind) } : undefined),
      [enterEncounter, tutorialMode],
    ),
    enterLobby: useCallback(() => enterLobby(), [enterLobby]),
    resetEncounter: useCallback(() => handleTutorialReset('external-owned'), [handleTutorialReset]),
    // A lesson's mechanics go into its tutorial setup, never the player's saved one; that setup keeps
    // Infinite Health on whatever a step asks (dying mid-lesson is a UX failure).
    setMechanics: useCallback(
      (config) => {
        const kind = adapterCtxRef.current.mechanicsVariantKindForAdapter;
        const mechanics = updateTutorialSetup(kind, { mechanics: config });
        // Apply to the engine SYNCHRONOUSLY so the director's next action
        // observes the new mechanics.
        engineRef.current.setMechanicsConfig(mechanics);
      },
      [updateTutorialSetup, engineRef],
    ),
    setTargetTile: useCallback(
      (tile) => {
        setTargetTile(tile);
        targetTileRef.current = tile;
      },
      [setTargetTile, targetTileRef],
    ),
    injectAction: useCallback((action) => engineRef.current.applyAction(action), [engineRef]),
    castMarkOfDarkness: useCallback(() => handleMarkOfDarknessCast(), [handleMarkOfDarknessCast]),
    executeEncounterCommand: useCallback(
      (command) => handleExecuteEncounterCommand(command),
      [handleExecuteEncounterCommand],
    ),
    activateTilePreset: useCallback(
      (presetId: string) => {
        // Tutorial presets are exclusive: a step that activates preset B
        // implicitly replaces preset A from a previous step. Without the
        // preceding deactivate, packs accumulate across steps and the
        // user sees stale tile markers from earlier mechanics still
        // glowing during the next mechanic's lesson.
        const kind = adapterCtxRef.current.activeEncounterKindForAdapter;
        deactivateAllPresets(getPresetsForEncounter(kind).map((p) => p.id));
        activateAllPresets([presetId]);
      },
      [activateAllPresets, deactivateAllPresets],
    ),
    deactivateTilePresets: useCallback(() => {
      const kind = adapterCtxRef.current.activeEncounterKindForAdapter;
      deactivateAllPresets(getPresetsForEncounter(kind).map((p) => p.id));
    }, [deactivateAllPresets]),
    fastForwardTicks,
    setTutorialPaused,
  });
  const _dp = tutorialDirector.directorState.demoPlayback;
  const demoReviewActive = tutorialDirector.directorState.demoPlayback?.mode === 'review';
  const _frameIdx = _dp ? Math.max(0, Math.min(_dp.frames.length - 1, Math.round(_dp.playheadMs / _dp.tickMs))) : 0;
  const demoReviewFrame = demoReviewActive && _dp ? (_dp.frames[_frameIdx] ?? null) : null;
  const advanceDemoPlayhead = tutorialDirector.advanceDemoPlayhead;
  const demoPlaybackIsPlaying = tutorialDirector.directorState.demoPlayback?.isPlaying;
  const demoPlaybackSpeed = tutorialDirector.directorState.demoPlayback?.speed;

  // A demo holds under a modal as the fight does, without changing whether it is playing.
  useEffect(() => {
    if (!demoPlaybackIsPlaying || focusPaused || modalCoversFight) return;
    let rafId = 0;
    let lastMs: number | null = null;
    const tick = (nowMs: number) => {
      if (lastMs !== null) {
        const dtMs = Math.min(nowMs - lastMs, 100);
        advanceDemoPlayhead(dtMs * (demoPlaybackSpeed ?? 1));
      }
      lastMs = nowMs;
      rafId = animationFrames.request(tick);
    };
    rafId = animationFrames.request(tick);
    return () => animationFrames.cancel(rafId);
  }, [advanceDemoPlayhead, demoPlaybackIsPlaying, demoPlaybackSpeed, focusPaused, modalCoversFight]);
  // Synthetic tile markers driven by the active world-highlight tutorial
  // step. Riding the existing TileMarker render pipeline (3D + 2D) lets the
  // overlay show a clear gold target on the world surface regardless of
  // target kind (tile / tiles / tile-region / npc / player).
  const tutorialHighlightMarkers = useMemo<TileMarker[]>(() => {
    const step = tutorialDirector.directorState.currentStep;
    if (!step) return [];
    const t =
      step.kind === 'world-highlight' ? step.target : step.kind === 'info' && step.highlight ? step.highlight : null;
    if (!t) return [];
    const color = '#FFD700';
    const opacity = 0.9;
    switch (t.type) {
      case 'tile':
        return [{ x: t.tile[0], y: t.tile[1], color, opacity }];
      case 'tiles':
        return t.tiles.map((tile) => ({ x: tile[0], y: tile[1], color, opacity }));
      case 'tile-region': {
        const out: TileMarker[] = [];
        for (let dx = 0; dx < t.bounds.width; dx++) {
          for (let dy = 0; dy < t.bounds.height; dy++) {
            out.push({ x: t.bounds.x + dx, y: t.bounds.y + dy, color, opacity });
          }
        }
        return out;
      }
      case 'npc': {
        // NPCs may span multiple tiles (Yama is 5×5 from SW corner). Mark
        // every occupied tile so the target's full footprint is visible.
        const actorId = t.actorId;
        const npc = simulationState.npcs.find((n) => n.id === actorId && n.alive);
        if (!npc) return [];
        const out: TileMarker[] = [];
        for (let dx = 0; dx < npc.size; dx++) {
          for (let dy = 0; dy < npc.size; dy++) {
            out.push({ x: npc.position[0] + dx, y: npc.position[1] + dy, color, opacity });
          }
        }
        return out;
      }
      case 'player':
        return [{ x: simulationState.playerPosition[0], y: simulationState.playerPosition[1], color, opacity }];
    }
  }, [tutorialDirector.directorState.currentStep, simulationState.npcs, simulationState.playerPosition]);
  const tileMarkersWithHighlight = useMemo(
    () =>
      tutorialHighlightMarkers.length === 0 ? effectiveMarkers : [...effectiveMarkers, ...tutorialHighlightMarkers],
    [effectiveMarkers, tutorialHighlightMarkers],
  );
  /**
   * Tile and line markers come from the recording while one is playing, so a
   * replay shows what its recorder had drawn instead of the viewer's current
   * markers. Shadowed for the duration only — the `use*Markers` state these fall
   * back to is never written here, so exiting the replay restores the viewer's.
   */
  const displayOverlays = replay.displayOverlays;
  const displayTileMarkers = useMemo(
    () => (displayOverlays ? [...displayOverlays.tileMarkers] : tileMarkersWithHighlight),
    [displayOverlays, tileMarkersWithHighlight],
  );
  const displayLineMarkers = useMemo(
    () => (displayOverlays ? [...displayOverlays.lineMarkers] : lineMarkers),
    [displayOverlays, lineMarkers],
  );
  // Everything except the marker lists falls back field-for-field to the viewer's
  // own snapshot, so record and display cannot drift apart as fields are added.
  const shownOverlays = displayOverlays ?? liveOverlays;
  /**
   * Marker editing is off for as long as the scene shows the recording's overlays,
   * on BOTH surfaces that can reach it — the scene's context menu and the Plugins
   * panel. In the scene the tile under the cursor carries the RECORDER's marker, so
   * "Remove" would either do nothing or delete the viewer's own marker on that tile;
   * in the Plugins panel every control would edit a list that is not on screen, so
   * "Clear all" would wipe the viewer's markers with no visible effect at all.
   * Routed through one object so the display and the edits cannot disagree.
   */
  const markersReadOnly = displayOverlays !== null;
  const markerEdits = useMemo(() => {
    const editable = !markersReadOnly;
    return {
      addMarker: editable ? addMarker : ignoreMarkerEdit,
      removeMarker: editable ? removeMarker : ignoreMarkerEdit,
      updateMarkerColor: editable ? updateMarkerColor : ignoreMarkerEdit,
      updateMarkerLabel: editable ? updateMarkerLabel : ignoreMarkerEdit,
      addLineEdge: editable ? addLineEdge : ignoreMarkerEdit,
      removeLineEdge: editable ? removeLineEdge : ignoreMarkerEdit,
      updateEdgeColor: editable ? updateLineEdgeColor : ignoreMarkerEdit,
      updateEdgeLabel: editable ? updateLineEdgeLabel : ignoreMarkerEdit,
      toggleShowMarkers: editable ? toggleShowMarkers : ignoreMarkerEdit,
      toggleShowLabels: editable ? toggleShowLabels : ignoreMarkerEdit,
      setTileMarkerWidth: editable ? setTileMarkerWidth : ignoreMarkerEdit,
      clearAllMarkers: editable ? clearAllMarkers : ignoreMarkerEdit,
      togglePreset: editable ? togglePreset : ignoreMarkerEdit,
      importMarkers: editable ? handleImportMarkers : ignoreMarkerEdit,
      toggleShowLineMarkers: editable ? toggleShowLineMarkers : ignoreMarkerEdit,
      toggleShowLineMarkerLabels: editable ? toggleShowLineMarkerLabels : ignoreMarkerEdit,
      setLineMarkerWidth: editable ? setLineMarkerWidth : ignoreMarkerEdit,
      removeLineMarker: editable ? removeLineMarker : ignoreMarkerEdit,
      clearAllLineMarkers: editable ? clearAllLineMarkers : ignoreMarkerEdit,
      toggleLinePreset: editable ? toggleLinePreset : ignoreMarkerEdit,
      deactivateAllLinePresets: editable ? deactivateAllLinePresets : ignoreMarkerEdit,
    };
  }, [
    markersReadOnly,
    addMarker,
    removeMarker,
    updateMarkerColor,
    updateMarkerLabel,
    addLineEdge,
    removeLineEdge,
    updateLineEdgeColor,
    updateLineEdgeLabel,
    toggleShowMarkers,
    toggleShowLabels,
    setTileMarkerWidth,
    clearAllMarkers,
    togglePreset,
    handleImportMarkers,
    toggleShowLineMarkers,
    toggleShowLineMarkerLabels,
    setLineMarkerWidth,
    removeLineMarker,
    clearAllLineMarkers,
    toggleLinePreset,
    deactivateAllLinePresets,
  ]);
  // Practice's view of the scene's setup. A replay's is the recording's, and a tutorial's resets nothing.
  const activeSetupContext = useMemo<SetupContextControls>(() => {
    const { kind, mode, isDefault } = activeSetup;
    return {
      mode,
      isDefault,
      ...(mode === 'saved' && !replay.replayMode ? { onReset: () => resetSavedSetup(kind) } : {}),
    };
  }, [activeSetup, replay.replayMode, resetSavedSetup]);
  const savedInfernoMechanics = useMemo(
    () => getEncounterMergedMechanicsConfig(INFERNO_KIND),
    [getEncounterMergedMechanicsConfig],
  );
  // The address mirrors the saved Inferno setup as a setup link while the Inferno is the route (its
  // fight, or its setup card in the lobby), but never under a replay, whose setup is the recording's.
  const sceneEncounter =
    sceneState.kind === 'encounter'
      ? sceneState.encounterKind
      : sceneState.kind === 'loading'
        ? sceneState.targetEncounter
        : null;
  const infernoRouteQuery = useInfernoSetupQuery(
    useMemo(() => infernoSetupQuery(savedInfernoMechanics), [savedInfernoMechanics]),
    !replay.replayMode &&
      ((sceneEncounter !== null && canonicalEncounterKind(sceneEncounter) === INFERNO_KIND) ||
        (sceneState.kind === 'lobby' && selectedLobbyEncounter?.encounterKind === INFERNO_KIND)),
  );
  // What a setup link changes, for its notice's Undo to put back.
  const infernoStoredMechanics = mechanicsConfigPerEncounter[INFERNO_KIND];
  const storedInfernoChoices = useMemo(
    () => ({ mechanics: infernoStoredMechanics, loadout: getEncounterLoadout(INFERNO_KIND) }),
    [infernoStoredMechanics, getEncounterLoadout],
  );
  // Ahead of the router: an Inferno setup link leaves the address before the router reads it.
  useInfernoSetupLink({
    saved: savedInfernoMechanics,
    saveLoadout: (loadout) => setEncounterLoadout(INFERNO_KIND, loadout),
    openSetup: (mechanics) => {
      const descriptor = encounterRegistry.getDescriptor(INFERNO_KIND);
      handleConfigureEncounter(
        INFERNO_KIND,
        descriptor?.displayName ?? INFERNO_KIND,
        descriptor?.description ?? '',
        // `{}` for a link that applies nothing: still the saved setup, never the defaults.
        mechanics ?? {},
      );
    },
    start: (mechanics, loadout) => enterEncounter(INFERNO_KIND, loadout, { mechanics }),
    stored: storedInfernoChoices,
    restore: ({ mechanics, loadout }) => {
      const next = { ...mechanicsConfigPerEncounter };
      if (mechanics) next[INFERNO_KIND] = mechanics;
      else delete next[INFERNO_KIND];
      updateMechanicsConfigPerEncounter(next);
      setEncounterLoadout(INFERNO_KIND, loadout);
    },
  });
  useRouting(
    sceneState,
    enterEncounter,
    enterLobby,
    encounterRegistry,
    infernoRouteQuery,
    !(harnessMode && devHarness?.fixedAddress),
  );

  useEscapeLayer(ESC_PRIORITY.ARMED_SPELL, armedSpell !== null, () => setArmedSpell(null));
  useEscapeLayer(ESC_PRIORITY.SETTINGS, controlsVisible, () => setControlsVisible(false));
  useEscapeLayer(ESC_PRIORITY.SETTINGS + 1, pluginsVisible, () => setPluginsVisible(false));
  // A link or search result opens the drawer that owns the setting; the drawer does the rest. A
  // game-panel destination opens no drawer: the panel navigates itself, and any drawer over it goes.
  // A search result for the Keyboard Shortcuts reference opens the reference itself (the header's
  // keyboard icon stays its anchor in Settings). Without a keyboard it has nothing to show.
  useRevealAction(KEYBOARD_SHORTCUTS_REFERENCE_ID, isTouchOnly ? null : () => setShortcutsModalOpen(true));
  // Drawers closed here are closed on the player's way somewhere, which keeps a search's way back.
  useSettingsRevealListener(({ surface }) => {
    if (surface === 'action') return;
    if (surface === 'gamepanel') {
      for (const drawer of drawersCoveringGamePanel()) {
        closeDrawerForNavigation(drawer);
        if (drawer === 'settings') setControlsVisible(false);
        else setPluginsVisible(false);
      }
      return;
    }
    const closeOther = drawersConflict();
    if (surface === 'settings') {
      setControlsVisible(true);
      if (closeOther && pluginsVisible) {
        closeDrawerForNavigation('plugins');
        setPluginsVisible(false);
      }
    } else {
      setPluginsVisible(true);
      if (closeOther && controlsVisible) {
        closeDrawerForNavigation('settings');
        setControlsVisible(false);
      }
    }
  });
  useEscapeLayer(ESC_PRIORITY.CACHE_EXPLORER, cacheExplorerOpen, () => setCacheExplorerOpen(false));
  useEscapeLayer(ESC_PRIORITY.CACHE_EXPLORER + 10, selectedLobbyEncounter !== null, () =>
    setSelectedLobbyEncounter(null),
  );

  // Dev UI harness hand-off. The source is refreshed after every COMMIT (not
  // during render, where React may abandon the pass and leave the harness
  // polling state the DOM never showed), and the ref is handed over once the
  // app is loaded. Both effects are dead code in a production build.
  const harnessSourceRef = useRef<DevHarnessSource | null>(null);
  useLayoutEffect(() => {
    if (!import.meta.env.DEV || !harnessMode) return;
    harnessSourceRef.current = {
      engine: engineRef.current,
      encounterKind: activeEncounterKind,
      sceneKind: sceneState.kind,
      sceneLoadId,
      autoAdvance,
      fastForwardTo: fastForwardTicks,
      enterEncounter,
      enterLobby,
      reset: handleReset,
      setGamePanelTab: tabStore.set,
      setBossHp: handleSetBossHp,
      setAutoAdvance: (enabled) => updateSetting('autoAdvance', enabled),
      simulationState,
      replaying: replay.replayMode,
      recordingIdentity: replay.displayHistory,
      installTerminalFixture: async (outcome, practice, signal) => {
        if (import.meta.env.DEV && harnessMode) {
          const original = harnessSourceRef.current;
          const originalEngine = engineRef.current;
          if (original?.encounterKind !== 'yama_p3' || original.sceneKind !== 'encounter') {
            throw new Error('Terminal UI fixtures require a settled base Yama encounter');
          }
          const fixture = await import('./harness/ui/terminalFixtures');
          if (
            signal?.aborted ||
            harnessSourceRef.current?.recordingIdentity !== original.recordingIdentity ||
            engineRef.current !== originalEngine ||
            harnessSourceRef.current?.replaying
          )
            return false;
          replay.loadExternalReplay(fixture.terminalFixturePrefix(originalEngine.getRunConfig()));
          replay.controlProps.onSeek(fixture.TERMINAL_PRACTICE_TICK);
          if (practice) await replay.replayPractice.onStartPractice();
          else await replay.controlProps.onTakeOver();
          // Playing tick 10 restores tick 9; the ending then records 10 onward.
          if (
            signal?.aborted ||
            engineRef.current === originalEngine ||
            engineRef.current.currentTick !== fixture.TERMINAL_RESTORED_TICK
          )
            return false;
          const adopted = engineRef.current;
          const deadline = Date.now() + 5000;
          while (
            harnessSourceRef.current?.engine !== adopted ||
            harnessSourceRef.current.replaying ||
            harnessSourceRef.current.simulationState.currentTick !== fixture.TERMINAL_RESTORED_TICK
          ) {
            if (
              signal?.aborted ||
              engineRef.current !== adopted ||
              adopted.currentTick !== fixture.TERMINAL_RESTORED_TICK
            )
              return false;
            if (Date.now() > deadline) throw new Error('Terminal UI fixture takeover did not commit');
            await new Promise((resolve) => setTimeout(resolve, 16));
          }
          // Let the real adoption's commit/effects finish before publishing the authored ending.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (
            signal?.aborted ||
            engineRef.current !== adopted ||
            adopted.currentTick !== fixture.TERMINAL_RESTORED_TICK ||
            harnessSourceRef.current?.replaying
          )
            return false;
          const ending = fixture.terminalFixtureEnding(engineRef.current, outcome);
          for (const frame of ending) {
            replay.recordFrame(frame.state.currentTick, frame.input, frame.state, frame.events);
            setSimulationState(frame.state);
          }
          return true;
        }
        return false;
      },
      ui: {
        setSettingsOpen: setControlsVisible,
        setPluginsOpen: setPluginsVisible,
        openEncounterPicker: () => setEncounterPickerOpen(true),
        openQuickSearch,
        openTutorialPicker: handleOpenTutorialPicker,
        openShortcuts: () => setShortcutsModalOpen(true),
        openCredits: () => setCreditsModalOpen(true),
        openCacheExplorer: () => setCacheExplorerOpen(true),
        openModifiers: openModifiersPicker,
        configureEncounter: (kind, displayName, description, modifierSelection) => {
          handleConfigureEncounter(kind, displayName, description);
          // This bridge is DEV-only (its storage is namespaced): the seed is an ordinary setup edit.
          if (modifierSelection !== undefined) saveEncounterModifiers(kind, modifierSelection);
        },
        startTutorial: startTutorialById,
        toggleQuickPrayers: handleQuickPrayerOrbToggle,
        updateSetting,
      },
    };
  });
  useEffect(() => {
    if (!import.meta.env.DEV || !devHarness || !isFullyLoaded) return;
    devHarness.onReady(harnessSourceRef);
  }, [devHarness, isFullyLoaded]);

  const activeEncounterControls = encounterControlsForKind(engineRef.current.getEncounterKind());
  const encounterMechanicsToggles = activeEncounterControls?.mechanicsToggles ?? [];
  const encounterDebugActions = activeEncounterControls?.debugActions ?? [];
  const encounterDebugFlagInfos = activeEncounterControls?.debugFlags ?? [];
  const handleQuickPrayerSetup = useCallback(() => {
    setQuickPrayerSetupOpen(true);
    setQuickPrayerSetupRequest((request) => request + 1);
  }, []);
  const handleCloseQuickPrayerSetup = useCallback(() => {
    setQuickPrayerSetupOpen(false);
  }, []);
  const handleQuickPrayerSelectionsReady = useCallback((selections: string[]) => {
    quickPrayerSelectionsRef.current = selections;
  }, []);
  const quickPrayerHint = useZoomHintToast({ disabledTypes: disabledShortcutHints });
  const handleQuickPrayerOrbToggle = useCallback(() => {
    if (replay.replayMode) return;
    if (quickPrayerSelectionsRef.current.length === 0) {
      quickPrayerHint.trigger('quick-prayers-empty', 'No quick-prayers selected.', {
        label: 'Set up',
        onClick: handleQuickPrayerSetup,
      });
      return;
    }
    handleQuickPrayerToggle(quickPrayerSelectionsRef.current);
  }, [handleQuickPrayerToggle, handleQuickPrayerSetup, quickPrayerHint.trigger, replay.replayMode]);

  const enterTutorialMode = useCallback(
    (kind: string, loadout?: EncounterLoadout) => {
      // Wipe any in-flight engine state (live Yama attacks, falling axes,
      // projectiles in mid-air, drifted player position) so entering
      // Tutorial Mode always starts from a clean tick-0 slate. Without this,
      // the safety-net pause freezes the world mid-fight and the user sees
      // stale combat chrome on top of a tutorial — the training-space
      // mental model is broken. Reset is harmless on a freshly-loaded
      // encounter (engine is already at tick 0).
      //
      // SimulationEngine.reset() rebuilds the player actor via createPlayerActor
      // which hard-codes equipment: {} + an empty inventory by design (engine
      // doesn't own equipment policy — the React-side caller does). The wiring's
      // resetForTutorial() re-applies the loadout passed to it, like handleReset(),
      // so Tutorial Mode entry doesn't visually strip the player of all gear. The
      // refs mirror the last published engine state, so they carry the live
      // loadout — including any mid-fight gear swap. It also starts a new
      // recording and live tick for the fresh run, applies the mechanics before
      // the recording captures them, and holds the run paused.
      //
      // The run is in a tutorial setup of its own: the encounter's defaults, the account's unlocks
      // and Infinite Health, with `loadout` (a lesson's preset) as its gear when given.
      const mechanicsConfig = beginTutorialSetup(kind, loadout);
      resetForTutorial({
        equipment: playerEquipmentRef.current,
        inventory: playerInventoryRef.current,
        supplies: playerCombatSuppliesRef.current,
        mechanicsConfig,
      });
      setTutorialMode(true);
      setTutorialModeKind(kind);
    },
    [beginTutorialSetup, resetForTutorial, playerEquipmentRef, playerInventoryRef, playerCombatSuppliesRef],
  );

  const exitTutorialMode = useCallback(() => {
    // Tear the director down FIRST so any running tutorial run ends and the
    // dock unmounts in the same transition. Without this the two state
    // machines decouple: leaving Tutorial Mode would leave the director
    // sitting in 'running' / 'awaiting-user' / etc. with the dock still
    // mounted and useless. director.exit() is safe when already idle
    // (no-op) and saves progress for any in-flight tutorial run.
    tutorialDirector.exitTutorial();

    // The scene leaves its tutorial setup for the saved one, applied at once to the live engine. A
    // lesson's gear is swapped back for the saved loadout; nothing was saved, so nothing is restored.
    const dropped = endTutorialSetup();
    const kind = adapterCtxRef.current.mechanicsVariantKindForAdapter;
    engineRef.current.setMechanicsConfig(getEncounterMergedMechanicsConfig(kind));
    if (dropped?.loadout) {
      const restored = getEncounterLoadout(
        resolveEncounterPresetsKey(kind, encounterRegistry.getDescriptorForKind(kind)?.variants),
      );
      setPlayerConfig((prev) => ({ ...prev, equipment: restored.equipment }));
      playerEquipmentRef.current = restored.equipment;
      playerInventoryRef.current = restored.inventory;
      playerCombatSuppliesRef.current = restored.supplies;
      engineRef.current.setEquipment(restored.equipment);
      engineRef.current.setInventory(restored.inventory);
      engineRef.current.setCombatSupplies(restored.supplies);
    }
    setTutorialPaused(false);
    setSimulationState(engineRef.current.getState());
    setTutorialMode(false);
    setTutorialModeKind(null);
  }, [
    endTutorialSetup,
    getEncounterLoadout,
    getEncounterMergedMechanicsConfig,
    setSimulationState,
    tutorialDirector,
    engineRef,
    setTutorialPaused,
    playerEquipmentRef,
    playerInventoryRef,
    setPlayerConfig,
    playerCombatSuppliesRef,
  ]);

  // The encounter picker's Enter: a fresh run of `kind` on its own saved loadout, leaving Tutorial
  // Mode's safety net. Also how a stage of an encounter group moves to another (the Practice pane's
  // link, the Victory screen's Continue). Read through a ref so the callback handed to the grid
  // keeps its identity while `enterEncounter` and the tutorial state change under it.
  const enterEncounterFreshRef = useRef((_kind: string) => {});
  enterEncounterFreshRef.current = (kind: string) => {
    if (tutorialMode) exitTutorialMode();
    enterEncounter(kind);
  };
  const enterEncounterFresh = useCallback((kind: string) => enterEncounterFreshRef.current(kind), []);

  // Whether the Training-button chrome (gold split button + Exit control)
  // should be shown. Combat tutorials drive this via `tutorialMode`; spotlight
  // (non-combat / Driver.js) tutorials drive it via the director's
  // `spotlightActive` flag, so the user gets the same persistent Exit
  // affordance in both flows.
  const tutorialChromeActive = tutorialMode || tutorialDirector.spotlightActive;
  replayPracticeTutorialRef.current = tutorialChromeActive;

  // The first-run menu waits until the player is really in the lobby: the scene starts as the lobby
  // even on a route to an encounter, and passes through it on the way, so it must stay the lobby
  // for a moment first. Never in an encounter, and never over a tour.
  const inQuietLobby = !firstRunMenuShown && isFullyLoaded && settledEncounterKind === 'lobby' && !tutorialChromeActive;
  const [firstRunMenuDue, setFirstRunMenuDue] = useState(false);
  useEffect(() => {
    if (!inQuietLobby) {
      setFirstRunMenuDue(false);
      return;
    }
    const timer = window.setTimeout(() => setFirstRunMenuDue(true), FIRST_RUN_MENU_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [inQuietLobby]);

  // Mobile layout: the menu buttons live in the tool window's Menu tab (MobileToolWindow), which
  // hands this its body to render the nav into. The window holds itself open for a tutorial step
  // that points inside it.
  const isMobileLayout = effectiveClientLayoutMode === 'mobile';
  // Every modal's mobile form keys on this one flag on the root (components/ui/mobileSheet).
  useMobileUiRoot(isMobileUi({ touchOnly: isTouchOnly, mobileLayout: isMobileLayout }));
  const [mobileMenuHost, setMobileMenuHost] = useState<HTMLElement | null>(null);
  const placeNav = (nav: React.ReactElement) => mobileMenuHost && createPortal(nav, mobileMenuHost);
  // Explanations in the Mobile layout are hover cards, never the browser's title tooltip.
  const navTitle = (text: string) => (isMobileLayout ? undefined : text);
  // The left column's gameframe. While a Mobile recording plays, it is the recorder's frame as
  // the replay draws it, so the pop-out and the full-screen stone sit inside the fitted frame
  // where the recorder's were and their recorded taps line up. Otherwise it is the live frame:
  // the placed frame's box (a locked resolution), or the window.
  const replayMobileFrame =
    replayPresentation?.clientLayoutMode === 'mobile' && replayFrameLayout ? replayPresentation : null;
  const mobileMenuFrame = useMemo(() => {
    if (replayMobileFrame && replayFrameLayout) {
      return osmFramePlaced(
        replayMobileFrame.frame,
        resolveReplaySafeAreaInsets(replayMobileFrame, liveSafeAreaInsets),
        resolveReplayMobileChromeScale(replayMobileFrame, liveMobileChromeScale),
        replayFrameLayout,
      );
    }
    if (!isMobileLayout) return null;
    if (placedFrame) {
      return osmFramePlaced(placedFrame, liveSafeAreaInsets, liveMobileChromeScale, {
        scale: 1,
        offsetX: placedFrame.windowX,
        offsetY: placedFrame.windowY,
      });
    }
    return osmFrame(windowSize, liveSafeAreaInsets, liveMobileChromeScale);
  }, [
    replayMobileFrame,
    replayFrameLayout,
    isMobileLayout,
    placedFrame,
    windowSize,
    liveSafeAreaInsets,
    liveMobileChromeScale,
  ]);
  // The tool window is the viewer's chrome, laid out in the window around whatever the frame
  // draws: `frame` null (a desktop viewer) leaves Grid's desktop top chrome and transport in place.
  // Every page load starts closed (DEFAULT_MOBILE_TOOL_WINDOW); the player's taps hold for this
  // page only, so a reload never reopens it.
  const [mobileToolWindow, setMobileToolWindow] = useState<MobileToolWindowState>(DEFAULT_MOBILE_TOOL_WINDOW);
  // The window only follows playback ending while it is mounted, and Take Over under a desktop
  // recording's layout can unmount it in that same commit. Ending replay mode here, where its
  // state outlives it, keeps it from remounting on a Replay tab with nothing playing.
  const wasReplayingRef = useRef(replay.replayMode);
  useEffect(() => {
    const wasReplaying = wasReplayingRef.current;
    wasReplayingRef.current = replay.replayMode;
    if (wasReplaying && !replay.replayMode) {
      setMobileToolWindow((current) => toolWindowReducer(current, { type: 'replayEnded' }));
    }
  }, [replay.replayMode]);
  const mobileTools = useMemo(
    () => ({
      state: mobileToolWindow,
      onStateChange: setMobileToolWindow,
      tutorialTarget: tutorialDirector.spotlightTarget,
      menuHostRef: setMobileMenuHost,
      frame: mobileMenuFrame,
      viewport: windowSize,
    }),
    [mobileToolWindow, tutorialDirector.spotlightTarget, mobileMenuFrame, windowSize],
  );
  // Suppress the app's Replay pill + bar while a COMBAT tutorial is active so
  // the tutorial beam's own transport is the only playback chrome on screen.
  // Spotlight (app-surface) tutorials keep the pill — the Advanced tutorial's
  // first step asks the user to click it. Grid.tsx gates the pill on
  // replayControls?.hasRecording; flipping it to false here hides the pill
  // without touching the underlying replay state.
  const effectiveReplay = useMemo(
    () => ({
      ...replay,
      controlProps: {
        ...replay.controlProps,
        hasRecording: !tutorialMode && replay.controlProps.hasRecording,
      },
    }),
    [tutorialMode, replay],
  );
  // The Modifiers launcher (desktop top chrome) and its picker, for an encounter whose descriptor
  // offers run modifiers. The picker opens on the running fight's own selection, read from its
  // engine, not the lobby configurer's draft or the descriptor's defaults.
  const runModifierDefinitions = settledEncounterKind
    ? encounterRegistry.getDescriptorForKind(settledEncounterKind)?.modifiers
    : undefined;
  const hasRunModifiers = (runModifierDefinitions?.length ?? 0) > 0;
  const openModifiersPicker = useCallback(() => {
    if (!settledEncounterKind) return;
    const definitions = encounterRegistry.getDescriptorForKind(settledEncounterKind)?.modifiers;
    const selection = runModifierSelection(engineRef.current.getRunConfig().bootstrap?.encounterConfig, definitions);
    setModifiersPicker({ kind: settledEncounterKind, selection });
  }, [settledEncounterKind, engineRef]);
  // A picker for a fight that has ended (another encounter, the lobby) or gone under a replay closes.
  useEffect(() => {
    if (modifiersPicker && (modifiersPicker.kind !== settledEncounterKind || replay.replayMode)) {
      setModifiersPicker(null);
    }
  }, [modifiersPicker, settledEncounterKind, replay.replayMode]);
  const topChromeModifiers = useMemo(
    () => (hasRunModifiers ? { open: modifiersPicker !== null, onOpen: openModifiersPicker } : null),
    [hasRunModifiers, modifiersPicker, openModifiersPicker],
  );

  const handleTutorialExit = useCallback(() => {
    if (tutorialMode) {
      exitTutorialMode();
    } else {
      tutorialDirector.exitTutorial();
    }
  }, [tutorialMode, exitTutorialMode, tutorialDirector]);

  // Opening the Training hub leaves any active spotlight tutorial behind.
  // Exiting first tears down the Driver.js overlay so the picker never stacks
  // on top of a live tutorial (whose overlay would otherwise block clicks).
  // Combat tutorialMode has no full-screen overlay, so it is not exited; the picker only holds its
  // fight, as every modal does.
  // Progress is persisted on exit, and the picker surfaces a resume option.
  const handleOpenTutorialPicker = useCallback(() => {
    if (tutorialDirector.spotlightActive) {
      tutorialDirector.exitTutorial();
    }
    if (tutorialMode && tutorialModeKind) {
      setTutorialPickerInitialCourseId(getCourseForEncounterKind(tutorialModeKind)?.id ?? null);
    } else {
      setTutorialPickerInitialCourseId(null);
    }
    setTutorialPickerOpen(true);
  }, [tutorialDirector, tutorialMode, tutorialModeKind]);

  // Completion modal's "Back to training": finish the run (persists progress,
  // dismisses the completion card) but STAY in Tutorial Mode, then surface the
  // picker so the user can chain into the next drill without re-loading the
  // encounter. Distinct from handleTutorialExit, which fully leaves Tutorial
  // Mode. The idle/complete re-pause effect below keeps the training space
  // frozen under the picker after exitTutorial() resumes the sim.
  const handleBackToTraining = useCallback(() => {
    tutorialDirector.exitTutorial();
    handleOpenTutorialPicker();
  }, [tutorialDirector, handleOpenTutorialPicker]);

  // After a tutorial completes / the user exits the overlay, the director's
  // exit() calls resumeSim() (correct for non-tutorial-mode runs). When
  // Tutorial Mode is on, that resume conflicts with the paused-by-default
  // training space, so we re-pause once the director returns to idle.
  useEffect(() => {
    if (!tutorialMode) return;
    if (tutorialDirector.directorState.phase === 'idle' || tutorialDirector.directorState.phase === 'complete') {
      setTutorialPaused(true);
    }
  }, [tutorialMode, tutorialDirector.directorState.phase, setTutorialPaused]);

  useEffect(() => {
    if (!pendingEncounterTutorialStart) return;
    if (settledEncounterKind !== pendingEncounterTutorialStart.target) return;
    // Two-pass: if Tutorial Mode isn't yet on for the target encounter, flip it
    // and let the effect rerun. Same-tick start would race tutorialMode flushing
    // through to guardedHandlers (see comment near the EncounterPanel callbacks).
    if (!tutorialMode || tutorialModeKind !== pendingEncounterTutorialStart.target) {
      enterTutorialMode(pendingEncounterTutorialStart.target);
      return;
    }
    const { id } = pendingEncounterTutorialStart;
    setPendingEncounterTutorialStart(null);
    tutorialDirector.startTutorial(id);
  }, [
    enterTutorialMode,
    pendingEncounterTutorialStart,
    settledEncounterKind,
    tutorialDirector,
    tutorialMode,
    tutorialModeKind,
  ]);

  // Start a tutorial by id, routing it to its declared scene. Hoisted out of
  // TutorialPickerModal's onStart so the completion card's "Next lesson" action
  // takes the exact same path (scene switch, Tutorial Mode, equipment preset)
  // instead of a second, subtly different one.
  //
  // Routing rule: the tutorial determines its target scene. Onboarding
  // tutorials run in the lobby (no Tutorial Mode wrapper). Encounter
  // tutorials always run inside Tutorial Mode — safety nets on, sim
  // paused-by-default — so they fire against the expected context.
  const startTutorialById = (id: string) => {
    const tutorial = getTutorialById(id);
    const target = tutorial ? getTutorialTargetEncounter(tutorial) : null;
    if (!target) {
      tutorialDirector.startTutorial(id);
      return;
    }

    if (target === 'lobby') {
      // Leave Tutorial Mode before switching to lobby; on a later TM
      // exit the snapshotted encounter mechanics would otherwise
      // restore onto the lobby engine.
      if (tutorialMode) exitTutorialMode();
      const needsLobby = settledEncounterKind !== 'lobby';
      if (needsLobby) enterLobby();
      setTimeout(() => tutorialDirector.startTutorial(id), needsLobby ? 600 : 300);
      return;
    }

    // A per-tutorial equipment preset (if declared) is the tutorial setup's gear: the run uses it,
    // its restarts keep it, and the player's saved loadout is never written.
    const presetKey = tutorial?.encounterContext?.equipmentPresetKey;
    let tutorialLoadout: EncounterLoadout | undefined;
    if (presetKey) {
      const variantDesc = encounterRegistry.getDescriptorForKind(target);
      const presetsKey = resolveEncounterPresetsKey(target, variantDesc?.variants);
      const preset = EQUIPMENT_PRESETS[presetsKey]?.[presetKey];
      if (preset) {
        const presetSupplies = preset.supplies ?? createEmptyCombatSupplies();
        tutorialLoadout = { equipment: preset.equipment, inventory: preset.inventory, supplies: presetSupplies };
        // Sync the engine-facing player refs + config so EVERY downstream
        // branch picks up the preset, not just enterEncounter's. The
        // enterTutorialMode paths (needsTutorialMode branch + the pending
        // start effect) reset the engine and re-apply these refs; the final
        // same-encounter branch reads them on the next reset and pushes the
        // loadout to the live engine directly (below). enterEncounter
        // re-applies the override itself, so the switch branch is unaffected
        // by these redundant writes. Clone the inventory so the engine never
        // mutates the shared EQUIPMENT_PRESETS constant.
        setPlayerConfig((prev) => ({ ...prev, equipment: preset.equipment }));
        playerEquipmentRef.current = preset.equipment;
        playerInventoryRef.current = cloneInventory(preset.inventory);
        playerCombatSuppliesRef.current = presetSupplies;
      }
    }

    // Encounter-bound tutorial: ensure encounter loaded + Tutorial Mode on.
    const needsEncounterSwitch = target !== settledEncounterKind;
    const needsTutorialMode = !tutorialMode || tutorialModeKind !== target;
    if (needsEncounterSwitch) {
      enterEncounter(target, undefined, { tutorial: tutorialSetup(target, tutorialLoadout) });
      setPendingEncounterTutorialStart({ id, target });
      return;
    }
    if (needsTutorialMode) {
      // Same encounter, but Tutorial Mode is not yet active (or active
      // for a different encounter kind). enterTutorialMode dispatches
      // React state plus engine-side pause/infinite-health; the engine
      // updates synchronously but the React-side adapters (e.g. the
      // director's enterEncounter tutorialMode closure) need a render to
      // re-memo. Routing through the pending queue lets the existing
      // settled-effect fire startTutorial after tutorialMode has flushed,
      // so director adapters see the correct state from their first call.
      enterTutorialMode(target, tutorialLoadout);
      setPendingEncounterTutorialStart({ id, target });
      return;
    }
    // Already in Tutorial Mode for this exact encounter: no encounter
    // switch and no enterTutorialMode reset happen before the run, so push
    // the preset loadout to the live engine directly. Without this, picking
    // a tutorial with a loadout from inside its own encounter's Tutorial
    // Mode would run the drill with the previously-loaded gear.
    if (tutorialLoadout) {
      updateTutorialSetup(target, { loadout: tutorialLoadout });
      engineRef.current.setEquipment(tutorialLoadout.equipment);
      engineRef.current.setInventory(playerInventoryRef.current);
      engineRef.current.setCombatSupplies(tutorialLoadout.supplies);
      setSimulationState(engineRef.current.getState());
    }
    tutorialDirector.startTutorial(id);
  };

  // Completion card → next lesson in the same course. Mirrors
  // handleBackToTraining (tear the finished run down first, staying in Tutorial
  // Mode) but chains straight into the next drill instead of the picker.
  const handleStartNextLesson = (id: string) => {
    tutorialDirector.exitTutorial();
    startTutorialById(id);
  };

  // Until a player has opened Training, the desktop menu marks it "Start here". The Mobile menu's
  // two-column grid has no room for the note.
  const startHere = !isMobileLayout && !tutorialPickerSeen && !tutorialChromeActive;
  // The menu's buttons: the desktop top chrome's Menu pane, or the Mobile tool window's Menu tab.
  const navItems = (
    <>
      <button
        type="button"
        className="controls-toggle-open"
        data-menu-item="settings"
        aria-pressed={controlsVisible}
        onClick={() => setControlsVisible(!controlsVisible)}
        title={navTitle(controlsVisible ? 'Hide Settings' : 'Open Settings')}
      >
        {isMobileLayout && <LauncherIcon glyph="modifiers" />}
        {isMobileLayout ? <span>Settings</span> : 'Settings'}
      </button>
      {isFullyLoaded && (
        <>
          <button
            type="button"
            className="controls-toggle-open"
            data-tutorial="encounters-button"
            data-mobile-menu-page="browse"
            onClick={() => setEncounterPickerOpen(true)}
            title={navTitle('Browse encounters')}
          >
            Encounters
          </button>
          {/* Desktop only: the shortcut it names needs a keyboard, and the Mobile menu has no room. */}
          {!isMobileLayout && (
            <button
              type="button"
              className="controls-toggle-open has-shortcut"
              data-menu-item="quick-search"
              onClick={openQuickSearch}
            >
              <span>Quick search</span>
              <span className="launcher-menu__note launcher-menu__shortcut">Ctrl+K</span>
            </button>
          )}
          <div className="tutorials-button-anchor" data-mobile-menu-page="browse">
            <button
              type="button"
              className={`controls-toggle-open${tutorialChromeActive ? ' controls-toggle-open--tutorial-mode controls-toggle-open--split-left' : ''}${startHere ? ' has-note' : ''}`}
              onClick={handleOpenTutorialPicker}
              title={navTitle(
                tutorialMode
                  ? `Browse drills for ${encounterRegistry.getDescriptorForKind(tutorialModeKind ?? '')?.displayName ?? 'this encounter'}`
                  : 'Training',
              )}
            >
              <span>Training</span>
              {startHere && <span className="launcher-menu__note">Start here</span>}
            </button>
            {tutorialChromeActive && (
              <button
                type="button"
                className="controls-toggle-open controls-toggle-open--tutorial-exit controls-toggle-open--split-right"
                onClick={handleTutorialExit}
                title={navTitle(tutorialMode ? 'Exit Training (restore normal mechanics)' : 'Exit tutorial')}
                aria-label={tutorialMode ? 'Exit Training' : 'Exit tutorial'}
              >
                <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
                  <path d="M3 3 L9 9 M3 9 L9 3" />
                </svg>
              </button>
            )}
          </div>
          {/* Mobile keeps the minimap clear: Plugins is a Menu entry there, not a button over it. */}
          {isMobileLayout && (
            <button
              type="button"
              className="controls-toggle-open"
              data-tutorial="plugins-button"
              onClick={() => setPluginsVisible(true)}
            >
              <LauncherIcon glyph="actions" />
              <span>Plugins</span>
            </button>
          )}
        </>
      )}
    </>
  );
  return (
    <HotkeyCustomizationProvider onOpenSettings={() => setControlsVisible(true)}>
      <div
        className={`app-container${IS_POPOUT_WINDOW ? ' app-container--popout' : ''}${hasFixedLayout ? ' has-fixed-layout' : ''}`}
      >
        <TransitionOverlay visible={sceneState.kind === 'loading'} />
        <TickTimingOverlay monitor={tickTimingRef.current} visible={showTickTiming} />
        {/* The desktop readout is the top chrome's, placed beside Plugins (launcher/TopChrome.tsx). */}
        {isMobileLayout && <FpsOverlay visible={showFps} />}
        <SoundDebugOverlay audioEngine={audioEngine} visible={showSoundDebug} controlsVisible={controlsVisible} />
        {showModifierKeys && (
          <ModifierKeysOverlay
            isReplaying={replay.replayMode}
            modifierTrack={replay.modifierTrack}
            replayFrameStore={replay.replayFrameStore}
          />
        )}
        {/* Nothing to load in the harness, and the screen holds a full-viewport
          "Welcome to Gielinor" beat for ~3s that would block every interaction. */}
        {!harnessMode && (
          <LoadingScreen cacheState={cacheDownloadState} isFullyLoaded={isFullyLoaded} onRetry={handleCacheRetry} />
        )}
        <MobileEntry entry={mobileEntry} frame={mobileMenuFrame} />
        {gpuStatus.status !== 'hardware' && (
          <HardwareAccelWarning
            variant="gameplay"
            gpuStatus={gpuStatus.status}
            renderer={gpuStatus.renderer}
            hidden={hideHardwareAccelWarning}
          />
        )}
        <ViewportSizeWarning
          visible={!controlsVisible && viewportSizeWarning !== null}
          width={viewportSizeWarning?.width ?? 0}
          height={viewportSizeWarning?.height ?? 0}
        />

        {selectedLobbyEncounter &&
          (() => {
            const desc = encounterRegistry.getDescriptorForKind(selectedLobbyEncounter.encounterKind);
            const baseKind = desc?.kind ?? selectedLobbyEncounter.encounterKind;
            const variants = desc?.variants;
            const activeVariant = variants?.find((v) => v.encounterKind === selectedLobbyEncounter.encounterKind);
            const presetsKey = resolveEncounterPresetsKey(selectedLobbyEncounter.encounterKind, variants);
            // The setup reads, writes and resets against the SELECTED variant, not the parent
            // descriptor's kind: a variant declares its own toggles and defaults (Forfeit
            // Breath's Infinite Stamina), and resolving them from the parent showed the plain
            // Yama fight's set and stored one contract's overrides on every Yama kind. The card
            // always shows the saved setup, and every edit saves at once.
            const setupKind = selectedLobbyEncounter.encounterKind;
            const saved = getSavedSetup(setupKind);
            return (
              <EncounterPanel
                mobile={effectiveClientLayoutMode === 'mobile'}
                npcModelLoader={loaders.npcModelLoader}
                animationSystem={animationSystem}
                encounterKind={selectedLobbyEncounter.encounterKind}
                displayName={selectedLobbyEncounter.displayName}
                description={selectedLobbyEncounter.description}
                isAvailable={encounterRegistry.hasKind(baseKind) && (activeVariant?.available ?? true)}
                isWorkInProgress={desc?.isWorkInProgress ?? false}
                playerConfig={playerConfig}
                encounterEquipment={getEncounterEquipment(presetsKey)}
                onEquipmentChange={(eq) => setEncounterEquipment(presetsKey, eq)}
                onInventoryChange={(inv) => setEncounterInventory(presetsKey, inv)}
                onLoadoutChange={(loadout) => setEncounterLoadout(presetsKey, loadout)}
                onStatsChange={setPlayerStats}
                objTypeLoader={objTypeLoader}
                mechanicsConfig={saved.mechanics}
                onMechanicsConfigChange={(config) => persistEncounterMechanicsConfig(setupKind, config)}
                keybindingsReadOnly={replay.replayMode}
                modifiers={desc?.modifiers}
                modifierSelection={saved.modifiers}
                onModifierSelectionChange={(selection) => saveEncounterModifiers(setupKind, selection)}
                setupNotes={desc?.setupNotes}
                startingHitpoints={saved.startingHp}
                onStartingHitpointsChange={(hitpoints) => saveEncounterStartingHp(setupKind, hitpoints)}
                setupContext={{
                  mode: saved.mode,
                  isDefault: saved.isDefault,
                  onReset: () => resetSavedSetup(setupKind),
                }}
                mechanicsToggles={
                  encounterControlsForKind(setupKind)?.mechanicsToggles ?? [
                    { key: 'infiniteHealth', label: 'Infinite Health' },
                  ]
                }
                onStart={() => {
                  // An ordinary Start commits to a fight, leaving Tutorial Mode's setup and safety net.
                  if (tutorialMode) exitTutorialMode();
                  enterEncounter(setupKind);
                  setSelectedLobbyEncounter(null);
                }}
                onTutorialMode={(kind) => {
                  // Same route as the picker's Start Tutorial: load the encounter in a tutorial
                  // setup, enter Tutorial Mode (paused + infinite health), and open the tutorial
                  // picker pre-scoped to this encounter's course.
                  enterEncounter(kind, undefined, { tutorial: tutorialSetup(kind) });
                  enterTutorialMode(kind);
                  setSelectedLobbyEncounter(null);
                  setTutorialPickerInitialCourseId(getCourseForEncounterKind(kind)?.id ?? null);
                  setTutorialPickerOpen(true);
                }}
                onClose={() => setSelectedLobbyEncounter(null)}
                inventory={getEncounterInventory(presetsKey)}
                supplies={getEncounterSupplies(presetsKey)}
                variants={variants}
                variantLabel={desc?.variantLabel}
                baseEncounterKind={baseKind}
                onVariantChange={(newKind) => {
                  setSelectedLobbyEncounter((prev) => (prev ? { ...prev, encounterKind: newKind } : prev));
                }}
              />
            );
          })()}

        <CacheExplorer
          isOpen={cacheExplorerOpen}
          onClose={() => setCacheExplorerOpen(false)}
          spotAnimLoader={spotAnimLoader}
          spotAnimModelLoader={spotAnimModelLoader}
          npcTypeLoader={npcTypeLoader}
          modelLoader={modelLoader}
          animationSystem={animationSystem}
          textureLoader={textureLoader}
        />

        <QuickSearch
          isOpen={quickSearchOpen}
          onClose={() => setQuickSearchOpen(false)}
          encounterRegistry={encounterRegistry}
          layout={searchLayoutOf(clientLayoutMode)}
          onChooseEncounter={(selection) => {
            setQuickSearchOpen(false);
            setEncounterPickerSelection(selection);
            setEncounterPickerOpen(true);
          }}
          onBrowseEncounters={() => {
            setQuickSearchOpen(false);
            setEncounterPickerSelection(null);
            setEncounterPickerOpen(true);
          }}
        />
        <EncounterPicker
          isOpen={encounterPickerOpen}
          onClose={closeEncounterPicker}
          onEnter={(kind) => {
            // Regular Enter commits to a fight, leaving Tutorial Mode's safety net.
            enterEncounterFresh(kind);
            setEncounterPickerOpen(false);
          }}
          onConfigure={(kind, displayName, description) => {
            handleConfigureEncounter(kind, displayName, description);
            setEncounterPickerOpen(false);
          }}
          onTutorialMode={(kind) => {
            enterEncounter(kind, undefined, { tutorial: tutorialSetup(kind) });
            enterTutorialMode(kind);
            setEncounterPickerOpen(false);
            setTutorialPickerInitialCourseId(getCourseForEncounterKind(kind)?.id ?? null);
            setTutorialPickerOpen(true);
          }}
          currentEncounterKind={settledEncounterKind}
          initialSelection={encounterPickerSelection}
          encounterRegistry={encounterRegistry}
        />
        {modifiersPicker &&
          (() => {
            const desc = encounterRegistry.getDescriptorForKind(modifiersPicker.kind);
            if (!desc?.modifiers?.length) return null;
            const { kind } = modifiersPicker;
            return (
              <ModifiersModal
                encounterName={desc.displayName}
                modifiers={desc.modifiers}
                initialSelection={modifiersPicker.selection}
                onRestart={(selection) => {
                  // A fresh fight of the same kind on the normal Enter path, so the loadout and the
                  // mechanics settings carry over and the selection is saved as its modifiers; only
                  // Tutorial Mode's setup and safety net are left, as the encounter picker's Enter
                  // leaves them.
                  if (tutorialMode) exitTutorialMode();
                  enterEncounter(kind, undefined, { modifiers: selection });
                  setModifiersPicker(null);
                }}
                onClose={() => setModifiersPicker(null)}
              />
            );
          })()}
        <TutorialPickerModal
          open={tutorialPickerOpen}
          initialCourseId={tutorialPickerInitialCourseId}
          currentSceneKind={settledEncounterKind}
          encounterRegistry={encounterRegistry}
          runningTutorialId={
            tutorialDirector.directorState.tutorial &&
            ['running', 'awaiting-user', 'paused', 'failed'].includes(tutorialDirector.directorState.phase)
              ? tutorialDirector.directorState.tutorial.id
              : null
          }
          onClose={closeTutorialPicker}
          onStart={startTutorialById}
        />

        <KeyboardShortcutsModal
          isOpen={shortcutsModalOpen}
          onClose={() => {
            setShortcutsModalOpen(false);
            const active = document.activeElement;
            if (active instanceof HTMLElement && active !== document.body) {
              active.blur();
            }
          }}
        />

        <CreditsModal isOpen={creditsModalOpen} onClose={() => setCreditsModalOpen(false)} />
        {/* The desktop top chrome (the launcher row, its panes, Plugins) is laid out here, under the
            drawers, by Grid (launcher/TopChrome.tsx). */}
        <div ref={setWorkspaceChromeHost} className="workspace-chrome-host" />
        {mobileMenuFrame && mobileEntry.fullscreenControl && (
          <MobileFullscreenStone
            frame={mobileMenuFrame}
            control={mobileEntry.fullscreenControl}
            onToggle={mobileEntry.toggleFullscreen}
            attention={mobileEntry.stoneAttention}
            tucked={controlsVisible}
          />
        )}
        {mobileMenuFrame && (
          <MobileRestartStone
            frame={mobileMenuFrame}
            slot={mobileEntry.fullscreenControl ? 1 : 0}
            onRestart={handleReset}
            disabled={simulationState.introActive}
            tucked={controlsVisible}
          />
        )}
        {/* Mobile only: the menu's buttons in the tool window's Menu tab. The desktop menu is the top
            chrome's Menu pane. */}
        {isMobileLayout &&
          placeNav(
            <nav
              className={`sidebar-nav sidebar-nav--tools${controlsVisible ? ' sidebar-nav--tucked' : ''}`}
              ref={navRef}
              inert={controlsVisible}
              onMouseDown={keepFocusOffMenuButtons}
            >
              {navItems}
            </nav>,
          )}

        <section className="grid-panel">
          <SettingsSidebar
            visible={controlsVisible}
            onClose={() => setControlsVisible(false)}
            onOpenShortcuts={() => setShortcutsModalOpen(true)}
            onOpenCredits={() => setCreditsModalOpen(true)}
            simulationControls={{
              onReset: handleReset,
              restartShortcutTargetsPractice: replay.replayPractice.startTick !== null || encounterSession !== null,
              resetDisabled: simulationState.introActive,
              speedMultiplier,
              onSpeedChange: (v) => updateSetting('speedMultiplier', v),
              autoAdvance,
              onAutoAdvanceToggle: () => updateSetting('autoAdvance', !autoAdvance),
              pauseWhenUnfocused,
              onPauseWhenUnfocusedChange: (value) => updateSetting('pauseWhenUnfocused', value),
              inputLagMs,
              onInputLagMsChange: (v) => updateSetting('inputLagMs', v),
              fightStartCountdown: fightStartCountdownEnabled,
              onFightStartCountdownChange: (enabled) => updateSetting('fightStartCountdown', enabled),
              fightStartCountdownTicks,
              onFightStartCountdownTicksChange: (ticks) => updateSetting('fightStartCountdownTicks', ticks),
            }}
            displayControls={{
              clientLayoutMode,
              onClientLayoutModeChange: (mode) => updateSetting('clientLayoutMode', mode),
              smoothTerrain,
              onSmoothTerrainToggle: () => updateSetting('smoothTerrain', !smoothTerrain),
              showShortcutHints,
              onShowShortcutHintsToggle: () => {
                const newVal = !showShortcutHints;
                updateSetting('showShortcutHints', newVal);
                if (newVal) updateSetting('disabledShortcutHints', []);
              },
              brightness,
              onBrightnessChange: (v) => updateSetting('brightness', v),
              contrast,
              onContrastChange: (v) => updateSetting('contrast', v),
              saturation,
              onSaturationChange: (v) => updateSetting('saturation', v),
              renderScale: activeRenderScale,
              onRenderScaleChange: (v) =>
                updateSetting(gpuStatus.status === 'hardware' ? 'renderScaleHardware' : 'renderScaleSoftware', v),
              fpsCap,
              onFpsCapChange: (v) => updateSetting('fpsCap', v),
              antiAliasing: settings.antiAliasing,
              onAntiAliasingChange: (v) => updateSetting('antiAliasing', v),
              selectedRenderer: rendererType,
              onRendererChange: handleRendererChange,
              gameResolution,
              onGameResolutionChange: (next) => updateSetting('gameResolution', next),
              interfaceScaling: {
                stretchedModeEnabled: stretchedModePluginEnabled,
                uiScale,
                fixedLayoutScale,
                mobileInterfaceScaling,
              },
              transparentChatbox,
              onTransparentChatboxChange: (next) => updateSetting('transparentChatbox', next),
              transparentSidePanel,
              onTransparentSidePanelChange: (next) => updateSetting('transparentSidePanel', next),
              hotkeysCloseSidePanel,
              onHotkeysCloseSidePanelChange: (next) => updateSetting('hotkeysCloseSidePanel', next),
              clickThroughTransparentChatbox,
              onClickThroughTransparentChatboxChange: (next) => updateSetting('clickThroughTransparentChatbox', next),
              onOpenPopout: handleOpenPopout,
              canPopOut: !IS_POPOUT_WINDOW,
              isPopoutWindow: IS_POPOUT_WINDOW,
              viewportSizeWarning,
            }}
            debugSection={{
              activeEncounterKind,
              encounterDebugFlags,
              onEncounterDebugFlagsChange: setEncounterDebugFlags,
              onReturnToLobby: handleReturnToLobby,
              logLevel,
              onLogLevelChange: (value) => updateSetting('logLevel', value),
              onOpenCacheExplorer: () => setCacheExplorerOpen(true),
              onStartBasicTutorial: () => {
                setControlsVisible(false);
                setTimeout(() => tutorialDirector.startTutorial('main'), 350);
              },
              onStartAdvancedTutorial: () => {
                setControlsVisible(false);
                setTimeout(() => tutorialDirector.startTutorial('advanced'), 350);
              },
            }}
            touchControls={{
              touchLongPressMs,
              onTouchLongPressMsChange: (value) => updateSetting('touchLongPressMs', value),
              touchMenuRowHeight,
              onTouchMenuRowHeightChange: (value) => updateSetting('touchMenuRowHeight', value),
              touchHapticsEnabled,
              onTouchHapticsEnabledChange: (value) => updateSetting('touchHapticsEnabled', value),
              mobileInterfaceScaling,
              onMobileInterfaceScalingChange: (value) => updateSetting('mobileInterfaceScaling', value),
              mobileHotkeys,
              onMobileHotkeysChange: (slots) => updateSetting('mobileHotkeys', slots),
              mobileHotkeysOpenOnLeft,
              onMobileHotkeysOpenOnLeftChange: (value) => updateSetting('mobileHotkeysOpenOnLeft', value),
            }}
            infoboxAppearance={{
              clientLayoutMode,
              pinTarget: infoboxPinTarget,
              onPinTargetChange: (value) => updateSetting('infoboxPinTarget', value),
              textOutlineEnabled: infoboxTextOutlineEnabled,
              onTextOutlineEnabledChange: (value) => updateSetting('infoboxTextOutlineEnabled', value),
              textOutlineColor: infoboxTextOutlineColor,
              onTextOutlineColorChange: (color) => updateSetting('infoboxTextOutlineColor', color),
            }}
          />

          <RendererErrorBoundary>
            {isFullyLoaded && (
              <div className="game-viewport-stage" ref={measureStage}>
                <WorkspaceDockContext.Provider value={workspaceContext}>
                  <div className="game-workspace">
                    <div
                      ref={measureGameFrame}
                      className={`game-viewport-frame game-viewport-frame--${hasFixedLayout ? 'fixed' : 'fit'}`}
                      style={effectiveGameFrameStyle}
                    >
                      <ReplayPresentationProvider
                        presentation={replayPresentation}
                        reportPanelPresentation={reportPanelPresentation}
                        reportMinimapZoom={reportMinimapZoom}
                      >
                        <GridProviders
                          demoDisplayEvents={demoReviewFrame?.events ?? null}
                          demoDisplayState={demoReviewFrame?.state ?? null}
                          simulation={{
                            activeEncounterKind,
                            activeMechanicsConfig,
                            gamePanelTabStore: tabStore,
                            addMarker: markerEdits.addMarker,
                            antiDragState,
                            cacheManager: cacheManagerRef.current,
                            encounterDebugActions,
                            encounterDebugFlags,
                            encounterDescriptor,
                            encounterMechanicsToggles,
                            engine: engineRef.current,
                            eventAudioPlayer: eventAudioPlayerRef.current,
                            frameSoundTracker: frameSoundTrackerRef.current,
                            fightStartCountdownPhase,
                            focusPaused,
                            handleAttackStyleChange,
                            handleSelectedSpellChange,
                            armedSpell,
                            setArmedSpell,
                            handleActiveGamePanelTabChange: tabStore.set,
                            handleEquipFromInventory,
                            handleEquipmentSlotClick,
                            handleIntroComplete,
                            handleMarkOfDarknessCast,
                            handleDeathChargeCast,
                            handleMechanicsConfigChange,
                            setupContext: activeSetupContext,
                            handleQuickPrayerToggle: () => handleQuickPrayerOrbToggle(),
                            handleOffensivePrayerChange,
                            handleIndependentPrayerChange,
                            handlePrayerChange,
                            onCloseQuickPrayerSetup: handleCloseQuickPrayerSetup,
                            onQuickPrayerSelectionsReady: handleQuickPrayerSelectionsReady,
                            onQuickPrayerSetup: handleQuickPrayerSetup,
                            handleReturnToLobby,
                            handleRunToggle,
                            handleSceneReady,
                            handleSpecialAttackToggle,
                            handleSwapInventorySlots,
                            handleTileClick,
                            handleExecuteEncounterCommand,
                            handleSetBossHp,
                            handleApplyBossHpPreset,
                            handleUnequipSlot,
                            handleUnequipAmmo,
                            handleUseItem,
                            handleDropItem,
                            handleTakeGroundItem,
                            instantInventoryResetToken,
                            inputPresentation,
                            prayerPresentation,
                            inventoryTagState,
                            loaders,
                            mapLocs,
                            npcHighlightState,
                            removeMarker: markerEdits.removeMarker,
                            replay: effectiveReplay,
                            onReplayViewportStateGetterChange: handleReplayViewportStateGetterChange,
                            onIntroTimingGetterChange: handleIntroTimingGetterChange,
                            replayPlayerConfig,
                            sceneLoadId,
                            quickPrayerSetupOpen,
                            quickPrayerSetupRequest,
                            quickPrayersActive,
                            showLabels: shownOverlays.showTileMarkerLabels,
                            showMarkers: shownOverlays.showTileMarkers,
                            targetTile,
                            tileIndicatorState,
                            tileMarkerLastColor: lastColor,
                            tileMarkerLastOpacity: lastOpacity,
                            tileMarkers: displayTileMarkers,
                            tileMarkerWidth: shownOverlays.tileMarkerWidth ?? DEFAULT_TILE_MARKER_WIDTH,
                            updateMarkerColor: markerEdits.updateMarkerColor,
                            updateMarkerLabel: markerEdits.updateMarkerLabel,
                            lineMarkers: displayLineMarkers,
                            showLineMarkers: shownOverlays.showLineMarkers,
                            showLineMarkerLabels: shownOverlays.showLineMarkerLabels,
                            lineMarkerWidth: shownOverlays.lineMarkerWidth,
                            addLineEdge: markerEdits.addLineEdge,
                            removeLineEdge: markerEdits.removeLineEdge,
                            updateEdgeColor: markerEdits.updateEdgeColor,
                            updateEdgeLabel: markerEdits.updateEdgeLabel,
                          }}
                          settings={{
                            activeRenderScale,
                            antialias,
                            fpsCap,
                            areaVolume,
                            brightness,
                            contrast,
                            gamePanelPosition: effectiveGamePanelPosition,
                            masterVolume,
                            minimapPosition: effectiveMinimapPosition,
                            compactOrbsPosition: effectiveCompactOrbsPosition,
                            infoboxPosition: effectiveInfoboxPosition,
                            infoboxPinTarget: effectiveInfoboxPinTarget,
                            muteWhenUnfocused,
                            onGamePanelPositionChange: handleGamePanelPositionChange,
                            onMinimapPositionChange: handleMinimapPositionChange,
                            onCompactOrbsPositionChange: handleCompactOrbsPositionChange,
                            onInfoboxPositionChange: handleInfoboxPositionChange,
                            onMuteWhenUnfocusedChange: handleMuteWhenUnfocusedChange,
                            onUiScaleChange: handleUiScaleChange,
                            onVolumeChange: handleVolumeChange,
                            rendererType: effectiveRendererType,
                            saturation,
                            sfxVolume,
                            showCoordinates: effectiveShowCoordinates,
                            tileGrid,
                            showTickCounter,
                            showTickCounterInfobox,
                            showTickCounterOverhead,
                            tickCounterAbovePrayerIcon,
                            tickCounterColors,
                            tickCounterOffsetX,
                            tickCounterOffsetY,
                            smoothTerrain,
                            speedMultiplier,
                            tickCounterFontSize,
                            tickCounterMax,
                            uiInsets,
                            // The VIEWER's own, deliberately: the replay's reaches the panels through
                            // Grid's `forcedScale`, and routing it through here too would seed
                            // TooltipProvider's own scale with it whenever the frame mounts during
                            // playback — stranding the viewer at the recorder's scale on exit.
                            uiScale,
                            viewportInsets: effectiveViewportInsets,
                            viewportOffsetX: effectiveViewportOffsetX,
                          }}
                        >
                          <Grid
                            onRestart={handleReset}
                            exportEncounterGear={exportEncounterGear}
                            onEncounterToolOpenChange={handleEncounterToolOpenChange}
                            replayPractice={replay.replayPractice}
                            encounterSession={encounterSession}
                            sceneOverlay={
                              isFullyLoaded && (
                                <EncounterTitleCard
                                  countdownActive={fightStartCountdownActive}
                                  encounterName={
                                    sceneState.kind === 'encounter' && fightStartPresentation === 'entry'
                                      ? (encounterDescriptor?.displayName ?? null)
                                      : null
                                  }
                                  layoutName={sceneState.kind === 'encounter' ? encounterDescriptor?.displayName : null}
                                  subtitle={
                                    sceneState.kind === 'encounter'
                                      ? (() => {
                                          if (!encounterDescriptor?.displayName) return null;
                                          const parts: string[] = [];
                                          const variant = encounterDescriptor?.variants?.find(
                                            (v) => v.encounterKind === activeEncounterKind,
                                          );
                                          if (variant && variant.encounterKind !== encounterDescriptor?.kind)
                                            parts.push(variant.name);
                                          if (tutorialMode) parts.push('Tutorial Mode');
                                          return parts.length ? parts.join(' · ') : null;
                                        })()
                                      : null
                                  }
                                  countdown={
                                    fightStartCountdown
                                      ? {
                                          ...fightStartCountdown,
                                          encounterName:
                                            fightStartPresentation === 'restart' && encounterDescriptor?.displayName
                                              ? resolveTitleParts(encounterDescriptor.displayName, null).heroName
                                              : null,
                                          onFinished: () => handleFightStartCountdownFinished(fightStartCountdown.key),
                                        }
                                      : undefined
                                  }
                                />
                              )
                            }
                            renderStatus={renderStatus}
                            onRenderStatusChange={setRenderStatus}
                            graphicsHeld={graphicsHeld}
                            graphicsHeldActivity={graphicsHeldActivity}
                            overlayScale={effectiveOverlayScale}
                            chromeScale={effectiveChromeScale}
                            stretchedModePluginEnabled={stretchedModePluginEnabled}
                            overlayOuterScale={workspaceScale}
                            framePaintScale={surfacePaintScale}
                            replayViewportWidth={windowSize.width}
                            clientLayoutMode={frameClientLayoutMode}
                            transparentSidePanel={transparentSidePanel}
                            hotkeysCloseSidePanel={hotkeysCloseSidePanel}
                            cameraPluginEnabled={cameraPluginEnabled}
                            cameraVerticalCamera={cameraVerticalCamera}
                            cameraInvertYaw={cameraInvertYaw}
                            cameraInvertPitch={cameraInvertPitch}
                            cameraInnerZoomLevel={cameraInnerZoomLevel}
                            cameraOuterZoomLimit={cameraOuterZoomLimit}
                            cameraSpeed={cameraSpeed}
                            cameraDragSpeed={cameraDragSpeed}
                            cameraRightClickMovesCamera={cameraRightClickMovesCamera}
                            cameraZoomIncrement={cameraZoomIncrement}
                            showCameraDebug={showCameraDebug}
                            showAttackTimerMetronome={attackTimerMetronomeEnabled && attackTimerMetronomeShowBar}
                            attackCooldownTicks={attackCooldownTicks}
                            showNpcAttackTimerMetronome={npcAttackTimerMetronomeEnabled}
                            entityHider={entityHiderEnabled ? entityHider : null}
                            tzhaarHpTracker={activeTzhaarHpTracker}
                            pillarAdditions={pillarAdditions}
                            customMenuSwapsEnabled={customMenuSwapsEnabled}
                            customMenuSwaps={customMenuSwaps}
                            npcHighlightColorMenuEntries={npcHighlightState.colorMenuEntries}
                            xpDropsEnabled={xpDropState.enabled}
                            onXpDropsToggle={xpDropState.toggleEnabled}
                            xpDropsShowPredictedHit={xpDropState.showPredictedHit}
                            xpDropsGrouped={xpDropState.grouped}
                            xpDropsShowIcons={xpDropState.showIcons}
                            xpDropsSpeed={xpDropState.speed}
                            xpDropsPosition={xpDropState.position}
                            onXpDropsPositionChange={xpDropState.setPosition}
                            bossHealthBarEnabled={bossHealthBarState.enabled}
                            bossHealthBarShowName={bossHealthBarState.showName}
                            bossHealthBarShowValues={bossHealthBarState.showValues}
                            bossHealthBarShowPercentage={bossHealthBarState.showPercentage}
                            bossHealthBarPosition={bossHealthBarState.position}
                            onBossHealthBarPositionChange={bossHealthBarState.setPosition}
                            infoboxTextOutlineColor={infoboxTextOutlineColor}
                            infoboxTextOutlineEnabled={infoboxTextOutlineEnabled}
                            chatboxVisible={effectiveChatboxVisible}
                            onChatboxVisibleChange={(visible) => updateSetting('fixedChatboxVisible', visible)}
                            chatboxTransparent={transparentChatbox}
                            chatboxClickThrough={clickThroughTransparentChatbox}
                            topChrome={
                              isMobileLayout
                                ? undefined
                                : {
                                    menu: {
                                      items: navItems,
                                      pinned: tutorialChromeActive,
                                      openOnce: firstRunMenuDue,
                                      onOpenedOnce: onFirstRunMenuOpened,
                                    },
                                    plugins: isFullyLoaded
                                      ? {
                                          open: pluginsVisible,
                                          inset: uiInsets.right,
                                          onToggle: () => setPluginsVisible((visible) => !visible),
                                        }
                                      : null,
                                    modifiers: topChromeModifiers,
                                    showFps,
                                    settings: { open: controlsVisible, inset: uiInsets.left },
                                    elevated: tutorialDirector.spotlightActive,
                                    // effectiveReplay hides Replay in a combat tutorial: the row is decided without it.
                                    replaySuppressed: tutorialMode,
                                  }
                            }
                            compactOrbs={effectiveCompactOrbsEnabled}
                            compactOrbsLayout={effectiveCompactOrbsLayout}
                            compactOrbsOrder={effectiveCompactOrbsOrder}
                            zukSetTimer={zukSetTimer}
                            zukSetTimerPosition={effectiveZukSetTimerPosition}
                            onZukSetTimerPositionChange={(position) => updateSetting('zukSetTimerPosition', position)}
                            prayerEnabled={prayerEnabled}
                            prayerFlickOrbEnabled={prayerFlickOrbEnabled}
                            prayerFlickAlwaysOn={prayerFlickAlwaysOn}
                            prayerFlickEnabled={prayerFlickEnabled}
                            prayerFlickPosition={prayerFlickPosition}
                            onPrayerFlickPositionChange={(position) => updateSetting('prayerFlickPosition', position)}
                            showDetailedDps={showDetailedDps}
                            dpsOverlayShowDetails={dpsOverlayShowDetails}
                            detailedDpsPosition={detailedDpsPosition}
                            onDetailedDpsPositionChange={(position) => updateSetting('detailedDpsPosition', position)}
                            statusBarsEnabled={statusBarsEnabled}
                            statusBarsShowValues={statusBarsShowValues}
                            mobileHotkeys={mobileHotkeys}
                            mobileHotkeysOpenOnLeft={mobileHotkeysOpenOnLeft}
                            mobileChromeScale={liveMobileChromeScale}
                            liveSafeAreaInsets={liveSafeAreaInsets}
                            mobileTools={mobileTools}
                            onHintToastAnchorChange={setHintToastAnchor}
                          />
                        </GridProviders>
                      </ReplayPresentationProvider>
                    </div>
                    <div className="workspace-presentation-surface" style={workspaceStyle}>
                      <div ref={setWorkspaceCursorHost} className="workspace-cursor-host" />
                    </div>
                    <div ref={setWorkspaceTransportHost} className="workspace-replay-host" />
                  </div>
                </WorkspaceDockContext.Provider>
                <DeathModal
                  replayPractice={replay.replayPractice}
                  encounterSession={encounterSession}
                  visible={terminalDialog === 'death'}
                  failedCondition={simulationState.failedCondition ?? ''}
                  damageHistory={simulationState.damageHistory}
                  onRestart={handleReset}
                  onEnterReplay={replay.controlProps.hasRecording ? replay.controlProps.onEnterReplay : undefined}
                  isReplaying={replay.replayMode}
                  onReturnToLobby={handleReturnToLobby}
                />
                {victoryDescriptor && (
                  <VictoryModal
                    replayPractice={replay.replayPractice}
                    encounterSession={encounterSession}
                    victory={victoryDescriptor}
                    visible={terminalDialog === 'victory'}
                    simulationState={simulationState}
                    onRestart={handleReset}
                    onEnterReplay={replay.controlProps.onEnterReplay}
                    isReplaying={replay.replayMode}
                    onReturnToLobby={handleReturnToLobby}
                    hasRecording={replay.controlProps.hasRecording}
                  />
                )}
              </div>
            )}
            {isFullyLoaded && replay.displayState.introActive && !replay.replayMode && (
              <div
                className={`intro-fade-overlay intro-fade-overlay--active ${introFadeFading ? 'intro-fade-overlay--fading' : ''}`}
                aria-hidden="true"
              />
            )}
            <div
              className={`exit-fade-overlay${exitFadePhase !== 'idle' ? ' exit-fade-overlay--active' : ''}`}
              onTransitionEnd={handleExitFadeTransitionEnd}
              aria-hidden="true"
            />
          </RendererErrorBoundary>

          <PluginsPanel
            visible={pluginsVisible}
            onClose={() => setPluginsVisible(false)}
            encounterKind={settledEncounterKind}
            setTimer={
              isEncounterPluginShown('setTimer', settledEncounterKind)
                ? {
                    enabled: activeMechanicsConfig.zukSetTimer === true,
                    readOnly: replay.replayMode,
                    onToggle: () => {
                      if (replay.replayMode) return;
                      handleMechanicsConfigChange({
                        ...activeMechanicsConfig,
                        zukSetTimer: activeMechanicsConfig.zukSetTimer !== true,
                      });
                    },
                  }
                : undefined
            }
            tileIndicatorsEnabled={tileIndicatorState.enabled}
            onTileIndicatorsToggle={tileIndicatorState.toggleEnabled}
            tileIndicatorConfig={tileIndicatorState.config}
            onTileIndicatorStyleChange={tileIndicatorState.updateTileStyle}
            showTickCounter={showTickCounter}
            onShowTickCounterToggle={() => updateSetting('showTickCounter', !showTickCounter)}
            showTickCounterOverhead={showTickCounterOverhead}
            onShowTickCounterOverheadToggle={() => updateSetting('showTickCounterOverhead', !showTickCounterOverhead)}
            tickCounterAbovePrayerIcon={tickCounterAbovePrayerIcon}
            onTickCounterAbovePrayerIconToggle={() =>
              updateSetting('tickCounterAbovePrayerIcon', !tickCounterAbovePrayerIcon)
            }
            showTickCounterInfobox={showTickCounterInfobox}
            onShowTickCounterInfoboxToggle={() => updateSetting('showTickCounterInfobox', !showTickCounterInfobox)}
            tickCounterMax={tickCounterMax}
            onTickCounterMaxChange={(v) => updateSetting('tickCounterMax', v)}
            tickCounterFontSize={tickCounterFontSize}
            onTickCounterFontSizeChange={(v) => updateSetting('tickCounterFontSize', v)}
            tickCounterColors={tickCounterColors}
            onTickCounterColorsChange={(v) => updateSetting('tickCounterColors', v)}
            tickCounterOffsetX={tickCounterOffsetX}
            tickCounterOffsetY={tickCounterOffsetY}
            onTickCounterOffsetChange={(axis, v) =>
              updateSetting(axis === 'x' ? 'tickCounterOffsetX' : 'tickCounterOffsetY', v)
            }
            showNpcClickbox={showNpcClickbox}
            onShowNpcClickboxToggle={() => updateSetting('showNpcClickbox', !showNpcClickbox)}
            npcAttackTimerMetronomeEnabled={npcAttackTimerMetronomeEnabled}
            onNpcAttackTimerMetronomeToggle={() =>
              updateSetting('npcAttackTimerMetronomeEnabled', !npcAttackTimerMetronomeEnabled)
            }
            showCoordinates={showCoordinates}
            onShowCoordinatesToggle={() => updateSetting('showCoordinates', !showCoordinates)}
            showTickTiming={showTickTiming}
            onShowTickTimingToggle={() => updateSetting('showTickTiming', !showTickTiming)}
            showDetailedDps={showDetailedDps}
            onShowDetailedDpsToggle={() => updateSetting('showDetailedDps', !showDetailedDps)}
            dpsOverlayShowDetails={dpsOverlayShowDetails}
            onDpsOverlayShowDetailsToggle={() => updateSetting('dpsOverlayShowDetails', !dpsOverlayShowDetails)}
            showSoundDebug={showSoundDebug}
            onShowSoundDebugToggle={() => updateSetting('showSoundDebug', !showSoundDebug)}
            showCameraDebug={showCameraDebug}
            onShowCameraDebugToggle={() => updateSetting('showCameraDebug', !showCameraDebug)}
            showModifierKeys={showModifierKeys}
            onShowModifierKeysToggle={() => updateSetting('showModifierKeys', !showModifierKeys)}
            hideHardwareAccelWarning={hideHardwareAccelWarning}
            onHideHardwareAccelWarningToggle={() =>
              updateSetting('hideHardwareAccelWarning', !hideHardwareAccelWarning)
            }
            encounterDebugFlags={encounterDebugFlags}
            onSetEncounterDebugFlag={(key, value) => {
              setEncounterDebugFlag(key, value);
              const settingsKeyMap: Record<string, keyof typeof settings> = {
                damageTiles: 'showDamageTiles',
                waveTiles: 'showWaveTiles',
                fireballDangerTiles: 'showFireballDangerTiles',
              };
              const settingsKey = settingsKeyMap[key];
              if (settingsKey) updateSetting(settingsKey, value);
            }}
            encounterDebugSectionTitle={activeEncounterKind !== 'lobby' ? encounterDescriptor?.displayName : undefined}
            encounterDebugFlagsInfo={encounterDebugFlagInfos}
            tileMarkers={markers}
            showTileMarkers={showMarkers}
            onToggleShowTileMarkers={markerEdits.toggleShowMarkers}
            showTileMarkerLabels={showLabels}
            onToggleShowTileMarkerLabels={markerEdits.toggleShowLabels}
            tileMarkerWidth={tileMarkerWidth}
            onTileMarkerWidthChange={markerEdits.setTileMarkerWidth}
            onRemoveMarker={markerEdits.removeMarker}
            onClearAllMarkers={markerEdits.clearAllMarkers}
            lineMarkers={userLineMarkers}
            showLineMarkers={showLineMarkers}
            onToggleShowLineMarkers={markerEdits.toggleShowLineMarkers}
            showLineMarkerLabels={showLineMarkerLabels}
            onToggleShowLineMarkerLabels={markerEdits.toggleShowLineMarkerLabels}
            lineMarkerWidth={lineMarkerWidth}
            onLineMarkerWidthChange={markerEdits.setLineMarkerWidth}
            availableLinePresets={availableLinePresets}
            activeLinePresetIds={activeLinePresetIds}
            onToggleLinePreset={markerEdits.toggleLinePreset}
            onDeactivateAllLinePresets={markerEdits.deactivateAllLinePresets}
            onRemoveLineMarker={markerEdits.removeLineMarker}
            onClearAllLineMarkers={markerEdits.clearAllLineMarkers}
            markersReadOnly={markersReadOnly}
            npcHighlights={npcHighlightState.highlights}
            showNpcHighlights={npcHighlightState.showHighlights}
            npcHighlightColorMenuEntries={npcHighlightState.colorMenuEntries}
            onToggleNpcHighlightColorMenuEntries={() =>
              npcHighlightState.setColorMenuEntries(!npcHighlightState.colorMenuEntries)
            }
            onToggleShowNpcHighlights={() => npcHighlightState.setShowHighlights(!npcHighlightState.showHighlights)}
            onRemoveNpcHighlight={npcHighlightState.removeHighlight}
            onRemoveAllNpcHighlightsForNpc={npcHighlightState.removeAllForNpc}
            onClearAllNpcHighlights={npcHighlightState.clearAll}
            antiDragEnabled={antiDragState.enabled}
            onAntiDragToggle={antiDragState.toggleEnabled}
            dragOnShiftOnly={antiDragState.onShiftOnly}
            onDragOnShiftOnlyToggle={() => antiDragState.setOnShiftOnly(!antiDragState.onShiftOnly)}
            antiDragDelay={antiDragState.dragDelay}
            onAntiDragDelayChange={antiDragState.setDragDelay}
            antiDragCtrlToDrag={antiDragState.ctrlToDrag}
            onAntiDragCtrlToDragToggle={() => antiDragState.setCtrlToDrag(!antiDragState.ctrlToDrag)}
            xpDropsEnabled={xpDropState.enabled}
            onXpDropsToggle={xpDropState.toggleEnabled}
            xpDropsShowPredictedHit={xpDropState.showPredictedHit}
            onXpDropsPredictedHitToggle={xpDropState.togglePredictedHit}
            xpDropsGrouped={xpDropState.grouped}
            onXpDropsGroupedToggle={xpDropState.toggleGrouped}
            xpDropsShowIcons={xpDropState.showIcons}
            onXpDropsShowIconsToggle={xpDropState.toggleIcons}
            xpDropsSpeed={xpDropState.speed}
            onXpDropsSpeedChange={xpDropState.setSpeed}
            bossHealthBarEnabled={bossHealthBarState.enabled}
            onBossHealthBarToggle={bossHealthBarState.toggleEnabled}
            bossHealthBarShowName={bossHealthBarState.showName}
            onBossHealthBarShowNameToggle={bossHealthBarState.toggleName}
            bossHealthBarShowValues={bossHealthBarState.showValues}
            onBossHealthBarShowValuesToggle={bossHealthBarState.toggleValues}
            bossHealthBarShowPercentage={bossHealthBarState.showPercentage}
            onBossHealthBarShowPercentageToggle={bossHealthBarState.togglePercentage}
            cameraPluginEnabled={cameraPluginEnabled}
            onCameraPluginToggle={() => updateSetting('cameraPluginEnabled', !cameraPluginEnabled)}
            cameraVerticalCamera={cameraVerticalCamera}
            onCameraVerticalCameraToggle={() => updateSetting('cameraVerticalCamera', !cameraVerticalCamera)}
            cameraInvertYaw={cameraInvertYaw}
            onCameraInvertYawToggle={() => updateSetting('cameraInvertYaw', !cameraInvertYaw)}
            cameraInvertPitch={cameraInvertPitch}
            onCameraInvertPitchToggle={() => updateSetting('cameraInvertPitch', !cameraInvertPitch)}
            cameraInnerZoomLevel={cameraInnerZoomLevel}
            onCameraInnerZoomLevelChange={(value) => updateSetting('cameraInnerZoomLevel', value)}
            cameraOuterZoomLimit={cameraOuterZoomLimit}
            onCameraOuterZoomLimitChange={(v) => updateSetting('cameraOuterZoomLimit', v)}
            cameraSpeed={cameraSpeed}
            onCameraSpeedChange={(v) => updateSetting('cameraSpeed', v)}
            cameraDragSpeed={cameraDragSpeed}
            onCameraDragSpeedChange={(v) => updateSetting('cameraDragSpeed', v)}
            cameraRightClickMovesCamera={cameraRightClickMovesCamera}
            onCameraRightClickMovesCameraToggle={() =>
              updateSetting('cameraRightClickMovesCamera', !cameraRightClickMovesCamera)
            }
            cameraZoomIncrement={cameraZoomIncrement}
            onCameraZoomIncrementChange={(v) => updateSetting('cameraZoomIncrement', v)}
            attackTimerMetronomeEnabled={attackTimerMetronomeEnabled}
            onAttackTimerMetronomeToggle={() =>
              updateSetting('attackTimerMetronomeEnabled', !attackTimerMetronomeEnabled)
            }
            attackTimerMetronomeShowBar={attackTimerMetronomeShowBar}
            onAttackTimerMetronomeShowBarToggle={() =>
              updateSetting('attackTimerMetronomeShowBar', !attackTimerMetronomeShowBar)
            }
            attackTimerMetronomeShowTicks={attackTimerMetronomeShowTicks}
            onAttackTimerMetronomeShowTicksToggle={() =>
              updateSetting('attackTimerMetronomeShowTicks', !attackTimerMetronomeShowTicks)
            }
            attackTimerMetronomeFontSize={attackTimerMetronomeFontSize}
            onAttackTimerMetronomeFontSizeChange={(v) => updateSetting('attackTimerMetronomeFontSize', v)}
            attackTimerMetronomeAbovePrayerIcon={attackTimerMetronomeAbovePrayerIcon}
            onAttackTimerMetronomeAbovePrayerIconToggle={() =>
              updateSetting('attackTimerMetronomeAbovePrayerIcon', !attackTimerMetronomeAbovePrayerIcon)
            }
            attackTimerMetronomeOffsetX={attackTimerMetronomeOffsetX}
            attackTimerMetronomeOffsetY={attackTimerMetronomeOffsetY}
            onAttackTimerMetronomeOffsetChange={(axis, v) =>
              updateSetting(axis === 'x' ? 'attackTimerMetronomeOffsetX' : 'attackTimerMetronomeOffsetY', v)
            }
            instantInventoryEnabled={instantInventoryEnabled}
            onInstantInventoryToggle={() => updateSetting('instantInventoryEnabled', !instantInventoryEnabled)}
            instantPrayerEnabled={instantPrayerEnabled}
            onInstantPrayerToggle={() => updateSetting('instantPrayerEnabled', !instantPrayerEnabled)}
            prayerEnabled={prayerEnabled}
            onPrayerToggle={() => updateSetting('prayerEnabled', !prayerEnabled)}
            prayerFlickOrbEnabled={prayerFlickOrbEnabled}
            onPrayerFlickOrbToggle={() => updateSetting('prayerFlickOrbEnabled', !prayerFlickOrbEnabled)}
            prayerFlickAlwaysOn={prayerFlickAlwaysOn}
            onPrayerFlickAlwaysOnToggle={() => updateSetting('prayerFlickAlwaysOn', !prayerFlickAlwaysOn)}
            prayerFlickEnabled={prayerFlickEnabled}
            onPrayerFlickToggle={() => updateSetting('prayerFlickEnabled', !prayerFlickEnabled)}
            tickAudioMetronomeEnabled={tickAudioMetronomeEnabled}
            onTickAudioMetronomeToggle={() => updateSetting('tickAudioMetronomeEnabled', !tickAudioMetronomeEnabled)}
            tickAudioMetronomeTock={tickAudioMetronomeTock}
            onTickAudioMetronomeTockToggle={() => updateSetting('tickAudioMetronomeTock', !tickAudioMetronomeTock)}
            tickAudioMetronomeVolume={tickAudioMetronomeVolume}
            onTickAudioMetronomeVolumeChange={(volume) => updateSetting('tickAudioMetronomeVolume', volume)}
            tileGridEnabled={tileGridEnabled}
            onTileGridToggle={() => updateSetting('tileGridEnabled', !tileGridEnabled)}
            tileGridColor={tileGridColor}
            onTileGridColorChange={(color) => updateSetting('tileGridColor', color)}
            tileGridOpacity={tileGridOpacity}
            onTileGridOpacityChange={(opacity) => updateSetting('tileGridOpacity', opacity)}
            tileGridWidth={tileGridWidth}
            onTileGridWidthChange={(width) => updateSetting('tileGridWidth', width)}
            statusBarsEnabled={statusBarsEnabled}
            onStatusBarsToggle={() => updateSetting('statusBarsEnabled', !statusBarsEnabled)}
            statusBarsShowValues={statusBarsShowValues}
            onStatusBarsShowValuesToggle={() => updateSetting('statusBarsShowValues', !statusBarsShowValues)}
            entityHiderEnabled={entityHiderEnabled}
            onEntityHiderToggle={() => updateSetting('entityHiderEnabled', !entityHiderEnabled)}
            entityHider={entityHider}
            onEntityHiderOptionToggle={(option) =>
              updateSetting('entityHider', { ...entityHider, [option]: !entityHider[option] })
            }
            tzhaarHpTrackerEnabled={tzhaarHpTrackerEnabled}
            onTzhaarHpTrackerToggle={() => updateSetting('tzhaarHpTrackerEnabled', !tzhaarHpTrackerEnabled)}
            tzhaarHpTracker={tzhaarHpTracker}
            onTzhaarHpTrackerChange={(options) => updateSetting('tzhaarHpTracker', options)}
            infernoAdditionsEnabled={infernoAdditionsEnabled}
            onInfernoAdditionsToggle={() => updateSetting('infernoAdditionsEnabled', !infernoAdditionsEnabled)}
            infernoAdditions={infernoAdditions}
            onInfernoAdditionsChange={(options) => updateSetting('infernoAdditions', options)}
            colosseumAdditionsEnabled={colosseumAdditionsEnabled}
            onColosseumAdditionsToggle={() => updateSetting('colosseumAdditionsEnabled', !colosseumAdditionsEnabled)}
            colosseumAdditions={colosseumAdditions}
            onColosseumAdditionsChange={(options) => updateSetting('colosseumAdditions', options)}
            uiScale={uiScale}
            stretchedModePluginEnabled={stretchedModePluginEnabled}
            onStretchedModePluginToggle={() => updateSetting('stretchedModePluginEnabled', !stretchedModePluginEnabled)}
            autoOverlayScaleEnabled={autoOverlayScaleEnabled}
            onAutoOverlayScaleToggle={() => updateSetting('autoOverlayScaleEnabled', !autoOverlayScaleEnabled)}
            onUiScaleChange={handleUiScaleSettingChange}
            fixedLayoutScale={fixedLayoutScale}
            onFixedLayoutScaleChange={(next) => updateSetting('fixedLayoutScale', next)}
            fixedLayoutIntegerScaling={fixedLayoutIntegerScaling}
            onFixedLayoutIntegerScalingChange={(next) => updateSetting('fixedLayoutIntegerScaling', next)}
            customMenuSwapsEnabled={customMenuSwapsEnabled}
            onCustomMenuSwapsToggle={() => updateSetting('customMenuSwapsEnabled', !customMenuSwapsEnabled)}
            customMenuSwaps={customMenuSwaps}
            onCustomMenuSwapsChange={(rules) => updateSetting('customMenuSwaps', rules)}
            fixedLayout={frameClientLayoutMode === 'fixed'}
            mobileLayout={frameClientLayoutMode === 'mobile'}
            compactOrbsEnabled={compactOrbsEnabled}
            onCompactOrbsToggle={() => updateSetting('compactOrbsEnabled', !compactOrbsEnabled)}
            compactOrbsLayout={compactOrbsLayout}
            onCompactOrbsLayoutChange={(layout) => updateSetting('compactOrbsLayout', layout)}
            compactOrbsOrder={compactOrbsOrder}
            onCompactOrbsOrderChange={(order) => updateSetting('compactOrbsOrder', order)}
            showInventoryTags={inventoryTagState.showTags}
            onToggleShowInventoryTags={inventoryTagState.toggleShowTags}
            inventoryTagCount={Object.keys(inventoryTagState.tags).length}
            onClearAllInventoryTags={inventoryTagState.clearAll}
            availablePresets={getListedPresetsForEncounter(activeEncounterKind)}
            activePresetIds={activePresetIds}
            onTogglePreset={markerEdits.togglePreset}
            onDeactivateAllPresets={() =>
              markersReadOnly
                ? undefined
                : deactivateAllPresets(getPresetsForEncounter(activeEncounterKind).map((p) => p.id))
            }
            onImportMarkers={markerEdits.importMarkers}
            onExportMarkers={handleExportMarkers}
            onExportPreset={handleExportPreset}
            importExportStatus={importExportStatus ?? undefined}
          />
        </section>

        <ZoomHintToast
          toasts={[...hintToasts, ...quickPrayerHint.toasts]}
          onDismiss={(id) => {
            dismissHintToast(id);
            quickPrayerHint.dismiss(id);
          }}
          onOptOut={handleHintOptOut}
          anchor={hintToastAnchor}
        />

        <TutorialOverlay
          state={tutorialDirector.directorState}
          onNext={tutorialDirector.nextStep}
          onPrev={tutorialDirector.prevStep}
          onSkip={tutorialDirector.skipStep}
          onRetryCheckpoint={tutorialDirector.retryFromCheckpoint}
          onRetryStep={tutorialDirector.retryStep}
          onStepDemoBack={tutorialDirector.stepDemoBack}
          onStepDemoForward={tutorialDirector.stepDemoForward}
          onSeekDemo={tutorialDirector.seekDemo}
          onPlayDemo={tutorialDirector.playDemo}
          onPauseDemo={tutorialDirector.pauseDemo}
          onPause={tutorialDirector.pauseTutorial}
          onResume={tutorialDirector.resumeTutorial}
          onExit={handleTutorialExit}
          onBackToTraining={handleBackToTraining}
          onStartNextLesson={handleStartNextLesson}
          onJumpToStep={tutorialDirector.goToStep}
          uiScale={effectiveUiScale}
          sidebarInsets={uiInsets}
          onWatchAgain={tutorialDirector.watchAgain}
          onDemoTargetMissing={tutorialDirector.reportDemoTargetMissing}
          demoPlayback={tutorialDirector.directorState.demoPlayback}
          demoReview={
            demoReviewActive && _dp
              ? { cues: _dp.cues, tickMs: _dp.tickMs, playheadMs: _dp.playheadMs, blockInput: _dp.blockInput }
              : null
          }
          demoPlayheadStore={tutorialDirector.demoPlayheadStore}
        />
      </div>
    </HotkeyCustomizationProvider>
  );
}

/** The app, or the unsupported-browser page. `devHarness` as for `App`. */
function BrowserSupportGate(props: { devHarness?: DevHarnessBoot } = {}) {
  const gpuResult = detectGpuStatus();
  if (gpuResult.status === 'no-webgl2') {
    return <BrowserSupportScreen />;
  }
  return <App {...props} />;
}

export default BrowserSupportGate;
