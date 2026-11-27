import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReplayFrameStore } from '../../contexts/ReplayFrameContext';
import { useSimulationContext } from '../../contexts/SimulationContext';
import { useTickProgressStore } from '../../contexts/TickProgressContext';
import type { ArenaTileExtent } from '../../core/encounters/mapFootprint';
import type { GameEvent } from '../../core/events/types';
import { createProjection, type Projection, type ProjectionType } from '../../core/projection';
import type { ReplayClickType } from '../../core/ReplayRecorder';
import { frameIndexAtMs } from '../../core/replayTimeline';
import type { SimulationEngine } from '../../core/SimulationEngine';
import { useClickAnimation } from '../../hooks/useClickAnimation';
import { useDevicePixelRatio } from '../../hooks/useDevicePixelRatio';
import { REPLAY_CLICK_OWNERSHIP_PROPS, type WorldClickType } from '../../input/replayClickFeedback';
import { MAP_SQUARE_SIZE } from '../../rs/map/MapLoader';
import { WATCH_INPUT_GATED_ATTR } from '../../tutorial/runtime/tutorialInputBoundary';
import type { EntityHiderOptions } from '../../types/entityHider';
import type { LineMarker } from '../../types/lineMarkers';
import { DEFAULT_LINE_MARKER_WIDTH } from '../../types/lineMarkers';
import type { NpcHighlightEntry } from '../../types/npcHighlight';
import type { PillarAdditionsPlugins } from '../../types/pillarAdditions';
import type { Coordinate, SimulationState } from '../../types/simulation';
import type { StartPositionPreparation } from '../../types/startPositionPreparation';
import type { TileIndicatorConfig } from '../../types/tileIndicators';
import { DEFAULT_TILE_MARKER_WIDTH, type TileMarker } from '../../types/tileMarkers';
import type { TzhaarHpTrackerOptions } from '../../types/tzhaarHpTracker';
import { animationFrames } from '../../util/animationFrames';
import { IMAGE_CROSS_ORIGIN } from '../../util/imageCache';
import { toElementLocalPoint } from '../../util/viewportBounds';
import { createProjectionAdapter } from '../adapters/projectionAdapter';
import type { Viewport } from '../core/camera';
import { createCamera2D } from '../core/camera';
import type {
  HealthBarOverlay,
  HitsplatOverlay,
  OverheadIcon,
  OverheadTextOverlay,
  TickCounterOverlay,
  TimerBarOverlay,
} from '../core/commands';
import { healthBarFillWidthPx, OVERLAY_LAYER_Z_INDEX } from '../core/commands';
import { fpsReporter } from '../core/fpsReporter';
import { calculateVisualPlayerPosition, startPositionPreparationVisual } from '../core/interpolation';
import type { Renderer } from '../core/renderer';
import { getReplayPresentation } from '../core/replayPresentation';
import { RestoredPresentationClock } from '../core/restoredPresentation';
import { setOverheadTextContent } from '../overlay/overheadTextContent';
import type { PlayerOverheadNumbers } from '../overlay/UIOverlayRenderer';
import type { RenderContext, SceneBuilderLike } from '../scene/types';
import { HITSPLAT_SPRITE_BY_TYPE } from './hitsplatSprites';

const BASE_TILE_SIZE = 32;
const ORIGIN_SQUARE_EXTENT: ArenaTileExtent = { width: MAP_SQUARE_SIZE, height: MAP_SQUARE_SIZE };
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3.0;
const ROTATION_DRAG_THRESHOLD = 80;
const MIDDLE_MOUSE_BUTTON_MASK = 4;

function isWatchInputGated(): boolean {
  return typeof document !== 'undefined' && document.body.hasAttribute(WATCH_INPUT_GATED_ATTR);
}

type MouseMoveSample = {
  readonly clientX: number;
  readonly clientY: number;
};

export interface CameraState2D {
  rotation: number;
  zoom: number;
}

