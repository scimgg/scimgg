import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LocWithType } from '../../cache/CacheManager';
import { useReplayFrameHistory, useReplayFrameStore, useReplayPreviewFrame } from '../../contexts/ReplayFrameContext';
import { useSettingsContext } from '../../contexts/SettingsContext';
import { useSimulationContext } from '../../contexts/SimulationContext';
import { useTickProgressStore } from '../../contexts/TickProgressContext';
import type { GameEvent } from '../../core/events/types';
import type { ReplayClickType, ReplayViewportState } from '../../core/ReplayRecorder';
import type { ReplayFrameSnapshot, ReplayFrameStore } from '../../core/replayFrameStore';
import { frameStartMs } from '../../core/replayTimeline';
import type { SimulationEngine } from '../../core/SimulationEngine';
import { type CameraAction, type CameraKeybindMap, DEFAULT_CAMERA_KEYBINDS } from '../../hooks/useCameraKeybinds';
import { useClickAnimation } from '../../hooks/useClickAnimation';
import { useDevicePixelRatio } from '../../hooks/useDevicePixelRatio';
import { useIsTouchOnly } from '../../hooks/useIsTouchOnly';
import { isSyntheticInput } from '../../input/inputProvenance';
import { isEditableTarget, isKeyHeld } from '../../input/keyState';
import { pinchZoomDelta } from '../../input/pinchZoom';
import { REPLAY_CLICK_OWNERSHIP_PROPS, type WorldClickType } from '../../input/replayClickFeedback';
import { isTouchPointer } from '../../input/touchHold';
import { useTouchCamera } from '../../input/useTouchCamera';
import { makeWheelDetentReader } from '../../input/wheelDetents';
import type { OverlayTypeLoader, UnderlayTypeLoader } from '../../rs/config/flotype/FloTypeLoader';
import type { LocModelLoader } from '../../rs/config/loctype/LocModelLoader';
import type { LocTypeInfo, LocTypeInfoLoader, MapLoader } from '../../rs/map/MapLoader';
import type { NpcModelLoader } from '../../rs/model/NpcModelLoader';
import type { PlayerModelLoader } from '../../rs/model/PlayerModelLoader';
import type { SpotAnimModelLoader } from '../../rs/model/SpotAnimModelLoader';
import type { TextureLoader } from '../../rs/texture/TextureLoader';
import { subscribeWatchInputGate, WATCH_INPUT_GATED_ATTR } from '../../tutorial/runtime/tutorialInputBoundary';
import type { EntityHiderOptions } from '../../types/entityHider';
import type { LineMarker } from '../../types/lineMarkers';
import { DEFAULT_LINE_MARKER_WIDTH } from '../../types/lineMarkers';
import type { NpcHighlightEntry } from '../../types/npcHighlight';
import type { PillarAdditionsPlugins } from '../../types/pillarAdditions';
import type { PlayerConfig } from '../../types/player';
import { type Coordinate, OSRS_TICK_MS, type SimulationState } from '../../types/simulation';
import type { StartPositionPreparation } from '../../types/startPositionPreparation';
import type { TileGridStyle } from '../../types/tileGrid';
import type { TileIndicatorConfig } from '../../types/tileIndicators';
import { DEFAULT_TILE_MARKER_WIDTH, type TileMarker } from '../../types/tileMarkers';
import type { TzhaarHpTrackerOptions } from '../../types/tzhaarHpTracker';
import { animationFrames } from '../../util/animationFrames';
import { frameProfiler } from '../../util/FrameProfiler';
import { matchesKeyboardKey } from '../../util/hotkey';
import { IMAGE_CROSS_ORIGIN } from '../../util/imageCache';
import { log } from '../../util/Logger';
import { toElementLocalPoint } from '../../util/viewportBounds';
import type { AnimationSystem } from '../core/animation';
import type { Viewport } from '../core/camera';
import { createCamera3D } from '../core/camera';
import type {
  HealthBarOverlay,
  HitsplatOverlay,
  OverheadIcon,
  OverheadTextOverlay,
  TickCounterOverlay,
  TileMarkerLabelOverlay,
  TimerBarOverlay,
} from '../core/commands';
import { healthBarFillWidthPx, OVERLAY_LAYER_Z_INDEX } from '../core/commands';
import { fpsReporter } from '../core/fpsReporter';
import { PlayerVisualTracker } from '../core/interpolation';
import { sharedModelTextureIndex } from '../core/modelTextures';
import {
  isContextStatusRenderer,
  isSameRenderStatus,
  isTextureCapableRenderer,
  type Renderer,
  RendererUnsupportedError,
  type RenderStatus,
} from '../core/renderer';
import { getReplayPresentation } from '../core/replayPresentation';
import { RestoredPresentationClock } from '../core/restoredPresentation';
import { setOverheadTextContent } from '../overlay/overheadTextContent';
import type { PlayerOverheadNumbers } from '../overlay/UIOverlayRenderer';
import {
  type CameraMode,
  createProjection3D,
  type OrbitCameraState,
  OSRS_DEFAULT_PITCH,
  type Projection3D,
} from '../projections/Projection3D';
import { replayViewportStateToOrbitCameraState } from '../projections/replayViewportMapper';
import type { RenderContext, SceneBuilderLike, TextureIndexMapper } from '../scene/types';
import { didOrbitCameraStateChange } from './cameraChangeDetection';
import { HITSPLAT_SPRITE_BY_TYPE } from './hitsplatSprites';

// Camera follow constants. Unsourced and unmeasured — chosen to look right here.
const OSRS_FRAME_MS = 20; // 50fps
// Bound 3D fill rate on high-density screens; UI and overlay density stay native.
const MAX_3D_DEVICE_PIXEL_RATIO = 2;
const FOLLOW_RETAIN = 15 / 16; // fraction of gap retained per OSRS frame
const FOLLOW_SNAP_TILES = 500 / 128; // ~3.9 tiles

const MIDDLE_MOUSE_BUTTON_MASK = 4;
const RIGHT_MOUSE_BUTTON_MASK = 2;
/**
 * 0.9 OSRS angle units per pixel, at 2048 units = 360 degrees.
 * Source: rs-map-viewer MapViewerRenderer.ts:148-156.
 *
 * This is the 1.0 rate, which `dragSpeed` multiplies. Do NOT reach for
 * `cameraSpeed` instead: that is RuneLite's KEYBOARD camera rate
 * (CameraConfig.cameraSpeed -> client.setCameraSpeed), and the two inputs are
 * separately tunable precisely because one mouse's pixels-per-inch has nothing
 * to do with how fast the arrow keys should swing the camera.
 */
const DRAG_DEGREES_PER_PIXEL = (0.9 * 360) / 2048;
/**
 * Touch rotation relative to a mouse drag: a phone is a few hundred CSS px wide, so the
 * mouse rate would take several swipes per half turn. Unsourced; chosen to feel right.
 */
const TOUCH_DRAG_SPEED_MULTIPLIER = 2;
/**
 * A touchscreen laptop's finger or pen drives the touch camera too (see `isTouchPointer`), so the
 * browser must not claim canvas touches for scrolling or page zoom here either.
 */
const DESKTOP_CANVAS_STYLE: React.CSSProperties = { display: 'block', touchAction: 'none' };
/** The browser must not claim canvas touches for scrolling, page zoom, or text selection. */
const TOUCH_CANVAS_STYLE: React.CSSProperties = {
  display: 'block',
  touchAction: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTouchCallout: 'none',
};
const FREEFORM_MOUSE_SENSITIVITY = 0.15;
/**
 * Consecutive throwing live frames after which the loop stops rescheduling. A transient
 * error (one bad frame during a scene swap) recovers well inside this; a deterministic
 * one would otherwise spin a full scene build every frame forever.
 */
export const MAX_CONSECUTIVE_LIVE_FRAME_FAILURES = 30;
const RENDER_STATUS_OK: RenderStatus = { kind: 'ok' };
const RENDER_STATUS_UNSUPPORTED: RenderStatus = { kind: 'failed', reason: 'unsupported' };
const RENDER_STATUS_LOOP_FAILED: RenderStatus = { kind: 'failed', reason: 'render-loop' };

/**
 * State that belongs to one scene: player interpolation, the follow camera, tick and
 * frame timing, replay and restoration cursors, hover, readiness and the scene's
 * render-failure budget. {@link createSceneRuntime} builds it on first mount and again at
 * every scene boundary, so both start from the same values. The viewport and its context
 * (render status, settings, input devices) live outside it and outlast scenes.
 */
interface SceneRuntime {
  tracker: PlayerVisualTracker;
  cameraTarget: { x: number; y: number; z: number };
  lastKnownTick: number;
  lastTickTimeMs: number;
  lastObservedTick: number;
  /** Last timeline key the render loop observed; drives the tracker snap on a same-tick timeline swap. */
  lastObservedTimelineKey: string | undefined;
  lastFrameTimeMs: number;
  lastReplayFrame: { timeMs: number; history: RenderContext['replayHistory'] } | null;
  restoredClock: RestoredPresentationClock;
  /** The countdown positioning step last fed to the tracker, so each is walked exactly once. */
  lastStartPositionPreparation: Pick<StartPositionPreparation, 'boundary' | 'sequence'> | null;
  /** The simulation tile the render loop last observed, to see the player placed without a tick. */
  lastObservedPlayerTile: Coordinate;
  replayCameraApplyKey: string | null;
  /**
   * Written by the mouse handlers and the render loop, read by the render loop. Not React
   * state: the hover highlight must reach the frame being drawn now. The new scene
   * recomputes it on its first frame from the cursor, which is input and outlasts scenes.
   */
  hoveredTile: Coordinate | null;
  sceneReadyFired: boolean;
  /** A new scene gets a fresh retry budget; a terminal loop failure clears on its first good frame. */
  consecutiveLiveFailures: number;
}

function createSceneRuntime(state: SimulationState, nowMs: number): SceneRuntime {
  const [x, y] = state.playerPosition;
  const tracker = new PlayerVisualTracker(x, y);
  tracker.facingAngle = state.playerFacingAngle;
  return {
    tracker,
    cameraTarget: { x: x + 0.5, y: y + 0.5, z: 0.9 },
    lastKnownTick: state.currentTick,
    lastTickTimeMs: nowMs,
    lastObservedTick: state.currentTick,
    lastObservedTimelineKey: undefined,
    lastFrameTimeMs: nowMs,
    lastReplayFrame: null,
    restoredClock: new RestoredPresentationClock(),
    lastStartPositionPreparation: null,
    lastObservedPlayerTile: [x, y],
    replayCameraApplyKey: null,
    hoveredTile: null,
    sceneReadyFired: false,
    consecutiveLiveFailures: 0,
  };
}

const MAX_FREEFORM_TURN_DEGREES_PER_EVENT = 15;

function isWatchInputGated(): boolean {
  return typeof document !== 'undefined' && document.body.hasAttribute(WATCH_INPUT_GATED_ATTR);
}

type MouseMoveSample = {
  readonly clientX: number;
  readonly clientY: number;
  readonly movementX: number;
  readonly movementY: number;
};

type CameraDragButton = 'middle' | 'right';

export type ViewportInputOwnership =
  | { readonly kind: 'camera-drag' }
  | { readonly kind: 'claimed' }
  | { readonly kind: 'none' };

interface RenderViewport3DProps {
  simulationState: SimulationState;
  engine?: SimulationEngine;
  onTileClick: (coord: Coordinate, ctrlKey?: boolean) => void;
  showCoordinates: boolean;
  /** The Tile Grid plugin's style; `null` when it is off. */
  tileGrid?: TileGridStyle | null;
  encounterDebugFlags?: Record<string, boolean | number>;
  showNpcClickbox?: boolean;
  showTileMarkers?: boolean;
  tileMarkers?: TileMarker[];
  tileIndicatorConfig?: TileIndicatorConfig;
  showNpcHighlights?: boolean;
  npcHighlights?: NpcHighlightEntry[];
  showTileMarkerLabels?: boolean;
  tileMarkerWidth?: number;
  showLineMarkers?: boolean;
  lineMarkers?: LineMarker[];
  showLineMarkerLabels?: boolean;
  lineMarkerWidth?: number;
  smoothTerrain?: boolean;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  renderScale?: number;
  targetTile?: Coordinate | null;
  /** Live play's destination, read every frame so a click needs no re-render; replaces `targetTile`. */
  getTargetTile?: () => Coordinate | null;
  /** Live countdown positioning, read every frame; each step is walked once while the tick stays 0. */
  getStartPositionPreparation?: () => StartPositionPreparation | null;
  renderer: Renderer;
  sceneBuilder: SceneBuilderLike;
  mapLoader?: MapLoader;
  underlayLoader?: UnderlayTypeLoader;
  overlayLoader?: OverlayTypeLoader;
  textureLoader?: TextureLoader;
  locModelLoader?: LocModelLoader;
  npcModelLoader?: NpcModelLoader;
  playerModelLoader?: PlayerModelLoader;
  spotAnimModelLoader?: SpotAnimModelLoader;
  playerConfig?: PlayerConfig;
  animationSystem?: AnimationSystem;
  mapLocs?: LocWithType[];
  width?: number;
  height?: number;
  /** Viewport height in client pixels when the frame is magnified — see Viewport.logicalHeight. */
  logicalHeight?: number;
  /** How much larger than `width` x `height` the canvas is drawn on screen — see Viewport.paintScale. */
  paintScale?: { readonly x: number; readonly y: number } | null;
  projection3D?: Projection3D;
  cameraKeybinds?: CameraKeybindMap;
  onCameraChange?: (state: OrbitCameraState) => void;
  onFpsUpdate?: (fps: number) => void;
  /** Max FPS for the render loop. 0 = uncapped (render every animation frame). */
  fpsCap?: number;
  speedMultiplier?: number;
  playerOverheadNumbers?: PlayerOverheadNumbers;
  showAttackTimerMetronome?: boolean;
  showNpcAttackTimerMetronome?: boolean;
  /** Entity Hider plugin's options; null while it is off. */
  entityHider?: EntityHiderOptions | null;
  /** TzHaar HP Tracker plugin's options; null while it is off. */
  tzhaarHpTracker?: TzhaarHpTrackerOptions | null;
  /** Inferno and Colosseum Additions plugins' options, each null while it is off; null for neither. */
  pillarAdditions?: PillarAdditionsPlugins | null;
  onContextMenu?: (
    tile: Coordinate | null,
    clientX: number,
    clientY: number,
    canvasScreenPx?: { x: number; y: number },
    shiftKey?: boolean,
  ) => ViewportInputOwnership;
  onHoveredTileChange?: (tile: Coordinate | null, screenPx: { x: number; y: number }) => void;
  leftClickType?: WorldClickType;
  onReplayCursorClick?: (clientX: number, clientY: number, type: ReplayClickType, nowMs?: number) => void;
  onVoidClick?: (canvasScreenPx: { x: number; y: number }, ctrlKey: boolean) => boolean;
  invertYaw?: boolean;
  invertPitch?: boolean;
  cameraSpeed?: number;
  dragSpeed?: number;
  zoomIncrement?: number;
  eventOverrides?: GameEvent[];
  replayViewportState?: ReplayViewportState;
  replayIsReplaying?: boolean;
  replayPlaying?: boolean;
  replayFrameIndex?: number;
  replayPaused?: boolean;
  replayTimelineKey?: string;
  onSceneReady?: () => void;
  encounterRequiresLocs?: boolean;
  /**
   * Whether the 3D canvas is actually drawing. Called once the renderer has initialized
   * (or failed to) and again on every transition — context lost, restoring, restored,
   * or a terminal failure — so the UI can explain a black canvas.
   */
  onRenderStatusChange?: (status: RenderStatus) => void;
}

