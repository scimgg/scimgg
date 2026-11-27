import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReplayPanelPresentation, useReportPanelPresentation } from '../../contexts/ReplayPresentationContext';
import type { SpellCastContext } from '../../core/combat/runeAvailability';
import type { ReplayClickType } from '../../core/ReplayRecorder';
import { type ReplayMobilePanelModes, resolveReplayMobilePanelModes } from '../../core/replayPresentation';
import type { ItemActionOption } from '../../data/itemEffects';
import { type CameraKeybindMap, useCameraKeybinds } from '../../hooks/useCameraKeybinds';
import {
  formatKeyName,
  type GamePanelTab,
  useGamePanelShortcuts,
  useKeybinds,
} from '../../hooks/useGamePanelShortcuts';
import { usePanelFilters } from '../../hooks/usePanelFilters';
import type { UIPosition } from '../../hooks/usePersistedSettings';
import { OSM_SIDE_BACKGROUND, osmChromeLayout, osmSidePanelOnLeft } from '../../layout/osmClientLayout';
import type { OsmFrame } from '../../layout/osmFrame';
import {
  JAGEX_BOSSING_HOTKEYS,
  type OsmHotkeyFacts,
  type OsmHotkeySlot,
  type OsmHotkeyType,
  osmSideButtonOp,
} from '../../layout/osmHotkeys';
import {
  CLASSIC_SIDE_COLUMN,
  type ClientLayoutMode,
  FIXED_SIDE_COLUMN,
  FIXED_SIDE_COLUMN_RECT,
  type SelectedTabStone,
  SIDE_TRANSPARENCY_DEFAULT,
  scaleRect,
  selectedTabStonePlacement,
  sideBackgroundFill,
} from '../../layout/osrsClientLayout';
import { DIALOG, PANEL, PANEL_BORDER, TAB_ICONS } from '../../resourcePack';
import type { EnumTypeLoader } from '../../rs/config/enumtype/EnumTypeLoader';
import type { ObjTypeLoader } from '../../rs/config/objtype/ObjTypeLoader';
import type { StructTypeLoader } from '../../rs/config/structtype/StructTypeLoader';
import type { PlayerEquipment } from '../../rs/model/PlayerModelLoader';
import {
  GAMEPANEL_AUDIO_ID,
  GAMEPANEL_KEYBINDS_CAMERA_ID,
  GAMEPANEL_KEYBINDS_PLUGINS_ID,
} from '../../settingsSearch/ids';
import type { SupplyItem } from '../../types/encounterLoadout';
import type { EquipmentStats } from '../../types/equipmentStats';
import type { EquipmentPanelView, SettingsSubTab } from '../../types/gamePanelViews';
import type { Inventory } from '../../types/inventory';
import type { PrayerState, PrayerType, SimulationState } from '../../types/simulation';
import type { SpellbookType } from '../../types/spellbook';
import { loadCachedImage } from '../../util/imageCache';
import { useContextMenu } from '../ContextMenu';
import {
  buildPrayerOrbContextMenu,
  buildRunOrbContextMenu,
  buildSpecialOrbContextMenu,
} from '../ContextMenu/contextMenuBuilders';
import { DraggablePanel } from '../DraggablePanel';
import { pressOrb, specialAttackShownActive } from '../orbActions';
import { PackImage } from '../PackImage';
import { type LayerSprite, PixelSpriteLayer } from '../PixelSpriteLayer';
import { usePanelContentScale } from '../panelContentScale';
import {
  isWithinRevealScope,
  REVEAL_REPLAY_AUDIO_REASON,
  REVEAL_REPLAY_REASON,
  useGamePanelRevealDestination,
} from '../settingsReveal';
import { useTooltip, useTooltipScale } from '../Tooltip';
import { useSpriteCssUrls } from '../useSpriteCss';
import { CombatContent } from './CombatContent';
import { EquipmentContent } from './EquipmentContent';
import { InventoryContent } from './InventoryContent';
import type { KeybindingCategory } from './KeybindingsContent';
import { type MobileHotkeyBinding, MobileHotkeys } from './MobileHotkeys';
import { MobileSideChrome } from './MobileSideChrome';
import { PrayerContent } from './PrayerContent';
import { resolveQuickPrayerSelections } from './prayerFilterUtils';
import { QuickPrayerSetup } from './QuickPrayerSetup';
import { SettingsContent } from './SettingsContent';
import { SidePanelColumn } from './SidePanelColumn';
import { SkillsContent } from './SkillsContent';
import { SpellbookContent } from './SpellbookContent';
import { StatusBars } from './StatusBars';

export const PANEL_WIDTH = 204;
export const PANEL_HEIGHT = 275;

// We render the entire 8-piece chrome (4 corners + 4 repeating edges) into a SINGLE
// <canvas> primitive rather than as 100+ adjacent absolutely-positioned <img>s.
//
// Why: Firefox's WebRender snaps every primitive's destination rect to device
// pixels INDEPENDENTLY in the scene builder's `SpaceSnapper::snap_rect()`, regardless
// of whether the primitive comes from `background-repeat` or an explicit <img>.
// Under DraggablePanel's `zoom + transform: scale(...)` stack at fractional UI
// scales (4/3, 7/5, 3/2, ...), adjacent primitives' snapped rects can round in
// opposite directions, opening 1-device-pixel transparent seams. There is NO CSS
// property that flips WebRender into a 'snap once at ancestor' mode — the only
// snapping disable switches are PrimitiveFlags::ANTIALIASED (which blurs) and
// PictureFlags::DISABLE_SNAPPING (internal). Two-pass / half-tile-offset DOM
// tiling does NOT help because both passes flow through the same snap path with
// the same composed transform, so their snap directions correlate.
const BORDER_TILE_SIZE = 32;
const BORDER_EDGE_INSET = 30;
// Within each 32x32 sprite, the visible 7-pixel metallic band sits at rows/cols
// 13-19. For corner sprites, the L-shaped outer band sits at rows 0-6 + cols
// 0-6 (top-left), mirrored for the other corners.
const BORDER_BAND_START = 13;
const BORDER_BAND_PX = 7;
// Tile counts: enough tiles so the last one always clips the strip end.
const HORIZONTAL_BORDER_TILE_COUNT = Math.ceil((PANEL_WIDTH - BORDER_EDGE_INSET * 2) / BORDER_TILE_SIZE) + 2;
const VERTICAL_BORDER_TILE_COUNT = Math.ceil((PANEL_HEIGHT - BORDER_EDGE_INSET * 2) / BORDER_TILE_SIZE) + 2;

// Through `imageCache`, which preloads these and sets the matching `crossOrigin`: a bare `new Image()`
// is a separate memory-cache entry, so it refetched every border tile on each redraw.
const loadChromeImage = (src: string): Promise<HTMLImageElement> =>
  loadCachedImage(src, 'immediate').then((image) => image ?? Promise.reject(new Error(`Failed to load ${src}`)));

/**
 * See the comment block above BORDER_TILE_SIZE for the WebRender background.
 *
 * Resolution strategy: the canvas backing buffer is sized to the panel's
 * effective DEVICE pixel size (PANEL_WIDTH * uiScale * devicePixelRatio), while
 * its CSS size stays at PANEL_WIDTH x PANEL_HEIGHT. This makes the canvas's
 * internal pixel grid match the device-pixel grid 1:1 under DraggablePanel's
 * outer `zoom + transform: scale(...)` stack. WebRender just blits the canvas
 * to device pixels with no inter-pixel sampling decision, eliminating the
 * nearest-neighbor jitter that would otherwise shift the band's row-doubling
 * pattern as the panel moves at subpixel offsets.
 */