interface RenderViewportProps {
  simulationState: SimulationState;
  engine?: SimulationEngine;
  onTileClick: (coord: Coordinate, ctrlKey?: boolean) => void;
  showCoordinates: boolean;
  encounterDebugFlags?: Record<string, boolean | number>;
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
  rotation?: number;
  targetTile?: Coordinate | null;
  /** Live play's destination, read every frame so a click needs no re-render; replaces `targetTile`. */
  getTargetTile?: () => Coordinate | null;
  /** Live countdown positioning, read every frame; its steps animate while the tick stays 0. */
  getStartPositionPreparation?: () => StartPositionPreparation | null;
  projectionType?: ProjectionType;
  /**
   * The tiles the view covers and accepts clicks on, from tile (0, 0): the displayed encounter's
   * arena rectangle (`EncounterMapFootprint.arenaTileExtent`). Default: the origin map square.
   */
  tileExtent?: ArenaTileExtent;
  renderer: Renderer;
  sceneBuilder: SceneBuilderLike;
  width?: number;
  height?: number;
  /** How much larger than `width` x `height` the canvas is drawn on screen — see Viewport.paintScale. */
  paintScale?: { readonly x: number; readonly y: number } | null;
  renderScale?: number;
  /** Max FPS for the render loop. 0 = uncapped (render every animation frame). */
  fpsCap?: number;
  onCameraChange?: (state: CameraState2D) => void;
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
  eventOverrides?: GameEvent[];
  replayPaused?: boolean;
  replayIsReplaying?: boolean;
  replayTimelineKey?: string;
  leftClickType?: WorldClickType;
  onReplayCursorClick?: (clientX: number, clientY: number, type: ReplayClickType, nowMs?: number) => void;
  onSceneReady?: () => void;
}