export const RenderViewport3D: React.FC<RenderViewport3DProps> = ({
  simulationState,
  engine,
  onTileClick,
  showCoordinates,
  tileGrid = null,
  encounterDebugFlags = {},
  showNpcClickbox = false,
  showTileMarkers = true,
  tileMarkers = [],
  tileIndicatorConfig,
  showNpcHighlights = true,
  npcHighlights = [],
  showTileMarkerLabels = true,
  tileMarkerWidth = DEFAULT_TILE_MARKER_WIDTH,
  showLineMarkers = true,
  lineMarkers = [],
  showLineMarkerLabels = true,
  lineMarkerWidth = DEFAULT_LINE_MARKER_WIDTH,
  smoothTerrain = false,
  brightness = 0.6,
  contrast = 1.0,
  saturation = 1.0,
  renderScale = 1,
  targetTile,
  getTargetTile,
  getStartPositionPreparation,
  renderer,
  sceneBuilder,
  mapLoader,
  underlayLoader,
  overlayLoader,
  textureLoader,
  locModelLoader,
  npcModelLoader,
  playerModelLoader,
  spotAnimModelLoader,
  playerConfig,
  animationSystem,
  mapLocs,
  width = 800,
  height = 600,
  logicalHeight,
  paintScale,
  projection3D: externalProjection,
  cameraKeybinds = DEFAULT_CAMERA_KEYBINDS,
  onCameraChange,
  onFpsUpdate,
  fpsCap = 0,
  speedMultiplier = 1,
  playerOverheadNumbers,
  showAttackTimerMetronome = false,
  showNpcAttackTimerMetronome = false,
  entityHider = null,
  tzhaarHpTracker = null,
  pillarAdditions = null,
  onContextMenu: onContextMenuProp,
  onHoveredTileChange,
  leftClickType = 'yellow',
  onReplayCursorClick,
  onVoidClick: onVoidClickProp,
  invertYaw = false,
  invertPitch = false,
  cameraSpeed = 1,
  dragSpeed = 1,
  zoomIncrement = 25,
  eventOverrides,
  replayViewportState: replayViewportStateProp,
  replayIsReplaying = false,
  replayPlaying = false,
  replayFrameIndex = 0,
  replayPaused = false,
  replayTimelineKey,
  onSceneReady,
  encounterRequiresLocs,
  onRenderStatusChange,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const antialias = useSettingsContext()?.antialias;
  const replayFrameStore = useReplayFrameStore();
  const replayFrameStoreRef = useRef(replayFrameStore);
  replayFrameStoreRef.current = replayFrameStore;
  useEffect(() => replayFrameStore?.registerRenderConsumer(), [replayFrameStore]);
  const previewFrame = useReplayPreviewFrame();
  const replayPreviewFrame = replayIsReplaying ? previewFrame : undefined;
  const replayFrameHistory = useReplayFrameHistory();
  const replayViewportState = replayFrameStore?.getSnapshot().viewportState ?? replayViewportStateProp;
  const replayViewportStatePropRef = useRef(replayViewportStateProp);
  replayViewportStatePropRef.current = replayViewportStateProp;
  const replayFrameIndexRef = useRef(replayFrameIndex);
  replayFrameIndexRef.current = replayFrameIndex;
  // Written (never read) by the render loop below, so infobox timers can count
  // down inside a tick instead of stepping on 0.6s tick boundaries.
  const tickProgressStore = useTickProgressStore();
  const [cameraMode, setCameraMode] = useState<CameraMode>('orbit');
  // Keyed by owner rather than boolean so a scene switch reads "not loaded" in the very
  // render that brings the new builder, before any effect runs on stale flags. The
  // texture array belongs to the renderer's context and survives scene switches; terrain
  // belongs to the scene.
  const [texturesLoadedFor, setTexturesLoadedFor] = useState<TextureLoader | null>(null);
  const texturesLoaded = textureLoader !== undefined && texturesLoadedFor === textureLoader;
  const [terrainLoadedFor, setTerrainLoadedFor] = useState<SceneBuilderLike | null>(null);
  const terrainLoaded = terrainLoadedFor === sceneBuilder;
  const frameCountRef = useRef(0);
  const lastFpsUpdateRef = useRef(animationFrames.clock.now());
  const onFpsUpdateRef = useRef(onFpsUpdate);
  onFpsUpdateRef.current = onFpsUpdate;
  const fpsCapRef = useRef(fpsCap);
  fpsCapRef.current = Number.isFinite(fpsCap) && fpsCap > 0 ? fpsCap : 0;
  // FPS-cap scheduling state. `nextFrameDeadlineRef` holds the performance.now()
  // timestamp at which the next frame is allowed to render. It advances by exactly
  // one frame budget each render so the average rate lands on the target even when
  // the display refreshes faster (e.g. 60fps cap on a 144Hz monitor). -1 = unstarted.
  const nextFrameDeadlineRef = useRef(-1);
  const onCameraChangeRef = useRef(onCameraChange);
  onCameraChangeRef.current = onCameraChange;
  const cameraSpeedRef = useRef(cameraSpeed);
  cameraSpeedRef.current = Number.isFinite(cameraSpeed) && cameraSpeed > 0 ? cameraSpeed : 1;
  const dragSpeedRef = useRef(dragSpeed);
  dragSpeedRef.current = Number.isFinite(dragSpeed) && dragSpeed > 0 ? dragSpeed : 1;
  const zoomIncrementRef = useRef(zoomIncrement);
  zoomIncrementRef.current = Number.isFinite(zoomIncrement) && zoomIncrement > 0 ? zoomIncrement : 25;

  const sceneBuilderRef = useRef(sceneBuilder);
  /** Bumped at every scene boundary; async loads started for an older scene compare and drop. */
  const sceneLoadVersionRef = useRef(0);
  const sceneRuntimeRef = useRef<SceneRuntime>(null!);
  if (sceneRuntimeRef.current === null) {
    sceneRuntimeRef.current = createSceneRuntime(simulationState, animationFrames.clock.now());
  }
  const simulationContext = useSimulationContext();
  const restoredPresentation = simulationContext?.restoredPresentation;
  const restoredPresentationRef = useRef(restoredPresentation);
  const fightStartCountdownRef = useRef(simulationContext?.fightStartCountdown);
  fightStartCountdownRef.current = simulationContext?.fightStartCountdown;

  const animationFrameRef = useRef<number>(0);
  const rendererInitRef = useRef(false);
  const onRenderStatusChangeRef = useRef(onRenderStatusChange);
  onRenderStatusChangeRef.current = onRenderStatusChange;
  const rendererStatusRef = useRef<RenderStatus>(RENDER_STATUS_OK);
  const rendererUnsupportedRef = useRef(false);
  const liveLoopFailedRef = useRef(false);
  const publishedRenderStatusRef = useRef<RenderStatus | null>(null);
  const publishRenderStatus = useCallback(() => {
    const rendererStatus = rendererStatusRef.current;
    const next = rendererUnsupportedRef.current
      ? RENDER_STATUS_UNSUPPORTED
      : rendererStatus.kind === 'failed'
        ? rendererStatus
        : liveLoopFailedRef.current
          ? RENDER_STATUS_LOOP_FAILED
          : rendererStatus;
    const previous = publishedRenderStatusRef.current;
    if (previous && isSameRenderStatus(previous, next)) return;
    publishedRenderStatusRef.current = next;
    onRenderStatusChangeRef.current?.(next);
  }, []);
  const cameraDragButtonRef = useRef<CameraDragButton | null>(null);
  const lastMouseRef = useRef({ x: 0, y: 0 });
  const lastCanvasMouseRef = useRef({ x: -1, y: -1 });
  const resetTimingRef = useRef(false);

  const isPointerLockedRef = useRef(false);
  const cameraKeybindsRef = useRef(cameraKeybinds);

  const targetTileRef = useRef<Coordinate | null>(targetTile ?? null);
  const getTargetTileRef = useRef(getTargetTile);
  getTargetTileRef.current = getTargetTile;
  const getStartPositionPreparationRef = useRef(getStartPositionPreparation);
  getStartPositionPreparationRef.current = getStartPositionPreparation;
  const overheadContainerRef = useRef<HTMLDivElement>(null);
  const tileMarkerLabelContainerRef = useRef<HTMLDivElement>(null);
  const hitsplatContainerRef = useRef<HTMLDivElement>(null);
  const clickOverlayRef = useRef<HTMLDivElement>(null);
  /** A cutscene's fade to black, over the scene and its overlays; its opacity is set per frame. */
  const cutsceneFadeRef = useRef<HTMLDivElement>(null);
  const triggerClickAnim = useClickAnimation(clickOverlayRef);
  const simulationStateRef = useRef(simulationState);
  const engineRef = useRef(engine);
  const showCoordinatesRef = useRef(showCoordinates);
  const tileGridRef = useRef(tileGrid);
  const encounterDebugFlagsRef = useRef(encounterDebugFlags);
  const showNpcClickboxRef = useRef(showNpcClickbox);
  const showTileMarkersRef = useRef(showTileMarkers);
  const tileMarkersRef = useRef(tileMarkers);
  const showNpcHighlightsRef = useRef(showNpcHighlights);
  const npcHighlightsRef = useRef(npcHighlights);
  const showTileMarkerLabelsRef = useRef(showTileMarkerLabels);
  const tileMarkerWidthRef = useRef(tileMarkerWidth);
  const showLineMarkersRef = useRef(showLineMarkers);
  const lineMarkersRef = useRef(lineMarkers);
  const showLineMarkerLabelsRef = useRef(showLineMarkerLabels);
  const lineMarkerWidthRef = useRef(lineMarkerWidth);
  const smoothTerrainRef = useRef(smoothTerrain);
  const brightnessRef = useRef(brightness);
  const contrastRef = useRef(contrast);
  const saturationRef = useRef(saturation);
  const speedMultiplierRef = useRef(speedMultiplier);
  const playerOverheadNumbersRef = useRef(playerOverheadNumbers);
  const showAttackTimerMetronomeRef = useRef(showAttackTimerMetronome);
  const showNpcAttackTimerMetronomeRef = useRef(showNpcAttackTimerMetronome);
  const entityHiderRef = useRef(entityHider);
  const tzhaarHpTrackerRef = useRef(tzhaarHpTracker);
  const pillarAdditionsRef = useRef(pillarAdditions);
  const eventOverridesRef = useRef(eventOverrides);
  const replayViewportStateRef = useRef(replayViewportState);
  const replayIsReplayingRef = useRef(replayIsReplaying);
  const replayPlayingRef = useRef(replayPlaying);
  const replayPausedRef = useRef(replayPaused);
  const replayTimelineKeyRef = useRef(replayTimelineKey);
  const tileIndicatorConfigRef = useRef(tileIndicatorConfig);
  tileIndicatorConfigRef.current = tileIndicatorConfig;

  // While the seek bar is being dragged the previewed tick arrives through the
  // frame store instead of React state, so only this component re-renders — the
  // Grid/chrome/panel tree stays on the committed tick until the pointer is
  // released. Everything below (tick timing, the render loop, the scene builder)
  // treats it exactly like the real displayed state.
  const effectiveSimulationState = replayPreviewFrame?.state ?? simulationState;
  const effectiveEventOverrides = replayPreviewFrame ? replayPreviewFrame.events : eventOverrides;
  // Gated on the replay flag as well as the store: the two are written by the same handler but
  // commit separately, so one render can see either ahead of the other, and a live or tutorial
  // scene must not receive frames in that window.
  const replayHistoryThroughFrameIndex = replayPreviewFrame?.frameIndex ?? replayFrameIndex;
  const replayHistory = useMemo<RenderContext['replayHistory']>(
    () =>
      replayIsReplaying && replayFrameHistory
        ? { frames: replayFrameHistory, throughFrameIndex: replayHistoryThroughFrameIndex }
        : undefined,
    [replayIsReplaying, replayFrameHistory, replayHistoryThroughFrameIndex],
  );
  const replayHistoryRef = useRef(replayHistory);

  if (
    effectiveSimulationState.currentTick !== sceneRuntimeRef.current.lastKnownTick ||
    (restoredPresentation &&
      restoredPresentation.engine === engine &&
      restoredPresentation !== restoredPresentationRef.current)
  ) {
    sceneRuntimeRef.current.lastKnownTick = effectiveSimulationState.currentTick;
    sceneRuntimeRef.current.lastTickTimeMs = animationFrames.clock.now();
  }
  simulationStateRef.current = effectiveSimulationState;
  engineRef.current = engine;
  eventOverridesRef.current = effectiveEventOverrides;
  replayViewportStateRef.current = replayViewportState;
  replayIsReplayingRef.current = replayIsReplaying;
  replayPlayingRef.current = replayPlaying;
  replayPausedRef.current = replayPaused;
  replayTimelineKeyRef.current = replayTimelineKey;
  replayHistoryRef.current = replayHistory;
  restoredPresentationRef.current = restoredPresentation;

  const replayOwnsCamera = replayIsReplaying && Boolean(replayViewportState);
  useEffect(() => {
    if (replayOwnsCamera) cameraDragButtonRef.current = null;
  }, [replayOwnsCamera]);

  useEffect(
    () =>
      subscribeWatchInputGate((gated) => {
        if (gated) cameraDragButtonRef.current = null;
      }),
    [],
  );

  const onHoveredTileChangeRef = useRef(onHoveredTileChange);
  onHoveredTileChangeRef.current = onHoveredTileChange;
  const leftClickTypeRef = useRef(leftClickType);
  leftClickTypeRef.current = leftClickType;
  const onReplayCursorClickRef = useRef(onReplayCursorClick);
  onReplayCursorClickRef.current = onReplayCursorClick;

  useEffect(() => {
    targetTileRef.current = targetTile ?? null;
  }, [targetTile]);
  useEffect(() => {
    showCoordinatesRef.current = showCoordinates;
  }, [showCoordinates]);
  useEffect(() => {
    tileGridRef.current = tileGrid;
  }, [tileGrid]);
  useEffect(() => {
    encounterDebugFlagsRef.current = encounterDebugFlags;
  }, [encounterDebugFlags]);
  useEffect(() => {
    showNpcClickboxRef.current = showNpcClickbox;
  }, [showNpcClickbox]);
  useEffect(() => {
    showTileMarkersRef.current = showTileMarkers;
  }, [showTileMarkers]);
  useEffect(() => {
    tileMarkersRef.current = tileMarkers;
  }, [tileMarkers]);
  useEffect(() => {
    showNpcHighlightsRef.current = showNpcHighlights;
  }, [showNpcHighlights]);
  useEffect(() => {
    npcHighlightsRef.current = npcHighlights;
  }, [npcHighlights]);
  useEffect(() => {
    showTileMarkerLabelsRef.current = showTileMarkerLabels;
  }, [showTileMarkerLabels]);
  useEffect(() => {
    showLineMarkersRef.current = showLineMarkers;
  }, [showLineMarkers]);
  useEffect(() => {
    lineMarkersRef.current = lineMarkers;
  }, [lineMarkers]);
  useEffect(() => {
    showLineMarkerLabelsRef.current = showLineMarkerLabels;
  }, [showLineMarkerLabels]);
  useEffect(() => {
    lineMarkerWidthRef.current = lineMarkerWidth;
  }, [lineMarkerWidth]);
  useEffect(() => {
    tileMarkerWidthRef.current = tileMarkerWidth;
  }, [tileMarkerWidth]);
  useEffect(() => {
    smoothTerrainRef.current = smoothTerrain;
    sceneBuilder.setSmoothTerrain?.(smoothTerrain);
  }, [smoothTerrain, sceneBuilder]);
  useEffect(() => {
    brightnessRef.current = brightness;
  }, [brightness]);
  useEffect(() => {
    contrastRef.current = contrast;
  }, [contrast]);
  useEffect(() => {
    saturationRef.current = saturation;
  }, [saturation]);
  useEffect(() => {
    speedMultiplierRef.current = speedMultiplier;
  }, [speedMultiplier]);
  // Reset the FPS-cap deadline when the cap changes so switching from a low cap
  // to a high one doesn't skip frames until the stale (slower) deadline elapses.
  useEffect(() => {
    fpsCapRef.current = Number.isFinite(fpsCap) && fpsCap > 0 ? fpsCap : 0;
    nextFrameDeadlineRef.current = -1;
  }, [fpsCap]);
  useEffect(() => {
    tileIndicatorConfigRef.current = tileIndicatorConfig;
  }, [tileIndicatorConfig]);
  useEffect(() => {
    playerOverheadNumbersRef.current = playerOverheadNumbers;
  }, [playerOverheadNumbers]);
  useEffect(() => {
    showAttackTimerMetronomeRef.current = showAttackTimerMetronome;
  }, [showAttackTimerMetronome]);
  useEffect(() => {
    showNpcAttackTimerMetronomeRef.current = showNpcAttackTimerMetronome;
  }, [showNpcAttackTimerMetronome]);
  useEffect(() => {
    entityHiderRef.current = entityHider;
  }, [entityHider]);
  useEffect(() => {
    tzhaarHpTrackerRef.current = tzhaarHpTracker;
  }, [tzhaarHpTracker]);
  useEffect(() => {
    pillarAdditionsRef.current = pillarAdditions;
  }, [pillarAdditions]);

  if (cameraKeybindsRef.current !== cameraKeybinds) {
    cameraKeybindsRef.current = cameraKeybinds;
  }

  // `renderScale` is the user's quality slider expressed as a FRACTION OF
  // NATIVE (capped at 2x), so 1.0 means one backing pixel per device pixel up
  // to that cap, rather than one per CSS pixel. Without the device ratio the
  // scene rasterizes at CSS resolution and the browser upscales it, pre-blurring
  // every edge before MSAA gets to resolve one. Projection math cancels the
  // raster size (Projection3D.getProjectionMatrix), so this changes fidelity
  // only — never framing.
  const deviceScale = useDevicePixelRatio();
  const paintX = paintScale?.x ?? 1;
  const paintY = paintScale?.y ?? 1;
  const viewport: Viewport = useMemo(
    () => ({
      width,
      height,
      dpr: renderScale * Math.min(deviceScale, MAX_3D_DEVICE_PIXEL_RATIO),
      ...(logicalHeight !== undefined ? { logicalHeight } : {}),
      ...(paintX !== 1 || paintY !== 1 ? { paintScale: { x: paintX, y: paintY } } : {}),
    }),
    [width, height, logicalHeight, paintX, paintY, renderScale, deviceScale],
  );

  const internalProjectionRef = useRef<Projection3D | null>(null);

  const getProjection3D = useCallback((): Projection3D => {
    if (externalProjection) return externalProjection;
    if (!internalProjectionRef.current) {
      internalProjectionRef.current = createProjection3D(
        { width: 800, height: 600, dpr: 1 },
        {
          pitch: OSRS_DEFAULT_PITCH,
          yaw: 180,
          targetX: simulationState.playerPosition[0] + 0.5,
          targetY: simulationState.playerPosition[1] + 0.5,
          targetZ: 0.9,
        },
      );
    }
    return internalProjectionRef.current;
  }, [externalProjection, simulationState.playerPosition]);

  const projection3DRef = useRef<Projection3D>(getProjection3D());

  const applyReplayViewportState = useCallback((viewportState: ReplayViewportState) => {
    const projection3D = projection3DRef.current;
    if (projection3D.getCameraMode() !== 'orbit') {
      projection3D.setCameraMode('orbit');
      setCameraMode('orbit');
      isPointerLockedRef.current = false;
      if (document.pointerLockElement && typeof document.exitPointerLock === 'function') {
        document.exitPointerLock();
      }
    }
    projection3D.restoreOrbitCamera(replayViewportStateToOrbitCameraState(viewportState));
    sceneRuntimeRef.current.cameraTarget = {
      x: viewportState.target.x,
      y: viewportState.target.y,
      z: viewportState.target.z,
    };
    onCameraChangeRef.current?.(projection3D.getCameraState());
  }, []);

  useEffect(() => {
    projection3DRef.current = getProjection3D();
    if (onCameraChange) {
      onCameraChange(projection3DRef.current.getCameraState());
    }
  }, [getProjection3D, onCameraChange]);

  useEffect(() => {
    projection3DRef.current.updateViewport(viewport);
  }, [viewport]);

  useEffect(() => {
    if (!replayIsReplaying || !replayViewportState) {
      sceneRuntimeRef.current.replayCameraApplyKey = null;
      return;
    }
    const applyKey = `${replayTimelineKey ?? 'unknown'}:${replayFrameIndex}:${replayPlaying ? 'playing' : 'paused'}`;
    if (sceneRuntimeRef.current.replayCameraApplyKey === applyKey) return;
    sceneRuntimeRef.current.replayCameraApplyKey = applyKey;
    applyReplayViewportState(replayViewportState);
  }, [
    applyReplayViewportState,
    replayFrameIndex,
    replayIsReplaying,
    replayPlaying,
    replayTimelineKey,
    replayViewportState,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: antialias is a context creation attribute, read only when the renderer initializes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (!rendererInitRef.current) {
      try {
        renderer.init(canvas, { antialias });
      } catch (error) {
        // A browser without a usable context is an environment state for the UI to
        // explain, not a crash; anything else still reaches the error boundary.
        if (!(error instanceof RendererUnsupportedError)) throw error;
        log.warn('Renderer', error.message);
        rendererUnsupportedRef.current = true;
        publishRenderStatus();
        return;
      }
      rendererInitRef.current = true;
    }
    rendererUnsupportedRef.current = false;
    rendererStatusRef.current = isContextStatusRenderer(renderer) ? renderer.getContextStatus() : RENDER_STATUS_OK;
    const unsubscribeStatus = isContextStatusRenderer(renderer)
      ? renderer.subscribeContextStatus((status) => {
          rendererStatusRef.current = status;
          publishRenderStatus();
        })
      : undefined;
    publishRenderStatus();

    return () => {
      unsubscribeStatus?.();
      if (rendererInitRef.current) {
        renderer.dispose();
        rendererInitRef.current = false;
        // dispose() drops the texture array, but a re-init without a remount (Fast Refresh, a
        // replaced renderer) keeps this state; clear it so the next init uploads them again.
        sharedModelTextureIndex.setMapper(null);
        setTexturesLoadedFor(null);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- init/dispose must only depend on renderer identity, not viewport
  }, [renderer, publishRenderStatus]);

  useEffect(() => {
    if (rendererInitRef.current) {
      renderer.resize(viewport);
    }
  }, [viewport, renderer]);

  useEffect(() => {
    if (textureLoader && rendererInitRef.current && isTextureCapableRenderer(renderer) && !texturesLoaded) {
      renderer.loadTextures(textureLoader);
      // Bind the OSRS-texture-id -> texture-array-layer mapping before any model
      // mesh is baked, so player/NPC/loc meshes can emit textured faces.
      const textureArrayManager = renderer.getTextureArrayManager();
      sharedModelTextureIndex.setMapper(
        textureArrayManager ? (textureId: number) => textureArrayManager.getTextureIndex(textureId) : null,
      );
      setTexturesLoadedFor(textureLoader);
    }
  }, [textureLoader, renderer, texturesLoaded]);

  const locsDataPending = encounterRequiresLocs && mapLocs === undefined;

  useEffect(() => {
    // The builder may already hold its terrain: a remounted viewport (3D after 2D), or a
    // load whose completion this effect stopped listening for when its inputs changed.
    // A load still in flight is joined below: the builder returns the same promise.
    if (sceneBuilder.isTerrainLoaded()) {
      projection3DRef.current.setTerrainHeights(sceneBuilder.getTerrainHeights?.() ?? null);
      setTerrainLoadedFor(sceneBuilder);
      return;
    }
    if (!locsDataPending && mapLoader && texturesLoaded) {
      let textureIndexMapper: TextureIndexMapper | undefined;

      if (isTextureCapableRenderer(renderer)) {
        const manager = renderer.getTextureArrayManager();
        if (manager) {
          textureIndexMapper = (textureId: number) => manager.getTextureIndex(textureId);
        }
      }

      const locations = mapLocs?.map((loc) => loc.location);
      const locTypeInfoLoader: LocTypeInfoLoader | undefined = mapLocs
        ? (locId: number) => {
            const locWithType = mapLocs.find((l) => l.location.id === locId);
            if (locWithType) {
              const { locType } = locWithType;
              return {
                clipped: locType.clipped,
                sizeX: locType.sizeX,
                sizeY: locType.sizeY,
              } as LocTypeInfo;
            }
            return undefined;
          }
        : undefined;

      let cancelled = false;
      const loadVersion = sceneLoadVersionRef.current;
      sceneBuilder
        .loadTerrain(
          mapLoader,
          underlayLoader,
          overlayLoader,
          textureIndexMapper,
          locations,
          locTypeInfoLoader,
          smoothTerrainRef.current,
        )
        .then(() => {
          if (cancelled || sceneLoadVersionRef.current !== loadVersion) return;
          projection3DRef.current.setTerrainHeights(sceneBuilder.getTerrainHeights?.() ?? null);
          setTerrainLoadedFor(sceneBuilder);
        })
        .catch((error) => {
          if (cancelled || sceneLoadVersionRef.current !== loadVersion) return;
          log.error('Renderer', 'Failed to load terrain', error);
        });

      return () => {
        cancelled = true;
      };
    }
  }, [mapLoader, underlayLoader, overlayLoader, sceneBuilder, renderer, texturesLoaded, mapLocs, locsDataPending]);

  const tryFireSceneReady = useCallback(() => {
    if (sceneRuntimeRef.current.sceneReadyFired || !onSceneReady || !terrainLoaded || !sceneBuilder.isTerrainLoaded()) {
      return;
    }

    // Wait for loc data to arrive when the encounter requires it.
    // mapLocs is undefined while loading, then [] (empty/failed) or [...] (loaded).
    if (locsDataPending) return;

    const requiresPlayer = Boolean(playerModelLoader && playerConfig);
    const requiresNpc = Boolean(npcModelLoader);
    const requiresLocs = Boolean(mapLocs && mapLocs.length > 0);

    const playerReady = !requiresPlayer || sceneBuilder.isPlayerLoaded();
    const spotAnimsReady = !spotAnimModelLoader || sceneBuilder.isSpotAnimsLoaded(spotAnimModelLoader);
    const npcReady = !requiresNpc || sceneBuilder.isNpcLoaded();
    const locsReady = !requiresLocs || sceneBuilder.isLocsLoaded();

    if (playerReady && spotAnimsReady && npcReady && locsReady) {
      sceneRuntimeRef.current.sceneReadyFired = true;
      onSceneReady();
    }
  }, [
    onSceneReady,
    terrainLoaded,
    playerModelLoader,
    playerConfig,
    spotAnimModelLoader,
    npcModelLoader,
    mapLocs,
    sceneBuilder,
    locsDataPending,
  ]);

  const tryFireSceneReadyRef = useRef(tryFireSceneReady);
  tryFireSceneReadyRef.current = tryFireSceneReady;

  useEffect(() => {
    if (
      locModelLoader &&
      mapLocs &&
      mapLocs.length > 0 &&
      terrainLoaded &&
      sceneBuilder.isTerrainLoaded() &&
      !sceneBuilder.isLocsLoaded()
    ) {
      let cancelled = false;
      const loadVersion = sceneLoadVersionRef.current;
      sceneBuilder
        .loadLocs(locModelLoader, mapLocs)
        .then(() => {
          if (cancelled || sceneLoadVersionRef.current !== loadVersion) return;
          log.info('Renderer', 'Locs loaded successfully');
          tryFireSceneReadyRef.current();
        })
        .catch((error: Error) => {
          if (cancelled || sceneLoadVersionRef.current !== loadVersion) return;
          log.error('Renderer', 'Failed to load locs', error);
        });

      return () => {
        cancelled = true;
      };
    }
  }, [locModelLoader, mapLocs, sceneBuilder, terrainLoaded]);

  useEffect(() => {
    if (
      npcModelLoader &&
      animationSystem &&
      terrainLoaded &&
      sceneBuilder.isTerrainLoaded() &&
      !sceneBuilder.isNpcLoaded()
    ) {
      let cancelled = false;
      const loadVersion = sceneLoadVersionRef.current;
      sceneBuilder
        .loadNpc(npcModelLoader, animationSystem)
        .then(() => {
          if (cancelled || sceneLoadVersionRef.current !== loadVersion) return;
          log.info('Renderer', 'NPC loaded successfully');
          tryFireSceneReadyRef.current();
        })
        .catch((error: Error) => {
          if (cancelled || sceneLoadVersionRef.current !== loadVersion) return;
          log.error('Renderer', 'Failed to load NPC', error);
        });

      return () => {
        cancelled = true;
      };
    }
  }, [npcModelLoader, animationSystem, sceneBuilder, terrainLoaded]);

  useEffect(() => {
    tryFireSceneReady();
  }, [tryFireSceneReady]);

  // Resident spotanim effects belong to the loader that baked them and outlive scenes. When the
  // loader is replaced (a cache reload) its effects go with it, so neither its GPU uploads nor the
  // recipes that would rebuild them keep the old cache alive.
  useEffect(() => {
    if (!spotAnimModelLoader) return;
    return () => renderer.retireResidentSources?.(spotAnimModelLoader);
  }, [spotAnimModelLoader, renderer]);

  useEffect(() => {
    if (!spotAnimModelLoader || !terrainLoaded || !sceneBuilder.isTerrainLoaded()) {
      tryFireSceneReadyRef.current();
      return;
    }

    // Effects bake on the CPU while loading; queue their GPU upload now rather than at first cast,
    // so the bakes leave memory at load. The renderer drains the queue a bounded amount per frame,
    // and only when its context is live.
    const uploadAhead = () => renderer.prepareResidentSources?.(sceneBuilder.getResidentMeshSources?.() ?? []);

    if (sceneBuilder.isSpotAnimsLoaded(spotAnimModelLoader)) {
      uploadAhead();
      tryFireSceneReadyRef.current();
      return;
    }

    let cancelled = false;
    sceneBuilder
      .loadSpotAnims(spotAnimModelLoader)
      .then(() => {
        if (cancelled) return;
        uploadAhead();
        tryFireSceneReadyRef.current();
      })
      .catch((error: Error) => {
        if (cancelled) return;
        log.error('Renderer', 'Failed to load spot anims', error);
        tryFireSceneReadyRef.current();
      });

    return () => {
      cancelled = true;
    };
  }, [spotAnimModelLoader, sceneBuilder, terrainLoaded, renderer]);

  useEffect(() => {
    if (playerModelLoader && playerConfig && terrainLoaded && sceneBuilder.isTerrainLoaded()) {
      let cancelled = false;
      const loadVersion = sceneLoadVersionRef.current;
      sceneBuilder
        .loadPlayer(playerModelLoader, playerConfig.appearance, playerConfig.equipment)
        .then(() => {
          if (cancelled || sceneLoadVersionRef.current !== loadVersion) return;
          log.debug('Renderer', 'Player loaded successfully');
          tryFireSceneReadyRef.current();
        })
        .catch((error: Error) => {
          if (cancelled || sceneLoadVersionRef.current !== loadVersion) return;
          log.error('Renderer', 'Failed to load player', error);
        });

      return () => {
        cancelled = true;
      };
    }
  }, [playerModelLoader, playerConfig, sceneBuilder, terrainLoaded]);

  useEffect(() => {
    // A refused lock fires pointerlockerror, never pointerlockchange, so
    // handlePointerLockChange below never runs for it. Without this the camera sits
    // in freeform with no mouse look — keyboard pan live, cursor free, nothing on
    // screen saying why. Reads the mode off the projection rather than the
    // `cameraMode` closure so it stays correct between this effect's re-runs.
    const abandonFreeform = () => {
      const projection3D = projection3DRef.current;
      if (projection3D.getCameraMode() !== 'freeform') return;
      projection3D.setCameraMode('orbit');
      setCameraMode('orbit');
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      const toggleKey = cameraKeybindsRef.current.toggleFreeform;
      if (toggleKey && matchesKeyboardKey(e.key, toggleKey)) {
        if (replayIsReplayingRef.current) return;
        e.preventDefault();
        const projection3D = projection3DRef.current;
        const newMode = projection3D.getCameraMode() === 'orbit' ? 'freeform' : 'orbit';
        projection3D.setCameraMode(newMode);
        setCameraMode(newMode);

        if (newMode === 'freeform') {
          // Chrome rate-limits repeated lock requests by rejecting the promise this
          // returns; browsers with the void signature return undefined,
          // so it cannot just be `.catch()`. An unhandled rejection here reaches the
          // global handler and is reported as a crash for a keypress the browser is
          // allowed to refuse.
          const pendingLock: unknown = canvasRef.current?.requestPointerLock();
          if (pendingLock instanceof Promise) pendingLock.catch(abandonFreeform);
        } else if (document.pointerLockElement) {
          document.exitPointerLock();
        }
        return;
      }
      // Every other camera key is read straight from the shared key store at frame
      // time; only this toggle needs an edge. The store deliberately records keys
      // pressed into a text field and during a replay too — filtering them at record
      // time would strand a key held across a focus change — so the reads
      // in the frame loop carry those gates instead.
    };

    const handlePointerLockChange = () => {
      isPointerLockedRef.current = document.pointerLockElement === canvasRef.current;
      if (!isPointerLockedRef.current && cameraMode === 'freeform') {
        const projection3D = projection3DRef.current;
        projection3D.setCameraMode('orbit');
        setCameraMode('orbit');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerlockchange', handlePointerLockChange);
    document.addEventListener('pointerlockerror', abandonFreeform);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerlockchange', handlePointerLockChange);
      document.removeEventListener('pointerlockerror', abandonFreeform);
    };
  }, [cameraMode]);

  const updateOverheadIcons = useCallback((icons: OverheadIcon[]) => {
    const root = overheadContainerRef.current;
    if (!root) return;

    let container = root.querySelector('[data-overhead-icons]') as HTMLDivElement | null;
    if (icons.length === 0) {
      if (container) container.remove();
      return;
    }

    if (!container) {
      container = document.createElement('div');
      container.setAttribute('data-overhead-icons', 'true');
      container.style.position = 'absolute';
      container.style.top = '0';
      container.style.left = '0';
      container.style.pointerEvents = 'none';
      container.style.zIndex = `${OVERLAY_LAYER_Z_INDEX.overheadIcons}`;
      root.appendChild(container);
    }

    while (container.children.length > icons.length) {
      container.removeChild(container.lastChild!);
    }

    for (let i = 0; i < icons.length; i++) {
      const icon = icons[i];
      let img = container.children[i] as HTMLImageElement | undefined;

      if (!img) {
        img = document.createElement('img');
        img.crossOrigin = IMAGE_CROSS_ORIGIN;
        img.style.position = 'absolute';
        img.style.imageRendering = 'pixelated';
        img.style.pointerEvents = 'none';
        img.style.filter = 'drop-shadow(0 0 3px rgba(0, 0, 0, 0.8))';
        container.appendChild(img);
      }

      if (img.getAttribute('data-icon') !== icon.iconPath) {
        img.src = icon.iconPath;
        img.setAttribute('data-icon', icon.iconPath);
      }
      img.style.width = `${icon.width}px`;
      img.style.height = `${icon.height}px`;
      img.style.left = `${icon.screenX - icon.width / 2}px`;
      img.style.top = `${icon.screenY - icon.height / 2}px`;
    }
  }, []);

  const updateTickCounters = useCallback((tickCounters: TickCounterOverlay[]) => {
    const root = overheadContainerRef.current;
    if (!root) return;

    let container = root.querySelector('[data-tick-counters]') as HTMLDivElement | null;
    if (tickCounters.length === 0) {
      if (container) container.remove();
      return;
    }

    if (!container) {
      container = document.createElement('div');
      container.setAttribute('data-tick-counters', 'true');
      container.style.position = 'absolute';
      container.style.top = '0';
      container.style.left = '0';
      container.style.pointerEvents = 'none';
      container.style.zIndex = `${OVERLAY_LAYER_Z_INDEX.tickCounters}`;
      root.appendChild(container);
    }

    while (container.children.length > tickCounters.length) {
      container.removeChild(container.lastChild!);
    }

    for (let i = 0; i < tickCounters.length; i++) {
      const tickCounter = tickCounters[i];
      let textEl = container.children[i] as HTMLSpanElement | undefined;

      if (!textEl) {
        textEl = document.createElement('span');
        textEl.style.position = 'absolute';
        textEl.style.pointerEvents = 'none';
        textEl.style.fontFamily = "'RuneScape Small', monospace";
        textEl.style.fontWeight = 'normal';
        textEl.style.lineHeight = '1';
        textEl.style.transform = 'translate(-50%, -50%)';
        textEl.style.whiteSpace = 'nowrap';
        // OSRS's own 1px drop shadow, as on every other in-world label.
        textEl.style.textShadow = '1px 1px 0 #000';
        container.appendChild(textEl);
      }

      // Unchanged text is left alone: rewriting it replaces the text node and restyles every frame.
      if (textEl.textContent !== tickCounter.text) textEl.textContent = tickCounter.text;
      textEl.style.left = `${tickCounter.screenX}px`;
      textEl.style.top = `${tickCounter.screenY}px`;
      textEl.style.color = tickCounter.textColor;
      textEl.style.fontSize = `${tickCounter.fontSize}px`;
    }
  }, []);

  const updateOverheadTexts = useCallback((overheadTexts: OverheadTextOverlay[]) => {
    const root = overheadContainerRef.current;
    if (!root) return;

    let container = root.querySelector('[data-overhead-texts]') as HTMLDivElement | null;
    if (overheadTexts.length === 0) {
      if (container) container.remove();
      return;
    }

    if (!container) {
      container = document.createElement('div');
      container.setAttribute('data-overhead-texts', 'true');
      container.style.position = 'absolute';
      container.style.top = '0';
      container.style.left = '0';
      container.style.pointerEvents = 'none';
      container.style.zIndex = `${OVERLAY_LAYER_Z_INDEX.overheadTexts}`;
      root.appendChild(container);
    }

    while (container.children.length > overheadTexts.length) {
      const lastChild = container.lastChild;
      if (!lastChild) break;
      container.removeChild(lastChild);
    }

    for (let i = 0; i < overheadTexts.length; i++) {
      const overheadText = overheadTexts[i];
      let textEl = container.children[i] as HTMLSpanElement | undefined;

      if (!textEl) {
        textEl = document.createElement('span');
        textEl.style.position = 'absolute';
        textEl.style.pointerEvents = 'none';
        textEl.style.fontFamily = "'RuneScape Bold 12', monospace";
        textEl.style.fontWeight = 'normal';
        textEl.style.lineHeight = '1';
        textEl.style.transform = 'translate(-50%, -100%)';
        textEl.style.whiteSpace = 'nowrap';
        textEl.style.textShadow = '1px 1px 0 #000';
        textEl.style.setProperty('-webkit-font-smoothing', 'none');
        textEl.style.setProperty('font-smooth', 'never');
        container.appendChild(textEl);
      }

      textEl.style.left = `${overheadText.screenX}px`;
      textEl.style.top = `${overheadText.screenY}px`;
      textEl.style.color = overheadText.textColor;
      textEl.style.fontSize = `${overheadText.fontSize}px`;

      setOverheadTextContent(textEl, overheadText);
    }
  }, []);

  const updateHitsplats = useCallback((hitsplats: HitsplatOverlay[]) => {
    const root = hitsplatContainerRef.current;
    if (!root) return;

    let container = root.querySelector('[data-hitsplats]') as HTMLDivElement | null;
    if (hitsplats.length === 0) {
      if (container) container.remove();
      return;
    }

    if (!container) {
      container = document.createElement('div');
      container.setAttribute('data-hitsplats', 'true');
      container.style.position = 'absolute';
      container.style.top = '0';
      container.style.left = '0';
      container.style.pointerEvents = 'none';
      container.style.zIndex = `${OVERLAY_LAYER_Z_INDEX.hitsplats}`;
      root.appendChild(container);
    }

    while (container.children.length > hitsplats.length) {
      container.removeChild(container.lastChild!);
    }

    for (let i = 0; i < hitsplats.length; i++) {
      const h = hitsplats[i];
      let el = container.children[i] as HTMLDivElement | undefined;

      if (!el) {
        el = document.createElement('div');
        el.style.position = 'absolute';
        // Positioned by transform, not left/top, so per-frame movement never
        // invalidates layout. See the write below.
        el.style.left = '0';
        el.style.top = '0';
        el.style.pointerEvents = 'none';
        el.style.display = 'flex';
        el.style.alignItems = 'center';
        el.style.justifyContent = 'center';
        el.style.imageRendering = 'pixelated';
        el.style.willChange = 'transform, opacity';

        const img = document.createElement('img');
        img.crossOrigin = IMAGE_CROSS_ORIGIN;
        img.setAttribute('data-role', 'hitsplat-image');
        img.style.position = 'absolute';
        img.style.top = '0';
        img.style.left = '0';
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.imageRendering = 'pixelated';
        img.style.pointerEvents = 'none';
        el.appendChild(img);

        const text = document.createElement('span');
        text.setAttribute('data-role', 'hitsplat-text');
        text.style.position = 'relative';
        text.style.fontFamily = "'RuneScape Small', monospace";
        text.style.fontWeight = 'normal';
        text.style.setProperty('-webkit-font-smoothing', 'none');
        text.style.setProperty('font-smooth', 'never');
        text.style.fontSize = '11px';
        text.style.lineHeight = '1';
        text.style.color = '#FFFFFF';
        text.style.textShadow = '1px 1px 0 #000';
        text.style.pointerEvents = 'none';
        el.appendChild(text);

        container.appendChild(el);
      }

      // Children are created above in a fixed order and never reordered, so index
      // access replaces two per-hitsplat selector queries on every frame.
      const img = el.children[0] as HTMLImageElement | undefined;
      const text = el.children[1] as HTMLSpanElement | undefined;
      const spritePath = HITSPLAT_SPRITE_BY_TYPE[h.type];
      if (img && img.getAttribute('data-sprite') !== spritePath) {
        img.src = spritePath;
        img.setAttribute('data-sprite', spritePath);
      }
      if (img) {
        const filter = h.type === 'venom' ? 'brightness(0.55) saturate(1.15)' : 'none';
        if (img.style.filter !== filter) img.style.filter = filter;
      }

      // width/height DO affect layout, so they are written only when they change;
      // for a given hitsplat type they are constant, and an unconditional rewrite
      // was dirtying layout on every frame.
      const width = `${h.width}px`;
      const height = `${h.height}px`;
      if (el.style.width !== width) el.style.width = width;
      if (el.style.height !== height) el.style.height = height;
      if (el.style.opacity !== '1') el.style.opacity = '1';

      if (text) {
        const amount = String(h.amount);
        if (text.textContent !== amount) text.textContent = amount;
        const fontSize = `${h.fontSize}px`;
        if (text.style.fontSize !== fontSize) text.style.fontSize = fontSize;
      }

      // translate3d instead of left/top: transforms are composited and do not
      // dirty layout, so a moving hitsplat does not force a full document
      // relayout every frame.
      el.style.transform = `translate3d(${h.screenX - h.width / 2}px, ${h.screenY - h.height / 2}px, 0px)`;
    }
  }, []);

  const updateTileMarkerLabels = useCallback((labels: TileMarkerLabelOverlay[]) => {
    const container = tileMarkerLabelContainerRef.current;
    if (!container) return;

    while (container.children.length > labels.length) {
      container.removeChild(container.lastChild!);
    }

    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      let span = container.children[i] as HTMLSpanElement | undefined;

      if (!span) {
        span = document.createElement('span');
        span.style.position = 'absolute';
        // Anchored at the origin and moved by transform, so per-frame movement
        // does not dirty layout.
        span.style.left = '0';
        span.style.top = '0';
        span.style.pointerEvents = 'none';
        span.style.fontFamily = "'RuneScape Small', sans-serif";
        span.style.fontSize = '16px';
        span.style.lineHeight = '1';
        span.style.whiteSpace = 'nowrap';
        span.style.textShadow = '1px 1px 0 #000';
        span.style.setProperty('-webkit-font-smoothing', 'none');
        span.style.setProperty('font-smooth', 'never');
        // The -50% centering is folded into the per-frame transform below.
        container.appendChild(span);
      }
      if (span.textContent !== label.text) span.textContent = label.text;
      // translate3d carries the position and keeps the original -50% centering,
      // replacing the layout-affecting left/top writes.
      const transform = `translate3d(${label.screenX}px, ${label.screenY}px, 0px) translate(-50%, -50%)`;
      if (span.style.transform !== transform) span.style.transform = transform;
      if (span.style.color !== label.color) span.style.color = label.color;
    }
  }, []);

  const updateHealthBars = useCallback((bars: HealthBarOverlay[]) => {
    const root = hitsplatContainerRef.current;
    if (!root) return;

    let barContainer = root.querySelector('[data-healthbars]') as HTMLDivElement | null;
    if (bars.length === 0) {
      if (barContainer) barContainer.remove();
      return;
    }

    if (!barContainer) {
      barContainer = document.createElement('div');
      barContainer.setAttribute('data-healthbars', 'true');
      barContainer.style.position = 'absolute';
      barContainer.style.top = '0';
      barContainer.style.left = '0';
      barContainer.style.pointerEvents = 'none';
      barContainer.style.zIndex = `${OVERLAY_LAYER_Z_INDEX.healthBars}`;
      root.appendChild(barContainer);
    }

    while (barContainer.children.length > bars.length) {
      barContainer.removeChild(barContainer.lastChild!);
    }

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      let wrapper = barContainer.children[i] as HTMLDivElement | undefined;

      if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.style.position = 'absolute';
        // Positioned by transform, not left/top, so per-frame movement never
        // invalidates layout. See the write below.
        wrapper.style.left = '0';
        wrapper.style.top = '0';
        wrapper.style.pointerEvents = 'none';
        wrapper.style.imageRendering = 'pixelated';
        wrapper.style.willChange = 'transform, opacity';

        const bgImg = document.createElement('img');
        bgImg.crossOrigin = IMAGE_CROSS_ORIGIN;
        bgImg.setAttribute('data-role', 'bg');
        bgImg.style.position = 'absolute';
        bgImg.style.top = '0';
        bgImg.style.left = '0';
        bgImg.style.width = '100%';
        bgImg.style.height = '100%';
        bgImg.style.display = 'block';
        bgImg.style.imageRendering = 'pixelated';
        bgImg.style.pointerEvents = 'none';
        // The data-src guard below stops the per-frame src rewrite, but it would
        // also stop a failed sprite ever retrying. Clearing it on error lets the
        // next frame retry the load, without reassigning src on every frame.
        bgImg.addEventListener('error', () => {
          bgImg.removeAttribute('data-src');
        });
        wrapper.appendChild(bgImg);

        const fgClip = document.createElement('div');
        fgClip.setAttribute('data-role', 'fg-clip');
        fgClip.style.position = 'absolute';
        fgClip.style.top = '0';
        fgClip.style.left = '0';
        fgClip.style.height = '100%';
        fgClip.style.overflow = 'hidden';

        const fgImg = document.createElement('img');
        fgImg.crossOrigin = IMAGE_CROSS_ORIGIN;
        fgImg.setAttribute('data-role', 'fg');
        fgImg.style.display = 'block';
        fgImg.style.width = '0';
        fgImg.style.height = '100%';
        fgImg.style.imageRendering = 'pixelated';
        fgImg.style.pointerEvents = 'none';
        fgImg.addEventListener('error', () => {
          fgImg.removeAttribute('data-src');
        });
        fgClip.appendChild(fgImg);

        wrapper.appendChild(fgClip);
        barContainer.appendChild(wrapper);
      }

      const barW = bar.width;
      const barH = bar.height;
      // width/height affect layout, so they are written only on change - they are
      // constant for a given bar size, and rewriting them unconditionally dirtied
      // layout every frame.
      const wrapperWidth = `${barW}px`;
      const wrapperHeight = `${barH}px`;
      if (wrapper.style.width !== wrapperWidth) wrapper.style.width = wrapperWidth;
      if (wrapper.style.height !== wrapperHeight) wrapper.style.height = wrapperHeight;
      // translate3d instead of left/top: composited, and does not dirty layout.
      wrapper.style.transform = `translate3d(${bar.screenX - barW / 2}px, ${bar.screenY - barH / 2}px, 0px)`;

      // Fixed child order (bg, fg-clip > fg), so index access replaces three
      // per-bar selector queries on every frame.
      const bgImg = wrapper.children[0] as HTMLImageElement | undefined;
      const bgUrl = `/assets/ui/healthbar/default_back_${barW}px.png`;
      // Compared through a data attribute, not `img.src`: the getter returns the
      // resolved absolute URL, so comparing it against this relative path would
      // never match and would re-assign `src` on every bar on every frame.
      if (bgImg && bgImg.getAttribute('data-src') !== bgUrl) {
        bgImg.src = bgUrl;
        bgImg.setAttribute('data-src', bgUrl);
      }

      const fgClip = wrapper.children[1] as HTMLDivElement | undefined;
      const fgImg = fgClip?.children[0] as HTMLImageElement | undefined;
      if (fgClip && fgImg) {
        const fgUrl = `/assets/ui/healthbar/default_front_${barW}px.png`;
        if (fgImg.getAttribute('data-src') !== fgUrl) {
          fgImg.src = fgUrl;
          fgImg.setAttribute('data-src', fgUrl);
        }
        // The clip width only moves when the bar's fill ratio changes, so guard it
        // rather than dirtying layout on every frame.
        const clipWidth = `${healthBarFillWidthPx(bar.ratio, barW)}px`;
        if (fgClip.style.width !== clipWidth) fgClip.style.width = clipWidth;
        const fgWidth = `${barW}px`;
        if (fgImg.style.width !== fgWidth) fgImg.style.width = fgWidth;
      }

      if (wrapper.style.opacity !== '1') wrapper.style.opacity = '1';
    }
  }, []);

  const updateTimerBars = useCallback((bars: TimerBarOverlay[]) => {
    const root = hitsplatContainerRef.current;
    if (!root) return;

    let barContainer = root.querySelector('[data-timerbars]') as HTMLDivElement | null;
    if (bars.length === 0) {
      if (barContainer) barContainer.remove();
      return;
    }

    if (!barContainer) {
      barContainer = document.createElement('div');
      barContainer.setAttribute('data-timerbars', 'true');
      barContainer.style.position = 'absolute';
      barContainer.style.top = '0';
      barContainer.style.left = '0';
      barContainer.style.pointerEvents = 'none';
      barContainer.style.zIndex = `${OVERLAY_LAYER_Z_INDEX.timerBars}`;
      root.appendChild(barContainer);
    }

    while (barContainer.children.length > bars.length) {
      barContainer.removeChild(barContainer.lastChild!);
    }

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      let wrapper = barContainer.children[i] as HTMLDivElement | undefined;

      if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.style.position = 'absolute';
        wrapper.style.pointerEvents = 'none';
        wrapper.style.imageRendering = 'pixelated';
        wrapper.style.willChange = 'transform, opacity';

        const bgImg = document.createElement('img');
        bgImg.crossOrigin = IMAGE_CROSS_ORIGIN;
        bgImg.setAttribute('data-role', 'bg');
        bgImg.style.position = 'absolute';
        bgImg.style.top = '0';
        bgImg.style.left = '0';
        bgImg.style.width = '100%';
        bgImg.style.height = '100%';
        bgImg.style.display = 'block';
        bgImg.style.imageRendering = 'pixelated';
        bgImg.style.pointerEvents = 'none';
        wrapper.appendChild(bgImg);

        const fgClip = document.createElement('div');
        fgClip.setAttribute('data-role', 'fg-clip');
        fgClip.style.position = 'absolute';
        fgClip.style.top = '0';
        fgClip.style.left = '0';
        fgClip.style.height = '100%';
        fgClip.style.overflow = 'hidden';

        const fgImg = document.createElement('img');
        fgImg.crossOrigin = IMAGE_CROSS_ORIGIN;
        fgImg.setAttribute('data-role', 'fg');
        fgImg.style.display = 'block';
        fgImg.style.width = '0';
        fgImg.style.height = '100%';
        fgImg.style.imageRendering = 'pixelated';
        fgImg.style.pointerEvents = 'none';
        fgClip.appendChild(fgImg);

        wrapper.appendChild(fgClip);
        barContainer.appendChild(wrapper);
      }

      const barW = bar.width;
      const barH = bar.height;
      wrapper.style.width = `${barW}px`;
      wrapper.style.height = `${barH}px`;
      wrapper.style.left = `${bar.screenX - barW / 2}px`;
      wrapper.style.top = `${bar.screenY - barH / 2}px`;

      const bgImg = wrapper.querySelector('[data-role="bg"]') as HTMLImageElement;
      const npcBgUrl = `/assets/ui/healthbar/dark_back_${barW}px.png`;
      if (bgImg && bgImg.src !== npcBgUrl) {
        bgImg.src = npcBgUrl;
      }

      const fgClip = wrapper.querySelector('[data-role="fg-clip"]') as HTMLDivElement;
      const fgImg = wrapper.querySelector('[data-role="fg"]') as HTMLImageElement;
      if (fgClip && fgImg) {
        const npcFgUrl = `/assets/ui/healthbar/yellow_front_${barW}px.png`;
        if (fgImg.src !== npcFgUrl) {
          fgImg.src = npcFgUrl;
        }
        const clipW = Math.max(0, bar.ratio * barW);
        fgClip.style.width = `${clipW}px`;
        fgImg.style.width = `${barW}px`;
      }

      wrapper.style.opacity = '1';
    }
  }, []);

  // The scene boundary. The viewport, its canvas and the renderer's WebGL context outlast
  // scenes: remounting per encounter created a new context every time (the iPad report
  // shows a second context-created on entering Sol Heredit, lost two seconds later). Here
  // the previous scene ends: its builder and GPU meshes go, its runtime is rebuilt by the
  // same initializer as a first mount, its overlays are cleared, and input that was bound
  // to it is let go. The context, programs and texture array stay.
  useLayoutEffect(() => {
    if (sceneBuilderRef.current === sceneBuilder) return;
    sceneBuilderRef.current.dispose?.();
    sceneBuilderRef.current = sceneBuilder;
    sceneLoadVersionRef.current += 1;
    renderer.releaseSceneMeshes?.();
    sceneRuntimeRef.current = createSceneRuntime(simulationStateRef.current, animationFrames.clock.now());

    updateOverheadIcons([]);
    updateOverheadTexts([]);
    updateTileMarkerLabels([]);
    updateHitsplats([]);
    updateHealthBars([]);
    updateTimerBars([]);
    updateTickCounters([]);

    // Freeform look needs the pointer lock, which removing the outgoing canvas would end.
    // A touch gesture or click marker in flight is left to finish: both act on the
    // camera and screen, which outlast the scene.
    cameraDragButtonRef.current = null;
    isPointerLockedRef.current = false;
    if (canvasRef.current && document.pointerLockElement === canvasRef.current) document.exitPointerLock();
    projection3DRef.current.setCameraMode('orbit');
    setCameraMode('orbit');
  }, [
    sceneBuilder,
    renderer,
    updateOverheadIcons,
    updateOverheadTexts,
    updateTileMarkerLabels,
    updateHitsplats,
    updateHealthBars,
    updateTimerBars,
    updateTickCounters,
  ]);

  useEffect(() => {
    const unsubscribeResume = animationFrames.subscribeResume(() => {
      resetTimingRef.current = true;
    });
    const renderScene = (
      renderStore: ReplayFrameStore | null,
      renderEpoch: number | undefined,
      replaySnapshot: ReplayFrameSnapshot | undefined,
      replayPresentation: ReturnType<typeof getReplayPresentation> | undefined,
    ): boolean => {
      const projection3D = projection3DRef.current;
      const recordedReplayViewportState = replaySnapshot?.viewportState ?? replayViewportStatePropRef.current;
      replayViewportStateRef.current = recordedReplayViewportState;
      const replayCameraActive = replayIsReplayingRef.current && recordedReplayViewportState !== undefined;
      const replayCameraLocked = replayCameraActive;
      if (replayCameraLocked && recordedReplayViewportState) {
        cameraDragButtonRef.current = null;
        applyReplayViewportState(recordedReplayViewportState);
      }

      const now = animationFrames.clock.now();
      const deltaTime = Math.min(now - sceneRuntimeRef.current.lastFrameTimeMs, 50);
      sceneRuntimeRef.current.lastFrameTimeMs = now;

      const ordinaryPaused = replayPresentation?.previewing || replayPausedRef.current;
      if (ordinaryPaused && !replayPresentation) {
        sceneRuntimeRef.current.lastTickTimeMs = now;
      }

      const elapsed = now - sceneRuntimeRef.current.lastTickTimeMs;
      const tickIntervalMs = 600 / speedMultiplierRef.current;
      const currentState = replayPresentation?.state ?? simulationStateRef.current;
      const restoration = !replayIsReplayingRef.current ? restoredPresentationRef.current : undefined;
      const restoredSample = !replayPresentation
        ? sceneRuntimeRef.current.restoredClock.sample(
            restoration,
            engineRef.current,
            currentState.currentTick,
            elapsed,
            speedMultiplierRef.current,
          )
        : undefined;
      const paused = ordinaryPaused || restoredSample?.held === true;
      const tickProgress =
        replayPresentation?.tickProgress ?? restoredSample?.tickProgress ?? Math.min(elapsed / tickIntervalMs, 1.0);
      const interpolatedTick =
        replayPresentation?.interpolatedTick ??
        restoredSample?.interpolatedTick ??
        currentState.currentTick + tickProgress;
      const actorDeltaMs = restoredSample?.deltaMs ?? deltaTime;
      // Publish for infobox timers. Only timer text subscribes, and it snapshots
      // the whole second, so this notification is a no-op on the frames where the
      // displayed value has not changed.
      tickProgressStore?.set(interpolatedTick);
      const tracker = sceneRuntimeRef.current.tracker;

      const previousObservedTick = sceneRuntimeRef.current.lastObservedTick;
      const tickDelta = currentState.currentTick - previousObservedTick;
      // A timeline swap (live ↔ replay, Take Over, scene load) can land on the
      // SAME tick number, so tickDelta alone misses it and the tracker would
      // keep sliding along the previous timeline's queued path. Treat it like a
      // rewind: snap to the new timeline's position/facing.
      const observedTimelineKey = replayTimelineKeyRef.current ?? 'live';
      const previousTimelineKey = sceneRuntimeRef.current.lastObservedTimelineKey;
      const timelineChanged = previousTimelineKey !== undefined && previousTimelineKey !== observedTimelineKey;
      sceneRuntimeRef.current.lastObservedTimelineKey = observedTimelineKey;
      let replayDeltaMs = 0;
      let movementPath = currentState.playerMovementPath;
      let trackerSnapped = false;
      if (replayPresentation) {
        const timeMs = (replayPresentation.frameIndex + replayPresentation.tickProgress) * OSRS_TICK_MS;
        const previous = sceneRuntimeRef.current.lastReplayFrame;
        if (
          !previous ||
          timeMs < previous.timeMs ||
          timelineChanged ||
          tickDelta > 1 ||
          previous.history?.frames !== replayPresentation.replayHistory?.frames
        ) {
          tracker.reset(...replayPresentation.playerVisual.position);
          tracker.facingAngle =
            replayPresentation.tickProgress === 0
              ? currentState.playerFacingAngle
              : replayPresentation.playerVisual.facingAngle;
          movementPath = movementPath.slice(Math.floor(replayPresentation.tickProgress * movementPath.length));
        } else {
          replayDeltaMs = timeMs - previous.timeMs;
        }
        sceneRuntimeRef.current.lastReplayFrame = { timeMs, history: replayPresentation.replayHistory };
      } else if (restoredSample?.firstFrame) {
        const position = restoredSample.held ? currentState.playerPosition : currentState.playerPreviousPosition;
        tracker.reset(position[0], position[1]);
        tracker.facingAngle = currentState.playerFacingAngle;
        tracker.lastProcessedTick = restoredSample.held ? currentState.currentTick : currentState.currentTick - 1;
      } else if (
        timelineChanged ||
        paused ||
        // A rewind onto the tile the in-flight step is already heading for (a restart where the player
        // stands) lets that step finish rather than jumping the model there.
        (tickDelta < 0 && !tracker.routeEndsOn(currentState.playerPosition))
      ) {
        tracker.reset(currentState.playerPosition[0], currentState.playerPosition[1]);
        tracker.facingAngle = currentState.playerFacingAngle;
        trackerSnapped = true;
        if (paused) {
          tracker.lastProcessedTick = currentState.currentTick;
        }
      } else if (tickDelta > 1) {
        if (tickDelta > 8) {
          tracker.reset(currentState.playerPosition[0], currentState.playerPosition[1]);
          tracker.facingAngle = currentState.playerFacingAngle;
          trackerSnapped = true;
        }
        tracker.lastProcessedTick = currentState.currentTick - 1;
      }
      if (currentState.currentTick !== previousObservedTick) {
        sceneRuntimeRef.current.lastObservedTick = currentState.currentTick;
      }
      if (!replayPresentation) sceneRuntimeRef.current.lastReplayFrame = null;

      // Countdown positioning moves the player while the tick stays 0, which the tick test below
      // never sees. A step seen on a frame that snapped the tracker is already in that snap.
      const preparation =
        replayPresentation || replayIsReplayingRef.current
          ? null
          : (getStartPositionPreparationRef.current?.() ?? null);
      const seenPreparation = sceneRuntimeRef.current.lastStartPositionPreparation;
      if (
        preparation &&
        (preparation.boundary !== seenPreparation?.boundary || preparation.sequence > seenPreparation.sequence)
      ) {
        sceneRuntimeRef.current.lastStartPositionPreparation = {
          boundary: preparation.boundary,
          sequence: preparation.sequence,
        };
        if (!trackerSnapped) tracker.enqueueSteps(preparation.step.stepTiles, preparation.step.isRunning);
      }

      // The sim can also place the player without a tick: a restart from a run still on tick 0 (its
      // countdown or landing), or a tick-zero setup edit that moves the start. The tick test below
      // never sees those, so the same unwalked-placement rule runs on the tile changing. A countdown
      // step is not one: its route is queued above (its descriptor arrives no later than its state).
      const observedTile = currentState.playerPosition;
      const lastTile = sceneRuntimeRef.current.lastObservedPlayerTile;
      const placedWithoutTick =
        !replayPresentation &&
        !trackerSnapped &&
        currentState.currentTick === tracker.lastProcessedTick &&
        (observedTile[0] !== lastTile[0] || observedTile[1] !== lastTile[1]);
      sceneRuntimeRef.current.lastObservedPlayerTile = [observedTile[0], observedTile[1]];

      let teleported = false;
      if (currentState.currentTick !== tracker.lastProcessedTick) {
        tracker.enqueueTickMovement(currentState.currentTick, movementPath, currentState.playerIsRunning);
        teleported = tracker.snapToUnwalkedPlacement(currentState.playerPosition, currentState.playerFacingAngle);
        if (movementPath.length === 0) {
          tracker.setTargetAngle(currentState.playerFacingAngle);
        }
        tracker.setInteracting(!!currentState.attackTarget);
        tracker.setForcedFacingAngle(currentState.attackTarget ? currentState.playerFacingAngle : null);
      } else if (placedWithoutTick) {
        teleported = tracker.snapToUnwalkedPlacement(currentState.playerPosition, currentState.playerFacingAngle);
      }

      const primaryAnimMovementBlock = sceneBuilderRef.current.getPrimaryAnimMovementBlock?.() ?? {
        blocksRunning: false,
        blocksWalking: false,
      };
      tracker.setPrimaryAnimBlocking(primaryAnimMovementBlock.blocksRunning, primaryAnimMovementBlock.blocksWalking);

      const playerVisual = replayPresentation
        ? tracker.advance(replayDeltaMs, 1)
        : tracker.advance(
            restoredSample?.firstFrame && !restoredSample.held ? tickProgress * tickIntervalMs : actorDeltaMs,
            speedMultiplierRef.current,
          );

      // Before any camera input: a cutscene's view freezes the player's angles and zoom until it ends.
      const cutscene = sceneBuilderRef.current.getCutsceneFrame?.(currentState, interpolatedTick) ?? null;
      projection3D.setScriptedCamera(cutscene?.camera ?? null);
      const fadeOverlay = cutsceneFadeRef.current;
      if (fadeOverlay) {
        const opacity = String(cutscene?.fadeOpacity ?? 0);
        if (fadeOverlay.style.opacity !== opacity) fadeOverlay.style.opacity = opacity;
      }

      // Both gates belong here rather than on the store's keydown path: filtering at
      // record time strands any key held across the moment focus enters a text field
      // or a replay starts, because the keyup is then filtered too.
      const cameraKeysInert = replayCameraLocked || isEditableTarget(document.activeElement);
      const isActionActive = (action: CameraAction): boolean => {
        if (cameraKeysInert) return false;
        const key = cameraKeybindsRef.current[action];
        return !!key && isKeyHeld(key);
      };

      if (projection3D.getCameraMode() === 'freeform') {
        const moveSpeed = 15 * (deltaTime / 1000);
        let forward = 0,
          right = 0,
          up = 0;

        if (isActionActive('freeformForward')) forward += moveSpeed;
        if (isActionActive('freeformBackward')) forward -= moveSpeed;
        if (isActionActive('freeformLeft')) right -= moveSpeed;
        if (isActionActive('freeformRight')) right += moveSpeed;
        if (isActionActive('freeformUp')) up += moveSpeed;
        if (isActionActive('freeformDown')) up -= moveSpeed;

        if (!replayCameraLocked && (forward !== 0 || right !== 0 || up !== 0)) {
          projection3D.moveFreeform(forward, right, up);
        }
      } else if (replayCameraActive || replayCameraLocked) {
        const rotateSpeed = 120 * cameraSpeedRef.current * (deltaTime / 1000);
        const tiltSpeed = 60 * cameraSpeedRef.current * (deltaTime / 1000);
        const state = projection3D.getCameraState();
        const orbitUpdate: Partial<OrbitCameraState> = {};

        if (!replayCameraLocked && isActionActive('orbitRotateLeft')) orbitUpdate.yaw = state.yaw - rotateSpeed;
        if (!replayCameraLocked && isActionActive('orbitRotateRight'))
          orbitUpdate.yaw = (orbitUpdate.yaw ?? state.yaw) + rotateSpeed;
        if (!replayCameraLocked && isActionActive('orbitTiltUp')) orbitUpdate.pitch = state.pitch - tiltSpeed;
        if (!replayCameraLocked && isActionActive('orbitTiltDown'))
          orbitUpdate.pitch = (orbitUpdate.pitch ?? state.pitch) + tiltSpeed;

        if (orbitUpdate.yaw !== undefined || orbitUpdate.pitch !== undefined) {
          projection3D.updateCamera(orbitUpdate);
          onCameraChangeRef.current?.(projection3D.getCameraState());
        }
      } else {
        const visualPos = playerVisual.position;

        const targetX = visualPos[0] + 0.5;
        const targetY = visualPos[1] + 0.5;

        const dx = targetX - sceneRuntimeRef.current.cameraTarget.x;
        const dy = targetY - sceneRuntimeRef.current.cameraTarget.y;

        // A teleport cuts the camera to the new tile as the game does, however short the jump.
        if (teleported || Math.abs(dx) > FOLLOW_SNAP_TILES || Math.abs(dy) > FOLLOW_SNAP_TILES) {
          sceneRuntimeRef.current.cameraTarget.x = targetX;
          sceneRuntimeRef.current.cameraTarget.y = targetY;
        } else {
          const followFactor = 1 - FOLLOW_RETAIN ** (deltaTime / OSRS_FRAME_MS);
          sceneRuntimeRef.current.cameraTarget.x += dx * followFactor;
          sceneRuntimeRef.current.cameraTarget.y += dy * followFactor;
        }

        // Focal height is set directly each frame, deliberately not smoothed: smoothing it
        // makes the camera lag vertically when the player steps onto a height change.
        const desiredZ = projection3D.getPlayerCenterZ(targetX, targetY);
        sceneRuntimeRef.current.cameraTarget.z = desiredZ;

        const orbitUpdate: Partial<OrbitCameraState> = {
          targetX: sceneRuntimeRef.current.cameraTarget.x,
          targetY: sceneRuntimeRef.current.cameraTarget.y,
          targetZ: sceneRuntimeRef.current.cameraTarget.z,
        };

        const rotateSpeed = 120 * cameraSpeedRef.current * (deltaTime / 1000);
        const tiltSpeed = 60 * cameraSpeedRef.current * (deltaTime / 1000);
        const previousCameraState = projection3D.getCameraState();

        if (isActionActive('orbitRotateLeft')) orbitUpdate.yaw = previousCameraState.yaw - rotateSpeed;
        if (isActionActive('orbitRotateRight'))
          orbitUpdate.yaw = (orbitUpdate.yaw ?? previousCameraState.yaw) + rotateSpeed;
        if (isActionActive('orbitTiltUp')) orbitUpdate.pitch = previousCameraState.pitch - tiltSpeed;
        if (isActionActive('orbitTiltDown'))
          orbitUpdate.pitch = (orbitUpdate.pitch ?? previousCameraState.pitch) + tiltSpeed;

        projection3D.updateCamera(orbitUpdate);
        projection3D.stepTerrainPitch(deltaTime);
        const currentCameraState = projection3D.getCameraState();

        if (onCameraChangeRef.current && didOrbitCameraStateChange(previousCameraState, currentCameraState)) {
          onCameraChangeRef.current(currentCameraState);
        }
      }

      if (lastCanvasMouseRef.current.x >= 0) {
        const pos = lastCanvasMouseRef.current;
        const tile = projection3D.screenToTile(pos);
        const newTile = tile ? ([tile.x, tile.y] as Coordinate) : null;
        sceneRuntimeRef.current.hoveredTile = newTile;
        onHoveredTileChangeRef.current?.(newTile, pos);
      }

      const ctx: RenderContext = {
        simulationState: currentState,
        events: replayPresentation?.events ?? eventOverridesRef.current ?? engineRef.current?.getLastTickEvents() ?? [],
        options: {
          renderMode: '3d',
          showCoordinates: showCoordinatesRef.current,
          tileGrid: tileGridRef.current,
          showNpcClickbox: showNpcClickboxRef.current,
          showTileMarkers: showTileMarkersRef.current,
          showNpcHighlights: showNpcHighlightsRef.current,
          showTileMarkerLabels: showTileMarkerLabelsRef.current,
          tileMarkerWidth: tileMarkerWidthRef.current,
          showLineMarkers: showLineMarkersRef.current,
          showLineMarkerLabels: showLineMarkerLabelsRef.current,
          lineMarkerWidth: lineMarkerWidthRef.current,
          smoothTerrain: smoothTerrainRef.current,
          playerOverheadNumbers: playerOverheadNumbersRef.current,
          showAttackTimerMetronome: showAttackTimerMetronomeRef.current,
          showNpcAttackTimerMetronome: showNpcAttackTimerMetronomeRef.current,
          entityHider: entityHiderRef.current,
          tzhaarHpTracker: tzhaarHpTrackerRef.current,
          pillarAdditions: pillarAdditionsRef.current,
          brightness: brightnessRef.current,
          contrast: contrastRef.current,
          saturation: saturationRef.current,
          encounterDebugFlags: encounterDebugFlagsRef.current || {},
          tileIndicatorConfig: tileIndicatorConfigRef.current,
        },
        interaction: {
          hoveredTile: sceneRuntimeRef.current.hoveredTile,
          targetTile: getTargetTileRef.current ? getTargetTileRef.current() : targetTileRef.current,
        },
        interpolatedTick,
        frameDeltaMs: replayPresentation ? replayDeltaMs / speedMultiplierRef.current : actorDeltaMs,
        restoredPresentation: restoration,
        speedMultiplier: speedMultiplierRef.current,
        playerVisual,
        tileMarkers: tileMarkersRef.current,
        lineMarkers: lineMarkersRef.current,
        npcHighlights: npcHighlightsRef.current,
        replayPaused: paused,
        timeline: {
          timelineKey: replayTimelineKeyRef.current ?? 'live',
          paused,
          timeMs: replayPresentation?.timeMs ?? restoredSample?.timeMs,
        },
        replayHistory: replayPresentation?.replayHistory ?? replayHistoryRef.current,
        fightStartCountdown: fightStartCountdownRef.current,
      };

      frameProfiler.beginFrame();

      frameProfiler.beginPhase('sceneBuild');
      const queue = sceneBuilder.build(ctx, projection3D, viewport);
      frameProfiler.endPhase('sceneBuild');
      if (
        replayPresentation &&
        renderStore &&
        (renderEpoch !== renderStore.getRenderEpoch() || renderStore.getRenderFailure())
      )
        return false;

      const updatedBlock = sceneBuilderRef.current.getPrimaryAnimMovementBlock?.() ?? {
        blocksRunning: false,
        blocksWalking: false,
      };
      tracker.setPrimaryAnimBlocking(updatedBlock.blocksRunning, updatedBlock.blocksWalking);

      const camera = createCamera3D(projection3D);

      frameProfiler.beginPhase('gpuRender');
      renderer.render({ camera, queue });
      frameProfiler.endPhase('gpuRender');
      updateOverheadIcons(queue.overheadIcons ?? []);
      updateOverheadTexts(queue.overheadTexts ?? []);
      updateTileMarkerLabels(queue.tileMarkerLabels ?? []);
      updateHitsplats(queue.hitsplats ?? []);
      updateHealthBars(queue.healthBars ?? []);
      updateTimerBars(queue.timerBars ?? []);
      updateTickCounters(queue.tickCounters ?? []);

      frameProfiler.endFrame();

      frameCountRef.current++;
      const fpsElapsed = now - lastFpsUpdateRef.current;
      if (fpsElapsed >= 1000) {
        const currentFps = Math.round((frameCountRef.current * 1000) / fpsElapsed);
        fpsReporter.report(currentFps);
        if (onFpsUpdateRef.current) {
          onFpsUpdateRef.current(currentFps);
        }
        frameCountRef.current = 0;
        lastFpsUpdateRef.current = now;
      }

      if (
        replayPresentation &&
        !paused &&
        queue.replayPresentationReady &&
        renderEpoch !== undefined &&
        replaySnapshot
      ) {
        renderStore?.acknowledgeRender(renderEpoch, replayPresentation.frameIndex, replaySnapshot.playheadMs);
      }
      return true;
    };

    const render = () => {
      if (resetTimingRef.current) {
        const now = animationFrames.clock.now();
        nextFrameDeadlineRef.current = -1;
        frameCountRef.current = 0;
        lastFpsUpdateRef.current = now;
        resetTimingRef.current = false;
      }
      // While the context is lost or failed nothing can be drawn, so skip the scene
      // build too; keep polling so drawing resumes the frame after a restore.
      if (!rendererInitRef.current || rendererStatusRef.current.kind !== 'ok') {
        animationFrameRef.current = animationFrames.request(render);
        return;
      }

      // FPS cap: when set (>0), skip GPU work on frames that arrive before the
      // next scheduled deadline. We reschedule via rAF but do NOT advance
      // interpolation, build the scene, or call renderer.render() — so the GPU
      // and CPU genuinely idle on skipped frames rather than rendering at vsync.
      // The deadline advances by exactly one frame budget per rendered frame so
      // the average rate hits the target even on a faster-refreshing display
      // (e.g. a 60fps cap on a 144Hz monitor renders ~60fps, not ~48fps).
      const fpsCap = fpsCapRef.current;
      if (fpsCap > 0) {
        const frameBudgetMs = 1000 / fpsCap;
        const t = performance.now();
        if (nextFrameDeadlineRef.current < 0) {
          nextFrameDeadlineRef.current = t + frameBudgetMs;
        } else if (t < nextFrameDeadlineRef.current) {
          animationFrameRef.current = animationFrames.request(render);
          return;
        } else {
          nextFrameDeadlineRef.current += frameBudgetMs;
          // Resync if we fell more than a full budget behind (e.g. tab was
          // backgrounded) so we don't burst-render a backlog of frames.
          if (nextFrameDeadlineRef.current < t - frameBudgetMs) {
            nextFrameDeadlineRef.current = t + frameBudgetMs;
          }
        }
      } else {
        nextFrameDeadlineRef.current = -1;
      }

      const replaying = replayIsReplayingRef.current;
      const renderStore = replayFrameStoreRef.current;
      const renderEpoch = renderStore?.getRenderEpoch();
      const replaySnapshot = renderStore?.getSnapshot();
      if (replaying && renderStore?.getRenderFailure()) {
        animationFrameRef.current = animationFrames.request(render);
        return;
      }
      let replayPresentation: ReturnType<typeof getReplayPresentation> | undefined;
      try {
        replayPresentation = replaying
          ? getReplayPresentation(replaySnapshot, {
              frameIndex: replayFrameIndexRef.current,
              state: simulationStateRef.current,
              events: eventOverridesRef.current ?? [],
            })
          : undefined;
        // Only a frame that reached the renderer counts; an invalidated replay epoch does not.
        if (renderScene(renderStore, renderEpoch, replaySnapshot, replayPresentation)) {
          sceneRuntimeRef.current.consecutiveLiveFailures = 0;
          // Any drawn frame, live or replay, proves an earlier live-loop failure obsolete;
          // left set it would hold the simulation behind a canvas that is drawing again.
          if (liveLoopFailedRef.current) {
            liveLoopFailedRef.current = false;
            publishRenderStatus();
          }
        }
      } catch (error) {
        if (!replaying || !renderStore || renderEpoch === undefined) {
          // The scheduler drops a callback before invoking it, so letting this escape
          // would end the loop for good while the simulation keeps ticking behind a
          // frozen canvas. Report the first failure of each run, then retry a bounded number of frames.
          sceneRuntimeRef.current.consecutiveLiveFailures += 1;
          if (sceneRuntimeRef.current.consecutiveLiveFailures === 1) {
            log.error(
              'Renderer',
              'Live frame render failed',
              error instanceof Error ? error : new Error('Live rendering failed'),
            );
          }
          if (sceneRuntimeRef.current.consecutiveLiveFailures >= MAX_CONSECUTIVE_LIVE_FRAME_FAILURES) {
            liveLoopFailedRef.current = true;
            publishRenderStatus();
            log.warn(
              'Renderer',
              `Live render loop stopped after ${sceneRuntimeRef.current.consecutiveLiveFailures} failed frames`,
            );
            return;
          }
          animationFrameRef.current = animationFrames.request(render);
          return;
        }
        renderStore.failRender(renderEpoch, {
          error: error instanceof Error ? error : new Error('Replay rendering failed'),
          frameIndex:
            replayPresentation?.frameIndex ?? replaySnapshot?.preview?.frameIndex ?? replayFrameIndexRef.current,
          playheadMs:
            replaySnapshot?.playheadMs ?? frameStartMs(replaySnapshot?.history ?? [], replayFrameIndexRef.current),
        });
      }

      animationFrameRef.current = animationFrames.request(render);
    };

    animationFrameRef.current = animationFrames.request(render);

    return () => {
      unsubscribeResume();
      if (animationFrameRef.current) {
        animationFrames.cancel(animationFrameRef.current);
      }
      // The projection outlives this loop: a cutscene must not keep holding it.
      projection3DRef.current.setScriptedCamera(null);
    };
  }, [
    sceneBuilder,
    viewport,
    renderer,
    applyReplayViewportState,
    updateOverheadIcons,
    updateOverheadTexts,
    updateTileMarkerLabels,
    updateHitsplats,
    updateHealthBars,
    updateTimerBars,
    updateTickCounters,
    tickProgressStore,
    publishRenderStatus,
  ]);

  const requestContextMenu = useCallback(
    (clientX: number, clientY: number, withExtras: boolean): ViewportInputOwnership => {
      const canvas = canvasRef.current;
      if (!canvas) return { kind: 'none' };
      const { x, y } = toElementLocalPoint(canvas, clientX, clientY);
      const tile = projection3DRef.current.screenToTile({ x, y });
      return (
        onContextMenuProp?.(tile ? [tile.x, tile.y] : null, clientX, clientY, { x, y }, withExtras) ?? { kind: 'none' }
      );
    },
    [onContextMenuProp],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (isWatchInputGated()) return;

      if (e.button === 0) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const { x, y } = toElementLocalPoint(canvas, e.clientX, e.clientY);
        if (onVoidClickProp?.({ x, y }, e.ctrlKey)) {
          triggerClickAnim(e.clientX, e.clientY, 'red');
          onReplayCursorClickRef.current?.(e.clientX, e.clientY, 'red', e.timeStamp);
        } else {
          const tile = projection3DRef.current.screenToTile({ x, y });
          if (tile) {
            const clickType = leftClickTypeRef.current;
            onReplayCursorClickRef.current?.(e.clientX, e.clientY, clickType, e.timeStamp);
            onTileClick([tile.x, tile.y], e.ctrlKey);
            triggerClickAnim(e.clientX, e.clientY, clickType);
          }
        }
      } else if (e.button === 2) {
        if (e.altKey) return;
        // Firefox reserves Shift+right-click for its own native menu (the contextmenu
        // event never fires), so Ctrl+right-click is offered as an equivalent trigger
        // for the shift-gated extras (tile markers / NPC highlights). Gated on button 2,
        // so macOS ctrl+left-click (button 0) is unaffected.
        const ownership = requestContextMenu(e.clientX, e.clientY, e.shiftKey || e.ctrlKey);
        switch (ownership.kind) {
          case 'camera-drag':
            if (
              cameraDragButtonRef.current !== 'middle' &&
              !(replayIsReplayingRef.current && replayViewportStateRef.current)
            ) {
              cameraDragButtonRef.current = 'right';
              lastMouseRef.current = { x: e.clientX, y: e.clientY };
            }
            break;
          case 'claimed':
          case 'none':
            break;
          default: {
            const exhaustiveOwnership: never = ownership;
            throw new TypeError(`Unsupported viewport input ownership: ${String(exhaustiveOwnership)}`);
          }
        }
      }
    },
    [onTileClick, triggerClickAnim, requestContextMenu, onVoidClickProp],
  );

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const releasedButton = e.button === 1 ? 'middle' : e.button === 2 ? 'right' : null;
    if (releasedButton && cameraDragButtonRef.current === releasedButton) {
      cameraDragButtonRef.current = null;
    }
  }, []);

  const rotateCameraByDrag = useCallback(
    (dx: number, dy: number, speed: number) => {
      const projection3D = projection3DRef.current;
      const state = projection3D.getCameraState();
      const dragDegreesPerPixel = DRAG_DEGREES_PER_PIXEL * dragSpeedRef.current * speed;

      projection3D.updateCamera({
        yaw: state.yaw - dx * dragDegreesPerPixel * (invertYaw ? -1 : 1),
        pitch: state.pitch - dy * dragDegreesPerPixel * (invertPitch ? -1 : 1),
      });

      if (onCameraChange) {
        onCameraChange(projection3D.getCameraState());
      }
    },
    [invertPitch, invertYaw, onCameraChange],
  );

  // Touch pointers drive the touch camera on every device (see `isTouchPointer`); a mouse keeps
  // the desktop path. Whether the device has a mouse at all only picks the canvas style and the
  // hover rule below.
  const isTouchOnly = useIsTouchOnly();
  const pinchBaseFovScaleRef = useRef(0);
  const isTouchCameraBlocked = () =>
    isWatchInputGated() || (replayIsReplayingRef.current && Boolean(replayViewportStateRef.current));
  useTouchCamera(canvasRef, {
    rotate: (dx, dy) => {
      if (!isTouchCameraBlocked()) rotateCameraByDrag(dx, dy, TOUCH_DRAG_SPEED_MULTIPLIER);
    },
    pinchStart: () => {
      pinchBaseFovScaleRef.current = projection3DRef.current.getCameraState().fovScale;
    },
    pinch: (scale) => {
      if (isTouchCameraBlocked() || !(scale > 0)) return;
      // Larger fovScale is closer, so spreading the fingers zooms in, as in mobile OSRS.
      const projection3D = projection3DRef.current;
      const delta = pinchZoomDelta(scale, zoomIncrementRef.current);
      const requested = Math.round(pinchBaseFovScaleRef.current + delta);
      projection3D.updateCamera({ fovScale: requested });
      const state = projection3D.getCameraState();
      // Past a zoom limit, move the base so the limit sits at the current spread: pinching back
      // then zooms at once, rather than only after undoing the overshoot.
      if (state.fovScale !== requested) pinchBaseFovScaleRef.current = state.fovScale - delta;
      onCameraChange?.(state);
    },
    longPress: (clientX, clientY) => {
      if (!isWatchInputGated()) requestContextMenu(clientX, clientY, false);
    },
  });

  const handleCameraMouseMove = useCallback(
    (sample: MouseMoveSample) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (isWatchInputGated() || (replayIsReplayingRef.current && replayViewportStateRef.current)) {
        cameraDragButtonRef.current = null;
        return;
      }

      const projection3D = projection3DRef.current;

      if (isPointerLockedRef.current && projection3D.getCameraMode() === 'freeform') {
        const dx = sample.movementX;
        const dy = sample.movementY;
        const freeState = projection3D.getFreeformState();
        const yawDelta = Math.max(
          -MAX_FREEFORM_TURN_DEGREES_PER_EVENT,
          Math.min(MAX_FREEFORM_TURN_DEGREES_PER_EVENT, dx * FREEFORM_MOUSE_SENSITIVITY * (invertYaw ? -1 : 1)),
        );
        const pitchDelta = Math.max(
          -MAX_FREEFORM_TURN_DEGREES_PER_EVENT,
          Math.min(MAX_FREEFORM_TURN_DEGREES_PER_EVENT, dy * FREEFORM_MOUSE_SENSITIVITY * (invertPitch ? -1 : 1)),
        );
        const yaw = freeState.yaw - yawDelta;
        projection3D.updateFreeformCamera({
          yaw,
          pitch: freeState.pitch - pitchDelta,
        });

        if (onCameraChange) {
          const state = projection3D.getCameraState();
          onCameraChange({ ...state, yaw });
        }
        return;
      }

      if (cameraDragButtonRef.current) {
        const dx = sample.clientX - lastMouseRef.current.x;
        const dy = sample.clientY - lastMouseRef.current.y;
        lastMouseRef.current = { x: sample.clientX, y: sample.clientY };
        rotateCameraByDrag(dx, dy, 1);
        // Update canvas-relative mouse position so render loop hover tracking continues during drag
        lastCanvasMouseRef.current = toElementLocalPoint(canvas, sample.clientX, sample.clientY);
      }
    },
    [invertPitch, invertYaw, onCameraChange, rotateCameraByDrag],
  );

  // Whichever pointer last moved or pressed anywhere: a touch pointer's (see `isTouchPointer`)
  // compatibility mousemoves are not hover. Window capture, since a tap elsewhere can still send
  // them to the canvas.
  const lastPointerIsTouchRef = useRef(false);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || cameraDragButtonRef.current || isPointerLockedRef.current) return;
      if (isWatchInputGated() && !isSyntheticInput()) return;
      // Touch has no hover. A tap's compatibility mousemove would otherwise park a "cursor" at the
      // tap point, and the render loop re-projects it every frame, so the hover outline would slide
      // across tiles as the camera turns. On a device with a mouse, only while a touch pointer was
      // the last pointer: the mouse's own pointermove comes before its mousemove and hands hover back.
      if ((isTouchOnly || lastPointerIsTouchRef.current) && !isSyntheticInput()) return;

      const { x, y } = toElementLocalPoint(canvas, e.clientX, e.clientY);
      lastCanvasMouseRef.current = { x, y };

      const tile = projection3DRef.current.screenToTile({ x, y });
      const newTile = tile ? ([tile.x, tile.y] as Coordinate) : null;
      sceneRuntimeRef.current.hoveredTile = newTile;
      onHoveredTileChangeRef.current?.(newTile, { x, y });
    },
    [isTouchOnly],
  );

  const handlePointerLeave = useCallback(() => {
    if (!cameraDragButtonRef.current) {
      lastCanvasMouseRef.current = { x: -1, y: -1 };
      sceneRuntimeRef.current.hoveredTile = null;
      onHoveredTileChangeRef.current?.(null, { x: -1, y: -1 });
    }
  }, []);

  useEffect(() => {
    const note = (e: PointerEvent) => {
      const touch = isTouchPointer(e);
      // A touch pointer taking over leaves the mouse's hover behind, which the render loop would
      // otherwise re-project as the touch turns the camera. A replay's hover is its own.
      if (touch && !lastPointerIsTouchRef.current && !replayIsReplayingRef.current) handlePointerLeave();
      lastPointerIsTouchRef.current = touch;
    };
    window.addEventListener('pointerdown', note, true);
    window.addEventListener('pointermove', note, true);
    return () => {
      window.removeEventListener('pointerdown', note, true);
      window.removeEventListener('pointermove', note, true);
    };
  }, [handlePointerLeave]);

  const stopDrag = useCallback((button?: CameraDragButton) => {
    if (button === undefined || cameraDragButtonRef.current === button) {
      cameraDragButtonRef.current = null;
    }
  }, []);

  useEffect(() => {
    // Middle-mouse camera rotation must start regardless of what is under the
    // cursor — including UI panels layered above the canvas — to match real
    // OSRS. The canvas-scoped onMouseDown never fires when the press lands on a
    // UI element, so initiation lives here at the window level. Capture phase
    // ensures a UI handler calling stopPropagation cannot swallow it.
    const handleWindowMouseDown = (e: MouseEvent) => {
      if (e.button !== 1) return;
      if (isWatchInputGated()) return;
      if (replayIsReplayingRef.current && replayViewportStateRef.current) return;
      e.preventDefault(); // suppress browser middle-click autoscroll
      cameraDragButtonRef.current = 'middle';
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
    };
    const handleWindowMouseMove = (e: MouseEvent) => {
      const dragButton = cameraDragButtonRef.current;
      if (!dragButton && !isPointerLockedRef.current) return;
      const dragButtonMask = dragButton === 'middle' ? MIDDLE_MOUSE_BUTTON_MASK : RIGHT_MOUSE_BUTTON_MASK;
      if (dragButton && (e.buttons & dragButtonMask) === 0) {
        stopDrag(dragButton);
        return;
      }
      handleCameraMouseMove(e);
    };
    const handleWindowMouseUp = (e: MouseEvent) => {
      if (e.button === 1) {
        stopDrag('middle');
      } else if (e.button === 2) {
        stopDrag('right');
      }
    };
    window.addEventListener('mousedown', handleWindowMouseDown, true);
    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
    return () => {
      window.removeEventListener('mousedown', handleWindowMouseDown, true);
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [handleCameraMouseMove, stopDrag]);

  // Safety net: clear drag on window blur (alt-tab, ctrl+alt+delete, OS dialogs)
  // and on visibility change (tab switch).
  useEffect(() => {
    const handleBlur = () => {
      cameraDragButtonRef.current = null;
    };
    const handleVisibilityChange = () => {
      if (document.hidden) {
        cameraDragButtonRef.current = null;
      }
    };
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  const containerRef = useRef<HTMLDivElement>(null);
  const wheelDetentsRef = useRef(makeWheelDetentReader());

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const wheelDetents = wheelDetentsRef.current;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Alt+wheel resizes UI panels, never the camera. Let it bubble to the window-level
      // resize gesture, so a burst whose panel shrank out from under the cursor carries on.
      if (e.altKey) return;
      e.stopPropagation();
      if (isWatchInputGated()) return;
      if (replayIsReplayingRef.current && replayViewportStateRef.current) return;
      // A horizontal-only gesture is not a zoom, and 0 must not fall through to
      // the zoom-in branch the way `deltaY > 0 ? out : in` did.
      if (e.deltaY === 0) return;

      const detents = wheelDetents(e);
      if (detents === 0) return;

      const projection3D = projection3DRef.current;
      const state = projection3D.getCameraState();

      // The game's wheel zoom is `fov + (-mousey * 25)`: one notch is one
      // increment, and scrolling down (deltaY > 0) zooms out.
      projection3D.updateCamera({
        fovScale: state.fovScale - detents * zoomIncrementRef.current,
      });

      if (onCameraChange) {
        onCameraChange(projection3D.getCameraState());
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [onCameraChange]);

  const handleAuxClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button === 1) {
      e.preventDefault();
    }
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  return (
    <div
      ref={containerRef}
      data-tutorial-input-surface="gameplay"
      style={{
        position: 'relative',
        width: width,
        height: height,
      }}
    >
      <canvas
        {...REPLAY_CLICK_OWNERSHIP_PROPS.world}
        ref={canvasRef}
        width={width}
        height={height}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseMove={handleMouseMove}
        onPointerLeave={handlePointerLeave}
        onAuxClick={handleAuxClick}
        onContextMenu={handleContextMenu}
        style={isTouchOnly ? TOUCH_CANVAS_STYLE : DESKTOP_CANVAS_STYLE}
        role="img"
        aria-label="3D Game Grid"
      />
      <div
        ref={overheadContainerRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width,
          height,
          pointerEvents: 'none',
          overflow: 'hidden',
        }}
      />
      <div
        ref={tileMarkerLabelContainerRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width,
          height,
          pointerEvents: 'none',
          overflow: 'hidden',
        }}
      />
      <div
        ref={hitsplatContainerRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width,
          height,
          pointerEvents: 'none',
          overflow: 'hidden',
        }}
      />
      <div
        ref={clickOverlayRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width,
          height,
          pointerEvents: 'none',
          overflow: 'hidden',
        }}
      />
      <div
        ref={cutsceneFadeRef}
        data-cutscene-fade=""
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width,
          height,
          pointerEvents: 'none',
          background: '#000',
          opacity: 0,
          zIndex: OVERLAY_LAYER_Z_INDEX.cutsceneFade,
        }}
      />
    </div>
  );
};