const PanelChromeCanvas: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const uiScale = usePanelContentScale();
  // Track DPR for users who drag the window between monitors with different
  // pixel densities. matchMedia for the current resolution fires when it changes.
  const [dpr, setDpr] = useState<number>(() => (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [dpr]);

  const borderSources = useMemo(
    () => ({
      edgeTop: PANEL_BORDER.edgeTop,
      edgeBottom: PANEL_BORDER.edgeBottom,
      edgeLeft: PANEL_BORDER.edgeLeft,
      edgeRight: PANEL_BORDER.edgeRight,
      cornerTopLeft: PANEL_BORDER.cornerTopLeft,
      cornerTopRight: PANEL_BORDER.cornerTopRight,
      cornerBottomLeft: PANEL_BORDER.cornerBottomLeft,
      cornerBottomRight: PANEL_BORDER.cornerBottomRight,
    }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const deviceScale = uiScale * dpr;
    Promise.all([
      loadChromeImage(borderSources.edgeTop),
      loadChromeImage(borderSources.edgeBottom),
      loadChromeImage(borderSources.edgeLeft),
      loadChromeImage(borderSources.edgeRight),
      loadChromeImage(borderSources.cornerTopLeft),
      loadChromeImage(borderSources.cornerTopRight),
      loadChromeImage(borderSources.cornerBottomLeft),
      loadChromeImage(borderSources.cornerBottomRight),
    ])
      .then(([edgeTop, edgeBottom, edgeLeft, edgeRight, cornerTL, cornerTR, cornerBL, cornerBR]) => {
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Buffer matches the panel's displayed device size as closely as possible:
        // round (not ceil) so the canvas-to-device blit stays ~1:1 and avoids a
        // fractional whole-canvas resample (up to ~0.8px) at fractional scales.
        const bufferW = Math.round(PANEL_WIDTH * deviceScale);
        const bufferH = Math.round(PANEL_HEIGHT * deviceScale);
        if (canvas.width !== bufferW) canvas.width = bufferW;
        if (canvas.height !== bufferH) canvas.height = bufferH;

        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, bufferW, bufferH);

        // Snap helper: panel coord → integer canvas coord. Consecutive snapped tile
        // boundaries abut perfectly because we use the same snap() for both ends.
        const snap = (panel: number) => Math.round(panel * deviceScale);

        // Visible-band dimensions on the canvas. Computed as integers so the LEFT/
        // RIGHT/TOP/BOTTOM bands all end up exactly the same thickness on screen —
        // independent of where the panel sits in subpixel space.
        const BAND_PX = Math.round(BORDER_BAND_PX * deviceScale);
        const CORNER_PX = Math.round(BORDER_TILE_SIZE * deviceScale);

        for (let i = 0; i < HORIZONTAL_BORDER_TILE_COUNT; i++) {
          const xStart = snap(BORDER_EDGE_INSET + i * BORDER_TILE_SIZE);
          const xEnd = snap(BORDER_EDGE_INSET + (i + 1) * BORDER_TILE_SIZE);
          ctx.drawImage(
            edgeTop,
            0,
            BORDER_BAND_START,
            BORDER_TILE_SIZE,
            BORDER_BAND_PX,
            xStart,
            0,
            xEnd - xStart,
            BAND_PX,
          );
        }

        for (let i = 0; i < HORIZONTAL_BORDER_TILE_COUNT; i++) {
          const xStart = snap(BORDER_EDGE_INSET + i * BORDER_TILE_SIZE);
          const xEnd = snap(BORDER_EDGE_INSET + (i + 1) * BORDER_TILE_SIZE);
          ctx.drawImage(
            edgeBottom,
            0,
            BORDER_BAND_START,
            BORDER_TILE_SIZE,
            BORDER_BAND_PX,
            xStart,
            bufferH - BAND_PX,
            xEnd - xStart,
            BAND_PX,
          );
        }

        for (let i = 0; i < VERTICAL_BORDER_TILE_COUNT; i++) {
          const yStart = snap(BORDER_EDGE_INSET + i * BORDER_TILE_SIZE);
          const yEnd = snap(BORDER_EDGE_INSET + (i + 1) * BORDER_TILE_SIZE);
          ctx.drawImage(
            edgeLeft,
            BORDER_BAND_START,
            0,
            BORDER_BAND_PX,
            BORDER_TILE_SIZE,
            0,
            yStart,
            BAND_PX,
            yEnd - yStart,
          );
        }

        for (let i = 0; i < VERTICAL_BORDER_TILE_COUNT; i++) {
          const yStart = snap(BORDER_EDGE_INSET + i * BORDER_TILE_SIZE);
          const yEnd = snap(BORDER_EDGE_INSET + (i + 1) * BORDER_TILE_SIZE);
          ctx.drawImage(
            edgeRight,
            BORDER_BAND_START,
            0,
            BORDER_BAND_PX,
            BORDER_TILE_SIZE,
            bufferW - BAND_PX,
            yStart,
            BAND_PX,
            yEnd - yStart,
          );
        }

        // Corners last so their opaque art covers any strip-edge overdraw at the
        // four corner joins. CRITICAL: the corner's visible 7-source-px outer band
        // must be EXACTLY BAND_PX thick so it lines up with the adjacent edge band.
        // Stretching the whole 32x32 sprite to CORNER_PX would make the band
        // (7/32)*CORNER_PX thick, which differs from round(7*deviceScale)=BAND_PX by
        // up to ~0.5px at fractional scales — that mismatch is the visible notch where
        // each corner meets each edge.
        const INNER_SRC = BORDER_TILE_SIZE - BORDER_BAND_PX;
        const INNER_DST = CORNER_PX - BAND_PX;
        const drawCorner = (
          img: HTMLImageElement,
          destX: number,
          destY: number,
          bandLeft: boolean,
          bandTop: boolean,
        ) => {
          // The outer band is the 7px edge of the sprite facing away from the panel
          // center (left+top for TL, right+top for TR, etc.).
          const sxBand = bandLeft ? 0 : INNER_SRC;
          const sxInner = bandLeft ? BORDER_BAND_PX : 0;
          const dxBand = bandLeft ? destX : destX + INNER_DST;
          const dxInner = bandLeft ? destX + BAND_PX : destX;
          const syBand = bandTop ? 0 : INNER_SRC;
          const syInner = bandTop ? BORDER_BAND_PX : 0;
          const dyBand = bandTop ? destY : destY + INNER_DST;
          const dyInner = bandTop ? destY + BAND_PX : destY;
          ctx.drawImage(img, sxBand, syBand, BORDER_BAND_PX, BORDER_BAND_PX, dxBand, dyBand, BAND_PX, BAND_PX);
          ctx.drawImage(img, sxInner, syBand, INNER_SRC, BORDER_BAND_PX, dxInner, dyBand, INNER_DST, BAND_PX);
          ctx.drawImage(img, sxBand, syInner, BORDER_BAND_PX, INNER_SRC, dxBand, dyInner, BAND_PX, INNER_DST);
          ctx.drawImage(img, sxInner, syInner, INNER_SRC, INNER_SRC, dxInner, dyInner, INNER_DST, INNER_DST);
        };
        drawCorner(cornerTL, 0, 0, true, true);
        drawCorner(cornerTR, bufferW - CORNER_PX, 0, false, true);
        drawCorner(cornerBL, 0, bufferH - CORNER_PX, true, false);
        drawCorner(cornerBR, bufferW - CORNER_PX, bufferH - CORNER_PX, false, false);
      })
      .catch(() => {
        // If a pack asset fails to load, leave the transparent canvas; the rest
        // of the UI keeps rendering.
      });
    return () => {
      cancelled = true;
    };
  }, [uiScale, dpr, borderSources]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: PANEL_WIDTH,
        height: PANEL_HEIGHT,
        zIndex: 2,
        pointerEvents: 'none',
        imageRendering: 'pixelated',
      }}
    />
  );
};

/** Listeners: spotlight action-step listeners (SpotlightRunner.buildActionHooks). */
const TUTORIAL_TAB_CHANGED_EVENT = 'tutorial:tab-changed';

const TAB_STONE_W = 33;
const TAB_STONE_H = 36;
const TAB_COUNT = 7;
/** Slots the client paints into each of its two tab rows. Equals TAB_COUNT only by coincidence. */
const TAB_SLOTS_PER_ROW = 7;
const TAB_GAP = 1;
export const ICON_BAR_WIDTH = TAB_COUNT * TAB_STONE_W + (TAB_COUNT - 1) * TAB_GAP;
export const ICON_BAR_HEIGHT = TAB_STONE_H;
/** Vertical offset (px) of the GamePanel's bottom edge from viewport bottom in its default slot. */
export const GAME_PANEL_DEFAULT_BOTTOM_OFFSET = ICON_BAR_HEIGHT + 2;

