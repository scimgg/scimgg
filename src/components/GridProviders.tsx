import { type ReactNode, useMemo, useRef } from 'react';
import type { EventAudioPlayer, FrameSoundTracker } from '../audio';
import type { CacheManager, LocWithType } from '../cache/CacheManager';
import { DisplayTimelineProvider } from '../contexts/DisplayTimelineContext';
import { GamePanelTabProvider } from '../contexts/GamePanelTabContext';
import { ReplayFrameProvider } from '../contexts/ReplayFrameContext';
import { useReplayPresentation } from '../contexts/ReplayPresentationContext';
import { type SettingsGridContextValue, SettingsProvider } from '../contexts/SettingsContext';
import { type SimulationGridContextValue, SimulationProvider } from '../contexts/SimulationContext';
import { TickProgressProvider } from '../contexts/TickProgressContext';
import type { EncounterCommand } from '../core/encounters/commands';
import type { DebugActionInfo, MechanicsToggleInfo } from '../core/encounters/types';
import type { GameEvent } from '../core/events/types';
import type { GamePanelTabStore } from '../core/gamePanelTabStore';
import type { SimulationEngine } from '../core/SimulationEngine';
import { TickProgressStore } from '../core/tickProgressStore';
import type { InfoboxPinTarget, UIPosition } from '../hooks/usePersistedSettings';
import { useSeedBossHighlights } from '../hooks/useSeedBossHighlights';
import type { UseSimulationWiringReturn } from '../hooks/useSimulationWiring';
import type { FightStartCountdownPhase } from '../render/graphics/sceneObjectTypes';
import { getEncounterRenderConfig } from '../render/scene/encounterRenderConfig';
import type { LineMarker, TileEdgeRef } from '../types/lineMarkers';
import type { PlayerConfig } from '../types/player';
import type { SetupContextControls } from '../types/setupContext';
import type { MechanicsConfig, PrayerType, SimulationState } from '../types/simulation';
import type { TileGridStyle } from '../types/tileGrid';
import type { TileMarker } from '../types/tileMarkers';
import type { TickColorOverrides } from '../util/tickColor';
import type { GridProps } from './Grid';

type AntiDragState = ReturnType<typeof import('../hooks/useAntiDrag').useAntiDrag>;
type CacheBootstrapLoaders = ReturnType<typeof import('../hooks/useCacheBootstrap').useCacheBootstrap>['loaders'];
type InventoryTagState = ReturnType<typeof import('../hooks/useInventoryTags').useInventoryTags>;
type NpcHighlightState = ReturnType<typeof import('../hooks/useNpcHighlights').useNpcHighlights>;
type TileIndicatorState = ReturnType<typeof import('../hooks/useTileIndicators').useTileIndicators>;

