import type React from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { EventAudioPlayer, FrameSoundTracker } from '../audio';
import type { CacheManager, LocWithType } from '../cache/CacheManager';
import { useGamePanelTab } from '../contexts/GamePanelTabContext';
import { useMobilePanelModes, useReplayPresentation } from '../contexts/ReplayPresentationContext';
import { useSettingsContext } from '../contexts/SettingsContext';
import { useSimulationContext } from '../contexts/SimulationContext';
import { WorkspacePortal } from '../contexts/WorkspaceDockContext';
import { isNpcTargetable } from '../core/actors/NpcActor';
import { soulreaperDisplayedStacks } from '../core/combat/player/soulreaper';
import { getArenaBounds, SIMULATION_START_TICK } from '../core/constants';
import type { EncounterCommand } from '../core/encounters/commands';
import type { DebugActionInfo, MechanicsToggleInfo } from '../core/encounters/types';
import type { GameEvent } from '../core/events/types';
import type { ReplayClickType, ReplayCursorTrack, ReplayViewportState } from '../core/ReplayRecorder';
import { resolveReplayMobileChromeScale, resolveReplaySafeAreaInsets } from '../core/replayPresentation';
import type { SimulationEngine } from '../core/SimulationEngine';
import type { ItemActionOption } from '../data/itemEffects';
import { weaponHasSpecialAttack } from '../data/specialAttacks';
import { withProfile } from '../debug/renderProfiler';
import { LOBBY_BOSS_NPCS } from '../encounters/lobby/metadata';
import { type EncounterCameraConfig, encounterDefaultCamera } from '../encounters/presentationModules';
import { type CameraKeybindMap, DEFAULT_CAMERA_KEYBINDS } from '../hooks/useCameraKeybinds';
import type { GamePanelTab } from '../hooks/useGamePanelShortcuts';
import {
  type InfoboxPinTarget,
  PERSISTED_SETTINGS_DEFAULTS,
  resolveInfoboxPinTarget,
  type UIPosition,
} from '../hooks/usePersistedSettings';
import { type SafeAreaInsets, useSafeAreaInsets } from '../hooks/useSafeAreaInsets';
import {
  committedPrayerPresentation,
  type InputPresentation,
  type PrayerPresentation,
} from '../hooks/useSimulationWiring';
import type { ZukSetTimerControls } from '../hooks/useZukSetTimer';
import { getModifiers, subscribeModifiers } from '../input/keyState';
import { chatboxClearance, chatboxPlacement } from '../layout/chatboxLayout';
import { isNarrowWindow } from '../layout/chromeBreakpoints';
import { setMobileLayoutEditing, useMobileLayoutEditing } from '../layout/mobileLayoutEdit';
import {
  OSM_INTERFACE_SCALING_DEFAULT,
  osmChromeLayout,
  osmChromeScale,
  osmSidePanelOnLeft,
} from '../layout/osmClientLayout';
import { type OsmFrame, osmCssRect, osmFrame, osmLeftColumnRight } from '../layout/osmFrame';
import type { OsmHotkeySlot } from '../layout/osmHotkeys';
import { OSM_HPBAR_HEIGHT, OSM_HPBAR_WIDTH, type OsmHudAid, placeOsmHud } from '../layout/osmHud';
import { DEFAULT_MOBILE_TOOL_WINDOW, type MobileToolWindowState } from '../layout/osmToolWindowState';
import {
  type ClientLayoutMode,
  FIXED_FRAME,
  FIXED_FRAME_EDGE_LEFT,
  FIXED_FRAME_EDGE_TOP,
  FIXED_SCENE,
  FIXED_TOP_RIGHT_CORNER,
  FIXED_VIEWPORT,
  type Rect,
  type Size,
  scaleRect,
} from '../layout/osrsClientLayout';
import { chatboxInfoboxAnchor } from '../layout/topChromeLayout';
import {
  createCanvas2DRenderer,
  createPicoGLRenderer,
  RenderViewport,
  RenderViewport3D as RenderViewport3DBase,
  type ViewportInputOwnership,
} from '../render';
import type { AnimationSystem } from '../render/core/animation';
import type { RenderStatus } from '../render/core/renderer';
import { resolveEffectiveLocs } from '../render/environment/locRenderFilter';
import type { OverheadNumberPlacement, PlayerOverheadNumbers } from '../render/overlay/UIOverlayRenderer';
import {
  createProjection3D,
  INNER_ZOOM_LEVEL_MIN,
  innerZoomLimitForLevel,
  type OrbitCameraState,
  OSRS_DEFAULT_FOV_SCALE,
  type Projection3D,
} from '../render/projections/Projection3D';
import { replayViewportStateOf } from '../render/projections/replayViewportMapper';
import { resolveEncounterLocRenderOptions } from '../render/scene/encounterLocRenderOptions';
import type { EncounterRenderConfig } from '../render/scene/encounterRenderConfig';
import { pickGroundItemsAtScreen } from '../render/scene/groundItemPick';
import { type PickedNpc, pickNpcsAtScreen } from '../render/scene/npcPick';
import { isNpcModelHidden } from '../render/scene/npcPluginVisibility';
import { PLAYER_ACTOR_ID } from '../render/scene/SceneCompositor';
import { createSceneBuilderForKind } from '../render/scene/sceneBuilderFactory';
import { getTerrainHeightInterpolated } from '../render/shared/renderUtils';
import { replayCaptureNotice } from '../replay/capturePresentation';
import { PANEL } from '../resourcePack';
import type { EnumTypeLoader } from '../rs/config/enumtype/EnumTypeLoader';
import type { OverlayTypeLoader, UnderlayTypeLoader } from '../rs/config/flotype/FloTypeLoader';
import type { LocModelLoader } from '../rs/config/loctype/LocModelLoader';
import type { NpcTypeLoader } from '../rs/config/npctype/NpcTypeLoader';
import type { ObjTypeLoader } from '../rs/config/objtype/ObjTypeLoader';
import type { StructTypeLoader } from '../rs/config/structtype/StructTypeLoader';
import type { MapLoader } from '../rs/map/MapLoader';
import type { NpcModelLoader } from '../rs/model/NpcModelLoader';
import type { PlayerModelLoader } from '../rs/model/PlayerModelLoader';
import type { SpotAnimModelLoader } from '../rs/model/SpotAnimModelLoader';
import type { TextureLoader } from '../rs/texture/TextureLoader';
import { TUTORIAL_REPLAY_ENTERED_EVENT } from '../tutorial/events';
import type { CompactOrbId, CompactOrbsLayout } from '../types/compactOrbs';
import { type CustomMenuSwap, parseCustomMenuSwaps } from '../types/customMenuSwaps';
import type { EntityHiderOptions } from '../types/entityHider';
import { type GroundItem, groundItemsAtTile } from '../types/groundItems';
import type { Inventory } from '../types/inventory';
import type { LineMarker, TileEdgeRef } from '../types/lineMarkers';
import { DEFAULT_LINE_MARKER_WIDTH } from '../types/lineMarkers';
import { getNpcHighlightMenuColor, type NpcHighlightEntry, type NpcHighlightMode } from '../types/npcHighlight';
import { hiddenPillarLocIds, type PillarAdditionsPlugins } from '../types/pillarAdditions';
import type { PlayerConfig } from '../types/player';
import type { PracticeSessionState } from '../types/practiceSession';
import type { ReplayPracticeControls } from '../types/replayPractice';
import type { SetupContextControls } from '../types/setupContext';
import type { Coordinate, MechanicsConfig, PrayerType, SimulationState } from '../types/simulation';
import type { TileGridStyle } from '../types/tileGrid';
import type { TileIndicatorConfig } from '../types/tileIndicators';
import {
  DEFAULT_MARKER_COLOR,
  DEFAULT_MARKER_OPACITY,
  DEFAULT_TILE_MARKER_WIDTH,
  type TileMarker,
} from '../types/tileMarkers';
import { type TzhaarHpTrackerOptions, tzhaarMenuColor } from '../types/tzhaarHpTracker';
import { readActualZukSetCountdown } from '../types/zukSetTimer';
import type { TickColorOverrides } from '../util/tickColor';
import { HUD_TOOL_GAP, uncoveredCentreX } from '../util/viewportLayout';
import { BOSS_HEALTH_BAR_WIDTH, BossHealthBarOverlay } from './BossHealthBarOverlay';
import { CameraDebugReadout } from './CameraDebugReadout';
import { Chatbox } from './Chatbox';
import {
  ContextMenuOverlay,
  ContextMenuProvider,
  type Ray3D,
  rayFindInteractiveLoc,
  rayFindInteractiveLocWithCoord,
  rayHitsNpc,
  useContextMenu,
  type ViewportEntityContext,
} from './ContextMenu';
import {
  type GroundItemMenuContext,
  type GroundItemMenuItem,
  type NpcHighlightMenuContext,
  resolveViewportLeftClickSwap,
  resolveViewportRightClick,
} from './ContextMenu/contextMenuBuilders';
import { useChatLog } from './chatLog';
import { chromeZoomStyle, useZoomTransition } from './chromeZoom';
import { DETAILED_DPS_SEED_HEIGHT, DetailedDpsOverlay } from './DetailedDpsOverlay';
import { GamePanel as GamePanelBase } from './GamePanel';
import { getEncounterMapFootprint } from './gridEncounterMapSquare';
import { HintBar } from './HintBar';
import { InfoBoxOverlay, InfoBoxPanel } from './InfoBox';
import { selectInfoboxes } from './InfoBox/selectInfoboxes';
import { TopChrome, type TopChromeProps } from './launcher/TopChrome';
import { Minimap, type MinimapHandle } from './Minimap';
import { MobileLayoutEditBar } from './MobileLayoutEditBar';
import { MobileToolWindow } from './MobileToolWindow';
import { isNpcAttackable, resolveInteractiveNpcPick } from './npcInteraction';
import { PixelComposedLayer, tileFill } from './PixelComposedLayer';
import { PRAYER_FLICK_PANEL_HEIGHT, PrayerFlickOverlay } from './PrayerFlickOverlay';
import { ReplayControls, type ReplayControlsProps } from './ReplayControls';
import { ReplayCursorLayer } from './ReplayCursorLayer';
import { OverlapGuideOverlay, SnapGuideOverlay, usePanelSnapRegistry } from './snap';
import { TileMarkerColorPicker } from './TileMarkerColorPicker';
import { TileMarkerLabelEditor } from './TileMarkerLabelEditor';
import {
  buildGroundItemTooltip,
  buildLocTooltip,
  buildMenuEntryTooltip,
  buildNpcTooltip,
  TooltipOverlay,
  TooltipProvider,
  useTooltip,
} from './Tooltip';
import { useLayoutMeasure } from './useLayoutMeasure';
import { ViewportStatusOverlay } from './ViewportStatusOverlay';
import { XP_DROP_PANEL, XpDropOverlay } from './XpDropOverlay';
import type { HintToastAnchor } from './ZoomHintToast';
import { ZUK_SET_TIMER_PANEL_HEIGHT, ZukSetTimerOverlay } from './ZukSetTimerOverlay';

// Render-cost attribution. These are the components that re-render when the
// displayed tick changes; withProfile is a no-op unless
// localStorage.renderProfile === '1'.
const RenderViewport3D = withProfile('viewport-3d', RenderViewport3DBase);
const GamePanelProfiled = withProfile('game-panel', GamePanelBase);
/**
 * Subscribes to the live tab HERE rather than in Grid, so a tab switch commits
 * only this subtree. `activeTab` from context is the replay-only override and
 * wins when present; outside a provider both are undefined and GamePanel falls
 * back to its own uncontrolled state (isolated tests).
 */
const GamePanel: typeof GamePanelBase = (props) => {
  const liveTab = useGamePanelTab();
  return <GamePanelProfiled {...props} activeTab={props.activeTab ?? liveTab} />;
};

/** Subscribes to the chat log HERE rather than in Grid, so a new line commits only the chat box. */
const GridChatbox = memo(function GridChatbox(props: Omit<React.ComponentProps<typeof Chatbox>, 'messages'>) {
  const messages = useChatLog();
  return <Chatbox {...props} messages={messages} />;
});

/**
 * The frame's layer scale, in the order things must cover each other. Everything between the
 * chrome and the tools is DraggablePanel's default 10 — infoboxes, minimap, side panel — which
 * are readouts.
 *
 * The Mobile tool window and the bottom-left readouts outrank those readouts because they are
 * chrome the user drives. The transport outranks even that: while replaying it is the control in
 * use.
 *
 * Fixed's frame bezels go UNDER all of them, clearing only the scene and the chatbox at 0.
 * They are 4 logical px that scale with the frame — 24px at the 6x ceiling — while an
 * overlay's anchor offset stays in unscaled screen pixels and DraggablePanel clamps to the
 * frame's OUTER box, so anything at the top or left edge lands inside that band; above the
 * readouts the bezel sliced their tops off. Going under costs nothing where the bezels meet
 * the pinned minimap block: it paints its own stone across those rows, measured
 * byte-identical either way.
 */
const CHROME_LAYER_Z = 5;
const HUD_LAYER_Z = 20;
/**
 * The Mobile tool window while replaying. Strictly BETWEEN its resting layer and the transport's:
 * the compact transport rides inside the window and needs it above the readouts and the cursor
 * overlay, but it must stay below the layer the centered transport claims.
 */
const REPLAY_STACK_Z = 30;
/** The Alt overlap guide: over every panel and the tool window, under the replay stack it never shows with. */
const OVERLAP_GUIDE_Z = 25;
/**
 * The 3D view's status notice is the one layer above the HUD, at 24 in ViewportStatusOverlay.css.
 * It has to be: the Mobile layouts put the side panel over the middle of the scene, so a notice
 * inside the HUD container was invisible on iPad and iPhone portrait. It passes every press
 * through except its own action, so nothing under it stops working.
 */
const RENDER_STATUS_OK: RenderStatus = { kind: 'ok' };

/** The side panel the Mobile tool window keeps clear of during playback: open, on the right. */

const LOBBY_BOSS_BY_ACTOR_ID: Record<string, (typeof LOBBY_BOSS_NPCS)[number]> = Object.fromEntries(
  LOBBY_BOSS_NPCS.map((boss) => [boss.actorId, boss]),
);

const SCENE_BUILDER_LIFECYCLE_DELIMITER = '@';

function sameCameraConfig(a: EncounterCameraConfig, b: EncounterCameraConfig): boolean {
  return a.yaw === b.yaw && a.pitch === b.pitch && a.zoom === b.zoom;
}

export function getSceneBuilderLifecycleKey(encounterKind: string, sceneLoadId = 0): string {
  return `${encounterKind}${SCENE_BUILDER_LIFECYCLE_DELIMITER}${sceneLoadId}`;
}

/** The painted sizes of the Mobile layout's native XP drops and boss bar, at the chrome's scale. */
function mobileNativeSizes(frame: { readonly scale: number }) {
  return {
    xpDrops: { width: XP_DROP_PANEL.width * frame.scale, height: XP_DROP_PANEL.height * frame.scale },
    bossBar: { width: OSM_HPBAR_WIDTH * frame.scale, height: OSM_HPBAR_HEIGHT * frame.scale },
  };
}

/**
 * Where Grid's frame is drawn in the window: its top-left corner and how much larger than laid out
 * it is drawn on each axis (a fitted replay's uniform downscale, or Fixed's Stretch to Window).
 */