interface GamePanelProps {
  simulationState?: SimulationState;
  activePrayer: PrayerType | null;
  boostPrayers?: readonly PrayerType[];
  independentPrayers?: readonly PrayerType[];
  prayerVisualOverrides?: Readonly<Partial<Record<PrayerType, boolean>>>;
  onPrayerChange: (prayer: PrayerType | null) => void;
  onBoostPrayerChange?: (prayer: PrayerType | null) => void;
  onIndependentPrayerChange?: (prayer: PrayerType) => void;
  quickPrayerSetupOpen?: boolean;
  /**
   * Bumped on every request to set up quick prayers. A request while setup is already open
   * still shows Prayer and reopens a closed Mobile panel, which the flag alone cannot signal.
   */
  quickPrayerSetupRequest?: number;
  onCloseQuickPrayerSetup?: () => void;
  onQuickPrayerSelectionsReady?: (selections: string[]) => void;
  onMarkOfDarknessCast?: () => void;
  onDeathChargeCast?: () => void;
  onHomeTeleportCast?: () => void;
  inventory?: Inventory;
  inventoryPreviewResetToken?: number;
  equipmentStats?: EquipmentStats;
  playerEquipment?: PlayerEquipment;
  equippedAmmo?: SupplyItem | null;
  quiverAmmo?: SupplyItem | null;
  prayerState?: PrayerState;
  onUnequipSlot?: (slot: string) => void;
  onUnequipAmmo?: () => void;
  onEquipmentSlotClick?: (slot: string) => boolean;
  onEquipFromInventory?: (inventoryIndex: number) => Inventory | null | undefined;
  onUseItem?: (inventoryIndex: number, option?: ItemActionOption) => void;
  onDropItem?: (inventoryIndex: number) => void;
  onReplayCursorClick?: (clientX: number, clientY: number, type: ReplayClickType, nowMs?: number) => void;
  onSwapInventorySlots?: (fromIndex: number, toIndex: number) => void;
  inventoryTags?: Record<string, string>;
  showInventoryTags?: boolean;
  antiDragEnabled?: boolean;
  dragOnShiftOnly?: boolean;
  antiDragDelay?: number;
  antiDragCtrlToDrag?: boolean;
  onUntagItem?: (itemId: number) => void;
  onPickInventoryTagColor?: (itemId: number, initialColor?: string) => void;
  onCameraKeybindsChange?: (keybinds: CameraKeybindMap) => void;
  weaponId?: number;
  specialAttackPercent?: number;
  /** See `CombatContentProps.soulreaperStacks`. */
  soulreaperStacks?: number;
  isSpecialAttackActive?: boolean;
  pendingSpecialAttackToggles?: number;
  onSpecialAttackToggle?: () => void;
  hasSpecialAttack?: boolean;
  /**
   * The orb actions the Mobile layout's hotkeys press, the very callbacks the minimap orbs
   * get (on the mobile client they do what the orbs do). Unused in the other layouts.
   */
  quickPrayersActive?: boolean;
  onQuickPrayerToggle?: () => void;
  onQuickPrayerSetup?: () => void;
  isRunEnabled?: boolean;
  onRunToggle?: () => void;
  /** Mobile layout: the five hotkey slots (see `PersistedSettings.mobileHotkeys`). */
  mobileHotkeys?: readonly OsmHotkeySlot[];
  /** Mobile layout: a panel a hotkey opens goes on the left. */
  mobileHotkeysOpenOnLeft?: boolean;
  selectedAttackStyleIndex?: number;
  onAttackStyleChange?: (index: number) => void;
  /** Spellbook the active loadout is on. Drives the Magic tab and the autocast picker. */
  spellbook?: SpellbookType;
  /** Explicitly selected autocast spell name, or null to fall back to the weapon default. */
  selectedSpell?: string | null;
  onSelectedSpellChange?: (spellName: string) => void;
  /** Runes/gear available right now, for graying spells the player cannot pay for. */
  runeContext?: SpellCastContext | null;
  /** Spell armed for a manual cast, awaiting a target click. */
  armedSpell?: string | null;
  onArmSpell?: (spellName: string | null) => void;
  objTypeLoader?: ObjTypeLoader;
  enumTypeLoader?: EnumTypeLoader;
  structTypeLoader?: StructTypeLoader;
  panelPosition?: UIPosition;
  onPanelPositionChange?: (position: UIPosition) => void;
  viewportWidth?: number;
  viewportHeight?: number;
  exclusionRects?: Array<{ left: number; top: number; right: number; bottom: number }>;
  masterVolume?: number;
  sfxVolume?: number;
  areaVolume?: number;
  onVolumeChange?: (key: 'masterVolume' | 'sfxVolume' | 'areaVolume', value: number) => void;
  muteWhenUnfocused?: boolean;
  onMuteWhenUnfocusedChange?: (value: boolean) => void;
  activeTab?: GamePanelTab;
  replayActiveTab?: GamePanelTab;
  onActiveTabChange?: (tab: GamePanelTab) => void;
  clientLayoutMode?: ClientLayoutMode;
  transparentSidePanel?: boolean;
  hotkeysCloseSidePanel?: boolean;
  /** The mobile gameframe. Required for the mobile layout, which pins its chrome to it. */
  mobileFrame?: OsmFrame;
  /** Suppresses Alt-drag. Set in fixed layout, where the column is pinned to the frame. */
  locked?: boolean;
  /** Status Bars plugin: hitpoints and prayer bars flanking the panel. */
  statusBarsEnabled?: boolean;
  statusBarsShowValues?: boolean;
  /**
   * Whether any prayer is lit as the CLIENT predicts it, queued clicks included.
   * Same source as the prayer orb's activated icon (`MinimapOrbs`'
   * `hasPredictedPrayer`); reading the engine-committed set instead leaves the
   * status bar a tick behind the orb through every flick.
   */
  anyPrayerActive?: boolean;
}

interface TabIconProps {
  alt: string;
  isActive: boolean;
  highlight?: boolean;
  onClick: () => void;
  onMouseDown?: React.MouseEventHandler<HTMLButtonElement>;
  onContextMenu?: React.MouseEventHandler<HTMLButtonElement>;
  onPointerDownCapture?: React.PointerEventHandler<HTMLButtonElement>;
  'data-tab'?: string;
}

/**
 * A tab plus the slot it occupies in the real client's two tab rows.
 *
 * Classic and fixed honor those slots, so the tabs this app does not ship read
 * as the bare stone the client shows there, rather than packing ours into a
 * shorter row.
 */
interface GamePanelTabSpec {
  readonly tab: GamePanelTab;
  readonly row: 'top' | 'bottom';
  readonly slot: number;
  readonly icon: string;
  readonly label: string;
  readonly highlight?: boolean;
  readonly contextMenu?: {
    readonly onMouseDown: React.MouseEventHandler<HTMLButtonElement>;
    readonly onContextMenu: React.MouseEventHandler<HTMLButtonElement>;
    readonly onPointerDownCapture: React.PointerEventHandler<HTMLButtonElement> | undefined;
  };
}

/**
 * Where the column opens before the user drags it: flush with the bottom-right
 * corner, which is where the client anchors its own side container.
 */
const COLUMN_DEFAULT_POSITION = { x: 0, y: 0, anchorX: 'right' as const, anchorY: 'bottom' as const };
/** The modern body's default: the corner, lifted clear of the tab bar by its exclusion band. */
const BODY_DEFAULT_POSITION = COLUMN_DEFAULT_POSITION;

function selectedTabStoneSprite(stone: SelectedTabStone): string {
  switch (stone) {
    case 'topLeft':
      return PANEL.tabStoneSelectedTopLeft;
    case 'topRight':
      return PANEL.tabStoneSelectedTopRight;
    case 'bottomLeft':
      return PANEL.tabStoneSelectedBottomLeft;
    case 'bottomRight':
      return PANEL.tabStoneSelectedBottomRight;
    case 'middle':
      return PANEL.tabStoneSelectedMiddle;
  }
}

/**
 * A tab's hit target. Every layout paints its stone, highlight and icon into a shared
 * `PixelSpriteLayer` — modern's bar into its own, classic and fixed into the column's — so
 * this contributes the accessible name, the pressed state and the click surface, nothing
 * visual. No `<img>` may live here: one sharing a zoom-scaled layer with a canvas rasterizes
 * soft on that layer's first paint. See SidePanelColumn.
 */
const TabIcon: React.FC<TabIconProps> = ({
  alt,
  isActive,
  highlight,
  onClick,
  onMouseDown,
  onContextMenu,
  onPointerDownCapture,
  'data-tab': dataTab,
}) => {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      onPointerDownCapture={onPointerDownCapture}
      className={highlight ? 'shortcut-hint-glow' : undefined}
      aria-label={alt}
      aria-pressed={isActive}
      data-tab={dataTab}
      data-active={isActive || undefined}
      style={{
        width: TAB_STONE_W,
        height: TAB_STONE_H,
        padding: 0,
        border: 'none',
        borderRadius: 0,
        backgroundColor: 'transparent',
        cursor: 'default',
        transition: 'none',
        position: 'relative',
      }}
    />
  );
};

/** The sprite the stylesheet tiles for each side background fill; the preloader warms every one. */
export const SIDE_BACKGROUND_SPRITES: Readonly<Record<ReturnType<typeof sideBackgroundFill>['sprite'], string>> = {
  get tradebackingDark() {
    return PANEL.background;
  },
  get tradebackingLight() {
    return DIALOG.backgroundBrighter;
  },
};