interface GridProvidersSimulationProps {
  activeEncounterKind: string;
  activeMechanicsConfig: MechanicsConfig;
  gamePanelTabStore: GamePanelTabStore;
  addMarker: (x: number, y: number) => void;
  antiDragState: AntiDragState;
  cacheManager: CacheManager;
  encounterDebugActions: readonly DebugActionInfo[];
  encounterDebugFlags: Record<string, boolean | number>;
  encounterDescriptor:
    | {
        loadsMapLocs?: boolean;
        isWorkInProgress?: boolean;
      }
    | null
    | undefined;
  encounterMechanicsToggles: readonly MechanicsToggleInfo[];
  engine: SimulationEngine;
  eventAudioPlayer: EventAudioPlayer;
  frameSoundTracker: FrameSoundTracker;
  /** The live start-of-fight countdown, or null when none runs. */
  fightStartCountdownPhase: FightStartCountdownPhase | null;
  focusPaused: boolean;
  /** Spell armed for a manual cast, awaiting a target click. */
  armedSpell: string | null;
  setArmedSpell: (spellName: string | null) => void;
  handleAttackStyleChange: (index: number) => void;
  handleSelectedSpellChange: (spellName: string) => void;
  handleActiveGamePanelTabChange: NonNullable<GridProps['onActiveGamePanelTabChange']>;
  handleEquipFromInventory: GridProps['onEquipFromInventory'];
  handleEquipmentSlotClick: GridProps['onEquipmentSlotClick'];
  handleIntroComplete: () => void;
  handleMarkOfDarknessCast: () => void;
  handleDeathChargeCast: () => void;
  handleMechanicsConfigChange: (config: MechanicsConfig) => void;
  /** The active setup's context and actions (`GridProps.setupContext`). */
  setupContext: SetupContextControls;
  handleQuickPrayerToggle: () => void;
  handleBoostPrayerChange: (prayer: PrayerType | null) => void;
  handleIndependentPrayerChange: (prayer: PrayerType) => void;
  handlePrayerChange: (prayer: PrayerType | null) => void;
  onCloseQuickPrayerSetup?: () => void;
  onQuickPrayerSelectionsReady?: (selections: string[]) => void;
  onQuickPrayerSetup?: () => void;
  handleReturnToLobby: () => void;
  handleRunToggle: () => void;
  handleSceneReady: () => void;
  handleSpecialAttackToggle: () => void;
  handleSwapInventorySlots: (fromIndex: number, toIndex: number) => void;
  handleTileClick: GridProps['onTileClick'];
  handleExecuteEncounterCommand: (command: EncounterCommand) => boolean;
  /** Enter a kind fresh, as the encounter picker's Enter does. */
  handleSetBossHp: (hp: number) => void;
  handleApplyBossHpPreset: (hp: number) => void;
  handleUnequipSlot: (slot: string) => void;
  handleUnequipAmmo: () => void;
  handleUseItem: UseSimulationWiringReturn['handleUseItem'];
  handleDropItem: (inventoryIndex: number) => void;
  handleTakeGroundItem: (groundItemId: string) => void;
  instantInventoryResetToken: number;
  inputPresentation: UseSimulationWiringReturn['inputPresentation'];
  inventoryTagState: InventoryTagState;
  loaders: CacheBootstrapLoaders;
  mapLocs: LocWithType[] | null;
  npcHighlightState: NpcHighlightState;
  removeMarker: (x: number, y: number) => void;
  replay: UseSimulationWiringReturn['replay'];
  onReplayViewportStateGetterChange?: GridProps['onReplayViewportStateGetterChange'];
  onIntroTimingGetterChange?: GridProps['onIntroTimingGetterChange'];
  replayPlayerConfig: PlayerConfig;
  sceneLoadId: number;
  prayerPresentation: UseSimulationWiringReturn['prayerPresentation'];
  quickPrayerSetupOpen: boolean;
  quickPrayerSetupRequest: number;
  quickPrayersActive: boolean;
  showLabels: boolean;
  showMarkers: boolean;
  targetTile: GridProps['targetTile'];
  tileIndicatorState: TileIndicatorState;
  tileMarkerLastColor: string;
  tileMarkerLastOpacity: number;
  tileMarkers: TileMarker[];
  tileMarkerWidth: number;
  lineMarkers: LineMarker[];
  showLineMarkers: boolean;
  showLineMarkerLabels: boolean;
  lineMarkerWidth: number;
  addLineEdge: (ref: TileEdgeRef) => void;
  removeLineEdge: (ref: TileEdgeRef) => void;
  updateEdgeColor: (ref: TileEdgeRef, color: string, opacity: number) => void;
  updateEdgeLabel: (ref: TileEdgeRef, label: string | undefined) => void;
  updateMarkerColor: (x: number, y: number, color: string, opacity: number, fillOpacity: number) => void;
  updateMarkerLabel: (x: number, y: number, label: string | undefined) => void;
}