interface FramePlacement {
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

const IDENTITY_FRAME_PLACEMENT: FramePlacement = { x: 0, y: 0, scaleX: 1, scaleY: 1 };

/**
 * Where `frame` is drawn in the window, from its box against its layout size: a transform on the
 * frame shows in the one and not the other.
 */
function measureFramePlacement(frame: HTMLElement, layoutWidth: number, layoutHeight: number): FramePlacement {
  const box = frame.getBoundingClientRect();
  return {
    x: box.left,
    y: box.top,
    scaleX: layoutWidth > 0 && box.width > 0 ? box.width / layoutWidth : 1,
    scaleY: layoutHeight > 0 && box.height > 0 ? box.height / layoutHeight : 1,
  };
}

function windowToFrame(rect: Rect, placement: FramePlacement): Rect {
  return {
    x: (rect.x - placement.x) / placement.scaleX,
    y: (rect.y - placement.y) / placement.scaleY,
    width: rect.width / placement.scaleX,
    height: rect.height / placement.scaleY,
  };
}

/** `previous` where `next` has the same values, so a re-measured rect does not re-render. */
function sameRect(previous: Rect | null, next: Rect | null): Rect | null {
  return previous &&
    next &&
    previous.x === next.x &&
    previous.y === next.y &&
    previous.width === next.width &&
    previous.height === next.height
    ? previous
    : next;
}

export interface GridProps {
  replayPractice?: ReplayPracticeControls;
  /**
   * The encounter's own session controls (Inferno's wave restarts), built by App from the
   * published snapshot. Shown in the top chrome's session slot and as the Mobile Tools Practice
   * page's session, where replay practice is not already using them.
   */
  encounterSession?: PracticeSessionState | null;
  simulationState: SimulationState;
  /** Click-through scene presentation, sharing the viewport's layout and translation. */
  sceneOverlay?: React.ReactNode;
  /**
   * The 3D view's last reported status, held by App (which holds the fight on it) and fed back from
   * the viewport's `onRenderStatusChange`. Grid only shows it, in ViewportStatusOverlay.
   */
  renderStatus?: RenderStatus;
  onRenderStatusChange?: (status: RenderStatus) => void;
  /**
   * App's hold for a 3D view that cannot draw. The scene presentation (title card, countdown) stays
   * mounted under it, so its timers and callbacks run on, but is not shown over the status notice.
   */
  graphicsHeld?: boolean;
  /** What that hold has paused, for the status notice to name. */
  graphicsHeldActivity?: 'fight' | 'replay' | null;
  replayViewportWidth?: number;
  replayControls?: Omit<ReplayControlsProps, 'compact'> & {
    isReplaying: boolean;
    hasRecording: boolean;
    onEnterReplay: () => void;
  };
  engine?: SimulationEngine;
  dpsProjection?: ReturnType<SimulationEngine['getAdjustedTheoreticalDps']>;
  onTileClick: (coord: Coordinate, ctrlKey?: boolean, hoveredNpcActorId?: string | null) => void;
  showCoordinates: boolean;
  /** The Tile Grid plugin's style; `null` when it is off. */
  tileGrid?: TileGridStyle | null;
  encounterDebugFlags?: Record<string, boolean | number>;
  smoothTerrain?: boolean;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  renderScale?: number;
  fpsCap?: number;
  /** What the prayer book renders, composed by `useSimulationWiring`. Absent while replaying recorded state. */
  prayerPresentation?: PrayerPresentation;
  inputPresentation?: InputPresentation;
  onPrayerChange: (prayer: PrayerType | null) => void;
  onBoostPrayerChange?: (prayer: PrayerType | null) => void;
  onIndependentPrayerChange?: (prayer: PrayerType) => void;
  onQuickPrayerToggle?: () => void;
  onQuickPrayerSetup?: () => void;
  onCloseQuickPrayerSetup?: () => void;
  onQuickPrayerSelectionsReady?: (selections: string[]) => void;
  onMarkOfDarknessCast?: () => void;
  onDeathChargeCast?: () => void;
  onRunToggle: () => void;
  onSpecialAttackToggle: () => void;
  onAttackStyleChange?: (index: number) => void;
  onSelectedSpellChange?: (spellName: string) => void;
  /** Spell armed for a manual cast, awaiting a target click. */
  armedSpell?: string | null;
  onArmSpell?: (spellName: string | null) => void;
  targetTile?: Coordinate | null;
  /**
   * Which viewport backend Grid mounts. `'none'` mounts no viewport at all —
   * the UI layer (top chrome, game panel, minimap orbs, overlays) renders on its own
   * with no scene, no GL context and no render loop. It exists for the UI test
   * harness (`/ui-harness.html`); the app itself only ever passes the two real
   * renderer types.
   */
  rendererType?: 'webgl' | 'canvas2d' | 'none';
  encounterKind: string;
  /** Monotonic scene-instance token; changes even when the encounter kind is reloaded in place. */
  sceneLoadId?: number;
  onReturnToLobby?: () => void;
  cacheManager: CacheManager;
  eventAudioPlayer?: EventAudioPlayer;
  frameSoundTracker?: FrameSoundTracker;
  mapLoader?: MapLoader;
  underlayLoader?: UnderlayTypeLoader;
  overlayLoader?: OverlayTypeLoader;
  textureLoader?: TextureLoader;
  minimapNpcDotUrl?: string;
  locModelLoader?: LocModelLoader;
  npcModelLoader?: NpcModelLoader;
  playerModelLoader?: PlayerModelLoader;
  spotAnimModelLoader?: SpotAnimModelLoader;
  playerConfig?: PlayerConfig;
  animationSystem?: AnimationSystem;
  mapLocs?: LocWithType[];
  encounterRequiresLocs?: boolean;
  /** The descriptor's `isWorkInProgress`, projected for the in-fight Beta marker. */
  encounterIsBeta?: boolean;
  encounterRenderConfig?: EncounterRenderConfig;
  inventory?: Inventory;
  inventoryPreviewResetToken?: number;
  equipmentStats?: import('../types/equipmentStats').EquipmentStats;
  playerEquipment?: import('../rs/model/PlayerModelLoader').PlayerEquipment;
  onUnequipSlot?: (slot: string) => void;
  equippedAmmo?: import('../types/encounterLoadout').SupplyItem | null;
  quiverAmmo?: import('../types/encounterLoadout').SupplyItem | null;
  onUnequipAmmo?: () => void;
  onEquipmentSlotClick?: (slot: string) => boolean;
  onEquipFromInventory?: (inventoryIndex: number) => Inventory | null | undefined;
  onUseItem?: (inventoryIndex: number, option?: ItemActionOption) => void;
  onDropItem?: (inventoryIndex: number) => void;
  /** Right-click "Take" on a pile in the viewport. */
  onTakeGroundItem?: (groundItemId: string) => void;
  onSwapInventorySlots?: (fromIndex: number, toIndex: number) => void;
  inventoryTags?: Record<string, string>;
  showInventoryTags?: boolean;
  antiDragEnabled?: boolean;
  dragOnShiftOnly?: boolean;
  antiDragDelay?: number;
  antiDragCtrlToDrag?: boolean;
  onTagItem?: (itemId: number, color: string) => void;
  onUntagItem?: (itemId: number) => void;
  inventoryTagLastColor?: string;
  objTypeLoader?: ObjTypeLoader;
  npcTypeLoader?: NpcTypeLoader;
  enumTypeLoader?: EnumTypeLoader;
  structTypeLoader?: StructTypeLoader;
  speedMultiplier?: number;
  gamePanelPosition?: UIPosition;
  activeGamePanelTab?: GamePanelTab;
  onActiveGamePanelTabChange?: (tab: GamePanelTab) => void;
  minimapPosition?: UIPosition;
  compactOrbsPosition?: UIPosition;
  infoboxPosition?: UIPosition | null;
  infoboxPinTarget?: InfoboxPinTarget;
  xpDropsEnabled?: boolean;
  onXpDropsToggle?: () => void;
  xpDropsShowPredictedHit?: boolean;
  xpDropsGrouped?: boolean;
  xpDropsShowIcons?: boolean;
  xpDropsSpeed?: number;
  xpDropsPosition?: UIPosition | null;
  onXpDropsPositionChange?: (position: UIPosition) => void;
  bossHealthBarEnabled?: boolean;
  bossHealthBarShowName?: boolean;
  bossHealthBarShowValues?: boolean;
  bossHealthBarShowPercentage?: boolean;
  bossHealthBarPosition?: UIPosition | null;
  onBossHealthBarPositionChange?: (position: UIPosition) => void;
  prayerEnabled?: boolean;
  prayerFlickOrbEnabled?: boolean;
  prayerFlickAlwaysOn?: boolean;
  prayerFlickEnabled?: boolean;
  prayerFlickPosition?: UIPosition | null;
  onPrayerFlickPositionChange?: (position: UIPosition) => void;
  showDetailedDps?: boolean;
  dpsOverlayShowDetails?: boolean;
  detailedDpsPosition?: UIPosition | null;
  onDetailedDpsPositionChange?: (position: UIPosition) => void;
  statusBarsEnabled?: boolean;
  statusBarsShowValues?: boolean;
  /** Mobile layout hotkeys bar; see `PersistedSettings.mobileHotkeys`. */
  mobileHotkeys?: readonly OsmHotkeySlot[];
  mobileHotkeysOpenOnLeft?: boolean;
  /**
   * Mobile layout: the viewer's own chrome scale (`osmChromeScale`), which a recording's
   * replaces. App passes the one it records. Absent, the formula at the default setting and
   * DPR 1 for this frame and its safe area.
   */
  mobileChromeScale?: number;
  /** The device's safe-area insets, which App measures once for everything. Absent, Grid measures them. */
  liveSafeAreaInsets?: SafeAreaInsets;
  /**
   * The Mobile tool window as the viewer's chrome (see MobileToolWindow): portalled into the
   * window-fixed transport host and laid out in window CSS pixels, whatever layout the frame
   * draws. Absent, Grid lays the window out in its own Mobile frame.
   */
  mobileTools?: {
    readonly state: MobileToolWindowState;
    readonly onStateChange: (next: MobileToolWindowState) => void;
    readonly tutorialTarget: Element | null;
    readonly menuHostRef: (node: HTMLElement | null) => void;
    /** The viewer's Mobile gameframe in the window; null for a desktop viewer, who keeps the top chrome. */
    readonly frame: OsmFrame | null;
    /** The window, CSS pixels. */
    readonly viewport: Size;
  };
  /** Where the window-fixed hint toast rests on the bottom-left corner this lays out (ZoomHintToast). */
  onHintToastAnchorChange?: (anchor: HintToastAnchor) => void;
  /**
   * The visible scene (what the sidebars leave of it, the Fixed client's own viewport), in window
   * CSS pixels, reported on a change: window-level prompts center on it (the Colosseum's choice).
   */
  onVisibleSceneRectChange?: (rect: Rect) => void;
  uiScale?: number;
  /** Auto over the game view: every plugin overlay's size. */
  overlayScale?: number;
  /** Auto over the window: the top chrome's and the replay transport's size. Viewer chrome, never recorded. */
  chromeScale?: number;
  /** Off pins the game UI at 100%; the overlays arrive already resolved in `overlayScale`. */
  stretchedModePluginEnabled?: boolean;
  /** Replay workspace fitting, for sprite backing stores (not another CSS zoom). */
  overlayOuterScale?: number;
  /**
   * How much larger than laid out App draws the live frame, per axis (Fixed's Stretch to Window),
   * or null. Sizes the scene canvas's backing store for the painted size; layout stays unscaled.
   */
  framePaintScale?: { readonly x: number; readonly y: number } | null;
  onGamePanelPositionChange?: (position: UIPosition) => void;
  onMinimapPositionChange?: (position: UIPosition) => void;
  onCompactOrbsPositionChange?: (position: UIPosition) => void;
  /** `null` returns the free strip to its default. */
  onInfoboxPositionChange?: (position: UIPosition | null) => void;
  onUiScaleChange?: (scale: number) => void;
  uiInsets?: { left: number; right: number; top: number; bottom: number };
  /**
   * Frame-local sidebar overlap — how much of the game viewport is
   * actually covered by each sidebar. In fit mode this equals
   * `uiInsets`. In fixed-resolution mode sidebars sitting over the
   * letterbox bars contribute zero, and partial overlaps are measured
   * from the frame's edge, not the window's.
   *
   * Used for `allExclusionRects` and the chatbox, Chatbox infobox and toast
   * placement so they stay inside the game viewport even when the
   * window-relative sidebar width doesn't match the frame-local
   * overlap.
   */
  viewportInsets?: { left: number; right: number; top: number; bottom: number };
  viewportOffsetX?: number;
  /**
   * Which OSRS client display mode the frame is laid out as. Only 'fixed'
   * changes anything here: it pins the scene to component 10's rectangle and
   * locks the minimap and side panel to their cache coordinates. The two
   * resizable layouts differ solely in the side panel's own chrome, which is
   * GamePanel's business.
   */
  clientLayoutMode?: ClientLayoutMode;
  transparentSidePanel?: boolean;
  hotkeysCloseSidePanel?: boolean;
  showTickCounter?: boolean;
  showTickCounterOverhead?: boolean;
  tickCounterAbovePrayerIcon?: boolean;
  tickCounterColors?: TickColorOverrides;
  tickCounterOffsetX?: number;
  tickCounterOffsetY?: number;
  showTickCounterInfobox?: boolean;
  tickCounterMax?: number;
  infoboxTextOutlineColor?: string;
  infoboxTextOutlineEnabled?: boolean;
  tickCounterFontSize?: number;
  showAttackTimerMetronome?: boolean;
  /** Attack Timer Metronome's cooldown number; null when hidden. */
  attackCooldownTicks?: OverheadNumberPlacement | null;
  showNpcAttackTimerMetronome?: boolean;
  /** Entity Hider plugin's options; null while it is off. */
  entityHider?: EntityHiderOptions | null;
  /** TzHaar HP Tracker plugin's options; null while it is off. */
  tzhaarHpTracker?: TzhaarHpTrackerOptions | null;
  /** Inferno and Colosseum Additions plugins' options, each null while it is off; null for neither. */
  pillarAdditions?: PillarAdditionsPlugins | null;
  /**
   * Whether the chatbox is open (desktop layouts; Mobile has none). Fixed also gives the scene
   * the cache's 512x334 viewport while it is; collapsed, only its controls row is left.
   */
  chatboxVisible?: boolean;
  onChatboxVisibleChange?: (visible: boolean) => void;
  /** The client's "Transparent chatbox". Resizable only: Fixed draws the opaque chatbox regardless. */
  chatboxTransparent?: boolean;
  /** The client's "Click through transparent chatbox". Read only while the chatbox is transparent. */
  chatboxClickThrough?: boolean;
  /**
   * The desktop top chrome's app-owned parts (launcher/TopChrome.tsx): the menu's buttons, Plugins,
   * the Modifiers launcher, the FPS readout, whether a drawer tucks the row, and whether a combat tutorial hides Replay.
   * Absent, Grid draws no top chrome (Mobile, and Grid rendered on its own).
   */
  topChrome?: Pick<
    TopChromeProps,
    'menu' | 'settings' | 'plugins' | 'modifiers' | 'showFps' | 'elevated' | 'replaySuppressed'
  >;
  /** Compact Orbs plugin: hide the minimap and pack the orbs into a block. */
  compactOrbs?: boolean;
  compactOrbsLayout?: CompactOrbsLayout;
  compactOrbsOrder?: CompactOrbId[];
  /** Zuk set timer controls (the player's clock), or undefined while it is off. */
  zukSetTimer?: ZukSetTimerControls;
  /** Persisted position of the Zuk set timer overlay; null = its default slot. */
  zukSetTimerPosition?: UIPosition | null;
  onZukSetTimerPositionChange?: (position: UIPosition) => void;
  eventOverrides?: GameEvent[];
  replayPaused?: boolean;
  replayCursorTrack?: ReplayCursorTrack;
  onReplayCursorClick?: (clientX: number, clientY: number, type: ReplayClickType, nowMs?: number) => void;
  onReplayViewportSample?: (nowMs?: number, viewportState?: ReplayViewportState) => void;
  onReplayViewportStateGetterChange?: (getter: (() => ReplayViewportState | undefined) | null) => void;
  /** Encounter-agnostic replay-timeline identity (see RenderContext.timeline). */
  replayTimelineKey?: string;
  onSceneReady?: () => void;
  onIntroComplete?: () => void;
  /**
   * Hands over a getter for the wall-clock ms left in the playing intro animation (null until it
   * plays), or null when this viewport cannot tell: no viewport, or a scene with no intro support.
   */
  onIntroTimingGetterChange?: (getter: ((expectedSpeedMultiplier: number) => number | null) | null) => void;
  quickPrayerSetupOpen?: boolean;
  /** Bumped on every request to set up quick prayers (see GamePanel). */
  quickPrayerSetupRequest?: number;
  quickPrayersActive?: boolean;
  tileMarkers?: TileMarker[];
  showTileMarkers?: boolean;
  npcHighlights?: NpcHighlightEntry[];
  showNpcHighlights?: boolean;
  /** NPC Highlights plugin: paint a highlighted NPC's menu entries in its color. */
  npcHighlightColorMenuEntries?: boolean;
  customMenuSwapsEnabled?: boolean;
  /** Raw Custom Menu Swaps rule text, one left-click rule per line. */
  customMenuSwaps?: string;
  showTileMarkerLabels?: boolean;
  tileMarkerWidth?: number;
  onMarkTile?: (tile: Coordinate) => void;
  onUnmarkTile?: (tile: Coordinate) => void;
  lineMarkers?: LineMarker[];
  showLineMarkers?: boolean;
  showLineMarkerLabels?: boolean;
  lineMarkerWidth?: number;
  onMarkLine?: (ref: TileEdgeRef) => void;
  onUnmarkLine?: (ref: TileEdgeRef) => void;
  onUpdateLineColor?: (ref: TileEdgeRef, color: string, opacity: number) => void;
  onUpdateLineLabel?: (ref: TileEdgeRef, label: string | undefined) => void;
  onToggleNpcHighlight?: (npcName: string, npcTypeId: number, mode: NpcHighlightMode) => void;
  onSetNpcHighlightColor?: (npcName: string, npcTypeId: number, mode: NpcHighlightMode, color: string) => void;
  onRemoveNpcHighlight?: (npcTypeId: number, mode: NpcHighlightMode) => void;
  onUpdateTileColor?: (tile: Coordinate, color: string, opacity: number, fillOpacity: number) => void;
  onUpdateMarkerLabel?: (tile: Coordinate, label: string | undefined) => void;
  tileMarkerLastColor?: string;
  tileMarkerLastOpacity?: number;
  masterVolume?: number;
  sfxVolume?: number;
  areaVolume?: number;
  onVolumeChange?: (key: 'masterVolume' | 'sfxVolume' | 'areaVolume', value: number) => void;
  muteWhenUnfocused?: boolean;
  onMuteWhenUnfocusedChange?: (value: boolean) => void;
  mechanicsConfig: MechanicsConfig;
  onMechanicsConfigChange: (config: MechanicsConfig) => void;
  /**
   * Whose setup `mechanicsConfig` is (the saved one, or a tutorial's) and its reset to defaults, for
   * the Practice surfaces to present (`SetupContextControls`).
   */
  setupContext?: SetupContextControls;
  mechanicsToggles: readonly MechanicsToggleInfo[];
  debugActions: readonly DebugActionInfo[];
  onExecuteEncounterCommand: (command: EncounterCommand) => void;
  /** The running encounter's selected loadout for setup links (`EncounterToolProps.exportGear`). */
  exportEncounterGear?: () => string;
  /** The encounter tool opening and closing, to hold the fight under it (`useEncounterTool`). */
  onEncounterToolOpenChange?: (open: boolean) => void;
  /** Practice tool: set the primary boss NPC's current HP (encounter-agnostic). */
  onSetBossHp: (hp: number) => void;
  onRestart?: () => void;
  /** Practice tool: apply a named boss-HP preset as a phase jump (may rebuild phase actors). */
  onApplyBossHpPreset: (hp: number) => void;
  tileIndicatorConfig?: TileIndicatorConfig;
  cameraPluginEnabled?: boolean;
  cameraVerticalCamera?: boolean;
  cameraInvertYaw?: boolean;
  cameraInvertPitch?: boolean;
  cameraInnerZoomLevel?: number;
  cameraOuterZoomLimit?: number;
  cameraSpeed?: number;
  cameraDragSpeed?: number;
  cameraRightClickMovesCamera?: boolean;
  cameraZoomIncrement?: number;
  showCameraDebug?: boolean;
  voidFlareNpcTypeId?: number;
}

const ViewportContextMenuBridge: React.FC<{
  onTileClick: (coord: Coordinate) => void;
  onNpcAction?: (coord: Coordinate) => void;
  onNpcAttackByTarget?: (actorId: string, position: Coordinate) => void;
  tileMarkers: TileMarker[];
  showTileMarkers: boolean;
  onMarkTile?: (tile: Coordinate) => void;
  onUnmarkTile?: (tile: Coordinate) => void;
  onLabelTile?: (tile: Coordinate, clientX: number, clientY: number) => void;
  onColorTile?: (tile: Coordinate, clientX: number, clientY: number) => void;
  lineMarkers: LineMarker[];
  showLineMarkers: boolean;
  onMarkLine?: (ref: TileEdgeRef) => void;
  onUnmarkLine?: (ref: TileEdgeRef) => void;
  onLabelLine?: (ref: TileEdgeRef, clientX: number, clientY: number) => void;
  onColorLine?: (ref: TileEdgeRef, clientX: number, clientY: number) => void;
  entityContext?: ViewportEntityContext;
  resolveGroundItemMenuItems?: (tile: Coordinate | null, screenPx?: { x: number; y: number }) => GroundItemMenuItem[];
  objTypeLoader?: ObjTypeLoader | null;
  onTakeGroundItem?: (groundItemId: string) => void;
  npcHighlights?: NpcHighlightEntry[];
  onToggleNpcHighlight?: (npcName: string, npcTypeId: number, mode: NpcHighlightMode) => void;
  onSetNpcHighlightColor?: (npcName: string, npcTypeId: number, mode: NpcHighlightMode, color: string) => void;
  onOpenNpcTagColorPicker?: (npcName: string, npcTypeId: number, mode: NpcHighlightMode, currentColor: string) => void;
  customMenuSwaps?: readonly CustomMenuSwap[];
  rightClickMovesCamera: boolean;
  projection3D: Projection3D;
  children: (
    handler: (
      tile: Coordinate | null,
      clientX: number,
      clientY: number,
      canvasScreenPx?: { x: number; y: number },
      shiftKey?: boolean,
    ) => ViewportInputOwnership,
  ) => React.ReactNode;
}> = ({
  onTileClick,
  onNpcAction,
  onNpcAttackByTarget,
  tileMarkers,
  showTileMarkers,
  onMarkTile,
  onUnmarkTile,
  onLabelTile,
  onColorTile,
  lineMarkers,
  showLineMarkers,
  onMarkLine,
  onUnmarkLine,
  onLabelLine,
  onColorLine,
  entityContext,
  resolveGroundItemMenuItems,
  objTypeLoader: groundItemObjTypeLoader,
  onTakeGroundItem,
  npcHighlights,
  onToggleNpcHighlight,
  onSetNpcHighlightColor,
  onOpenNpcTagColorPicker,
  customMenuSwaps,
  rightClickMovesCamera,
  projection3D,
  children,
}) => {
  const { showContextMenu } = useContextMenu();
  const hasMarker = useCallback(
    (tile: Coordinate) => {
      return tileMarkers.some((marker) => marker.x === tile[0] && marker.y === tile[1]);
    },
    [tileMarkers],
  );
  const hasEdge = useCallback(
    (ref: TileEdgeRef) => {
      const seg =
        ref.edge === 'south'
          ? { x: ref.x, y: ref.y, orientation: 'horizontal' as const }
          : ref.edge === 'north'
            ? { x: ref.x, y: ref.y + 1, orientation: 'horizontal' as const }
            : ref.edge === 'west'
              ? { x: ref.x, y: ref.y, orientation: 'vertical' as const }
              : { x: ref.x + 1, y: ref.y, orientation: 'vertical' as const };
      return lineMarkers.some((l) => l.x === seg.x && l.y === seg.y && l.orientation === seg.orientation);
    },
    [lineMarkers],
  );

  const handler = useCallback(
    (
      tile: Coordinate | null,
      clientX: number,
      clientY: number,
      canvasScreenPx?: { x: number; y: number },
      shiftKey?: boolean,
    ): ViewportInputOwnership => {
      const ray = canvasScreenPx ? projection3D.screenToRay(canvasScreenPx) : null;
      const tileMarkerContext =
        shiftKey && showTileMarkers && onMarkTile && onUnmarkTile && onLabelTile && onColorTile
          ? {
              shiftKey: true,
              hasMarker,
              callbacks: {
                onMark: onMarkTile,
                onUnmark: onUnmarkTile,
                onLabel: (menuTile: Coordinate) => onLabelTile(menuTile, clientX, clientY),
                onColor: (menuTile: Coordinate) => onColorTile(menuTile, clientX, clientY),
              },
            }
          : undefined;
      const lineMarkerCtx =
        shiftKey && showLineMarkers && onMarkLine && onUnmarkLine && onLabelLine && onColorLine && canvasScreenPx
          ? {
              shiftKey: true,
              edge: projection3D.screenToTileEdge(canvasScreenPx),
              hasEdge,
              callbacks: {
                onMark: onMarkLine,
                onUnmark: onUnmarkLine,
                onLabel: (ref: TileEdgeRef) => onLabelLine(ref, clientX, clientY),
                onColor: (ref: TileEdgeRef) => onColorLine(ref, clientX, clientY),
              },
            }
          : undefined;
      const npcHighlightCtx: NpcHighlightMenuContext | undefined =
        shiftKey && npcHighlights && onToggleNpcHighlight
          ? {
              shiftKey: true,
              isHighlighted: (npcTypeId: number, mode: NpcHighlightMode) =>
                npcHighlights.some((h) => h.npcTypeId === npcTypeId && h.mode === mode),
              getHighlightColor: (npcTypeId: number, mode: NpcHighlightMode) =>
                npcHighlights.find((h) => h.npcTypeId === npcTypeId && h.mode === mode)?.color,
              onToggleHighlight: onToggleNpcHighlight,
              onOpenColorPicker:
                onSetNpcHighlightColor && onOpenNpcTagColorPicker ? onOpenNpcTagColorPicker : undefined,
            }
          : undefined;
      const groundItemMenuItems = onTakeGroundItem ? (resolveGroundItemMenuItems?.(tile, canvasScreenPx) ?? []) : [];
      const groundItemCtx: GroundItemMenuContext | undefined =
        onTakeGroundItem && groundItemMenuItems.length > 0
          ? { items: groundItemMenuItems, objTypeLoader: groundItemObjTypeLoader, onTake: onTakeGroundItem }
          : undefined;
      const resolution = resolveViewportRightClick(
        {
          tile,
          onTileClick,
          entityContext,
          ray,
          screenPx: canvasScreenPx,
          onNpcAction,
          onNpcAttackByTarget,
          groundItemContext: groundItemCtx,
          customMenuSwaps,
          tileMarkerContext,
          lineMarkerContext: lineMarkerCtx,
          npcHighlightContext: npcHighlightCtx,
        },
        rightClickMovesCamera,
      );
      switch (resolution.kind) {
        case 'menu':
          showContextMenu(resolution.content, clientX, clientY);
          return { kind: 'claimed' };
        case 'camera-drag':
          return { kind: 'camera-drag' };
        case 'none':
          return { kind: 'none' };
        default: {
          const exhaustiveResolution: never = resolution;
          throw new TypeError(`Unsupported viewport right-click resolution: ${String(exhaustiveResolution)}`);
        }
      }
    },
    [
      onTileClick,
      onNpcAction,
      onNpcAttackByTarget,
      showContextMenu,
      entityContext,
      resolveGroundItemMenuItems,
      groundItemObjTypeLoader,
      onTakeGroundItem,
      projection3D,
      hasMarker,
      showTileMarkers,
      onMarkTile,
      onUnmarkTile,
      onLabelTile,
      onColorTile,
      npcHighlights,
      onToggleNpcHighlight,
      onSetNpcHighlightColor,
      onOpenNpcTagColorPicker,
      showLineMarkers,
      onMarkLine,
      onUnmarkLine,
      onLabelLine,
      onColorLine,
      hasEdge,
      customMenuSwaps,
      rightClickMovesCamera,
    ],
  );
  return <>{children(handler)}</>;
};

const ViewportEntityBridge: React.FC<{
  entityContext: ViewportEntityContext;
  projection3D: Projection3D;
  isLobby?: boolean;
  onHoveredNpcChange: (actorId: string | null) => void;
  customMenuSwaps?: readonly CustomMenuSwap[];
  /** Same ground-item stack the right-click menu lists, so a rule sees one menu everywhere. */
  resolveGroundItemMenuItems?: (tile: Coordinate | null, screenPx?: { x: number; y: number }) => GroundItemMenuItem[];
  objTypeLoader?: ObjTypeLoader | null;
  onTakeGroundItem?: (groundItemId: string) => void;
  children: (
    onHoveredTileChange: (tile: Coordinate | null, screenPx: { x: number; y: number }) => void,
    leftClickType: 'yellow' | 'red',
  ) => React.ReactNode;
}> = ({
  entityContext,
  projection3D,
  isLobby,
  onHoveredNpcChange,
  customMenuSwaps,
  resolveGroundItemMenuItems,
  objTypeLoader: groundItemObjTypeLoader,
  onTakeGroundItem,
  children,
}) => {
  const { showTooltip, hideTooltip } = useTooltip();
  const [leftClickType, setLeftClickType] = useState<'yellow' | 'red'>('yellow');

  // Hover result memoization: prevents redundant React state updates when the mouse
  // moves within the same entity's hitbox. The key encodes the hover target identity
  // (e.g., 'npc:{actorId}', 'loc:{locType.id}', 'none', 'shift').
  //
  // IMPORTANT: The key must change whenever the tooltip CONTENT semantics change for
  // a given entity. If NPC tooltips become dynamic (e.g., showing HP, combat level
  // changes), the key must incorporate the dynamic data, otherwise the tooltip will
  // display stale content while hovering the same target.
  const lastHoverKeyRef = useRef<string>('none');
  const lastHoverScreenPxRef = useRef<{ x: number; y: number }>({ x: -1, y: -1 });

  const handleHoveredTileChange = useCallback(
    (tile: Coordinate | null, screenPx: { x: number; y: number }) => {
      lastHoverScreenPxRef.current = screenPx;

      const applyHoverResult = (
        key: string,
        tooltip: ReturnType<typeof buildNpcTooltip> | null,
        clickType: 'red' | 'yellow',
        npcId: string | null,
      ) => {
        if (lastHoverKeyRef.current === key) return;
        lastHoverKeyRef.current = key;
        if (tooltip) {
          showTooltip(tooltip);
        } else {
          hideTooltip();
        }
        setLeftClickType(clickType);
        onHoveredNpcChange(npcId);
      };

      if (screenPx.x < 0) {
        applyHoverResult('none', null, 'yellow', null);
        return;
      }

      if (getModifiers().shift) {
        applyHoverResult('shift', null, 'yellow', null);
        return;
      }

      const ray = projection3D.screenToRay(screenPx);
      if (!ray) {
        applyHoverResult('none', null, 'yellow', null);
        return;
      }

      // One pick for the whole handler: resolving a swap builds the same menu the click
      // does, and the fallback below needs the same NPCs. Left as two calls this ran the
      // per-face narrowphase over every NPC twice on every mouse move.
      const picks = entityContext.pickNpcs?.(ray, screenPx) ?? [];
      const hoverContext: ViewportEntityContext = { ...entityContext, pickNpcs: () => picks };

      // A swap rule decides the left click, so it decides the hover text too. The promoted
      // entry can belong to an NPC further back than the nearest one under the cursor, which
      // is the whole point of a rule: without this the tooltip would keep naming whatever is
      // in front while the click acted on something else.
      if (customMenuSwaps && customMenuSwaps.length > 0) {
        const groundItems = onTakeGroundItem ? (resolveGroundItemMenuItems?.(tile, screenPx) ?? []) : [];
        const swapped = resolveViewportLeftClickSwap({
          tile,
          entityContext: hoverContext,
          ray,
          screenPx,
          groundItemContext:
            onTakeGroundItem && groundItems.length > 0
              ? { items: groundItems, objTypeLoader: groundItemObjTypeLoader, onTake: onTakeGroundItem }
              : undefined,
          customMenuSwaps,
        });
        if (swapped?.kind === 'walk') {
          applyHoverResult('swap:walk', null, 'yellow', null);
          return;
        }
        if (swapped) {
          const { action, target, targetColor } = swapped.entry;
          applyHoverResult(
            `swap:${action}:${target ?? ''}:${targetColor ?? ''}`,
            buildMenuEntryTooltip(swapped.entry),
            'red',
            null,
          );
          return;
        }
      }

      // Every NPC under the cursor, nearest first, reduced to the one that owns the
      // menu - op-less NPCs like the Zuk shield are see-through.
      const resolved = resolveInteractiveNpcPick(picks, entityContext.npcTypeLoader);
      if (resolved) {
        const { picked, npcType } = resolved;
        if (!npcType) {
          // NPC hit but its type failed to load - still mark it as the hovered target.
          applyHoverResult(`npc-no-tooltip:${picked.actorId}`, null, 'yellow', picked.actorId);
          return;
        }
        if (isNpcAttackable(npcType)) {
          // In the memo key because it is part of the tooltip's content: recoloring a tag
          // while its NPC is hovered would otherwise leave the old color on screen.
          const highlightColor = entityContext.npcMenuColor?.(picked.npcTypeId, picked.actorId);
          applyHoverResult(
            `npc:${picked.actorId}:${highlightColor ?? ''}`,
            buildNpcTooltip(npcType, highlightColor),
            'red',
            picked.actorId,
          );
          return;
        }
        // Owns ops but no Attack (e.g. a Talk-to NPC): it still heads the menu, so it
        // is not a red-X target and nothing behind it can be one either.
        applyHoverResult(`npc-no-action:${picked.actorId}`, null, 'yellow', null);
        return;
      }

      const groundItemHits = entityContext.pickGroundItems?.(screenPx) ?? [];
      const nearestGroundItem = groundItemHits[0];
      if (nearestGroundItem) {
        applyHoverResult(
          `item:${nearestGroundItem.groundItemId}`,
          buildGroundItemTooltip(nearestGroundItem.itemId, entityContext.objTypeLoader ?? undefined),
          'red',
          null,
        );
        return;
      }

      if (!isLobby) {
        const { locs } = entityContext;
        if (locs && locs.length > 0) {
          const locType = rayFindInteractiveLoc(ray, locs);
          if (locType) {
            const tooltip = buildLocTooltip(locType);
            if (tooltip) {
              applyHoverResult(`loc:${locType.id}`, tooltip, 'red', null);
              return;
            }
          }
        }
      }

      applyHoverResult('none', null, 'yellow', null);
    },
    [
      entityContext,
      projection3D,
      isLobby,
      showTooltip,
      hideTooltip,
      onHoveredNpcChange,
      customMenuSwaps,
      resolveGroundItemMenuItems,
      groundItemObjTypeLoader,
      onTakeGroundItem,
    ],
  );

  // Shift makes the left click "Walk here", so the tooltip naming the entity under
  // the cursor is wrong for as long as it is held. Hover is otherwise only
  // recomputed on pointer movement, which leaves a stale tooltip on screen for a
  // player who presses Shift without moving the mouse — the normal way to do it.
  useEffect(() => {
    let previousShift = getModifiers().shift;
    return subscribeModifiers(({ shift }) => {
      if (shift === previousShift) return;
      previousShift = shift;
      handleHoveredTileChange(null, lastHoverScreenPxRef.current);
    });
  }, [handleHoveredTileChange]);

  return <>{children(handleHoveredTileChange, leftClickType)}</>;
};

export const Grid: React.FC<Partial<GridProps>> = (props) => {
  const simulationContext = useSimulationContext();
  const settingsContext = useSettingsContext();
  const {
    simulationState,
    replayControls,
    replayPractice,
    encounterSession = null,
    replayViewportWidth = window.innerWidth,
    engine,
    dpsProjection,
    onTileClick,
    showCoordinates,
    tileGrid = null,
    encounterDebugFlags = {},
    smoothTerrain = false,
    brightness = 0.6,
    contrast = 1.0,
    saturation = 1.0,
    renderScale = 1,
    fpsCap = 0,
    prayerPresentation,
    inputPresentation,
    onPrayerChange,
    onBoostPrayerChange,
    onIndependentPrayerChange,
    onQuickPrayerToggle,
    onQuickPrayerSetup,
    onCloseQuickPrayerSetup,
    onQuickPrayerSelectionsReady,
    onMarkOfDarknessCast,
    onDeathChargeCast,
    onRunToggle,
    onSpecialAttackToggle,
    onAttackStyleChange,
    onSelectedSpellChange,
    armedSpell,
    onArmSpell,
    targetTile,
    rendererType = 'webgl',
    encounterKind,
    sceneLoadId = 0,
    onReturnToLobby,
    cacheManager,
    eventAudioPlayer,
    frameSoundTracker,
    mapLoader,
    underlayLoader,
    overlayLoader,
    textureLoader,
    minimapNpcDotUrl,
    locModelLoader,
    npcModelLoader,
    playerModelLoader,
    spotAnimModelLoader,
    playerConfig,
    animationSystem,
    mapLocs,
    encounterRequiresLocs,
    encounterIsBeta,
    encounterRenderConfig,
    inventory,
    inventoryPreviewResetToken,
    equipmentStats,
    playerEquipment,
    onUnequipSlot,
    equippedAmmo,
    quiverAmmo,
    onUnequipAmmo,
    onEquipmentSlotClick,
    onEquipFromInventory,
    onUseItem,
    onDropItem,
    onTakeGroundItem,
    onSwapInventorySlots,
    inventoryTags,
    showInventoryTags,
    antiDragEnabled,
    dragOnShiftOnly,
    antiDragDelay,
    antiDragCtrlToDrag,
    onTagItem,
    onUntagItem,
    inventoryTagLastColor,
    objTypeLoader,
    npcTypeLoader,
    enumTypeLoader,
    structTypeLoader,
    speedMultiplier = 1,
    gamePanelPosition,
    activeGamePanelTab,
    onActiveGamePanelTabChange,
    minimapPosition,
    compactOrbsPosition,
    infoboxPosition,
    infoboxPinTarget = 'inventory',
    xpDropsEnabled = true,
    onXpDropsToggle,
    xpDropsShowPredictedHit = true,
    xpDropsGrouped = true,
    xpDropsShowIcons = true,
    xpDropsSpeed = 44,
    xpDropsPosition,
    onXpDropsPositionChange,
    bossHealthBarEnabled = false,
    bossHealthBarShowName = true,
    bossHealthBarShowValues = true,
    bossHealthBarShowPercentage = true,
    bossHealthBarPosition,
    onBossHealthBarPositionChange,
    prayerEnabled = false,
    prayerFlickOrbEnabled = false,
    prayerFlickAlwaysOn = false,
    prayerFlickEnabled = false,
    prayerFlickPosition,
    onPrayerFlickPositionChange,
    showDetailedDps = false,
    dpsOverlayShowDetails = false,
    detailedDpsPosition,
    onDetailedDpsPositionChange,
    statusBarsEnabled = false,
    mobileHotkeys,
    mobileHotkeysOpenOnLeft = false,
    mobileChromeScale,
    liveSafeAreaInsets,
    mobileTools,
    onHintToastAnchorChange,
    onVisibleSceneRectChange,
    statusBarsShowValues = true,
    uiScale,
    overlayScale = 1,
    chromeScale = overlayScale,
    stretchedModePluginEnabled = true,
    overlayOuterScale = 1,
    framePaintScale = null,
    onGamePanelPositionChange,
    onMinimapPositionChange,
    onCompactOrbsPositionChange,
    onInfoboxPositionChange,
    onUiScaleChange,
    uiInsets,
    viewportInsets,
    viewportOffsetX = 0,
    sceneOverlay,
    renderStatus = RENDER_STATUS_OK,
    onRenderStatusChange,
    graphicsHeld = false,
    graphicsHeldActivity = null,
    clientLayoutMode = 'modern',
    transparentSidePanel = true,
    hotkeysCloseSidePanel = false,
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
    showAttackTimerMetronome,
    attackCooldownTicks = null,
    showNpcAttackTimerMetronome,
    entityHider = null,
    tzhaarHpTracker = null,
    pillarAdditions = null,
    chatboxVisible = true,
    onChatboxVisibleChange,
    chatboxTransparent = PERSISTED_SETTINGS_DEFAULTS.transparentChatbox,
    chatboxClickThrough = PERSISTED_SETTINGS_DEFAULTS.clickThroughTransparentChatbox,
    topChrome,
    compactOrbs,
    compactOrbsLayout,
    compactOrbsOrder,
    zukSetTimer,
    zukSetTimerPosition,
    onZukSetTimerPositionChange,
    eventOverrides,
    replayPaused,
    replayCursorTrack,
    onReplayCursorClick,
    onReplayViewportSample,
    onReplayViewportStateGetterChange,
    replayTimelineKey,
    onSceneReady,
    onIntroComplete,
    onIntroTimingGetterChange,
    quickPrayerSetupOpen,
    quickPrayerSetupRequest,
    quickPrayersActive,
    tileMarkers = [],
    showTileMarkers = true,
    npcHighlights = [],
    showNpcHighlights = true,
    npcHighlightColorMenuEntries = true,
    customMenuSwapsEnabled = false,
    customMenuSwaps = '',
    showTileMarkerLabels = true,
    tileMarkerWidth = DEFAULT_TILE_MARKER_WIDTH,
    onMarkTile,
    onUnmarkTile,
    lineMarkers = [],
    showLineMarkers = true,
    showLineMarkerLabels = true,
    lineMarkerWidth = DEFAULT_LINE_MARKER_WIDTH,
    onMarkLine,
    onUnmarkLine,
    onUpdateLineColor,
    onUpdateLineLabel,
    onToggleNpcHighlight,
    onSetNpcHighlightColor,
    onUpdateTileColor,
    onUpdateMarkerLabel,
    tileMarkerLastColor = DEFAULT_MARKER_COLOR,
    tileMarkerLastOpacity = DEFAULT_MARKER_OPACITY,
    masterVolume,
    sfxVolume,
    areaVolume,
    onVolumeChange,
    muteWhenUnfocused,
    onMuteWhenUnfocusedChange,
    mechanicsConfig,
    onMechanicsConfigChange,
    setupContext,
    mechanicsToggles,
    debugActions,
    onExecuteEncounterCommand,
    exportEncounterGear,
    onEncounterToolOpenChange,
    onSetBossHp,
    onRestart,
    onApplyBossHpPreset,
    tileIndicatorConfig,
    cameraPluginEnabled = false,
    cameraVerticalCamera = false,
    cameraInvertYaw = false,
    cameraInvertPitch = false,
    cameraInnerZoomLevel = INNER_ZOOM_LEVEL_MIN,
    cameraOuterZoomLimit = 0,
    cameraSpeed = 1,
    cameraDragSpeed = 1,
    cameraRightClickMovesCamera = false,
    cameraZoomIncrement = 25,
    showCameraDebug = false,
  } = { ...(simulationContext ?? {}), ...(settingsContext ?? {}), ...props } as GridProps;
  const containerRef = useRef<HTMLDivElement>(null);
  /** The scene's box, holding the viewport whose wheel is the camera zoom. */
  const sceneRef = useRef<HTMLDivElement>(null);
  const replayPresentation = useReplayPresentation();
  const effectiveOverlayScale = replayPresentation ? (replayPresentation.overlayScale ?? 1) : overlayScale;
  /**
   * Layout transitions are suppressed while replaying a recorded presentation.
   *
   * The recorder's layout arrives as discrete snapshots and the replayed cursor
   * jumps to the new one instantly, so a 300ms slide between them would leave the
   * cursor pointing at a control that is still on its way. CSS/WAAPI clocks also
   * ignore replay seeking and the speed multiplier, so the animation would not
   * even be reproducible. Live play keeps its animations.
   */
  const transportZoomRef = useRef<HTMLDivElement>(null);
  const snapRegistry = usePanelSnapRegistry();
  // Window-fixed chrome (the launcher row, Plugins) registers snap bounds against the game-frame origin.
  useEffect(() => {
    if (!snapRegistry) return;
    return snapRegistry.registerFrameOrigin(() => {
      const container = containerRef.current;
      if (!container) return null;
      const { x, y, scaleX, scaleY } = measureFramePlacement(container, container.clientWidth, container.clientHeight);
      return { left: x, top: y, scaleX, scaleY };
    });
  }, [snapRegistry]);
  const captureNotice = useMemo(() => replayCaptureNotice(replayControls?.capture), [replayControls?.capture]);
  const snapLayout = replayPresentation !== null;
  // Bumped whenever the rebuilt frame changes shape. Recorded cursor coordinates
  // do not change with it, but the ELEMENT under them does, so the cursor layer's
  // synthetic hover has to be re-aimed even though the cursor has not moved.
  const [layoutRevision, setLayoutRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: replayPresentation is the trigger, not an input. The body reads nothing from it; entering or leaving a replay is exactly the moment the frame is rebuilt and the revision has to tick.
  useEffect(() => {
    setLayoutRevision((revision) => revision + 1);
  }, [replayPresentation]);
  const layoutTransition = (property: string) =>
    snapLayout ? undefined : `${property} 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)`;
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  // Tracks whether the ResizeObserver has produced its first authoritative
  // measurement of the container's actual size. Until this flips true, the
  // `size` state still carries the window-size initializer which is a lie
  // in fixed-resolution mode (the frame is a centered WxH box inside the
  // stage, not the full window).
  //
  // Used to gate rendering of draggable panels (GamePanel, Minimap) whose
  // child DraggablePanel treats the first viewport value it sees as the
  // rescaling baseline — feeding it the wrong initial viewport causes a
  // persistent drift where each refresh rewrites the saved panel position
  // after the ResizeObserver correction.
  const [viewportMeasured, setViewportMeasured] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    setSize({
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });
    setViewportMeasured(true);

    // Rendered synchronously inside the observer callback, which runs after layout and
    // before paint: every panel is placed against the new frame in the frame that shows
    // it. Deferring to a rAF (and from there to React's default-priority task) painted
    // each window-drag step with the panels still placed for the previous size, so they
    // trailed the window edge by a step and caught up a frame or two later.
    const observer = new ResizeObserver(() => {
      const container = containerRef.current;
      if (!container) return;
      const next = { width: container.clientWidth, height: container.clientHeight };
      flushSync(() => setSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next)));
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // App sizes `.game-viewport-frame` to exactly FIXED_FRAME x stretchScale, so
  // the measured container width recovers that factor without a second prop —
  // and it recovers it from the box that was actually laid out, which is the
  // one every rectangle below has to agree with.
  //
  // Nothing is transformed. Logical cache coordinates become physical CSS
  // pixels here and nowhere else, which is what keeps pointer coordinates,
  // DraggablePanel's drag math and the position:fixed overlays in one space.
  const isFixedLayout = clientLayoutMode === 'fixed';
  const fixedStretchScale = isFixedLayout && size.width > 0 ? size.width / FIXED_FRAME.width : 1;
  // Mobile pins its chrome to a gameframe inside the device's safe area at the native
  // client's scale (see osmChromeScale), so like fixed it is not user-resizable.
  const isMobileLayout = clientLayoutMode === 'mobile';
  // The mobile client's orbs are its own (orbs_osm, in the map container); Compact Orbs would
  // only cover them.
  const showCompactOrbs = Boolean(compactOrbs) && !isMobileLayout;
  // Reported by GamePanel, which owns the mobile side panel's state.
  // Playback rebuilds the recorder's frame, notch and scale included (see
  // resolveReplaySafeAreaInsets).
  const measuredSafeAreaInsets = useSafeAreaInsets(isMobileLayout && liveSafeAreaInsets === undefined);
  const safeAreaInsets = resolveReplaySafeAreaInsets(replayPresentation, liveSafeAreaInsets ?? measuredSafeAreaInsets);
  const osmScale = resolveReplayMobileChromeScale(
    replayPresentation,
    mobileChromeScale ??
      osmChromeScale({
        interfaceScaling: OSM_INTERFACE_SCALING_DEFAULT,
        devicePixelRatio: 1,
        viewport: size,
        safeAreaInsets,
      }),
  );
  const mobileFrame = useMemo(
    () => (isMobileLayout && size.width > 0 && size.height > 0 ? osmFrame(size, safeAreaInsets, osmScale) : null),
    [isMobileLayout, size, safeAreaInsets, osmScale],
  );
  const mobileMapContainer = useMemo(
    () =>
      mobileFrame
        ? {
            frame: mobileFrame,
            rect: osmCssRect(mobileFrame, osmChromeLayout(mobileFrame.size, false).mapContainer),
          }
        : undefined,
    [mobileFrame],
  );
  // With the chatbox shown the scene is the cache's own viewport; with it hidden
  // the scene takes CHAT_CONTAINER's rows too. Everything else in the frame is
  // unaffected — the side column starts at x=516 either way.
  const fixedScene = isFixedLayout && chatboxVisible ? FIXED_VIEWPORT : FIXED_SCENE;
  /**
   * The Mobile tool window outranks the passive overlays it shares the frame with.
   *
   * `.replay-bar` already asks for z-index 30, but the compact transport renders INSIDE the window,
   * which carries a transform, so that 30 only orders the bar against its own siblings. While
   * replaying, the transport is the control the user is actually driving; readouts must not cover it.
   */
  const toolWindowZ = replayControls?.isReplaying ? REPLAY_STACK_Z : HUD_LAYER_Z;

  const gamePanelScale = replayPresentation?.uiScale ?? (stretchedModePluginEnabled ? (uiScale ?? 1) : 1);
  // Use viewportInsets (frame-local overlap) rather than uiInsets
  // (window-relative) so exclusion rects never reach into the
  // letterbox bars in fixed-resolution mode. Falls back to uiInsets
  // for parents that haven't wired viewportInsets yet.
  const effectiveViewportInsets = viewportInsets ?? uiInsets;
  /**
   * The chatbox, in this layer's CSS pixels; null in Mobile. It is the bottom layer, and only the
   * chrome keeps off it: the Chatbox infoboxes sit on top of it (RuneLite's "above chatbox" corner),
   * the launcher panes end above it, and the Mobile tool window and the replay transport treat it as
   * an obstacle. Draggable panels
   * (side panel, minimap, infoboxes and the rest) do NOT take it as an exclusion: they draw over
   * it, so resizing the window or collapsing the chat never moves them.
   */
  const toggleChatbox = useCallback(
    () => onChatboxVisibleChange?.(!chatboxVisible),
    [onChatboxVisibleChange, chatboxVisible],
  );
  const chatbox = useMemo(
    () =>
      chatboxPlacement({
        layout: clientLayoutMode,
        visible: chatboxVisible,
        frame: size,
        fixedScale: fixedStretchScale,
        resizableScale: gamePanelScale,
        insetLeft: isFixedLayout ? 0 : (effectiveViewportInsets?.left ?? 0),
      }),
    [clientLayoutMode, chatboxVisible, size, fixedStretchScale, gamePanelScale, isFixedLayout, effectiveViewportInsets],
  );
  // Where the chatbox's top is, in frame pixels: its controls row's while collapsed.
  const chatTop = size.height - chatboxClearance(chatbox, size.height);
  /**
   * The Chatbox infobox rows' anchor (Settings, Infobox position "Chatbox"): above the chatbox, as
   * wide as it (layout/topChromeLayout.ts).
   */
  const chatboxInfoboxes = useMemo(
    () =>
      chatbox || isFixedLayout
        ? chatboxInfoboxAnchor({
            frame: size,
            fixed: isFixedLayout,
            chat: chatbox
              ? { ...chatbox.rect, y: chatTop }
              : { x: effectiveViewportInsets?.left ?? 0, y: chatTop, width: 0, height: 0 },
            zoom: effectiveOverlayScale,
          })
        : null,
    [chatbox, chatTop, isFixedLayout, size, effectiveViewportInsets, effectiveOverlayScale],
  );

  // Where the frame is drawn in the window (a replay fits, and may scale, it): the one measure that
  // maps the window-space chrome (the top chrome, the Mobile tool window, the hint toast) to and
  // from the frame's own pixels. Measured with the rest of the frame's chrome (useLayoutMeasure,
  // below), set only on a change: the fit follows the window.
  const [framePlacement, setFramePlacement] = useState<FramePlacement>(IDENTITY_FRAME_PLACEMENT);

  // The Mobile tool window. In the app it is the viewer's chrome: one instance, portalled into the
  // window-fixed transport host and laid out in window CSS pixels around whatever layout the
  // frame draws, so a desktop recording on a phone keeps it (and the Menu inside it). A Grid
  // without the app lays it out in its own Mobile frame.
  const toolsInWindow = mobileTools !== undefined;
  const toolsFrame = mobileTools ? mobileTools.frame : mobileFrame;
  const toolsViewport = mobileTools ? mobileTools.viewport : size;
  // The space the Mobile tool window takes, open or docked, reported by the window itself, in
  // its own coordinates (toolsViewport).
  const [mobileToolsRects, setMobileToolsRects] = useState<readonly Rect[]>([]);
  const mobileToolsRect = mobileToolsRects[0] ?? null;
  // Its state is the app's; a Grid rendered without the app keeps its own.
  const [localMobileToolsState, setLocalMobileToolsState] = useState(DEFAULT_MOBILE_TOOL_WINDOW);

  /**
   * The Mobile layout's HUD overlays: XP drops, the buff bar and the boss bar where the mobile
   * client puts them, and the simulator's aids where nothing else is (osmHud). Every Mobile
   * overlay is locked in ordinary play; "Edit layout" (mobileLayoutEdit) frees the aids alone.
   */
  const mobilePanelModes = useMobilePanelModes();
  const mobileLayoutEditingRequested = useMobileLayoutEditing();
  const mobileLayoutEditing = mobileLayoutEditingRequested && isMobileLayout && !replayControls?.isReplaying;
  useEffect(() => {
    // Edit mode is the Mobile layout's and the viewer's: it ends with either.
    if (mobileLayoutEditingRequested && (!isMobileLayout || replayControls?.isReplaying)) {
      setMobileLayoutEditing(false);
    }
  }, [mobileLayoutEditingRequested, isMobileLayout, replayControls?.isReplaying]);
  // The panel measures itself; until it has, its seed height stands in.
  const [detailedDpsHeight, setDetailedDpsHeight] = useState(DETAILED_DPS_SEED_HEIGHT);
  const mobileBuffCount = isMobileLayout
    ? selectInfoboxes(simulationState, {
        showTickCounterInfobox: (showTickCounter ?? true) && (showTickCounterInfobox ?? true),
        tickCounterMax,
      }).length
    : 0;
  const mobileSide = useMemo(
    () => ({
      panelOpen: mobilePanelModes.panelOpen,
      tabsCollapsed: mobilePanelModes.tabsCollapsed,
      panelOnLeft:
        mobilePanelModes.panelOpen &&
        osmSidePanelOnLeft(mobilePanelModes.panelFromHotkey, mobilePanelModes.hotkeysOpenOnLeft),
    }),
    [mobilePanelModes],
  );
  const replaying = replayControls?.isReplaying ?? false;
  // The transport (desktop's dock, or the Mobile Replay tab that asked for playback) renders in the
  // commit that turns playback on, so by this effect it is in the DOM for the step that spotlights it.
  useEffect(() => {
    if (replaying) window.dispatchEvent(new CustomEvent(TUTORIAL_REPLAY_ENTERED_EVENT));
  }, [replaying]);
  const mobileHud = useMemo(() => {
    if (!mobileFrame) return null;
    const aids: OsmHudAid[] = [];
    const aidWidth = BOSS_HEALTH_BAR_WIDTH * effectiveOverlayScale;
    if (showDetailedDps) {
      aids.push({
        id: 'detailedDps',
        size: { width: aidWidth, height: detailedDpsHeight * effectiveOverlayScale },
      });
    }
    if (prayerFlickEnabled) {
      aids.push({
        id: 'prayerFlick',
        size: { width: aidWidth, height: PRAYER_FLICK_PANEL_HEIGHT * effectiveOverlayScale },
      });
    }
    if (zukSetTimer?.timer) {
      aids.push({
        id: 'zukSetTimer',
        size: { width: aidWidth, height: ZUK_SET_TIMER_PANEL_HEIGHT * effectiveOverlayScale },
      });
    }
    const tools = toolsInWindow
      ? mobileToolsRects.map((rect) => windowToFrame(rect, framePlacement))
      : mobileToolsRects;
    const placement = placeOsmHud({
      frame: mobileFrame,
      side: mobileSide,
      hotkeysCollapsed: mobilePanelModes.hotkeysCollapsed,
      ...mobileNativeSizes(mobileFrame),
      buffCount: mobileBuffCount,
      aids,
      occupied: tools,
    });
    const topLeft = (rect: { x: number; y: number }): UIPosition => ({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      anchorX: 'left',
      anchorY: 'top',
    });
    const exclusions = [...placement.chrome, placement.xpDrops, placement.bossBar, ...tools].map((rect) => ({
      left: rect.x,
      top: rect.y,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
    }));
    return {
      placement,
      bossBar: topLeft(placement.bossBar),
      xpDrops: {
        x: Math.round(size.width - placement.xpDrops.x - placement.xpDrops.width),
        y: Math.round(placement.xpDrops.y),
        anchorX: 'right',
        anchorY: 'top',
      } satisfies UIPosition,
      aid: (id: string): UIPosition | undefined => {
        const rect = placement.aids[id];
        return rect ? topLeft(rect) : undefined;
      },
      aidExclusions: exclusions,
    };
  }, [
    mobileFrame,
    mobileSide,
    mobilePanelModes.hotkeysCollapsed,
    mobileBuffCount,
    showDetailedDps,
    detailedDpsHeight,
    prayerFlickEnabled,
    zukSetTimer?.timer,
    effectiveOverlayScale,
    mobileToolsRects,
    toolsInWindow,
    framePlacement,
    size.width,
  ]);

  const effectiveInfoboxPinTarget: InfoboxPinTarget = resolveInfoboxPinTarget(infoboxPinTarget, clientLayoutMode);
  // The Mobile tool window replaces a desktop frame's bottom-left corner, and the infoboxes
  // pinned there, so they show at the standalone panel's default spot instead. Display only: the saved free
  // position and the setting itself stay as they were.
  const infoboxHudFallback = toolsFrame !== null && !isMobileLayout && effectiveInfoboxPinTarget === 'hud';
  const displayedInfoboxPinTarget: InfoboxPinTarget = infoboxHudFallback ? 'free' : effectiveInfoboxPinTarget;
  // What sits at the bottom left over the chatbox (the Chatbox infobox rows and the readouts above
  // them), measured (useLayoutMeasure, below) and set only on a change: the readouts stack on the
  // rows, and the window-fixed hint toast (ZoomHintToast) sits on all of it.
  const bottomLeftReadoutsRef = useRef<HTMLDivElement>(null);
  const [bottomLeftReadoutsHeight, setBottomLeftReadoutsHeight] = useState(0);
  const [chatboxInfoboxHeight, setChatboxInfoboxHeight] = useState(0);
  const infoboxesAtChatbox = displayedInfoboxPinTarget === 'hud' && !isMobileLayout && chatboxInfoboxes !== null;
  const bottomLeftBottom = size.height - (chatboxInfoboxes?.bottom ?? chatTop - HUD_TOOL_GAP) + chatboxInfoboxHeight;
  // Reported rather than duplicated: the window-fixed toast cannot see the chatbox's clearance, the
  // rows, the readouts or the frame's place in the window, and hardcoding any of them is what leaves
  // it floating off them. In window pixels, from the measures, and only on a change.
  const reportedHintToastAnchorRef = useRef<HintToastAnchor | null>(null);
  useEffect(() => {
    if (!onHintToastAnchorChange) return;
    const { x: frameX, y: frameY, scaleX, scaleY } = framePlacement;
    const frameToWindowX = (value: number) => frameX + value * scaleX;
    const frameToWindowY = (value: number) => frameY + value * scaleY;
    // The tool window's own coordinates are the window's in the app, the frame's without it.
    const toolsToWindowX = (value: number) => (toolsInWindow ? value : frameToWindowX(value));
    const toolsToWindowY = (value: number) => (toolsInWindow ? value : frameToWindowY(value));
    // Toast policy: one gap past a sidebar over the frame's left even where the corner under it
    // does not move past it (Fixed's), and clear of the Mobile tool window's left column.
    const leftInFrame = Math.max(
      chatboxInfoboxes?.left ?? 0,
      (effectiveViewportInsets?.left ?? 0) + HUD_TOOL_GAP * effectiveOverlayScale,
    );
    let left = frameToWindowX(leftInFrame);
    if (toolsFrame) left = Math.max(left, toolsToWindowX(osmLeftColumnRight(toolsFrame)) + HUD_TOOL_GAP * scaleX);
    // It rests on the Mobile tool window, open or docked; otherwise on the readouts and rows.
    const top = mobileToolsRect
      ? toolsToWindowY(mobileToolsRect.y)
      : frameToWindowY(size.height - bottomLeftBottom - bottomLeftReadoutsHeight);
    const previous = reportedHintToastAnchorRef.current;
    if (previous && previous.left === left && previous.top === top) return;
    reportedHintToastAnchorRef.current = { left, top };
    onHintToastAnchorChange({ left, top });
  });

  // The desktop top chrome (launcher/TopChrome.tsx): the layout it places its panes on, the replay
  // entry it offers, and the labeled launcher row it reports back, in frame pixels, for the boss
  // bar's default slot to keep clear of.
  const topChromeLayoutKey = [
    size.width,
    size.height,
    clientLayoutMode,
    chatboxVisible,
    replayViewportWidth,
    JSON.stringify(minimapPosition ?? null),
    showCompactOrbs,
  ].join('|');
  const topChromeReplay = useMemo<TopChromeProps['replay']>(
    () =>
      replayControls
        ? {
            hasRecording: Boolean(replayControls.hasRecording && replayControls.onEnterReplay),
            isReplaying: replayControls.isReplaying,
            onEnter: replayControls.onEnterReplay,
            onExit: replayControls.onExitReplay,
            notice: captureNotice,
          }
        : null,
    [replayControls, captureNotice],
  );
  // The top chrome reports the launcher row and Plugins in window pixels, and they are kept so; the
  // boss bar's default slot takes them in the frame's (framePlacement), which a fitted replay also
  // scales.
  const [launcherRowInWindow, setLauncherRowInWindow] = useState<Rect | null>(null);
  const reportLauncherRow = useCallback(
    (rect: Rect | null) => setLauncherRowInWindow((previous) => sameRect(previous, rect)),
    [],
  );
  const [pluginsInWindow, setPluginsInWindow] = useState<Rect | null>(null);
  const reportPlugins = useCallback(
    (rect: Rect | null) => setPluginsInWindow((previous) => sameRect(previous, rect)),
    [],
  );
  // The minimap with its orbs (or the Compact Orbs block), where it is now, in window pixels: the
  // boss bar's default keeps clear of it. Set only on a change.
  const [minimapInWindow, setMinimapInWindow] = useState<Rect | null>(null);
  // The frame's place in the window, the minimap, the Chatbox infobox rows and the readouts on them,
  // measured when any may have moved (useLayoutMeasure: panel solves, the window, the frame's place
  // and these inputs), never on a tick.
  useLayoutMeasure(containerRef, () => {
    const container = containerRef.current;
    if (!container) return [];
    const placement = measureFramePlacement(container, container.clientWidth, container.clientHeight);
    setFramePlacement((previous) =>
      previous.x === placement.x &&
      previous.y === placement.y &&
      previous.scaleX === placement.scaleX &&
      previous.scaleY === placement.scaleY
        ? previous
        : placement,
    );
    const minimap = container.querySelector('[data-tutorial="minimap"]');
    const box = minimap?.getBoundingClientRect();
    const next = box && box.width > 0 ? { x: box.left, y: box.top, width: box.width, height: box.height } : null;
    setMinimapInWindow((previous) => sameRect(previous, next));
    const strip = infoboxesAtChatbox ? container.querySelector('[data-tutorial="infobox-panel"]') : null;
    const stripBox = strip?.getBoundingClientRect();
    // Measured on screen, used in frame pixels: a transform on the frame (Stretch to Window, a
    // fitted replay) is in the box, so it comes back out.
    const stripHeight =
      stripBox && stripBox.height > 0 ? stripBox.height / placement.scaleY + HUD_TOOL_GAP * effectiveOverlayScale : 0;
    setChatboxInfoboxHeight((previous) => (previous === stripHeight ? previous : stripHeight));
    const readouts = bottomLeftReadoutsRef.current;
    const readoutsHeight = readouts?.offsetHeight ?? 0;
    setBottomLeftReadoutsHeight((previous) => (previous === readoutsHeight ? previous : readoutsHeight));
    return [container, minimap, strip, readouts];
  }, [
    size.width,
    size.height,
    clientLayoutMode,
    replayPresentation,
    infoboxesAtChatbox,
    effectiveOverlayScale,
    // The readouts are drawn with these.
    toolsFrame !== null,
    showCameraDebug,
    showCoordinates,
  ]);
  const launcherRow = useMemo(
    () => launcherRowInWindow && windowToFrame(launcherRowInWindow, framePlacement),
    [launcherRowInWindow, framePlacement],
  );
  const bossBarChrome = useMemo(
    () =>
      [minimapInWindow, pluginsInWindow]
        .filter((rect): rect is Rect => rect !== null)
        .map((rect) => windowToFrame(rect, framePlacement)),
    [minimapInWindow, pluginsInWindow, framePlacement],
  );

  // Viewer drawers bound the window-level dock, not the recording's frame-local
  // viewportInsets. Keep the existing 8px dock gutters on either side of the room.
  const replayDockLeft = uiInsets?.left ?? 0;
  const replayDockRight = uiInsets?.right ?? 0;
  const replayDockWidth = Math.max(0, replayViewportWidth - replayDockLeft - replayDockRight);
  const replayDockStyle = {
    left: replayDockLeft ? replayDockLeft + 8 : undefined,
    right: replayDockRight ? replayDockRight + 8 : undefined,
    '--transport-room': `${Math.max(0, replayDockWidth - 16) / chromeScale}px`,
  } as React.CSSProperties;

  // When Auto changes, the transport grows from the bottom center of its available room.
  useZoomTransition(transportZoomRef, chromeScale, 'center bottom');

  const fixedSceneRect = useMemo(
    () => (isFixedLayout ? scaleRect(fixedScene, fixedStretchScale) : null),
    [isFixedLayout, fixedScene, fixedStretchScale],
  );
  // The part of the scene the sidebars leave visible, in frame pixels: what the scene's
  // centered overlays (the boss bar's default slot) center on, as the scene's own offset keeps
  // the player centered there.
  const visibleSceneRect = useMemo(() => {
    const scene = fixedSceneRect ?? { x: 0, y: 0, width: size.width, height: size.height };
    const left = Math.max(scene.x, effectiveViewportInsets?.left ?? 0);
    const right = Math.min(scene.x + scene.width, size.width - (effectiveViewportInsets?.right ?? 0));
    return right > left ? { ...scene, x: left, width: right - left } : scene;
  }, [fixedSceneRect, size.width, size.height, effectiveViewportInsets]);
  // Reported in window pixels through the frame's measured placement, not measured again.
  useEffect(() => {
    if (!onVisibleSceneRectChange) return;
    onVisibleSceneRectChange({
      x: framePlacement.x + visibleSceneRect.x * framePlacement.scaleX,
      y: framePlacement.y + visibleSceneRect.y * framePlacement.scaleY,
      width: visibleSceneRect.width * framePlacement.scaleX,
      height: visibleSceneRect.height * framePlacement.scaleY,
    });
  }, [onVisibleSceneRectChange, visibleSceneRect, framePlacement]);
  // One rectangle for rendering and scene-owned presentation. The latter sits
  // above client chrome without promoting the renderer over interactive panels.
  const sceneViewportStyle: React.CSSProperties = {
    position: 'absolute',
    top: fixedSceneRect ? fixedSceneRect.y : 0,
    left: fixedSceneRect ? fixedSceneRect.x : 0,
    width: fixedSceneRect ? fixedSceneRect.width : '100%',
    height: fixedSceneRect ? fixedSceneRect.height : '100%',
    // Fixed is pinned to the stone frame; resizable scenes retain their sidebar shift.
    transform: !fixedSceneRect && viewportOffsetX ? `translateX(${viewportOffsetX}px)` : undefined,
    transition: layoutTransition('transform'),
    willChange: !fixedSceneRect && viewportOffsetX ? 'transform' : undefined,
  };
  const fixedFrameChrome = useMemo(
    () =>
      isFixedLayout
        ? {
            // The top edge and the corner abut at x=717 and together span the frame's full
            // width, so they compose as ONE strip rather than two boxes that round apart.
            topStrip: scaleRect(
              { x: 0, y: 0, width: FIXED_FRAME.width, height: FIXED_FRAME_EDGE_TOP.height },
              fixedStretchScale,
            ),
            // Runs the scene's height, which is the cache's 334 only when the
            // chatbox is shown — see FIXED_FRAME_EDGE_LEFT for why.
            edgeLeft: scaleRect({ ...FIXED_FRAME_EDGE_LEFT, height: fixedScene.height }, fixedStretchScale),
          }
        : null,
    [isFixedLayout, fixedScene, fixedStretchScale],
  );
  // The minimap and side panel are pinned to the frame, so a sidebar sliding
  // over them must not push them off their cache coordinates. Movable overlays
  // keep receiving exclusions as usual.
  const pinnedExclusionRects = useMemo(
    () => (isFixedLayout || isMobileLayout ? [] : undefined),
    [isFixedLayout, isMobileLayout],
  );

  // Fixed pins the minimap block and the side column to the frame, so their
  // positions are COMPUTED rather than read from settings — the user's dragged
  // positions are left untouched and come back with the resizable layouts.
  //
  // The two are halves of ONE stone strip: the block runs from the frame's top
  // edge to the upper tab row and the column takes the rest, both flush with the
  // frame's right edge, so together they cover the full height with no seam.
  //
  // Both sit flush in the frame's corners — the strip spans the frame's whole
  // right edge and runs to its bottom — so every offset here is zero and none of
  // them can land on a fraction. `pinned fixed-mode containers` in
  // osrsClientLayout.test.ts is what keeps that true. The panels take their SIZE
  // from the same frame-space rects through `physicalSize`.
  const fixedMinimapPosition = useMemo(
    () => (isFixedLayout ? { x: 0, y: 0, anchorX: 'right' as const, anchorY: 'top' as const } : null),
    [isFixedLayout],
  );
  const fixedGamePanelPosition = useMemo(
    () => (isFixedLayout ? { x: 0, y: 0, anchorX: 'right' as const, anchorY: 'bottom' as const } : null),
    [isFixedLayout],
  );

  const allExclusionRects = useMemo(() => {
    const rects: Array<{ left: number; top: number; right: number; bottom: number }> = [];
    if (effectiveViewportInsets && effectiveViewportInsets.left > 0) {
      rects.push({ left: 0, top: 0, right: effectiveViewportInsets.left, bottom: size.height });
    }
    if (effectiveViewportInsets && effectiveViewportInsets.right > 0) {
      rects.push({
        left: size.width - effectiveViewportInsets.right,
        top: 0,
        right: size.width,
        bottom: size.height,
      });
    }
    return rects;
  }, [effectiveViewportInsets, size.width, size.height]);

  const webglRenderer = useMemo(() => createPicoGLRenderer(), []);
  const canvas2DRenderer = useMemo(() => createCanvas2DRenderer(), []);
  const defaultCamera = encounterDefaultCamera(encounterKind, simulationState.mechanicsConfig);
  const sceneBuilderLifecycleKey = getSceneBuilderLifecycleKey(encounterKind, sceneLoadId);
  const sceneBuilder = useMemo(() => {
    const builderEncounterKind = sceneBuilderLifecycleKey.slice(
      0,
      sceneBuilderLifecycleKey.lastIndexOf(SCENE_BUILDER_LIFECYCLE_DELIMITER),
    );
    return createSceneBuilderForKind(builderEncounterKind, {
      cacheManager,
      eventAudioPlayer,
      frameSoundTracker,
      encounterRenderConfig,
    });
  }, [sceneBuilderLifecycleKey, cacheManager, eventAudioPlayer, frameSoundTracker, encounterRenderConfig]);

  const projection3DRef = useRef<Projection3D>(
    createProjection3D(
      { width: size.width, height: size.height, dpr: 1 },
      {
        pitch: defaultCamera.pitch,
        yaw: defaultCamera.yaw,
        fovScale: defaultCamera.zoom ?? OSRS_DEFAULT_FOV_SCALE,
        targetX: simulationState.playerPosition[0] + 0.5,
        targetY: simulationState.playerPosition[1] + 0.5,
      },
    ),
  );
  // The displayed encounter's footprint: its arena block bounds the Debug view, 3D picking and the
  // minimap. Resolved once per descriptor, so the blocks keep their identity across renders.
  const mapFootprint = getEncounterMapFootprint(encounterKind);
  const arenaBlock = mapFootprint?.arenaBlock;
  useEffect(() => {
    projection3DRef.current.setPickableMapSquareBlock(arenaBlock);
  }, [arenaBlock]);

  const getReplayViewportState = useCallback((): ReplayViewportState | undefined => {
    if (rendererType !== 'webgl') return undefined;
    return replayViewportStateOf(projection3DRef.current);
  }, [rendererType]);

  useEffect(() => {
    onReplayViewportStateGetterChange?.(getReplayViewportState);
    return () => onReplayViewportStateGetterChange?.(null);
  }, [getReplayViewportState, onReplayViewportStateGetterChange]);

  const is3D = rendererType === 'webgl';
  // The VISIBLE scene, not the canvas box: the canvas slides sideways to keep the player centered
  // behind an open drawer, and a notice belongs in the UI area the player can see. Taking the
  // rectangle plainly also leaves the renderer's transform animation and `will-change` behind,
  // both of which are LCD-text vetoes over text this layer has to be read
  // (docs/agent-reference.md, LCD text).
  const renderStatusRect: React.CSSProperties = {
    top: visibleSceneRect.y,
    left: visibleSceneRect.x,
    width: visibleSceneRect.width,
    height: visibleSceneRect.height,
  };
  // Measured, never guessed from the device or a media query: this is the box the notice is laid
  // out in, and a tall one takes the banner form rather than a card lost in the middle.
  const renderStatusPortrait = visibleSceneRect.height > visibleSceneRect.width;
  const displayedPrayers = prayerPresentation ?? committedPrayerPresentation(simulationState);
  const displayedRunEnabled = inputPresentation?.runEnabled ?? simulationState.isRunEnabled;
  const displayedSpecialAttackActive =
    inputPresentation?.specialAttackActive ??
    simulationState.pendingSpecialAttackActive ??
    simulationState.isSpecialAttackActive;
  const displayedPendingSpecialAttackToggles =
    inputPresentation?.specialAttackActive === undefined && simulationState.pendingSpecialAttackActive === undefined
      ? simulationState.pendingSpecialAttackToggles
      : 0;
  const displayedAttackStyleIndex =
    inputPresentation?.selectedAttackStyleIndex ?? simulationState.selectedAttackStyleIndex;
  const displayedSelectedSpell =
    inputPresentation?.selectedSpell !== undefined
      ? inputPresentation.selectedSpell
      : simulationState.playerCombatSupplies.selectedSpell;
  const getLiveTargetTile = inputPresentation?.getTargetTile;
  const getStartPositionPreparation = inputPresentation?.getStartPositionPreparation;

  const minimapRef = useRef<MinimapHandle>(null);
  const [cameraKeybinds, setCameraKeybinds] = useState<CameraKeybindMap>(DEFAULT_CAMERA_KEYBINDS);

  const previousEncounterKindRef = useRef(encounterKind);
  const openingCameraRef = useRef(defaultCamera);
  // Present only while the live engine is one adopted from a replay (Take Over), which its next
  // fresh run replaces (GridProviders).
  const restoredBoundary = simulationContext?.restoredPresentation !== undefined;
  useEffect(() => {
    // The run's setup is the new encounter's here: the kind and mechanics arrive in one snapshot.
    const cam = encounterDefaultCamera(encounterKind, simulationState.mechanicsConfig);
    const kindChanged = previousEncounterKindRef.current !== encounterKind;
    // Within one encounter the player's camera carries over restarts, unless the new run opens on a
    // different view (a restart into or out of the Inferno's wave 1 or 69). Only an unstarted live run
    // counts: a setting changed mid-fight applies from the next attempt, and a replay owns its view.
    const openingViewChanged =
      !replaying &&
      simulationState.currentTick === SIMULATION_START_TICK &&
      !sameCameraConfig(openingCameraRef.current, cam);
    if (!kindChanged && !openingViewChanged) {
      return;
    }
    previousEncounterKindRef.current = encounterKind;
    openingCameraRef.current = cam;
    // A taken-over replay's tick 0 is a restored boundary, not a fresh opening: it keeps the camera
    // the replay left, which then carries over that run's retries like any other.
    if (!kindChanged && restoredBoundary) return;

    // The viewport leaves freeform itself on a scene load; a restart only re-aims the orbit view.
    if (kindChanged) projection3DRef.current.setCameraMode('orbit');
    // A cutscene from the run this one replaced (a Retry Wave during the wave 68 to 69 intro) would
    // swallow the new opening view: the projection freezes yaw, pitch and zoom under a script. That
    // script is obsolete; the viewport's next frame re-applies one only if the new run has its own.
    projection3DRef.current.setScriptedCamera(null);
    projection3DRef.current.updateCamera({
      pitch: cam.pitch,
      yaw: cam.yaw,
      fovScale: cam.zoom ?? OSRS_DEFAULT_FOV_SCALE,
      targetX: simulationState.playerPosition[0] + 0.5,
      targetY: simulationState.playerPosition[1] + 0.5,
      targetZ: projection3DRef.current.getFollowHeight(),
    });
    minimapRef.current?.setCameraYaw(cam.yaw);
  }, [
    encounterKind,
    replaying,
    restoredBoundary,
    simulationState.currentTick,
    simulationState.mechanicsConfig,
    simulationState.playerPosition,
  ]);

  useEffect(() => {
    projection3DRef.current.setCameraLimits({
      relaxPitch: cameraPluginEnabled && cameraVerticalCamera,
      innerZoomLimit: innerZoomLimitForLevel(cameraPluginEnabled ? cameraInnerZoomLevel : INNER_ZOOM_LEVEL_MIN),
      outerZoomAdjust: cameraPluginEnabled ? cameraOuterZoomLimit : 0,
    });
  }, [cameraInnerZoomLevel, cameraOuterZoomLimit, cameraPluginEnabled, cameraVerticalCamera]);

  const handleCameraChange = useCallback(
    (state: OrbitCameraState) => {
      minimapRef.current?.setCameraYaw(state.yaw);
      onReplayViewportSample?.(performance.now(), replayViewportStateOf(projection3DRef.current));
    },
    [onReplayViewportSample],
  );

  // Compass click → snap camera yaw to 0 (camera south of target, looking north).
  // Matches OSRS "Look North" compass behavior.
  const handleCompassClick = useCallback(() => {
    projection3DRef.current.updateCamera({ yaw: 0 });
    minimapRef.current?.setCameraYaw(0);
  }, []);

  const primaryNpcActorId = simulationState.npcs.find((n) => n.role === 'boss')?.id ?? simulationState.npcs[0]?.id;
  const primaryNpcTypeId =
    simulationState.npcs.find((n) => n.role === 'boss')?.npcTypeId ?? simulationState.npcs[0]?.npcTypeId;
  const hasPrimaryNpc = primaryNpcTypeId !== undefined;

  const resolveNpcActor = useCallback(
    (rawActorId: string): { actorId: string; npcTypeId: number; position: Coordinate } | null => {
      const simNpc =
        rawActorId === 'primary-npc'
          ? simulationState.npcs.find((n) => n.role === 'boss')
          : simulationState.npcs.find((n) => n.id === rawActorId);
      if (simNpc) {
        // A not-yet-targetable NPC is see-through: no hover, no left-click attack, no menu entry.
        if (!isNpcTargetable(simNpc, simulationState.currentTick)) return null;
        return { actorId: simNpc.id, npcTypeId: simNpc.npcTypeId, position: simNpc.position };
      }
      const lobbyBoss = LOBBY_BOSS_BY_ACTOR_ID[rawActorId];
      if (lobbyBoss) {
        return { actorId: rawActorId, npcTypeId: lobbyBoss.npcTypeId, position: lobbyBoss.position };
      }
      return null;
    },
    [simulationState.npcs, simulationState.currentTick],
  );

  const npcHidingPlugins = useMemo(() => ({ entityHider, tzhaarHpTracker }), [entityHider, tzhaarHpTracker]);

  // Unified NPC pick used by hover, left-click, and right-click. Iterates every
  // live NPC instance and runs the OSRS-faithful per-face narrowphase on its
  // animated pose - no primary-NPC singleton path, no idle-pose broadphase.
  // Returns every NPC under the cursor, nearest first, so the right-click menu can
  // list stacked NPCs and hover / left-click can skip the op-less ones.
  const pickNpcs = useCallback(
    (ray: Ray3D, screenPx: { x: number; y: number }): PickedNpc[] => {
      const entries = sceneBuilder.getAllNpcHitTestData?.() ?? [];
      if (entries.length === 0) {
        // Model not yet loaded - coarse tile AABB fallback for the primary NPC. The scene also
        // leaves out the clickbox of a model a hiding plugin keeps undrawn, so the same verdict
        // keeps a hidden boss out of this fallback.
        if (hasPrimaryNpc && rayHitsNpc(ray, simulationState.primaryNpcPosition, simulationState.primaryNpcSize)) {
          const boss = simulationState.npcs.find((n) => n.role === 'boss') ?? simulationState.npcs[0];
          if (boss && !isNpcModelHidden(boss, npcHidingPlugins, PLAYER_ACTOR_ID)) {
            return [{ actorId: boss.id, npcTypeId: boss.npcTypeId, position: boss.position, distance: 0 }];
          }
        }
        return [];
      }
      const proj3D = projection3DRef.current;
      return pickNpcsAtScreen(
        screenPx,
        ray,
        entries,
        proj3D.getViewMatrix(),
        proj3D.getProjectionMatrix(),
        proj3D.viewport.width,
        proj3D.viewport.height,
        resolveNpcActor,
      );
    },
    [
      sceneBuilder,
      hasPrimaryNpc,
      simulationState.primaryNpcPosition,
      simulationState.primaryNpcSize,
      simulationState.npcs,
      npcHidingPlugins,
      resolveNpcActor,
    ],
  );

  // The pile under the cursor, or null. Every model in a pile reports the tile's
  // most valuable obj — the client gives an obj stack a single clickbox and takes
  // its top obj — so this resolves to one pile, not one per model drawn.
  const pickGroundItem = useCallback(
    (screenPx: { x: number; y: number }): GroundItem | null => {
      const entries = sceneBuilder.getAllGroundItemHitTestData?.() ?? [];
      if (entries.length === 0) return null;
      const proj3D = projection3DRef.current;
      const hits = pickGroundItemsAtScreen(
        screenPx,
        entries,
        proj3D.getViewMatrix(),
        proj3D.getProjectionMatrix(),
        proj3D.viewport.width,
        proj3D.viewport.height,
      );
      for (const hit of hits) {
        const pile = simulationState.groundItems.find((item) => item.id === hit.groundItemId);
        if (pile) return pile;
      }
      return null;
    },
    [sceneBuilder, simulationState.groundItems],
  );

  const pickGroundItems = useCallback(
    (screenPx: { x: number; y: number }): GroundItemMenuItem[] => {
      const pile = pickGroundItem(screenPx);
      return pile ? [{ groundItemId: pile.id, itemId: pile.itemId }] : [];
    },
    [pickGroundItem],
  );

  const resolveGroundItemMenuItems = useCallback(
    (tile: Coordinate | null, screenPx?: { x: number; y: number }): GroundItemMenuItem[] => {
      const hasModels = (sceneBuilder.getAllGroundItemHitTestData?.().length ?? 0) > 0;
      // A hit names the tile, not one obj: the menu then lists everything lying on
      // that tile, the way the client lists every obj in the stack it clicked.
      // Without baked models (2D viewport, or a scene still loading) the hovered
      // tile stands in for the pick.
      const menuTile = hasModels ? (screenPx ? (pickGroundItem(screenPx)?.position ?? null) : null) : tile;
      if (!menuTile) return [];
      return groundItemsAtTile(simulationState.groundItems, menuTile).map((item) => ({
        groundItemId: item.id,
        itemId: item.itemId,
      }));
    },
    [pickGroundItem, sceneBuilder, simulationState.groundItems],
  );

  const activeMenuSwaps = useMemo(
    () => (customMenuSwapsEnabled ? parseCustomMenuSwaps(customMenuSwaps) : []),
    [customMenuSwapsEnabled, customMenuSwaps],
  );

  // Read through a ref: hover is re-resolved every frame and the menu when it opens, so both see
  // the current tick's NPCs without rebuilding the entity context on every tick.
  const latestNpcsRef = useRef(simulationState.npcs);
  latestNpcsRef.current = simulationState.npcs;
  const npcMenuColor = useMemo(() => {
    const highlightColor =
      showNpcHighlights && npcHighlightColorMenuEntries
        ? (npcTypeId: number) => getNpcHighlightMenuColor(npcHighlights, npcTypeId)
        : undefined;
    const tzhaarRecolor = tzhaarHpTracker?.recolorMenu ? tzhaarHpTracker : null;
    if (!highlightColor && !tzhaarRecolor) return undefined;
    // TzHaar HP Tracker's alive/dead color wins over a highlight tag's: it is the NPC's live state.
    return (npcTypeId: number, actorId?: string) => {
      if (tzhaarRecolor && actorId !== undefined) {
        const npc = latestNpcsRef.current.find((candidate) => candidate.id === actorId);
        const color = npc ? tzhaarMenuColor(npc, tzhaarRecolor) : undefined;
        if (color) return color;
      }
      return highlightColor?.(npcTypeId);
    };
  }, [showNpcHighlights, npcHighlightColorMenuEntries, npcHighlights, tzhaarHpTracker]);

  // Hover, left click and the right-click menu must offer exactly the scenery the
  // renderer draws: resolving mapLocs through the encounter's own render filter keeps
  // excluded statics (e.g. Zuk's Ancestral Glyph, which the wave respawns as an NPC)
  // from being phantom tooltip/menu targets, and gives replaced locs their packet-final
  // footprint. Without locModelLoader the renderer loads no locs at all, so interaction
  // offers none either. Pillars Inferno or Colosseum Additions hides are left out the same way.
  const renderedLocs = useMemo(() => {
    if (!mapLocs || !locModelLoader) return undefined;
    return resolveEffectiveLocs(mapLocs, resolveEncounterLocRenderOptions(encounterRenderConfig), locModelLoader);
  }, [mapLocs, locModelLoader, encounterRenderConfig]);
  const hiddenPillars = hiddenPillarLocIds(pillarAdditions);
  const interactionLocs = useMemo(
    () =>
      hiddenPillars.size === 0 ? renderedLocs : renderedLocs?.filter(({ location }) => !hiddenPillars.has(location.id)),
    [renderedLocs, hiddenPillars],
  );

  const entityContext = useMemo(
    (): ViewportEntityContext => ({
      npcPosition: hasPrimaryNpc ? simulationState.primaryNpcPosition : undefined,
      npcSize: hasPrimaryNpc ? simulationState.primaryNpcSize : undefined,
      npcTypeLoader,
      npcId: primaryNpcTypeId,
      npcActorId: primaryNpcActorId,
      locs: interactionLocs,
      pickNpcs,
      attackTargetActorId: simulationState.attackTarget,
      pickGroundItems,
      objTypeLoader,
      npcMenuColor,
    }),
    [
      hasPrimaryNpc,
      simulationState.primaryNpcPosition,
      simulationState.primaryNpcSize,
      npcTypeLoader,
      primaryNpcTypeId,
      primaryNpcActorId,
      interactionLocs,
      pickNpcs,
      simulationState.attackTarget,
      pickGroundItems,
      objTypeLoader,
      npcMenuColor,
    ],
  );

  const hoveredNpcActorIdRef = useRef<string | null>(null);
  const handleHoveredNpcChange = useCallback((actorId: string | null) => {
    hoveredNpcActorIdRef.current = actorId;
  }, []);

  const wrappedOnTileClick = useCallback(
    (coord: Coordinate, ctrlKey?: boolean, actorIdOverride?: string | null) => {
      if (getModifiers().shift) {
        onTileClick(coord, ctrlKey, null);
      } else {
        onTileClick(coord, ctrlKey, actorIdOverride !== undefined ? actorIdOverride : hoveredNpcActorIdRef.current);
      }
    },
    [onTileClick],
  );

  const handleNpcAction = useCallback(
    (coord: Coordinate) => {
      onTileClick(coord, getModifiers().ctrl, primaryNpcActorId ?? null);
    },
    [onTileClick, primaryNpcActorId],
  );

  const handleNpcAttackByTarget = useCallback(
    (actorId: string, position: Coordinate) => {
      onTileClick(position, getModifiers().ctrl, actorId);
    },
    [onTileClick],
  );

  const handleVoidClick = useCallback(
    (screenPx: { x: number; y: number }, ctrlKey: boolean): boolean => {
      if (getModifiers().shift) return false;

      const ray = projection3DRef.current.screenToRay(screenPx);
      if (!ray) return false;

      // Custom Menu Swaps outranks the built-in priority below: the promoted entry IS
      // the left click, exactly as the top of the right-click menu shows it. A promoted
      // "Walk here" falls through instead of running its own handler, so the viewport
      // still walks with the yellow click marker rather than this path's red one.
      if (activeMenuSwaps.length > 0) {
        const tile = projection3DRef.current.screenToTile(screenPx);
        // Swapped left clicks use the initiating pointer's Ctrl flag, not a later menu selection.
        const groundItems = onTakeGroundItem
          ? resolveGroundItemMenuItems(tile ? [tile.x, tile.y] : null, screenPx)
          : [];
        const swapped = resolveViewportLeftClickSwap({
          tile: tile ? [tile.x, tile.y] : null,
          onTileClick: (coord) => wrappedOnTileClick(coord, ctrlKey),
          entityContext,
          ray,
          screenPx,
          onNpcAction: (coord) => onTileClick(coord, ctrlKey, primaryNpcActorId ?? null),
          onNpcAttackByTarget: (actorId, position) => onTileClick(position, ctrlKey, actorId),
          groundItemContext:
            onTakeGroundItem && groundItems.length > 0
              ? { items: groundItems, objTypeLoader, onTake: onTakeGroundItem }
              : undefined,
          customMenuSwaps: activeMenuSwaps,
        });
        if (swapped) {
          if (swapped.kind === 'walk') {
            hoveredNpcActorIdRef.current = null;
            return false;
          }
          swapped.entry.onClick?.();
          return true;
        }
      }

      const resolved = resolveInteractiveNpcPick(pickNpcs(ray, screenPx), npcTypeLoader);
      if (resolved) {
        if (resolved.npcType && isNpcAttackable(resolved.npcType)) {
          wrappedOnTileClick(resolved.picked.position, ctrlKey, resolved.picked.actorId);
          return true;
        }
        // The NPC heading the menu offers no attack (or its type failed to load): do
        // not attack. Clear the hovered actor so the fall-through tile walk does not
        // route through it, and let the viewport perform an ordinary click.
        hoveredNpcActorIdRef.current = null;
        return false;
      }

      if (onTakeGroundItem) {
        const groundItemHit = pickGroundItems(screenPx)[0];
        if (groundItemHit) {
          onTakeGroundItem(groundItemHit.groundItemId);
          return true;
        }
      }

      if (entityContext.locs && entityContext.locs.length > 0) {
        const result = rayFindInteractiveLocWithCoord(ray, entityContext.locs);
        if (result) {
          wrappedOnTileClick(result.coord, ctrlKey);
          return true;
        }
      }

      return false;
    },
    [
      activeMenuSwaps,
      entityContext,
      npcTypeLoader,
      objTypeLoader,
      onTakeGroundItem,
      onTileClick,
      pickGroundItems,
      pickNpcs,
      primaryNpcActorId,
      resolveGroundItemMenuItems,
      wrappedOnTileClick,
    ],
  );

  const getTileMarker = useCallback(
    (tile: Coordinate): TileMarker | undefined => {
      return tileMarkers.find((marker) => marker.x === tile[0] && marker.y === tile[1]);
    },
    [tileMarkers],
  );

  const [colorPickerState, setColorPickerState] = useState<{
    tile: Coordinate;
    anchor: { x: number; y: number };
    initialColor: string;
    initialOpacity: number;
    initialFillOpacity: number;
  } | null>(null);

  const handleOpenTileColorPicker = useCallback(
    (tile: Coordinate, clientX: number, clientY: number) => {
      const marker = getTileMarker(tile);
      setColorPickerState({
        tile,
        anchor: { x: clientX + 6, y: clientY + 6 },
        initialColor: marker?.color ?? tileMarkerLastColor,
        initialOpacity: marker?.opacity ?? tileMarkerLastOpacity,
        initialFillOpacity: marker?.fillOpacity ?? 0,
      });
    },
    [getTileMarker, tileMarkerLastColor, tileMarkerLastOpacity],
  );

  const handleApplyTileColor = useCallback(
    (color: string, opacity: number, fillOpacity: number) => {
      if (!colorPickerState || !onUpdateTileColor) {
        setColorPickerState(null);
        return;
      }
      onUpdateTileColor(colorPickerState.tile, color, opacity, fillOpacity);
      setColorPickerState(null);
    },
    [colorPickerState, onUpdateTileColor],
  );

  const findLineByEdge = useCallback(
    (ref: TileEdgeRef): LineMarker | undefined => {
      const seg =
        ref.edge === 'south'
          ? { x: ref.x, y: ref.y, orientation: 'horizontal' as const }
          : ref.edge === 'north'
            ? { x: ref.x, y: ref.y + 1, orientation: 'horizontal' as const }
            : ref.edge === 'west'
              ? { x: ref.x, y: ref.y, orientation: 'vertical' as const }
              : { x: ref.x + 1, y: ref.y, orientation: 'vertical' as const };
      return lineMarkers.find((l) => l.x === seg.x && l.y === seg.y && l.orientation === seg.orientation);
    },
    [lineMarkers],
  );

  const [lineColorPickerState, setLineColorPickerState] = useState<{
    ref: TileEdgeRef;
    anchor: { x: number; y: number };
    initialColor: string;
    initialOpacity: number;
  } | null>(null);

  const handleOpenLineColorPicker = useCallback(
    (ref: TileEdgeRef, clientX: number, clientY: number) => {
      const line = findLineByEdge(ref);
      setLineColorPickerState({
        ref,
        anchor: { x: clientX + 6, y: clientY + 6 },
        initialColor: line?.color ?? tileMarkerLastColor,
        initialOpacity: line?.opacity ?? tileMarkerLastOpacity,
      });
    },
    [findLineByEdge, tileMarkerLastColor, tileMarkerLastOpacity],
  );

  const handleApplyLineColor = useCallback(
    (color: string, opacity: number) => {
      if (!lineColorPickerState || !onUpdateLineColor) {
        setLineColorPickerState(null);
        return;
      }
      onUpdateLineColor(lineColorPickerState.ref, color, opacity);
      setLineColorPickerState(null);
    },
    [lineColorPickerState, onUpdateLineColor],
  );

  const handleCloseLineColorPicker = useCallback(() => {
    setLineColorPickerState(null);
  }, []);

  const handleCloseTileColorPicker = useCallback(() => {
    setColorPickerState(null);
  }, []);

  const [invTagPickerState, setInvTagPickerState] = useState<{
    itemId: number;
    initialColor?: string;
    anchor: { x: number; y: number };
  } | null>(null);

  // Pickers opened from a menu that has already closed open near the center of the window the
  // sidebars leave visible, not under one of them.
  const uncoveredWindowCentre = useCallback(
    () => ({ x: uncoveredCentreX(window.innerWidth, uiInsets), y: window.innerHeight / 2 }),
    [uiInsets],
  );

  const handleOpenInvTagColorPicker = useCallback(
    (itemId: number, initialColor?: string) => {
      setInvTagPickerState({ itemId, initialColor, anchor: uncoveredWindowCentre() });
    },
    [uncoveredWindowCentre],
  );

  const handleApplyInvTagColor = useCallback(
    (color: string, _opacity: number) => {
      if (!invTagPickerState || !onTagItem) {
        setInvTagPickerState(null);
        return;
      }
      onTagItem(invTagPickerState.itemId, color);
      setInvTagPickerState(null);
    },
    [invTagPickerState, onTagItem],
  );

  const handleCloseInvTagColorPicker = useCallback(() => {
    setInvTagPickerState(null);
  }, []);

  const [npcTagPickerState, setNpcTagPickerState] = useState<{
    npcName: string;
    npcTypeId: number;
    mode: NpcHighlightMode;
    modeLabel: string;
    initialColor: string;
    anchor: { x: number; y: number };
  } | null>(null);

  const handleOpenNpcTagColorPicker = useCallback(
    (npcName: string, npcTypeId: number, mode: NpcHighlightMode, currentColor: string) => {
      const modeLabel = mode === 'trueTile' ? 'True Tile' : mode === 'swTile' ? 'SW Tile' : 'Clickbox';
      setNpcTagPickerState({
        npcName,
        npcTypeId,
        mode,
        modeLabel,
        initialColor: currentColor,
        anchor: uncoveredWindowCentre(),
      });
    },
    [uncoveredWindowCentre],
  );

  const handleApplyNpcTagColor = useCallback(
    (color: string, _opacity: number) => {
      if (!npcTagPickerState || !onSetNpcHighlightColor) {
        setNpcTagPickerState(null);
        return;
      }
      onSetNpcHighlightColor(npcTagPickerState.npcName, npcTagPickerState.npcTypeId, npcTagPickerState.mode, color);
      setNpcTagPickerState(null);
    },
    [npcTagPickerState, onSetNpcHighlightColor],
  );

  const handleCloseNpcTagColorPicker = useCallback(() => {
    setNpcTagPickerState(null);
  }, []);

  const [labelEditorState, setLabelEditorState] = useState<{
    tile: Coordinate;
    anchor: { x: number; y: number };
    initialLabel: string | undefined;
  } | null>(null);

  const handleLabelTile = useCallback(
    (tile: Coordinate, clientX: number, clientY: number) => {
      const marker = getTileMarker(tile);
      setLabelEditorState({
        tile,
        anchor: { x: clientX + 6, y: clientY + 6 },
        initialLabel: marker?.label,
      });
    },
    [getTileMarker],
  );

  const handleApplyMarkerLabel = useCallback(
    (label: string | undefined) => {
      if (!labelEditorState || !onUpdateMarkerLabel) {
        setLabelEditorState(null);
        return;
      }
      onUpdateMarkerLabel(labelEditorState.tile, label);
      setLabelEditorState(null);
    },
    [labelEditorState, onUpdateMarkerLabel],
  );

  const handleCloseLabelEditor = useCallback(() => {
    setLabelEditorState(null);
  }, []);

  const [lineLabelEditorState, setLineLabelEditorState] = useState<{
    ref: TileEdgeRef;
    tile: Coordinate;
    anchor: { x: number; y: number };
    initialLabel: string | undefined;
  } | null>(null);

  const handleLabelLine = useCallback(
    (ref: TileEdgeRef, clientX: number, clientY: number) => {
      const line = findLineByEdge(ref);
      setLineLabelEditorState({
        ref,
        tile: [ref.x, ref.y],
        anchor: { x: clientX + 6, y: clientY + 6 },
        initialLabel: line?.label,
      });
    },
    [findLineByEdge],
  );

  const handleApplyLineLabel = useCallback(
    (label: string | undefined) => {
      if (!lineLabelEditorState || !onUpdateLineLabel) {
        setLineLabelEditorState(null);
        return;
      }
      onUpdateLineLabel(lineLabelEditorState.ref, label);
      setLineLabelEditorState(null);
    },
    [lineLabelEditorState, onUpdateLineLabel],
  );

  const handleCloseLineLabelEditor = useCallback(() => {
    setLineLabelEditorState(null);
  }, []);

  const introCompleteNotifiedRef = useRef(false);
  const introActiveRef = useRef(simulationState.introActive);
  introActiveRef.current = simulationState.introActive;
  const effectiveShowTickCounterOverhead = (showTickCounter ?? true) && (showTickCounterOverhead ?? true);
  const playerOverheadNumbers = useMemo<PlayerOverheadNumbers>(
    () => ({
      tickCounter: effectiveShowTickCounterOverhead
        ? {
            max: tickCounterMax ?? 4,
            fontSize: tickCounterFontSize ?? 24,
            abovePrayerIcon: tickCounterAbovePrayerIcon ?? false,
            offsetX: tickCounterOffsetX ?? 0,
            offsetY: tickCounterOffsetY ?? 0,
            colors: tickCounterColors,
          }
        : null,
      attackCooldown: attackCooldownTicks,
    }),
    [
      effectiveShowTickCounterOverhead,
      tickCounterMax,
      tickCounterFontSize,
      tickCounterAbovePrayerIcon,
      tickCounterOffsetX,
      tickCounterOffsetY,
      tickCounterColors,
      attackCooldownTicks,
    ],
  );
  const effectiveShowTickCounterInfobox = (showTickCounter ?? true) && (showTickCounterInfobox ?? true);

  useEffect(() => {
    if (simulationState.introActive) {
      introCompleteNotifiedRef.current = false;
      sceneBuilder.resetIntroState?.();
    }
  }, [simulationState.introActive, sceneBuilder]);

  useEffect(() => {
    // Without a viewport there is no intro animation to poll for, and leaving
    // the rAF loop running would keep the page busy forever.
    if (!onIntroComplete || rendererType === 'none') {
      return;
    }

    let frameId = 0;
    const checkIntroCompletion = () => {
      if (introActiveRef.current && !introCompleteNotifiedRef.current && sceneBuilder.isIntroAnimationComplete?.()) {
        introCompleteNotifiedRef.current = true;
        onIntroComplete();
      }
      frameId = requestAnimationFrame(checkIntroCompletion);
    };

    frameId = requestAnimationFrame(checkIntroCompletion);
    return () => cancelAnimationFrame(frameId);
  }, [onIntroComplete, rendererType, sceneBuilder]);

  useEffect(() => {
    if (!onIntroTimingGetterChange) return;
    if (rendererType === 'none' || !sceneBuilder.getIntroAnimationRemainingMs) {
      onIntroTimingGetterChange(null);
      return;
    }
    onIntroTimingGetterChange(
      (expectedSpeedMultiplier) => sceneBuilder.getIntroAnimationRemainingMs?.(expectedSpeedMultiplier) ?? null,
    );
    return () => onIntroTimingGetterChange(null);
  }, [onIntroTimingGetterChange, rendererType, sceneBuilder]);

  return (
    <TooltipProvider
      initialScale={uiScale}
      // A replay's scale has to be FORCED, not passed as `initialScale`: that prop is read
      // once by `useState` at mount, and this provider is already mounted when playback
      // starts, so the recorder's scale would never reach the panels — they would keep the
      // viewer's, under a cursor recorded against the recorder's. Forcing also makes the
      // viewer's Alt+wheel inert for the duration, which it must be: resizing mid-playback
      // moves every hit target out from under the recorded cursor.
      // The Stretched Mode plugin being off pins 100% the same way, so Alt+wheel is inert and
      // the user's own scale waits in the provider until the plugin is back on.
      forcedScale={
        isFixedLayout
          ? fixedStretchScale
          : mobileFrame
            ? mobileFrame.scale
            : (replayPresentation?.uiScale ?? (stretchedModePluginEnabled ? undefined : 1))
      }
      onScaleChange={onUiScaleChange}
    >
      <ContextMenuProvider onReplayCursorClick={onReplayCursorClick} isReplaying={replayControls?.isReplaying}>
        <ViewportEntityBridge
          entityContext={entityContext}
          projection3D={projection3DRef.current}
          isLobby={encounterKind === 'lobby'}
          onHoveredNpcChange={handleHoveredNpcChange}
          customMenuSwaps={activeMenuSwaps}
          resolveGroundItemMenuItems={resolveGroundItemMenuItems}
          objTypeLoader={objTypeLoader}
          onTakeGroundItem={onTakeGroundItem}
        >
          {(handleHoveredTileChange, leftClickType) => (
            <ViewportContextMenuBridge
              onTileClick={wrappedOnTileClick}
              onNpcAction={handleNpcAction}
              onNpcAttackByTarget={handleNpcAttackByTarget}
              tileMarkers={tileMarkers}
              showTileMarkers={showTileMarkers}
              onMarkTile={onMarkTile}
              onUnmarkTile={onUnmarkTile}
              onLabelTile={handleLabelTile}
              onColorTile={handleOpenTileColorPicker}
              lineMarkers={lineMarkers}
              showLineMarkers={showLineMarkers}
              onMarkLine={onMarkLine}
              onUnmarkLine={onUnmarkLine}
              onLabelLine={handleLabelLine}
              onColorLine={handleOpenLineColorPicker}
              entityContext={entityContext}
              resolveGroundItemMenuItems={resolveGroundItemMenuItems}
              objTypeLoader={objTypeLoader}
              onTakeGroundItem={onTakeGroundItem}
              npcHighlights={npcHighlights}
              onToggleNpcHighlight={onToggleNpcHighlight}
              onSetNpcHighlightColor={onSetNpcHighlightColor}
              onOpenNpcTagColorPicker={handleOpenNpcTagColorPicker}
              customMenuSwaps={activeMenuSwaps}
              rightClickMovesCamera={is3D && cameraPluginEnabled && cameraRightClickMovesCamera}
              projection3D={projection3DRef.current}
            >
              {(handleViewportContextMenu) => (
                <div
                  ref={containerRef}
                  style={{
                    width: '100%',
                    height: '100%',
                    position: 'relative',
                    overflow: 'hidden',
                    backgroundColor: '#000',
                  }}
                >
                  <div
                    ref={sceneRef}
                    className="scene-viewport"
                    style={{ ...sceneViewportStyle, zIndex: 0 }}
                    /* A browser page translation rewriting text nodes React owns tears the
                       live game HUD down mid-render. The dynamic surfaces opt out; menus,
                       settings and modals stay translatable. */
                    translate="no"
                  >
                    {rendererType === 'none' ? null : is3D ? (
                      // Deliberately unkeyed: the viewport, its canvas and the WebGL context
                      // live for the page and switch scenes in place (see RenderViewport3D).
                      <RenderViewport3D
                        simulationState={simulationState}
                        engine={engine}
                        eventOverrides={eventOverrides}
                        onTileClick={wrappedOnTileClick}
                        showCoordinates={showCoordinates}
                        tileGrid={tileGrid}
                        encounterDebugFlags={encounterDebugFlags}
                        showTileMarkers={showTileMarkers}
                        tileMarkers={tileMarkers}
                        tileIndicatorConfig={tileIndicatorConfig}
                        showNpcHighlights={showNpcHighlights}
                        npcHighlights={npcHighlights}
                        showTileMarkerLabels={showTileMarkerLabels}
                        tileMarkerWidth={tileMarkerWidth}
                        showLineMarkers={showLineMarkers}
                        lineMarkers={lineMarkers}
                        showLineMarkerLabels={showLineMarkerLabels}
                        lineMarkerWidth={lineMarkerWidth}
                        smoothTerrain={smoothTerrain}
                        brightness={brightness}
                        contrast={contrast}
                        saturation={saturation}
                        renderScale={renderScale}
                        fpsCap={fpsCap}
                        targetTile={targetTile}
                        getTargetTile={getLiveTargetTile}
                        getStartPositionPreparation={getStartPositionPreparation}
                        renderer={webglRenderer}
                        sceneBuilder={sceneBuilder}
                        mapLoader={mapLoader}
                        underlayLoader={underlayLoader}
                        overlayLoader={overlayLoader}
                        textureLoader={textureLoader}
                        locModelLoader={locModelLoader}
                        npcModelLoader={npcModelLoader}
                        playerModelLoader={playerModelLoader}
                        spotAnimModelLoader={spotAnimModelLoader}
                        playerConfig={playerConfig}
                        animationSystem={animationSystem}
                        mapLocs={mapLocs}
                        encounterRequiresLocs={encounterRequiresLocs}
                        projection3D={projection3DRef.current}
                        cameraKeybinds={cameraKeybinds}
                        width={fixedSceneRect ? fixedSceneRect.width : size.width}
                        height={fixedSceneRect ? fixedSceneRect.height : size.height}
                        logicalHeight={fixedSceneRect ? fixedScene.height : undefined}
                        paintScale={framePaintScale}
                        onCameraChange={handleCameraChange}
                        speedMultiplier={speedMultiplier}
                        playerOverheadNumbers={playerOverheadNumbers}
                        showAttackTimerMetronome={showAttackTimerMetronome}
                        showNpcAttackTimerMetronome={showNpcAttackTimerMetronome}
                        entityHider={entityHider}
                        tzhaarHpTracker={tzhaarHpTracker}
                        pillarAdditions={pillarAdditions}
                        onContextMenu={handleViewportContextMenu}
                        onHoveredTileChange={handleHoveredTileChange}
                        leftClickType={leftClickType}
                        onReplayCursorClick={onReplayCursorClick}
                        replayIsReplaying={replayControls?.isReplaying ?? false}
                        replayPlaying={replayControls?.isPlaying ?? false}
                        replayFrameIndex={replayControls?.replayFrameIndex ?? 0}
                        onVoidClick={handleVoidClick}
                        invertYaw={cameraPluginEnabled && cameraInvertYaw}
                        invertPitch={cameraPluginEnabled && cameraInvertPitch}
                        cameraSpeed={cameraPluginEnabled ? cameraSpeed : 1}
                        dragSpeed={cameraPluginEnabled ? cameraDragSpeed : 1}
                        zoomIncrement={cameraPluginEnabled ? cameraZoomIncrement : 25}
                        replayPaused={replayPaused}
                        replayTimelineKey={replayTimelineKey}
                        onRenderStatusChange={onRenderStatusChange}
                        onSceneReady={() => {
                          const heights = sceneBuilder.getTerrainHeights?.();
                          if (heights) {
                            const px = simulationState.playerPosition[0] + 0.5;
                            const py = simulationState.playerPosition[1] + 0.5;
                            const terrainZ = -getTerrainHeightInterpolated(heights, px, py) / 128;
                            const followHeight = projection3DRef.current.getFollowHeight();
                            projection3DRef.current.updateCamera({ targetZ: terrainZ + followHeight });
                          }
                          onSceneReady?.();
                        }}
                      />
                    ) : (
                      <RenderViewport
                        key={`viewport-2d-${sceneBuilderLifecycleKey}`}
                        simulationState={simulationState}
                        engine={engine}
                        eventOverrides={eventOverrides}
                        onTileClick={wrappedOnTileClick}
                        showCoordinates={showCoordinates}
                        encounterDebugFlags={encounterDebugFlags}
                        showTileMarkers={showTileMarkers}
                        tileMarkers={tileMarkers}
                        tileIndicatorConfig={tileIndicatorConfig}
                        showNpcHighlights={showNpcHighlights}
                        npcHighlights={npcHighlights}
                        showTileMarkerLabels={showTileMarkerLabels}
                        tileMarkerWidth={tileMarkerWidth}
                        showLineMarkers={showLineMarkers}
                        lineMarkers={lineMarkers}
                        showLineMarkerLabels={showLineMarkerLabels}
                        lineMarkerWidth={lineMarkerWidth}
                        renderScale={renderScale}
                        fpsCap={fpsCap}
                        rotation={0}
                        targetTile={targetTile}
                        getTargetTile={getLiveTargetTile}
                        getStartPositionPreparation={getStartPositionPreparation}
                        projectionType="top-down"
                        tileExtent={mapFootprint?.arenaTileExtent}
                        renderer={canvas2DRenderer}
                        sceneBuilder={sceneBuilder}
                        width={fixedSceneRect ? fixedSceneRect.width : size.width}
                        height={fixedSceneRect ? fixedSceneRect.height : size.height}
                        paintScale={framePaintScale}
                        speedMultiplier={speedMultiplier}
                        playerOverheadNumbers={playerOverheadNumbers}
                        showAttackTimerMetronome={showAttackTimerMetronome}
                        showNpcAttackTimerMetronome={showNpcAttackTimerMetronome}
                        entityHider={entityHider}
                        tzhaarHpTracker={tzhaarHpTracker}
                        pillarAdditions={pillarAdditions}
                        leftClickType={leftClickType}
                        onReplayCursorClick={onReplayCursorClick}
                        replayPaused={replayPaused}
                        replayTimelineKey={replayTimelineKey}
                        replayIsReplaying={replayControls?.isReplaying ?? false}
                        onSceneReady={onSceneReady}
                      />
                    )}
                  </div>

                  {is3D && (
                    <ViewportStatusOverlay
                      status={renderStatus}
                      rect={renderStatusRect}
                      portrait={renderStatusPortrait}
                      cornerOccupied={isMobileLayout}
                      heldActivity={graphicsHeldActivity}
                    />
                  )}

                  {sceneOverlay && (
                    <div
                      className="scene-presentation"
                      style={{
                        ...sceneViewportStyle,
                        zIndex: 40,
                        pointerEvents: 'none',
                        ...(graphicsHeld ? { visibility: 'hidden' } : {}),
                      }}
                    >
                      {sceneOverlay}
                    </div>
                  )}

                  <div
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: '100%',
                      pointerEvents: 'none',
                      zIndex: 20,
                    }}
                  >
                    <TooltipOverlay />
                    <ContextMenuOverlay />
                    <SnapGuideOverlay />
                    {replayControls?.isReplaying && replayControls.replayCursorVisible && replayCursorTrack && (
                      <WorkspacePortal surface="cursor">
                        <ReplayCursorLayer
                          track={replayCursorTrack}
                          frameIndex={replayControls.replayFrameIndex}
                          isPlaying={replayControls.isPlaying}
                          speedMultiplier={speedMultiplier}
                          layoutRevision={layoutRevision}
                        />
                      </WorkspacePortal>
                    )}
                    <HintBar insets={effectiveViewportInsets} />
                    <TileMarkerColorPicker
                      isOpen={colorPickerState !== null}
                      anchor={colorPickerState?.anchor ?? null}
                      initialColor={colorPickerState?.initialColor ?? tileMarkerLastColor}
                      initialOpacity={colorPickerState?.initialOpacity ?? tileMarkerLastOpacity}
                      initialFillOpacity={colorPickerState?.initialFillOpacity ?? 0}
                      onApply={handleApplyTileColor}
                      onCancel={handleCloseTileColorPicker}
                      title="Tile Marker Color"
                      subtitle="Outline and fill"
                      showFill
                    />
                    <TileMarkerColorPicker
                      isOpen={invTagPickerState !== null}
                      anchor={invTagPickerState?.anchor ?? null}
                      initialColor={invTagPickerState?.initialColor ?? inventoryTagLastColor ?? '#e24040'}
                      initialOpacity={1}
                      onApply={handleApplyInvTagColor}
                      onCancel={handleCloseInvTagColorPicker}
                      title="Inventory Tag Color"
                      showOpacity={false}
                    />
                    <TileMarkerColorPicker
                      isOpen={npcTagPickerState !== null}
                      anchor={npcTagPickerState?.anchor ?? null}
                      initialColor={npcTagPickerState?.initialColor ?? '#00ffff'}
                      initialOpacity={1}
                      onApply={handleApplyNpcTagColor}
                      onCancel={handleCloseNpcTagColorPicker}
                      title="NPC Tag Color"
                      subtitle={npcTagPickerState?.modeLabel}
                      showOpacity={false}
                    />
                    <TileMarkerLabelEditor
                      isOpen={labelEditorState !== null}
                      tile={labelEditorState?.tile ?? null}
                      anchor={labelEditorState?.anchor ?? null}
                      initialLabel={labelEditorState?.initialLabel}
                      onApply={handleApplyMarkerLabel}
                      onCancel={handleCloseLabelEditor}
                    />
                    <TileMarkerColorPicker
                      isOpen={lineColorPickerState !== null}
                      anchor={lineColorPickerState?.anchor ?? null}
                      initialColor={lineColorPickerState?.initialColor ?? tileMarkerLastColor}
                      initialOpacity={lineColorPickerState?.initialOpacity ?? tileMarkerLastOpacity}
                      onApply={handleApplyLineColor}
                      onCancel={handleCloseLineColorPicker}
                      title="Line Marker Color"
                      subtitle="Line style"
                    />
                    <TileMarkerLabelEditor
                      isOpen={lineLabelEditorState !== null}
                      tile={lineLabelEditorState?.tile ?? null}
                      anchor={lineLabelEditorState?.anchor ?? null}
                      initialLabel={lineLabelEditorState?.initialLabel}
                      onApply={handleApplyLineLabel}
                      onCancel={handleCloseLineLabelEditor}
                    />
                    {viewportMeasured && rendererType !== 'canvas2d' && (
                      <Minimap
                        ref={minimapRef}
                        simulationState={simulationState}
                        initialCameraYaw={projection3DRef.current.getCameraState().yaw}
                        mapLoader={mapLoader}
                        underlayLoader={underlayLoader}
                        overlayLoader={overlayLoader}
                        textureLoader={textureLoader}
                        npcTypeLoader={npcTypeLoader}
                        minimapNpcDotUrl={minimapNpcDotUrl}
                        mapSquare={mapFootprint?.origin}
                        arenaBlock={arenaBlock}
                        speedMultiplier={speedMultiplier}
                        arenaBounds={getArenaBounds()}
                        hasSpecialAttack={weaponHasSpecialAttack(playerEquipment?.weapon, enumTypeLoader)}
                        soulreaperStacks={soulreaperDisplayedStacks(
                          playerEquipment?.weapon,
                          simulationState.soulreaperStacks,
                        )}
                        isQuickPrayerActive={quickPrayersActive}
                        hasPredictedPrayer={displayedPrayers.anyLit}
                        isRunEnabled={displayedRunEnabled}
                        isSpecialAttackActive={displayedSpecialAttackActive}
                        pendingSpecialAttackToggles={displayedPendingSpecialAttackToggles}
                        prayerEnabled={prayerEnabled}
                        prayerFlickOrbEnabled={prayerFlickOrbEnabled}
                        prayerFlickAlwaysOn={prayerFlickAlwaysOn}
                        onQuickPrayerToggle={onQuickPrayerToggle}
                        onQuickPrayerSetup={onQuickPrayerSetup}
                        onRunToggle={onRunToggle}
                        onSpecialAttackToggle={onSpecialAttackToggle}
                        xpDropsEnabled={xpDropsEnabled}
                        onXpDropsToggle={onXpDropsToggle}
                        panelPosition={
                          fixedMinimapPosition ?? (showCompactOrbs ? compactOrbsPosition : minimapPosition)
                        }
                        onPanelPositionChange={showCompactOrbs ? onCompactOrbsPositionChange : onMinimapPositionChange}
                        viewportWidth={size.width}
                        viewportHeight={size.height}
                        exclusionRects={pinnedExclusionRects ?? allExclusionRects}
                        locked={isFixedLayout}
                        fixedLayout={isFixedLayout}
                        mobileContainer={mobileMapContainer}
                        onCompassClick={handleCompassClick}
                        compactOrbs={showCompactOrbs}
                        compactOrbsLayout={compactOrbsLayout}
                        compactOrbsOrder={compactOrbsOrder}
                      />
                    )}

                    {fixedFrameChrome && (
                      <>
                        {/*
                            The window frame, composed at 1:1 and resampled as ONE bitmap each.

                            The top edge and the corner ABUT at x=717, and the left bezel is a
                            REPEAT (a 4x334 sprite down a scene taller than the client's
                            viewport). As three separate boxes — two <img> and a CSS repeat-y —
                            each rounded its own edges and each repetition started on its own
                            subpixel phase, so hairlines opened along the top join and down the
                            bezel at fractional scales. Composed logical-first, both joins are
                            exact integer boundaries between whole source pixels.
                          */}
                        <PixelComposedLayer
                          cacheKey={`fixed-frame-top|${PANEL.fixedWindowFrameEdgeTop}|${PANEL.fixedTopRightCorner}`}
                          width={FIXED_FRAME.width}
                          height={FIXED_FRAME_EDGE_TOP.height}
                          cssSize={fixedFrameChrome.topStrip}
                          sources={[PANEL.fixedWindowFrameEdgeTop, PANEL.fixedTopRightCorner]}
                          draw={(flat, images) => {
                            const edge = images.get(PANEL.fixedWindowFrameEdgeTop);
                            const corner = images.get(PANEL.fixedTopRightCorner);
                            if (edge) {
                              flat.drawImage(
                                edge,
                                FIXED_FRAME_EDGE_TOP.x,
                                FIXED_FRAME_EDGE_TOP.y,
                                FIXED_FRAME_EDGE_TOP.width,
                                FIXED_FRAME_EDGE_TOP.height,
                              );
                            }
                            if (corner) {
                              flat.drawImage(
                                corner,
                                FIXED_TOP_RIGHT_CORNER.x,
                                FIXED_TOP_RIGHT_CORNER.y,
                                FIXED_TOP_RIGHT_CORNER.width,
                                FIXED_TOP_RIGHT_CORNER.height,
                              );
                            }
                          }}
                          style={{
                            left: fixedFrameChrome.topStrip.x,
                            top: fixedFrameChrome.topStrip.y,
                            zIndex: CHROME_LAYER_Z,
                          }}
                        />
                        <PixelComposedLayer
                          cacheKey={`fixed-frame-left|${PANEL.fixedWindowFrameEdgeLeft}|${fixedScene.height}`}
                          width={FIXED_FRAME_EDGE_LEFT.width}
                          height={fixedScene.height}
                          cssSize={fixedFrameChrome.edgeLeft}
                          sources={[PANEL.fixedWindowFrameEdgeLeft]}
                          draw={(flat, images) => {
                            const bezel = images.get(PANEL.fixedWindowFrameEdgeLeft);
                            if (bezel) {
                              tileFill(flat, bezel, 0, 0, FIXED_FRAME_EDGE_LEFT.width, fixedScene.height);
                            }
                          }}
                          style={{
                            left: fixedFrameChrome.edgeLeft.x,
                            top: fixedFrameChrome.edgeLeft.y,
                            zIndex: CHROME_LAYER_Z,
                          }}
                        />
                      </>
                    )}

                    {chatbox && (
                      <GridChatbox
                        rect={chatbox.rect}
                        scale={chatbox.scale}
                        visible={chatboxVisible}
                        transparent={chatboxTransparent && !isFixedLayout}
                        clickThrough={chatboxClickThrough}
                        sceneRef={sceneRef}
                        onToggle={toggleChatbox}
                      />
                    )}

                    {/* With the Mobile tool window (below), Practice and Replay are its own, whatever
                        layout the frame draws. */}
                    {!toolsFrame && replayControls?.isReplaying && (
                      <WorkspacePortal surface="transport">
                        <div className="replay-transport-dock" style={replayDockStyle}>
                          {/* The tour's target, not the bar: see MobileToolWindow's transport. */}
                          <div
                            ref={transportZoomRef}
                            style={chromeZoomStyle(chromeScale)}
                            data-tutorial="replay-controls"
                          >
                            <ReplayControls
                              compact={isNarrowWindow(replayDockWidth / chromeScale)}
                              {...replayControls}
                              replayPractice={replayPractice}
                            />
                          </div>
                        </div>
                      </WorkspacePortal>
                    )}
                    {!toolsFrame && topChrome && (
                      <WorkspacePortal surface="chrome">
                        <TopChrome
                          onRestart={onRestart}
                          frameRef={containerRef}
                          fixed={isFixedLayout}
                          zoom={chromeScale}
                          layoutKey={topChromeLayoutKey}
                          settings={topChrome.settings}
                          elevated={topChrome.elevated}
                          menu={topChrome.menu}
                          plugins={topChrome.plugins}
                          modifiers={topChrome.modifiers}
                          showFps={topChrome.showFps}
                          replaySuppressed={topChrome.replaySuppressed}
                          engine={engine}
                          simulationState={simulationState}
                          dpsProjection={dpsProjection}
                          mechanicsConfig={mechanicsConfig}
                          onMechanicsConfigChange={onMechanicsConfigChange}
                          setupContext={setupContext}
                          mechanicsToggles={mechanicsToggles}
                          debugActions={debugActions}
                          onExecuteEncounterCommand={onExecuteEncounterCommand}
                          exportEncounterGear={exportEncounterGear}
                          onEncounterToolOpenChange={onEncounterToolOpenChange}
                          onSetBossHp={onSetBossHp}
                          onApplyBossHpPreset={onApplyBossHpPreset}
                          replay={topChromeReplay}
                          replayPractice={replayPractice}
                          encounterSession={encounterSession}
                          onRowChange={reportLauncherRow}
                          onPluginsChange={reportPlugins}
                        />
                      </WorkspacePortal>
                    )}
                    {!toolsFrame && (showCameraDebug || showCoordinates) && (
                      // Debug and plugin readouts at the bottom left, on the Chatbox infobox rows or
                      // one gap over the chatbox.
                      <div
                        ref={bottomLeftReadoutsRef}
                        style={{
                          position: 'absolute',
                          left: chatboxInfoboxes?.left ?? HUD_TOOL_GAP,
                          bottom: bottomLeftBottom,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'flex-start',
                          gap: HUD_TOOL_GAP,
                          pointerEvents: 'none',
                          zIndex: HUD_LAYER_Z,
                        }}
                      >
                        {showCameraDebug && projection3DRef.current && (
                          <CameraDebugReadout projection={projection3DRef.current} />
                        )}
                        {showCoordinates && (
                          <div
                            style={{
                              padding: '3px 8px',
                              background: 'rgba(0, 0, 0, 0.78)',
                              border: '1px solid var(--hud-border)',
                              borderRadius: 2,
                              color: '#ffe066',
                              font: '700 14px "RuneScape Bold 12", monospace, sans-serif',
                              letterSpacing: '0.3px',
                              textShadow: '1px 1px 0 #000',
                              userSelect: 'none',
                            }}
                          >
                            {`(${simulationState.playerPosition[0]}, ${simulationState.playerPosition[1]})`}
                          </div>
                        )}
                      </div>
                    )}

                    {viewportMeasured && (
                      <GamePanel
                        simulationState={simulationState}
                        activePrayer={displayedPrayers.protection}
                        boostPrayers={displayedPrayers.boost}
                        independentPrayers={displayedPrayers.independent}
                        prayerVisualOverrides={displayedPrayers.visualOverrides}
                        onPrayerChange={onPrayerChange}
                        onBoostPrayerChange={onBoostPrayerChange}
                        onIndependentPrayerChange={onIndependentPrayerChange}
                        quickPrayerSetupOpen={quickPrayerSetupOpen}
                        quickPrayerSetupRequest={quickPrayerSetupRequest}
                        onCloseQuickPrayerSetup={onCloseQuickPrayerSetup}
                        onQuickPrayerSelectionsReady={onQuickPrayerSelectionsReady}
                        onMarkOfDarknessCast={onMarkOfDarknessCast}
                        onDeathChargeCast={onDeathChargeCast}
                        onHomeTeleportCast={encounterKind !== 'lobby' ? onReturnToLobby : undefined}
                        inventory={inventory}
                        inventoryPreviewResetToken={inventoryPreviewResetToken}
                        equipmentStats={equipmentStats}
                        playerEquipment={playerEquipment}
                        equippedAmmo={equippedAmmo}
                        quiverAmmo={quiverAmmo}
                        prayerState={simulationState.prayerState}
                        onUnequipSlot={onUnequipSlot}
                        onUnequipAmmo={onUnequipAmmo}
                        onEquipmentSlotClick={onEquipmentSlotClick}
                        onEquipFromInventory={onEquipFromInventory}
                        onUseItem={onUseItem}
                        onDropItem={onDropItem}
                        onSwapInventorySlots={onSwapInventorySlots}
                        inventoryTags={inventoryTags}
                        showInventoryTags={showInventoryTags}
                        antiDragEnabled={antiDragEnabled}
                        dragOnShiftOnly={dragOnShiftOnly}
                        antiDragDelay={antiDragDelay}
                        antiDragCtrlToDrag={antiDragCtrlToDrag}
                        onUntagItem={onUntagItem}
                        onPickInventoryTagColor={handleOpenInvTagColorPicker}
                        onCameraKeybindsChange={setCameraKeybinds}
                        weaponId={playerEquipment?.weapon}
                        specialAttackPercent={simulationState.specialAttack?.energy}
                        soulreaperStacks={soulreaperDisplayedStacks(
                          playerEquipment?.weapon,
                          simulationState.soulreaperStacks,
                        )}
                        isSpecialAttackActive={displayedSpecialAttackActive}
                        pendingSpecialAttackToggles={displayedPendingSpecialAttackToggles}
                        onSpecialAttackToggle={onSpecialAttackToggle}
                        hasSpecialAttack={weaponHasSpecialAttack(playerEquipment?.weapon, enumTypeLoader)}
                        quickPrayersActive={quickPrayersActive}
                        onQuickPrayerToggle={onQuickPrayerToggle}
                        onQuickPrayerSetup={onQuickPrayerSetup}
                        isRunEnabled={displayedRunEnabled}
                        onRunToggle={onRunToggle}
                        mobileHotkeys={mobileHotkeys}
                        mobileHotkeysOpenOnLeft={mobileHotkeysOpenOnLeft}
                        selectedAttackStyleIndex={displayedAttackStyleIndex}
                        onAttackStyleChange={onAttackStyleChange}
                        spellbook={simulationState.playerCombatSupplies.spellbook}
                        selectedSpell={displayedSelectedSpell}
                        onSelectedSpellChange={onSelectedSpellChange}
                        armedSpell={armedSpell}
                        onArmSpell={onArmSpell}
                        runeContext={{
                          equipment: simulationState.playerEquipment,
                          inventory: simulationState.inventory,
                          runePouch: simulationState.playerCombatSupplies.runePouch,
                          // Boosted level: a Magic potion lets you cast above base.
                          magicLevel: simulationState.stats.magic.current,
                        }}
                        objTypeLoader={objTypeLoader}
                        enumTypeLoader={enumTypeLoader}
                        structTypeLoader={structTypeLoader}
                        activeTab={activeGamePanelTab}
                        onActiveTabChange={replayControls?.isReplaying ? undefined : onActiveGamePanelTabChange}
                        panelPosition={fixedGamePanelPosition ?? gamePanelPosition}
                        onPanelPositionChange={onGamePanelPositionChange}
                        viewportWidth={size.width}
                        viewportHeight={size.height}
                        exclusionRects={pinnedExclusionRects ?? allExclusionRects}
                        clientLayoutMode={clientLayoutMode}
                        transparentSidePanel={transparentSidePanel}
                        hotkeysCloseSidePanel={hotkeysCloseSidePanel}
                        mobileFrame={mobileFrame ?? undefined}
                        locked={isFixedLayout}
                        statusBarsEnabled={statusBarsEnabled}
                        statusBarsShowValues={statusBarsShowValues}
                        anyPrayerActive={displayedPrayers.anyLit}
                        masterVolume={masterVolume}
                        sfxVolume={sfxVolume}
                        areaVolume={areaVolume}
                        onVolumeChange={onVolumeChange}
                        muteWhenUnfocused={muteWhenUnfocused}
                        onMuteWhenUnfocusedChange={onMuteWhenUnfocusedChange}
                      />
                    )}
                    {mobileHud && (
                      // The mobile client's buff bar, where it puts it: no strip, no pin, no drag.
                      <div
                        style={{
                          position: 'absolute',
                          left: mobileHud.placement.buffBar.x,
                          top: mobileHud.placement.buffBar.y,
                          pointerEvents: 'none',
                          zIndex: HUD_LAYER_Z,
                        }}
                      >
                        <InfoBoxOverlay
                          simulationState={simulationState}
                          osmBuffBarScale={mobileFrame?.scale ?? 1}
                          infoBoxSettings={{
                            showTickCounterInfobox: effectiveShowTickCounterInfobox,
                            tickCounterMax,
                            tickCounterColors,
                            infoboxTextOutlineColor,
                            infoboxTextOutlineEnabled,
                          }}
                        />
                      </div>
                    )}
                    {/* One stable place for the window, so playback, its tab history and the menu host
                        survive a recording's layout coming and going under it. In the window it is
                        viewer chrome: its hints escape the workspace beneath it, as the transport's do. */}
                    <WorkspacePortal surface="transport">
                      <div data-replay-viewer-chrome={toolsInWindow ? '' : undefined}>
                        {toolsFrame && (
                          <MobileToolWindow
                            onRestart={onRestart}
                            frame={toolsFrame}
                            viewport={toolsViewport}
                            sidePanelOnLeft={mobileSide.panelOnLeft}
                            state={mobileTools?.state ?? localMobileToolsState}
                            onStateChange={mobileTools?.onStateChange ?? setLocalMobileToolsState}
                            tutorialTarget={mobileTools?.tutorialTarget ?? null}
                            menuHostRef={mobileTools?.menuHostRef}
                            onOccupiedChange={setMobileToolsRects}
                            zIndex={toolWindowZ}
                            simulationState={simulationState}
                            engine={engine}
                            mechanicsConfig={mechanicsConfig}
                            onMechanicsConfigChange={onMechanicsConfigChange}
                            setupContext={setupContext}
                            mechanicsToggles={mechanicsToggles}
                            debugActions={debugActions}
                            onExecuteEncounterCommand={onExecuteEncounterCommand}
                            exportEncounterGear={exportEncounterGear}
                            onEncounterToolOpenChange={onEncounterToolOpenChange}
                            onSetBossHp={onSetBossHp}
                            onApplyBossHpPreset={onApplyBossHpPreset}
                            replay={replayControls}
                            replayPractice={replayPractice}
                            encounterSession={encounterSession}
                          />
                        )}
                      </div>
                    </WorkspacePortal>
                    {viewportMeasured && !isMobileLayout && (
                      <InfoBoxPanel
                        clientLayoutMode={clientLayoutMode}
                        simulationState={simulationState}
                        infoBoxSettings={{
                          showTickCounterInfobox: effectiveShowTickCounterInfobox,
                          tickCounterMax,
                          tickCounterColors,
                          infoboxTextOutlineColor,
                          infoboxTextOutlineEnabled,
                        }}
                        position={infoboxHudFallback ? null : infoboxPosition}
                        gamePanelPosition={fixedGamePanelPosition ?? gamePanelPosition}
                        pinTarget={displayedInfoboxPinTarget}
                        chatboxAnchor={infoboxesAtChatbox && chatboxInfoboxes ? chatboxInfoboxes : undefined}
                        onPositionChange={infoboxHudFallback ? undefined : onInfoboxPositionChange}
                        viewportWidth={size.width}
                        viewportHeight={size.height}
                        exclusionRects={allExclusionRects}
                      />
                    )}
                    <XpDropOverlay
                      // Mobile draws it at the chrome's own scale, where the client puts it.
                      overlayScale={mobileFrame?.scale ?? effectiveOverlayScale}
                      overlayOuterScale={overlayOuterScale}
                      enabled={xpDropsEnabled}
                      showPredictedHit={xpDropsShowPredictedHit}
                      grouped={xpDropsGrouped}
                      showIcons={xpDropsShowIcons}
                      speed={xpDropsSpeed}
                      position={mobileHud?.xpDrops ?? xpDropsPosition}
                      onPositionChange={mobileHud ? undefined : onXpDropsPositionChange}
                      locked={mobileHud !== null}
                      viewportWidth={size.width}
                      viewportHeight={size.height}
                      exclusionRects={allExclusionRects}
                    />
                    {viewportMeasured && (
                      <BossHealthBarOverlay
                        overlayScale={mobileFrame?.scale ?? effectiveOverlayScale}
                        width={mobileHud ? OSM_HPBAR_WIDTH : undefined}
                        enabled={bossHealthBarEnabled}
                        simulationState={simulationState}
                        showName={bossHealthBarShowName}
                        showValues={bossHealthBarShowValues}
                        showPercentage={bossHealthBarShowPercentage}
                        beta={encounterIsBeta}
                        position={mobileHud?.bossBar ?? bossHealthBarPosition}
                        defaultSlot={
                          mobileHud
                            ? undefined
                            : {
                                scene: visibleSceneRect,
                                row: topChrome && !toolsFrame ? launcherRow : null,
                                // The window chrome's zoom in frame pixels: a frame drawn at half
                                // size needs twice the gap.
                                zoom: chromeScale / Math.min(framePlacement.scaleX, framePlacement.scaleY),
                                chrome: bossBarChrome,
                              }
                        }
                        onPositionChange={mobileHud ? undefined : onBossHealthBarPositionChange}
                        locked={mobileHud !== null}
                        viewportWidth={size.width}
                        viewportHeight={size.height}
                        exclusionRects={allExclusionRects}
                      />
                    )}
                    {viewportMeasured && (
                      <DetailedDpsOverlay
                        overlayScale={effectiveOverlayScale}
                        engine={engine ?? null}
                        dpsProjection={dpsProjection}
                        simulationState={simulationState}
                        visible={showDetailedDps}
                        showDetails={dpsOverlayShowDetails}
                        position={detailedDpsPosition ?? mobileHud?.aid('detailedDps')}
                        onPositionChange={mobileHud && !mobileLayoutEditing ? undefined : onDetailedDpsPositionChange}
                        locked={mobileHud !== null && !mobileLayoutEditing}
                        editDrag={mobileLayoutEditing}
                        onHeightChange={setDetailedDpsHeight}
                        viewportWidth={size.width}
                        viewportHeight={size.height}
                        exclusionRects={mobileHud?.aidExclusions ?? allExclusionRects}
                      />
                    )}
                    {viewportMeasured && (
                      <PrayerFlickOverlay
                        overlayScale={effectiveOverlayScale}
                        enabled={prayerFlickEnabled}
                        position={prayerFlickPosition ?? mobileHud?.aid('prayerFlick')}
                        onPositionChange={mobileHud && !mobileLayoutEditing ? undefined : onPrayerFlickPositionChange}
                        locked={mobileHud !== null && !mobileLayoutEditing}
                        editDrag={mobileLayoutEditing}
                        viewportWidth={size.width}
                        viewportHeight={size.height}
                        exclusionRects={mobileHud?.aidExclusions ?? allExclusionRects}
                      />
                    )}
                    {viewportMeasured && (
                      <ZukSetTimerOverlay
                        overlayScale={effectiveOverlayScale}
                        timer={zukSetTimer?.timer}
                        keybinds={zukSetTimer?.keybinds}
                        currentTick={simulationState.currentTick}
                        actual={
                          zukSetTimer?.showActual
                            ? readActualZukSetCountdown(
                                simulationState.encounter,
                                // Not `=== true`: `undefined` means "no opinion" to this reader,
                                // which is not the same as the toggle being off.
                                typeof simulationState.mechanicsConfig.zukSets === 'boolean'
                                  ? simulationState.mechanicsConfig.zukSets
                                  : undefined,
                              )
                            : undefined
                        }
                        position={zukSetTimerPosition ?? mobileHud?.aid('zukSetTimer')}
                        onPositionChange={mobileHud && !mobileLayoutEditing ? undefined : onZukSetTimerPositionChange}
                        locked={mobileHud !== null && !mobileLayoutEditing}
                        editDrag={mobileLayoutEditing}
                        viewportWidth={size.width}
                        viewportHeight={size.height}
                        exclusionRects={mobileHud?.aidExclusions ?? allExclusionRects}
                      />
                    )}
                    {mobileLayoutEditing && (
                      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: OVERLAP_GUIDE_Z }}>
                        <MobileLayoutEditBar />
                      </div>
                    )}
                    {/* Last in the layer and above the tool window, so hidden edges draw over whatever
                        covers them. Not in playback: the recorded layout is not the viewer's to rearrange. */}
                    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: OVERLAP_GUIDE_Z }}>
                      <OverlapGuideOverlay disabled={replayControls?.isReplaying ?? false} />
                    </div>
                  </div>
                </div>
              )}
            </ViewportContextMenuBridge>
          )}
        </ViewportEntityBridge>
      </ContextMenuProvider>
    </TooltipProvider>
  );
};