/** 601:113 with the fill the mobile client gives it; see `sideBackgroundFill`. */
const MobileSideBackground: React.FC = () => {
  const fill = sideBackgroundFill(SIDE_TRANSPARENCY_DEFAULT);
  const sprite = SIDE_BACKGROUND_SPRITES[fill.sprite];
  const [url] = useSpriteCssUrls([sprite]);
  return (
    <div
      aria-hidden="true"
      // Dev-only, for tests and DevTools: the stylesheet paints an object URL, not this path.
      data-sprite={import.meta.env.DEV ? sprite : undefined}
      style={{
        position: 'absolute',
        left: OSM_SIDE_BACKGROUND.x,
        top: OSM_SIDE_BACKGROUND.y,
        width: OSM_SIDE_BACKGROUND.width,
        height: OSM_SIDE_BACKGROUND.height,
        backgroundImage: url ? `url("${url}")` : 'none',
        backgroundRepeat: 'repeat',
        imageRendering: 'pixelated',
        opacity: fill.alpha,
        pointerEvents: 'none',
        zIndex: 0,
      }}
    />
  );
};

/** Stable identity, so an inert control does not remount its body every render. */
const NO_PANEL_CHANGE = () => {};

export const GamePanel: React.FC<GamePanelProps> = ({
  simulationState,
  activePrayer,
  boostPrayers,
  independentPrayers,
  prayerVisualOverrides,
  onPrayerChange,
  onBoostPrayerChange,
  onIndependentPrayerChange,
  quickPrayerSetupOpen = false,
  quickPrayerSetupRequest = 0,
  onCloseQuickPrayerSetup,
  onQuickPrayerSelectionsReady,
  onMarkOfDarknessCast,
  onDeathChargeCast,
  onHomeTeleportCast,
  inventory,
  inventoryPreviewResetToken,
  equipmentStats,
  playerEquipment,
  equippedAmmo,
  quiverAmmo,
  prayerState,
  onUnequipSlot,
  onUnequipAmmo,
  onEquipmentSlotClick,
  onEquipFromInventory,
  onUseItem,
  onDropItem,
  onReplayCursorClick,
  onSwapInventorySlots,
  inventoryTags,
  showInventoryTags,
  antiDragEnabled,
  dragOnShiftOnly,
  antiDragDelay,
  antiDragCtrlToDrag,
  onUntagItem,
  onPickInventoryTagColor,
  onCameraKeybindsChange,
  weaponId,
  specialAttackPercent,
  soulreaperStacks,
  isSpecialAttackActive,
  pendingSpecialAttackToggles,
  onSpecialAttackToggle,
  hasSpecialAttack,
  quickPrayersActive = false,
  onQuickPrayerToggle,
  onQuickPrayerSetup,
  isRunEnabled = false,
  onRunToggle,
  mobileHotkeys = JAGEX_BOSSING_HOTKEYS,
  mobileHotkeysOpenOnLeft = false,
  selectedAttackStyleIndex,
  onAttackStyleChange,
  spellbook,
  selectedSpell,
  onSelectedSpellChange,
  runeContext,
  armedSpell,
  onArmSpell,
  objTypeLoader,
  enumTypeLoader,
  structTypeLoader,
  panelPosition,
  onPanelPositionChange,
  viewportWidth,
  viewportHeight,
  exclusionRects,
  masterVolume,
  sfxVolume,
  areaVolume,
  onVolumeChange,
  muteWhenUnfocused,
  onMuteWhenUnfocusedChange,
  activeTab: controlledActiveTab,
  replayActiveTab,
  onActiveTabChange,
  clientLayoutMode = 'modern',
  transparentSidePanel = true,
  hotkeysCloseSidePanel = false,
  mobileFrame,
  locked,
  statusBarsEnabled = false,
  statusBarsShowValues = true,
  anyPrayerActive = false,
}) => {
  const [uncontrolledActiveTab, setUncontrolledActiveTab] = useState<GamePanelTab>('inventory');
  const [highlightSettings, setHighlightSettings] = useState(false);
  const [ownPrayerReordering, setPrayerReordering] = useState(false);
  const [ownSpellReordering, setSpellReordering] = useState(false);
  const [ownSpellFiltering, setSpellFiltering] = useState(false);
  const [ownPrayerFiltering, setPrayerFiltering] = useState(false);
  const [ownPickerStyleIndex, setPickerStyleIndex] = useState<number | null>(null);
  const [ownEquipmentView, setEquipmentView] = useState<EquipmentPanelView>('equipment');
  const [ownSettingsSubTab, setSettingsSubTab] = useState<SettingsSubTab>('audio');
  // The Keybindings page's group. Held here, not in the page, so a reveal can choose Camera.
  const [keybindCategory, setKeybindCategory] = useState<KeybindingCategory>('Panel');
  const [ownPrayerFilterViewOpen, setPrayerFilterViewOpen] = useState(false);
  const [ownSpellFilterViewOpen, setSpellFilterViewOpen] = useState(false);
  // Mobile only. The native client keeps no tab selected while its side panel is closed;
  // the simulator keeps its last tab (other systems read it) and hides the panel instead.
  const [mobilePanelOpen, setMobilePanelOpen] = useState(true);
  const [modernPanelOpen, setModernPanelOpen] = useState(true);
  // The last open came from a hotkey, which can put the panel on the left.
  const [mobilePanelFromHotkey, setMobilePanelFromHotkey] = useState(false);
  // A tab change this panel made itself, so the effect below can tell it from keyboard,
  // tutorial and replay changes (a key press counts as a rail open, not a hotkey one).
  const mobileTabChangeSourceRef = useRef<'rail' | 'hotkey' | null>(null);
  // The rail collapsed to its left column.
  const [mobileTabsCollapsed, setMobileTabsCollapsed] = useState(false);
  // The hotkeys bar folded down to its master toggle.
  const [mobileHotkeysCollapsed, setMobileHotkeysCollapsed] = useState(false);
  const { keybinds } = useKeybinds();
  const { cameraKeybinds } = useCameraKeybinds();
  const { setScale: setTooltipScale, hideTooltip, recheckHover } = useTooltip();
  const uiScale = useTooltipScale();
  const {
    prayerFilter,
    spellbookFilter,
    quickPrayerSelections,
    togglePrayerHidden,
    toggleQuickPrayerSelection,
    setPrayerOrder,
    togglePrayerFilterOption,
    toggleSpellHidden,
    setSpellOrder,
    toggleSpellCategory,
    toggleSpellFilterOption,
    ownFilters,
  } = usePanelFilters();
  const { bindContextMenu } = useContextMenu();
  /**
   * The recorder's panel, while replaying one. `filterPrayerGrid`/`filterSpellGrid`
   * return the UNFILTERED grid in reorder mode, so replaying the recorded filters
   * without their modes reproduces neither — the modes are as much a part of the
   * arrangement as the hidden set is.
   */
  const replayPanel = useReplayPanelPresentation();
  const reportPanelPresentation = useReportPanelPresentation();
  const prayerReordering = replayPanel?.modes.prayerReordering ?? ownPrayerReordering;
  const prayerFiltering = replayPanel?.modes.prayerFiltering ?? ownPrayerFiltering;
  const spellReordering = replayPanel?.modes.spellReordering ?? ownSpellReordering;
  const spellFiltering = replayPanel?.modes.spellFiltering ?? ownSpellFiltering;
  /**
   * The bodies, which differ from the modes above in what an ABSENT value falls back to.
   * A recording that does not carry them gets the DEFAULT body, not the viewer's:
   * the viewer's is whatever screen they happened to leave open before pressing play,
   * and a stats readout or filter screen the recorder never saw would pop up over the
   * grid and still be there when playback ended.
   */
  const replayOwnsPanel = replayPanel !== null;
  const navigationFollowsReplay =
    replayOwnsPanel ||
    replayActiveTab !== undefined ||
    (controlledActiveTab !== undefined && onActiveTabChange === undefined);
  const modernPanelShown = navigationFollowsReplay ? (replayPanel?.modes.modernPanelOpen ?? true) : modernPanelOpen;
  const pickerStyleIndex = replayPanel ? (replayPanel.modes.autocastPickerStyleIndex ?? null) : ownPickerStyleIndex;
  const equipmentView = replayPanel ? (replayPanel.modes.equipmentView ?? 'equipment') : ownEquipmentView;
  const settingsSubTab = replayPanel ? (replayPanel.modes.settingsSubTab ?? 'audio') : ownSettingsSubTab;
  const prayerFilterViewOpen = replayPanel
    ? (replayPanel.modes.prayerFilterViewOpen ?? false)
    : ownPrayerFilterViewOpen;
  const spellFilterViewOpen = replayPanel ? (replayPanel.modes.spellFilterViewOpen ?? false) : ownSpellFilterViewOpen;
  const quickPrayerSetupShown = replayPanel ? (replayPanel.modes.quickPrayerSetupOpen ?? false) : quickPrayerSetupOpen;
  const prayerAvailability = useMemo(
    () =>
      simulationState
        ? {
            basePrayerLevel: simulationState.stats.prayer.max,
            baseDefenceLevel: simulationState.stats.defence.max,
            baseAttackLevel: simulationState.stats.attack.max,
            baseStrengthLevel: simulationState.stats.strength.max,
          }
        : undefined,
    [simulationState],
  );
  // Unset toggles pass through as undefined; `isPrayerUnlocked` applies their defaults.
  const upgradedPrayers = simulationState?.mechanicsConfig?.upgradedPrayers;
  const zealPrayer = simulationState?.mechanicsConfig?.zealPrayer;
  const effectiveQuickPrayerSelections = useMemo(
    () => resolveQuickPrayerSelections(quickPrayerSelections, prayerAvailability, { upgradedPrayers, zealPrayer }),
    [prayerAvailability, quickPrayerSelections, upgradedPrayers, zealPrayer],
  );

  // The viewer's own Mobile panel and hotkeys bar, reported for recording and replaced by the
  // recorder's while a replay owns the panel (resolveReplayMobilePanelModes).
  const ownMobileModes = useMemo<ReplayMobilePanelModes>(
    () => ({
      panelOpen: mobilePanelOpen,
      tabsCollapsed: mobileTabsCollapsed,
      panelFromHotkey: mobilePanelFromHotkey,
      hotkeysCollapsed: mobileHotkeysCollapsed,
      hotkeysOpenOnLeft: mobileHotkeysOpenOnLeft,
      hotkeys: mobileHotkeys,
    }),
    [
      mobilePanelOpen,
      mobileTabsCollapsed,
      mobilePanelFromHotkey,
      mobileHotkeysCollapsed,
      mobileHotkeysOpenOnLeft,
      mobileHotkeys,
    ],
  );
  const mobileModes = resolveReplayMobilePanelModes(replayPanel?.modes, ownMobileModes);

  const ownModes = useMemo(
    () => ({
      prayerReordering: ownPrayerReordering,
      prayerFiltering: ownPrayerFiltering,
      spellReordering: ownSpellReordering,
      spellFiltering: ownSpellFiltering,
      quickPrayerSetupOpen,
      autocastPickerStyleIndex: ownPickerStyleIndex,
      equipmentView: ownEquipmentView,
      settingsSubTab: ownSettingsSubTab,
      prayerFilterViewOpen: ownPrayerFilterViewOpen,
      spellFilterViewOpen: ownSpellFilterViewOpen,
      ...(clientLayoutMode === 'modern' ? { modernPanelOpen } : {}),
      ...(clientLayoutMode === 'mobile' ? { mobile: ownMobileModes } : {}),
    }),
    [
      clientLayoutMode,
      modernPanelOpen,
      ownMobileModes,
      ownPrayerReordering,
      ownPrayerFiltering,
      ownSpellReordering,
      ownSpellFiltering,
      quickPrayerSetupOpen,
      ownPickerStyleIndex,
      ownEquipmentView,
      ownSettingsSubTab,
      ownPrayerFilterViewOpen,
      ownSpellFilterViewOpen,
    ],
  );
  // A control the replay overrides is inert, not merely masked: its write would land in
  // the viewer's own state and surface the moment playback ended.
  const changePickerStyleIndex = replayOwnsPanel ? NO_PANEL_CHANGE : setPickerStyleIndex;
  const changeEquipmentView = replayOwnsPanel ? NO_PANEL_CHANGE : setEquipmentView;
  const changeSettingsSubTab = replayOwnsPanel ? NO_PANEL_CHANGE : setSettingsSubTab;
  const changePrayerFilterView = replayOwnsPanel ? NO_PANEL_CHANGE : setPrayerFilterViewOpen;
  const changeSpellFilterView = replayOwnsPanel ? NO_PANEL_CHANGE : setSpellFilterViewOpen;
  // Reports what the VIEWER owns, never the override: recording the override back
  // would leave each replay seeding the arrangement of the next recording.
  useEffect(() => {
    reportPanelPresentation({ filters: ownFilters, modes: ownModes });
  }, [reportPanelPresentation, ownFilters, ownModes]);
  const activeTab = controlledActiveTab ?? replayActiveTab ?? uncontrolledActiveTab;
  const setActiveTab = useCallback(
    (tab: GamePanelTab) => {
      if (controlledActiveTab === undefined && replayActiveTab === undefined) {
        setUncontrolledActiveTab(tab);
      }
      onActiveTabChange?.(tab);
    },
    [controlledActiveTab, onActiveTabChange, replayActiveTab],
  );

  // Selecting a tab by any route (keyboard, tutorial, replay) shows its panel, as a
  // tap on its stone does in game.
  // A replay's tab changes are the recorder's, and its panel state comes with them: leave
  // the viewer's own alone. That includes the commit playback ends in, whose switch back to
  // the live tab is no selection and must not reopen a panel the viewer had closed.
  const replayOwnedNavigationRef = useRef(navigationFollowsReplay);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-open on every tab change, not on the value.
  useEffect(() => {
    const previouslyReplayOwned = replayOwnedNavigationRef.current;
    replayOwnedNavigationRef.current = navigationFollowsReplay;
    if (navigationFollowsReplay || previouslyReplayOwned) {
      mobileTabChangeSourceRef.current = null;
      return;
    }
    setMobilePanelOpen(true);
    setModernPanelOpen(true);
    setMobilePanelFromHotkey(mobileTabChangeSourceRef.current === 'hotkey');
    mobileTabChangeSourceRef.current = null;
  }, [activeTab, navigationFollowsReplay]);

  // A command that asks for a tab (its keybind, quick-prayer setup) shows the Mobile panel even
  // when that tab is already the active one, which the change-driven open above cannot see.
  const showTab = useCallback(
    (tab: GamePanelTab) => {
      if (navigationFollowsReplay) return;
      setActiveTab(tab);
      setMobilePanelOpen(true);
      setModernPanelOpen(true);
      setMobilePanelFromHotkey(false);
    },
    [navigationFollowsReplay, setActiveTab],
  );

  // A reveal of the wrench tab's pages (settingsReveal.ts) navigates through the same state a tap
  // would: Settings tab (shown, on Mobile), then the Audio page, or the Keybindings page on its
  // Panel or Camera group. It is refused while a replay owns the panel: the replay drives the tab
  // (a controlled tab with no way to change it is how Grid hands it over) and the recorder's
  // modes, so the panel could not get there, and writing the viewer's own state would surface
  // when playback ended. The one exception is the Audio page while the replay is already showing
  // it: its volumes are the viewer's own and stay editable, so the reveal just marks the control.
  const replayShowsAudio =
    activeTab === 'settings' &&
    settingsSubTab === 'audio' &&
    (clientLayoutMode !== 'mobile' || mobileModes.panelOpen) &&
    (clientLayoutMode !== 'modern' || modernPanelShown);
  useGamePanelRevealDestination(
    (id) => {
      if (!navigationFollowsReplay) return null;
      if (!isWithinRevealScope(id, GAMEPANEL_AUDIO_ID)) return REVEAL_REPLAY_REASON;
      return replayShowsAudio ? null : REVEAL_REPLAY_AUDIO_REASON;
    },
    (id) => {
      if (navigationFollowsReplay) return;
      if (isWithinRevealScope(id, GAMEPANEL_AUDIO_ID)) {
        setSettingsSubTab('audio');
      } else {
        setKeybindCategory(
          id === GAMEPANEL_KEYBINDS_CAMERA_ID ? 'Camera' : id === GAMEPANEL_KEYBINDS_PLUGINS_ID ? 'Plugins' : 'Panel',
        );
        setSettingsSubTab('keybinds');
      }
      showTab('settings');
    },
  );

  /**
   * The Mobile layout's side-panel open or close, from a rail stone or a hotkey: the open
   * tab closes, the closed panel's own tab reopens it, any other tab switches to it. The tab
   * itself still goes through `setActiveTab`, the path every other route takes.
   */
  const mobileSideButtonOp = useCallback(
    (tab: GamePanelTab, source: 'rail' | 'hotkey') => {
      // Inert under a replay, like every other control the recording owns.
      if (replayOwnsPanel) return;
      const next = osmSideButtonOp(
        { tab: activeTab, open: mobilePanelOpen, fromHotkey: mobilePanelFromHotkey },
        tab,
        source,
      );
      if (next.tab !== activeTab) {
        mobileTabChangeSourceRef.current = source;
        setActiveTab(next.tab);
      }
      setMobilePanelOpen(next.open);
      setMobilePanelFromHotkey(next.fromHotkey);
    },
    [activeTab, mobilePanelOpen, mobilePanelFromHotkey, replayOwnsPanel, setActiveTab],
  );

  const panelVisible = clientLayoutMode !== 'modern' || modernPanelShown;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a tab switch or the panel hiding must drop the open tooltip and recheck hover, so both are triggers rather than inputs.
  useEffect(() => {
    hideTooltip();
    recheckHover();
  }, [activeTab, panelVisible, hideTooltip, recheckHover]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent(TUTORIAL_TAB_CHANGED_EVENT, { detail: { tab: activeTab } }));
  }, [activeTab]);

  // Leaving a tab discards its sub-view. Without it the equipment tab reopens on the
  // stats readout and the autocast picker is still up several tabs later.
  //
  // Skipped entirely while playback owns the panel: `activeTab` is then the RECORDING's
  // tab, and resetting off it would clear state the viewer owns and report the defaults
  // into their next recording.
  useEffect(() => {
    if (replayOwnsPanel) return;
    if (activeTab !== 'combat') setPickerStyleIndex(null);
    if (activeTab !== 'equipment') setEquipmentView('equipment');
    if (activeTab !== 'settings') {
      setSettingsSubTab('audio');
      setKeybindCategory('Panel');
    }
    if (activeTab !== 'prayer') setPrayerFilterViewOpen(false);
    if (activeTab !== 'spellbook') setSpellFilterViewOpen(false);
  }, [activeTab, replayOwnsPanel]);

  useEffect(() => {
    onCameraKeybindsChange?.(cameraKeybinds);
  }, [cameraKeybinds, onCameraKeybindsChange]);

  // Driven by the requests alone: `showTab` changes identity as playback starts and ends,
  // which would re-show an old, still-open request over a panel closed since.
  const showTabRef = useRef(showTab);
  showTabRef.current = showTab;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each request re-shows Prayer, even when the flag is unchanged.
  useEffect(() => {
    if (quickPrayerSetupOpen && !replayOwnsPanel) {
      showTabRef.current('prayer');
    }
  }, [quickPrayerSetupOpen, quickPrayerSetupRequest]);

  useEffect(() => {
    onQuickPrayerSelectionsReady?.(effectiveQuickPrayerSelections);
  }, [effectiveQuickPrayerSelections, onQuickPrayerSelectionsReady]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const listener = () => {
      setHighlightSettings(true);
      timer = setTimeout(() => setHighlightSettings(false), 4000);
    };
    window.addEventListener('shortcut-hint:highlight-settings', listener);
    return () => {
      window.removeEventListener('shortcut-hint:highlight-settings', listener);
      clearTimeout(timer);
    };
  }, []);

  // A click on the open tab's stone always closes it; a hotkey closes it only when the
  // hotkey preference allows.
  const modernSideButtonOp = useCallback(
    (tab: GamePanelTab, canClose: boolean) => {
      if (navigationFollowsReplay) return;
      if (tab === activeTab && canClose) {
        setModernPanelOpen((open) => !open);
      } else {
        showTab(tab);
      }
    },
    [activeTab, navigationFollowsReplay, showTab],
  );
  const onTabShortcut = useCallback(
    (tab: GamePanelTab) =>
      clientLayoutMode === 'modern' ? modernSideButtonOp(tab, hotkeysCloseSidePanel) : showTab(tab),
    [clientLayoutMode, modernSideButtonOp, hotkeysCloseSidePanel, showTab],
  );
  useGamePanelShortcuts(onTabShortcut, keybinds);

  const getTooltip = (tab: GamePanelTab, label: string): string => {
    const key = keybinds[tab];
    return key ? `${label} (${formatKeyName(key)})` : label;
  };

  // A replay owns these modes for as long as it is playing. The entries stay
  // visible and say so rather than silently ignoring the click.
  const prayerTabContextMenu = bindContextMenu(() => ({
    entries: replayPanel
      ? [{ action: 'Controlled by', target: 'replay', disabled: true }, { action: 'Cancel' }]
      : [
          {
            action: prayerReordering ? 'Disable' : 'Enable',
            target: 'prayer reordering',
            onClick: () => setPrayerReordering((v) => !v),
          },
          {
            action: prayerFiltering ? 'Disable' : 'Enable',
            target: 'prayer filtering',
            onClick: () => setPrayerFiltering((v) => !v),
          },
          { action: 'Cancel' },
        ],
  }));

  const spellbookTabContextMenu = bindContextMenu(() => ({
    entries: replayPanel
      ? [{ action: 'Controlled by', target: 'replay', disabled: true }, { action: 'Cancel' }]
      : [
          {
            action: spellReordering ? 'Disable' : 'Enable',
            target: 'spellbook reordering',
            onClick: () => setSpellReordering((v) => !v),
          },
          {
            action: spellFiltering ? 'Disable' : 'Enable',
            target: 'spellbook filtering',
            onClick: () => setSpellFiltering((v) => !v),
          },
          { action: 'Cancel' },
        ],
  }));

  const renderContent = () => {
    switch (activeTab) {
      case 'inventory':
        return (
          <InventoryContent
            inventory={inventory}
            currentTick={simulationState?.currentTick}
            previewResetToken={inventoryPreviewResetToken}
            onEquipFromInventory={onEquipFromInventory}
            onUseItem={onUseItem}
            onDropItem={onDropItem}
            onReplayCursorClick={onReplayCursorClick}
            onSwapSlots={onSwapInventorySlots}
            objTypeLoader={objTypeLoader}
            inventoryTags={inventoryTags}
            showInventoryTags={showInventoryTags}
            antiDragEnabled={antiDragEnabled}
            dragOnShiftOnly={dragOnShiftOnly}
            antiDragDelay={antiDragDelay}
            antiDragCtrlToDrag={antiDragCtrlToDrag}
            onUntagItem={onUntagItem}
            onPickInventoryTagColor={onPickInventoryTagColor}
          />
        );
      case 'combat':
        return (
          <CombatContent
            pickerStyleIndex={pickerStyleIndex}
            onPickerStyleIndexChange={changePickerStyleIndex}
            weaponId={weaponId}
            specialAttackPercent={specialAttackPercent}
            soulreaperStacks={soulreaperStacks}
            isSpecialAttackActive={isSpecialAttackActive}
            pendingSpecialAttackToggles={pendingSpecialAttackToggles}
            onSpecialAttackToggle={onSpecialAttackToggle}
            onReplayCursorClick={onReplayCursorClick}
            hasSpecialAttack={hasSpecialAttack}
            selectedAttackStyleIndex={selectedAttackStyleIndex}
            onAttackStyleChange={onAttackStyleChange}
            objTypeLoader={objTypeLoader}
            enumTypeLoader={enumTypeLoader}
            structTypeLoader={structTypeLoader}
            spellbook={spellbook}
            selectedSpell={selectedSpell}
            onSelectedSpellChange={onSelectedSpellChange}
            stats={simulationState?.stats}
          />
        );
      case 'skills':
        return <SkillsContent stats={simulationState?.stats} />;
      case 'spellbook':
        return (
          <SpellbookContent
            spellbook={spellbook}
            runeContext={runeContext}
            armedSpell={armedSpell}
            onArmSpell={onArmSpell}
            onMarkOfDarknessCast={onMarkOfDarknessCast}
            onDeathChargeCast={onDeathChargeCast}
            onHomeTeleportCast={onHomeTeleportCast}
            onReplayCursorClick={onReplayCursorClick}
            reorderMode={spellReordering}
            filteringEnabled={spellFiltering}
            replayControlled={replayPanel !== null}
            filterViewOpen={spellFilterViewOpen}
            onFilterViewOpenChange={changeSpellFilterView}
            filterSettings={spellbookFilter}
            onToggleHidden={toggleSpellHidden}
            onReorder={setSpellOrder}
            onToggleCategory={toggleSpellCategory}
            onToggleFilterOption={toggleSpellFilterOption}
            baseMagicLevel={simulationState?.stats.magic.max}
            antiDragEnabled={antiDragEnabled}
            dragOnShiftOnly={dragOnShiftOnly}
            antiDragDelay={antiDragDelay}
            antiDragCtrlToDrag={antiDragCtrlToDrag}
          />
        );
      case 'prayer':
        return quickPrayerSetupShown ? (
          <QuickPrayerSetup
            quickPrayerSelections={quickPrayerSelections}
            availability={prayerAvailability}
            upgradedPrayers={upgradedPrayers}
            zealPrayer={zealPrayer}
            onToggleSelection={toggleQuickPrayerSelection}
            onClose={onCloseQuickPrayerSetup ?? (() => {})}
          />
        ) : (
          <PrayerContent
            activePrayer={activePrayer}
            boostPrayers={boostPrayers}
            independentPrayers={independentPrayers}
            prayerVisualOverrides={prayerVisualOverrides}
            onPrayerChange={onPrayerChange}
            onBoostPrayerChange={onBoostPrayerChange}
            onIndependentPrayerChange={onIndependentPrayerChange}
            prayerState={prayerState}
            reorderMode={prayerReordering}
            filteringEnabled={prayerFiltering}
            replayControlled={replayPanel !== null}
            filterViewOpen={prayerFilterViewOpen}
            onFilterViewOpenChange={changePrayerFilterView}
            filterSettings={prayerFilter}
            availability={prayerAvailability}
            upgradedPrayers={upgradedPrayers}
            zealPrayer={zealPrayer}
            onToggleHidden={togglePrayerHidden}
            onReorder={setPrayerOrder}
            onToggleFilterOption={togglePrayerFilterOption}
            onReplayCursorClick={onReplayCursorClick}
            antiDragEnabled={antiDragEnabled}
            dragOnShiftOnly={dragOnShiftOnly}
            antiDragDelay={antiDragDelay}
            antiDragCtrlToDrag={antiDragCtrlToDrag}
          />
        );
      case 'equipment':
        return (
          <EquipmentContent
            view={equipmentView}
            onViewChange={changeEquipmentView}
            equipmentStats={equipmentStats}
            playerEquipment={playerEquipment}
            equippedAmmo={equippedAmmo}
            quiverAmmo={quiverAmmo}
            inventory={inventory}
            onUnequipSlot={onUnequipSlot}
            onUnequipAmmo={onUnequipAmmo}
            onEquipmentSlotClick={onEquipmentSlotClick}
            objTypeLoader={objTypeLoader}
          />
        );
      case 'settings':
        return (
          <SettingsContent
            subTab={settingsSubTab}
            onSubTabChange={changeSettingsSubTab}
            keybindCategory={keybindCategory}
            onKeybindCategoryChange={setKeybindCategory}
            readOnly={replayOwnsPanel}
            masterVolume={masterVolume}
            sfxVolume={sfxVolume}
            areaVolume={areaVolume}
            onVolumeChange={onVolumeChange}
            muteWhenUnfocused={muteWhenUnfocused}
            onMuteWhenUnfocusedChange={onMuteWhenUnfocusedChange}
          />
        );
    }
  };

  // A saved body position may overlap the tabs rather than being docked. Keep-clear
  // is a solver constraint in exact logical units, not a rounded post-docking push.
  const bodyExclusionRects = useMemo(() => {
    const frameHeight = viewportHeight ?? window.innerHeight;
    return [
      ...(exclusionRects ?? []),
      {
        left: 0,
        top: frameHeight - ICON_BAR_HEIGHT * uiScale - 2,
        right: viewportWidth ?? window.innerWidth,
        bottom: frameHeight,
      },
    ];
  }, [exclusionRects, viewportWidth, viewportHeight, uiScale]);

  /**
   * Slot numbers are the client's own: six of ours are top-row tabs (slot 2 is Quests,
   * which this app has no use for) and Options is bottom-row slot 4. Modern ignores
   * them and lays the buttons out in one line, which is what its own bar does.
   */
  const tabs: readonly GamePanelTabSpec[] = useMemo(
    () => [
      { tab: 'combat', row: 'top', slot: 0, icon: TAB_ICONS.combat, label: 'Combat' },
      { tab: 'skills', row: 'top', slot: 1, icon: TAB_ICONS.skills, label: 'Skills' },
      { tab: 'inventory', row: 'top', slot: 3, icon: TAB_ICONS.inventory, label: 'Inventory' },
      { tab: 'equipment', row: 'top', slot: 4, icon: TAB_ICONS.equipment, label: 'Equipment' },
      {
        tab: 'prayer',
        row: 'top',
        slot: 5,
        icon: TAB_ICONS.prayer,
        label: 'Prayer',
        contextMenu: prayerTabContextMenu,
      },
      {
        tab: 'spellbook',
        row: 'top',
        slot: 6,
        icon: TAB_ICONS.spellbook,
        label: 'Spellbook',
        contextMenu: spellbookTabContextMenu,
      },
      {
        tab: 'settings',
        row: 'bottom',
        slot: 4,
        icon: TAB_ICONS.settings,
        label: 'Keybinds',
        highlight: highlightSettings,
      },
    ],
    [highlightSettings, prayerTabContextMenu, spellbookTabContextMenu],
  );

  // A touch pointer (see `isTouchPointer`): a tab without a menu still takes its taps through the
  // shared press recognizer, which keeps a wobbling or slow tap a tap for as long as the finger
  // stays on the stone. Only the touch handler, so the mouse's right-click is left as it was.
  const tabTouchTap = bindContextMenu(() => null).onPointerDownCapture;

  const renderTab = (spec: GamePanelTabSpec) => (
    <TabIcon
      key={spec.tab}
      alt={getTooltip(spec.tab, spec.label)}
      isActive={activeTab === spec.tab && (clientLayoutMode !== 'modern' || modernPanelShown)}
      highlight={spec.highlight}
      onClick={() => (clientLayoutMode === 'modern' ? modernSideButtonOp(spec.tab, true) : setActiveTab(spec.tab))}
      data-tab={spec.tab}
      onMouseDown={spec.contextMenu?.onMouseDown}
      onContextMenu={spec.contextMenu?.onContextMenu}
      onPointerDownCapture={spec.contextMenu?.onPointerDownCapture ?? tabTouchTap}
    />
  );

  /**
   * The column's sprite payload for one tab. Fixed and classic highlight from
   * `SideStoneHighlights` — wider than the slot at the row ends, so the placement carries its
   * own width and offset — while modern's bare bar uses the square `PreEocStones` stone.
   */
  const columnSlot = (spec: GamePanelTabSpec) => {
    const placement = selectedTabStonePlacement(spec.row, spec.slot, TAB_SLOTS_PER_ROW);
    return {
      slot: spec.slot,
      node: renderTab(spec),
      icon: spec.icon,
      selectedStone:
        activeTab === spec.tab
          ? { src: selectedTabStoneSprite(placement.stone), dx: placement.dx, width: placement.width }
          : undefined,
    };
  };

  const statusBars = statusBarsEnabled ? (
    <StatusBars
      mode={clientLayoutMode}
      currentHitpoints={simulationState?.playerHP ?? 0}
      maxHitpoints={simulationState?.maxHP ?? 0}
      currentPrayer={prayerState?.points ?? 0}
      maxPrayer={prayerState?.maxPoints ?? 0}
      anyPrayerActive={anyPrayerActive}
      showValues={statusBarsShowValues}
    />
  ) : null;

  // Only the backing becomes translucent, never the content or the stone chrome.
  // App-owned text pages remain opaque in both resizable layouts.
  const sideBackgroundOpacity = transparentSidePanel && activeTab !== 'settings' ? 0.5 : 1;

  // The panel body. Identical in every layout — only its chrome differs, so
  // the column supplies its own and this drops the modern shell's background
  // and stone border.
  //
  // `mobile` keeps the same stone border: 601:111 and Modern's 164:96 share it (see
  // OSM_SIDE_BORDER). Its fill is the native
  // `sideBackgroundFill`, tiled one pixel inside the container (601:113).
  const panelBody = (chrome: 'modern' | 'mobile' | 'none') => (
    <div
      /* Marks this subtree as a panel surface: no hand cursor, clickability is
         carried visually instead. See --- Panel cursor policy --- in index.css. */
      className="panel-surface"
      style={{
        overflow: 'hidden',
        position: 'relative',
      }}
      /* A browser page translation rewriting text nodes React owns tears the live game HUD
         down mid-render. Every layout's panel body comes through here, so this is the
         one place the whole game panel opts out. The in-panel Settings tabs opt back in
         (SettingsContent), and menus and modals sit outside this boundary. */
      translate="no"
    >
      {chrome === 'mobile' && (
        <>
          <MobileSideBackground />
          <PanelChromeCanvas />
        </>
      )}
      {chrome === 'modern' && (
        <>
          {/* Preserve the existing half-opacity gameplay backing. The opaque option matches the
              client's opaque side panel; app-owned text pages never become translucent. */}
          <PackImage
            src={PANEL.background}
            alt=""
            style={{
              width: PANEL_WIDTH,
              height: PANEL_HEIGHT,
              position: 'absolute',
              top: 0,
              left: 0,
              zIndex: 0,
              pointerEvents: 'none',
              opacity: sideBackgroundOpacity,
              imageRendering: 'pixelated',
            }}
          />
          <PanelChromeCanvas />
        </>
      )}
      <div style={{ position: 'relative', zIndex: 1, width: PANEL_WIDTH, height: PANEL_HEIGHT }}>{renderContent()}</div>
    </div>
  );

  if (clientLayoutMode === 'mobile' && mobileFrame) {
    const layout = osmChromeLayout(
      mobileFrame.size,
      mobileModes.tabsCollapsed,
      osmSidePanelOnLeft(mobileModes.panelFromHotkey, mobileModes.hotkeysOpenOnLeft),
    );
    const specShownActive = specialAttackShownActive(isSpecialAttackActive ?? false, pendingSpecialAttackToggles ?? 0);
    const hotkeyFacts: OsmHotkeyFacts = {
      openTab: mobileModes.panelOpen ? activeTab : null,
      quickPrayersActive,
      runEnabled: isRunEnabled,
      hasSpecialAttack: hasSpecialAttack ?? false,
      specialAttackShownActive: specShownActive,
    };
    const bindHotkey = (type: OsmHotkeyType): MobileHotkeyBinding => {
      if (type.tab) {
        const tab = type.tab;
        const open = () => mobileSideButtonOp(tab, 'hotkey');
        return {
          onPress: open,
          ...bindContextMenu(() => ({ entries: [{ action: type.name, onClick: open }, { action: 'Cancel' }] })),
        };
      }
      switch (type.orb) {
        case 'quickPrayers':
          return {
            onPress: (event) => pressOrb(onQuickPrayerToggle, onReplayCursorClick, event),
            ...bindContextMenu(() =>
              buildPrayerOrbContextMenu(quickPrayersActive, {
                onToggle: () => onQuickPrayerToggle?.(),
                onSetup: () => onQuickPrayerSetup?.(),
              }),
            ),
          };
        case 'run':
          return {
            onPress: (event) => pressOrb(onRunToggle, onReplayCursorClick, event),
            ...bindContextMenu(() => buildRunOrbContextMenu(isRunEnabled, () => onRunToggle?.())),
          };
        default:
          // No op at all without a special-attack weapon.
          if (!hasSpecialAttack) return { onPress: () => {} };
          return {
            onPress: (event) => pressOrb(onSpecialAttackToggle, onReplayCursorClick, event),
            ...bindContextMenu(() => buildSpecialOrbContextMenu(specShownActive, () => onSpecialAttackToggle?.())),
          };
      }
    };
    return (
      <>
        <MobileHotkeys
          frame={mobileFrame}
          viewportWidth={viewportWidth}
          viewportHeight={viewportHeight}
          slots={mobileModes.hotkeys}
          facts={hotkeyFacts}
          bind={bindHotkey}
          collapsed={mobileModes.hotkeysCollapsed}
          onToggleCollapsed={() => {
            if (!replayOwnsPanel) setMobileHotkeysCollapsed((collapsed) => !collapsed);
          }}
        />
        <MobileSideChrome
          frame={mobileFrame}
          layout={layout}
          viewportWidth={viewportWidth}
          viewportHeight={viewportHeight}
          tabs={tabs.map((spec) => ({
            tab: spec.tab,
            label: getTooltip(spec.tab, spec.label),
            highlight: spec.highlight,
            contextMenu: spec.contextMenu,
          }))}
          selectedTab={mobileModes.panelOpen ? activeTab : null}
          onTabPress={(tab) => mobileSideButtonOp(tab, 'rail')}
          tabsCollapsed={mobileModes.tabsCollapsed}
          onToggleTabsCollapsed={() => {
            if (!replayOwnsPanel) setMobileTabsCollapsed((collapsed) => !collapsed);
          }}
          overlay={statusBars}
        >
          {mobileModes.panelOpen ? panelBody('mobile') : null}
        </MobileSideChrome>
      </>
    );
  }

  // One column instead of modern's two floating pieces, which is what the
  // client does: group 161 has a single 241x335 side container holding both
  // tab rows and the panel, and group 548 stacks the same three pieces into the
  // strip that runs down the right of the fixed frame. Fixed's column is pinned
  // and locked by Grid rather than positioned here.
  if (clientLayoutMode === 'fixed' || clientLayoutMode === 'classic') {
    const column = clientLayoutMode === 'fixed' ? FIXED_SIDE_COLUMN : CLASSIC_SIDE_COLUMN;
    // Fixed pins the column to the client frame, so its physical box is its
    // frame-space rect snapped by `scaleRect` rather than `logical * scale` — the
    // rule every fixed-mode box follows. Classic keeps deriving its own box.
    const physicalSize = clientLayoutMode === 'fixed' ? scaleRect(FIXED_SIDE_COLUMN_RECT, uiScale) : undefined;
    return (
      <DraggablePanel
        inputSurface="gameplay"
        defaultPosition={COLUMN_DEFAULT_POSITION}
        position={panelPosition}
        width={column.size.width}
        height={column.size.height}
        scale={uiScale}
        physicalSize={physicalSize}
        onPositionChange={onPanelPositionChange}
        onScaleChange={setTooltipScale}
        viewportWidth={viewportWidth}
        viewportHeight={viewportHeight}
        exclusionRects={exclusionRects}
        locked={locked}
        scaleEnabled={clientLayoutMode !== 'fixed'}
        dataTutorial="game-panel"
      >
        {/* `tab-bar` lives on the column's upper tab row — see SidePanelColumn. */}
        <SidePanelColumn
          geometry={column}
          backgroundOpacity={clientLayoutMode === 'classic' ? sideBackgroundOpacity : 1}
          topRow={tabs.filter((t) => t.row === 'top').map(columnSlot)}
          bottomRow={tabs.filter((t) => t.row === 'bottom').map(columnSlot)}
          overlay={statusBars}
        >
          {panelBody('none')}
        </SidePanelColumn>
      </DraggablePanel>
    );
  }

  // Its bar paints every stone and icon into ONE canvas behind the transparent tab buttons.
  // See PixelSpriteLayer for why a canvas per sprite is worth avoiding. Classic and fixed
  // paint their stones into the column's row sprite instead, so only modern needs this.
  const tabSprites: LayerSprite[] = [];
  tabs.forEach((spec, index) => {
    const box = { x: index * (TAB_STONE_W + TAB_GAP), y: 0, w: TAB_STONE_W, h: TAB_STONE_H };
    tabSprites.push({ ...box, src: PANEL.tabStone, width: TAB_STONE_W, height: TAB_STONE_H });
    if (spec.tab === activeTab && modernPanelShown) {
      tabSprites.push({ ...box, src: PANEL.tabStoneSelected, width: TAB_STONE_W, height: TAB_STONE_H });
    }
    tabSprites.push({ ...box, src: spec.icon });
  });

  return (
    <>
      {modernPanelShown && (
        <DraggablePanel
          inputSurface="gameplay"
          defaultPosition={BODY_DEFAULT_POSITION}
          position={panelPosition}
          width={PANEL_WIDTH}
          height={PANEL_HEIGHT}
          scale={uiScale}
          onPositionChange={onPanelPositionChange}
          onScaleChange={setTooltipScale}
          viewportWidth={viewportWidth}
          viewportHeight={viewportHeight}
          exclusionRects={bodyExclusionRects}
          dataTutorial="game-panel"
        >
          {/* Positioning context for the status bars, which hang off the shell's
            LEFT edge at a negative offset. The body clips its own overflow, so
            they cannot live inside it, and this box has to stay `visible`. */}
          <div style={{ position: 'relative', width: PANEL_WIDTH, height: PANEL_HEIGHT }}>
            {panelBody('modern')}
            {statusBars}
          </div>
        </DraggablePanel>
      )}

      <DraggablePanel
        inputSurface="gameplay"
        defaultPosition={{ x: 0, y: 0, anchorX: 'right', anchorY: 'bottom' }}
        width={ICON_BAR_WIDTH}
        height={ICON_BAR_HEIGHT}
        scale={uiScale}
        onScaleChange={setTooltipScale}
        viewportWidth={viewportWidth}
        viewportHeight={viewportHeight}
        dataTutorial="tab-bar"
        exclusionRects={exclusionRects}
      >
        <div
          /* Panel surface too: the tab stones are reproduced OSRS chrome, so they
             take the same no-cursor contract as the panel body.
             See --- GamePanel cursor policy --- in index.css. */
          className="panel-surface"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: TAB_GAP,
            position: 'relative',
          }}
        >
          <PixelSpriteLayer width={ICON_BAR_WIDTH} height={ICON_BAR_HEIGHT} sprites={tabSprites} />
          {tabs.map((spec) => renderTab(spec))}
        </div>
      </DraggablePanel>
    </>
  );
};