interface GridProvidersSettingsProps {
  activeRenderScale: number;
  antialias: boolean;
  fpsCap: number;
  areaVolume: number;
  brightness: number;
  contrast: number;
  gamePanelPosition: UIPosition;
  masterVolume: number;
  muteWhenUnfocused: boolean;
  onMuteWhenUnfocusedChange: (value: boolean) => void;
  minimapPosition: UIPosition;
  compactOrbsPosition: UIPosition;
  infoboxPosition: UIPosition | null;
  infoboxPinTarget: InfoboxPinTarget;
  onGamePanelPositionChange: (pos: UIPosition) => void;
  onMinimapPositionChange: (pos: UIPosition) => void;
  onCompactOrbsPositionChange: (pos: UIPosition) => void;
  onInfoboxPositionChange: (pos: UIPosition | null) => void;
  onUiScaleChange: (scale: number) => void;
  onVolumeChange: (key: 'masterVolume' | 'sfxVolume' | 'areaVolume', value: number) => void;
  rendererType: NonNullable<GridProps['rendererType']>;
  saturation: number;
  sfxVolume: number;
  showCoordinates: boolean;
  tileGrid: TileGridStyle | null;
  showTickCounter: boolean;
  showTickCounterInfobox: boolean;
  showTickCounterOverhead: boolean;
  tickCounterAbovePrayerIcon: boolean;
  tickCounterColors: TickColorOverrides;
  tickCounterOffsetX: number;
  tickCounterOffsetY: number;
  smoothTerrain: boolean;
  speedMultiplier: number;
  tickCounterFontSize: number;
  tickCounterMax: number;
  uiInsets: NonNullable<GridProps['uiInsets']>;
  viewportInsets: NonNullable<GridProps['viewportInsets']>;
  uiScale: number;
  viewportOffsetX: number;
}

interface GridProvidersProps {
  children: ReactNode;
  demoDisplayEvents?: GameEvent[] | null;
  demoDisplayState?: SimulationState | null;
  settings: GridProvidersSettingsProps;
  simulation: GridProvidersSimulationProps;
}

interface GridInputPresentation {
  armedSpell: string | null;
  inputPresentation: UseSimulationWiringReturn['inputPresentation'] | undefined;
  prayerPresentation: UseSimulationWiringReturn['prayerPresentation'] | undefined;
  quickPrayersActive: boolean;
  targetTile: GridProps['targetTile'];
}

export function resolveInputPresentationForDisplay(
  historicalDisplay: boolean,
  recordedQuickPrayersActive: boolean,
  live: GridInputPresentation,
): GridInputPresentation {
  if (!historicalDisplay) return live;
  return {
    armedSpell: null,
    inputPresentation: undefined,
    prayerPresentation: undefined,
    quickPrayersActive: recordedQuickPrayersActive,
    targetTile: null,
  };
}

/** The countdown belongs to the live engine, not to a replay or demo frame shown in its place. */
export function resolveFightStartCountdownForDisplay(
  historicalDisplay: boolean,
  live: FightStartCountdownPhase | null,
): FightStartCountdownPhase | undefined {
  return historicalDisplay ? undefined : (live ?? undefined);
}