export const RenderViewport: React.FC<RenderViewportProps> = ({
  simulationState,
  engine,
  onTileClick,
  showCoordinates,
  encounterDebugFlags = {},
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
  renderScale = 1,
  fpsCap = 0,
  rotation: initialRotation = 0,
  targetTile,
  getTargetTile,
  getStartPositionPreparation,
  projectionType = 'top-down',
  tileExtent = ORIGIN_SQUARE_EXTENT,
  renderer,
  sceneBuilder,
  width = 800,
  height = 600,
  paintScale,
  onCameraChange,
  speedMultiplier = 1,
  playerOverheadNumbers,
  showAttackTimerMetronome = false,
  showNpcAttackTimerMetronome = false,
  entityHider = null,
  tzhaarHpTracker = null,
  pillarAdditions = null,
  eventOverrides,
  replayPaused = false,
  replayIsReplaying = false,
  replayTimelineKey,
  leftClickType = 'yellow',
  onReplayCursorClick,
  onSceneReady,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tickProgressStore = useTickProgressStore();
  const tickProgressStoreRef = useRef(tickProgressStore);
  tickProgressStoreRef.current = tickProgressStore;
  const replayFrameStore = useReplayFrameStore();
  const replayFrameStoreRef = useRef(replayFrameStore);
  replayFrameStoreRef.current = replayFrameStore;
  useEffect(() => replayFrameStore?.registerRenderConsumer(), [replayFrameStore]);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastTickTimeRef = useRef<number>(animationFrames.clock.now());
  const restoredPresentation = useSimulationContext()?.restoredPresentation;
  const restoredPresentationRef = useRef(restoredPresentation);
  const restoredClockRef = useRef(new RestoredPresentationClock());
  const lastKnownTickRef = useRef<number>(simulationState.currentTick);
  const animationFrameRef = useRef<number>(0);
  const rendererInitRef = useRef(false);
  const sceneReadyFiredRef = useRef(false);
  const overheadContainerRef = useRef<HTMLDivElement>(null);
  const hitsplatContainerRef = useRef<HTMLDivElement>(null);
  const clickOverlayRef = useRef<HTMLDivElement>(null);
  const triggerClickAnim = useClickAnimation(clickOverlayRef);
  const leftClickTypeRef = useRef(leftClickType);
  leftClickTypeRef.current = leftClickType;
  const onReplayCursorClickRef = useRef(onReplayCursorClick);
  onReplayCursorClickRef.current = onReplayCursorClick;

  const [cameraRotation, setCameraRotation] = useState(initialRotation);
  const [zoomLevel, setZoomLevel] = useState(1.0);

  const isDraggingRef = useRef(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });
  const dragAccumulatorRef = useRef(0);

  if (
    simulationState.currentTick !== lastKnownTickRef.current ||
    (restoredPresentation &&
      restoredPresentation.engine === engine &&
      restoredPresentation !== restoredPresentationRef.current)
  ) {
    lastKnownTickRef.current = simulationState.currentTick;
    lastTickTimeRef.current = animationFrames.clock.now();
  }

  const effectiveTileSize = BASE_TILE_SIZE * zoomLevel;

  const { width: gridWidth, height: gridHeight } = tileExtent;
  const projection = useMemo<Projection>(
    () =>
      createProjection(projectionType, {
        gridWidth,
        gridHeight,
        tileSize: effectiveTileSize,
        rotation: cameraRotation,
      }),
    [projectionType, cameraRotation, effectiveTileSize, gridWidth, gridHeight],
  );

  const cameraOffsetRef = useRef({ x: 0, y: 0 });

  const projectionAdapter = useMemo(() => {
    return createProjectionAdapter(projection);
  }, [projection]);

  const createProjectionWithCamera = useCallback(
    (offset: { x: number; y: number }) => {
      return {
        tileToScreen: (tile: { x: number; y: number }) => {
          const screen = projectionAdapter.tileToScreen(tile);
          if (!screen) return null;
          return { x: screen.x - offset.x, y: screen.y - offset.y };
        },
        tileDeltaToScreen: (delta: { x: number; y: number }) => {
          return projectionAdapter.tileDeltaToScreen(delta);
        },
        screenToTile: (screenPx: { x: number; y: number }) => {
          return projectionAdapter.screenToTile({
            x: screenPx.x + offset.x,
            y: screenPx.y + offset.y,
          });
        },
        tilePolygonScreen: (tile: { x: number; y: number }) => {
          return projectionAdapter.tilePolygonScreen(tile).map((p) => ({
            x: p.x - offset.x,
            y: p.y - offset.y,
          }));
        },
      } as typeof projectionAdapter;
    },
    [projectionAdapter],
  );

  // Fraction of NATIVE resolution, not of CSS resolution — see the matching
  // comment in RenderViewport3D.
  const deviceScale = useDevicePixelRatio();
  const paintX = paintScale?.x ?? 1;
  const paintY = paintScale?.y ?? 1;
  const viewport: Viewport = useMemo(
    () => ({
      width,
      height,
      dpr: renderScale * deviceScale,
      // Stretch to Window draws the canvas larger than laid out; see Viewport.paintScale.
      ...(paintX !== 1 || paintY !== 1 ? { paintScale: { x: paintX, y: paintY } } : {}),
    }),
    [width, height, paintX, paintY, renderScale, deviceScale],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || rendererInitRef.current) return;

    renderer.init(canvas);
    rendererInitRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- init must only depend on renderer identity, not viewport
  }, [renderer]);

  useEffect(() => {
    if (!onSceneReady || sceneReadyFiredRef.current || !rendererInitRef.current) return;
    sceneReadyFiredRef.current = true;
    onSceneReady();
  }, [onSceneReady]);

  useEffect(() => {
    if (rendererInitRef.current) {
      renderer.resize(viewport);
    }
  }, [viewport, renderer]);

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

      const img = el.querySelector('[data-role="hitsplat-image"]') as HTMLImageElement | null;
      const text = el.querySelector('[data-role="hitsplat-text"]') as HTMLSpanElement | null;
      const spritePath = HITSPLAT_SPRITE_BY_TYPE[h.type];
      if (img && img.getAttribute('data-sprite') !== spritePath) {
        img.src = spritePath;
        img.setAttribute('data-sprite', spritePath);
      }
      if (img) {
        img.style.filter = h.type === 'venom' ? 'brightness(0.55) saturate(1.15)' : 'none';
      }

      el.style.width = `${h.width}px`;
      el.style.height = `${h.height}px`;
      el.style.opacity = '1';
      if (text) {
        text.textContent = String(h.amount);
        text.style.fontSize = `${h.fontSize}px`;
      }
      el.style.left = `${h.screenX - h.width / 2}px`;
      el.style.top = `${h.screenY - h.height / 2}px`;
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
        wrapper.style.pointerEvents = 'none';
        wrapper.style.imageRendering = 'pixelated';
        wrapper.style.willChange = 'transform, opacity';

        const bgImg = document.createElement('img');
        bgImg.crossOrigin = IMAGE_CROSS_ORIGIN;
        bgImg.setAttribute('data-role', 'bg');
        bgImg.src = '/assets/ui/healthbar/default_back_40px.png';
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
        fgImg.src = '/assets/ui/healthbar/default_front_40px.png';
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

      const fgClip = wrapper.querySelector('[data-role="fg-clip"]') as HTMLDivElement;
      const fgImg = wrapper.querySelector('[data-role="fg"]') as HTMLImageElement;
      if (fgClip && fgImg) {
        const clipW = healthBarFillWidthPx(bar.ratio, barW);
        fgClip.style.width = `${clipW}px`;
        fgImg.style.width = `${barW}px`;
      }

      wrapper.style.opacity = '1';
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
      const bgUrl = `/assets/ui/healthbar/dark_back_${barW}px.png`;
      if (bgImg && bgImg.src !== bgUrl) {
        bgImg.src = bgUrl;
      }

      const fgClip = wrapper.querySelector('[data-role="fg-clip"]') as HTMLDivElement;
      const fgImg = wrapper.querySelector('[data-role="fg"]') as HTMLImageElement;
      if (fgClip && fgImg) {
        const fgUrl = `/assets/ui/healthbar/yellow_front_${barW}px.png`;
        if (fgImg.src !== fgUrl) {
          fgImg.src = fgUrl;
        }
        const clipW = Math.max(0, bar.ratio * barW);
        fgClip.style.width = `${clipW}px`;
        fgImg.style.width = `${barW}px`;
      }

      wrapper.style.opacity = '1';
    }
  }, []);

  // Store all render-relevant values in refs so the rAF loop reads the latest
  // without being torn down and restarted (which causes camera jitter on tick changes)
  const simulationStateRef = useRef(simulationState);
  const engineRef = useRef(engine);
  const eventOverridesRef = useRef(eventOverrides);
  const replayPausedRef = useRef(replayPaused);
  const replayIsReplayingRef = useRef(replayIsReplaying);
  const replayTimelineKeyRef = useRef(replayTimelineKey);
  simulationStateRef.current = simulationState;
  engineRef.current = engine;
  eventOverridesRef.current = eventOverrides;
  replayPausedRef.current = replayPaused;
  replayIsReplayingRef.current = replayIsReplaying;
  replayTimelineKeyRef.current = replayTimelineKey;
  restoredPresentationRef.current = restoredPresentation;
  const showCoordinatesRef = useRef(showCoordinates);
  showCoordinatesRef.current = showCoordinates;
  const encounterDebugFlagsRef = useRef(encounterDebugFlags);
  encounterDebugFlagsRef.current = encounterDebugFlags;
  const showTileMarkersRef = useRef(showTileMarkers);
  showTileMarkersRef.current = showTileMarkers;
  const showNpcHighlightsRef = useRef(showNpcHighlights);
  showNpcHighlightsRef.current = showNpcHighlights;
  const showTileMarkerLabelsRef = useRef(showTileMarkerLabels);
  showTileMarkerLabelsRef.current = showTileMarkerLabels;
  const tileMarkersRef = useRef(tileMarkers);
  tileMarkersRef.current = tileMarkers;
  const tileMarkerWidthRef = useRef(tileMarkerWidth);
  tileMarkerWidthRef.current = tileMarkerWidth;
  const showLineMarkersRef = useRef(showLineMarkers);
  showLineMarkersRef.current = showLineMarkers;
  const showLineMarkerLabelsRef = useRef(showLineMarkerLabels);
  showLineMarkerLabelsRef.current = showLineMarkerLabels;
  const lineMarkerWidthRef = useRef(lineMarkerWidth);
  lineMarkerWidthRef.current = lineMarkerWidth;
  const lineMarkersRef = useRef(lineMarkers);
  lineMarkersRef.current = lineMarkers;
  const tileIndicatorConfigRef = useRef(tileIndicatorConfig);
  tileIndicatorConfigRef.current = tileIndicatorConfig;
  const npcHighlightsRef = useRef(npcHighlights);
  npcHighlightsRef.current = npcHighlights;
  // Not React state: the hover highlight must reach the frame being drawn now,
  // not the one after a re-render of this whole viewport.
  const hoveredTileRef = useRef<Coordinate | null>(null);
  const targetTileRef = useRef(targetTile);
  targetTileRef.current = targetTile;
  const getTargetTileRef = useRef(getTargetTile);
  getTargetTileRef.current = getTargetTile;
  const getStartPositionPreparationRef = useRef(getStartPositionPreparation);
  getStartPositionPreparationRef.current = getStartPositionPreparation;
  const sceneBuilderRef = useRef(sceneBuilder);
  sceneBuilderRef.current = sceneBuilder;
  const createProjectionWithCameraRef = useRef(createProjectionWithCamera);
  createProjectionWithCameraRef.current = createProjectionWithCamera;
  const projectionRef = useRef(projection);
  projectionRef.current = projection;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const rendererRef = useRef(renderer);
  rendererRef.current = renderer;
  const widthRef = useRef(width);
  widthRef.current = width;
  const heightRef = useRef(height);
  heightRef.current = height;
  const updateOverheadIconsRef = useRef(updateOverheadIcons);
  updateOverheadIconsRef.current = updateOverheadIcons;
  const updateOverheadTextsRef = useRef(updateOverheadTexts);
  updateOverheadTextsRef.current = updateOverheadTexts;
  const updateHitsplatsRef = useRef(updateHitsplats);
  updateHitsplatsRef.current = updateHitsplats;
  const updateHealthBarsRef = useRef(updateHealthBars);
  updateHealthBarsRef.current = updateHealthBars;
  const updateTimerBarsRef = useRef(updateTimerBars);
  updateTimerBarsRef.current = updateTimerBars;
  const updateTickCountersRef = useRef(updateTickCounters);
  updateTickCountersRef.current = updateTickCounters;
  const speedMultiplierRef = useRef(speedMultiplier);
  speedMultiplierRef.current = speedMultiplier;
  const playerOverheadNumbersRef = useRef(playerOverheadNumbers);
  playerOverheadNumbersRef.current = playerOverheadNumbers;
  const showAttackTimerMetronomeRef = useRef(showAttackTimerMetronome);
  showAttackTimerMetronomeRef.current = showAttackTimerMetronome;
  const showNpcAttackTimerMetronomeRef = useRef(showNpcAttackTimerMetronome);
  showNpcAttackTimerMetronomeRef.current = showNpcAttackTimerMetronome;
  const entityHiderRef = useRef(entityHider);
  entityHiderRef.current = entityHider;
  const tzhaarHpTrackerRef = useRef(tzhaarHpTracker);
  tzhaarHpTrackerRef.current = tzhaarHpTracker;
  const pillarAdditionsRef = useRef(pillarAdditions);
  pillarAdditionsRef.current = pillarAdditions;
  const fpsCapRef = useRef(fpsCap);
  fpsCapRef.current = Number.isFinite(fpsCap) && fpsCap > 0 ? fpsCap : 0;
  // FPS-cap scheduling: deadline advances by one frame budget per rendered
  // frame so the average rate hits the target on faster-refreshing displays.
  // -1 = unstarted.
  const nextFrameDeadlineRef = useRef(-1);
  // Reset the FPS-cap deadline when the cap changes so switching from a low cap
  // to a high one doesn't skip frames until the stale (slower) deadline elapses.
  useEffect(() => {
    fpsCapRef.current = Number.isFinite(fpsCap) && fpsCap > 0 ? fpsCap : 0;
    nextFrameDeadlineRef.current = -1;
  }, [fpsCap]);
  // Real-FPS measurement: count rendered frames and publish once per second
  // to fpsReporter so the on-screen overlay reflects the throttled rate.
  const frameCountRef = useRef(0);
  const lastFpsUpdateRef = useRef(performance.now());

  useEffect(() => {
    let resetTiming = false;
    const unsubscribeResume = animationFrames.subscribeResume(() => {
      resetTiming = true;
    });
    const render = () => {
      if (resetTiming) {
        const now = performance.now();
        nextFrameDeadlineRef.current = -1;
        frameCountRef.current = 0;
        lastFpsUpdateRef.current = now;
        resetTiming = false;
      }
      if (!rendererInitRef.current) {
        animationFrameRef.current = animationFrames.request(render);
        return;
      }

      // FPS cap: skip GPU work on frames that arrive before the next scheduled
      // deadline. The deadline advances by one frame budget per rendered frame
      // so the average rate hits the target even on a faster-refreshing display.
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
          if (nextFrameDeadlineRef.current < t - frameBudgetMs) {
            nextFrameDeadlineRef.current = t + frameBudgetMs;
          }
        }
      } else {
        nextFrameDeadlineRef.current = -1;
      }

      const renderStore = replayFrameStoreRef.current;
      const renderEpoch = renderStore?.getRenderEpoch();
      const replaySnapshot = renderStore?.getSnapshot();
      const replayPresentation =
        replayIsReplayingRef.current && replaySnapshot
          ? getReplayPresentation(replaySnapshot, {
              frameIndex: frameIndexAtMs(replaySnapshot.history ?? [], replaySnapshot.playheadMs),
              state: simulationStateRef.current,
              events: eventOverridesRef.current ?? [],
            })
          : undefined;
      const state = replayPresentation?.state ?? simulationStateRef.current;
      const proj = projectionRef.current;
      const w = widthRef.current;
      const h = heightRef.current;

      const now = animationFrames.clock.now();
      const ordinaryPaused = replayPresentation?.previewing || replayPausedRef.current;
      if (ordinaryPaused && !replayPresentation) {
        lastTickTimeRef.current = now;
      }
      const elapsed = now - lastTickTimeRef.current;
      const tickIntervalMs = 600 / speedMultiplierRef.current;
      const restoration = !replayIsReplayingRef.current ? restoredPresentationRef.current : undefined;
      const restoredSample = !replayPresentation
        ? restoredClockRef.current.sample(
            restoration,
            engineRef.current,
            state.currentTick,
            elapsed,
            speedMultiplierRef.current,
          )
        : undefined;
      const paused = ordinaryPaused || restoredSample?.held === true;
      const tickProgress =
        replayPresentation?.tickProgress ?? restoredSample?.tickProgress ?? Math.min(elapsed / tickIntervalMs, 1.0);
      const interpolatedTick =
        replayPresentation?.interpolatedTick ?? restoredSample?.interpolatedTick ?? state.currentTick + tickProgress;
      tickProgressStoreRef.current?.set(interpolatedTick);

      // Countdown positioning walks while the tick (and so tickProgress) stays put at 0.
      const preparation = replayPresentation ? null : (getStartPositionPreparationRef.current?.() ?? null);
      const preparationVisual = preparation
        ? startPositionPreparationVisual(preparation, now, tickIntervalMs)
        : undefined;
      const playerVisual = replayPresentation?.playerVisual ?? preparationVisual;

      const { position: visualPos } =
        playerVisual ??
        calculateVisualPlayerPosition(
          state.playerPreviousPosition,
          state.playerMovementPath,
          state.playerPosition,
          tickProgress,
        );

      const visualScreenPos = proj.gridToScreen(visualPos[0], visualPos[1]);
      cameraOffsetRef.current = {
        x: Math.round(visualScreenPos.x - w / 2),
        y: Math.round(visualScreenPos.y - h / 2),
      };

      const projectionWithCamera = createProjectionWithCameraRef.current(cameraOffsetRef.current);

      const ctx: RenderContext = {
        simulationState: state,
        events: replayPresentation?.events ?? eventOverridesRef.current ?? engineRef.current?.getLastTickEvents() ?? [],
        options: {
          renderMode: '2d',
          showCoordinates: showCoordinatesRef.current,
          showNpcClickbox: false,
          showTileMarkers: showTileMarkersRef.current,
          showNpcHighlights: showNpcHighlightsRef.current,
          showTileMarkerLabels: showTileMarkerLabelsRef.current,
          tileMarkerWidth: tileMarkerWidthRef.current,
          showLineMarkers: showLineMarkersRef.current,
          showLineMarkerLabels: showLineMarkerLabelsRef.current,
          lineMarkerWidth: lineMarkerWidthRef.current,
          smoothTerrain: false,
          playerOverheadNumbers: playerOverheadNumbersRef.current,
          showAttackTimerMetronome: showAttackTimerMetronomeRef.current,
          showNpcAttackTimerMetronome: showNpcAttackTimerMetronomeRef.current,
          entityHider: entityHiderRef.current,
          tzhaarHpTracker: tzhaarHpTrackerRef.current,
          pillarAdditions: pillarAdditionsRef.current,
          brightness: 0.6,
          contrast: 1.0,
          saturation: 1.0,
          encounterDebugFlags: encounterDebugFlagsRef.current || {},
          tileIndicatorConfig: tileIndicatorConfigRef.current,
        },
        interaction: {
          hoveredTile: hoveredTileRef.current,
          targetTile: getTargetTileRef.current ? getTargetTileRef.current() : (targetTileRef.current ?? null),
        },
        interpolatedTick,
        frameDeltaMs: restoredSample?.deltaMs,
        restoredPresentation: restoration,
        playerVisual,
        speedMultiplier: speedMultiplierRef.current,
        tileMarkers: tileMarkersRef.current,
        lineMarkers: lineMarkersRef.current,
        npcHighlights: npcHighlightsRef.current,
        replayPaused: paused,
        replayHistory: replayPresentation?.replayHistory,
        timeline: {
          timelineKey: replayTimelineKeyRef.current ?? 'live',
          paused,
          timeMs: replayPresentation?.timeMs ?? restoredSample?.timeMs,
        },
      };

      const vp = viewportRef.current;
      const queue = sceneBuilderRef.current.build(ctx, projectionWithCamera, vp);
      const camera = createCamera2D(projectionWithCamera, vp);

      rendererRef.current.render({ camera, queue });
      if (
        replayPresentation &&
        !paused &&
        queue.replayPresentationReady &&
        renderEpoch !== undefined &&
        replaySnapshot
      ) {
        renderStore?.acknowledgeRender(renderEpoch, replayPresentation.frameIndex, replaySnapshot.playheadMs);
      }

      updateOverheadIconsRef.current(queue.overheadIcons ?? []);
      updateOverheadTextsRef.current(queue.overheadTexts ?? []);
      updateHitsplatsRef.current(queue.hitsplats ?? []);
      updateHealthBarsRef.current(queue.healthBars ?? []);
      updateTimerBarsRef.current(queue.timerBars ?? []);
      updateTickCountersRef.current(queue.tickCounters ?? []);

      frameCountRef.current++;
      const fpsElapsed = performance.now() - lastFpsUpdateRef.current;
      if (fpsElapsed >= 1000) {
        fpsReporter.report(Math.round((frameCountRef.current * 1000) / fpsElapsed));
        frameCountRef.current = 0;
        lastFpsUpdateRef.current = performance.now();
      }
      animationFrameRef.current = animationFrames.request(render);
    };

    animationFrameRef.current = animationFrames.request(render);

    return () => {
      unsubscribeResume();
      if (animationFrameRef.current) {
        animationFrames.cancel(animationFrameRef.current);
      }
    };
  }, []); // Mount once — all values read from refs

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (isWatchInputGated()) return;

      if (e.button === 0) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const local = toElementLocalPoint(canvas, e.clientX, e.clientY);
        const x = local.x + cameraOffsetRef.current.x;
        const y = local.y + cameraOffsetRef.current.y;
        const gridCoord = projection.screenToGrid(x, y);
        if (gridCoord) {
          const clickType = leftClickTypeRef.current;
          onReplayCursorClickRef.current?.(e.clientX, e.clientY, clickType, e.timeStamp);
          onTileClick(gridCoord, e.ctrlKey);
          triggerClickAnim(e.clientX, e.clientY, clickType);
        }
      } else if (e.button === 1) {
        e.preventDefault();
        isDraggingRef.current = true;
        lastMouseRef.current = { x: e.clientX, y: e.clientY };
        dragAccumulatorRef.current = 0;
      }
    },
    [projection, onTileClick, triggerClickAnim],
  );

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button === 1 && isDraggingRef.current) {
      isDraggingRef.current = false;
      dragAccumulatorRef.current = 0;
    }
  }, []);

  const handleCameraMouseMove = useCallback(
    (sample: MouseMoveSample) => {
      if (isDraggingRef.current) {
        const dx = sample.clientX - lastMouseRef.current.x;
        lastMouseRef.current = { x: sample.clientX, y: sample.clientY };

        dragAccumulatorRef.current += dx;

        if (Math.abs(dragAccumulatorRef.current) >= ROTATION_DRAG_THRESHOLD) {
          const direction = dragAccumulatorRef.current > 0 ? -90 : 90;
          setCameraRotation((prev) => {
            const newRotation = (((prev + direction) % 360) + 360) % 360;
            if (onCameraChange) {
              onCameraChange({ rotation: newRotation, zoom: zoomLevel });
            }
            return newRotation;
          });
          dragAccumulatorRef.current = 0;
        }
      }
    },
    [zoomLevel, onCameraChange],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || isDraggingRef.current) return;

      const local = toElementLocalPoint(canvas, e.clientX, e.clientY);
      const x = local.x + cameraOffsetRef.current.x;
      const y = local.y + cameraOffsetRef.current.y;

      hoveredTileRef.current = projection.screenToGrid(x, y);
    },
    [projection],
  );

  const handlePointerLeave = useCallback(() => {
    if (!isDraggingRef.current) {
      hoveredTileRef.current = null;
    }
  }, []);

  const stopDrag = useCallback(() => {
    isDraggingRef.current = false;
    dragAccumulatorRef.current = 0;
  }, []);

  useEffect(() => {
    const handleWindowMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      if ((e.buttons & MIDDLE_MOUSE_BUTTON_MASK) === 0) {
        stopDrag();
        return;
      }
      handleCameraMouseMove(e);
    };
    const handleWindowMouseUp = (e: MouseEvent) => {
      if (e.button === 1) {
        stopDrag();
      }
    };
    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [handleCameraMouseMove, stopDrag]);

  // Safety net: clear drag on window blur (alt-tab, ctrl+alt+delete, OS dialogs)
  // and on visibility change (tab switch).
  useEffect(() => {
    const handleBlur = () => {
      isDraggingRef.current = false;
      dragAccumulatorRef.current = 0;
    };
    const handleVisibilityChange = () => {
      if (document.hidden) {
        isDraggingRef.current = false;
        dragAccumulatorRef.current = 0;
      }
    };
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  const handleAuxClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button === 1) {
      e.preventDefault();
    }
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Alt+wheel resizes UI panels, never the camera (see RenderViewport3D).
      if (e.altKey) return;
      e.stopPropagation();
      if (isWatchInputGated()) return;

      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      setZoomLevel((prev) => {
        const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev * zoomFactor));
        if (onCameraChange) {
          onCameraChange({ rotation: cameraRotation, zoom: newZoom });
        }
        return newZoom;
      });
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [cameraRotation, onCameraChange]);

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
        style={{ display: 'block' }}
        role="img"
        aria-label="Game Grid"
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
    </div>
  );
};