export function GridProviders({
  children,
  demoDisplayEvents,
  demoDisplayState,
  settings,
  simulation,
}: GridProvidersProps) {
  const {
    activeEncounterKind,
    activeMechanicsConfig,
    gamePanelTabStore,
    addMarker,
    antiDragState,
    cacheManager,
    encounterDebugActions,
    encounterDebugFlags,
    encounterDescriptor,
    encounterMechanicsToggles,
    engine,
    eventAudioPlayer,
    frameSoundTracker,
    fightStartCountdownPhase,
    focusPaused,
    handleActiveGamePanelTabChange,
    armedSpell,
    setArmedSpell,
    handleAttackStyleChange,
    handleSelectedSpellChange,
    handleEquipFromInventory,
    handleEquipmentSlotClick,
    handleIntroComplete,
    handleMarkOfDarknessCast,
    handleDeathChargeCast,
    handleMechanicsConfigChange,
    setupContext,
    handleQuickPrayerToggle,
    handleBoostPrayerChange,
    handleIndependentPrayerChange,
    handlePrayerChange,
    onCloseQuickPrayerSetup,
    onQuickPrayerSelectionsReady,
    onQuickPrayerSetup,
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
    inventoryTagState,
    loaders,
    mapLocs,
    npcHighlightState,
    removeMarker,
    tileMarkerWidth,
    lineMarkers,
    showLineMarkers,
    showLineMarkerLabels,
    lineMarkerWidth,
    addLineEdge,
    removeLineEdge,
    updateEdgeColor,
    updateEdgeLabel,
    replay,
    onReplayViewportStateGetterChange,
    onIntroTimingGetterChange,
    replayPlayerConfig,
    sceneLoadId,
    prayerPresentation,
    quickPrayerSetupOpen,
    quickPrayerSetupRequest,
    quickPrayersActive,
    showLabels,
    showMarkers,
    targetTile,
    tileIndicatorState,
    tileMarkerLastColor,
    tileMarkerLastOpacity,
    tileMarkers,
    updateMarkerColor,
    updateMarkerLabel,
  } = simulation;
  const {
    activeRenderScale,
    antialias,
    fpsCap,
    areaVolume,
    brightness,
    contrast,
    gamePanelPosition,
    masterVolume,
    muteWhenUnfocused,
    onMuteWhenUnfocusedChange,
    minimapPosition,
    compactOrbsPosition,
    infoboxPosition,
    infoboxPinTarget,
    onGamePanelPositionChange,
    onMinimapPositionChange,
    onCompactOrbsPositionChange,
    onInfoboxPositionChange,
    onUiScaleChange,
    onVolumeChange,
    rendererType,
    saturation,
    sfxVolume,
    showCoordinates,
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
    viewportInsets,
    uiScale,
    viewportOffsetX,
  } = settings;

  const {
    animationSystem,
    enumTypeLoader,
    locModelLoader,
    mapLoader,
    minimapNpcDotUrl,
    npcModelLoader,
    npcTypeLoader,
    objTypeLoader,
    overlayLoader,
    playerModelLoader,
    spotAnimModelLoader,
    structTypeLoader,
    textureLoader,
    underlayLoader,
  } = loaders;
  const { ctrlToDrag, dragDelay, enabled: antiDragEnabled } = antiDragState;
  const { lastColor: inventoryTagLastColor, removeTag, setTag, showTags, tags: inventoryTags } = inventoryTagState;
  const {
    highlights: npcHighlights,
    removeHighlight,
    setHighlightColor,
    showHighlights,
    seedBossDefault,
    toggleHighlight,
  } = npcHighlightState;
  const { config: tileIndicatorConfig } = tileIndicatorState;
  const {
    controlProps,
    cursorTrack,
    displayEvents,
    displayHistory,
    displayState,
    displayUiState,
    replayMode,
    replayFrameStore,
  } = replay;
  const effectiveDisplayEvents = demoDisplayEvents ?? displayEvents;
  const effectiveDisplayState = demoDisplayState ?? displayState;

  // Seed the default boss true-tile highlight through the NPC Highlights plugin
  // so bosses are pre-tagged (shift+right-click shows "Untag True Tile"). Runs
  // for encounters only; the lobby is excluded inside the hook.
  useSeedBossHighlights({
    encounterKind: activeEncounterKind,
    npcs: effectiveDisplayState.npcs,
    npcTypeLoader: npcTypeLoader ?? undefined,
    seedBossDefault,
  });
  const encounterRenderConfig = useMemo(() => getEncounterRenderConfig(activeEncounterKind), [activeEncounterKind]);
  // The recorded LAYOUT owns the tab, not the per-tick UI state: a tab switch
  // changes what is under the cursor immediately, while the per-tick snapshot can
  // be up to a tick behind the cursor samples that followed it.
  const replayPresentation = useReplayPresentation();
  // Replay-only override. Live play leaves this `undefined` so the tab reaches
  // GamePanel through GamePanelTabStore instead, keeping a tab switch out of
  // this provider (and everything above it).
  const effectiveGamePanelTab = replayMode
    ? (replayPresentation?.variants.activeGamePanelTab ?? displayUiState.activeGamePanelTab)
    : undefined;

  // Monotonic engine identity: bump whenever the engine instance is swapped
  // (takeover) so the timeline key changes even when sceneLoadId/replayMode do
  // not. Idempotent per render (safe ref mutation, no re-render).
  const engineIdRef = useRef(0);
  const previousEngineRef = useRef<SimulationEngine | null>(null);
  if (previousEngineRef.current !== engine) {
    previousEngineRef.current = engine;
    engineIdRef.current += 1;
  }
  // Encounter-agnostic replay-timeline identity: changes on scene load, engine
  // takeover/swap, and live↔replay. The base SceneCompositor uses it to detect
  // timeline-change discontinuities and reset transient render/audio state.
  const replayTimelineKey = `${activeEncounterKind}:${sceneLoadId}:${replayMode ? 'R' : 'L'}:${engineIdRef.current}`;
  const restoredPresentation =
    !replayMode && demoDisplayState === null && replay.restoredPresentation?.engine === engine
      ? replay.restoredPresentation
      : undefined;
  const fightStartCountdown = resolveFightStartCountdownForDisplay(
    replayMode || demoDisplayState !== null,
    fightStartCountdownPhase,
  );
  const displayInputPresentation = resolveInputPresentationForDisplay(
    replayMode || demoDisplayState !== null,
    effectiveDisplayState.quickPrayersActive,
    {
      armedSpell,
      inputPresentation,
      prayerPresentation,
      quickPrayersActive,
      targetTile,
    },
  );

  const simulationContextValue = useMemo<SimulationGridContextValue>(
    () => ({
      animationSystem: animationSystem ?? undefined,
      activeGamePanelTab: effectiveGamePanelTab,
      antiDragCtrlToDrag: ctrlToDrag,
      antiDragDelay: dragDelay,
      antiDragEnabled,
      cacheManager,
      debugActions: encounterDebugActions,
      encounterDebugFlags,
      encounterKind: activeEncounterKind,
      encounterRequiresLocs: !!encounterDescriptor?.loadsMapLocs,
      encounterIsBeta: !!encounterDescriptor?.isWorkInProgress,
      encounterRenderConfig,
      engine,
      dpsProjection: replay.displayDpsProjection,
      enumTypeLoader: enumTypeLoader ?? undefined,
      equipmentStats: effectiveDisplayState.equipmentStats,
      eventAudioPlayer,
      eventOverrides: effectiveDisplayEvents,
      fightStartCountdown,
      frameSoundTracker,
      inventory: effectiveDisplayState.inventory,
      inventoryPreviewResetToken: instantInventoryResetToken,
      inputPresentation: displayInputPresentation.inputPresentation,
      inventoryTagLastColor,
      inventoryTags,
      locModelLoader: locModelLoader ?? undefined,
      mapLoader: mapLoader ?? undefined,
      mapLocs: mapLocs ?? undefined,
      mechanicsConfig: activeMechanicsConfig,
      setupContext,
      mechanicsToggles: encounterMechanicsToggles,
      minimapNpcDotUrl: minimapNpcDotUrl ?? undefined,
      npcHighlights,
      npcModelLoader: npcModelLoader ?? undefined,
      npcTypeLoader: npcTypeLoader ?? undefined,
      objTypeLoader: objTypeLoader ?? undefined,
      onActiveGamePanelTabChange: handleActiveGamePanelTabChange,
      onAttackStyleChange: handleAttackStyleChange,
      onSelectedSpellChange: handleSelectedSpellChange,
      armedSpell: displayInputPresentation.armedSpell,
      onArmSpell: setArmedSpell,
      onEquipFromInventory: handleEquipFromInventory,
      onEquipmentSlotClick: handleEquipmentSlotClick,
      onIntroComplete: handleIntroComplete,
      onIntroTimingGetterChange,
      onMarkOfDarknessCast: handleMarkOfDarknessCast,
      onDeathChargeCast: handleDeathChargeCast,
      onMechanicsConfigChange: handleMechanicsConfigChange,
      onBoostPrayerChange: handleBoostPrayerChange,
      onIndependentPrayerChange: handleIndependentPrayerChange,
      onReplayCursorClick: replay.recordCursorClick,
      onPrayerChange: handlePrayerChange,
      onQuickPrayerSelectionsReady,
      onQuickPrayerToggle: handleQuickPrayerToggle,
      onQuickPrayerSetup,
      onCloseQuickPrayerSetup,
      onRemoveNpcHighlight: removeHighlight,
      onReturnToLobby: handleReturnToLobby,
      onRunToggle: handleRunToggle,
      onSceneReady: handleSceneReady,
      onSetNpcHighlightColor: setHighlightColor,
      onSpecialAttackToggle: handleSpecialAttackToggle,
      onSwapInventorySlots: handleSwapInventorySlots,
      onTagItem: setTag,
      onTileClick: handleTileClick,
      onToggleNpcHighlight: toggleHighlight,
      onExecuteEncounterCommand: handleExecuteEncounterCommand,
      onSetBossHp: handleSetBossHp,
      onApplyBossHpPreset: handleApplyBossHpPreset,
      onUnequipSlot: handleUnequipSlot,
      onUnequipAmmo: handleUnequipAmmo,
      onUnmarkTile: (tile) => removeMarker(tile[0], tile[1]),
      onUpdateMarkerLabel: (tile, label) => updateMarkerLabel(tile[0], tile[1], label),
      onUpdateTileColor: (tile, color, opacity, fillOpacity) =>
        updateMarkerColor(tile[0], tile[1], color, opacity, fillOpacity),
      onUseItem: handleUseItem,
      onDropItem: handleDropItem,
      onTakeGroundItem: handleTakeGroundItem,
      onMarkTile: (tile) => addMarker(tile[0], tile[1]),
      onMarkLine: (ref) => addLineEdge(ref),
      onUnmarkLine: (ref) => removeLineEdge(ref),
      onUpdateLineColor: (ref, color, opacity) => updateEdgeColor(ref, color, opacity),
      onUpdateLineLabel: (ref, label) => updateEdgeLabel(ref, label),
      tileMarkerWidth,
      lineMarkers,
      showLineMarkers,
      showLineMarkerLabels,
      lineMarkerWidth,
      onUntagItem: removeTag,
      overlayLoader: overlayLoader ?? undefined,
      playerConfig: replayPlayerConfig,
      playerEquipment: effectiveDisplayState.playerEquipment,
      equippedAmmo: effectiveDisplayState.playerCombatSupplies.equippedAmmo,
      quiverAmmo: effectiveDisplayState.playerCombatSupplies.quiverAmmo,
      playerModelLoader: playerModelLoader ?? undefined,
      replayControls: controlProps,
      replayCursorTrack: cursorTrack,
      replayPaused: focusPaused || (replayMode && !controlProps.isPlaying),
      onReplayViewportStateGetterChange,
      onReplayViewportSample: replay.recordViewportSample,
      replayTimelineKey,
      restoredPresentation,
      sceneLoadId,
      showInventoryTags: showTags,
      showNpcHighlights: showHighlights,
      showTileMarkerLabels: showLabels,
      showTileMarkers: showMarkers,
      simulationState: effectiveDisplayState,
      prayerPresentation: displayInputPresentation.prayerPresentation,
      quickPrayerSetupOpen,
      quickPrayerSetupRequest,
      quickPrayersActive: displayInputPresentation.quickPrayersActive,
      spotAnimModelLoader: spotAnimModelLoader ?? undefined,
      structTypeLoader: structTypeLoader ?? undefined,
      targetTile: displayInputPresentation.targetTile,
      textureLoader: textureLoader ?? undefined,
      tileIndicatorConfig,
      tileMarkerLastColor,
      tileMarkerLastOpacity,
      tileMarkers,
      underlayLoader: underlayLoader ?? undefined,
      voidFlareNpcTypeId: encounterRenderConfig?.preloadNpcTypes?.[0]?.npcTypeId,
    }),
    [
      activeEncounterKind,
      activeMechanicsConfig,
      effectiveGamePanelTab,
      addMarker,
      animationSystem,
      antiDragEnabled,
      cacheManager,
      controlProps,
      ctrlToDrag,
      displayInputPresentation,
      effectiveDisplayEvents,
      effectiveDisplayState,
      dragDelay,
      encounterDebugActions,
      encounterDebugFlags,
      encounterDescriptor,
      encounterRenderConfig,
      encounterMechanicsToggles,
      engine,
      enumTypeLoader,
      eventAudioPlayer,
      fightStartCountdown,
      frameSoundTracker,
      focusPaused,
      handleAttackStyleChange,
      handleSelectedSpellChange,
      setArmedSpell,
      handleActiveGamePanelTabChange,
      handleEquipFromInventory,
      handleEquipmentSlotClick,
      handleIntroComplete,
      handleMarkOfDarknessCast,
      handleDeathChargeCast,
      handleMechanicsConfigChange,
      setupContext,
      handleQuickPrayerToggle,
      handleBoostPrayerChange,
      handleIndependentPrayerChange,
      handlePrayerChange,
      replay.recordCursorClick,
      replay.displayDpsProjection,
      replay.recordViewportSample,
      onReplayViewportStateGetterChange,
      onIntroTimingGetterChange,
      onCloseQuickPrayerSetup,
      onQuickPrayerSelectionsReady,
      onQuickPrayerSetup,
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
      inventoryTagLastColor,
      inventoryTags,
      locModelLoader,
      mapLoader,
      mapLocs,
      minimapNpcDotUrl,
      npcHighlights,
      npcModelLoader,
      npcTypeLoader,
      objTypeLoader,
      overlayLoader,
      playerModelLoader,
      removeHighlight,
      removeMarker,
      removeTag,
      cursorTrack,
      replayMode,
      replayTimelineKey,
      restoredPresentation,
      replayPlayerConfig,
      sceneLoadId,
      quickPrayerSetupOpen,
      quickPrayerSetupRequest,
      setHighlightColor,
      setTag,
      showHighlights,
      showLabels,
      showMarkers,
      showTags,
      spotAnimModelLoader,
      structTypeLoader,
      textureLoader,
      tileIndicatorConfig,
      tileMarkerLastColor,
      tileMarkerLastOpacity,
      tileMarkers,
      tileMarkerWidth,
      lineMarkers,
      showLineMarkers,
      showLineMarkerLabels,
      lineMarkerWidth,
      addLineEdge,
      removeLineEdge,
      updateEdgeColor,
      updateEdgeLabel,
      toggleHighlight,
      underlayLoader,
      updateMarkerColor,
      updateMarkerLabel,
    ],
  );

  const settingsContextValue = useMemo<SettingsGridContextValue>(
    () => ({
      areaVolume,
      brightness,
      contrast,
      gamePanelPosition,
      masterVolume,
      muteWhenUnfocused,
      onMuteWhenUnfocusedChange,
      minimapPosition,
      compactOrbsPosition,
      infoboxPosition,
      infoboxPinTarget,
      onGamePanelPositionChange,
      onMinimapPositionChange,
      onCompactOrbsPositionChange,
      onInfoboxPositionChange,
      onUiScaleChange,
      onVolumeChange,
      renderScale: activeRenderScale,
      antialias,
      fpsCap,
      rendererType,
      saturation,
      sfxVolume,
      showCoordinates,
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
      viewportInsets,
      uiScale,
      viewportOffsetX,
    }),
    [
      activeRenderScale,
      antialias,
      fpsCap,
      areaVolume,
      brightness,
      contrast,
      gamePanelPosition,
      masterVolume,
      muteWhenUnfocused,
      onMuteWhenUnfocusedChange,
      minimapPosition,
      compactOrbsPosition,
      infoboxPosition,
      infoboxPinTarget,
      onGamePanelPositionChange,
      onMinimapPositionChange,
      onCompactOrbsPositionChange,
      onInfoboxPositionChange,
      onUiScaleChange,
      onVolumeChange,
      rendererType,
      saturation,
      sfxVolume,
      showCoordinates,
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
      viewportInsets,
      uiScale,
      viewportOffsetX,
    ],
  );

  // High-frequency replay values (playhead + camera) flow through replayFrameStore
  // via useSyncExternalStore, so a per-frame update only re-renders the 3D viewport
  // + replay cursor — never this provider or the broad Grid/chrome tree above them.
  //
  // tickProgressStore carries the same-shaped per-frame value for infobox timers:
  // the render loop writes how far the current tick has advanced, and only the
  // timer text subscribes.
  const tickProgressStore = useRef(new TickProgressStore()).current;

  return (
    <SimulationProvider value={simulationContextValue}>
      <SettingsProvider value={settingsContextValue}>
        <ReplayFrameProvider store={replayFrameStore}>
          <TickProgressProvider store={tickProgressStore}>
            <DisplayTimelineProvider history={displayHistory} state={effectiveDisplayState} replaying={replayMode}>
              <GamePanelTabProvider store={gamePanelTabStore}>{children}</GamePanelTabProvider>
            </DisplayTimelineProvider>
          </TickProgressProvider>
        </ReplayFrameProvider>
      </SettingsProvider>
    </SimulationProvider>
  );
}
